import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { ResolvedModelRoute } from "../../model-router/src";
import { CodexAppServerClient } from "../src/codex-app-server-client";
import {
  buildCodexTurnInput,
  CodexAppServerDriver,
  isCodexThreadConfigApplied,
  toCodexTurnReasoningEffort,
} from "../src/codex-app-server-driver";
import { buildCodexGatewayModelAlias } from "../src/codex-config-sync";
import { CodexEventAdapter } from "../src/codex-event-adapter";
import { CODEX_TURN_INTERRUPT_METHOD, CodexTurnInterruptFailed } from "../src/codex-turn-interrupt";
import { CodexTurnRouteRegistry } from "../src/codex-turn-route-registry";
import { readRpcMessages } from "./codex-mock-transport";

const ECO_DEVELOPER_INSTRUCTIONS = "You coordinate Eco orchestration.";

test("a failed native recovery never submits the pending business input", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const methods: string[] = [];
  const registry = new CodexTurnRouteRegistry();
  stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      const message = JSON.parse(line);
      if (!message.id) continue;
      methods.push(message.method);
      if (message.method === "initialize") writeResponse(stdout, { id: message.id, result: {} });
      else if (message.method === "thread/resume")
        writeResponse(stdout, {
          id: message.id,
          result: {
            thread: {
              id: "native",
              turns: [{ status: "failed", error: { codexErrorInfo: "contextWindowExceeded" } }],
            },
          },
        });
      else if (message.method === "thread/compact/start") {
        writeResponse(stdout, { id: message.id, result: {} });
        writeResponse(stdout, {
          method: "turn/started",
          params: { threadId: "native", turn: { id: "compact", status: "inProgress" } },
        });
        writeResponse(stdout, {
          method: "turn/completed",
          params: {
            threadId: "native",
            turn: { id: "compact", status: "failed", error: { message: "Summary provider rejected" } },
          },
        });
      }
    }
  });
  await client.initialize();
  const driver = new CodexAppServerDriver({
    client,
    existingCodexThreadId: "native",
    turnRouteRegistry: registry,
  });
  try {
    await expect(
      (async () => {
        for await (const _event of driver.run({
          threadId: "eco",
          prompt: "Pending business input",
          workspacePath: "/repo",
          worktreePath: "/repo",
          routes: [plannerRoute()],
          signal: new AbortController().signal,
        })) {
          /* Drain until recovery fails. */
        }
      })(),
    ).rejects.toThrow("原生上下文压缩失败，未提交新输入：Summary provider rejected");
    expect(methods).toEqual(["initialize", "thread/resume", "thread/compact/start"]);
    expect(registry.size).toBe(0);
  } finally {
    driver.dispose();
    client.close();
  }
});

function writeResponse(stdout: PassThrough, message: unknown): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function plannerRoute(
  overrides: {
    providerId?: string;
    upstreamModelId?: string;
    primaryModelId?: string;
    thinkingEffort?: ResolvedModelRoute["thinkingEffort"];
    apiCompat?: ResolvedModelRoute["apiCompat"];
  } = {},
): ResolvedModelRoute {
  return {
    role: "main",
    providerId: overrides.providerId ?? "anthropic-main",
    upstreamModelId: overrides.upstreamModelId ?? "claude-sonnet-4",
    ...(overrides.thinkingEffort ? { thinkingEffort: overrides.thinkingEffort } : {}),
    ...(overrides.apiCompat ? { apiCompat: overrides.apiCompat } : {}),
    primary: {
      id: "sonnet",
      provider: "custom",
      displayName: "Sonnet",
      baseUrl: "https://example.com",
      modelId: overrides.primaryModelId ?? "eco-planner-alias",
      capabilities: ["messages_api"],
      enabled: true,
    },
    fallbacks: [],
  };
}

test("toCodexTurnReasoningEffort preserves explicit effort and maps off to none", () => {
  expect(toCodexTurnReasoningEffort(undefined)).toBeUndefined();
  expect(toCodexTurnReasoningEffort("off")).toBe("none");
  expect(toCodexTurnReasoningEffort("high")).toBe("high");
  expect(toCodexTurnReasoningEffort("max")).toBe("max");
  expect(toCodexTurnReasoningEffort("ultra")).toBe("ultra");
  expect(toCodexTurnReasoningEffort(" focused ")).toBe("focused");
  expect(() => toCodexTurnReasoningEffort("   ")).toThrow("must be a non-empty string");
});

test("buildCodexTurnInput validates and deduplicates structured skills by exact path", () => {
  expect(
    buildCodexTurnInput("Use $demo", [
      { type: "skill", name: "demo", path: "/repo/.agents/skills/demo/SKILL.md" },
      { type: "skill", name: "demo-copy", path: "/repo/.agents/skills/demo/SKILL.md" },
    ]),
  ).toEqual([
    { type: "text", text: "Use $demo" },
    { type: "skill", name: "demo", path: "/repo/.agents/skills/demo/SKILL.md" },
  ]);
  expect(() => buildCodexTurnInput("bad", [{ type: "skill", name: "", path: "/x" }])).toThrow(
    "must contain type=skill, name, and path",
  );
});

test("buildCodexTurnInput sends no items for a continuation without a new prompt", () => {
  expect(buildCodexTurnInput("", undefined)).toEqual([]);
});

