import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stopGlobalCodexRuntimeLifecycle } from "../src/main/codex-runtime-lifecycle";
import {
  configureCodexRuntimeRun,
  runThreadRequestWithRuntimeProxy,
  shutdownCodexGlobalRuntimeRefresh,
} from "../src/main/codex-runtime-run";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import type { CodexThreadMap } from "../src/main/codex-thread-map";

test.skipIf(process.platform === "win32")(
  "native turns wait for credential readiness and surface refresh failures before running",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-runtime-credentials-"));
    const previousExecutable = process.env.CODEX_EXECUTABLE;
    const executable = path.join(root, "fake-codex");
    const order: string[] = [];
    let ready = false;
    try {
      await fs.writeFile(
        executable,
        `#!${process.execPath}
import {createInterface} from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('--bundled')) {
  console.log(JSON.stringify({models:[{slug:'gpt-6.1-sol',apply_patch_tool_type:'freeform',context_window:180000}]}));
  process.exit(0);
}
for await (const line of createInterface({input:process.stdin})) {
  const req=JSON.parse(line);
  if ('id' in req) process.stdout.write(JSON.stringify({id:req.id,result:{}})+'\\n');
}
`,
        { mode: 0o700 },
      );
      process.env.CODEX_EXECUTABLE = executable;
      configureCodexRuntimeRun({
        ecoDataDir: root,
        listProviders: () => [],
        listAccountModels: async () => [{ modelId: "gpt-6.1-sol", contextWindow: 180_000 }],
        ensureAccountReady: async () => {
          order.push("refresh");
          if (!ready) throw new Error("workspace routing discovery failed");
        },
        threadMap: { getCodexThreadId: () => undefined } as unknown as CodexThreadMap,
        appendConversationRuntimeEvent: () => {},
        scheduleThreadRunProjectionUpdated: () => {},
      });
      const route = {
        role: "main",
        provider: { id: "openai", name: "ChatGPT Login", apiCompat: "openai_responses" },
        modelId: "gpt-6.1-sol",
        apiCompat: "openai_responses",
      } as RuntimeRoute;
      const run = () =>
        runThreadRequestWithRuntimeProxy({
          threadId: "thr-refresh-test",
          resolveRuntimeConfig: () => ({ ok: true, routes: [route] }),
          recordRouteFingerprint: () => {},
          onPrepared: () => {
            order.push("prepared");
          },
          run: async () => {
            order.push("turn");
            return { ok: true };
          },
        });
      expect(await run()).toMatchObject({ ok: false, reason: "workspace routing discovery failed" });
      expect(order).toEqual(["refresh"]);
      ready = true;
      expect(await run()).toMatchObject({ ok: true });
      expect(order).toEqual(["refresh", "refresh", "prepared", "turn"]);
    } finally {
      if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = previousExecutable;
      await shutdownCodexGlobalRuntimeRefresh();
      await stopGlobalCodexRuntimeLifecycle();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
