/**
 * Bridge must tell the gateway which agent core issued a request so the gateway can
 * apply a per-core upstream User-Agent (Codex / Claude Code / PI).
 */
import { describe, expect, test } from "bun:test";
import { type EcoGatewayServer, GATEWAY_AGENT_CORE_HEADER, mapApiCompatToUpstreamKind } from "@eco/gateway";
import { createEcoSdkBridgeHandler } from "../src/main/eco-sdk-bridge";
import { buildPiGatewayRequestHeaders } from "../src/main/gateway-route-binding";

function stubGateway(): {
  server: EcoGatewayServer;
  lastHeaders: () => Headers | undefined;
  lastBody: () => Record<string, unknown> | undefined;
} {
  let headers: Headers | undefined;
  let body: Record<string, unknown> | undefined;
  const server: EcoGatewayServer = {
    port: 0,
    handleRequest: async (request) => {
      headers = new Headers(request.headers);
      body = (await request.json()) as Record<string, unknown>;
      return Response.json({ ok: true });
    },
    stop: () => undefined,
    getProviders: () => [],
    setProviders: () => undefined,
    setUpstreamUserAgent: () => undefined,
    setUpstreamUserAgents: () => undefined,
    setUpstreamProxyUrl: () => undefined,
    getUpstreamProxyUrl: () => undefined,
  };
  return { server, lastHeaders: () => headers, lastBody: () => body };
}

async function post(
  handler: (request: Request) => Promise<Response>,
  path: string,
  headers: Record<string, string> = {},
) {
  return handler(
    new Request(`http://127.0.0.1:18765${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "eco_main__x__y", messages: [] }),
    }),
  );
}

describe("bridge stamps the agent core header", () => {
  test("responses face is stamped as codex", async () => {
    const { server, lastHeaders } = stubGateway();
    const handler = createEcoSdkBridgeHandler({
      gateway: server,
      prepareGatewayBindingForward: async () => ({
        kind: "forward",
        resolution: { providerId: "p1", upstreamModelId: "m1", upstreamKind: "responses" },
        clientModel: "eco_main__p1__m1",
      }),
    });

    await post(handler, "/v1/responses");
    expect(lastHeaders()?.get(GATEWAY_AGENT_CORE_HEADER)).toBe("codex");
  });

  test("messages face is stamped as claude", async () => {
    const { server, lastHeaders } = stubGateway();
    const handler = createEcoSdkBridgeHandler({
      gateway: server,
      prepareClaudeMessages: async () => ({
        kind: "forward",
        resolution: { providerId: "p1", upstreamModelId: "m1", upstreamKind: "anthropic-messages" },
        clientModel: "eco_main__p1__m1",
      }),
    });

    await post(handler, "/v1/messages");
    expect(lastHeaders()?.get(GATEWAY_AGENT_CORE_HEADER)).toBe("claude");
  });

  test("a pre-stamped core (PI) is never overwritten", async () => {
    const { server, lastHeaders } = stubGateway();
    const handler = createEcoSdkBridgeHandler({
      gateway: server,
      prepareClaudeMessages: async () => ({
        kind: "forward",
        resolution: { providerId: "p1", upstreamModelId: "m1", upstreamKind: "anthropic-messages" },
        clientModel: "eco_main__p1__m1",
      }),
    });

    await post(handler, "/v1/messages", { [GATEWAY_AGENT_CORE_HEADER]: "pi" });
    expect(lastHeaders()?.get(GATEWAY_AGENT_CORE_HEADER)).toBe("pi");
  });
});

describe("PI gateway request headers", () => {
  test("stamp the pi core alongside provider/model identity", () => {
    const headers = buildPiGatewayRequestHeaders({
      bindingId: "cbb_1",
      providerId: "p1",
      requestedModel: "eco_main__p1__m1",
      apiCompat: "openai_responses",
      threadId: "thr_1",
    });
    expect(headers[GATEWAY_AGENT_CORE_HEADER]).toBe("pi");
    expect(headers["x-gateway-provider-id"]).toBe("p1");
    expect(headers["x-gateway-upstream-kind"]).toBe(mapApiCompatToUpstreamKind("openai_responses"));
    expect(headers["x-gateway-thread-id"]).toBe("thr_1");
  });
});
