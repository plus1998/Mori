import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexAppServerClient } from "@eco/runtime";
import {
  buildCodexAppServerEnv,
  CodexRuntimeLifecycle,
  setCodexAccountProxyConfigGetter,
} from "../src/main/codex-runtime-lifecycle";

const realAppServerTest = process.env.ECO_CODEX_REAL_APP_SERVER_TEST === "1" ? test : test.skip;

realAppServerTest(
  "Codex bypasses a configured proxy when calling the local Eco gateway",
  async () => {
    const codexExecutable =
      process.env.CODEX_EXECUTABLE?.trim() ||
      path.resolve(
        process.cwd(),
        `apps/desktop/node_modules/.bin/${process.platform === "win32" ? "codex.exe" : "codex"}`,
      );
    expect(fs.existsSync(codexExecutable)).toBe(true);

    const ecoDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-loopback-"));
    const codexHomeDir = path.join(ecoDataDir, "codex");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-loopback-workspace-"));
    const targetServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/v1/responses") {
          return new Response("not found", { status: 404 });
        }
        return new Response(buildCompletedResponseStream(), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    let proxyGatewayRequests = 0;
    const proxyServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.hostname === "127.0.0.1" && url.port === String(targetServer.port)) {
          proxyGatewayRequests += 1;
        }
        return new Response("proxy must not receive loopback requests", { status: 502 });
      },
    });
    fs.mkdirSync(codexHomeDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexHomeDir, "config.toml"),
      [
        'model_provider = "stub"',
        "",
        "[model_providers.stub]",
        'name = "Local integration stub"',
        `base_url = "http://127.0.0.1:${targetServer.port}/v1"`,
        'wire_api = "responses"',
        "request_max_retries = 0",
        "stream_idle_timeout_ms = 5000",
        "",
      ].join("\n"),
    );

    const proxyUrl = `http://127.0.0.1:${proxyServer.port}`;
    let proxyLookups = 0;
    setCodexAccountProxyConfigGetter(() => {
      proxyLookups += 1;
      return { mode: "manual", proxyUrl };
    });
    let lifecycle: CodexRuntimeLifecycle | undefined;
    let client: CodexAppServerClient | undefined;
    try {
      // Keep proxy configuration out of the test runner: Bun fetch retains proxy
      // state even after process.env is restored, breaking later loopback tests.
      const env = buildCodexAppServerEnv(
        {
          ...process.env,
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          NO_PROXY: undefined,
          no_proxy: undefined,
        },
        codexHomeDir,
      );
      expect(env.NO_PROXY).toContain("127.0.0.1");
      lifecycle = new CodexRuntimeLifecycle({ ecoDataDir, codexExecutable });
      client = await lifecycle.start();
      expect(proxyLookups).toBe(1);
      const thread = await client.request<{ thread: { id: string } }>("thread/start", {
        cwd: workspace,
        model: "test-model",
        modelProvider: "stub",
      });
      const completed = waitForTurnCompleted(client, thread.thread.id);
      await client.request("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: "Ping local gateway." }],
        model: "test-model",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      });
      await completed;
      expect(proxyGatewayRequests).toBe(0);
    } finally {
      client?.close();
      await lifecycle?.stop();
      setCodexAccountProxyConfigGetter(undefined);
      targetServer.stop(true);
      proxyServer.stop(true);
      removeTempDirBestEffort(ecoDataDir);
      removeTempDirBestEffort(workspace);
    }
  },
  30_000,
);

function removeTempDirBestEffort(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") {
      throw error;
    }
  }
}

function waitForTurnCompleted(client: CodexAppServerClient, threadId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      removeHandler();
      reject(new Error(`Timed out waiting for turn/completed on thread ${threadId}.`));
    }, 15_000);
    const removeHandler = client.addNotificationHandler((method, params) => {
      if (
        method !== "turn/completed" ||
        !params ||
        typeof params !== "object" ||
        (params as { threadId?: unknown }).threadId !== threadId
      ) {
        return;
      }
      clearTimeout(timeout);
      removeHandler();
      resolve();
    });
  });
}

function buildCompletedResponseStream(): string {
  const response = {
    id: "resp_loopback",
    object: "response",
    status: "completed",
    model: "test-model",
    output: [
      {
        id: "msg_loopback",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: response.output[0] })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
  ].join("");
}
