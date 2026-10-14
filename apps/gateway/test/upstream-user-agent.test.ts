import { expect, test } from "bun:test";
import {
  applyUpstreamUserAgent,
  DEFAULT_UPSTREAM_USER_AGENT,
  GATEWAY_AGENT_CORE_HEADER,
  readGatewayAgentCore,
  resolveUpstreamUserAgent,
} from "../src/upstream/user-agent.js";

function clientHeaders(init: Record<string, string>): Headers {
  return new Headers(init);
}

test("per-core override wins over the global override", () => {
  const ua = resolveUpstreamUserAgent(
    clientHeaders({ "user-agent": "sdk/1.0", [GATEWAY_AGENT_CORE_HEADER]: "claude" }),
    { override: "global/1", byCore: { claude: "claude-custom/1", pi: "pi-custom/1" } },
  );
  expect(ua).toBe("claude-custom/1");
});

test("a cleared per-core field falls back to the SDK User-Agent, not the global one", () => {
  // 清空 Codex 的 UA 后：即使全局有覆盖，Codex 也要用 SDK 自己的 UA。
  const withGlobal = resolveUpstreamUserAgent(
    clientHeaders({ "user-agent": "codex-sdk/2.0", [GATEWAY_AGENT_CORE_HEADER]: "codex" }),
    { override: "global/1", byCore: { pi: "pi-custom/1" } },
  );
  expect(withGlobal).toBe("codex-sdk/2.0");

  const withoutGlobal = resolveUpstreamUserAgent(
    clientHeaders({ "user-agent": "codex-sdk/2.0", [GATEWAY_AGENT_CORE_HEADER]: "codex" }),
    { byCore: { pi: "pi-custom/1" } },
  );
  expect(withoutGlobal).toBe("codex-sdk/2.0");
});

test("blank per-core values count as not configured", () => {
  const ua = resolveUpstreamUserAgent(
    clientHeaders({ "user-agent": "sdk/1", [GATEWAY_AGENT_CORE_HEADER]: "pi" }),
    {
      byCore: { pi: "   " },
    },
  );
  expect(ua).toBe("sdk/1");
});

test("per-core values are trimmed and the core header is case-insensitive", () => {
  expect(readGatewayAgentCore(clientHeaders({ [GATEWAY_AGENT_CORE_HEADER]: "  PI " }))).toBe("pi");
  expect(
    resolveUpstreamUserAgent(clientHeaders({ [GATEWAY_AGENT_CORE_HEADER]: "Pi" }), {
      byCore: { pi: "  pi-ua/1  " },
    }),
  ).toBe("pi-ua/1");
});

test("unknown or missing core header keeps the global rules", () => {
  expect(readGatewayAgentCore(clientHeaders({ [GATEWAY_AGENT_CORE_HEADER]: "cursor" }))).toBeUndefined();
  expect(readGatewayAgentCore(clientHeaders({}))).toBeUndefined();

  const ua = resolveUpstreamUserAgent(
    clientHeaders({ "user-agent": "cursor-sdk/1", [GATEWAY_AGENT_CORE_HEADER]: "cursor" }),
    { override: "global/1", byCore: { codex: "codex-custom/1" } },
  );
  expect(ua).toBe("global/1");
});

test("the global override does not leak into an identified core", () => {
  // Codex 没有自己的配置时用 SDK 的 UA，不会被全局兼底抢走。
  const ua = resolveUpstreamUserAgent(
    clientHeaders({ "user-agent": "codex-sdk/1", [GATEWAY_AGENT_CORE_HEADER]: "codex" }),
    { override: "global/1", byCore: { claude: "claude-custom/1" } },
  );
  expect(ua).toBe("codex-sdk/1");
});

test("no override and no client UA falls back to the injected Eco UA", () => {
  expect(resolveUpstreamUserAgent(clientHeaders({}), {})).toBe(DEFAULT_UPSTREAM_USER_AGENT);
  expect(
    resolveUpstreamUserAgent(clientHeaders({ [GATEWAY_AGENT_CORE_HEADER]: "pi" }), {
      fallback: "Eco-Coding/1.2.3 (darwin 24.6.0; arm64)",
    }),
  ).toBe("Eco-Coding/1.2.3 (darwin 24.6.0; arm64)");
});

test("applyUpstreamUserAgent keeps override → client → Eco default", () => {
  const overridden: Record<string, string> = {};
  applyUpstreamUserAgent(overridden, clientHeaders({ "user-agent": "sdk/1" }), "override/1");
  expect(overridden["user-agent"]).toBe("override/1");

  const passthrough: Record<string, string> = {};
  applyUpstreamUserAgent(passthrough, clientHeaders({ "user-agent": "sdk/1" }), "  ");
  expect(passthrough["user-agent"]).toBe("sdk/1");

  const fallback: Record<string, string> = {};
  applyUpstreamUserAgent(fallback, clientHeaders({}), undefined);
  expect(fallback["user-agent"]).toBe(DEFAULT_UPSTREAM_USER_AGENT);
});
