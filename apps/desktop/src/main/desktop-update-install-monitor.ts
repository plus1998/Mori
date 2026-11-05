import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppLocale } from "../shared/locale";
import { macUpdateMonitorScript, windowsUpdateMonitorScript } from "./desktop-update-monitor-scripts";

type MonitorPhase = "preparing" | "installing" | "completed" | "error";
interface MonitorSession {
  directory: string;
  version: string;
  sourcePid: number;
  startedAt: number;
  phase: MonitorPhase;
  error?: string;
  copy: ReturnType<typeof monitorCopy>;
}

export function monitorCopy(locale: AppLocale) {
  return locale === "zh-CN" ? {
    title: "Mori 更新",
    preparing: "正在准备重启…",
    installing: "正在安装并重新打开 Mori…",
    detail: "此窗口会在 Mori 退出后继续显示，新版界面就绪后自动关闭。关闭此窗口不会取消更新。",
    elapsed: "已用时 {time}",
    slow: "更新等待时间较长，尚未确认完成。可以继续等待，或稍后手动打开 Mori 检查。",
    completed: "更新完成",
    failed: "未能完成更新",
    versionMismatch: "重新打开的版本与目标版本不一致，请在应用中重新检查更新。",
  } : {
    title: "Mori Update",
    preparing: "Preparing to restart…",
    installing: "Installing and reopening Mori…",
    detail: "This window stays open after Mori quits and closes when the new version is ready. Closing it does not cancel the update.",
    elapsed: "Elapsed {time}",
    slow: "The update is taking longer than expected. Completion has not been confirmed. Keep waiting, or open Mori manually to check.",
    completed: "Update complete",
    failed: "Update could not be completed",
    versionMismatch: "The reopened version differs from the expected update. Check for updates again in the app.",
  };
}

export function monitorCommand(platform: string, scriptPath: string, statePath: string) {
  if (platform === "darwin") return { command: "/usr/bin/osascript", args: ["-l", "JavaScript", scriptPath, statePath] };
  if (platform === "win32") return {
    command: path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-StatePath", statePath],
  };
  throw new Error(`Update monitor is unsupported on ${platform}`);
}

/** A system UI process must survive app exit without holding the installed bundle open. */
export class DesktopUpdateInstallMonitor {
  private active: MonitorSession | undefined;
  constructor(private readonly options: {
    userDataPath: () => string;
    locale: () => AppLocale;
    platform?: string;
  }) {}

  private get pointerPath() { return path.join(this.options.userDataPath(), "desktop-update-monitor.json"); }

  async start(version: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const platform = this.options.platform ?? process.platform;
    // AppImage updates currently keep the in-app notice until exit.
    if (platform !== "darwin" && platform !== "win32") return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-update-monitor-"));
    fs.chmodSync(directory, 0o700);
    const statePath = path.join(directory, "state.json");
    const scriptPath = path.join(directory, platform === "darwin" ? "monitor.js" : "monitor.ps1");
    const session: MonitorSession = {
      directory, version, sourcePid: process.pid, startedAt: Date.now(), phase: "preparing",
      copy: monitorCopy(this.options.locale()),
    };
    fs.writeFileSync(scriptPath, platform === "darwin" ? macUpdateMonitorScript : windowsUpdateMonitorScript, { mode: 0o600 });
    this.writeSession(session);
    const { command, args } = monitorCommand(platform, scriptPath, statePath);
    const logPath = path.join(directory, "monitor.log");
    const logFd = fs.openSync(logPath, "wx", 0o600);
    const child = (() => {
      try { return spawn(command, args, { detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd] }); }
      finally { fs.closeSync(logFd); }
    })();
    let launchError: Error | undefined;
    let exited = false;
    child.once("error", error => { launchError = error; });
    child.once("exit", () => { exited = true; });
    child.unref();
    // Abort must terminate the helper before the app can quit; polling alone
    // could leave it behind if quitAndInstall exits before the next timer tick.
    const onAbort = () => { child.kill(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(`${statePath}.ready`)) {
        signal?.throwIfAborted();
        if (launchError) throw launchError;
        if (exited || Date.now() >= deadline) {
          const detail = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().slice(0, 1000) : "";
          throw new Error(`Update progress window did not open${detail ? `: ${detail}` : "."}`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      signal?.throwIfAborted();
      this.active = session;
      fs.writeFileSync(this.pointerPath, JSON.stringify(session), { mode: 0o600 });
    } catch (error) {
      child.kill();
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  installing(): void { this.publish("installing"); }
  failed(error: string): void { this.publish("error", error); }

  private publish(phase: MonitorPhase, error?: string): void {
    if (!this.active) return;
    this.active = { ...this.active, phase, ...(error ? { error } : {}) };
    // The user may close the helper without cancelling installation.
    if (fs.existsSync(this.active.directory)) this.writeSession(this.active);
  }

  private writeSession(session: MonitorSession): void {
    const target = path.join(session.directory, "state.json");
    try {
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(session), { mode: 0o600 });
      fs.renameSync(`${target}.tmp`, target);
    } catch (error) {
      // Closing the native window removes its directory; tolerate that precise race.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(session.directory)) return;
      throw error;
    }
  }

  /** Called only after the new renderer is ready, never merely after the old PID exits. */
  complete(currentVersion: string): void {
    if (!fs.existsSync(this.pointerPath)) return;
    const session: MonitorSession = JSON.parse(fs.readFileSync(this.pointerPath, "utf8"));
    if (session.sourcePid === process.pid) return;
    if (fs.existsSync(session.directory)) {
      this.writeSession({
        ...session,
        phase: session.version === currentVersion ? "completed" : "error",
        ...(session.version !== currentVersion ? { error: session.copy.versionMismatch } : {}),
      });
    }
    fs.rmSync(this.pointerPath);
  }
}
