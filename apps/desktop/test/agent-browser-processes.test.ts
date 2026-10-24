import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentBrowserProcesses } from "../src/main/agent-browser-processes";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eco-ab-processes-"));
  dirs.push(root);
  const binaryPath = fs.realpathSync.native(process.execPath);
  const live = new Map<number, { executable: string; startedAt: number }>();
  const signals: { pid: number; signal: string | number | undefined }[] = [];
  const state = { ignoreTerm: false, ignoreKill: false };
  const manager = new AgentBrowserProcesses({
    inspect: async (pids) =>
      new Map(
        pids.flatMap((pid) => {
          const identity = live.get(pid);
          return identity ? [[pid, identity] as const] : [];
        }),
      ),
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      if ((signal === "SIGTERM" && !state.ignoreTerm) || (signal === "SIGKILL" && !state.ignoreKill))
        live.delete(pid);
      return true;
    },
    delay: async () => {},
    timeoutMs: 200,
  });
  const session = (key: string, pid: number, threadId = "thread-a", base = root) => {
    const socketDir = path.join(base, key);
    fs.mkdirSync(socketDir, { recursive: true });
    const pidFile = path.join(socketDir, `${key}.pid`);
    fs.writeFileSync(pidFile, String(pid));
    live.set(pid, { executable: binaryPath, startedAt: fs.statSync(pidFile).mtimeMs - 100 });
    return { sessionKey: key, threadId, binaryPath, env: { AGENT_BROWSER_SOCKET_DIR: socketDir }, pidFile };
  };
  return { root, binaryPath, live, signals, state, manager, session };
}

test("discovers earlier Eco daemons and associates their session with a conversation", async () => {
  const f = fixture();
  const input = f.session("e0000000001", 101);
  expect(await f.manager.list(f.root, f.binaryPath, new Map([[input.sessionKey, "thread-a"]]))).toEqual([
    { id: input.sessionKey, pid: 101, threadId: "thread-a", state: "idle" },
  ]);
  await f.manager.stop(f.root);
  expect(f.signals).toEqual([{ pid: 101, signal: "SIGTERM" }]);
  expect(await f.manager.list(f.root, f.binaryPath)).toEqual([]);
});

test("recovers the recorded executable and owner after Eco restarts with another binary", async () => {
  const f = fixture();
  const input = f.session("e0000000001", 101);
  fs.writeFileSync(
    path.join(path.dirname(input.pidFile), `${input.sessionKey}.eco-process.json`),
    JSON.stringify({
      binaryPath: "/previous/dependency/agent-browser",
      threadId: "older-thread",
      browserId: "older-page",
    }),
  );
  f.live.set(101, {
    executable: "/previous/dependency/agent-browser",
    startedAt: fs.statSync(input.pidFile).mtimeMs - 100,
  });
  expect(await f.manager.list(f.root, f.binaryPath)).toEqual([
    { id: input.sessionKey, pid: 101, threadId: "older-thread", browserId: "older-page", state: "idle" },
  ]);
  await f.manager.stop(f.root);
  expect(f.signals).toEqual([{ pid: 101, signal: "SIGTERM" }]);
});

test("keeps ownership when an upgraded client replaces an older daemon", async () => {
  const f = fixture();
  const input = f.session("e0000000001", 101);
  fs.writeFileSync(
    path.join(path.dirname(input.pidFile), `${input.sessionKey}.eco-process.json`),
    JSON.stringify({
      binaryPath: "/previous/dependency/agent-browser",
      threadId: input.threadId,
    }),
  );
  f.live.set(101, {
    executable: "/previous/dependency/agent-browser",
    startedAt: fs.statSync(input.pidFile).mtimeMs - 100,
  });
  await f.manager.list(f.root, f.binaryPath);
  await f.manager.run(input, undefined, async () => {
    fs.writeFileSync(input.pidFile, "102");
    f.live.delete(101);
    f.live.set(102, { executable: f.binaryPath, startedAt: fs.statSync(input.pidFile).mtimeMs - 100 });
  });
  expect((await f.manager.list(f.root, f.binaryPath))[0]?.pid).toBe(102);
  await f.manager.stop(f.root);
  expect(f.signals).toEqual([{ pid: 102, signal: "SIGTERM" }]);
});

test("a process inspection failure is reported instead of an empty resource list", async () => {
  const f = fixture();
  f.session("e0000000001", 101);
  const manager = new AgentBrowserProcesses({
    inspect: async () => {
      throw new Error("ps permission denied");
    },
    signal: () => {
      throw new Error("must not signal an unverified process");
    },
    delay: async () => {},
    timeoutMs: 0,
  });
  await expect(manager.list(f.root, f.binaryPath)).rejects.toThrow("ps permission denied");
  await expect(manager.stop(f.root)).rejects.toThrow("ps permission denied");
});

