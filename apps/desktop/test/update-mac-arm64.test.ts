import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedAppPids, startDetachedUpdate, updateMacArm64 } from "../scripts/update-mac-arm64.mjs";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eco-local-update-test-"));
  tempDirs.push(dir);
  const root = path.join(dir, "desktop");
  const applicationsDir = path.join(dir, "Applications");
  const source = path.join(root, "release", "mac-arm64", "Eco Coding.app");
  const target = path.join(applicationsDir, "Eco Coding.app");
  const executable = path.join("Contents", "MacOS", "Eco Coding");
  for (const [app, content] of [
    [source, "new"],
    [target, "old"],
  ] as const) {
    fs.mkdirSync(path.dirname(path.join(app, executable)), { recursive: true });
    fs.writeFileSync(path.join(app, executable), content);
  }
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const state = {
    failCommand: "",
    bundleId: "com.eco.coding",
    psSnapshots: [`123 S ${path.join(target, executable)}\n`, ""],
  };
  const signals: { pid: number; signal: string }[] = [];
  let psIndex = 0;
  let elapsed = 0;
  const run = (command: string, args: string[], options: Record<string, unknown> = {}) => {
    calls.push({ command, args, options });
    if (command === state.failCommand) throw new Error(`test failure: ${command}`);
    switch (command) {
      case "bun":
        return "";
      case "/usr/libexec/PlistBuddy":
        return `${state.bundleId}\n`;
      case "/bin/ps": {
        const snapshot = state.psSnapshots[Math.min(psIndex++, state.psSnapshots.length - 1)];
        assert.notEqual(snapshot, undefined);
        return snapshot;
      }
      case "/usr/bin/osascript":
        return "";
      case "/usr/bin/ditto": {
        const [from, to] = args;
        assert.ok(from && to);
        fs.cpSync(from, to, { recursive: true });
        return "";
      }
      case "/usr/bin/open":
        expect(fs.readFileSync(path.join(target, executable), "utf8")).toBe("new");
        return "";
      default:
        throw new Error(`unexpected command: ${command}`);
    }
  };
  return {
    root,
    source,
    target,
    applicationsDir,
    executable,
    state,
    calls,
    signals,
    options: {
      root,
      applicationsDir,
      platform: "darwin",
      arch: "arm64",
      run,
      now: () => elapsed,
      delay: async (ms: number) => {
        elapsed += ms;
      },
      signalProcess: (pid: number, signal: string) => {
        signals.push({ pid, signal });
      },
    },
  };
}

test("matches only processes executing inside the installed app, not dev or arguments", () => {
  expect(
    installedAppPids(
      `
    10 S /Applications/Eco Coding.app/Contents/MacOS/Eco Coding
    11 S /Applications/Eco Coding.app/Contents/Frameworks/Eco Coding Helper.app/Contents/MacOS/Eco Coding Helper
    12 S /Applications/Eco Coding Dev.app/Contents/MacOS/Eco Coding
    13 S /repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
    14 S /bin/sh -c echo /Applications/Eco Coding.app/Contents/MacOS/Eco Coding
    15 S /repo/release/mac-arm64/Eco Coding.app/Contents/MacOS/Eco Coding
    16 Ss /Applications/Eco Coding.app/Contents/Resources/agent-browser/agent-browser
    17 Z /Applications/Eco Coding.app/Contents/MacOS/Eco Coding
  `,
      "/Applications/Eco Coding.app",
    ),
  ).toEqual([10, 11, 16]);
});

test("packs, quits production, replaces the bundle and opens the exact installed path", async () => {
  const f = fixture();
  await updateMacArm64(f.options);
  expect(f.calls.map((call) => call.command)).toEqual([
    "bun",
    "/usr/libexec/PlistBuddy",
    "/bin/ps",
    "/usr/bin/osascript",
    "/bin/ps",
    "/usr/bin/ditto",
    "/usr/bin/open",
  ]);
  expect(f.calls[0]).toEqual({
    command: "bun",
    args: ["run", "pack:mac-arm64", "--dir"],
    options: { cwd: f.root },
  });
  expect(f.calls.find((call) => call.command === "/usr/bin/osascript")?.args).toEqual([
    "-e",
    `tell application ${JSON.stringify(f.target)} to quit`,
  ]);
  expect(f.calls.at(-1)?.args).toEqual(["-a", f.target]);
  expect(f.signals).toEqual([]);
  expect(fs.readdirSync(f.applicationsDir)).toEqual(["Eco Coding.app"]);
});

