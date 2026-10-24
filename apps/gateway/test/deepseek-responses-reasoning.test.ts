import { describe, expect, test } from "bun:test";
import type { ResponsesRequest } from "@eco/openai-anthropic-bridge";
import type { GatewayProvider } from "../src/types.js";
import { sanitizeDeepSeekResponsesReasoning } from "../src/upstream/responses-passthrough.js";
import { createTestGatewayFetchHandler } from "./test-bridge-rewrite.js";

describe("DeepSeek Responses reasoning compatibility", () => {
  test("removes only the summary selector without mutating effort or reasoning history", () => {
    const body: ResponsesRequest = {
      model: "deepseek-flash",
      input: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "prior thinking" }], summary: [] }],
      reasoning: { effort: "high", summary: "detailed" },
    };
    Object.freeze(body.reasoning);
    Object.freeze(body);

    const sanitized = sanitizeDeepSeekResponsesReasoning(body, body.model);
    expect(sanitized.dropped).toEqual(["reasoning.summary"]);
    expect(sanitized.body.reasoning).toEqual({ effort: "high" });
    expect(sanitized.body.input).toBe(body.input);
    expect(body.reasoning).toEqual({ effort: "high", summary: "detailed" });
  });

  test("preserves non-DeepSeek requests and absent reasoning selectors", () => {
    const body: ResponsesRequest = { model: "gpt-5", input: [], reasoning: { effort: "high", summary: "auto" } };
    expect(sanitizeDeepSeekResponsesReasoning(body, body.model)).toEqual({ body, dropped: [] });
    expect(sanitizeDeepSeekResponsesReasoning(body, body.model).body).toBe(body);
    for (const reasoning of [undefined, null, { effort: "high" }]) {
      const request: ResponsesRequest = { model: "deepseek-flash", input: [], reasoning };
      expect(sanitizeDeepSeekResponsesReasoning(request, request.model).body).toBe(request);
    }
  });

  for (const path of ["/v1/responses", "/v1/messages"]) {
    for (const stream of [false, true]) {
      test(`${path} stream=${stream} omits summary before the first upstream request`, async () => {
        const model = "deepseek-flash";
        const provider: GatewayProvider = {
          id: "deepseek-proxy",
          name: "DeepSeek proxy",
          upstreamKind: "responses",
          baseUrl: "https://mock.deepseek.test",
          apiKey: "test-key",
          upstreamModelId: model,
          models: [model],
        };
        const logs: string[] = [];
        const bodies: Record<string, unknown>[] = [];
        const reply = {
          id: "resp_deepseek",
          object: "response",
          model,
          status: "completed",
          output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        };
        const handler = createTestGatewayFetchHandler(
          { host: "127.0.0.1", port: 0, providers: [provider] },
          async (_input, init) => {
            const body = JSON.parse(String(init?.body));
            bodies.push(body);
            if (body.reasoning && "summary" in body.reasoning) {
              return Response.json({ message: 'json: unknown field "summary"' }, { status: 400 });
            }
            return stream
              ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: reply })}\n\n`, {
                  headers: { "content-type": "text/event-stream" },
                })
              : Response.json(reply);
          },
          (line) => logs.push(line),
        );
        const body = path === "/v1/messages"
          ? { model, stream, max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 2048 }, messages: [{ role: "user", content: "hi" }] }
          : { model, stream, input: "hi", reasoning: { effort: "medium", summary: "detailed" } };
        const response = await handler(new Request(`http://127.0.0.1${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }));
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("ok");
        expect(bodies).toHaveLength(1);
        expect(bodies[0]?.reasoning).toEqual({ effort: "medium" });
        expect(logs.some((line) => line.includes("dropped=reasoning.summary"))).toBe(true);
      });
    }
  }
});
