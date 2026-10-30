import { expect, test } from "bun:test";
import { createGatewayFetchHandler } from "../src/server";

for (const local of [true, false]) {
  test(`${local ? "local" : "upstream"} context rejection preserves its source before Codex replaces the message`, async () => {
    let upstreamCalls = 0;
    const logs: string[] = [];
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [
          {
            id: "test",
            name: "Test",
            upstreamKind: "responses",
            baseUrl: "https://example.test",
            apiKey: "test-key",
            upstreamModelId: "deepseek-flash",
            models: ["deepseek-flash"],
            modelContextTokens: { "deepseek-flash": 262_144 },
          },
        ],
        countInputTokens: async () => ({
          tokens: local ? 261_120 : 1_000,
          precision: "provider_exact",
          source: "test:controlled",
        }),
      },
      async () => {
        upstreamCalls++;
        return Response.json(
          { error: { code: "context_length_exceeded", message: "UPSTREAM_CONTEXT_MARKER" } },
          { status: 400 },
        );
      },
      (message) => logs.push(message),
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gateway-provider-id": "test",
          "x-gateway-thread-id": "thread-original",
        },
        body: JSON.stringify({
          model: "deepseek-flash",
          stream: true,
          input: [{ role: "user", content: "test" }],
        }),
      }),
    );
    const text = await response.text();
    const origin = local ? "eco.context_budget" : "upstream";
    expect(upstreamCalls).toBe(local ? 0 : 1);
    expect(response.headers.get("x-eco-error-origin")).toBe(origin);
    expect(text).toContain("response.failed");
    expect(text).toContain(
      local
        ? "Context window exhausted: window=262144, input=261120, reserve=1024"
        : "UPSTREAM_CONTEXT_MARKER",
    );
    const diagnostic = logs.find((message) => message.startsWith("context overflow "));
    if (!diagnostic) throw new Error("Context overflow diagnosis was not recorded.");
    expect(JSON.parse(diagnostic.slice("context overflow ".length))).toMatchObject({
      origin,
      threadId: "thread-original",
    });
    expect(diagnostic).not.toContain("test-key");
  });
}
