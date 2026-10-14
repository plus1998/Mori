import { expect, test } from "bun:test";
import {
  buildDefaultUpstreamUserAgent,
  buildProviderDirectUpstreamHeaders,
  buildProxyUpstreamHeaders,
  DEFAULT_UPSTREAM_USER_AGENT,
  setDefaultUpstreamUserAgent,
} from "../src/main/upstream-request-headers";

test("buildProxyUpstreamHeaders passthrough SDK user-agent on anthropic path", () => {
  const headers = buildProxyUpstreamHeaders({
    clientHeaders: { "user-agent": "claude-sdk/1.0", accept: "application/json" },
    apiKey: "secret",
    apiCompat: "anthropic",
  });
  expect(headers["user-agent"]).toBe("claude-sdk/1.0");
  expect(headers.accept).toBe("application/json");
  expect(headers["x-api-key"]).toBe("secret");
});

test("buildProxyUpstreamHeaders passthrough SDK user-agent on openai path", () => {
  const headers = buildProxyUpstreamHeaders({
    clientHeaders: { "user-agent": "claude-sdk/2.0" },
    apiKey: "secret",
    apiCompat: "openai_responses",
  });
  expect(headers["user-agent"]).toBe("claude-sdk/2.0");
  expect(headers.authorization).toBe("Bearer secret");
  expect(headers["anthropic-version"]).toBeUndefined();
});

test("buildProxyUpstreamHeaders uses Eco user-agent when client has none and no override", () => {
  const headers = buildProxyUpstreamHeaders({
    clientHeaders: {},
    apiKey: "",
    apiCompat: "openai_chat_completions",
  });
  expect(headers["user-agent"]).toBe(DEFAULT_UPSTREAM_USER_AGENT);
});

test("buildProxyUpstreamHeaders global override wins over SDK", () => {
  const headers = buildProxyUpstreamHeaders({
    clientHeaders: { "user-agent": "claude-sdk/1.0" },
    apiKey: "k",
    apiCompat: "anthropic",
    upstreamUserAgent: "custom-gateway/9",
  });
  expect(headers["user-agent"]).toBe("custom-gateway/9");
});

test("buildProviderDirectUpstreamHeaders identifies as Eco by default and honors override", () => {
  expect(
    buildProviderDirectUpstreamHeaders({
      apiKey: "k",
      apiCompat: "anthropic",
    })["user-agent"],
  ).toBe(DEFAULT_UPSTREAM_USER_AGENT);
  expect(
    buildProviderDirectUpstreamHeaders({
      apiKey: "k",
      apiCompat: "anthropic",
      upstreamUserAgent: "eco-test/1",
    })["user-agent"],
  ).toBe("eco-test/1");
});

test("buildDefaultUpstreamUserAgent carries the Eco version and the OS", () => {
  expect(
    buildDefaultUpstreamUserAgent({
      version: "1.4.2",
      platform: "darwin",
      release: "24.6.0",
      arch: "arm64",
    }),
  ).toBe("Eco-Coding/1.4.2 (darwin 24.6.0; arm64)");
  // Degenerate host info still produces a valid, non-empty UA.
  expect(buildDefaultUpstreamUserAgent({ version: " ", platform: "win32", release: "", arch: "" })).toBe(
    "Eco-Coding/0.0.0 (win32)",
  );
});

test("setDefaultUpstreamUserAgent replaces the bare fallback for host-owned requests", () => {
  const versioned = "Eco-Coding/1.4.2 (darwin 24.6.0; arm64)";
  expect(setDefaultUpstreamUserAgent(versioned)).toBeUndefined();
  try {
    expect(buildProviderDirectUpstreamHeaders({ apiKey: "k", apiCompat: "anthropic" })["user-agent"]).toBe(
      versioned,
    );
    // A client UA still wins over the fallback.
    expect(
      buildProxyUpstreamHeaders({
        clientHeaders: { "user-agent": "claude-sdk/1.0" },
        apiKey: "k",
        apiCompat: "anthropic",
      })["user-agent"],
    ).toBe("claude-sdk/1.0");
  } finally {
    setDefaultUpstreamUserAgent(undefined);
  }
  expect(buildProviderDirectUpstreamHeaders({ apiKey: "k", apiCompat: "anthropic" })["user-agent"]).toBe(
    DEFAULT_UPSTREAM_USER_AGENT,
  );
});
