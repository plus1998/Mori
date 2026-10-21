import { expect, test } from "bun:test";
import { ContextWindowMonitor } from "../src/main/context-window-monitor";
import type { ModelsDevPricingCache } from "../src/main/models-dev-pricing-cache";
import { reconcileProxyAttributionContexts } from "../src/main/proxy-attribution-context-reconciliation";
import {
  PROXY_PENDING_ATTRIBUTION_REASON,
  USAGE_LEDGER_BILLING_ROLE_METADATA_KEY,
  USAGE_LEDGER_CONTEXT_UPDATE_METADATA_KEY,
  USAGE_LEDGER_ROUTE_ROLE_METADATA_KEY,
} from "../src/main/proxy-usage-pending-settlement";
import type { SubagentMetricsPersistenceStore } from "../src/main/subagent-metrics-persistence";
import { SubagentMetricsRegistry } from "../src/main/subagent-metrics-registry";
import { createUsageContextService } from "../src/main/usage-context-effects";
import {
  type AgentInstanceRecord,
  buildUsageLedgerEventKey,
  InMemoryUsageLedger,
  type UsageLedgerEvent,
} from "../src/main/usage-ledger";
import {
  type ProxyAttributionSettlement,
  UsageLedgerCoordinator,
  type UsageLedgerCoordinatorStore,
} from "../src/main/usage-ledger-coordinator";

const threadId = "thr_message_identity";

const metricsStoreStub: SubagentMetricsPersistenceStore = {
  listSubagentMetrics: () => [],
  upsertSubagentMetrics: () => {},
  clearSubagentMetrics: () => {},
};

function mockPricingCache(): ModelsDevPricingCache {
  return {
    resolveContextLimit: async () => ({
      limit: 200_000,
      limitsResolved: true,
    }),
  } as ModelsDevPricingCache;
}

function createCoordinator(
  input: {
    metrics?: SubagentMetricsRegistry;
    onSettled?: (
      threadId: string,
      settlements: readonly ProxyAttributionSettlement[],
    ) => void | Promise<void>;
    diagnostics?: Array<{ topic: string; fields: Record<string, unknown> }>;
  } = {},
) {
  const ledger = new InMemoryUsageLedger();
  const metrics = input.metrics ?? new SubagentMetricsRegistry(metricsStoreStub);
  const store: UsageLedgerCoordinatorStore = {
    appendUsageLedgerEvent(event: UsageLedgerEvent) {
      return ledger.appendUsageEvent(event).inserted;
    },
    listUsageLedgerEvents(targetThreadId: string) {
      return ledger.listUsageEvents(targetThreadId);
    },
    listAgentInstances(targetThreadId: string): AgentInstanceRecord[] {
      return ledger.listAgentInstances(targetThreadId);
    },
    updateUsageLedgerEventAttribution(eventId, update) {
      return Boolean(ledger.updateUsageEventAttribution(eventId, update));
    },
  };
  const coordinator = new UsageLedgerCoordinator({
    store,
    metrics,
    ...(input.onSettled && { onProxyAttributionSettled: input.onSettled }),
    ...(input.diagnostics && {
      logDiag: (topic, fields) => input.diagnostics?.push({ topic, fields }),
    }),
    writeError: (message) => {
      throw new Error(message);
    },
  });
  return { ledger, metrics, coordinator };
}

