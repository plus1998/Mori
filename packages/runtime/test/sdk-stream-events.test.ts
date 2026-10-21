import { expect, test } from "bun:test";
import { mapSdkMessageToEvents } from "../src/claude-agent-sdk";
import {
  createSdkStreamContext,
  mapStreamEventToEvents,
  registerSubagentOnStreamContext,
} from "../src/sdk-stream-events";
import { ecoSubagentKeyForRole } from "../src/subagent-availability";

test("maps tool_use content_block_start to tool.started", () => {
  const ctx = createSdkStreamContext();
  const events = mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "u1",
      session_id: "sess",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Read", id: "toolu_abc" },
      },
    },
    "thr_1",
    ctx,
  );
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("tool.started");
  const payload = events[0]?.payload as Record<string, unknown>;
  expect(payload.tool_name).toBe("Read");
  expect(payload.tool_use_id).toBe("toolu_abc");
  expect(payload.streaming).toBe(true);
  expect(payload.input_complete).toBeUndefined();
});

test("marks tool_use content_block_stop input as complete", () => {
  const ctx = createSdkStreamContext();
  mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "u1",
      session_id: "sess",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Read", id: "toolu_abc" },
      },
    },
    "thr_1",
    ctx,
  );
  mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "u2",
      session_id: "sess",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"file_path":"/a.ts"}' },
      },
    },
    "thr_1",
    ctx,
  );
  const events = mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "u3",
      session_id: "sess",
      event: { type: "content_block_stop" },
    },
    "thr_1",
    ctx,
  );
  expect(events).toHaveLength(1);
  const payload = events[0]?.payload as Record<string, unknown>;
  expect(payload.tool_name).toBe("Read");
  expect(payload.input_complete).toBe(true);
  expect(payload.input).toEqual({ file_path: "/a.ts" });
});

test("maps eco subagent stream metadata to the role", () => {
  const ctx = createSdkStreamContext();
  const events = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_eco",
      session_id: "sess",
      subagent_type: ecoSubagentKeyForRole("coder"),
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Read", id: "toolu_eco" },
      },
    },
    "thr_1",
    "sess",
    "main",
    "u_eco",
    ctx,
  );
  expect(events[0]?.role).toBe("coder");
});

test("maps dynamic eco subagent stream metadata to the role", () => {
  const ctx = createSdkStreamContext();
  const events = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_dynamic",
      session_id: "sess",
      subagent_type: "eco_researcher",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "WebSearch", id: "toolu_research" },
      },
    },
    "thr_1",
    "sess",
    "main",
    "u_dynamic",
    ctx,
  );
  expect(events[0]?.role).toBe("researcher");
});

test("maps general-purpose stream metadata to the role", () => {
  const ctx = createSdkStreamContext();
  const events = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_general",
      session_id: "sess",
      subagent_type: "general-purpose",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Read", id: "toolu_general" },
      },
    },
    "thr_1",
    "sess",
    "main",
    "u_general",
    ctx,
  );
  expect(events[0]?.role).toBe("general-purpose");
});

test("maps Plan stream metadata to the role", () => {
  const ctx = createSdkStreamContext();
  const events = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_plan",
      session_id: "sess",
      subagent_type: "Plan",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Read", id: "toolu_plan" },
      },
    },
    "thr_1",
    "sess",
    "main",
    "u_plan",
    ctx,
  );
  expect(events[0]?.role).toBe("Plan");
});

test("attributes dynamic subagent stream usage through resolver", () => {
  const calls: Array<{ role: string; parentToolUseId?: string; sessionId: string }> = [];
  const ctx = createSdkStreamContext({
    resolveSubagentAgentId(input) {
      calls.push(input);
      return "agent_researcher";
    },
  });
  const events = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_usage",
      session_id: "sess",
      subagent_type: "eco_researcher",
      parent_tool_use_id: "toolu_parent",
      event: {
        type: "message_delta",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    },
    "thr_1",
    "sess",
    "main",
    "u_usage",
    ctx,
  );

  expect(calls).toEqual([{ role: "researcher", parentToolUseId: "toolu_parent", sessionId: "sess" }]);
  expect(events[0]?.agentId).toBe("agent_researcher");
  expect(events[0]?.role).toBe("researcher");
});

