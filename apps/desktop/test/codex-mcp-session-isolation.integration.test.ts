import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { CodexRuntimeLifecycle } from "../src/main/codex-runtime-lifecycle";
import { handleMcpStreamableHttpRequest } from "../src/main/mcp-streamable-http";

const temporaryDirectories: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

test("Codex app-server instances isolate MCP headers by session and recover from the same home", async () => {
  if (process.platform === "win32") {
    // The production lifecycle expects an executable path. The shebang wrapper
    // below is intentionally POSIX so this probe does not pretend to cover
    // Windows process launch semantics.
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-mcp-isolation-"));
  temporaryDirectories.push(root);
  const fakeCodex = await writeFakeCodexExecutable(root);
  const tokens = { A: "Bearer eco-probe-A", B: "Bearer eco-probe-B" };
  const requests: Array<{ method: string; authorization: string }> = [];
  const mcpServer = http.createServer((request, response) => {
    void handleMcpStreamableHttpRequest(request, response, {
      serverName: "eco_isolation_probe",
      listTools: async ({ authToken }) => {
        requests.push({ method: "tools/list", authorization: authToken ?? "" });
        return { tools: [{ name: "echo_context", inputSchema: { type: "object" } }] };
      },
      callTool: async ({ authToken }) => {
        requests.push({ method: "tools/call", authorization: authToken ?? "" });
        return { content: [{ type: "text", text: authToken ?? "" }] };
      },
    });
  });
  servers.push(mcpServer);
  await new Promise<void>((resolve, reject) => {
    mcpServer.once("error", reject);
    mcpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = mcpServer.address();
  if (!address || typeof address === "string") throw new Error("isolation probe MCP server did not bind");
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

  const dataA = path.join(root, "session-a");
  const dataB = path.join(root, "session-b");
  await Promise.all([
    writeSessionConfig(dataA, mcpUrl, tokens.A),
    writeSessionConfig(dataB, mcpUrl, tokens.B),
  ]);

  const lifecycleA = new CodexRuntimeLifecycle({ ecoDataDir: dataA, codexExecutable: fakeCodex });
  const lifecycleB = new CodexRuntimeLifecycle({ ecoDataDir: dataB, codexExecutable: fakeCodex });
  try {
    await Promise.all([lifecycleA.start(), lifecycleB.start()]);
    const firstA = await readProbe(path.join(dataA, "codex", "fake-mcp-probe.json"));
    const firstB = await readProbe(path.join(dataB, "codex", "fake-mcp-probe.json"));

    expect(firstA.authorization).toBe(tokens.A);
    expect(firstB.authorization).toBe(tokens.B);
    expect(firstA.home).toBe(path.join(dataA, "codex"));
    expect(firstB.home).toBe(path.join(dataB, "codex"));
    expect(firstA.pid).not.toBe(firstB.pid);
    expect(requests.map((entry) => entry.authorization).sort()).toEqual(["eco-probe-A", "eco-probe-B"]);
    expect(lifecycleA.isRunning()).toBe(true);
    expect(lifecycleB.isRunning()).toBe(true);

    await Promise.all([lifecycleA.stop(), lifecycleB.stop()]);
    expect(lifecycleA.isRunning()).toBe(false);
    expect(lifecycleB.isRunning()).toBe(false);

    // A second lifecycle using the same session home sees the same static MCP
    // header and persists the probe marker. This is the recovery boundary the
    // shared global lifecycle cannot provide per session by itself.
    const recoveredA = new CodexRuntimeLifecycle({ ecoDataDir: dataA, codexExecutable: fakeCodex });
    try {
      await recoveredA.start();
      const secondA = await readProbe(path.join(dataA, "codex", "fake-mcp-probe.json"));
      expect(secondA.authorization).toBe(tokens.A);
      expect(secondA.runCount).toBe(2);
      expect(secondA.pid).not.toBe(firstA.pid);
      expect(requests.at(-1)?.authorization).toBe("eco-probe-A");
    } finally {
      await recoveredA.stop();
    }
  } finally {
    await Promise.all([lifecycleA.stop(), lifecycleB.stop()]);
  }
});

async function writeSessionConfig(ecoDataDir: string, mcpUrl: string, authorization: string): Promise<void> {
  const codexHome = path.join(ecoDataDir, "codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    [
      'model = "eco-isolation-probe"',
      "",
      "[mcp_servers.mori_mcp]",
      `url = "${mcpUrl}"`,
      "[mcp_servers.mori_mcp.http_headers]",
      `Authorization = "${authorization}"`,
      "",
    ].join("\n"),
  );
}

async function writeFakeCodexExecutable(root: string): Promise<string> {
  const script = path.join(root, "fake-codex.mjs");
  await fs.writeFile(
    script,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const home = process.env.CODEX_HOME;
if (!home) throw new Error("CODEX_HOME is required");
const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
const url = config.match(/^url\\s*=\\s*"([^"]+)"/m)?.[1];
const authorization = config.match(/^Authorization\\s*=\\s*"([^"]+)"/m)?.[1] ?? "";
if (!url) throw new Error("MCP URL missing from config.toml");
const markerPath = path.join(home, "fake-mcp-probe.json");
const previous = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, "utf8")) : {};
const headers = { "content-type": "application/json", authorization };
let sessionId;
const rpc = async (id, method, params) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
  });
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  return response.json();
};
const init = await rpc(0, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-codex", version: "0.1.0" } });
await fetch(url, { method: "POST", headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
const listed = await rpc(1, "tools/list");
fs.writeFileSync(markerPath, JSON.stringify({
  pid: process.pid,
  home,
  authorization,
  protocolVersion: init?.result?.protocolVersion,
  toolCount: listed?.result?.tools?.length ?? 0,
  runCount: Number(previous.runCount ?? 0) + 1,
}));

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { codexHome: home, thread: { id: "fake-thread" } } }) + "\\n");
});
`,
    { mode: 0o755 },
  );
  return script;
}

type ProbeMarker = {
  pid: number;
  home: string;
  authorization: string;
  runCount: number;
};

async function readProbe(filePath: string): Promise<ProbeMarker> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as ProbeMarker;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
