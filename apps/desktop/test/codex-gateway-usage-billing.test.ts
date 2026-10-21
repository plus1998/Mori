import { describe, expect, test } from "bun:test";
import type { GatewayUsageEvent } from "@eco/gateway";
import { buildCodexGatewayModelAlias, type CodexThreadAttribution } from "@eco/runtime";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import {
  CodexGatewayUsageDeduplicator,
  resolveCodexGatewayUsageBilling,
} from "../src/main/codex-gateway-usage-billing";
import { CodexGatewayUsagePendingBuffer } from "../src/main/codex-gateway-usage-pending";
import type { ProviderConfigSecret } from "../src/main/provider-store";

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