test("does not attribute main-session stream usage to a stale subagent context", () => {
  const calls: Array<{ role: string; parentToolUseId?: string; sessionId: string }> = [];
  const ctx = createSdkStreamContext({
    resolveSubagentAgentId(input) {
      calls.push(input);
      return "agent_explore";
    },
  });
  mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_sub",
      session_id: "sess",
      subagent_type: "eco_explore",
      parent_tool_use_id: "toolu_parent",
      event: { type: "message_delta", usage: { input_tokens: 50, output_tokens: 5 } },
    },
    "thr_1",
    "sess",
    "main",
    "u_sub",
    ctx,
  );
  calls.length = 0;

  const mainEvents = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_main",
      session_id: "sess",
      event: { type: "message_delta", usage: { input_tokens: 200, output_tokens: 10 } },
    },
    "thr_1",
    "sess",
    "main",
    "u_main",
    ctx,
  );

  expect(calls).toHaveLength(0);
  expect(mainEvents[0]?.agentId).toBe("sess");
  expect(mainEvents[0]?.role).toBe("main");
  expect((mainEvents[0]?.payload as Record<string, unknown>).parent_tool_use_id).toBeUndefined();
});

test("keeps parent_tool_use_id on usage payload when runtime resolution fails", () => {
  const ctx = createSdkStreamContext({
    resolveSubagentAgentId() {
      return undefined;
    },
  });
  const events = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_unresolved",
      session_id: "sess",
      subagent_type: "eco_explore",
      parent_tool_use_id: "toolu_parallel",
      event: { type: "message_delta", usage: { input_tokens: 80, output_tokens: 8 } },
    },
    "thr_1",
    "sess",
    "main",
    "u_unresolved",
    ctx,
  );

  expect(events[0]?.agentId).toBe("sess");
  expect((events[0]?.payload as Record<string, unknown>).parent_tool_use_id).toBe("toolu_parallel");
});

test("keeps per-subagent roles when parallel streams interleave", () => {
  const ctx = createSdkStreamContext();
  mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_a1",
      session_id: "sess",
      subagent_type: "eco_explore",
      parent_tool_use_id: "toolu_a",
      event: { type: "content_block_start", content_block: { type: "text" } },
    },
    "thr_1",
    "sess",
    "main",
    "u_a1",
    ctx,
  );
  mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_b1",
      session_id: "sess",
      subagent_type: ecoSubagentKeyForRole("coder"),
      parent_tool_use_id: "toolu_b",
      event: { type: "content_block_start", content_block: { type: "text" } },
    },
    "thr_1",
    "sess",
    "main",
    "u_b1",
    ctx,
  );

  // Later chunk from subagent A carries only the parent id, not the subagent type.
  const events = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u_a2",
      session_id: "sess",
      parent_tool_use_id: "toolu_a",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
    },
    "thr_1",
    "sess",
    "main",
    "u_a2",
    ctx,
  );
  expect(events[0]?.role).toBe("explore");
});

test("suppresses text_delta while inside tool block", () => {
  const ctx = createSdkStreamContext();
  mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u1",
      session_id: "sess",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Bash", id: "toolu_bash" },
      },
    },
    "thr_1",
    "sess",
    "main",
    "u1",
    ctx,
  );
  const textEvents = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u2",
      session_id: "sess",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "should not show" },
      },
    },
    "thr_1",
    "sess",
    "main",
    "u2",
    ctx,
  );
  expect(textEvents).toHaveLength(0);
});

test("emits thinking placeholder and finalize stream events", () => {
  const ctx = createSdkStreamContext();
  const start = mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "u1",
      session_id: "sess",
      event: {
        type: "content_block_start",
        content_block: { type: "thinking" },
      },
    },
    "thr_1",
    ctx,
  );
  expect(start[0]?.type).toBe("message.delta");
  const payload = start[0]?.payload as Record<string, unknown>;
  expect(payload.type).toBe("eco_stream");
  expect(payload.streamPlaceholder).toBe(true);

  mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u2",
      session_id: "sess",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
    },
    "thr_1",
    "sess",
    "main",
    "u2",
    ctx,
  );

  const stop = mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "u3",
      session_id: "sess",
      event: { type: "content_block_stop" },
    },
    "thr_1",
    ctx,
  );
  const finalize = stop[0]?.payload as Record<string, unknown>;
  expect(finalize.streamFinalize).toBe(true);
});

