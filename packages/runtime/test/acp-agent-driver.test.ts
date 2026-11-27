import { describe, expect, mock, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { encodeJsonRpcLine } from "../src/acp-jsonrpc.js";

function createFakeAcpChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcess & {
    kill: (signal?: string) => boolean;
    killed: boolean;
  };
  child.stdin = stdin as unknown as ChildProcess["stdin"];
  child.stdout = stdout as unknown as ChildProcess["stdout"];
  child.stderr = stderr as unknown as ChildProcess["stderr"];
  child.killed = false;
  child.kill = (_signal?: string) => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  };

  const written: string[] = [];
  stdin.on("data", (chunk) => {
    written.push(String(chunk));
  });

  return {
    child,
    written,
    emitLine(obj: object) {
      stdout.write(encodeJsonRpcLine(obj));
    },
    parseWritten() {
      return written
        .join("")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

const INIT_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true },
  },
  authMethods: [],
};

/** After session/new (or load), driver always calls session/set_mode before prompt. */
async function answerSetMode(
  fake: ReturnType<typeof createFakeAcpChild>,
  sessionId: string,
  modeId = "agent",
  afterCount = 0,
) {
  await waitFor(
    () => fake.parseWritten().filter((m) => m.method === "session/set_mode").length > afterCount,
  );
  const modeReq = fake.parseWritten().filter((m) => m.method === "session/set_mode").at(-1)!;
  expect(modeReq.params).toEqual({ sessionId, modeId });
  fake.emitLine({ jsonrpc: "2.0", id: modeReq.id, result: {} });
}

