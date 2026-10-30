import { expect, test } from "bun:test";
import { AcpClient } from "../src/acp-client";
import { AcpJsonRpcPeer, encodeJsonRpcLine } from "../src/acp-jsonrpc";
import { ACP_IDLE_TIMEOUT_MS } from "../src/acp-types";

/** Measured against local `agent acp` (2026.08.11-e8db854). */
const ACP_METHODS = {
  initialize: "initialize",
  initialized: "notifications/initialized",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionDelete: "session/delete",
  sessionPrompt: "session/prompt",
  /** Notification (not request) — request returns -32601 Method not found. */
  sessionCancel: "session/cancel",
  sessionUpdate: "session/update",
} as const;

function createMockIo() {
  let lineHandler: ((line: string) => void) | undefined;
  const writes: string[] = [];
  return {
    writes,
    write: (line: string) => {
      writes.push(line);
    },
    onLine: (cb: (line: string) => void) => {
      lineHandler = cb;
    },
    emit: (line: string) => {
      lineHandler?.(line);
    },
  };
}

function parseWrites(writes: string[]) {
  return writes.map((line) => JSON.parse(line.trim()) as Record<string, unknown>);
}

function createClient(io = createMockIo()) {
  const peer = new AcpJsonRpcPeer(io);
  const client = new AcpClient({
    peer,
    clientInfo: { name: "eco-test", version: "0.0.0" },
  });
  return { io, peer, client };
}

const INIT_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { audio: false, embeddedContext: false, image: true },
    sessionCapabilities: { list: {} },
  },
  authMethods: [
    {
      id: "cursor_login",
      name: "Cursor Login",
      description: "Authenticate using existing Cursor login credentials.",
    },
  ],
};

async function handshake(io: ReturnType<typeof createMockIo>, client: AcpClient) {
  const initPromise = client.initialize();
  const initReq = parseWrites(io.writes).at(-1)!;
  expect(initReq.method).toBe(ACP_METHODS.initialize);
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: initReq.id,
      result: INIT_RESULT,
    }),
  );
  await initPromise;
  client.confInitialized();
}

test("initialize sends protocolVersion 1 with empty clientCapabilities and returns agent result", async () => {
  const { io, peer, client } = createClient();
  const pending = client.initialize();
  const sent = parseWrites(io.writes)[0]!;
  expect(sent).toEqual({
    jsonrpc: "2.0",
    id: sent.id,
    method: ACP_METHODS.initialize,
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "eco-test", version: "0.0.0" },
    },
  });

  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: sent.id,
      result: INIT_RESULT,
    }),
  );

  await expect(pending).resolves.toEqual(INIT_RESULT);
  peer.dispose();
});

test("confInitialized notifies notifications/initialized", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  const last = parseWrites(io.writes).at(-1)!;
  expect(last).toEqual({
    jsonrpc: "2.0",
    method: ACP_METHODS.initialized,
  });
  expect("id" in last).toBe(false);
  peer.dispose();
});

test("newSession returns sessionId from session/new", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  const pending = client.newSession({ cwd: "/tmp/ws" });
  const sent = parseWrites(io.writes).at(-1)!;
  expect(sent.method).toBe(ACP_METHODS.sessionNew);
  expect(sent.params).toEqual({ cwd: "/tmp/ws", mcpServers: [] });

  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: sent.id,
      result: { sessionId: "sess-1" },
    }),
  );

  await expect(pending).resolves.toEqual({ sessionId: "sess-1" });
  peer.dispose();
});

test("newSession forwards ACP mcpServers on session/new", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  const mcpServers = [
    {
      type: "http" as const,
      name: "docs",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer x" }],
    },
  ];
  const pending = client.newSession({ cwd: "/tmp/ws", mcpServers });
  const sent = parseWrites(io.writes).at(-1)!;
  expect(sent.params).toEqual({ cwd: "/tmp/ws", mcpServers });

  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: sent.id,
      result: { sessionId: "sess-mcp" },
    }),
  );
  await expect(pending).resolves.toEqual({ sessionId: "sess-mcp" });
  peer.dispose();
});

