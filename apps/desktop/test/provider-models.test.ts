import { describe, expect, test } from "bun:test";
import {
  buildBridgeProviderTestAnthropicRequest,
  buildBridgeProviderTestUpstreamBody,
} from "../src/main/bridge-provider-test";
import { ROUTE_TEST_THINKING_EFFORT } from "../src/shared/models";

function mockAnthropicUpstreamMessage(text: string): Response {
  return new Response(
    JSON.stringify({
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200 },
  );
}

function expectAnthropicNativeUpstreamBody(body: unknown, modelId: string): void {
  expect(body).toMatchObject({
    model: modelId,
    max_tokens: 256,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
  });
  expect(body).not.toHaveProperty("stream");
  expect(body).not.toHaveProperty("input");
  expect(body).not.toHaveProperty("store");
  expect(body).not.toHaveProperty("parallel_tool_calls");
}

import {
  buildChatCompletionsTestRequestBody,
  buildChatCompletionsUrl,
  buildMessagesUrl,
  buildModelsListUrl,
  buildOpenAICompatUpstreamUrl,
  buildProviderRequestBaseUrl,
  buildProviderTestRequestBody,
  buildResponsesInputTokensUrl,
  buildResponsesTestRequestBody,
  buildRouteTestDedupeKey,
  CODEX_AUTH_MODELS_UNAVAILABLE_ERROR,
  describeProviderCompatRouting,
  listProviderUpstreamModels,
  normalizeRequestPath,
  parseUpstreamModelsPayload,
  resolveModelsListUrl,
  splitBaseUrlAndRequestPath,
  testProviderConnection,
  testRoleRoutes,
} from "../src/main/provider-models";
import type { ProviderStore } from "../src/main/provider-store";
import { normalizeUpstreamApiCompat } from "../src/shared/api-compat";

describe("listProviderUpstreamModels", () => {
  test("returns localizable details when a saved provider has no baseURL", async () => {
    const store = {
      getProviderWithSecret: () => ({
        id: "omlx",
        name: "oMLX",
        baseUrl: "",
        requestPath: "",
        version: "v1",
        apiCompat: "anthropic",
        apiKey: "",
        enabled: true,
      }),
    } as unknown as ProviderStore;

    const result = await listProviderUpstreamModels(store, { providerId: "omlx" });

    expect(result).toEqual({
      ok: false,
      error: "Provider「oMLX」的 baseURL 为空，请在设置中填写服务地址。",
      errorCode: "provider_base_url_missing",
      providerId: "omlx",
      providerName: "oMLX",
    });
  });

  test("still queries upstream /v1/models without an API key and surfaces the upstream error", async () => {
    const previousFetch = globalThis.fetch;
    const calls: Array<{ url: string; hasAuth: boolean }> = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        hasAuth: Boolean(new Headers(init?.headers ?? {}).get("authorization")),
      });
      return new Response(JSON.stringify({ error: { message: "missing credentials" } }), { status: 401 });
    }) as unknown as typeof fetch;

    const store = {
      getProviderWithSecret: () => ({
        id: "plus64",
        name: "Plus64",
        baseUrl: "http://localhost:8080",
        requestPath: "",
        version: "v1",
        apiCompat: "openai_chat_completions",
        apiKey: "",
        enabled: true,
        authMethod: "api_key",
      }),
    } as unknown as ProviderStore;

    try {
      const result = await listProviderUpstreamModels(store, { providerId: "plus64" });

      expect(calls).toEqual([{ url: "http://localhost:8080/v1/models", hasAuth: false }]);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error).toContain("上游 401：missing credentials");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("refuses to invent a model list for Codex Auth (auth.json) providers", async () => {
    const store = {
      getProviderWithSecret: () => ({
        id: "openai",
        name: "OpenAI",
        baseUrl: "http://localhost:8080",
        requestPath: "/v1",
        version: "v1",
        apiCompat: "openai_responses",
        apiKey: "",
        enabled: true,
        authMethod: "auth_json",
      }),
    } as unknown as ProviderStore;

    const result = await listProviderUpstreamModels(store, { providerId: "openai" });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe(CODEX_AUTH_MODELS_UNAVAILABLE_ERROR);
    expect(result.providerId).toBe("openai");
  });
});

