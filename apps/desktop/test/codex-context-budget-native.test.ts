import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGatewayFetchHandler, GATEWAY_PROVIDER_ID_HEADER } from "@eco/gateway";
import { CodexAppServerClient } from "@eco/runtime";

// Launches the installed native binary against an isolated local Gateway; no model/API access.
test.skipIf(process.env.ECO_CODEX_REAL_APP_SERVER_TEST !== "1")(
  "native Codex reduces an overflowing compact request and resumes with the 10% reserve intact",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-context-budget-"));
    let compacting = false;
    let generations = 0;
    const compactInputs: Array<{ tokens: number; hasOldHistory: boolean }> = [];
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [
          {
            id: "stub",
            name: "Local context budget fixture",
            upstreamKind: "responses",
            baseUrl: "http://local-fixture.invalid",
            apiKey: "local-test-key",
            upstreamModelId: "deepseek-flash",
            models: ["deepseek-flash"],
            modelContextTokens: { "deepseek-flash": 946_176 },
            modelMaxOutputTokens: { "deepseek-flash": 384_000 },
          },
        ],
        countInputTokens: async ({ body }) => {
          const hasOldHistory = JSON.stringify(body.input).includes("OLD_HISTORY_BUDGET_MARKER");
          const tokens = compacting && hasOldHistory ? 893_615 : 1_000;
          if (compacting) compactInputs.push({ tokens, hasOldHistory });
          return { tokens, precision: "heuristic", source: "test:controlled-input" };
        },
      },
      async (_url, init) => {
        generations += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.max_output_tokens).toBe(384_000);
        const id = `response_budget_${generations}`;
        const item = {
          id: `message_${id}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: compacting ? "COMPACT_RECOVERY_SUMMARY" : "BUDGET_RECOVERY_OK",
              annotations: [],
            },
          ],
        };
        const response = {
          id,
          object: "response",
          model: body.model,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1_000, output_tokens: 10, total_tokens: 1_010 },
        };
        return new Response(
          [
            { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response },
          ]
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const headers = new Headers(request.headers);
        headers.set(GATEWAY_PROVIDER_ID_HEADER, "stub");
        return handler(new Request(request, { headers }));
      },
    });
    await fs.writeFile(
      path.join(directory, "config.toml"),
      [
        'model = "deepseek-flash"',
        'model_provider = "stub"',
        "model_context_window = 1000000",
        "model_auto_compact_token_limit = 900000",
        "[model_providers.stub]",
        'name = "Local context budget fixture"',
        `base_url = "http://127.0.0.1:${server.port}/v1"`,
        'env_key = "ECO_TEST_CONTEXT_API_KEY"',
        'wire_api = "responses"',
        "request_max_retries = 0",
        "stream_max_retries = 0",
        "stream_idle_timeout_ms = 5000",
        "[model_providers.stub.capabilities]",
        'remote_compaction = "unsupported"',
        "",
      ].join("\n"),
    );
    const child = spawn(
      process.env.CODEX_EXECUTABLE ?? path.resolve(import.meta.dir, "../node_modules/.bin/codex"),
      ["app-server", "--stdio"],
      {
        cwd: directory,
        env: {
          ...process.env,
          CODEX_HOME: directory,
          ECO_TEST_CONTEXT_API_KEY: "local-test-key",
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
          RUST_LOG: "error",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = CodexAppServerClient.attachToProcess(child, { timeoutMs: 10_000 });
    const completed = (threadId: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Native compaction timed out: ${stderr}`));
        }, 15_000);
        const unsubscribe = client.addNotificationHandler((method, params) => {
          if (method !== "turn/completed" || !params || typeof params !== "object") return;
          const event = params as { threadId?: string; turn: Record<string, unknown> };
          if (event.threadId !== threadId) return;
          clearTimeout(timer);
          unsubscribe();
          resolve(event.turn);
        });
      });
    try {
      await client.initialize();
      const { thread } = await client.request<{ thread: { id: string } }>("thread/start", {
        cwd: directory,
        model: "deepseek-flash",
        modelProvider: "stub",
        approvalPolicy: "never",
        sandbox: "read-only",
        config: { mcp_servers: {} },
      });
      for (const text of ["OLD_HISTORY_BUDGET_MARKER", "Keep the recent task in the summary."]) {
        const turn = completed(thread.id);
        await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
        expect(await turn).toMatchObject({ status: "completed" });
      }
      compacting = true;
      const compact = completed(thread.id);
      await client.request("thread/compact/start", { threadId: thread.id });
      expect(await compact).toMatchObject({ status: "completed" });
      expect(compactInputs[0]).toEqual({ tokens: 893_615, hasOldHistory: true });
      expect(compactInputs.at(-1)).toEqual({ tokens: 1_000, hasOldHistory: false });
      expect(compactInputs.length).toBeLessThan(20);
      compacting = false;
      const continued = completed(thread.id);
      await client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "Continue after successful compaction." }],
      });
      expect(await continued).toMatchObject({ status: "completed" });
      expect(generations).toBe(4);
    } finally {
      client.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      server.stop(true);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  45_000,
);
