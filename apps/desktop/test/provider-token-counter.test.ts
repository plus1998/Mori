import { expect, test } from "bun:test";
import type { GatewayProvider } from "@eco/gateway";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import { countGatewayInputTokens, countProviderInputTokens } from "../src/main/provider-token-counter";

function provider(overrides: Partial<ProviderConfigSecret> = {}): ProviderConfigSecret {
  return {
    id: "provider_1",
    name: "Provider",
    baseUrl: "https://gateway.test",
    requestPath: "",
    version: "v1",
    apiCompat: "anthropic",
    tokenCountMode: "local_heuristic",
    defaultModel: "model-1",
    enabled: true,
    hasApiKey: true,
    apiKey: "secret",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const anthropicBody = {
  model: "alias-model",
  system: "You are helpful",
  messages: [{ role: "user", content: "Hello" }],
};

test("local_heuristic reports heuristic precision without network access", async () => {
  let fetched = false;
  const result = await countProviderInputTokens({
    mode: "local_heuristic",
    provider: provider(),
    modelId: "model-1",
    anthropicBody,
    fetcher: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });

  expect(result.tokens).toBeGreaterThan(0);
  expect(result.precision).toBe("heuristic");
  expect(result.source).toBe("eco:local_heuristic");
  expect(fetched).toBe(false);
});

test("anthropic_messages counts via Eco Bridge → Gateway → provider", async () => {
  const { configureEcoGatewayLifecycle, resetGlobalEcoGatewayForTests } = await import(
    "../src/main/eco-gateway-lifecycle"
  );
  const upstreamRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      upstreamRequests.push({
        path: new URL(request.url).pathname,
        body: (await request.json()) as Record<string, unknown>,
      });
      return Response.json({ input_tokens: 321 });
    },
  });
  const baseUrl = `http://127.0.0.1:${upstream.port}`;
  configureEcoGatewayLifecycle({
    ecoDataDir: "/tmp/eco-token-anthropic",
    gatewayPort: 0,
    listProviders: () => [
      {
        id: "provider_1",
        name: "Provider",
        enabled: true,
        baseUrl,
        requestPath: "/anthropic",
        version: "v1",
        apiKey: "secret",
        apiCompat: "anthropic",
        defaultModel: "real-model",
        modelIds: ["real-model"],
      },
    ],
  });
  try {
    const result = await countProviderInputTokens({
      mode: "anthropic_messages",
      provider: provider({
        baseUrl,
        requestPath: "/anthropic",
        version: "v1",
        tokenCountMode: "anthropic_messages",
      }),
      modelId: "real-model",
      anthropicBody,
    });
    expect(result.tokens).toBe(321);
    expect(result.precision).toBe("provider_exact");
    expect(result.source).toBe("eco-gateway:/v1/messages/count_tokens");
    expect(upstreamRequests).toEqual([
      {
        path: "/anthropic/v1/messages/count_tokens",
        body: expect.objectContaining({ model: "real-model" }) as unknown as Record<string, unknown>,
      },
    ]);
  } finally {
    await resetGlobalEcoGatewayForTests();
    upstream.stop(true);
  }
});

test("explicit provider counting failure is not replaced by a heuristic", async () => {
  let calls = 0;
  await expect(
    countProviderInputTokens({
      mode: "anthropic_messages",
      provider: provider(),
      modelId: "model-1",
      anthropicBody,
      fetcher: async () => {
        calls += 1;
        return new Response("unsupported endpoint", { status: 404 });
      },
    }),
  ).rejects.toThrow("HTTP 404");
  expect(calls).toBe(1);
});

test("openai_responses converts the Anthropic request before counting", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | undefined;
  const result = await countProviderInputTokens({
    mode: "openai_responses",
    provider: provider({ apiCompat: "openai_responses", requestPath: "/zen" }),
    version: "v1",
    modelId: "gpt-test",
    anthropicBody,
    fetcher: async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ object: "response.input_tokens", input_tokens: 456 });
    },
  });

  expect(capturedUrl).toBe("https://gateway.test/zen/v1/responses/input_tokens");
  expect(capturedBody?.model).toBe("gpt-test");
  expect(capturedBody?.input).toBeDefined();
  expect(capturedBody).not.toHaveProperty("messages");
  expect(result.precision).toBe("provider_exact");
  expect(result.tokens).toBe(456);
});

test("llama_tokenize applies the chat template before tokenization", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const result = await countProviderInputTokens({
    mode: "llama_tokenize",
    provider: provider({ apiCompat: "openai_chat_completions" }),
    modelId: "llama-model",
    anthropicBody,
    fetcher: async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/apply-template")) {
        return Response.json({ prompt: "<s>[INST] Hello [/INST]" });
      }
      return Response.json({ tokens: [1, 2, 3, 4, 5] });
    },
  });

  expect(calls.map((call) => call.url)).toEqual([
    "https://gateway.test/apply-template",
    "https://gateway.test/tokenize",
  ]);
  expect(calls[0]?.body.messages).toBeArray();
  expect(calls[1]?.body).toMatchObject({
    content: "<s>[INST] Hello [/INST]",
    add_special: false,
    parse_special: true,
  });
  expect(result).toEqual({
    tokens: 5,
    precision: "tokenizer_exact",
    source: "https://gateway.test/apply-template -> https://gateway.test/tokenize",
  });
});

