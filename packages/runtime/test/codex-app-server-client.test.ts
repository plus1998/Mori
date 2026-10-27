import { afterEach, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import {
  CODEX_JSON_RPC_INVALID_PARAMS,
  CODEX_JSON_RPC_METHOD_NOT_FOUND,
  CodexAppServerClient,
  CodexAppServerRequestError,
} from "../src/codex-app-server-client";
import { drainPassThroughText, parseJsonLines } from "./codex-mock-transport";

function createMockTransport() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return { stdin, stdout };
}

function writeResponse(stdout: PassThrough, message: unknown): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

async function readWrittenMessages(stdin: PassThrough): Promise<unknown[]> {
  await Bun.sleep(0);
  return parseJsonLines(drainPassThroughText(stdin));
}

afterEach(() => {
  // no-op: each test creates its own client/streams
});

test("CodexAppServerClient completes initialize → initialized handshake", async () => {
  const { stdin, stdout } = createMockTransport();
  const client = new CodexAppServerClient(stdin, stdout);

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    result: {
      userAgent: "codex-test",
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "darwin",
    },
  });

  const result = await handshake;
  expect(result.codexHome).toBe("/tmp/codex");
  expect(client.isInitialized).toBe(true);

  const lines = parseJsonLines(drainPassThroughText(stdin));
  expect(lines[0]).toEqual({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "eco_coding",
        title: "Mori",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
      },
    },
  });
  expect(lines[1]).toEqual({ method: "initialized" });
});

test("CodexAppServerClient dispatches notifications and resolves requests", async () => {
  const { stdin, stdout } = createMockTransport();
  const notifications: Array<{ method: string; params: unknown }> = [];
  const client = new CodexAppServerClient(stdin, stdout, {
    onNotification: (method, params) => {
      notifications.push({ method, params });
    },
  });

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    result: { codexHome: "/tmp/codex" },
  });
  await handshake;

  const threadStart = client.request("thread/start", { cwd: "/repo" });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: { thread: { id: "thr_codex_1" } },
  });
  const thread = await threadStart;
  expect(thread).toEqual({ thread: { id: "thr_codex_1" } });

  stdout.write(
    `${JSON.stringify({
      method: "item/started",
      params: { item: { id: "item_1", type: "agentMessage" } },
    })}\n`,
  );
  await Bun.sleep(0);
  expect(notifications.some((entry) => entry.method === "item/started")).toBe(true);

  const turnStart = client.request("turn/start", {
    threadId: "thr_codex_1",
    input: [{ type: "text", text: "hello" }],
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 3,
    result: { turn: { id: "turn_1", items: [], status: "inProgress" } },
  });
  const turn = await turnStart;
  expect(turn).toEqual({ turn: { id: "turn_1", items: [], status: "inProgress" } });
});

test("CodexAppServerClient registers a request before a synchronous transport responds", async () => {
  const stdout = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString()) as { id: number; method: string };
      stdout.write(`${JSON.stringify({ id: request.id, result: { echoedMethod: request.method } })}\n`);
      callback();
    },
  });
  const client = new CodexAppServerClient(stdin, stdout);

  await expect(client.request("thread/start", {})).resolves.toEqual({
    echoedMethod: "thread/start",
  });
});

test("CodexAppServerClient runs onResult before later notifications in the same chunk", async () => {
  const { stdin, stdout } = createMockTransport();
  const order: string[] = [];
  const client = new CodexAppServerClient(stdin, stdout, {
    onNotification: (method) => order.push(method),
  });
  const pending = client.request<{ turn: { id: string } }>(
    "turn/start",
    {},
    {
      onResult: (result) => order.push(`result:${result.turn.id}`),
    },
  );
  await Bun.sleep(0);

  stdout.write(
    `${[
      { id: 1, result: { turn: { id: "turn_same_chunk" } } },
      { method: "turn/started", params: { turn: { id: "turn_same_chunk" } } },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n")}\n`,
  );

  await pending;
  expect(order).toEqual(["result:turn_same_chunk", "turn/started"]);
});

