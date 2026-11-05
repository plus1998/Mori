import fs from "node:fs";
import { app, autoUpdater as nativeAutoUpdater, net, powerMonitor, session, shell } from "electron";
import electronUpdater from "electron-updater";
import {
  canRunAutomaticUpdateCheck,
  type DesktopReleaseManifest,
  type DesktopUpdateMode,
  type DesktopUpdateProgress,
  type DesktopUpdateState,
} from "../shared/desktop-update";
import { setApplicationQuitBypassConfirmation } from "./application-quit-bypass";
import { applyDesktopAutoUpdaterPolicy, formatDesktopUpdateError } from "./desktop-update-policy";

const { autoUpdater } = electronUpdater;

const STARTUP_CHECK_DELAY_MS = 10_000;
/** Align with VS Code default periodic update cadence. */
const PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
/** Throttle resume/online-style auto checks so lid-open storms do not hammer the feed. */
const MIN_AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1_000;
const INSTALL_MONITOR_STARTUP_TIMEOUT_MS = 3_000;

interface DesktopUpdateServiceOptions {
  manifestPath: string;
  onStateChange: (state: DesktopUpdateState) => void;
  /** Outbound proxy URL (http/https/socks5/socks); routes update check/download through it. */
  getOutboundProxyUrl?: (() => string | undefined) | undefined;
  installMonitor?: {
    start: (version: string, signal: AbortSignal) => Promise<void>;
    failed: (error: string) => void;
  };
  installMonitorStartupTimeoutMs?: number;
}

export class DesktopUpdateService {
  private readonly manifestPath: string;
  private readonly onStateChange: (state: DesktopUpdateState) => void;
  private readonly getOutboundProxyUrl: (() => string | undefined) | undefined;
  private readonly currentVersion: string;
  private manifest: DesktopReleaseManifest | undefined;
  private state: DesktopUpdateState;
  private started = false;
  private checkPromise: Promise<DesktopUpdateState> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private periodicTimer: ReturnType<typeof setInterval> | undefined;
  private lastAutoCheckAt = 0;
  private readonly installMonitor: DesktopUpdateServiceOptions["installMonitor"];
  private readonly installMonitorStartupTimeoutMs: number;
  private readonly onNativeUpdateDownloaded = (): void => {
    if (this.state.phase === "preparing") this.setState({ phase: "downloaded" });
  };
  private readonly onPowerResume = (): void => {
    void this.checkForUpdates(false, { throttle: true });
  };

  constructor(options: DesktopUpdateServiceOptions) {
    this.manifestPath = options.manifestPath;
    this.onStateChange = options.onStateChange;
    this.getOutboundProxyUrl = options.getOutboundProxyUrl;
    this.installMonitor = options.installMonitor;
    this.installMonitorStartupTimeoutMs = options.installMonitorStartupTimeoutMs ?? INSTALL_MONITOR_STARTUP_TIMEOUT_MS;
    this.currentVersion = app.getVersion();
    this.manifest = this.readManifest();
    this.state = this.resolveInitialState();
  }

