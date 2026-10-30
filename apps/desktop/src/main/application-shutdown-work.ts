import type { CoreKind } from "@eco/runtime/core-runtime";
import { translateCatalog } from "../shared/i18n-catalogs";
import type { ThreadStatus } from "../shared/ipc";
import type { AppLocale } from "../shared/locale";
import {
  setApplicationQuitBypassConfirmation,
  shouldBypassQuitConfirmation,
} from "./application-quit-bypass";

export {
  setApplicationQuitBypassConfirmation,
  shouldBypassQuitConfirmation,
} from "./application-quit-bypass";

export interface RunningThreadSnapshot {
  threadId: string;
  title: string;
  status: ThreadStatus;
  coreKind: CoreKind | undefined;
  runtimeActive: boolean;
}

export interface RunningWorkSummary {
  runningThreads: RunningThreadSnapshot[];
  backgroundTaskCount: number;
  compactingThreadIds: readonly string[];
}

export type QuitConfirmationChoice = "quit" | "cancel";

export interface QuitConfirmationDialogOptions {
  type: "warning";
  title: string;
  message: string;
  detail: string;
  buttons: [string, string];
  defaultId: number;
  cancelId: number;
  noLink: true;
}

export interface ApplicationShutdownDeps {
  locale: () => AppLocale;
  listThreads: () => ReadonlyArray<{
    id: string;
    title: string;
    status: ThreadStatus;
    coreKind?: CoreKind;
  }>;
  hasActiveRun: (threadId: string) => boolean;
  isCompactInFlight: (threadId: string) => boolean;
  countRunningBackgroundTasks: () => number;
  cancelThreadRuntime: (coreKind: CoreKind, threadId: string) => Promise<void>;
  abortActiveRun: (threadId: string, reason: string) => boolean;
  finishActiveRun: (threadId: string) => void;
  cancelClarifications: (threadId: string, reason: string) => void;
  cancelBashApprovals: (threadId: string, reason: string) => void;
  cancelPlanApprovals: (threadId: string, reason: string) => void;
  settleRecoveredLifecycleRecords: (threadId: string, outcome: "cancelled" | "failed") => void;
  getPendingPlan: (threadId: string) => unknown;
  updateThreadOnQuit: (
    threadId: string,
    patch: { status: "awaiting_plan" | "idle"; message: string },
  ) => void;
  emitThreadQuitEvent: (
    threadId: string,
    type: "thread.awaiting_plan" | "thread.idle",
    message: string,
  ) => void;
  stopAllBackgroundTasks: () => void;
  killAllInteractiveTerminals: () => void;
  disposeBrowserHost: () => void | Promise<void>;
  stopAllPiRuntimes: () => Promise<void>;
  closeImageGenerationGateway: () => Promise<void>;
  closeImageViewGateway: () => Promise<void>;
  closeImageDisplayGateway: () => Promise<void>;
  closeIntegratedWebSearchGateway: () => Promise<void>;
  closeMcpHubGateway: () => Promise<void>;
  stopGlobalCodexRuntime: () => Promise<void>;
  /** Flush Codex auth.json and close its SQLite account store after the runtime stops. */
  closeOpenAIAccountService?: () => Promise<void>;
  /** Tear down Cursor ACP process trees Eco spawned this session (tracked only). */
  stopAllAcpRuntimes: () => void;
  stopGlobalEcoGateway: () => Promise<void>;
  disposeDesktopUpdateService: () => void;
  disposeSystemSleepBlocker: () => void | Promise<void>;
  clearCodexSubagentRuntimeLimit: () => void;
  flushAllThreadMetrics: () => void;
  disposeCodexGatewayUsagePending: () => void;
  clearCodexGatewayUsageDeduplicator: () => void;
  disposeGitAutoFetcher: () => void;
  disposeCenterServerClient: () => void;
  parentWindow?: () => Electron.BrowserWindow | undefined;
  logError?: (error: unknown) => void;
}

const ACTIVE_THREAD_STATUSES = new Set<ThreadStatus>(["running", "queued"]);
const RUN_SETTLE_TIMEOUT_MS = 8_000;
const RUN_SETTLE_POLL_MS = 50;

export function isThreadActivelyRunning(input: { status: ThreadStatus; runtimeActive: boolean }): boolean {
  return input.runtimeActive || ACTIVE_THREAD_STATUSES.has(input.status);
}

export function collectRunningWorkSummary(deps: ApplicationShutdownDeps): RunningWorkSummary {
  const runningThreads: RunningThreadSnapshot[] = [];
  const compactingThreadIds: string[] = [];

  for (const thread of deps.listThreads()) {
    const runtimeActive = deps.hasActiveRun(thread.id);
    if (deps.isCompactInFlight(thread.id)) {
      compactingThreadIds.push(thread.id);
    }
    if (!isThreadActivelyRunning({ status: thread.status, runtimeActive })) {
      continue;
    }
    runningThreads.push({
      threadId: thread.id,
      title: thread.title,
      status: thread.status,
      coreKind: thread.coreKind,
      runtimeActive,
    });
  }

  return {
    runningThreads,
    backgroundTaskCount: deps.countRunningBackgroundTasks(),
    compactingThreadIds,
  };
}