describe("splitBaseUrlAndRequestPath", () => {
  test("splits legacy baseURL with path suffix", () => {
    expect(splitBaseUrlAndRequestPath("https://api.deepseek.com/anthropic")).toEqual({
      baseUrl: "https://api.deepseek.com",
      requestPath: "/anthropic",
    });
  });

  test("leaves bare origin unchanged", () => {
    expect(splitBaseUrlAndRequestPath("https://api.anthropic.com")).toEqual({
      baseUrl: "https://api.anthropic.com",
      requestPath: "",
    });
  });
});

describe("buildProviderRequestBaseUrl", () => {
  test("combines baseURL and request path", () => {
    expect(buildProviderRequestBaseUrl("https://api.deepseek.com", "/anthropic")).toBe(
      "https://api.deepseek.com/anthropic",
    );
  });

  test("normalizes request path without leading slash", () => {
    expect(buildProviderRequestBaseUrl("https://api.deepseek.com", "anthropic")).toBe(
      "https://api.deepseek.com/anthropic",
    );
  });
});

describe("buildModelsListUrl", () => {
  test("uses bare baseURL", () => {
    expect(buildModelsListUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/v1/models");
    expect(buildModelsListUrl("http://127.0.0.1:55302")).toBe("http://127.0.0.1:55302/v1/models");
  });

  test("ignores messages-only request path (DeepSeek /anthropic)", () => {
    expect(buildModelsListUrl("https://api.deepseek.com", "/anthropic")).toBe(
      "https://api.deepseek.com/v1/models",
    );
    expect(buildModelsListUrl("https://api.deepseek.com/anthropic")).toBe(
      "https://api.deepseek.com/v1/models",
    );
  });

  test("includes service path prefix (OpenCode Zen)", () => {
    expect(buildModelsListUrl("https://opencode.ai/zen")).toBe("https://opencode.ai/zen/v1/models");
    expect(buildModelsListUrl("https://opencode.ai", "/zen")).toBe("https://opencode.ai/zen/v1/models");
  });

  test("strips OpenAI-compat endpoint suffixes from baseURL", () => {
    expect(buildModelsListUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1/models",
    );
    expect(buildModelsListUrl("https://api.example.com", "/v1/responses")).toBe(
      "https://api.example.com/v1/models",
    );
  });

  test("returns undefined when baseURL is empty", () => {
    expect(buildModelsListUrl("")).toBeUndefined();
    expect(buildModelsListUrl("  ")).toBeUndefined();
  });
});

describe("resolveModelsListUrl", () => {
  test("rejects empty base with clear error", () => {
    const result = resolveModelsListUrl("", "/anthropic");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("baseURL");
    }
  });
});

