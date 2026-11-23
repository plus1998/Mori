import { describe, expect, test } from "bun:test";
import { createGatewayFetchHandler, type GatewayUsageEvent } from "@eco/gateway";
import { buildCodexGatewayModelAlias, type CodexThreadAttribution, resolveCodexContextSnapshot } from "@eco/runtime";
import { projectBillingFromUsageLedger } from "../src/main/billing-projector";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import {
  CodexGatewayUsageDeduplicator,
  resolveCodexGatewayUsageBilling,
} from "../src/main/codex-gateway-usage-billing";
import { CodexGatewayUsagePendingBuffer } from "../src/main/codex-gateway-usage-pending";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import { resolveSingleUsageBillingOrchestration } from "../src/main/single-usage-billing-orchestration";
import { InMemoryUsageLedger } from "../src/main/usage-ledger";

const provider: ProviderConfigSecret = {
  id: "provider_test",
  name: "Test Provider",
  baseUrl: "https://api.example.test",
  requestPath: "/v1/responses",
  version: "v1",
  apiCompat: "openai_responses",
  defaultModel: "gpt-test",
  enabled: true,
  hasApiKey: true,
  apiKeyPreview: "sk-...",
  apiKey: "sk-test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const routes: RuntimeRoute[] = [
  {
    role: "main",
    provider,
    modelId: "gpt-test",
    apiCompat: "openai_responses",
  },
];

function usageEvent(overrides: Partial<GatewayUsageEvent> = {}): GatewayUsageEvent {
  return {
    source: "responses",
    sourceEventId: "responses:provider_test:response:resp_1",
    providerId: "provider_test",
    requestedModel: buildCodexGatewayModelAlias("provider_test", "gpt-test", "openai_responses"),
    upstreamModelId: "gpt-test",
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      modelId: "gpt-test",
    },
    stream: true,
    observedAt: "2026-07-14T00:00:00.000Z",
    responseId: "resp_1",
    codexTurnMetadata: {
      threadId: "codex_root",
      turnId: "turn_1",
      requestKind: "turn",
    },
    ...overrides,
  };
}

function resolve(event: GatewayUsageEvent, attribution?: CodexThreadAttribution) {
  return resolveCodexGatewayUsageBilling({
    event,
    resolveThreadAttribution: () => attribution,
    resolveParentCodexThreadId: () => undefined,
    resolveRuntimeRoutes: () => routes,
    runAttemptId: () => "attempt_1",
    plannerAgentId: () => "planner_1",
  });
}