  getState(): DesktopUpdateState {
    return this.state;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.emitState();
    if (this.state.capability !== "auto") {
      return;
    }

    this.configureUpdater();
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.checkForUpdates(false);
    }, STARTUP_CHECK_DELAY_MS);
    this.periodicTimer = setInterval(() => {
      void this.checkForUpdates(false);
    }, PERIODIC_CHECK_INTERVAL_MS);
    powerMonitor.on("resume", this.onPowerResume);
  }

  /**
   * @param explicit - User/IPC initiated checks always run; automatic checks skip busy phases.
   * @param options.throttle - Resume-style auto checks respect a minimum interval.
   */
  async checkForUpdates(explicit = true, options?: { throttle?: boolean }): Promise<DesktopUpdateState> {
    if (this.state.capability !== "auto") {
      return this.state;
    }
    if (["downloading", "preparing", "downloaded", "installing"].includes(this.state.phase)) {
      return this.state;
    }
    if (this.checkPromise) {
      return this.checkPromise;
    }
    if (!explicit) {
      if (!canRunAutomaticUpdateCheck(this.state.phase)) {
        return this.state;
      }
      if (!net.isOnline()) {
        return this.state;
      }
      const now = Date.now();
      if (
        options?.throttle &&
        this.lastAutoCheckAt > 0 &&
        now - this.lastAutoCheckAt < MIN_AUTO_CHECK_INTERVAL_MS
      ) {
        return this.state;
      }
      this.lastAutoCheckAt = now;
    }

    this.setState({
      phase: "checking",
      error: undefined,
      reason: undefined,
      progress: undefined,
    });
    this.checkPromise = this.applyOutboundProxy()
      .then(() => autoUpdater.checkForUpdates())
      .then((result) => {
        if (result && !result.isUpdateAvailable && this.state.phase === "checking") {
          this.setState({ phase: "idle", reason: "up-to-date", availableVersion: undefined });
        }
        return this.state;
      })
      .catch((error: unknown) => {
        this.setState({
          phase: "error",
          reason: "download-failed",
          error: formatDesktopUpdateError(error),
        });
        return this.state;
      })
      .finally(() => {
        this.checkPromise = undefined;
      });
    return this.checkPromise;
  }

  async downloadUpdate(): Promise<DesktopUpdateState> {
    if (this.state.capability !== "auto" || this.state.phase !== "available") {
      return this.state;
    }
    // The feed may have advanced since the update was offered. Refresh the
    // updater's cached metadata before downloading, and never use it after a failed check.
    await this.checkForUpdates();
    if (this.state.phase !== "available") {
      return this.state;
    }
    try {
      this.setState({
        phase: "downloading",
        progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
        error: undefined,
        reason: undefined,
      });
      await autoUpdater.downloadUpdate();
      return this.state;
    } catch (error: unknown) {
      this.setState({
        phase: "error",
        reason: "download-failed",
        error: formatDesktopUpdateError(error),
      });
      return this.state;
    }
  }

  async installUpdate(): Promise<DesktopUpdateState> {
    if (this.state.phase !== "downloaded") {
      throw new Error("No downloaded update is ready to install.");
    }
    this.setState({ phase: "installing", error: undefined, monitorError: undefined });
    await this.startInstallMonitor();
    if (this.getState().phase !== "installing") return this.state;
    try {
      // Silent NSIS update; isForceRunAfter relaunches the app after /S install.
      setApplicationQuitBypassConfirmation(true);
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      setApplicationQuitBypassConfirmation(false);
      const message = formatDesktopUpdateError(error);
      this.notifyInstallMonitorFailure(message);
      this.setState({ phase: "downloaded", error: message });
    }
    return this.state;
  }

  private async startInstallMonitor(): Promise<void> {
    if (!this.installMonitor) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.installMonitor.start(this.state.availableVersion ?? "", controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Update progress window startup timed out; installation will continue.");
            controller.abort(error);
            reject(error);
          }, this.installMonitorStartupTimeoutMs);
        }),
      ]);
    } catch (error) {
      const message = formatDesktopUpdateError(error);
      this.writeLog("warn", `progress window unavailable; continuing installation: ${message}`);
      this.setState({ phase: this.state.phase, monitorError: message });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private notifyInstallMonitorFailure(message: string): void {
    try {
      this.installMonitor?.failed(message);
    } catch (error) {
      this.writeLog("warn", `could not notify progress window: ${formatDesktopUpdateError(error)}`);
    }
  }

  async openReleasePage(): Promise<{ ok: true }> {
    const releaseUrl = this.manifest?.releaseUrl;
    if (!releaseUrl) {
      throw new Error("Release page is unavailable.");
    }
    await shell.openExternal(releaseUrl);
    return { ok: true };
  }

  dispose(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }
    powerMonitor.removeListener("resume", this.onPowerResume);
    if (process.platform === "darwin") {
      nativeAutoUpdater.removeListener("update-downloaded", this.onNativeUpdateDownloaded);
    }
  }

  private configureUpdater(): void {
    const channel = this.manifest?.channel;
    const updateFeedUrl = this.manifest?.updateFeedUrl?.trim();
    if (!channel || !updateFeedUrl) {
      return;
    }
    autoUpdater.setFeedURL({
      provider: "generic",
      url: updateFeedUrl,
      channel,
      useMultipleRangeRequest: false,
    });
    applyDesktopAutoUpdaterPolicy(autoUpdater, channel);
    autoUpdater.logger = {
      info: (message) => this.writeLog("info", message),
      warn: (message) => this.writeLog("warn", message),
      error: (message) => this.writeLog("error", message),
      debug: (message) => this.writeLog("debug", message),
    };

    autoUpdater.on("checking-for-update", () => {
      this.setState({ phase: "checking", error: undefined, reason: undefined });
    });
    autoUpdater.on("update-available", (info) => {
      this.setState({
        phase: "available",
        availableVersion: info.version,
        progress: undefined,
        error: undefined,
        reason: undefined,
      });
    });
    autoUpdater.on("download-progress", (progress) => {
      const updateProgress: DesktopUpdateProgress = {
        percent: clampPercent(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      };
      this.setState({ phase: "downloading", progress: updateProgress, progressUpdatedAt: Date.now() });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.setState({
        // MacUpdater emits this before Squirrel finishes unzipping / validation.
        phase: process.platform === "darwin" ? "preparing" : "downloaded",
        availableVersion: info.version,
        progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
        error: undefined,
        reason: undefined,
      });
    });
    if (process.platform === "darwin") {
      nativeAutoUpdater.on("update-downloaded", this.onNativeUpdateDownloaded);
    }
    autoUpdater.on("update-not-available", () => {
      this.setState({
        phase: "idle",
        reason: "up-to-date",
        availableVersion: undefined,
        progress: undefined,
      });
    });
    autoUpdater.on("error", (error) => {
      if (this.state.phase === "installing") {
        setApplicationQuitBypassConfirmation(false);
        this.notifyInstallMonitorFailure(formatDesktopUpdateError(error));
      }
      this.setState({
        phase: "error",
        reason: "download-failed",
        error: formatDesktopUpdateError(error),
      });
    });
  }

  private async applyOutboundProxy(): Promise<void> {
    // electron-updater downloads on its own session partition; proxy only that
    // session so the rest of the app keeps its default connectivity.
    const netSession = session.fromPartition("electron-updater", { cache: false });
    const proxyUrl = this.getOutboundProxyUrl?.()?.trim();
    try {
      if (proxyUrl) {
        await netSession.setProxy({ proxyRules: proxyUrl, proxyBypassRules: "<-loopback>" });
      } else {
        await netSession.setProxy({});
      }
    } catch (error: unknown) {
      this.writeLog("warn", `apply update proxy failed: ${formatDesktopUpdateError(error)}`);
    }
  }

  private readManifest(): DesktopReleaseManifest | undefined {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
      if (!isReleaseManifest(parsed)) {
        throw new Error("Release manifest has an invalid shape.");
      }
      return parsed;
    } catch (error: unknown) {
      this.writeLog("warn", `release manifest unavailable: ${formatDesktopUpdateError(error)}`);
      return undefined;
    }
  }

  private resolveInitialState(): DesktopUpdateState {
    const base = {
      currentVersion: this.currentVersion,
      ...(this.manifest ? { channel: this.manifest.channel, releaseUrl: this.manifest.releaseUrl } : {}),
    };
    if (!app.isPackaged) {
      return { phase: "disabled", capability: "disabled", reason: "development", ...base };
    }
    if (!this.manifest) {
      return {
        phase: "disabled",
        capability: "disabled",
        reason: "release_manifest_missing",
        ...base,
      };
    }

    const platform = process.platform as keyof DesktopReleaseManifest["updateModes"];
    const mode = this.manifest.updateModes[platform];
    if (mode === "auto" && process.platform === "linux" && !process.env.APPIMAGE) {
      return {
        phase: "disabled",
        capability: "manual",
        reason: "not_appimage",
        ...base,
      };
    }
    if (mode === "manual" && process.platform === "darwin" && this.manifest.unsigned) {
      return {
        phase: "disabled",
        capability: "manual",
        reason: "unsigned_macos",
        ...base,
      };
    }
    if (mode !== "auto") {
      return {
        phase: "disabled",
        capability: mode ?? "disabled",
        reason: mode === undefined ? "unsupported_platform" : "platform_disabled",
        ...base,
      };
    }
    return { phase: "idle", capability: "auto", ...base };
  }

  private setState(patch: DesktopUpdateStatePatch): void {
    const next: DesktopUpdateState = { ...this.state, phase: patch.phase };
    if (patch.phase !== this.state.phase) next.phaseStartedAt = Date.now();
    if (patch.progressUpdatedAt !== undefined) next.progressUpdatedAt = patch.progressUpdatedAt;
    else if (patch.phase !== "downloading") delete next.progressUpdatedAt;
    if ("availableVersion" in patch) {
      if (patch.availableVersion === undefined) delete next.availableVersion;
      else next.availableVersion = patch.availableVersion;
    }
    if ("progress" in patch) {
      if (patch.progress === undefined) delete next.progress;
      else next.progress = patch.progress;
    }
    if ("reason" in patch) {
      if (patch.reason === undefined) delete next.reason;
      else next.reason = patch.reason;
    }
    if ("error" in patch) {
      if (patch.error === undefined) delete next.error;
      else next.error = patch.error;
    }
    if ("monitorError" in patch) {
      if (patch.monitorError === undefined) delete next.monitorError;
      else next.monitorError = patch.monitorError;
    }
    this.state = next;
    this.emitState();
  }

  private emitState(): void {
    this.onStateChange(this.state);
  }

  private writeLog(level: "debug" | "info" | "warn" | "error", message: unknown): void {
    const text = String(message).replaceAll(/\s+/g, " ").trim();
    process.stderr.write(`[eco-updater:${level}] ${text}\n`);
  }
}

type DesktopUpdateStatePatch = {
  phase: DesktopUpdateState["phase"];
  availableVersion?: DesktopUpdateState["availableVersion"] | undefined;
  progress?: DesktopUpdateState["progress"] | undefined;
  reason?: DesktopUpdateState["reason"] | undefined;
  error?: DesktopUpdateState["error"] | undefined;
  monitorError?: string | undefined;
  progressUpdatedAt?: number;
};

function isReleaseManifest(value: unknown): value is DesktopReleaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<DesktopReleaseManifest>;
  const updateModes = candidate.updateModes;
  return (
    typeof candidate.version === "string" &&
    (candidate.channel === "beta" || candidate.channel === "latest") &&
    typeof candidate.unsigned === "boolean" &&
    typeof candidate.releaseUrl === "string" &&
    typeof candidate.updateFeedUrl === "string" &&
    candidate.updateFeedUrl.length > 0 &&
    Boolean(updateModes) &&
    isUpdateMode(updateModes?.darwin) &&
    isUpdateMode(updateModes?.win32) &&
    isUpdateMode(updateModes?.linux)
  );
}

function isUpdateMode(value: unknown): value is DesktopUpdateMode {
  return value === "auto" || value === "manual" || value === "disabled";
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}
