import { describe, expect, test } from "bun:test";
import type { AnthropicRequest } from "@eco/openai-anthropic-bridge";
import { GATEWAY_PROVIDER_ID_HEADER, GATEWAY_REQUESTED_MODEL_HEADER } from "../src/provider-router.js";
import {
  buildRequestLifecycleContext,
  fetchWithRequestLifecycle,
  reportLogicalUpstreamFailure,
  RequestLifecycleTracker,
  tryEmitLogicalCompleted,
} from "../src/request-lifecycle.js";
import { createGatewayFetchHandler } from "../src/server.js";
import type {
  GatewayProvider,
  GatewayRequestLifecycleEvent,
  GatewayRequestLifecycleObserver,
  ResolvedProviderRoute,
} from "../src/types.js";
import { forwardAnthropicMessagesBody } from "../src/upstream/anthropic-messages.js";
import { createTestGatewayFetchHandler } from "./test-bridge-rewrite.js";

function collectLifecycle(observer: GatewayRequestLifecycleObserver) {
  const events: GatewayRequestLifecycleEvent[] = [];
  const wrapped: GatewayRequestLifecycleObserver = (event) => {
    events.push(event);
  };
  return { events, observer: wrapped };
}

const anthropicProvider: GatewayProvider = {
  id: "anthropic",
  name: "Anthropic mock",
  upstreamKind: "anthropic-messages",
  baseUrl: "https://mock.anthropic.test",
  apiKey: "test-key",
  upstreamModelId: "claude-sonnet-4-20250514",
  models: ["claude-sonnet-4-20250514"],
};

const anthropicRoute: ResolvedProviderRoute = {
  provider: anthropicProvider,
  requestedModel: "claude-sonnet-4-20250514",
  upstreamModelId: "claude-sonnet-4-20250514",
};

