/**
 * Real Codex app-server isolation probe.
 *
 * This deliberately starts the installed Codex binary with `app-server
 * --stdio` twice.  It does not use `codex exec`, a fake app-server, or the
 * Eco production lifecycle.  Each process has its own CODEX_HOME/config.toml
 * and Hub bearer.  A local Responses API fixture makes the model/tool loop
 * deterministic while the MCP calls go through the real Streamable HTTP
 * transport and the real Codex app-server MCP client.
 */

import http from "node:http";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "../../packages/runtime/src/codex-app-server-client";
import { startHub, type RunningHub } from "./run";

type Identity = "A" | "B";

type ModelRequest = {
  input?: unknown;
  tools?: unknown;
  model?: string;
};

type ModelApi = {
  identity: Identity;
  url: string;
  requests: ModelRequest[];
  close: () => Promise<void>;
};

const approvalRequests: string[] = [];

async function handleProbeServerRequest(method: string, params: unknown): Promise<unknown> {
  approvalRequests.push(`${method}:${JSON.stringify(params)}`);
  if (method === "mcpServer/elicitation/request") {
    return { action: "accept", content: {} };
  }
  if (method.includes("requestApproval")) return { decision: "accept" };
  if (method.includes("requestUserInput")) return { answers: {} };
  throw new Error(`unsupported Codex app-server request: ${method}`);
}

type ProcessSample = {
  at: string;
  pid: number;
  rssKb: number | null;
};

type Worker = {
  identity: Identity;
  home: string;
  workspace: string;
  token: string;
  api: ModelApi;
  child: ChildProcessWithoutNullStreams;
  client: CodexAppServerClient;
  threadId?: string;
  pid?: number;
  initializeResult?: Record<string, unknown>;
  startupMs: number;
  samples: ProcessSample[];
  stderr: string;
};

function sseResponse(responseId: string, output: Record<string, unknown>[]): string {
  const response = {
    id: responseId,
    object: "response",
    status: "completed",
    model: "eco-local-probe",
    output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    ...output.map((item, outputIndex) => ({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    })),
    { type: "response.completed", response },
  ];
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}`;
}

function functionCall(
  responseId: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
  namespace = "mcp__eco_mcp",
): Record<string, unknown> {
  return {
    id: `fc_${callId}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name,
    namespace,
    arguments: JSON.stringify(args),
    responseId,
  };
}

