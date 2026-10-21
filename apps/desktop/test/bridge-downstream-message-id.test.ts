import { expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createStreamingUsageTracker } from "../src/main/anthropic-usage";
import {
  type BridgeForwardRoute,
  type BridgeUsageInfo,
  forwardMessagesViaBridge,
} from "../src/main/bridge-upstream";
import { resolveProxyUsageBilling } from "../src/main/proxy-usage-billing";

function mockServerResponse(): ServerResponse {
  return {
    writableEnded: false,
    writeHead() {
      return this;
    },
    write() {
      return true;
    },
    end() {
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
}

function route(apiCompat: BridgeForwardRoute["apiCompat"]): BridgeForwardRoute {
  return {
    role: "coder",
    provider: {
      id: "provider_1",
      name: "Provider",
      baseUrl: "https://api.example.com",
      requestPath: "",
      version: "v1",
      apiKey: "sk-test",
    },
    modelId: "upstream-model",
    apiCompat,
    aliasModelId: "alias-model",
  };
}

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test("streaming usage tracker captures Anthropic message_start id", () => {
  const tracker = createStreamingUsageTracker();
  tracker.push(
    Buffer.from(
      sse([
        {
          type: "message_start",
          message: {
            id: " msg_stream_identity ",
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        { type: "message_delta", usage: { output_tokens: 4 } },
      ]),
    ),
  );

  expect(tracker.finish()).toMatchObject({ inputTokens: 10, outputTokens: 4 });
  expect(tracker.downstreamMessageId()).toBe("msg_stream_identity");
});

test("proxy billing writes downstream message id into sdkMessageId input", () => {
  const resolved = resolveProxyUsageBilling({
    info: {
      threadId: "thread_1",
      role: "main",
      providerId: "provider_1",
      providerName: "Provider",
      providerBaseUrl: "https://api.example.com",
      modelId: "upstream-model",
      apiCompat: "anthropic",
      downstreamMessageId: "msg_proxy_identity",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    },
    resolver: {
      resolveAgentId() {
        return undefined;
      },
      roleForAgentId() {
        return undefined;
      },
    },
  });

  expect(resolved.billingInput.messageId).toBe("msg_proxy_identity");
});

test("bridge reports downstream message ids for all compat and streaming paths", async () => {
  const originalFetch = globalThis.fetch;
  const cases: Array<{
    name: string;
    apiCompat: BridgeForwardRoute["apiCompat"];
    stream: boolean;
    expectedId: string;
    response: Response;
  }> = [
    {
      name: "anthropic buffered",
      apiCompat: "anthropic",
      stream: false,
      expectedId: "msg_anthropic_buffered",
      response: new Response(
        JSON.stringify({
          id: "msg_anthropic_buffered",
          type: "message",
          role: "assistant",
          model: "upstream-model",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    },
    {
      name: "anthropic streaming",
      apiCompat: "anthropic",
      stream: true,
      expectedId: "msg_anthropic_streaming",
      response: new Response(
        sse([
          {
            type: "message_start",
            message: {
              id: "msg_anthropic_streaming",
              type: "message",
              role: "assistant",
              model: "upstream-model",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
          },
          { type: "message_stop" },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    },
    {
      name: "responses buffered",
      apiCompat: "openai_responses",
      stream: false,
      expectedId: "resp_responses_buffered",
      response: new Response(
        JSON.stringify({
          id: "resp_responses_buffered",
          object: "response",
          model: "upstream-model",
          status: "completed",
          output: [
            {
              type: "message",
              id: "item_responses_buffered",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    },
    {
      name: "responses streaming",
      apiCompat: "openai_responses",
      stream: true,
      expectedId: "resp_responses_streaming",
      response: new Response(
        sse([
          {
            type: "response.created",
            response: {
              id: "resp_responses_streaming",
              object: "response",
              model: "upstream-model",
              status: "in_progress",
              output: [],
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_responses_streaming",
              object: "response",
              model: "upstream-model",
              status: "completed",
              output: [],
              usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            },
          },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    },
    {
      name: "chat completions buffered",
      apiCompat: "openai_chat_completions",
      stream: false,
      expectedId: "chatcmpl_buffered",
      response: new Response(
        JSON.stringify({
          id: "chatcmpl_buffered",
          object: "chat.completion",
          created: 0,
          model: "upstream-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    },
    {
      name: "chat completions streaming",
      apiCompat: "openai_chat_completions",
      stream: true,
      expectedId: "chatcmpl_streaming",
      response: new Response(
        sse([
          {
            id: "chatcmpl_streaming",
            object: "chat.completion.chunk",
            created: 0,
            model: "upstream-model",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "ok" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl_streaming",
            object: "chat.completion.chunk",
            created: 0,
            model: "upstream-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    },
  ];

  try {
    for (const testCase of cases) {
      globalThis.fetch = (async () => testCase.response.clone()) as typeof fetch;
      const usages: BridgeUsageInfo[] = [];

      await forwardMessagesViaBridge(
        { headers: { "user-agent": "claude-sdk/1.0" } } as unknown as IncomingMessage,
        mockServerResponse(),
        {
          route: route(testCase.apiCompat),
          body: {
            model: "alias-model",
            max_tokens: 128,
            stream: testCase.stream,
            messages: [{ role: "user", content: "hi" }],
          },
          onUsage(info) {
            usages.push(info);
          },
        },
      );

      expect(usages, testCase.name).toHaveLength(1);
      expect(usages[0]?.downstreamMessageId, testCase.name).toBe(testCase.expectedId);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
