import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { attachRendererCrashRecovery } from "../src/main/renderer-crash-recovery";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    id: 2,
    isDestroyed: () => false,
    reload: jest.fn(),
  });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: contents,
  });
  let quitting = false;
  let time = 0;
  const log = jest.fn();
  const onFailure = jest.fn();
  attachRendererCrashRecovery(window as unknown as BrowserWindow, {
    canRecover: () => !quitting,
    now: () => time,
    log,
    onFailure,
  });
  return {
    contents, window, log, onFailure,
    quit: () => { quitting = true; },
    advance: (ms: number) => { time += ms; jest.advanceTimersByTime(ms); },
    crash: (reason = "oom", exitCode = 0) =>
      contents.emit("render-process-gone", {}, { reason, exitCode }),
  };
}

test("recovers both explicit OOM and macOS V8 OOM reported as crashed, asynchronously", () => {
  for (const [reason, code] of [["oom", -536870904], ["crashed", 5]] as const) {
    const f = fixture();
    f.crash(reason, code);
    expect(f.contents.reload).not.toHaveBeenCalled();
    f.advance(1_000);
    expect(f.contents.reload).toHaveBeenCalledTimes(1);
    f.contents.emit("did-finish-load");
    expect(f.log).toHaveBeenCalledWith("desktop.renderer-recovery.loaded", { webContentsId: 2 });
    expect(f.onFailure).not.toHaveBeenCalled();
  }
});

test("successful page load does not permit an immediate crash loop; budget renews after a minute", () => {
  const f = fixture();
  f.crash();
  f.advance(1_000);
  f.contents.emit("did-finish-load");
  f.crash();
  f.advance(1_000);
  expect(f.contents.reload).toHaveBeenCalledTimes(1);
  expect(f.onFailure).toHaveBeenCalledTimes(1);
  f.advance(60_000);
  f.crash();
  f.advance(1_000);
  expect(f.contents.reload).toHaveBeenCalledTimes(2);
});

test("does not recover intentional kills or normal exits", () => {
  for (const reason of ["killed", "clean-exit", "abnormal-exit", "launch-failed", "integrity-failure"]) {
    const f = fixture();
    f.crash(reason);
    f.advance(1_000);
    expect(f.contents.reload).not.toHaveBeenCalled();
    expect(f.onFailure).not.toHaveBeenCalled();
  }
});

test("cancels recovery when the app quits, the window closes, or contents are destroyed", () => {
  for (const cancel of ["quit", "closed", "destroyed", "killed"]) {
    const f = fixture();
    f.crash();
    if (cancel === "quit") f.quit();
    else if (cancel === "closed") f.window.emit("closed");
    else if (cancel === "destroyed") f.contents.emit("destroyed");
    else f.crash("killed");
    f.advance(1_000);
    expect(f.contents.reload).not.toHaveBeenCalled();
  }
});

test("reports reload exceptions and main-frame navigation failures without retrying forever", () => {
  const thrown = fixture();
  thrown.contents.reload.mockImplementation(() => { throw new Error("reload failed"); });
  thrown.crash();
  thrown.advance(1_000);
  expect(thrown.onFailure).toHaveBeenCalledTimes(1);

  const failed = fixture();
  failed.crash();
  failed.advance(1_000);
  failed.contents.emit("did-fail-load", {}, -2, "subframe failed", "file:///", false);
  failed.contents.emit("did-fail-load", {}, -3, "aborted", "file:///", true);
  expect(failed.onFailure).not.toHaveBeenCalled();
  failed.contents.emit("did-fail-load", {}, -6, "file missing", "file:///", true);
  expect(failed.onFailure).toHaveBeenCalledTimes(1);
});
