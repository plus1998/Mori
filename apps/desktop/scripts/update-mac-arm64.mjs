#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(scriptPath), "..");
const APP_NAME = "Eco Coding.app";
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
export function installedAppPids(psOutput, appPath) {
  const prefix = `${appPath}/Contents/`;
  return psOutput.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    return match?.[2].startsWith(prefix) ? [Number(match[1])] : [];
  });
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
} = {}) {
  assertSupportedPlatform(platform, arch);
  fs.accessSync(applicationsDir, fs.constants.W_OK);
  const source = path.join(root, "release", "mac-arm64", APP_NAME);
  const target = path.join(applicationsDir, APP_NAME);

  console.log("[1/4] 打包 macOS ARM64 应用……");
  run("bun", ["run", "pack:mac-arm64", "--dir"], { cwd: root });
  if (!fs.statSync(path.join(source, "Contents", "MacOS", "Eco Coding")).isFile()) {
    throw new Error(`打包产物缺少应用可执行文件：${source}`);
  }
  const bundleId = run(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", path.join(source, "Contents", "Info.plist")],
    { capture: true },
  ).trim();
  if (bundleId !== APP_ID) throw new Error(`打包产物 bundle ID 不匹配：${bundleId}`);

  console.log("[2/4] 退出 /Applications 中的生产版 Eco（不影响 dev 版）……");
  const listPids = () => installedAppPids(run("/bin/ps", ["-axo", "pid=,comm="], { capture: true }), target);
  if (listPids().length > 0) {
    // Target the exact installed bundle, not a name that may also identify dev.
    run("/usr/bin/osascript", ["-e", `tell application ${JSON.stringify(target)} to quit`], {
      timeout: quitTimeoutMs,
    });
    const deadline = now() + quitTimeoutMs;
    while (listPids().length > 0) {
      if (now() >= deadline) {
        throw new Error(
          `生产版 Eco 未在 ${quitTimeoutMs / 1000} 秒内完全退出，已停止更新；请退出应用及其子进程后重试。`,
        );
      }
      await delay(250);
    }
  }

  console.log("[3/4] 替换 /Applications/Eco Coding.app……");
  // Keep the old bundle until the complete new bundle is ready on the same volume.
  const stagingDir = fs.mkdtempSync(path.join(applicationsDir, ".eco-local-update-"));
  const staged = path.join(stagingDir, APP_NAME);
  const backup = path.join(stagingDir, "previous.app");
  try {
    run("/usr/bin/ditto", [source, staged]);
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    try {
      fs.renameSync(staged, target);
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, target);
      throw error;
    }
    console.log("[4/4] 打开新安装的 Eco……");
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

async function main() {
  assertSupportedPlatform(process.platform, process.arch);
  if (process.argv[2] === "--worker") {
    await updateMacArm64();
    return;
  }
  if (process.argv.length > 2) throw new Error("用法：bun run update:mac-arm64（无需额外参数）");
  const { pid, logPath } = await startDetachedUpdate();
  console.log(`本地更新任务已启动（PID ${pid}），打包成功后将退出并重新打开生产版 Eco。`);
  console.log(`查看进度及最终结果：tail -f ${JSON.stringify(logPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`[eco local update] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
