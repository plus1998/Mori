import { beforeEach, expect, test } from "bun:test";
import {
  type AnthropicProxyResolvedRoute,
  applyRouteMaxOutputTokens,
  buildModelsListResponse,
  canonicalModelFamilyIds,
  createModelAlias,
  createStreamingUsageTracker,
  estimateInputTokensFromAnthropicBody,
  extractUsageFromResponseBody,
  injectImagesIntoMessagesBody,
  normalizeThinkingEffortFields,
  prepareClaudeBridgeMessagesRequest,
  prepareGatewayBindingForwardRequest,
  resolveProxyRoute,
  resolveRouteMaxOutputTokens,
  runtimeRouteToProxyRoute,
} from "../src/main/anthropic-proxy";
import { globalClaudeBridgeBindingRegistry } from "../src/main/claude-bridge-binding";
import type { ProviderConfigSecret } from "../src/main/provider-store";

test("resolves provider routes by local model alias", () => {
  const provider = createProvider("qwen", "Qwen Anthropic", "provider-secret");
  const route: AnthropicProxyResolvedRoute = {
    role: "coder",
    provider,
    modelId: "qwen-coder",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("coder", provider.id, "qwen-coder"),
  };

  expect(resolveProxyRoute([route], route.aliasModelId)).toEqual(route);
  expect(resolveProxyRoute([route], "qwen-coder")).toEqual(route);
  expect(resolveProxyRoute([route], "missing-model")).toBeUndefined();
});

test("canonicalModelFamilyIds derives gpt-5.4 from gpt-5.4-mini", () => {
  expect(canonicalModelFamilyIds("gpt-5.4-mini")).toEqual(["gpt-5.4"]);
  expect(canonicalModelFamilyIds("claude-sonnet-4-6")).toEqual([]);
});

test("resolveProxyRoute maps canonical gpt-5.4 to unique gpt-5.4-mini explore route", () => {
  const provider = createProvider("openai", "OpenAI", "provider-secret");
  const exploreRoute: AnthropicProxyResolvedRoute = {
    role: "explore",
    provider,
    modelId: "gpt-5.4-mini",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("explore", provider.id, "gpt-5.4-mini"),
  };
  const plannerRoute: AnthropicProxyResolvedRoute = {
    role: "main",
    provider,
    modelId: "gpt-5.5",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("main", provider.id, "gpt-5.5"),
  };
  expect(resolveProxyRoute([exploreRoute, plannerRoute], "gpt-5.4")).toEqual(exploreRoute);
  expect(resolveProxyRoute([exploreRoute, plannerRoute], "gpt-5.4-mini")).toEqual(exploreRoute);
});

test("resolveProxyRoute does not guess when multiple routes share a family prefix", () => {
  const provider = createProvider("openai", "OpenAI", "provider-secret");
  const routes: AnthropicProxyResolvedRoute[] = [
    {
      role: "explore",
      provider,
      modelId: "gpt-5.4-mini",
      apiCompat: "anthropic",
      aliasModelId: createModelAlias("explore", provider.id, "gpt-5.4-mini"),
    },
    {
      role: "coder",
      provider,
      modelId: "gpt-5.4-turbo",
      apiCompat: "anthropic",
      aliasModelId: createModelAlias("coder", provider.id, "gpt-5.4-turbo"),
    },
  ];
  expect(resolveProxyRoute(routes, "gpt-5.4")).toBeUndefined();
});

test("resolveProxyRoute maps canonical gpt-5.4 to explore when roles share gpt-5.4-mini", () => {
  const provider = createProvider("openai", "OpenAI", "provider-secret");
  const exploreRoute: AnthropicProxyResolvedRoute = {
    role: "explore",
    provider,
    modelId: "gpt-5.4-mini",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("explore", provider.id, "gpt-5.4-mini"),
  };
  const coderRoute: AnthropicProxyResolvedRoute = {
    role: "coder",
    provider,
    modelId: "gpt-5.4-mini",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("coder", provider.id, "gpt-5.4-mini"),
  };
  const testerRoute: AnthropicProxyResolvedRoute = {
    role: "tester",
    provider,
    modelId: "gpt-5.4-mini",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("tester", provider.id, "gpt-5.4-mini"),
  };
  const routes = [coderRoute, exploreRoute, testerRoute];
  expect(resolveProxyRoute(routes, "gpt-5.4")).toEqual(exploreRoute);
  expect(resolveProxyRoute(routes, "gpt-5.4-mini")).toEqual(exploreRoute);
});