export function hasRunningWork(summary: RunningWorkSummary): boolean {
  return (
    summary.runningThreads.length > 0 ||
    summary.backgroundTaskCount > 0 ||
    summary.compactingThreadIds.length > 0
  );
}

export function buildQuitConfirmationDialogOptions(
  locale: AppLocale,
  summary: RunningWorkSummary,
): QuitConfirmationDialogOptions {
  const text = (
    key: Parameters<typeof translateCatalog>[1],
    variables?: Parameters<typeof translateCatalog>[2],
  ) => translateCatalog(locale, key, variables);

  const agentCount = summary.runningThreads.length;
  const backgroundCount = summary.backgroundTaskCount;
  const compactingCount = summary.compactingThreadIds.length;

  const detailParts: string[] = [];
  if (agentCount > 0) {
    detailParts.push(text("app.quit.detailAgents", { count: agentCount }));
  }
  if (backgroundCount > 0) {
    detailParts.push(text("app.quit.detailBackground", { count: backgroundCount }));
  }
  if (compactingCount > 0) {
    detailParts.push(text("app.quit.detailCompacting", { count: compactingCount }));
  }

  return {
    type: "warning",
    title: text("app.quit.title"),
    message: text("app.quit.message"),
    detail: detailParts.length > 0 ? detailParts.join("\n") : text("app.quit.detailFallback"),
    buttons: [text("app.quit.confirm"), text("common.cancel")],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

async function waitForActiveRunsToSettle(
  deps: ApplicationShutdownDeps,
  threadIds: readonly string[],
): Promise<void> {
  if (threadIds.length === 0) {
    return;
  }
  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pending = threadIds.some((threadId) => deps.hasActiveRun(threadId));
    if (!pending) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RUN_SETTLE_POLL_MS));
  }
  for (const threadId of threadIds) {
    if (deps.hasActiveRun(threadId)) {
      deps.finishActiveRun(threadId);
    }
  }
}

export async function interruptAllRunningWork(deps: ApplicationShutdownDeps): Promise<void> {
  const summary = collectRunningWorkSummary(deps);
  const interruptedThreadIds = new Set<string>();

  for (const thread of summary.runningThreads) {
    interruptedThreadIds.add(thread.threadId);
    if (thread.coreKind) {
      await deps.cancelThreadRuntime(thread.coreKind, thread.threadId);
    }
    deps.abortActiveRun(thread.threadId, "application quitting");
    deps.cancelClarifications(thread.threadId, "application quitting");
    deps.cancelBashApprovals(thread.threadId, "application quitting");
    deps.cancelPlanApprovals(thread.threadId, "application quitting");
    deps.settleRecoveredLifecycleRecords(thread.threadId, "cancelled");

    const pendingPlan = deps.getPendingPlan(thread.threadId);
    if (pendingPlan) {
      deps.updateThreadOnQuit(thread.threadId, {
        status: "awaiting_plan",
        message: "",
      });
      deps.emitThreadQuitEvent(
        thread.threadId,
        "thread.awaiting_plan",
        translateCatalog(deps.locale(), "app.quit.preservePendingPlan"),
      );
    } else {
      deps.updateThreadOnQuit(thread.threadId, {
        status: "idle",
        message: "",
      });
      deps.emitThreadQuitEvent(
        thread.threadId,
        "thread.idle",
        translateCatalog(deps.locale(), "app.quit.interruptedRun"),
      );
    }
    if (!thread.runtimeActive) {
      deps.finishActiveRun(thread.threadId);
    }
  }

  for (const threadId of summary.compactingThreadIds) {
    interruptedThreadIds.add(threadId);
    deps.abortActiveRun(threadId, "application quitting");
  }

  deps.stopAllBackgroundTasks();
  deps.killAllInteractiveTerminals();
  await waitForActiveRunsToSettle(deps, [...interruptedThreadIds]);
}

export async function shutdownApplicationServices(deps: ApplicationShutdownDeps): Promise<void> {
  await deps.stopAllPiRuntimes();
  await deps.disposeSystemSleepBlocker();
  deps.disposeDesktopUpdateService();
  await deps.disposeBrowserHost();
  await deps.closeImageGenerationGateway();
  await deps.closeImageViewGateway();
  await deps.closeImageDisplayGateway();
  await deps.closeIntegratedWebSearchGateway();
  await deps.closeMcpHubGateway();
  deps.clearCodexSubagentRuntimeLimit();
  deps.flushAllThreadMetrics();
  deps.disposeCodexGatewayUsagePending();
  deps.clearCodexGatewayUsageDeduplicator();
  deps.disposeGitAutoFetcher();
  deps.disposeCenterServerClient();
  await deps.stopGlobalCodexRuntime();
  await deps.closeOpenAIAccountService?.();
  deps.stopAllAcpRuntimes();
  await deps.stopGlobalEcoGateway();
}

export async function shutdownApplication(deps: ApplicationShutdownDeps): Promise<void> {
  await interruptAllRunningWork(deps);
  await shutdownApplicationServices(deps);
}

export function shouldConfirmQuit(deps: ApplicationShutdownDeps): boolean {
  return hasRunningWork(collectRunningWorkSummary(deps)) && !shouldBypassQuitConfirmation();
}
