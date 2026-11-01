import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent } from "../src";
import { PI_MCP_HUB_TOOL_NAMES } from "../src/pi-mcp";
import { type ProbeSessionResult, runScriptedPiSession } from "./pi-session-events-probe";

const echoTool = "mcp__lc_echo__echo";

async function fixture(silent = false) {
  const workspace = await mkdtemp(path.join(tmpdir(), "eco-pi-mcp-session-"));
  const agentDir = path.join(workspace, "agent");
  await mkdir(agentDir);
  const pidPath = path.join(workspace, "server.pid");
  const serverPath = path.join(workspace, "server.mjs");
  await writeFile(
    serverPath,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      silent
        ? "process.stdin.resume();"
        : `await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "_lc-mcp-server.mjs")).href)});`,
    ].join("\n"),
  );
  return {
    workspace,
    agentDir,
    pidPath,
    mcpServers: { lc_echo: { command: "node", args: [serverPath], timeout: 2_000 } },
  };
}

function terminal(events: AgentEvent[]) {
  return events.find((event) => event.type === "run.terminal")?.payload as
    | { status?: string; error?: string }
    | undefined;
}

function toolResult(events: AgentEvent[], id: string) {
  return events.find(
    (event) =>
      event.type === "tool.completed" && (event.payload as { tool_use_id?: string }).tool_use_id === id,
  )?.payload as { content?: string } | undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("driver exposes real non-Hub MCP tools and disposal stops their stdio process", async () => {
  const input = await fixture();
  let result: ProbeSessionResult | undefined;
  try {
    result = await runScriptedPiSession({
      ...input,
      threadId: "mcp-direct",
      turns: [{ tool: echoTool, id: "echo_1", input: { text: "DIRECT-PROBE" } }, { text: "done" }],
    });
    expect(result.requests[0]?.toolNames).toEqual(["read", "bash", "edit", "write", "codemode", echoTool]);
    expect(toolResult(result.events, "echo_1")?.content).toContain("MCP-ECHO: DIRECT-PROBE");
    expect(terminal(result.events)?.status).toBe("completed");
    const pid = Number(await readFile(input.pidPath, "utf8"));
    expect(isAlive(pid)).toBe(true);
    await result.dispose();
    expect(isAlive(pid)).toBe(false);
  } finally {
    await result?.dispose();
    await rm(input.workspace, { recursive: true, force: true });
  }
});

test("codemode sees selected MCP tools and enforces nested permission rejection", async () => {
  const input = await fixture();
  const approvals: string[] = [];
  let result: ProbeSessionResult | undefined;
  try {
    result = await runScriptedPiSession({
      ...input,
      threadId: "mcp-nested-permission",
      toolsAllowlist: ["read", "codemode", ...PI_MCP_HUB_TOOL_NAMES],
      toolPermissionHandler: async (request) => {
        approvals.push(request.toolName);
        return request.toolName === echoTool
          ? { behavior: "deny", message: "MCP-NESTED-DENIED" }
          : { behavior: "allow", updatedInput: request.input };
      },
      turns: [
        { tool: "codemode", id: "names", input: { code: "return ALL_TOOLS.map(t => t.name);" } },
        {
          tool: "codemode",
          id: "nested",
          input: { code: `return await tools[${JSON.stringify(echoTool)}]({text:"SECRET"});` },
        },
        { text: "done" },
      ],
    });
    expect(result.requests[0]?.toolNames).toEqual(["read", "codemode", echoTool]);
    expect(toolResult(result.events, "names")?.content).toContain(`["read","${echoTool}"]`);
    expect(approvals).toContain(echoTool);
    const denied = result.events.filter((event) => event.type === "tool.failed");
    expect(JSON.stringify(denied)).toContain("MCP-NESTED-DENIED");
    expect(JSON.stringify(denied)).toContain('"parent_tool_call_id":"nested"');
  } finally {
    await result?.dispose();
    await rm(input.workspace, { recursive: true, force: true });
  }
});

test("native sanitized tool names use their actual server owner for the allowlist", async () => {
  const input = await fixture();
  let result: ProbeSessionResult | undefined;
  try {
    result = await runScriptedPiSession({
      ...input,
      mcpServers: { "eco-mcp": input.mcpServers.lc_echo },
      threadId: "mcp-sanitized-name",
      turns: [{ tool: "mcp__eco_mcp__echo", id: "echo", input: { text: "SANITIZED" } }, { text: "done" }],
    });
    expect(result.requests[0]?.toolNames).toContain("mcp__eco_mcp__echo");
    expect(toolResult(result.events, "echo")?.content).toContain("MCP-ECHO: SANITIZED");
  } finally {
    await result?.dispose();
    await rm(input.workspace, { recursive: true, force: true });
  }
});

test("MCP timeout changes rebuild the real session and close its previous transport", async () => {
  const input = await fixture();
  let result: ProbeSessionResult | undefined;
  try {
    const firstConfig = { lc_echo: { ...input.mcpServers.lc_echo, timeout: 60_000 } };
    result = await runScriptedPiSession({
      ...input,
      mcpServers: firstConfig,
      threadId: "mcp-timeout-drift",
      turns: [{ text: "done" }],
    });
    const firstPid = Number(await readFile(input.pidPath, "utf8"));
    const nextEvents = await result.runAgain({ lc_echo: { ...firstConfig.lc_echo, timeout: 600_000 } });
    const firstSession = result.events.find((event) => event.type === "session.captured")?.agentId;
    const nextSession = nextEvents.find((event) => event.type === "session.captured")?.agentId;
    expect(firstSession).toBeDefined();
    expect(nextSession).toBeDefined();
    // Rebuild the in-process session while keeping the same persisted conversation.
    expect(nextSession).toBe(firstSession);
    const nextPid = Number(await readFile(input.pidPath, "utf8"));
    expect(nextPid).not.toBe(firstPid);
    expect(isAlive(firstPid)).toBe(false);
    expect(result.requests[1]?.toolNames).toContain(echoTool);
    expect(terminal(nextEvents)?.status).toBe("completed");
  } finally {
    await result?.dispose();
    await rm(input.workspace, { recursive: true, force: true });
  }
});

test("unreachable MCP fails before any model request", async () => {
  const input = await fixture();
  let result: ProbeSessionResult | undefined;
  try {
    result = await runScriptedPiSession({
      ...input,
      threadId: "mcp-unreachable",
      mcpServers: { eco_mcp: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      turns: [{ text: "must not run" }],
    });
    expect(result.requests).toHaveLength(0);
    expect(terminal(result.events)).toMatchObject({ status: "failed" });
    expect(terminal(result.events)?.error).toContain("eco_mcp");
  } finally {
    await result?.dispose();
    await rm(input.workspace, { recursive: true, force: true });
  }
});

test("MCP startup timeout fails explicitly and closes a transport still initializing", async () => {
  const input = await fixture(true);
  let result: ProbeSessionResult | undefined;
  try {
    result = await runScriptedPiSession({
      ...input,
      threadId: "mcp-hanging",
      mcpStartupWaitMs: 250,
      turns: [{ text: "must not run" }],
    });
    expect(result.requests).toHaveLength(0);
    expect(terminal(result.events)).toMatchObject({ status: "failed" });
    expect(terminal(result.events)?.error).toContain("still connecting");
    expect(isAlive(Number(await readFile(input.pidPath, "utf8")))).toBe(false);
  } finally {
    await result?.dispose();
    await rm(input.workspace, { recursive: true, force: true });
  }
});

test("failed MCP startup retries with a fresh connection, including a server with zero tools", async () => {
  const input = await fixture();
  let rejectAuth = true;
  const server = http.createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      if (rejectAuth) {
        response.writeHead(401);
        response.end("MCP-AUTH-REJECTED");
        return;
      }
      const message = JSON.parse(raw);
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result:
            message.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "empty", version: "1" },
                }
              : { tools: [] },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  let result: ProbeSessionResult | undefined;
  try {
    result = await runScriptedPiSession({
      ...input,
      threadId: "mcp-auth-retry",
      mcpServers: {
        empty: {
          type: "http",
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: "Bearer test" },
        },
      },
      turns: [{ text: "done" }],
    });
    expect(result.requests).toHaveLength(0);
    expect(terminal(result.events)?.status).toBe("failed");
    rejectAuth = false;
    const next = await result.runAgain();
    expect(result.requests).toHaveLength(1);
    expect(terminal(next)?.status).toBe("completed");
  } finally {
    await result?.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(input.workspace, { recursive: true, force: true });
  }
});

