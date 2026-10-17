import { expect, test } from "bun:test";
import {
  isConversationV2ProjectionRefreshEffect,
  shouldRefreshConversationV2ProjectionExtras,
  TOOL_WRITING_REFRESH_LIVE_TYPES,
} from "../src/renderer/projection-extras-refresh";

const ready = {
  hasThreadState: true,
  hasProjectionApi: true,
  inFlight: false,
  now: 1_000,
  nextAllowed: 2_000,
};

test("native thinking boundaries force projection refresh while token appends stay throttled", () => {
  expect(isConversationV2ProjectionRefreshEffect({ type: "noop", reason: "runtime.thinking.changed" })).toBe(true);
  expect(isConversationV2ProjectionRefreshEffect({ type: "noop", reason: "runtime.tool_writing.changed" })).toBe(true);
  expect(isConversationV2ProjectionRefreshEffect({ type: "noop", reason: "runtime.input" })).toBe(false);
  expect(isConversationV2ProjectionRefreshEffect({
    type: "message.append", messageId: "thought", baseContentVersion: 0,
    nextContentVersion: 1, delta: "继续分析", versionSeq: 3,
  })).toBe(false);
});

test("the extras fetch stays throttled for the facts that ride the event stream", () => {
  expect(shouldRefreshConversationV2ProjectionExtras(ready)).toBe(false);
  expect(shouldRefreshConversationV2ProjectionExtras({ ...ready, now: 2_000 })).toBe(true);
});

test("a fact that has no event to ride can force the fetch past the throttle", () => {
  // Measured failure this guards: a 15.8s tool write whose own trigger landed 20ms after the
  // previous fetch, was swallowed by the one-second throttle, and left the Feed showing a still
  // timeline for the entire write — because nothing else is emitted while arguments stream.
  expect(shouldRefreshConversationV2ProjectionExtras({ ...ready, force: true })).toBe(true);
  expect(
    shouldRefreshConversationV2ProjectionExtras({ ...ready, now: 1_001, nextAllowed: 1_999, force: true }),
  ).toBe(true);
});

test("a forced fetch still waits for an in-flight one and needs a thread to fetch", () => {
  expect(shouldRefreshConversationV2ProjectionExtras({ ...ready, force: true, inFlight: true })).toBe(false);
  expect(shouldRefreshConversationV2ProjectionExtras({ ...ready, force: true, hasThreadState: false })).toBe(
    false,
  );
  expect(
    shouldRefreshConversationV2ProjectionExtras({ ...ready, force: true, hasProjectionApi: false }),
  ).toBe(false);
});

test("the tool-writing fact and everything that ends it force a fetch", () => {
  // If `tool.writing` drops out of this set the feature dies silently: the write window emits
  // nothing else, so the throttled path never sees the fact at all.
  for (const type of ["tool.writing", "tool.writing.completed", "tool.started", "tool.completed", "tool.failed"]) {
    expect(TOOL_WRITING_REFRESH_LIVE_TYPES.has(type)).toBe(true);
  }
  for (const type of [
    "thread.completed",
    "thread.failed",
    "thread.cancelled",
    "thread.idle",
    "thread.blocked",
    "thread.execution_failed",
  ]) {
    expect(TOOL_WRITING_REFRESH_LIVE_TYPES.has(type)).toBe(true);
  }
  // Streaming deltas keep riding the throttle: they arrive continuously, so forcing each one
  // would turn the Feed's per-token traffic into per-token IPC reads.
  expect(TOOL_WRITING_REFRESH_LIVE_TYPES.has("message.delta")).toBe(false);
  expect(TOOL_WRITING_REFRESH_LIVE_TYPES.has("thinking.delta")).toBe(false);
});
