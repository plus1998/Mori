import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateChatGptResponsesRequest } from "../src/chatgpt-responses-policy.js";
import { GATEWAY_PROVIDER_ID_HEADER } from "../src/provider-router.js";
import { createGatewayFetchHandler } from "../src/server.js";
import { reportRouteCredentialResult, resolveRouteCredential } from "../src/route-credentials.js";
import type {
  GatewayConfig,
  GatewayCredentialResult,
  GatewayProvider,
  GatewayUsageEvent,
  GatewayRequestLifecycleEvent,
  ResolvedProviderRoute,
} from "../src/types.js";
import { UPSTREAM_PROXY_URL } from "../src/upstream-proxy.js";

const provider = {
  id: "eco-coding-chatgpt",
  name: "ChatGPT 订阅",
  upstreamKind: "responses" as const,
  baseUrl: "https://api.openai.com",
  apiKey: "local-unused",
  authMethod: "chatgpt_subscription" as const,
  credentialPoolId: "chatgpt-default",
  upstreamModelId: "gpt-5",
  models: ["gpt-5"],
};

const validBody = {
  model: "gpt-5",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  store: false,
  stream: true,
};

// Sanitized replay of the real OAuth response supplied in the user's log:
// output_item.done carries the text, response.completed.output is empty.
const oauthHiSse = readFileSync(new URL("./fixtures/chatgpt-oauth-hi.sse", import.meta.url), "utf8");

const completedResponse = {
  id: "resp_hi",
  object: "response",
  status: "completed",
  model: "gpt-5",
  output: [
    { type: "message", id: "msg_hi", role: "assistant", content: [{ type: "output_text", text: "你好 👋" }] },
  ],
  usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 4 } },
};

function messagesRequest(stream?: boolean, tools?: unknown[]): Request {
  return new Request("http://127.0.0.1/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", [GATEWAY_PROVIDER_ID_HEADER]: provider.id },
    body: JSON.stringify({
      model: "gpt-5",
      max_tokens: 128,
      ...(stream !== undefined ? { stream } : {}),
      messages: [{ role: "user", content: "hi" }],
      ...(tools ? { tools } : {}),
    }),
  });
}

function terminalSse(response: unknown): string {
  return `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response })}\r\n\r\n`;
}

