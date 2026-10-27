import fs from "node:fs";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import {
  buildEcoComputerUsePromptAppend,
  ECO_COMPUTER_USE_ALLOWED_TOOL,
  ECO_COMPUTER_USE_MCP_SERVER,
  ECO_COMPUTER_USE_TOOLS,
  shouldAutoApproveEcoComputerUseTools,
  type ComputerUseSettingsSnapshot,
} from "../shared/computer-use";
import type { McpSdkConfig } from "../shared/mcp";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { buildEcoHttpCodexServer, buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest } from "./mcp-streamable-http";
import { detectScreenRecordingAppLabel } from "./computer-use-screen-host-native";
import { openComputerUseAppBundleFromBinary } from "./open-computer-use-install";
import {
  resolveOpenComputerUseBinary,
  type OpenComputerUseResolveResult,
} from "./open-computer-use-resolve";
import { SharedMcpStdioUpstream } from "./shared-mcp-stdio-upstream";
import { saveComputerUseScreenshots } from "./computer-use-screenshots";

const require = createRequire(import.meta.url);
const CONTROL_SECRET_HEADER = "X-Eco-Computer-Use-Control-Secret";

function tryElectronDesktopApis(): {
  app?: { isPackaged?: boolean };
  desktopCapturer?: { getSources: (opts: { types: string[] }) => Promise<unknown> };
  shell?: { openExternal: (url: string) => Promise<void> };
  systemPreferences?: { getMediaAccessStatus: (mediaType: string) => string };
} | undefined {
  try {
    return require("electron") as {
      app?: { isPackaged?: boolean };
      desktopCapturer?: { getSources: (opts: { types: string[] }) => Promise<unknown> };
      shell?: { openExternal: (url: string) => Promise<void> };
      systemPreferences?: { getMediaAccessStatus: (mediaType: string) => string };
    };
  } catch {
    return undefined;
  }
}

/** Screen Recording TCC list name for the current Eco host process. */
export function resolveEcoScreenRecordingAppLabel(
  packaged: boolean = tryElectronDesktopApis()?.app?.isPackaged === true,
): string {
  return detectScreenRecordingAppLabel(packaged);
}

/** Screen Recording for MCP is attributed to Eco's responsible host, not the helper. */
export function getEcoScreenRecordingStatus(): "granted" | "missing" | "unknown" {
  const electron = tryElectronDesktopApis();
  const status = electron?.systemPreferences?.getMediaAccessStatus?.("screen");
  if (status === "granted") {
    return "granted";
  }
  if (status === "denied" || status === "restricted" || status === "not-determined") {
    return "missing";
  }
  return "unknown";
}

/**
 * Register the current host in Screen Recording and open that privacy pane.
 * Needed when only the host's screen TCC is missing — OCU `doctor` will not show UI
 * if Open Computer Use.app already has its own grants.
 */
export async function ensureEcoScreenRecordingPrompt(): Promise<void> {
  const electron = tryElectronDesktopApis();
  if (!electron || process.platform !== "darwin") {
    return;
  }
  try {
    await electron.desktopCapturer?.getSources?.({ types: ["screen"] });
  } catch {
    // Prompt / registration best-effort.
  }
  const urls = [
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  ];
  for (const url of urls) {
    try {
      await electron.shell?.openExternal?.(url);
      break;
    } catch {
      // try fallback
    }
  }
}

/** `open -n <abs.app> --args doctor` — path form; `-a` rejects relative / unregistered names. */
export function buildOpenComputerUseDoctorOpenArgs(appBundlePath: string): string[] {
  return ["-n", path.resolve(appBundlePath), "--args", "doctor"];
}

export function describeMacOsComputerUsePermissionGap(
  missing: string[],
  screenApp: string = resolveEcoScreenRecordingAppLabel(),
): string {
  const needsAccessibility = missing.includes("accessibility");
  const needsScreen = missing.includes("screenRecording");
  if (needsAccessibility && needsScreen) {
    return `系统权限未就绪：请在「Open Computer Use」完成辅助功能授权；录屏请打开「${screenApp}」。`;
  }
  if (needsAccessibility) {
    return "系统权限未就绪：请在「Open Computer Use」完成辅助功能授权。";
  }
  if (needsScreen) {
    return `系统权限未就绪：录屏请打开「${screenApp}」（不是 Open Computer Use）。`;
  }
  return "系统权限未就绪。";
}

