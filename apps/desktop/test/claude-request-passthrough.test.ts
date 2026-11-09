import { expect, test } from "bun:test";
import { createTestGatewayFetchHandler } from "../../gateway/test/test-bridge-rewrite";
import { countGatewayInputTokens } from "../src/main/provider-token-counter";

// Match metadata observed from the native Claude Agent SDK, without synthesizing
// it in production for clients that did not send it.
const sdkHeaders = {
  "user-agent": "claude-cli/2.1.301 (external, sdk-ts, agent-sdk/0.3.301)",
  "x-app": "cli",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "interleaved-thinking-2025-05-14,claude-code-20250219",
  "anthropic-dangerous-direct-browser-access": "true",
  "x-stainless-lang": "js",
  "x-stainless-runtime": "node",
  "x-stainless-package-version": "0.128.0",
  "x-claude-code-session-id": "test-session",
};

for (const beta of [false, true]) {
  test(`native Messages and dynamic counter retain SDK metadata, beta=${beta}`, async () => {
    const paths: string[] = [];
    const metadata = { user_id: "test-user" };
    const system = [{ type: "text", text: "You are Claude Code." }];
    const handler = createTestGatewayFetchHandler({
      host: "127.0.0.1", port: 0,
      providers: [{
        id: "claude", name: "Claude", baseUrl: "https://upstream.test", apiKey: "provider-key",
        upstreamKind: "anthropic-messages", upstreamModelId: "claude-haiku-5-5", models: ["claude-haiku-5-5"],
        modelContextTokens: { "claude-haiku-5-5": 100_000 }, modelMaxOutputTokens: { "claude-haiku-5-5": 32_768 },
      }],
      countInputTokens: countGatewayInputTokens,
    }, async (url, init) => {
      const target = new URL(String(url));
      paths.push(target.pathname + target.search);
      expect(target.search).toBe(beta ? "?beta=true" : "");
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(sdkHeaders)) expect(headers.get(name)).toBe(value);
      expect(headers.get("x-api-key")).toBe("provider-key");
      for (const name of ["authorization", "cookie", "x-gateway-provider-id", "x-eco-agent-core"]) expect(headers.has(name)).toBe(false);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("claude-haiku-5-5");
      expect(body.system).toEqual(system);
      if (target.pathname.endsWith("count_tokens")) {
        expect(body.max_tokens).toBeUndefined();
        expect(body.stream).toBeUndefined();
        expect(body.metadata).toBeUndefined();
        return Response.json({ input_tokens: 42 });
      }
      expect(body.metadata).toEqual(metadata);
      expect(body.max_tokens).toBe(32_768);
      return Response.json({ id: "msg_test", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 42, output_tokens: 1 } });
    });
    const response = await handler(new Request(`http://127.0.0.1/v1/messages?${beta ? "beta=true&" : ""}local-only=private`, {
      method: "POST",
      headers: { ...sdkHeaders, "content-type": "application/json", "x-api-key": "local-binding", authorization: "Bearer private", cookie: "private", "x-eco-agent-core": "claude" },
      body: JSON.stringify({ model: "claude-haiku-5-5", system, metadata, messages: [{ role: "user", content: "hi" }], max_tokens: 64_000 }),
    }));
    expect(response.status).toBe(200);
    expect(paths).toEqual([`/v1/messages/count_tokens${beta ? "?beta=true" : ""}`, `/v1/messages${beta ? "?beta=true" : ""}`]);
  });
}
