import { expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnthropicRequest } from "@eco/openai-anthropic-bridge";
import {
  appendStreamUtf8Chunk,
  applyGatewayContextManagementPolyfill,
  applyResponsesRoutingHints,
  applyUpstreamMaxOutputLimit,
  buildBridgePromptCacheKey,
  buildBridgeUpstreamMessagesPayload,
  createStreamUtf8Decoder,
  finalizeStreamUtf8Decoder,
  forwardMessagesViaBridge,
  parseAnthropicStreamEventBlock,
  parseBridgeProbeReply,
  pruneAnthropicToolResults,
  splitSseBlocks,
  stripSemanticCompactionDirectives,
} from "../src/main/bridge-upstream";

test("buildBridgeUpstreamMessagesPayload passthrough anthropic without responses ir", () => {
  const request: AnthropicRequest = {
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [{ role: "user", content: "hi" }],
  };
  const body = buildBridgeUpstreamMessagesPayload("anthropic", request, "claude-sonnet-4-6", false);
  expect(body).toMatchObject({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(body).not.toHaveProperty("stream");
  expect(body).not.toHaveProperty("input");
  expect(body).not.toHaveProperty("store");
  expect(body).not.toHaveProperty("parallel_tool_calls");
});

test("stripSemanticCompactionDirectives removes provider compaction but preserves tool clearing", () => {
  const request: AnthropicRequest = {
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    context_management: {
      edits: [
        { type: "compact_20260112", trigger: { type: "input_tokens", value: 100_000 } },
        { type: "clear_tool_uses_20250919", keep: { type: "tool_uses", value: 2 } },
      ],
    },
    messages: [{ role: "user", content: "hi" }],
  };

  const stripped = stripSemanticCompactionDirectives(request);
  expect(stripped.context_management).toEqual({
    edits: [{ type: "clear_tool_uses_20250919", keep: { type: "tool_uses", value: 2 } }],
  });
  expect(request.context_management).toHaveProperty("edits.0.type", "compact_20260112");
});

test("buildBridgeUpstreamMessagesPayload strips semantic compaction for Anthropic passthrough", () => {
  const request: AnthropicRequest = {
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    context_management: [{ type: "compaction", compact_threshold: 100_000 }],
    messages: [{ role: "user", content: "hi" }],
  };

  const body = buildBridgeUpstreamMessagesPayload("anthropic", request, "claude-sonnet-4-6", false);
  expect(body.context_management).toBeUndefined();
});

test("pruneAnthropicToolResults truncates oversized tool_result content", () => {
  const huge = `result ${"x".repeat(80_000)}`;
  const request: AnthropicRequest = {
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "Bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: huge }],
      },
    ],
  };
  const pruned = pruneAnthropicToolResults(request);
  expect(pruned.prunedCount).toBe(1);
  const content = (pruned.request.messages[1]?.content as Array<{ content?: string }>)[0]?.content;
  expect(typeof content).toBe("string");
  expect(String(content)).toContain("Warning: truncated output");
  expect(String(content).length).toBeLessThan(huge.length);
  // Original request not mutated.
  expect((request.messages[1]?.content as Array<{ content?: string }>)[0]?.content).toBe(huge);
});

test("buildBridgeUpstreamMessagesPayload prunes tool results for Anthropic and Responses", () => {
  const huge = `result ${"x".repeat(80_000)}`;
  const request: AnthropicRequest = {
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "cat" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: huge }],
      },
    ],
  };

  const anthropicBody = buildBridgeUpstreamMessagesPayload("anthropic", request, "claude-sonnet-4-6", false);
  const anthropicMessages = anthropicBody.messages as Array<{ content: unknown }>;
  const anthropicToolResult = (
    anthropicMessages[1]?.content as Array<{ type?: string; content?: string }>
  ).find((block) => block.type === "tool_result");
  expect(String(anthropicToolResult?.content)).toContain("Warning: truncated output");

  const responsesBody = buildBridgeUpstreamMessagesPayload("openai_responses", request, "gpt-test", false);
  const input = responsesBody.input as Array<{ type?: string; output?: string }>;
  const outputItem = input.find((item) => item.type === "function_call_output");
  expect(String(outputItem?.output ?? "")).toContain("Warning: truncated output");
  expect(String(outputItem?.output ?? "").length).toBeLessThan(huge.length);
});

