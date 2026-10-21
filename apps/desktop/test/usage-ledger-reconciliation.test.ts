import { expect, test } from "bun:test";
import { buildSdkUsageLedgerEvents, buildSingleUsageLedgerEvent } from "../src/main/usage-ledger-adapters";
import { projectBillingFromUsageLedger } from "../src/main/billing-projector";
import { reconcileUsageLedgerWithBilling } from "../src/main/usage-ledger-reconciliation";
import type {
  BillingUsageSource,
  ThreadBillingSnapshot,
  ThreadBillingSourceSnapshot,
} from "../src/shared/ipc";

function makeBilling(
  sourceBreakdown: Partial<Record<BillingUsageSource, ThreadBillingSourceSnapshot>>,
): ThreadBillingSnapshot {
  return {
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    sourceReportedCostUsd: 0,
    plannerTokenCostUsd: 0,
    ecoCostUsd: 0,
    savedUsd: 0,
    savedPct: 0,
    pricingResolved: true,
    sourceBreakdown,
  };
}

function sourceSnapshot(
  source: BillingUsageSource,
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number },
  reportedCostUsd = 0,
): ThreadBillingSourceSnapshot {
  return {
    source,
    totalTokens: tokens,
    plannerTokenCostUsd: 0,
    ecoCostUsd: 0,
    ...(reportedCostUsd !== 0 && { reportedCostUsd }),
    pricingResolved: true,
  };
}

test("reconcileUsageLedgerWithBilling matches source token totals", () => {
  const events = [
    buildSingleUsageLedgerEvent({
      threadId: "thr_reconcile",
      role: "coder",
      source: "sdk",
      sourceEventId: "sdk:1",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 0 },
      modelId: "coder-model",
      agentId: "agent_coder_a",
      reportedCostUsd: 0.01,
    }),
    buildSingleUsageLedgerEvent({
      threadId: "thr_reconcile",
      role: "coder",
      source: "proxy",
      sourceEventId: "proxy:1",
      usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 2, cacheCreationTokens: 1 },
      modelId: "coder-model",
      agentId: "agent_coder_a",
      reportedCostUsd: 0.02,
    }),
  ];

  const result = reconcileUsageLedgerWithBilling(
    events,
    makeBilling({
      sdk: sourceSnapshot("sdk", { input: 10, output: 2, cacheRead: 1, cacheCreation: 0 }, 0.01),
      proxy: sourceSnapshot("proxy", { input: 20, output: 4, cacheRead: 2, cacheCreation: 1 }, 0.02),
    }),
  );

  expect(result.ok).toBe(true);
  expect(result.issues).toEqual([]);
});

test("reconcileUsageLedgerWithBilling reports token mismatches", () => {
  const event = buildSingleUsageLedgerEvent({
    threadId: "thr_reconcile",
    role: "coder",
    source: "sdk",
    sourceEventId: "sdk:1",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 0 },
    modelId: "coder-model",
    agentId: "agent_coder_a",
  });

  const result = reconcileUsageLedgerWithBilling(
    [event],
    makeBilling({
      sdk: sourceSnapshot("sdk", { input: 9, output: 2, cacheRead: 1, cacheCreation: 0 }),
    }),
  );

  expect(result.ok).toBe(false);
  expect(result.issues).toContainEqual(
    expect.objectContaining({
      type: "token_mismatch",
      source: "sdk",
      field: "inputTokens",
      delta: 1,
    }),
  );
});

test("reconcileUsageLedgerWithBilling counts sdk request total once for multi-model rows", () => {
  const events = buildSdkUsageLedgerEvents({
    threadId: "thr_reconcile",
    role: "main",
    requestKey: "sdk-result:multi",
    totalCostUsd: 1.23,
    models: [
      {
        role: "main",
        modelId: "planner-model",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 0 },
      },
      {
        role: "coder",
        modelId: "coder-model",
        usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 2, cacheCreationTokens: 1 },
      },
    ],
  });

  const result = reconcileUsageLedgerWithBilling(
    events,
    makeBilling({
      sdk: sourceSnapshot("sdk", { input: 30, output: 6, cacheRead: 3, cacheCreation: 1 }, 1.23),
    }),
  );

  expect(result.issues.filter((issue) => issue.type === "reported_cost_mismatch")).toEqual([]);
});

test("reconcileUsageLedgerWithBilling prefers per-model reported cost over sdk request metadata", () => {
  const events = buildSdkUsageLedgerEvents({
    threadId: "thr_reconcile",
    role: "main",
    requestKey: "sdk-result:multi",
    totalCostUsd: 9.99,
    models: [
      {
        role: "main",
        modelId: "planner-model",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
        sdkCostUsd: 0.25,
      },
      {
        role: "coder",
        modelId: "coder-model",
        usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 },
        sdkCostUsd: 0.75,
      },
    ],
  });

  const result = reconcileUsageLedgerWithBilling(
    events,
    makeBilling({
      sdk: sourceSnapshot("sdk", { input: 30, output: 6, cacheRead: 0, cacheCreation: 0 }, 1),
    }),
  );

  expect(result.issues.filter((issue) => issue.type === "reported_cost_mismatch")).toEqual([]);
});

test("reconcileUsageLedgerWithBilling follows V2 shadow-row selection", () => {
  const usage = { inputTokens: 500, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 0 };
  const proxyEvent = buildSingleUsageLedgerEvent({
    threadId: "thr_reconcile_shadow",
    role: "coder",
    source: "proxy",
    sourceEventId: "proxy:request",
    requestKey: "proxy:request",
    providerRequestId: "provider:request",
    usage,
    modelId: "coder-model",
    agentId: "agent_coder",
    reportedCostUsd: 0.5,
  });
  const sdkShadowEvent = buildSingleUsageLedgerEvent({
    threadId: "thr_reconcile_shadow",
    role: "coder",
    source: "sdk",
    sourceEventId: "sdk:request",
    requestKey: "sdk:request",
    usage,
    modelId: "coder-model",
    agentId: "agent_coder",
    reportedCostUsd: 0.5,
  });
  const events = [proxyEvent, sdkShadowEvent];
  const projection = projectBillingFromUsageLedger({ events });

  expect(projection.snapshot?.sourceBreakdown?.sdk).toBeUndefined();
  expect(reconcileUsageLedgerWithBilling(events, projection.snapshot)).toMatchObject({
    ok: true,
    issues: [],
  });
});

test("reconcileUsageLedgerWithBilling reports missing ledger source and unattributed usage", () => {
  const event = buildSingleUsageLedgerEvent({
    threadId: "thr_reconcile",
    role: "coder",
    source: "sdk",
    sourceEventId: "sdk:1",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
    modelId: "coder-model",
  });

  const result = reconcileUsageLedgerWithBilling(
    [event],
    makeBilling({
      proxy: sourceSnapshot("proxy", { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 }),
      sdk: sourceSnapshot("sdk", { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 }),
    }),
  );

  expect(result.issues).toContainEqual(
    expect.objectContaining({ type: "missing_ledger_source", source: "proxy" }),
  );
  expect(result.issues).toContainEqual(expect.objectContaining({ type: "unattributed_usage", count: 1 }));
});
