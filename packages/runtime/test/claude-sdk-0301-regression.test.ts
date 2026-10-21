import { expect, test } from "bun:test";
import { buildSdkTodoUpdatedPayload, mapSdkMessageToEvents } from "../src/claude-agent-sdk";
import { buildSdkTodoUpdatedPayload as buildDisplayTask } from "../src/runtime-activity-display";
import { createSdkStreamContext, registerSubagentOnStreamContext } from "../src/sdk-stream-events";

test("native SDK agent identity wins over stale parent-tool linkage after resume", () => {
  const context = createSdkStreamContext();
  registerSubagentOnStreamContext(context, {
    role: "coder",
    agentId: "old-child",
    parentToolUseId: "launch",
  });
  const events = mapSdkMessageToEvents(
    {
      type: "assistant",
      session_id: "main",
      uuid: "resumed-reply",
      parent_tool_use_id: "launch",
      agent_id: "resumed-child",
      message: {
        id: "native-message",
        model: "test",
        usage: { input_tokens: 12, output_tokens: 3 },
        content: [
          { type: "text", text: "child reply" },
          { type: "tool_use", id: "read", name: "Read", input: { file_path: "/tmp/test" } },
        ],
      },
    },
    "thread",
    context,
  );
  expect(events.map((event) => event.type)).toEqual(["usage.recorded", "message.delta", "tool.started"]);
  for (const event of events) {
    expect(event.agentId).toBe("resumed-child");
    expect(event.role).toBe("coder");
    expect(event.payload).toMatchObject({
      agent_id: "resumed-child",
      subagentAgentId: "resumed-child",
      parent_tool_use_id: "launch",
    });
  }
  const result = mapSdkMessageToEvents(
    { type: "result", session_id: "main", num_turns: 1, subtype: "success" },
    "thread",
    context,
  );
  expect(result.every((event) => event.agentId === "main")).toBe(true);
});

test("a native child without parent-tool metadata keeps its text, usage and tool results", () => {
  const context = createSdkStreamContext();
  const assistant = mapSdkMessageToEvents(
    {
      type: "assistant",
      session_id: "main",
      agent_id: "child",
      uuid: "child-reply",
      message: {
        id: "child-message",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: "reply" }],
      },
    },
    "thread",
    context,
  );
  expect(assistant).toHaveLength(2);
  expect(assistant.every((event) => event.agentId === "child")).toBe(true);
  const result = mapSdkMessageToEvents(
    {
      type: "user",
      session_id: "main",
      agent_id: "child",
      uuid: "child-tool-result",
      message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "ok" }] },
    },
    "thread",
    context,
  );
  expect(result[0]).toMatchObject({
    agentId: "child",
    type: "tool.completed",
    payload: { agent_id: "child" },
  });
});

test("task generations and parent identity survive live and renderer-safe task projections", () => {
  for (const build of [buildSdkTodoUpdatedPayload, buildDisplayTask]) {
    for (const run_id of ["run-first", "run-resumed"]) {
      const event = {
        subtype: "task_started",
        task_id: "child",
        run_id,
        parent_task_id: "parent",
        description: "child run",
      };
      expect(JSON.parse(JSON.stringify(build(event)))).toMatchObject({
        task_id: "child",
        run_id,
        parent_task_id: "parent",
      });
      expect(
        mapSdkMessageToEvents({ ...event, type: "system", session_id: "main" }, "thread")[0]?.payload,
      ).toMatchObject({ task_id: "child", run_id, parent_task_id: "parent" });
    }
  }
});