test("buildBridgeUpstreamMessagesPayload preserves anthropic stream when SDK sends it", () => {
  const request: AnthropicRequest = {
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  };
  const body = buildBridgeUpstreamMessagesPayload("anthropic", request, "claude-sonnet-4-6", false);
  expect(body).toMatchObject({
    model: "claude-sonnet-4-6",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
});

test("buildBridgeUpstreamMessagesPayload maps max_tokens for openai chat completions", () => {
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 4096,
    messages: [{ role: "user", content: "hi" }],
  };
  const body = buildBridgeUpstreamMessagesPayload("openai_chat_completions", request, "local-model", false);
  expect(body.max_tokens).toBe(4096);
  expect(body.max_completion_tokens).toBe(4096);
});

test("buildBridgeUpstreamMessagesPayload preserves JSON-shaped user text for openai chat completions", () => {
  const content = JSON.stringify({
    userRequest: "检查当前项目",
    toolName: "Bash",
    toolInput: { command: "git status" },
  });
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 800,
    system: "Review the requested tool action.",
    messages: [{ role: "user", content }],
  };

  const body = buildBridgeUpstreamMessagesPayload("openai_chat_completions", request, "local-model", true);
  const messages = body.messages as Array<{ role: string; content: unknown }>;

  expect(messages).toEqual([
    { role: "system", content: "Review the requested tool action." },
    { role: "user", content },
  ]);
});

test("buildBridgeUpstreamMessagesPayload omits reasoning_effort for openai chat completions", () => {
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 256,
    stream: true,
    thinking: { type: "adaptive" },
    effort: "medium",
    messages: [{ role: "user", content: "hi" }],
  };
  const body = buildBridgeUpstreamMessagesPayload("openai_chat_completions", request, "local-model", true);
  expect(body.stream).toBe(true);
  expect(body).not.toHaveProperty("reasoning_effort");
});

test("buildBridgeUpstreamMessagesPayload adds disable-thinking kwargs for openai chat", () => {
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 256,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: "hi" }],
  };
  const body = buildBridgeUpstreamMessagesPayload("openai_chat_completions", request, "local-model", false);
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
});

test("buildBridgeUpstreamMessagesPayload does not add chat kwargs when thinking is enabled", () => {
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 256,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: "hi" }],
  };
  const body = buildBridgeUpstreamMessagesPayload("openai_chat_completions", request, "local-model", false);
  expect(body).not.toHaveProperty("chat_template_kwargs");
});

test("applyUpstreamMaxOutputLimit keeps only max_tokens for openai chat (New API → llama.cpp)", () => {
  const body: Record<string, unknown> = {
    model: "local-model",
    max_tokens: 8192,
    max_completion_tokens: 8192,
  };
  applyUpstreamMaxOutputLimit(body, "openai_chat_completions", 2048);
  expect(body.max_tokens).toBe(2048);
  expect(body.max_completion_tokens).toBeUndefined();
});

test("buildBridgeUpstreamMessagesPayload applies manual cap on openai responses wire body", () => {
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 8192,
    messages: [{ role: "user", content: "hi" }],
  };
  const body = buildBridgeUpstreamMessagesPayload("openai_responses", request, "local-model", false, 4096);
  expect(body.max_output_tokens).toBe(4096);
});

test("buildBridgeUpstreamMessagesPayload sends Responses input as a list", () => {
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 256,
    messages: [{ role: "user", content: "hi" }],
  };

  const body = buildBridgeUpstreamMessagesPayload("openai_responses", request, "local-model", true);

  expect(Array.isArray(body.input)).toBe(true);
  expect(body.input).toEqual([
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    },
  ]);
});

