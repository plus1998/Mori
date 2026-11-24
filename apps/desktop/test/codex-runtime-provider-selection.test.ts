import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexAppServerClient } from "@eco/runtime";
import {
  getCodexRuntimeClients,
  setCodexExternalAuthProvider,
  stopGlobalCodexRuntimeLifecycle,
} from "../src/main/codex-runtime-lifecycle";
import {
  configureCodexRuntimeRun,
  createCodexRuntimeDriver,
  prepareCodexRuntime,
  type EcoProviderForCodexCatalog,
  shutdownCodexGlobalRuntimeRefresh,
} from "../src/main/codex-runtime-run";
import type { CodexThreadMap } from "../src/main/codex-thread-map";

// Reproduce the upstream provider admission rule without credentials or inference.
// Exercise the real Mori config generation, preparation, process pool and stdio RPC.
test.skipIf(process.platform === "win32")(
  "prepared conversations always use their selected provider, never the first registered provider",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-provider-selection-"));
    const executable = path.join(root, "fake-codex");
    const previousExecutable = process.env.CODEX_EXECUTABLE;
    try {
      await fs.writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.171.0'); process.exit(0); }
if (process.argv.includes('--bundled')) {
  console.log(JSON.stringify({models:[{slug:'gpt-6.1-sol',apply_patch_tool_type:'freeform',context_window:180000}]}));
  process.exit(0);
}
const arg = process.argv.find(value => value.startsWith('model_provider='));
const provider = arg ? JSON.parse(arg.slice('model_provider='.length)) : undefined;
const threads = new Map();
let counter = 0;
let account;
for await (const line of createInterface({input:process.stdin})) {
  const req = JSON.parse(line);
  if (!('id' in req)) continue;
  const p = req.params ?? {};
  let result = {};
  if (req.method === 'account/login/start') account = p.chatgptAccountId;
  if (req.method === 'fixture/selection') result = { provider, account, pid:process.pid };
  if (req.method === 'thread/start') {
    const thread = { id:process.pid+'-'+(++counter), modelProvider:p.modelProvider, status:{type:'idle'} };
    threads.set(thread.id, thread);
    result = { thread, modelProvider:p.modelProvider, model:p.model };
  }
  if (req.method === 'turn/start' || req.method === 'thread/resume') {
    const thread = threads.get(p.threadId);
    const config = readFileSync(process.env.CODEX_HOME+'/config.toml', 'utf8');
    const configured = provider ?? config.match(/^model_provider\\s*=\\s*"([^"]+)"/m)?.[1];
    if (thread?.modelProvider !== configured) {
      console.log(JSON.stringify({id:req.id,error:{code:-32600,message:'This chat uses '+thread?.modelProvider+', but your current provider is '+configured}}));
      continue;
    }
    result = req.method === 'turn/start' ? {turn:{id:'turn-'+counter}} : {thread,modelProvider:thread.modelProvider,model:p.model};
  }
  if (req.method === 'thread/loaded/list') result = { data:[...threads.keys()] };
  if (req.method === 'thread/read') result = { thread:threads.get(p.threadId) ?? {status:{type:'notLoaded'}} };
  if (req.method === 'thread/backgroundTerminals/list') result = { data:[] };
  console.log(JSON.stringify({id:req.id,result}));
}
`, { mode: 0o700 });
      process.env.CODEX_EXECUTABLE = executable;
      await fs.mkdir(path.join(root, "codex"));
      await fs.writeFile(path.join(root, "codex/config.toml"), 'model_provider = "eco_sixoner"\n');
      const providers: EcoProviderForCodexCatalog[] = ["sixoner", "A001", "A002"].map(id => ({
        id, name: id, enabled: true, apiCompat: "openai_responses", models: [{ modelId: "probe" }],
      }));
      configureCodexRuntimeRun({
        ecoDataDir: root,
        listProviders: () => providers,
        listAccountModels: async () => [{ modelId: "gpt-6.1-sol", contextWindow: 180_000 }],
        threadMap: { getCodexThreadId: () => undefined } as unknown as CodexThreadMap,
        appendConversationRuntimeEvent: () => {},
        scheduleThreadRunProjectionUpdated: () => {},
      });
      setCodexExternalAuthProvider(async accountId => {
        if (!accountId) throw new Error("Missing selected account");
        return { accountId, accessToken: "fixture-only", chatgptAccountId: `chatgpt-${accountId}` };
      });
      const prepare = (providerId: string, accountId?: string) => prepareCodexRuntime({
        ecoThreadId: `thr-${providerId}-${accountId ?? "api"}`,
        mainProviderId: providerId,
        mainModelId: providerId === "openai" ? "gpt-6.1-sol" : "probe",
        ...(accountId ? { accountId } : {}),
      });
      const login = await prepare("openai", "account-a");
      const first = await prepare("A001");
      const second = await prepare("A002");
      const otherLogin = await prepare("openai", "account-b");
      expect(new Set([login.runtimeClient, first.runtimeClient, second.runtimeClient, otherLogin.runtimeClient]).size).toBe(4);
      const turns: Array<{ client: CodexAppServerClient; id: string; provider: string; model: string }> = [];
      for (const [prepared, expectedProvider, expectedAccount] of [
        [login, "openai", "chatgpt-account-a"],
        [first, "eco_A001", undefined],
        [second, "eco_A002", undefined],
        [otherLogin, "openai", "chatgpt-account-b"],
      ] as const) {
        const client = prepared.runtimeClient!;
        expect(await client.request("fixture/selection")).toMatchObject({ provider: expectedProvider });
        const selection = await client.request<{ account?: string }>("fixture/selection");
        expect(selection.account).toBe(expectedAccount);
        expect(prepared.mainThreadModel?.modelProvider).toBe(expectedProvider);
        const model = prepared.mainThreadModel!.model;
        const result = await client.request<{ thread: { id: string } }>("thread/start", {
          modelProvider: expectedProvider, model,
        });
        turns.push({ client, id: result.thread.id, provider: expectedProvider, model });
      }
      // Changing provider registry order must not influence existing or new turns.
      providers.reverse();
      const content = await fs.readFile(path.join(root, "codex/config.toml"), "utf8");
      expect(Bun.TOML.parse(content)).not.toHaveProperty("model_provider");
      await Promise.all(turns.map(async ({ client, id, provider, model }) => {
        expect(await client.request("turn/start", { threadId: id, model, input: [] })).toHaveProperty("turn");
        expect(await client.request("thread/resume", { threadId: id, modelProvider: provider, model })).toHaveProperty("thread");
      }));
      expect((await prepare("A001")).runtimeClient).toBe(first.runtimeClient);
      expect((await prepare("openai", "account-a")).runtimeClient).toBe(login.runtimeClient);
      const processCount = getCodexRuntimeClients().length;
      expect(() => createCodexRuntimeDriver("thr-no-provider", "agent")).toThrow("尚未准备所选供应商");
      await expect(prepareCodexRuntime({ ecoThreadId: "thr-no-provider" })).rejects.toThrow("没有选择供应商");
      expect(getCodexRuntimeClients()).toHaveLength(processCount);
    } finally {
      await shutdownCodexGlobalRuntimeRefresh();
      await stopGlobalCodexRuntimeLifecycle();
      setCodexExternalAuthProvider(undefined);
      if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = previousExecutable;
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
