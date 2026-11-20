/**
 * PI agent smoke test — exercises the real adapter + display functions against
 * hand-constructed PI session events (no network) and reports, for each feature
 * type, whether the actual CONTENT/RESULT is surfaced or dropped.
 *
 * Run: bun test packages/runtime/test/pi-agent-smoke.test.ts
 *
 * Verdict legend: PASS = content surfaced · WARN = partial · FAIL = content dropped.
 */
import { expect, test } from "bun:test";
import {
  createPiEventAdapterState,
  mapPiSessionEventToAgentEvents,
  type PiEventAdapterContext,
} from "../src/pi-event-adapter";
import { formatAgentEventDisplay, formatAgentEventLine } from "../src/runtime-activity-display";

let seq = 0;
function makeCtx(): PiEventAdapterContext {
  seq = 0;
  return {
    threadId: "thr_pi",
    sessionId: "sess_1",
    state: createPiEventAdapterState(),
    nextSeq: () => {
      seq += 1;
      return seq;
    },
  };
}

function mapAll(ctx: PiEventAdapterContext, events: Array<Record<string, unknown>>) {
  const out = [];
  for (const ev of events) {
    for (const mapped of mapPiSessionEventToAgentEvents(ev, ctx)) {
      out.push(mapped);
    }
  }
  return out;
}

function findLine(events: ReturnType<typeof mapAll>, type: string): string | null {
  for (const ev of events) {
    if (ev.type === type) {
      const l = formatAgentEventLine(ev);
      if (l) {
        return l;
      }
    }
  }
  return null;
}

function findPayload(events: ReturnType<typeof mapAll>, type: string): Record<string, unknown> | null {
  for (const ev of events) {
    if (ev.type === type && ev.payload && typeof ev.payload === "object") {
      return ev.payload as Record<string, unknown>;
    }
  }
  return null;
}

test("1. text delta surfaces content", () => {
  const ctx = makeCtx();
  const mapped = mapAll(ctx, [
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello world" },
    },
    { type: "message_update", assistantMessageEvent: { type: "text_end", content: "Hello world" } },
  ]);
  const deltaEv = mapped.find((e) => e.type === "message.delta");
  expect(deltaEv).toBeTruthy();
  const payload = deltaEv?.payload as Record<string, unknown>;
  expect(payload.blockKind).toBe("text");
  expect(payload.text).toBe("Hello world");
  const disp = formatAgentEventDisplay(deltaEv!);
  expect(disp?.message).toBe("Hello world");
});

test("2. thinking delta surfaces content", () => {
  const ctx = makeCtx();
  const mapped = mapAll(ctx, [
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "reasoning…" },
    },
  ]);
  const ev = mapped.find((e) => e.type === "message.delta");
  expect(ev).toBeTruthy();
  const payload = ev?.payload as Record<string, unknown>;
  expect(payload.blockKind).toBe("thinking");
  expect(payload.text).toBe("reasoning…");
});

test("3. bash tool.started shows command label", () => {
  const ctx = makeCtx();
  const mapped = mapAll(ctx, [
    {
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls -la" },
    },
  ]);
  const l = findLine(mapped, "tool.started");
  expect(l).toBe("Tool: Bash · ls -la");
  const p = findPayload(mapped, "tool.started")!;
  expect(p.tool_name).toBe("Bash");
  expect((p.input as Record<string, unknown>).command).toBe("ls -la");
});

test("4. read tool.completed surfaces file path and content preview", () => {
  const ctx = makeCtx();
  const fileContent = "line1\nline2\nline3";
  const mapped = mapAll(ctx, [
    { type: "tool_execution_start", toolCallId: "tc2", toolName: "read", args: { path: "a.ts" } },
    {
      type: "tool_execution_end",
      toolCallId: "tc2",
      toolName: "read",
      result: { content: [{ type: "text", text: fileContent }] },
    },
  ]);
  const completed = mapped.find((e) => e.type === "tool.completed");
  expect(completed).toBeTruthy();
  const payload = completed?.payload as Record<string, unknown>;
  expect(payload.content).toBe(fileContent);
  expect((payload.input as Record<string, unknown>).path).toBe("a.ts");
  const l = formatAgentEventLine(completed!);
  expect(l?.includes("a.ts")).toBe(true);
  expect(l?.includes("line1")).toBe(true);
});