describe("AcpAgentDriver", () => {
  test("run: handshake → session/new → prompt; maps updates and stopReason", async () => {
    const fake = createFakeAcpChild();
    const spawnFn = mock(() => fake.child);

    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_1",
        prompt: "hello",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
      })) {
        out.push(event);
      }
      return out;
    })();

    // Wait until initialize request is written
    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "notifications/initialized"));
    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    const newReq = fake.parseWritten().find((m) => m.method === "session/new")!;
    expect(newReq.params).toEqual({ cwd: "/tmp/ws", mcpServers: [] });
    fake.emitLine({ jsonrpc: "2.0", id: newReq.id, result: { sessionId: "sess-1" } });

    await answerSetMode(fake, "sess-1");

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const promptReq = fake.parseWritten().find((m) => m.method === "session/prompt")!;
    expect(promptReq.params).toEqual({
      sessionId: "sess-1",
      prompt: [{ type: "text", text: "hello" }],
    });

    fake.emitLine({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        },
      },
    });
    fake.emitLine({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });

    const events = await eventsPromise;
    expect(events.some((e) => e.type === "agent.started")).toBe(true);
    expect(events.some((e) => e.type === "session.captured")).toBe(true);
    const delta = events.find((e) => e.type === "message.delta");
    expect(delta?.payload).toMatchObject({ type: "eco_stream", text: "hi" });
    const terminal = events.find((e) => e.type === "run.terminal");
    expect(terminal?.payload).toEqual({ status: "completed" });
    expect(spawnFn).toHaveBeenCalled();
  });

  test("Antigravity validates isolated storage before starting a session and cancels unhandled permissions", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });
    const verifyStorage = mock(async () => {});
    const eventsPromise = Array.fromAsync(driver.run({
      threadId: "thr_antigravity",
      prompt: "hello",
      workspacePath: "/tmp/ws",
      acpAgentId: "antigravity",
      prepareAntigravity: async () => ({
        executable: "/tmp/agy",
        args: ["acp", "--sandbox"],
        env: { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1" },
        verifyStorage,
      }),
    }));

    try {
      await waitFor(() => fake.parseWritten().some(m => m.method === "initialize"));
      const init = fake.parseWritten().find(m => m.method === "initialize")!;
      fake.emitLine({ jsonrpc: "2.0", id: init.id, result: INIT_RESULT });
      await waitFor(() => fake.parseWritten().some(m => m.method === "session/new"));
      expect(verifyStorage).toHaveBeenCalledTimes(1);
      const created = fake.parseWritten().find(m => m.method === "session/new")!;
      fake.emitLine({ jsonrpc: "2.0", id: created.id, result: { sessionId: "agy-session" } });
      await waitFor(() => fake.parseWritten().some(m => m.method === "session/prompt"));
      const prompt = fake.parseWritten().find(m => m.method === "session/prompt")!;
      expect(fake.parseWritten().some(m => m.method === "session/set_mode")).toBe(false);
      fake.emitLine({
        jsonrpc: "2.0", id: "permission", method: "session/request_permission",
        params: {
          sessionId: "agy-session",
          toolCall: { toolCallId: "t1", kind: "execute" },
          options: [{ optionId: "allow", kind: "allow_once" }],
        },
      });
      await waitFor(() => fake.parseWritten().some(m => m.id === "permission"));
      expect(fake.parseWritten().find(m => m.id === "permission")?.result).toEqual({
        outcome: { outcome: "cancelled" },
      });
      fake.emitLine({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
      const events = await eventsPromise;
      expect(events.find(event => event.type === "run.terminal")?.payload).toEqual({ status: "completed" });
    } finally {
      driver.dispose("thr_antigravity");
    }
  });

  test("run: session/new forwards Eco MCP servers in ACP wire shape", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });
    const mcpServers = [
      {
        type: "stdio" as const,
        name: "github",
        command: "uvx",
        args: ["mcp-github"],
        env: [{ name: "TOKEN", value: "abc" }],
      },
    ];

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_mcp",
        prompt: "hello",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        mcpServers,
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    const newReq = fake.parseWritten().find((m) => m.method === "session/new")!;
    expect(newReq.params).toEqual({ cwd: "/tmp/ws", mcpServers });
    fake.emitLine({ jsonrpc: "2.0", id: newReq.id, result: { sessionId: "sess-mcp" } });

    await answerSetMode(fake, "sess-mcp");

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const promptReq = fake.parseWritten().find((m) => m.method === "session/prompt")!;
    fake.emitLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });
    await eventsPromise;
  });

  test("run: image attachments become ACP image content blocks", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_img",
        prompt: "look",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        attachments: [{ mediaType: "image/png", data: "abc" }],
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    const newReq = fake.parseWritten().find((m) => m.method === "session/new")!;
    fake.emitLine({ jsonrpc: "2.0", id: newReq.id, result: { sessionId: "sess-img" } });

    await answerSetMode(fake, "sess-img");

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const promptReq = fake.parseWritten().find((m) => m.method === "session/prompt")!;
    expect(promptReq.params).toEqual({
      sessionId: "sess-img",
      prompt: [
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", data: "abc" },
      ],
    });

    fake.emitLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });
    await eventsPromise;
  });

  test("run: attachments fail the turn when initialize does not advertise image", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_noimg",
        prompt: "look",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        attachments: [{ mediaType: "image/png", data: "abc" }],
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({
      jsonrpc: "2.0",
      id: initReq.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
      },
    });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    const newReq = fake.parseWritten().find((m) => m.method === "session/new")!;
    fake.emitLine({ jsonrpc: "2.0", id: newReq.id, result: { sessionId: "sess-noimg" } });

    await answerSetMode(fake, "sess-noimg");

    const events = await eventsPromise;
    expect(fake.parseWritten().some((m) => m.method === "session/prompt")).toBe(false);
    const terminal = events.find((e) => e.type === "run.terminal");
    expect(terminal?.payload).toEqual({
      status: "failed",
      error: "Cursor ACP 未声明图片输入能力，无法发送附件。",
      unstarted: true,
    });
  });

  test("run: session/load replay updates are not yielded into the Eco feed", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_resume",
        prompt: "follow up",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        resumeSessionId: "sess-1",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/load"));
    const loadReq = fake.parseWritten().find((m) => m.method === "session/load")!;
    expect(loadReq.params).toEqual({
      sessionId: "sess-1",
      cwd: "/tmp/ws",
      mcpServers: [],
    });
    fake.emitLine({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "old user question" },
        },
      },
    });
    fake.emitLine({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "old assistant answer" },
        },
      },
    });
    fake.emitLine({ jsonrpc: "2.0", id: loadReq.id, result: null });

    await answerSetMode(fake, "sess-1");

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const promptReq = fake.parseWritten().find((m) => m.method === "session/prompt")!;
    fake.emitLine({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "new follow-up answer" },
        },
      },
    });
    fake.emitLine({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });

    const events = await eventsPromise;
    const deltas = events.filter((e) => e.type === "message.delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.payload).toMatchObject({ text: "new follow-up answer" });
    expect(JSON.stringify(events)).not.toContain("old assistant answer");
    expect(JSON.stringify(events)).not.toContain("old user question");
  });

  test("run: session/load models map CLI auto onto wire id before set_model", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_resume_model",
        prompt: "follow up",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        resumeSessionId: "sess-1",
        model: "auto",
        sessionMode: "plan",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/load"));
    const loadReq = fake.parseWritten().find((m) => m.method === "session/load")!;
    fake.emitLine({
      jsonrpc: "2.0",
      id: loadReq.id,
      result: {
        models: {
          currentModelId: "default[]",
          availableModels: [
            { modelId: "default[]", name: "Auto" },
            { modelId: "composer-2.5[fast=true]", name: "composer-2.5" },
          ],
        },
      },
    });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/set_model"));
    const modelReq = fake.parseWritten().find((m) => m.method === "session/set_model")!;
    expect(modelReq.params).toEqual({ sessionId: "sess-1", modelId: "default[]" });
    fake.emitLine({ jsonrpc: "2.0", id: modelReq.id, result: {} });

    await answerSetMode(fake, "sess-1", "plan");

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const promptReq = fake.parseWritten().find((m) => m.method === "session/prompt")!;
    fake.emitLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });

    const events = await eventsPromise;
    expect(events.some((e) => e.type === "run.terminal")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("Invalid params");
  });

  test("run: resume without availableModels fails clearly for CLI model id", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_resume_no_models",
        prompt: "follow up",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        resumeSessionId: "sess-1",
        model: "auto",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/load"));
    const loadReq = fake.parseWritten().find((m) => m.method === "session/load")!;
    fake.emitLine({ jsonrpc: "2.0", id: loadReq.id, result: null });

    const events = await eventsPromise;
    const terminal = events.find((e) => e.type === "run.terminal");
    expect(terminal?.payload).toMatchObject({ status: "failed" });
    expect(String((terminal?.payload as { error?: string })?.error)).toMatch(/availableModels missing/);
    expect(fake.parseWritten().some((m) => m.method === "session/set_model")).toBe(false);
  });

  test("run: session/load forwards Eco MCP servers in ACP wire shape", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });
    const mcpServers = [
      {
        type: "http" as const,
        name: "docs",
        url: "https://example.com/mcp",
        headers: [],
      },
    ];

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_load_mcp",
        prompt: "follow up",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        resumeSessionId: "sess-1",
        mcpServers,
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/load"));
    const loadReq = fake.parseWritten().find((m) => m.method === "session/load")!;
    expect(loadReq.params).toEqual({
      sessionId: "sess-1",
      cwd: "/tmp/ws",
      mcpServers,
    });
    fake.emitLine({ jsonrpc: "2.0", id: loadReq.id, result: null });

    await answerSetMode(fake, "sess-1");

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const promptReq = fake.parseWritten().find((m) => m.method === "session/prompt")!;
    fake.emitLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });
    await eventsPromise;
  });

  test("cancel soft-cancels without killing; dispose tears down the process", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_cancel",
        prompt: "x",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().length > 0);
    expect(driver.cancel("thr_cancel")).toBe(true);
    expect(fake.child.killed).toBe(false);
    const events = await eventsPromise;
    const terminal = events.find((e) => e.type === "run.terminal");
    expect(terminal?.payload).toEqual({
      status: "cancelled",
      reason: "cancelled by user",
    });
    expect(JSON.stringify(events)).not.toContain("AcpJsonRpcPeer disposed");
    expect(driver.dispose("thr_cancel")).toBe(true);
    expect(fake.child.killed).toBe(true);
  });

  test("AbortSignal abort yields run.terminal cancelled", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });
    const ac = new AbortController();

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_abort",
        prompt: "x",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        signal: ac.signal,
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().length > 0);
    ac.abort();
    const events = await eventsPromise;
    const terminal = events.find((e) => e.type === "run.terminal");
    expect(terminal?.payload).toEqual({
      status: "cancelled",
      reason: "cancelled by user",
    });
  });

  test("model option is recorded on agent.started without modelGap", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_model",
        prompt: "hi",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        model: "gpt-5",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    expect(driver.cancel("thr_model")).toBe(true);
    const events = await eventsPromise;
    const started = events.find((e) => e.type === "agent.started");
    expect(started?.payload).toMatchObject({
      source: "acp",
      acpAgentId: "cursor",
      requestedModel: "gpt-5",
      sessionMode: "agent",
    });
    expect((started?.payload as { modelGap?: string } | undefined)?.modelGap).toBeUndefined();
  });

  test("run: sessionMode plan triggers session/set_mode before prompt", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_plan_mode",
        prompt: "plan it",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        sessionMode: "plan",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    const newReq = fake.parseWritten().find((m) => m.method === "session/new")!;
    fake.emitLine({
      jsonrpc: "2.0",
      id: newReq.id,
      result: {
        sessionId: "sess_plan",
        models: {
          currentModelId: "default[]",
          availableModels: [{ modelId: "default[]", name: "Auto" }],
        },
      },
    });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/set_mode"));
    const modeReq = fake.parseWritten().find((m) => m.method === "session/set_mode")!;
    expect(modeReq.params).toEqual({ sessionId: "sess_plan", modeId: "plan" });
    fake.emitLine({ jsonrpc: "2.0", id: modeReq.id, result: {} });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const promptReq = fake.parseWritten().find((m) => m.method === "session/prompt")!;
    fake.emitLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });

    const events = await eventsPromise;
    expect(events.some((e) => e.type === "run.terminal")).toBe(true);
  });

  test("run: session/new failure includes stage and redacted stderr", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_new_failed",
        prompt: "hi",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });
    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    const newReq = fake.parseWritten().find((m) => m.method === "session/new")!;
    fake.child.stderr?.write("provider api_key=sk-abcdefghijklmnop exhausted");
    fake.emitLine({
      jsonrpc: "2.0",
      id: newReq.id,
      error: { code: -32000, message: "provider unavailable" },
    });

    const events = await eventsPromise;
    const terminal = events.find((event) => event.type === "run.terminal");
    const error = String((terminal?.payload as { error?: string } | undefined)?.error);
    expect(terminal?.payload).toMatchObject({ status: "failed", unstarted: true });
    expect(error).toContain("Cursor ACP session/new failed");
    expect(error).toContain("provider unavailable");
    expect(error).toContain("api_key=[REDACTED]");
    expect(error).not.toContain("sk-abcdefghijklmnop");
    expect(events.some((event) => event.type === "session.captured")).toBe(false);
  });

  test("run: session/load failure identifies continuation stage", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_load_failed",
        prompt: "continue",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        resumeSessionId: "sess-missing",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });
    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/load"));
    const loadReq = fake.parseWritten().find((m) => m.method === "session/load")!;
    fake.emitLine({
      jsonrpc: "2.0",
      id: loadReq.id,
      error: { code: -32001, message: "session does not exist" },
    });

    const events = await eventsPromise;
    const terminal = events.find((event) => event.type === "run.terminal");
    expect(String((terminal?.payload as { error?: string } | undefined)?.error)).toContain(
      "Cursor ACP session/load failed",
    );
    expect(events.some((event) => event.type === "session.captured")).toBe(false);
  });

  test("run: spawn ENOENT (Cursor not installed) yields run.terminal failed, no crash", async () => {
    const fake = createFakeAcpChild();
    const spawnFn = mock(() => {
      // Real child_process delivers ENOENT asynchronously on the `error` event.
      setImmediate(() => {
        fake.child.emit("error", Object.assign(new Error("spawn agent ENOENT"), { code: "ENOENT" }));
      });
      return fake.child;
    });

    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn });

    const events = await (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_enoent",
        prompt: "hi",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
      })) {
        out.push(event);
      }
      return out;
    })();

    const terminal = events.find((e) => e.type === "run.terminal");
    expect(terminal?.payload).toMatchObject({ status: "failed" });
    expect(String((terminal?.payload as { error?: string })?.error)).toContain("ENOENT");
  });

  test("run: per-run env (e.g. CURSOR_API_KEY) is merged into the spawned process env", async () => {
    const fake = createFakeAcpChild();
    let spawnOptions: SpawnOptions | undefined;
    const spawnFn = mock((_cmd: string, _args: readonly string[], opts: SpawnOptions) => {
      spawnOptions = opts;
      setImmediate(() => {
        fake.child.emit("error", Object.assign(new Error("spawn agent ENOENT"), { code: "ENOENT" }));
      });
      return fake.child;
    });

    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn });

    const events = await (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_env",
        prompt: "hi",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        env: { CURSOR_API_KEY: "ck-test-123" },
      })) {
        out.push(event);
      }
      return out;
    })();

    expect(events.some((e) => e.type === "run.terminal")).toBe(true);
    const env = (spawnOptions?.env ?? {}) as Record<string, string | undefined>;
    expect(env.CURSOR_API_KEY).toBe("ck-test-123");
  });

  test("run: create_plan accept → set_mode(agent) → same-session plan continue prompt", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver, ACP_PLAN_CONTINUE_PROMPT } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    let resolveApproval: ((v: { outcome: "accepted" }) => void) | undefined;
    let createPlanParked = false;

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_plan_continue",
        prompt: "plan a tiny change",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        sessionMode: "plan",
        onCreatePlan: () =>
          new Promise((resolve) => {
            createPlanParked = true;
            resolveApproval = resolve;
          }),
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    const newReq = fake.parseWritten().find((m) => m.method === "session/new")!;
    fake.emitLine({
      jsonrpc: "2.0",
      id: newReq.id,
      result: { sessionId: "sess-plan", modes: { currentModeId: "plan", availableModes: [] } },
    });

    await answerSetMode(fake, "sess-plan", "plan");

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const firstPrompt = fake.parseWritten().find((m) => m.method === "session/prompt")!;

    fake.emitLine({
      jsonrpc: "2.0",
      id: 9001,
      method: "cursor/create_plan",
      params: {
        toolCallId: "call_plan_1",
        name: "Tiny",
        plan: "# Plan\n\nDo the thing.",
        todos: [],
      },
    });

    await waitFor(() => createPlanParked && Boolean(resolveApproval));
    resolveApproval!({ outcome: "accepted" });

    // set_mode(agent) runs before the create_plan JSON-RPC reply is written.
    await waitFor(() => fake.parseWritten().filter((m) => m.method === "session/set_mode").length >= 2);
    const afterAcceptMode = fake
      .parseWritten()
      .filter((m) => m.method === "session/set_mode")
      .at(-1)!;
    expect(afterAcceptMode.params).toEqual({ sessionId: "sess-plan", modeId: "agent" });
    fake.emitLine({ jsonrpc: "2.0", id: afterAcceptMode.id, result: {} });

    await waitFor(() =>
      fake.parseWritten().some((m) => m.id === 9001 && JSON.stringify(m).includes('"accepted"')),
    );
    expect(fake.parseWritten().find((m) => m.id === 9001)).toMatchObject({
      id: 9001,
      result: { outcome: { outcome: "accepted" } },
    });

    // Planning turn ends — Eco continues in the same session.
    fake.emitLine({ jsonrpc: "2.0", id: firstPrompt.id, result: { stopReason: "end_turn" } });

    await waitFor(() => fake.parseWritten().filter((m) => m.method === "session/set_mode").length >= 3);
    const beforeContinueMode = fake
      .parseWritten()
      .filter((m) => m.method === "session/set_mode")
      .at(-1)!;
    fake.emitLine({ jsonrpc: "2.0", id: beforeContinueMode.id, result: {} });

    await waitFor(() => fake.parseWritten().filter((m) => m.method === "session/prompt").length >= 2);
    const continueReq = fake
      .parseWritten()
      .filter((m) => m.method === "session/prompt")
      .at(-1)!;
    expect(JSON.stringify(continueReq.params)).toContain("approved the plan");
    fake.emitLine({ jsonrpc: "2.0", id: continueReq.id, result: { stopReason: "end_turn" } });

    const events = await eventsPromise;
    expect(
      events.some(
        (e) =>
          e.type === "terminal.output" &&
          (e.payload as { liveType?: string }).liveType === "acp.plan_continue",
      ),
    ).toBe(true);
    expect(ACP_PLAN_CONTINUE_PROMPT).toContain("approved the plan");
  });

  test("run: cursor/update_todos request emits todo.updated with statuses", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_todos",
        prompt: "track tasks",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    const newReq = fake.parseWritten().find((m) => m.method === "session/new")!;
    fake.emitLine({ jsonrpc: "2.0", id: newReq.id, result: { sessionId: "sess-todos" } });

    await answerSetMode(fake, "sess-todos");

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const promptReq = fake.parseWritten().find((m) => m.method === "session/prompt")!;

    fake.emitLine({
      jsonrpc: "2.0",
      id: 9101,
      method: "cursor/update_todos",
      params: {
        toolCallId: "call_todos",
        todos: [
          { id: "1", content: "Todo #1", status: "completed" },
          { id: "2", content: "Todo #2", status: "in_progress" },
          { id: "3", content: "Todo #3", status: "pending" },
        ],
        merge: false,
      },
    });

    await waitFor(() => fake.parseWritten().some((m) => m.id === 9101));
    expect(fake.parseWritten().find((m) => m.id === 9101)).toMatchObject({
      id: 9101,
      result: {
        outcome: {
          outcome: "accepted",
          todos: [
            { id: "1", content: "Todo #1", status: "completed" },
            { id: "2", content: "Todo #2", status: "in_progress" },
            { id: "3", content: "Todo #3", status: "pending" },
          ],
        },
      },
    });

    fake.emitLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });
    const events = await eventsPromise;
    const todo = events.find((e) => e.type === "todo.updated");
    expect(todo?.payload).toMatchObject({
      liveType: "acp.update_todos",
      merge: false,
      todos: [
        { id: "1", content: "Todo #1", status: "completed" },
        { id: "2", content: "Todo #2", status: "in_progress" },
        { id: "3", content: "Todo #3", status: "pending" },
      ],
    });
  });

  test("run: cursor/task opens subagent Cards via agent.started", async () => {
    const fake = createFakeAcpChild();
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn: () => fake.child });

    const eventsPromise = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_task",
        prompt: "explore auth",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    const newReq = fake.parseWritten().find((m) => m.method === "session/new")!;
    fake.emitLine({ jsonrpc: "2.0", id: newReq.id, result: { sessionId: "sess-task" } });

    await answerSetMode(fake, "sess-task");

    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const promptReq = fake.parseWritten().find((m) => m.method === "session/prompt")!;

    fake.emitLine({
      jsonrpc: "2.0",
      id: 9201,
      method: "cursor/task",
      params: {
        toolCallId: "call_explore",
        description: "Explore codebase",
        prompt: "Find auth handlers",
        subagentType: "explore",
      },
    });

    await waitFor(() => fake.parseWritten().some((m) => m.id === 9201));
    expect(fake.parseWritten().find((m) => m.id === 9201)).toMatchObject({
      id: 9201,
      result: {
        outcome: {
          outcome: "completed",
          agentId: "acp-sub:call_explore",
        },
      },
    });

    fake.emitLine({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });
    const events = await eventsPromise;
    const started = events.find((e) => e.type === "agent.started" && e.agentId === "acp-sub:call_explore");
    expect(started?.payload).toMatchObject({
      liveType: "acp.cursor_task",
      parentToolUseId: "call_explore",
      subagent_type: "explore",
      prompt: "Find auth handlers",
    });
    expect(events.some((e) => e.type === "tool.started")).toBe(true);
  });

  test("reuses the same process across turns without re-initialize or session/new", async () => {
    const fake = createFakeAcpChild();
    const spawnFn = mock(() => fake.child);
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn });

    async function runPrompt(prompt: string, resumeSessionId?: string) {
      const eventsPromise = (async () => {
        const out = [];
        for await (const event of driver.run({
          threadId: "thr_reuse",
          prompt,
          workspacePath: "/tmp/ws",
          acpAgentId: "cursor",
          ...(resumeSessionId ? { resumeSessionId } : {}),
        })) {
          out.push(event);
        }
        return out;
      })();
      return eventsPromise;
    }

    const first = runPrompt("one");
    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    const initReq = fake.parseWritten().find((m) => m.method === "initialize")!;
    fake.emitLine({ jsonrpc: "2.0", id: initReq.id, result: INIT_RESULT });
    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    const newReq = fake.parseWritten().find((m) => m.method === "session/new")!;
    fake.emitLine({ jsonrpc: "2.0", id: newReq.id, result: { sessionId: "sess-reuse" } });
    await answerSetMode(fake, "sess-reuse");
    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    const prompt1 = fake.parseWritten().filter((m) => m.method === "session/prompt").at(-1)!;
    fake.emitLine({ jsonrpc: "2.0", id: prompt1.id, result: { stopReason: "end_turn" } });
    const firstEvents = await first;
    expect(firstEvents.some((e) => e.type === "run.terminal")).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(fake.child.killed).toBe(false);

    const beforeSecond = fake.parseWritten().length;
    const setModeBefore = fake.parseWritten().filter((m) => m.method === "session/set_mode").length;
    const second = runPrompt("two", "sess-reuse");
    await waitFor(() => fake.parseWritten().length > beforeSecond);
    await answerSetMode(fake, "sess-reuse", "agent", setModeBefore);
    await waitFor(
      () => fake.parseWritten().filter((m) => m.method === "session/prompt").length >= 2,
    );
    const prompt2 = fake.parseWritten().filter((m) => m.method === "session/prompt").at(-1)!;
    expect(prompt2.params).toEqual({
      sessionId: "sess-reuse",
      prompt: [{ type: "text", text: "two" }],
    });
    fake.emitLine({ jsonrpc: "2.0", id: prompt2.id, result: { stopReason: "end_turn" } });
    await second;

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(fake.parseWritten().filter((m) => m.method === "initialize")).toHaveLength(1);
    expect(fake.parseWritten().filter((m) => m.method === "session/new")).toHaveLength(1);
    expect(fake.parseWritten().filter((m) => m.method === "session/load")).toHaveLength(0);
    expect(fake.child.killed).toBe(false);
  });

  test("cancel then next run reuses the same child and only sends a new prompt", async () => {
    const fake = createFakeAcpChild();
    const spawnFn = mock(() => fake.child);
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn });

    const first = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_cancel_reuse",
        prompt: "busy",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
      })) {
        out.push(event);
      }
      return out;
    })();

    await waitFor(() => fake.parseWritten().some((m) => m.method === "initialize"));
    fake.emitLine({
      jsonrpc: "2.0",
      id: fake.parseWritten().find((m) => m.method === "initialize")!.id,
      result: INIT_RESULT,
    });
    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/new"));
    fake.emitLine({
      jsonrpc: "2.0",
      id: fake.parseWritten().find((m) => m.method === "session/new")!.id,
      result: { sessionId: "sess-cr" },
    });
    await answerSetMode(fake, "sess-cr");
    await waitFor(() => fake.parseWritten().some((m) => m.method === "session/prompt"));
    expect(driver.cancel("thr_cancel_reuse")).toBe(true);
    expect(fake.child.killed).toBe(false);
    await first;
    expect(spawnFn).toHaveBeenCalledTimes(1);

    const setModeBefore = fake.parseWritten().filter((m) => m.method === "session/set_mode").length;
    const second = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_cancel_reuse",
        prompt: "after-cancel",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        resumeSessionId: "sess-cr",
      })) {
        out.push(event);
      }
      return out;
    })();
    await answerSetMode(fake, "sess-cr", "agent", setModeBefore);
    await waitFor(
      () => fake.parseWritten().filter((m) => m.method === "session/prompt").length >= 2,
    );
    const prompt2 = fake.parseWritten().filter((m) => m.method === "session/prompt").at(-1)!;
    expect(prompt2.params).toMatchObject({
      sessionId: "sess-cr",
      prompt: [{ type: "text", text: "after-cancel" }],
    });
    fake.emitLine({ jsonrpc: "2.0", id: prompt2.id, result: { stopReason: "end_turn" } });
    await second;
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(fake.parseWritten().filter((m) => m.method === "initialize")).toHaveLength(1);
  });

  test("dispose then run respawns a new process", async () => {
    const fake1 = createFakeAcpChild();
    const fake2 = createFakeAcpChild();
    let spawnCount = 0;
    const spawnFn = mock(() => {
      spawnCount += 1;
      return spawnCount === 1 ? fake1.child : fake2.child;
    });
    const { AcpAgentDriver } = await import("../src/acp-agent-driver.js");
    const driver = new AcpAgentDriver({ spawnFn });

    const first = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_dispose",
        prompt: "a",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
      })) {
        out.push(event);
      }
      return out;
    })();
    await waitFor(() => fake1.parseWritten().some((m) => m.method === "initialize"));
    fake1.emitLine({
      jsonrpc: "2.0",
      id: fake1.parseWritten().find((m) => m.method === "initialize")!.id,
      result: INIT_RESULT,
    });
    await waitFor(() => fake1.parseWritten().some((m) => m.method === "session/new"));
    fake1.emitLine({
      jsonrpc: "2.0",
      id: fake1.parseWritten().find((m) => m.method === "session/new")!.id,
      result: { sessionId: "sess-d1" },
    });
    await answerSetMode(fake1, "sess-d1");
    await waitFor(() => fake1.parseWritten().some((m) => m.method === "session/prompt"));
    const p1 = fake1.parseWritten().find((m) => m.method === "session/prompt")!;
    fake1.emitLine({ jsonrpc: "2.0", id: p1.id, result: { stopReason: "end_turn" } });
    await first;

    expect(driver.dispose("thr_dispose")).toBe(true);
    expect(fake1.child.killed).toBe(true);

    const second = (async () => {
      const out = [];
      for await (const event of driver.run({
        threadId: "thr_dispose",
        prompt: "b",
        workspacePath: "/tmp/ws",
        acpAgentId: "cursor",
        resumeSessionId: "sess-d1",
      })) {
        out.push(event);
      }
      return out;
    })();
    await waitFor(() => fake2.parseWritten().some((m) => m.method === "initialize"));
    fake2.emitLine({
      jsonrpc: "2.0",
      id: fake2.parseWritten().find((m) => m.method === "initialize")!.id,
      result: INIT_RESULT,
    });
    await waitFor(() => fake2.parseWritten().some((m) => m.method === "session/load"));
    fake2.emitLine({
      jsonrpc: "2.0",
      id: fake2.parseWritten().find((m) => m.method === "session/load")!.id,
      result: { sessionId: "sess-d1" },
    });
    await answerSetMode(fake2, "sess-d1");
    await waitFor(() => fake2.parseWritten().some((m) => m.method === "session/prompt"));
    const p2 = fake2.parseWritten().find((m) => m.method === "session/prompt")!;
    fake2.emitLine({ jsonrpc: "2.0", id: p2.id, result: { stopReason: "end_turn" } });
    await second;
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
