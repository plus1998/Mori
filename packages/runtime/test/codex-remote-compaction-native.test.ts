import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client";
import { syncCodexConfigFromEcoProviders } from "../src/codex-config-sync";
import { buildCodexRoleToml, withCodexRemoteCompaction } from "../src/codex-role-sync";
import { resumeCodexThread } from "../src/codex-thread-resume";

// Opt in because this launches the installed native Codex binary. No account/API access.
test.skipIf(process.env.ECO_CODEX_NATIVE_SMOKE !== "1")(
  "native Codex scopes root compaction, inherits it in children, and applies cold resume changes",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-remote-compaction-native-"));
    const requests: Array<{
      input?: Array<{ type?: string; call_id?: string; output?: string }>;
      model?: string;
    }> = [];
    let spawned = false;
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as (typeof requests)[number];
        requests.push(body);
        const id = `response_${requests.length}`;
        const compact = body.input?.some((item) => item.type === "compaction_trigger");
        const output: Array<Record<string, unknown>> = compact
          ? [{ type: "compaction", encrypted_content: "test_remote_summary" }]
          : [
              {
                type: "message",
                id: `msg_${id}`,
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "Local summary", annotations: [] }],
              },
            ];
        if (body.model === "eco-parent-spawn-probe" && !spawned) {
          spawned = true;
          output.splice(0, output.length, {
            type: "function_call",
            id: "fc_spawn",
            call_id: "call_spawn",
            name: "spawn_agent",
            namespace: "multi_agent_v1",
            arguments: JSON.stringify({ agent_type: "compact_child", message: "Reply with a short line." }),
          });
        }
        const response = {
          id,
          object: "response",
          status: "completed",
          model: body.model,
          output,
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        };
        const events = [
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          ...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
          { type: "response.completed", response },
        ];
        return new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const config = await syncCodexConfigFromEcoProviders({
      ecoDataDir: dir,
      providers: [{ id: "vendor", name: "Local fixture", enabled: true, apiCompat: "openai_responses" }],
      gatewayBaseUrl: `http://127.0.0.1:${api.port}/v1`,
      enableMultiAgent: true,
    });
    const executable =
      process.env.CODEX_EXECUTABLE ??
      fileURLToPath(new URL("../../../apps/desktop/node_modules/.bin/codex", import.meta.url));
    const spawnProcess = () =>
      spawn(executable, ["app-server", "--stdio"], {
        cwd: dir,
        env: { ...process.env, CODEX_HOME: config.codexHomeDir, RUST_LOG: "error" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    let child = spawnProcess();
    let stderr = "";
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const createClient = () => {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      return CodexAppServerClient.attachToProcess(child, {
        timeoutMs: 15_000,
        onNotification(method, params) {
          notifications.push({ method, params: params as Record<string, unknown> });
        },
        onServerRequest(method) {
          throw new Error(`Unexpected native server request: ${method}`);
        },
      });
    };
    let client = createClient();
    const stopProcess = async () => {
      client.close();
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    };
    const baseConfig = { mcp_servers: {} };
    const remoteConfig = withCodexRemoteCompaction(baseConfig, "vendor", "v2");
    const localConfig = withCodexRemoteCompaction(baseConfig, "vendor", "unsupported");
    const complete = async (method: string, params: Record<string, unknown>) => {
      const start = notifications.length;
      await client.request(method, params);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const completed = notifications
          .slice(start)
          .find((event) => event.method === "turn/completed" && event.params.threadId === params.threadId);
        if (completed) {
          expect(completed.params.turn).toMatchObject({ status: "completed" });
          return;
        }
        const failed = notifications.slice(start).find((event) => event.method === "error");
        if (failed) throw new Error(`Native compaction failed: ${JSON.stringify(failed)}\n${stderr}`);
        await Bun.sleep(10);
      }
      throw new Error(
        `Timed out waiting for ${method}: ${JSON.stringify(notifications.slice(start))}\n${stderr}`,
      );
    };
    try {
      await client.initialize();
      const startThread = async (model: string, config: typeof remoteConfig) => {
        const result = await client.request<{ thread: { id: string } }>("thread/start", {
          model,
          modelProvider: "eco_vendor",
          cwd: dir,
          config,
          approvalPolicy: "never",
          sandbox: "read-only",
        });
        const threadId = result.thread.id;
        await complete("turn/start", {
          threadId,
          input: [{ type: "text", text: "Reply with a short line." }],
        });
        return threadId;
      };
      const remoteThread = await startThread("gpt-6.1-sol", remoteConfig);
      const localThread = await startThread("gpt-6-astra", localConfig);
      let before = requests.length;
      await complete("thread/compact/start", { threadId: remoteThread });
      expect(
        requests
          .slice(before)
          .some((request) => request.input?.some((item) => item.type === "compaction_trigger")),
      ).toBe(true);
      before = requests.length;
      await complete("thread/compact/start", { threadId: localThread });
      expect(requests.length).toBeGreaterThan(before);
      expect(
        requests
          .slice(before)
          .some((request) => request.input?.some((item) => item.type === "compaction_trigger")),
      ).toBe(false);
      const rolePath = path.join(dir, "compact-child.toml");
      await fs.writeFile(
        rolePath,
        buildCodexRoleToml({
          roleId: "compact_child",
          description: "Local compaction child",
          developerInstructions: "Reply briefly.",
          modelId: "gpt-6-astra",
          providerId: "vendor",
          apiCompat: "openai_responses",
          toolPolicy: {
            sandboxMode: "read-only",
            approvalPolicy: "never",
            webSearch: "disabled",
            allowSpawn: false,
          },
        }),
      );
      await startThread("eco-parent-spawn-probe", {
        ...remoteConfig,
        features: { multi_agent: true, hooks: true, multi_agent_v2: false },
        agents: { compact_child: { description: "Compaction fixture child", config_file: rolePath } },
      });
      const spawnResult = requests
        .flatMap((request) => request.input ?? [])
        .find((item) => item.type === "function_call_output" && item.call_id === "call_spawn")?.output;
      expect(spawnResult).toBeDefined();
      const childThreadId = JSON.parse(spawnResult ?? "{}").agent_id as string;
      expect(childThreadId).toBeString();
      // Subscribe to the child without replacing its role-owned config.
      await client.request("thread/resume", { threadId: childThreadId });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const snapshot = await client.request<{ thread: { status: { type: string } } }>("thread/read", {
          threadId: childThreadId,
        });
        if (snapshot.thread.status.type === "idle") break;
        await Bun.sleep(10);
      }
      // Native child sessions inherit provider capabilities; product validation rejects mismatched model settings.
      before = requests.length;
      await complete("thread/compact/start", { threadId: childThreadId });
      expect(requests.length).toBeGreaterThan(before);
      expect(
        requests
          .slice(before)
          .some((request) => request.input?.some((item) => item.type === "compaction_trigger")),
      ).toBe(true);
      await expect(
        resumeCodexThread(client, {
          threadId: remoteThread,
          modelProvider: "eco_vendor",
          config: localConfig,
        }),
      ).rejects.toThrow("Restart the Codex app-server");
      await stopProcess();
      child = spawnProcess();
      client = createClient();
      await client.initialize();
      const resumed = await resumeCodexThread(client, {
        threadId: remoteThread,
        modelProvider: "eco_vendor",
        config: localConfig,
      });
      expect(resumed.thread.id).toBe(remoteThread);
      before = requests.length;
      await complete("thread/compact/start", { threadId: remoteThread });
      expect(requests.length).toBeGreaterThan(before);
      expect(
        requests
          .slice(before)
          .some((request) => request.input?.some((item) => item.type === "compaction_trigger")),
      ).toBe(false);
    } finally {
      await stopProcess();
      api.stop(true);
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
