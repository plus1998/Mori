import { expect, test } from "bun:test";
import {
  type ContextLifecycleMonitor,
  createContextLifecycleService,
} from "../src/main/context-lifecycle-service";

function createMonitor() {
  const calls = {
    completed: [] as Array<{ threadId: string; postTokens?: number }>,
    compacting: [] as string[],
  };
  const monitor: ContextLifecycleMonitor = {
    markCompactCompleted(threadId, postTokens) {
      calls.completed.push({ threadId, ...(postTokens !== undefined && { postTokens }) });
      return {
        occupied: postTokens ?? 0,
        limit: 100_000,
        ratio: 0,
        occupancyPct: 0,
        limitsResolved: true,
        roles: [],
        instances: [],
      };
    },
    noteCompactionObserved(threadId) {
      calls.compacting.push(threadId);
    },
  };
  return { monitor, calls };
}

test("afterRunRefresh emits live context without scheduling Eco compaction", async () => {
  const { monitor } = createMonitor();
  const live: string[] = [];
  const service = createContextLifecycleService({
    monitor,
    emitLiveContext: (threadId) => live.push(threadId),
    applySdkContextUsageBreakdown: () => undefined,
    recordCompactionBoundary: () => undefined,
  });

  await service.afterRunRefresh("thr_context");
  expect(live).toEqual(["thr_context"]);
});

test("handleSdkContextEvent applies context usage and consumes that event", () => {
  const { monitor } = createMonitor();
  const applied: unknown[] = [];
  const service = createContextLifecycleService({
    monitor,
    emitLiveContext: () => undefined,
    applySdkContextUsageBreakdown: (_threadId, payload) => applied.push(payload),
    recordCompactionBoundary: () => undefined,
  });

  const consumed = service.handleSdkContextEvent({
    threadId: "thr_context",
    eventId: "evt_context",
    payload: {
      type: "sdk_context_usage",
      ecoSdkContextUsage: { total: 123 },
    },
  });

  expect(consumed).toBe(true);
  expect(applied).toEqual([{ total: 123 }]);
});

test("handleSdkContextEvent records compact boundary and compacting status", () => {
  const { monitor, calls } = createMonitor();
  const live: string[] = [];
  const boundaries: Array<{ threadId: string; sourceEventId?: string; payload: unknown }> = [];
  const service = createContextLifecycleService({
    monitor,
    emitLiveContext: (threadId) => live.push(threadId),
    applySdkContextUsageBreakdown: () => undefined,
    recordCompactionBoundary: (threadId, payload, sourceEventId) => {
      boundaries.push({ threadId, payload, ...(sourceEventId && { sourceEventId }) });
    },
  });

  expect(
    service.handleSdkContextEvent({
      threadId: "thr_compact",
      eventId: "evt_boundary",
      payload: {
        subtype: "compact_boundary",
        compact_metadata: { post_tokens: 42 },
      },
    }),
  ).toBe(false);
  expect(
    service.handleSdkContextEvent({
      threadId: "thr_compact",
      eventId: "evt_status",
      payload: { type: "system", subtype: "status", status: "compacting" },
    }),
  ).toBe(false);

  expect(boundaries).toHaveLength(1);
  expect(boundaries[0]).toMatchObject({
    threadId: "thr_compact",
    sourceEventId: "evt_boundary",
  });
  expect(calls.completed).toEqual([{ threadId: "thr_compact", postTokens: 42 }]);
  expect(calls.compacting).toEqual(["thr_compact"]);
  expect(live).toEqual(["thr_compact"]);
});

test("service exposes compaction observed marker", () => {
  const { monitor, calls } = createMonitor();
  const service = createContextLifecycleService({
    monitor,
    emitLiveContext: () => undefined,
    applySdkContextUsageBreakdown: () => undefined,
    recordCompactionBoundary: () => undefined,
  });

  service.noteCompactionObserved("thr_compact");

  expect(calls.compacting).toEqual(["thr_compact"]);
});

test("compaction completion retries queued delivery after clearing the monitor and publishing context", () => {
  let compacting = true;
  const order: string[] = [];
  const { monitor } = createMonitor();
  const service = createContextLifecycleService({
    monitor: {
      ...monitor,
      markCompactCompleted(threadId, postTokens) {
        compacting = false;
        order.push("completed");
        return monitor.markCompactCompleted(threadId, postTokens);
      },
    },
    emitLiveContext: () => { order.push("published"); },
    applySdkContextUsageBreakdown: () => undefined,
    recordCompactionBoundary: () => { order.push("boundary"); },
    onCompactionCompleted: (threadId) => {
      expect(threadId).toBe("thr_compact");
      expect(compacting).toBe(false);
      order.push("retry");
    },
  });

  service.handleSdkContextEvent({
    threadId: "thr_compact", eventId: "evt_start",
    payload: { type: "system", subtype: "status", status: "compacting" },
  });
  expect(order).toEqual([]);
  service.handleSdkContextEvent({
    threadId: "thr_compact", eventId: "evt_boundary", payload: { subtype: "compact_boundary" },
  });
  expect(order).toEqual(["boundary", "completed", "published", "retry"]);
});
