/**
 * Characterization + acceptance tests for Claude Bridge concurrent isolation.
 * Concurrent runs must not share activeClaudeSession / clear each other's routes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ParsedUsage } from "@eco/runtime";
import {
  type AnthropicProxyUsageInfo,
  emitClaudeGatewayUsageIfSession,
  LOCAL_PROXY_API_KEY,
  prepareClaudeBridgeMessagesRequest,
  startAnthropicModelProxy,
} from "../src/main/anthropic-proxy";
import {
  globalClaudeBridgeBindingRegistry,
  redactClaudeBridgeSecret,
} from "../src/main/claude-bridge-binding";
import {
  configureEcoGatewayLifecycle,
  resetGlobalEcoGatewayForTests,
} from "../src/main/eco-gateway-lifecycle";
import {
  clearGatewayRequestLifecycleStateForTests,
  handleGatewayRequestLifecycleEvent,
} from "../src/main/gateway-request-lifecycle";
import type { ProviderConfigSecret } from "../src/main/provider-store";

afterEach(async () => {
  clearGatewayRequestLifecycleStateForTests();
  globalClaudeBridgeBindingRegistry.clearAllForTests();
  await resetGlobalEcoGatewayForTests();
});

describe("Claude Bridge concurrent isolation", () => {
  test("two Claude threads with different providers stay isolated", async () => {
    const upstreamA = serveUpstream("provider-a", "model-a", "pong-a");
    const upstreamB = serveUpstream("provider-b", "model-b", "pong-b");
    try {
      configureLifecycle([
        providerEntry("provider_a", upstreamA.baseUrl, "model-a"),
        providerEntry("provider_b", upstreamB.baseUrl, "model-b"),
      ]);

      const usagesA: AnthropicProxyUsageInfo[] = [];
      const usagesB: AnthropicProxyUsageInfo[] = [];

      const proxyA = await startAnthropicModelProxy(
        [
          {
            role: "coder",
            provider: providerSecret("provider_a", "A", upstreamA.baseUrl),
            modelId: "model-a",
          },
        ],
        {
          threadId: "thread-a",
          onUsage: (info) => {
            usagesA.push(info);
          },
        },
      );
      const proxyB = await startAnthropicModelProxy(
        [
          {
            role: "coder",
            provider: providerSecret("provider_b", "B", upstreamB.baseUrl),
            modelId: "model-b",
          },
        ],
        {
          threadId: "thread-b",
          onUsage: (info) => {
            usagesB.push(info);
          },
        },
      );

      expect(proxyA.apiKey).not.toBe(proxyB.apiKey);
      expect(proxyA.apiKey).not.toBe(LOCAL_PROXY_API_KEY);
      expect(proxyB.apiKey).not.toBe(LOCAL_PROXY_API_KEY);

      const [resA, resB] = await Promise.all([
        postMessages(proxyA.baseUrl, proxyA.apiKey, proxyA.routes[0]!.aliasModelId),
        postMessages(proxyB.baseUrl, proxyB.apiKey, proxyB.routes[0]!.aliasModelId),
      ]);

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(await resA.json().then((j: { content: Array<{ text: string }> }) => j.content[0]?.text)).toBe(
        "pong-a",
      );
      expect(await resB.json().then((j: { content: Array<{ text: string }> }) => j.content[0]?.text)).toBe(
        "pong-b",
      );
      expect(upstreamA.models).toEqual(["model-a"]);
      expect(upstreamB.models).toEqual(["model-b"]);

      await proxyA.close();
      await proxyB.close();
    } finally {
      upstreamA.stop();
      upstreamB.stop();
    }
  });

  test("two threads with the same model id still isolate by credential", async () => {
    const upstream = serveUpstream("shared", "shared-model", "ok");
    try {
      configureLifecycle([providerEntry("prov", upstream.baseUrl, "shared-model")]);
      const proxyA = await startAnthropicModelProxy(
        [
          {
            role: "main",
            provider: providerSecret("prov", "P", upstream.baseUrl),
            modelId: "shared-model",
          },
        ],
        { threadId: "t-a" },
      );
      const proxyB = await startAnthropicModelProxy(
        [
          {
            role: "main",
            provider: providerSecret("prov", "P", upstream.baseUrl),
            modelId: "shared-model",
          },
        ],
        { threadId: "t-b" },
      );

      expect(proxyA.routes[0]?.aliasModelId).toBe(proxyB.routes[0]?.aliasModelId);

      const modelsA = await fetch(`${proxyA.baseUrl}/v1/models`, {
        headers: { "x-api-key": proxyA.apiKey },
      });
      const modelsB = await fetch(`${proxyB.baseUrl}/v1/models`, {
        headers: { "x-api-key": proxyB.apiKey },
      });
      expect(modelsA.status).toBe(200);
      expect(modelsB.status).toBe(200);

      // Closing A must not revoke B's credential.
      await proxyA.close();
      const stillB = await postMessages(proxyB.baseUrl, proxyB.apiKey, proxyB.routes[0]!.aliasModelId);
      expect(stillB.status).toBe(200);

      const deadA = await postMessages(proxyA.baseUrl, proxyA.apiKey, proxyA.routes[0]!.aliasModelId);
      expect(deadA.status).toBe(401);

      await proxyB.close();
    } finally {
      upstream.stop();
    }
  });

  test("missing / wrong / revoked credentials fail closed with 401", async () => {
    const upstream = serveUpstream("auth", "m1", "ok");
    try {
      configureLifecycle([providerEntry("prov", upstream.baseUrl, "m1")]);
      const proxy = await startAnthropicModelProxy(
        [
          {
            role: "coder",
            provider: providerSecret("prov", "P", upstream.baseUrl),
            modelId: "m1",
          },
        ],
        { threadId: "t-auth" },
      );

      const noKey = await postMessages(proxy.baseUrl, "", proxy.routes[0]!.aliasModelId);
      expect(noKey.status).toBe(401);

      const badKey = await postMessages(proxy.baseUrl, "not-a-binding", proxy.routes[0]!.aliasModelId);
      expect(badKey.status).toBe(401);

      const legacyShared = await postMessages(
        proxy.baseUrl,
        LOCAL_PROXY_API_KEY,
        proxy.routes[0]!.aliasModelId,
      );
      expect(legacyShared.status).toBe(401);

      await proxy.close();
      const revoked = await postMessages(proxy.baseUrl, proxy.apiKey, proxy.routes[0]!.aliasModelId);
      expect(revoked.status).toBe(401);
    } finally {
      upstream.stop();
    }
  });

  test("pending images inject only into each binding's first messages request", async () => {
    const bodiesA: Array<Record<string, unknown>> = [];
    const bodiesB: Array<Record<string, unknown>> = [];
    const upstreamA = Bun.serve({
      port: 0,
      fetch: async (req) => {
        bodiesA.push((await req.json()) as Record<string, unknown>);
        return Response.json(messageJson("a"));
      },
    });
    const upstreamB = Bun.serve({
      port: 0,
      fetch: async (req) => {
        bodiesB.push((await req.json()) as Record<string, unknown>);
        return Response.json(messageJson("b"));
      },
    });
    const baseA = `http://127.0.0.1:${upstreamA.port}`;
    const baseB = `http://127.0.0.1:${upstreamB.port}`;
    try {
      configureLifecycle([providerEntry("pa", baseA, "ma"), providerEntry("pb", baseB, "mb")]);
      const proxyA = await startAnthropicModelProxy(
        [{ role: "coder", provider: providerSecret("pa", "A", baseA), modelId: "ma" }],
        {
          threadId: "img-a",
          pendingImages: [{ mediaType: "image/png", data: Buffer.from("img-a").toString("base64") }],
        },
      );
      const proxyB = await startAnthropicModelProxy(
        [{ role: "coder", provider: providerSecret("pb", "B", baseB), modelId: "mb" }],
        {
          threadId: "img-b",
          pendingImages: [{ mediaType: "image/png", data: Buffer.from("img-b").toString("base64") }],
        },
      );

      await postMessages(proxyA.baseUrl, proxyA.apiKey, proxyA.routes[0]!.aliasModelId);
      await postMessages(proxyB.baseUrl, proxyB.apiKey, proxyB.routes[0]!.aliasModelId);
      await postMessages(proxyA.baseUrl, proxyA.apiKey, proxyA.routes[0]!.aliasModelId);
      await postMessages(proxyB.baseUrl, proxyB.apiKey, proxyB.routes[0]!.aliasModelId);

      expect(JSON.stringify(bodiesA[0])).toContain(Buffer.from("img-a").toString("base64"));
      expect(JSON.stringify(bodiesA[0])).not.toContain(Buffer.from("img-b").toString("base64"));
      expect(JSON.stringify(bodiesB[0])).toContain(Buffer.from("img-b").toString("base64"));
      expect(JSON.stringify(bodiesB[0])).not.toContain(Buffer.from("img-a").toString("base64"));
      expect(JSON.stringify(bodiesA[1])).not.toContain("image");
      expect(JSON.stringify(bodiesB[1])).not.toContain("image");

      await proxyA.close();
      await proxyB.close();
    } finally {
      upstreamA.stop(true);
      upstreamB.stop(true);
    }
  });

  test("count_tokens does not consume pending images for the real messages request", async () => {
    const upstreamBodies: Record<string, unknown>[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.includes("count_tokens")) {
          return Response.json({ input_tokens: 99 });
        }
        upstreamBodies.push((await req.json()) as Record<string, unknown>);
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "ma",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    const baseUrl = `http://127.0.0.1:${upstream.port}`;
    const imageData = Buffer.from("keep-me").toString("base64");
    try {
      configureLifecycle([providerEntry("pa", baseUrl, "ma")]);
      const proxy = await startAnthropicModelProxy(
        [
          {
            role: "coder",
            provider: {
              ...providerSecret("pa", "A", baseUrl),
              tokenCountMode: "anthropic_messages",
            },
            modelId: "ma",
          },
        ],
        {
          threadId: "img-count",
          pendingImages: [{ mediaType: "image/png", data: imageData }],
        },
      );
      const binding = globalClaudeBridgeBindingRegistry.getByCredential(proxy.apiKey)!;
      expect(binding.pendingImages).toHaveLength(1);
      expect(binding.imagesInjected).toBe(false);

      const countRes = await fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": proxy.apiKey,
        },
        body: JSON.stringify({
          model: proxy.routes[0]!.aliasModelId,
          messages: [{ role: "user", content: "count me" }],
        }),
      });
      expect(countRes.ok).toBe(true);
      expect(binding.pendingImages).toHaveLength(1);
      expect(binding.imagesInjected).toBe(false);

      await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": proxy.apiKey,
        },
        body: JSON.stringify({
          model: proxy.routes[0]!.aliasModelId,
          messages: [{ role: "user", content: "real request" }],
          max_tokens: 16,
        }),
      });

      expect(binding.pendingImages).toHaveLength(0);
      expect(binding.imagesInjected).toBe(true);
      expect(JSON.stringify(upstreamBodies[0])).toContain(imageData);

      await proxy.close();
    } finally {
      upstream.stop(true);
    }
  });

  test("usage / callbacks attribute to owning binding; late usage after close still lands on A", async () => {
    configureLifecycle([providerEntry("pa", "https://a.test", "model-a")]);
    const usagesA: AnthropicProxyUsageInfo[] = [];
    const usagesB: AnthropicProxyUsageInfo[] = [];

    const proxyA = await startAnthropicModelProxy(
      [{ role: "coder", provider: providerSecret("pa", "A", "https://a.test"), modelId: "model-a" }],
      {
        threadId: "usage-a",
        onUsage: (info) => {
          usagesA.push(info);
        },
      },
    );
    const proxyB = await startAnthropicModelProxy(
      [{ role: "coder", provider: providerSecret("pb", "B", "https://b.test"), modelId: "model-b" }],
      {
        threadId: "usage-b",
        onUsage: (info) => {
          usagesB.push(info);
        },
      },
    );

    const usage: ParsedUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };

    const bindingA = globalClaudeBridgeBindingRegistry.getByCredential(proxyA.apiKey);
    const bindingB = globalClaudeBridgeBindingRegistry.getByCredential(proxyB.apiKey);
    expect(bindingA).toBeDefined();
    expect(bindingB).toBeDefined();

    expect(
      await emitClaudeGatewayUsageIfSession({
        providerId: "pa",
        requestedModel: proxyA.routes[0]!.aliasModelId,
        upstreamModelId: "model-a",
        usage,
        bridgeBindingId: bindingA!.bindingId,
      }),
    ).toBe(true);
    expect(
      await emitClaudeGatewayUsageIfSession({
        providerId: "pb",
        requestedModel: proxyB.routes[0]!.aliasModelId,
        upstreamModelId: "model-b",
        usage,
        bridgeBindingId: bindingB!.bindingId,
      }),
    ).toBe(true);

    expect(usagesA).toHaveLength(1);
    expect(usagesB).toHaveLength(1);
    expect(usagesA[0]?.providerId).toBe("pa");
    expect(usagesB[0]?.providerId).toBe("pb");

    // Hold a lease so close waits; late usage while closing still attributes to A.
    expect(globalClaudeBridgeBindingRegistry.acquire(bindingA!)).toBe(true);
    const closePromise = proxyA.close();
    expect(bindingA!.state).toBe("closing");
    expect(
      await emitClaudeGatewayUsageIfSession({
        providerId: "pa",
        requestedModel: proxyA.routes[0]!.aliasModelId,
        upstreamModelId: "model-a",
        usage: { ...usage, outputTokens: 9 },
        bridgeBindingId: bindingA!.bindingId,
      }),
    ).toBe(true);
    globalClaudeBridgeBindingRegistry.release(bindingA!);
    await closePromise;
    expect(usagesA).toHaveLength(2);
    expect(usagesA[1]?.usage.outputTokens).toBe(9);

    // B unaffected.
    expect(
      await emitClaudeGatewayUsageIfSession({
        providerId: "pb",
        requestedModel: proxyB.routes[0]!.aliasModelId,
        upstreamModelId: "model-b",
        usage,
        bridgeBindingId: bindingB!.bindingId,
      }),
    ).toBe(true);
    expect(usagesB).toHaveLength(2);

    await proxyB.close();
  });

  test("close waits for reserved usage settle scheduled after lease release", async () => {
    configureLifecycle([providerEntry("pa", "https://a.test", "model-a")]);
    const usages: AnthropicProxyUsageInfo[] = [];
    const proxy = await startAnthropicModelProxy(
      [{ role: "coder", provider: providerSecret("pa", "A", "https://a.test"), modelId: "model-a" }],
      {
        threadId: "usage-race",
        onUsage: async (info) => {
          await Bun.sleep(30);
          usages.push(info);
        },
      },
    );
    const binding = globalClaudeBridgeBindingRegistry.getByCredential(proxy.apiKey)!;
    const releaseSettle = globalClaudeBridgeBindingRegistry.reserveUsageSettle(binding.bindingId);
    expect(releaseSettle).toBeDefined();

    // Simulate stream end releasing the request lease while usage observer is still pending.
    expect(globalClaudeBridgeBindingRegistry.acquire(binding)).toBe(true);
    globalClaudeBridgeBindingRegistry.release(binding);

    const closePromise = proxy.close();
    const attributed = emitClaudeGatewayUsageIfSession({
      providerId: "pa",
      requestedModel: proxy.routes[0]!.aliasModelId,
      upstreamModelId: "model-a",
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      bridgeBindingId: binding.bindingId,
    });
    // Release the pre-close reservation only after attribution has started.
    await Bun.sleep(5);
    releaseSettle!();
    expect(await attributed).toBe(true);
    await closePromise;
    expect(usages).toHaveLength(1);
    expect(usages[0]?.usage.inputTokens).toBe(4);
  });

  test("SSE streams interleaved across bindings do not cross-attribute usage", async () => {
    const usagesA: AnthropicProxyUsageInfo[] = [];
    const usagesB: AnthropicProxyUsageInfo[] = [];

    const upstreamA = Bun.serve({
      port: 0,
      fetch: async () =>
        new Response(
          [
            "event: message_start",
            'data: {"type":"message_start","message":{"id":"msg_a","type":"message","role":"assistant","content":[],"model":"model-a","usage":{"input_tokens":3,"output_tokens":0}}}',
            "",
            "event: content_block_delta",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}',
            "",
            "event: message_delta",
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
            "",
            "event: message_stop",
            'data: {"type":"message_stop"}',
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const upstreamB = Bun.serve({
      port: 0,
      fetch: async () =>
        new Response(
          [
            "event: message_start",
            'data: {"type":"message_start","message":{"id":"msg_b","type":"message","role":"assistant","content":[],"model":"model-b","usage":{"input_tokens":7,"output_tokens":0}}}',
            "",
            "event: content_block_delta",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"b"}}',
            "",
            "event: message_delta",
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
            "",
            "event: message_stop",
            'data: {"type":"message_stop"}',
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const baseA = `http://127.0.0.1:${upstreamA.port}`;
    const baseB = `http://127.0.0.1:${upstreamB.port}`;
    try {
      configureEcoGatewayLifecycle({
        ecoDataDir: `/tmp/eco-claude-bridge-sse-${Date.now()}`,
        gatewayPort: 0,
        listProviders: () => [providerEntry("pa", baseA, "model-a"), providerEntry("pb", baseB, "model-b")],
        onUsage: async (event) => {
          await emitClaudeGatewayUsageIfSession({
            providerId: event.providerId,
            requestedModel: event.requestedModel,
            upstreamModelId: event.upstreamModelId,
            usage: event.usage,
            ...(event.bridgeBindingId ? { bridgeBindingId: event.bridgeBindingId } : {}),
          });
        },
      });

      const proxyA = await startAnthropicModelProxy(
        [{ role: "coder", provider: providerSecret("pa", "A", baseA), modelId: "model-a" }],
        {
          threadId: "sse-a",
          onUsage: (info) => {
            usagesA.push(info);
          },
        },
      );
      const proxyB = await startAnthropicModelProxy(
        [{ role: "coder", provider: providerSecret("pb", "B", baseB), modelId: "model-b" }],
        {
          threadId: "sse-b",
          onUsage: (info) => {
            usagesB.push(info);
          },
        },
      );

      const [resA, resB] = await Promise.all([
        fetch(`${proxyA.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": proxyA.apiKey,
          },
          body: JSON.stringify({
            model: proxyA.routes[0]!.aliasModelId,
            max_tokens: 16,
            stream: true,
            messages: [{ role: "user", content: "a" }],
          }),
        }),
        fetch(`${proxyB.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": proxyB.apiKey,
          },
          body: JSON.stringify({
            model: proxyB.routes[0]!.aliasModelId,
            max_tokens: 16,
            stream: true,
            messages: [{ role: "user", content: "b" }],
          }),
        }),
      ]);

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      await Promise.all([resA.text(), resB.text()]);
      // Allow gateway usage observers to settle.
      await Bun.sleep(50);

      expect(usagesA).toHaveLength(1);
      expect(usagesB).toHaveLength(1);
      expect(usagesA[0]?.providerId).toBe("pa");
      expect(usagesB[0]?.providerId).toBe("pb");
      expect(usagesA[0]?.usage.inputTokens).toBe(3);
      expect(usagesB[0]?.usage.inputTokens).toBe(7);

      await proxyA.close();
      await proxyB.close();
    } finally {
      upstreamA.stop(true);
      upstreamB.stop(true);
    }
  });

  test("Claude request chain does not read a global session; secrets are redacted", async () => {
    expect(redactClaudeBridgeSecret("eco_cbb_abcdefghijklmnopqrstuvwxyz0123456789")).toMatch(
      /^eco_cb…[0-9a-f]{4}$/,
    );
    expect(redactClaudeBridgeSecret(undefined)).toBe("(none)");

    const prepared = await prepareClaudeBridgeMessagesRequest({
      path: "/v1/messages",
      body: { model: "eco-coder-deadbeef", messages: [] },
      requestedModel: "eco-coder-deadbeef",
      // no headers → no credential
    });
    expect(prepared.kind).toBe("response");
    if (prepared.kind === "response") {
      expect(prepared.response.status).toBe(401);
    }
  });

  test("/v1/models and count_tokens are binding-scoped", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: async () => Response.json({ input_tokens: 42 }),
    });
    const baseUrl = `http://127.0.0.1:${upstream.port}`;
    try {
      configureLifecycle([providerEntry("prov", baseUrl, "m1")]);
      const proxyA = await startAnthropicModelProxy(
        [
          {
            role: "main",
            provider: {
              ...providerSecret("prov", "P", baseUrl),
              tokenCountMode: "anthropic_messages",
            },
            modelId: "m1",
          },
        ],
        { threadId: "models-a" },
      );
      const proxyB = await startAnthropicModelProxy(
        [
          {
            role: "coder",
            provider: {
              ...providerSecret("prov", "P", baseUrl),
              tokenCountMode: "anthropic_messages",
            },
            modelId: "m1",
          },
        ],
        { threadId: "models-b" },
      );

      const listA = await fetch(`${proxyA.baseUrl}/v1/models`, {
        headers: { "x-api-key": proxyA.apiKey },
      });
      const listB = await fetch(`${proxyB.baseUrl}/v1/models`, {
        headers: { "x-api-key": proxyB.apiKey },
      });
      const jsonA = (await listA.json()) as { data: Array<{ id: string }> };
      const jsonB = (await listB.json()) as { data: Array<{ id: string }> };
      expect(jsonA.data.map((d) => d.id)).toEqual([proxyA.routes[0]!.aliasModelId]);
      expect(jsonB.data.map((d) => d.id)).toEqual([proxyB.routes[0]!.aliasModelId]);
      expect(jsonA.data[0]?.id).not.toBe(jsonB.data[0]?.id);

      const count = await fetch(`${proxyA.baseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": proxyA.apiKey,
        },
        body: JSON.stringify({
          model: proxyA.routes[0]!.aliasModelId,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(count.status).toBe(200);
      expect(await count.json()).toEqual({ input_tokens: 42 });

      await proxyA.close();
      await proxyB.close();
    } finally {
      upstream.stop(true);
    }
  });

  test("late usage keeps binding-stamped runAttemptId after a newer attempt is current", async () => {
    configureLifecycle([providerEntry("pa", "https://a.test", "model-a")]);
    const stampedAttempts: Array<string | undefined> = [];
    const proxy = await startAnthropicModelProxy(
      [{ role: "coder", provider: providerSecret("pa", "A", "https://a.test"), modelId: "model-a" }],
      {
        threadId: "attempt-stamp",
        runAttemptId: "attempt_old",
        onUsage: (info) => {
          stampedAttempts.push(info.stampedRunAttemptId);
        },
      },
    );
    const binding = globalClaudeBridgeBindingRegistry.getByCredential(proxy.apiKey)!;
    expect(binding.runAttemptId).toBe("attempt_old");

    expect(
      await emitClaudeGatewayUsageIfSession({
        providerId: "pa",
        requestedModel: proxy.routes[0]!.aliasModelId,
        upstreamModelId: "model-a",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        bridgeBindingId: binding.bindingId,
        requestId: "req_old",
      }),
    ).toBe(true);

    expect(stampedAttempts).toEqual(["attempt_old"]);
    await proxy.close();
  });

  test("gateway upstream.headers lifecycle reports provider request id once per logical request", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () =>
        Response.json(messageJson("ok"), {
          headers: { "request-id": "req_from_upstream" },
        }),
    });
    try {
      const handlerRequestIds: string[] = [];
      let observedLogicalRequestId: string | undefined;
      configureLifecycle([providerEntry("pa", `http://127.0.0.1:${server.port}`, "model-a")], {
        onRequestLifecycle: (event) => {
          if (event.type === "upstream.headers") {
            observedLogicalRequestId = event.logicalRequestId;
          }
          handleGatewayRequestLifecycleEvent(event, {
            onUpstreamRequestId: ({ requestId }) => handlerRequestIds.push(requestId),
            onUpstreamConnectionError: () => {},
          });
        },
      });
      const proxy = await startAnthropicModelProxy(
        [
          {
            role: "coder",
            provider: providerSecret("pa", "A", `http://127.0.0.1:${server.port}`),
            modelId: "model-a",
          },
        ],
        { threadId: "lifecycle-thread" },
      );
      const alias = proxy.routes[0]?.aliasModelId;
      if (!alias) {
        throw new Error("expected Claude proxy route alias");
      }
      const res = await postMessages(proxy.baseUrl, proxy.apiKey, alias);
      expect(res.status).toBe(200);
      expect(res.headers.get("request-id")).toBe("req_from_upstream");
      expect(handlerRequestIds).toEqual(["req_from_upstream"]);
      expect(observedLogicalRequestId).toBeDefined();

      const binding = globalClaudeBridgeBindingRegistry.getByCredential(proxy.apiKey)!;
      handleGatewayRequestLifecycleEvent(
        {
          type: "upstream.headers",
          source: "messages",
          providerId: "pa",
          requestedModel: alias,
          upstreamModelId: "model-a",
          bridgeBindingId: binding.bindingId,
          threadId: "lifecycle-thread",
          logicalRequestId: observedLogicalRequestId!,
          attemptIndex: 0,
          providerRequestId: "req_from_upstream",
          statusCode: 200,
          observedAt: new Date().toISOString(),
        },
        {
          onUpstreamRequestId: ({ requestId }) => handlerRequestIds.push(requestId),
          onUpstreamConnectionError: () => {},
        },
      );
      expect(handlerRequestIds).toEqual(["req_from_upstream"]);

      handleGatewayRequestLifecycleEvent(
        {
          type: "upstream.headers",
          source: "messages",
          providerId: "pa",
          requestedModel: alias,
          upstreamModelId: "model-a",
          bridgeBindingId: binding.bindingId,
          threadId: "lifecycle-thread",
          logicalRequestId: "lr_other_logical_same_provider",
          attemptIndex: 0,
          providerRequestId: "req_from_upstream",
          statusCode: 200,
          observedAt: new Date().toISOString(),
        },
        {
          onUpstreamRequestId: ({ requestId }) => handlerRequestIds.push(requestId),
          onUpstreamConnectionError: () => {},
        },
      );
      expect(handlerRequestIds).toEqual(["req_from_upstream", "req_from_upstream"]);

      await proxy.close();
    } finally {
      server.stop(true);
    }
  });

  test("emitClaudeGatewayUsageIfSession forwards stampedAgentId from logical request lookup", async () => {
    configureLifecycle([providerEntry("pa", "https://stamp.test", "model-a")]);
    const usages: AnthropicProxyUsageInfo[] = [];
    const proxy = await startAnthropicModelProxy(
      [
        {
          role: "coder",
          provider: providerSecret("pa", "A", "https://stamp.test"),
          modelId: "model-a",
        },
      ],
      {
        threadId: "stamp-thread",
        onUsage: (info) => {
          usages.push(info);
        },
      },
    );
    const binding = globalClaudeBridgeBindingRegistry.getByCredential(proxy.apiKey)!;
    expect(
      await emitClaudeGatewayUsageIfSession({
        providerId: "pa",
        requestedModel: proxy.routes[0]!.aliasModelId,
        upstreamModelId: "model-a",
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        bridgeBindingId: binding.bindingId,
        logicalRequestId: "req_logical_for_stamp",
        stampedAgentId: "agent_from_logical",
        stampedBillingRole: "coder",
      }),
    ).toBe(true);
    expect(usages).toHaveLength(1);
    expect(usages[0]?.stampedAgentId).toBe("agent_from_logical");
    expect(usages[0]?.stampedBillingRole).toBe("coder");
    expect(usages[0]?.logicalRequestId).toBe("req_logical_for_stamp");
    await proxy.close();
  });
});

function configureLifecycle(
  providers: Array<{
    id: string;
    name: string;
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    apiCompat: "anthropic";
    defaultModel: string;
    modelIds: string[];
  }>,
  options?: {
    onRequestLifecycle?: import("@eco/gateway").GatewayRequestLifecycleObserver;
  },
): void {
  configureEcoGatewayLifecycle({
    ecoDataDir: `/tmp/eco-claude-bridge-concurrent-${Date.now()}`,
    gatewayPort: 0,
    listProviders: () => providers,
    ...(options?.onRequestLifecycle ? { onRequestLifecycle: options.onRequestLifecycle } : {}),
  });
}

function providerEntry(id: string, baseUrl: string, model: string) {
  return {
    id,
    name: id,
    enabled: true,
    baseUrl,
    apiKey: "sk",
    apiCompat: "anthropic" as const,
    defaultModel: model,
    modelIds: [model],
  };
}

function providerSecret(id: string, name: string, baseUrl: string): ProviderConfigSecret {
  return {
    id,
    name,
    baseUrl,
    requestPath: "",
    version: "v1",
    defaultModel: "x",
    enabled: true,
    hasApiKey: true,
    apiKey: "sk",
    createdAt: "",
    updatedAt: "",
  };
}

function serveUpstream(label: string, expectedModel: string, text: string) {
  const models: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { model?: string };
      models.push(body.model ?? "");
      void label;
      void expectedModel;
      return Response.json(messageJson(text));
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    models,
    stop: () => server.stop(true),
  };
}

function messageJson(text: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function postMessages(baseUrl: string, apiKey: string, model: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 16,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}
