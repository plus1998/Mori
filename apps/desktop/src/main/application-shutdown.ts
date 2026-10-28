import { app, type BrowserWindow, dialog } from "electron";
import {
  type ApplicationShutdownDeps,
  buildQuitConfirmationDialogOptions,
  collectRunningWorkSummary,
  type QuitConfirmationChoice,
  shouldBypassQuitConfirmation,
  shouldConfirmQuit,
  shutdownApplication,
} from "./application-shutdown-work";

export {
  type ApplicationShutdownDeps,
  buildQuitConfirmationDialogOptions,
  collectRunningWorkSummary,
  hasRunningWork,
  interruptAllRunningWork,
  isThreadActivelyRunning,
  type QuitConfirmationChoice,
  type QuitConfirmationDialogOptions,
  type RunningThreadSnapshot,
  type RunningWorkSummary,
  setApplicationQuitBypassConfirmation,
  shouldBypassQuitConfirmation,
  shouldConfirmQuit,
  shutdownApplication,
  shutdownApplicationServices,
} from "./application-shutdown-work";

let shutdownDeps: ApplicationShutdownDeps | undefined;
let applicationQuitting = false;

export function isApplicationQuitting(): boolean {
  return applicationQuitting;
}

/** Test seam — reset module quit state between cases. */
export function resetApplicationQuitStateForTests(): void {
  applicationQuitting = false;
}

export async function confirmQuitIfRunningWork(
  deps: ApplicationShutdownDeps,
  parentWindow?: BrowserWindow,
): Promise<QuitConfirmationChoice> {
  if (!shouldConfirmQuit(deps)) {
    return "quit";
  }

  const summary = collectRunningWorkSummary(deps);
  const parent =
    parentWindow && !parentWindow.isDestroyed()
      ? parentWindow
      : (() => {
          const fallback = deps.parentWindow?.();
          return fallback && !fallback.isDestroyed() ? fallback : undefined;
        })();
  const dialogOptions = buildQuitConfirmationDialogOptions(deps.locale(), summary);
  const { response } = parent
    ? await dialog.showMessageBox(parent, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);
  return response === 0 ? "quit" : "cancel";
}

async function requestApplicationQuit(
  deps: ApplicationShutdownDeps,
  parentWindow?: BrowserWindow,
): Promise<boolean> {
  if (applicationQuitting) {
    return true;
  }

  if (!shouldBypassQuitConfirmation()) {
    const choice = await confirmQuitIfRunningWork(deps, parentWindow);
    if (choice === "cancel") {
      return false;
    }
  }

  applicationQuitting = true;
  await shutdownApplication(deps);
  return true;
}

/**
 * Intercept the main window close button before the window is destroyed so the
 * confirmation dialog still has a visible parent.
 */
export function attachMainWindowQuitGuard(window: BrowserWindow, keepInBackground?: () => boolean): void {
  const deps = shutdownDeps;
  if (!deps) {
    throw new Error("Application shutdown hook is not installed.");
  }

  window.on("close", (event) => {
    if (applicationQuitting) {
      return;
    }
    if (keepInBackground?.()) {
      event.preventDefault();
      window.hide();
      return;
    }
    event.preventDefault();
    void (async () => {
      try {
        const proceed = await requestApplicationQuit(deps, window);
        if (!proceed) {
          return;
        }
        window.close();
      } catch (error) {
        applicationQuitting = false;
        deps.logError?.(error);
      }
    })();
  });
}

export function installApplicationShutdownHook(deps: ApplicationShutdownDeps): void {
  shutdownDeps = deps;

  app.on("before-quit", (event) => {
    if (applicationQuitting) {
      return;
    }
    event.preventDefault();
    void (async () => {
      try {
        const proceed = await requestApplicationQuit(deps);
        if (!proceed) {
          return;
        }
        app.quit();
      } catch (error) {
        applicationQuitting = false;
        deps.logError?.(error);
      }
    })();
  });
}