test("buildBridgeUpstreamMessagesPayload maps structured output for Responses and Chat", () => {
  const schema = {
    type: "object",
    properties: { decision: { type: "string" } },
    required: ["decision"],
    additionalProperties: false,
  };
  const request = {
    model: "review-model",
    max_tokens: 256,
    messages: [{ role: "user", content: "Review this action." }],
    output_format: { type: "json_schema", schema },
  } satisfies AnthropicRequest;

  const responses = buildBridgeUpstreamMessagesPayload("openai_responses", request, "review-model", true);
  expect(responses.text).toEqual({
    verbosity: "medium",
    format: {
      type: "json_schema",
      name: "eco_structured_output",
      schema,
      strict: true,
    },
  });

  const chat = buildBridgeUpstreamMessagesPayload("openai_chat_completions", request, "review-model", true);
  expect(chat.response_format).toEqual({
    type: "json_schema",
    json_schema: {
      name: "eco_structured_output",
      schema,
      strict: true,
    },
  });
});

test("OpenAI bridge preserves SDK Read tool output byte-for-byte", () => {
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 256,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_read", name: "Read", input: { file_path: "panel.dart" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_read",
            content: "291\t        DropdownMenu<String>(",
          },
        ],
      },
    ],
  };

  const body = buildBridgeUpstreamMessagesPayload("openai_responses", request, "local-model", true);
  const output = (body.input as Array<Record<string, unknown>>).find(
    (item) => item.type === "function_call_output",
  );
  expect(output?.output).toBe("291\t        DropdownMenu<String>(");
});

test("buildBridgeUpstreamMessagesPayload does not send Anthropic cache_control to Responses", () => {
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 256,
    cache_control: { type: "ephemeral" },
    system: [{ type: "text", text: "cached system", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hi",
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
        ],
      },
    ],
    tools: [
      {
        name: "lookup",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ],
  };

  const body = buildBridgeUpstreamMessagesPayload("openai_responses", request, "gpt-5.5", true);

  expect(body).not.toHaveProperty("cache_control");
  expect(JSON.stringify(body)).not.toContain('"cache_control"');
});

test("buildBridgeUpstreamMessagesPayload builds full OpenAI Responses wire body", () => {
  const request: AnthropicRequest = {
    model: "alias-model",
    max_tokens: 4096,
    system: [
      { type: "text", text: "System prompt" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "ignored" } },
      { type: "text", text: "Second instruction" },
    ],
    thinking: { type: "enabled", budget_tokens: 4096 },
    context_management: {
      edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 150000 } }],
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this" },
          { type: "image", source: { type: "url", url: "https://example.com/input.png" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need the file contents" },
          { type: "text", text: "I will read it." },
          { type: "tool_use", id: "call_read", name: "Read", input: { file: "a.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_read",
            content: [
              { type: "text", text: "tool text" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "abc123" },
              },
            ],
          },
        ],
      },
    ],
    tools: [
      { name: "Read", description: "Read file", input_schema: { type: "object" } },
      {
        type: "web_search_20250305",
        name: "web_search",
        allowed_domains: ["https://example.com/"],
      },
    ],
    tool_choice: { type: "tool", name: "web_search" },
  };

  const body = buildBridgeUpstreamMessagesPayload("openai_responses", request, "gpt-5.5", true);

  expect(body.model).toBe("gpt-5.5");
  expect(body.stream).toBe(true);
  expect(body.instructions).toBe("System prompt\nSecond instruction");
  expect(body.max_output_tokens).toBe(4096);
  expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  expect(body.tool_choice).toEqual({ type: "web_search" });
  expect(body.context_management).toBeUndefined();
  expect(body.tools).toEqual([
    {
      type: "function",
      name: "Read",
      description: "Read file",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
    { type: "web_search", filters: { allowed_domains: ["example.com"] } },
  ]);

  const input = body.input as Array<Record<string, unknown>>;
  expect(Array.isArray(input)).toBe(true);
  expect(input.map((item) => item.type)).toEqual([
    "message",
    "reasoning",
    "message",
    "function_call",
    "function_call_output",
    "message",
  ]);
  expect(input[0]).toMatchObject({
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "Inspect this" },
      { type: "input_image", image_url: "https://example.com/input.png" },
    ],
  });
  expect(input[1]).toMatchObject({
    type: "reasoning",
    summary: [],
    content: [{ type: "reasoning_text", text: "Need the file contents" }],
  });
  expect(input[3]).toMatchObject({
    type: "function_call",
    call_id: "call_read",
    name: "Read",
    arguments: '{"file":"a.txt"}',
  });
  expect(input[4]).toEqual({
    type: "function_call_output",
    call_id: "call_read",
    output: "tool text",
  });
  expect(input[5]).toEqual({
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: "data:image/png;base64,abc123" }],
  });
});

