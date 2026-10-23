import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureGlobalCodexRuntimeLifecycle,
  getCodexRuntimeClientForThread,
  getCodexRuntimeClients,
  getGlobalCodexRuntimeLifecycle,
  handoffCodexRuntimeThread,
  reapRetiredCodexRuntimes,
  recordCodexRuntimeThreadOwner,
  replaceGlobalCodexRuntimeLifecycle,
  retainCodexRuntimeClient,
  stopGlobalCodexRuntimeLifecycle,
} from "../src/main/codex-runtime-lifecycle";

let root: string | undefined;
afterEach(async () => {
  await stopGlobalCodexRuntimeLifecycle();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-rolling-"));
  const executable = path.join(root, "app-server");
  await fs.writeFile(
    executable,
    `#!${process.execPath}
import { createInterface } from "node:readline";
const threads = new Map();
const background = new Set();
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (!('id' in req)) continue;
  const p = req.params ?? {};
  let result = {};
  if (req.method === 'initialize') result = { userAgent: 'offline-fixture' };
  else if (req.method === 'thread/loaded/list') result = { data: [...threads.keys()] };
  else if (req.method === 'thread/backgroundTerminals/list') result = { data: background.has(p.threadId) ? [{}] : [] };
  else if (req.method === 'fixture/background') { if (p.enabled) background.add(p.threadId); else background.delete(p.threadId); }
  else if (req.method === 'fixture/set') { threads.set(p.threadId, p.status); result = { home: process.env.CODEX_HOME, pid: process.pid }; }
  else if (req.method === 'thread/read') result = { thread: { status: { type: threads.get(p.threadId) ?? 'notLoaded' } } };
  else if (req.method === 'thread/unsubscribe') {
    threads.delete(p.threadId);
    process.stdout.write(JSON.stringify({ method: 'thread/closed', params: { threadId: p.threadId } }) + '\\n');
    result = { status: 'unsubscribed' };
  }
  else if (req.method === 'turn/interrupt') threads.set(p.threadId, 'idle');
  process.stdout.write(JSON.stringify({ id: req.id, result }) + '\\n');
}
`,
    { mode: 0o700 },
  );
  return { ecoDataDir: root, codexExecutable: executable };
}

test("replacement shares home, keeps old active turns controllable, then reaps them", async () => {
  const options = await fixture();
  const old = await ensureGlobalCodexRuntimeLifecycle(options);
  const first = await old.request<{ home: string; pid: number }>("fixture/set", {
    threadId: "old",
    status: "active",
  });
  recordCodexRuntimeThreadOwner("old", old);
  const current = await replaceGlobalCodexRuntimeLifecycle(options);
  const second = await current.request<{ home: string; pid: number }>("fixture/set", {
    threadId: "new",
    status: "active",
  });
  expect(first.home).toBe(second.home);
  expect(first.pid).not.toBe(second.pid);
  expect(getGlobalCodexRuntimeLifecycle()?.getClient()).toBe(current);
  await reapRetiredCodexRuntimes();
  expect(getCodexRuntimeClients()).toHaveLength(2);
  expect(getCodexRuntimeClientForThread("old")).toBe(old);
  await old.request("turn/interrupt", { threadId: "old" });
  await reapRetiredCodexRuntimes();
  expect(getCodexRuntimeClients()).toEqual([current]);
  expect(getCodexRuntimeClientForThread("old")).toBe(current);
});

test("failed replacement leaves the current generation and its tasks available", async () => {
  const options = await fixture();
  const old = await ensureGlobalCodexRuntimeLifecycle(options);
  await expect(
    replaceGlobalCodexRuntimeLifecycle({
      ...options,
      codexExecutable: path.join(options.ecoDataDir, "missing"),
    }),
  ).rejects.toThrow();
  expect(getGlobalCodexRuntimeLifecycle()?.getClient()).toBe(old);
  expect(await old.request("thread/loaded/list")).toEqual({ data: [] });
});

test("preparation reservations protect an idle generation until driver startup finishes", async () => {
  const options = await fixture();
  const old = await ensureGlobalCodexRuntimeLifecycle(options);
  const release = retainCodexRuntimeClient(old);
  await replaceGlobalCodexRuntimeLifecycle(options);
  await reapRetiredCodexRuntimes();
  expect(getCodexRuntimeClients()).toHaveLength(2);
  release();
  release();
  await reapRetiredCodexRuntimes();
  expect(getCodexRuntimeClients()).toHaveLength(1);
});

test("idle thread handoff waits for writer release while another old turn keeps running", async () => {
  const options = await fixture();
  const old = await ensureGlobalCodexRuntimeLifecycle(options);
  await old.request("fixture/set", { threadId: "idle", status: "idle" });
  await old.request("fixture/set", { threadId: "busy", status: "active" });
  recordCodexRuntimeThreadOwner("idle", old);
  recordCodexRuntimeThreadOwner("busy", old);
  const current = await replaceGlobalCodexRuntimeLifecycle(options);
  await handoffCodexRuntimeThread("idle", current);
  expect(getCodexRuntimeClientForThread("idle")).toBe(current);
  expect(getCodexRuntimeClientForThread("busy")).toBe(old);
  await expect(handoffCodexRuntimeThread("busy", current)).rejects.toThrow("still active");
  await reapRetiredCodexRuntimes();
  expect(getCodexRuntimeClients()).toHaveLength(2);
});

test("shutdown cancels a queued replacement instead of publishing a process after exit", async () => {
  const options = await fixture();
  await ensureGlobalCodexRuntimeLifecycle(options);
  const replacement = replaceGlobalCodexRuntimeLifecycle(options).then(
    () => "published",
    (error: unknown) => error,
  );
  await stopGlobalCodexRuntimeLifecycle();
  const outcome = await replacement;
  expect(outcome).toBeInstanceOf(Error);
  expect(String(outcome)).toContain("cancelled");
  expect(getCodexRuntimeClients()).toEqual([]);
});

test("concurrent replacements keep every previous generation owned until it drains", async () => {
  const options = await fixture();
  const first = await ensureGlobalCodexRuntimeLifecycle(options);
  const releaseFirst = retainCodexRuntimeClient(first);
  const second = await replaceGlobalCodexRuntimeLifecycle(options);
  const releaseSecond = retainCodexRuntimeClient(second);
  const replacements = await Promise.all([
    replaceGlobalCodexRuntimeLifecycle(options),
    replaceGlobalCodexRuntimeLifecycle(options),
  ]);
  expect(getCodexRuntimeClients()).toContain(first);
  expect(getCodexRuntimeClients()).toContain(second);
  expect(getCodexRuntimeClients()).toContain(replacements[0]);
  expect(getGlobalCodexRuntimeLifecycle()?.getClient()).toBe(replacements[1]);
  releaseFirst();
  releaseSecond();
  await reapRetiredCodexRuntimes();
  expect(getCodexRuntimeClients()).toEqual([replacements[1]]);
});

test("retirement preserves an idle thread's running background terminal", async () => {
  const options = await fixture();
  const old = await ensureGlobalCodexRuntimeLifecycle(options);
  await old.request("fixture/set", { threadId: "shell", status: "idle" });
  await old.request("fixture/background", { threadId: "shell", enabled: true });
  await replaceGlobalCodexRuntimeLifecycle(options);
  await reapRetiredCodexRuntimes();
  expect(getCodexRuntimeClients()).toHaveLength(2);
  await old.request("fixture/background", { threadId: "shell", enabled: false });
  await reapRetiredCodexRuntimes();
  expect(getCodexRuntimeClients()).toHaveLength(1);
});
