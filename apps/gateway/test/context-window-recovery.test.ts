import { expect, test } from "bun:test";
import type { GatewayProvider, GatewayRequestLifecycleEvent, GatewayUsageEvent } from "../src/types.js";
import { createTestGatewayFetchHandler } from "./test-bridge-rewrite.js";

for (const kind of ["responses", "anthropic-messages", "openai-chat"] as const) {
  for (const stream of [false, true]) {
    for (const rejection of ["budget", "provider"] as const) {
      test(`Responses ${kind} ${rejection} overflow preserves recovery semantics stream=${stream}`, async () => {
        const provider: GatewayProvider = {
          id: "recovery",
          name: "Recovery fixture",
          upstreamKind: kind,
          baseUrl: "https://example.test",
          apiKey: "secret-test-key",
          upstreamModelId: "deepseek-flash",
          models: ["deepseek-flash"],
          ...(rejection === "budget" && { modelContextTokens: { "deepseek-flash": 946_176 } }),
        };
        const lifecycle: GatewayRequestLifecycleEvent[] = [];
        const usage: GatewayUsageEvent[] = [];
        let generationCalls = 0;
        const handler = createTestGatewayFetchHandler(
          {
            host: "127.0.0.1",
            port: 0,
            providers: [provider],
            countInputTokens: async () => ({
              tokens: 945_152,
              precision: "provider_exact",
              source: "test:controlled-input",
            }),
          },
          async () => {
            generationCalls += 1;
            return Response.json(
              {
                error: {
                  code: "context_length_exceeded",
                  type: "invalid_request_error",
                  message: "Provider context exceeded.",
                  param: "input",
                },
              },
              { status: 400 },
            );
          },
          () => {},
          (event) => usage.push(event),
          (event) => lifecycle.push(event),
        );
        const response = await handler(
          new Request("http://127.0.0.1/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "deepseek-flash",
              stream,
              input: [{ role: "user", content: "Summarize the history." }],
            }),
          }),
        );
        expect(generationCalls).toBe(rejection === "budget" ? 0 : 1);
        expect(response.headers.get("x-eco-upstream-error-code")).toBe("context_length_exceeded");
        expect(response.status).toBe(stream ? 200 : 400);
        const text = await response.text();
        const error = stream
          ? JSON.parse(text.split("data: ")[1]?.trim() ?? "null").response.error
          : JSON.parse(text).error;
        expect(error.code).toBe("context_length_exceeded");
        expect(error.message).toContain(
          rejection === "budget" ? "window=946176, input=945152, reserve=1024" : "Provider context exceeded",
        );
        if (stream) {
          expect(response.headers.get("content-type")).toBe("text/event-stream");
          expect(text).toContain("event: response.failed");
          expect(text).not.toContain("response.completed");
        }
        expect(text).not.toContain("secret-test-key");
        expect(usage).toHaveLength(0);
        expect(lifecycle.filter((event) => event.type === "logical.failed")).toHaveLength(1);
        expect(lifecycle.filter((event) => event.type === "logical.completed")).toHaveLength(0);
      });
    }
  }
}

test("streaming Responses leaves unrelated HTTP request failures as HTTP errors", async () => {
  const handler = createTestGatewayFetchHandler(
    {
      host: "127.0.0.1",
      port: 0,
      providers: [
        {
          id: "invalid",
          name: "Invalid fixture",
          upstreamKind: "responses",
          baseUrl: "https://example.test",
          apiKey: "test-key",
          upstreamModelId: "m",
          models: ["m"],
        },
      ],
    },
    async () =>
      Response.json({ error: { code: "invalid_parameter", message: "Invalid parameter." } }, { status: 400 }),
  );
  const response = await handler(
    new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, input: [] }),
    }),
  );
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect((await response.json()).error.code).toBe("invalid_parameter");
});
