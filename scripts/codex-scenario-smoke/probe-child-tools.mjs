/**
 * Focused live probe: does Codex emit commandExecution on the *child* threadId?
 *
 *   LONGCAT_API_KEY=... bun scripts/codex-scenario-smoke/probe-child-tools.mjs
 *
 * Writes under fixtures/_probe/child-tools-<runId>/
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../packages/runtime/src/codex-app-server-client.ts";
import { syncEcoCodexHooks } from "../../packages/runtime/src/codex-hooks-sync.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

const apiKey = process.env.LONGCAT_API_KEY?.trim() || process.env.ECO_CODEX_SMOKE_API_KEY?.trim() || "";
const baseUrl = (process.env.ECO_CODEX_SMOKE_BASE_URL ?? "https://api.longcat.chat/openai/v1").replace(
  /\/$/,
  "",
);
const model = process.env.ECO_CODEX_SMOKE_MODEL?.trim() || "LongCat-2.0";
const timeoutMs = Number.parseInt(process.env.ECO_CODEX_SMOKE_TIMEOUT_MS ?? "480000", 10);
const providerSlug = "longcat";
const marker = process.env.ECO_SMOKE_MARKER?.trim() || `CT${Date.now().toString(36).toUpperCase()}`;
const runId =
  process.env.ECO_CODEX_SMOKE_RUN_ID?.trim() ||
  `child-tools-${new Date().toISOString().replace(/[:.]/g, "-")}-${marker}`;

if (!apiKey) {
  console.error("Missing LONGCAT_API_KEY or ECO_CODEX_SMOKE_API_KEY");
  process.exit(2);
}

const codexExecutable = resolveCodexExecutable();
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "eco-child-tools-home-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eco-child-tools-ws-"));
const outDir = path.join(__dirname, "fixtures", "_probe", runId);
fs.mkdirSync(outDir, { recursive: true });

/** @type {Array<Record<string, unknown>>} */
const rpcLog = [];
let seq = 0;

function logRpc(entry) {
  const row = { seq: ++seq, ts: new Date().toISOString(), ...entry };
  rpcLog.push(row);
  fs.appendFileSync(path.join(outDir, "rpc-log.jsonl"), `${JSON.stringify(redact(row))}\n`);
}

fs.writeFileSync(path.join(workspace, "README.md"), `# child-tools probe\nmarker=${marker}\n`);
const hooks = await syncEcoCodexHooks({ codexHomeDir: codexHome, enableSpawnAgent: true });
const agentRolePath = writeAgentRole();
writeConfigToml(hooks.trustTomlBlock);

const child = spawn(codexExecutable, ["app-server", "--stdio"], {
  env: { ...process.env, CODEX_HOME: codexHome, LONGCAT_API_KEY: apiKey },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  fs.appendFileSync(path.join(outDir, "codex-stderr.log"), chunk);
});

const client = CodexAppServerClient.attachToProcess(child, {
  timeoutMs: Math.min(timeoutMs, 120_000),
  onServerRequest: async (method, params) => {
    logRpc({ kind: "server_request", direction: "server→client", method, params });
    if (method.includes("requestApproval") || method.endsWith("/requestApproval")) {
      return { decision: "accept", accept: true, approved: true };
    }
    if (method.includes("requestUserInput") || method.includes("elicitation")) {
      return {
        answers: {},
        accepted: true,
        content: [{ type: "text", text: "approved by child-tools probe" }],
      };
    }
    const err = new Error(`unhandled server request ${method}`);
    err.code = -32601;
    throw err;
  },
});

client.addNotificationHandler((method, params) => {
  logRpc({ kind: "notification", direction: "server→client", method, params });
});

const report = {
  runId,
  marker,
  model,
  baseUrl,
  startedAt: new Date().toISOString(),
  ok: false,
  analysis: null,
  errors: [],
};