function textMessage(responseId: string, text: string): Record<string, unknown> {
  return {
    id: `msg_${responseId}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function textFromInput(input: unknown): string | undefined {
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "message" || record.role !== "user") continue;
    const content = record.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .map((part) => (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return undefined;
}

async function startModelApi(identity: Identity): Promise<ModelApi> {
  const requests: ModelRequest[] = [];
  let phase = 0;
  let promptKey: string | undefined;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      if (request.method !== "POST" || !request.url?.startsWith("/v1/responses")) {
        response.writeHead(404).end();
        return;
      }
      let body: ModelRequest;
      try {
        body = JSON.parse(raw) as ModelRequest;
      } catch {
        response.writeHead(400).end("invalid json");
        return;
      }
      requests.push(body);
      const currentPrompt = textFromInput(body.input) ?? `request-${requests.length}`;
      if (currentPrompt !== promptKey) {
        promptKey = currentPrompt;
        phase = 0;
      }
      const namespace = Array.isArray(body.tools)
        ? body.tools.find((tool) => tool && typeof tool === "object" && (tool as Record<string, unknown>).name === "mcp__eco_mcp" && (tool as Record<string, unknown>).type === "namespace")
        : undefined;
      const hasHub = Boolean(namespace);
      const output = !hasHub
        ? [textMessage(`text_${requests.length}`, `no Hub namespace for ${identity}`)]
        : phase === 0
          ? [functionCall(`resp_${requests.length}`, `search_${requests.length}`, "search_tools", { query: "echo" })]
          : phase === 1
            ? [functionCall(`resp_${requests.length}`, `call_${requests.length}`, "call_tool", {
              name: "echo_context",
              arguments: { marker: `app-server-${identity}` },
            })]
            : [textMessage(`text_${requests.length}`, JSON.stringify({ identity, phase, requests: requests.length }))];
      phase += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "cache-control": "no-cache",
      });
      response.end(sseResponse(`resp_${requests.length}`, output));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local Responses API did not bind");
  return {
    identity,
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function codexExecutable(): string {
  return process.env.CODEX_EXECUTABLE?.trim() || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
}

async function codexVersion(executable: string): Promise<string> {
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    execFile(executable, ["--version"], { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: error ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0 });
    });
  });
  if (result.code !== 0) throw new Error(`Codex --version failed: ${result.stderr || result.stdout}`);
  return `${result.stdout}${result.stderr}`.trim();
}

async function writeConfig(home: string, api: ModelApi, hub: RunningHub, token: string): Promise<void> {
  await writeFile(path.join(home, "config.toml"), [
    'model = "eco-local-probe"',
    'model_provider = "eco_probe"',
    "",
    "[model_providers.eco_probe]",
    'name = "Eco local deterministic Responses provider"',
    `base_url = "${api.url}"`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_idle_timeout_ms = 10000',
    'env_key = "ECO_PROBE_KEY"',
    "[model_providers.eco_probe.capabilities]",
    'remote_compaction = "unsupported"',
    'external_web_access = false',
    "",
    "[mcp_servers.eco_mcp]",
    `url = "${hub.url}"`,
    'default_tools_approval_mode = "prompt"',
    "",
    "[mcp_servers.eco_mcp.http_headers]",
    `Authorization = "Bearer ${token}"`,
    "",
  ].join("\n"));
}

async function sampleProcess(worker: Worker): Promise<void> {
  if (!worker.pid) return;
  const result = await new Promise<{ stdout: string; code: number | null }>((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(worker.pid)], { encoding: "utf8" }, (error, stdout) => {
      resolve({ stdout, code: error ? 1 : 0 });
    });
  });
  const rssKb = result.code === 0 && /^\s*\d+\s*$/.test(result.stdout) ? Number.parseInt(result.stdout.trim(), 10) : null;
  worker.samples.push({ at: new Date().toISOString(), pid: worker.pid, rssKb });
}

async function waitForTurnCompleted(client: CodexAppServerClient, threadId: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let removeHandler = () => {};
    const timeout = setTimeout(() => {
      removeHandler();
      reject(new Error(`timed out waiting for turn/completed ${threadId}`));
    }, timeoutMs);
    removeHandler = client.addNotificationHandler((method, params) => {
      if (method !== "turn/completed" || !params || typeof params !== "object") return;
      const record = params as Record<string, unknown>;
      if (record.threadId !== threadId) return;
      clearTimeout(timeout);
      removeHandler();
      resolve(record);
    });
  });
}

async function waitForThreadStatus(client: CodexAppServerClient, threadId: string, expected: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await client.request<Record<string, unknown>>("thread/read", { threadId, includeTurns: false });
    const thread = result.thread as Record<string, unknown> | undefined;
    const status = (thread?.status as Record<string, unknown> | undefined)?.type;
    if (status === expected) return result;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${threadId} status ${expected}`);
}

async function startWorker(input: {
  identity: Identity;
  home: string;
  workspace: string;
  token: string;
  api: ModelApi;
  hub: RunningHub;
  executable: string;
}): Promise<Worker> {
  const started = Date.now();
  const child = spawn(input.executable, ["app-server", "--stdio"], {
    env: {
      ...process.env,
      CODEX_HOME: input.home,
      ECO_PROBE_KEY: "eco-local-probe-key",
      ECO_CODEX_DISABLE_PLUGIN_WARM: "1",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const client = CodexAppServerClient.attachToProcess(child, {
    timeoutMs: 60_000,
    onServerRequest: handleProbeServerRequest,
  });
  const worker: Worker = {
    identity: input.identity,
    home: input.home,
    workspace: input.workspace,
    token: input.token,
    api: input.api,
    child,
    client,
    pid: child.pid,
    startupMs: 0,
    samples: [],
    stderr,
  };
  await client.initialize();
  worker.initializeResult = await client.request<Record<string, unknown>>("initialize", undefined).catch(() => undefined);
  // The client has already initialized above; initialize result is captured by
  // the return value there in the real run below.  Keep the app-server user
  // agent from stderr/metadata even when builds reject a second initialize.
  worker.startupMs = Date.now() - started;
  await sampleProcess(worker);
  return worker;
}

async function initializeWorker(worker: Worker): Promise<Record<string, unknown>> {
  // CodexAppServerClient.initialize() is intentionally called by startWorker;
  // this helper exists so the main flow can use a single typed point for a
  // fresh process without sending a duplicate JSON-RPC initialize.
  return worker.initializeResult ?? {};
}

async function stopWorker(worker: Worker | undefined): Promise<void> {
  if (!worker) return;
  worker.client.close();
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  worker.child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => worker.child.once("exit", () => resolve())),
    Bun.sleep(5_000),
  ]);
  if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
}