test("buildBridgeUpstreamMessagesPayload builds full OpenAI Chat Completions wire body", () => {
  const request: AnthropicRequest = {
    model: "alias-model",
    max_tokens: 4096,
    system: "System prompt",
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this" },
          { type: "image", source: { type: "url", url: "https://example.com/input.png" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need the file contents" },
          { type: "text", text: "I will read it." },
          { type: "tool_use", id: "call_read", name: "Read", input: { file: "a.txt" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_read", content: "tool text" }],
      },
    ],
    tools: [{ name: "Read", description: "Read file", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "Read" },
  };

  const body = buildBridgeUpstreamMessagesPayload("openai_chat_completions", request, "chat-model", true);

  expect(body.model).toBe("chat-model");
  expect(body.stream).toBe(true);
  expect(body.max_tokens).toBe(4096);
  expect(body.max_completion_tokens).toBe(4096);
  expect(body).not.toHaveProperty("max_output_tokens");
  expect(body).not.toHaveProperty("input");
  expect(body).not.toHaveProperty("reasoning_effort");
  expect(body.tools).toEqual([
    {
      type: "function",
      function: {
        name: "Read",
        description: "Read file",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    },
  ]);
  expect(body.tool_choice).toEqual({ type: "function", function: { name: "Read" } });

  const messages = body.messages as Array<Record<string, unknown>>;
  expect(messages[0]).toEqual({ role: "system", content: "System prompt" });
  expect(messages[1]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "Inspect this" },
      {
        type: "image_url",
        image_url: { url: "https://example.com/input.png" },
      },
    ],
  });
  expect(messages[2]).toMatchObject({
    role: "assistant",
    content: "I will read it.",
    reasoning_content: "Need the file contents",
    tool_calls: [
      {
        id: "call_read",
        type: "function",
        function: { name: "Read", arguments: '{"file":"a.txt"}' },
      },
    ],
  });
  expect(messages[3]).toEqual({
    role: "tool",
    tool_call_id: "call_read",
    content: "tool text",
  });
});

test("buildBridgeUpstreamMessagesPayload polyfills clear_tool_uses for openai responses", () => {
  const largeResult1 = `result 1 ${"x".repeat(2048)}`;
  const largeResult2 = `result 2 ${"y".repeat(2048)}`;
  const largeResult3 = `result 3 ${"z".repeat(2048)}`;
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 8192,
    context_management: {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "tool_uses", value: 1 },
          keep: { type: "tool_uses", value: 2 },
        },
      ],
    },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "Read", input: { file: "a" } },
          { type: "tool_use", id: "call_2", name: "Read", input: { file: "b" } },
          { type: "tool_use", id: "call_3", name: "Read", input: { file: "c" } },
          { type: "tool_use", id: "call_4", name: "Read", input: { file: "d" } },
          { type: "tool_use", id: "call_5", name: "Read", input: { file: "e" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: largeResult1 },
          { type: "tool_result", tool_use_id: "call_2", content: largeResult2 },
          { type: "tool_result", tool_use_id: "call_3", content: largeResult3 },
          { type: "tool_result", tool_use_id: "call_4", content: "result 4" },
          { type: "tool_result", tool_use_id: "call_5", content: "result 5" },
        ],
      },
    ],
  };

  const body = buildBridgeUpstreamMessagesPayload("openai_responses", request, "local-model", false);
  expect(Array.isArray(body.input)).toBe(true);
  const items = body.input as Array<Record<string, unknown>>;
  const outputs = items.filter((item) => item.type === "function_call_output");

  expect(outputs.map((item) => item.output)).toEqual([
    "[Cleared by context management]",
    "[Cleared by context management]",
    "[Cleared by context management]",
    "result 4",
    "result 5",
  ]);
  expect((request.messages[1]?.content as Array<{ content: string }>)[0]?.content).toBe(largeResult1);
});