test("does not quit any app when production is not running", async () => {
  const f = fixture();
  f.state.psSnapshots = ["42 S /repo/Eco Coding Dev.app/Contents/MacOS/Electron\n"];
  await updateMacArm64(f.options);
  expect(f.calls.some((call) => call.command === "/usr/bin/osascript")).toBe(false);
  expect(f.signals).toEqual([]);
});

test("pack failure leaves the installed app and running processes untouched", async () => {
  const f = fixture();
  f.state.failCommand = "bun";
  await expect(updateMacArm64(f.options)).rejects.toThrow("test failure: bun");
  expect(f.calls.map((call) => call.command)).toEqual(["bun"]);
  expect(fs.readFileSync(path.join(f.target, f.executable), "utf8")).toBe("old");
});

test("missing artifact or wrong bundle ID fails before quitting production", async () => {
  const f = fixture();
  fs.rmSync(f.source, { recursive: true });
  await expect(updateMacArm64(f.options)).rejects.toThrow("ENOENT");
  expect(f.calls.map((call) => call.command)).toEqual(["bun"]);

  const other = fixture();
  other.state.bundleId = "com.eco.coding.dev";
  await expect(updateMacArm64(other.options)).rejects.toThrow("bundle ID 不匹配");
  expect(other.calls.some((call) => call.command === "/usr/bin/osascript")).toBe(false);
});

test("a quit failure stops installation", async () => {
  const f = fixture();
  f.state.failCommand = "/usr/bin/osascript";
  await expect(updateMacArm64(f.options)).rejects.toThrow("test failure: /usr/bin/osascript");
  expect(f.calls.some((call) => call.command === "/usr/bin/ditto")).toBe(false);
  expect(fs.readFileSync(path.join(f.target, f.executable), "utf8")).toBe("old");
});

test("allows the main process to quit normally before cleaning up helpers", async () => {
  const f = fixture();
  f.state.psSnapshots.splice(1, 0, `123 S ${path.join(f.target, f.executable)}\n`);
  await updateMacArm64(f.options);
  expect(f.calls.filter((call) => call.command === "/bin/ps")).toHaveLength(3);
  expect(f.signals).toEqual([]);
});

test("terminates a bundled daemon left behind after the main process quits", async () => {
  const f = fixture();
  const daemon = `124 Ss ${f.target}/Contents/Resources/agent-browser/agent-browser\n`;
  const dev = "42 S /repo/Eco Coding Dev.app/Contents/MacOS/Electron\n";
  const main = `123 S ${path.join(f.target, f.executable)}\n`;
  f.state.psSnapshots = [main + daemon + dev, daemon + dev, daemon + dev, dev];
  await updateMacArm64(f.options);
  expect(f.signals).toEqual([{ pid: 124, signal: "SIGTERM" }]);
  expect(f.calls.some((call) => call.command === "/usr/bin/ditto")).toBe(true);
});

test("cleans up an orphan daemon without AppleScript relaunching the app", async () => {
  const f = fixture();
  const daemon = `124 Ss ${f.target}/Contents/Resources/agent-browser/agent-browser\n`;
  f.state.psSnapshots = [daemon, daemon, ""];
  await updateMacArm64(f.options);
  expect(f.calls.some((call) => call.command === "/usr/bin/osascript")).toBe(false);
  expect(f.signals).toEqual([{ pid: 124, signal: "SIGTERM" }]);
});

test("escalates a stuck helper to SIGKILL and verifies it exits before replacing", async () => {
  const f = fixture();
  f.state.psSnapshots = [`124 S ${f.target}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n`];
  await updateMacArm64({
    ...f.options,
    cleanupTimeoutMs: 500,
    signalProcess: (pid: number, signal: string) => {
      f.signals.push({ pid, signal });
      expect(f.calls.some((call) => call.command === "/usr/bin/ditto")).toBe(false);
      if (signal === "SIGKILL") f.state.psSnapshots = [""];
    },
  });
  expect(f.signals).toEqual([
    { pid: 124, signal: "SIGTERM" },
    { pid: 124, signal: "SIGKILL" },
  ]);
  expect(f.calls.some((call) => call.command === "/usr/bin/ditto")).toBe(true);
});

test("rechecks executable ownership before signaling a PID that has been reused", async () => {
  const f = fixture();
  f.state.psSnapshots = [
    `124 S ${f.target}/Contents/Resources/agent-browser/agent-browser\n`,
    "124 S /repo/Eco Coding Dev.app/Contents/MacOS/Electron\n",
  ];
  await updateMacArm64(f.options);
  expect(f.signals).toEqual([]);
});

