import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { appendLegacyThreadRunEventToConversationV2 } from "../src/main/conversation-v2-legacy-adapter";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import type { ThreadRunEvent } from "../src/shared/thread-run-events";

function createStore(): ConversationV2Store {
  const store = new ConversationV2Store(new DatabaseSync(":memory:"), {
    idFactory: (() => {
      let n = 0;
      return () => `id_${++n}`;
    })(),
    now: () => "2026-09-14T00:00:00.000Z",
  });
  store.initialize();
  return store;
}

function event(input: Partial<ThreadRunEvent>): ThreadRunEvent {
  return {
    id: "legacy_event_1",
    threadId: "thread_legacy",
    sequence: 1,
    eventType: "message.delta",
    scope: "main",
    streamState: "streaming",
    message: "a",
    observedAt: "2026-09-14T00:00:00.000Z",
    role: "assistant",
    runAttemptId: "run_1",
    streamKey: "answer_1",
    ...input,
  };
}

test("mirrors a provider notice as the row the Feed reads, one row per notice", () => {
  const store = createStore();
  // Two failures of the same request (a retry after a 503 fails again) share a request id.
  // Keying the notice by its stream would fold the second onto the first and keep only the
  // newer text — the reason for the first failure would be gone from the record.
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_notice_1",
      sequence: 1,
      eventType: "api.error",
      message: "【连接失败】HTTP 503：Upstream returned HTTP 503",
      role: "main",
      requestId: "req_shared",
      streamKey: undefined,
      streamState: "none",
      metadata: {
        liveType: "thread.api_error",
        apiError: { message: "Upstream returned HTTP 503", statusCode: 503 },
      },
    }),
  );
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_notice_2",
      sequence: 2,
      eventType: "api.error",
      message: "【连接失败】Upstream service temporarily unavailable",
      role: "main",
      requestId: "req_shared",
      streamKey: undefined,
      streamState: "none",
      metadata: {
        liveType: "thread.api_error",
        apiError: { message: "Upstream service temporarily unavailable" },
      },
    }),
  );

  const messages = store.bootstrap("thread_legacy").messages;
  expect(messages.map((message) => message.body)).toEqual([
    "【连接失败】HTTP 503：Upstream returned HTTP 503",
    "【连接失败】Upstream service temporarily unavailable",
  ]);
  // The reader has to know the agent did not say this: the provider did.
  expect(
    messages.map((message) => ({
      channel: message.channel,
      role: message.role,
      providerRole: message.providerRole,
      status: message.status,
    })),
  ).toEqual([
    { channel: "system", role: "system", providerRole: "main", status: "final" },
    { channel: "system", role: "system", providerRole: "main", status: "final" },
  ]);
});

test("SDK and billing notices remain system messages after durable V2 projection", () => {
  const store = createStore();
  for (const [index, liveType] of [
    "sdk.notice",
    "sdk.session_state",
    "sdk.conversation_reset",
    "sdk.commands_changed",
    "request.rate_limit",
    "billing.warning",
  ].entries()) {
    appendLegacyThreadRunEventToConversationV2(
      store,
      event({
        id: `sdk_notice_${index}`,
        eventType: "diagnostic",
        role: "system",
        message: `${liveType} notification`,
        streamState: "none",
        streamKey: undefined,
        metadata: { liveType },
      }),
    );
  }
  const snapshot = store.bootstrap("thread_legacy");
  expect(snapshot.messages).toHaveLength(6);
  expect(
    snapshot.messages.every((message) => message.role === "system" && message.channel === "commentary"),
  ).toBe(true);
  expect(snapshot.agents).toHaveLength(0);
});

