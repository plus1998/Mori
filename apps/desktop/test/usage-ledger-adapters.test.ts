import { expect, test } from "bun:test";
import { buildSdkUsageLedgerEvents, buildSingleUsageLedgerEvent } from "../src/main/usage-ledger-adapters";

test("buildSdkUsageLedgerEvents writes one row per model without duplicating total cost", () => {
  const events = buildSdkUsageLedgerEvents({
    threadId: "thr_adapter",
    role: "main",
    requestKey: "sdk-result:evt_1",
    totalCostUsd: 1.23,
    runAttemptId: "attempt_1",
    observedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        role: "main",
        modelId: "planner-model",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 1 },
        sdkCostUsd: 0.4,
      },
      {
        role: "coder",
        modelId: "coder-model",
        usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 10, cacheCreationTokens: 2 },
        sdkCostUsd: 0.83,
      },
    ],
  });

  expect(events).toHaveLength(2);
  expect(events[0]?.reportedCostUsd).toBe(0.4);
  expect(events[1]?.reportedCostUsd).toBe(0.83);
  expect(events[0]?.runAttemptId).toBe("attempt_1");
  expect(events[1]?.runAttemptId).toBe("attempt_1");
  expect(events[0]?.metadata?.sdkTotalCostUsd).toBe(1.23);
  expect(events[0]?.idempotencyKey).not.toBe(events[1]?.idempotencyKey);
});

test("buildSdkUsageLedgerEvents uses request total only for a single model row", () => {
  const events = buildSdkUsageLedgerEvents({
    threadId: "thr_adapter",
    role: "main",
    requestKey: "sdk-result:evt_single",
    totalCostUsd: 0.5,
    models: [
      {
        modelId: "planner-model",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
      },
    ],
  });

  expect(events[0]?.reportedCostUsd).toBe(0.5);
});

test("buildSingleUsageLedgerEvent keeps idempotency stable when attribution changes", () => {
  const base = {
    threadId: "thr_adapter",
    role: "coder" as const,
    source: "sdk" as const,
    sourceEventId: "sdk:request:1",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
    modelId: "coder-model",
    observedAt: "2026-01-01T00:00:00.000Z",
  };

  const unattributed = buildSingleUsageLedgerEvent(base);
  const attributed = buildSingleUsageLedgerEvent({ ...base, agentId: "agent_coder_a" });

  expect(unattributed.idempotencyKey).toBe(attributed.idempotencyKey);
  expect(unattributed.id).toBe(attributed.id);
  expect(unattributed.attribution).toEqual({
    status: "unattributed",
    reason: "agent_id_missing",
  });
  expect(attributed.attribution).toEqual({
    status: "attributed",
    agentId: "agent_coder_a",
  });
});

test("buildSingleUsageLedgerEvent preserves source-specific audit fields", () => {
  const event = buildSingleUsageLedgerEvent({
    threadId: "thr_adapter",
    role: "coder",
    source: "proxy",
    sourceEventId: "proxy:coder:model:req_1",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 0 },
    modelId: "coder-model",
    requestKey: "proxy:coder:model:req_1",
    providerRequestId: "req_1",
    runAttemptId: "attempt_proxy",
    parentToolUseId: "toolu_parent",
    agentId: "agent_coder_a",
    reportedCostUsd: 0.01,
  });

  expect(event.source).toBe("proxy");
  expect(event.providerRequestId).toBe("req_1");
  expect(event.runAttemptId).toBe("attempt_proxy");
  expect(event.parentToolUseId).toBe("toolu_parent");
  expect(event.reportedCostUsd).toBe(0.01);
});

test("buildSingleUsageLedgerEvent preserves sdk assistant fallback identity", () => {
  const event = buildSingleUsageLedgerEvent({
    threadId: "thr_adapter",
    role: "explore",
    source: "sdk",
    sourceEventId: "sdk-assistant:msg_1",
    usageKind: "assistant_fallback",
    usage: { inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
    modelId: "explore-model",
    requestKey: "sdk-assistant:msg_1",
    sdkMessageId: "msg_1",
    parentToolUseId: "toolu_parent",
    agentId: "agent_explore_a",
  });

  expect(event.usageKind).toBe("assistant_fallback");
  expect(event.sdkMessageId).toBe("msg_1");
  expect(event.sourceEventId).toBe("sdk-assistant:msg_1");
});