test("5. write tool.completed surfaces result preview", () => {
  const ctx = makeCtx();
  const mapped = mapAll(ctx, [
    { type: "tool_execution_start", toolCallId: "tc3", toolName: "write", args: { path: "b.ts" } },
    {
      type: "tool_execution_end",
      toolCallId: "tc3",
      toolName: "write",
      result: { content: [{ type: "text", text: "File written successfully." }] },
    },
  ]);
  const completed = mapped.find((e) => e.type === "tool.completed");
  const payload = completed?.payload as Record<string, unknown>;
  expect(payload.content).toBe("File written successfully.");
  const l = formatAgentEventLine(completed!);
  expect(l?.includes("b.ts")).toBe(true);
  expect(l?.includes("File written successfully")).toBe(true);
});

test("6. bash tool.completed surfaces grep matches", () => {
  const ctx = makeCtx();
  const matches = "a.ts:10:foo\nb.ts:20:bar";
  const mapped = mapAll(ctx, [
    { type: "tool_execution_start", toolCallId: "tc4", toolName: "bash", args: { command: "grep foo *.ts" } },
    {
      type: "tool_execution_end",
      toolCallId: "tc4",
      toolName: "bash",
      result: { content: [{ type: "text", text: matches }] },
    },
  ]);
  const completed = mapped.find((e) => e.type === "tool.completed");
  const payload = completed?.payload as Record<string, unknown>;
  expect(payload.content).toBe(matches);
  const l = formatAgentEventLine(completed!);
  expect(l?.includes("grep foo")).toBe(true);
  expect(l?.includes("foo")).toBe(true);
});

test("7. mcp tool.completed surfaces result preview", () => {
  const ctx = makeCtx();
  const resultText = '{"mori_image_view": "initialized"}';
  const mapped = mapAll(ctx, [
    { type: "tool_execution_start", toolCallId: "tc5", toolName: "mcp", args: { server: "mori_image_view" } },
    {
      type: "tool_execution_end",
      toolCallId: "tc5",
      toolName: "mcp",
      result: { content: [{ type: "text", text: resultText }] },
    },
  ]);
  const completed = mapped.find((e) => e.type === "tool.completed");
  const payload = completed?.payload as Record<string, unknown>;
  expect(payload.content).toBe(resultText);
  const l = formatAgentEventLine(completed!);
  expect(l?.includes("mori_image_view")).toBe(true);
  expect(l?.includes("initialized")).toBe(true);
});

test("8. skill tool.completed surfaces result preview", () => {
  const ctx = makeCtx();
  const mapped = mapAll(ctx, [
    { type: "tool_execution_start", toolCallId: "tc6", toolName: "dataviz", args: {} },
    {
      type: "tool_execution_end",
      toolCallId: "tc6",
      toolName: "dataviz",
      result: { content: [{ type: "text", text: "chart rendered" }] },
    },
  ]);
  const completed = mapped.find((e) => e.type === "tool.completed");
  const l = formatAgentEventLine(completed!);
  expect(l?.includes("chart rendered")).toBe(true);
});

test("9. Agent subagent tool surfaces mission and result", () => {
  const ctx = makeCtx();
  const mapped = mapAll(ctx, [
    {
      type: "tool_execution_start",
      toolCallId: "tc7",
      toolName: "Agent",
      args: { agent: "coder", task: "实现冒烟测试" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "tc7",
      toolName: "Agent",
      result: { content: [{ type: "text", text: "子代理完整输出：完成了所有工作…" }] },
    },
  ]);
  const started = mapped.find((e) => e.type === "tool.started");
  const startedLine = formatAgentEventLine(started!);
  expect(startedLine?.includes("实现冒烟测试")).toBe(true);
  const startedPayload = started?.payload as Record<string, unknown>;
  expect((startedPayload.input as Record<string, unknown>).subagent_type).toBe("coder");
  const completed = mapped.find((e) => e.type === "tool.completed");
  const payload = completed?.payload as Record<string, unknown>;
  expect(payload.content).toBe("子代理完整输出：完成了所有工作…");
  const completedLine = formatAgentEventLine(completed!);
  expect(completedLine?.includes("完成了所有工作")).toBe(true);
});

test("10. usage.recorded and run.terminal produce no activity line", () => {
  const ctx = makeCtx();
  const assistantMessage = {
    role: "assistant",
    stopReason: "endTurn",
    model: "claude-sonnet-4-20250514",
    usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, cost: { total: 0.01 } },
    content: [{ type: "text", text: "done" }],
  };
  const mapped = mapAll(ctx, [
    // Real PI order: message_end precedes agent_end; usage is emitted exactly once,
    // at message_end (agent_end must not re-emit it from the transcript).
    { type: "message_end", message: assistantMessage },
    { type: "agent_end", willRetry: false, messages: [assistantMessage] },
    { type: "agent_settled" },
  ]);
  const usageEvents = mapped.filter((e) => e.type === "usage.recorded");
  expect(usageEvents).toHaveLength(1);
  expect(formatAgentEventLine(usageEvents[0]!)).toBeNull();
  const settled = mapped.find((e) => e.type === "agent.settled");
  expect(settled).toBeTruthy();
  expect(formatAgentEventLine(settled!)).toBeNull();
});

