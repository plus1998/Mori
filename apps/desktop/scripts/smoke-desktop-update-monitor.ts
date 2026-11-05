import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopUpdateInstallMonitor } from "../src/main/desktop-update-install-monitor";

// Probe files live outside the repository; no production userData or updater is used.
const entryPath = fileURLToPath(import.meta.url);
const testVersion = "999.0.0-monitor-smoke";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function monitor(root: string) {
  return new DesktopUpdateInstallMonitor({ userDataPath: () => root, locale: () => "zh-CN" });
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function until(done: () => boolean, timeoutMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(50);
  }
}

if (process.argv[2] === "--worker") {
  const root = process.argv[3];
  assert(root);
  const workerMonitor = monitor(root);
  await workerMonitor.start(testVersion, AbortSignal.timeout(10_000));
  workerMonitor.installing();
  // Exit naturally; the independent native process must remain alive.
} else {
  assert(process.platform === "darwin" || process.platform === "win32", "This smoke test requires macOS or Windows.");
  const root = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "mori-update-monitor-smoke-"));
  const sessions: { directory: string; helperPid: number }[] = [];
  const results: string[] = [];
  const report = (result: string) => { results.push(result); console.log(`PASS ${result}`); };
  try {
    async function launch() {
      const child = spawn(process.execPath, [entryPath, "--worker", root], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.on("data", chunk => { output += String(chunk); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error(`Test parent did not exit: ${output}`)); }, 15_000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`Test parent failed (${code}): ${output}`));
          else resolve();
        });
      });
      const session = JSON.parse(fs.readFileSync(path.join(root, "desktop-update-monitor.json"), "utf8"));
      const { pid: helperPid } = JSON.parse(fs.readFileSync(path.join(session.directory, "state.json.ready"), "utf8"));
      assert(Number.isInteger(helperPid) && helperPid > 0, "Missing native helper PID");
      sessions.push({ directory: session.directory, helperPid });
      assert(!alive(session.sourcePid), "Test parent must have exited");
      await delay(750);
      assert(alive(helperPid), `Native helper exited with the test parent: ${fs.readFileSync(path.join(session.directory, "monitor.log"), "utf8")}`);
      return { ...session, helperPid };
    }

    const first = await launch();
    report("测试父进程退出后，真实原生提示进程仍存活");
    if (process.argv.includes("--interactive")) {
      console.log("现在可手动关闭提示窗口；20 秒后模拟新版就绪，关闭提示窗口不会取消该模拟。");
      await delay(20_000);
    }
    monitor(root).complete(testVersion);
    await until(() => !alive(first.helperPid), 6000, "The native helper did not exit after completion");
    report("模拟新版界面就绪后，提示进程退出，完成信号不等待窗口回执");

    const second = await launch();
    process.kill(second.helperPid, "SIGTERM");
    await until(() => !alive(second.helperPid), 5000, "The native helper did not exit after SIGTERM");
    monitor(root).complete(testVersion);
    assert(!fs.existsSync(path.join(root, "desktop-update-monitor.json")));
    report("提示进程被终止后，模拟新版启动仍可完成");
    console.log(`模拟通过；未下载更新、未替换 Mori。报告：${path.join(root, "result.json")}`);
  } finally {
    for (const session of sessions) {
      if (alive(session.helperPid)) process.kill(session.helperPid, "SIGTERM");
      fs.rmSync(session.directory, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ platform: process.platform, results }, null, 2));
  }
}