test("buildCodexTurnInput includes deduplicated local image paths", () => {
  expect(buildCodexTurnInput("inspect", undefined, ["/tmp/a.png", "/tmp/a.png", "/tmp/b.jpg"])).toEqual([
    { type: "text", text: "inspect" },
    { type: "localImage", path: "/tmp/a.png" },
    { type: "localImage", path: "/tmp/b.jpg" },
  ]);
});

test("buildCodexTurnInput rejects relative local image paths", () => {
  expect(() => buildCodexTurnInput("inspect", undefined, ["images/example.png"])).toThrow(
    "must be an absolute path",
  );
});

test("CodexAppServerDriver runs thread/start then turn/start and observes item notifications", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const itemNotifications: string[] = [];
  const client = new CodexAppServerClient(stdin, stdout);

  const driver = new CodexAppServerDriver({
    client,
    developerInstructions: ` ${ECO_DEVELOPER_INSTRUCTIONS} `,
    threadConfig: {
      mcp_servers: {
        browser: { enabled: false },
      },
    },
    onItemNotification: (method) => {
      itemNotifications.push(method);
    },
  });

  const controller = new AbortController();
  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    const events = [];
    for await (const event of driver.run({
      threadId: "thr_eco_1",
      prompt: "Read README and summarize",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute({ thinkingEffort: "high" })],
      signal: controller.signal,
      codexSession: {
        skillInputs: [
          {
            type: "skill",
            name: "repo-docs",
            path: "/repo/.agents/skills/repo-docs/SKILL.md",
          },
        ],
      },
    })) {
      events.push(event);
    }
    return events;
  })();

  await Bun.sleep(0);

  writeResponse(stdout, {
    id: 2,
    result: { thread: { id: "thr_codex_1" } },
  });
  await Bun.sleep(0);

  stdout.write(
    `${JSON.stringify({
      method: "item/started",
      params: { item: { id: "item_1", type: "agentMessage" } },
    })}\n`,
  );
  await Bun.sleep(0);

  writeResponse(stdout, {
    id: 3,
    result: { turn: { id: "turn_1", items: [], status: "inProgress" } },
  });
  await Bun.sleep(0);

  stdout.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thr_codex_1",
        turn: { id: "turn_1", items: [], status: "completed" },
      },
    })}\n`,
  );

  const events = await runPromise;
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events[0]?.type).toBe("agent.started");
  expect(events.at(-1)?.type).toBe("agent.completed");
  expect(itemNotifications).toContain("item/started");

  const messages = readRpcMessages(stdin);
  const threadStart = messages.find((message) => message.method === "thread/start");
  const turnStart = messages.find((message) => message.method === "turn/start");
  expect(threadStart?.params?.modelProvider).toBe("eco_anthropic-main");
  expect(threadStart?.params?.model).toBe("eco_anthropic-main__claude-sonnet-4");
  expect(threadStart?.params?.developerInstructions).toBe(ECO_DEVELOPER_INSTRUCTIONS);
  expect(threadStart?.params?.config).toEqual({
    mcp_servers: {
      browser: { enabled: false },
    },
  });
  expect(turnStart?.params?.model).toBe("eco_anthropic-main__claude-sonnet-4");
  expect(turnStart?.params?.modelProvider).toBeUndefined();
  expect(turnStart?.params?.developerInstructions).toBeUndefined();
  expect(turnStart?.params?.developer_instructions).toBeUndefined();
  expect(turnStart?.params?.effort).toBe("high");
  expect(turnStart?.params?.input).toEqual([
    { type: "text", text: "Read README and summarize" },
    {
      type: "skill",
      name: "repo-docs",
      path: "/repo/.agents/skills/repo-docs/SKILL.md",
    },
  ]);
  expect((turnStart?.params?.collaborationMode as { settings?: { model?: string } })?.settings?.model).toBe(
    "eco_anthropic-main__claude-sonnet-4",
  );
  expect(
    (turnStart?.params?.collaborationMode as { settings?: { reasoning_effort?: string } })?.settings
      ?.reasoning_effort,
  ).toBe("high");
  expect(
    (turnStart?.params?.collaborationMode as { settings?: { developer_instructions?: unknown } })?.settings
      ?.developer_instructions,
  ).toBeNull();
  // Must use provider-scoped gateway alias, not the eco SDK alias on primary.modelId.
  expect(turnStart?.params?.model).not.toBe("eco-planner-alias");

  driver.dispose();
});

test("CodexAppServerDriver pins the built-in OpenAI subscription route to Codex's own provider", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const registry = new CodexTurnRouteRegistry();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({ client, turnRouteRegistry: registry });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    const events = [];
    for await (const event of driver.run({
      threadId: "thr_eco_openai",
      prompt: "reply with pong",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute({ providerId: "openai", upstreamModelId: "gpt-5.6-luna" })],
      signal: controller.signal,
    })) {
      events.push(event);
    }
    return events;
  })();

  await Bun.sleep(0);
  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_openai" } } });
  await Bun.sleep(0);
  writeResponse(stdout, { id: 3, result: { turn: { id: "turn_openai", items: [], status: "inProgress" } } });
  await Bun.sleep(0);

  // Read the bound route before the turn terminal clears it.
  const boundRoute = registry.peek("thr_codex_openai", "turn_openai");

  stdout.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thr_codex_openai",
        turn: { id: "turn_openai", items: [], status: "completed" },
      },
    })}\n`,
  );
  await runPromise;

  const messages = readRpcMessages(stdin);
  const threadStart = messages.find((message) => message.method === "thread/start");
  const turnStart = messages.find((message) => message.method === "turn/start");
  // Must be explicit: config.toml sets a global `model_provider = "eco_*"` default, so an
  // omitted value silently routes the official-subscription model into eco-gateway, whose
  // provider table has no "openai" entry (route miss → 404).
  expect(threadStart?.params?.modelProvider).toBe("openai");
  // Built-in OpenAI keeps the bare upstream model id — never the eco_ gateway alias.
  expect(threadStart?.params?.model).toBe("gpt-5.6-luna");
  expect(turnStart?.params?.model).toBe("gpt-5.6-luna");
  // The bridge resolves the gateway provider id from this registry record.
  expect(boundRoute?.providerId).toBe("openai");
  expect(boundRoute?.upstreamModelId).toBe("gpt-5.6-luna");

  driver.dispose();
});