test("attaches stable stream block keys from content block index", () => {
  const ctx = createSdkStreamContext();
  const start = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u1",
      session_id: "sess",
      event: {
        type: "content_block_start",
        index: 2,
        content_block: { type: "text" },
      },
    },
    "thr_1",
    "sess",
    "main",
    "u1",
    ctx,
  );
  const delta = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u2",
      session_id: "sess",
      event: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "正文一" },
      },
    },
    "thr_1",
    "sess",
    "main",
    "u2",
    ctx,
  );
  const stop = mapStreamEventToEvents(
    {
      type: "stream_event",
      uuid: "u3",
      session_id: "sess",
      event: { type: "content_block_stop", index: 2 },
    },
    "thr_1",
    "sess",
    "main",
    "u3",
    ctx,
  );

  expect((start[0]?.payload as Record<string, unknown>).stream_block_key).toBe("text:2");
  expect((delta[0]?.payload as Record<string, unknown>).stream_block_key).toBe("text:2");
  expect((stop[0]?.payload as Record<string, unknown>).stream_block_key).toBe("text:2");
});

test("expands serialized content array delivered as one text_delta", () => {
  const ctx = createSdkStreamContext();
  const payload =
    '[{"type":"text","text":"Inspect admin tabs."},{"type":"tool_use","id":"toolu_x","name":"Read","input":{"file_path":"/tmp/main.tsx"}}]';
  const events = mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "u_embed",
      session_id: "sess",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: payload },
      },
    },
    "thr_1",
    ctx,
  );
  expect(events.some((event) => event.type === "message.delta" && event.payload?.type === "eco_stream")).toBe(
    true,
  );
  expect(events.some((event) => event.type === "tool.started")).toBe(true);
  expect(events.some((event) => event.payload?.text === payload)).toBe(false);
});

test("skips duplicate assistant tool_use when stream already emitted", () => {
  const ctx = createSdkStreamContext();
  mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "u1",
      session_id: "sess",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Read", id: "toolu_dup" },
      },
    },
    "thr_1",
    ctx,
  );
  const assistantEvents = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "u2",
      session_id: "sess",
      message: {
        content: [{ type: "tool_use", name: "Read", id: "toolu_dup", input: { file_path: "/a.ts" } }],
      },
    },
    "thr_1",
    ctx,
  );
  expect(assistantEvents).toHaveLength(0);
});

test("maps message_delta usage to usage.recorded", () => {
  const ctx = createSdkStreamContext();
  const events = mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "u1",
      session_id: "sess",
      event: {
        type: "message_delta",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    "thr_1",
    ctx,
  );
  expect(events.some((event) => event.type === "usage.recorded")).toBe(true);
});

test("assistant tool_use without message parent stays unresolved instead of inheriting stream context", () => {
  const ctx = createSdkStreamContext();
  ctx.parentToolUseId = "toolu_delegate";
  ctx.activeSubagentRole = "explore";
  const events = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "u_assistant",
      session_id: "sess",
      message: {
        id: "msg_unresolved",
        content: [{ type: "tool_use", name: "Read", id: "toolu_read", input: { file_path: "/a.ts" } }],
      },
    },
    "thr_1",
    ctx,
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    agentId: "sess",
    type: "tool.started",
    role: "main",
  });
  expect(events[0]?.payload).toMatchObject({
    messageId: "msg_unresolved",
    tool_name: "Read",
  });
  expect((events[0]?.payload as Record<string, unknown>).parent_tool_use_id).toBeUndefined();
});

test("task_progress without tool_use_id does not inherit stale stream identity", () => {
  const ctx = createSdkStreamContext();
  ctx.parentToolUseId = "toolu_delegate";
  ctx.activeSubagentRole = "explore";
  const events = mapSdkMessageToEvents(
    {
      type: "system",
      subtype: "task_progress",
      task_id: "task_abc",
      description: "Inspecting auth module",
      last_tool_name: "Read",
      uuid: "sdk_task_1",
      session_id: "session_1",
    },
    "thr_1",
    ctx,
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    agentId: "session_1",
    type: "todo.updated",
    role: "main",
  });
  expect((events[0]?.payload as Record<string, unknown>).parent_tool_use_id).toBeUndefined();
});

