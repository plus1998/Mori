import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentEvent } from "../../shared/src";
import { isEcoStreamPlaceholder } from "../src/sdk-stream-events";
import { runScriptedPiSession } from "./pi-session-events-probe";

interface ToolPayload {
  type: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input_target?: string;
  input?: Record<string, unknown>;
  streaming?: boolean;
  input_complete?: boolean;
}

function toolPayloads(events: AgentEvent[]): ToolPayload[] {
  return events
    .filter((event) => event.type === "tool.started")
    .map((event) => event.payload as unknown as ToolPayload);
}

async function makeWorkspace(): Promise<{ workspace: string; agentDir: string }> {
  const workspace = await mkdtemp(path.join(tmpdir(), "eco-pi-writing-ws-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "eco-pi-writing-agent-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "target.txt"), "NESTED-TARGET-CONTENT", "utf8");
  return { workspace, agentDir };
}

/**
 * End-to-end smoke: a real PI session whose model writes a tool call's arguments one
 * fragment at a time. Before this change the session went silent between the last
 * narrative token and `tool_execution_start`, and the Composer could only guess from a
 * still Feed; now the adapter announces the call the moment the model commits to it.
 *
 * The scripted endpoint is a local Anthropic Messages server (the same wire the real
 * provider speaks), so the PI SDK, the MCP/extension stack and the event adapter are all
 * the production ones — only the model is scripted.
 */
test("PI session announces the tool call while its arguments are still being written", async () => {
  const { workspace, agentDir } = await makeWorkspace();
  const result = await runScriptedPiSession({
    workspace,
    agentDir,
    threadId: "thr_pi_tool_writing",
    streamToolArgs: { fragments: 24, delayMs: 25 },
    turns: [
      {
        tool: "write",
        id: "call_write",
        input: { path: "src/out.txt", content: "x".repeat(240) },
      },
      { text: "done" },
    ],
    toolsAllowlist: ["read", "write"],
  });
  try {
    const started = toolPayloads(result.events);
    // Two rows per call on purpose: the placeholder announcing the write, then the real
    // row once the arguments are complete and the tool actually runs.
    const announced = started.filter((payload) => payload.streaming === true);
    const completed = started.filter((payload) => payload.input_complete === true);

    // Two facts about the wait: the call is under way, then which file it is writing.
    expect(announced).toHaveLength(2);
    expect(completed).toHaveLength(1);
    expect(announced[0]?.tool_name).toBe("Write");
    expect(announced[0]?.tool_use_id).toBe("call_write");
    expect(announced[0]?.tool_input_target).toBeUndefined();
    expect(announced[1]?.tool_input_target).toBe("src/out.txt");
    // Still incomplete: nothing may present this as a runnable tool row.
    expect(announced[0]?.input).toBeUndefined();
    expect(announced[1]?.input).toBeUndefined();
    expect(completed[0]?.input).toEqual({ path: "src/out.txt", content: "x".repeat(240) });

    const announcedIndex = result.events.findIndex(
      (event) =>
        event.type === "tool.started" && (event.payload as unknown as ToolPayload).streaming === true,
    );
    const completedIndex = result.events.findIndex(
      (event) =>
        event.type === "tool.started" && (event.payload as unknown as ToolPayload).input_complete === true,
    );
    expect(announcedIndex).toBeGreaterThanOrEqual(0);
    expect(announcedIndex).toBeLessThan(completedIndex);

    // 24 fragments × 25 ms: the announced state must hold for the whole writing window,
    // which is the point — the window is seconds long, not a race.
    const announcedAt = Date.parse(String(result.events[announcedIndex]?.timestamp));
    const completedAt = Date.parse(String(result.events[completedIndex]?.timestamp));
    expect(completedAt - announcedAt).toBeGreaterThanOrEqual(300);

    // The placeholder must never be mistaken for streamed narrative text.
    expect(isEcoStreamPlaceholder(announced[0])).toBe(false);
    expect(isEcoStreamPlaceholder(announced[1])).toBe(false);

    // The file is named well before the arguments finish — that is what makes the label worth
    // showing: it lands early in the window, not at the end of it.
    const namedIndex = result.events.findIndex(
      (event) =>
        event.type === "tool.started" &&
        (event.payload as unknown as ToolPayload).tool_input_target === "src/out.txt",
    );
    expect(namedIndex).toBeGreaterThan(announcedIndex);
    expect(namedIndex).toBeLessThan(completedIndex);
    const namedAt = Date.parse(String(result.events[namedIndex]?.timestamp));
    expect(completedAt - namedAt).toBeGreaterThanOrEqual(200);
  } finally {
    await result.dispose();
  }
}, 60_000);
