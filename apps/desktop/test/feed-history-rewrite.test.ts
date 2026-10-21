import { expect, test } from "bun:test";
import {
  cutThreadRunProjectionForUserMessageRewrite,
  findRewriteTargetTimelineItem,
} from "../src/renderer/feed-history-rewrite";
import type { ThreadRunProjectionSnapshot, ThreadRunProjectionTimelineItem } from "../src/shared/ipc";

function timelineItem(
  overrides: Partial<ThreadRunProjectionTimelineItem> &
    Pick<ThreadRunProjectionTimelineItem, "id" | "sequence" | "text">,
): ThreadRunProjectionTimelineItem {
  return {
    eventType: "thread.status",
    scope: "main",
    role: "user",
    at: `2026-01-01T00:00:0${overrides.sequence}.000Z`,
    metadata: { liveType: "thread.user_prompt" },
    ...overrides,
  };
}

function makeProjection(timeline: ThreadRunProjectionTimelineItem[]): ThreadRunProjectionSnapshot {
  return {
    generatedAt: "2026-01-01T00:00:10.000Z",
    historyRevision: 0,
    sourceEventCount: timeline.length,
    thread: {
      threadId: "thr_1",
      status: "idle",
      generatedAt: "2026-01-01T00:00:10.000Z",
      message: "",
    },
    timeline,
    agents: [
      {
        agentId: "agent_late",
        role: "explore",
        kind: "subagent",
        status: "completed",
        startedAt: "2026-01-01T00:00:05.000Z",
        timeline: [
          {
            id: "agent_evt",
            sequence: 5,
            eventType: "message.final",
            scope: "subagent",
            text: "late",
            at: "2026-01-01T00:00:06.000Z",
          },
        ],
      },
    ],
    attempts: [
      {
        attemptId: "attempt_keep",
        phase: "execution",
        retryIndex: 0,
        status: "completed",
        startedAt: "2026-01-01T00:00:01.500Z",
        endedAt: "2026-01-01T00:00:02.500Z",
      },
      {
        attemptId: "attempt_drop",
        phase: "execution",
        retryIndex: 0,
        status: "completed",
        startedAt: "2026-01-01T00:00:04.000Z",
        endedAt: "2026-01-01T00:00:09.000Z",
      },
    ],
    requestSpans: [],
    diagnostics: [],
  };
}

test("findRewriteTargetTimelineItem matches sdk stream keys and bare user message ids", () => {
  const timeline = [
    timelineItem({ id: "p1", sequence: 1, text: "hi", streamKey: "sdk:user-1" }),
    timelineItem({
      id: "p2",
      sequence: 3,
      text: "second",
      streamKey: "sdk:user-2",
      metadata: {
        liveType: "thread.user_prompt",
        rewindTarget: { activityLineId: "sdk:user-2", userMessageId: "user-2" },
      },
    }),
  ];
  expect(findRewriteTargetTimelineItem(timeline, "sdk:user-2", "user-2")?.id).toBe("p2");
  expect(findRewriteTargetTimelineItem(timeline, "sdk:user-2")?.id).toBe("p2");
});

test("cutThreadRunProjectionForUserMessageRewrite drops target and later content instantly", () => {
  const before = makeProjection([
    timelineItem({ id: "p1", sequence: 1, text: "hi", streamKey: "sdk:user-1" }),
    timelineItem({
      id: "r1",
      sequence: 2,
      text: "reply",
      role: "main",
      eventType: "message.final",
      metadata: {},
    }),
    timelineItem({
      id: "p2",
      sequence: 3,
      text: "old second",
      streamKey: "sdk:user-2",
      metadata: {
        liveType: "thread.user_prompt",
        rewindTarget: { activityLineId: "sdk:user-2", userMessageId: "user-2" },
      },
    }),
    timelineItem({
      id: "r2",
      sequence: 4,
      text: "late reply",
      role: "main",
      eventType: "message.final",
      metadata: {},
    }),
  ]);

  const cut = cutThreadRunProjectionForUserMessageRewrite(before, {
    activityLineId: "sdk:user-2",
    userMessageId: "user-2",
    nextPrompt: "rewritten",
    historyRevision: 1,
    generatedAt: "2026-01-01T00:00:20.000Z",
  });

  expect(cut.historyRevision).toBe(1);
  expect(cut.timeline.map((item) => item.text)).toEqual(["hi", "reply", "rewritten"]);
  expect(cut.timeline.at(-1)?.id).toBe("p2");
  expect(cut.timeline.at(-1)?.metadata?.rewritePending).toBe(true);
  expect(cut.attempts.map((attempt) => attempt.attemptId)).toEqual(["attempt_keep"]);
  expect(cut.agents).toEqual([]);
  expect(cut.thread.status).toBe("running");
});
