import { expect, test } from "bun:test";
import type { GatewayProvider } from "@eco/gateway";
import { createTestGatewayFetchHandler } from "../../gateway/test/test-bridge-rewrite";
import { countGatewayInputTokens } from "../src/main/provider-token-counter";

for (const [kind, face, endpoint, outputField] of [
  ["responses", "responses", "input_tokens", "max_output_tokens"],
  ["anthropic-messages", "messages", "count_tokens", "max_tokens"],
] as const) {
  test(`${kind} generation uses server counts and recounts after tool results`, async () => {
    const provider: GatewayProvider = {
      id: "native",
      name: "Native",
      baseUrl: "https://upstream.test",
      apiKey: "test",
      upstreamKind: kind,
      upstreamModelId: "m",
      models: ["m"],
      // Persisted pre-upgrade setting must no longer select a character estimate.
      tokenCountMode: "local_heuristic",
      modelContextTokens: { m: 262_144 },
      modelMaxOutputTokens: { m: 131_072 },
    };
    const order: string[] = [];
    const outputs: number[] = [];
    let countCalls = 0;
    const handler = createTestGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        countInputTokens: countGatewayInputTokens,
      },
      async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (String(url).endsWith(`/${endpoint}`)) {
          order.push("count");
          expect(body.tools).toHaveLength(1);
          expect(body[outputField]).toBeUndefined();
          countCalls++;
          if (countCalls === 2) expect(JSON.stringify(body)).toContain("new tool result");
          return Response.json({ input_tokens: countCalls === 1 ? 184_998 : 196_000 });
        }
        order.push("generate");
        outputs.push(body[outputField]);
        return Response.json(
          kind === "responses"
            ? {
                id: "resp_test",
                object: "response",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              }
            : {
                id: "msg_test",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "ok" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 1, output_tokens: 1 },
              },
        );
      },
    );
    for (const next of [false, true]) {
      const body =
        kind === "responses"
          ? {
              model: "m",
              input: next
                ? [
                    { type: "function_call", call_id: "call", name: "f", arguments: "{}" },
                    { type: "function_call_output", call_id: "call", output: "new tool result" },
                  ]
                : [{ role: "user", content: "hi" }],
              tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
            }
          : {
              model: "m",
              messages: next
                ? [
                    { role: "assistant", content: [{ type: "tool_use", id: "call", name: "f", input: {} }] },
                    {
                      role: "user",
                      content: [{ type: "tool_result", tool_use_id: "call", content: "new tool result" }],
                    },
                  ]
                : [{ role: "user", content: "hi" }],
              tools: [{ name: "f", input_schema: { type: "object" } }],
            };
      const response = await handler(
        new Request(`http://127.0.0.1/v1/${face}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-gateway-provider-id": "native" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(order).toEqual(["count", "generate", "count", "generate"]);
    expect(outputs).toEqual([76_122, 65_120]);
  });

  for (const failure of ["unsupported", "malformed", "network"] as const) {
    test(`${kind} ${failure} counting fails without sending generation`, async () => {
      const calls: string[] = [];
      const handler = createTestGatewayFetchHandler(
        {
          host: "127.0.0.1",
          port: 0,
          providers: [
            {
              id: "native",
              name: "Native",
              baseUrl: "https://upstream.test",
              apiKey: "test",
              upstreamKind: kind,
              upstreamModelId: "m",
              models: ["m"],
              modelContextTokens: { m: 262_144 },
            },
          ],
          countInputTokens: countGatewayInputTokens,
        },
        async (url) => {
          calls.push(String(url));
          if (failure === "network") throw new Error("count endpoint unavailable");
          return failure === "unsupported" ? new Response("unsupported", { status: 404 }) : Response.json({});
        },
      );
      const response = await handler(
        new Request(`http://127.0.0.1/v1/${face}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-gateway-provider-id": "native" },
          body: JSON.stringify({ model: "m", input: "hi", messages: [{ role: "user", content: "hi" }] }),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("dynamic_output_budget_error");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEndWith(`/${endpoint}`);
    });
  }
}