test("task_progress uses exact tool_use_id and preserves aggregate terminal diagnostics", () => {
  const ctx = createSdkStreamContext();
  registerSubagentOnStreamContext(ctx, {
    role: "explore",
    parentToolUseId: "call_delegate",
  });
  const events = mapSdkMessageToEvents(
    {
      type: "system",
      subtype: "task_progress",
      task_id: "task_abc",
      tool_use_id: "call_delegate",
      description: "Inspecting auth module",
      last_tool_name: "Read",
      usage: { total_tokens: 120, tool_uses: 3, duration_ms: 4500 },
      uuid: "sdk_task_pre",
      session_id: "session_planner",
    },
    "thr_1",
    ctx,
  );

  expect(events[0]).toMatchObject({
    agentId: "session_planner",
    role: "explore",
    type: "todo.updated",
    payload: {
      parent_tool_use_id: "call_delegate",
      sdkKind: "task_progress",
      tool_use_id: "call_delegate",
      usage: { total_tokens: 120, tool_uses: 3, duration_ms: 4500 },
    },
  });
  expect(events.some((event) => event.type === "usage.recorded")).toBe(false);
});

test("task_progress does not use SubagentStart role-only registration", () => {
  const ctx = createSdkStreamContext();
  registerSubagentOnStreamContext(ctx, {
    role: "explore",
    agentId: "agent_explore_a",
  });
  const events = mapSdkMessageToEvents(
    {
      type: "system",
      subtype: "task_progress",
      task_id: "task_abc",
      description: "Inspecting auth module",
      last_tool_name: "Read",
      uuid: "sdk_task_role",
      session_id: "session_planner",
      subagent_type: "eco_explore",
    },
    "thr_1",
    ctx,
  );

  expect(events[0]?.agentId).toBe("session_planner");
});

test("task_progress resolves agent from exact tool_use_id registration", () => {
  const ctx = createSdkStreamContext();
  registerSubagentOnStreamContext(ctx, {
    role: "explore",
    agentId: "agent_explore_a",
    parentToolUseId: "call_delegate",
  });
  const events = mapSdkMessageToEvents(
    {
      type: "system",
      subtype: "task_progress",
      task_id: "task_abc",
      tool_use_id: "call_delegate",
      description: "Inspecting auth module",
      last_tool_name: "Read",
      uuid: "sdk_task_3",
      session_id: "session_planner",
    },
    "thr_1",
    ctx,
  );

  expect(events[0]?.agentId).toBe("agent_explore_a");
  expect(events[0]?.payload).toMatchObject({
    parent_tool_use_id: "call_delegate",
    sdkKind: "task_progress",
  });
});

test("task_notification preserves exact terminal fields without producing billing usage", () => {
  const ctx = createSdkStreamContext();
  registerSubagentOnStreamContext(ctx, {
    role: "general-purpose",
    agentId: "agent_general_a",
    parentToolUseId: "call_general",
  });
  const events = mapSdkMessageToEvents(
    {
      type: "system",
      subtype: "task_notification",
      task_id: "task_general",
      tool_use_id: "call_general",
      status: "completed",
      output_file: "/tmp/task.output",
      summary: "Done",
      usage: { total_tokens: 900, tool_uses: 5, duration_ms: 7000 },
      uuid: "sdk_task_notification",
      session_id: "session_planner",
    },
    "thr_1",
    ctx,
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    agentId: "agent_general_a",
    role: "general-purpose",
    type: "todo.updated",
    payload: {
      sdkKind: "task_notification",
      task_id: "task_general",
      tool_use_id: "call_general",
      parent_tool_use_id: "call_general",
      status: "completed",
      output_file: "/tmp/task.output",
      summary: "Done",
      usage: { total_tokens: 900, tool_uses: 5, duration_ms: 7000 },
    },
  });
  expect(events.some((event) => event.type === "usage.recorded")).toBe(false);
});

test("tool progress uses direct parent id while summary does not inherit context", () => {
  const ctx = createSdkStreamContext();
  ctx.parentToolUseId = "toolu_ctx";
  ctx.activeSubagentRole = "coder";
  const progress = mapSdkMessageToEvents(
    {
      type: "tool_progress",
      uuid: "u_progress",
      session_id: "sess",
      tool_use_id: "toolu_read",
      parent_tool_use_id: "toolu_msg",
    },
    "thr_1",
    ctx,
  );
  expect(progress[0]?.payload).toMatchObject({ parent_tool_use_id: "toolu_msg" });

  const summary = mapSdkMessageToEvents(
    {
      type: "tool_use_summary",
      uuid: "u_summary",
      session_id: "sess",
    },
    "thr_1",
    ctx,
  );
  expect((summary[0]?.payload as Record<string, unknown>).parent_tool_use_id).toBeUndefined();
  expect(summary[0]?.agentId).toBe("sess");
});

