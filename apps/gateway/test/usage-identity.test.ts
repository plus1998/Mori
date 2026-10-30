import { expect, test } from "bun:test";
import { GATEWAY_PROVIDER_ID_HEADER, GATEWAY_REQUESTED_MODEL_HEADER } from "../src/provider-router.js";
import { createGatewayFetchHandler } from "../src/server.js";
import type { GatewayProvider, GatewayUsageEvent } from "../src/types.js";

for (const kind of ["responses", "messages", "chat_completions"] as const) {
  test(`custom ${kind} usage retains provider identity captured before sending`, async () => {
    const provider: GatewayProvider = {
      id: "custom-vendor",
      name: "Original vendor",
      upstreamKind:
        kind === "messages"
          ? "anthropic-messages"
          : kind === "chat_completions"
            ? "openai-chat"
            : "responses",
      baseUrl: "https://vendor.invalid",
      apiKey: "test-only",
      authMethod: "api_key",
      upstreamModelId: "model",
      models: ["model"],
    };
    const events: GatewayUsageEvent[] = [];
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
      },
      async () => {
        provider.name = "Renamed while running";
        if (kind === "responses")
          return Response.json({
            id: "resp",
            object: "response",
            status: "completed",
            model: "model",
            output: [],
            usage: {
              input_tokens: 12,
              output_tokens: 3,
              total_tokens: 15,
              input_tokens_details: { cached_tokens: 4 },
            },
          });
        if (kind === "messages")
          return Response.json({
            id: "msg",
            type: "message",
            role: "assistant",
            model: "model",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 4 },
          });
        return Response.json({
          id: "chat",
          object: "chat.completion",
          model: "model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        });
      },
      () => undefined,
      (event) => {
        events.push(event);
      },
    );
    const path = kind === "chat_completions" ? "chat/completions" : kind;
    const body =
      kind === "responses"
        ? { model: "model", input: "hi", stream: false }
        : { model: "model", max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: false };
    const response = await handler(
      new Request(`http://127.0.0.1/v1/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: provider.id,
          [GATEWAY_REQUESTED_MODEL_HEADER]: "model",
        },
        body: JSON.stringify(body),
      }),
    );
    await response.text();
    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerId: "custom-vendor",
      providerName: "Original vendor",
      providerAuthMethod: "api_key",
      upstreamModelId: "model",
      usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 4 },
    });
    expect(events[0]).not.toHaveProperty("accountId");
    expect(events[0]).not.toHaveProperty("apiKey");
  });
}