export interface ComputerUseMcpInjection {
  enabled: boolean;
  serverName: typeof ECO_COMPUTER_USE_MCP_SERVER;
  sdkEntry?: Record<string, unknown>;
  codexServer?: CodexMcpServerForConfigSync;
  allowedToolPattern?: string;
  autoApproveTools?: boolean;
  promptAppend?: string;
  unavailableReason?: string;
}

export interface ComputerUseFeatureAvailability {
  available: boolean;
  reason?: string;
  /** Raw doctor / permission-status stdout when probed. */
  doctorOutput?: string;
}

export type ComputerUseSettingsGetter = () => ComputerUseSettingsSnapshot;

const PERMISSION_STATUS_TIMEOUT_MS = 15_000;

export interface OpenComputerUsePermissionProbe {
  ok: boolean;
  /**
   * Missing gates:
   * - macOS: "accessibility" | "screenRecording"
   * - Linux: "desktopSession" when no graphical session env is visible
   */
  missing: string[];
  reason?: string;
  /** Raw command output (permission / doctor summary). */
  output?: string;
}

/** macOS alone has TCC Accessibility / Screen Recording + GUI onboarding. */
export function openComputerUseUsesMacOsPrivacyGate(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "darwin";
}

/**
 * Linux needs a signed-in graphical session for AT-SPI2.
 * We only detect session env here — doctor does not prove AT-SPI is installed/working.
 */
export function assessLinuxComputerUseSession(
  env: NodeJS.ProcessEnv = process.env,
): OpenComputerUsePermissionProbe {
  const display = env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim();
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (!display && !runtimeDir) {
    return {
      ok: false,
      missing: ["desktopSession"],
      reason:
        "未检测到 Linux 图形桌面会话（缺少 DISPLAY/WAYLAND_DISPLAY 与 XDG_RUNTIME_DIR）。请在已登录桌面中运行 Mori，并确保 AT-SPI2 可用；不支持无桌面的服务会话。",
    };
  }
  return {
    ok: true,
    missing: [],
    output: `linuxSession display=${display ? "yes" : "no"} xdgRuntimeDir=${runtimeDir ? "yes" : "no"}`,
  };
}

function runBinaryCommand(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; output: string; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (result: { code: number | null; output: string; timedOut: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({
        code: null,
        output: Buffer.concat(chunks).toString("utf8").trim(),
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ code: null, output: "", timedOut: false, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        code,
        output: Buffer.concat(chunks).toString("utf8").trim(),
        timedOut: false,
      });
    });
  });
}

/**
 * Windows/Linux `doctor` only prints runtime notes (no TCC GUI). Await exit;
 * exit 0 means the native runtime started and reported its notes.
 */
async function probeOpenComputerUseDoctorNotes(
  binaryPath: string,
  timeoutMs: number,
  platformLabel: string,
): Promise<OpenComputerUsePermissionProbe> {
  const result = await runBinaryCommand(binaryPath, ["doctor"], timeoutMs);
  const output = result.output;
  if (result.error) {
    return {
      ok: false,
      missing: [],
      reason: `无法启动 open-computer-use doctor（${platformLabel}）：${result.error}`,
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      missing: [],
      reason: `open-computer-use doctor timed out（${platformLabel}）`,
      output,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      missing: [],
      reason:
        output ||
        `open-computer-use doctor 失败（${platformLabel}，退出码 ${result.code ?? "unknown"}）`,
      output,
    };
  }
  return { ok: true, missing: [], output: output || `${platformLabel} doctor ok` };
}

async function probeDarwinPermissionStatus(
  binaryPath: string,
  timeoutMs: number,
): Promise<OpenComputerUsePermissionProbe> {
  const result = await runBinaryCommand(binaryPath, ["permission-status"], timeoutMs);
  const output = result.output;
  if (result.error) {
    return {
      ok: false,
      missing: [],
      reason: `无法启动 open-computer-use permission-status：${result.error}`,
    };
  }
  if (result.timedOut) {
    return { ok: false, missing: [], reason: "open-computer-use permission-status timed out", output };
  }
  const accessibility = /accessibility=(granted|missing)/.exec(output)?.[1];
  let screenRecording = /screenRecording=(granted|missing)/.exec(output)?.[1];
  if (!accessibility || !screenRecording) {
    return {
      ok: false,
      missing: [],
      reason:
        output ||
        `open-computer-use permission-status 失败（退出码 ${result.code ?? "unknown"}）`,
      output,
    };
  }

  let mergedOutput = output;
  const ecoScreen = getEcoScreenRecordingStatus();
  if (ecoScreen !== "unknown") {
    // MCP stdio child → Eco is responsible for Screen Recording.
    screenRecording = ecoScreen === "granted" ? "granted" : "missing";
    mergedOutput = `${output}; ecoScreenRecording=${ecoScreen}`;
  }

  const missing: string[] = [];
  if (accessibility === "missing") missing.push("accessibility");
  if (screenRecording === "missing") missing.push("screenRecording");
  return { ok: missing.length === 0, missing, output: mergedOutput };
}