test("tool summaries recover Hub wrapper arguments from the streamed tool use", () => {
  const ctx = createSdkStreamContext();
  mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "u_hub_started",
      session_id: "sess",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_hub_call",
            name: "mcp__eco_mcp__call_tool",
            input: {
              name: "eco_image_view:view_image",
              arguments: { path: "/tmp/hub.png", prompt: "描述" },
            },
          },
        ],
      },
    },
    "thr_1",
    ctx,
  );

  const summary = mapSdkMessageToEvents(
    {
      type: "tool_use_summary",
      uuid: "u_hub_summary",
      session_id: "sess",
      tool_use_id: "toolu_hub_call",
      tool_name: "mcp__eco_mcp__call_tool",
      summary: "completed",
    },
    "thr_1",
    ctx,
  );

  expect(summary[0]?.payload).toMatchObject({
    tool_name: "mcp__eco_mcp__call_tool",
    input: {
      name: "eco_image_view:view_image",
      arguments: { path: "/tmp/hub.png", prompt: "描述" },
    },
  });
});

test("message_start propagates one exact message id to streamed text, thinking, tool, and usage", () => {
  const ctx = createSdkStreamContext();
  registerSubagentOnStreamContext(ctx, {
    role: "general-purpose",
    agentId: "agent_general_stream",
    parentToolUseId: "call_general_stream",
  });
  mapStreamEventToEvents(
    {
      type: "stream_event",
      parent_tool_use_id: "call_general_stream",
      subagent_type: "general-purpose",
      event: { type: "message_start", message: { id: "msg_stream_exact" } },
    },
    "thr_stream_exact",
    "session_planner",
    "main",
    "stream_start",
    ctx,
  );

  const text = mapStreamEventToEvents(
    {
      type: "stream_event",
      parent_tool_use_id: "call_general_stream",
      subagent_type: "general-purpose",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    },
    "thr_stream_exact",
    "session_planner",
    "main",
    "stream_text",
    ctx,
  );
  const thinking = mapStreamEventToEvents(
    {
      type: "stream_event",
      parent_tool_use_id: "call_general_stream",
      subagent_type: "general-purpose",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: "reason" },
      },
    },
    "thr_stream_exact",
    "session_planner",
    "main",
    "stream_thinking",
    ctx,
  );
  const tool = mapStreamEventToEvents(
    {
      type: "stream_event",
      parent_tool_use_id: "call_general_stream",
      subagent_type: "general-purpose",
      event: {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", name: "Read", id: "tool_read_exact" },
      },
    },
    "thr_stream_exact",
    "session_planner",
    "main",
    "stream_tool",
    ctx,
  );
  const usage = mapStreamEventToEvents(
    {
      type: "stream_event",
      parent_tool_use_id: "call_general_stream",
      subagent_type: "general-purpose",
      event: { type: "message_delta", usage: { input_tokens: 40, output_tokens: 8 } },
    },
    "thr_stream_exact",
    "session_planner",
    "main",
    "stream_usage",
    ctx,
  );

  for (const event of [...text, ...thinking, ...tool, ...usage]) {
    expect(event.agentId).toBe("agent_general_stream");
    expect((event.payload as Record<string, unknown>).messageId).toBe("msg_stream_exact");
  }
});

test("assistant final replay uses one exact agent and message id across all content kinds", () => {
  const ctx = createSdkStreamContext();
  registerSubagentOnStreamContext(ctx, {
    role: "general-purpose",
    agentId: "agent_general_final",
    parentToolUseId: "call_general_final",
  });
  const events = mapSdkMessageToEvents(
    {
      type: "assistant",
      uuid: "assistant_final_exact",
      session_id: "session_planner",
      parent_tool_use_id: "call_general_final",
      subagent_type: "general-purpose",
      message: {
        id: "msg_final_exact",
        usage: { input_tokens: 80, output_tokens: 20 },
        content: [
          { type: "thinking", thinking: "reason" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "tool_final_read", name: "Read", input: { file_path: "/a.ts" } },
        ],
      },
    },
    "thr_final_exact",
    ctx,
  );

  expect(events.map((event) => event.type).sort()).toEqual([
    "message.delta",
    "message.delta",
    "tool.started",
    "usage.recorded",
  ]);
  for (const event of events) {
    expect(event.agentId).toBe("agent_general_final");
    expect(event.role).toBe("general-purpose");
    expect((event.payload as Record<string, unknown>).messageId).toBe("msg_final_exact");
  }
});