test("llama_tokenize rejects tool requests rather than silently undercounting", async () => {
  let fetched = false;
  await expect(
    countProviderInputTokens({
      mode: "llama_tokenize",
      provider: provider({ apiCompat: "openai_chat_completions" }),
      modelId: "llama-model",
      anthropicBody: {
        ...anthropicBody,
        tools: [
          {
            name: "Read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
      fetcher: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
    }),
  ).rejects.toThrow("无法从 /apply-template 文档化接口精确计入 tools");
  expect(fetched).toBe(false);
});

test("invalid token count mode is rejected instead of normalized to local heuristic", async () => {
  const { normalizeProviderTokenCountMode } = await import("../src/shared/provider-token-count");
  expect(() => normalizeProviderTokenCountMode("invented_mode")).toThrow("无效的 Provider token 计数模式");
});

test("provider token counter rejects an invalid runtime mode instead of treating it as llama_tokenize", async () => {
  let fetched = false;
  await expect(
    countProviderInputTokens({
      mode: "invented_mode" as never,
      provider: provider(),
      modelId: "model-1",
      anthropicBody,
      fetcher: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
    }),
  ).rejects.toThrow("无效的 Provider token 计数模式");
  expect(fetched).toBe(false);
});

test("Anthropic proxy uses the provider's explicit token count adapter", async () => {
  const { startAnthropicModelProxy } = await import("../src/main/anthropic-proxy");
  const { configureEcoGatewayLifecycle, resetGlobalEcoGatewayForTests } = await import(
    "../src/main/eco-gateway-lifecycle"
  );
  const upstreamRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      upstreamRequests.push({
        path: new URL(request.url).pathname,
        body: (await request.json()) as Record<string, unknown>,
      });
      return Response.json({ input_tokens: 777 });
    },
  });
  const baseUrl = `http://127.0.0.1:${upstream.port}`;
  configureEcoGatewayLifecycle({
    ecoDataDir: "/tmp/eco-token-test",
    gatewayPort: 0,
    listProviders: () => [
      {
        id: "provider_1",
        name: "Provider",
        enabled: true,
        baseUrl,
        apiKey: "sk-test",
        apiCompat: "anthropic",
        defaultModel: "real-model",
        modelIds: ["real-model"],
      },
    ],
  });

  const proxy = await startAnthropicModelProxy([
    {
      role: "planner",
      provider: provider({
        baseUrl,
        tokenCountMode: "anthropic_messages",
      }),
      modelId: "real-model",
    },
  ]);

  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": proxy.apiKey,
      },
      body: JSON.stringify({
        model: proxy.routes[0]?.aliasModelId,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 777 });
    expect(upstreamRequests).toEqual([
      {
        path: "/v1/messages/count_tokens",
        body: { model: "real-model", messages: [{ role: "user", content: "hello" }] },
      },
    ]);
  } finally {
    await proxy.close();
    await resetGlobalEcoGatewayForTests();
    upstream.stop(true);
  }
});

for (const [kind, mode, endpoint] of [
  ["responses", "openai_responses", "/zen/v2/responses/input_tokens"],
  ["anthropic-messages", "anthropic_messages", "/zen/v2/messages/count_tokens"],
] as const) {
  test(`dispatch counter keeps the final ${kind} payload and credentials`, async () => {
    const provider: GatewayProvider = {
      id: "p",
      name: "P",
      baseUrl: "https://count.test",
      requestPath: "/zen",
      version: "v2",
      apiKey: "rotated-account-secret",
      upstreamKind: kind,
      upstreamModelId: "actual",
      models: ["actual"],
      tokenCountMode: mode,
    };
    const body =
      kind === "responses"
        ? {
            model: "actual",
            input: [{ type: "function_call_output", call_id: "tool-1", output: "tool result" }],
            instructions: "system",
            tools: [{ type: "custom", name: "edit", format: { type: "text" } }],
            previous_response_id: "previous",
            text: { format: { type: "json_object" } },
            max_output_tokens: 32_768,
            stream: true,
          }
        : {
            model: "actual",
            system: [{ type: "text", text: "system" }],
            messages: [
              {
                role: "user",
                content: [
                  { type: "image", source: { type: "url", url: "https://image.test/a.png" } },
                  { type: "text", text: "hi" },
                ],
              },
            ],
            tools: [{ name: "edit", input_schema: { type: "object" } }],
            thinking: { type: "adaptive" },
            max_tokens: 32_768,
            stream: true,
          };
    let calls = 0;
    const count = await countGatewayInputTokens({
      route: { provider, upstreamKind: kind, upstreamModelId: "actual", requestedModel: "alias" },
      body,
      headers: new Headers({
        authorization: "Bearer resolved-account",
        "anthropic-beta": "interleaved-thinking",
        "content-type": "application/json",
      }),
      fetcher: async (url, init) => {
        calls++;
        expect(new URL(String(url)).pathname).toBe(endpoint);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer resolved-account");
        expect(headers.get("anthropic-beta")).toBe("interleaved-thinking");
        const sent = JSON.parse(String(init?.body));
        expect(sent.model).toBe("actual");
        expect(sent.tools).toEqual(body.tools);
        expect(sent.stream).toBeUndefined();
        expect(sent.max_tokens).toBeUndefined();
        expect(sent.max_output_tokens).toBeUndefined();
        if (kind === "responses") {
          expect(sent.input).toEqual(body.input);
          expect(sent.previous_response_id).toBe("previous");
          expect(sent.text).toEqual(body.text);
        } else {
          expect(sent.messages).toEqual(body.messages);
          expect(sent.thinking).toEqual(body.thinking);
        }
        return Response.json({ input_tokens: 30_000 });
      },
    });
    expect(count.tokens).toBe(30_000);
    expect(count.precision).toBe("provider_exact");
    expect(calls).toBe(1);
  });
}

