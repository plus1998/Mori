import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client";
import { CodexAppServerDriver } from "../src/codex-app-server-driver";
import { syncCodexConfigFromEcoProviders } from "../src/codex-config-sync";
import { withCodexRemoteCompaction } from "../src/codex-role-sync";

// Real bundled app-server, isolated home and local API only; no account or external model calls.
test.skipIf(process.env.ECO_CODEX_NATIVE_SMOKE !== "1")(
  "native Codex driver executes /compact and emits contextCompaction without a user turn",
  async () => {
    const dir = await mkdtemp(
      path.join(process.platform === "win32" ? tmpdir() : "/tmp", "eco-codex-manual-compact-"),
    );
    const requests: unknown[] = [];
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model: string };
        requests.push(body);
        const response = {
          id: `r_${requests.length}`,
          object: "response",
          status: "completed",
          model: body.model,
          output: [
            {
              type: "message",
              id: `m_${requests.length}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Local summary", annotations: [] }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        };
        const events = [
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          { type: "response.output_item.done", output_index: 0, item: response.output[0] },
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
    });
    const executable =
      process.env.CODEX_EXECUTABLE ??
      fileURLToPath(new URL("../../../apps/desktop/node_modules/.bin/codex", import.meta.url));
    const child = spawn(executable, ["app-server", "--stdio"], {
      cwd: dir,
      env: { ...process.env, CODEX_HOME: config.codexHomeDir, RUST_LOG: "error" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const client = CodexAppServerClient.attachToProcess(child, {
      timeoutMs: 15_000,
      onNotification: (method, params) => {
        notifications.push({ method, params });
      },
    });
    let nativeThreadId: string | undefined;
    const driver = new CodexAppServerDriver({
      client,
      sessionMode: "ask",
      threadConfig: withCodexRemoteCompaction({ mcp_servers: {} }, "vendor", "unsupported"),
      onThreadMapped: (_eco, native) => {
        nativeThreadId = native;
      },
    });
    const input = {
      threadId: "eco",
      prompt: "Reply briefly.",
      workspacePath: dir,
      worktreePath: dir,
      signal: new AbortController().signal,
      routes: [
        {
          role: "main" as const,
          providerId: "vendor",
          upstreamModelId: "gpt-6-astra",
          apiCompat: "openai_responses" as const,
          primary: {
            id: "local",
            provider: "custom" as const,
            displayName: "Local",
            baseUrl: `http://127.0.0.1:${api.port}`,
            modelId: "gpt-6-astra",
            capabilities: ["responses_api"],
            enabled: true,
          },
          fallbacks: [],
        },
      ],
    };
    let compactDriver: CodexAppServerDriver | undefined;
    try {
      await client.initialize();
      for await (const _event of driver.run(input)) {
        /* seed history */
      }
      expect(nativeThreadId).toBeString();
      const before = notifications.length;
      const requestsBefore = requests.length;
      compactDriver = new CodexAppServerDriver({
        client,
        existingCodexThreadId: nativeThreadId!,
        sessionMode: "ask",
      });
      for await (const _event of compactDriver.runAsk({ ...input, prompt: "/compact" })) {
        /* wait for real native completion */
      }
      expect(requests.length).toBeGreaterThan(requestsBefore);
      expect(JSON.stringify(requests.slice(requestsBefore))).not.toContain("/compact");
      const compactEvents = notifications.slice(before);
      expect(
        compactEvents.some(
          (event) =>
            event.method === "item/completed" &&
            (event.params as { item?: { type?: string } }).item?.type === "contextCompaction",
        ),
      ).toBe(true);
      expect(
        compactEvents.some(
          (event) =>
            event.method === "item/started" &&
            (event.params as { item?: { type?: string } }).item?.type === "userMessage",
        ),
      ).toBe(false);
    } catch (error) {
      throw new Error(`${String(error)}\n${stderr}`, { cause: error });
    } finally {
      compactDriver?.dispose();
      driver.dispose();
      client.close();
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      api.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
