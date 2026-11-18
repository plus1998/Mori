import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexMidTurnPortRegistry } from "../src/main/codex-mid-turn-port";
import {
  getGlobalCodexRuntimeLifecycle,
  getOwnedCodexRuntimeClientForThread,
  recordCodexRuntimeThreadOwner,
  setCodexExternalAuthProvider,
  stopCodexRuntimeProcess,
  stopGlobalCodexRuntimeLifecycle,
} from "../src/main/codex-runtime-lifecycle";
import {
  bindPreparedCodexRuntimeToThread,
  clearPreparedCodexRuntimeForThread,
  configureCodexRuntimeRun,
  createCodexRuntimeDriver,
  getCodexRuntimeClientForEcoThread,
  prepareCodexRuntime,
  resolveCodexExecutable,
  shutdownCodexGlobalRuntimeRefresh,
} from "../src/main/codex-runtime-run";
import type { CodexThreadMap } from "../src/main/codex-thread-map";

// Real preparation, process restart, notification dispatch and mid-turn stdio RPC;
// the fixture never connects to a provider or generates a model response.
test.skipIf(process.platform === "win32")("restarted account and provider runtimes keep steering on the current client", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-restart-steer-"));
  const executable = path.join(root, "fake-codex");
  const previousExecutable = process.env.CODEX_EXECUTABLE;
  const mappings = new Map<string, string>();
  const ports = new CodexMidTurnPortRegistry();
  const threadMap: CodexThreadMap = {
    getCodexThreadId: id => mappings.get(id),
    getEcoThreadId: id => [...mappings].find(([, native]) => native === id)?.[0],
    setMapping: (eco, native) => { mappings.set(eco, native); },
    deleteMapping: eco => { mappings.delete(eco); },
    getThreadAttribution: () => undefined,
    setThreadAttribution: () => {},
  };
  try {
    await fs.writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.167.0'); process.exit(0); }
if (process.argv.includes('--bundled')) {
  console.log(JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', apply_patch_tool_type: 'freeform', context_window: 180000 }] }));
  process.exit(0);
}
const threads = new Map();
const reply = value => console.log(JSON.stringify(value));
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (!('id' in req)) continue;
  const p = req.params ?? {};
  let result = {};
  if (req.method === 'initialize') result = { userAgent: 'offline-restart-fixture' };
  if (req.method === 'fixture/pid') result = { pid: process.pid };
  if (req.method === 'thread/resume') {
    const thread = { id: p.threadId, status: { type: 'idle' }, turns: [] };
    threads.set(p.threadId, thread);
    reply({ method: 'thread/started', params: { thread } });
    result = { thread, model: p.model, modelProvider: p.modelProvider };
  }
  if (req.method === 'thread/unsubscribe') {
    threads.delete(p.threadId);
    reply({ method: 'thread/closed', params: { threadId: p.threadId } });
    result = { status: 'unsubscribed' };
  }
  if (req.method === 'fixture/notify') reply({ method: 'thread/status/changed', params: { threadId: p.threadId, status: { type: 'idle' } } });
  if (req.method === 'thread/loaded/list') result = { data: [...threads.keys()] };
  if (req.method === 'thread/read') result = { thread: threads.get(p.threadId) ?? { id: p.threadId, status: { type: 'notLoaded' } } };
  if (req.method === 'thread/backgroundTerminals/list') result = { data: [] };
  if (req.method === 'turn/start') {
    reply({ method: 'thread/status/changed', params: { threadId: p.threadId, status: { type: 'active', activeFlags: [] } } });
    reply({ id: req.id, result: { turn: { id: 'turn-probe', status: 'inProgress', items: [] } } });
    continue;
  }
  if (req.method === 'turn/steer') {
    if (!threads.has(p.threadId)) {
      reply({ id: req.id, error: { code: -32600, message: 'thread not found: ' + p.threadId } });
      continue;
    }
    result = { turnId: p.expectedTurnId };
  }
  reply({ id: req.id, result });
  if (req.method === 'fixture/complete') reply({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: 'turn-probe', status: 'completed' } } });
}
`, { mode: 0o700 });
    process.env.CODEX_EXECUTABLE = executable;
    // A broken fixture must fail explicitly, never start an installed Codex binary.
    expect(resolveCodexExecutable()).toBe(executable);
    configureCodexRuntimeRun({
      ecoDataDir: root,
      listProviders: () => [{ id: "probe-api", name: "Probe", enabled: true, apiCompat: "openai_responses", models: [{ modelId: "probe" }] }],
      listAccountModels: async () => [{ modelId: "gpt-6.1-sol", contextWindow: 180_000 }],
      threadMap,
      appendConversationRuntimeEvent: () => {},
      scheduleThreadRunProjectionUpdated: () => {},
    });
    setCodexExternalAuthProvider(async accountId => {
      if (!accountId) throw new Error("Missing fixture account");
      return { accountId, accessToken: "offline", chatgptAccountId: "offline" };
    });
    for (const providerId of ["openai", "probe-api"]) {
      const eco = `eco-${providerId}`;
      const native = `native-${providerId}`;
      const prepare = () => prepareCodexRuntime({
        ecoThreadId: eco,
        mainProviderId: providerId,
        mainModelId: providerId === "openai" ? "gpt-6.1-sol" : "probe",
        ...(providerId === "openai" ? { accountId: "fixture-account" } : {}),
      });
      const first = (await prepare()).runtimeClient!;
      mappings.set(eco, native);
      await first.request("thread/resume", { threadId: native });
      expect(getCodexRuntimeClientForEcoThread(eco)).toBe(first);
      const { pid } = await first.request<{ pid: number }>("fixture/pid");
      await stopCodexRuntimeProcess(pid);
      expect(getCodexRuntimeClientForEcoThread(eco)).toBeUndefined();
      expect(getOwnedCodexRuntimeClientForThread(native)).toBeUndefined();

      const prepared = await prepare();
      const restarted = prepared.runtimeClient!;
      expect(restarted).not.toBe(first);
      await restarted.request("thread/resume", { threadId: native });
      expect(getCodexRuntimeClientForEcoThread(eco)).toBe(restarted);
      recordCodexRuntimeThreadOwner(native, restarted);
      await restarted.request("fixture/notify", { threadId: native });
      expect(getCodexRuntimeClientForEcoThread(eco)).toBe(restarted);

      bindPreparedCodexRuntimeToThread(eco, prepared);
      const controller = new AbortController();
      let onBound!: () => void;
      const bound = new Promise<void>(resolve => { onBound = resolve; });
      const driver = createCodexRuntimeDriver(eco, "agent", {
        enableMidTurnPort: true,
        onTurnBound: ({ ecoThreadId, codexThreadId, turnId, client }) => {
          expect(client).toBe(restarted);
          // Even a corrupted registry cannot redirect the live driver's port.
          recordCodexRuntimeThreadOwner(native, getGlobalCodexRuntimeLifecycle()!.getClient()!);
          ports.open(ecoThreadId, { codexThreadId, turnId, client });
          onBound();
        },
      });
      const run = (async () => {
        for await (const _event of driver.run({
          threadId: eco, prompt: "offline", workspacePath: root, worktreePath: root,
          signal: controller.signal,
          routes: [{ role: "main", providerId, upstreamModelId: providerId === "openai" ? "gpt-6.1-sol" : "probe", primary: { id: "probe", provider: "custom", displayName: "Probe", modelId: "probe", enabled: true, capabilities: ["responses_api"] }, fallbacks: [] }],
        })) { /* drain the actual driver */ }
      })();
      // Observe errors immediately if startup fails before the binding callback.
      try {
        await Promise.race([bound, run.then(() => { throw new Error("Turn ended without binding"); })]);
        expect(await ports.tryPushUserText(eco, "midturn", { clientUserMessageId: "follow-up" }))
          .toEqual({ ok: true, turnId: "turn-probe" });
        await restarted.request("fixture/complete", { threadId: native });
        await run;
      } finally {
        controller.abort();
        await run.catch(() => {});
        driver.dispose();
        ports.close(eco);
        clearPreparedCodexRuntimeForThread(eco);
      }
    }
    expect(getOwnedCodexRuntimeClientForThread("missing-thread")).toBeUndefined();
    expect(getCodexRuntimeClientForEcoThread("missing-eco")).toBeUndefined();
  } finally {
    await shutdownCodexGlobalRuntimeRefresh();
    await stopGlobalCodexRuntimeLifecycle();
    setCodexExternalAuthProvider(undefined);
    if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE;
    else process.env.CODEX_EXECUTABLE = previousExecutable;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);
