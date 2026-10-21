import { expect, test } from "bun:test";
import { buildClaudeCodeSystemPrompt } from "../src/agent-orchestration";
import {
  buildSdkTodoUpdatedPayload,
  ClaudeAgentSdkDriver,
  type ClaudeQueryHandle,
  createCanUseTool,
  mapSdkMessageToEvents,
  normalizeClaudeSdkUserMessageUuid,
  readSdkSlashCommands,
} from "../src/claude-agent-sdk";
import { SDK_DELEGATION_SUPPORT_TOOL_NAMES, SDK_TASK_PROGRESS_TOOL_NAMES } from "../src/sdk-tool-names";

test("new SDK status events and result diagnostics survive mapping", () => {
  for (const message of [
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 123 } },
    { type: "system", subtype: "informational", content: "Warning", level: "warning" },
    { type: "system", subtype: "session_state_changed", state: "requires_action" },
    { type: "conversation_reset", new_conversation_id: "new-session", trigger: "clear" },
    { type: "system", subtype: "commands_changed", commands: [{ name: "example" }] },
  ])
    expect(mapSdkMessageToEvents(message, "thr")[0]?.payload).toEqual(message);
  const result = mapSdkMessageToEvents(
    {
      type: "result",
      is_error: true,
      subtype: "error_during_execution",
      startup_failure_reason: "provider_not_allowed",
      result_index: 0,
      resume_reason: "interrupted",
      num_turns: 0,
    },
    "thr",
  );
  expect(result[0]?.payload).toMatchObject({
    startup_failure_reason: "provider_not_allowed",
    result_index: 0,
    resume_reason: "interrupted",
  });
  expect(result.some((event) => event.type === "run.terminal")).toBe(true);
});
test("background-only result does not finish a user turn; local commands do", () => {
  expect(mapSdkMessageToEvents({ type: "result", num_turns: 0 }, "thr").map((event) => event.type)).toEqual([
    "usage.recorded",
  ]);
  expect(
    mapSdkMessageToEvents(
      { type: "result", num_turns: 0, user_message_uuid: "background-notification" },
      "thr",
    ).map((event) => event.type),
  ).toEqual(["usage.recorded"]);
  expect(
    mapSdkMessageToEvents({ type: "result", num_turns: 0, local_command: "clear" }, "thr").some(
      (event) => event.type === "run.terminal",
    ),
  ).toBe(true);
});
test("detached tool remains active and oversized structured output is explicitly identified", () => {
  const message = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "" }] },
    tool_use_result: { detachedToolCall: true },
  };
  expect(mapSdkMessageToEvents(message, "thr")[0]).toMatchObject({
    type: "tool.started",
    payload: { detachedToolCall: true },
  });
  const completed = mapSdkMessageToEvents(
    { ...message, tool_use_result: { structuredContentOmitted: true } },
    "thr",
  )[0];
  expect(completed).toMatchObject({ type: "tool.completed", payload: { structuredContentOmitted: true } });
  expect((completed?.payload as Record<string, unknown>).message).toContain("omitted");
});
test("SDK permissions keep decline, persistent-rule and MCP provenance hints", async () => {
  let captured: unknown;
  const callback = createCanUseTool(async (request) => {
    captured = request;
    return { behavior: "deny", message: "Denied" };
  });
  await callback(
    "Bash",
    { command: "test" },
    {
      toolUseID: "t1",
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
      mcpServer: { name: "remote", source: "plugin" },
    },
  );
  expect(captured).toMatchObject({
    defaultToNo: true,
    suppressAlwaysAllowRule: true,
    mcpServer: { name: "remote", source: "plugin" },
  });
});
test("updated tools, prompt rendering, slash commands and task timeout reason", () => {
  expect(SDK_TASK_PROGRESS_TOOL_NAMES).toContain("TaskGet");
  expect(SDK_TASK_PROGRESS_TOOL_NAMES).toContain("TaskList");
  expect(SDK_DELEGATION_SUPPORT_TOOL_NAMES as readonly string[]).not.toContain("TaskOutput");
  expect(buildClaudeCodeSystemPrompt({ globalUserRules: "current rules" })).toMatchObject({
    snapshot: false,
    append: "current rules",
  });
  expect(
    readSdkSlashCommands({ type: "system", subtype: "commands_changed", commands: [{ name: "example" }] }),
  ).toEqual(["example"]);
  expect(
    buildSdkTodoUpdatedPayload({
      subtype: "task_notification",
      task_id: "bash",
      status: "stopped",
      reason: "timeout",
    }),
  ).toMatchObject({ reason: "timeout" });
});
test("coalesced user UUIDs settle all inputs while an interim background result keeps stdin open", async () => {
  const messages: Array<{ uuid: string }> = [];
  let promptDone = false;
  let handle: ClaudeQueryHandle | undefined;
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test",
    baseUrl: "http://127.0.0.1:1",
    queryLifecycle: {
      onOpen: (value) => {
        handle = value;
      },
    },
    loadSdk: async () => ({
      query: ({ prompt }) => {
        void (async () => {
          for await (const message of prompt as AsyncIterable<{ uuid: string }>) messages.push(message);
          promptDone = true;
        })();
        return {
          close() {},
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "session-1", uuid: "init" };
            yield {
              type: "result",
              num_turns: 0,
              session_id: "session-1",
              uuid: "background",
              user_message_uuids: messages.map((message) => message.uuid),
            };
            await Bun.sleep(100);
            expect(promptDone).toBe(false);
            yield {
              type: "result",
              num_turns: 1,
              session_id: "session-1",
              uuid: "final",
              user_message_uuids: messages.map((message) => message.uuid),
            };
            while (!promptDone) await Bun.sleep(5);
          },
        };
      },
    }),
  });
  const events = [];
  for await (const event of driver.runAsk({
    threadId: "thr",
    prompt: "First",
    workspacePath: "/tmp",
    worktreePath: "/tmp",
    routes: [
      {
        role: "main",
        primary: { provider: "anthropic", modelId: "claude-sonnet-4", contextWindow: 200_000 },
      },
    ],
    signal: new AbortController().signal,
  })) {
    events.push(event);
    if (event.type === "session.captured") {
      if (!handle) throw new Error("SDK query handle was not opened");
      await handle.pushUserMessage("Second");
      await handle.pushUserMessage("Third");
    }
  }
  expect(messages).toHaveLength(3);
  expect(events.filter((event) => event.type === "run.terminal")).toHaveLength(1);
  expect(events.find((event) => event.type === "usage.recorded")?.payload).toMatchObject({
    sdk_session_usage: { sessionId: "session-1", resumed: false },
  });
}, 5000);