test("Ask never connects configured MCP or declares codemode", async () => {
  const input = await fixture();
  let result: ProbeSessionResult | undefined;
  try {
    result = await runScriptedPiSession({
      ...input,
      sessionMode: "ask",
      threadId: "mcp-ask",
      turns: [{ text: "done" }],
    });
    expect(result.requests[0]?.toolNames).toEqual(["read", "bash"]);
    expect(terminal(result.events)?.status).toBe("completed");
    expect(await Bun.file(input.pidPath).exists()).toBe(false);
  } finally {
    await result?.dispose();
    await rm(input.workspace, { recursive: true, force: true });
  }
});

test("Plan connects MCP and executes research tools through the normal permission handler", async () => {
  const input = await fixture();
  const approvals: string[] = [];
  let result: ProbeSessionResult | undefined;
  try {
    result = await runScriptedPiSession({
      ...input,
      sessionMode: "plan",
      threadId: "mcp-plan-research",
      toolPermissionHandler: async (request) => {
        approvals.push(request.toolName);
        return { behavior: "allow", updatedInput: request.input };
      },
      turns: [
        { tool: echoTool, id: "research", input: { text: "PLAN-RESEARCH" } },
        { tool: "bash", id: "bash-research", input: { command: `node -p '"PLAN-BASH-RESEARCH"'` } },
        { text: "done" },
      ],
    });
    expect(result.requests[0]?.toolNames).toEqual(["read", "finalize_plan", "bash", echoTool]);
    expect(toolResult(result.events, "research")?.content).toContain("MCP-ECHO: PLAN-RESEARCH");
    expect(toolResult(result.events, "bash-research")?.content).toContain("PLAN-BASH-RESEARCH");
    expect(approvals).toContain(echoTool);
    expect(approvals).toContain("Bash");
    expect(terminal(result.events)?.status).toBe("completed");
    expect(await Bun.file(input.pidPath).exists()).toBe(true);
  } finally {
    await result?.dispose();
    await rm(input.workspace, { recursive: true, force: true });
  }
});
