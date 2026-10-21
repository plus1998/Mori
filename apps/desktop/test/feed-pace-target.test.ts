import { expect, test } from "bun:test";
import { resolveFeedPaceTargetKey } from "../src/renderer/feed-pace-target";
import type { ThreadRunProjectionMainFeedEntry } from "../src/renderer/conversation-v2-projection-view";
import type { ThreadRunTurnFeedSection } from "../src/renderer/conversation-v2-turn-feed";
import type { ThreadRunProjectionAttempt, ThreadRunProjectionTimelineItem } from "../src/shared/ipc";

function item(
  id: string,
  text: string,
  input: Partial<ThreadRunProjectionTimelineItem> = {},
): ThreadRunProjectionTimelineItem {
  return {
    id,
    sequence: input.sequence ?? 1,
    eventType: input.eventType ?? "message.final",
    scope: input.scope ?? "main",
    role: input.role ?? "main",
    text,
    at: input.at ?? "2026-01-01T00:00:02.000Z",
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.metadata && { metadata: input.metadata }),
  };
}

function entry(value: ThreadRunProjectionTimelineItem): ThreadRunProjectionMainFeedEntry {
  return {
    kind: "timeline",
    key: `main:${value.id}`,
    item: value,
    at: value.at,
    sequence: value.sequence,
  };
}

function attempt(status: ThreadRunProjectionAttempt["status"]): ThreadRunProjectionAttempt {
  return {
    attemptId: "attempt-1",
    phase: "execution",
    retryIndex: 0,
    status,
    startedAt: "2026-01-01T00:00:01.000Z",
    ...(status !== "running" ? { endedAt: "2026-01-01T00:00:08.000Z" } : {}),
  };
}

function turnSection(
  processEntries: ThreadRunProjectionMainFeedEntry[],
  finalEntry?: ThreadRunProjectionMainFeedEntry,
): ThreadRunTurnFeedSection {
  return {
    kind: "turn",
    key: "turn:attempt-1",
    attempt: attempt("running"),
    running: true,
    processEntries,
    ...(finalEntry && { finalEntry }),
  };
}

test("resolveFeedPaceTargetKey follows the only streaming thinking entry", () => {
  const sections: ThreadRunTurnFeedSection[] = [
    turnSection([
      entry(
        item("think", "正在分析。", {
          eventType: "thinking.delta",
          runAttemptId: "attempt-1",
        }),
      ),
    ]),
  ];
  expect(resolveFeedPaceTargetKey(sections)).toBe("main:think");
});

test("resolveFeedPaceTargetKey switches to later streaming narrative", () => {
  const sections: ThreadRunTurnFeedSection[] = [
    turnSection([
      entry(
        item("think", "思考内容。", {
          eventType: "thinking.delta",
          runAttemptId: "attempt-1",
          sequence: 1,
        }),
      ),
      entry(
        item("body", "正文输出。", {
          eventType: "message.delta",
          runAttemptId: "attempt-1",
          sequence: 2,
        }),
      ),
    ]),
  ];
  expect(resolveFeedPaceTargetKey(sections)).toBe("main:body");
});

test("resolveFeedPaceTargetKey ignores empty streaming text", () => {
  const sections: ThreadRunTurnFeedSection[] = [
    turnSection([
      entry(
        item("think", "思考。", {
          eventType: "thinking.delta",
          runAttemptId: "attempt-1",
          sequence: 1,
        }),
      ),
      entry(
        item("body", "   ", {
          eventType: "message.delta",
          runAttemptId: "attempt-1",
          sequence: 2,
        }),
      ),
    ]),
  ];
  expect(resolveFeedPaceTargetKey(sections)).toBe("main:think");
});

test("resolveFeedPaceTargetKey prefers finalEntry over earlier process thinking", () => {
  const sections: ThreadRunTurnFeedSection[] = [
    turnSection(
      [
        entry(
          item("think", "仍在思考。", {
            eventType: "thinking.delta",
            runAttemptId: "attempt-1",
            sequence: 1,
          }),
        ),
      ],
      entry(
        item("final", "最终正文。", {
          eventType: "message.delta",
          runAttemptId: "attempt-1",
          sequence: 2,
          at: "2026-01-01T00:00:07.000Z",
        }),
      ),
    ),
  ];
  expect(resolveFeedPaceTargetKey(sections)).toBe("main:final");
});

test("resolveFeedPaceTargetKey returns null when nothing is streaming", () => {
  const sections: ThreadRunTurnFeedSection[] = [
    turnSection([
      entry(
        item("think", "已结束。", {
          eventType: "thinking.final",
          runAttemptId: "attempt-1",
        }),
      ),
      entry(
        item("body", "定稿正文。", {
          eventType: "message.final",
          runAttemptId: "attempt-1",
          sequence: 2,
        }),
      ),
    ]),
  ];
  expect(resolveFeedPaceTargetKey(sections)).toBeNull();
});