describe("ChatGPT subscription gateway adapter", () => {
  for (const path of ["/v1/responses","/v1/messages"]) {
    test(`usage retains the selected account after the active account changes: ${path}`, async () => {
      const usage:GatewayUsageEvent[] = [];
      let selected = "account-a";
      let release:()=>void = () => {};
      const ready = Promise.withResolvers<void>();
      const handler = createGatewayFetchHandler({host:"127.0.0.1",port:0,providers:[provider],
        resolveCredential:async () => ({accessToken:"oauth-access",accountId:selected})},
        async () => {
          ready.resolve();
          await new Promise<void>(resolve => {release=resolve;});
          return new Response(terminalSse(completedResponse),{headers:{"content-type":"text/event-stream"}});
        },() => {},event => {usage.push(event);});
      const request = path === "/v1/messages" ? messagesRequest(false) : new Request(`http://127.0.0.1${path}`,{
        method:"POST",headers:{"content-type":"application/json",[GATEWAY_PROVIDER_ID_HEADER]:provider.id},body:JSON.stringify(validBody)});
      const pending = handler(request);
      await ready.promise;
      selected = "account-b";
      release();
      const response = await pending;
      await response.text();
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({accountId:"account-a",usage:{inputTokens:8,cacheReadTokens:4,outputTokens:3}});
    });
  }
  for (const sessionHeader of ["session-id", "session_id"]) {
    test(`Responses preserves ${sessionHeader} across growing requests and distinct sessions`, async () => {
      const sent: { headers: Headers; body: Record<string, unknown> }[] = [];
      const handler = createGatewayFetchHandler({
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        resolveCredential: async () => ({ accessToken: "oauth-access" }),
      }, async (_url, init) => {
        sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return new Response(terminalSse(completedResponse), { headers: { "content-type": "text/event-stream" } });
      });

      for (const [session, additions] of [
        ["session-a", ["first"]],
        ["session-a", ["first", "follow-up"]],
        ["session-b", ["other"]],
      ] as const) {
        const response = await handler(new Request("http://127.0.0.1/v1/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [GATEWAY_PROVIDER_ID_HEADER]: provider.id,
            [sessionHeader]: session,
            "x-eco-private-context": "local-only",
            authorization: "Bearer local-bridge-secret",
          },
          body: JSON.stringify({
            ...validBody,
            prompt_cache_key: session,
            input: [...validBody.input, ...additions.map((text) => ({ role: "user", content: text }))],
          }),
        }));
        expect(response.status).toBe(200);
        await response.text();
      }

      expect(sent.map((request) => request.headers.get(sessionHeader))).toEqual(["session-a", "session-a", "session-b"]);
      expect(sent.map((request) => request.body.prompt_cache_key)).toEqual(["session-a", "session-a", "session-b"]);
      for (const { headers } of sent) {
        expect(headers.get("authorization")).toBe("Bearer oauth-access");
        expect(headers.has("x-eco-private-context")).toBe(false);
        expect(headers.has(GATEWAY_PROVIDER_ID_HEADER)).toBe(false);
      }
    });
  }

  for (const endpoint of ["responses", "messages"]) {
    test(`${endpoint} preserves a local paused-pool error without calling upstream`, async () => {
      let upstreamCalls = 0;
      const reports: GatewayCredentialResult[] = [];
      const handler = createGatewayFetchHandler({
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        resolveCredential: async () => {
          throw Object.assign(new Error("用量受限账号已暂停，请手动测试，测试成功后才能恢复"), {
            statusCode: 403,
            errorCode: "subscription_sharing_usage_limit_exceeded",
            accountId: "account-paused",
          });
        },
        reportCredentialResult: (result) => { reports.push(result); },
      }, async () => {
        upstreamCalls += 1;
        return new Response("unexpected upstream call");
      });
      const request = endpoint === "messages" ? messagesRequest(true) : new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", [GATEWAY_PROVIDER_ID_HEADER]: provider.id },
        body: JSON.stringify(validBody),
      });

      const response = await handler(request);
      expect(response.status).toBe(403);
      expect(response.headers.get("x-eco-upstream-error-code")).toBe("subscription_sharing_usage_limit_exceeded");
      expect(await response.json()).toMatchObject({ error: {
        type: "credential_error",
        code: "subscription_sharing_usage_limit_exceeded",
        accountId: "account-paused",
        message: expect.stringContaining("手动测试"),
      } });
      expect(upstreamCalls).toBe(0);
      expect(reports).toHaveLength(0);
    });
  }

  for (const stream of [true, false, undefined]) {
    test(`真实 OAuth 日志回放：缺少 Content-Type，Messages stream=${stream}`, async () => {
      const usage: GatewayUsageEvent[] = [];
      const logs: string[] = [];
      const handler = createGatewayFetchHandler(
        {
          host: "127.0.0.1",
          port: 0,
          providers: [provider],
          resolveCredential: async () => ({ accessToken: "oauth-access" }),
        },
        async () => new Response(new TextEncoder().encode(oauthHiSse)),
        (log) => logs.push(log),
        (event) => {
          usage.push(event);
        },
      );
      const response = await handler(messagesRequest(stream));
      expect(response.status).toBe(200);
      if (stream === true) {
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const sse = await response.text();
        expect(sse).toContain('"delta":{"type":"text_delta","text":"Hi"}');
        expect(sse).toContain("message_stop");
        expect(sse).not.toContain("event: error");
      } else {
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toMatchObject({
          content: [{ type: "text", text: "Hi! How can I help you today?" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 13 },
        });
      }
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ usage: { inputTokens: 7, outputTokens: 13 } });
      expect(logs.some((log) => log.includes("non-SSE while"))).toBe(false);
    });
  }

  test("Codex/Pi 原生 Responses OAuth SSE 缺少 Content-Type 时仍返回流式并上报用量", async () => {
    const usage: GatewayUsageEvent[] = [];
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        resolveCredential: async () => ({ accessToken: "oauth-access" }),
      },
      async () => new Response(new TextEncoder().encode(oauthHiSse)),
      () => undefined,
      (event) => {
        usage.push(event);
      },
    );
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", [GATEWAY_PROVIDER_ID_HEADER]: provider.id },
        body: JSON.stringify(validBody),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"text": "Hi! How can I help you today?"');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ usage: { inputTokens: 7, outputTokens: 13 }, stream: true });
  });

  test("动态输出模式下跳过预算计算，并且订阅请求不发送 max_output_tokens", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    let countInputTokensCalls = 0;
    const dynamicProvider = {
      ...provider,
      modelMaxOutputTokens: { "gpt-5": 8_192 },
      modelContextTokens: { "gpt-5": 32_768 },
    };
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [dynamicProvider],
        resolveCredential: async () => ({ accessToken: "oauth-access" }),
        countInputTokens: async () => {
          countInputTokensCalls++;
          return { tokens: 1, precision: "provider_exact", source: "test" };
        },
      },
      async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(new TextEncoder().encode(oauthHiSse));
      },
      () => undefined,
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", [GATEWAY_PROVIDER_ID_HEADER]: provider.id },
        body: JSON.stringify({ ...validBody, max_output_tokens: 128 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(upstreamBody).toBeDefined();
    expect(upstreamBody).not.toHaveProperty("max_output_tokens");
    expect(countInputTokensCalls).toBe(0);
  });

  for (const stream of [false, undefined]) {
    test(`Messages stream=${stream} 使用 OAuth SSE 上游并返回完整 JSON`, async () => {
      const usage: GatewayUsageEvent[] = [];
      const lifecycle: GatewayRequestLifecycleEvent[] = [];
      const logs: string[] = [];
      let cancelled = false;
      let upstreamBody: Record<string, unknown> = {};
      let upstreamInit: RequestInit | undefined;
      const bytes = new TextEncoder().encode(terminalSse(completedResponse));
      const handler = createGatewayFetchHandler(
        {
          host: "127.0.0.1",
          port: 0,
          providers: [provider],
          resolveCredential: async () => ({
            accessToken: "oauth-access",
            accountId: "account-1",
            upstreamProxyUrl: "socks5://127.0.0.1:19090",
          }),
        },
        async (_input, init) => {
          upstreamInit = init;
          upstreamBody = JSON.parse(String(init?.body));
          // Keep the upstream open and split every UTF-8 character across chunks.
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream", "x-request-id": "req_hi" } },
          );
        },
        (log) => logs.push(log),
        (event) => {
          usage.push(event);
        },
        (event) => {
          lifecycle.push(event);
        },
      );

      const response = await handler(messagesRequest(stream));
      expect(upstreamBody.stream).toBe(true);
      expect(upstreamBody.store).toBe(false);
      expect(upstreamBody).not.toHaveProperty("max_output_tokens");
      expect(new Headers(upstreamInit?.headers).get("authorization")).toBe("Bearer oauth-access");
      expect((upstreamInit as RequestInit & { [UPSTREAM_PROXY_URL]?: string })[UPSTREAM_PROXY_URL]).toBe(
        "socks5://127.0.0.1:19090",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({
        id: "resp_hi",
        type: "message",
        content: [{ type: "text", text: "你好 👋" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 4 },
      });
      expect(cancelled).toBe(true);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 4 },
        stream: false,
      });
      expect(lifecycle.filter((event) => event.type === "logical.completed")).toHaveLength(1);
      expect(logs.some((log) => log.includes("downstreamStream=false upstreamStream=true"))).toBe(true);
    });
  }

  test("非流式 Messages 聚合 OAuth 工具调用，保留结构化参数与停止原因", async () => {
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        resolveCredential: async () => ({ accessToken: "oauth-access" }),
      },
      async () =>
        new Response(
          `data: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "lookup",
              arguments: '{"query":"hi"}',
            },
          })}\n\n` +
            terminalSse({
              ...completedResponse,
              output: [],
            }),
          { headers: { "content-type": "application/octet-stream" } },
        ),
      () => undefined,
    );
    const response = await handler(
      messagesRequest(false, [
        { name: "lookup", input_schema: { type: "object", properties: { query: { type: "string" } } } },
      ]),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: [{ type: "tool_use", name: "lookup", input: { query: "hi" } }],
      stop_reason: "tool_use",
    });
  });

  test("API Key 的非流式 Messages 保持原有 JSON 上游协议", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const handler = createGatewayFetchHandler(
      { host: "127.0.0.1", port: 0, providers: [{ ...provider, authMethod: "api_key" }] },
      async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return Response.json(completedResponse);
      },
      () => undefined,
    );
    const response = await handler(messagesRequest(false));
    expect(upstreamBody.stream).toBe(false);
    expect(upstreamBody).toHaveProperty("max_output_tokens");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { content: unknown[] }).content).toEqual([
      { type: "text", text: "你好 👋" },
    ]);
  });

  for (const [name, sse, code] of [
    [
      "response.failed",
      `data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "Upstream failed", code: "server_error" } } })}\n\n`,
      "server_error",
    ],
    [
      "error",
      `data: ${JSON.stringify({ type: "error", message: "Upstream failed", code: "server_error" })}\n\n`,
      "server_error",
    ],
    ["截断", 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n', "incomplete_stream"],
  ] as const) {
    test(`非流式 OAuth 上游 ${name} 返回错误而非空成功`, async () => {
      const usage: GatewayUsageEvent[] = [];
      const lifecycle: GatewayRequestLifecycleEvent[] = [];
      const handler = createGatewayFetchHandler(
        {
          host: "127.0.0.1",
          port: 0,
          providers: [provider],
          resolveCredential: async () => ({ accessToken: "oauth-access" }),
        },
        async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
        () => undefined,
        (event) => {
          usage.push(event);
        },
        (event) => {
          lifecycle.push(event);
        },
      );
      const response = await handler(messagesRequest(false));
      expect(response.status).toBe(502);
      expect(response.headers.get("x-eco-upstream-error-code")).toBe(code);
      expect(await response.json()).toMatchObject({ type: "error", error: { code } });
      expect(usage).toHaveLength(0);
      expect(lifecycle.filter((event) => event.type === "logical.failed")).toHaveLength(1);
      expect(lifecycle.filter((event) => event.type === "logical.completed")).toHaveLength(0);
    });
  }

  for (const stream of [true, false]) {
    test(`HTTP 200 流内订阅额度失败只上报一次且保留关联身份 stream=${stream}`, async () => {
      const reports: GatewayCredentialResult[] = [];
      const lifecycle: GatewayRequestLifecycleEvent[] = [];
      let upstreamCalls = 0;
      const quotaFailure =
        `data: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_quota", status: "in_progress", output: [] },
        })}\n\n` +
        `data: ${JSON.stringify({
          type: "response.failed",
          response: {
            id: "resp_quota",
            status: "failed",
            error: {
              type: "invalid_request_error",
              code: "subscription_sharing_usage_limit_exceeded",
              param: "model",
              message: "Subscription sharing usage limit exceeded",
            },
          },
        })}\n\n`;
      const handler = createGatewayFetchHandler(
        {
          host: "127.0.0.1",
          port: 0,
          providers: [provider],
          resolveCredential: async () => ({ accessToken: "oauth-access", accountId: "account-quota" }),
          reportCredentialResult: (result) => {
            reports.push(result);
          },
        },
        async () => {
          upstreamCalls += 1;
          return new Response(quotaFailure, {
            status: 200,
            headers: { "x-request-id": "req_quota" },
          });
        },
        () => undefined,
        undefined,
        (event) => {
          lifecycle.push(event);
        },
      );
      const request = messagesRequest(stream);
      request.headers.set("x-eco-logical-request-id", "logical-quota");
      request.headers.set("x-eco-bridge-binding-id", "binding-quota");
      request.headers.set("x-eco-run-attempt-id", "run-attempt-quota");
      request.headers.set(
        "x-codex-turn-metadata",
        JSON.stringify({
          thread_id: "codex-thread-quota",
          turn_id: "codex-turn-quota",
          request_kind: "turn",
        }),
      );

      const response = await handler(request);
      expect(response.status).toBe(stream ? 200 : 502);
      await response.text();
      expect(upstreamCalls).toBe(1);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        accountId: "account-quota",
        resultType: "failed",
        statusCode: 200,
        providerRequestId: "req_quota",
        responseId: "resp_quota",
        logicalRequestId: "logical-quota",
        bridgeBindingId: "binding-quota",
        threadId: "codex-thread-quota",
        turnId: "codex-turn-quota",
        runAttemptId: "run-attempt-quota",
        attemptIndex: 0,
        error: {
          code: "subscription_sharing_usage_limit_exceeded",
          param: "model",
          type: "invalid_request_error",
          eventType: "response.failed",
          rawEvent: {
            type: "response.failed",
            response: {
              id: "resp_quota",
              status: "failed",
              error: {
                code: "subscription_sharing_usage_limit_exceeded",
              },
            },
          },
        },
      });
      expect(lifecycle.filter((event) => event.type === "upstream.failed")).toHaveLength(1);
      expect(lifecycle.filter((event) => event.type === "logical.failed")).toHaveLength(1);
      expect(lifecycle.filter((event) => event.type === "logical.completed")).toHaveLength(0);
    });
  }

  test("非流式 OAuth 上游 403 保留状态和错误码供账号管理使用", async () => {
    const reports: unknown[] = [];
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        resolveCredential: async () => ({ accessToken: "oauth-access", accountId: "account-1" }),
        reportCredentialResult: (result) => {
          reports.push(result);
        },
      },
      async () =>
        Response.json(
          { error: { message: "Not eligible", code: "subscription_sharing_user_not_eligible" } },
          { status: 403 },
        ),
      () => undefined,
    );
    const response = await handler(messagesRequest(false));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "subscription_sharing_user_not_eligible" },
    });
    expect(reports[0]).toMatchObject({
      accountId: "account-1",
      statusCode: 403,
      resultType: "failed",
      error: { code: "subscription_sharing_user_not_eligible" },
    });
  });
  test("accepts the supported Responses preview shape", () => {
    expect(validateChatGptResponsesRequest(provider, validBody as never)).toBeUndefined();
  });

  test("rejects required preview violations before upstream fetch", () => {
    expect(validateChatGptResponsesRequest(provider, { ...validBody, stream: false } as never)).toContain(
      "stream:true",
    );
    expect(validateChatGptResponsesRequest(provider, { ...validBody, store: true } as never)).toContain(
      "store:false",
    );
    expect(validateChatGptResponsesRequest(provider, { ...validBody, temperature: 0 } as never)).toContain(
      "temperature",
    );
    expect(
      validateChatGptResponsesRequest(provider, { ...validBody, previous_response_id: "resp_1" } as never),
    ).toContain("previous_response_id");
  });

  test("resolves a token at request time and reports the selected account", async () => {
    const route: ResolvedProviderRoute = {
      provider,
      upstreamKind: "responses",
      requestedModel: "gpt-5",
      upstreamModelId: "gpt-5",
    };
    const reports: unknown[] = [];
    const config: GatewayConfig = {
      host: "127.0.0.1",
      port: 18765,
      providers: [provider],
      resolveCredential: async () => ({ accessToken: "oauth-access", accountId: "account-1" }),
      reportCredentialResult: (result) => reports.push(result),
    };
    const resolved = await resolveRouteCredential(route, config);
    expect(resolved.provider.apiKey).toBe("oauth-access");
    expect(resolved.credentialAccountId).toBe("account-1");
    await reportRouteCredentialResult(resolved, config, new Response(null, { status: 429 }));
    expect(reports).toHaveLength(1);
    expect((reports[0] as { accountId: string; statusCode: number }).accountId).toBe("account-1");
    expect((reports[0] as { accountId: string; statusCode: number }).statusCode).toBe(429);
  });

  test("Messages 转 Responses 时提前移除 max_output_tokens 并保留 stream", async () => {
    const chatgptProvider: GatewayProvider = {
      ...provider,
      apiKey: "local-unused",
      models: ["gpt-5"],
    };
    let upstreamBody: Record<string, unknown> | undefined;
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [chatgptProvider],
        resolveCredential: async () => ({ accessToken: "oauth-access", accountId: "account-1" }),
      },
      async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const response = {
          id: "resp_1",
          object: "response",
          status: "completed",
          model: "gpt-5",
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        return new Response(
          `data: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}\n\n` +
            terminalSse(response),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "eco-coding-chatgpt",
        },
        body: JSON.stringify({
          model: "gpt-5",
          max_tokens: 32768,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(upstreamBody).toBeDefined();
    expect(upstreamBody?.stream).toBe(true);
    expect(upstreamBody).not.toHaveProperty("max_output_tokens");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const sse = await response.text();
    expect(sse).toContain('"text":"ok"');
    expect(sse).toContain("message_stop");
  });

  test("流式上游 403 保留原状态并报告订阅资格错误", async () => {
    const reports: Array<{ accountId?: string; statusCode: number; errorCode?: string }> = [];
    let upstreamCalls = 0;
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [{ ...provider, models: ["gpt-5"] }],
        resolveCredential: async () => ({ accessToken: "oauth-access", accountId: "account-1" }),
        reportCredentialResult: (result) => reports.push(result),
      },
      async () => {
        upstreamCalls += 1;
        return new Response(
          JSON.stringify({
            error: {
              message: "The ChatGPT user is not eligible for subscription sharing.",
              code: "subscription_sharing_user_not_eligible",
            },
          }),
          { status: 403, headers: { "content-type": "text/plain" } },
        );
      },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "eco-coding-chatgpt",
        },
        body: JSON.stringify({
          model: "gpt-5",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-eco-upstream-error-code")).toBe("subscription_sharing_user_not_eligible");
    expect(await response.text()).toContain("not eligible for subscription sharing");
    expect(upstreamCalls).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      accountId: "account-1",
      statusCode: 403,
      resultType: "failed",
      error: { code: "subscription_sharing_user_not_eligible" },
    });
  });

  test("原生 Responses 请求移除 max_output_tokens 后透传上游 403", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [{ ...provider, models: ["gpt-5"] }],
        resolveCredential: async () => ({ accessToken: "oauth-access", accountId: "account-1" }),
      },
      async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(
          {
            error: {
              message: "The ChatGPT user is not eligible for subscription sharing.",
              code: "subscription_sharing_user_not_eligible",
            },
          },
          { status: 403 },
        );
      },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "eco-coding-chatgpt",
        },
        body: JSON.stringify({ ...validBody, max_output_tokens: 128 }),
      }),
    );

    expect(response.status).toBe(403);
    expect(upstreamBody).toBeDefined();
    expect(upstreamBody).not.toHaveProperty("max_output_tokens");
  });
});