test("maps legacy cumulative stream rows to V2 replace/finalize effects", () => {
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(store, event({ sequence: 1, message: "a" }));
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({ sequence: 2, id: "legacy_event_2", message: "answer" }),
  );
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      sequence: 3,
      id: "legacy_event_3",
      eventType: "message.final",
      streamState: "finalized",
      message: "answer",
    }),
  );

  const message = store.bootstrap("thread_legacy").messages[0];
  expect(message).toMatchObject({ body: "answer", contentVersion: 1, status: "final" });
  expect(store.head("thread_legacy").lastSeq).toBe(3);
  expect(store.validateIntegrity("thread_legacy").effectCount).toBe(3);

  // Replaying a persisted legacy row after a checkpoint race is idempotent
  // and must not be counted as a newly emitted V2 event.
  expect(
    appendLegacyThreadRunEventToConversationV2(
      store,
      event({
        sequence: 3,
        id: "legacy_event_3",
        eventType: "message.final",
        streamState: "finalized",
        message: "answer",
      }),
    ),
  ).toBe(0);
  expect(store.head("thread_legacy").lastSeq).toBe(3);
});

test("reuses the accepted V2 user message identity when the legacy prompt arrives", () => {
  const store = createStore();
  const accepted = store.sendMessage({
    principalId: "mobile-user",
    conversationId: "thread_legacy",
    clientCommandId: "command_1",
    text: "continue",
  });

  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_prompt_1",
      sequence: 1,
      eventType: "message.final",
      role: "user",
      message: "continue",
      metadata: { conversationV2MessageId: accepted.messageId },
    }),
  );

  const messages = store.bootstrap("thread_legacy").messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    messageId: accepted.messageId,
    body: "continue",
    status: "final",
  });
});

test("preserves agent-scoped Codex message.user rows as V2 user prompts", () => {
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_agent_prompt_1",
      sequence: 1,
      eventType: "message.final",
      scope: "agent",
      role: "coder",
      agentId: "agent_coder",
      requestId: "request_1",
      streamKey: "message_1",
      streamState: "finalized",
      message: "状态确认：请汇报当前情况。",
      metadata: { liveType: "message.user" },
    }),
  );

  expect(store.bootstrap("thread_legacy").messages).toEqual([
    expect.objectContaining({
      body: "状态确认：请汇报当前情况。",
      role: "user",
      channel: "answer",
      providerRole: "coder",
      agentId: "agent_coder",
      agentInstanceId: "agent_coder",
      status: "final",
    }),
  ]);
});

test("keeps legacy tool rows when structured metadata or run id is missing", () => {
  const store = createStore();
  const emitted = appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_tool_1",
      sequence: 1,
      eventType: "tool.completed",
      streamState: "finalized",
      runAttemptId: undefined,
      message: "Tool: Bash · echo hello",
      metadata: undefined,
    }),
  );

  expect(emitted).toBe(3);
  const bootstrap = store.bootstrap("thread_legacy");
  expect(bootstrap.tools).toHaveLength(1);
  expect(bootstrap.tools[0]).toMatchObject({
    name: "Bash",
    input: { command: "echo hello" },
    status: "completed",
  });
  expect(bootstrap.runs).toHaveLength(1);
  expect(bootstrap.runs[0]?.status).toBe("completed");
});

test("projects approval and clarification live rows into V2 tools and details", () => {
  const store = createStore();
  const clarification = {
    toolUseId: "question_1",
    threadId: "thread_legacy",
    questions: [{ question: "Which file?", options: [{ label: "a" }] }],
  };
  const emitted = appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "clarification_1",
      sequence: 1,
      eventType: "message.final",
      message: "主代理需要你回答几个问题。",
      metadata: {
        liveType: "clarification.requested",
        clarification,
        tool: { name: "AskUserQuestion", toolUseId: "question_1", status: "started" },
      },
    }),
  );

  expect(emitted).toBe(2);
  expect(store.bootstrap("thread_legacy").messages).toHaveLength(0);
  expect(store.bootstrap("thread_legacy").tools[0]).toMatchObject({
    toolCallId: "question_1",
    name: "AskUserQuestion",
    status: "running",
  });
  const details = store.detailsPage("thread_legacy", "run_1", undefined, 10);
  expect(details.items[0]).toMatchObject({
    type: "clarification.requested",
    toolCallId: "question_1",
  });
});

