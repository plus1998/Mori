import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type CodexAppServerClient, syncCodexConfigFromEcoProviders } from "@eco/runtime";
import {
  ensureCodexProviderRuntimeLifecycle,
  stopGlobalCodexRuntimeLifecycle,
} from "../src/main/codex-runtime-lifecycle";

// The installed native Codex talks only to this loopback fixture: no real API or credentials.
test.skipIf(process.env.ECO_CODEX_REAL_APP_SERVER_TEST !== "1")(
  "native Codex executes concurrent providers selected by conversations without a shared default",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-native-provider-selection-"));
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json() as { model: string };
        const id = `resp_selection_${++requests}`;
        const item = {
          id: `msg_${id}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "PROVIDER_SELECTION_OK", annotations: [] }],
        };
        const response = {
          id, object: "response", model: body.model, status: "completed", output: [item],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        };
        return new Response([
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const synced = await syncCodexConfigFromEcoProviders({
        ecoDataDir: root,
        gatewayBaseUrl: `http://127.0.0.1:${server.port}/v1`,
        providers: ["unselected-first", "A001", "A002"].map(id => ({ id, name: id, enabled: true })),
      });
      expect(Bun.TOML.parse(await fs.readFile(synced.configPath, "utf8"))).not.toHaveProperty("model_provider");
      const options = {
        ecoDataDir: root,
        codexExecutable: process.env.CODEX_EXECUTABLE ?? path.resolve(import.meta.dir, "../node_modules/.bin/codex"),
        clientOptions: { timeoutMs: 10_000 },
        onStderr: (chunk: string) => process.stderr.write(chunk),
      };
      // Initialize the shared SQLite schema before another process opens it,
      // as production preparation does via its control-plane runtime.
      const first = await ensureCodexProviderRuntimeLifecycle("eco_A001", options, 1);
      const second = await ensureCodexProviderRuntimeLifecycle("eco_A002", options, 1);
      const run = async (client: CodexAppServerClient, modelProvider: string) => {
        const { thread } = await client.request<{ thread: { id: string; modelProvider: string } }>("thread/start", {
          cwd: root, model: "gpt-5", modelProvider, approvalPolicy: "never", sandbox: "read-only",
        });
        expect(thread.modelProvider).toBe(modelProvider);
        let resolveTurn!: (value: unknown) => void;
        let rejectTurn!: (reason: Error) => void;
        const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
        void completed.catch(() => {});
        const timer = setTimeout(() => rejectTurn(new Error("Native provider fixture timed out")), 15_000);
        const remove = client.addNotificationHandler((method, params) => {
          const event = params as { threadId?: string; turn?: unknown };
          if (method === "turn/completed" && event.threadId === thread.id) resolveTurn(event.turn);
        });
        try {
          await client.request("turn/start", {
            threadId: thread.id, input: [{ type: "text", text: "Return the fixture marker." }],
          });
          expect(await completed).toMatchObject({ status: "completed" });
          const resumed = await client.request<{ modelProvider: string }>("thread/resume", {
            threadId: thread.id, modelProvider,
          });
          expect(resumed.modelProvider).toBe(modelProvider);
        } finally {
          clearTimeout(timer);
          remove();
        }
      };
      await Promise.all([run(first, "eco_A001"), run(second, "eco_A002")]);
      expect(requests).toBeGreaterThanOrEqual(2);
      expect(await ensureCodexProviderRuntimeLifecycle("eco_A001", options, 1)).toBe(first);
    } finally {
      await stopGlobalCodexRuntimeLifecycle();
      await server.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  40_000,
);