test("applyGatewayContextManagementPolyfill never clears latest completed tool_result", () => {
  const request: AnthropicRequest = {
    model: "local-model",
    max_tokens: 8192,
    context_management: {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "tool_uses", value: 0 },
          keep: { type: "tool_uses", value: 0 },
        },
      ],
    },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "Read", input: {} },
          { type: "tool_use", id: "call_2", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "old result" },
          { type: "tool_result", tool_use_id: "call_2", content: "latest result" },
        ],
      },
    ],
  };

  const result = applyGatewayContextManagementPolyfill(request);
  const content = result.request.messages[1]?.content as Array<{ content: string }>;

  expect(content[0]?.content).toBe("[Cleared by context management]");
  expect(content[1]?.content).toBe("latest result");
  expect(result.appliedEdits[0]?.cleared_tool_uses).toBe(1);
});

test("applyResponsesRoutingHints sets prompt_cache_key and OpenRouter session_id", () => {
  expect(buildBridgePromptCacheKey("thread 123")).toBe("eco_thread_thread_123");

  const openRouterBody: Record<string, unknown> = {};
  applyResponsesRoutingHints(openRouterBody, {
    providerBaseUrl: "https://openrouter.ai/api",
    threadId: "thread 123",
  });
  expect(openRouterBody.prompt_cache_key).toBe("eco_thread_thread_123");
  expect(openRouterBody.session_id).toBe("eco_thread_thread_123");

  const strictBody: Record<string, unknown> = {};
  applyResponsesRoutingHints(strictBody, {
    providerBaseUrl: "https://api.example.com",
    threadId: "thread 123",
  });
  expect(strictBody.prompt_cache_key).toBe("eco_thread_thread_123");
  expect(strictBody.session_id).toBeUndefined();
});

