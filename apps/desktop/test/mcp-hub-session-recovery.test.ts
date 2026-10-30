import { expect, test } from "bun:test";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpHubGateway } from "../src/main/mcp-hub-gateway";
import { handleMcpStreamableHttpRequest } from "../src/main/mcp-streamable-http";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Request = { id?: number; method: string; params?: { arguments?: Record<string, unknown> } };

async function fixture() {
  const sessions = new Map<string, string>();
  const initializations: string[] = [];
  const calls: string[] = [];
  let listings = 0;
  const controls: {
    onInitialize?: () => Promise<void>;
    onStale?: () => Promise<void>;
    onCall?: () => Promise<void>;
    failure?: number | "rpc" | "disconnect" | "tool";
    initializeFailure?: number;
  } = {};
  const upstream = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message: Request = JSON.parse(Buffer.concat(chunks).toString());
    const auth = String(req.headers.authorization ?? "");
    const respond = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (message.method === "initialize") {
      initializations.push(auth);
      const sid = `fixture-${initializations.length}`;
      await controls.onInitialize?.();
      if (controls.initializeFailure) {
        respond(controls.initializeFailure, { error: "initialize unavailable" });
        return;
      }
      sessions.set(sid, auth);
      res.setHeader("mcp-session-id", sid);
      respond(200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "offline", version: "1" },
        },
      });
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (sessions.get(String(req.headers["mcp-session-id"])) !== auth) {
      await controls.onStale?.();
      respond(404, { error: "MCP session not found" });
      return;
    }
    if (typeof controls.failure === "number") {
      respond(controls.failure, { error: "request rejected" });
      return;
    }
    if (controls.failure === "rpc") {
      respond(200, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "MCP session not found (application error)" },
      });
      return;
    }
    if (message.method === "tools/list") {
      listings++;
      respond(200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      });
      return;
    }
    if (message.method === "tools/call") {
      calls.push(auth);
      await controls.onCall?.();
      if (controls.failure === "disconnect") {
        req.socket.destroy();
        return;
      }
      respond(200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          ...(controls.failure === "tool" ? { isError: true } : {}),
          content: [{ type: "text", text: String(message.params?.arguments?.value ?? "ok") }],
        },
      });
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const gateway = new McpHubGateway();
  const clients: Client[] = [];
  async function attach(threadId = "A", external = false) {
    const entry = {
      type: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { authorization: `Bearer ${threadId}` },
    };
    const serverName = external ? "remote" : "eco_agent_browser";
    if (external) gateway.syncSdkConfig({ mcpServers: { remote: entry }, allowedTools: [] });
    else gateway.registerThreadServerEntry({ name: serverName, threadId, sdkEntry: entry });
    const prepared = await gateway.prepareThread({ threadId, allowedServers: [serverName] });
    const client = new Client({ name: "offline-recovery-test", version: "1" });
    clients.push(client);
    const cancelled = deferred();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(String(prepared.sdkEntry.url)), {
        requestInit: { headers: prepared.sdkEntry.headers as Record<string, string> },
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          if (typeof init?.body === "string" && JSON.parse(init.body).method === "notifications/cancelled")
            cancelled.resolve();
          return response;
        },
      }),
    );
    return {
      cancelled,
      search: (signal?: AbortSignal) =>
        client.callTool(
          { name: "search_tools", arguments: { query: serverName } },
          undefined,
          signal ? { signal } : undefined,
        ),
      call: (value = "ok") =>
        client.callTool({
          name: "call_tool",
          arguments: { name: `${serverName}:echo`, arguments: { value } },
        }),
    };
  }
  return {
    controls,
    gateway,
    attach,
    initializations,
    calls,
    get listings() {
      return listings;
    },
    expire(auth?: string) {
      for (const [sid, owner] of sessions) if (!auth || owner === `Bearer ${auth}`) sessions.delete(sid);
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await gateway.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

for (const external of [false, true]) {
  test(`${external ? "external" : "built-in"} Hub discovery and calls recover expired inner sessions`, async () => {
    const f = await fixture();
    try {
      const h = await f.attach("A", external);
      expect((await h.search()).structuredContent).toMatchObject({ total: 1 });
      f.expire();
      expect((await h.search()).structuredContent).toMatchObject({ total: 1 });
      f.expire();
      expect((await h.call("after expiry")).content).toEqual([{ type: "text", text: "after expiry" }]);
      expect(f.initializations).toEqual(["Bearer A", "Bearer A", "Bearer A"]);
      expect(f.calls).toEqual(["Bearer A"]);
    } finally {
      await f.close();
    }
  });
}

test("concurrent stale requests and a late old-session 404 share the replacement connection", async () => {
  const f = await fixture();
  const bothStale = deferred();
  const late = deferred();
  let stale = 0;
  try {
    const h = await f.attach();
    await h.search();
    f.expire();
    f.controls.onStale = async () => {
      if (++stale === 1) await bothStale.promise;
      else {
        bothStale.resolve();
        await late.promise;
      }
    };
    const first = h.search();
    const second = h.search();
    await Promise.race([first, second]);
    // A third request uses the new session while the second old 404 is held.
    await h.search();
    late.resolve();
    await Promise.all([first, second]);
    expect(stale).toBe(2);
    expect(f.initializations).toHaveLength(2);
    expect(f.listings).toBe(4);
  } finally {
    bothStale.resolve();
    late.resolve();
    await f.close();
  }
});

test("cancelling one caller waiting for shared reinitialization does not cancel or replay another", async () => {
  const f = await fixture();
  const initializing = deferred();
  const release = deferred();
  const bothStale = deferred();
  let stale = 0;
  try {
    const h = await f.attach();
    await h.search();
    f.expire();
    f.controls.onStale = async () => {
      if (++stale === 2) bothStale.resolve();
      await bothStale.promise;
    };
    f.controls.onInitialize = async () => {
      initializing.resolve();
      await release.promise;
    };
    const controller = new AbortController();
    const cancelled = h.search(controller.signal);
    const surviving = h.search();
    await initializing.promise;
    controller.abort(new Error("cancel waiting caller"));
    await expect(cancelled).rejects.toThrow("cancel waiting caller");
    await h.cancelled.promise;
    release.resolve();
    await surviving;
    expect(f.initializations).toHaveLength(2);
    expect(f.listings).toBe(2); // Warm-up and the surviving caller only.
  } finally {
    bothStale.resolve();
    release.resolve();
    await f.close();
  }
});

test("recovery does not close an old client while another tool is still executing", async () => {
  const f = await fixture();
  const executing = deferred();
  const release = deferred();
  try {
    const h = await f.attach();
    await h.search();
    f.controls.onCall = async () => {
      executing.resolve();
      await release.promise;
    };
    const running = h.call("one side effect");
    await executing.promise;
    f.expire();
    await h.search();
    release.resolve();
    expect((await running).content).toEqual([{ type: "text", text: "one side effect" }]);
    expect(f.initializations).toHaveLength(2);
    expect(f.calls).toHaveLength(1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("recovered credentials remain isolated between threads", async () => {
  const f = await fixture();
  try {
    const a = await f.attach("A");
    const b = await f.attach("B");
    await Promise.all([a.search(), b.search()]);
    f.expire("A");
    await Promise.all([a.call(), b.call()]);
    expect(f.initializations.filter((auth) => auth === "Bearer A")).toHaveLength(2);
    expect(f.initializations.filter((auth) => auth === "Bearer B")).toHaveLength(1);
    expect(f.calls.sort()).toEqual(["Bearer A", "Bearer B"]);
  } finally {
    await f.close();
  }
});

for (const failure of [401, 500, "rpc", "disconnect", "tool"] as const) {
  test(`${failure} does not trigger session recovery or repeat a tool`, async () => {
    const f = await fixture();
    try {
      const h = await f.attach();
      await h.search();
      f.controls.failure = failure;
      if (failure === "tool") expect((await h.call()).isError).toBe(true);
      else await expect(h.call()).rejects.toThrow();
      expect(f.initializations).toHaveLength(1);
      expect(f.calls.length).toBe(failure === "disconnect" || failure === "tool" ? 1 : 0);
    } finally {
      await f.close();
    }
  });
}

test("a second session 404 is surfaced after one retry, and a later request can reconnect", async () => {
  const f = await fixture();
  try {
    const h = await f.attach();
    await h.search();
    f.controls.failure = 404;
    await expect(h.call()).rejects.toThrow("request rejected");
    expect(f.initializations).toHaveLength(2);
    expect(f.calls).toHaveLength(0);
    delete f.controls.failure;
    await h.call();
    expect(f.initializations).toHaveLength(3);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("failed reinitialization remains visible and can be retried later", async () => {
  const f = await fixture();
  try {
    const h = await f.attach();
    await h.search();
    f.expire();
    f.controls.initializeFailure = 500;
    await expect(h.call()).rejects.toThrow("initialize unavailable");
    expect(f.initializations).toHaveLength(2);
    expect(f.calls).toHaveLength(0);
    delete f.controls.initializeFailure;
    await h.call();
    expect(f.initializations).toHaveLength(3);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("revoking a thread during recovery cannot reconnect the retired adapter", async () => {
  const f = await fixture();
  const initializing = deferred();
  const release = deferred();
  try {
    const h = await f.attach();
    await h.search();
    f.expire();
    f.controls.onInitialize = async () => {
      initializing.resolve();
      await release.promise;
    };
    const pending = h.call();
    await initializing.promise;
    f.gateway.revokeThread("A");
    await expect(pending).rejects.toThrow();
    release.resolve();
    expect(f.initializations).toHaveLength(2);
    expect(f.calls).toHaveLength(0);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("production 30-minute TTL expiry recovers through both real HTTP hops", async () => {
  const traffic: { method: string; status: number }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    res.on("finish", () => {
      try {
        traffic.push({ method: JSON.parse(Buffer.concat(chunks).toString()).method, status: res.statusCode });
      } catch {
        /* GET has no RPC body. */
      }
    });
    await handleMcpStreamableHttpRequest(req, res, {
      serverName: "ttl-recovery-test",
      listTools: async () => ({ tools: [{ name: "read", inputSchema: { type: "object" } }] }),
      callTool: async () => ({ content: [] }),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const gateway = new McpHubGateway();
  const realNow = Date.now;
  try {
    gateway.registerThreadServerEntry({
      name: "eco_agent_browser",
      threadId: "ttl",
      sdkEntry: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { authorization: "Bearer offline-ttl" },
      },
    });
    const { sdkEntry: entry } = await gateway.prepareThread({
      threadId: "ttl",
      allowedServers: ["eco_agent_browser"],
    });
    const rpc = async (method: string, params: unknown, sid?: string) => {
      const response = await fetch(String(entry.url), {
        method: "POST",
        headers: {
          ...(entry.headers as Record<string, string>),
          "content-type": "application/json",
          ...(sid ? { "mcp-session-id": sid } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return {
        sid: response.headers.get("mcp-session-id")!,
        body: (await response.json()) as {
          result?: { structuredContent?: { total: number } };
          error?: unknown;
        },
      };
    };
    const initialize = () =>
      rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "ttl-test", version: "1" },
      });
    const search = (sid: string) => rpc("tools/call", { name: "search_tools", arguments: {} }, sid);
    expect((await search((await initialize()).sid)).body.result?.structuredContent?.total).toBe(1);
    const future = realNow() + 31 * 60_000;
    Date.now = () => future;
    // The outer client is fresh; the Hub still owns the expired inner client.
    const outer = await initialize();
    expect((await search(outer.sid)).body.result?.structuredContent?.total).toBe(1);
    expect((await search(outer.sid)).body.error).toBeUndefined();
    expect(traffic.filter((r) => r.method === "initialize")).toHaveLength(2);
    expect(traffic.filter((r) => r.method === "tools/list" && r.status === 404)).toHaveLength(1);
  } finally {
    Date.now = realNow;
    await gateway.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