async function startWorkerWithInitialize(input: Parameters<typeof startWorker>[0]): Promise<Worker> {
  const started = Date.now();
  const child = spawn(input.executable, ["app-server", "--stdio"], {
    env: {
      ...process.env,
      CODEX_HOME: input.home,
      ECO_PROBE_KEY: "eco-local-probe-key",
      ECO_CODEX_DISABLE_PLUGIN_WARM: "1",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const client = CodexAppServerClient.attachToProcess(child, {
    timeoutMs: 60_000,
    onServerRequest: handleProbeServerRequest,
  });
  const worker: Worker = {
    identity: input.identity,
    home: input.home,
    workspace: input.workspace,
    token: input.token,
    api: input.api,
    child,
    client,
    pid: child.pid,
    startupMs: 0,
    samples: [],
    stderr,
  };
  const initialized = await client.initialize();
  worker.initializeResult = initialized as Record<string, unknown>;
  worker.startupMs = Date.now() - started;
  await sampleProcess(worker);
  return worker;
}

async function startTurn(worker: Worker, prompt: string): Promise<Record<string, unknown>> {
  const threadId = worker.threadId;
  if (!threadId) throw new Error(`worker ${worker.identity} has no thread`);
  const completion = waitForTurnCompleted(worker.client, threadId);
  await worker.client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    model: "eco-local-probe",
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly" },
  });
  const completed = await completion;
  await waitForThreadStatus(worker.client, threadId, "idle");
  await sampleProcess(worker);
  return completed;
}

async function main(): Promise<Record<string, unknown>> {
  const executable = codexExecutable();
  const version = await codexVersion(executable);
  const hub = await startHub();
  const homeA = await mkdtemp(path.join(tmpdir(), "eco-codex-app-server-a-"));
  const homeB = await mkdtemp(path.join(tmpdir(), "eco-codex-app-server-b-"));
  const workspaceA = await mkdtemp(path.join(tmpdir(), "eco-codex-app-server-workspace-a-"));
  const workspaceB = await mkdtemp(path.join(tmpdir(), "eco-codex-app-server-workspace-b-"));
  const apiA = await startModelApi("A");
  const apiB = await startModelApi("B");
  const a = hub.state.issue("A", ["echo_context"]);
  const b = hub.state.issue("B", ["echo_context"]);
  await Promise.all([
    writeConfig(homeA, apiA, hub, a.token),
    writeConfig(homeB, apiB, hub, b.token),
  ]);
  let workers: Array<Worker | undefined> = [];
  let resumedWorkers: Array<Worker | undefined> = [];
  try {
    const initial = await Promise.all([
      startWorkerWithInitialize({ identity: "A", home: homeA, workspace: workspaceA, token: a.token, api: apiA, hub, executable }),
      startWorkerWithInitialize({ identity: "B", home: homeB, workspace: workspaceB, token: b.token, api: apiB, hub, executable }),
    ]);
    workers = initial;
    const threadResults = await Promise.all(initial.map((worker) => worker.client.request<Record<string, unknown>>("thread/start", {
      cwd: worker.workspace,
      model: "eco-local-probe",
      modelProvider: "eco_probe",
      ephemeral: false,
    })));
    for (let index = 0; index < initial.length; index += 1) {
      const thread = threadResults[index]?.thread as Record<string, unknown> | undefined;
      const id = typeof thread?.id === "string" ? thread.id : undefined;
      if (!id) throw new Error(`thread/start did not return id for ${initial[index]?.identity}`);
      initial[index]!.threadId = id;
    }
    await Promise.all(initial.map((worker) => startTurn(worker, `Initial Hub call for ${worker.identity}.`)));
    const initialThreadIds = initial.map((worker) => worker.threadId);
    const initialPids = initial.map((worker) => worker.pid);
    await Promise.all(initial.map((worker) => stopWorker(worker)));
    workers = [];

    const restarted = await Promise.all([
      startWorkerWithInitialize({ identity: "A", home: homeA, workspace: workspaceA, token: a.token, api: apiA, hub, executable }),
      startWorkerWithInitialize({ identity: "B", home: homeB, workspace: workspaceB, token: b.token, api: apiB, hub, executable }),
    ]);
    resumedWorkers = restarted;
    const resumedThreads = await Promise.all(restarted.map(async (worker, index) => {
      const before = await worker.client.request<Record<string, unknown>>("thread/read", {
        threadId: initialThreadIds[index],
        includeTurns: false,
      });
      const resumed = await worker.client.request<Record<string, unknown>>("thread/resume", {
        threadId: initialThreadIds[index],
      });
      worker.threadId = initialThreadIds[index];
      return {
        beforeStatus: ((before.thread as Record<string, unknown> | undefined)?.status as Record<string, unknown> | undefined)?.type,
        resumedStatus: ((resumed.thread as Record<string, unknown> | undefined)?.status as Record<string, unknown> | undefined)?.type,
      };
    }));
    await Promise.all(restarted.map((worker) => startTurn(worker, `Continue Hub call after restart for ${worker.identity}.`)));

    const upstreamCalls = hub.state.logs.filter((entry) => entry.event === "upstream_call" && entry.phase === "started");
    const identities = upstreamCalls.map((entry) => entry.identity);
    const byIdentity = {
      A: upstreamCalls.filter((entry) => entry.identity === "A").length,
      B: upstreamCalls.filter((entry) => entry.identity === "B").length,
    };
    if (byIdentity.A < 2 || byIdentity.B < 2) {
      throw new Error(
        `expected two real Hub calls per identity: ${JSON.stringify(byIdentity)}; ` +
          `modelRequests=${JSON.stringify({ A: apiA.requests.map((r) => ({ tools: summarizeTools(r.tools), inputTypes: summarizeInput(r.input) })), B: apiB.requests.map((r) => ({ tools: summarizeTools(r.tools), inputTypes: summarizeInput(r.input) })) })}; ` +
          `approvalRequests=${JSON.stringify(approvalRequests)}; ` +
          `stderr=${JSON.stringify({ A: initial[0]?.stderr.slice(-800), B: initial[1]?.stderr.slice(-800) })}`,
      );
    }
    if (identities.some((identity) => identity !== "A" && identity !== "B")) throw new Error(`unexpected Hub identity: ${JSON.stringify(identities)}`);
    return {
      status: "pass",
      scope: "real Codex app-server binary; two independent CODEX_HOME instances",
      codexExecutable: executable,
      codexVersion: version,
      initialize: {
        A: await initializeWorker(initial[0]),
        B: await initializeWorker(initial[1]),
        restartedA: await initializeWorker(restarted[0]),
        restartedB: await initializeWorker(restarted[1]),
      },
      concurrent: {
        appServerProcesses: 2,
        initialPids,
        restartedPids: restarted.map((worker) => worker.pid),
        initialThreadIds,
        resume: resumedThreads,
      },
      hub: {
        identities,
        callsByIdentity: byIdentity,
        totalUpstreamCalls: upstreamCalls.length,
        callsAfterRestart: identities.slice(2),
      },
      approvals: {
        methods: [...new Set(approvalRequests.map((entry) => entry.split(":", 1)[0]))],
        requestCount: approvalRequests.length,
        samples: approvalRequests.slice(0, 2),
      },
      resources: {
        initialStartupMs: initial.map((worker) => worker.startupMs),
        restartStartupMs: restarted.map((worker) => worker.startupMs),
        processRssSamplesKb: {
          A: [...initial[0]!.samples, ...restarted[0]!.samples],
          B: [...initial[1]!.samples, ...restarted[1]!.samples],
        },
        isolatedCodexHomeBytes: {
          A: (await directoryBytes(homeA)),
          B: (await directoryBytes(homeB)),
        },
        note: "每个 session 需要一个独立 app-server 子进程、Codex 客户端、CODEX_HOME rollout/config；本次只测 RSS/启动时延，没有做长时间吞吐基准。",
      },
      runtimeIdentity: {
        mcpBearerConfiguredPerHome: true,
        modelProvider: "eco_probe -> local deterministic Responses API",
        fakeAppServer: false,
        execCli: false,
      },
      stderrTail: {
        A: restarted[0]!.stderr.slice(-1000),
        B: restarted[1]!.stderr.slice(-1000),
      },
    };
  } finally {
    await Promise.all([...workers, ...resumedWorkers].filter(Boolean).map((worker) => stopWorker(worker)));
    await Promise.all([apiA.close(), apiB.close(), hub.close()]);
    await Promise.all([
      rm(homeA, { recursive: true, force: true }),
      rm(homeB, { recursive: true, force: true }),
      rm(workspaceA, { recursive: true, force: true }),
      rm(workspaceB, { recursive: true, force: true }),
    ]);
  }
}

function summarizeTools(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter((tool) => {
    if (!tool || typeof tool !== "object") return false;
    const name = (tool as Record<string, unknown>).name;
    return typeof name === "string" && (name.includes("eco") || name.includes("mcp"));
  }).map((tool) => {
    if (!tool || typeof tool !== "object") return typeof tool;
    const record = tool as Record<string, unknown>;
    return { type: record.type, name: record.name, namespace: record.namespace };
  });
}

function summarizeInput(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!item || typeof item !== "object") return typeof item;
    const record = item as Record<string, unknown>;
    return { type: record.type, name: record.name, call_id: record.call_id, output: record.output };
  }).slice(-8);
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  async function walk(current: string): Promise<void> {
    const entries = await (await import("node:fs/promises")).readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else total += (await stat(child)).size;
    }
  }
  await walk(directory);
  return total;
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await main(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      status: "fail",
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }, null, 2));
    process.exitCode = 1;
  }
}