test("loadSession calls session/load with mcpServers when capability present", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  const pending = client.loadSession({ sessionId: "sess-1", cwd: "/tmp/ws" });
  const sent = parseWrites(io.writes).at(-1)!;
  expect(sent.method).toBe(ACP_METHODS.sessionLoad);
  // Measured: Cursor requires mcpServers: array on session/load
  expect(sent.params).toEqual({
    sessionId: "sess-1",
    cwd: "/tmp/ws",
    mcpServers: [],
  });

  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: sent.id,
      result: {},
    }),
  );

  await expect(pending).resolves.toEqual({});
  peer.dispose();
});

test("loadSession returns models from session/load result", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  const pending = client.loadSession({ sessionId: "sess-1", cwd: "/tmp/ws" });
  const sent = parseWrites(io.writes).at(-1)!;
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: sent.id,
      result: {
        models: {
          currentModelId: "default[]",
          availableModels: [{ modelId: "default[]", name: "Auto" }],
        },
      },
    }),
  );
  await expect(pending).resolves.toEqual({
    models: {
      currentModelId: "default[]",
      availableModels: [{ modelId: "default[]", name: "Auto" }],
    },
  });
  peer.dispose();
});

test("setModel error includes modelId and RPC method", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  const pending = client.setModel({ sessionId: "sess-1", modelId: "auto" });
  const sent = parseWrites(io.writes).at(-1)!;
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: sent.id,
      error: { code: -32602, message: "Invalid params" },
    }),
  );
  await expect(pending).rejects.toThrow(
    /session\/set_model modelId="auto".*session\/set_model failed \(-32602\): Invalid params/,
  );
  peer.dispose();
});

test("loadSession throws ACP_LOAD_SESSION_UNSUPPORTED when capability false", async () => {
  const { io, peer, client } = createClient();
  const pending = client.initialize();
  const sent = parseWrites(io.writes)[0]!;
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: sent.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      },
    }),
  );
  await pending;
  client.confInitialized();

  await expect(client.loadSession({ sessionId: "x", cwd: "/tmp" })).rejects.toThrow(
    /ACP_LOAD_SESSION_UNSUPPORTED/,
  );
  peer.dispose();
});

test("deleteSession sends session/delete when capability is advertised", async () => {
  const { io, peer, client } = createClient();
  const initPromise = client.initialize();
  const initReq = parseWrites(io.writes).at(-1)!;
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: initReq.id,
      result: {
        ...INIT_RESULT,
        agentCapabilities: {
          ...INIT_RESULT.agentCapabilities,
          sessionCapabilities: { list: {}, delete: {} },
        },
      },
    }),
  );
  await initPromise;
  client.confInitialized();

  const pending = client.deleteSession({ sessionId: "sess-del" });
  const req = parseWrites(io.writes).at(-1)!;
  expect(req.method).toBe(ACP_METHODS.sessionDelete);
  expect(req.params).toEqual({ sessionId: "sess-del" });
  io.emit(encodeJsonRpcLine({ jsonrpc: "2.0", id: req.id, result: {} }));
  await pending;
  peer.dispose();
});

test("deleteSession does not send RPC when delete capability is missing", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  const writesBefore = io.writes.length;
  await expect(client.deleteSession({ sessionId: "sess-del" })).rejects.toThrow(
    /ACP_SESSION_DELETE_UNSUPPORTED/,
  );
  expect(io.writes.length).toBe(writesBefore);
  peer.dispose();
});

test("prompt and cancel use measured method names; cancel is a notification", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);

  const promptPending = client.prompt({
    sessionId: "sess-1",
    prompt: [{ type: "text", text: "hi" }],
  });
  const promptReq = parseWrites(io.writes).at(-1)!;
  expect(promptReq.method).toBe(ACP_METHODS.sessionPrompt);
  expect(promptReq.params).toEqual({
    sessionId: "sess-1",
    prompt: [{ type: "text", text: "hi" }],
  });
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    }),
  );
  await expect(promptPending).resolves.toEqual({ stopReason: "end_turn" });

  const before = io.writes.length;
  await client.cancel({ sessionId: "sess-1" });
  const cancelMsg = parseWrites(io.writes).at(-1)!;
  expect(io.writes.length).toBe(before + 1);
  expect(cancelMsg).toEqual({
    jsonrpc: "2.0",
    method: ACP_METHODS.sessionCancel,
    params: { sessionId: "sess-1" },
  });
  expect("id" in cancelMsg).toBe(false);
  peer.dispose();
});