test("CodexAppServerDriver serializes new thread creation on a shared app-server client", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const mapped: Array<{ ecoThreadId: string; codexThreadId: string }> = [];
  const driverA = new CodexAppServerDriver({
    client,
    onThreadMapped: (ecoThreadId, codexThreadId) => mapped.push({ ecoThreadId, codexThreadId }),
  });
  const driverB = new CodexAppServerDriver({
    client,
    onThreadMapped: (ecoThreadId, codexThreadId) => mapped.push({ ecoThreadId, codexThreadId }),
  });

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const input = (threadId: string) => ({
    threadId,
    prompt: "start",
    workspacePath: "/repo",
    worktreePath: "/repo",
    routes: [plannerRoute()],
    signal: new AbortController().signal,
  });
  const runs = [driverA.run(input("thr_eco_a")), driverB.run(input("thr_eco_b"))];
  const firstEvents = runs.map((run) => run.next());

  await Bun.sleep(0);
  const firstRequests = readRpcMessages(stdin);
  expect(firstRequests.filter((request) => request.method === "thread/start")).toHaveLength(1);

  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_a" } } });
  await expect(firstEvents[0]).resolves.toMatchObject({ value: { type: "agent.started" } });

  await Bun.sleep(0);
  const secondRequests = readRpcMessages(stdin);
  expect(secondRequests.filter((request) => request.method === "thread/start")).toHaveLength(1);

  writeResponse(stdout, { id: 3, result: { thread: { id: "thr_codex_b" } } });
  await expect(firstEvents[1]).resolves.toMatchObject({ value: { type: "agent.started" } });
  expect(mapped).toEqual([
    { ecoThreadId: "thr_eco_a", codexThreadId: "thr_codex_a" },
    { ecoThreadId: "thr_eco_b", codexThreadId: "thr_codex_b" },
  ]);

  await Promise.all(runs.map((run) => run.return?.()));
  driverA.dispose();
  driverB.dispose();
});

test("CodexAppServerDriver handles turn response, usage, and completion in one stdout chunk", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const registry = new CodexTurnRouteRegistry();
  const projectedEvents: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
  let contextModelId: string | undefined;
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: () => "thr_eco_same_chunk",
    recordThreadRunEvent: (event) => projectedEvents.push(event),
    turnRouteRegistry: registry,
    onTokenUsageUpdated: (resolution) => {
      contextModelId = resolution.context.modelId;
    },
  });
  const client = new CodexAppServerClient(stdin, stdout, {
    onNotification: (method, params) => adapter.dispatch(method, params),
  });
  const driver = new CodexAppServerDriver({ client, turnRouteRegistry: registry });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    const events = [];
    for await (const event of driver.run({
      threadId: "thr_eco_same_chunk",
      prompt: "fast",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute({ apiCompat: "openai_chat_completions" })],
      signal: controller.signal,
    })) {
      events.push(event);
    }
    return events;
  })();

  await Bun.sleep(0);
  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_same_chunk" } } });
  await Bun.sleep(0);

  stdout.write(
    [
      {
        id: 3,
        result: {
          turn: { id: "turn_same_chunk", items: [], status: "inProgress" },
        },
      },
      {
        method: "turn/started",
        params: {
          threadId: "thr_codex_same_chunk",
          turn: { id: "turn_same_chunk", items: [], status: "inProgress" },
        },
      },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thr_codex_same_chunk",
          turnId: "turn_same_chunk",
          tokenUsage: {
            last: {
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 10,
              reasoningOutputTokens: 0,
              totalTokens: 110,
            },
            total: {
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 10,
              reasoningOutputTokens: 0,
              totalTokens: 110,
            },
            modelContextWindow: 200_000,
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thr_codex_same_chunk",
          turn: { id: "turn_same_chunk", items: [], status: "completed" },
        },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n") + "\n",
  );

  const events = await runPromise;
  expect(events.at(-1)?.type).toBe("agent.completed");
  expect(contextModelId).toBe("claude-sonnet-4");
  expect(
    projectedEvents.find((event) => event.eventType === "run.attempt.completed")?.metadata
      ?.appServerTokenUsage,
  ).toEqual({
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    totalTokens: 110,
  });
  expect(registry.size).toBe(0);
  driver.dispose();
});

