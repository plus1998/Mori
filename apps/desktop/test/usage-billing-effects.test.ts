import { expect, test } from "bun:test";
import type { ModelPricingLookup, ParsedUsage } from "@eco/runtime";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import type { SubagentMetricsPersistenceStore } from "../src/main/subagent-metrics-persistence";
import type { ThreadBillingSnapshot } from "../src/shared/ipc";
import { SubagentMetricsRegistry } from "../src/main/subagent-metrics-registry";
import { ThreadUsageAccumulator } from "../src/main/thread-usage-accumulator";
import {
  resolveSdkRunBillingModels,
  resolveSdkStreamPartialBillingArtifacts,
  resolveSingleUsageBillingArtifacts,
  type UsageBillingPricingRoute,
} from "../src/main/usage-billing-artifacts";
import {
  applySdkRunBillingEffects,
  applySdkStreamPartialBillingEffects,
  applySingleUsageBillingEffects,
  type UsageBillingEffectsServices,
  type UsageBillingUpdatedEvent,
} from "../src/main/usage-billing-effects";
import { createUsageContextService } from "../src/main/usage-context-effects";
import {
  type AgentInstanceRecord,
  InMemoryUsageLedger,
  type UsageLedgerEvent,
} from "../src/main/usage-ledger";
import {
  UsageLedgerCoordinator,
  type UsageLedgerCoordinatorStore,
} from "../src/main/usage-ledger-coordinator";

const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const haikuRates = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };

function usage(inputTokens = 10_000): ParsedUsage {
  return { inputTokens, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function stubBillingSnapshot(primarySource: "proxy" | "sdk"): ThreadBillingSnapshot {
  return {
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    sourceReportedCostUsd: 0,
    plannerTokenCostUsd: 0,
    ecoCostUsd: 0,
    savedUsd: 0,
    savedPct: 0,
    pricingResolved: true,
    primarySource,
  };
}

const provider: ProviderConfigSecret = {
  id: "provider_test",
  name: "Test Provider",
  baseUrl: "https://api.example.test",
  requestPath: "/v1/messages",
  version: "v1",
  apiCompat: "anthropic",
  defaultModel: "sonnet",
  enabled: true,
  hasApiKey: true,
  apiKeyPreview: "sk-...",
  apiKey: "sk-test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const routes: RuntimeRoute[] = [
  { role: "main", provider, modelId: "sonnet", apiCompat: "anthropic" },
  { role: "coder", provider, modelId: "haiku", apiCompat: "anthropic" },
];

const metricsStoreStub: SubagentMetricsPersistenceStore = {
  listSubagentMetrics: () => [],
  upsertSubagentMetrics: () => {},
  clearSubagentMetrics: () => {},
};

async function lookupPricing(route: UsageBillingPricingRoute): Promise<ModelPricingLookup> {
  return {
    providerKey: "test",
    modelId: route.modelId,
    rates: route.modelId === "haiku" ? haikuRates : sonnetRates,
    displayName: route.modelId === "haiku" ? "Claude Haiku" : "Claude Sonnet",
  };
}

function createLedgerCoordinator() {
  const ledger = new InMemoryUsageLedger();
  const store: UsageLedgerCoordinatorStore = {
    appendUsageLedgerEvent(event: UsageLedgerEvent) {
      return ledger.appendUsageEvent(event).inserted;
    },
    listUsageLedgerEvents(threadId: string) {
      return ledger.listUsageEvents(threadId);
    },
    listAgentInstances(threadId: string): AgentInstanceRecord[] {
      return ledger.listAgentInstances(threadId);
    },
    updateUsageLedgerEventAttribution(eventId, update) {
      return Boolean(ledger.updateUsageEventAttribution(eventId, update));
    },
  };
  const coordinator = new UsageLedgerCoordinator({
    store,
    metrics: {
      listEntries: () => [],
    },
    writeError: (message) => {
      throw new Error(message);
    },
  });
  return { ledger, coordinator };
}

test("applySingleUsageBillingEffects applies ledger context accumulator metrics and event side effects", async () => {
  const contextObservationCalls: Array<
    Parameters<UsageBillingEffectsServices["subagentMetrics"]["recordContextObservation"]>[1]
  > = [];
  const legacySubagentUsageCalls: Array<
    Parameters<UsageBillingEffectsServices["subagentMetrics"]["recordSdkUsage"]>[1]
  > = [];
  const subagentMetrics: UsageBillingEffectsServices["subagentMetrics"] = {
    recordContextObservation: (_threadId, input) => {
      contextObservationCalls.push(input);
      return undefined;
    },
    recordSdkUsage: (_threadId, input) => {
      legacySubagentUsageCalls.push(input);
      return undefined;
    },
  };
  const { ledger, coordinator } = createLedgerCoordinator();
  const contextUpdates: Array<{ threadId: string; usage: ParsedUsage; options: unknown }> = [];
  const emitted: UsageBillingUpdatedEvent[] = [];
  const persisted: string[] = [];
  const liveContext: string[] = [];
  const services: UsageBillingEffectsServices = {
    context: createUsageContextService({
      monitor: {
        async updateFromUsage(threadId, nextUsage, options) {
          contextUpdates.push({ threadId, usage: nextUsage, options });
        },
        async updateOccupied() {
          return undefined;
        },
        getSnapshot: () => undefined,
      },
      emitLiveContext: (threadId) => liveContext.push(threadId),
    }),
    usageLedger: coordinator,
    accumulator: new ThreadUsageAccumulator(),
    subagentMetrics,
    emitUsageUpdated: (event) => emitted.push(event),
    schedulePersistThreadMetrics: (threadId) => persisted.push(threadId),
  };
  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_effects",
    role: "coder",
    source: "proxy",
    usage: usage(),
    runtimeRoutes: routes,
    lookupPricing,
    agentId: "agent_coder",
    modelId: "haiku",
    requestKey: "proxy:coder:req_1",
  });

  const billing = await applySingleUsageBillingEffects(services, {
    threadId: "thr_effects",
    artifacts,
    updateContext: true,
    agentId: "agent_coder",
    reconciliationOnly: true,
    fillSdkPrimaryForSubagent: true,
  });

  expect(ledger.listUsageEvents("thr_effects")).toHaveLength(1);
  expect(contextUpdates).toHaveLength(1);
  expect(contextObservationCalls).toHaveLength(1);
  expect(contextObservationCalls[0]).toMatchObject({
    role: "coder",
    agentId: "agent_coder",
    requestKey: "proxy:coder:req_1",
    modelId: "haiku",
  });
  expect(legacySubagentUsageCalls).toHaveLength(0);
  expect(billing.primarySource).toBe("proxy");
  expect(billing.sourceBreakdown?.proxy).toBeDefined();
  expect(billing.sourceBreakdown?.sdk).toBeUndefined();
  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.payload.billing.primarySource).toBe("proxy");
  expect(persisted).toEqual(["thr_effects"]);
  expect(liveContext).toEqual(["thr_effects"]);
});