test("session/request_permission auto-selects allow_once so the prompt turn is not blocked", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);

  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: 42,
      method: "session/request_permission",
      params: {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call_001" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    }),
  );
  for (let i = 0; i < 50; i++) {
    if (parseWrites(io.writes).some((m) => m.id === 42)) break;
    await Promise.resolve();
  }

  const reply = parseWrites(io.writes).find((m) => m.id === 42)!;
  expect(reply).toEqual({
    jsonrpc: "2.0",
    id: 42,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  peer.dispose();
});

test("session/request_permission parks on Eco handler instead of auto-allow", async () => {
  const io = createMockIo();
  const peer = new AcpJsonRpcPeer(io);
  let resolvePermission:
    | ((value: { outcome: { outcome: "selected"; optionId: string } }) => void)
    | undefined;
  const client = new AcpClient({
    peer,
    clientInfo: { name: "eco-test", version: "0.0.0" },
    onRequestPermission: () =>
      new Promise((resolve) => {
        resolvePermission = resolve;
      }),
  });
  await handshake(io, client);

  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: 43,
      method: "session/request_permission",
      params: {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call_sh", kind: "execute", title: "rm -rf /" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    }),
  );
  await Promise.resolve();
  expect(parseWrites(io.writes).some((m) => m.id === 43)).toBe(false);

  resolvePermission?.({ outcome: { outcome: "selected", optionId: "reject-once" } });
  for (let i = 0; i < 50; i++) {
    if (parseWrites(io.writes).some((m) => m.id === 43)) break;
    await Promise.resolve();
  }
  expect(parseWrites(io.writes).find((m) => m.id === 43)).toEqual({
    jsonrpc: "2.0",
    id: 43,
    result: { outcome: { outcome: "selected", optionId: "reject-once" } },
  });
  peer.dispose();
});

test("session/prompt uses idle timeout instead of a hard turn deadline", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  const timeouts: unknown[] = [];
  const original = peer.request.bind(peer);
  peer.request = ((method: string, params?: unknown, timeout?: unknown) => {
    timeouts.push(timeout);
    return original(method, params, timeout as number);
  }) as typeof peer.request;

  const pending = client.prompt({
    sessionId: "sess-1",
    prompt: [{ type: "text", text: "hi" }],
  });
  const promptReq = parseWrites(io.writes).at(-1)!;
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    }),
  );
  await pending;
  expect(timeouts.at(-1)).toEqual({ idleTimeoutMs: ACP_IDLE_TIMEOUT_MS });
  peer.dispose();
});

test("onSessionUpdate subscribes to session/update notifications", () => {
  const { io, peer, client } = createClient();
  const seen: unknown[] = [];
  const unsubscribe = client.onSessionUpdate((params) => {
    seen.push(params);
  });

  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      method: ACP_METHODS.sessionUpdate,
      params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk" } },
    }),
  );
  expect(seen).toEqual([{ sessionId: "s", update: { sessionUpdate: "agent_message_chunk" } }]);

  unsubscribe();
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      method: ACP_METHODS.sessionUpdate,
      params: { sessionId: "s", update: { sessionUpdate: "ignored" } },
    }),
  );
  expect(seen).toHaveLength(1);
  peer.dispose();
});

test("setMode and setModel send measured ACP methods", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);

  const modePending = client.setMode({ sessionId: "sess-1", modeId: "ask" });
  const modeReq = parseWrites(io.writes).at(-1)!;
  expect(modeReq.method).toBe("session/set_mode");
  expect(modeReq.params).toEqual({ sessionId: "sess-1", modeId: "ask" });
  io.emit(encodeJsonRpcLine({ jsonrpc: "2.0", id: modeReq.id, result: {} }));
  await modePending;

  const modelPending = client.setModel({ sessionId: "sess-1", modelId: "default[]" });
  const modelReq = parseWrites(io.writes).at(-1)!;
  expect(modelReq.method).toBe("session/set_model");
  expect(modelReq.params).toEqual({ sessionId: "sess-1", modelId: "default[]" });
  io.emit(encodeJsonRpcLine({ jsonrpc: "2.0", id: modelReq.id, result: {} }));
  await modelPending;
  peer.dispose();
});