test("tolerates a helper exiting between the process listing and the signal", async () => {
  const f = fixture();
  const daemon = `124 S ${f.target}/Contents/Resources/agent-browser/agent-browser\n`;
  f.state.psSnapshots = [daemon, daemon, ""];
  await updateMacArm64({
    ...f.options,
    signalProcess: () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    },
  });
  expect(f.calls.some((call) => call.command === "/usr/bin/ditto")).toBe(true);
});

test("reports signal permission errors and leaves the installation untouched", async () => {
  const f = fixture();
  f.state.psSnapshots = [`124 S ${f.target}/Contents/Resources/agent-browser/agent-browser\n`];
  await expect(
    updateMacArm64({
      ...f.options,
      signalProcess: () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    }),
  ).rejects.toThrow("无法终止生产版进程（SIGTERM, PID 124:");
  expect(f.calls.some((call) => call.command === "/usr/bin/ditto")).toBe(false);
  expect(fs.readFileSync(path.join(f.target, f.executable), "utf8")).toBe("old");
});

test("reports the exact remaining helper after SIGKILL and stops installation", async () => {
  const f = fixture();
  const executable = `${f.target}/Contents/Resources/agent-browser/agent-browser`;
  f.state.psSnapshots = [`124 S ${executable}\n`];
  await expect(updateMacArm64({ ...f.options, cleanupTimeoutMs: 0 })).rejects.toThrow(
    `PID 124: ${executable}`,
  );
  expect(f.signals).toEqual([
    { pid: 124, signal: "SIGTERM" },
    { pid: 124, signal: "SIGKILL" },
  ]);
  expect(f.calls.some((call) => call.command === "/usr/bin/ditto")).toBe(false);
  expect(fs.readFileSync(path.join(f.target, f.executable), "utf8")).toBe("old");
});

test("a main-process quit timeout does not replace the bundle or force-kill active work", async () => {
  const f = fixture();
  f.state.psSnapshots = f.state.psSnapshots.slice(0, 1);
  await expect(updateMacArm64({ ...f.options, quitTimeoutMs: 0 })).rejects.toThrow("已停止更新");
  expect(f.calls.some((call) => call.command === "/usr/bin/ditto")).toBe(false);
  expect(f.signals).toEqual([]);
  expect(fs.readFileSync(path.join(f.target, f.executable), "utf8")).toBe("old");
});

test("copy failure preserves the previous installation and does not open an app", async () => {
  const f = fixture();
  f.state.failCommand = "/usr/bin/ditto";
  await expect(updateMacArm64(f.options)).rejects.toThrow("临时文件/旧版备份保留在");
  expect(fs.readFileSync(path.join(f.target, f.executable), "utf8")).toBe("old");
  expect(f.calls.some((call) => call.command === "/usr/bin/open")).toBe(false);
});

test("launch failure is reported and retains the previous bundle for recovery", async () => {
  const f = fixture();
  f.state.failCommand = "/usr/bin/open";
  await expect(updateMacArm64(f.options)).rejects.toThrow("安装或启动失败");
  const staging = fs.readdirSync(f.applicationsDir).find((name) => name.startsWith(".eco-local-update-"));
  assert.ok(staging);
  expect(fs.readFileSync(path.join(f.applicationsDir, staging, "previous.app", f.executable), "utf8")).toBe(
    "old",
  );
  expect(fs.readFileSync(path.join(f.target, f.executable), "utf8")).toBe("new");
});

test.skipIf(process.platform === "win32")("detached worker persists progress and errors", async () => {
  const f = fixture();
  const entryPath = path.join(f.root, "test-worker.mjs");
  fs.writeFileSync(
    entryPath,
    `
    console.log(process.argv[2]);
    setTimeout(() => {
      console.error("worker failure recorded");
      process.exitCode = 1;
    }, 10);
  `,
  );
  const { pid, logPath } = await startDetachedUpdate({ entryPath, cwd: f.root, logDir: f.root });
  expect(pid).toBeGreaterThan(0);
  const deadline = Date.now() + 5_000;
  while (!fs.readFileSync(logPath, "utf8").includes("worker failure recorded")) {
    if (Date.now() >= deadline) throw new Error("Detached test worker did not write its log");
    await Bun.sleep(10);
  }
  expect(fs.readFileSync(logPath, "utf8")).toContain("--worker");
  expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
});

test("rejects non-Apple-Silicon platforms before invoking commands", async () => {
  const f = fixture();
  await expect(updateMacArm64({ ...f.options, platform: "linux" })).rejects.toThrow("仅支持");
  await expect(updateMacArm64({ ...f.options, arch: "x64" })).rejects.toThrow("仅支持");
  expect(f.calls).toHaveLength(0);
});
