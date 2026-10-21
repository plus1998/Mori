import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeRequestBilling } from "@eco/runtime";
import { projectBillingFromUsageLedger } from "../src/main/billing-projector";
import { createConversationStore } from "../src/main/conversation-store";
import {
  type AppendSdkSessionUsageInput,
  buildSdkSessionUsageLedgerEvents,
  readSdkSessionUsageContext,
} from "../src/main/sdk-session-usage-ledger";
import { projectUsageLedger, type UsageLedgerEvent } from "../src/main/usage-ledger";
import { UsageLedgerCoordinator } from "../src/main/usage-ledger-coordinator";

const rates = { input: 3, output: 15 };
function input(tokens: number, requestKey: string, resumed = false): AppendSdkSessionUsageInput {
  const usage = {
    inputTokens: tokens,
    outputTokens: tokens / 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  return {
    threadId: "thr_session_usage",
    role: "main",
    agentId: "main",
    requestKey,
    session: { sessionId: "session-1", resumed },
    totalCostUsd: tokens / 1000,
    models: [
      {
        modelId: "provider-model",
        sdkModelId: "sdk-model",
        usage,
        actualRates: rates,
        plannerRates: rates,
        sdkCostUsd: tokens / 1000,
        computedBilling: computeRequestBilling(usage, rates, rates),
      },
    ],
  };
}
function append(value: AppendSdkSessionUsageInput, existing: UsageLedgerEvent[]) {
  const result = buildSdkSessionUsageLedgerEvents(value, existing);
  existing.push(...result.events);
  return result;
}
test("cumulative SDK results count only increments in both token and cost projections", () => {
  const events: UsageLedgerEvent[] = [];
  append(input(100, "r1"), events);
  append(input(150, "r2", true), events);
  expect(projectUsageLedger(events).total.inputTokens).toBe(150);
  const projection = projectBillingFromUsageLedger({ threadId: "thr_session_usage", events, agents: [] });
  expect(projection.snapshot?.totalTokens.input).toBe(150);
  expect(projection.snapshot?.sourceReportedCostUsd).toBeCloseTo(0.15);
  expect(projection.snapshot?.ecoCostUsd).toBeCloseTo(0.000675);
  expect(
    events.filter((event) => event.usageKind === "request_final").map((event) => event.inputTokens),
  ).toEqual([100, 50]);
});
test("checkpoint survives serialization, deduplicates replay, and keeps SDK identity across route changes", () => {
  const events: UsageLedgerEvent[] = [];
  append(input(100, "r1"), events);
  const restored = JSON.parse(JSON.stringify(events)) as UsageLedgerEvent[];
  expect(append(input(100, "r1", true), restored).events).toEqual([]);
  const resumed = input(150, "r2", true);
  const resumedModel = resumed.models[0];
  if (!resumedModel) throw new Error("Missing resumed usage model fixture");
  resumedModel.modelId = "different-provider-model";
  expect(append(resumed, restored).events[0]).toMatchObject({
    inputTokens: 50,
    modelId: "different-provider-model",
  });
});
test("unknown resume or fork history is marked unverified rather than charged again", () => {
  const events: UsageLedgerEvent[] = [];
  const initial = append(input(150, "r1", true), events);
  expect(initial.warnings).toEqual(["sdk_session_usage_baseline_missing"]);
  expect(initial.events).toHaveLength(1);
  expect(initial.events[0]?.metadata?.billingGap).toBe("sdk_session_usage_baseline_missing");
  append(input(200, "r2", true), events);
  expect(projectUsageLedger(events).total.inputTokens).toBe(50);
  const fork = input(250, "fork", true);
  fork.session.sessionId = "forked-session";
  expect(append(fork, events).warnings).toEqual(["sdk_session_usage_baseline_missing"]);
  expect(projectUsageLedger(events).total.inputTokens).toBe(50);
});
test("only an explicit conversation reset starts a zero baseline", () => {
  const events: UsageLedgerEvent[] = [];
  append(input(100, "r1"), events);
  expect(append(input(50, "bad", true), events).warnings).toContain("sdk_session_usage_regressed:sdk-model");
  expect(events).toHaveLength(2);
  const reset = input(20, "reset");
  reset.session.resetId = "clear-message";
  append(reset, events);
  append(input(30, "r3", true), events);
  expect(projectUsageLedger(events).total.inputTokens).toBe(130);
});
test("new models start at zero and checkpoint order does not depend on timestamps", () => {
  const events: UsageLedgerEvent[] = [];
  const first = input(100, "r1");
  first.observedAt = "2026-10-05T00:00:00Z";
  append(first, events);
  const second = input(150, "r2", true);
  second.observedAt = first.observedAt;
  const newModel = input(40, "unused").models[0];
  if (!newModel) throw new Error("Missing new usage model fixture");
  second.models = [...second.models, { ...newModel, sdkModelId: "new-model", modelId: "new-model" }];
  second.totalCostUsd = 0.19;
  append(second, events);
  const reversed = [...events].reverse();
  const third = input(200, "r3", true);
  third.totalCostUsd = 0.24;
  expect(append(third, reversed).events[0]?.inputTokens).toBe(50);
});
test("write failure never advances a checkpoint and retry repairs partially persisted deltas", () => {
  const events: UsageLedgerEvent[] = [];
  let fail = true;
  const coordinator = new UsageLedgerCoordinator({
    store: {
      listUsageLedgerEvents: () => events,
      listAgentInstances: () => [],
      appendUsageLedgerEvent(event) {
        if (fail && event.usageKind === "session_total") throw new Error("disk write failed");
        if (events.some((old) => old.idempotencyKey === event.idempotencyKey)) return false;
        events.push(event);
        return true;
      },
    },
    metrics: { listEntries: () => [] },
  });
  expect(() => coordinator.appendSdkSessionUsage(input(100, "r1"))).toThrow("disk write failed");
  expect(events).toHaveLength(1);
  fail = false;
  coordinator.appendSdkSessionUsage(input(100, "r1"));
  coordinator.appendSdkSessionUsage(input(150, "r2", true));
  expect(projectUsageLedger(events).total.inputTokens).toBe(150);
  expect(events.filter((event) => event.usageKind === "session_total")).toHaveLength(2);
});
test("invalid session usage identity fails explicitly", () => {
  expect(() =>
    readSdkSessionUsageContext({ sdk_session_usage: { sessionId: "unknown-session", resumed: false } }),
  ).toThrow();
});

test("V2 SQLite stores session checkpoints and settles increments after reopening", async () => {
  const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), "eco-sdk-checkpoint-")), "eco.sqlite");
  const store = await createConversationStore(dbPath);
  store.saveThread({
    id: "thr_session_usage",
    title: "SDK checkpoint",
    prompt: "test",
    workspacePath: "/tmp",
    status: "idle",
    message: "",
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
  });
  store.upsertAgentInstance({
    threadId: "thr_session_usage",
    agentId: "main",
    role: "main",
    kind: "main",
    status: "completed",
    startedAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
  });
  const first = new UsageLedgerCoordinator({ store, metrics: { listEntries: () => [] } });
  first.appendSdkSessionUsage(input(100, "r1"));
  const reopened = await createConversationStore(dbPath);
  const second = new UsageLedgerCoordinator({ store: reopened, metrics: { listEntries: () => [] } });
  expect(second.appendSdkSessionUsage(input(150, "r2", true))).toEqual([]);
  const events = reopened.listUsageLedgerEvents("thr_session_usage");
  expect(events.filter((event) => event.usageKind === "session_total")).toHaveLength(2);
  expect(projectUsageLedger(events).total.inputTokens).toBe(150);
});
