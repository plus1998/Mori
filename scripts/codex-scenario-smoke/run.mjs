/**
 * Live Codex scenario smoke against LongCat (or any Responses-compatible provider).
 *
 * Record:
 *   LONGCAT_API_KEY=... bun scripts/codex-scenario-smoke/run.mjs
 *
 * Options (env):
 *   LONGCAT_API_KEY / ECO_CODEX_SMOKE_API_KEY  required for live
 *   ECO_CODEX_SMOKE_BASE_URL   default https://api.longcat.chat/openai
 *   ECO_CODEX_SMOKE_MODEL      default LongCat-2.0
 *   ECO_CODEX_SMOKE_TIMEOUT_MS default 600000
 *   ECO_CODEX_SMOKE_FIXTURE_DIR optional override output dir
 *
 * Writes fixtures under scripts/codex-scenario-smoke/fixtures/<runId>/
 * and updates fixtures/latest.json pointer.
 *
 * Replay without network:
 *   bun scripts/codex-scenario-smoke/replay.mjs
 *   bun scripts/codex-scenario-smoke/replay.mjs --fixture=<runId>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../packages/runtime/src/codex-app-server-client.ts";
import { syncEcoCodexHooks } from "../../packages/runtime/src/codex-hooks-sync.ts";
import { listCodexSkills } from "../../packages/runtime/src/codex-skills-list.ts";
import { buildScenarioPrompt } from "../conversation-round/lib/scenario-prompt.mjs";
import { diffAgainstBaseline, evaluateScenarioChecklist } from "./assert.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const fixturesRoot = path.join(__dirname, "fixtures");
const mcpServerPath = path.join(__dirname, "mcp-echo-server.mjs");

const apiKey = process.env.LONGCAT_API_KEY?.trim() || process.env.ECO_CODEX_SMOKE_API_KEY?.trim() || "";
// Codex appends `/responses` to model_provider.base_url (no `/v1`).
// LongCat OpenAI surface expects `/openai/v1/responses`.
const baseUrl = (process.env.ECO_CODEX_SMOKE_BASE_URL ?? "https://api.longcat.chat/openai/v1").replace(
  /\/$/,
  "",
);
const model = process.env.ECO_CODEX_SMOKE_MODEL?.trim() || "LongCat-2.0";
const timeoutMs = Number.parseInt(process.env.ECO_CODEX_SMOKE_TIMEOUT_MS ?? "600000", 10);
const providerSlug = "longcat";
const marker = process.env.ECO_SMOKE_MARKER?.trim() || `LC${Date.now().toString(36).toUpperCase()}`;
const runId =
  process.env.ECO_CODEX_SMOKE_RUN_ID?.trim() || new Date().toISOString().replace(/[:.]/g, "-") + `-${marker}`;

if (!apiKey) {
  console.error("Missing LONGCAT_API_KEY or ECO_CODEX_SMOKE_API_KEY");
  process.exit(2);
}

const codexExecutable = resolveCodexExecutable();
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-scenario-home-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-scenario-ws-"));
const outDir = process.env.ECO_CODEX_SMOKE_FIXTURE_DIR?.trim()
  ? path.resolve(process.env.ECO_CODEX_SMOKE_FIXTURE_DIR)
  : path.join(fixturesRoot, runId);

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(fixturesRoot, { recursive: true });

/** @type {Array<Record<string, unknown>>} */
const rpcLog = [];
let seq = 0;

function logRpc(entry) {
  const row = {
    seq: ++seq,
    ts: new Date().toISOString(),
    ...entry,
  };
  rpcLog.push(row);
  fs.appendFileSync(path.join(outDir, "rpc-log.jsonl"), `${JSON.stringify(redact(row))}\n`);
}

setupWorkspace();
const hooks = await syncEcoCodexHooks({ codexHomeDir: codexHome, enableSpawnAgent: true });
const agentRolePath = writeAgentRole();
writeConfigToml(hooks.trustTomlBlock);