test("same-chunk completion cannot hide a Gateway-first route conflict", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const registry = new CodexTurnRouteRegistry();
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: () => "thr_eco_same_chunk_conflict",
    recordThreadRunEvent: () => {},
    turnRouteRegistry: registry,
  });
  const client = new CodexAppServerClient(stdin, stdout, {
    onNotification: (method, params) => adapter.dispatch(method, params),
  });
  const driver = new CodexAppServerDriver({ client, turnRouteRegistry: registry });

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_same_chunk_conflict",
      prompt: "fast conflict",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: new AbortController().signal,
    })) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: { thread: { id: "thr_codex_same_chunk_conflict" } },
  });
  await Bun.sleep(0);
  registry.register("thr_codex_same_chunk_conflict", "turn_same_chunk_conflict", {
    aliasModelId: "eco_gateway__different-model",
    providerId: "gateway",
    upstreamModelId: "different-model",
  });
  expect(registry.size).toBe(2);

  stdout.write(
    `${[
      {
        id: 3,
        result: {
          turn: { id: "turn_same_chunk_conflict", items: [], status: "inProgress" },
        },
      },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thr_codex_same_chunk_conflict",
          turnId: "turn_same_chunk_conflict",
          tokenUsage: {
            last: {
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              totalTokens: 15,
            },
            total: {
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              totalTokens: 15,
            },
            modelContextWindow: 200_000,
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thr_codex_same_chunk_conflict",
          turn: { id: "turn_same_chunk_conflict", items: [], status: "completed" },
        },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n")}\n`,
  );

  await expect(runPromise).rejects.toThrow("Codex turn route registration conflict");
  expect(registry.size).toBe(0);
  driver.dispose();
});

test("a turn/start route conflict preserves the Gateway exact until terminal cleanup", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const registry = new CodexTurnRouteRegistry();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({ client, turnRouteRegistry: registry });

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_response_conflict",
      prompt: "conflict",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: new AbortController().signal,
    })) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: { thread: { id: "thr_codex_response_conflict" } },
  });
  await Bun.sleep(0);
  registry.register("thr_codex_response_conflict", "turn_response_conflict", {
    aliasModelId: "eco_gateway__different-model",
    providerId: "gateway",
    upstreamModelId: "different-model",
  });

  writeResponse(stdout, {
    id: 3,
    result: {
      turn: { id: "turn_response_conflict", items: [], status: "inProgress" },
    },
  });

  await expect(runPromise).rejects.toThrow("Codex turn route registration conflict");
  expect(registry.size).toBe(1);
  expect(registry.peek("thr_codex_response_conflict", "turn_response_conflict")).toMatchObject({
    providerId: "gateway",
    upstreamModelId: "different-model",
  });
  driver.dispose();
  expect(registry.peek("thr_codex_response_conflict", "turn_response_conflict")).toBeDefined();
  expect(registry.clearThread("thr_codex_response_conflict")).toBe(1);
});

test("CodexAppServerDriver rejects top-level turn/completed compatibility fields", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({ client });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_invalid_completion",
      prompt: "fast",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: controller.signal,
    })) {
      // Drain the driver stream so terminal protocol errors reject this promise.
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: { thread: { id: "thr_codex_invalid_completion" } },
  });
  await Bun.sleep(0);
  stdout.write(
    [
      {
        id: 3,
        result: {
          turn: {
            id: "turn_invalid_completion",
            items: [],
            status: "inProgress",
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thr_codex_invalid_completion",
          turnId: "turn_invalid_completion",
          status: "completed",
        },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n") + "\n",
  );

  await expect(runPromise).rejects.toThrow(
    "Invalid turn/completed params for thread thr_codex_invalid_completion",
  );
  driver.dispose();
});

test("CodexAppServerDriver ignores child subagent turn/completed while waiting for parent turn", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({ client });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    const events = [];
    for await (const event of driver.run({
      threadId: "thr_eco_parent",
      prompt: "Spawn explore to check timezone",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: controller.signal,
    })) {
      events.push(event);
    }
    return events;
  })();

  await Bun.sleep(0);
  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_parent" } } });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 3,
    result: { turn: { id: "turn_parent", items: [], status: "inProgress" } },
  });
  await Bun.sleep(0);

  stdout.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thr_codex_child",
        turn: { id: "turn_child", items: [], status: "completed" },
      },
    })}\n`,
  );
  await Bun.sleep(0);

  stdout.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thr_codex_parent",
        turn: { id: "turn_parent", items: [], status: "completed" },
      },
    })}\n`,
  );

  const events = await runPromise;
  expect(events.at(-1)?.type).toBe("agent.completed");
  driver.dispose();
});