/**
 * Platform-aware readiness probe.
 *
 * - macOS: `permission-status` (+ Eco Screen Recording merge). Safe to poll; no GUI.
 * - Windows: no Accessibility/Screen Recording TCC; `doctor` notes + interactive desktop.
 * - Linux: graphical session env + `doctor` notes (AT-SPI2). Does not prove AT-SPI works.
 */
export async function probeOpenComputerUsePermissionStatus(
  binaryPath: string,
  timeoutMs: number = PERMISSION_STATUS_TIMEOUT_MS,
): Promise<OpenComputerUsePermissionProbe> {
  if (process.platform === "darwin") {
    return probeDarwinPermissionStatus(binaryPath, timeoutMs);
  }
  if (process.platform === "win32") {
    return probeOpenComputerUseDoctorNotes(binaryPath, timeoutMs, "Windows");
  }
  if (process.platform === "linux") {
    const session = assessLinuxComputerUseSession();
    if (!session.ok) {
      return session;
    }
    const doctor = await probeOpenComputerUseDoctorNotes(binaryPath, timeoutMs, "Linux");
    if (!doctor.ok) {
      return doctor;
    }
    const parts = [session.output, doctor.output].filter(Boolean);
    return { ok: true, missing: [], output: parts.join("; ") };
  }
  return {
    ok: false,
    missing: [],
    reason: `电脑操控暂不支持平台 ${process.platform}`,
  };
}

let onboardingChild: ChildProcess | undefined;
let onboardingError: string | undefined;

export interface MacOsComputerUseRemediation {
  onboardingLaunched: boolean;
  screenPromptOpened: boolean;
  reason: string;
  screenRecordingAppLabel: string;
  onboardingError?: string;
}

/**
 * Launch the package's built-in permission onboarding window
 * ("Enable Open Computer Use"). macOS only — Windows/Linux `doctor` prints notes
 * and exits; it is not a TCC onboarding UI.
 *
 * OCU `doctor` only opens the GUI when *its own* Accessibility / Screen Recording
 * are missing. If Eco/Electron Screen Recording alone is missing, doctor exits
 * immediately with no window — use {@link ensureEcoScreenRecordingPrompt} instead.
 *
 * Prefer `open -n <Open Computer Use.app> --args doctor` (path form, not `-a`) so
 * LaunchServices owns the process.
 */
