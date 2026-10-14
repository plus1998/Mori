/**
 * End-to-end: the User-Agent that actually reaches the upstream depends on which
 * agent core issued the request (Codex / Claude Code / PI), and clearing a core
 * falls back to the SDK's own UA.
 */
import { describe, expect, test } from "bun:test";
import { GATEWAY_PROVIDER_ID_HEADER, GATEWAY_REQUESTED_MODEL_HEADER } from "../src/provider-router.js";
import type { GatewayConfig, GatewayProvider } from "../src/types.js";
import { GATEWAY_AGENT_CORE_HEADER } from "../src/upstream/user-agent.js";
import { createTestGatewayFetchHandler } from "./test-bridge-rewrite.js";

const provider: GatewayProvider = {
  id: "anthropic",
  name: "Anthropic",
  upstreamKind: "anthropic-messages",
  baseUrl: "http://mock.anthropic.test",
  apiKey: "sk-test",
  upstreamModelId: "claude-test",
  models: ["claude-test"],
};

function captureUpstreamUserAgent(): { fetch: typeof fetch; seen: () => string | undefined } {
  let seen: string | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Upstream callers pass either (url, init) or a prepared Request.
    const headers =
      typeof input === "object" && "headers" in input
        ? new Headers((input as Request).headers)
        : new Headers(init?.headers);
    seen = headers.get("user-agent") ?? undefined;
    return Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, seen: () => seen };
}

async function postMessages(
  config: GatewayConfig,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<Response> {
  const handler = createTestGatewayFetchHandler(config, fetchImpl);
  return handler(
    new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [GATEWAY_PROVIDER_ID_HEADER]: "anthropic",
        [GATEWAY_REQUESTED_MODEL_HEADER]: "claude-test",
        ...headers,
      },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 16,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
}

describe("per-core upstream User-Agent", () => {
  test("each core sends its own configured User-Agent", async () => {
    const config: GatewayConfig = {
      host: "127.0.0.1",
      port: 0,
      providers: [provider],
      upstreamUserAgents: { codex: "codex-ua/1", claude: "claude-ua/1", pi: "pi-ua/1" },
    };

    for (const [core, expected] of [
      ["codex", "codex-ua/1"],
      ["claude", "claude-ua/1"],
      ["pi", "pi-ua/1"],
    ] as const) {
      const upstream = captureUpstreamUserAgent();
      const response = await postMessages(config, upstream.fetch, {
        "user-agent": "sdk-client/1.0",
        [GATEWAY_AGENT_CORE_HEADER]: core,
      });
      expect(response.status).toBe(200);
      expect(upstream.seen()).toBe(expected);
    }
  });

  test("a cleared core sends the SDK's own User-Agent", async () => {
    const config: GatewayConfig = {
      host: "127.0.0.1",
      port: 0,
      providers: [provider],
      upstreamUserAgents: { codex: "codex-ua/1" },
    };

    const upstream = captureUpstreamUserAgent();
    await postMessages(config, upstream.fetch, {
      "user-agent": "claude-sdk/9.9",
      [GATEWAY_AGENT_CORE_HEADER]: "claude",
    });
    expect(upstream.seen()).toBe("claude-sdk/9.9");
  });

  test("without a core header the gateway falls back to the Eco UA", async () => {
    const config: GatewayConfig = {
      host: "127.0.0.1",
      port: 0,
      providers: [provider],
      userAgentDefault: "Eco-Coding/1.2.3 (darwin 24.6.0; arm64)",
      upstreamUserAgents: { codex: "codex-ua/1" },
    };

    const upstream = captureUpstreamUserAgent();
    await postMessages(config, upstream.fetch, {});
    expect(upstream.seen()).toBe("Eco-Coding/1.2.3 (darwin 24.6.0; arm64)");
  });

  test("the global override still covers unidentified callers", async () => {
    const config: GatewayConfig = {
      host: "127.0.0.1",
      port: 0,
      providers: [provider],
      upstreamUserAgent: "global-ua/1",
    };

    const upstream = captureUpstreamUserAgent();
    await postMessages(config, upstream.fetch, { "user-agent": "someone-else/1" });
    expect(upstream.seen()).toBe("global-ua/1");
  });
});

describe("live refresh (the path desktop uses after saving settings)", () => {
  test("setUpstreamUserAgents hot-applies overrides and the Eco fallback", async () => {
    const { startEcoGateway } = await import("../src/server.js");
    const upstream = captureUpstreamUserAgent();
    const server = await startEcoGateway(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      { fetchImpl: upstream.fetch },
    );
    try {
      server.setUpstreamUserAgents(
        { codex: "  codex-ua/1  ", claude: "" },
        "Eco-Coding/9.9.9 (darwin 1.0.0; arm64)",
      );

      // Empty string models an SDK that sends no UA header at all.
      const send = async (core?: string, userAgent = "sdk-client/1.0") =>
        fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": userAgent,
            [GATEWAY_PROVIDER_ID_HEADER]: "anthropic",
            [GATEWAY_REQUESTED_MODEL_HEADER]: "claude-test",
            ...(core ? { [GATEWAY_AGENT_CORE_HEADER]: core } : {}),
          },
          body: JSON.stringify({
            model: "claude-test",
            max_tokens: 16,
            stream: false,
            messages: [{ role: "user", content: "hi" }],
          }),
        });

      expect((await send("codex")).status).toBe(200);
      expect(upstream.seen()).toBe("codex-ua/1");
      // claude was cleared → the SDK's own UA
      expect((await send("claude")).status).toBe(200);
      expect(upstream.seen()).toBe("sdk-client/1.0");
      // An SDK that sends no UA gets the injected Eco fallback.
      expect((await send("claude", "")).status).toBe(200);
      expect(upstream.seen()).toBe("Eco-Coding/9.9.9 (darwin 1.0.0; arm64)");

      // Clearing everything again drops the overrides.
      server.setUpstreamUserAgents(undefined, undefined);
      expect((await send("codex")).status).toBe(200);
      expect(upstream.seen()).toBe("sdk-client/1.0");
      // The injected default is gone too, so the bare Eco constant is the floor.
      expect((await send("codex", "")).status).toBe(200);
      expect(upstream.seen()).toBe("Eco-Coding/0.0.0");
    } finally {
      server.stop();
    }
  });
});