test("CodexAppServerClient rejects JSON-RPC errors", async () => {
  const { stdin, stdout } = createMockTransport();
  const client = new CodexAppServerClient(stdin, stdout);
  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: {} });
  await handshake;

  const pending = client.request("thread/start", {});
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    error: { code: -32600, message: "Not initialized" },
  });

  await expect(pending).rejects.toThrow("thread/start failed: Not initialized");
});

test("CodexAppServerClient preserves upstream error data for quota retry policy", async () => {
  const { stdin, stdout } = createMockTransport();
  const client = new CodexAppServerClient(stdin, stdout);
  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: {} });
  await handshake;
  const pending = client.request("account/rateLimits/read");
  writeResponse(stdout, { id: 2, error: { code: 429, message: "Limited", data: { retryAfter: 600 } } });
  try {
    await pending;
    throw new Error("Expected upstream rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(CodexAppServerRequestError);
    expect((error as CodexAppServerRequestError).code).toBe(429);
    expect((error as CodexAppServerRequestError).data).toEqual({ retryAfter: 600 });
  } finally { client.close(); }
});

test("CodexAppServerClient returns the explicit server-request handler result", async () => {
  const { stdin, stdout } = createMockTransport();
  const received: Array<{ method: string; params: unknown }> = [];
  new CodexAppServerClient(stdin, stdout, {
    onServerRequest: (method, params) => {
      received.push({ method, params });
      return { action: "decline" };
    },
  });

  writeResponse(stdout, {
    id: "server_1",
    method: "mcpServer/elicitation/request",
    params: { mode: "url" },
  });

  expect(await readWrittenMessages(stdin)).toEqual([{ id: "server_1", result: { action: "decline" } }]);
  expect(received).toEqual([{ method: "mcpServer/elicitation/request", params: { mode: "url" } }]);
});

test("CodexAppServerClient fails closed when no server-request handler exists", async () => {
  const { stdin, stdout } = createMockTransport();
  new CodexAppServerClient(stdin, stdout);

  writeResponse(stdout, { id: 41, method: "future/request", params: {} });

  expect(await readWrittenMessages(stdin)).toEqual([
    {
      id: 41,
      error: {
        code: CODEX_JSON_RPC_METHOD_NOT_FOUND,
        message: "Mori does not implement Codex app-server request method future/request.",
      },
    },
  ]);
});

test("CodexAppServerClient treats an undefined handler result as unimplemented", async () => {
  const { stdin, stdout } = createMockTransport();
  new CodexAppServerClient(stdin, stdout, { onServerRequest: () => undefined });

  writeResponse(stdout, { id: 42, method: "future/request", params: {} });

  expect(await readWrittenMessages(stdin)).toEqual([
    {
      id: 42,
      error: {
        code: CODEX_JSON_RPC_METHOD_NOT_FOUND,
        message: "Mori does not implement Codex app-server request method future/request.",
      },
    },
  ]);
});

test("CodexAppServerClient preserves protocol errors from a server-request handler", async () => {
  const { stdin, stdout } = createMockTransport();
  new CodexAppServerClient(stdin, stdout, {
    onServerRequest: () => {
      throw new CodexAppServerRequestError(CODEX_JSON_RPC_INVALID_PARAMS, "Invalid elicitation schema.", {
        field: "requestedSchema",
      });
    },
  });

  writeResponse(stdout, { id: "server_2", method: "mcpServer/elicitation/request", params: [] });

  expect(await readWrittenMessages(stdin)).toEqual([
    {
      id: "server_2",
      error: {
        code: CODEX_JSON_RPC_INVALID_PARAMS,
        message: "Invalid elicitation schema.",
        data: { field: "requestedSchema" },
      },
    },
  ]);
});
