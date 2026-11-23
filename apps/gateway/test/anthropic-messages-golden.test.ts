import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  anthropicEventToResponsesEvents,
  finalizeAnthropicResponsesStream,
  newAnthropicEventToResponsesState,
  responsesEventToSse,
} from "@eco/openai-anthropic-bridge";
import { buildCodexGatewayModelAlias } from "@eco/shared";
import { parseAnthropicStreamEventBlock, splitSseBlocks } from "../src/sse.js";
import type { GatewayConfig, GatewayProvider, GatewayUsageEvent } from "../src/types.js";
import { collectResponsesSseEvents } from "../src/upstream/responses-passthrough.js";
import { createTestGatewayFetchHandler } from "./test-bridge-rewrite.js";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "anthropic-text-stream.sse"), "utf8");
const STRATA_MODEL = "qwen3.8-flash-next-iq3_s";

async function requestResponsesWithAnthropicUsage(
  startUsage: Record<string, number | undefined>,
  finalUsage: Record<string, number | undefined>,
) {
  const provider: GatewayProvider = {
    id: "strata",
    name: "Strata mock",
    upstreamKind: "anthropic-messages",
    baseUrl: "https://mock.anthropic.test",
    apiKey: "test-key",
    upstreamModelId: STRATA_MODEL,
    models: [STRATA_MODEL],
  };
  const usageEvents: GatewayUsageEvent[] = [];
  const logs: string[] = [];
  const upstreamEvents = [
    {
      type: "message_start",
      message: {
        id: "msg_cache_split",
        type: "message",
        role: "assistant",
        model: STRATA_MODEL,
        content: [],
        stop_reason: null,
        usage: startUsage,
      },
    },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: finalUsage },
    { type: "message_stop" },
  ];
  const stream = upstreamEvents
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const handler = createTestGatewayFetchHandler(
    { host: "127.0.0.1", port: 0, providers: [provider] },
    async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    (message) => logs.push(message),
    (event) => usageEvents.push(event),
  );
  const response = await handler(
    new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "codex-root",
          turn_id: "turn-cache-split",
          request_kind: "turn",
        }),
      },
      body: JSON.stringify({ model: STRATA_MODEL, stream: true, input: JSON.stringify("Hi") }),
    }),
  );
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`Expected Responses SSE, got HTTP ${response.status}: ${text}`);
  }
  const completion = text.split("\n").find((line) => line.startsWith('data: {"type":"response.completed"'));
  if (!completion) {
    throw new Error("Expected response.completed in converted Anthropic stream");
  }
  return { usageEvents, logs, completedUsage: JSON.parse(completion.slice("data: ".length)).response.usage };
}

function anthropicFixtureToResponsesEventTypes(): string[] {
  const state = newAnthropicEventToResponsesState();
  const eventTypes: string[] = [];
  const { blocks } = splitSseBlocks(FIXTURE);
  for (const block of blocks) {
    const evt = parseAnthropicStreamEventBlock(block);
    if (!evt) {
      continue;
    }
    for (const responsesEvent of anthropicEventToResponsesEvents(evt, state)) {
      eventTypes.push(responsesEvent.type);
    }
  }
  for (const responsesEvent of finalizeAnthropicResponsesStream(state)) {
    eventTypes.push(responsesEvent.type);
  }
  return eventTypes;
}

