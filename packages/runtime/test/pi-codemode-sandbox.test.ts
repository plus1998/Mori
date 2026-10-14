import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentEvent } from "../src";
import { PI_CODEMODE_TOOL_NAME } from "../src/pi-codemode";
import { runScriptedPiSession } from "./pi-session-events-probe";

interface ToolEvent {
  type: string;
  payload: {
    type: string;
    tool_name?: string;
    tool_use_id?: string;
    input?: Record<string, unknown>;
    content?: string;
    message?: string;
    parent_tool_call_id?: string;
  };
}

function toolEvents(events: AgentEvent[]): ToolEvent[] {
  return events.filter((event) => event.type.startsWith("tool.")) as unknown as ToolEvent[];
}

/**
 * Tool calls that actually ran. The adapter also announces a call while the model is still
 * writing its arguments (`tool.started` with `input_complete: false`); that is a fact about
 * the model, not an execution, so these tests look at the executed calls only.
 */
function executedToolEvents(events: AgentEvent[]): ToolEvent[] {
  return toolEvents(events).filter(
    (event) => !(event.type === "tool.started" && event.payload.input_complete === false),
  );
}

async function makeWorkspace(): Promise<{ workspace: string; agentDir: string }> {
  const workspace = await mkdtemp(path.join(tmpdir(), "eco-pi-codemode-ws-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "eco-pi-codemode-agent-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "target.txt"), "NESTED-TARGET-CONTENT", "utf8");
  return { workspace, agentDir };
}

test("codemode sandbox exposes exactly the session's tool allowlist, minus codemode itself", async () => {
  const { workspace, agentDir } = await makeWorkspace();
  const result = await runScriptedPiSession({
    workspace,
    agentDir,
    threadId: "thr_codemode_sandbox",
    turns: [
      { tool: PI_CODEMODE_TOOL_NAME, id: "code_1", input: { code: "return ALL_TOOLS.map((t) => t.name);" } },
      { text: "done" },
    ],
  });
  try {
    // The model sees codemode plus the builtins...
    expect(result.requests[0]?.toolNames).toEqual(["read", "bash", "edit", "write", PI_CODEMODE_TOOL_NAME]);
    const completed = toolEvents(result.events).find(
      (event) => event.type === "tool.completed" && event.payload.tool_use_id === "code_1",
    );
    // ...while the sandbox only reaches what the session already allowed, and
    // cannot re-enter codemode from inside a script.
    expect(completed?.payload.content).toContain('["read","bash","edit","write"]');
    expect(result.turnCount).toBe(2);
  } finally {
    await result.dispose();
  }
}, 60_000);

test("serial nested tool calls surface as their own events with <parent>/<n> ids", async () => {
  const { workspace, agentDir } = await makeWorkspace();
  const result = await runScriptedPiSession({
    workspace,
    agentDir,
    threadId: "thr_codemode_serial",
    turns: [
      {
        tool: PI_CODEMODE_TOOL_NAME,
        id: "code_1",
        input: { code: 'const a = await tools["read"]({ path: "src/target.txt" });\nreturn a;' },
      },
      { text: "done" },
    ],
  });
  try {
    const events = executedToolEvents(result.events);
    expect(events.map((event) => `${event.type}:${event.payload.tool_use_id}`)).toEqual([
      "tool.started:code_1",
      "tool.started:code_1/1",
      "tool.completed:code_1/1",
      "tool.completed:code_1",
    ]);
    // The nested call keeps its parent link on both halves, so a consumer can tell
    // it apart from a call the planner made itself instead of counting it twice.
    const nestedStart = events.find(
      (event) => event.type === "tool.started" && event.payload.tool_use_id === "code_1/1",
    );
    const nestedEnd = events.find(
      (event) => event.type === "tool.completed" && event.payload.tool_use_id === "code_1/1",
    );
    expect(nestedStart?.payload.parent_tool_call_id).toBe("code_1");
    expect(nestedEnd?.payload.parent_tool_call_id).toBe("code_1");
    // The parent call is the model's own, so it carries no parent link.
    expect(events[0]?.payload.parent_tool_call_id).toBeUndefined();
    expect(
      events.find((event) => event.payload.tool_use_id === "code_1" && event.type === "tool.completed")
        ?.payload.parent_tool_call_id,
    ).toBeUndefined();
    expect(nestedEnd?.payload.input).toEqual({ path: "src/target.txt" });
    expect(nestedEnd?.payload.content).toBe("NESTED-TARGET-CONTENT");
  } finally {
    await result.dispose();
  }
}, 60_000);

test("parallel nested tool calls each get a distinct index under the same parent", async () => {
  const { workspace, agentDir } = await makeWorkspace();
  const result = await runScriptedPiSession({
    workspace,
    agentDir,
    threadId: "thr_codemode_parallel",
    turns: [
      {
        tool: PI_CODEMODE_TOOL_NAME,
        id: "code_2",
        input: {
          code: 'const [x, y] = await Promise.all([tools["read"]({ path: "src/target.txt" }), tools["read"]({ path: "src/target.txt" })]);\nreturn { x, y };',
        },
      },
      { text: "done" },
    ],
  });
  try {
    const started = executedToolEvents(result.events).filter((event) => event.type === "tool.started");
    expect(started.map((event) => event.payload.tool_use_id)).toEqual(["code_2", "code_2/1", "code_2/2"]);
    expect(started.map((event) => event.payload.parent_tool_call_id)).toEqual([
      undefined,
      "code_2",
      "code_2",
    ]);
    expect(result.requests.length).toBe(2);
  } finally {
    await result.dispose();
  }
}, 60_000);

test("a failed nested call keeps its parent link and reports the failure", async () => {
  const { workspace, agentDir } = await makeWorkspace();
  const result = await runScriptedPiSession({
    workspace,
    agentDir,
    threadId: "thr_codemode_nested_failure",
    turns: [
      {
        tool: PI_CODEMODE_TOOL_NAME,
        id: "code_3",
        input: {
          code: 'const a = await tools["read"]({ path: "src/missing.txt" });\nreturn a;',
        },
      },
      { text: "done" },
    ],
  });
  try {
    const events = toolEvents(result.events);
    const nestedFailure = events.find(
      (event) => event.type === "tool.failed" && event.payload.tool_use_id === "code_3/1",
    );
    expect(nestedFailure?.payload.parent_tool_call_id).toBe("code_3");
    expect(nestedFailure?.payload.type).toBe("tool_result_error");
    expect(nestedFailure?.payload.message).toBeTruthy();
  } finally {
    await result.dispose();
  }
}, 60_000);
