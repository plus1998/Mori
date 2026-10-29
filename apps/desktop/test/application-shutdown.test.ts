import { expect, test } from "bun:test";
import {
  type ApplicationShutdownDeps,
  buildQuitConfirmationDialogOptions,
  collectRunningWorkSummary,
  hasRunningWork,
  isThreadActivelyRunning,
  shutdownApplicationServices,
} from "../src/main/application-shutdown-work";

function createDeps(overrides: Partial<ApplicationShutdownDeps> = {}): ApplicationShutdownDeps {
  return {
    locale: () => "zh-CN",
    listThreads: () => [],
    hasActiveRun: () => false,
    isCompactInFlight: () => false,
    countRunningBackgroundTasks: () => 0,
    cancelThreadRuntime: async () => {},
    abortActiveRun: () => false,
    finishActiveRun: () => {},
    cancelClarifications: () => {},
    cancelBashApprovals: () => {},
    cancelPlanApprovals: () => {},
    settleRecoveredLifecycleRecords: () => {},
    getPendingPlan: () => undefined,
    updateThreadOnQuit: () => {},
    emitThreadQuitEvent: () => {},
    stopAllBackgroundTasks: () => {},
    killAllInteractiveTerminals: () => {},
    disposeBrowserHost: () => {},
    closeImageGenerationGateway: async () => {},
    closeImageViewGateway: async () => {},
    closeImageDisplayGateway: async () => {},
    closeIntegratedWebSearchGateway: async () => {},
    closeMcpHubGateway: async () => {},
    stopAllPiRuntimes: async () => {},
    stopGlobalCodexRuntime: async () => {},
    stopAllAcpRuntimes: () => {},
    stopGlobalEcoGateway: async () => {},
    disposeDesktopUpdateService: () => {},
    disposeSystemSleepBlocker: () => {},
    clearCodexSubagentRuntimeLimit: () => {},
    flushAllThreadMetrics: () => {},
    disposeCodexGatewayUsagePending: () => {},
    clearCodexGatewayUsageDeduplicator: () => {},
    disposeGitAutoFetcher: () => {},
    disposeCenterServerClient: () => {},
    ...overrides,
  };
}

test("application quit waits for browser processes before closing the remaining services", async () => {
  let release!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const shutdown = shutdownApplicationServices(createDeps({
    disposeBrowserHost: async () => { order.push("browser-stopping"); await stopped; order.push("browser-stopped"); },
    closeImageGenerationGateway: async () => { order.push("gateways"); },
  }));
  await Bun.sleep(0);
  expect(order).toEqual(["browser-stopping"]);
  release();
  await shutdown;
  expect(order).toEqual(["browser-stopping", "browser-stopped", "gateways"]);
});

test("application quit waits for screen brightness restoration before stopping services", async () => {
  let release!: () => void;
  const restored = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const shutdown = shutdownApplicationServices(createDeps({
    disposeSystemSleepBlocker: async () => {
      order.push("restoring");
      await restored;
      order.push("restored");
    },
    disposeBrowserHost: () => { order.push("browser"); },
  }));
  await Bun.sleep(0);
  expect(order).toEqual(["restoring"]);
  release();
  await shutdown;
  expect(order).toEqual(["restoring", "restored", "browser"]);
});

test("isThreadActivelyRunning treats runtime and persisted running states as active", () => {
  expect(isThreadActivelyRunning({ status: "idle", runtimeActive: false })).toBe(false);
  expect(isThreadActivelyRunning({ status: "running", runtimeActive: false })).toBe(true);
  expect(isThreadActivelyRunning({ status: "queued", runtimeActive: false })).toBe(true);
  expect(isThreadActivelyRunning({ status: "idle", runtimeActive: true })).toBe(true);
});

test("collectRunningWorkSummary aggregates threads, background tasks, and compaction", () => {
  const summary = collectRunningWorkSummary(
    createDeps({
      listThreads: () => [
        {
          id: "thr_running",
          title: "Running thread",
          status: "running",
          coreKind: "codex",
        },
        {
          id: "thr_idle",
          title: "Idle thread",
          status: "idle",
          coreKind: "claude",
        },
      ],
      hasActiveRun: (threadId) => threadId === "thr_runtime_only",
      isCompactInFlight: (threadId) => threadId === "thr_compact",
      countRunningBackgroundTasks: () => 2,
    }),
  );

  expect(summary.runningThreads.map((thread) => thread.threadId)).toEqual(["thr_running"]);
  expect(summary.backgroundTaskCount).toBe(2);
  expect(summary.compactingThreadIds).toEqual([]);
});

test("hasRunningWork is false when nothing is active", () => {
  expect(
    hasRunningWork({
      runningThreads: [],
      backgroundTaskCount: 0,
      compactingThreadIds: [],
    }),
  ).toBe(false);
});

test("buildQuitConfirmationDialogOptions includes running counts", () => {
  const options = buildQuitConfirmationDialogOptions("zh-CN", {
    runningThreads: [
      {
        threadId: "thr_1",
        title: "One",
        status: "running",
        coreKind: "codex",
        runtimeActive: true,
      },
    ],
    backgroundTaskCount: 1,
    compactingThreadIds: ["thr_2"],
  });

  expect(options.title).toBe("退出 Mori？");
  expect(options.detail).toContain("1 个对话任务正在运行");
  expect(options.detail).toContain("1 个后台终端任务正在运行");
  expect(options.detail).toContain("1 个对话正在压缩上下文");
  expect(options.buttons).toEqual(["仍要退出", "取消"]);
  expect(options.defaultId).toBe(1);
});

test("shutdownApplicationServices stops ACP runtimes after Codex", async () => {
  const order: string[] = [];
  await shutdownApplicationServices(
    createDeps({
      disposeSystemSleepBlocker: () => {
        order.push("sleep");
      },
      stopGlobalCodexRuntime: async () => {
        order.push("codex");
      },
      stopAllAcpRuntimes: () => {
        order.push("acp");
      },
      stopGlobalEcoGateway: async () => {
        order.push("eco");
      },
    }),
  );
  expect(order).toEqual(["sleep", "codex", "acp", "eco"]);
});

test("application shutdown awaits idle PI sessions before closing their gateways", async () => {
  const order: string[] = [];
  await shutdownApplicationServices(
    createDeps({
      stopAllPiRuntimes: async () => {
        order.push("pi-start");
        await Promise.resolve();
        order.push("pi-closed");
      },
      closeMcpHubGateway: async () => {
        order.push("hub");
      },
      stopGlobalEcoGateway: async () => {
        order.push("models");
      },
    }),
  );
  expect(order).toEqual(["pi-start", "pi-closed", "hub", "models"]);
});