test("applySingleUsageBillingEffects requests verified ledger projection by default", async () => {
  const selectionOptions: Array<{ plannerModelLabel?: string }> = [];
  const emitted: UsageBillingUpdatedEvent[] = [];
  const services: UsageBillingEffectsServices = {
    context: createUsageContextService({
      monitor: {
        async updateFromUsage() {
          return undefined;
        },
        async updateOccupied() {
          return undefined;
        },
        getSnapshot: () => undefined,
      },
      emitLiveContext: () => undefined,
    }),
    usageLedger: {
      appendEvents: () => undefined,
      resolveV2BillingSnapshot: (_threadId, plannerModelLabel) => {
        selectionOptions.push({ ...(plannerModelLabel ? { plannerModelLabel } : {}) });
        return {
          ...stubBillingSnapshot("sdk"),
          ...(plannerModelLabel ? { plannerModelLabel } : {}),
        };
      },
      reconcileShadow: () => undefined,
    },
    accumulator: new ThreadUsageAccumulator(),
    subagentMetrics: {
      recordContextObservation: () => undefined,
      recordSdkUsage: () => undefined,
    },
    emitUsageUpdated: (event) => emitted.push(event),
    schedulePersistThreadMetrics: () => undefined,
  };
  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_effects_selection",
    role: "main",
    source: "sdk",
    usage: usage(),
    runtimeRoutes: routes,
    lookupPricing,
    requestKey: "sdk:main:req_1",
  });

  await applySingleUsageBillingEffects(services, {
    threadId: "thr_effects_selection",
    artifacts,
    updateContext: false,
  });

  expect(selectionOptions).toEqual([
    {
      plannerModelLabel: "Claude Sonnet · Test Provider",
    },
  ]);
  expect(emitted[0]?.payload.billing.primarySource).toBe("sdk");
});

test("applySdkStreamPartialBillingEffects records partial ledger and context side effects only", async () => {
  const { ledger, coordinator } = createLedgerCoordinator();
  const contextUpdates: Array<{ threadId: string; usage: ParsedUsage; options: unknown }> = [];
  const liveContext: string[] = [];
  const accumulator: UsageBillingEffectsServices["accumulator"] = {
    recordUsage: () => {
      throw new Error("stream partial must not update legacy single usage");
    },
    recordRunUsage: () => {
      throw new Error("stream partial must not update legacy run usage");
    },
    hasSeenRequestKey: () => {
      throw new Error("stream partial must not inspect legacy request keys");
    },
  };
  const services: UsageBillingEffectsServices = {
    context: createUsageContextService({
      monitor: {
        async updateFromUsage(threadId, nextUsage, options) {
          contextUpdates.push({ threadId, usage: nextUsage, options });
        },
        async updateOccupied() {
          return undefined;
        },
        getSnapshot: () => undefined,
      },
      emitLiveContext: (threadId) => liveContext.push(threadId),
    }),
    usageLedger: coordinator,
    accumulator,
    subagentMetrics: {
      recordContextObservation: () => {
        throw new Error("stream partial must not update subagent context metrics");
      },
      recordSdkUsage: () => {
        throw new Error("stream partial must not update subagent billing metrics");
      },
    },
    emitUsageUpdated: () => {
      throw new Error("stream partial must not emit usage_updated");
    },
    schedulePersistThreadMetrics: () => {
      throw new Error("stream partial must not persist thread metrics");
    },
  };
  const artifacts = await resolveSdkStreamPartialBillingArtifacts({
    threadId: "thr_stream_effects",
    eventId: "evt_stream",
    role: "coder",
    usage: usage(1_000),
    modelId: "haiku",
    runtimeRoutes: routes,
    lookupPricing,
    runAttemptId: "attempt_1",
    subagentAgentId: "agent_coder",
  });

  await applySdkStreamPartialBillingEffects(services, {
    threadId: "thr_stream_effects",
    usage: usage(1_000),
    artifacts,
    subagentAgentId: "agent_coder",
  });

  expect(ledger.listUsageEvents("thr_stream_effects")).toHaveLength(1);
  expect(ledger.listUsageEvents("thr_stream_effects")[0]).toMatchObject({
    source: "sdk",
    usageKind: "request_partial",
    runAttemptId: "attempt_1",
    agentId: "agent_coder",
  });
  expect(contextUpdates).toHaveLength(1);
  expect(contextUpdates[0]?.options).toMatchObject({
    role: "coder",
    agentId: "agent_coder",
    modelId: "haiku",
    providerBaseUrl: "https://api.example.test",
  });
  expect(liveContext).toEqual(["thr_stream_effects"]);

  const noContextArtifacts = await resolveSdkStreamPartialBillingArtifacts({
    threadId: "thr_stream_audit_only",
    eventId: "evt_no_route",
    role: "coder",
    usage: usage(500),
    modelId: "unknown-model",
    runtimeRoutes: [],
    lookupPricing,
  });
  await applySdkStreamPartialBillingEffects(services, {
    threadId: "thr_stream_audit_only",
    usage: usage(500),
    artifacts: noContextArtifacts,
  });

  expect(ledger.listUsageEvents("thr_stream_audit_only")).toHaveLength(1);
  expect(contextUpdates).toHaveLength(1);
  expect(liveContext).toEqual(["thr_stream_effects"]);
});

