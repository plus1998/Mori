import { expect, test } from "bun:test";
import type { GatewayProvider } from "@eco/gateway";
import { createTestGatewayFetchHandler } from "../../gateway/test/test-bridge-rewrite";
import { countGatewayInputTokens } from "../src/main/provider-token-counter";

for (const tokenCountMode of ["provider_native", "llama_tokenize"] as const) {
  test(`Chat tool calls continue with fixed 32K when ${tokenCountMode} cannot count tools`, async () => {
    let generationCalls = 0;
    const handler = createTestGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [
          {
            id: "chat",
            name: "Chat",
            baseUrl: "https://upstream.test",
            apiKey: "test",
            upstreamKind: "openai-chat",
            upstreamModelId: "m",
            models: ["m"],
            tokenCountMode,
            modelContextTokens: { m: 262_144 },
            modelMaxOutputTokens: { m: 131_072 },
          },
        ],
        countInputTokens: countGatewayInputTokens,
      },
      async (url, init) => {
        generationCalls++;
        expect(String(url)).toEndWith("/v1/chat/completions");
        const body = JSON.parse(String(init?.body));
        expect(body.max_tokens ?? body.max_completion_tokens).toBe(32_768);
        expect(body.tools[0].function.name).toBe("f");
        return Response.json({
          id: "chatcmpl_fixed",
          object: "chat.completion",
          model: "m",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_fixed", type: "function", function: { name: "f", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
        });
      },
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gateway-provider-id": "chat" },
        body: JSON.stringify({
          model: "m",
          input: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.output).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "call_fixed", name: "f" }),
    );
    expect(generationCalls).toBe(1);
  });
}

for (const [kind, face, endpoint, outputField] of [
  ["responses", "responses", "input_tokens", "max_output_tokens"],
  ["anthropic-messages", "messages", "count_tokens", "max_tokens"],
] as const) {
  for (const status of [404, 405, 501]) {
    for (const stream of [false, true]) {
      test(`${kind} unsupported count HTTP ${status} continues generation with 32K stream=${stream}`, async () => {
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
                modelMaxOutputTokens: { m: 131_072 },
              },
            ],
            countInputTokens: countGatewayInputTokens,
          },
          async (url, init) => {
            calls.push(String(url));
            if (String(url).endsWith(`/${endpoint}`)) {
              return Response.json(
                {
                  error: {
                    message: `Invalid URL (POST /v1/responses/input_tokens)`,
                    type: "packy_invalid_request",
                  },
                },
                { status },
              );
            }
            const body = JSON.parse(String(init?.body));
            expect(body[outputField]).toBe(32_768);
            expect(body.tools).toHaveLength(1);
            if (!stream) {
              return Response.json(
                kind === "responses"
                  ? {
                      id: "resp_fixed",
                      object: "response",
                      status: "completed",
                      output: [
                        {
                          id: "msg_fixed",
                          type: "message",
                          role: "assistant",
                          content: [{ type: "output_text", text: "continued", annotations: [] }],
                        },
                      ],
                    }
                  : {
                      id: "msg_fixed",
                      type: "message",
                      role: "assistant",
                      content: [{ type: "text", text: "continued" }],
                      stop_reason: "end_turn",
                      usage: { input_tokens: 100, output_tokens: 1 },
                    },
              );
            }
            const events =
              kind === "responses"
                ? [
                    {
                      type: "response.completed",
                      response: {
                        id: "resp_fixed",
                        object: "response",
                        status: "completed",
                        output: [
                          {
                            id: "msg_fixed",
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "continued", annotations: [] }],
                          },
                        ],
                        usage: { input_tokens: 100, output_tokens: 1 },
                      },
                    },
                  ]
                : [
                    {
                      type: "message_start",
                      message: {
                        id: "msg_fixed",
                        type: "message",
                        role: "assistant",
                        model: "m",
                        content: [],
                        usage: { input_tokens: 100, output_tokens: 0 },
                      },
                    },
                    {
                      type: "content_block_start",
                      index: 0,
                      content_block: { type: "text", text: "continued" },
                    },
                    { type: "content_block_stop", index: 0 },
                    {
                      type: "message_delta",
                      delta: { stop_reason: "end_turn" },
                      usage: { output_tokens: 1 },
                    },
                    { type: "message_stop" },
                  ];
            return new Response(
              events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        );
        const tools =
          kind === "responses"
            ? [{ type: "function", name: "f", parameters: { type: "object" } }]
            : [{ name: "f", input_schema: { type: "object" } }];
        const response = await handler(
          new Request(`http://127.0.0.1/v1/${face}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-gateway-provider-id": "native" },
            body: JSON.stringify({
              model: "m",
              stream,
              tools,
              input: "hi",
              messages: [{ role: "user", content: "hi" }],
            }),
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("continued");
        expect(calls).toHaveLength(2);
        expect(calls[0]).toEndWith(`/${endpoint}`);
        expect(response.headers.get("x-eco-upstream-error-code")).toBeNull();
      });
    }
  }

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

  for (const failure of ["malformed", "network", "unauthorized", "server_error", "rate_limited"] as const) {
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
          if (failure === "unauthorized") return new Response("unauthorized", { status: 401 });
          if (failure === "server_error") return new Response("server error", { status: 500 });
          if (failure === "rate_limited") return new Response("rate limited", { status: 429 });
          return Response.json({});
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
