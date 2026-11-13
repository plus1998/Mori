import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureCodexAccountRuntimeLifecycle,
  ensureGlobalCodexRuntimeLifecycle,
  getCodexRuntimeClientForThread,
  getCodexRuntimeClients,
  getCodexRuntimeProcesses,
  getGlobalCodexRuntimeLifecycle,
  invalidateCodexAccountRuntimeLifecycle,
  handoffCodexRuntimeThread,
  reapRetiredCodexRuntimes,
  recordCodexRuntimeThreadOwner,
  replaceGlobalCodexRuntimeLifecycle,
  retainCodexRuntimeClient,
  setCodexExternalAuthProvider,
  setCodexAccountProxyConfigGetter,
  setCodexSystemProxyResolver,
  stopGlobalCodexRuntimeLifecycle,
} from "../src/main/codex-runtime-lifecycle";

let root: string | undefined;
afterEach(async () => {
  setCodexExternalAuthProvider(undefined);
  setCodexAccountProxyConfigGetter(undefined);
  setCodexSystemProxyResolver(undefined);
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
let loggedInAccount = '';
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (!('id' in req)) continue;
  const p = req.params ?? {};
  let result = {};
  if (req.method === 'initialize') result = { userAgent: 'offline-fixture' };
  else if (req.method === 'account/login/start') { loggedInAccount = p.chatgptAccountId; result = { type: 'success' }; }
  else if (req.method === 'fixture/account') result = { accountId: loggedInAccount, pid: process.pid };
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

test("account-bound app-servers keep separate credentials and processes", async () => {
  const options = await fixture();
  const credentials: string[] = [];
  const proxies: string[] = [];
  setCodexExternalAuthProvider(async (accountId) => {
    if (!accountId) throw new Error("A runtime must select an account explicitly");
    credentials.push(accountId);
    return { accountId, accessToken: `token-${accountId}`, chatgptAccountId: `chatgpt-${accountId}` };
  });
  let proxyUrl = "http://user:secret@proxy.example.test:8080/private?token=hidden#fragment";
  setCodexAccountProxyConfigGetter(accountId => {
    proxies.push(accountId);
    return accountId === "account-a" ? { mode: "manual", proxyUrl } : { mode: "direct" };
  });
  const gateway = await ensureGlobalCodexRuntimeLifecycle(options);
  expect(await gateway.request("fixture/account", {})).toMatchObject({ accountId: "" });
  const first = await ensureCodexAccountRuntimeLifecycle("account-a", options, 1);
  const second = await ensureCodexAccountRuntimeLifecycle("account-b", options, 1);
  expect(first).not.toBe(second);
  expect(await first.request("fixture/account", {})).toMatchObject({ accountId: "chatgpt-account-a" });
  expect(await second.request("fixture/account", {})).toMatchObject({ accountId: "chatgpt-account-b" });
  expect(getCodexRuntimeClients()).toHaveLength(3);
  expect(credentials).toEqual(["account-a", "account-b"]);
  expect(proxies).toEqual(["account-a", "account-b"]);
  const before = getCodexRuntimeProcesses();
  expect(before).toHaveLength(3);
  expect(before.find((process) => process.account?.id === "account-a")).toMatchObject({
    account: { id: "account-a", status: "bound" },
    proxy: { mode: "manual", endpoint: "http://proxy.example.test:8080" },
  });
  expect(before.find((process) => process.account?.id === "account-b")?.proxy).toEqual({ mode: "direct" });
  expect(before.find((process) => !process.account)?.proxy).toEqual({ mode: "system" });
  expect(JSON.stringify(before)).not.toMatch(/secret|private|hidden|token-account/);
  // Updating A's proxy only replaces A for new turns. B retains its process.
  await first.request("fixture/set", { threadId: "active-a", status: "active" });
  recordCodexRuntimeThreadOwner("active-a", first);
  invalidateCodexAccountRuntimeLifecycle("account-a");
  proxyUrl = "socks5://user:secret@127.0.0.1:1080";
  const replacement = await ensureCodexAccountRuntimeLifecycle("account-a", options, 1);
  expect(replacement).not.toBe(first);
  expect(await ensureCodexAccountRuntimeLifecycle("account-b", options, 1)).toBe(second);
  expect(getCodexRuntimeClientForThread("active-a")).toBe(first);
  const generations = getCodexRuntimeProcesses().filter((process) => process.account?.id === "account-a");
  expect(generations).toHaveLength(2);
  expect(generations.find((process) => process.proxy.endpoint === "http://proxy.example.test:8080")).toEqual(
    before.find((process) => process.account?.id === "account-a"),
  );
  expect(generations.find((process) => process.proxy.endpoint === "socks5://127.0.0.1:1080")?.proxy.bridgeEndpoint)
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  await stopGlobalCodexRuntimeLifecycle();
  expect(getCodexRuntimeProcesses()).toEqual([]);
});

test("process snapshots keep the resolved system route and report account binding progress", async () => {
  const options = await fixture();
  let resolution = "PROXY system.example.test:7890; DIRECT";
  setCodexSystemProxyResolver(() => resolution);
  await ensureGlobalCodexRuntimeLifecycle(options);
  resolution = "DIRECT";
  expect(getCodexRuntimeProcesses()[0]).toMatchObject({
    account: null,
    proxy: { mode: "system", endpoint: "http://system.example.test:7890" },
  });
  let finishAuth!: () => void;
  let authStarted!: () => void;
  const started = new Promise<void>((resolve) => { authStarted = resolve; });
  const ready = new Promise<void>((resolve) => { finishAuth = resolve; });
  setCodexExternalAuthProvider(async () => {
    authStarted();
    await ready;
    return { accountId: "a", accessToken: "secret-token", chatgptAccountId: "chatgpt-a" };
  });
  const starting = ensureCodexAccountRuntimeLifecycle("a", options, 1);
  try {
    await started;
    expect(getCodexRuntimeProcesses().find((process) => process.account?.id === "a")).toMatchObject({
      account: { id: "a", status: "binding" }, proxy: { mode: "system" },
    });
  } finally {
    finishAuth();
    await starting;
  }
  expect(getCodexRuntimeProcesses().find((process) => process.account?.id === "a")?.account?.status).toBe("bound");
});

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