test("Eco follow-up identifiers become valid SDK fork UUIDs without changing their identity", () => {
  const uuid = "00000000-0000-4000-8000-000000000289";
  expect(normalizeClaudeSdkUserMessageUuid(`tfu_${uuid}`)).toBe(uuid);
  expect(normalizeClaudeSdkUserMessageUuid(uuid)).toBe(uuid);
  expect(() => normalizeClaudeSdkUserMessageUuid("tfu_invalid")).toThrow("valid UUID");
});

test("a startup failure without init retains its error and cannot advance cumulative session usage", async () => {
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test",
    baseUrl: "http://127.0.0.1:1",
    loadSdk: async () => ({
      query: () => ({
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            session_id: "missing-session",
            errors: ["No conversation found with session ID: missing-session"],
            num_turns: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
            modelUsage: {},
            total_cost_usd: 0,
          };
        },
      }),
    }),
  });
  const events = [];
  for await (const event of driver.runAsk({
    threadId: "thr",
    prompt: "Resume",
    workspacePath: "/tmp",
    worktreePath: "/tmp",
    resume: { resumeSessionId: "missing-session" },
    routes: [
      {
        role: "main",
        primary: { provider: "anthropic", modelId: "claude-sonnet-4", contextWindow: 200_000 },
      },
    ],
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(events.some((event) => event.type === "session.captured")).toBe(false);
  const usage = events.find((event) => event.type === "usage.recorded")?.payload as Record<string, unknown>;
  expect(usage.errors).toEqual(["No conversation found with session ID: missing-session"]);
  expect(usage.sdk_session_usage).toBeUndefined();
  expect(events.find((event) => event.type === "run.terminal")?.payload).toMatchObject({
    status: "failed",
    error: "No conversation found with session ID: missing-session",
  });
});

test("a post-clear API failure resumes its persisted user turn on retry", async () => {
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "test",
    baseUrl: "http://127.0.0.1:1",
    loadSdk: async () => ({
      getSessionMessages: async () => [{ type: "user", uuid: "persisted-user" }],
      query: () => ({
        close() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "reset-id" };
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            session_id: "reset-id",
            errors: ["upstream rejected"],
            num_turns: 1,
            usage: { input_tokens: 0, output_tokens: 0 },
            modelUsage: {},
            total_cost_usd: 0,
          };
        },
      }),
    }),
  });
  const events = [];
  for await (const event of driver.runAsk({
    threadId: "thr",
    prompt: "First post-clear turn",
    workspacePath: "/tmp",
    worktreePath: "/tmp",
    resume: { newSessionId: "reset-id" },
    routes: [
      {
        role: "main",
        primary: { provider: "anthropic", modelId: "claude-sonnet-4", contextWindow: 200_000 },
      },
    ],
    signal: new AbortController().signal,
  }))
    events.push(event);
  const captures = events.filter((event) => event.type === "session.captured");
  expect(captures[0]?.payload).toMatchObject({ sessionId: "reset-id", resetPending: true });
  expect(captures.at(-1)?.payload).toEqual({ sessionId: "reset-id", cwd: "/tmp" });
  expect(events.find((event) => event.type === "run.terminal")?.payload).toMatchObject({
    status: "failed",
    error: "upstream rejected",
  });
});
