import { expect, test } from "bun:test";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assessLinuxComputerUseSession,
  buildOpenComputerUseDoctorOpenArgs,
  ComputerUseMcpGateway,
  describeMacOsComputerUsePermissionGap,
  launchOpenComputerUseOnboarding,
  openComputerUseUsesMacOsPrivacyGate,
  probeOpenComputerUsePermissionStatus,
  resolveEcoScreenRecordingAppLabel,
} from "../src/main/computer-use-mcp-gateway";

/** 跨平台的路径 fixture：POSIX 上保持原样，Windows 上是 `<当前盘>` 下的同一路径。 */
const APP_PATH = path.resolve(path.parse(process.cwd()).root, "tmp", "Open Computer Use.app");

test("eco-computer-use-mcp-stdio packaging script still exists for debug", () => {
  const packagingStdio = ComputerUseMcpGateway.packagingStdioScriptPath();
  expect(fs.existsSync(packagingStdio)).toBe(true);
  const src = fs.readFileSync(packagingStdio, "utf8");
  expect(src).toContain("/v1/tool-started");
  expect(src).toContain("ECO_OPEN_COMPUTER_USE_BINARY");
});

test("openComputerUseUsesMacOsPrivacyGate is darwin-only", () => {
  expect(openComputerUseUsesMacOsPrivacyGate("darwin")).toBe(true);
  expect(openComputerUseUsesMacOsPrivacyGate("win32")).toBe(false);
  expect(openComputerUseUsesMacOsPrivacyGate("linux")).toBe(false);
});

test("buildOpenComputerUseDoctorOpenArgs uses path form not -a", () => {
  const args = buildOpenComputerUseDoctorOpenArgs(
    APP_PATH,
  );
  expect(args).toEqual(["-n", APP_PATH, "--args", "doctor"]);
  expect(args).not.toContain("-a");
});

test("resolveEcoScreenRecordingAppLabel packaged uses Mori", () => {
  expect(resolveEcoScreenRecordingAppLabel(true)).toBe("Mori");
});

test("describeMacOsComputerUsePermissionGap uses provided screen host label", () => {
  const text = describeMacOsComputerUsePermissionGap(["screenRecording"], "Terminal");
  expect(text).toContain("Terminal");
  expect(text).not.toContain("Electron");
  expect(text).not.toContain("辅助功能");
});

test("assessLinuxComputerUseSession requires display or XDG_RUNTIME_DIR", () => {
  expect(assessLinuxComputerUseSession({}).ok).toBe(false);
  expect(assessLinuxComputerUseSession({}).missing).toContain("desktopSession");
  expect(assessLinuxComputerUseSession({ DISPLAY: ":0" }).ok).toBe(true);
  expect(assessLinuxComputerUseSession({ WAYLAND_DISPLAY: "wayland-0" }).ok).toBe(true);
  expect(assessLinuxComputerUseSession({ XDG_RUNTIME_DIR: "/run/user/1000" }).ok).toBe(true);
});

test("launchOpenComputerUseOnboarding refuses non-macOS hosts", () => {
  if (process.platform === "darwin") {
    return;
  }
  const result = launchOpenComputerUseOnboarding("/nonexistent/open-computer-use");
  expect(result.launched).toBe(false);
  expect(result.reason).toMatch(/macOS|授权窗口/);
});

test("probeOpenComputerUsePermissionStatus uses doctor notes on Windows", async () => {
  if (process.platform !== "win32") {
    return;
  }
  const binaryPath = path.join(
    process.cwd(),
    "node_modules/@qwen-code/open-computer-use/dist/windows/amd64/open-computer-use.exe",
  );
  if (!fs.existsSync(binaryPath)) {
    return;
  }
  const probe = await probeOpenComputerUsePermissionStatus(binaryPath);
  expect(probe.ok).toBe(true);
  expect(probe.missing).toEqual([]);
  expect(probe.output ?? "").toMatch(/UI Automation|Windows runtime/i);
});

test("resolveInjection uses shared HTTP MCP (no per-session Electron stdio)", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eco-computer-use-"));
  const gateway = new ComputerUseMcpGateway(
    () => ({
      agentIntegrationEnabled: true,
      actionApprovalMode: "always_allow",
    }),
    directory,
  );

  try {
    const first = await gateway.resolveInjection({
      threadId: "thr_presence",
      sessionEnabled: true,
    });
    const second = await gateway.resolveInjection({
      threadId: "thr_other",
      sessionEnabled: true,
    });
    if (!first.enabled || !first.sdkEntry || !second.enabled || !second.sdkEntry) {
      expect(first.enabled).toBe(false);
      return;
    }

    expect(first.sdkEntry.type).toBe("http");
    expect(String(first.sdkEntry.url)).toMatch(/\/mcp$/);
    expect(first.sdkEntry.url).toBe(second.sdkEntry.url);
    expect(first.codexServer?.transport).toBe("http");
    expect(first.sdkEntry).not.toHaveProperty("command");
    expect(first.sdkEntry.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();

    const headers = first.sdkEntry.headers as Record<string, string>;
    const response = await fetch(`${String(first.sdkEntry.url).replace(/\/mcp$/, "")}/v1/tool-started`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Eco-Computer-Use-Control-Secret": headers["X-Eco-Computer-Use-Control-Secret"]!,
      },
      body: JSON.stringify({
        name: "click",
        arguments: { x: 10, y: 20 },
        threadId: "thr_presence",
      }),
    });
    expect(response.ok).toBe(true);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});
