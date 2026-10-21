import { describe, expect, test } from "bun:test";
import type { AnthropicRequest } from "@eco/openai-anthropic-bridge";
import { buildRequestLifecycleContext, reportLogicalUpstreamFailure } from "../src/request-lifecycle.js";
import type {
  GatewayProvider,
  GatewayRequestLifecycleEvent,
  GatewayRequestLifecycleObserver,
  ResolvedProviderRoute,
} from "../src/types.js";
import { forwardAnthropicMessagesBody } from "../src/upstream/anthropic-messages.js";
import { fetchUpstreamWithRetry } from "../src/upstream/fetch-with-retry.js";

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

const okAnthropicBody = {
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
};

describe("fetchUpstreamWithRetry", () => {
  test("retries 429 then succeeds with one terminal per attempt", async () => {
    const { events, observer } = collectLifecycle(() => undefined);
    const lifecycle = buildRequestLifecycleContext(anthropicRoute, "messages", () => undefined, observer);
    let calls = 0;
    const logs: string[] = [];
    const response = await fetchUpstreamWithRetry({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0", "request-id": "req_429_1" },
          });
        }
        return new Response("ok", {
          status: 200,
          headers: { "request-id": "req_ok" },
        });
      },
      url: "https://mock.anthropic.test/v1/messages",
      init: { method: "POST", body: "{}" },
      lifecycle,
      onLog: (message) => logs.push(message),
      baseDelayMs: 0,
      maxDelayMs: 0,
      maxElapsedMs: 60_000,
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(logs.some((line) => line.includes("upstream retry attempt=1 status=429"))).toBe(true);
    const failed = events.filter((event) => event.type === "upstream.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ attemptIndex: 0, statusCode: 429 });
    expect(events.filter((event) => event.type === "logical.failed")).toHaveLength(0);
    const started = events.filter((event) => event.type === "upstream.started");
    expect(started.map((event) => event.attemptIndex)).toEqual([0, 1]);
  });

  test("does not retry 401", async () => {
    const { events, observer } = collectLifecycle(() => undefined);
    const lifecycle = buildRequestLifecycleContext(anthropicRoute, "messages", () => undefined, observer);
    let calls = 0;
    const response = await fetchUpstreamWithRetry({
      fetchImpl: async () => {
        calls += 1;
        return new Response("unauthorized", {
          status: 401,
          headers: { "request-id": "req_401" },
        });
      },
      url: "https://mock.anthropic.test/v1/messages",
      init: { method: "POST", body: "{}" },
      lifecycle,
      maxAttempts: 5,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });

    expect(response.status).toBe(401);
    expect(calls).toBe(1);
    expect(events.filter((event) => event.type === "upstream.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "upstream.failed")).toHaveLength(1);
  });

  test("does not retry an explicit subscription usage-limit response", async () => {
    const { events, observer } = collectLifecycle(() => undefined);
    const lifecycle = buildRequestLifecycleContext(anthropicRoute, "messages", () => undefined, observer);
    let calls = 0;
    const response = await fetchUpstreamWithRetry({
      fetchImpl: async () => {
        calls += 1;
        return Response.json(
          {
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "Usage limit exceeded",
            },
          },
          { status: 429, headers: { "retry-after": "0", "x-request-id": "req_quota_429" } },
        );
      },
      url: "https://mock.anthropic.test/v1/messages",
      init: { method: "POST", body: "{}" },
      lifecycle,
      maxAttempts: 5,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });

    expect(response.status).toBe(429);
    expect(calls).toBe(1);
    expect(events.filter((event) => event.type === "upstream.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "upstream.started")).toHaveLength(1);
  });

  test("exhausts 429 and records exactly one failure per attempt", async () => {
    const { events, observer } = collectLifecycle(() => undefined);
    const lifecycle = buildRequestLifecycleContext(anthropicRoute, "messages", () => undefined, observer);
    let calls = 0;
    const response = await fetchUpstreamWithRetry({
      fetchImpl: async () => {
        calls += 1;
        return new Response(`attempt ${calls}`, {
          status: 429,
          headers: { "retry-after": "0", "request-id": `req_${calls}` },
        });
      },
      url: "https://mock.anthropic.test/v1/messages",
      init: { method: "POST", body: "{}" },
      lifecycle,
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      maxElapsedMs: 60_000,
    });

    expect(response.status).toBe(429);
    expect(calls).toBe(3);
    reportLogicalUpstreamFailure(lifecycle, {
      stage: "http",
      error: "Upstream returned HTTP 429",
      statusCode: 429,
      providerRequestId: "req_3",
    });
    expect(
      events
        .filter((event) => event.type === "upstream.failed")
        .map((event) => event.attemptIndex),
    ).toEqual([0, 1, 2]);
    expect(events.filter((event) => event.type === "logical.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "upstream.started").map((e) => e.attemptIndex)).toEqual([
      0, 1, 2,
    ]);
  });

  test("forwardAnthropicMessagesBody retries 429 before success", async () => {
    const { events, observer } = collectLifecycle(() => undefined);
    const lifecycle = buildRequestLifecycleContext(anthropicRoute, "responses", () => undefined, observer);
    let calls = 0;
    const anthropicBody: AnthropicRequest = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    };
    const response = await forwardAnthropicMessagesBody(
      anthropicRoute,
      anthropicBody,
      new Headers(),
      async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "0", "request-id": "req_r1" },
          });
        }
        return Response.json(okAnthropicBody, { headers: { "request-id": "req_r2" } });
      },
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
    expect(
      events.filter((event) => event.type === "upstream.started").map((event) => event.attemptIndex),
    ).toEqual([0, 1]);
  });
});