test("CodexAppServerDriver maps route apiCompat into a V1 gateway alias", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({ client });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_custom",
      prompt: "ping",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [
        plannerRoute({
          providerId: "custom",
          upstreamModelId: "gpt-test",
          primaryModelId: "eco-custom-alias",
          apiCompat: "openai_chat_completions",
        }),
      ],
      signal: controller.signal,
    })) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_custom" } } });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 3,
    result: { turn: { id: "turn_custom", items: [], status: "inProgress" } },
  });
  await Bun.sleep(0);
  stdout.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thr_codex_custom",
        turn: { id: "turn_custom", items: [], status: "completed" },
      },
    })}\n`,
  );
  await runPromise;

  const messages = readRpcMessages(stdin);
  const threadStart = messages.find((message) => message.method === "thread/start");
  const turnStart = messages.find((message) => message.method === "turn/start");
  const expectedAlias = buildCodexGatewayModelAlias("custom", "gpt-test", "openai_chat_completions");
  expect(threadStart?.params?.modelProvider).toBe("eco_custom");
  expect(threadStart?.params?.model).toBe(expectedAlias);
  expect(turnStart?.params?.modelProvider).toBeUndefined();
  expect(turnStart?.params?.model).toBe(expectedAlias);
  expect((turnStart?.params?.collaborationMode as { settings?: { model?: string } })?.settings?.model).toBe(
    expectedAlias,
  );
  driver.dispose();
});

test("CodexAppServerDriver runAsk / runPlan send turn/start with model", async () => {
  for (const mode of ["ask", "plan"] as const) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new CodexAppServerClient(stdin, stdout);
    const driver = new CodexAppServerDriver({ client, sessionMode: mode === "plan" ? "plan" : "agent" });
    const controller = new AbortController();

    const handshake = client.initialize();
    await Bun.sleep(0);
    writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
    await handshake;

    const run = mode === "ask" ? driver.runAsk!.bind(driver) : driver.runPlan!.bind(driver);
    const runPromise = (async () => {
      for await (const _event of run({
        threadId: `thr_eco_${mode}`,
        prompt: "ping",
        workspacePath: "/repo",
        worktreePath: "/repo",
        routes: [plannerRoute({ upstreamModelId: `model-for-${mode}` })],
        signal: controller.signal,
      })) {
        // drain
      }
    })();

    await Bun.sleep(0);
    writeResponse(stdout, { id: 2, result: { thread: { id: `thr_codex_${mode}` } } });
    await Bun.sleep(0);
    writeResponse(stdout, {
      id: 3,
      result: { turn: { id: `turn_${mode}`, items: [], status: "inProgress" } },
    });
    await Bun.sleep(0);
    stdout.write(
      `${JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: `thr_codex_${mode}`,
          turn: { id: `turn_${mode}`, items: [], status: "completed" },
        },
      })}\n`,
    );
    await runPromise;

    const turnStart = readRpcMessages(stdin).find((message) => message.method === "turn/start");
    expect(turnStart?.params?.model).toBe(`eco_anthropic-main__model-for-${mode}`);
    expect((turnStart?.params?.collaborationMode as { settings?: { model?: string } })?.settings?.model).toBe(
      `eco_anthropic-main__model-for-${mode}`,
    );
    expect((turnStart?.params?.collaborationMode as { mode?: string })?.mode).toBe(
      mode === "plan" ? "plan" : "default",
    );
    if (mode === "plan") {
      expect(turnStart?.params?.sandboxPolicy).toEqual({ type: "readOnly" });
    }
    driver.dispose();
  }
});

test("approved plan reuses the mapped thread and switches to the built-in Default mode", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({
    client,
    existingCodexThreadId: "thr_codex_plan",
    developerInstructions: ECO_DEVELOPER_INSTRUCTIONS,
  });

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.runContinuation!(
      {
        threadId: "thr_eco_plan",
        prompt: "original prompt",
        workspacePath: "/repo",
        worktreePath: "/repo",
        routes: [plannerRoute()],
        signal: new AbortController().signal,
      },
      "execution",
      {
        plan: "# Plan\n- implement it",
        handoffChoice: "same_thread",
      },
    )) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: { thread: { id: "thr_codex_plan", status: { type: "idle" } } },
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 3,
    result: { turn: { id: "turn_implement", items: [], status: "inProgress" } },
  });
  await Bun.sleep(0);
  stdout.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thr_codex_plan",
        turn: { id: "turn_implement", items: [], status: "completed" },
      },
    })}\n`,
  );
  await runPromise;

  const messages = readRpcMessages(stdin);
  expect(messages.some((message) => message.method === "thread/start")).toBe(false);
  expect(messages.find((message) => message.method === "thread/resume")?.params).toMatchObject({
    threadId: "thr_codex_plan",
    developerInstructions: ECO_DEVELOPER_INSTRUCTIONS,
  });
  const turnStart = messages.find((message) => message.method === "turn/start");
  expect(turnStart?.params?.threadId).toBe("thr_codex_plan");
  expect(turnStart?.params?.input).toEqual([{ type: "text", text: "Implement the plan." }]);
  expect(turnStart?.params?.sandboxPolicy).toMatchObject({ type: "workspaceWrite" });
  expect(turnStart?.params?.collaborationMode).toMatchObject({
    mode: "default",
    settings: {
      developer_instructions: null,
    },
  });
  driver.dispose();
});

test("CodexAppServerDriver rejects routes that omit providerId", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({ client });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: {} });
  await handshake;

  await expect(
    driver
      .run({
        threadId: "thr_missing_provider",
        prompt: "ping",
        workspacePath: "/repo",
        worktreePath: "/repo",
        routes: [
          {
            role: "main",
            upstreamModelId: "claude-sonnet-4",
            primary: {
              id: "sonnet",
              provider: "custom",
              displayName: "Sonnet",
              baseUrl: "https://example.com",
              modelId: "eco-planner-alias",
              capabilities: ["messages_api"],
              enabled: true,
            },
            fallbacks: [],
          },
        ],
        signal: controller.signal,
      })
      .next(),
  ).rejects.toThrow(/providerId is required/);
  driver.dispose();
});