test("applySdkRunBillingEffects applies SDK final side effects", async () => {
  const contextObservationCalls: Array<
    Parameters<UsageBillingEffectsServices["subagentMetrics"]["recordContextObservation"]>[1]
  > = [];
  const legacySubagentUsageCalls: Array<
    Parameters<UsageBillingEffectsServices["subagentMetrics"]["recordSdkUsage"]>[1]
  > = [];
  const subagentMetrics: UsageBillingEffectsServices["subagentMetrics"] = {
    recordContextObservation: (_threadId, input) => {
      contextObservationCalls.push(input);
      return undefined;
    },
    recordSdkUsage: (_threadId, input) => {
      legacySubagentUsageCalls.push(input);
      return undefined;
    },
  };
  const { ledger, coordinator } = createLedgerCoordinator();
  const contextUpdates: Array<{ threadId: string; usage: ParsedUsage; options: unknown }> = [];
  const emitted: UsageBillingUpdatedEvent[] = [];
  const services: UsageBillingEffectsServices = {
    context: createUsageContextService({
      monitor: {
        async updateFromUsage(threadId, nextUsage, options) {
          contextUpdates.push({ threadId, usage: nextUsage, options });
        },
        async updateOccupied() {
          return undefined;
        },
        getSnapshot: () => undefined,
      },
      emitLiveContext: () => undefined,
    }),
    usageLedger: coordinator,
    accumulator: new ThreadUsageAccumulator(),
    subagentMetrics,
    emitUsageUpdated: (event) => emitted.push(event),
    schedulePersistThreadMetrics: () => undefined,
  };
  const billingModels = await resolveSdkRunBillingModels({
    role: "coder",
    models: [{ modelId: "haiku", usage: usage(2_000), sdkCostUsd: 0.01 }],
    runtimeRoutes: routes,
    lookupPricing,
  });

  const billing = await applySdkRunBillingEffects(services, {
    threadId: "thr_sdk_effects",
    role: "coder",
    requestKey: "sdk-result:event_1",
    models: billingModels.models,
    billingRole: "coder",
    contextUsage: usage(2_000),
    updateContext: true,
    totalCostUsd: 0.01,
    ...(billingModels.plannerModelLabel && { plannerModelLabel: billingModels.plannerModelLabel }),
    runAttemptId: "attempt_1",
    ledgerAgentId: "agent_coder",
    resolvedSubagentId: "agent_coder",
    contextUpdate: {
      role: "coder",
      modelId: "haiku",
      providerBaseUrl: "https://api.example.test",
    },
  });

  const sdkLedgerEvents = ledger.listUsageEvents("thr_sdk_effects");
  expect(sdkLedgerEvents).toHaveLength(1);
  expect(sdkLedgerEvents[0]).toMatchObject({
    source: "sdk",
    usageKind: "request_final",
    runAttemptId: "attempt_1",
    agentId: "agent_coder",
  });
  expect(contextUpdates).toHaveLength(1);
  expect(contextObservationCalls).toHaveLength(1);
  expect(contextObservationCalls[0]).toMatchObject({
    role: "coder",
    agentId: "agent_coder",
    requestKey: "sdk-result:event_1",
    modelId: "haiku",
  });
  expect(legacySubagentUsageCalls).toHaveLength(0);
  expect(billing.primarySource).toBe("sdk");
  expect(billing.sourceReportedCostUsd).toBe(0.01);
  expect(emitted[0]?.payload.billing.primarySource).toBe("sdk");
  expect(emitted[0]?.payload.modelId).toBe("haiku");
});

