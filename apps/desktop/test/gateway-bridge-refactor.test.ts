/**
 * Gateway 架构重构回归（拍板硬标准）
 *
 * 1B 辅助经 Bridge
 * 2A compact 仅 Bridge 契约拦截
 * 3B 无 SDK/产品辅助直打 bridge-upstream 第二入口
 * 4A count_tokens 精确走内嵌 Gateway anthropic
 *
 * 运行：
 *   bun test apps/gateway apps/desktop/test/gateway-bridge-refactor.test.ts apps/desktop/test/provider-token-counter.test.ts apps/desktop/test/proxy-cch-audit.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  createGatewayFetchHandler,
  GATEWAY_PROVIDER_ID_HEADER,
  GATEWAY_REQUESTED_MODEL_HEADER,
  GATEWAY_UPSTREAM_KIND_HEADER,
} from "@eco/gateway";
import { buildCodexGatewayModelAlias } from "@eco/shared";
import { type AnthropicProxyRoute, startAnthropicModelProxy } from "../src/main/anthropic-proxy";
import { postAuxiliaryBridgeRequest } from "../src/main/bridge-auxiliary-request";
import {
  configureEcoGatewayLifecycle,
  resetGlobalEcoGatewayForTests,
} from "../src/main/eco-gateway-lifecycle";
import {
  buildEcoBridgeCompactInterceptResponse,
  createEcoSdkBridgeHandler,
} from "../src/main/eco-sdk-bridge";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import { countProviderInputTokens } from "../src/main/provider-token-counter";

function providerSecret(
  overrides: Partial<ProviderConfigSecret> & { baseUrl: string },
): ProviderConfigSecret {
  return {
    id: "provider_1",
    name: "Provider",
    requestPath: "",
    version: "v1",
    apiCompat: "anthropic",
    tokenCountMode: "anthropic_messages",
    defaultModel: "real-model",
    enabled: true,
    hasApiKey: true,
    apiKey: "sk-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await resetGlobalEcoGatewayForTests().catch(() => undefined);
});

describe("gateway-pure: 无 Eco 别名 / 必须 provider header", () => {
  test("H1 missing provider id → 400", async () => {
    const handler = createGatewayFetchHandler({
      host: "127.0.0.1",
      port: 0,
      providers: [
        {
          id: "p1",
          name: "P",
          upstreamKind: "responses",
          baseUrl: "http://mock.test",
          apiKey: "k",
          upstreamModelId: "m",
          models: ["m"],
        },
      ],
    });
    const res = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", input: [] }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("x-gateway-provider-id");
  });

  test("H1 eco_route alias is NOT parsed; concrete id + header works", async () => {
    let upstreamModel = "";
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [
          {
            id: "packy",
            name: "Packy",
            upstreamKind: "responses",
            baseUrl: "http://mock.packy.test",
            apiKey: "k",
            upstreamModelId: "deepseek",
            models: ["deepseek"],
          },
        ],
      },
      async (_url, init) => {
        upstreamModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return Response.json({ id: "resp_1", output: [] });
      },
    );
    const alias = buildCodexGatewayModelAlias("packy", "deepseek");
    // Without header: pure gateway must refuse even if body.model is eco alias
    const miss = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: alias, input: [] }),
      }),
    );
    expect(miss.status).toBe(400);

    const hit = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "packy",
          [GATEWAY_REQUESTED_MODEL_HEADER]: alias,
        },
        body: JSON.stringify({ model: "deepseek", input: [] }),
      }),
    );
    expect(hit.status).toBe(200);
    expect(upstreamModel).toBe("deepseek");
  });

  test("H2 gateway compact forwards Responses-capable providers (product intercept is Bridge)", async () => {
    let upstreamUrl = "";
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [
          {
            id: "openai",
            name: "O",
            upstreamKind: "responses",
            baseUrl: "http://mock.openai.test",
            apiKey: "k",
            upstreamModelId: "gpt",
            models: ["gpt"],
          },
        ],
      },
      async (input) => {
        upstreamUrl = String(input);
        return Response.json({
          id: "resp_compact",
          status: "completed",
          output: [
            {
              type: "compaction",
              encrypted_content: "native-compact",
            },
          ],
        });
      },
    );
    const res = await handler(
      new Request("http://127.0.0.1/v1/responses/compact", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "openai",
        },
        body: JSON.stringify({ model: "gpt", input: "x" }),
      }),
    );
    const json = (await res.json()) as {
      output: Array<{ type: string; encrypted_content?: string }>;
    };
    expect(res.status).toBe(200);
    expect(upstreamUrl).toBe("http://mock.openai.test/v1/responses/compact");
    expect(json.output[0]?.encrypted_content).toBe("native-compact");
  });
});

describe("2A: Bridge compact intercept（不调 gateway/upstream）", () => {
  test("H2 bridge compact returns contract compaction item", async () => {
    let gatewayCalled = false;
    const handler = createEcoSdkBridgeHandler({
      gateway: {
        port: 0,
        handleRequest: async () => {
          gatewayCalled = true;
          return Response.json({ error: "should not reach gateway" }, { status: 500 });
        },
        stop: () => undefined,
        getProviders: () => [],
        setProviders: () => undefined,
        setUpstreamUserAgent: () => undefined,
        setUpstreamUserAgents: () => undefined,
        setUpstreamProxyUrl: () => undefined,
        getUpstreamProxyUrl: () => undefined,
      },
    });
    const res = await handler(
      new Request("http://bridge/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "eco_test", input: "compact" }),
      }),
    );
    const json = (await res.json()) as {
      status: string;
      output: Array<{ type: string; encrypted_content?: string }>;
    };
    expect(res.status).toBe(200);
    expect(gatewayCalled).toBe(false);
    expect(json.status).toBe("completed");
    expect(json.output.filter((o) => o.type === "compaction")).toHaveLength(1);
    expect(json.output[0]?.encrypted_content).toBe("eco_bridge_compact_intercept");
  });

  test("H2 buildEcoBridgeCompactInterceptResponse shape stable", () => {
    const res = buildEcoBridgeCompactInterceptResponse({ model: "gpt-test" });
    expect(res.status).toBe(200);
  });
});

describe("1B: 辅助 HTTP 只打 Bridge，不直连 provider baseUrl", () => {
  test("prebound provider header wins over model table when ids collide", async () => {
    const seen: Array<{ providerId: string | null; model: string | null; kind: string | null }> = [];
    const gateway = {
      handleRequest: async (request: Request) => {
        const body = (await request.json()) as { model?: string };
        seen.push({
          providerId: request.headers.get(GATEWAY_PROVIDER_ID_HEADER),
          model: typeof body.model === "string" ? body.model : null,
          kind: request.headers.get(GATEWAY_UPSTREAM_KIND_HEADER),
        });
        return Response.json({
          id: "msg_prebound",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    };
    const handler = createEcoSdkBridgeHandler({
      gateway: gateway as never,
      // Wrong provider is first in table with the same shared model id.
      getProviders: () => [
        { id: "wrong_first", upstreamModelId: "shared-model", models: ["shared-model"] },
        { id: "aux_provider", upstreamModelId: "shared-model", models: ["shared-model"] },
      ],
      prepareClaudeMessages: async () => {
        // Would steal aux traffic if prebound check failed.
        return {
          kind: "forward",
          clientModel: "claude-stolen",
          resolution: {
            providerId: "claude_session",
            upstreamModelId: "claude-main",
            upstreamKind: "anthropic-messages",
          },
        };
      },
    });

    const res = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "aux_provider",
          [GATEWAY_UPSTREAM_KIND_HEADER]: "openai-chat",
          [GATEWAY_REQUESTED_MODEL_HEADER]: "shared-model",
        },
        body: JSON.stringify({
          model: "shared-model",
          max_tokens: 16,
          messages: [{ role: "user", content: "title me" }],
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(seen).toEqual([
      {
        providerId: "aux_provider",
        model: "shared-model",
        kind: "openai-chat",
      },
    ]);
  });

  test("H3 postAuxiliaryBridgeRequest hits bridge /v1/messages with provider header", async () => {
    const upstreamHits: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        upstreamHits.push(new URL(req.url).pathname);
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "aux-ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    const providerBase = `http://127.0.0.1:${upstream.port}`;
    configureEcoGatewayLifecycle({
      ecoDataDir: "/tmp/eco-gateway-refactor-aux",
      gatewayPort: 0,
      listProviders: () => [
        {
          id: "provider_1",
          name: "Provider",
          enabled: true,
          baseUrl: providerBase,
          apiKey: "sk-test",
          apiCompat: "anthropic",
          defaultModel: "real-model",
          modelIds: ["real-model"],
        },
      ],
    });

    const bridgeFetches: Array<{
      url: string;
      providerHeader: string | null;
      requestedModel: string | null;
      stream: unknown;
    }> = [];
    const route: AnthropicProxyRoute = {
      role: "planner",
      provider: providerSecret({ baseUrl: providerBase }),
      modelId: "real-model",
      apiCompat: "anthropic",
    };

    const result = await postAuxiliaryBridgeRequest({
      route,
      anthropicBody: {
        model: "ignored-alias",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      },
      logEventPrefix: "refactor-test-aux",
      fetcher: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        bridgeFetches.push({
          url,
          providerHeader: headers.get(GATEWAY_PROVIDER_ID_HEADER),
          requestedModel: headers.get(GATEWAY_REQUESTED_MODEL_HEADER),
          stream: (JSON.parse(String(init?.body)) as { stream?: unknown }).stream,
        });
        // Real fetch through system would use global fetch; here we force through bridge only
        // and reject if tester tries provider base.
        if (url.startsWith(providerBase)) {
          return new Response("leaked to provider", { status: 599 });
        }
        return fetch(input, init);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe("aux-ok");
    expect(bridgeFetches.length).toBeGreaterThanOrEqual(1);
    expect(bridgeFetches.every((f) => f.url.includes("/v1/messages"))).toBe(true);
    expect(bridgeFetches.every((f) => f.providerHeader === "provider_1")).toBe(true);
    expect(bridgeFetches.every((f) => f.requestedModel === "real-model")).toBe(true);
    expect(bridgeFetches.every((f) => f.stream === false)).toBe(true);
    expect(bridgeFetches.every((f) => !f.requestedModel?.startsWith("eco-aux-"))).toBe(true);
    expect(bridgeFetches.every((f) => !f.url.startsWith(providerBase))).toBe(true);
    // Gateway did hit real upstream with native messages
    expect(upstreamHits.some((p) => p.includes("/v1/messages"))).toBe(true);

    upstream.stop(true);
  });

  test("H3 ChatGPT 订阅辅助请求使用 stream:true", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const route: AnthropicProxyRoute = {
      role: "planner",
      provider: providerSecret({
        baseUrl: "https://api.openai.com",
        authMethod: "chatgpt_subscription",
      }),
      modelId: "gpt-5.6-luna",
      apiCompat: "openai_responses",
    };

    const result = await postAuxiliaryBridgeRequest({
      route,
      anthropicBody: {
        model: "ignored-alias",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      },
      logEventPrefix: "refactor-test-chatgpt-aux",
      fetcher: async (_input, init) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          id: "msg_chatgpt",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "aux-ok" }],
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe("aux-ok");
    expect(seenBody?.stream).toBe(true);
  });
});

describe("4A: Anthropic 精确 count 走内嵌 Gateway", () => {
  test("H4 count_tokens anthropic ends at provider count_tokens via gateway", async () => {
    const upstreamPaths: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        upstreamPaths.push(new URL(req.url).pathname);
        return Response.json({ input_tokens: 42 });
      },
    });
    const baseUrl = `http://127.0.0.1:${upstream.port}`;
    configureEcoGatewayLifecycle({
      ecoDataDir: "/tmp/eco-gateway-refactor-count",
      gatewayPort: 0,
      listProviders: () => [
        {
          id: "provider_1",
          name: "Provider",
          enabled: true,
          baseUrl,
          apiKey: "sk",
          apiCompat: "anthropic",
          defaultModel: "real-model",
          modelIds: ["real-model"],
        },
      ],
    });

    const counted = await countProviderInputTokens({
      mode: "anthropic_messages",
      provider: providerSecret({ baseUrl, tokenCountMode: "anthropic_messages" }),
      modelId: "real-model",
      anthropicBody: {
        model: "alias",
        messages: [{ role: "user", content: "x" }],
      },
    });

    expect(counted.tokens).toBe(42);
    expect(counted.precision).toBe("provider_exact");
    expect(counted.source).toBe("eco-gateway:/v1/messages/count_tokens");
    expect(upstreamPaths).toContain("/v1/messages/count_tokens");

    upstream.stop(true);
  });

  test("H4 Claude SDK compact face count via Bridge→product→gateway", async () => {
    const upstreamPaths: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        upstreamPaths.push(new URL(req.url).pathname);
        return Response.json({ input_tokens: 99 });
      },
    });
    const baseUrl = `http://127.0.0.1:${upstream.port}`;
    configureEcoGatewayLifecycle({
      ecoDataDir: "/tmp/eco-gateway-refactor-sdk-count",
      gatewayPort: 0,
      listProviders: () => [
        {
          id: "provider_1",
          name: "Provider",
          enabled: true,
          baseUrl,
          apiKey: "sk",
          apiCompat: "anthropic",
          defaultModel: "real-model",
          modelIds: ["real-model"],
        },
      ],
    });
    const proxy = await startAnthropicModelProxy([
      {
        role: "planner",
        provider: providerSecret({ baseUrl, tokenCountMode: "anthropic_messages" }),
        modelId: "real-model",
      },
    ]);
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, {
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
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ input_tokens: 99 });
      expect(upstreamPaths).toContain("/v1/messages/count_tokens");
    } finally {
      await proxy.close();
      upstream.stop(true);
    }
  });
});

describe("Claude 主路径：alias 登记 + Bridge messages 转发", () => {
  test("H5 messages with eco alias uses bridge baseUrl; upstream sees real model", async () => {
    const upstreamBodies: Array<{ model?: string }> = [];
    const upstream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.method === "POST") {
          upstreamBodies.push((await req.json()) as { model?: string });
        }
        return Response.json({
          id: "msg_claude",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "pong" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 1 },
        });
      },
    });
    const baseUrl = `http://127.0.0.1:${upstream.port}`;
    configureEcoGatewayLifecycle({
      ecoDataDir: "/tmp/eco-gateway-refactor-messages",
      gatewayPort: 0,
      listProviders: () => [
        {
          id: "provider_1",
          name: "Provider",
          enabled: true,
          baseUrl,
          apiKey: "sk",
          apiCompat: "anthropic",
          defaultModel: "real-model",
          modelIds: ["real-model"],
        },
      ],
    });
    const proxy = await startAnthropicModelProxy([
      {
        role: "coder",
        provider: providerSecret({ baseUrl }),
        modelId: "real-model",
      },
    ]);
    try {
      expect(proxy.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": proxy.apiKey,
        },
        body: JSON.stringify({
          model: proxy.routes[0]?.aliasModelId,
          max_tokens: 32,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const json = (await res.json()) as { content: Array<{ text: string }> };
      expect(res.status).toBe(200);
      expect(json.content?.[0]?.text).toBe("pong");
      expect(upstreamBodies.every((b) => b.model === "real-model")).toBe(true);
      expect(proxy.routes[0]?.aliasModelId).toMatch(/^eco-coder-/);
    } finally {
      await proxy.close();
      upstream.stop(true);
    }
  });
});

describe("messages face: openai-chat 转换矩阵", () => {
  test("H6 POST /v1/messages openai-chat converts via chat completions", async () => {
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [
          {
            id: "chat",
            name: "Chat",
            upstreamKind: "openai-chat",
            baseUrl: "http://mock.chat.test",
            apiKey: "k",
            upstreamModelId: "chat-model",
            models: ["chat-model"],
          },
        ],
      },
      async (input) => {
        expect(String(input)).toBe("http://mock.chat.test/v1/chat/completions");
        return Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "chat-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "from-chat" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    );
    const res = await handler(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_PROVIDER_ID_HEADER]: "chat",
          [GATEWAY_UPSTREAM_KIND_HEADER]: "openai-chat",
        },
        body: JSON.stringify({
          model: "chat-model",
          max_tokens: 16,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    const json = (await res.json()) as {
      type: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(res.status).toBe(200);
    expect(json.type).toBe("message");
    expect(JSON.stringify(json.content)).toContain("from-chat");
  });
});