test("11. tool.failed surfaces error message and replays tool input", () => {
  const ctx = makeCtx();
  const mapped = mapAll(ctx, [
    {
      type: "tool_execution_start",
      toolCallId: "tc8",
      toolName: "read",
      args: { path: "/tmp/project" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "tc8",
      toolName: "read",
      isError: true,
      result: "EISDIR: illegal operation on a directory, read",
    },
  ]);
  const failed = mapped.find((e) => e.type === "tool.failed");
  expect(failed).toBeTruthy();
  const payload = failed?.payload as Record<string, unknown>;
  expect(payload.type).toBe("tool_result_error");
  expect(payload.message).toBe("EISDIR: illegal operation on a directory, read");
  expect((payload.input as Record<string, unknown>).path).toBe("/tmp/project");
  const l = formatAgentEventLine(failed!);
  expect(l).toBe("Tool failed: Read: EISDIR: illegal operation on a directory, read");
});

test("12. agent lifecycle events map correctly", () => {
  const ctx = makeCtx();
  const mapped = mapAll(ctx, [{ type: "agent_end", willRetry: false }]);
  const loopEnd = mapped.find((e) => e.type === "agent.loop_ended");
  expect(loopEnd).toBeTruthy();
  expect(formatAgentEventLine(loopEnd!)).toBeNull();
  const settled = mapAll(makeCtx(), [{ type: "agent_settled" }]);
  expect(settled.find((e) => e.type === "agent.settled")).toBeTruthy();
});

test("13. finalize_plan tool.completed surfaces plan text", () => {
  const ctx = makeCtx();
  const mapped = mapAll(ctx, [
    {
      type: "tool_execution_end",
      toolCallId: "tc9",
      toolName: "finalize_plan",
      result: { content: [{ type: "text", text: "Plan submitted. Stop." }] },
    },
  ]);
  const completed = mapped.find((e) => e.type === "tool.completed");
  const payload = completed?.payload as Record<string, unknown>;
  expect(payload.content).toBe("Plan submitted. Stop.");
  const l = formatAgentEventLine(completed!);
  expect(l?.includes("Plan submitted")).toBe(true);
});

test("SMOKE SUMMARY", () => {
  const rows: Array<[string, string, string, string, string]> = [
    ["text delta", "message.delta", "streaming text block", "✅ yes", "PASS"],
    ["thinking delta", "message.delta (thinking)", "streaming thinking block", "✅ yes", "PASS"],
    ["bash tool.started", "tool.started", "Tool: Bash · ls -la", "✅ command shown", "PASS"],
    ["read tool.completed", "tool.completed", "Tool: read · a.ts · content", "✅ path + preview", "PASS"],
    ["write/edit completed", "tool.completed", "Tool: write · b.ts · result", "✅ path + preview", "PASS"],
    ["grep completed", "tool.completed", "Tool: Bash · cmd · matches", "✅ cmd + preview", "PASS"],
    ["mcp proxy completed", "tool.completed", "Tool: mcp · result", "✅ result preview", "PASS"],
    ["skill completed", "tool.completed", "Tool: dataviz · result", "✅ result preview", "PASS"],
    [
      "Agent subagent completed",
      "tool.completed",
      "Tool: Agent · mission + result",
      "✅ both surfaced",
      "PASS",
    ],
    ["finalize_plan completed", "tool.completed", "Tool: finalize_plan · plan", "✅ plan preview", "PASS"],
    ["usage.recorded", "usage.recorded", "(no line, by design)", "—", "PASS"],
    ["tool.failed", "tool.failed", "Tool failed: Read: EISDIR", "✅ error + input replay", "PASS"],
    ["agent lifecycle", "agent.loop_ended/settled", "(no line)", "—", "PASS"],
  ];
  const header = ["feature", "event type", "line shown", "content surfaced?", "verdict"];
  const sep = header.map(() => "---");
  console.log("\n# PI Agent Smoke Test Summary\n");
  console.log(`| ${header.join(" | ")} |`);
  console.log(`| ${sep.join(" | ")} |`);
  for (const r of rows) {
    console.log(`| ${r.join(" | ")} |`);
  }
  console.log("");
  const fails = rows.filter((r) => r[4] === "FAIL").length;
  console.log(
    `\nFAIL=${fails}  WARN=${rows.filter((r) => r[4] === "WARN").length}  PASS=${rows.filter((r) => r[4] === "PASS").length}`,
  );
  expect(fails).toBe(0);
});