test("applySdkRunBillingEffects requests verified ledger projection by default", async () => {
  const selectionOptions: Array<{ plannerModelLabel?: string }> = [];
  const services: UsageBillingEffectsServices = {
    context: createUsageContextService({
      monitor: {
        async updateFromUsage() {
          return undefined;
        },
        async updateOccupied() {
          return undefined;
        },
        getSnapshot: () => undefined,
      },
      emitLiveContext: () => undefined,
    }),
    usageLedger: {
      appendEvents: () => undefined,
      resolveV2BillingSnapshot: (_threadId, plannerModelLabel) => {
        selectionOptions.push({ ...(plannerModelLabel ? { plannerModelLabel } : {}) });
        return {
          ...stubBillingSnapshot("sdk"),
          ...(plannerModelLabel ? { plannerModelLabel } : {}),
        };
      },
      reconcileShadow: () => undefined,
    },
    accumulator: new ThreadUsageAccumulator(),
    subagentMetrics: {
      recordContextObservation: () => undefined,
      recordSdkUsage: () => undefined,
    },
    emitUsageUpdated: () => undefined,
    schedulePersistThreadMetrics: () => undefined,
  };
  const billingModels = await resolveSdkRunBillingModels({
    role: "main",
    models: [{ modelId: "sonnet", usage: usage(3_000), sdkCostUsd: 0.02 }],
    runtimeRoutes: routes,
    lookupPricing,
  });

  await applySdkRunBillingEffects(services, {
    threadId: "thr_sdk_effects_selection",
    role: "main",
    requestKey: "sdk-result:event_selection",
    models: billingModels.models,
    billingRole: "main",
    contextUsage: usage(3_000),
    updateContext: true,
    totalCostUsd: 0.02,
    ...(billingModels.plannerModelLabel && { plannerModelLabel: billingModels.plannerModelLabel }),
    runAttemptId: "attempt_selection",
    ledgerAgentId: "agent_planner",
  });

  expect(selectionOptions).toEqual([
    {
      plannerModelLabel: "Claude Sonnet · Test Provider",
    },
  ]);
});

test("applySingleUsageBillingEffects fails closed when the V2 ledger projection is unavailable", async () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const legacySubagentUsageCalls: Array<
    Parameters<UsageBillingEffectsServices["subagentMetrics"]["recordSdkUsage"]>
  > = [];
  const threadId = "thr_effects_no_legacy_subagent_backfill";
  registry.onSubagentStart(threadId, { agentId: "agent_coder", role: "coder" });
  const coordinator = new UsageLedgerCoordinator({
    store: {
      appendUsageLedgerEvent: () => false,
      listUsageLedgerEvents: () => [],
      listAgentInstances: () => [],
    },
    metrics: {
      listEntries: (id) => registry.listEntries(id),
    },
    writeError: (message) => {
      throw new Error(message);
    },
  });
  const services: UsageBillingEffectsServices = {
    context: createUsageContextService({
      monitor: {
        async updateFromUsage() {
          return undefined;
        },
        async updateOccupied() {
          return undefined;
        },
        getSnapshot: () => undefined,
      },
      emitLiveContext: () => undefined,
    }),
    usageLedger: coordinator,
    accumulator: new ThreadUsageAccumulator(),
    subagentMetrics: {
      recordContextObservation: (id, input) => registry.recordContextObservation(id, input),
      recordSdkUsage: (...args) => {
        legacySubagentUsageCalls.push(args);
        return registry.recordSdkUsage(...args);
      },
    },
    emitUsageUpdated: () => undefined,
    schedulePersistThreadMetrics: () => undefined,
  };
  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId,
    role: "coder",
    source: "proxy",
    usage: usage(),
    runtimeRoutes: routes,
    lookupPricing,
    agentId: "agent_coder",
    requestKey: "proxy:coder:req_no_backfill",
  });

  await expect(
    applySingleUsageBillingEffects(services, {
      threadId,
      artifacts,
      updateContext: true,
      agentId: "agent_coder",
    }),
  ).rejects.toThrow("V2 usage ledger billing projection is unavailable");

  const [entry] = registry.listEntries(threadId);
  expect(legacySubagentUsageCalls).toHaveLength(0);
  expect(entry?.usage.inputTokens).toBe(0);
  expect(entry?.ecoCostUsd).toBe(0);
});

