import { expect, test } from "bun:test";
import {
  buildUsageLedgerEventKey,
  InMemoryUsageLedger,
  projectUsageLedger,
  type UsageLedgerEvent,
} from "../src/main/usage-ledger";

function makeUsageEvent(
  overrides: Partial<UsageLedgerEvent> & Pick<UsageLedgerEvent, "id" | "sourceEventId">,
): UsageLedgerEvent {
  const event: UsageLedgerEvent = {
    id: overrides.id,
    idempotencyKey:
      overrides.idempotencyKey ??
      buildUsageLedgerEventKey({
        threadId: overrides.threadId ?? "thr_ledger",
        source: overrides.source ?? "sdk",
        sourceEventId: overrides.sourceEventId,
        usageKind: overrides.usageKind ?? "request_final",
        ...(overrides.modelId && { modelId: overrides.modelId }),
        ...(overrides.agentId && { agentId: overrides.agentId }),
      }),
    threadId: "thr_ledger",
    source: "sdk",
    sourceEventId: overrides.sourceEventId,
    usageKind: "request_final",
    role: "coder",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheCreationTokens: 1,
    observedAt: "2026-01-01T00:00:00.000Z",
    attribution: { status: "attributed", agentId: "agent_coder_a" },
    agentId: "agent_coder_a",
    modelId: "claude-test",
    reportedCostUsd: 0.01,
    ...overrides,
  };
  return event;
}

test("InMemoryUsageLedger appends usage events idempotently", () => {
  const ledger = new InMemoryUsageLedger();
  const event = makeUsageEvent({ id: "evt_1", sourceEventId: "sdk-result:1" });

  const first = ledger.appendUsageEvent(event);
  const second = ledger.appendUsageEvent({ ...event, id: "evt_duplicate" });

  expect(first.inserted).toBe(true);
  expect(second.inserted).toBe(false);
  expect(second.event.id).toBe("evt_1");
  expect(ledger.listUsageEvents("thr_ledger")).toHaveLength(1);
});

test("projectUsageLedger aggregates totals by role agent and model", () => {
  const events = [
    makeUsageEvent({ id: "evt_1", sourceEventId: "sdk-result:1" }),
    makeUsageEvent({
      id: "evt_2",
      sourceEventId: "proxy:req-2",
      source: "proxy",
      role: "main",
      agentId: "planner_session",
      attribution: { status: "attributed", agentId: "planner_session" },
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelId: "planner-model",
      reportedCostUsd: 0.02,
    }),
  ];

  const projection = projectUsageLedger(events);

  expect(projection.total.inputTokens).toBe(150);
  expect(projection.total.outputTokens).toBe(30);
  expect(projection.total.reportedCostUsd).toBeCloseTo(0.03);
  expect(projection.byRole.coder?.inputTokens).toBe(100);
  expect(projection.byRole.main?.inputTokens).toBe(50);
  expect(projection.byAgent.agent_coder_a?.cacheReadTokens).toBe(5);
  expect(projection.byModel["planner-model"]?.outputTokens).toBe(10);
});

test("projectUsageLedger preserves unattributed events for audit", () => {
  const event = makeUsageEvent({
    id: "evt_unattributed",
    sourceEventId: "sdk:req-3",
    source: "sdk",
    agentId: undefined,
    attribution: { status: "unattributed", reason: "parent_tool_use_unmapped" },
  });

  const projection = projectUsageLedger([event]);

  expect(projection.unattributedEvents).toHaveLength(1);
  expect(projection.unattributedEvents[0]?.attribution.reason).toBe("parent_tool_use_unmapped");
  expect(projection.byAgent.agent_coder_a).toBeUndefined();
});

test("buildUsageLedgerEventKey separates model rows for one source event", () => {
  const base = {
    threadId: "thr_ledger",
    source: "sdk" as const,
    sourceEventId: "sdk-result:multi-model",
    usageKind: "request_final" as const,
    agentId: "agent_coder_a",
  };

  expect(buildUsageLedgerEventKey({ ...base, modelId: "model-a" })).not.toBe(
    buildUsageLedgerEventKey({ ...base, modelId: "model-b" }),
  );
});

test("buildUsageLedgerEventKey stays stable when attribution is added later", () => {
  const base = {
    threadId: "thr_ledger",
    source: "sdk" as const,
    sourceEventId: "sdk-result:reattributed",
    usageKind: "request_final" as const,
    modelId: "model-a",
  };

  expect(buildUsageLedgerEventKey(base)).toBe(
    buildUsageLedgerEventKey({ ...base, agentId: "agent_coder_a" }),
  );
});