test("buildModelsListResponse lists only eco alias ids for SDK discovery", () => {
  const provider = createProvider("openai", "OpenAI", "provider-secret");
  const route: AnthropicProxyResolvedRoute = {
    role: "explore",
    provider,
    modelId: "gpt-5.4-mini",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("explore", provider.id, "gpt-5.4-mini"),
  };
  const ids = buildModelsListResponse([route]).data.map((entry) => entry.id);
  expect(ids).toEqual([route.aliasModelId]);
  expect(ids).not.toContain("gpt-5.4-mini");
  expect(ids).not.toContain("gpt-5.4");
  const displayNames = buildModelsListResponse([route]).data.map((entry) => entry.display_name);
  expect(displayNames.every((name) => !name.includes("gpt-5.4"))).toBe(true);
});

test("buildModelsListResponse lists one alias per configured route", () => {
  const provider = createProvider("openai", "OpenAI", "provider-secret");
  const exploreRoute: AnthropicProxyResolvedRoute = {
    role: "explore",
    provider,
    modelId: "gpt-5.4-mini",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("explore", provider.id, "gpt-5.4-mini"),
  };
  const coderRoute: AnthropicProxyResolvedRoute = {
    role: "coder",
    provider,
    modelId: "gpt-5.4-mini",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("coder", provider.id, "gpt-5.4-mini"),
  };
  const ids = buildModelsListResponse([exploreRoute, coderRoute]).data.map((entry) => entry.id);
  expect(ids).toEqual([exploreRoute.aliasModelId, coderRoute.aliasModelId]);
});

test("resolveProxyRoute does not guess SDK built-in Explore model ids", () => {
  const provider = createProvider("anthropic", "Anthropic", "provider-secret");
  const exploreRoute: AnthropicProxyResolvedRoute = {
    role: "explore",
    provider,
    modelId: "claude-haiku-4-5-20251001",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("explore", provider.id, "claude-haiku-4-5-20251001"),
  };
  const plannerRoute: AnthropicProxyResolvedRoute = {
    role: "main",
    provider,
    modelId: "claude-sonnet-4-6",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("main", provider.id, "claude-sonnet-4-6"),
  };
  expect(resolveProxyRoute([exploreRoute, plannerRoute], "gpt-5.4")).toBeUndefined();
});

test("resolveProxyRoute does not guess SDK default Claude models", () => {
  const provider = createProvider("openai", "OpenAI", "provider-secret");
  const exploreRoute: AnthropicProxyResolvedRoute = {
    role: "explore",
    provider,
    modelId: "gpt-5.4-mini",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("explore", provider.id, "gpt-5.4-mini"),
  };
  const plannerRoute: AnthropicProxyResolvedRoute = {
    role: "main",
    provider,
    modelId: "gpt-5.5",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("main", provider.id, "gpt-5.5"),
  };
  expect(resolveProxyRoute([exploreRoute, plannerRoute], "claude-haiku-4-5-20251001")).toBeUndefined();
  expect(resolveProxyRoute([exploreRoute, plannerRoute], "claude-sonnet-4-6")).toBeUndefined();
});

test("resolveProxyRoute matches alias with [1m] suffix stripped", () => {
  const provider = createProvider("anthropic", "Anthropic", "provider-secret");
  const baseAlias = createModelAlias("main", provider.id, "claude-opus-4-8");
  const route: AnthropicProxyResolvedRoute = {
    role: "main",
    provider,
    modelId: "claude-opus-4-8",
    apiCompat: "anthropic",
    aliasModelId: `${baseAlias}[1m]`,
    contextTokens: 1_000_000,
  };

  expect(resolveProxyRoute([route], `${baseAlias}[1m]`)).toEqual(route);
  expect(resolveProxyRoute([route], baseAlias)).toEqual(route);
});

test("toSdkModelAlias appends [1m] when context is at least 1M", async () => {
  const { toSdkModelAlias, supportsExtendedContextModelSuffix } = await import("../src/main/anthropic-proxy");
  const base = "eco-planner-abc123";
  expect(supportsExtendedContextModelSuffix(999_999)).toBe(false);
  expect(supportsExtendedContextModelSuffix(1_000_000)).toBe(true);
  expect(toSdkModelAlias(base, 200_000)).toBe(base);
  expect(toSdkModelAlias(base, 1_000_000)).toBe(`${base}[1m]`);
  expect(toSdkModelAlias(`${base}[1m]`, 1_000_000)).toBe(`${base}[1m]`);
});