test("CodexAppServerDriver rejects routes that omit upstreamModelId", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({ client });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: {} });
  await handshake;

  await expect(
    driver
      .run({
        threadId: "thr_missing_model",
        prompt: "ping",
        workspacePath: "/repo",
        worktreePath: "/repo",
        routes: [
          {
            role: "main",
            providerId: "anthropic-main",
            primary: {
              id: "sonnet",
              provider: "custom",
              displayName: "Sonnet",
              baseUrl: "https://example.com",
              modelId: "eco-planner-alias",
              capabilities: ["messages_api"],
              enabled: true,
            },
            fallbacks: [],
          },
        ],
        signal: controller.signal,
      })
      .next(),
  ).rejects.toThrow(/upstreamModelId is required/);
  driver.dispose();
});

test("CodexAppServerDriver fails the run when turn/completed status is failed", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const registry = new CodexTurnRouteRegistry();
  const driver = new CodexAppServerDriver({ client, turnRouteRegistry: registry });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_fail",
      prompt: "ping",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: controller.signal,
    })) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_fail" } } });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 3,
    result: { turn: { id: "turn_fail", items: [], status: "inProgress" } },
  });
  await Bun.sleep(0);
  stdout.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thr_codex_fail",
        turn: {
          id: "turn_fail",
          items: [],
          status: "failed",
          error: { message: "Model provider eco_custom not found" },
        },
      },
    })}\n`,
  );

  await expect(runPromise).rejects.toThrow(/Model provider eco_custom not found/);
  expect(registry.size).toBe(0);
  driver.dispose();
});

test("CodexAppServerDriver clears a pending route when turn/start fails", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const registry = new CodexTurnRouteRegistry();
  const driver = new CodexAppServerDriver({ client, turnRouteRegistry: registry });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: {} });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_start_failure",
      prompt: "ping",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: controller.signal,
    })) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_start_failure" } } });
  await Bun.sleep(0);
  expect(registry.size).toBe(1);
  writeResponse(stdout, { id: 3, error: { code: -32602, message: "invalid model" } });

  await expect(runPromise).rejects.toThrow("turn/start failed: invalid model");
  expect(registry.size).toBe(0);
  driver.dispose();
});

test("an old driver cleanup cannot clear a newer pending route owner", async () => {
  const registry = new CodexTurnRouteRegistry();
  const stdinA = new PassThrough();
  const stdoutA = new PassThrough();
  const clientA = new CodexAppServerClient(stdinA, stdoutA);
  const driverA = new CodexAppServerDriver({
    client: clientA,
    existingCodexThreadId: "thr_codex_shared_owner",
    turnRouteRegistry: registry,
  });
  const stdinB = new PassThrough();
  const stdoutB = new PassThrough();
  const clientB = new CodexAppServerClient(stdinB, stdoutB);
  const driverB = new CodexAppServerDriver({
    client: clientB,
    existingCodexThreadId: "thr_codex_shared_owner",
    turnRouteRegistry: registry,
  });

  for (const [client, stdout] of [
    [clientA, stdoutA],
    [clientB, stdoutB],
  ] as const) {
    const handshake = client.initialize();
    await Bun.sleep(0);
    writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
    await handshake;
  }

  const runA = (async () => {
    for await (const _event of driverA.run({
      threadId: "thr_eco_owner_a",
      prompt: "first",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: new AbortController().signal,
    })) {
      // drain
    }
  })();
  await Bun.sleep(0);
  writeResponse(stdoutA, {
    id: 2,
    result: { thread: { id: "thr_codex_shared_owner" } },
  });
  await Bun.sleep(0);
  writeResponse(stdoutA, {
    id: 3,
    result: { turn: { id: "turn_owner_a", items: [], status: "inProgress" } },
  });
  await Bun.sleep(0);
  expect(registry.peek("thr_codex_shared_owner", "turn_owner_a")).toBeDefined();

  const runB = (async () => {
    for await (const _event of driverB.run({
      threadId: "thr_eco_owner_b",
      prompt: "second",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: new AbortController().signal,
    })) {
      // drain
    }
  })();
  await Bun.sleep(0);
  writeResponse(stdoutB, {
    id: 2,
    result: { thread: { id: "thr_codex_shared_owner" } },
  });
  await Bun.sleep(0);
  expect(registry.size).toBe(2);

  stdoutA.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thr_codex_shared_owner",
        turn: { id: "turn_owner_a", items: [], status: "completed" },
      },
    })}\n`,
  );
  await runA;

  // A clears only its exact route and stale owner; B's pending generation survives.
  expect(registry.size).toBe(1);
  writeResponse(stdoutB, { id: 3, error: { code: -32602, message: "stop second" } });
  await expect(runB).rejects.toThrow("turn/start failed: stop second");
  expect(registry.size).toBe(0);
  driverA.dispose();
  driverB.dispose();
});

