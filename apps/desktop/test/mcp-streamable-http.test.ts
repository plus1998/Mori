import { afterEach, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { handleMcpStreamableHttpRequest, isJsonRpcNotification } from "../src/main/mcp-streamable-http";

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
});

async function listenTestServer(
  handlers: Parameters<typeof handleMcpStreamableHttpRequest>[2],
  secret = "secret-test",
): Promise<{ port: number; secret: string }> {
  const server = http.createServer((req, res) => {
    void handleMcpStreamableHttpRequest(req, res, handlers, {
      controlSecretHeader: "x-eco-test-control-secret",
      controlSecret: secret,
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return { port: (server.address() as AddressInfo).port, secret };
}

test("isJsonRpcNotification detects Codex notifications/initialized", () => {
  expect(
    isJsonRpcNotification({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  ).toBe(true);
  expect(
    isJsonRpcNotification({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    }),
  ).toBe(false);
});

test("MCP streamable HTTP initialize tools/list tools/call round-trip", async () => {
  const { port, secret } = await listenTestServer({
    serverName: "eco_test",
    instructions: "test",
    listTools: async () => ({
      tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }],
    }),
    callTool: async ({ name, authToken }) => ({
      content: [{ type: "text", text: `${name}:${authToken ?? ""}` }],
    }),
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = {
    "content-type": "application/json",
    "x-eco-test-control-secret": secret,
    authorization: "Bearer thr-token",
  };

  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
  expect(initBody.result.serverInfo.name).toBe("eco_test");

  const list = await fetch(url, {
    method: "POST",
    headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } };
  expect(listBody.result.tools[0]?.name).toBe("ping");

  const call = await fetch(url, {
    method: "POST",
    headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    }),
  });
  const callBody = (await call.json()) as { result: { content: Array<{ text: string }> } };
  expect(callBody.result.content[0]?.text).toBe("ping:thr-token");
});

test("Codex handshake: notifications/initialized returns 202 empty; GET is 405", async () => {
  const { port, secret } = await listenTestServer({
    serverName: "eco_agent_browser",
    listTools: async () => ({
      tools: [
        {
          name: "agent_browser_open",
          description: "open",
          inputSchema: { type: "object", properties: { url: { type: "string" } } },
        },
      ],
    }),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  // Codex Accept prefers event-stream first; we still answer with application/json.
  const headers = {
    accept: "text/event-stream, application/json",
    "content-type": "application/json",
    "x-eco-test-control-secret": secret,
  };

  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "codex_test", version: "0.153.4" },
      },
    }),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  const initBody = (await init.json()) as { result: { protocolVersion: string } };
  expect(initBody.result.protocolVersion).toBe("2025-03-26");

  const notified = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  expect(notified.status).toBe(202);
  expect(await notified.text()).toBe("");

  const list = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(list.status).toBe(200);
  const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } };
  expect(listBody.result.tools.map((t) => t.name)).toEqual(["agent_browser_open"]);

  const get = await fetch(url, { method: "GET", headers });
  expect(get.status).toBe(405);
  expect(await get.text()).toBe("");
});

test("probeCodexStyleHttpMcpHandshake accepts Codex Accept header + 202 notification", async () => {
  const { probeCodexStyleHttpMcpHandshake } = await import("../src/main/mcp-streamable-http");
  const { port, secret } = await listenTestServer({
    serverName: "eco_probe",
    listTools: async () => ({
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" } }],
    }),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  const result = await probeCodexStyleHttpMcpHandshake({
    name: "eco_probe",
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { "x-eco-test-control-secret": secret },
  });
  expect(result.toolCount).toBe(1);
});

test("MCP client disconnect does not implicitly cancel an in-flight tools/call", async () => {
  let startedResolve!: () => void;
  let finishResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishResolve = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  const { port, secret } = await listenTestServer({
    serverName: "eco_abort",
    listTools: async () => ({ tools: [{ name: "slow", inputSchema: { type: "object" } }] }),
    callTool: async ({ signal }) => {
      observedSignal = signal;
      startedResolve();
      await finish;
      return { content: [{ type: "text", text: "finished" }] };
    },
  });

  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = {
    "content-type": "application/json",
    "x-eco-test-control-secret": secret,
  };
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "disconnect", version: "0" },
      },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  const request = http.request(url, {
    method: "POST",
    headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
  });
  request.on("error", () => undefined);
  request.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slow", arguments: {} },
    }),
  );
  request.end();
  await started;
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(observedSignal?.aborted).toBe(false);
  finishResolve();
});