test("keeps denied approvals visibly failed in the V2 tool projection", () => {
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "approval_denied_1",
      sequence: 1,
      eventType: "message.final",
      message: "命令未获批准",
      metadata: {
        liveType: "bash_approval.denied",
        bashApproval: { command: "rm -rf /tmp/example" },
        tool: { name: "Bash", toolUseId: "bash_1", input: { command: "rm -rf /tmp/example" } },
      },
    }),
  );

  expect(store.bootstrap("thread_legacy").tools[0]).toMatchObject({
    toolCallId: "bash_1",
    name: "Bash",
    status: "failed",
  });
});

test("keeps an approved tool running until its provider terminal row", () => {
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "approval_approved_1",
      sequence: 1,
      eventType: "message.final",
      message: "已允许 Grep",
      metadata: {
        liveType: "bash_approval.approved",
        bashApproval: { toolUseId: "grep_1", phase: "approved" },
        tool: { name: "Grep", toolUseId: "grep_1", input: { pattern: "foo" } },
      },
    }),
  );
  expect(store.bootstrap("thread_legacy").tools[0]).toMatchObject({
    toolCallId: "grep_1",
    status: "running",
  });

  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "tool_failed_after_approval",
      sequence: 2,
      eventType: "tool.failed",
      streamState: "finalized",
      message: "Tool failed: Grep",
      metadata: {
        tool: { name: "Grep", toolUseId: "grep_1", output: "path not found" },
      },
    }),
  );
  expect(store.bootstrap("thread_legacy").tools[0]).toMatchObject({
    toolCallId: "grep_1",
    status: "failed",
  });
});

test("keeps the execution owner when an approval row belongs to its planner", () => {
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "tool_started_by_subagent",
      sequence: 1,
      eventType: "tool.started",
      scope: "agent",
      role: "tool",
      agentId: "executor_agent",
      metadata: {
        liveType: "tool.started",
        tool: { name: "Bash", toolUseId: "shared_tool_call", input: { command: "bun test" } },
      },
    }),
  );

  // V1 records the permission decision under the planner, although the call itself
  // belongs to the subagent that later emits tool.started/tool.completed.
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "approval_by_planner",
      sequence: 2,
      eventType: "message.final",
      scope: "agent",
      role: "tool",
      agentId: "planner_for_run",
      metadata: {
        liveType: "bash_approval.approved",
        bashApproval: { toolUseId: "shared_tool_call", phase: "approved" },
        tool: { name: "Bash", toolUseId: "shared_tool_call", input: { command: "bun test" } },
      },
    }),
  );

  expect(store.bootstrap("thread_legacy").tools[0]).toMatchObject({
    toolCallId: "shared_tool_call",
    agentId: "executor_agent",
    status: "running",
  });
});

test("disambiguates a legacy tool ID reused by different runs", () => {
  const store = createStore();
  for (const [sequence, runAttemptId] of [
    [1, "run_1"],
    [2, "run_2"],
  ] as const) {
    appendLegacyThreadRunEventToConversationV2(
      store,
      event({
        id: `approval_${runAttemptId}`,
        sequence,
        runAttemptId,
        eventType: "message.final",
        metadata: {
          liveType: "bash_approval.approved",
          bashApproval: { toolUseId: "web_fetch_0", phase: "approved" },
          tool: { name: "Bash", toolUseId: "web_fetch_0", input: { command: "fetch" } },
        },
      }),
    );
  }

  expect(store.bootstrap("thread_legacy").tools).toHaveLength(2);
  expect(store.bootstrap("thread_legacy").tools.map(({ runId }) => runId)).toEqual(["run_1", "run_2"]);
  expect(new Set(store.bootstrap("thread_legacy").tools.map(({ toolCallId }) => toolCallId)).size).toBe(2);
});

