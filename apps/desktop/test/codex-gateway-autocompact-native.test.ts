import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGatewayFetchHandler, GATEWAY_PROVIDER_ID_HEADER } from "@eco/gateway";
import {
  buildCodexGatewayModelAlias,
  buildEcoCodexModelCatalogDocument,
  CodexAppServerClient,
  CodexAppServerDriver,
  CodexTurnRouteRegistry,
  loadBundledCodexModelCatalog,
} from "@eco/runtime";

test.skipIf(process.env.ECO_CODEX_REAL_APP_SERVER_TEST !== "1")(
  "Codex owns automatic compaction when a Gateway alias declares its usable budget",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-gateway-autocompact-"));
    const executable =
      process.env.CODEX_EXECUTABLE ?? path.resolve(import.meta.dir, "../node_modules/.bin/codex");
    const alias = buildCodexGatewayModelAlias("stub", "deepseek-flash", "openai_responses");
    const native = await loadBundledCodexModelCatalog(executable);
    const catalog = buildEcoCodexModelCatalogDocument(native, [
      {
        providerId: "stub",
        modelId: "deepseek-flash",
        apiCompat: "openai_responses",
        manualSpec: { contextTokens: 262_144 },
      },
    ]);
    expect(catalog.models.find((model) => model.slug === alias)?.auto_compact_token_limit).toBe(212_821);
    const catalogPath = path.join(directory, "models.json");
    await fs.writeFile(catalogPath, JSON.stringify(catalog));
    const requests: Array<{ compact: boolean; summaryPresent: boolean }> = [];
    let lowUsage = false;
    let rejectNextTurn = false;
    const handler = createGatewayFetchHandler(
      {
        host: "127.0.0.1",
        port: 0,
        providers: [
          {
            id: "stub",
            name: "Offline",
            upstreamKind: "responses",
            baseUrl: "http://fixture.invalid",
            apiKey: "offline",
            upstreamModelId: "deepseek-flash",
            models: ["deepseek-flash"],
            modelContextTokens: { "deepseek-flash": 262_144 },
          },
        ],
        countInputTokens: async () => ({ tokens: 1_000, precision: "heuristic", source: "test:controlled" }),
      },
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const compact = !body.tools?.length;
        requests.push({
          compact,
          summaryPresent: JSON.stringify(body.input).includes("NATIVE_SUMMARY_MARKER"),
        });
        if (rejectNextTurn && !compact) {
          rejectNextTurn = false;
          return Response.json(
            { error: { code: "context_length_exceeded", message: "Native failed-turn recovery fixture." } },
            { status: 400 },
          );
        }
        const id = `resp_${requests.length}`;
        const item = {
          id: `msg_${id}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: compact ? "NATIVE_SUMMARY_MARKER" : "TASK_OK", annotations: [] },
          ],
        };
        const inputTokens = lowUsage ? 150_000 : requests.length === 1 ? 230_000 : 1_000;
        const response = {
          id,
          object: "response",
          model: body.model,
          status: "completed",
          output: [item],
          usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10 },
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
      () => {},
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.model).toBe(alias);
        body.model = "deepseek-flash";
        const headers = new Headers(request.headers);
        headers.set(GATEWAY_PROVIDER_ID_HEADER, "stub");
        return handler(
          new Request(request.url, { method: request.method, headers, body: JSON.stringify(body) }),
        );
      },
    });
    await fs.writeFile(
      path.join(directory, "config.toml"),
      [
        `model = "${alias}"`,
        'model_provider = "stub"',
        `model_catalog_json = "${catalogPath}"`,
        "[model_providers.stub]",
        'name = "Offline"',
        `base_url = "http://127.0.0.1:${server.port}/v1"`,
        'env_key = "ECO_NATIVE_AUTOCOMPACT_TEST_KEY"',
        'wire_api = "responses"',
        "request_max_retries = 0",
        "stream_max_retries = 0",
        "[model_providers.stub.capabilities]",
        'remote_compaction = "unsupported"',
        "",
      ].join("\n"),
    );
    const child = spawn(executable, ["app-server", "--stdio"], {
      cwd: directory,
      env: {
        ...process.env,
        CODEX_HOME: directory,
        ECO_NATIVE_AUTOCOMPACT_TEST_KEY: "offline",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        RUST_LOG: "error",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = CodexAppServerClient.attachToProcess(child, { timeoutMs: 15_000 });
    const nextTurn = (threadId: string) =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          remove();
          reject(new Error(`Native auto-compaction timeout: ${stderr}`));
        }, 15_000);
        const remove = client.addNotificationHandler((method, params) => {
          const event = params as { threadId?: string; turn?: unknown };
          if (method === "turn/completed" && event.threadId === threadId) {
            clearTimeout(timer);
            remove();
            resolve(event.turn);
          }
        });
      });
    try {
      await client.initialize();
      const { thread } = await client.request<{ thread: { id: string } }>("thread/start", {
        cwd: directory,
        model: alias,
        modelProvider: "stub",
        approvalPolicy: "never",
        sandbox: "read-only",
        config: { mcp_servers: {} },
      });
      for (const text of ["Recorded history marker.", "Continue the task."]) {
        const completed = nextTurn(thread.id);
        await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
        expect(await completed).toMatchObject({ status: "completed" });
      }
      expect(requests.map((request) => request.compact)).toEqual([false, true, false]);
      expect(requests.at(-1)?.summaryPresent).toBe(true);

      // The real failure happens after cumulative usage exceeds the context window.
      // Codex's error bookkeeping then zeros last_token_usage, bypassing auto-compaction on resume.
      lowUsage = true;
      for (const text of ["Continue one.", "Continue two."]) {
        const completed = nextTurn(thread.id);
        await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
        expect(await completed).toMatchObject({ status: "completed" });
      }
      rejectNextTurn = true;
      let lastUsageTokens: number | undefined;
      const removeUsage = client.addNotificationHandler((method, params) => {
        const event = params as { threadId?: string; tokenUsage?: { last?: { totalTokens?: number } } };
        if (method === "thread/tokenUsage/updated" && event.threadId === thread.id) {
          lastUsageTokens = event.tokenUsage?.last?.totalTokens;
        }
      });
      const failed = nextTurn(thread.id);
      await client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "Overflow." }],
      });
      expect(await failed).toMatchObject({
        status: "failed",
        error: { codexErrorInfo: "contextWindowExceeded" },
      });
      removeUsage();
      expect(lastUsageTokens).toBe(0);
      lowUsage = false;
      const registry = new CodexTurnRouteRegistry();
      const driver = new CodexAppServerDriver({
        client,
        existingCodexThreadId: thread.id,
        turnRouteRegistry: registry,
      });
      const requestCountBeforeRetry = requests.length;
      try {
        const events = [];
        for await (const event of driver.run({
          threadId: "thr_offline_context_recovery",
          prompt: "Continue after the failed turn.",
          workspacePath: directory,
          worktreePath: directory,
          routes: [
            {
              role: "main",
              providerId: "stub",
              upstreamModelId: "deepseek-flash",
              apiCompat: "openai_responses",
              primary: {
                id: "stub",
                provider: "custom",
                displayName: "Offline",
                baseUrl: "http://fixture.invalid",
                modelId: "deepseek-flash",
                capabilities: ["responses_api"],
                enabled: true,
              },
              fallbacks: [],
            },
          ],
          signal: new AbortController().signal,
        }))
          events.push(event);
        expect(events.at(-1)?.type).toBe("agent.completed");
        expect(events.some((event) => String(event.payload.text).includes("原生压缩"))).toBe(true);
        expect(requests.slice(requestCountBeforeRetry).map((request) => request.compact)).toEqual([
          true,
          false,
        ]);
        expect(requests.at(-1)?.summaryPresent).toBe(true);
        expect(registry.size).toBe(0);
      } finally {
        driver.dispose();
      }
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
  30_000,
);
