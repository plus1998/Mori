#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(scriptPath), "..");
const APP_NAME = "Mori.app";
const LEGACY_APP_NAME = "Eco Coding.app";
const APP_ID = "com.eco.coding";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runCommand(command, args, { capture = false, ...options } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: desktopRoot,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} 执行失败（${result.signal ?? result.status}）${result.stderr ? `：${result.stderr.trim()}` : ""}`,
    );
  }
  return result.stdout ?? "";
}

function assertSupportedPlatform(platform, arch) {
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error("update:mac-arm64 仅支持 Apple Silicon macOS，请在原生 ARM64 终端中运行。");
  }
}

/** Match executable paths, never app names/arguments shared by production and dev. */
function installedAppProcesses(psOutput, appPath) {
  const prefix = `${appPath}/Contents/`;
  return psOutput.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/);
    // Zombies have already exited and cannot respond to signals.
    return match?.[3].startsWith(prefix) && !match[2].includes("Z")
      ? [{ pid: Number(match[1]), executable: match[3] }]
      : [];
  });
}

export function installedAppPids(psOutput, appPath) {
  return installedAppProcesses(psOutput, appPath).map(({ pid }) => pid);
}

/** Only detach when quitting the installed app would also terminate this caller. */
export function isRunningInsideInstalledApp({ ppid = process.ppid, target, run = runCommand } = {}) {
  const output = run("/bin/ps", ["-axo", "pid=,ppid=,comm="], { capture: true });
  const processes = new Map();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (match) processes.set(Number(match[1]), { ppid: Number(match[2]), executable: match[3] });
  }
  const visited = new Set();
  const targets = target
    ? [target]
    : [path.join("/Applications", APP_NAME), path.join("/Applications", LEGACY_APP_NAME)];
  while (ppid > 1 && !visited.has(ppid)) {
    visited.add(ppid);
    const entry = processes.get(ppid);
    if (!entry) throw new Error(`无法检测启动来源：父进程 PID ${ppid} 不在进程列表中。`);
    if (targets.some((appPath) => entry.executable.startsWith(`${appPath}/Contents/`))) return true;
    ppid = entry.ppid;
  }
  if (ppid > 1) throw new Error("无法检测启动来源：父进程链存在循环。");
  return false;
}

/** Also handles daemons orphaned by an earlier Eco exit, without relaunching Eco. */
export async function quitInstalledApp({
  target,
  run = runCommand,
  delay = sleep,
  now = Date.now,
  quitTimeoutMs = 30_000,
  cleanupTimeoutMs = 5_000,
  signalProcess = process.kill,
}) {
  const listProcesses = () =>
    installedAppProcesses(run("/bin/ps", ["-axo", "pid=,stat=,comm="], { capture: true }), target);
  const describe = (processes) =>
    processes.map(({ pid, executable }) => `PID ${pid}: ${executable}`).join("\n");
  const mainExecutable = path.join(target, "Contents", "MacOS", path.basename(target, ".app"));
  const hasMain = (processes) => processes.some(({ executable }) => executable === mainExecutable);
  const waitUntil = async (done, timeoutMs) => {
    const deadline = now() + timeoutMs;
    let remaining = listProcesses();
    while (!done(remaining) && now() < deadline) {
      await delay(250);
      remaining = listProcesses();
    }
    return remaining;
  };

  let remaining = listProcesses();
  if (hasMain(remaining)) {
    // Only send AppleScript to a running main process: otherwise it launches Eco.
    run("/usr/bin/osascript", ["-e", `tell application ${JSON.stringify(target)} to quit`], {
      timeout: quitTimeoutMs,
    });
    remaining = await waitUntil((processes) => !hasMain(processes), quitTimeoutMs);
    if (hasMain(remaining)) {
      throw new Error(
        `生产版 Mori 主进程未在 ${quitTimeoutMs / 1000} 秒内退出，已停止更新：\n${describe(remaining)}`,
      );
    }
  }

  // CLI daemons (e.g. agent-browser) may survive the main process and be reparented
  // to launchd. Re-read exact bundle paths before each signal; never kill by name.
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (remaining.length === 0) return;
    console.log(`清理生产版残留进程（${signal}）：\n${describe(remaining)}`);
    for (const { pid, executable } of listProcesses()) {
      try {
        signalProcess(pid, signal);
      } catch (error) {
        if (error.code === "ESRCH") continue; // Exited between ps and kill.
        throw new Error(`无法终止生产版进程（${signal}, PID ${pid}: ${executable}）：${error.message}`, {
          cause: error,
        });
      }
    }
    remaining = await waitUntil((processes) => processes.length === 0, cleanupTimeoutMs);
  }
  if (remaining.length > 0) {
    throw new Error(`生产版 Mori 仍有进程未退出，已停止更新：\n${describe(remaining)}`);
  }
}

/** Exported for isolated tests; importing this module never packs or quits Eco. */
export async function updateMacArm64({
  root = desktopRoot,
  applicationsDir = "/Applications",
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
  delay = sleep,
  now = Date.now,
  quitTimeoutMs = 30_000,
  cleanupTimeoutMs = 5_000,
  signalProcess = process.kill,
} = {}) {
  assertSupportedPlatform(platform, arch);
  fs.accessSync(applicationsDir, fs.constants.W_OK);
  const source = path.join(root, "release", "mac-arm64", APP_NAME);
  const target = path.join(applicationsDir, APP_NAME);
  const legacyTarget = path.join(applicationsDir, LEGACY_APP_NAME);

  console.log("[1/4] 打包 macOS ARM64 应用……");
  run("bun", ["run", "pack:mac-arm64", "--dir"], { cwd: root });
  if (!fs.statSync(path.join(source, "Contents", "MacOS", "Mori")).isFile()) {
    throw new Error(`打包产物缺少应用可执行文件：${source}`);
  }
  const bundleId = run(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", path.join(source, "Contents", "Info.plist")],
    { capture: true },
  ).trim();
  if (bundleId !== APP_ID) throw new Error(`打包产物 bundle ID 不匹配：${bundleId}`);

  console.log("[2/4] 退出 /Applications 中的生产版 Mori / Eco Coding（不影响 dev 版）……");
  for (const installedTarget of [target, legacyTarget]) {
    await quitInstalledApp({
      target: installedTarget,
      run,
      delay,
      now,
      quitTimeoutMs,
      cleanupTimeoutMs,
      signalProcess,
    });
  }

  console.log("[3/4] 安装 /Applications/Mori.app……");
  // Keep the old bundle until the complete new bundle is ready on the same volume.
  const stagingDir = fs.mkdtempSync(path.join(applicationsDir, ".eco-local-update-"));
  const staged = path.join(stagingDir, APP_NAME);
  const backup = path.join(stagingDir, "previous.app");
  const legacyBackup = path.join(stagingDir, "previous-eco.app");
  try {
    run("/usr/bin/ditto", [source, staged]);
    try {
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      if (fs.existsSync(legacyTarget)) fs.renameSync(legacyTarget, legacyBackup);
      fs.renameSync(staged, target);
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, target);
      if (fs.existsSync(legacyBackup)) fs.renameSync(legacyBackup, legacyTarget);
      throw error;
    }
    console.log("[4/4] 打开新安装的 Mori……");
    run("/usr/bin/open", ["-a", target]);
    fs.rmSync(stagingDir, { recursive: true });
  } catch (error) {
    throw new Error(`安装或启动失败；临时文件/旧版备份保留在 ${stagingDir}：${error.message}`, {
      cause: error,
    });
  }
  console.log(`更新完成：${target}`);
}

export async function startDetachedUpdate({
  entryPath = scriptPath,
  cwd = desktopRoot,
  logDir = os.tmpdir(),
} = {}) {
  // Quitting Eco must not kill an update launched from Eco's integrated terminal.
  const logPath = path.join(logDir, `eco-update-mac-arm64-${Date.now()}-${process.pid}.log`);
  const logFd = fs.openSync(logPath, "wx", 0o600);
  try {
    const child = spawn("/usr/bin/nohup", [process.execPath, entryPath, "--worker"], {
      cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
    return { pid: child.pid, logPath };
  } finally {
    fs.closeSync(logFd);
  }
}

export async function main({
  args = process.argv.slice(2),
  platform = process.platform,
  arch = process.arch,
  detect = isRunningInsideInstalledApp,
  update = updateMacArm64,
  detach = startDetachedUpdate,
} = {}) {
  assertSupportedPlatform(platform, arch);
  if (args.length === 1 && args[0] === "--worker") {
    await update();
    return;
  }
  if (args.length > 0) throw new Error("用法：bun run update:mac-arm64（无需额外参数）");
  if (!detect()) {
    await update();
    return;
  }
  const { pid, logPath } = await detach();
  console.log(`本地更新任务已启动（PID ${pid}），打包成功后将退出并重新打开生产版 Mori。`);
  console.log(`查看进度及最终结果：tail -f ${JSON.stringify(logPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`[eco local update] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
