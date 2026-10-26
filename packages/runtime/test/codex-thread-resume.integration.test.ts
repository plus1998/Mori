import { expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "../src/codex-app-server-client";
import { forkCodexThread } from "../src/codex-fork";
import { recordAppliedCodexThreadConfig } from "../src/codex-thread-config-fingerprint";
import { resumeCodexThread } from "../src/codex-thread-resume";
import {
  parseCodexAppServerUserAgentVersion,
  readCodexCliVersion,
  readCodexDependencyPins,
} from "../src/codex-version";

const realAppServerTest = process.env.ECO_CODEX_REAL_APP_SERVER_TEST === "1" ? test : test.skip;

/** The dependency pin the app ships; `packages/runtime/test` → repo root → apps/desktop. */
const appCodexPin = readCodexDependencyPins(
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../../../apps/desktop/package.json"), "utf8")),
).version;

interface ThreadConfigResponse {
  model: string;
  cwd: string;
  thread: {
    id: string;
    status?: { type?: string };
  };
}

realAppServerTest(
  "Codex app-server reloads config cold and continues a known-config systemError thread",
  async () => {
    const codexExecutable =
      process.env.CODEX_EXECUTABLE?.trim() ||
      path.resolve(process.cwd(), "apps/desktop/node_modules/.bin/codex");
    expect(fs.existsSync(codexExecutable)).toBe(true);

    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-resume-integration-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-resume-workspace-"));
    let disconnectedResponsesRemaining = 0;
    const stubServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/v1/responses") {
          return new Response("not found", { status: 404 });
        }
        const body = (await request.json()) as { model?: string };
        if (disconnectedResponsesRemaining > 0) {
          disconnectedResponsesRemaining -= 1;
          return new Response(buildDisconnectedResponseStream(body.model ?? "unknown"), {
            headers: {
              "content-type": "text/event-stream",
            },
          });
        }
        return new Response(buildCompletedResponseStream(body.model ?? "unknown"), {
          headers: {
            "content-type": "text/event-stream",
          },
        });
      },
    });
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model_provider = "stub"',
        "thread_unload_delay_secs = 0",
        "",
        "[model_providers.stub]",
        'name = "Local integration stub"',
        `base_url = "http://127.0.0.1:${stubServer.port}/v1"`,
        'env_key = "STUB_API_KEY"',
        'wire_api = "responses"',
        "request_max_retries = 0",
        "stream_idle_timeout_ms = 5000",
        "",
      ].join("\n"),
    );
    const child = spawn(codexExecutable, ["app-server", "--stdio"], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        STUB_API_KEY: "integration-test-key",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const client = CodexAppServerClient.attachToProcess(child, {
      timeoutMs: 15_000,
    });
    let coldChild: ChildProcessWithoutNullStreams | undefined;
    let coldClient: CodexAppServerClient | undefined;

    try {
      const initialized = await client.initialize();
      // Verify the running app-server against the real binary and the dependency pin.
      // The handshake now sends `<clientName>/<serverVersion> (…)` instead of the
      // removed `codex-cli <version>` banner, so parse the server token, not a banner.
      expect(readCodexCliVersion(codexExecutable)).toBe(appCodexPin);
      expect(parseCodexAppServerUserAgentVersion(initialized.userAgent ?? "")).toBe(appCodexPin);

      const initialModel = "gpt-5.1-codex-mini";
      const resumedModel = "gpt-5.2-codex";
      const started = await client.request<ThreadConfigResponse>("thread/start", {
        cwd: workspace,
        modelProvider: "stub",
        config: {
          model: initialModel,
        },
      });
      expect(started.model).toBe(initialModel);
      expect(started.thread.status?.type).toBe("idle");

      const turnCompleted = waitForTurnCompleted(client, started.thread.id);
      await client.request("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: "Create a persisted rollout." }],
        model: initialModel,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      });
      await turnCompleted;
      await waitForIdleThread(client, started.thread.id);

      // A second local-only turn gives rewind a retained first turn. The global
      // provider is "stub", so omitting fork's provider reproduces the Prod bug.
      const secondTurn = waitForTurnCompleted(client, started.thread.id);
      await client.request("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: "A turn to rewind." }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      });
      await secondTurn;
      await waitForIdleThread(client, started.thread.id);
      const history = await client.request<{
        thread: { turns: Array<{ items: Array<{ id: string; type: string }> }> };
      }>("thread/read", { threadId: started.thread.id, includeTurns: true });
      const targetItem = history.thread.turns.at(-1)?.items.find((item) => item.type === "userMessage");
      if (!targetItem) throw new Error("Missing persisted user item for fork regression");
      const forked = await forkCodexThread(client, {
        threadId: started.thread.id,
        itemId: targetItem.id,
        model: initialModel,
        modelProvider: "openai",
        config: { model_reasoning_effort: "low", web_search: "disabled" },
        developerInstructions: "Fork regression rules",
      });
      expect(forked.modelProvider).toBe("openai");
      expect(forked.model).toBe(initialModel);
      const forkResume = await client.request<{
        modelProvider: string;
        reasoningEffort: string;
        cwd: string;
      }>("thread/resume", { threadId: forked.thread?.id });
      expect(forkResume.modelProvider).toBe("openai");
      expect(forkResume.reasoningEffort).toBe("low");
      expect(forkResume.cwd).toBe(fs.realpathSync(workspace));

      const resumed = await client.request<ThreadConfigResponse>("thread/resume", {
        threadId: started.thread.id,
        config: {
          model: resumedModel,
        },
      });
      expect(resumed.thread.id).toBe(started.thread.id);
      expect(resumed.thread.status?.type).toBe("idle");
      // GAP: loaded+idle may still silently ignore resume config model changes on some Codex builds.
      expect(resumed.model).toBe(initialModel);
      const reloaded = await resumeCodexThread(client, {
        threadId: started.thread.id,
        model: resumedModel,
        modelProvider: "stub",
        config: { model: resumedModel },
      });
      expect(reloaded.thread.id).toBe(started.thread.id);
      expect(reloaded.model).toBe(resumedModel);
      expect(reloaded.modelProvider).toBe("stub");

      client.close();
      await stopChild(child);

      coldChild = spawn(codexExecutable, ["app-server", "--stdio"], {
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          STUB_API_KEY: "integration-test-key",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      coldChild.stderr.setEncoding("utf8");
      coldChild.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      coldClient = CodexAppServerClient.attachToProcess(coldChild, {
        timeoutMs: 15_000,
      });
      await coldClient.initialize();

      const coldRead = await coldClient.request<ThreadConfigResponse>("thread/read", {
        threadId: started.thread.id,
        includeTurns: false,
      });
      expect(coldRead.thread.status?.type).toBe("notLoaded");

      const coldResumed = await coldClient.request<ThreadConfigResponse>("thread/resume", {
        threadId: started.thread.id,
        config: {
          model: resumedModel,
        },
      });
      expect(coldResumed.thread.status?.type).toBe("idle");
      expect(coldResumed.model).toBe(resumedModel);

      disconnectedResponsesRemaining = 6;
      const failedTurnCompleted = waitForTurnCompleted(coldClient, started.thread.id);
      await coldClient.request("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: "Trigger a disconnected response stream." }],
        model: resumedModel,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      });
      expect((await failedTurnCompleted).turn.status).toBe("failed");
      await waitForThreadStatus(coldClient, started.thread.id, "systemError");

      const resumedConfig = { model: resumedModel };
      recordAppliedCodexThreadConfig(coldClient, started.thread.id, resumedConfig);
      const diagnostics: Array<{ status?: string; configAlreadyApplied: boolean; decision: string }> = [];
      const recovered = await resumeCodexThread(coldClient, {
        threadId: started.thread.id,
        config: resumedConfig,
        configAlreadyApplied: true,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      expect(recovered.thread.status?.type).toBe("systemError");
      expect(diagnostics).toEqual([
        expect.objectContaining({
          status: "systemError",
          configAlreadyApplied: true,
          decision: "omit_known_config",
        }),
      ]);

      const recoveryTurnCompleted = waitForTurnCompleted(coldClient, started.thread.id);
      await coldClient.request("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: "Continue after the transport failure." }],
        model: resumedModel,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      });
      expect((await recoveryTurnCompleted).turn.status).toBe("completed");
      await waitForThreadStatus(coldClient, started.thread.id, "idle");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nCodex stderr:\n${stderr.slice(-4000)}`,
      );
    } finally {
      client.close();
      await stopChild(child);
      coldClient?.close();
      if (coldChild) {
        await stopChild(coldChild);
      }
      stubServer.stop(true);
      fs.rmSync(codexHome, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  },
  30_000,
);

realAppServerTest(
  "a failed thread switches provider without losing history or stopping another active thread",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-provider-switch-"));
    const home = path.join(root, "codex");
    fs.mkdirSync(home);
    let failOld = true;
    let releaseOther!: () => void;
    const otherReleased = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    let observedOther!: () => void;
    const otherObserved = new Promise<void>((resolve) => {
      observedOther = resolve;
    });
    const requests: Array<{ path: string; model: string; body: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text();
        const model = (JSON.parse(body) as { model: string }).model;
        const pathname = new URL(request.url).pathname;
        requests.push({ path: pathname, model, body });
        if (body.includes("hold-other-turn")) {
          observedOther();
          await otherReleased;
        } else if (pathname === "/old/v1/responses" && failOld) {
          return Response.json(
            { error: { type: "usage_limit_reached", message: "Offline quota exhausted" } },
            { status: 429 },
          );
        }
        return new Response(buildCompletedResponseStream(model), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    fs.writeFileSync(
      path.join(home, "config.toml"),
      [
        'model_provider = "old"',
        "thread_unload_delay_secs = 0",
        ...["old", "next"].flatMap((provider) => [
          `[model_providers.${provider}]`,
          `name = "Offline ${provider}"`,
          `base_url = "http://127.0.0.1:${server.port}/${provider}/v1"`,
          'env_key = "ECO_SWITCH_TEST_KEY"',
          'wire_api = "responses"',
          "request_max_retries = 0",
          "stream_max_retries = 0",
        ]),
      ].join("\n"),
    );
    const child = spawn(
      process.env.CODEX_EXECUTABLE?.trim() ||
        path.resolve(import.meta.dir, "../../../apps/desktop/node_modules/.bin/codex"),
      ["app-server", "--stdio"],
      {
        env: { ...process.env, CODEX_HOME: home, ECO_SWITCH_TEST_KEY: "offline-dummy" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const client = CodexAppServerClient.attachToProcess(child, { timeoutMs: 10_000 });
    try {
      await client.initialize();
      const oldConfig = { mcp_servers: {}, web_search: "disabled", features: { view_image: true } };
      const target = await client.request<ThreadConfigResponse>("thread/start", {
        cwd: root,
        model: "old-model",
        modelProvider: "old",
        config: oldConfig,
      });
      const threadId = target.thread.id;
      recordAppliedCodexThreadConfig(client, threadId, oldConfig);
      const failed = waitForTurnCompleted(client, threadId);
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "keep-history-before-quota" }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      });
      expect((await failed).turn.status).toBe("failed");
      await waitForThreadStatus(client, threadId, "systemError");
      failOld = false;

      const other = await client.request<ThreadConfigResponse>("thread/start", {
        cwd: root,
        model: "old-model",
        modelProvider: "old",
      });
      const otherCompleted = waitForTurnCompleted(client, other.thread.id);
      await client.request("turn/start", {
        threadId: other.thread.id,
        input: [{ type: "text", text: "hold-other-turn" }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      });
      await otherObserved;
      await waitForThreadStatus(client, other.thread.id, "active");
      // Same static config still requires unloading when the provider changes.
      const switched = await resumeCodexThread(client, {
        threadId,
        model: "next-model",
        modelProvider: "next",
        config: oldConfig,
        configAlreadyApplied: true,
        signal: AbortSignal.timeout(5_000),
      });
      expect(switched.thread.id).toBe(threadId);
      expect(switched.model).toBe("next-model");
      expect(switched.modelProvider).toBe("next");
      await waitForThreadStatus(client, other.thread.id, "active");
      const completed = waitForTurnCompleted(client, threadId);
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "continue-after-switch" }],
        model: "next-model",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      });
      expect((await completed).turn.status).toBe("completed");
      await waitForThreadStatus(client, threadId, "idle");
      const continued = requests.filter((entry) => entry.body.includes("continue-after-switch"));
      expect(continued).toHaveLength(1);
      expect(continued[0]).toMatchObject({ path: "/next/v1/responses", model: "next-model" });
      expect(continued[0]?.body).toContain("keep-history-before-quota");
      // Change static capabilities again while idle, retaining the same native thread.
      const changed = await resumeCodexThread(client, {
        threadId,
        model: "next-model",
        modelProvider: "next",
        config: { ...oldConfig, features: { view_image: false } },
        signal: AbortSignal.timeout(5_000),
      });
      expect(changed.thread.id).toBe(threadId);
      await waitForThreadStatus(client, other.thread.id, "active");
      const capabilitiesTurn = waitForTurnCompleted(client, threadId);
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "continue-after-capability-change" }],
        model: "next-model",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      });
      expect((await capabilitiesTurn).turn.status).toBe("completed");
      const capabilitiesRequest = requests.find((entry) =>
        entry.body.includes("continue-after-capability-change"),
      );
      if (!capabilitiesRequest) throw new Error("Missing request after capability reload");
      expect(capabilitiesRequest?.path).toBe("/next/v1/responses");
      const tools = (JSON.parse(capabilitiesRequest.body) as { tools: Array<{ name?: string }> }).tools;
      expect(tools.some((tool) => tool.name === "view_image")).toBe(false);
      releaseOther();
      expect((await otherCompleted).turn.status).toBe("completed");
    } catch (error) {
      throw new Error(`${String(error)}\nCodex stderr:\n${stderr.slice(-4000)}`);
    } finally {
      releaseOther();
      client.close();
      await stopChild(child);
      server.stop(true);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

function buildCompletedResponseStream(model: string): string {
  const responseId = "resp_eco_resume_integration";
  const itemId = "msg_eco_resume_integration";
  const message = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  const events = [
    {
      type: "response.created",
      sequence_number: 0,
      response: {
        id: responseId,
        object: "response",
        model,
        status: "in_progress",
        output: [],
      },
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      item_id: itemId,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      output_index: 0,
      content_index: 0,
      item_id: itemId,
      delta: "ok",
    },
    {
      type: "response.output_text.done",
      sequence_number: 4,
      output_index: 0,
      content_index: 0,
      item_id: itemId,
      text: "ok",
    },
    {
      type: "response.content_part.done",
      sequence_number: 5,
      output_index: 0,
      content_index: 0,
      item_id: itemId,
      part: { type: "output_text", text: "ok", annotations: [] },
    },
    {
      type: "response.output_item.done",
      sequence_number: 6,
      output_index: 0,
      item: message,
    },
    {
      type: "response.completed",
      sequence_number: 7,
      response: {
        id: responseId,
        object: "response",
        model,
        status: "completed",
        output: [message],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n")}\n`;
}

function buildDisconnectedResponseStream(model: string): string {
  const event = {
    type: "response.created",
    sequence_number: 0,
    response: {
      id: "resp_eco_resume_disconnected",
      object: "response",
      model,
      status: "in_progress",
      output: [],
    },
  };
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function waitForIdleThread(client: CodexAppServerClient, threadId: string): Promise<void> {
  await waitForThreadStatus(client, threadId, "idle");
}

async function waitForThreadStatus(
  client: CodexAppServerClient,
  threadId: string,
  expectedStatus: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await client.request<{ thread: { status?: { type?: string } } }>("thread/read", {
      threadId,
      includeTurns: false,
    });
    if (result.thread.status?.type === expectedStatus) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for thread ${threadId} to become ${expectedStatus}.`);
}

function waitForTurnCompleted(
  client: CodexAppServerClient,
  threadId: string,
): Promise<{ turn: { status?: string; error?: { message?: string } | null } }> {
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
      resolve(params as { turn: { status?: string; error?: { message?: string } | null } });
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), Bun.sleep(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}
