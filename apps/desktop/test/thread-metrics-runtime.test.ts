import { expect, test } from "bun:test";
import type { ParsedUsage } from "@eco/runtime";
import type { ThreadMetricsRecord } from "../src/main/conversation-store";
import {
  buildPersistedThreadMetrics,
  flushThreadMetrics,
  type PersistedThreadMetricsInput,
  persistThreadMetrics,
  restoreThreadMetricsFromStore,
} from "../src/main/thread-metrics-runtime";
import { ThreadUsageAccumulator } from "../src/main/thread-usage-accumulator";
import type { UsageContextUpdateMonitor } from "../src/main/usage-context-effects";
import type { ThreadContextSnapshot } from "../src/shared/ipc";

const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function usage(inputTokens = 1_000): ParsedUsage {
  return { inputTokens, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function contextSnapshot(occupied = 1_000): ThreadContextSnapshot {
  return {
    occupied,
    limit: 100_000,
    occupancyPct: 1,
    limitsResolved: true,
    segments: [],
    updatedAt: 1,
  };
}

function serializedUsageState() {
  const accumulator = new ThreadUsageAccumulator();
  accumulator.recordUsage({
    threadId: "thr_metrics",
    role: "main",
    delta: usage(),
    actualRates: sonnetRates,
    plannerRates: sonnetRates,
    requestKey: "request_1",
  });
  const serialized = accumulator.serializeState("thr_metrics");
  if (!serialized) {
    throw new Error("expected serialized usage state");
  }
  return serialized;
}

test("restoreThreadMetricsFromStore restores accumulator context and hydrates subagent context", () => {
  const serialized = serializedUsageState();
  const context = contextSnapshot();
  const records: ThreadMetricsRecord[] = [
    {
      threadId: "thr_metrics",
      accumulator: serialized,
      context,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const restoredAccumulator: unknown[] = [];
  const restoredContext: unknown[] = [];
  const restoredSubagents: string[] = [];
  const contextOccupancyUpdates: Array<{
    threadId: string;
    role: string;
    occupied: number;
    options: unknown;
  }> = [];
  const contextMonitor: UsageContextUpdateMonitor = {
    async updateFromUsage() {
      throw new Error("hydrate must not feed cumulative billing usage into updateFromUsage");
    },
    async updateOccupied(threadId, role, occupied, options) {
      contextOccupancyUpdates.push({ threadId, role, occupied, options });
      return undefined as Awaited<ReturnType<UsageContextUpdateMonitor["updateOccupied"]>>;
    },
  };

  restoreThreadMetricsFromStore({
    store: {
      listThreadMetrics: () => records,
    },
    accumulator: {
      restoreState: (threadId, data) => restoredAccumulator.push({ threadId, data }),
    },
    contextSnapshots: {
      restoreSnapshot: (threadId, snapshot) => restoredContext.push({ threadId, snapshot }),
    },
    subagentMetrics: {
      restoreFromStore: (threadId) => restoredSubagents.push(threadId),
      listEntries: () => [
        {
          agentId: "agent_coder",
          role: "coder",
          usage: usage(500),
          contextOccupied: 500,
          modelId: "haiku",
        },
        {
          agentId: "agent_empty",
          role: "coder",
          usage: usage(0),
          contextOccupied: 0,
        },
      ],
    },
    contextMonitor,
  });

  expect(restoredAccumulator).toHaveLength(1);
  expect(restoredContext).toEqual([{ threadId: "thr_metrics", snapshot: context }]);
  expect(restoredSubagents).toEqual(["thr_metrics"]);
  expect(contextOccupancyUpdates).toHaveLength(1);
  expect(contextOccupancyUpdates[0]).toMatchObject({
    threadId: "thr_metrics",
    role: "coder",
    occupied: 500,
    options: {
      agentId: "agent_coder",
      modelId: "haiku",
    },
  });
});

test("hydrateSubagentContextFromMetrics never treats cumulative billing usage as window occupancy", () => {
  const serialized = serializedUsageState();
  const contextOccupancyUpdates: Array<{ occupied: number; agentId?: string }> = [];
  const contextMonitor: UsageContextUpdateMonitor = {
    async updateFromUsage() {
      throw new Error("must not call updateFromUsage with cumulative usage");
    },
    async updateOccupied(_threadId, _role, occupied, options) {
      contextOccupancyUpdates.push({ occupied, agentId: options?.agentId });
      return undefined as Awaited<ReturnType<UsageContextUpdateMonitor["updateOccupied"]>>;
    },
  };

  restoreThreadMetricsFromStore({
    store: {
      listThreadMetrics: () => [
        {
          threadId: "thr_explore_bug",
          accumulator: serialized,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    accumulator: { restoreState: () => undefined },
    contextSnapshots: { restoreSnapshot: () => undefined },
    subagentMetrics: {
      restoreFromStore: () => undefined,
      listEntries: () => [
        {
          agentId: "agent_explore",
          role: "explore",
          // Cumulative billing total that previously became fake occupancy 4390200
          usage: {
            inputTokens: 232_248,
            outputTokens: 50_000,
            cacheReadTokens: 4_157_952,
            cacheCreationTokens: 0,
          },
          contextOccupied: 0,
          modelId: "deepseek-v4-flash",
        },
        {
          agentId: "agent_explore_ok",
          role: "explore",
          usage: {
            inputTokens: 232_248,
            outputTokens: 50_000,
            cacheReadTokens: 4_157_952,
            cacheCreationTokens: 0,
          },
          contextOccupied: 114_000,
          modelId: "deepseek-v4-flash",
        },
      ],
    },
    contextMonitor,
  });

  expect(contextOccupancyUpdates).toEqual([{ occupied: 114_000, agentId: "agent_explore_ok" }]);
});

test("buildPersistedThreadMetrics and persistThreadMetrics preserve snapshot shape", () => {
  const serialized = serializedUsageState();
  const context = contextSnapshot(2_000);
  const saved: Array<{ threadId: string; input: PersistedThreadMetricsInput }> = [];
  const services = {
    store: {
      saveThreadMetrics: (threadId: string, input: PersistedThreadMetricsInput) => {
        saved.push({ threadId, input });
      },
    },
    accumulator: {
      serializeState: () => serialized,
    },
    contextSnapshots: {
      getDisplaySnapshot: () => context,
    },
  };

  expect(buildPersistedThreadMetrics(services, "thr_metrics")).toEqual({
    accumulator: serialized,
    context,
  });
  persistThreadMetrics(services, "thr_metrics");

  expect(saved).toEqual([
    {
      threadId: "thr_metrics",
      input: {
        accumulator: serialized,
        context,
      },
    },
  ]);
});

test("flushThreadMetrics saves persisted and live threads with metrics", () => {
  const serialized = serializedUsageState();
  const context = contextSnapshot(3_000);
  const saved: string[] = [];
  const records: ThreadMetricsRecord[] = [
    { threadId: "thr_persisted", updatedAt: "2026-01-01T00:00:00.000Z" },
    { threadId: "thr_empty", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];

  flushThreadMetrics({
    store: {
      listThreadMetrics: () => records,
      listThreads: () => [{ id: "thr_live" }, { id: "thr_empty" }],
      saveThreadMetrics: (threadId) => {
        saved.push(threadId);
      },
    },
    accumulator: {
      serializeState: (threadId) => (threadId === "thr_persisted" ? serialized : undefined),
    },
    contextSnapshots: {
      getDisplaySnapshot: (threadId) => (threadId === "thr_live" ? context : undefined),
    },
  });

  expect(saved).toEqual(["thr_persisted", "thr_live"]);
});