test("applySingleUsageBillingEffects persists authoritative ledger subagent metrics", async () => {
  const persistedRows: Array<{
    inputTokens: number;
    contextOccupied: number;
    ecoCostUsd: number;
  }> = [];
  const registry = new SubagentMetricsRegistry({
    listSubagentMetrics: () => [],
    upsertSubagentMetrics: (_threadId, input) => {
      persistedRows.push({
        inputTokens: input.inputTokens,
        contextOccupied: input.contextOccupied,
        ecoCostUsd: input.ecoCostUsd,
      });
    },
    clearSubagentMetrics: () => undefined,
  });
  const threadId = "thr_effects_projected_persistence";
  registry.onSubagentStart(threadId, { agentId: "agent_coder", role: "coder" });
  const ledger = new InMemoryUsageLedger();
  ledger.upsertAgentInstance({
    threadId,
    agentId: "agent_coder",
    role: "coder",
    kind: "subagent",
    status: "active",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const coordinator = new UsageLedgerCoordinator({
    store: {
      appendUsageLedgerEvent: (event) => ledger.appendUsageEvent(event).inserted,
      listUsageLedgerEvents: (id) => ledger.listUsageEvents(id),
      listAgentInstances: (id) => ledger.listAgentInstances(id),
    },
    metrics: registry,
  });
  const services: UsageBillingEffectsServices = {
    context: createUsageContextService({
      monitor: {
        async updateFromUsage() {
          return undefined;
        },
        async updateOccupied() {
          return undefined;
        },
        getSnapshot: () => undefined,
      },
      emitLiveContext: () => undefined,
    }),
    usageLedger: coordinator,
    accumulator: new ThreadUsageAccumulator(),
    subagentMetrics: registry,
    emitUsageUpdated: () => undefined,
    schedulePersistThreadMetrics: () => undefined,
  };
  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId,
    role: "coder",
    source: "proxy",
    usage: usage(),
    runtimeRoutes: routes,
    lookupPricing,
    agentId: "agent_coder",
    modelId: "haiku",
    requestKey: "proxy:coder:projected-persistence",
  });

  await applySingleUsageBillingEffects(services, {
    threadId,
    artifacts,
    updateContext: true,
    agentId: "agent_coder",
  });

  expect(persistedRows.at(-1)).toMatchObject({
    inputTokens: 10_000,
    contextOccupied: 10_000,
  });
  expect(persistedRows.at(-1)?.ecoCostUsd).toBeGreaterThan(0);
});

