import { expect, test } from "bun:test";
import { CodexEventAdapter, type CodexTurnTokenUsageBreakdown } from "@eco/runtime";
import { CodexAccountUsageTracker } from "../src/main/codex-account-usage-tracker";

function tokens(input = 100, output = 20, cached = 30): CodexTurnTokenUsageBreakdown {
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    reasoningOutputTokens: 10,
    totalTokens: input + output,
  };
}
test("freezes account ownership and counts normalized usage only once", () => {
  const tracker = new CodexAccountUsageTracker();
  tracker.start("thread", "turn", { accountId: "a", modelId: "m" });
  tracker.start("thread", "turn", { accountId: "b", modelId: "other" });
  const snapshot = { last: tokens(), total: tokens() };
  const first = tracker.observe("thread", "turn", snapshot, 100)!;
  expect(first.record).toMatchObject({
    accountId: "a",
    modelId: "m",
    inputTokens: 70,
    outputTokens: 20,
    cacheReadTokens: 30,
    reasoningTokens: 10,
  });
  expect(first.aggregate).toBe(false);
  expect(tracker.observe("thread", "turn", snapshot, 101)).toBeUndefined();
  tracker.finish("thread", "turn");
  expect(
    tracker.observe("thread", "turn", { last: tokens(), total: tokens(200, 40, 60) }, 102),
  ).toBeUndefined();
});
test("resume history seeds the baseline, multiple responses and compacted totals remain distinct", () => {
  const tracker = new CodexAccountUsageTracker();
  tracker.observe("thread", "old", { last: tokens(), total: tokens(1000, 200, 300) }, 0);
  tracker.start("thread", "new", { accountId: "b", modelId: "m" });
  const first = tracker.observe("thread", "new", { last: tokens(), total: tokens(1100, 220, 330) }, 100)!;
  expect(first.record.inputTokens).toBe(70);
  const second = tracker.observe("thread", "new", { last: tokens(), total: tokens(1300, 260, 390) }, 101)!;
  expect(second.record.inputTokens).toBe(140);
  expect(second.aggregate).toBe(true);
  const reset = tracker.observe("thread", "new", { last: tokens(), total: tokens() }, 102)!;
  const again = tracker.observe("thread", "new", { last: tokens(), total: tokens(1100, 220, 330) }, 103)!;
  expect(new Set([first, second, reset, again].map((row) => row.record.eventId)).size).toBe(4);
  tracker.clearThread("thread");
  expect(tracker.observe("thread", "new", { last: tokens(), total: tokens() }, 104)).toBeUndefined();
});
test("real adapter observes main and child usage before terminal cleanup, including failed turns", () => {
  const tracker = new CodexAccountUsageTracker();
  const records: unknown[] = [];
  let active = "a";
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: (id) => id,
    recordThreadRunEvent: () => {},
    onTurnStarted: ({ codexThreadId, turnId }) =>
      tracker.start(codexThreadId, turnId, { accountId: active, modelId: "m" }),
    onAccountTokenUsage: ({ codexThreadId, turnId, usage }) => {
      const result = tracker.observe(codexThreadId, turnId, usage, 100);
      if (result) records.push(result.record);
    },
    onTurnFinished: ({ codexThreadId, turnId }) => tracker.finish(codexThreadId, turnId),
    onThreadRouteCleanup: (id) => tracker.clearThread(id),
  });
  adapter.dispatch("turn/started", { threadId: "root", turn: { id: "turn" } });
  active = "b";
  adapter.dispatch("turn/started", { threadId: "child", turn: { id: "child-turn" } });
  for (const [threadId, turnId] of [
    ["root", "turn"],
    ["child", "child-turn"],
  ]) {
    adapter.dispatch("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: { last: tokens(), total: tokens() },
    });
    adapter.dispatch("turn/completed", {
      threadId,
      turn: { id: turnId, status: "failed", error: { message: "quota" } },
    });
    adapter.dispatch("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: { last: tokens(), total: tokens(200, 40, 60) },
    });
  }
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ accountId: "a" });
  expect(records[1]).toMatchObject({ accountId: "b" });
});
