import { expect, test } from "bun:test";
import { GATEWAY_PROVIDER_ID_HEADER } from "../src/provider-router";
import type { GatewayProvider } from "../src/types";
import { createTestGatewayFetchHandler } from "./test-bridge-rewrite";

test("every gateway face rejects disabled model images before contacting an upstream", async () => {
  const cases = [
    {
      pathname: "/v1/responses",
      upstreamKind: "responses",
      body: {
        input: [
          {
            type: "function_call_output",
            call_id: "read-image",
            output: [{ type: "input_image", image_url: "data:image/png;base64,bytes" }],
          },
        ],
      },
    },
    {
      pathname: "/v1/responses",
      upstreamKind: "responses",
      body: {
        input: [
          { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,bytes" }] },
        ],
      },
    },
    {
      pathname: "/v1/responses/compact",
      upstreamKind: "responses",
      body: {
        input: [
          { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,bytes" }] },
        ],
      },
    },
    {
      pathname: "/v1/messages",
      upstreamKind: "anthropic-messages",
      body: {
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "bytes" } }],
          },
        ],
        max_tokens: 100,
      },
    },
    {
      pathname: "/v1/messages/count_tokens",
      upstreamKind: "anthropic-messages",
      body: {
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "bytes" } }] }],
      },
    },
    {
      pathname: "/v1/chat/completions",
      upstreamKind: "openai-chat",
      body: {
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }],
          },
        ],
      },
    },
  ] as const;
  for (const { pathname, upstreamKind, body } of cases) {
    const provider: GatewayProvider = {
      id: "local",
      name: "Local",
      upstreamKind,
      baseUrl: "http://localhost:8080",
      apiKey: "test",
      upstreamModelId: "text-model",
      models: ["text-model"],
      modelSupportsImageInput: { "text-model": false },
    };
    let upstreamCalls = 0;
    const handler = createTestGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      async () => {
        upstreamCalls += 1;
        return Response.json({});
      },
    );
    const response = await handler(
      new Request(`http://localhost${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", [GATEWAY_PROVIDER_ID_HEADER]: "local" },
        body: JSON.stringify({ model: "text-model", ...body }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "image_input_disabled" } });
    expect(upstreamCalls).toBe(0);
  }
});

test("gateway permits text with disabled vision and images on a different enabled vision model", async () => {
  const provider: GatewayProvider = {
    id: "local",
    name: "Local",
    upstreamKind: "responses",
    baseUrl: "http://localhost:8080",
    apiKey: "test",
    upstreamModelId: "text-model",
    models: ["text-model", "vision-model"],
    modelSupportsImageInput: { "text-model": false, "vision-model": true },
  };
  const models: string[] = [];
  const handler = createTestGatewayFetchHandler(
    { host: "127.0.0.1", port: 0, providers: [provider] },
    async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      models.push(body.model);
      return Response.json({
        id: "response",
        model: body.model,
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  );
  for (const [model, content] of [
    ["text-model", [{ type: "input_text", text: "hi" }]],
    ["vision-model", [{ type: "input_image", image_url: "data:image/png;base64,bytes" }]],
  ] as const) {
    const response = await handler(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", [GATEWAY_PROVIDER_ID_HEADER]: "local" },
        body: JSON.stringify({ model, input: [{ role: "user", content }] }),
      }),
    );
    expect(response.status).toBe(200);
  }
  expect(models).toEqual(["text-model", "vision-model"]);
});