export function launchOpenComputerUseOnboarding(
  binaryPath: string,
  appBundlePath?: string,
): { launched: boolean; reason?: string } {
  if (!openComputerUseUsesMacOsPrivacyGate()) {
    return {
      launched: false,
      reason: "当前平台无 macOS 辅助功能/录屏授权窗口；请使用 doctor 运行时检查。",
    };
  }
  stopOpenComputerUseOnboarding();
  onboardingError = undefined;
  try {
    const bundle =
      appBundlePath?.trim() || openComputerUseAppBundleFromBinary(binaryPath);
    if (bundle) {
      const result = spawnSync("open", buildOpenComputerUseDoctorOpenArgs(bundle), {
        encoding: "utf8",
      });
      if (result.error) {
        onboardingError = `无法启动授权窗口：${result.error.message}`;
        return { launched: false, reason: onboardingError };
      }
      if (result.status !== 0) {
        const detail = [result.stderr, result.stdout].map((s) => s?.trim()).filter(Boolean).join(" ")
          || `open 退出码 ${result.status ?? "unknown"}`;
        onboardingError = `无法打开 Open Computer Use：${detail}`;
        return { launched: false, reason: onboardingError };
      }
      return { launched: true };
    }

    const child = spawn(binaryPath, ["doctor"], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4_000) {
        stderr = stderr.slice(-4_000);
      }
    });
    child.on("error", (error) => {
      onboardingError = `无法启动授权窗口：${error.message}`;
    });
    child.on("close", (code) => {
      if (onboardingChild !== child) {
        return;
      }
      onboardingChild = undefined;
      const tail = stderr.trim().slice(-500);
      if (code !== 0 && tail) {
        onboardingError = `授权窗口已退出（退出码 ${code}）：${tail}`;
      }
    });
    child.unref();
    onboardingChild = child;
    return { launched: true };
  } catch (error) {
    return {
      launched: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * macOS remediation after a failed permission probe.
 * - accessibility → Open Computer Use doctor window (only pops when OCU itself lacks grants)
 * - screenRecording alone → Screen Recording prefs for Eco/Electron (doctor exits with no UI)
 * - both → doctor window only (avoid Screen prefs stealing focus); reason still covers录屏
 */
export async function remediateMacOsComputerUsePermissions(
  binaryPath: string,
  appBundlePath: string | undefined,
  missing: string[],
): Promise<MacOsComputerUseRemediation> {
  const screenRecordingAppLabel = resolveEcoScreenRecordingAppLabel();
  const reason = describeMacOsComputerUsePermissionGap(missing, screenRecordingAppLabel);
  const needsAccessibility = missing.includes("accessibility");
  const needsScreen = missing.includes("screenRecording");

  let onboardingLaunched = false;
  let screenPromptOpened = false;
  let launchError: string | undefined;

  if (needsAccessibility) {
    const launch = launchOpenComputerUseOnboarding(binaryPath, appBundlePath);
    onboardingLaunched = launch.launched;
    if (!launch.launched) {
      launchError = launch.reason ?? getOpenComputerUseOnboardingError();
    }
  } else if (needsScreen) {
    // Doctor will not show a window when OCU already has Accessibility + its own screen grant.
    await ensureEcoScreenRecordingPrompt();
    screenPromptOpened = true;
  } else {
    // Neither gate recognized — still try doctor so the user gets *some* UI.
    const launch = launchOpenComputerUseOnboarding(binaryPath, appBundlePath);
    onboardingLaunched = launch.launched;
    if (!launch.launched) {
      launchError = launch.reason ?? getOpenComputerUseOnboardingError();
    }
  }

  const onboardingError = launchError ?? getOpenComputerUseOnboardingError();
  return {
    onboardingLaunched,
    screenPromptOpened,
    screenRecordingAppLabel,
    reason: onboardingError ? `${reason} ${onboardingError}` : reason,
    ...(onboardingError ? { onboardingError } : {}),
  };
}

export function getOpenComputerUseOnboardingError(): string | undefined {
  return onboardingError;
}

export function stopOpenComputerUseOnboarding(): void {
  if (!onboardingChild) {
    return;
  }
  try {
    onboardingChild.kill();
  } catch {
    // ignore
  }
  onboardingChild = undefined;
}

function resolveStdioScriptPath(): string {
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packaging/eco-computer-use-mcp-stdio.mjs"),
    path.join(process.cwd(), "apps/desktop/packaging/eco-computer-use-mcp-stdio.mjs"),
    path.join(process.cwd(), "packaging/eco-computer-use-mcp-stdio.mjs"),
  ];
  try {
    const electron = require("electron") as {
      app?: { getAppPath?: () => string };
    };
    if (electron.app?.getAppPath) {
      candidates.unshift(path.join(electron.app.getAppPath(), "packaging/eco-computer-use-mcp-stdio.mjs"));
    }
    if (typeof process.resourcesPath === "string") {
      candidates.unshift(path.join(process.resourcesPath, "packaging/eco-computer-use-mcp-stdio.mjs"));
      candidates.unshift(path.join(process.resourcesPath, "eco-computer-use-mcp-stdio.mjs"));
    }
  } catch {
    // non-electron
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return candidates[0]!;
}

export class ComputerUseMcpGateway {
  private readonly controlSecret = createBrowserMcpControlSecret();
  private readonly auth = new BrowserMcpAuthRegistry();
  private controlServer: http.Server | undefined;
  private controlPort: number | undefined;
  private disposed = false;

  constructor(
    private readonly getSettings: ComputerUseSettingsGetter,
    private readonly screenshotDirectory: string,
    private readonly upstream: Pick<
      SharedMcpStdioUpstream,
      "pid" | "ensure" | "listTools" | "callTool" | "close"
    > = new SharedMcpStdioUpstream(),
  ) {}

  /** Test/diag: packaging script still ships for offline debugging. */
  static packagingStdioScriptPath(): string {
    return resolveStdioScriptPath();
  }

  /** Test/diag: shared upstream PID when running. */
  getSharedUpstreamPid(): number | undefined {
    return this.upstream.pid;
  }

  async start(): Promise<void> {
    if (this.controlServer || this.disposed) {
      return;
    }
    this.controlServer = http.createServer((req, res) => {
      void this.handleControl(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.controlServer!.listen(0, "127.0.0.1", () => resolve());
      this.controlServer!.once("error", reject);
    });
    this.controlPort = (this.controlServer.address() as AddressInfo).port;
  }

  get controlBaseUrl(): string {
    if (!this.controlPort) {
      throw new Error("Computer Use MCP control server not started");
    }
    return `http://127.0.0.1:${this.controlPort}`;
  }

  async close(): Promise<void> {
    this.disposed = true;
    stopOpenComputerUseOnboarding();
    await this.upstream.close();
    if (this.controlServer) {
      await new Promise<void>((resolve) => this.controlServer!.close(() => resolve()));
      this.controlServer = undefined;
      this.controlPort = undefined;
    }
  }

  disposeThread(threadId: string): void {
    this.auth.revokeThread(threadId);
  }

  resolveBinary(): OpenComputerUseResolveResult {
    return resolveOpenComputerUseBinary();
  }

  /**
   * Settings master switch must be on and binary present.
   * Does not run doctor (cheap UI poll). Use {@link checkFeatureAvailable} before enabling.
   */
  isFeatureAvailableQuick(): ComputerUseFeatureAvailability {
    const settings = this.getSettings();
    if (!settings.agentIntegrationEnabled) {
      return { available: false, reason: "电脑操控 Agent 能力未在设置中开启" };
    }
    const resolved = this.resolveBinary();
    if (!resolved.available || !resolved.binaryPath) {
      return { available: false, reason: resolved.reason ?? "open-computer-use 不可用" };
    }
    return { available: true };
  }

  /** Full gate used when turning the master switch on (includes permission check). */
  async checkFeatureAvailable(): Promise<
    ComputerUseFeatureAvailability & {
      onboardingLaunched?: boolean;
      screenPromptOpened?: boolean;
    }
  > {
    const resolved = this.resolveBinary();
    if (!resolved.available || !resolved.binaryPath) {
      return { available: false, reason: resolved.reason ?? "open-computer-use 不可用" };
    }
    const probe = await probeOpenComputerUsePermissionStatus(resolved.binaryPath);
    if (!probe.ok) {
      if (openComputerUseUsesMacOsPrivacyGate()) {
        const remediation = await remediateMacOsComputerUsePermissions(
          resolved.binaryPath,
          resolved.appBundlePath,
          probe.missing,
        );
        return {
          available: false,
          reason: remediation.reason,
          onboardingLaunched: remediation.onboardingLaunched,
          screenPromptOpened: remediation.screenPromptOpened,
          ...(probe.output ? { doctorOutput: probe.output } : {}),
        };
      }
      return {
        available: false,
        reason: probe.reason ?? "电脑操控运行时未就绪",
        onboardingLaunched: false,
        ...(probe.output ? { doctorOutput: probe.output } : {}),
      };
    }
    return {
      available: true,
      ...(probe.output ? { doctorOutput: probe.output } : {}),
    };
  }

  getAgentPromptAppend(sessionEnabled: boolean): string | undefined {
    if (!sessionEnabled || !this.getSettings().agentIntegrationEnabled) {
      return undefined;
    }
    return buildEcoComputerUsePromptAppend();
  }

  async resolveGlobalCodexServer(): Promise<CodexMcpServerForConfigSync | undefined> {
    if (!this.getSettings().agentIntegrationEnabled) {
      return undefined;
    }
    const resolved = this.resolveBinary();
    if (!resolved.available || !resolved.binaryPath) {
      throw new Error(resolved.reason ?? "open-computer-use unavailable");
    }
    await this.start();
    return buildEcoHttpCodexServer({
      name: ECO_COMPUTER_USE_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      enabledTools: [...ECO_COMPUTER_USE_TOOLS],
    });
  }

  async resolveInjection(input: {
    threadId: string;
    sessionEnabled: boolean;
  }): Promise<ComputerUseMcpInjection> {
    const settings = this.getSettings();
    if (!settings.agentIntegrationEnabled) {
      return { enabled: false, serverName: ECO_COMPUTER_USE_MCP_SERVER };
    }
    if (!input.sessionEnabled) {
      return { enabled: false, serverName: ECO_COMPUTER_USE_MCP_SERVER };
    }
    const resolved = this.resolveBinary();
    if (!resolved.available || !resolved.binaryPath) {
      return {
        enabled: false,
        serverName: ECO_COMPUTER_USE_MCP_SERVER,
        unavailableReason: resolved.reason ?? "open-computer-use 不可用",
      };
    }
    await this.start();
    const autoApproveTools = shouldAutoApproveEcoComputerUseTools(settings.actionApprovalMode);
    const auth = this.auth.ensure(input.threadId);
    const http = buildEcoHttpInjection({
      name: ECO_COMPUTER_USE_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      authToken: auth.token,
      enabledTools: [...ECO_COMPUTER_USE_TOOLS],
    });
    return {
      enabled: true,
      serverName: ECO_COMPUTER_USE_MCP_SERVER,
      sdkEntry: http.sdkEntry,
      codexServer: http.codexServer,
      allowedToolPattern: ECO_COMPUTER_USE_ALLOWED_TOOL,
      autoApproveTools,
      promptAppend: buildEcoComputerUsePromptAppend(),
    };
  }

  mergeIntoSdkConfig(base: McpSdkConfig, injection: ComputerUseMcpInjection): McpSdkConfig {
    if (!injection.enabled || !injection.sdkEntry) {
      return base;
    }
    const allowedTools = [...base.allowedTools];
    if (injection.autoApproveTools && injection.allowedToolPattern) {
      allowedTools.push(injection.allowedToolPattern);
    } else if (injection.allowedToolPattern) {
      const filtered = allowedTools.filter((tool) => tool !== injection.allowedToolPattern);
      return {
        mcpServers: { ...base.mcpServers, [ECO_COMPUTER_USE_MCP_SERVER]: injection.sdkEntry },
        allowedTools: [...new Set(filtered)],
      };
    }
    return {
      mcpServers: { ...base.mcpServers, [ECO_COMPUTER_USE_MCP_SERVER]: injection.sdkEntry },
      allowedTools: [...new Set(allowedTools)],
    };
  }

  private async ensureUpstream(): Promise<void> {
    const resolved = this.resolveBinary();
    if (!resolved.available || !resolved.binaryPath) {
      throw new Error(resolved.reason ?? "open-computer-use unavailable");
    }
    await this.upstream.ensure(resolved.binaryPath, ["mcp"]);
  }

  private async handleControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.disposed) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "disposed" }));
      return;
    }

    const urlPath = (req.url ?? "").split("?")[0] ?? "";
    if (urlPath === "/mcp" || urlPath.startsWith("/mcp/")) {
      await handleMcpStreamableHttpRequest(
        req,
        res,
        {
          serverName: ECO_COMPUTER_USE_MCP_SERVER,
          instructions: "Mori computer use (shared open-computer-use upstream).",
          listTools: async ({ signal }) => {
            await this.ensureUpstream();
            const listed = await this.upstream.listTools(signal);
            return {
              tools: listed.tools.filter(
                (tool): tool is { name: string; [key: string]: unknown } =>
                  Boolean(tool) &&
                  typeof tool === "object" &&
                  typeof (tool as { name?: unknown }).name === "string",
              ),
            };
          },
          callTool: async ({ name, arguments: args, signal }) => {
            await this.ensureUpstream();
            const result = await this.upstream.callTool(name, args, signal);
            const toolResult =
              result && typeof result === "object"
                ? (result as Record<string, unknown>)
                : { content: [{ type: "text", text: String(result ?? "") }] };
            return saveComputerUseScreenshots(toolResult, this.screenshotDirectory);
          },
        },
        {
          controlSecretHeader: "x-eco-computer-use-control-secret",
          controlSecret: this.controlSecret,
        },
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const secret = req.headers["x-eco-computer-use-control-secret"];
    if (secret !== this.controlSecret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    let body: Record<string, unknown> = {};
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    try {
      const url = req.url || "";
      if (url === "/v1/tool-started") {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) {
          throw new Error("tool-started requires name");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }
}
