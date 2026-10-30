/**
 * Focused MCP handshake probe against Codex app-server (no model turn).
 *
 *   bun scripts/codex-scenario-smoke/probe-mcp-handshake.mjs
 *
 * Writes mcp-handshake-probe.json + mcp-server.log under fixtures/_probe/
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../packages/runtime/src/codex-app-server-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const mcpServerPath = path.join(__dirname, "mcp-echo-server.mjs");
const outDir = path.join(__dirname, "fixtures", "_probe");
fs.mkdirSync(outDir, { recursive: true });
const mcpLog = path.join(outDir, "mcp-server.log");
fs.writeFileSync(mcpLog, "");

const nodeExe = resolveNodeExecutable();
const codexExecutable = resolveCodexExecutable();
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "eco-mcp-probe-home-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eco-mcp-probe-ws-"));

fs.writeFileSync(
  path.join(codexHome, "config.toml"),
  [
    'model = "gpt-5.1-codex-mini"',
    'model_provider = "stub"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    "",
    "[features]",
    "remote_plugin = false",
    "plugins = false",
    "",
    "[model_providers.stub]",
    'name = "stub"',
    'base_url = "http://127.0.0.1:9/v1"',
    'env_key = "STUB_API_KEY"',
    'wire_api = "responses"',
    "request_max_retries = 0",
    "stream_idle_timeout_ms = 1000",
    "",
    "[mcp_servers.eco_smoke]",
    `command = ${JSON.stringify(nodeExe)}`,
    `args = ${JSON.stringify([mcpServerPath])}`,
    'enabled_tools = ["smoke_ping", "smoke_echo"]',
    "startup_timeout_sec = 20",
    "",
    "[mcp_servers.eco_smoke.env]",
    `ECO_SMOKE_MCP_LOG = ${JSON.stringify(mcpLog)}`,
    "",
  ].join("\n"),
);

const child = spawn(codexExecutable, ["app-server", "--stdio"], {
  env: { ...process.env, CODEX_HOME: codexHome, STUB_API_KEY: "k" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
  stderr += c;
});

const statuses = [];
const client = CodexAppServerClient.attachToProcess(child, { timeoutMs: 30_000 });
client.addNotificationHandler((method, params) => {
  if (method.startsWith("mcp") || method.includes("mcp")) {
    statuses.push({ ts: new Date().toISOString(), method, params });
  }
});

const report = {
  nodeExe,
  mcpServerPath,
  framing: "ndjson",
  ok: false,
  list: null,
  statuses,
  mcpLogTail: "",
  stderrTail: "",
  errors: [],
};

try {
  await client.initialize({
    clientInfo: { name: "eco_mcp_probe", title: "Mori MCP Probe", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });

  // Give Codex time to spawn/handshake MCP (lazy start is common).
  await sleep(2000);

  // Force MCP use by starting a thread with mcp enabled — status list often populates after.
  const started = await client.request("thread/start", {
    cwd: workspace,
    modelProvider: "stub",
    config: {
      model: "gpt-5.1-codex-mini",
      mcp_servers: {
        eco_smoke: { enabled: true, enabled_tools: ["smoke_ping", "smoke_echo"] },
      },
    },
  });

  // Poll status for up to ~25s
  let list = null;
  for (let i = 0; i < 25; i++) {
    try {
      list = await client.request("mcpServerStatus/list", {});
      report.list = list;
      const data = list?.data ?? list?.servers ?? list;
      const entries = Array.isArray(data) ? data : [];
      const eco = entries.find(
        (s) =>
          s?.name === "eco_smoke" ||
          s?.server === "eco_smoke" ||
          String(s?.authStatus ?? s?.status ?? "").length > 0,
      );
      // Also accept any entry mentioning eco_smoke
      const hit = entries.find((s) => JSON.stringify(s).includes("eco_smoke"));
      if (hit) {
        const blob = JSON.stringify(hit).toLowerCase();
        if (blob.includes("ready") || blob.includes("enabled") || blob.includes("running")) {
          report.ok = true;
          break;
        }
        if (blob.includes("error") || blob.includes("failed") || blob.includes("timed")) {
          report.errors.push(JSON.stringify(hit));
          break;
        }
      }
    } catch (error) {
      report.errors.push(String(error));
    }
    await sleep(1000);
  }

  // Fallback: if MCP log shows initialize was answered, treat handshake as OK even if status API is vague.
  if (fs.existsSync(mcpLog)) {
    const logText = fs.readFileSync(mcpLog, "utf8");
    report.mcpLogTail = logText.slice(-2000);
    if (logText.includes("method=initialize") && logText.includes('"serverInfo"')) {
      report.ok = true;
      report.handshakeEvidence = "mcp-server.log saw initialize + serverInfo response";
    } else if (logText.includes("START") && !logText.includes("method=initialize")) {
      report.errors.push("MCP process started but never received initialize (Codex stdin not delivered?)");
    }
  }

  // Touch thread id so GC doesn't complain
  void started.thread?.id;
} catch (error) {
  report.errors.push(String(error));
} finally {
  report.stderrTail = stderr.slice(-2500);
  client.close();
  child.kill("SIGTERM");
  await sleep(300);
  fs.writeFileSync(path.join(outDir, "mcp-handshake-probe.json"), JSON.stringify(report, null, 2));
  try {
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

function resolveNodeExecutable() {
  const fromEnv = process.env.ECO_SMOKE_NODE_EXE?.trim() || process.env.NODE_EXE?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (process.platform === "win32") {
    const winNode = "C:\\Program Files\\nodejs\\node.exe";
    if (fs.existsSync(winNode)) return winNode;
  }
  return "node";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveCodexExecutable() {
  const fromEnv = process.env.CODEX_EXECUTABLE?.trim();
  if (fromEnv) return fromEnv;
  const win = path.join(root, "apps/desktop/node_modules/.bin/codex.exe");
  if (process.platform === "win32" && fs.existsSync(win)) return win;
  return path.join(root, "apps/desktop/node_modules/.bin/codex");
}
