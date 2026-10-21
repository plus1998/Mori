import { expect, test } from "bun:test";
import type { ParsedUsage } from "@eco/runtime";
import { projectBillingFromUsageLedger } from "../src/main/billing-projector";
import { resolveProxyUsageBilling } from "../src/main/proxy-usage-billing";
import type { SubagentMetricsPersistenceStore } from "../src/main/subagent-metrics-persistence";
import { SubagentMetricsRegistry } from "../src/main/subagent-metrics-registry";
import { resolveSingleUsageBillingArtifacts } from "../src/main/usage-billing-artifacts";
import {
  type AgentInstanceRecord,
  InMemoryUsageLedger,
  type UsageLedgerEvent,
} from "../src/main/usage-ledger";
import {
  UsageLedgerCoordinator,
  type UsageLedgerCoordinatorStore,
} from "../src/main/usage-ledger-coordinator";
import { buildThreadUsageLedgerEventView } from "../src/main/usage-ledger-view";
import { verifyBillingAccounting } from "../src/shared/billing-accounting-verify";

const metricsStoreStub: SubagentMetricsPersistenceStore = {
  listSubagentMetrics: () => [],
  upsertSubagentMetrics: () => {},
  clearSubagentMetrics: () => {},
};

const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const haikuRates = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };

const provider = {
  id: "provider_test",
  name: "Test Provider",
  baseUrl: "https://api.example.test",
  apiKey: "test-key",
};

const routes = [
  { role: "main" as const, provider, modelId: "sonnet", apiCompat: "anthropic" as const },
  { role: "coder" as const, provider, modelId: "haiku", apiCompat: "anthropic" as const },
];

function lookupPricing(role: string) {
  return Promise.resolve({
    displayName: role,
    rates: role === "main" ? sonnetRates : haikuRates,
  });
}

function usage(inputTokens = 10_000): ParsedUsage {
  return { inputTokens, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

async function appendProxyUsage(
  coordinator: UsageLedgerCoordinator,
  threadId: string,
  role: "main" | "coder",
  modelId: string,
  requestId: string,
  inputTokens: number,
) {
  const resolved = resolveProxyUsageBilling({
    info: {
      threadId,
      role,
      providerId: "provider",
      providerName: "Provider",
      providerBaseUrl: "https://api.example.test",
      modelId,
      apiCompat: "anthropic",
      requestId,
      usage: usage(inputTokens),
    },
    resolver: new SubagentMetricsRegistry(metricsStoreStub),
  });
  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId,
    role: resolved.billingRole,
    source: "proxy",
    usage: usage(inputTokens),
    runtimeRoutes: routes,
    lookupPricing,
    requestKey: resolved.requestKey,
    sourceEventId: resolved.requestKey,
    modelId,
    routeRole: resolved.billingInput.routeRole,
    ...(resolved.attributionPending && { attributionPending: true }),
  });
  coordinator.appendEvents([artifacts.ledgerEvent]);
}

function createCoordinatorStore(ledger: InMemoryUsageLedger): UsageLedgerCoordinatorStore {
  return {
    appendUsageLedgerEvent(event: UsageLedgerEvent) {
      return ledger.appendUsageEvent(event).inserted;
    },
    listUsageLedgerEvents(threadId: string) {
      return ledger.listUsageEvents(threadId);
    },
    listAgentInstances(_threadId: string): AgentInstanceRecord[] {
      return [];
    },
    updateUsageLedgerEventAttribution(eventId, update) {
      return Boolean(ledger.updateUsageEventAttribution(eventId, update));
    },
  };
}

test("verifyBillingAccounting: proxy planner+coder events match snapshot and breakdown", async () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const ledger = new InMemoryUsageLedger();
  const coordinator = new UsageLedgerCoordinator({
    store: createCoordinatorStore(ledger),
    metrics: registry,
  });
  const threadId = "thr_accounting";

  await appendProxyUsage(coordinator, threadId, "main", "sonnet", "req_planner", 12_000);
  await appendProxyUsage(coordinator, threadId, "coder", "haiku", "req_coder", 8_000);

  const billing = coordinator.projectBillingSnapshot(threadId);
  expect(billing).toBeDefined();
  const events = coordinator.listUsageLedgerEventViews(threadId);
  const report = verifyBillingAccounting({ billing: billing!, events });
  expect(report.ok).toBe(true);
  expect(report.issues).toEqual([]);
  expect(report.eventSums.primary).toBe(report.snapshot.totalTokens);
  expect(report.breakdown.byModelTokens).toBe(report.snapshot.totalTokens);
});

test("verifyBillingAccounting: pending events still count in primary totals", async () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const ledger = new InMemoryUsageLedger();
  const coordinator = new UsageLedgerCoordinator({
    store: createCoordinatorStore(ledger),
    metrics: registry,
  });
  const threadId = "thr_accounting_pending";

  await appendProxyUsage(coordinator, threadId, "coder", "haiku", "req_pending", 5_000);

  const billing = coordinator.projectBillingSnapshot(threadId);
  expect(billing).toBeDefined();
  const events = coordinator.listUsageLedgerEventViews(threadId);
  const report = verifyBillingAccounting({ billing: billing!, events });
  expect(report.eventSums.pending).toBe(6_000);
  expect(report.ok).toBe(true);
});

test("verifyBillingAccounting: direct projector path matches event sum", () => {
  const ledger = new InMemoryUsageLedger();
  const threadId = "thr_direct";
  const event = ledger.appendUsageEvent({
    threadId,
    source: "proxy",
    role: "main",
    inputTokens: 3000,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    observedAt: new Date().toISOString(),
    attribution: { status: "attributed" },
    requestKey: "req_1",
  }).event;
  const projection = projectBillingFromUsageLedger({
    events: [event],
    agents: [],
  });
  const views = [buildThreadUsageLedgerEventView(event)];
  const report = verifyBillingAccounting({
    billing: projection.snapshot!,
    events: views,
  });
  expect(report.ok).toBe(true);
  expect(report.eventSums.primary).toBe(3300);
});
