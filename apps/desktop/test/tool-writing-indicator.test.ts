import { expect, test } from "bun:test";
import { resolveToolWritingIndicator, resolveToolWritingLabel } from "../src/renderer/tool-writing-indicator";
import type {
  ThreadRunProjectionRequestSpan,
  ToolWritingActivity,
} from "../src/shared/conversation-v2-projection";

function span(
  input: Partial<ThreadRunProjectionRequestSpan> & { requestId: string },
): ThreadRunProjectionRequestSpan {
  return {
    requestId: input.requestId,
    status: input.status ?? "streaming",
    startedAt: input.startedAt ?? "2026-01-01T00:00:01.000Z",
    ...(input.endedAt && { endedAt: input.endedAt }),
    ...(input.ownerAgentId && { ownerAgentId: input.ownerAgentId }),
    ...(input.writingTool && { writingTool: input.writingTool }),
  };
}

function writing(input: ToolWritingActivity, since = "2026-01-01T00:00:03.000Z") {
  return { ...input, since };
}

test("resolveToolWritingIndicator carries what the fact knows about the call", () => {
  expect(
    resolveToolWritingIndicator([
      span({
        requestId: "req_1",
        writingTool: writing({ name: "Write", kind: "file", target: "/tmp/eco.md" }),
      }),
    ]),
  ).toEqual({
    requestId: "req_1",
    name: "Write",
    kind: "file",
    target: "/tmp/eco.md",
    since: "2026-01-01T00:00:03.000Z",
  });
});

test("resolveToolWritingIndicator keeps a write on a span the narrative already closed", () => {
  // The text block finalizes before the tool call it precedes, so the span is `completed`
  // while the call is still being written. That is the normal case, not a stale one.
  expect(
    resolveToolWritingIndicator([
      span({
        requestId: "req_1",
        status: "completed",
        endedAt: "2026-01-01T00:00:03.000Z",
        writingTool: writing({ name: "Write", kind: "file" }),
      }),
    ]),
  ).toMatchObject({ name: "Write", kind: "file" });
});

test("resolveToolWritingIndicator prefers the newest write", () => {
  expect(
    resolveToolWritingIndicator([
      span({
        requestId: "req_1",
        writingTool: writing({ name: "Write", kind: "file" }, "2026-01-01T00:00:03.000Z"),
      }),
      span({
        requestId: "req_2",
        status: "waiting_first_token",
        writingTool: writing({ name: "Bash", kind: "command" }, "2026-01-01T00:00:09.000Z"),
      }),
    ]),
  ).toMatchObject({ requestId: "req_2", name: "Bash" });
});

test("the main Feed ignores subagent writes even when they are newer", () => {
  const child = span({
    requestId: "req_child",
    ownerAgentId: "coder_a",
    writingTool: writing({ name: "Write", kind: "file", target: "child.ts" }, "2026-01-01T00:00:09.000Z"),
  });
  expect(resolveToolWritingIndicator([child])).toBeUndefined();
  expect(resolveToolWritingIndicator([child], "coder_a")).toMatchObject({ requestId: "req_child" });
  expect(resolveToolWritingIndicator([child], "coder_b")).toBeUndefined();
  expect(
    resolveToolWritingIndicator([
      span({
        requestId: "req_main",
        writingTool: writing({ name: "Read", kind: "read", target: "main.ts" }),
      }),
      child,
    ]),
  ).toMatchObject({ requestId: "req_main", target: "main.ts" });
});

test("a fact about a call the producers could not name is still a fact", () => {
  // Codex's provider-side items (a web search) carry no tool name, but the write is real.
  expect(
    resolveToolWritingIndicator([span({ requestId: "req_1", writingTool: writing({ kind: "tool" }) })]),
  ).toMatchObject({ requestId: "req_1", kind: "tool" });
  expect(resolveToolWritingIndicator([span({ requestId: "req_1" })])).toBeUndefined();
  expect(resolveToolWritingIndicator([])).toBeUndefined();
});

test("the label says the file when the file is known", () => {
  expect(
    resolveToolWritingLabel({
      requestId: "r",
      since: "s",
      name: "Write",
      kind: "file",
      target: "/tmp/eco.md",
    }),
  ).toEqual({ key: "activity.writingFileTarget", params: { target: "/tmp/eco.md" } });
  expect(resolveToolWritingLabel({ requestId: "r", since: "s", name: "Edit", kind: "file" })).toEqual({
    key: "activity.writingFile",
    params: {},
  });
});

test("the label says the command when the command is known", () => {
  expect(
    resolveToolWritingLabel({
      requestId: "r",
      since: "s",
      name: "Bash",
      kind: "command",
      target: "wc -l /tmp/eco.md",
    }),
  ).toEqual({ key: "activity.writingCommandTarget", params: { target: "wc -l /tmp/eco.md" } });
  expect(resolveToolWritingLabel({ requestId: "r", since: "s", name: "Bash", kind: "command" })).toEqual({
    key: "activity.writingCommand",
    params: {},
  });
});

test("a read says what it reads, and a call we cannot place is a build in progress", () => {
  expect(
    resolveToolWritingLabel({
      requestId: "r",
      since: "s",
      name: "Read",
      kind: "read",
      target: "/tmp/eco.md",
    }),
  ).toEqual({ key: "activity.writingReadTarget", params: { target: "/tmp/eco.md" } });
  expect(
    resolveToolWritingLabel({ requestId: "r", since: "s", name: "mcp__eco_mcp__search_tools", kind: "tool" }),
  ).toEqual({ key: "activity.writingTool", params: { tool: "mcp__eco_mcp__search_tools" } });
  // Nothing to name: the stream said only that a call is being written.
  expect(resolveToolWritingLabel({ requestId: "r", since: "s", kind: "tool" })).toEqual({
    key: "activity.writingUnknown",
    params: {},
  });
});

test("a legacy fact that carried only a tool name still labels", () => {
  // Rows written before the fact was refined hold the tool name and nothing else.
  expect(resolveToolWritingLabel({ requestId: "r", since: "s", name: "Write" })).toEqual({
    key: "activity.writingTool",
    params: { tool: "Write" },
  });
});

test("a target too long for one line is cut, not wrapped", () => {
  const long = `/tmp/${"x".repeat(200)}.md`;
  const label = resolveToolWritingLabel({
    requestId: "r",
    since: "s",
    name: "Write",
    kind: "file",
    target: long,
  });
  expect(label.params.target?.length).toBe(64);
  expect(label.params.target?.endsWith("…")).toBe(true);
});