describe("describeProviderCompatRouting", () => {
  test("documents incompatible OpenAI Responses on /anthropic without stripping path", () => {
    const routing = describeProviderCompatRouting(
      "https://api.deepseek.com",
      "/anthropic",
      "openai_responses",
    );
    expect(routing.apiCompat).toBe("openai_responses");
    expect(routing.chatApi).toBe("openai-v1-responses");
    expect(routing.chatUrl).toBe("(incompatible-config)");
    expect(routing.compatNotes.some((n) => n.includes("不会静默去掉"))).toBe(true);
  });

  test("documents OpenAI Chat Completions path", () => {
    const routing = describeProviderCompatRouting("https://api.deepseek.com", "", "openai_chat_completions");
    expect(routing.chatApi).toBe("openai-v1-chat-completions");
    expect(routing.chatUrl).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  test("normalizes legacy openai apiCompat to openai_responses", () => {
    expect(normalizeUpstreamApiCompat("openai")).toBe("openai_responses");
  });

  test("buildOpenAICompatUpstreamUrl prefers /v1/responses", () => {
    expect(buildOpenAICompatUpstreamUrl("https://api.example.com", "/zen")).toBe(
      "https://api.example.com/zen/v1/responses",
    );
  });

  test("buildResponsesInputTokensUrl targets /v1/responses/input_tokens", () => {
    expect(buildResponsesInputTokensUrl("https://api.example.com", "/zen")).toBe(
      "https://api.example.com/zen/v1/responses/input_tokens",
    );
  });

  test("buildResponsesInputTokensUrl rejects OpenAI on /anthropic instead of stripping", () => {
    expect(() => buildResponsesInputTokensUrl("https://api.deepseek.com", "/anthropic")).toThrow(
      /不会静默去掉 \/anthropic/,
    );
  });

  test("buildChatCompletionsUrl targets /v1/chat/completions", () => {
    expect(buildChatCompletionsUrl("https://api.example.com", "/zen")).toBe(
      "https://api.example.com/zen/v1/chat/completions",
    );
  });

  test("documents Anthropic messages path vs OpenAI models list", () => {
    const routing = describeProviderCompatRouting("https://api.deepseek.com", "/anthropic");
    expect(routing.modelsDiscoveryApi).toBe("openai-get-v1-models");
    expect(routing.chatApi).toBe("anthropic-v1-messages");
    expect(routing.modelsListUrl).toBe("https://api.deepseek.com/v1/models");
    expect(routing.chatUrl).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(routing.compatNotes.some((n) => n.includes("OpenAI"))).toBe(true);
    expect(routing.compatNotes.some((n) => n.includes("Anthropic"))).toBe(true);
  });
});

describe("buildMessagesUrl", () => {
  test("appends request path before /v1/messages", () => {
    expect(buildMessagesUrl("https://api.deepseek.com", "/anthropic")).toBe(
      "https://api.deepseek.com/anthropic/v1/messages",
    );
  });

  test("works for bare host", () => {
    expect(buildMessagesUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
  });

  test("supports legacy combined baseURL", () => {
    expect(buildMessagesUrl("https://api.deepseek.com/anthropic")).toBe(
      "https://api.deepseek.com/anthropic/v1/messages",
    );
  });

  test("buildMessagesUrl uses custom version segment", () => {
    expect(buildMessagesUrl("https://api.example.com", "", "v2")).toBe("https://api.example.com/v2/messages");
  });
});

describe("normalizeRequestPath", () => {
  test("adds leading slash and trims trailing slash", () => {
    expect(normalizeRequestPath("anthropic/")).toBe("/anthropic");
  });
});

describe("parseUpstreamModelsPayload", () => {
  test("parses Anthropic-style models list", () => {
    const models = parseUpstreamModelsPayload({
      data: [
        { id: "claude-opus-4-7", display_name: "Opus 4.7", type: "model" },
        { id: "claude-sonnet-4-6", display_name: "Sonnet 4.6", type: "model" },
      ],
    });
    expect(models).toEqual([
      { id: "claude-opus-4-7", displayName: "Opus 4.7" },
      { id: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
    ]);
  });

  test("parses OpenAI-style models list", () => {
    const models = parseUpstreamModelsPayload({
      data: [{ id: "gpt-4o", object: "model" }],
    });
    expect(models).toEqual([{ id: "gpt-4o", displayName: undefined }]);
  });

  test("parses Ollama native tags list", () => {
    const models = parseUpstreamModelsPayload({
      models: [{ name: "qwen2.5-coder:7b", model: "qwen2.5-coder:7b" }],
    });
    expect(models).toEqual([{ id: "qwen2.5-coder:7b", displayName: "qwen2.5-coder:7b" }]);
  });
});

describe("buildProviderTestRequestBody", () => {
  test("disables thinking and allows enough tokens for a short reply", () => {
    expect(buildProviderTestRequestBody("qwen3")).toEqual({
      model: "qwen3",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    });
  });
});

describe("buildProviderTestRequestBody", () => {
  test("anthropic test body stays native without responses IR", () => {
    const anthropicRequest = buildBridgeProviderTestAnthropicRequest(
      "claude-sonnet-4-6",
      ROUTE_TEST_THINKING_EFFORT,
    );
    const { body } = buildBridgeProviderTestUpstreamBody("anthropic", anthropicRequest, "claude-sonnet-4-6");
    expectAnthropicNativeUpstreamBody(body, "claude-sonnet-4-6");
  });
});

describe("buildOpenAICompatTestRequestBody", () => {
  test("chat completions test uses bridge with streaming", () => {
    expect(buildChatCompletionsTestRequestBody("gpt-5.2")).toMatchObject({
      model: "gpt-5.2",
      stream: true,
    });
    expect(buildChatCompletionsTestRequestBody("gpt-5.2").messages).toEqual([
      { role: "user", content: "hi" },
    ]);
    expect(buildChatCompletionsTestRequestBody("gpt-5.2")).not.toHaveProperty("reasoning_effort");
  });

  test("responses test uses list input for compatible providers", () => {
    const body = buildResponsesTestRequestBody("gpt-5.2");
    expect(body).toEqual({
      model: "gpt-5.2",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
      max_output_tokens: 256,
    });
  });
});

describe("testProviderConnection", () => {
  test("returns localizable details when a saved provider has no baseURL", async () => {
    const store = {
      getProviderWithSecret: () => ({
        id: "omlx",
        name: "oMLX",
        baseUrl: "",
        requestPath: "",
        version: "v1",
        apiCompat: "anthropic",
        apiKey: "",
        enabled: true,
      }),
    } as unknown as ProviderStore;

    const result = await testProviderConnection(store, {
      providerId: "omlx",
      defaultModel: "model-a",
    });

    expect(result).toEqual({
      ok: false,
      error: "Provider「oMLX」的 baseURL 为空，请在设置中填写服务地址。",
      errorCode: "provider_base_url_missing",
      providerId: "omlx",
      providerName: "oMLX",
    });
  });

  test("requires default model", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const result = await testProviderConnection(store, {
      baseUrl: "https://api.example.com",
      defaultModel: "  ",
    });
    expect(result).toEqual({ ok: false, error: "请先选择要测试的模型。" });
  });

  test("returns upstream error details", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const fetcher = async () =>
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 });

    const result = await testProviderConnection(
      store,
      {
        baseUrl: "https://api.example.com",
        requestPath: "",
        version: "v1",
        defaultModel: "claude-sonnet-4-6",
        apiKey: "bad",
      },
      fetcher,
    );

    expect(result).toEqual({ ok: false, error: "上游 401：invalid api key" });
  });

  test("uses request path for messages endpoint", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const fetcher = async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.deepseek.com/anthropic/v1/messages");
      expectAnthropicNativeUpstreamBody(JSON.parse(String(init?.body)), "deepseek-chat");
      return mockAnthropicUpstreamMessage("ok");
    };

    const result = await testProviderConnection(
      store,
      {
        baseUrl: "https://api.deepseek.com",
        requestPath: "/anthropic",
        version: "v1",
        defaultModel: "deepseek-chat",
      },
      fetcher,
    );

    expect(result).toEqual({ ok: true, reply: "ok" });
  });

  test("rejects openai_responses on /anthropic without calling upstream", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    let called = false;
    const fetcher = async () => {
      called = true;
      return new Response("should not run", { status: 500 });
    };

    const result = await testProviderConnection(
      store,
      {
        baseUrl: "https://api.deepseek.com",
        requestPath: "/anthropic",
        version: "v1",
        defaultModel: "deepseek-v4-flash",
        apiKey: "k",
        apiCompat: "openai_responses",
      },
      fetcher,
    );

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/不会静默去掉 \/anthropic/);
  });

  test("succeeds when assistant text is returned", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const fetcher = async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.example.com/v1/messages");
      expectAnthropicNativeUpstreamBody(JSON.parse(String(init?.body)), "claude-sonnet-4-6");
      return mockAnthropicUpstreamMessage("Hello! How can I help?");
    };

    const result = await testProviderConnection(
      store,
      { baseUrl: "https://api.example.com", defaultModel: "claude-sonnet-4-6" },
      fetcher,
    );

    expect(result).toEqual({ ok: true, reply: "Hello! How can I help?" });
  });

  test("accepts thinking-only replies when text is absent", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          type: "message",
          role: "assistant",
          model: "qwen3",
          content: [{ type: "thinking", thinking: "The user said hi." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );

    const result = await testProviderConnection(
      store,
      { baseUrl: "https://api.example.com", defaultModel: "qwen3" },
      fetcher,
    );

    expect(result).toEqual({ ok: true, reply: "The user said hi." });
  });

  test("accepts OpenAI chat completions replies without anthropic conversion loss", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const fetcher = async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true });
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("reasoning_effort");
      return new Response(
        JSON.stringify({
          id: "gen-test",
          object: "chat.completion",
          model: "xiaomi/mimo-v2.5-20260422",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Hi there! How can I help you today?",
                reasoning: "The user said hi.",
              },
            },
          ],
          usage: {
            prompt_tokens: 250,
            completion_tokens: 141,
            total_tokens: 391,
            prompt_tokens_details: { cached_tokens: 192 },
          },
        }),
        { status: 200 },
      );
    };

    const result = await testProviderConnection(
      store,
      {
        baseUrl: "https://openrouter.ai/api",
        apiCompat: "openai_chat_completions",
        defaultModel: "xiaomi/mimo-v2.5-20260422",
      },
      fetcher,
    );

    expect(result).toEqual({ ok: true, reply: "Hi there! How can I help you today?" });
  });

  test("succeeds for OpenAI Responses buffered JSON via bridge", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const fetcher = async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.example.com/v1/responses");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "gpt-5.4",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
        max_output_tokens: 256,
      });
      return new Response(
        JSON.stringify({
          id: "resp_test",
          object: "response",
          status: "completed",
          model: "gpt-5.4",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello from responses API" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await testProviderConnection(
      store,
      {
        baseUrl: "https://api.example.com",
        apiCompat: "openai_responses",
        defaultModel: "gpt-5.4",
      },
      fetcher,
    );

    expect(result).toEqual({ ok: true, reply: "Hello from responses API" });
  });

  test("succeeds for OpenAI Responses SSE via bridge stream parser", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const sse = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"Hi"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"!"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      "",
    ].join("\n");

    const fetcher = async (url: string) => {
      expect(url).toBe("https://api.example.com/v1/responses");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const result = await testProviderConnection(
      store,
      {
        baseUrl: "https://api.example.com",
        apiCompat: "openai_responses",
        defaultModel: "gpt-5.4",
      },
      fetcher,
    );

    expect(result).toEqual({ ok: true, reply: "Hi!" });
  });

  test("fails when Responses stream and buffered body have no text", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          id: "resp_empty",
          object: "response",
          status: "completed",
          model: "gpt-5.4",
          output: [],
          usage: { input_tokens: 47, output_tokens: 11, total_tokens: 58 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const result = await testProviderConnection(
      store,
      {
        baseUrl: "https://api.example.com",
        apiCompat: "openai_responses",
        defaultModel: "gpt-5.4",
      },
      fetcher,
    );

    expect(result).toEqual({ ok: false, error: "上游未返回可识别的 assistant 文本。" });
  });

  test("surfaces upstream error from Responses SSE error events", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const sse = [
      'data: {"error":{"message":"model not found","type":"invalid_request_error"}}',
      "",
      "event: response.failed",
      'data: {"type":"response.failed","response":{"error":{"message":"model not found","code":"model_not_found"}}}',
      "",
    ].join("\n");

    const fetcher = async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const result = await testProviderConnection(
      store,
      {
        baseUrl: "https://api.example.com",
        apiCompat: "openai_responses",
        defaultModel: "gpt-5.4",
      },
      fetcher,
    );

    expect(result).toEqual({ ok: false, error: "上游错误：model not found" });
  });

  test("falls back to reasoning text for reasoning-only chat completions replies", async () => {
    const store = { getProviderWithSecret: () => undefined } as unknown as ProviderStore;
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          id: "gen-test",
          object: "chat.completion",
          model: "xiaomi/mimo-v2.5-20260422",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "",
                reasoning: "Hi there! How can I help you today?",
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      );

    const result = await testProviderConnection(
      store,
      {
        baseUrl: "https://openrouter.ai/api",
        apiCompat: "openai_chat_completions",
        defaultModel: "xiaomi/mimo-v2.5-20260422",
      },
      fetcher,
    );

    expect(result).toEqual({ ok: true, reply: "Hi there! How can I help you today?" });
  });
});