test("applySdkRunBillingEffects fails closed when the V2 ledger projection is unavailable", async () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const legacySubagentUsageCalls: Array<
    Parameters<UsageBillingEffectsServices["subagentMetrics"]["recordSdkUsage"]>
  > = [];
  const threadId = "thr_sdk_effects_no_legacy_subagent_backfill";
  registry.onSubagentStart(threadId, { agentId: "agent_coder", role: "coder" });
  const coordinator = new UsageLedgerCoordinator({
    store: {
      appendUsageLedgerEvent: () => false,
      listUsageLedgerEvents: () => [],
      listAgentInstances: () => [],
    },
    metrics: {
      listEntries: (id) => registry.listEntries(id),
    },
    writeError: (message) => {
      throw new Error(message);
    },
  });
  const services: UsageBillingEffectsServices = {
    context: createUsageContextService({
      monitor: {
        async updateFromUsage() {
          return undefined;
        },
        async updateOccupied() {
          return undefined;
        },
        getSnapshot: () => undefined,
      },
      emitLiveContext: () => undefined,
    }),
    usageLedger: coordinator,
    accumulator: new ThreadUsageAccumulator(),
    subagentMetrics: {
      recordContextObservation: (id, input) => registry.recordContextObservation(id, input),
      recordSdkUsage: (...args) => {
        legacySubagentUsageCalls.push(args);
        return registry.recordSdkUsage(...args);
      },
    },
    emitUsageUpdated: () => undefined,
    schedulePersistThreadMetrics: () => undefined,
  };
  const billingModels = await resolveSdkRunBillingModels({
    role: "coder",
    models: [
      { modelId: "haiku", usage: usage(1_000), sdkCostUsd: 0.01 },
      { modelId: "reviewer-haiku", usage: usage(500), sdkCostUsd: 0.02 },
    ],
    runtimeRoutes: [
      ...routes,
      { role: "reviewer", provider, modelId: "reviewer-haiku", apiCompat: "anthropic" },
    ],
    lookupPricing,
  });

  await expect(
    applySdkRunBillingEffects(services, {
      threadId,
      role: "coder",
      requestKey: "sdk-result:event_no_backfill",
      models: billingModels.models,
      billingRole: "coder",
      contextUsage: usage(1_500),
      updateContext: true,
      totalCostUsd: 0.03,
      ...(billingModels.plannerModelLabel && { plannerModelLabel: billingModels.plannerModelLabel }),
      runAttemptId: "attempt_no_backfill",
      ledgerAgentId: "agent_coder",
      resolvedSubagentId: "agent_coder",
    }),
  ).rejects.toThrow("V2 usage ledger billing projection is unavailable");

  const [entry] = registry.listEntries(threadId);
  expect(legacySubagentUsageCalls).toHaveLength(0);
  expect(entry?.usage.inputTokens).toBe(0);
  expect(entry?.usage.outputTokens).toBe(0);
  expect(entry?.ecoCostUsd).toBe(0);
});

test("applySingleUsageBillingEffects keeps unresolved proxy context out of role-level snapshots", async () => {
  const { ledger, coordinator } = createLedgerCoordinator();
  const contextUpdates: Array<{ threadId: string; usage: ParsedUsage; options: unknown }> = [];
  const contextObservations: unknown[] = [];
  const services: UsageBillingEffectsServices = {
    context: createUsageContextService({
      monitor: {
        async updateFromUsage(threadId, nextUsage, options) {
          contextUpdates.push({ threadId, usage: nextUsage, options });
        },
        async updateOccupied() {
          return undefined;
        },
        getSnapshot: () => undefined,
      },
      emitLiveContext: () => undefined,
    }),
    usageLedger: coordinator,
    accumulator: new ThreadUsageAccumulator(),
    subagentMetrics: {
      recordContextObservation: (_threadId, input) => {
        contextObservations.push(input);
        return undefined;
      },
      recordSdkUsage: () => undefined,
    },
    emitUsageUpdated: () => undefined,
    schedulePersistThreadMetrics: () => undefined,
  };
  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_pending_context",
    role: "coder",
    source: "proxy",
    usage: usage(12_000),
    runtimeRoutes: routes,
    lookupPricing,
    modelId: "haiku",
    messageId: "msg_pending_context",
    requestKey: "proxy:coder:pending-context",
    attributionPending: true,
  });

  await applySingleUsageBillingEffects(services, {
    threadId: "thr_pending_context",
    artifacts,
    updateContext: true,
    messageId: "msg_pending_context",
    reconciliationOnly: true,
  });

  expect(ledger.listUsageEvents("thr_pending_context")[0]).toMatchObject({
    sdkMessageId: "msg_pending_context",
    attribution: { status: "pending" },
  });
  expect(contextUpdates).toHaveLength(0);
  expect(contextObservations).toHaveLength(0);
});