test("carries structured tool presentation metadata into V2 input summaries", () => {
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "tool_rich_1",
      sequence: 1,
      eventType: "tool.completed",
      streamState: "finalized",
      message: "Tool: Edit · src/app.ts",
      metadata: {
        tool: {
          name: "Edit",
          toolUseId: "edit_1",
          detail: "src/app.ts",
          input: { file_path: "src/app.ts", old_string: "old", new_string: "new" },
          fileChange: {
            path: "src/app.ts",
            additions: 1,
            deletions: 1,
            previewLines: [{ kind: "add", text: "new" }],
          },
          readTarget: { path: "src/app.ts" },
          webSearch: { query: "eco coding" },
          imageView: { path: "/tmp/shot.png" },
        },
      },
    }),
  );

  expect(store.bootstrap("thread_legacy").tools[0]?.input).toMatchObject({
    file_path: "src/app.ts",
    fileChange: { path: "src/app.ts", additions: 1 },
    readTarget: { path: "src/app.ts" },
    webSearch: { query: "eco coding" },
    imageView: { path: "/tmp/shot.png" },
  });
});

test("does not close the run that owns a completing tool", () => {
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_run_1",
      sequence: 1,
      eventType: "run.attempt.started",
      runAttemptId: "run_1",
    }),
  );
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_tool_1",
      sequence: 2,
      eventType: "tool.started",
      streamState: "streaming",
      metadata: {
        tool: { name: "Bash", toolUseId: "bash_1", input: { command: "ls" } },
      },
    }),
  );
  const emitted = appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_tool_2",
      sequence: 3,
      eventType: "tool.completed",
      streamState: "finalized",
      metadata: {
        tool: {
          name: "Bash",
          toolUseId: "bash_1",
          input: { command: "ls" },
          output: "ok",
        },
      },
    }),
  );

  // Only the tool row is projected: the attempt lifecycle owns a run's outcome,
  // so a tool finishing must not turn a live run into a completed one.
  expect(emitted).toBe(1);
  const bootstrap = store.bootstrap("thread_legacy");
  expect(bootstrap.tools[0]).toMatchObject({
    toolCallId: "bash_1",
    status: "completed",
  });
  expect(bootstrap.runs).toHaveLength(1);
  expect(bootstrap.runs[0]?.status).toBe("running");
});

test("closes only the synthetic run a run-less tool call invented", () => {
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_tool_3",
      sequence: 1,
      eventType: "tool.started",
      streamState: "streaming",
      runAttemptId: undefined,
      metadata: {
        tool: { name: "Bash", toolUseId: "bash_2", input: { command: "pwd" } },
      },
    }),
  );
  expect(store.bootstrap("thread_legacy").runs[0]?.status).toBe("running");

  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_tool_4",
      sequence: 2,
      eventType: "tool.completed",
      streamState: "finalized",
      runAttemptId: undefined,
      metadata: {
        tool: { name: "Bash", toolUseId: "bash_2", output: "ok" },
      },
    }),
  );
  const bootstrap = store.bootstrap("thread_legacy");
  expect(bootstrap.runs).toHaveLength(1);
  expect(bootstrap.runs[0]?.runId.startsWith("legacy_run_")).toBe(true);
  expect(bootstrap.runs[0]?.status).toBe("completed");
});

test("does not invent a tool call from a provider task progress row", () => {
  // `todo.updated` progress rows carry a "Running <description>" label and no tool call
  // id. Deriving a tool call from them creates a second row for a call that already has
  // one, unowned, which readers draw in the main Feed (the legacy Feed drops them).
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      sequence: 1,
      id: "legacy_progress",
      eventType: "tool.started",
      scope: "agent",
      role: "coder",
      message: "Tool: Bash · Running Get detailed Sanya weather",
      metadata: {
        liveType: "todo.updated",
        sdkTaskId: "agent_sanya",
        sdkTaskKind: "task_progress",
        tool: { name: "Bash", detail: "Running Get detailed Sanya weather" },
      },
    }),
  );
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      sequence: 2,
      id: "legacy_call",
      eventType: "tool.started",
      scope: "agent",
      role: "coder",
      agentId: "agent_sanya",
      message: "Tool: Bash · Get detailed Sanya weather",
      observedAt: "2026-09-14T00:00:02.000Z",
      metadata: {
        liveType: "tool.started",
        tool: {
          name: "Bash",
          toolUseId: "call_sanya_1",
          detail: "curl -s 'https://wttr.in/Sanya'",
          description: "Get detailed Sanya weather",
        },
      },
    }),
  );

  const tools = store.bootstrap("thread_legacy").tools;
  expect(tools.map((tool) => tool.toolCallId)).toEqual(["call_sanya_1"]);
  expect(tools[0]).toMatchObject({
    agentInstanceId: "agent_sanya",
    occurredAt: "2026-09-14T00:00:02.000Z",
  });
});

