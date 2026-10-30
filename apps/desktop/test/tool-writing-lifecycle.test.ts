import { expect, test } from "bun:test";
import { buildThreadRunProjectionRequestSpans } from "../src/main/conversation-v2-runtime-projection";
import { buildThreadRunEventFromLiveEvent } from "../src/main/thread-run-event-normalizer";
import type { ThreadRunEvent } from "../src/shared/thread-run-events";

function event(
  sequence: number,
  input: Partial<ThreadRunEvent> & Pick<ThreadRunEvent, "eventType">,
): ThreadRunEvent {
  return {
    id: `event_${sequence}`,
    threadId: "thread",
    sequence,
    scope: "main",
    streamState: "none",
    message: "",
    observedAt: `2026-10-17T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...input,
  };
}

const start = event(1, { eventType: "request.started", requestId: "request", runAttemptId: "run" });
const writing = event(2, {
  eventType: "tool.writing",
  runAttemptId: "run",
  message: "request_user_input",
  metadata: { toolWriting: { name: "request_user_input" } },
});
const project = (events: ThreadRunEvent[]) =>
  buildThreadRunProjectionRequestSpans({ events, threadStatus: "running" });

test("clarification starts and answers close tool writing without a tool source row", () => {
  for (const [liveType, status] of [
    ["clarification.requested", "started"],
    ["clarification.answered", "completed"],
  ]) {
    const interaction = event(3, {
      eventType: "message.final",
      runAttemptId: "run",
      metadata: { liveType, tool: { name: "AskUserQuestion", status, toolUseId: "question" } },
    });
    expect(project([start, writing])[0]?.writingTool).toBeDefined();
    expect(project([start, writing, interaction])[0]?.writingTool).toBeUndefined();
  }
});

test("a new request cannot revive a completed request's tool writing", () => {
  const completed = event(3, { eventType: "request.completed", requestId: "request" });
  const next = event(4, {
    eventType: "request.started",
    requestId: "next-request",
    runAttemptId: "next-run",
  });
  expect(project([start, writing, completed, next]).some((span) => span.writingTool)).toBe(false);
  expect(
    project([
      start,
      completed,
      next,
      { ...writing, sequence: 5, observedAt: "2026-10-17T00:00:05.000Z" },
    ]).some((span) => span.writingTool),
  ).toBe(false);
});

test("request completion closes an earlier write while a later write remains eligible", () => {
  const completed = event(3, { eventType: "request.completed", requestId: "request" });
  expect(project([start, writing, completed])[0]?.writingTool).toBeUndefined();
  expect(
    project([start, completed, { ...writing, sequence: 4, observedAt: "2026-10-17T00:00:04.000Z" }])[0]
      ?.writingTool,
  ).toBeDefined();
});

test("nonempty thinking closes writing after the provider index replaces its placeholder", () => {
  const thinking = event(4, {
    eventType: "thinking.delta",
    requestId: "request",
    streamState: "streaming",
    message: "继续执行后续步骤",
    metadata: { thinkingStartedAt: "2026-10-17T00:00:03.000Z" },
  });
  expect(project([start, writing, thinking])[0]?.writingTool).toBeUndefined();
  expect(
    project([start, writing, { ...thinking, metadata: { thinkingStartedAt: "2026-10-17T00:00:01.500Z" } }])[0]
      ?.writingTool,
  ).toBeDefined();
});

test("an older request's tool result cannot clear the current call being written", () => {
  const next = event(3, { eventType: "request.started", requestId: "next-request" });
  const nextWriting = event(4, {
    eventType: "tool.writing",
    requestId: "next-request",
    message: "Edit",
  });
  const oldResult = event(5, { eventType: "tool.completed", requestId: "request" });
  expect(project([start, writing, next, nextWriting, oldResult])[1]?.writingTool?.name).toBe("Edit");
});

test("writing completion preserves call identity through dispatch until the matching tool starts", () => {
  const completed = buildThreadRunEventFromLiveEvent({
    threadId: "thread",
    eventId: "ready",
    liveType: "tool.writing.completed",
    message: "Plan",
    role: "tool",
    stream: false,
    observedAt: "2026-10-17T00:00:03.000Z",
    requestId: "request",
    streamKey: "call",
    metadata: { toolCallId: "call" },
  });
  expect(completed?.eventType).toBe("tool.writing.completed");
  if (!completed) throw new Error("Missing writing completion.");
  const named = { ...writing, requestId: "request", streamKey: "call" };
  expect(project([start, named, { ...completed, sequence: 3 }])[0]?.writingTool?.phase).toBe("dispatching");
  const dispatched = event(4, {
    eventType: "tool.started",
    requestId: "request",
    streamKey: "call",
    metadata: { toolCallId: "call" },
  });
  expect(project([start, named, { ...completed, sequence: 3 }, dispatched])[0]?.writingTool).toBeUndefined();
  expect(
    project([
      start,
      named,
      { ...completed, sequence: 3 },
      {
        ...dispatched,
        streamKey: "other-call",
        metadata: { toolCallId: "other-call" },
      },
    ])[0]?.writingTool?.phase,
  ).toBe("dispatching");
  expect(
    project([
      start,
      named,
      { ...completed, sequence: 3, streamKey: "other-call", metadata: { toolCallId: "other-call" } },
    ])[0]?.writingTool,
  ).toMatchObject({ name: "request_user_input", since: named.observedAt });
});