describe("anthropic-messages golden SSE", () => {
  test("V1 route alias overrides a Responses provider to Anthropic for this request", async () => {
    const provider: GatewayProvider = {
      id: "mixed-wire",
      name: "Mixed wire mock",
      upstreamKind: "responses",
      baseUrl: "https://mock.mixed.test",
      apiKey: "test-key",
      upstreamModelId: "responses-default",
      models: ["responses-default"],
    };
    const alias = buildCodexGatewayModelAlias(provider.id, "claude/model.__v1", "anthropic");
    const handler = createTestGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      async (input, init) => {
        expect(String(input)).toBe("https://mock.mixed.test/v1/messages");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "claude/model.__v1",
          stream: true,
        });
        return new Response(FIXTURE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: alias,
          stream: true,
          input: JSON.stringify([
            {
              type: "message",
              role: "user",
              content: JSON.stringify([{ type: "input_text", text: "Hi" }]),
            },
          ]),
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    if (!response.body) {
      throw new Error("Expected Anthropic override response body");
    }
    expect(await collectResponsesSseEvents(response.body)).toContain("response.completed");
  });

  test("fixture converts to Responses lifecycle events", () => {
    const types = anthropicFixtureToResponsesEventTypes();
    expect(types).toContain("response.created");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.completed");
    expect(types.filter((t) => t === "response.output_text.delta").length).toBeGreaterThanOrEqual(2);
  });

  test("POST /v1/responses streams converted Responses SSE from mock Anthropic upstream", async () => {
    const provider: GatewayProvider = {
      id: "anthropic",
      name: "Anthropic mock",
      upstreamKind: "anthropic-messages",
      baseUrl: "https://mock.anthropic.test",
      apiKey: "test-key",
      upstreamModelId: "claude-sonnet-4-20250514",
      models: ["claude-sonnet-4-20250514"],
    };
    const config: GatewayConfig = { host: "127.0.0.1", port: 0, providers: [provider] };
    const usageEvents: GatewayUsageEvent[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://mock.anthropic.test/v1/messages");
      const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean };
      expect(body.model).toBe("claude-sonnet-4-20250514");
      expect(body.stream).toBe(true);
      return new Response(FIXTURE, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "request-id": "req_anthropic_stream_01",
        },
      });
    };

    const handler = createTestGatewayFetchHandler(
      config,
      mockFetch,
      () => undefined,
      (event) => usageEvents.push(event),
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "codex-root-stream",
            turn_id: "turn-stream-01",
            request_kind: "turn",
          }),
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          stream: true,
          input: JSON.stringify([
            {
              type: "message",
              role: "user",
              content: JSON.stringify([{ type: "input_text", text: "Hi" }]),
            },
          ]),
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body).not.toBeNull();

    const eventTypes = await collectResponsesSseEvents(response.body!);
    expect(eventTypes).toContain("response.created");
    expect(eventTypes).toContain("response.output_text.delta");
    expect(eventTypes).toContain("response.completed");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      source: "responses",
      sourceEventId: "anthropic:anthropic:response:msg_golden01",
      providerId: "anthropic",
      requestedModel: "claude-sonnet-4-20250514",
      upstreamModelId: "claude-sonnet-4-20250514",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelId: "claude-sonnet-4-20250514",
      },
      stream: true,
      responseId: "msg_golden01",
      providerRequestId: "req_anthropic_stream_01",
      codexTurnMetadata: {
        threadId: "codex-root-stream",
        turnId: "turn-stream-01",
        requestKind: "turn",
      },
    });
  });

  test.each([
    {
      name: "Strata classifies provisional input as cache writes",
      start: { input_tokens: 56, output_tokens: 0 },
      final: {
        input_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 55,
        output_tokens: 16,
      },
      usage: { inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 55, outputTokens: 16 },
      totalInput: 56,
      totalTokens: 72,
    },
    {
      name: "QwenCloud reports a higher final input total after classifying cache reads",
      start: { input_tokens: 8834, output_tokens: 0 },
      final: {
        input_tokens: 18,
        cache_read_input_tokens: 8831,
        cache_creation_input_tokens: 0,
        output_tokens: 426,
      },
      usage: { inputTokens: 18, cacheReadTokens: 8831, cacheCreationTokens: 0, outputTokens: 426 },
      totalInput: 8849,
      totalTokens: 9275,
    },
    {
      name: "explicit zeros replace prior input and cache read counts",
      start: { input_tokens: 40, cache_read_input_tokens: 16, output_tokens: 0 },
      final: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 56,
        output_tokens: 16,
      },
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 56, outputTokens: 16 },
      totalInput: 56,
      totalTokens: 72,
    },
    {
      name: "output-only delta keeps the initial input and cache split",
      start: {
        input_tokens: 1,
        cache_read_input_tokens: 23,
        cache_creation_input_tokens: 32,
        output_tokens: 0,
      },
      final: { output_tokens: 16 },
      usage: { inputTokens: 1, cacheReadTokens: 23, cacheCreationTokens: 32, outputTokens: 16 },
      totalInput: 56,
      totalTokens: 72,
    },
  ])("settles billed and client usage when $name", async ({
    start,
    final,
    usage,
    totalInput,
    totalTokens,
  }) => {
    const { usageEvents, completedUsage } = await requestResponsesWithAnthropicUsage(start, final);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      source: "responses",
      responseId: "msg_cache_split",
      codexTurnMetadata: { threadId: "codex-root", turnId: "turn-cache-split" },
      usage,
    });
    expect(completedUsage).toEqual({
      input_tokens: totalInput,
      output_tokens: usage.outputTokens,
      total_tokens: totalTokens,
      ...(usage.cacheReadTokens > 0 && { input_tokens_details: { cached_tokens: usage.cacheReadTokens } }),
    });
  });

  test("invalid cache usage still prevents billing a completed stream", async () => {
    const { usageEvents, logs } = await requestResponsesWithAnthropicUsage(
      { input_tokens: 56, output_tokens: 0 },
      { input_tokens: 1, cache_creation_input_tokens: -55, output_tokens: 16 },
    );
    expect(usageEvents).toHaveLength(0);
    expect(logs).toContainEqual(expect.stringContaining("reason=invalid_message_delta_usage"));
  });

  test("non-stream Anthropic usage preserves cache counters and child turn metadata", async () => {
    const provider: GatewayProvider = {
      id: "anthropic",
      name: "Anthropic mock",
      upstreamKind: "anthropic-messages",
      baseUrl: "https://mock.anthropic.test",
      apiKey: "test-key",
      upstreamModelId: "claude-sonnet-4-20250514",
      models: ["claude-sonnet-4-20250514"],
    };
    const config: GatewayConfig = { host: "127.0.0.1", port: 0, providers: [provider] };
    const usageEvents: GatewayUsageEvent[] = [];
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "msg_json01",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-20250514",
          content: [{ type: "text", text: "Hello" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 21,
            output_tokens: 7,
            cache_read_input_tokens: 13,
            cache_creation_input_tokens: 5,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "request-id": "req_anthropic_json_01",
          },
        },
      );
    const handler = createTestGatewayFetchHandler(
      config,
      mockFetch,
      () => undefined,
      (event) => usageEvents.push(event),
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "codex-child-json",
            turn_id: "turn-json-01",
            parent_thread_id: "codex-root-json",
            subagent_kind: "reviewer",
            request_kind: "turn",
          }),
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          stream: false,
          input: JSON.stringify("Hi"),
        }),
      }),
    );

    expect(response.status).toBe(200);
    // `request-id` is the client-facing identity: the Claude Agent SDK reads it as the
    // assistant message's request id, so the Gateway stamps the ECO logical id (Codex's turn
    // id for a Codex request). The provider's own id travels as separate metadata and is what
    // the usage event reports.
    expect(response.headers.get("request-id")).toBe("turn-json-01");
    expect(response.headers.get("x-eco-provider-request-id")).toBe("req_anthropic_json_01");
    expect((await response.json()) as { id?: string }).toMatchObject({ id: "msg_json01" });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      sourceEventId: "anthropic:anthropic:response:msg_json01",
      usage: {
        inputTokens: 21,
        outputTokens: 7,
        cacheReadTokens: 13,
        cacheCreationTokens: 5,
        modelId: "claude-sonnet-4-20250514",
      },
      stream: false,
      responseId: "msg_json01",
      providerRequestId: "req_anthropic_json_01",
      codexTurnMetadata: {
        threadId: "codex-child-json",
        turnId: "turn-json-01",
        parentThreadId: "codex-root-json",
        subagentKind: "reviewer",
        requestKind: "turn",
      },
    });
  });

  test("truncated Anthropic SSE is explicit and never emits partial usage", async () => {
    const provider: GatewayProvider = {
      id: "anthropic",
      name: "Anthropic mock",
      upstreamKind: "anthropic-messages",
      baseUrl: "https://mock.anthropic.test",
      apiKey: "test-key",
      upstreamModelId: "claude-sonnet-4-20250514",
      models: ["claude-sonnet-4-20250514"],
    };
    const config: GatewayConfig = { host: "127.0.0.1", port: 0, providers: [provider] };
    const usageEvents: GatewayUsageEvent[] = [];
    const logs: string[] = [];
    const messageStopIndex = FIXTURE.indexOf("event: message_stop");
    expect(messageStopIndex).toBeGreaterThan(0);
    const truncatedFixture = FIXTURE.slice(0, messageStopIndex);
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(truncatedFixture, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      (message) => logs.push(message),
      (event) => usageEvents.push(event),
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "codex-root-truncated",
            turn_id: "turn-truncated-01",
            request_kind: "turn",
          }),
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          stream: true,
          input: JSON.stringify("Hi"),
        }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(usageEvents).toHaveLength(0);
    expect(logs.some((message) => message.includes("reason=missing_message_stop"))).toBe(true);
    expect(logs.some((message) => message.includes("usage will not be billed"))).toBe(true);
  });

  test("successful Anthropic status without a body fails explicitly", async () => {
    const provider: GatewayProvider = {
      id: "anthropic",
      name: "Anthropic mock",
      upstreamKind: "anthropic-messages",
      baseUrl: "https://mock.anthropic.test",
      apiKey: "test-key",
      upstreamModelId: "claude-sonnet-4-20250514",
      models: ["claude-sonnet-4-20250514"],
    };
    const config: GatewayConfig = { host: "127.0.0.1", port: 0, providers: [provider] };
    const handler = createTestGatewayFetchHandler(
      config,
      async () =>
        new Response(null, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          stream: true,
          input: JSON.stringify("Hi"),
        }),
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("successful response without a body");
  });

  test("reasoning none disables thinking in the Anthropic upstream request", async () => {
    const provider: GatewayProvider = {
      id: "anthropic",
      name: "Anthropic mock",
      upstreamKind: "anthropic-messages",
      baseUrl: "https://mock.anthropic.test",
      apiKey: "test-key",
      upstreamModelId: "claude-sonnet-4-20250514",
      models: ["claude-sonnet-4-20250514"],
    };
    const config: GatewayConfig = { host: "127.0.0.1", port: 0, providers: [provider] };

    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        thinking?: { type?: string };
        output_config?: { effort?: string };
      };
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.output_config).toBeUndefined();
      return new Response(FIXTURE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const handler = createTestGatewayFetchHandler(config, mockFetch);
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          stream: true,
          input: JSON.stringify("Hi"),
          reasoning: { effort: "none" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();
  });

  test("null reasoning is accepted for an Anthropic upstream request", async () => {
    const provider: GatewayProvider = {
      id: "anthropic",
      name: "Anthropic mock",
      upstreamKind: "anthropic-messages",
      baseUrl: "https://mock.anthropic.test",
      apiKey: "test-key",
      upstreamModelId: "claude-sonnet-4-20250514",
      models: ["claude-sonnet-4-20250514"],
    };
    const config: GatewayConfig = { host: "127.0.0.1", port: 0, providers: [provider] };

    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        thinking?: unknown;
        output_config?: unknown;
      };
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
      return new Response(FIXTURE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const handler = createTestGatewayFetchHandler(config, mockFetch);
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          stream: true,
          input: JSON.stringify("Hi"),
          reasoning: null,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();
  });

  test("golden wire: fixture SSE lines match expected Responses event types", () => {
    const expectedTypes = anthropicFixtureToResponsesEventTypes();
    const sseLines = expectedTypes.map((type) => {
      const state = newAnthropicEventToResponsesState();
      const { blocks } = splitSseBlocks(FIXTURE);
      const collected: string[] = [];
      for (const block of blocks) {
        const evt = parseAnthropicStreamEventBlock(block);
        if (!evt) {
          continue;
        }
        for (const responsesEvent of anthropicEventToResponsesEvents(evt, state)) {
          if (responsesEvent.type === type) {
            collected.push(responsesEventToSse(responsesEvent).split("\n")[0] ?? "");
          }
        }
      }
      return collected[0];
    });
    expect(sseLines.filter(Boolean).length).toBeGreaterThan(0);
  });

  test("Anthropic route wraps apply_patch custom tool and restores custom_tool_call", async () => {
    const provider: GatewayProvider = {
      id: "anthropic-provider",
      name: "Anthropic mock",
      upstreamKind: "anthropic-messages",
      baseUrl: "https://mock.anthropic.test",
      apiKey: "test-key",
      upstreamModelId: "claude-sonnet",
      models: ["claude-sonnet"],
    };
    const alias = buildCodexGatewayModelAlias(provider.id, "claude-sonnet", "anthropic");
    const patch = "*** Begin Patch\n*** Add File: b.txt\n+yo\n*** End Patch";
    let upstreamBody: {
      tools?: { type?: string; name?: string; input_schema?: unknown }[];
      messages?: { role?: string; content?: unknown }[];
    } = {};
    const handler = createTestGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as typeof upstreamBody;
        return Response.json({
          id: "msg_custom",
          type: "message",
          role: "assistant",
          model: "claude-sonnet",
          content: [
            {
              type: "tool_use",
              id: "toolu_patch",
              name: "apply_patch",
              input: { input: patch },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 4, output_tokens: 3 },
        });
      },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: alias,
          stream: false,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "patch" }],
            },
            {
              type: "custom_tool_call",
              call_id: "call_previous_patch",
              name: "apply_patch",
              input: patch,
            },
            {
              type: "custom_tool_call_output",
              call_id: "call_previous_patch",
              output: "ok",
            },
          ],
          tools: [
            {
              type: "custom",
              name: "apply_patch",
              description: "Apply freeform patch",
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(upstreamBody.tools?.some((tool) => tool.type === "custom")).toBe(false);
    expect(upstreamBody.tools?.[0]).toMatchObject({ name: "apply_patch" });
    expect(JSON.stringify(upstreamBody.tools?.[0]?.input_schema)).toContain('"input"');
    expect(upstreamBody.messages?.[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_previous_patch",
          name: "apply_patch",
          input: { input: patch },
        },
      ],
    });
    expect(upstreamBody.messages?.[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_previous_patch",
          content: "ok",
        },
      ],
    });
    const body = (await response.json()) as {
      output?: { type?: string; name?: string; input?: string }[];
    };
    expect(body.output?.[0]).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      input: patch,
    });
  });
});