describe("Codex Gateway usage billing", () => {
  test("Anthropic cache corrections reach both Codex context and billed totals", async () => {
    const modelId = "claude-test";
    const alias = buildCodexGatewayModelAlias(provider.id, modelId, "anthropic");
    const runtimeRoutes: RuntimeRoute[] = [{
      role: "main",
      provider: { ...provider, apiCompat: "anthropic", defaultModel: modelId },
      modelId,
      apiCompat: "anthropic",
      manualSpec: { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 2.5 },
    }];
    const attribution: CodexThreadAttribution = { ecoThreadId: "thr_1", billingRole: "main" };
    const threadId = "codex-root";
    const turnId = "turn-cache-correction";
    const ledger = new InMemoryUsageLedger();
    const pendingBilling: Promise<void>[] = [];
    const gateway = createGatewayFetchHandler({
      host: "127.0.0.1",
      port: 0,
      providers: [{
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: "test-key",
        upstreamKind: "anthropic-messages",
        upstreamModelId: modelId,
        models: [modelId],
      }],
    }, async () => new Response([
      { type: "message_start", message: {
        id: "msg_cache_corrected",
        model: modelId,
        usage: { input_tokens: 28000, cache_read_input_tokens: 405793, output_tokens: 0 },
      } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {
        input_tokens: 1400,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 25000,
        output_tokens: 330,
      } },
      { type: "message_stop" },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    }), () => undefined, (event) => {
      const billingTask = (async () => {
        const resolved = resolveCodexGatewayUsageBilling({
          event,
          resolveThreadAttribution: (id) => id === threadId ? attribution : undefined,
          resolveParentCodexThreadId: () => undefined,
          resolveRuntimeRoutes: () => runtimeRoutes,
          plannerAgentId: () => "planner_1",
        });
        if (resolved.status !== "resolved") throw new Error(resolved.reason);
        const billing = await resolveSingleUsageBillingOrchestration({
          request: resolved.billingInput,
          runtimeRoutes,
          lookupPricing: async () => null,
        });
        if (!billing) throw new Error("The final provider usage did not reach billing.");
        ledger.appendUsageEvent(billing.effectsInput.artifacts.ledgerEvent);
      })();
      pendingBilling.push(billingTask);
      return billingTask;
    });
    const response = await gateway(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gateway-provider-id": provider.id,
        "x-gateway-requested-model": alias,
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId, request_kind: "turn" }),
      },
      body: JSON.stringify({ model: modelId, stream: true, input: JSON.stringify("Hi") }),
    }));
    const responseText = await response.text();
    const completion = responseText.split("\n").find((line) => line.startsWith('data: {"type":"response.completed"'));
    if (!completion) throw new Error(`Expected a Responses completion, got HTTP ${response.status}: ${responseText}`);
    const { usage } = JSON.parse(completion.slice("data: ".length)).response;
    const last = {
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage.output_tokens,
      reasoningOutputTokens: 0,
      totalTokens: usage.total_tokens,
    };
    const context = resolveCodexContextSnapshot({
      params: { threadId, turnId, tokenUsage: { last, total: last, modelContextWindow: 1_000_000 } },
      attribution,
    });
    await Promise.all(pendingBilling);
    const events = ledger.listUsageEvents(attribution.ecoThreadId);
    expect({
      ledgerRows: events.length,
      contextOccupied: context?.contextOccupied,
    }).toEqual({ ledgerRows: 1, contextOccupied: 26_730 });
    const { snapshot } = projectBillingFromUsageLedger({ events });
    expect(snapshot).toMatchObject({
      totalTokens: { input: 1400, output: 330, cacheRead: 0, cacheCreation: 25000 },
      pricingResolved: true,
    });
    expect(snapshot?.ecoCostUsd).toBeCloseTo(0.0686, 8);
  });

  test("resolves a root turn to the existing Codex ledger and pricing contract", () => {
    const result = resolve(usageEvent(), { ecoThreadId: "thr_1", billingRole: "main" });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result).toMatchObject({
      threadId: "thr_1",
      codexThreadId: "codex_root",
      turnId: "turn_1",
      billingRole: "main",
      routeRole: "main",
      contextOccupied: 140,
      observation: { source: "codex", role: "main" },
      billingInput: {
        threadId: "thr_1",
        source: "codex",
        role: "main",
        providerId: "provider_test",
        modelId: "gpt-test",
        runAttemptId: "attempt_1",
        plannerAgentId: "planner_1",
      },
    });
  });

  test("passthrough reasoningTokens from gateway usage event", () => {
    const result = resolve(
      usageEvent({
        usage: {
          inputTokens: 485,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 34,
          modelId: "gpt-test",
        },
      }),
      { ecoThreadId: "thr_1", billingRole: "main" },
    );

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.usage.reasoningTokens).toBe(34);
    expect(result.billingInput.usage.reasoningTokens).toBe(34);
  });

  test("resolves an untyped Codex child through equivalent shared-model pricing routes", () => {
    const sharedRoutes: RuntimeRoute[] = [
      {
        role: "main",
        provider,
        modelId: "gpt-test",
        apiCompat: "openai_responses",
        manualSpec: {
          maxOutputTokens: 128_000,
          inputPerM: 0.5,
          outputPerM: 3,
          cacheReadPerM: 0.05,
        },
      },
      {
        role: "vision",
        provider,
        modelId: "gpt-test",
        apiCompat: "openai_responses",
        manualSpec: {
          maxOutputTokens: 1_600,
          inputPerM: 0.5,
          outputPerM: 3,
          cacheReadPerM: 0.05,
        },
      },
    ];
    const result = resolveCodexGatewayUsageBilling({
      event: usageEvent({
        codexTurnMetadata: {
          threadId: "codex_child",
          parentThreadId: "codex_root",
          turnId: "turn_child",
          requestKind: "turn",
        },
      }),
      resolveThreadAttribution: () => ({
        ecoThreadId: "thr_1",
        billingRole: "general",
        isSubagentThread: true,
        agentId: "codex_child",
      }),
      resolveParentCodexThreadId: () => "codex_root",
      resolveRuntimeRoutes: () => sharedRoutes,
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result).toMatchObject({
      billingRole: "general",
      routeRole: "main",
      subagentAgentId: "codex_child",
      billingInput: {
        role: "general",
        routeRole: "main",
        agentId: "codex_child",
      },
    });
  });

  test("keeps shared-model routes ambiguous when their pricing inputs differ", () => {
    const baseRoute = routes[0];
    if (!baseRoute) {
      throw new Error("Expected the test pricing route.");
    }
    const result = resolveCodexGatewayUsageBilling({
      event: usageEvent({
        codexTurnMetadata: {
          threadId: "codex_child",
          parentThreadId: "codex_root",
          turnId: "turn_child",
          requestKind: "turn",
        },
      }),
      resolveThreadAttribution: () => ({
        ecoThreadId: "thr_1",
        billingRole: "general",
        isSubagentThread: true,
        agentId: "codex_child",
      }),
      resolveParentCodexThreadId: () => "codex_root",
      resolveRuntimeRoutes: () => [
        { ...baseRoute, role: "explore", manualSpec: { inputPerM: 0.25, outputPerM: 0.5 } },
        { ...baseRoute, role: "coder", manualSpec: { inputPerM: 0.5, outputPerM: 1 } },
      ],
    });

    expect(result).toMatchObject({
      status: "rejected",
      reason: "ambiguous_route",
      matchedRouteCount: 2,
    });
  });

  test("rejects usage until persisted thread attribution exists", () => {
    expect(resolve(usageEvent())).toEqual({
      status: "rejected",
      reason: "thread_attribution_not_found",
      codexThreadId: "codex_root",
      turnId: "turn_1",
    });
  });

  test("attributes out-of-run compaction usage to the thread-scoped Codex planner", () => {
    const event = usageEvent({
      codexTurnMetadata: {
        threadId: "codex_root",
        turnId: "compact_1",
        requestKind: "compaction",
      },
    });
    const result = resolveCodexGatewayUsageBilling({
      event,
      resolveThreadAttribution: () => ({ ecoThreadId: "thr_1", billingRole: "main" }),
      resolveParentCodexThreadId: () => undefined,
      resolveRuntimeRoutes: () => routes,
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.billingInput).toMatchObject({
      plannerAgentId: "main:codex-control:thr_1",
      updateContext: false,
    });
  });

  test("rejects child attribution when the declared parent is not persisted", () => {
    const event = usageEvent({
      codexTurnMetadata: {
        threadId: "codex_child",
        turnId: "turn_child",
        parentThreadId: "codex_root",
        requestKind: "turn",
      },
    });
    const result = resolveCodexGatewayUsageBilling({
      event,
      resolveThreadAttribution: () => ({
        ecoThreadId: "thr_1",
        billingRole: "coder",
        isSubagentThread: true,
        agentId: "codex_child",
      }),
      resolveParentCodexThreadId: () => undefined,
      resolveRuntimeRoutes: () => routes,
    });

    expect(result).toMatchObject({ status: "rejected", reason: "thread_attribution_mismatch" });
  });

  test("buffers the first-turn race and drains only the matching Codex thread", () => {
    let now = 1_000;
    const dropped: string[] = [];
    const pending = new CodexGatewayUsagePendingBuffer({
      ttlMs: 100,
      maxEvents: 4,
      now: () => now,
      onDrop: (drop) => dropped.push(drop.reason),
    });
    const root = usageEvent();
    const other = usageEvent({
      sourceEventId: "responses:provider_test:response:resp_2",
      codexTurnMetadata: { threadId: "codex_other", turnId: "turn_2", requestKind: "turn" },
    });

    expect(pending.enqueue(root).status).toBe("queued");
    expect(pending.enqueue(other).status).toBe("queued");
    expect(pending.drain("codex_root").map((entry) => entry.event)).toEqual([root]);
    expect(pending.size).toBe(1);
    now = 1_101;
    expect(pending.pruneExpired()).toBe(1);
    expect(dropped).toEqual(["expired"]);
    pending.dispose();
  });

  test("deduplicates identical events and surfaces changed payloads", () => {
    const deduplicator = new CodexGatewayUsageDeduplicator();
    const input = {
      requestKey: "codex-gateway:request_1",
      usage: usageEvent().usage,
    };
    expect(deduplicator.observe(input)).toEqual({ status: "accepted" });
    expect(deduplicator.observe(input)).toEqual({ status: "duplicate" });
    expect(
      deduplicator.observe({
        ...input,
        usage: { ...input.usage, outputTokens: input.usage.outputTokens + 1 },
      }),
    ).toEqual({ status: "conflict", reason: "usage_payload_mismatch" });
    deduplicator.forget(input.requestKey);
    expect(deduplicator.observe(input)).toEqual({ status: "accepted" });
  });
});