test("dispatch local heuristic counts full input fields and rejects unseen server history", async () => {
  const provider: GatewayProvider = {
    id: "p",
    name: "P",
    baseUrl: "https://count.test",
    apiKey: "test",
    upstreamKind: "responses",
    upstreamModelId: "m",
    models: ["m"],
    tokenCountMode: "local_heuristic",
  };
  const input = {
    route: { provider, upstreamKind: "responses" as const, upstreamModelId: "m", requestedModel: "m" },
    headers: new Headers(),
    fetcher: async () => {
      throw new Error("must not fetch");
    },
  };
  const short = await countGatewayInputTokens({ ...input, body: { input: "hi" } });
  const full = await countGatewayInputTokens({
    ...input,
    body: {
      input: [{ type: "function_call_output", call_id: "call", output: "x".repeat(1_000) }],
      instructions: "s".repeat(1_000),
      tools: [{ type: "function", name: "f", parameters: { description: "t".repeat(1_000) } }],
    },
  });
  expect(full.tokens).toBeGreaterThan(short.tokens + 700);
  expect(full.precision).toBe("heuristic");
  await expect(
    countGatewayInputTokens({ ...input, body: { input: "hi", previous_response_id: "old" } }),
  ).rejects.toThrow("服务端会话历史");
});

test("dispatch exact counter errors and protocol mismatches never fall back", async () => {
  const provider: GatewayProvider = {
    id: "p",
    name: "P",
    baseUrl: "https://count.test",
    apiKey: "test",
    upstreamKind: "responses",
    upstreamModelId: "m",
    models: ["m"],
    tokenCountMode: "openai_responses",
  };
  const input = {
    route: { provider, upstreamKind: "responses" as const, upstreamModelId: "m", requestedModel: "m" },
    body: { model: "m", input: "hi" },
    headers: new Headers(),
  };
  for (const response of [
    new Response("unsupported", { status: 404 }),
    Response.json({ input_tokens: 1.5 }),
    Response.json({}),
  ]) {
    await expect(countGatewayInputTokens({ ...input, fetcher: async () => response })).rejects.toThrow();
  }
  provider.tokenCountMode = "anthropic_messages";
  await expect(
    countGatewayInputTokens({
      ...input,
      fetcher: async () => {
        throw new Error("must not fetch");
      },
    }),
  ).rejects.toThrow("不能用协议转换后的计数冒充");
});

test("dispatch llama tokenizer counts native text and rejects uncountable media/tools", async () => {
  const provider: GatewayProvider = {
    id: "p",
    name: "P",
    baseUrl: "https://count.test",
    requestPath: "/zen",
    version: "v2",
    apiKey: "test",
    upstreamKind: "openai-chat",
    upstreamModelId: "m",
    models: ["m"],
    tokenCountMode: "llama_tokenize",
  };
  const messages = [{ role: "user", content: "hi" }];
  const urls: string[] = [];
  const input = {
    route: { provider, upstreamKind: "openai-chat" as const, upstreamModelId: "m", requestedModel: "m" },
    headers: new Headers(),
    fetcher: async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("apply-template")) {
        expect(body.messages).toEqual(messages);
        return Response.json({ prompt: "<user>hi<assistant>" });
      }
      expect(body.content).toBe("<user>hi<assistant>");
      expect(body.add_special).toBe(false);
      return Response.json({ tokens: [1, 2, 3] });
    },
  };
  const count = await countGatewayInputTokens({ ...input, body: { model: "m", messages } });
  expect(count.tokens).toBe(3);
  expect(count.precision).toBe("tokenizer_exact");
  expect(urls).toEqual(["https://count.test/zen/apply-template", "https://count.test/zen/tokenize"]);
  for (const body of [
    { messages, tools: [{ type: "function", function: { name: "f" } }] },
    {
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://image.test" } }] },
      ],
    },
  ]) {
    await expect(countGatewayInputTokens({ ...input, body })).rejects.toThrow("无法");
  }
  expect(urls).toHaveLength(2);
});