test("forwardMessagesViaBridge passthrough anthropic json response without sse replay", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamRaw = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "upstream-claude",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  let upstreamBody: Record<string, unknown> | undefined;

  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    upstreamBody = JSON.parse(String(init?.body));
    return new Response(upstreamRaw, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const chunks: string[] = [];
    let statusCode = 0;
    let responseHeaders: Record<string, unknown> | undefined;
    const response = {
      writableEnded: false,
      writeHead(status: number, headers?: Record<string, unknown>) {
        statusCode = status;
        responseHeaders = headers;
        return this;
      },
      write(chunk: unknown) {
        chunks.push(String(chunk));
        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) {
          chunks.push(String(chunk));
        }
        this.writableEnded = true;
        return this;
      },
    } as unknown as ServerResponse;

    await forwardMessagesViaBridge(
      { headers: { "user-agent": "claude-sdk/1.0" } } as unknown as IncomingMessage,
      response,
      {
        route: {
          role: "coder",
          provider: {
            id: "p1",
            name: "Provider",
            baseUrl: "https://api.example.com",
            requestPath: "",
            version: "v1",
            apiKey: "sk-test",
          },
          modelId: "upstream-claude",
          apiCompat: "anthropic",
          aliasModelId: "alias-claude",
        },
        body: {
          model: "alias-claude",
          max_tokens: 16,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
      },
    );

    expect(upstreamBody).toMatchObject({ model: "upstream-claude", stream: true });
    expect(statusCode).toBe(200);
    expect(responseHeaders).toEqual({ "content-type": "application/json" });
    expect(chunks.join("")).toBe(upstreamRaw);
    expect(chunks.join("")).not.toContain("event:");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forwardMessagesViaBridge retries openai responses after dropping unsupported max_output_tokens", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamRaw = JSON.stringify({
    id: "resp_1",
    object: "response",
    model: "gpt-5.5",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
  const upstreamBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (upstreamBodies.length === 1) {
      return new Response(JSON.stringify({ detail: "Unsupported parameter: max_output_tokens" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(upstreamRaw, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const chunks: string[] = [];
    let statusCode = 0;
    const response = {
      writableEnded: false,
      writeHead(status: number) {
        statusCode = status;
        return this;
      },
      write(chunk: unknown) {
        chunks.push(String(chunk));
        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) {
          chunks.push(String(chunk));
        }
        this.writableEnded = true;
        return this;
      },
    } as unknown as ServerResponse;

    await forwardMessagesViaBridge(
      { headers: { "user-agent": "claude-sdk/1.0" } } as unknown as IncomingMessage,
      response,
      {
        route: {
          role: "main",
          provider: {
            id: "p1",
            name: "Provider",
            baseUrl: "https://api.example.com",
            requestPath: "",
            version: "v1",
            apiKey: "sk-test",
          },
          modelId: "gpt-5.5",
          apiCompat: "openai_responses",
          aliasModelId: "alias-gpt",
        },
        body: {
          model: "alias-gpt",
          max_tokens: 128000,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        },
      },
    );

    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies[0]).toHaveProperty("max_output_tokens", 128000);
    expect(upstreamBodies[1]).not.toHaveProperty("max_output_tokens");
    expect(statusCode).toBe(200);
    expect(chunks.join("")).toContain("ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseAnthropicStreamEventBlock reads text_delta from SSE block", () => {
  const block = [
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
  ].join("\n");
  const event = parseAnthropicStreamEventBlock(block);
  expect(event?.type).toBe("content_block_delta");
  expect(event?.delta).toMatchObject({ type: "text_delta", text: "Hi" });
});

test("splitSseBlocks splits event stream chunks", () => {
  const { blocks, remainder } = splitSseBlocks("event: ping\ndata: {}\n\nevent: done\ndata: {}\n\npart");
  expect(blocks).toHaveLength(2);
  expect(remainder).toBe("part");
});

test("appendStreamUtf8Chunk preserves multibyte UTF-8 split across chunks", () => {
  const payload = `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    delta: { type: "text_delta", text: "的多样性" },
  })}\n\n`;
  const bytes = Buffer.from(payload, "utf8");
  const splitAt = payload.indexOf("多");
  const first = bytes.subarray(0, splitAt);
  const second = bytes.subarray(splitAt);

  const broken = first.toString("utf8") + second.toString("utf8");
  expect(broken.includes("\uFFFD")).toBe(true);

  const decoder = createStreamUtf8Decoder();
  let buffer = "";
  buffer = appendStreamUtf8Chunk(decoder, buffer, first);
  buffer = appendStreamUtf8Chunk(decoder, buffer, second);
  buffer = finalizeStreamUtf8Decoder(decoder, buffer);

  const { blocks } = splitSseBlocks(buffer);
  const event = parseAnthropicStreamEventBlock(blocks[0] ?? "");
  expect(event?.delta).toMatchObject({ type: "text_delta", text: "的多样性" });
});

test("parseBridgeProbeReply invokes onTextDelta for buffered anthropic replies", async () => {
  const deltas: string[] = [];
  const result = await parseBridgeProbeReply({
    apiCompat: "anthropic",
    modelId: "claude-sonnet-4-6",
    anthropicRequest: {
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    },
    response: new Response(
      JSON.stringify({
        type: "message",
        content: [{ type: "text", text: "feat(ui): hello" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    preferStream: false,
    onTextDelta: (_delta, text) => {
      deltas.push(text);
    },
  });

  expect(result.reply).toBe("feat(ui): hello");
  expect(deltas).toEqual(["feat(ui): hello"]);
});