test("keeps when each row happened so a Feed can place it inside the turn", () => {
  // Row order is a reader's order, not a conversation's: without the time, every row of
  // a turn collapses onto one instant and the Feed cannot put a message between tools.
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      sequence: 1,
      eventType: "message.final",
      streamState: "finalized",
      message: "starting",
      observedAt: "2026-09-14T00:00:01.000Z",
    }),
  );
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      sequence: 2,
      id: "legacy_event_2",
      eventType: "tool.completed",
      role: "tool",
      message: "Tool: Read · src/main.ts",
      observedAt: "2026-09-14T00:00:09.000Z",
      metadata: {
        liveType: "tool.completed",
        tool: { name: "Read", toolUseId: "toolu_1", detail: "src/main.ts" },
      },
    }),
  );

  const page = store.bootstrap("thread_legacy");
  expect(page.messages[0].occurredAt).toBe("2026-09-14T00:00:01.000Z");
  expect(page.tools[0].occurredAt).toBe("2026-09-14T00:00:09.000Z");
});

test("does not project a tool heartbeat as a call of its own", () => {
  // Heartbeats (`call_<id>-heartbeat-N`, `Tool: Bash (30.0s)`) are progress ticks of a
  // running call, not calls. The legacy Feed shows none of them for a conversation that
  // has 24 of these rows (measured on the dev database, `thr_1789531481908`), so a
  // reader that keeps them shows a row the old chain never had — and without an owner it
  // lands in the middle of the main Feed.
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      sequence: 1,
      id: "legacy_heartbeat",
      eventType: "tool.started",
      scope: "agent",
      role: "tool",
      message: "Tool: Bash (30.0s)",
      metadata: {
        liveType: "todo.updated",
        parent_tool_use_id: "call_spawn_1",
        tool: {
          name: "Bash",
          toolUseId: "call_bash_1-heartbeat-0",
          durationMs: 30000,
        },
      },
    }),
  );
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      sequence: 2,
      id: "legacy_call",
      eventType: "tool.completed",
      scope: "agent",
      role: "tool",
      agentId: "agent_a",
      message: "Tool: Bash · curl wttr.in",
      observedAt: "2026-09-14T00:00:03.000Z",
      metadata: {
        liveType: "tool.completed",
        tool: { name: "Bash", toolUseId: "call_bash_1", detail: "curl wttr.in" },
      },
    }),
  );

  expect(store.bootstrap("thread_legacy").tools.map((tool) => tool.toolCallId)).toEqual(["call_bash_1"]);
});

test("resolves an agent-scoped row from the durable parent tool owner", () => {
  const store = createStore();
  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_parent_tool",
      sequence: 1,
      eventType: "tool.started",
      scope: "agent",
      role: "coder",
      agentId: "agent_weather",
      message: "Tool: Bash · fetch weather",
      metadata: {
        liveType: "tool.started",
        tool: { name: "Bash", toolUseId: "call_weather", input: { command: "curl weather" } },
      },
    }),
  );

  appendLegacyThreadRunEventToConversationV2(
    store,
    event({
      id: "legacy_nested_message",
      sequence: 2,
      eventType: "message.final",
      scope: "agent",
      role: "main",
      agentId: undefined,
      parentToolUseId: "call_weather",
      streamKey: "nested_weather_summary",
      streamState: "finalized",
      message: "天气查询完成",
    }),
  );

  expect(store.bootstrap("thread_legacy").messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        body: "天气查询完成",
        agentId: "agent_weather",
        agentInstanceId: "agent_weather",
      }),
    ]),
  );
});