function pendingProxyEvent(input: {
  eventId: string;
  messageId?: string;
  parentToolUseId?: string;
  inputTokens?: number;
}): UsageLedgerEvent {
  const sourceEventId = `proxy:${input.eventId}`;
  return {
    id: input.eventId,
    idempotencyKey: buildUsageLedgerEventKey({
      threadId,
      source: "proxy",
      sourceEventId,
      usageKind: "request_final",
      modelId: "claude-sonnet",
    }),
    threadId,
    source: "proxy",
    sourceEventId,
    requestKey: sourceEventId,
    usageKind: "request_final",
    role: "general-purpose",
    modelId: "claude-sonnet",
    inputTokens: input.inputTokens ?? 50_000,
    outputTokens: 2_000,
    cacheReadTokens: 1_000,
    cacheCreationTokens: 500,
    observedAt: `2026-07-10T00:00:0${input.eventId.slice(-1)}.000Z`,
    attribution: {
      status: "pending",
      reason: PROXY_PENDING_ATTRIBUTION_REASON,
    },
    ...(input.messageId && { sdkMessageId: input.messageId }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
    metadata: {
      [USAGE_LEDGER_ROUTE_ROLE_METADATA_KEY]: "general-purpose",
      [USAGE_LEDGER_BILLING_ROLE_METADATA_KEY]: "general-purpose",
      [USAGE_LEDGER_CONTEXT_UPDATE_METADATA_KEY]: {
        role: "general-purpose",
        modelId: "claude-sonnet",
        providerBaseUrl: "https://api.example.test",
      },
    },
  };
}

function appendPending(coordinator: UsageLedgerCoordinator, event: UsageLedgerEvent): number {
  coordinator.appendEvents([event]);
  return coordinator.registerProxyPendingAttribution(threadId, {
    eventId: event.id,
    requestKey: event.requestKey ?? event.sourceEventId,
    routeRole: "general-purpose",
    billingRole: "general-purpose",
    observedAt: event.observedAt,
    ...(event.sdkMessageId && { messageId: event.sdkMessageId }),
    ...(event.parentToolUseId && { parentToolUseId: event.parentToolUseId }),
  });
}

test("planner-route pending usage is rebound to the exact general-purpose role and parent", () => {
  const { ledger, coordinator } = createCoordinator();
  const event = pendingProxyEvent({
    eventId: "evt_planner_route",
    messageId: "resp_general_exact",
  });
  event.role = "main";
  event.metadata = {
    ...event.metadata,
    [USAGE_LEDGER_ROUTE_ROLE_METADATA_KEY]: "main",
    [USAGE_LEDGER_BILLING_ROLE_METADATA_KEY]: "main",
    [USAGE_LEDGER_CONTEXT_UPDATE_METADATA_KEY]: {
      role: "main",
      modelId: "claude-sonnet",
      providerBaseUrl: "https://api.example.test",
    },
  };
  coordinator.appendEvents([event]);
  coordinator.registerProxyPendingAttribution(threadId, {
    eventId: event.id,
    requestKey: event.requestKey ?? event.sourceEventId,
    routeRole: "main",
    billingRole: "main",
    observedAt: event.observedAt,
    messageId: "resp_general_exact",
  });

  expect(
    coordinator.bindProxyMessageIdentity(threadId, {
      messageId: "resp_general_exact",
      agentId: "agent_general_exact",
      role: "general-purpose",
      parentToolUseId: "call_general_exact",
    }),
  ).toBe(1);

  expect(ledger.listUsageEvents(threadId)[0]).toMatchObject({
    role: "general-purpose",
    agentId: "agent_general_exact",
    parentToolUseId: "call_general_exact",
    attribution: { status: "attributed", agentId: "agent_general_exact" },
    metadata: {
      [USAGE_LEDGER_ROUTE_ROLE_METADATA_KEY]: "main",
      [USAGE_LEDGER_BILLING_ROLE_METADATA_KEY]: "general-purpose",
      [USAGE_LEDGER_CONTEXT_UPDATE_METADATA_KEY]: { role: "general-purpose" },
    },
  });
});

test("proxy usage first settles when the SDK assistant message identity arrives", () => {
  const { ledger, coordinator } = createCoordinator();
  appendPending(coordinator, pendingProxyEvent({ eventId: "evt_1", messageId: "msg_proxy_first" }));

  expect(
    coordinator.bindProxyMessageIdentity(threadId, {
      messageId: "msg_proxy_first",
      agentId: "agent_alpha",
      role: "general-purpose",
    }),
  ).toBe(1);

  expect(ledger.listUsageEvents(threadId)[0]).toMatchObject({
    agentId: "agent_alpha",
    attribution: { status: "attributed", agentId: "agent_alpha" },
  });
});

test("SDK assistant identity first settles a later proxy usage registration", () => {
  const { ledger, coordinator } = createCoordinator();
  expect(
    coordinator.bindProxyMessageIdentity(threadId, {
      messageId: "msg_identity_first",
      agentId: "agent_beta",
      role: "general-purpose",
    }),
  ).toBe(0);

  expect(
    appendPending(coordinator, pendingProxyEvent({ eventId: "evt_2", messageId: "msg_identity_first" })),
  ).toBe(1);
  expect(ledger.listUsageEvents(threadId)[0]?.agentId).toBe("agent_beta");
});

test("three concurrent general-purpose agents settle only by their message ids", () => {
  const { ledger, coordinator } = createCoordinator();
  for (const [index, messageId] of ["msg_a", "msg_b", "msg_c"].entries()) {
    appendPending(coordinator, pendingProxyEvent({ eventId: `evt_${index + 3}`, messageId }));
  }

  coordinator.bindProxyMessageIdentity(threadId, {
    messageId: "msg_c",
    agentId: "agent_c",
    role: "general-purpose",
  });
  coordinator.bindProxyMessageIdentity(threadId, {
    messageId: "msg_a",
    agentId: "agent_a",
    role: "general-purpose",
  });
  coordinator.bindProxyMessageIdentity(threadId, {
    messageId: "msg_b",
    agentId: "agent_b",
    role: "general-purpose",
  });

  expect(
    Object.fromEntries(ledger.listUsageEvents(threadId).map((event) => [event.sdkMessageId, event.agentId])),
  ).toEqual({ msg_a: "agent_a", msg_b: "agent_b", msg_c: "agent_c" });
});

test("message identity is idempotent and conflicting identities are logged without overwrite", () => {
  const diagnostics: Array<{ topic: string; fields: Record<string, unknown> }> = [];
  const { ledger, coordinator } = createCoordinator({ diagnostics });
  appendPending(coordinator, pendingProxyEvent({ eventId: "evt_6", messageId: "msg_conflict" }));
  expect(
    coordinator.bindProxyMessageIdentity(threadId, {
      messageId: "msg_conflict",
      agentId: "agent_original",
      role: "general-purpose",
    }),
  ).toBe(1);
  expect(
    coordinator.bindProxyMessageIdentity(threadId, {
      messageId: "msg_conflict",
      agentId: "agent_original",
      role: "general-purpose",
    }),
  ).toBe(0);
  expect(
    coordinator.bindProxyMessageIdentity(threadId, {
      messageId: "msg_conflict",
      agentId: "agent_conflicting",
      role: "general-purpose",
    }),
  ).toBe(0);

  expect(ledger.listUsageEvents(threadId)[0]?.agentId).toBe("agent_original");
  expect(
    diagnostics.some(
      (entry) =>
        entry.topic === "usage_ledger.proxy_message_identity_conflict" &&
        entry.fields.reason === "message_identity_conflict",
    ),
  ).toBe(true);
});

test("missing message and parent identity remains pending until explicit timeout", () => {
  const { ledger, coordinator } = createCoordinator();
  appendPending(coordinator, pendingProxyEvent({ eventId: "evt_7" }));

  expect(ledger.listUsageEvents(threadId)[0]?.attribution.status).toBe("pending");
  expect(coordinator.settleProxyPendingTimeouts(threadId)).toBe(1);
  expect(ledger.listUsageEvents(threadId)[0]?.attribution).toEqual({
    status: "unattributed",
    reason: "pending_agent_settlement_timeout",
  });
});

test("settlement reconciles the exact agent instance context and metrics", async () => {
  const metrics = new SubagentMetricsRegistry(metricsStoreStub);
  metrics.onSubagentStart(threadId, {
    agentId: "agent_context",
    role: "general-purpose",
  });
  const monitor = new ContextWindowMonitor(mockPricingCache());
  const emitted: string[] = [];
  const persisted: string[] = [];
  const context = createUsageContextService({
    monitor,
    emitLiveContext: (targetThreadId) => emitted.push(targetThreadId),
  });
  const { ledger, coordinator } = createCoordinator({
    metrics,
    onSettled: (targetThreadId, settlements) =>
      reconcileProxyAttributionContexts(
        {
          context,
          subagentMetrics: metrics,
          schedulePersistThreadMetrics: (persistedThreadId) => persisted.push(persistedThreadId),
        },
        targetThreadId,
        settlements,
      ),
  });

  appendPending(
    coordinator,
    pendingProxyEvent({
      eventId: "evt_8",
      messageId: "msg_context",
      inputTokens: 60_000,
    }),
  );
  coordinator.bindProxyMessageIdentity(threadId, {
    messageId: "msg_context",
    agentId: "agent_context",
    role: "general-purpose",
  });
  await coordinator.flushUsageUpdates(threadId);

  expect(ledger.listUsageEvents(threadId)[0]).toMatchObject({
    agentId: "agent_context",
    attribution: { status: "attributed", agentId: "agent_context" },
  });
  expect(monitor.getInstanceOccupancy(threadId, "agent_context")).toMatchObject({
    role: "general-purpose",
    occupied: 61_500,
    limit: 200_000,
  });
  expect(metrics.listEntries(threadId)[0]).toMatchObject({
    agentId: "agent_context",
    role: "general-purpose",
    contextOccupied: 61_500,
    contextLimit: 200_000,
    modelId: "claude-sonnet",
  });
  expect(emitted).toEqual([threadId]);
  expect(persisted).toEqual([threadId]);
});