test("createModelAlias includes explore role", () => {
  const provider = createProvider("qwen", "Qwen Anthropic", "provider-secret");
  const alias = createModelAlias("explore", provider.id, "qwen-explore");
  expect(alias).toMatch(/^eco-explore-/);
  const route: AnthropicProxyResolvedRoute = {
    role: "explore",
    provider,
    modelId: "qwen-explore",
    apiCompat: "anthropic",
    aliasModelId: alias,
  };
  expect(resolveProxyRoute([route], alias)).toEqual(route);
});

test("lists alias ids for SDK model discovery", () => {
  const provider = createProvider("qwen", "Qwen Anthropic", "provider-secret");
  const route: AnthropicProxyResolvedRoute = {
    role: "main",
    provider,
    modelId: "qwen-planner",
    apiCompat: "anthropic",
    aliasModelId: createModelAlias("main", provider.id, "qwen-planner"),
  };

  const response = buildModelsListResponse([route]);
  expect(response.data.map((entry) => entry.id)).toEqual([route.aliasModelId]);
});

test("estimateInputTokensFromAnthropicBody counts messages and system", () => {
  const estimate = estimateInputTokensFromAnthropicBody({
    system: "hello",
    messages: [{ role: "user", content: "world" }],
  });
  expect(estimate).toBeGreaterThan(0);
});

test("estimateInputTokensFromAnthropicBody reflects the current request body", () => {
  const small = estimateInputTokensFromAnthropicBody({
    messages: [{ role: "user", content: "short" }],
  });
  const large = estimateInputTokensFromAnthropicBody({
    system: "系统约束",
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "long ".repeat(1_000) }],
  });
  expect(large).toBeGreaterThan(small);
});

test("injectImagesIntoMessagesBody prepends image blocks to last user message", () => {
  const body = {
    messages: [
      { role: "assistant", content: "hi" },
      { role: "user", content: "describe this" },
    ],
  };
  injectImagesIntoMessagesBody(body, [{ mediaType: "image/png", data: "abc123" }]);
  const user = body.messages[1] as { content: Array<{ type: string }> };
  expect(Array.isArray(user.content)).toBe(true);
  expect(user.content[0]?.type).toBe("image");
  expect(user.content[1]?.type).toBe("text");
});

test("normalizeThinkingEffortFields removes reasoning effort when thinking is disabled", () => {
  const body: Record<string, unknown> = {
    thinking: { type: "disabled" },
    reasoning_effort: "medium",
    effort: "medium",
    output_config: { effort: "medium", other: true },
  };

  normalizeThinkingEffortFields(body);

  expect(body).toEqual({
    thinking: { type: "disabled" },
    output_config: { other: true },
  });
});

test("normalizeThinkingEffortFields preserves effort when thinking is enabled", () => {
  const body: Record<string, unknown> = {
    thinking: { type: "adaptive" },
    reasoning_effort: "medium",
  };

  normalizeThinkingEffortFields(body);

  expect(body).toEqual({
    thinking: { type: "adaptive" },
    reasoning_effort: "medium",
  });
});

test("resolveRouteMaxOutputTokens reads positive manualSpec values only", () => {
  expect(resolveRouteMaxOutputTokens({ maxOutputTokens: 64_000 })).toBe(64_000);
  expect(resolveRouteMaxOutputTokens({ maxOutputTokens: 0 })).toBeUndefined();
  expect(resolveRouteMaxOutputTokens(undefined)).toBeUndefined();
});

test("runtimeRouteToProxyRoute maps manualSpec maxOutputTokens onto proxy route", () => {
  const provider = createProvider("anthropic", "Anthropic", "provider-secret");
  const route = runtimeRouteToProxyRoute(
    {
      role: "coder",
      provider,
      modelId: "claude-sonnet-4-6",
      manualSpec: { maxOutputTokens: 32_768 },
    },
    { globalMaxOutputTokens: 64_000 },
  );
  expect(route.maxOutputTokens).toBe(32_768);
});

test("runtimeRouteToProxyRoute clamps illegal model max output by global ceiling", () => {
  const provider = createProvider("anthropic", "Anthropic", "provider-secret");
  const route = runtimeRouteToProxyRoute(
    {
      role: "coder",
      provider,
      modelId: "deepseek-v4-flash",
      manualSpec: { maxOutputTokens: 384_000, contextTokens: 258_000 },
    },
    { globalMaxOutputTokens: 32_000, contextTokens: 258_000 },
  );
  expect(route.maxOutputTokens).toBe(32_000);
});

test("runtimeRouteToProxyRoute defaults missing model max output to global 32K", () => {
  const provider = createProvider("anthropic", "Anthropic", "provider-secret");
  const route = runtimeRouteToProxyRoute({
    role: "coder",
    provider,
    modelId: "some-model",
  });
  expect(route.maxOutputTokens).toBe(32_768);
});

