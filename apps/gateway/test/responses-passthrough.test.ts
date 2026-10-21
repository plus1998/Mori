import { describe, expect, test } from "bun:test";
import { buildCodexGatewayModelAlias } from "@eco/shared";
import type {
  GatewayConfig,
  GatewayProvider,
  GatewayRequestLifecycleEvent,
  GatewayUsageEvent,
} from "../src/types.js";
import {
  collectResponsesSseEvents,
  isOfficialOpenAIResponsesBaseUrl,
  sanitizeLongCatResponsesAgentMessages,
  sanitizeThirdPartyResponsesSoftFailFields,
} from "../src/upstream/responses-passthrough.js";
import { createTestGatewayFetchHandler } from "./test-bridge-rewrite.js";

const UPSTREAM_SSE = [
  "event: response.created",
  'data: {"type":"response.created","response":{"id":"resp_up","model":"gpt-4.1","status":"in_progress","output":[]}}',
  "",
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hi"}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","response":{"id":"resp_up","model":"gpt-4.1","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
  "",
].join("\n");

describe("responses passthrough", () => {
  test("preserves reserved tool schemas for a native Responses upstream", async () => {
    const provider: GatewayProvider = {
      id: "native",
      name: "Native Responses mock",
      upstreamKind: "responses",
      baseUrl: "https://mock.native.test",
      apiKey: "test-key",
      upstreamModelId: "gpt-6-sol",
      models: ["gpt-6-sol"],
    };
    const tools = [
      {
        type: "namespace",
        name: "collaboration",
        tools: [
          {
            type: "function",
            name: "wait_agent",
            parameters: {
              type: "object",
              properties: { timeout_ms: { type: "number" } },
            },
          },
        ],
      },
    ];
    const handler = createTestGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      async (_input, init) => {
        const upstreamBody = JSON.parse(String(init?.body)) as { tools: unknown };
        expect(upstreamBody.tools).toEqual(tools);
        return Response.json({ id: "resp_native", object: "response", model: "gpt-6-sol", output: [] });
      },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6-sol", input: [], tools }),
      }),
    );

    expect(response.status).toBe(200);
  });

  test("malformed reserved V1 aliases return 400 without reaching upstream", async () => {
    const malformed = "eco_route_v1.bad";
    const provider: GatewayProvider = {
      id: "custom",
      name: "Custom mock",
      upstreamKind: "responses",
      baseUrl: "https://mock.custom.test",
      apiKey: "test-key",
      upstreamModelId: "vendor-model",
      models: [malformed],
    };
    let fetched = false;
    const handler = createTestGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      async () => {
        fetched = true;
        return Response.json({});
      },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: malformed, stream: false, input: [] }),
      }),
    );

    expect(response.status).toBe(400);
    expect(fetched).toBe(false);
    expect(await response.json()).toMatchObject({
      error: {
        message: expect.stringContaining("Invalid gateway route alias"),
      },
    });
  });

  test("V1 route alias overrides an Anthropic provider to Responses for this request", async () => {
    const provider: GatewayProvider = {
      id: "mixed-wire",
      name: "Mixed wire mock",
      upstreamKind: "anthropic-messages",
      baseUrl: "https://mock.mixed.test",
      apiKey: "test-key",
      upstreamModelId: "claude-default",
      models: ["claude-default"],
    };
    const alias = buildCodexGatewayModelAlias(provider.id, "responses/model.__v1", "openai_responses");
    const handler = createTestGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      async (input, init) => {
        expect(String(input)).toBe("https://mock.mixed.test/v1/responses");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "responses/model.__v1",
          stream: false,
        });
        return Response.json({
          id: "resp_override",
          object: "response",
          model: "responses/model.__v1",
          status: "completed",
          output: [],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        });
      },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: alias, stream: false, input: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "resp_override" });
  });

  test("400 upstream body is reported as the lifecycle failure reason", async () => {
    const provider: GatewayProvider = {
      id: "sk-deepseek-mock",
      name: "Deepseek mock",
      upstreamKind: "responses",
      baseUrl: "https://mock.deepseek.test",
      apiKey: "test-key",
      upstreamModelId: "deepseek-flash",
      models: ["deepseek-flash"],
    };
    const lifecycleEvents: GatewayRequestLifecycleEvent[] = [];
    const handler = createTestGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      async () =>
        Response.json(
          { message: "Context window exhausted: window=262144, input=299189, reserve=1." },
          { status: 400 },
        ),
      () => undefined,
      undefined,
      (event) => {
        lifecycleEvents.push(event);
      },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-flash", stream: false, input: [] }),
      }),
    );

    expect(response.status).toBe(400);
    const failed = lifecycleEvents.filter((event) => event.type === "upstream.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain("sk-deepseek-mock");
    expect(failed[0]?.error).toContain("status=400");
    expect(failed[0]?.error).toContain("Context window exhausted: window=262144, input=299189, reserve=1.");
  });

  test("POST /v1/responses forwards to upstream /v1/responses and streams SSE", async () => {
    const provider: GatewayProvider = {
      id: "openai",
      name: "OpenAI mock",
      upstreamKind: "responses",
      baseUrl: "https://mock.openai.test",
      apiKey: "test-key",
      upstreamModelId: "gpt-4.1",
      models: ["gpt-4.1"],
    };
    const config: GatewayConfig = {
      host: "127.0.0.1",
      port: 0,
      providers: [provider],
    };

    const mockFetch: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://mock.openai.test/v1/responses");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        stream: boolean;
      };
      expect(body.model).toBe("gpt-4.1");
      expect(body.stream).toBe(true);
      expect(init?.headers).toMatchObject({
        authorization: "Bearer test-key",
      });
      return new Response(UPSTREAM_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const usageEvents: GatewayUsageEvent[] = [];
    const handler = createTestGatewayFetchHandler(
      config,
      mockFetch,
      () => undefined,
      (event) => {
        usageEvents.push(event);
      },
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "codex_root",
            turn_id: "turn_stream",
            request_kind: "turn",
          }),
        },
        body: JSON.stringify({
          model: "gpt-4.1",
          stream: true,
          input: "[]",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    const eventTypes = await collectResponsesSseEvents(response.body!);
    expect(eventTypes).toEqual(["response.created", "response.output_text.delta", "response.completed"]);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      source: "responses",
      sourceEventId: "responses:openai:response:resp_up",
      providerId: "openai",
      requestedModel: "gpt-4.1",
      upstreamModelId: "gpt-4.1",
      stream: true,
      responseId: "resp_up",
      codexTurnMetadata: {
        threadId: "codex_root",
        turnId: "turn_stream",
        requestKind: "turn",
      },
      usage: {
        inputTokens: 3,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelId: "gpt-4.1",
      },
    });
  });

  test("stream usage event carries gateway-measured ttft and decode span", async () => {
    const provider: GatewayProvider = {
      id: "openai",
      name: "OpenAI mock",
      upstreamKind: "responses",
      baseUrl: "https://mock.openai.test",
      apiKey: "test-key",
      upstreamModelId: "gpt-4.1",
      models: ["gpt-4.1"],
    };
    const config: GatewayConfig = {
      host: "127.0.0.1",
      port: 0,
      providers: [provider],
    };
    // Reasoning delta precedes the first content delta — it must not count as content.
    const sse = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_t","model":"gpt-4.1","status":"in_progress","output":[]}}',
      "",
      "event: response.reasoning_summary_text.delta",
      'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hi"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":" there"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_t","model":"gpt-4.1","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
      "",
    ].join("\n");
    const mockFetch: typeof fetch = async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const usageEvents: GatewayUsageEvent[] = [];
    const handler = createTestGatewayFetchHandler(
      config,
      mockFetch,
      () => undefined,
      (event) => {
        usageEvents.push(event);
      },
      () => undefined,
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4.1", stream: true, input: "[]" }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ stream: true, responseId: "resp_t" });
    expect(typeof usageEvents[0]?.ttftMs).toBe("number");
    expect(typeof usageEvents[0]?.generationMs).toBe("number");
    expect(usageEvents[0]?.ttftMs).toBeGreaterThanOrEqual(0);
    expect(usageEvents[0]?.generationMs).toBeGreaterThanOrEqual(0);
  });

  test("POST /v1/responses observes non-stream JSON usage", async () => {
    const provider: GatewayProvider = {
      id: "custom",
      name: "Custom mock",
      upstreamKind: "responses",
      baseUrl: "https://mock.custom.test",
      apiKey: "test-key",
      upstreamModelId: "vendor-model",
      models: ["eco_custom__vendor-model"],
    };
    const config: GatewayConfig = {
      host: "127.0.0.1",
      port: 0,
      providers: [provider],
    };

    const mockFetch: typeof fetch = async () =>
      Response.json(
        {
          id: "resp_json",
          object: "response",
          model: "vendor-model",
          status: "completed",
          output: [],
          usage: {
            input_tokens: 8,
            output_tokens: 2,
            total_tokens: 10,
            input_tokens_details: { cached_tokens: 3 },
          },
        },
        {
          headers: { "x-request-id": "req_json_1" },
        },
      );

    const usageEvents: GatewayUsageEvent[] = [];
    const handler = createTestGatewayFetchHandler(
      config,
      mockFetch,
      () => undefined,
      (event) => {
        usageEvents.push(event);
      },
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "codex_child",
            turn_id: "turn_json",
            parent_thread_id: "codex_root",
            subagent_kind: "collab_spawn",
            request_kind: "turn",
          }),
        },
        body: JSON.stringify({
          model: "eco_custom__vendor-model",
          stream: false,
          input: "[]",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req_json_1");
    expect(await response.json()).toMatchObject({ id: "resp_json" });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.ttftMs).toBeUndefined();
    expect(usageEvents[0]?.generationMs).toBeUndefined();
    expect(usageEvents[0]).toMatchObject({
      sourceEventId: "responses:custom:response:resp_json",
      providerId: "custom",
      requestedModel: "eco_custom__vendor-model",
      upstreamModelId: "vendor-model",
      stream: false,
      responseId: "resp_json",
      providerRequestId: "req_json_1",
      codexTurnMetadata: {
        threadId: "codex_child",
        turnId: "turn_json",
        parentThreadId: "codex_root",
        subagentKind: "collab_spawn",
        requestKind: "turn",
      },
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 0,
        modelId: "vendor-model",
      },
    });
  });

  test("Responses route passthrough preserves custom apply_patch tools", async () => {
    const provider: GatewayProvider = {
      id: "responses-provider",
      name: "Responses mock",
      upstreamKind: "responses",
      baseUrl: "https://mock.responses.test",
      apiKey: "test-key",
      upstreamModelId: "gpt-5.2",
      models: ["gpt-5.2"],
    };
    const alias = buildCodexGatewayModelAlias(provider.id, "gpt-5.2", "openai_responses");
    let upstreamBody: {
      tools?: { type?: string; name?: string }[];
      model?: string;
    } = {};
    const handler = createTestGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as typeof upstreamBody;
        return Response.json({
          id: "resp_custom",
          object: "response",
          model: "gpt-5.2",
          status: "completed",
          output: [
            {
              type: "custom_tool_call",
              id: "item_1",
              call_id: "call_1",
              name: "apply_patch",
              input: "*** Begin Patch\n*** End Patch",
              status: "completed",
            },
          ],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
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
    expect(upstreamBody.model).toBe("gpt-5.2");
    expect(upstreamBody.tools?.[0]).toMatchObject({
      type: "custom",
      name: "apply_patch",
    });
    const body = (await response.json()) as {
      output?: { type?: string; name?: string }[];
    };
    expect(body.output?.[0]).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
    });
  });

  test("DeepSeek Responses drops unsupported custom tools such as exec", async () => {
    const provider: GatewayProvider = {
      id: "packeycode-deepseek",
      name: "Packey DeepSeek",
      upstreamKind: "responses",
      baseUrl: "https://www.packyapi.com",
      apiKey: "test-key",
      upstreamModelId: "deepseek-v4-flash",
      models: ["deepseek-v4-flash"],
    };
    const alias = buildCodexGatewayModelAlias(provider.id, "deepseek-v4-flash", "openai_responses");
    let upstreamBody: {
      tools?: { type?: string; name?: string }[];
      model?: string;
    } = {};
    const handler = createTestGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as typeof upstreamBody;
        return Response.json({
          id: "resp_ds",
          object: "response",
          model: "deepseek-v4-flash",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
              status: "completed",
            },
          ],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
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
              content: [{ type: "input_text", text: "run ls" }],
            },
          ],
          tools: [
            {
              type: "custom",
              name: "exec",
              description: "Shell",
              format: { type: "text" },
            },
            {
              type: "custom",
              name: "apply_patch",
              description: "Patch files",
            },
            {
              type: "function",
              name: "wait",
              parameters: { type: "object", properties: {} },
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(upstreamBody.model).toBe("deepseek-v4-flash");
    expect(upstreamBody.tools).toEqual([
      { type: "custom", name: "apply_patch", description: "Patch files" },
      {
        type: "function",
        name: "wait",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  test("sanitizeThirdPartyResponsesSoftFailFields drops include for non-OpenAI hosts", () => {
    expect(isOfficialOpenAIResponsesBaseUrl("https://api.openai.com")).toBe(true);
    expect(isOfficialOpenAIResponsesBaseUrl("https://gpt.pomener.ru")).toBe(false);

    const thirdParty = sanitizeThirdPartyResponsesSoftFailFields(
      {
        model: "grok-4.5",
        input: [],
        include: ["reasoning.encrypted_content"],
        store: false,
      } as never,
      "https://gpt.pomener.ru",
    );
    expect(thirdParty.dropped).toEqual(["include"]);
    expect((thirdParty.body as { include?: unknown }).include).toBeUndefined();

    const official = sanitizeThirdPartyResponsesSoftFailFields(
      {
        model: "gpt-5",
        input: [],
        include: ["reasoning.encrypted_content"],
      } as never,
      "https://api.openai.com",
    );
    expect(official.dropped).toEqual([]);
    expect((official.body as { include?: unknown }).include).toEqual(["reasoning.encrypted_content"]);
  });

  test("LongCat converts plain Codex agent_message handoffs to standard user messages", () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "delegate" }],
      },
      {
        type: "agent_message",
        id: "agent_msg_1",
        author: "/root/coder",
        recipient: "/root/coder",
        content: [{ type: "input_text", text: "Run the requested task." }],
      },
    ];
    const result = sanitizeLongCatResponsesAgentMessages(
      { model: "LongCat-2.0", input } as never,
      "https://api.longcat.chat/openai",
    );
    expect(result.converted).toBe(1);
    expect(result.encrypted).toBe(0);
    expect(result.body.input).toEqual([
      input[0],
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Run the requested task." }],
      },
    ]);
  });

  test("LongCat leaves encrypted agent_message handoffs fail-closed", () => {
    const item = {
      type: "agent_message",
      encrypted_content: "opaque-ciphertext",
      content: [{ type: "input_text", text: "unavailable" }],
    };
    const result = sanitizeLongCatResponsesAgentMessages(
      { model: "LongCat-2.0", input: [item] } as never,
      "https://api.longcat.chat/openai",
    );
    expect(result.converted).toBe(0);
    expect(result.encrypted).toBe(1);
    expect(result.body.input).toEqual([item]);
  });

  test("LongCat leaves a handoff with an encrypted content part fail-closed", () => {
    const result = sanitizeLongCatResponsesAgentMessages(
      {
        model: "LongCat-2.0",
        input: [
          {
            type: "agent_message",
            content: [
              { type: "input_text", text: "Run the task." },
              { type: "encrypted_content", data: "opaque" },
            ],
          },
        ],
      } as never,
      "https://api.longcat.chat/openai",
    );
    expect(result.converted).toBe(0);
    expect(result.encrypted).toBe(1);
    expect(result.body.input).toEqual([
      {
        type: "agent_message",
        content: [
          { type: "input_text", text: "Run the task." },
          { type: "encrypted_content", data: "opaque" },
        ],
      },
    ]);
  });

  test("LongCat handoff sanitizer does not affect other Responses providers", () => {
    const body = {
      model: "vendor-model",
      input: [{ type: "agent_message", content: [{ type: "input_text", text: "task" }] }],
    };
    const result = sanitizeLongCatResponsesAgentMessages(body as never, "https://example.test");
    expect(result).toEqual({ body, converted: 0, encrypted: 0 });
  });

  for (const partialNextFrame of [false, true]) {
    test(`waits for real completion after a normal tool-frame gap (partial next frame: ${partialNextFrame})`, async () => {
      const provider: GatewayProvider = {
        id: "delayed-terminal",
        name: "Delayed Responses mock",
        upstreamKind: "responses",
        baseUrl: "https://mock.responses.test",
        apiKey: "test-key",
        upstreamModelId: "gpt-5",
        models: ["gpt-5"],
      };
      const toolFrame = 'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"exec","arguments":"{}"}}\n\n';
      const nextFrame = 'data: {"type":"response.output_text.delta","delta":"after tool"}\n\n';
      const completion = 'data: {"type":"response.completed","response":{"id":"resp_real","status":"completed","output":[],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n';
      const prefixLength = 24;
      let realTerminalSent = false;
      let cancelledEarly = false;
      let timer: ReturnType<typeof setTimeout>;
      const usageEvents: GatewayUsageEvent[] = [];
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(toolFrame + (partialNextFrame ? nextFrame.slice(0, prefixLength) : "")));
          timer = setTimeout(() => {
            realTerminalSent = true;
            controller.enqueue(new TextEncoder().encode((partialNextFrame ? nextFrame.slice(prefixLength) : "") + completion));
            controller.close();
          }, 250);
        },
        cancel() {
          cancelledEarly = !realTerminalSent;
          clearTimeout(timer);
        },
      });
      const handler = createTestGatewayFetchHandler(
        { host: "127.0.0.1", port: 0, providers: [provider] },
        async () => new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
        () => undefined,
        (event) => { usageEvents.push(event); },
      );
      const response = await handler(new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5", stream: true, input: [] }),
      }));
      const body = await response.text();
      expect(cancelledEarly).toBe(false);
      expect(body).toContain('"id":"resp_real"');
      expect(body).toContain('"total_tokens":10');
      expect(body.match(/"type":"response.completed"/g)).toHaveLength(1);
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]?.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    });
  }

  test("synthesizes response.completed with tool outputs after post-tool stall", async () => {
    const provider: GatewayProvider = {
      id: "mygrok-stall",
      name: "MyGrok stall mock",
      upstreamKind: "responses",
      baseUrl: "https://gpt.pomener.ru",
      apiKey: "test-key",
      upstreamModelId: "grok-4.5",
      models: ["grok-4.5"],
    };
    const usableFrames = [
      'data: {"type":"response.created","response":{"id":"resp_stall","status":"in_progress"}}',
      "",
      'data: {"type":"response.output_item.done","item":{"type":"custom_tool_call","id":"item_1","call_id":"call_1","name":"exec","input":"ls"}}',
      "",
      "",
    ].join("\n");
    const incompleteRemainder =
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stall","status":"completed","output":[' +
      `${"x".repeat(8_000)}`;
    let upstreamCancelCount = 0;
    let sent = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(usableFrames + incompleteRemainder));
        }
        return new Promise<void>(() => undefined);
      },
      cancel() {
        upstreamCancelCount += 1;
      },
    });
    const handler = createTestGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [provider] },
      async () =>
        new Response(hangingBody, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_stall" },
        }),
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-4.5", stream: true, input: [] }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await Promise.race([
      response.text(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("stall synthesis timed out")), 1_000),
      ),
    ]);
    expect(body).toContain("response.output_item.done");
    expect(body).toContain("response.completed");
    expect(body).toContain('"type":"custom_tool_call"');
    expect(body).toContain('"name":"exec"');
    expect(body).not.toContain("xxxxx");
    expect(upstreamCancelCount).toBe(1);
  });
});
