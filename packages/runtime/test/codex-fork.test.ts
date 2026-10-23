import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CodexAppServerClient } from "../src/codex-app-server-client";
import {
  buildCodexThreadForkParams,
  CODEX_FORK_METHOD,
  CodexForkNotAvailable,
  forkCodexThread,
} from "../src/codex-fork";
import { drainPassThroughText, parseJsonLines } from "./codex-mock-transport";

function writeResponse(stdout: PassThrough, message: unknown): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

test("buildCodexThreadForkParams trims and locks request shape", () => {
  expect(buildCodexThreadForkParams(" codex-thread-1 ", " turn-keep ")).toEqual({
    threadId: "codex-thread-1",
    lastTurnId: "turn-keep",
  });
});

test("buildCodexThreadForkParams rejects missing lastTurnId without fallback", () => {
  expect(() => buildCodexThreadForkParams("codex-thread-1", " ")).toThrow(CodexForkNotAvailable);
});

test("fork submits model, provider, policy and instructions instead of taking global defaults", async () => {
  const config = { web_search: "disabled", model_reasoning_effort: "high", mcp_servers: {} };
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "thread/read") {
        return {
          thread: {
            cwd: "/tmp/worktree",
            turns: [
              { id: "keep", items: [{ type: "userMessage", id: "u1" }] },
              { id: "drop", items: [{ type: "userMessage", id: "u2" }] },
            ],
          },
        };
      }
      return { thread: { id: "forked" }, model: "gpt-6-luna", modelProvider: "openai" };
    },
  };
  const result = await forkCodexThread(client as never, {
    threadId: "source",
    itemId: "u2",
    model: "gpt-6-luna",
    modelProvider: "openai",
    config,
    developerInstructions: "Thread-specific rules",
  });
  expect(requests[1]).toEqual({
    method: "thread/fork",
    params: {
      threadId: "source",
      lastTurnId: "keep",
      cwd: "/tmp/worktree",
      model: "gpt-6-luna",
      modelProvider: "openai",
      config,
      developerInstructions: "Thread-specific rules",
    },
  });
  expect(result).toMatchObject({ model: "gpt-6-luna", modelProvider: "openai" });
});

test("forkCodexThread sends thread/fork with lastTurnId of the previous turn", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);

  const forked = forkCodexThread(client, {
    threadId: "codex-thread-1",
    itemId: "item-user-2",
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    result: {
      thread: {
        turns: [
          { id: "turn-1", items: [{ type: "userMessage", id: "item-user-1" }] },
          {
            id: "turn-2",
            items: [{ type: "userMessage", id: "server-item-2", clientId: "item-user-2" }],
          },
          { id: "turn-3", items: [{ type: "userMessage", id: "item-user-3" }] },
        ],
      },
    },
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: {
      thread: { id: "codex-thread-forked", forkedFromId: "codex-thread-1" },
    },
  });

  await expect(forked).resolves.toEqual({
    clearMapping: false,
    sourceThreadId: "codex-thread-1",
    lastTurnId: "turn-1",
    thread: { id: "codex-thread-forked", forkedFromId: "codex-thread-1" },
  });
  const lines = parseJsonLines(drainPassThroughText(stdin));
  expect(lines).toEqual([
    {
      id: 1,
      method: "thread/read",
      params: { threadId: "codex-thread-1", includeTurns: true },
    },
    {
      id: 2,
      method: CODEX_FORK_METHOD,
      params: {
        threadId: "codex-thread-1",
        lastTurnId: "turn-1",
      },
    },
  ]);
});

