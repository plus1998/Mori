import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isCodexThreadConfigApplied, recordAppliedCodexThreadConfig } from "@eco/runtime";
import {
  ensureGlobalCodexRuntimeLifecycle,
  getCodexRuntimeClientForThread,
  recordCodexRuntimeThreadOwner,
  stopGlobalCodexRuntimeLifecycle,
} from "../src/main/codex-runtime-lifecycle";
import {
  bindPreparedCodexRuntimeToThread,
  configureCodexRuntimeRun,
  forkCodexThreadForEcoThread,
  isCodexThreadForkPrepared,
  type PreparedCodexRuntime,
} from "../src/main/codex-runtime-run";

let root: string | undefined;
afterEach(async () => {
  await stopGlobalCodexRuntimeLifecycle();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(options: { status?: string; mismatch?: "provider" | "model" | "missing" } = {}) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-fork-"));
  const executable = path.join(root, "app-server");
  await fs.writeFile(
    executable,
    `#!${process.execPath}
import { createInterface } from "node:readline";
const calls = [];
let status = ${JSON.stringify(options.status ?? "idle")};
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (!('id' in req)) continue;
  const p = req.params ?? {};
  calls.push({ method: req.method, params: p });
  let result = {};
  if (req.method === 'initialize') result = { userAgent: 'offline-fork-fixture' };
  else if (req.method === 'fixture/calls') result = calls;
  else if (req.method === 'thread/read') result = { thread: {
    id: p.threadId, status: { type: status }, cwd: '/tmp/source-worktree', turns: [
      { id: 'keep', items: [{ type: 'userMessage', id: 'u1' }] },
      { id: 'drop', items: [{ type: 'userMessage', id: 'u2' }] },
    ],
  } };
  else if (req.method === 'thread/resume') { status = 'idle'; result = { thread: { id: p.threadId } }; }
  else if (req.method === 'thread/fork') {
    result = {
      thread: { id: 'forked', forkedFromId: p.threadId },
      modelProvider: p.modelProvider ?? 'eco_global_default', model: p.model ?? 'global-default-model',
    };
    if (${JSON.stringify(options.mismatch)} === 'provider') result.modelProvider = 'eco_wrong';
    if (${JSON.stringify(options.mismatch)} === 'model') result.model = 'wrong-model';
    if (${JSON.stringify(options.mismatch)} === 'missing') delete result.modelProvider;
  }
  process.stdout.write(JSON.stringify({ id: req.id, result }) + '\\n');
}
`,
    { mode: 0o700 },
  );
  let mapping: string | undefined = "source";
  const pruned: string[] = [];
  configureCodexRuntimeRun({
    ecoDataDir: root,
    listProviders: () => [],
    threadMap: {
      getCodexThreadId: () => mapping,
      getEcoThreadId: (id) => (id === mapping ? "eco-thread" : undefined),
      setMapping: (_ecoId, codexId) => {
        mapping = codexId;
      },
      deleteMapping: () => {
        mapping = undefined;
      },
      getThreadAttribution: () => undefined,
      setThreadAttribution: () => {},
    },
    appendConversationRuntimeEvent: () => {},
    scheduleThreadRunProjectionUpdated: () => {},
    pruneThreadAfterCodexFork: (_ecoId, itemId) => {
      pruned.push(itemId);
    },
  });
  const client = await ensureGlobalCodexRuntimeLifecycle({ ecoDataDir: root, codexExecutable: executable });
  recordCodexRuntimeThreadOwner("source", client);
  const prepared: PreparedCodexRuntime = {
    mainThreadModel: { model: "gpt-6-luna", modelProvider: "openai" },
    threadConfig: { web_search: "disabled", model_reasoning_effort: "high", mcp_servers: {} },
    orchestrationAppend: "Thread instructions",
    roleIds: [],
    roleToolPolicies: {},
    roleThreadConfigs: {},
  };
  return {
    client,
    prepared,
    pruned,
    mapping: () => mapping,
    calls: () => client.request<Array<{ method: string; params: Record<string, unknown> }>>("fixture/calls"),
  };
}

for (const provider of ["openai", "eco_vendor"]) {
  test(`rewind pins ${provider} and applies the submitted config rather than the parent's proof`, async () => {
    const h = await fixture();
    h.prepared.mainThreadModel = { modelProvider: provider, model: "selected-model" };
    recordAppliedCodexThreadConfig(h.client, "source", { web_search: "live" });
    bindPreparedCodexRuntimeToThread("eco-thread", h.prepared);
    expect(isCodexThreadForkPrepared("eco-thread")).toBe(true);
    await forkCodexThreadForEcoThread({ ecoThreadId: "eco-thread", targetItemId: "u2" });
    expect((await h.calls()).find((call) => call.method === "thread/fork")?.params).toEqual({
      threadId: "source",
      lastTurnId: "keep",
      model: "selected-model",
      modelProvider: provider,
      config: h.prepared.threadConfig,
      developerInstructions: "Thread instructions",
      cwd: "/tmp/source-worktree",
    });
    expect(h.mapping()).toBe("forked");
    expect(h.pruned).toEqual(["u2"]);
    expect(isCodexThreadConfigApplied(h.client, "forked", h.prepared.threadConfig)).toBe(true);
    expect(isCodexThreadConfigApplied(h.client, "forked", { web_search: "live" })).toBe(false);
    expect(getCodexRuntimeClientForThread("forked")).toBe(h.client);
  });
}

for (const mismatch of ["provider", "model", "missing"] as const) {
  test(`fork rejects ${mismatch} mismatch before pruning or recording config`, async () => {
    const h = await fixture({ mismatch });
    bindPreparedCodexRuntimeToThread("eco-thread", h.prepared);
    await expect(
      forkCodexThreadForEcoThread({ ecoThreadId: "eco-thread", targetItemId: "u2" }),
    ).rejects.toThrow("unexpected model settings");
    expect(h.mapping()).toBe("source");
    expect(h.pruned).toEqual([]);
    expect(isCodexThreadConfigApplied(h.client, "forked", h.prepared.threadConfig)).toBe(false);
    expect((await h.calls()).find((call) => call.method === "thread/archive")?.params).toEqual({
      threadId: "forked",
    });
  });
}

test("cold rewind loads the desired provider before forking", async () => {
  const h = await fixture({ status: "notLoaded" });
  bindPreparedCodexRuntimeToThread("eco-thread", h.prepared);
  await forkCodexThreadForEcoThread({ ecoThreadId: "eco-thread", targetItemId: "u2" });
  expect((await h.calls()).find((call) => call.method === "thread/resume")?.params).toMatchObject({
    model: "gpt-6-luna",
    modelProvider: "openai",
    config: h.prepared.threadConfig,
  });
  expect(h.mapping()).toBe("forked");
});

test("unprepared rewind fails before touching the source thread", async () => {
  const h = await fixture();
  expect(isCodexThreadForkPrepared("eco-thread")).toBe(false);
  await expect(
    forkCodexThreadForEcoThread({ ecoThreadId: "eco-thread", targetItemId: "u2" }),
  ).rejects.toThrow("requires prepared model");
  expect((await h.calls()).some((call) => call.method.startsWith("thread/"))).toBe(false);
  expect(h.mapping()).toBe("source");
});

test("failed source turns can be rewound with explicit settings", async () => {
  const h = await fixture({ status: "systemError" });
  bindPreparedCodexRuntimeToThread("eco-thread", h.prepared);
  await forkCodexThreadForEcoThread({ ecoThreadId: "eco-thread", targetItemId: "u2" });
  expect(h.mapping()).toBe("forked");
});