test("stopping one session preserves another conversation and the other Eco instance", async () => {
  const f = fixture();
  const first = f.session("e0000000001", 101);
  const second = f.session("e0000000002", 102, "thread-b");
  const devRoot = path.join(f.root, "dev");
  const dev = f.session("e0000000003", 103, "dev", devRoot);
  for (const input of [first, second, dev]) await f.manager.run(input, undefined, async () => "ok");
  await f.manager.stop(f.root, new Set([first.sessionKey]));
  expect(f.signals).toEqual([{ pid: 101, signal: "SIGTERM" }]);
  expect(f.live.has(102)).toBe(true);
  expect(f.live.has(103)).toBe(true);
  await f.manager.stop(f.root);
  expect(f.live.has(103)).toBe(true);
});

test("an idle daemon survives a completed tool call until explicitly stopped", async () => {
  const f = fixture();
  const input = f.session("e0000000001", 101);
  expect(await f.manager.run(input, undefined, async () => "result")).toBe("result");
  expect(f.signals).toEqual([]);
  expect((await f.manager.list(f.root, f.binaryPath))[0]?.state).toBe("idle");
});

test("shutdown aborts active CLI calls before waiting for and terminating their daemon", async () => {
  const f = fixture();
  const input = f.session("e0000000001", 101);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const active = f.manager.run(
    input,
    undefined,
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        started();
      }),
  );
  const rejection = active.catch((error) => error);
  await ready;
  expect((await f.manager.list(f.root, f.binaryPath))[0]?.state).toBe("active");
  await f.manager.stop(f.root);
  expect((await rejection).message).toContain("已停止");
  expect(f.signals).toEqual([{ pid: 101, signal: "SIGTERM" }]);
});

test("SIGKILL is used only when a verified daemon ignores SIGTERM", async () => {
  const f = fixture();
  f.state.ignoreTerm = true;
  const input = f.session("e0000000001", 101);
  await f.manager.run(input, undefined, async () => {});
  await f.manager.stop(f.root);
  expect(f.signals).toEqual([
    { pid: 101, signal: "SIGTERM" },
    { pid: 101, signal: "SIGKILL" },
  ]);
});

test("a daemon that remains alive is reported and kept visible with its cleanup error", async () => {
  const f = fixture();
  f.state.ignoreTerm = true;
  f.state.ignoreKill = true;
  const input = f.session("e0000000001", 101);
  await f.manager.run(input, undefined, async () => {});
  await expect(f.manager.stop(f.root)).rejects.toThrow("PID 101");
  expect((await f.manager.list(f.root, f.binaryPath))[0]?.error).toContain("PID 101");
});

test("stale PID files never terminate a reused PID, including the same executable", async () => {
  const f = fixture();
  const input = f.session("e0000000001", 101);
  f.live.set(101, { executable: "/unrelated/app", startedAt: Date.now() });
  expect(await f.manager.list(f.root, f.binaryPath)).toEqual([]);
  await f.manager.stop(f.root);
  expect(f.signals).toEqual([]);
  f.live.set(101, { executable: f.binaryPath, startedAt: fs.statSync(input.pidFile).mtimeMs + 5000 });
  expect(await f.manager.list(f.root, f.binaryPath)).toEqual([]);
  await f.manager.stop(f.root);
  expect(f.signals).toEqual([]);
});

test("retains the recorded identity when a closing daemon removes its PID file first", async () => {
  const f = fixture();
  const input = f.session("e0000000001", 101);
  await f.manager.run(input, undefined, async () => {});
  fs.rmSync(input.pidFile);
  await f.manager.stop(f.root);
  expect(f.signals).toEqual([{ pid: 101, signal: "SIGTERM" }]);
});

test("rejects a CLI call without an Eco-owned socket directory before execution", async () => {
  const f = fixture();
  let executed = false;
  await expect(
    f.manager.run({ sessionKey: "e0000000001", binaryPath: f.binaryPath, env: {} }, undefined, async () => {
      executed = true;
    }),
  ).rejects.toThrow("专属");
  expect(executed).toBe(false);
});

test("application shutdown rejects a queued call before it can spawn another daemon", async () => {
  const f = fixture();
  const input = f.session("e0000000001", 101);
  f.manager.beginShutdown(f.root);
  let executed = false;
  await expect(
    f.manager.run(input, undefined, async () => {
      executed = true;
    }),
  ).rejects.toThrow("正在退出");
  expect(executed).toBe(false);
  await f.manager.list(f.root, f.binaryPath);
  await f.manager.stop(f.root);
  expect(f.live.has(101)).toBe(false);
});