describe("buildRouteTestDedupeKey", () => {
  test("combines provider id and model id", () => {
    expect(buildRouteTestDedupeKey("p1", "claude-sonnet", "anthropic")).toBe("p1:claude-sonnet:anthropic");
    expect(buildRouteTestDedupeKey(" p1 ", " claude-sonnet ", "openai_responses")).toBe(
      "p1:claude-sonnet:openai_responses",
    );
  });
});

describe("testRoleRoutes", () => {
  test("dedupes identical provider and model to a single upstream call", async () => {
    const store = {
      getProviderWithSecret: (id: string) =>
        id === "p1"
          ? {
              id: "p1",
              name: "Test",
              baseUrl: "https://api.example.com",
              requestPath: "",
              version: "v1",
              apiCompat: "anthropic",
              apiKey: "key",
              enabled: true,
            }
          : undefined,
    } as unknown as ProviderStore;

    let callCount = 0;
    const fetcher = async () => {
      callCount += 1;
      return mockAnthropicUpstreamMessage("ok");
    };

    const result = await testRoleRoutes(
      store,
      {
        routes: [
          { role: "planner", providerId: "p1", modelId: "shared-model" },
          { role: "explore", providerId: "p1", modelId: "shared-model" },
          { role: "coder", providerId: "p1", modelId: "shared-model" },
          { role: "reviewer", providerId: "p1", modelId: "other-model" },
        ],
      },
      fetcher,
    );

    expect(callCount).toBe(2);
    expect(result.passed).toBe(4);
    expect(result.results.every((entry) => entry.ok)).toBe(true);
    expect(result.results.map((entry) => entry.modelId)).toEqual([
      "shared-model",
      "shared-model",
      "shared-model",
      "other-model",
    ]);
  });

  test("tests each configured role against /v1/messages", async () => {
    const store = {
      getProviderWithSecret: (id: string) =>
        id === "p1"
          ? {
              id: "p1",
              name: "Test",
              baseUrl: "https://api.example.com",
              requestPath: "",
              version: "v1",
              apiCompat: "anthropic",
              apiKey: "key",
              enabled: true,
            }
          : undefined,
    } as unknown as ProviderStore;

    let callCount = 0;
    const fetcher = async (_url: string, init?: RequestInit) => {
      callCount += 1;
      expectAnthropicNativeUpstreamBody(
        JSON.parse(String(init?.body)),
        callCount === 1 ? "model-a" : "model-b",
      );
      return mockAnthropicUpstreamMessage("ok");
    };

    const result = await testRoleRoutes(
      store,
      {
        routes: [
          { role: "planner", providerId: "p1", modelId: "model-a", thinkingEffort: "off" },
          { role: "coder", providerId: "p1", modelId: "model-b", thinkingEffort: "off" },
        ],
      },
      fetcher,
    );

    expect(callCount).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results.map((entry) => entry.ok)).toEqual([true, true]);
  });

  test("ignores non-off thinkingEffort on route test requests", async () => {
    const store = {
      getProviderWithSecret: (id: string) =>
        id === "p1"
          ? {
              id: "p1",
              name: "Test",
              baseUrl: "https://api.example.com",
              requestPath: "",
              version: "v1",
              apiCompat: "anthropic",
              apiKey: "key",
              enabled: true,
            }
          : undefined,
    } as unknown as ProviderStore;

    const fetcher = async (_url: string, init?: RequestInit) => {
      expectAnthropicNativeUpstreamBody(JSON.parse(String(init?.body)), "model-b");
      return mockAnthropicUpstreamMessage("ok");
    };

    const result = await testRoleRoutes(
      store,
      {
        routes: [{ role: "coder", providerId: "p1", modelId: "model-b", thinkingEffort: "low" }],
      },
      fetcher,
    );

    expect(result.passed).toBe(1);
  });
});