test("MCP notifications/cancelled aborts only the matching authenticated session request", async () => {
  let startedResolve!: () => void;
  let observedSignal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const { port, secret } = await listenTestServer({
    serverName: "eco_cancel",
    listTools: async () => ({ tools: [] }),
    callTool: async ({ signal }) => {
      observedSignal = signal;
      startedResolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    },
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = {
    "content-type": "application/json",
    "x-eco-test-control-secret": secret,
  };
  const initialize = async () => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "cancel", version: "0" },
        },
      }),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("missing MCP session id");
    return sessionId;
  };
  const sessionA = await initialize();
  const sessionB = await initialize();
  const call = http.request(url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionA },
  });
  call.on("error", () => undefined);
  call.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "slow", arguments: {} },
    }),
  );
  call.end();
  await started;

  const wrongSession = await fetch(url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionB },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 42, reason: "wrong session" },
    }),
  });
  expect(wrongSession.status).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(observedSignal?.aborted).toBe(false);

  const cancelled = await fetch(url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionA },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 42, reason: "same session" },
    }),
  });
  expect(cancelled.status).toBe(202);
  await Promise.race([
    new Promise<void>((resolve) => {
      const signal = observedSignal;
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("cancellation was not propagated")), 2_000),
    ),
  ]);
  expect(observedSignal?.aborted).toBe(true);
});

test("unknown session id answers 404 so the client re-initializes (local control-secret gateway)", async () => {
  let calls = 0;
  const { port, secret } = await listenTestServer({
    serverName: "mori_tasks",
    listTools: async () => ({
      tools: [{ name: "mori_list_todos", description: "todos", inputSchema: { type: "object" } }],
    }),
    callTool: async ({ name }) => {
      calls += 1;
      return { content: [{ type: "text", text: name }] };
    },
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  // Local Mori gateways authenticate with the control secret only: Codex does
  // not send an Authorization header for these servers.
  const headers = {
    "content-type": "application/json",
    "x-eco-test-control-secret": secret,
  };

  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  expect(init.status).toBe(200);
  expect(init.headers.get("mcp-session-id")).toBeTruthy();

  // The client still holds a session ID the server no longer knows — e.g.
  // evicted by the idle TTL while the assistant thread sat idle. Codex's pinned
  // rmcp client retries with a fresh initialize handshake on HTTP 404,
  // so a 400 here strands the thread forever.
  const staleSession = "stale-session-from-before-ttl";
  const stale = await fetch(url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": staleSession },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "mori_list_todos" },
    }),
  });
  expect(stale.status).toBe(404);
  expect(await stale.json()).toEqual({ error: "MCP session not found" });
  expect(stale.headers.get("mcp-session-id")).toBeNull();
  expect(calls).toBe(0);

  // Recovery is the client's re-initialize + resend, exercised here directly.
  const reinit = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
  expect(reinit.status).toBe(200);
  const session = reinit.headers.get("mcp-session-id");
  expect(session).toBeTruthy();
  const retried = await fetch(url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": session as string },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "mori_list_todos" },
    }),
  });
  expect(retried.status).toBe(200);
  const body = (await retried.json()) as { result: { content: Array<{ text: string }> } };
  expect(body.result.content[0]?.text).toBe("mori_list_todos");
  expect(calls).toBe(1);
});

test("idle TTL expires an initialized session; auth scope and invalid control secrets never dispatch tools", async () => {
  let calls = 0;
  const { port, secret } = await listenTestServer({
    serverName: "mori_tasks_ttl",
    listTools: async () => ({ tools: [] }),
    callTool: async () => {
      calls++;
      return { content: [] };
    },
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = {
    "content-type": "application/json",
    "x-eco-test-control-secret": secret,
    authorization: "Bearer owner",
  };
  const initialized = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "ttl-test", version: "1" },
      },
    }),
  });
  const session = initialized.headers.get("mcp-session-id");
  expect(session).toBeTruthy();
  const request = (overrides: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": session!, ...overrides },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping" } }),
    });
  expect((await request({ authorization: "Bearer other" })).status).toBe(404);
  expect((await request({ "x-eco-test-control-secret": "wrong-secret" })).status).toBe(401);
  expect(calls).toBe(0);
  expect((await request()).status).toBe(200);
  expect(calls).toBe(1);
  const realNow = Date.now;
  const future = realNow() + 31 * 60 * 1000;
  try {
    Date.now = () => future;
    const expired = await request();
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual({ error: "MCP session not found" });
    expect(calls).toBe(1);
  } finally {
    Date.now = realNow;
  }
});

test("unknown session id answers 404 for bearer-authenticated clients too", async () => {
  const { port, secret } = await listenTestServer({
    serverName: "eco_test",
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [] }),
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  const stale = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-eco-test-control-secret": secret,
      authorization: "Bearer thr-token",
      "mcp-session-id": "stale-session-from-before-ttl",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(stale.status).toBe(404);
  expect(await stale.json()).toEqual({ error: "MCP session not found" });
});

test("request without a session id and without bearer is still rejected with 400", async () => {
  const { port, secret } = await listenTestServer({
    serverName: "eco_test",
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [] }),
  });
  const url = `http://127.0.0.1:${port}/mcp`;

  const anonymous = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-eco-test-control-secret": secret,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(anonymous.status).toBe(400);
  const body = (await anonymous.json()) as { error: string };
  expect(body.error).toBe("missing or invalid MCP session id");
});