const child = spawn(codexExecutable, ["app-server", "--stdio"], {
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    LONGCAT_API_KEY: apiKey,
  },
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
    // Unattended smoke: approve everything Codex asks.
    if (method.includes("requestApproval") || method.endsWith("/requestApproval")) {
      return { decision: "accept", accept: true, approved: true };
    }
    if (method.includes("requestUserInput") || method.includes("elicitation")) {
      return {
        answers: {},
        accepted: true,
        content: [{ type: "text", text: "approved by scenario smoke" }],
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
  codexVersion: null,
  startedAt: new Date().toISOString(),
  ok: false,
  checklist: null,
  errors: [],
};

try {
  const init = await client.initialize({
    clientInfo: {
      name: "eco_codex_scenario_smoke",
      title: "Mori Codex Scenario Smoke",
      version: "1.0.0",
    },
    capabilities: { experimentalApi: true },
  });
  report.codexVersion = init.userAgent ?? null;
  logRpc({ kind: "client_result", method: "initialize", params: init });

  const skills = await listCodexSkills(client, { cwds: [workspace], forceReload: true });
  logRpc({ kind: "client_result", method: "skills/list", params: skills });
  fs.writeFileSync(path.join(outDir, "skills-list.json"), JSON.stringify(skills, null, 2));

  const threadConfig = {
    model,
    features: { multi_agent: true, hooks: true },
    agents: {
      max_threads: 8,
      max_depth: 1,
      smoke_worker: {
        description: "Short-lived worker for Mori scenario smoke. Reply with the given marker only.",
        config_file: agentRolePath,
      },
    },
    skills: {
      config: [
        {
          path: path.join(codexHome, "skills", "smoke-skill"),
          enabled: true,
        },
      ],
    },
    mcp_servers: {
      eco_smoke: { enabled: true, enabled_tools: ["smoke_ping", "smoke_echo"] },
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

  const prompt = buildPrompt(marker);
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

  let read = null;
  try {
    read = await client.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    logRpc({
      kind: "client_result",
      method: "thread/read",
      params: { threadId, status: read.thread?.status },
    });
    fs.writeFileSync(path.join(outDir, "thread-read.json"), JSON.stringify(redact(read), null, 2));
  } catch (readError) {
    report.errors.push(`thread/read failed: ${String(readError)}`);
  }

  const workspaceFiles = snapshotWorkspace(workspace);
  fs.writeFileSync(path.join(outDir, "workspace-files.json"), JSON.stringify(workspaceFiles, null, 2));

  const evaluation = evaluateScenarioChecklist({
    rpcLog,
    workspaceFiles,
    marker,
    skillsListResult: skills,
  });
  report.checklist = evaluation.checklist;
  report.observed = evaluation.observed;
  report.ok = evaluation.ok && turnStatus === "completed";
  report.failed = evaluation.failed;
  report.finishedAt = new Date().toISOString();

  // Compare against previous latest baseline if present
  const latestPointer = path.join(fixturesRoot, "latest.json");
  if (fs.existsSync(latestPointer)) {
    try {
      const prev = JSON.parse(fs.readFileSync(latestPointer, "utf8"));
      const prevSummaryPath = path.join(fixturesRoot, prev.runId, "summary.json");
      if (fs.existsSync(prevSummaryPath)) {
        const baseline = JSON.parse(fs.readFileSync(prevSummaryPath, "utf8"));
        report.baselineDiff = diffAgainstBaseline(baseline, evaluation);
      }
    } catch (error) {
      report.baselineDiffError = String(error);
    }
  }

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "meta.json"),
    JSON.stringify(
      {
        runId,
        marker,
        model,
        baseUrl,
        codexExecutable,
        codexVersion: report.codexVersion,
        workspace,
        codexHome,
        recordedAt: report.finishedAt,
        apiKeyRedacted: true,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    latestPointer,
    JSON.stringify({ runId, path: outDir, marker, ok: report.ok, recordedAt: report.finishedAt }, null, 2),
  );

  console.log(
    JSON.stringify(
      { ok: report.ok, runId, outDir, failed: report.failed, checklist: report.checklist },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.errors.push(String(error));
  report.finishedAt = new Date().toISOString();
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
  // Keep workspace copy inside fixture already; remove temp workspace
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
  if (stderr.trim()) {
    console.error("---stderr tail---\n", stderr.slice(-3000));
  }
}

function resolveCodexExecutable() {
  const fromEnv = process.env.CODEX_EXECUTABLE?.trim();
  if (fromEnv) return fromEnv;
  const win = path.join(root, "apps/desktop/node_modules/.bin/codex.exe");
  const unix = path.join(root, "apps/desktop/node_modules/.bin/codex");
  if (process.platform === "win32" && fs.existsSync(win)) return win;
  if (fs.existsSync(unix)) return unix;
  throw new Error("Codex executable not found. Install @openai/codex in apps/desktop.");
}

function setupWorkspace() {
  fs.writeFileSync(
    path.join(workspace, "README.md"),
    `# Mori Codex Scenario Smoke Workspace\nmarker=${marker}\n`,
  );

  const skillDir = path.join(codexHome, "skills", "smoke-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---
name: smoke-skill
description: Mori Codex scenario smoke skill. When asked about SMOKE_SKILL, reply with SMOKE_SKILL_OK and the marker.
---
# Smoke Skill

When the user asks you to use this skill, include the exact token \`SMOKE_SKILL_OK\` and the session marker in your reply.
`,
  );

  // Also place under workspace skills discovery roots Eco cares about
  const wsSkill = path.join(workspace, ".agents", "skills", "smoke-skill");
  fs.mkdirSync(wsSkill, { recursive: true });
  fs.copyFileSync(path.join(skillDir, "SKILL.md"), path.join(wsSkill, "SKILL.md"));
}

function writeAgentRole() {
  const agentsDir = path.join(codexHome, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const rolePath = path.join(agentsDir, "smoke_worker.toml");
  const toml = [
    'name = "smoke_worker"',
    'description = "Short worker for Mori scenario smoke. Do one tiny task and reply with the provided marker."',
    `developer_instructions = ${JSON.stringify(
      "You are smoke_worker. Do not call tools unless required. Reply with exactly the marker string the parent asked for.",
    )}`,
    `model = ${JSON.stringify(model)}`,
    `model_provider = ${JSON.stringify(providerSlug)}`,
    'sandbox_mode = "workspace-write"',
    'approval_policy = "never"',
    "",
    "[sandbox_workspace_write]",
    "network_access = false",
    "",
  ].join("\n");
  fs.writeFileSync(rolePath, toml);
  return rolePath;
}

function writeConfigToml(trustTomlBlock) {
  // Community: pin absolute node.exe on Windows — PATH/`bun` resolution breaks MCP spawn.
  // Ref: openai/codex#18486 (pin real Node; stdout must be JSON-RPC only).
  const nodeExe = resolveNodeExecutable();
  const mcpLog = path.join(outDir, "mcp-server.log");
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
    "[mcp_servers.eco_smoke]",
    `command = ${JSON.stringify(nodeExe)}`,
    `args = ${JSON.stringify([mcpServerPath])}`,
    'enabled_tools = ["smoke_ping", "smoke_echo"]',
    "startup_timeout_sec = 60",
    "",
    "[mcp_servers.eco_smoke.env]",
    `ECO_SMOKE_MCP_LOG = ${JSON.stringify(mcpLog)}`,
    "",
    trustTomlBlock.trim(),
    "",
  ];
  fs.writeFileSync(path.join(codexHome, "config.toml"), `${lines.join("\n").trim()}\n`);
}

/** Prefer absolute node.exe so Codex can spawn MCP on Windows without PATH quirks. */
function resolveNodeExecutable() {
  const fromEnv = process.env.ECO_SMOKE_NODE_EXE?.trim() || process.env.NODE_EXE?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (process.platform === "win32") {
    const winNode = "C:\\Program Files\\nodejs\\node.exe";
    if (fs.existsSync(winNode)) return winNode;
  }
  // Prefer system `node` over `bun` (process.execPath may be bun when runner is bun).
  return "node";
}

function buildPrompt(m) {
  return buildScenarioPrompt(m);
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
  walk(dir);
  return files;
}

function waitForNotification(client, method, threadId, waitMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      remove();
      reject(new Error(`timeout waiting for ${method} on ${threadId}`));
    }, waitMs);
    const remove = client.addNotificationHandler((m, p) => {
      if (m !== method) return;
      if (p?.threadId && p.threadId !== threadId) return;
      clearTimeout(timer);
      remove();
      resolve(p);
    });
  });
}

async function waitIdle(client, threadId, waitMs) {
  const started = Date.now();
  let lastStatus = null;
  while (Date.now() - started < waitMs) {
    const r = await client.request("thread/read", { threadId, includeTurns: false });
    const status = r.thread?.status;
    const type = typeof status === "string" ? status : status?.type;
    lastStatus = type ?? status;
    // idle is success; systemError / failed are terminal — stop waiting and let checklist fail.
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
