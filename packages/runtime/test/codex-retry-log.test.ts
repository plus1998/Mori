import { expect, test } from "bun:test";
import {
  CodexRetryLogDecoder,
  type CodexRetryLogNotice,
  CodexRetryLogObserver,
  parseCodexRetryLog,
} from "../src/codex-retry-log";

function entry() {
  return {
    timestamp: "2026-11-12T06:18:17.194476Z",
    level: "WARN",
    target: "codex_core::responses_retry",
    fields: {
      message: "stream disconnected - retrying sampling request (1/5 in 314.998382375s)...",
      turn_id: "turn-a",
      retries: 1,
      max_retries: 5,
      sampling_error: "Selected model is at capacity. Please try a different model.",
    },
    spans: [
      { name: "session_loop", thread_id: "thread-a" },
      { name: "turn", "thread.id": "thread-a" },
    ],
  };
}

test("first-retry logs retain exact attribution and the upstream wait", () => {
  expect(parseCodexRetryLog(JSON.stringify(entry()))).toEqual({
    threadId: "thread-a",
    turnId: "turn-a",
    attempt: 1,
    maxRetries: 5,
    delayMs: 314998.382375,
    error: "Selected model is at capacity. Please try a different model.",
  });
});

test("ambiguous, malformed and non-first-retry logs never create a notice", () => {
  const original = entry();
  for (const value of [
    { ...original, spans: [...original.spans, { thread_id: "another-thread" }] },
    { ...original, target: "another::target" },
    { ...original, fields: { ...original.fields, retries: 2 } },
    { ...original, fields: { ...original.fields, turn_id: "" } },
    { ...original, fields: { ...original.fields, max_retries: 6 } },
    { ...original, fields: { ...original.fields, message: "stream failed" } },
  ])
    expect(parseCodexRetryLog(JSON.stringify(value))).toBeUndefined();
  expect(parseCodexRetryLog("not json")).toBeUndefined();
});

test("release logs without spans bind only to a matching native turn from the same process", () => {
  const notices: CodexRetryLogNotice[] = [];
  const observer = new CodexRetryLogObserver((notice) => notices.push(notice));
  const anotherProcess = new CodexRetryLogObserver((notice) => notices.push(notice));
  const log = `${JSON.stringify({ ...entry(), spans: undefined })}\n`;
  expect(parseCodexRetryLog(log)?.threadId).toBeUndefined();
  observer.push(log);
  anotherProcess.observeNotification("turn/started", { threadId: "wrong-process", turn: { id: "turn-a" } });
  expect(notices).toEqual([]);
  observer.observeNotification("turn/started", { threadId: "thread-a", turn: { id: "turn-a" } });
  expect(notices).toHaveLength(1);
  expect(notices[0]?.threadId).toBe("thread-a");
  observer.observeNotification("turn/completed", { threadId: "thread-a", turn: { id: "turn-a" } });
  observer.push(log);
  observer.observeNotification("turn/started", { threadId: "thread-b", turn: { id: "turn-b" } });
  observer.push(`${JSON.stringify(entry())}\n`);
  expect(notices).toHaveLength(1);
});

test("structured thread attribution cannot override a native turn's owner", () => {
  const notices: CodexRetryLogNotice[] = [];
  const observer = new CodexRetryLogObserver((notice) => notices.push(notice));
  observer.observeNotification("turn/started", { threadId: "different-thread", turn: { id: "turn-a" } });
  observer.push(`${JSON.stringify(entry())}\n`);
  expect(notices).toEqual([]);
});

test("stderr decoding handles fragmented, batched and oversized lines without mixing threads", () => {
  const decoder = new CodexRetryLogDecoder();
  const first = JSON.stringify(entry());
  const other = entry();
  other.fields.turn_id = "turn-b";
  other.spans = [{ name: "session_loop", thread_id: "thread-b" }];
  expect(decoder.push(`${"x".repeat(130 * 1024)}`)).toEqual([]);
  expect(decoder.push(`discarded\nnot-json\n${first.slice(0, 80)}`)).toEqual([]);
  const notices = decoder.push(`${first.slice(80)}\n${JSON.stringify(other)}\n`);
  expect(notices.map(({ threadId, turnId }) => ({ threadId, turnId }))).toEqual([
    { threadId: "thread-a", turnId: "turn-a" },
    { threadId: "thread-b", turnId: "turn-b" },
  ]);
});

test("Rust duration units are converted without inventing a wait for unsupported formats", () => {
  for (const [duration, delayMs] of [
    ["200ms", 200],
    ["500µs", 0.5],
    ["30ns", 0.00003],
    ["0s", 0],
  ] as const) {
    const value = entry();
    value.fields.message = `stream disconnected - retrying sampling request (1/5 in ${duration})...`;
    expect(parseCodexRetryLog(JSON.stringify(value))?.delayMs).toBeCloseTo(delayMs, 6);
  }
});