test("cursor/create_plan parks on handler and returns accepted outcome", async () => {
  const io = createMockIo();
  const peer = new AcpJsonRpcPeer(io);
  let sawPlan = "";
  let resolveSaw: (() => void) | undefined;
  const saw = new Promise<void>((resolve) => {
    resolveSaw = resolve;
  });
  const client = new AcpClient({
    peer,
    clientInfo: { name: "eco-test", version: "0.0.0" },
    onCreatePlan: async (req) => {
      sawPlan = req.plan;
      resolveSaw?.();
      return { outcome: "accepted" };
    },
  });
  await handshake(io, client);

  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: 77,
      method: "cursor/create_plan",
      params: {
        toolCallId: "call_plan",
        name: "Demo",
        overview: "ov",
        plan: "# Plan\n\nDo it.",
        todos: [],
      },
    }),
  );
  await saw;
  for (let i = 0; i < 50; i++) {
    if (parseWrites(io.writes).some((m) => m.id === 77)) break;
    await Promise.resolve();
  }

  expect(sawPlan).toContain("Do it");
  const reply = parseWrites(io.writes).find((m) => m.id === 77);
  expect(reply).toEqual({
    jsonrpc: "2.0",
    id: 77,
    result: { outcome: { outcome: "accepted" } },
  });
  peer.dispose();
});

test("cursor/create_plan without handler is rejected explicitly", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: 78,
      method: "cursor/create_plan",
      params: { toolCallId: "c1", plan: "x" },
    }),
  );
  for (let i = 0; i < 20; i++) {
    if (parseWrites(io.writes).some((m) => m.id === 78)) break;
    await Promise.resolve();
  }
  const reply = parseWrites(io.writes).find((m) => m.id === 78)!;
  expect(reply).toMatchObject({
    id: 78,
    result: {
      outcome: {
        outcome: "rejected",
        reason: "Mori ACP host has no create_plan handler (plan approval not wired)",
      },
    },
  });
  peer.dispose();
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpFsHandler } from "../src/acp-fs";

function createClientWithFs(io = createMockIo(), fsHandler?: AcpFsHandler) {
  const peer = new AcpJsonRpcPeer(io);
  const client = new AcpClient({
    peer,
    fsHandler,
  });
  return { io, peer, client };
}

function waitForReply(io: ReturnType<typeof createMockIo>, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const check = () => {
      const reply = parseWrites(io.writes).find((m) => m.id === id);
      if (reply) {
        settled = true;
        resolve(reply);
        return true;
      }
      return false;
    };
    if (check()) return;
    const timer = setInterval(() => {
      if (settled) {
        clearInterval(timer);
        return;
      }
      if (check()) {
        clearInterval(timer);
        return;
      }
    }, 1);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        clearInterval(timer);
        reject(new Error(`timed out waiting for reply id=${id}`));
      }
    }, 2000);
  });
}

test("fs/read_text_file is answered by the fs handler (workspace-scoped)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-fs-client-"));
  try {
    await writeFile(path.join(dir, "note.txt"), "hello fs");
    const { io, peer, client } = createClientWithFs(undefined, new AcpFsHandler(dir));
    await handshake(io, client);
    io.emit(
      encodeJsonRpcLine({
        jsonrpc: "2.0",
        id: 90,
        method: "fs/read_text_file",
        params: { path: path.join(dir, "note.txt") },
      }),
    );
    const reply = await waitForReply(io, 90);
    expect(reply).toMatchObject({ id: 90, result: { content: "hello fs" } });
    peer.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs/read_text_file without handler returns a structured error", async () => {
  const { io, peer, client } = createClientWithFs();
  await handshake(io, client);
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: 91,
      method: "fs/read_text_file",
      params: { path: "/tmp/x.txt" },
    }),
  );
  const reply = (await waitForReply(io, 91)) as {
    id: number;
    error: { code: number; message: string };
  };
  expect(reply.id).toBe(91);
  expect(reply.error.code).toBe(-32603);
  expect(reply.error.message).toMatch(/no fs handler/i);
  peer.dispose();
});

