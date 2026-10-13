import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { McpHubGateway } from "../src/main/mcp-hub-gateway";
import { IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS } from "../src/shared/image-generation";

function headers(entry: Record<string, unknown>): Record<string, string> {
  return (entry.headers ?? {}) as Record<string, string>;
}

async function rpc(url: string, h: Record<string, string>, body: Record<string, unknown>, sid?: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...h, "content-type": "application/json", ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

async function initialize(entry: Record<string, unknown>) {
  const url = String(entry.url);
  const h = headers(entry);
  const init = await rpc(url, h, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi-test", version: "1" } },
  });
  const sid = init.response.headers.get("mcp-session-id")!;
  await rpc(url, h, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  return { url, h, sid };
}

test("MCP Hub gateway gives a Pi-shaped eco_mcp entry and dispatches over real HTTP", async () => {
  const gateway = new McpHubGateway();
  gateway.registerServer({
    name: "probe",
    server: {
      name: "probe",
      listTools: async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
      callTool: async ({ name, arguments: args }) => ({ content: [{ type: "text", text: `${name}:${String(args.value ?? "")}` }] }),
    },
  });
  try {
    const prepared = await gateway.prepareThread({ threadId: "pi-thread-a", allowedServers: ["probe"] });
    const { url, h, sid } = await initialize(prepared.sdkEntry);
    const listed = await rpc(url, h, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    expect((listed.body.result as { tools: Array<{ name: string }> }).tools.map((x) => x.name)).toEqual(["search_tools", "call_tool"]);
    const search = await rpc(url, h, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_tools", arguments: {} } }, sid);
    expect((search.body.result as { structuredContent: { tools: Array<{ name: string }> } }).structuredContent.tools.map((x) => x.name)).toEqual(["probe:echo"]);
    const called = await rpc(url, h, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "call_tool", arguments: { name: "probe:echo", arguments: { value: "ok" } } } }, sid);
    expect((called.body.result as { content: Array<{ text: string }> }).content[0]?.text).toBe("echo:ok");
  } finally {
    await gateway.close();
  }
});

test("MCP Hub keeps image generation's 10-minute timeout on the outer wrapper", async () => {
  const gateway = new McpHubGateway();
  try {
    const prepared = await gateway.prepareThread({
      threadId: "image-timeout-thread",
      allowedServers: ["eco_image_generation"],
      runtimeName: "eco_mcp_image_timeout",
    });
    expect(IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
    expect(prepared.sdkEntry).toMatchObject({
      timeout: IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS,
      requestTimeoutMs: IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS,
    });
    expect(prepared.codexServer.toolTimeoutSec).toBe(
      Math.ceil(IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS / 1000),
    );
  } finally {
    await gateway.close();
  }
});

test("MCP Hub gateway adapts HTTP config and enforces per-thread token scope", async () => {
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: string; method?: string; params?: Record<string, unknown> };
    res.setHeader("content-type", "application/json");
    if (message.method === "initialize") {
      res.setHeader("mcp-session-id", "upstream-session");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } }));
      return;
    }
    if (message.method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    calls += 1;
    if (message.method === "tools/list") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }));
      return;
    }
    const args = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(args.value ?? "") }] } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const gateway = new McpHubGateway();
  try {
    expect(gateway.syncSdkConfig({ mcpServers: { remote: { type: "http", url: `http://127.0.0.1:${port}/mcp` } }, allowedTools: ["mcp__remote__echo"] })).toEqual({ registered: ["remote"], unsupported: [] });
    const prepared = (await gateway.prepareThreadFromSdkConfig({
      threadId: "remote-a",
      config: { mcpServers: { remote: { type: "http", url: `http://127.0.0.1:${port}/mcp` } }, allowedTools: ["mcp__remote__echo"] },
      allowedServers: ["remote"],
    }))!;
    expect(prepared.promptAppend).toContain('"server":"remote"');
    expect(prepared.promptAppend).toContain('"name":"remote:echo"');
    expect(prepared.promptAppend).toContain("Description not provided");
    expect(prepared.promptAppend).not.toContain(`127.0.0.1:${port}`);
    expect(gateway.getThreadPromptAppend("remote-a")).toBe(prepared.promptAppend);
    const a = await initialize(prepared.sdkEntry);
    const search = await rpc(a.url, a.h, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_tools", arguments: {} } }, a.sid);
    expect((search.body.result as { structuredContent: { tools: Array<{ name: string }> } }).structuredContent.tools.map((x) => x.name)).toEqual(["remote:echo"]);
    const called = await rpc(a.url, a.h, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "call_tool", arguments: { name: "remote:echo", arguments: { value: "remote-ok" } } } }, a.sid);
    expect((called.body.result as { content: Array<{ text: string }> }).content[0]?.text).toBe("remote-ok");
    expect(calls).toBe(3);
    const other = await gateway.prepareThread({ threadId: "remote-b", allowedServers: [] });
    expect(gateway.getThreadPromptAppend("remote-b")).toBeUndefined();
    const b = await initialize(other.sdkEntry);
    const denied = await rpc(b.url, b.h, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_tools", arguments: {} } }, b.sid);
    expect((denied.body.result as { structuredContent: { tools: unknown[] } }).structuredContent.tools).toEqual([]);
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("MCP Hub injects real stdio capabilities, refreshes permissions and removes disabled directories", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-hub-directory-"));
  const script = path.join(directory, "server.mjs");
  await fs.writeFile(script, `
import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const tools = [
    { name: "read", description: "Read database records", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { name: "write", description: "Modify database records", inputSchema: { type: "object" } },
  ];
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "database", version: "1" } }
    : { tools };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);
  const gateway = new McpHubGateway();
  const servers = {
    database: { command: process.execPath, args: [script], env: { ECO_DIRECTORY_TEST_SECRET: "private-config-value" } },
    unselected: { command: "this-server-must-never-be-launched" },
  };
  try {
    const first = (await gateway.prepareThreadFromSdkConfig({
      threadId: "stdio-thread", config: { mcpServers: servers, allowedTools: ["mcp__database__read"] }, allowedServers: ["database"],
    }))!;
    expect(first.promptAppend).toContain("database:read");
    expect(first.promptAppend).toContain("Read database records");
    expect(first.promptAppend).not.toContain("Modify database records");
    expect(first.promptAppend).not.toContain("unselected");
    expect(first.promptAppend).not.toContain("private-config-value");
    expect(first.promptAppend).not.toContain(script);
    expect(first.promptAppend).not.toContain('"query"');
    const second = (await gateway.prepareThreadFromSdkConfig({
      threadId: "stdio-thread", config: { mcpServers: servers, allowedTools: ["mcp__database__write"] }, allowedServers: ["database"],
    }))!;
    expect(second.token).toBe(first.token);
    expect(second.promptAppend).toContain("database:write");
    expect(second.promptAppend).not.toContain("database:read");
    const other = await gateway.prepareThreadFromSdkConfig({
      threadId: "other-thread", config: { mcpServers: servers, allowedTools: ["mcp__database__read"] }, allowedServers: ["database"],
    });
    expect(other?.promptAppend).toContain("database:read");
    expect(gateway.getThreadPromptAppend("stdio-thread")).toBe(second.promptAppend);

    gateway.registerThreadServerEntry({ name: "eco_demo", threadId: "stdio-thread", sdkEntry: { type: "http", url: "http://127.0.0.1:1/mcp" } });
    const builtinOnly = await gateway.prepareThreadFromSdkConfig({
      threadId: "stdio-thread", config: { mcpServers: servers, allowedTools: [] }, allowedServers: ["eco_demo"],
    });
    expect(builtinOnly?.promptAppend).toBeUndefined();
    expect(gateway.getThreadPromptAppend("stdio-thread")).toBeUndefined();
    expect(gateway.getThreadPromptAppend("other-thread")).toBe(other?.promptAppend);
    gateway.revokeThread("other-thread");
    expect(gateway.getThreadPromptAppend("other-thread")).toBeUndefined();
  } finally {
    await gateway.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("MCP Hub gateway reports unsupported transports instead of silently dropping them", async () => {
  const gateway = new McpHubGateway();
  try {
    gateway.syncSdkConfig({
      mcpServers: { legacy: { type: "http", url: "http://127.0.0.1:9/mcp" } },
      allowedTools: [],
    });
    expect(
      gateway.syncSdkConfig({
        mcpServers: {
          legacy: { type: "sse", url: "http://127.0.0.1:9/sse" },
          invalid: { type: "http" },
        },
        allowedTools: [],
      }),
    ).toEqual({ registered: [], unsupported: ["legacy", "invalid"] });
    await expect(
      gateway.prepareThreadFromSdkConfig({
        threadId: "unsupported-thread",
        config: { mcpServers: { legacy: { type: "sse", url: "http://127.0.0.1:9/sse" } }, allowedTools: [] },
        allowedServers: ["legacy"],
      }),
    ).rejects.toThrow("legacy");
  } finally {
    await gateway.close();
  }
});

test("MCP Hub keeps built-in HTTP gateway credentials isolated per thread", async () => {
  const seenAuth: string[] = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: string; method?: string; params?: Record<string, unknown> };
    seenAuth.push(String(req.headers.authorization ?? ""));
    res.setHeader("content-type", "application/json");
    if (message.method === "initialize") {
      res.setHeader("mcp-session-id", `upstream-${seenAuth.at(-1)}`);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "builtin", version: "1" } } }));
      return;
    }
    if (message.method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (message.method === "tools/list") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(req.headers.authorization ?? "") }] } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const gateway = new McpHubGateway();
  try {
    gateway.registerThreadServerEntry({ name: "eco_demo", threadId: "thread-a", sdkEntry: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { authorization: "Bearer A" } } });
    gateway.registerThreadServerEntry({ name: "eco_demo", threadId: "thread-b", sdkEntry: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { authorization: "Bearer B" } } });
    const a = await gateway.prepareThread({ threadId: "thread-a", allowedServers: ["eco_demo"] });
    const b = await gateway.prepareThread({ threadId: "thread-b", allowedServers: ["eco_demo"] });
    const run = async (entry: Record<string, unknown>) => {
      const current = await initialize(entry);
      const search = await rpc(current.url, current.h, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_tools", arguments: {} } }, current.sid);
      expect((search.body.result as { structuredContent: { tools: Array<{ name: string }> } }).structuredContent.tools.map((tool) => tool.name)).toEqual(["eco_demo:echo"]);
      return rpc(current.url, current.h, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "call_tool", arguments: { name: "eco_demo:echo", arguments: {} } } }, current.sid);
    };
    const [calledA, calledB] = await Promise.all([run(a.sdkEntry), run(b.sdkEntry)]);
    expect((calledA.body.result as { content: Array<{ text: string }> }).content[0]?.text).toBe("Bearer A");
    expect((calledB.body.result as { content: Array<{ text: string }> }).content[0]?.text).toBe("Bearer B");
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("MCP Hub forwards an image server's per-entry timeout to its nested MCP client", async () => {
  let toolCallStarted = false;
  const upstream = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: string; method?: string };
    res.setHeader("content-type", "application/json");
    if (message.method === "initialize") {
      res.setHeader("mcp-session-id", "timeout-upstream-session");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "slow", version: "1" } },
      }));
      return;
    }
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
      res.statusCode = 202;
      res.end();
      return;
    }
    toolCallStarted = true;
    await new Promise((resolve) => setTimeout(resolve, 50));
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "late" }] } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const gateway = new McpHubGateway();
  try {
    gateway.registerThreadServerEntry({
      name: "eco_image_generation",
      threadId: "image-timeout-forwarding",
      sdkEntry: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        requestTimeoutMs: 10,
      },
    });
    const prepared = await gateway.prepareThread({
      threadId: "image-timeout-forwarding",
      allowedServers: ["eco_image_generation"],
    });
    const session = await initialize(prepared.sdkEntry);
    const called = await rpc(
      session.url,
      session.h,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "call_tool", arguments: { name: "eco_image_generation:slow", arguments: {} } },
      },
      session.sid,
    );
    expect(toolCallStarted).toBe(true);
    expect((called.body.error as { message?: string } | undefined)?.message).toContain(
      "MCP error -32001: Request timed out",
    );
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("MCP Hub tracks and retires thread-scoped Codex descriptors", async () => {
  const gateway = new McpHubGateway();
  try {
    const sdkEntry = {
      type: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: { authorization: "Bearer A" },
    };
    gateway.registerThreadServerEntry({ name: "eco_demo", threadId: "thread-a", sdkEntry });
    const first = await gateway.prepareThread({
      threadId: "thread-a",
      allowedServers: ["eco_demo"],
      runtimeName: "eco_mcp_thread_a",
    });
    expect(first.codexServerChanged).toBe(true);
    expect(gateway.listThreadCodexServers().map((server) => server.name)).toEqual(["eco_mcp_thread_a"]);

    const same = await gateway.prepareThread({
      threadId: "thread-a",
      allowedServers: ["eco_demo"],
      runtimeName: "eco_mcp_thread_a",
    });
    expect(same.codexServerChanged).toBeUndefined();
    expect(gateway.listThreadCodexServers()).toHaveLength(1);

    const sdkEntryB = { ...sdkEntry, headers: { authorization: "Bearer B" } };
    gateway.registerThreadServerEntry({ name: "eco_demo", threadId: "thread-b", sdkEntry: sdkEntryB });
    const second = await gateway.prepareThread({
      threadId: "thread-b",
      allowedServers: ["eco_demo"],
      runtimeName: "eco_mcp_thread_b",
    });
    expect(second.codexServerChanged).toBe(true);
    expect(gateway.listThreadCodexServers().map((server) => server.name)).toEqual([
      "eco_mcp_thread_a",
      "eco_mcp_thread_b",
    ]);

    gateway.revokeThread("thread-a");
    expect(gateway.listThreadCodexServers().map((server) => server.name)).toEqual(["eco_mcp_thread_b"]);
  } finally {
    await gateway.close();
  }
});

test("MCP Hub retires a Codex descriptor when a thread loses its last server", async () => {
  const gateway = new McpHubGateway();
  try {
    gateway.registerThreadServerEntry({
      name: "eco_demo",
      threadId: "thread-empty",
      sdkEntry: {
        type: "http",
        url: "http://127.0.0.1:1/mcp",
        headers: { authorization: "Bearer empty" },
      },
    });
    await gateway.prepareThreadFromSdkConfig({
      threadId: "thread-empty",
      config: { mcpServers: {}, allowedTools: [] },
      allowedServers: ["eco_demo"],
      runtimeName: "eco_mcp_thread_empty",
    });
    expect(gateway.listThreadCodexServers()).toHaveLength(1);

    const retired = await gateway.prepareThreadFromSdkConfig({
      threadId: "thread-empty",
      config: { mcpServers: {}, allowedTools: [] },
      allowedServers: [],
      runtimeName: "eco_mcp_thread_empty",
    });
    expect(retired).toBeUndefined();
    expect(gateway.listThreadCodexServers()).toHaveLength(0);
  } finally {
    await gateway.close();
  }
});


test("MCP Hub keeps speech generation's timeout on the runtime-visible wrapper", async () => {
  const gateway = new McpHubGateway();
  try {
    const prepared = await gateway.prepareThread({ threadId: "tts-timeout-thread", allowedServers: ["eco_tts"], runtimeName: "eco_mcp_tts_timeout" });
    expect(prepared.sdkEntry).toMatchObject({ timeout: 600_000, requestTimeoutMs: 600_000 });
    expect(prepared.codexServer.toolTimeoutSec).toBe(600);
  } finally { await gateway.close(); }
});
