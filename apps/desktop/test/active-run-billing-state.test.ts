import { expect, test } from "bun:test";
import { ActiveRunBillingStateStore } from "../src/main/active-run-billing-state";
import type { UsageBillingObservation } from "../src/main/billing-orchestration";

function observation(overrides: Partial<UsageBillingObservation> = {}): UsageBillingObservation {
  return {
    source: "sdk",
    role: "coder",
    agentId: "agent_coder",
    requestKey: "req_1",
    modelId: "haiku",
    usage: {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 10,
      cacheCreationTokens: 20,
    },
    ...overrides,
  };
}

test("ActiveRunBillingStateStore scopes observations to active runs", () => {
  const store = new ActiveRunBillingStateStore();

  expect(store.appendObservation("thr_state", observation())).toBe(false);
  expect(store.listObservations("thr_state")).toBeUndefined();

  store.startRun("thr_state");
  expect(store.appendObservation("thr_state", observation())).toBe(true);
  expect(store.appendObservation("thr_state", observation())).toBe(false);
  expect(store.listObservations("thr_state")).toHaveLength(1);

  store.clearRun("thr_state");
  expect(store.listObservations("thr_state")).toBeUndefined();
});

test("ActiveRunBillingStateStore tracks request sequences and proxy context cache", () => {
  const store = new ActiveRunBillingStateStore();
  store.startRun("thr_state");

  expect(store.proxyRequestSeq("thr_state")).toBeUndefined();
  store.recordProxyRequest("thr_state", {
    nextRequestSeq: 1,
    contextRole: "coder",
    contextOccupied: 12_000,
  });
  expect(store.proxyRequestSeq("thr_state")).toBe(1);
  expect(store.proxyContextOccupied("thr_state", "coder")).toBe(12_000);
  expect(store.proxyContextOccupied("thr_state", "main")).toBeUndefined();
});

test("ActiveRunBillingStateStore restarts with fresh billing state", () => {
  const store = new ActiveRunBillingStateStore();
  store.startRun("thr_state");
  store.appendObservation("thr_state", observation());
  store.recordProxyRequest("thr_state", {
    nextRequestSeq: 3,
    contextRole: "coder",
    contextOccupied: 8_000,
  });

  store.startRun("thr_state");

  expect(store.listObservations("thr_state")).toBeUndefined();
  expect(store.proxyRequestSeq("thr_state")).toBeUndefined();
  expect(store.proxyContextOccupied("thr_state", "coder")).toBeUndefined();
});