test("fs/read_text_file rejects paths that escape the workspace", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-fs-client-"));
  try {
    const { io, peer, client } = createClientWithFs(undefined, new AcpFsHandler(dir));
    await handshake(io, client);
    io.emit(
      encodeJsonRpcLine({
        jsonrpc: "2.0",
        id: 92,
        method: "fs/read_text_file",
        params: { path: "/etc/hosts" },
      }),
    );
    const reply = (await waitForReply(io, 92)) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(reply.id).toBe(92);
    expect(reply.error.code).toBe(-32603);
    expect(reply.error.message).toMatch(/escapes workspace/i);
    peer.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cursor/task is accepted by default (no handler)", async () => {
  const { io, peer, client } = createClientWithFs();
  await handshake(io, client);
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: 93,
      method: "cursor/task",
      params: { toolCallId: "call-1", description: "Sum 1 through 100", prompt: "Calculate the sum" },
    }),
  );
  for (let i = 0; i < 50; i++) {
    if (parseWrites(io.writes).some((m) => m.id === 93)) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const reply = parseWrites(io.writes).find((m) => m.id === 93)!;
  expect(reply).toMatchObject({ id: 93, result: { outcome: { outcome: "completed" } } });
  peer.dispose();
});

test("cursor/update_todos request is accepted with statuses and does not hang", async () => {
  const io = createMockIo();
  const peer = new AcpJsonRpcPeer(io);
  const seen: unknown[] = [];
  const client = new AcpClient({
    peer,
    onUpdateTodos: (request) => {
      seen.push(request);
      return { outcome: "accepted", todos: request.todos };
    },
  });
  await handshake(io, client);
  const todos = [
    { id: "1", content: "Set up project structure", status: "completed" },
    { id: "2", content: "Add authentication", status: "in_progress" },
    { id: "3", content: "Write unit tests", status: "pending" },
  ];
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: 94,
      method: "cursor/update_todos",
      params: { toolCallId: "call_125", todos, merge: true },
    }),
  );
  const reply = await waitForReply(io, 94);
  expect(seen).toEqual([
    {
      toolCallId: "call_125",
      todos: [
        { id: "1", content: "Set up project structure", status: "completed" },
        { id: "2", content: "Add authentication", status: "in_progress" },
        { id: "3", content: "Write unit tests", status: "pending" },
      ],
      merge: true,
    },
  ]);
  expect(reply).toMatchObject({
    id: 94,
    result: {
      outcome: {
        outcome: "accepted",
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "in_progress" },
          { id: "3", content: "Write unit tests", status: "pending" },
        ],
      },
    },
  });
  peer.dispose();
});

test("_cursor/update_todos request alias is accepted", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: 95,
      method: "_cursor/update_todos",
      params: {
        toolCallId: "tool_1",
        todos: [{ id: "1", content: "Fix auth", status: "in_progress" }],
        merge: false,
      },
    }),
  );
  const reply = await waitForReply(io, 95);
  expect(reply).toMatchObject({
    id: 95,
    result: {
      outcome: {
        outcome: "accepted",
        todos: [{ id: "1", content: "Fix auth", status: "in_progress" }],
      },
    },
  });
  peer.dispose();
});

test("cursor/update_todos notification invokes handler without a JSON-RPC reply", async () => {
  const io = createMockIo();
  const peer = new AcpJsonRpcPeer(io);
  let saw: unknown;
  const client = new AcpClient({
    peer,
    onUpdateTodos: (request) => {
      saw = request;
      return { outcome: "accepted", todos: request.todos };
    },
  });
  await handshake(io, client);
  const writesBefore = io.writes.length;
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      method: "cursor/update_todos",
      params: {
        toolCallId: "call_n",
        todos: [{ id: "1", content: "Notify", status: "pending" }],
        merge: false,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(saw).toMatchObject({
    toolCallId: "call_n",
    todos: [{ id: "1", content: "Notify", status: "pending" }],
    merge: false,
  });
  expect(io.writes.length).toBe(writesBefore);
  peer.dispose();
});

test("cursor/generate_image without handler is rejected explicitly", async () => {
  const { io, peer, client } = createClient();
  await handshake(io, client);
  io.emit(
    encodeJsonRpcLine({
      jsonrpc: "2.0",
      id: 96,
      method: "cursor/generate_image",
      params: { toolCallId: "call_img", description: "icon", filePath: "/tmp/icon.png" },
    }),
  );
  const reply = await waitForReply(io, 96);
  expect(reply).toMatchObject({
    id: 96,
    result: {
      outcome: {
        outcome: "rejected",
        reason: "Mori ACP host has no generate_image handler",
      },
    },
  });
  peer.dispose();
});
