import type { BrowserWindow, RenderProcessGoneDetails } from "electron";

const RELOAD_DELAY_MS = 1_000;
const RETRY_WINDOW_MS = 60_000;

interface RecoveryOptions {
  canRecover: () => boolean;
  log: (phase: string, payload: Record<string, unknown>) => void;
  onFailure: () => void;
  now?: () => number;
}

/** Keep recovery in the main process: a crashed renderer cannot recover itself. */
export function attachRendererCrashRecovery(window: BrowserWindow, options: RecoveryOptions): void {
  const contents = window.webContents;
  const now = options.now ?? Date.now;
  let lastReloadAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let awaitingLoad = false;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const live = () => !window.isDestroyed() && !contents.isDestroyed() && options.canRecover();
  const log = (phase: string, payload: Record<string, unknown> = {}) =>
    options.log(`desktop.renderer-recovery.${phase}`, { webContentsId: contents.id, ...payload });

  contents.on("render-process-gone", (_event, details: RenderProcessGoneDetails) => {
    // V8 OOM can surface as `crashed` (SIGTRAP/exitCode 5 on macOS), not just `oom`.
    // Normal exits and intentional kills must not resurrect a renderer.
    clearTimer();
    awaitingLoad = false;
    if (!live() || (details.reason !== "oom" && details.reason !== "crashed")) return;
    if (lastReloadAt !== undefined && now() - lastReloadAt < RETRY_WINDOW_MS) {
      log("blocked", { reason: details.reason, exitCode: details.exitCode });
      options.onFailure();
      return;
    }
    log("scheduled", { reason: details.reason, exitCode: details.exitCode, delayMs: RELOAD_DELAY_MS });
    // Do not reload synchronously inside Chromium's process-exit dispatch.
    timer = setTimeout(() => {
      timer = undefined;
      if (!live()) return;
      lastReloadAt = now();
      awaitingLoad = true;
      try {
        log("reload");
        contents.reload();
      } catch (error) {
        awaitingLoad = false;
        log("failed", { message: error instanceof Error ? error.message : String(error) });
        options.onFailure();
      }
    }, RELOAD_DELAY_MS);
  });
  contents.on("did-finish-load", () => {
    if (!awaitingLoad) return;
    awaitingLoad = false;
    // Loading successfully does not reset the retry budget: boot can immediately OOM again.
    log("loaded");
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!awaitingLoad || !isMainFrame || errorCode === -3 || !live()) return;
    awaitingLoad = false;
    log("failed", { errorCode, errorDescription });
    options.onFailure();
  });
  contents.once("destroyed", clearTimer);
  window.once("closed", clearTimer);
}
