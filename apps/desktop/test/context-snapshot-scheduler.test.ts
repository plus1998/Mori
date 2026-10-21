import { expect, test } from "bun:test";
import { ContextSnapshotScheduler } from "../src/main/context-snapshot-scheduler";
import type { ContextMonitorSnapshot, ContextWindowMonitor } from "../src/main/context-window-monitor";
import type { ThreadContextSnapshot } from "../src/shared/ipc";

test("emits one occupancy segment per independent role window", () => {
  const emitted: ThreadContextSnapshot[] = [];
  const monitorSnapshot: ContextMonitorSnapshot = {
    occupied: 10_000,
    limit: 100_000,
    ratio: 0.1,
    occupancyPct: 10,
    limitsResolved: true,
    displayRole: "main",
    roles: [
      {
        role: "main",
        occupied: 10_000,
        limit: 100_000,
        ratio: 0.1,
        occupancyPct: 10,
        limitsResolved: true,
      },
      {
        role: "coder",
        occupied: 40_000,
        limit: 100_000,
        ratio: 0.4,
        occupancyPct: 40,
        limitsResolved: true,
      },
    ],
  };
  const monitor = {
    getSnapshot: () => monitorSnapshot,
    restoreFromContextSnapshot: () => {},
    clearThread: () => {},
  } as unknown as ContextWindowMonitor;
  const scheduler = new ContextSnapshotScheduler({
    monitor,
    emitContext: (_threadId, snapshot) => emitted.push(snapshot),
  });

  scheduler.restoreSnapshot("t1", {
    occupied: 10_000,
    limit: 100_000,
    occupancyPct: 10,
    limitsResolved: true,
    displayRole: "main",
    segments: [],
    roles: [
      {
        role: "main",
        occupied: 10_000,
        limit: 100_000,
        occupancyPct: 10,
        limitsResolved: true,
        segments: [],
      },
    ],
    updatedAt: Date.now(),
  });
  scheduler.emitLiveFromMonitor("t1");

  const snapshot = emitted.at(-1);
  expect(snapshot?.roles?.find((role) => role.role === "main")?.segments).toEqual([
    { key: "conversation", label: "会话", tokens: 10_000, color: "#ea580c" },
  ]);
  const coderSegments = snapshot?.roles?.find((role) => role.role === "coder")?.segments;
  expect(coderSegments).toEqual([{ key: "conversation", label: "会话", tokens: 40_000, color: "#ea580c" }]);
});

test("clearSubagentState drops cached child role snapshots and segments", () => {
  const plannerSegments: ThreadContextSnapshot["segments"] = [
    { key: "conversation", label: "会话", tokens: 10_000, color: "#ea580c" },
  ];
  const coderSegments: ThreadContextSnapshot["segments"] = [
    { key: "conversation", label: "会话", tokens: 40_000, color: "#ea580c" },
  ];
  let monitorSnapshot: ContextMonitorSnapshot | undefined;
  const monitor = {
    getSnapshot: () => monitorSnapshot,
    restoreFromContextSnapshot: (_threadId: string, snapshot: ThreadContextSnapshot) => {
      monitorSnapshot = {
        occupied: snapshot.occupied,
        limit: snapshot.limit,
        ratio: snapshot.limit > 0 ? snapshot.occupied / snapshot.limit : 0,
        occupancyPct: snapshot.occupancyPct,
        limitsResolved: snapshot.limitsResolved,
        displayRole: snapshot.displayRole,
        roles:
          snapshot.roles?.map((role) => ({
            role: role.role,
            occupied: role.occupied,
            limit: role.limit,
            ratio: role.limit > 0 ? role.occupied / role.limit : 0,
            occupancyPct: role.occupancyPct,
            limitsResolved: role.limitsResolved,
            ...(role.modelId && { modelId: role.modelId }),
          })) ?? [],
      };
    },
    clearThread: () => {},
  } as unknown as ContextWindowMonitor;
  const scheduler = new ContextSnapshotScheduler({
    monitor,
    emitContext: () => {},
  });

  scheduler.restoreSnapshot("t1", {
    occupied: 10_000,
    limit: 100_000,
    occupancyPct: 10,
    limitsResolved: true,
    displayRole: "main",
    segments: plannerSegments,
    roles: [
      {
        role: "main",
        occupied: 10_000,
        limit: 100_000,
        occupancyPct: 10,
        limitsResolved: true,
        segments: plannerSegments,
      },
      {
        role: "coder",
        occupied: 40_000,
        limit: 100_000,
        occupancyPct: 40,
        limitsResolved: true,
        segments: coderSegments,
      },
    ],
    updatedAt: Date.now(),
  });

  scheduler.clearSubagentState("t1");

  const snapshot = scheduler.getDisplaySnapshot("t1");
  expect(snapshot?.roles?.map((role) => role.role)).toEqual(["main"]);
  expect(snapshot?.segments).toEqual(plannerSegments);
});

test("applySdkContextUsageBreakdown updates planner segments from getContextUsage payload", async () => {
  const emitted: ThreadContextSnapshot[] = [];
  let monitorSnapshot: ContextMonitorSnapshot = {
    occupied: 36_000,
    limit: 200_000,
    ratio: 0.18,
    occupancyPct: 18,
    limitsResolved: true,
    displayRole: "main",
    roles: [
      {
        role: "main",
        occupied: 36_000,
        limit: 200_000,
        ratio: 0.24,
        occupancyPct: 24,
        limitsResolved: true,
      },
    ],
  };
  const monitor = {
    getSnapshot: () => monitorSnapshot,
    updateOccupied: async (_threadId: string, role: "main", occupied: number) => {
      monitorSnapshot = {
        ...monitorSnapshot,
        occupied,
        roles: monitorSnapshot.roles.map((entry) =>
          entry.role === role
            ? { ...entry, occupied, occupancyPct: Math.round((occupied / entry.limit) * 100) }
            : entry,
        ),
      };
      return monitorSnapshot;
    },
    restoreFromContextSnapshot: () => {},
    clearThread: () => {},
  } as unknown as ContextWindowMonitor;

  const scheduler = new ContextSnapshotScheduler({
    monitor,
    emitContext: (_threadId, snapshot) => emitted.push(snapshot),
  });

  scheduler.applySdkContextUsageBreakdown("t1", {
    totalTokens: 31_528,
    maxTokens: 200_000,
    percentage: 16,
    messageBreakdown: {
      userMessageTokens: 2098,
      assistantMessageTokens: 270,
      toolCallTokens: 28,
      toolResultTokens: 42,
      attachmentTokens: 1672,
      unattributedTokens: 27_418,
    },
  });

  const snapshot = emitted.at(-1);
  expect(snapshot?.occupied).toBe(31_528);
  expect(
    snapshot?.roles
      ?.find((role) => role.role === "main")
      ?.segments.some((s) => s.label === "未归因上下文"),
  ).toBe(true);
});