test("forkCodexThread clears mapping when rewinding the first user turn", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "thread/read") {
        return {
          thread: {
            turns: [
              { id: "turn-1", items: [{ type: "userMessage", id: "item-user-1" }] },
              { id: "turn-2", items: [{ type: "userMessage", id: "item-user-2" }] },
            ],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  const result = await forkCodexThread(client as never, {
    threadId: "codex-thread-1",
    itemId: "item-user-1",
  });
  expect(result).toEqual({
    clearMapping: true,
    sourceThreadId: "codex-thread-1",
  });
  expect(requests).toEqual([
    { method: "thread/read", params: { threadId: "codex-thread-1", includeTurns: true } },
  ]);
});

test("forkCodexThread uses the persisted user-turn ordinal when app-server rebuilds item ids", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "thread/read") {
        return {
          thread: {
            turns: [
              { id: "turn-1", items: [{ type: "userMessage", id: "item-1", clientId: null }] },
              { id: "turn-2", items: [{ type: "userMessage", id: "item-3", clientId: null }] },
              { id: "turn-3", items: [{ type: "userMessage", id: "item-5", clientId: null }] },
            ],
          },
        };
      }
      return { thread: { id: "codex-fork-new", forkedFromId: "codex-thread-1" } };
    },
  };
  const result = await forkCodexThread(client as never, {
    threadId: "codex-thread-1",
    itemId: "eco-uuid-2",
    targetTurnIndex: 1,
  });
  expect(result.thread?.id).toBe("codex-fork-new");
  expect(requests[1]).toEqual({
    method: CODEX_FORK_METHOD,
    params: { threadId: "codex-thread-1", lastTurnId: "turn-1" },
  });
});

test("forkCodexThread clamps an ahead-of-remote Eco ordinal to the last user turn", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "thread/read") {
        return {
          thread: {
            turns: [
              { id: "turn-1", items: [{ type: "userMessage", id: "remote-a" }] },
              { id: "turn-2", items: [{ type: "userMessage", id: "remote-b" }] },
            ],
          },
        };
      }
      return { thread: { id: "codex-fork-clamped", forkedFromId: "codex-thread-1" } };
    },
  };
  const result = await forkCodexThread(client as never, {
    threadId: "codex-thread-1",
    itemId: "eco-missing-id",
    targetTurnIndex: 9,
  });
  expect(result.thread?.id).toBe("codex-fork-clamped");
  expect(requests[1]).toEqual({
    method: CODEX_FORK_METHOD,
    params: { threadId: "codex-thread-1", lastTurnId: "turn-1" },
  });
});

test("forkCodexThread accepts snake_case user_message type", async () => {
  const client = {
    request: async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            turns: [
              { id: "turn-1", items: [{ type: "user_message", id: "item-1" }] },
              { id: "turn-2", items: [{ type: "user_message", id: "item-2" }] },
            ],
          },
        };
      }
      return { thread: { id: "codex-fork-snake", forkedFromId: "codex-thread-1" } };
    },
  };
  const result = await forkCodexThread(client as never, {
    threadId: "codex-thread-1",
    itemId: "item-2",
  });
  expect(result.thread?.id).toBe("codex-fork-snake");
});

test("forkCodexThread fails when kept turn has no id", async () => {
  const client = {
    request: async () => ({
      thread: {
        turns: [
          { items: [{ type: "userMessage", id: "item-1" }] },
          { id: "turn-2", items: [{ type: "userMessage", id: "item-2" }] },
        ],
      },
    }),
  };

  await expect(
    forkCodexThread(client as never, {
      threadId: "codex-thread-1",
      itemId: "item-2",
    }),
  ).rejects.toThrow("has no stable id");
});

test("forkCodexThread reports a bounded diagnostic when the target is absent", async () => {
  const client = {
    request: async () => ({
      thread: {
        turns: [
          { id: "turn-1", items: [{ type: "userMessage", id: "item-1" }] },
          { id: "turn-2", items: [{ type: "agentMessage", id: "item-2" }] },
          { id: "turn-3", items: [{ type: "userMessage", id: "item-3" }] },
        ],
      },
    }),
  };

  await expect(
    forkCodexThread(client as never, {
      threadId: "codex-thread-1",
      itemId: "missing-item",
    }),
  ).rejects.toThrow("not found among 2 persisted user items");
});