test("applyRouteMaxOutputTokens preserves a smaller SDK budget", () => {
  const body: Record<string, unknown> = { max_tokens: 16_000, model: "claude-sonnet-4-6" };
  applyRouteMaxOutputTokens(body, 64_000);
  expect(body.max_tokens).toBe(16_000);
});

test("applyRouteMaxOutputTokens is a no-op without configured cap", () => {
  const body: Record<string, unknown> = { max_tokens: 16_000 };
  applyRouteMaxOutputTokens(body, undefined);
  expect(body.max_tokens).toBe(16_000);
});

test("extractUsageFromResponseBody reads non-streaming response usage", () => {
  const usage = extractUsageFromResponseBody({
    id: "msg_1",
    type: "message",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
  });

  expect(usage).toMatchObject({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheCreationTokens: 40,
  });
});

test("extractUsageFromResponseBody dedupes OpenAI-compat total plus cache subset", () => {
  const usage = extractUsageFromResponseBody({
    usage: {
      input_tokens: 24_748,
      output_tokens: 20,
      cache_read_input_tokens: 24_588,
    },
  });

  expect(usage).toMatchObject({
    inputTokens: 160,
    outputTokens: 20,
    cacheReadTokens: 24_588,
    cacheCreationTokens: 0,
  });
});

test("createStreamingUsageTracker reads streaming response usage", () => {
  const tracker = createStreamingUsageTracker();
  tracker.push(
    Buffer.from(
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 80,
            output_tokens: 1,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 12,
          },
        },
      })}\n\n`,
    ),
  );
  tracker.push(
    Buffer.from(
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 25 },
      })}\n\n`,
    ),
  );

  expect(tracker.finish()).toMatchObject({
    inputTokens: 80,
    outputTokens: 25,
    cacheReadTokens: 10,
    cacheCreationTokens: 12,
  });
});

test("createStreamingUsageTracker merges raw chunks then dedupes OpenAI-compat totals", () => {
  const tracker = createStreamingUsageTracker();
  tracker.push(
    Buffer.from(
      `data: ${JSON.stringify({
        type: "message_delta",
        usage: {
          input_tokens: 1301,
          output_tokens: 5,
          cache_read_input_tokens: 2803,
        },
      })}\n\n`,
    ),
  );
  tracker.push(
    Buffer.from(
      `data: ${JSON.stringify({
        type: "message_delta",
        usage: {
          input_tokens: 3105,
          output_tokens: 20,
          cache_read_input_tokens: 2803,
        },
      })}\n\n`,
    ),
  );

  const usage = tracker.finish();
  expect(usage).toMatchObject({
    inputTokens: 302,
    outputTokens: 20,
    cacheReadTokens: 2803,
    cacheCreationTokens: 0,
  });
  expect((usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0)).toBe(3105);
});

beforeEach(() => {
  globalClaudeBridgeBindingRegistry.clearAllForTests();
});

test("runtimeRouteToProxyRoute carries disabled vision into the request binding", () => {
  expect(
    runtimeRouteToProxyRoute({
      role: "main",
      provider: createProvider("local", "Local", "key"),
      modelId: "text-model",
      manualSpec: { supportsImageInput: false },
    }).supportsImageInput,
  ).toBe(false);
});

test("bridge rejects images locally on every API face without consuming pending state or request callbacks", async () => {
  const cases = [
    {
      face: "responses",
      body: {
        input: [
          { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,bytes" }] },
        ],
      },
    },
    {
      face: "chat_completions",
      body: {
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }],
          },
        ],
      },
    },
    {
      face: "messages",
      body: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                content: [{ type: "image", source: { type: "base64", data: "bytes" } }],
              },
            ],
          },
        ],
      },
    },
  ] as const;
  for (const { face, body } of cases) {
    let callbacks = 0;
    const binding = globalClaudeBridgeBindingRegistry.create({
      routes: [
        {
          role: "main",
          provider: createProvider("local", "Local", "key"),
          modelId: "text-model",
          aliasModelId: "text-alias",
          apiCompat: "openai_chat_completions",
          supportsImageInput: false,
        },
      ],
      callbacks: {
        onMessagesRequest: () => {
          callbacks += 1;
        },
      },
    });
    const request = {
      body: structuredClone(body),
      requestedModel: "text-alias",
      headers: new Headers({ authorization: `Bearer ${binding.credential}` }),
    };
    const result =
      face === "messages"
        ? await prepareClaudeBridgeMessagesRequest({ ...request, path: "/v1/messages" })
        : await prepareGatewayBindingForwardRequest({ ...request, face });
    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("image request unexpectedly forwarded");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toMatchObject({ error: { code: "image_input_disabled" } });
    expect(callbacks).toBe(0);
    expect(binding.inFlight).toBe(0);
    expect(binding.imagesInjected).toBe(false);
  }
});