try {
  const init = await client.initialize({
    clientInfo: {
      name: "eco_codex_child_tools_probe",
      title: "Mori Codex Child Tools Probe",
      version: "1.0.0",
    },
    capabilities: { experimentalApi: true },
  });
  report.codexVersion = init.userAgent ?? null;
  logRpc({ kind: "client_result", method: "initialize", params: init });

  const threadConfig = {
    model,
    features: { multi_agent: true, hooks: true },
    agents: {
      max_threads: 8,
      max_depth: 1,
      smoke_worker: {
        description: "Worker that MUST run one shell command then reply with marker.",
        config_file: agentRolePath,
      },
    },
  };

  const started = await client.request("thread/start", {
    cwd: workspace,
    modelProvider: providerSlug,
    model,
    config: threadConfig,
  });
  const threadId = started.thread.id;
  logRpc({ kind: "client_result", method: "thread/start", params: started });

  const prompt = [
    `Child-tools attribution probe. Marker=${marker}.`,
    "Do ONLY these steps:",
    "1) Spawn exactly one subagent with agent_type/role smoke_worker.",
    "2) Instruct the child to:",
    `   a) Run a shell command that writes exactly CHILD_TOOL_OK:${marker} into child-tool.txt`,
    "   b) Read child-tool.txt back",
    `   c) Reply with exactly SMOKE_CHILD:${marker}`,
    "3) Wait for the child to finish.",
    "4) Do NOT run the child's shell/file tools yourself.",
    `5) Final parent reply exactly: SMOKE_DONE:${marker}`,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "prompt.txt"), prompt);

  const turnDone = waitForNotification(client, "turn/completed", threadId, timeoutMs);
  const turn = await client.request(
    "turn/start",
    {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd: workspace,
      model,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      collaborationMode: {
        mode: "default",
        settings: { model, developer_instructions: null },
      },
    },
    { timeoutMs },
  );
  logRpc({ kind: "client_result", method: "turn/start", params: turn });
  const completed = await turnDone;
  logRpc({ kind: "client_result", method: "turn/completed.wait", params: completed });

  const turnStatus = completed?.turn?.status;
  if (turnStatus && turnStatus !== "completed") {
    report.errors.push(`turn status=${turnStatus}: ${completed?.turn?.error?.message ?? ""}`);
  }

  try {
    await waitIdle(client, threadId, 30_000);
  } catch (idleError) {
    report.errors.push(String(idleError));
  }

  try {
    const read = await client.request("thread/read", { threadId, includeTurns: true });
    fs.writeFileSync(path.join(outDir, "thread-read.json"), JSON.stringify(redact(read), null, 2));
  } catch (readError) {
    report.errors.push(`thread/read failed: ${String(readError)}`);
  }

  const workspaceFiles = snapshotWorkspace(workspace);
  fs.writeFileSync(path.join(outDir, "workspace-files.json"), JSON.stringify(workspaceFiles, null, 2));

  report.analysis = analyzeChildToolAttribution(rpcLog, threadId, marker, workspaceFiles);
  report.ok =
    report.analysis.childToolOkFile &&
    report.analysis.childThreadIds.length > 0 &&
    report.errors.length === 0 &&
    turnStatus === "completed";
  report.finishedAt = new Date().toISOString();

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, runId, outDir, analysis: report.analysis, errors: report.errors }, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.errors.push(String(error));
  report.finishedAt = new Date().toISOString();
  try {
    report.analysis = analyzeChildToolAttribution(rpcLog, null, marker, snapshotWorkspace(workspace));
  } catch {
    // ignore
  }
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(report, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  client.close();
  child.kill("SIGTERM");
  await Bun.sleep(400);
  try {
    fs.rmSync(codexHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
  if (stderr.trim()) {
    console.error("---stderr tail---\n", stderr.slice(-3000));
  }
}

function analyzeChildToolAttribution(log, parentThreadId, m, files) {
  const threadIds = new Set();
  /** @type {Array<{method:string, threadId:string|null, itemType:string|null, command:string|null}>} */
  const toolish = [];
  /** @type {string[]} */
  const childThreadIds = [];
  /** @type {Array<Record<string, unknown>>} */
  const agentSignals = [];

  for (const row of log) {
    const method = typeof row.method === "string" ? row.method : "";
    const params = row.params && typeof row.params === "object" ? /** @type {Record<string, unknown>} */ (row.params) : {};
    const tid = typeof params.threadId === "string" ? params.threadId : null;
    if (tid) threadIds.add(tid);

    if (
      method.includes("agent") ||
      method.includes("subagent") ||
      method === "thread/started" ||
      method === "thread/status/changed"
    ) {
      agentSignals.push({ method, threadId: tid, keys: Object.keys(params) });
      const nested =
        params.agent && typeof params.agent === "object"
          ? /** @type {Record<string, unknown>} */ (params.agent)
          : null;
      const agentThread =
        (typeof params.agentThreadId === "string" && params.agentThreadId) ||
        (typeof nested?.threadId === "string" && nested.threadId) ||
        (typeof params.childThreadId === "string" && params.childThreadId) ||
        null;
      if (agentThread && agentThread !== parentThreadId) childThreadIds.push(agentThread);
      if (tid && parentThreadId && tid !== parentThreadId) childThreadIds.push(tid);
    }

    const item = params.item && typeof params.item === "object" ? /** @type {Record<string, unknown>} */ (params.item) : null;
    const itemType = typeof item?.type === "string" ? item.type : typeof params.type === "string" ? params.type : null;
    if (
      method.includes("item") ||
      itemType === "commandExecution" ||
      itemType === "fileChange" ||
      itemType === "mcpToolCall" ||
      method.includes("command")
    ) {
      const command =
        (typeof item?.command === "string" && item.command) ||
        (typeof params.command === "string" && params.command) ||
        null;
      if (itemType || command || method.includes("command") || method.includes("mcp")) {
        toolish.push({ method, threadId: tid, itemType, command });
      }
    }
  }

  const uniqueChildren = [...new Set(childThreadIds.filter((id) => id && id !== parentThreadId))];
  const toolsOnParent = toolish.filter((t) => t.threadId && t.threadId === parentThreadId);
  const toolsOnChild = toolish.filter((t) => t.threadId && uniqueChildren.includes(t.threadId));
  const toolsOnOther = toolish.filter(
    (t) => t.threadId && t.threadId !== parentThreadId && !uniqueChildren.includes(t.threadId),
  );
  const commandExec = toolish.filter((t) => t.itemType === "commandExecution" || (t.command && t.method.includes("item")));

  const childToolOkFile =
    typeof files["child-tool.txt"] === "string" && files["child-tool.txt"].includes(`CHILD_TOOL_OK:${m}`);

  return {
    parentThreadId,
    allThreadIds: [...threadIds],
    childThreadIds: uniqueChildren,
    childToolOkFile,
    childToolFilePreview: typeof files["child-tool.txt"] === "string" ? files["child-tool.txt"].slice(0, 120) : null,
    toolishCount: toolish.length,
    commandExecutionCount: commandExec.length,
    toolsOnParentCount: toolsOnParent.length,
    toolsOnChildCount: toolsOnChild.length,
    toolsOnOtherCount: toolsOnOther.length,
    toolsOnParentSample: toolsOnParent.slice(0, 12),
    toolsOnChildSample: toolsOnChild.slice(0, 12),
    toolsOnOtherSample: toolsOnOther.slice(0, 12),
    agentSignalsSample: agentSignals.slice(0, 20),
    /** Core question for Eco attribution */
    verdict:
      uniqueChildren.length === 0
        ? "no_child_thread_observed"
        : toolsOnChild.length > 0
          ? "child_thread_has_tool_notifications"
          : commandExec.length === 0
            ? "no_commandExecution_anywhere"
            : "commandExecution_only_on_parent_or_other",
  };
}

function resolveCodexExecutable() {
  const fromEnv = process.env.CODEX_EXECUTABLE?.trim();
  if (fromEnv) return fromEnv;
  const unix = path.join(root, "apps/desktop/node_modules/.bin/codex");
  if (fs.existsSync(unix)) return unix;
  throw new Error("Codex executable not found");
}

function writeAgentRole() {
  const agentsDir = path.join(codexHome, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const rolePath = path.join(agentsDir, "smoke_worker.toml");
  const toml = [
    'name = "smoke_worker"',
    'description = "Worker that must run one shell write then reply with marker."',
    `developer_instructions = ${JSON.stringify(
      "You are smoke_worker. You MUST run the shell/file tools the parent requested before replying. Prefer tools over guessing. After tools succeed, reply with exactly the marker string.",
    )}`,
    `model = ${JSON.stringify(model)}`,
    `model_provider = ${JSON.stringify(providerSlug)}`,
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    "",
  ].join("\n");
  fs.writeFileSync(rolePath, toml);
  return rolePath;
}

function writeConfigToml(trustTomlBlock) {
  const lines = [
    `model = ${JSON.stringify(model)}`,
    `model_provider = ${JSON.stringify(providerSlug)}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    "",
    "[features]",
    "remote_plugin = false",
    "plugins = false",
    "multi_agent = true",
    "hooks = true",
    "",
    "[agents]",
    "max_threads = 8",
    "max_depth = 1",
    "",
    `[model_providers.${providerSlug}]`,
    'name = "LongCat"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'env_key = "LONGCAT_API_KEY"',
    'wire_api = "responses"',
    "request_max_retries = 1",
    "stream_idle_timeout_ms = 300000",
    "",
    trustTomlBlock.trim(),
    "",
  ];
  fs.writeFileSync(path.join(codexHome, "config.toml"), `${lines.join("\n").trim()}\n`);
}

function snapshotWorkspace(dir) {
  /** @type {Record<string, string>} */
  const files = {};
  const walk = (current, rel = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const abs = path.join(current, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, nextRel);
      else if (entry.isFile() && entry.name.length < 200) {
        const stat = fs.statSync(abs);
        if (stat.size <= 64_000) {
          files[nextRel.replace(/\\/g, "/")] = fs.readFileSync(abs, "utf8");
        }
      }
    }
  };
  try {
    walk(dir);
  } catch {
    // ignore
  }
  return files;
}

function waitForNotification(c, method, threadId, waitMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      remove();
      reject(new Error(`timeout waiting for ${method} on ${threadId}`));
    }, waitMs);
    const remove = c.addNotificationHandler((m, p) => {
      if (m !== method) return;
      if (p?.threadId && p.threadId !== threadId) return;
      clearTimeout(timer);
      remove();
      resolve(p);
    });
  });
}

async function waitIdle(c, threadId, waitMs) {
  const started = Date.now();
  let lastStatus = null;
  while (Date.now() - started < waitMs) {
    const r = await c.request("thread/read", { threadId, includeTurns: false });
    const status = r.thread?.status;
    const type = typeof status === "string" ? status : status?.type;
    lastStatus = type ?? status;
    if (type === "idle") return;
    if (type === "systemError" || type === "failed" || type === "closed") {
      throw new Error(`thread terminal status: ${JSON.stringify(status)}`);
    }
    await Bun.sleep(200);
  }
  throw new Error(`thread not idle (last=${JSON.stringify(lastStatus)})`);
}

function redact(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (typeof v === "string" && apiKey && v.includes(apiKey)) {
        return v.split(apiKey).join("***REDACTED***");
      }
      return v;
    }),
  );
}