describe("gateway request lifecycle", () => {
  test("rectifier first 4xx records its real failed terminal before success", async () => {
    const { events, observer } = collectLifecycle(() => undefined);
    let calls = 0;
    const anthropicBody: AnthropicRequest = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t", signature: "bad" },
            { type: "text", text: "hi" },
          ],
        },
      ],
    };
    const lifecycle = buildRequestLifecycleContext(anthropicRoute, "responses", () => undefined, observer);
    const mockFetch: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            error: { message: "Invalid `signature` in `thinking` block", type: "invalid_request_error" },
          }),
          { status: 400, headers: { "content-type": "application/json", "request-id": "req_rect_1" } },
        );
      }
      return Response.json(
        {
          id: "msg_ok",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-20250514",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        { headers: { "request-id": "req_rect_2" } },
      );
    };

    const response = await forwardAnthropicMessagesBody(
      anthropicRoute,
      anthropicBody,
      new Headers(),
      mockFetch,
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lifecycle,
    );

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(events.filter((event) => event.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "logical.failed")).toHaveLength(0);
    expect(events.some((event) => event.type === "logical.completed")).toBe(true);
    const started = events.filter((event) => event.type === "upstream.started");
    const headers = events.filter((event) => event.type === "upstream.headers");
    expect(started).toHaveLength(2);
    expect(headers).toHaveLength(2);
    const logicalIds = started.map((event) => event.logicalRequestId);
    expect(new Set(logicalIds).size).toBe(1);
    expect(started.map((event) => event.attemptIndex)).toEqual([0, 1]);
    expect(headers.map((event) => event.attemptIndex)).toEqual([0, 1]);
    for (const event of events) {
      expect(typeof event.logicalRequestId).toBe("string");
      expect(event.logicalRequestId.length).toBeGreaterThan(0);
      expect(typeof event.attemptIndex).toBe("number");
    }
  });

  test("unsupported param retry first 4xx records its real failed terminal", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    let calls = 0;
    const handler = createTestGatewayFetchHandler(
      config,
      async (_req, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (calls === 1 && "temperature" in body) {
          return Response.json(
            {
              error: {
                message: "Unsupported parameter: 'temperature' is not supported with this model.",
                type: "invalid_request_error",
              },
            },
            { status: 400, headers: { "request-id": "req_unsup_1" } },
          );
        }
        return Response.json(
          {
            id: "resp_ok",
            object: "response",
            status: "completed",
            model: "gpt-test",
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
          },
          { headers: { "request-id": "req_unsup_2" } },
        );
      },
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
          [GATEWAY_REQUESTED_MODEL_HEADER]: "gpt-test",
        },
        body: JSON.stringify({
          model: "gpt-test",
          max_tokens: 64,
          stream: false,
          temperature: 0.2,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(events.filter((event) => event.type === "upstream.failed")).toHaveLength(1);
    expect(events.some((event) => event.type === "logical.completed")).toBe(true);
    const started = events.filter((event) => event.type === "upstream.started");
    const headers = events.filter((event) => event.type === "upstream.headers");
    expect(started).toHaveLength(2);
    expect(headers).toHaveLength(2);
    const logicalIds = started.map((event) => event.logicalRequestId);
    expect(new Set(logicalIds).size).toBe(1);
    expect(started.map((event) => event.attemptIndex)).toEqual([0, 1]);
    expect(headers.map((event) => event.attemptIndex)).toEqual([0, 1]);
    for (const event of events) {
      expect(typeof event.logicalRequestId).toBe("string");
      expect(event.logicalRequestId.length).toBeGreaterThan(0);
      expect(typeof event.attemptIndex).toBe("number");
    }
  });

  test("final HTTP failure emits exactly one http upstream.failed", async () => {
    const { events, observer } = collectLifecycle(() => undefined);
    const lifecycle = buildRequestLifecycleContext(anthropicRoute, "messages", () => undefined, observer);
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: 503,
        headers: { "request-id": "req_http_fail" },
      });

    await fetchWithRequestLifecycle(
      fetchImpl,
      "https://mock.test/v1/messages",
      { method: "POST" },
      lifecycle!,
    );
    reportLogicalUpstreamFailure(lifecycle, {
      stage: "http",
      error: "Upstream returned HTTP 503",
      statusCode: 503,
      providerRequestId: "req_http_fail",
    });

    const failed = events.filter((event) => event.type === "upstream.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.stage).toBe("http");
    expect(failed[0]?.statusCode).toBe(503);
    expect(failed[0]?.providerRequestId).toBe("req_http_fail");
    for (const event of events) {
      expect(typeof event.logicalRequestId).toBe("string");
      expect(event.logicalRequestId.length).toBeGreaterThan(0);
      expect(typeof event.attemptIndex).toBe("number");
    }
  });

  test("native Anthropic SSE error event reports stream failure once", async () => {
    const provider = { ...anthropicProvider, baseUrl: "http://127.0.0.1:0" };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const sse = [
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom"}}\n\n',
    ].join("");
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_sse_err" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "anthropic",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    await response.text();

    const failed = events.filter((event) => event.type === "upstream.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.stage).toBe("stream");
    expect(events.some((event) => event.type === "logical.failed")).toBe(true);
    for (const event of events) {
      expect(typeof event.logicalRequestId).toBe("string");
      expect(event.logicalRequestId.length).toBeGreaterThan(0);
      expect(typeof event.attemptIndex).toBe("number");
    }
  });

  test("Responses SSE failed/incomplete/error suppress duplicate failure on no-message-start", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const sse = 'data: {"type":"response.failed","response":{"error":{"message":"upstream died"}}}\n\n';
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_resp_fail" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({
          model: "gpt-test",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    await response.text();

    expect(events.filter((event) => event.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "logical.failed")).toHaveLength(1);
    for (const event of events) {
      expect(typeof event.logicalRequestId).toBe("string");
      expect(event.logicalRequestId.length).toBeGreaterThan(0);
      expect(typeof event.attemptIndex).toBe("number");
    }
  });

  test("success without usage still emits logical.completed", async () => {
    const { events, observer } = collectLifecycle(() => undefined);
    const lifecycle = buildRequestLifecycleContext(anthropicRoute, "messages", () => undefined, observer);
    tryEmitLogicalCompleted(lifecycle, "req_no_usage");
    expect(events.filter((event) => event.type === "logical.completed")).toHaveLength(1);
    tryEmitLogicalCompleted(lifecycle, "req_no_usage");
    expect(events.filter((event) => event.type === "logical.completed")).toHaveLength(1);
    for (const event of events) {
      expect(typeof event.logicalRequestId).toBe("string");
      expect(event.logicalRequestId.length).toBeGreaterThan(0);
      expect(typeof event.attemptIndex).toBe("number");
    }
  });

  test("native Anthropic passthrough reader failure reports upstream.failed + logical.failed exactly once", async () => {
    const provider = { ...anthropicProvider, baseUrl: "http://127.0.0.1:0" };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    let pullCount = 0;
    const errorStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
            ),
          );
          return;
        }
        throw new Error("simulated reader failure");
      },
    });
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(errorStream, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_reader_err" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "anthropic",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    try {
      await response.text();
    } catch {}

    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
  });

  test("native Responses passthrough reader failure reports upstream.failed + logical.failed exactly once", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    let pullCount = 0;
    const errorStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","model":"gpt-test","output":[]}}\n\n',
            ),
          );
          return;
        }
        throw new Error("simulated reader failure");
      },
    });
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(errorStream, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_resp_reader_err" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({
          model: "gpt-test",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    try {
      await response.text();
    } catch {}

    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
  });

  test("native Responses downstream cancel produces logical.cancelled exactly once", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    let cancelUpstream: (() => void) | undefined;
    let upstreamCancelCount = 0;
    const neverEnd = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}\n\n',
          ),
        );
        return new Promise<void>((resolve) => {
          cancelUpstream = resolve;
        });
      },
      cancel() {
        upstreamCancelCount += 1;
        cancelUpstream?.();
      },
    });
    const handler = createGatewayFetchHandler(
      config,
      async () =>
        new Response(neverEnd, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_cancel" },
        }),
      () => undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({
          model: "gpt-test",
          input: "hi",
        }),
      }),
    );

    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50));

    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(0);
    expect(upstreamCancelCount).toBe(1);
  });

  test("Responses SSE error event reports failure separately from response.failed", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const sse = 'data: {"type":"error","error":{"message":"server error","type":"server_error"}}\n\n';
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_resp_err" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({
          model: "gpt-test",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    await response.text();

    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
  });

  test("Responses SSE response.incomplete reports failure separately", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const sse =
      'data: {"type":"response.incomplete","response":{"id":"resp_1","object":"response","status":"incomplete","model":"gpt-test","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n';
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_resp_incomplete" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({
          model: "gpt-test",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    await response.text();

    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
  });

  test("success without usage via full Gateway path emits logical.completed", async () => {
    const provider = { ...anthropicProvider, baseUrl: "http://127.0.0.1:0" };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_no_usage_obs" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "anthropic",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    await response.text();

    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(0);
  });

  test("OpenAI Chat stream [DONE] emits logical.completed exactly once", async () => {
    const provider: GatewayProvider = {
      id: "chat",
      name: "Chat",
      upstreamKind: "openai-chat",
      baseUrl: "http://mock.chat.test",
      apiKey: "sk-test",
      upstreamModelId: "chat-model",
      models: ["chat-model"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    let upstreamCancelCount = 0;
    let hang: (() => void) | undefined;
    let sent = false;
    const sse = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"chat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"chat-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n");
    const hangingAfterDone = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(sse));
          return;
        }
        return new Promise<void>((resolve) => {
          hang = resolve;
        });
      },
      cancel() {
        upstreamCancelCount += 1;
        hang?.();
      },
    });
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(hangingAfterDone, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_chat_done" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "chat",
        },
        body: JSON.stringify({
          model: "chat-model",
          stream: true,
          input: '"hi"',
        }),
      }),
    );
    await response.text();
    await new Promise((r) => setTimeout(r, 20));

    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(0);
    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(0);
    expect(upstreamCancelCount).toBe(1);
  });

  test("OpenAI Chat downstream cancel produces logical.cancelled exactly once", async () => {
    const provider: GatewayProvider = {
      id: "chat",
      name: "Chat",
      upstreamKind: "openai-chat",
      baseUrl: "http://mock.chat.test",
      apiKey: "sk-test",
      upstreamModelId: "chat-model",
      models: ["chat-model"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    let cancelUpstream: (() => void) | undefined;
    let upstreamCancelCount = 0;
    const neverEnd = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"chat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
          ),
        );
        return new Promise<void>((resolve) => {
          cancelUpstream = resolve;
        });
      },
      cancel() {
        upstreamCancelCount += 1;
        cancelUpstream?.();
      },
    });
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(neverEnd, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_chat_cancel" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "chat",
        },
        body: JSON.stringify({
          model: "chat-model",
          stream: true,
          input: '"hi"',
        }),
      }),
    );

    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50));

    const cancelled = events.filter((e) => e.type === "logical.cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ reason: "downstream cancel" });
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(0);
    expect(upstreamCancelCount).toBe(1);
  });

  test("OpenAI Chat SSE error cancels hanging upstream reader once", async () => {
    const provider: GatewayProvider = {
      id: "chat",
      name: "Chat",
      upstreamKind: "openai-chat",
      baseUrl: "http://mock.chat.test",
      apiKey: "sk-test",
      upstreamModelId: "chat-model",
      models: ["chat-model"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    let upstreamCancelCount = 0;
    let hang: (() => void) | undefined;
    let sent = false;
    const hangingAfterError = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(
            new TextEncoder().encode(
              'event: error\ndata: {"error":{"message":"upstream boom","type":"server_error"}}\n\n',
            ),
          );
          return;
        }
        return new Promise<void>((resolve) => {
          hang = resolve;
        });
      },
      cancel() {
        upstreamCancelCount += 1;
        hang?.();
      },
    });
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(hangingAfterError, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_chat_sse_err" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "chat",
        },
        body: JSON.stringify({
          model: "chat-model",
          stream: true,
          input: '"hi"',
        }),
      }),
    );
    try {
      await response.text();
    } catch {}
    await new Promise((r) => setTimeout(r, 20));

    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(0);
    expect(upstreamCancelCount).toBe(1);
  });

  test("OpenAI Chat reader failure reports upstream.failed + logical.failed exactly once", async () => {
    const provider: GatewayProvider = {
      id: "chat",
      name: "Chat",
      upstreamKind: "openai-chat",
      baseUrl: "http://mock.chat.test",
      apiKey: "sk-test",
      upstreamModelId: "chat-model",
      models: ["chat-model"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    let pullCount = 0;
    const errorStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"chat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
            ),
          );
          return;
        }
        throw new Error("simulated reader failure");
      },
    });
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(errorStream, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_chat_reader_err" },
        }),
      undefined,
      undefined,
      observer,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "chat",
        },
        body: JSON.stringify({
          model: "chat-model",
          stream: true,
          input: '"hi"',
        }),
      }),
    );
    try {
      await response.text();
    } catch {}

    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(0);
  });

  test("truncated Anthropic SSE without message_stop is stream failure not completed", async () => {
    const config = { host: "127.0.0.1", port: 0, providers: [anthropicProvider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const truncated = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_trunc","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      "",
      "",
    ].join("\n");
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(truncated, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_trunc_anth" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "anthropic",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          stream: true,
          input: '"hi"',
        }),
      }),
    );
    const body = await response.text();
    expect(body).toContain("response.failed");
    expect(body).not.toContain('"type":"response.completed"');
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
  });

  test("truncated Responses SSE without response.completed is stream failure not completed", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const truncated =
      'data: {"type":"response.created","response":{"id":"resp_trunc","status":"in_progress"}}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n';
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(truncated, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_trunc_resp" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({ model: "gpt-test", stream: true, input: "hi" }),
      }),
    );
    const body = await response.text();
    expect(body).toContain("response.failed");
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
  });

  test("messages Responses→Anthropic truncated without response.completed fails closed", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const truncated =
      'data: {"type":"response.created","response":{"id":"resp_msg_trunc","status":"in_progress","output":[]}}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n';
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(truncated, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_msg_trunc" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({
          model: "gpt-test",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    const body = await response.text();
    expect(body).toContain('"type":"error"');
    expect(body).not.toContain('"type":"message_stop"');
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
  });

  test("Anthropic conversion cancel cancels upstream and emits only cancelled", async () => {
    const config = { host: "127.0.0.1", port: 0, providers: [anthropicProvider] };
    const { events, observer } = collectLifecycle(() => undefined);
    let cancelUpstream: (() => void) | undefined;
    let upstreamCancelCount = 0;
    const neverEnd = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              "event: message_start",
              'data: {"type":"message_start","message":{"id":"msg_c","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
              "",
              "",
            ].join("\n"),
          ),
        );
        return new Promise<void>((resolve) => {
          cancelUpstream = resolve;
        });
      },
      cancel() {
        upstreamCancelCount += 1;
        cancelUpstream?.();
      },
    });
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(neverEnd, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_anth_cancel" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "anthropic",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          stream: true,
          input: '"hi"',
        }),
      }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(0);
    expect(upstreamCancelCount).toBe(1);
  });

  function hangAfterFrames(frames: string): {
    body: ReadableStream<Uint8Array>;
    upstreamCancelCount: () => number;
  } {
    let sent = false;
    let upstreamCancelCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(frames));
        }
        // Keep HTTP connection open forever after terminal frames.
        return new Promise<void>(() => undefined);
      },
      cancel() {
        upstreamCancelCount += 1;
      },
    });
    return {
      body,
      upstreamCancelCount: () => upstreamCancelCount,
    };
  }

  async function expectBodyResolvesSoon(response: Response, ms = 2000): Promise<string> {
    const textPromise = response.text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`response.text() hung after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([textPromise, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  test("hanging Anthropic after message_stop completes immediately and cancels upstream", async () => {
    const config = { host: "127.0.0.1", port: 0, providers: [anthropicProvider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const frames = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_hang","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":2,"output_tokens":0}}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
      "",
    ].join("\n");
    const hanging = hangAfterFrames(frames);
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(hanging.body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_hang_ok" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "anthropic",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          stream: true,
          input: '"hi"',
        }),
      }),
    );
    const body = await expectBodyResolvesSoon(response);
    expect(body).toContain("response.completed");
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(0);
    expect(hanging.upstreamCancelCount()).toBe(1);
  });

  test("hanging Anthropic after error fails immediately with response.failed and cancels upstream", async () => {
    const config = { host: "127.0.0.1", port: 0, providers: [anthropicProvider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const frames = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_err","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
      "",
      "event: error",
      'data: {"type":"error","error":{"type":"api_error","message":"boom"}}',
      "",
      "",
    ].join("\n");
    const hanging = hangAfterFrames(frames);
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(hanging.body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_hang_err" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "anthropic",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          stream: true,
          input: '"hi"',
        }),
      }),
    );
    const body = await expectBodyResolvesSoon(response);
    expect(body).toContain("response.failed");
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(0);
    expect(hanging.upstreamCancelCount()).toBe(1);
  });

  test("hanging Responses after response.completed completes immediately and cancels upstream", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const frames =
      'data: {"type":"response.created","response":{"id":"resp_hang","status":"in_progress"}}\n\n' +
      'data: {"type":"response.completed","response":{"id":"resp_hang","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
    const hanging = hangAfterFrames(frames);
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(hanging.body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_resp_hang_ok" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({ model: "gpt-test", stream: true, input: "hi" }),
      }),
    );
    const body = await expectBodyResolvesSoon(response);
    expect(body).toContain("response.completed");
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(0);
    expect(hanging.upstreamCancelCount()).toBe(1);
  });

  test("hanging Responses after response.failed fails immediately and cancels upstream", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const frames =
      'data: {"type":"response.created","response":{"id":"resp_fail","status":"in_progress"}}\n\n' +
      'data: {"type":"response.failed","response":{"id":"resp_fail","error":{"message":"upstream died"}}}\n\n';
    const hanging = hangAfterFrames(frames);
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(hanging.body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_resp_hang_fail" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({ model: "gpt-test", stream: true, input: "hi" }),
      }),
    );
    const body = await expectBodyResolvesSoon(response);
    expect(body).toContain("response.failed");
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(0);
    expect(hanging.upstreamCancelCount()).toBe(1);
  });

  test("hanging messages Responses→Anthropic after response.completed emits message_stop and cancels", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const frames = [
      'data: {"type":"response.created","response":{"id":"resp_msg_ok","object":"response","status":"in_progress","model":"gpt-test","output":[]}}',
      "",
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}',
      "",
      'data: {"type":"response.content_part.added","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}',
      "",
      'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hi"}',
      "",
      'data: {"type":"response.output_text.done","item_id":"msg_1","output_index":0,"content_index":0,"text":"Hi"}',
      "",
      'data: {"type":"response.content_part.done","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hi"}}',
      "",
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hi"}]}}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp_msg_ok","object":"response","status":"completed","model":"gpt-test","output":[{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hi"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      "",
      "",
    ].join("\n");
    const hanging = hangAfterFrames(frames);
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(hanging.body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_msg_hang_ok" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({
          model: "gpt-test",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    const body = await expectBodyResolvesSoon(response);
    expect(body).toContain('"type":"message_stop"');
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(0);
    expect(hanging.upstreamCancelCount()).toBe(1);
  });

  test("hanging messages Responses→Anthropic after response.failed emits error and cancels", async () => {
    const provider: GatewayProvider = {
      id: "resp",
      name: "Responses",
      upstreamKind: "responses",
      baseUrl: "http://mock.resp.test",
      apiKey: "sk-test",
      upstreamModelId: "gpt-test",
      models: ["gpt-test"],
    };
    const config = { host: "127.0.0.1", port: 0, providers: [provider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const frames =
      'data: {"type":"response.created","response":{"id":"resp_msg_fail","status":"in_progress"}}\n\n' +
      'data: {"type":"response.failed","response":{"id":"resp_msg_fail","error":{"message":"nope"}}}\n\n';
    const hanging = hangAfterFrames(frames);
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(hanging.body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_msg_hang_fail" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "resp",
        },
        body: JSON.stringify({
          model: "gpt-test",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    const body = await expectBodyResolvesSoon(response);
    expect(body).toContain('"type":"error"');
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(0);
    expect(hanging.upstreamCancelCount()).toBe(1);
  });

  test("hanging native /messages Anthropic after message_stop completes immediately and cancels", async () => {
    const config = { host: "127.0.0.1", port: 0, providers: [anthropicProvider] };
    const { events, observer } = collectLifecycle(() => undefined);
    const frames = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_native","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":2,"output_tokens":0}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
      "",
    ].join("\n");
    const hanging = hangAfterFrames(frames);
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(hanging.body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_native_hang" },
        }),
      undefined,
      undefined,
      observer,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "anthropic",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    const body = await expectBodyResolvesSoon(response);
    expect(body).toContain("message_stop");
    expect(events.filter((e) => e.type === "logical.completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "logical.failed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "logical.cancelled")).toHaveLength(0);
    expect(hanging.upstreamCancelCount()).toBe(1);
  });

  test("generationTiming measures ttft and generation span (new-api style)", () => {
    const tracker = new RequestLifecycleTracker();
    expect(tracker.generationTiming(1000)).toEqual({});
    tracker.noteUpstreamStarted(1000);
    // No chunk yet — falls back to total latency.
    expect(tracker.generationTiming(2000)).toEqual({ generationMs: 1000 });
    tracker.noteFirstChunk(1350);
    tracker.noteFirstChunk(1900); // second chunk ignored
    expect(tracker.generationTiming(3000)).toEqual({ ttftMs: 350, generationMs: 1650 });
  });
});