test("Messages rejects pending attachments before injecting or consuming them", async () => {
  const binding = globalClaudeBridgeBindingRegistry.create({
    routes: [
      {
        role: "main",
        provider: createProvider("local", "Local", "key"),
        modelId: "text-model",
        aliasModelId: "text-alias",
        apiCompat: "anthropic",
        supportsImageInput: false,
      },
    ],
    pendingImages: [{ id: "image", mediaType: "image/png", data: "bytes" }],
  });
  for (const requestPath of ["/v1/messages/count_tokens", "/v1/messages"]) {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const result = await prepareClaudeBridgeMessagesRequest({
      path: requestPath,
      body,
      requestedModel: "text-alias",
      headers: new Headers({ "x-api-key": binding.credential }),
    });
    expect(result.kind).toBe("response");
    expect(binding.pendingImages).toHaveLength(1);
    expect(binding.imagesInjected).toBe(false);
    expect(body.messages[0]?.content).toBe("hi");
    expect(binding.inFlight).toBe(0);
  }
});

test("prepareGatewayBindingForwardRequest allows openai_chat_completions route on responses face", async () => {
  const provider = createProvider("deepseek", "DeepSeek", "secret");
  const alias = createModelAlias("main", provider.id, "deepseek-chat");
  const binding = globalClaudeBridgeBindingRegistry.create({
    threadId: "thr_pi",
    routes: [
      {
        role: "main",
        provider,
        modelId: "deepseek-chat",
        aliasModelId: alias,
        apiCompat: "openai_chat_completions",
      },
    ],
  });

  const result = await prepareGatewayBindingForwardRequest({
    face: "responses",
    body: { model: alias },
    requestedModel: alias,
    headers: new Headers({ authorization: `Bearer ${binding.credential}` }),
  });

  expect(result.kind).toBe("forward");
  if (result.kind === "forward") {
    expect(result.resolution.upstreamKind).toBe("openai-chat");
    expect(result.resolution.upstreamModelId).toBe("deepseek-chat");
    result.releaseLease();
  }
});

test("prepareGatewayBindingForwardRequest allows anthropic route on responses face", async () => {
  const provider = createProvider("anthropic", "Anthropic", "secret");
  const alias = createModelAlias("main", provider.id, "claude-sonnet");
  const binding = globalClaudeBridgeBindingRegistry.create({
    threadId: "thr_pi",
    routes: [
      {
        role: "main",
        provider,
        modelId: "claude-sonnet",
        aliasModelId: alias,
        apiCompat: "anthropic",
      },
    ],
  });

  const result = await prepareGatewayBindingForwardRequest({
    face: "responses",
    body: { model: alias },
    requestedModel: alias,
    headers: new Headers({ authorization: `Bearer ${binding.credential}` }),
  });

  expect(result.kind).toBe("forward");
  if (result.kind === "forward") {
    expect(result.resolution.upstreamKind).toBe("anthropic-messages");
    result.releaseLease();
  }
});

test("prepareGatewayBindingForwardRequest still rejects non-chat route on chat_completions face", async () => {
  const provider = createProvider("openai", "OpenAI", "secret");
  const alias = createModelAlias("main", provider.id, "gpt-5.2");
  const binding = globalClaudeBridgeBindingRegistry.create({
    threadId: "thr_pi",
    routes: [
      {
        role: "main",
        provider,
        modelId: "gpt-5.2",
        aliasModelId: alias,
        apiCompat: "openai_responses",
      },
    ],
  });

  const result = await prepareGatewayBindingForwardRequest({
    face: "chat_completions",
    body: { model: alias },
    requestedModel: alias,
    headers: new Headers({ authorization: `Bearer ${binding.credential}` }),
  });

  expect(result.kind).toBe("response");
  if (result.kind === "response") {
    expect(result.response.status).toBe(400);
    const payload = (await result.response.json()) as { error: { message: string } };
    expect(payload.error.message).toContain("face=chat_completions");
  }
});

function createProvider(
  id: string,
  name: string,
  apiKey: string,
  baseUrl = `https://${id}.example.com`,
  requestPath = "",
): ProviderConfigSecret {
  return {
    id,
    name,
    baseUrl,
    requestPath,
    apiCompat: "anthropic",
    defaultModel: "sonnet",
    enabled: true,
    hasApiKey: true,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    apiKey,
  };
}