test("CodexAppServerDriver rejects a non-schema turn/start result", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const registry = new CodexTurnRouteRegistry();
  const driver = new CodexAppServerDriver({ client, turnRouteRegistry: registry });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: {} });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_invalid_start_result",
      prompt: "ping",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: controller.signal,
    })) {
      // Drain the stream so protocol validation rejects this promise.
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: { thread: { id: "thr_codex_invalid_start_result" } },
  });
  await Bun.sleep(0);
  expect(registry.size).toBe(1);
  writeResponse(stdout, {
    id: 3,
    result: { turn: { id: "turn_invalid_start_result", status: "running" } },
  });

  await expect(runPromise).rejects.toThrow("Invalid turn/start response: turn.items must be an array");
  expect(registry.size).toBe(0);
  driver.dispose();
});

test("CodexAppServerDriver dispose clears an active route", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const registry = new CodexTurnRouteRegistry();
  const driver = new CodexAppServerDriver({ client, turnRouteRegistry: registry });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: {} });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_dispose",
      prompt: "ping",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: controller.signal,
    })) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_dispose" } } });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 3,
    result: { turn: { id: "turn_dispose", items: [], status: "inProgress" } },
  });
  await Bun.sleep(0);
  expect(registry.size).toBe(1);
  driver.dispose();
  expect(registry.size).toBe(0);

  stdout.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thr_codex_dispose",
        turn: { id: "turn_dispose", items: [], status: "completed" },
      },
    })}\n`,
  );
  await runPromise;
  expect(registry.size).toBe(0);
});

test("CodexAppServerDriver rejects empty routes", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({ client });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: {} });
  await handshake;

  await expect(
    driver
      .run({
        threadId: "thr_eco_2",
        prompt: "ping",
        workspacePath: "/repo",
        worktreePath: "/repo",
        routes: [],
        signal: controller.signal,
      })
      .next(),
  ).rejects.toThrow(/ResolvedModelRoute is required/);
  driver.dispose();
});

test("CodexAppServerDriver resumes existing map and starts an empty-input continuation", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({
    client,
    existingCodexThreadId: "thr_codex_existing",
    developerInstructions: ECO_DEVELOPER_INSTRUCTIONS,
    threadConfig: { mcp_servers: { browser: { enabled: false } } },
  });
  const controller = new AbortController();
  expect(
    isCodexThreadConfigApplied(client, "thr_codex_existing", {
      mcp_servers: { browser: { enabled: false } },
    }),
  ).toBe(false);

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.runContinuation(
      {
        threadId: "thr_eco_resume",
        prompt: "",
        workspacePath: "/repo",
        worktreePath: "/repo",
        routes: [plannerRoute()],
        signal: controller.signal,
      },
      "execution",
    )) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: { thread: { id: "thr_codex_existing", status: { type: "notLoaded" } } },
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 3,
    result: { thread: { id: "thr_codex_existing", status: { type: "idle" } } },
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 4,
    result: { turn: { id: "turn_resume", items: [], status: "inProgress" } },
  });
  await Bun.sleep(0);
  stdout.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thr_codex_existing",
        turn: { id: "turn_resume", items: [], status: "completed" },
      },
    })}\n`,
  );
  await runPromise;

  const messages = readRpcMessages(stdin);
  expect(messages.some((message) => message.method === "thread/start")).toBe(false);
  expect(messages.find((message) => message.method === "thread/read")?.params).toEqual({
    threadId: "thr_codex_existing",
    includeTurns: false,
  });
  expect(messages.some((message) => message.method === "thread/unsubscribe")).toBe(false);
  const threadResume = messages.find((message) => message.method === "thread/resume");
  const turnStart = messages.find((message) => message.method === "turn/start");
  expect(threadResume?.params?.threadId).toBe("thr_codex_existing");
  expect(threadResume?.params?.modelProvider).toBe("eco_anthropic-main");
  expect(threadResume?.params?.model).toBe("eco_anthropic-main__claude-sonnet-4");
  expect(threadResume?.params?.developerInstructions).toBe(ECO_DEVELOPER_INSTRUCTIONS);
  expect(threadResume?.params?.config).toEqual({
    mcp_servers: { browser: { enabled: false } },
  });
  expect(turnStart?.params?.threadId).toBe("thr_codex_existing");
  expect(turnStart?.params?.input).toEqual([]);
  expect(
    isCodexThreadConfigApplied(client, "thr_codex_existing", {
      mcp_servers: { browser: { enabled: false } },
    }),
  ).toBe(true);
  driver.dispose();
});

test("resume history usage cannot claim the pending route before turn/start responds", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const registry = new CodexTurnRouteRegistry();
  const projectedEvents: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
  const contextModelIds: Array<string | undefined> = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: () => "thr_eco_resume_split",
    recordThreadRunEvent: (event) => projectedEvents.push(event),
    turnRouteRegistry: registry,
    onTokenUsageUpdated: (resolution) => {
      contextModelIds.push(resolution.context.modelId);
    },
  });
  const client = new CodexAppServerClient(stdin, stdout, {
    onNotification: (method, params) => adapter.dispatch(method, params),
  });
  const driver = new CodexAppServerDriver({
    client,
    existingCodexThreadId: "thr_codex_resume_split",
    turnRouteRegistry: registry,
  });

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    const events = [];
    for await (const event of driver.run({
      threadId: "thr_eco_resume_split",
      prompt: "continue after replay",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute({ apiCompat: "openai_chat_completions" })],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    return events;
  })();

  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: { thread: { id: "thr_codex_resume_split", status: { type: "idle" } } },
  });
  await Bun.sleep(0);
  expect(registry.size).toBe(1);

  writeResponse(stdout, {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr_codex_resume_split",
      turnId: "turn_historical",
      tokenUsage: {
        last: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 10,
          reasoningOutputTokens: 0,
          totalTokens: 110,
        },
        total: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 10,
          reasoningOutputTokens: 0,
          totalTokens: 110,
        },
        modelContextWindow: 200_000,
      },
    },
  });
  await Bun.sleep(0);
  expect(registry.peek("thr_codex_resume_split", "turn_historical")).toBeUndefined();
  expect(registry.size).toBe(1);
  expect(contextModelIds).toEqual([undefined]);

  writeResponse(stdout, {
    id: 3,
    result: { turn: { id: "turn_current", items: [], status: "inProgress" } },
  });
  await Bun.sleep(0);
  expect(registry.peek("thr_codex_resume_split", "turn_current")).toMatchObject({
    providerId: "anthropic-main",
    upstreamModelId: "claude-sonnet-4",
    apiCompat: "openai_chat_completions",
  });
  expect(registry.size).toBe(1);

  stdout.write(
    [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thr_codex_resume_split",
          turnId: "turn_current",
          tokenUsage: {
            last: {
              inputTokens: 30,
              cachedInputTokens: 5,
              outputTokens: 10,
              reasoningOutputTokens: 0,
              totalTokens: 40,
            },
            total: {
              inputTokens: 130,
              cachedInputTokens: 25,
              outputTokens: 20,
              reasoningOutputTokens: 0,
              totalTokens: 150,
            },
            modelContextWindow: 200_000,
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thr_codex_resume_split",
          turn: { id: "turn_current", items: [], status: "completed" },
        },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n") + "\n",
  );

  const events = await runPromise;
  expect(events.at(-1)?.type).toBe("agent.completed");
  expect(contextModelIds).toEqual([undefined, "claude-sonnet-4"]);
  expect(
    projectedEvents.find((event) => event.eventType === "run.attempt.completed")?.metadata
      ?.appServerTokenUsage,
  ).toEqual({
    inputTokens: 30,
    cachedInputTokens: 5,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    totalTokens: 40,
  });
  expect(registry.size).toBe(0);
  driver.dispose();
});

test("CodexAppServerDriver abort with active turn sends turn/interrupt", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const registry = new CodexTurnRouteRegistry();
  const driver = new CodexAppServerDriver({ client, turnRouteRegistry: registry });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_cancel",
      prompt: "long running",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: controller.signal,
    })) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_cancel" } } });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 3,
    result: { turn: { id: "turn_cancel", items: [], status: "inProgress" } },
  });
  await Bun.sleep(0);

  controller.abort("cancelled by user");
  await Bun.sleep(0);

  // Respond to turn/interrupt
  writeResponse(stdout, { id: 4, result: {} });

  await expect(runPromise).rejects.toBe("cancelled by user");
  expect(registry.size).toBe(0);

  const messages = readRpcMessages(stdin);
  const interrupt = messages.find((message) => message.method === CODEX_TURN_INTERRUPT_METHOD);
  expect(interrupt?.params).toEqual({
    threadId: "thr_codex_cancel",
    turnId: "turn_cancel",
  });
  driver.dispose();
});

test("CodexAppServerDriver abort without active turn does not send turn/interrupt", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const driver = new CodexAppServerDriver({ client });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  controller.abort("cancelled by user");

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_no_turn",
      prompt: "never starts",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: controller.signal,
    })) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_no_turn" } } });

  await expect(runPromise).rejects.toBe("cancelled by user");

  const messages = readRpcMessages(stdin);
  expect(messages.some((message) => message.method === CODEX_TURN_INTERRUPT_METHOD)).toBe(false);
  expect(messages.some((message) => message.method === "turn/start")).toBe(false);
  driver.dispose();
});

test("CodexAppServerDriver surfaces turn/interrupt failure and does not pretend cancelled", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const registry = new CodexTurnRouteRegistry();
  const driver = new CodexAppServerDriver({ client, turnRouteRegistry: registry });
  const controller = new AbortController();

  const handshake = client.initialize();
  await Bun.sleep(0);
  writeResponse(stdout, { id: 1, result: { codexHome: "/tmp/codex" } });
  await handshake;

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_eco_interrupt_fail",
      prompt: "long running",
      workspacePath: "/repo",
      worktreePath: "/repo",
      routes: [plannerRoute()],
      signal: controller.signal,
    })) {
      // drain
    }
  })();

  await Bun.sleep(0);
  writeResponse(stdout, { id: 2, result: { thread: { id: "thr_codex_interrupt_fail" } } });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 3,
    result: {
      turn: { id: "turn_interrupt_fail", items: [], status: "inProgress" },
    },
  });
  await Bun.sleep(0);

  controller.abort("cancelled by user");
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 4,
    error: { code: -32600, message: "turn not active" },
  });

  try {
    await runPromise;
    expect.unreachable("expected run to fail on interrupt error");
  } catch (error) {
    expect(error).toBeInstanceOf(CodexTurnInterruptFailed);
    expect(String(error)).toMatch(/turn\/interrupt failed/);
  }
  expect(registry.size).toBe(0);
  driver.dispose();
});
