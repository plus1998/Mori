import { describe, expect, test } from "vitest";
import {
  buildThreadRunProjection,
  eventToTimelineItem,
} from "../src/main/conversation-v2-runtime-projection";
import { trimProjectionForFeed } from "../src/main/legacy-feed-replay-projection";
import type { FeedSkeletonPatchContext } from "../src/main/legacy-feed-skeleton-patch";
import {
  createFeedSkeletonPatchState,
  createThreadFeedSkeletonRecord,
  feedSkeletonTimelineIds,
  hasFeedSkeletonAttemptBecameTerminal,
  patchThreadFeedSkeletonFromEvent,
  shouldPatchAgentTimelineForFeedSkeleton,
} from "../src/main/legacy-feed-skeleton-patch";
import {
  FEED_SKELETON_RULES_VERSION,
  isThreadFeedSkeletonFresh,
  type ThreadFeedSkeletonRecord,
} from "../src/main/legacy-feed-skeleton-store";
import { isFeedMainTimelineEvent } from "../src/main/legacy-feed-skeleton-timeline-items";
import type { RunAttemptRecord } from "../src/main/usage-ledger";
import type {
  ThreadRunProjectionAgent,
  ThreadRunProjectionAttempt,
  ThreadRunProjectionTimelineItem,
} from "../src/shared/conversation-v2-projection";
import { selectSkeletonTimelineItems } from "../src/shared/conversation-v2-projection-skeleton";
import type { ThreadRunEvent } from "../src/shared/ipc";
import { isThreadFollowUpActivityMessage } from "../src/shared/thread-follow-up-events";
import {
  attemptsAtSequence,
  CORPUS_ATTEMPT_ID,
  CORPUS_THREAD_ID,
  type CorpusStream,
  collapseStreamDeltas,
  corpusAgentInstance,
  corpusProjectionAgent,
  eventFromShape,
  generateStream,
  isPersistableShape,
  loadObservedShapeFile,
  type ObservedEventShape,
  rebuildFeedTimeline,
  timelineSignature,
} from "./helpers/feed-parity-corpus";

const THREAD_ID = "thr_patch";
const STARTED_AT = "2026-01-01T00:00:00.000Z";

function runEvent(
  overrides: Partial<ThreadRunEvent> & Pick<ThreadRunEvent, "id" | "sequence" | "eventType" | "message">,
): ThreadRunEvent {
  return {
    threadId: THREAD_ID,
    scope: "main",
    streamState: "finalized",
    observedAt: `2026-01-01T00:00:${String(overrides.sequence).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

function attemptRecord(
  attemptId: string,
  status: RunAttemptRecord["status"],
  startedAt = STARTED_AT,
): RunAttemptRecord {
  return {
    attemptId,
    threadId: THREAD_ID,
    phase: "run",
    retryIndex: 0,
    status,
    startedAt,
    ...(status === "running" ? {} : { endedAt: "2026-01-01T00:10:00.000Z" }),
  };
}

function projectionAttempt(
  attemptId: string,
  status: ThreadRunProjectionAttempt["status"],
  startedAt = STARTED_AT,
): ThreadRunProjectionAttempt {
  return {
    attemptId,
    phase: "run",
    retryIndex: 0,
    status,
    startedAt,
    ...(status === "running" ? {} : { endedAt: "2026-01-01T00:10:00.000Z" }),
  };
}

function mapAttempts(records: readonly RunAttemptRecord[]): ThreadRunProjectionAttempt[] {
  return records.map((record) => projectionAttempt(record.attemptId, record.status, record.startedAt));
}

function emptySnapshot(threadId = THREAD_ID) {
  return {
    thread: {
      threadId,
      status: "running",
      generatedAt: STARTED_AT,
    },
    attempts: [] as ThreadRunProjectionAttempt[],
    agents: [],
    requestSpans: [],
    timeline: [] as ThreadRunProjectionTimelineItem[],
    diagnostics: [],
    sourceEventCount: 0,
    historyRevision: 0,
  };
}

function patchContext(
  attempts: readonly ThreadRunProjectionAttempt[],
  maxEventSequence: number,
  agents: readonly ThreadRunProjectionAgent[] = [],
): FeedSkeletonPatchContext {
  return {
    attempts,
    agents: [...agents],
    historyRevision: 0,
    maxEventSequence,
  };
}

function exploreAgent(status: ThreadRunProjectionAgent["status"] = "active"): ThreadRunProjectionAgent {
  return {
    agentId: "explore_a",
    role: "explore",
    kind: "subagent",
    status,
    startedAt: STARTED_AT,
    durationMs: 0,
    timeline: [],
  };
}

/**
 * The oracle: what a full rebuild produces for the same event prefix. Deltas are collapsed
 * first because that is what `listThreadRunEventsForProjection` returns; everything else is
 * byte-for-byte the production rebuild path.
 */
function referenceFeedTimelineIds(
  events: readonly ThreadRunEvent[],
  attempts: readonly RunAttemptRecord[],
): string[] {
  const projection = buildThreadRunProjection({
    threadId: THREAD_ID,
    status: "running",
    attempts,
    agents: [],
    events: collapseStreamDeltas(events),
    historyComplete: true,
  });
  return trimProjectionForFeed(projection).timeline.map((item) => item.id);
}

function replayPatchRecords(
  events: readonly ThreadRunEvent[],
  attempts: readonly RunAttemptRecord[],
): ThreadFeedSkeletonRecord[] {
  let record = createThreadFeedSkeletonRecord(emptySnapshot(), {
    attempts: mapAttempts(attempts),
    agents: [],
    historyRevision: 0,
    maxEventSequence: 0,
  });
  record.patchState = createFeedSkeletonPatchState(record.snapshot);

  const records: ThreadFeedSkeletonRecord[] = [];
  for (const event of events) {
    const attemptRecords = [...attempts];
    const context = patchContext(mapAttempts(attemptRecords), event.sequence);
    const patched = patchThreadFeedSkeletonFromEvent(record, event, context);
    expect(patched).not.toBeNull();
    record = patched!;
    records.push(record);
  }
  return records;
}

function replayPatchTimelineIds(
  events: readonly ThreadRunEvent[],
  attempts: readonly RunAttemptRecord[],
): string[] {
  const records = replayPatchRecords(events, attempts);
  return feedSkeletonTimelineIds(records[records.length - 1]!.snapshot);
}

describe("thread feed skeleton patch", () => {
  test("matches selectSkeletonTimelineItems for multi-turn completed thread", () => {
    const attempts = [attemptRecord("att_1", "completed")];
    const events = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "message.final",
        message: "第一句",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "tool_1",
        sequence: 2,
        eventType: "tool.completed",
        message: "Tool: Bash",
        runAttemptId: "att_1",
      }),
      runEvent({
        id: "narr_1",
        sequence: 3,
        eventType: "message.final",
        message: "过程旁白",
        role: "coder",
        runAttemptId: "att_1",
      }),
      runEvent({
        id: "final_1",
        sequence: 4,
        eventType: "message.final",
        message: "第一轮最终输出",
        role: "coder",
        runAttemptId: "att_1",
      }),
      runEvent({
        id: "user_2",
        sequence: 5,
        eventType: "message.final",
        message: "要啊，不然我怎么设置呢",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "think_2",
        sequence: 6,
        eventType: "thinking.delta",
        message: "思考中",
        role: "thinking",
        runAttemptId: "att_1",
      }),
      runEvent({
        id: "final_2",
        sequence: 7,
        eventType: "message.final",
        message: "第二轮最终输出",
        role: "coder",
        runAttemptId: "att_1",
      }),
    ];

    const timeline = events.map((event) => eventToTimelineItem(event));
    const selected = selectSkeletonTimelineItems(timeline, mapAttempts(attempts)).map((item) => item.id);
    const patched = replayPatchTimelineIds(events, attempts);
    expect(patched).toEqual(selected);
    expect(patched).toEqual(referenceFeedTimelineIds(events, attempts));
  });

  test("keeps running attempt process items until attempt completes", () => {
    const attempts = [attemptRecord("att_run", "running")];
    const events = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "message.final",
        message: "继续",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "tool_live",
        sequence: 2,
        eventType: "tool.started",
        message: "Tool: Read",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "delta_live",
        sequence: 3,
        eventType: "message.delta",
        message: "正在写",
        role: "coder",
        runAttemptId: "att_run",
        streamKey: "stream_1",
        streamState: "streaming",
      }),
    ];

    const patched = replayPatchTimelineIds(events, attempts);
    expect(patched).toEqual(["user_1", "tool_live", "delta_live"]);

    const completedAttempts = [attemptRecord("att_run", "completed")];
    const finalEvents = [
      ...events,
      runEvent({
        id: "final_run",
        sequence: 4,
        eventType: "message.final",
        message: "写完了",
        role: "coder",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "att_done",
        sequence: 5,
        eventType: "run.attempt.completed",
        message: "Turn completed",
        runAttemptId: "att_run",
      }),
    ];
    const patchedAfterComplete = replayPatchTimelineIds(finalEvents, completedAttempts);
    expect(patchedAfterComplete).toEqual(["user_1", "final_run"]);
    expect(patchedAfterComplete).toEqual(referenceFeedTimelineIds(finalEvents, completedAttempts));
  });

  test("keeps every running-attempt message.final between tools (no mid-turn collapse)", () => {
    const attempts = [attemptRecord("att_run", "running")];
    const events = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "thread.status",
        message: "修一下 Feed 丢正文",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "narr_1",
        sequence: 2,
        eventType: "message.final",
        message: "先改 shared helpers",
        role: "main",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "tool_1",
        sequence: 3,
        eventType: "tool.completed",
        message: "Tool: Edit · helpers.ts",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "narr_2",
        sequence: 4,
        eventType: "message.final",
        message: "再改 main handler",
        role: "main",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "tool_2",
        sequence: 5,
        eventType: "tool.started",
        message: "Tool: Edit · index.ts",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "narr_3",
        sequence: 6,
        eventType: "message.final",
        message: "最后补测试",
        role: "main",
        runAttemptId: "att_run",
      }),
    ];

    const patched = replayPatchTimelineIds(events, attempts);
    expect(patched).toEqual(["user_1", "narr_1", "tool_1", "narr_2", "tool_2", "narr_3"]);
    expect(patched).toEqual(referenceFeedTimelineIds(events, attempts));

    const completedAttempts = [attemptRecord("att_run", "completed")];
    const finalEvents = [
      ...events,
      runEvent({
        id: "att_done",
        sequence: 7,
        eventType: "run.attempt.completed",
        message: "Turn completed",
        runAttemptId: "att_run",
      }),
    ];
    const patchedAfterComplete = replayPatchTimelineIds(finalEvents, completedAttempts);
    expect(patchedAfterComplete).toEqual(["user_1", "narr_3"]);
    expect(patchedAfterComplete).toEqual(referenceFeedTimelineIds(finalEvents, completedAttempts));
  });

  test("running-attempt tool.failed does not wipe earlier message.final bodies", () => {
    const attempts = [attemptRecord("att_run", "running")];
    const events = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "thread.status",
        message: "继续改",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "narr_1",
        sequence: 2,
        eventType: "message.final",
        message: "先写测试",
        role: "main",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "tool_ok",
        sequence: 3,
        eventType: "tool.completed",
        message: "Tool: Edit · ok.ts",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "tool_fail",
        sequence: 4,
        eventType: "tool.failed",
        message: "Tool failed: Edit overlap",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "tool_retry",
        sequence: 5,
        eventType: "tool.started",
        message: "Tool: Edit · retry.ts",
        runAttemptId: "att_run",
      }),
    ];

    const patched = replayPatchTimelineIds(events, attempts);
    expect(patched).toEqual(["user_1", "narr_1", "tool_ok", "tool_fail", "tool_retry"]);
    expect(patched).toEqual(referenceFeedTimelineIds(events, attempts));
  });

  test("completed-attempt tool.failed after message.final keeps the narrative final", () => {
    const attempts = [attemptRecord("att_1", "completed")];
    const events = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "thread.status",
        message: "提问",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "narr_1",
        sequence: 2,
        eventType: "message.final",
        message: "回答正文",
        role: "main",
        runAttemptId: "att_1",
      }),
      runEvent({
        id: "tool_fail",
        sequence: 3,
        eventType: "tool.failed",
        message: "Tool failed: Edit overlap",
        runAttemptId: "att_1",
      }),
    ];

    const patched = replayPatchTimelineIds(events, attempts);
    expect(patched).toEqual(["user_1", "narr_1"]);
    expect(patched).toEqual(referenceFeedTimelineIds(events, attempts));
  });

  test("ignores completed-attempt tool noise but advances sequence watermark", () => {
    const attempts = [attemptRecord("att_1", "completed")];
    const events = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "message.final",
        message: "提问",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "final_1",
        sequence: 2,
        eventType: "message.final",
        message: "回答",
        role: "coder",
        runAttemptId: "att_1",
      }),
      runEvent({
        id: "tool_noise_1",
        sequence: 3,
        eventType: "tool.completed",
        message: "Tool: Bash",
        runAttemptId: "att_1",
      }),
      runEvent({
        id: "tool_noise_2",
        sequence: 4,
        eventType: "tool.completed",
        message: "Tool: Read",
        runAttemptId: "att_1",
      }),
    ];

    // Process rows of a finished attempt are tracked (they are part of the projection)
    // but the selection rule keeps them out of the Feed — see the assertions below.
    expect(isFeedMainTimelineEvent(events[2]!)).toBe(true);
    expect(isFeedMainTimelineEvent(events[3]!)).toBe(true);

    let record = createThreadFeedSkeletonRecord(emptySnapshot(), {
      attempts: mapAttempts(attempts),
      agents: [],
      historyRevision: 0,
      maxEventSequence: 0,
    });
    record.patchState = createFeedSkeletonPatchState(record.snapshot);
    for (const event of events) {
      record = patchThreadFeedSkeletonFromEvent(
        record,
        event,
        patchContext(mapAttempts(attempts), event.sequence),
      )!;
    }
    expect(feedSkeletonTimelineIds(record.snapshot)).toEqual(["user_1", "final_1"]);
    expect(record.maxEventSequence).toBe(4);
  });

  test("matches reference feed projection across a long tool-heavy thread", () => {
    const attempts = [attemptRecord("att_1", "completed")];
    const events: ThreadRunEvent[] = [];
    let sequence = 0;
    const push = (event: Omit<Parameters<typeof runEvent>[0], "sequence">) => {
      sequence += 1;
      events.push(runEvent({ ...event, sequence }));
    };

    push({
      id: "user_open",
      eventType: "message.final",
      message: "开始",
      role: "user",
      metadata: { liveType: "thread.user_prompt" },
    });
    for (let index = 1; index <= 120; index += 1) {
      push({
        id: `tool_${index}`,
        eventType: "tool.completed",
        message: `Tool ${index}`,
        runAttemptId: "att_1",
      });
    }
    push({
      id: "user_mid",
      eventType: "message.final",
      message: "中间提问",
      role: "user",
      metadata: { liveType: "thread.user_prompt" },
    });
    for (let index = 1; index <= 80; index += 1) {
      push({
        id: `tool_mid_${index}`,
        eventType: "tool.completed",
        message: `Mid tool ${index}`,
        runAttemptId: "att_1",
      });
    }
    push({
      id: "final_mid",
      eventType: "message.final",
      message: "中间回答",
      role: "coder",
      runAttemptId: "att_1",
    });
    push({
      id: "user_close",
      eventType: "message.final",
      message: "结束",
      role: "user",
      metadata: { liveType: "thread.user_prompt" },
    });
    push({
      id: "final_close",
      eventType: "message.final",
      message: "最终回答",
      role: "coder",
      runAttemptId: "att_1",
    });

    const patched = replayPatchTimelineIds(events, attempts);
    const reference = referenceFeedTimelineIds(events, attempts);
    expect(patched).toEqual(reference);
    expect(patched.filter((id) => id.startsWith("tool_"))).toEqual([]);
    expect(patched.filter((id) => id.startsWith("user_"))).toEqual(["user_open", "user_mid", "user_close"]);
  });

  test("retains candidate finals when a replayed user boundary arrives after provider rows", () => {
    const attempts = [attemptRecord("att_1", "completed")];
    const events = [
      runEvent({
        id: "final_before_prompt",
        sequence: 1,
        eventType: "message.final",
        message: "第一段结果",
        role: "main",
        runAttemptId: "att_1",
        observedAt: "2026-01-01T00:00:10.000Z",
      }),
      runEvent({
        id: "final_after_prompt",
        sequence: 2,
        eventType: "message.final",
        message: "第二段结果",
        role: "main",
        runAttemptId: "att_1",
        observedAt: "2026-01-01T00:00:20.000Z",
      }),
      runEvent({
        id: "late_user_prompt",
        sequence: 3,
        eventType: "thread.status",
        message: "中途继续",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
        observedAt: "2026-01-01T00:00:15.000Z",
      }),
    ];
    const prefix = events.slice(0, 2);
    const prefixProjection = trimProjectionForFeed(
      buildThreadRunProjection({
        threadId: THREAD_ID,
        status: "running",
        attempts,
        agents: [],
        events: prefix,
        historyComplete: true,
      }),
    );
    let record = createThreadFeedSkeletonRecord(
      prefixProjection,
      patchContext(mapAttempts(attempts), 2),
      prefix,
    );
    record = patchThreadFeedSkeletonFromEvent(
      record,
      events[2]!,
      patchContext(mapAttempts(attempts), events[2]!.sequence),
    )!;

    expect(feedSkeletonTimelineIds(record.snapshot)).toEqual(referenceFeedTimelineIds(events, attempts));
    expect(feedSkeletonTimelineIds(record.snapshot)).toEqual([
      "final_before_prompt",
      "final_after_prompt",
      "late_user_prompt",
    ]);
  });

  test("uses api.error as segment final when no message.final exists", () => {
    const attempts = [attemptRecord("att_1", "failed")];
    const events = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "message.final",
        message: "提问",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "tool_1",
        sequence: 2,
        eventType: "tool.completed",
        message: "Tool: Bash",
        runAttemptId: "att_1",
      }),
      runEvent({
        id: "err_1",
        sequence: 3,
        eventType: "api.error",
        message: "请求失败",
        role: "coder",
        runAttemptId: "att_1",
      }),
    ];

    expect(replayPatchTimelineIds(events, attempts)).toEqual(["user_1", "err_1"]);
    expect(replayPatchTimelineIds(events, attempts)).toEqual(referenceFeedTimelineIds(events, attempts));
  });

  test("updates stream delta text in place for running attempts", () => {
    const attempts = [attemptRecord("att_run", "running")];
    const events = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "message.final",
        message: "写代码",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "delta_1",
        sequence: 2,
        eventType: "message.delta",
        message: "正在",
        role: "coder",
        runAttemptId: "att_run",
        streamKey: "stream_1",
        streamState: "streaming",
      }),
      runEvent({
        id: "delta_1",
        sequence: 2,
        eventType: "message.delta",
        message: "正在写代码",
        role: "coder",
        runAttemptId: "att_run",
        streamKey: "stream_1",
        streamState: "streaming",
      }),
    ];

    const patched = replayPatchTimelineIds(events, attempts);
    expect(patched).toEqual(["user_1", "delta_1"]);
    let record = createThreadFeedSkeletonRecord(emptySnapshot(), {
      attempts: mapAttempts(attempts),
      agents: [],
      historyRevision: 0,
      maxEventSequence: 0,
    });
    record.patchState = createFeedSkeletonPatchState(record.snapshot);
    for (const event of events) {
      record = patchThreadFeedSkeletonFromEvent(
        record,
        event,
        patchContext(mapAttempts(attempts), event.sequence),
      )!;
    }
    const delta = record.snapshot.timeline.find((item) => item.id === "delta_1");
    expect(delta?.text).toBe("正在写代码");
  });

  test("does not put running-attempt subagent prompt or thinking on the main skeleton", () => {
    const attempts = [attemptRecord("att_run", "running")];
    const events = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "thread.status",
        message: "加产品排行",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "planner_final",
        sequence: 2,
        eventType: "message.final",
        message: "我先用 explore 勘察",
        role: "assistant",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "explore_prompt",
        sequence: 3,
        eventType: "message.final",
        scope: "agent",
        message: "请只读探索当前仓库，禁止编辑、生成或删除任何文件。",
        role: "explore",
        agentId: "explore_a",
        runAttemptId: "att_run",
        metadata: { liveType: "message.user", itemType: "userMessage" },
      }),
      runEvent({
        id: "explore_think",
        sequence: 4,
        eventType: "thinking.delta",
        scope: "agent",
        message: "The user wants me to explore the codebase",
        role: "explore",
        agentId: "explore_a",
        runAttemptId: "att_run",
      }),
    ];

    // Agent-scoped rows never enter the main tracked set; they go to the agent timeline.
    expect(isFeedMainTimelineEvent(events[2]!)).toBe(false);
    expect(isFeedMainTimelineEvent(events[3]!)).toBe(false);
    expect(shouldPatchAgentTimelineForFeedSkeleton(events[2]!)).toBe(true);
    expect(shouldPatchAgentTimelineForFeedSkeleton(events[3]!)).toBe(true);
    expect(replayPatchTimelineIds(events, attempts)).toEqual(["user_1", "planner_final"]);
  });

  test("routes running-attempt subagent prompt and thinking onto the live agent timeline", () => {
    const attempts = [projectionAttempt("att_run", "running")];
    const agent = exploreAgent();
    const events = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "thread.status",
        message: "加产品排行",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "planner_final",
        sequence: 2,
        eventType: "message.final",
        message: "我先用 explore 勘察",
        role: "assistant",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "explore_prompt",
        sequence: 3,
        eventType: "message.final",
        scope: "agent",
        message: "请只读探索当前仓库，禁止编辑、生成或删除任何文件。",
        role: "explore",
        agentId: "explore_a",
        runAttemptId: "att_run",
        metadata: { liveType: "message.user", itemType: "userMessage" },
      }),
      runEvent({
        id: "explore_think",
        sequence: 4,
        eventType: "thinking.delta",
        scope: "agent",
        message: "The user wants me to explore the codebase",
        role: "explore",
        agentId: "explore_a",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "planner_think",
        sequence: 5,
        eventType: "thinking.delta",
        message: "**Preparing subagent**",
        role: "thinking",
        runAttemptId: "att_run",
      }),
    ];

    let record = createThreadFeedSkeletonRecord(
      {
        ...emptySnapshot(),
        attempts,
        agents: [agent],
      },
      {
        attempts,
        agents: [agent],
        historyRevision: 0,
        maxEventSequence: 0,
      },
    );
    record.patchState = createFeedSkeletonPatchState(record.snapshot);
    for (const event of events) {
      record = patchThreadFeedSkeletonFromEvent(
        record,
        event,
        patchContext(attempts, event.sequence, [agent]),
      )!;
    }

    expect(feedSkeletonTimelineIds(record.snapshot)).toEqual(["user_1", "planner_final", "planner_think"]);
    expect(record.snapshot.timeline.some((item) => item.scope === "agent")).toBe(false);
    expect(record.snapshot.agents[0]?.timeline.map((item) => item.id)).toEqual([
      "explore_prompt",
      "explore_think",
    ]);
    expect(record.snapshot.agents[0]?.latestActivity).toBe("The user wants me to explore the codebase");
  });

  test("strips already leaked agent-scoped items from a dirty skeleton on the next patch", () => {
    const attempts = [projectionAttempt("att_run", "running")];
    const leaked = {
      id: "explore_prompt",
      sequence: 3,
      eventType: "message.final" as const,
      scope: "agent" as const,
      role: "explore",
      text: "请只读探索当前仓库",
      at: "2026-01-01T00:00:03.000Z",
      metadata: { liveType: "message.user" },
    };
    const record = createThreadFeedSkeletonRecord(
      {
        ...emptySnapshot(),
        attempts,
        timeline: [
          {
            id: "user_1",
            sequence: 1,
            eventType: "thread.status",
            scope: "main",
            role: "user",
            text: "加产品排行",
            at: "2026-01-01T00:00:01.000Z",
            metadata: { liveType: "thread.user_prompt" },
          },
          leaked,
        ],
      },
      {
        attempts,
        agents: [],
        historyRevision: 0,
        maxEventSequence: 3,
      },
    );
    record.patchState = {
      ...createFeedSkeletonPatchState(record.snapshot),
      trackedItems: [...(record.patchState?.trackedItems ?? []), leaked],
    };

    const patched = patchThreadFeedSkeletonFromEvent(
      record,
      runEvent({
        id: "planner_think",
        sequence: 5,
        eventType: "thinking.delta",
        message: "**Preparing subagent**",
        role: "thinking",
        runAttemptId: "att_run",
      }),
      patchContext(attempts, 5),
    );

    expect(patched).not.toBeNull();
    expect(feedSkeletonTimelineIds(patched!.snapshot)).toEqual(["user_1", "planner_think"]);
    expect(patched!.snapshot.timeline.some((item) => item.scope === "agent")).toBe(false);
  });

  test("compacts live process rows on request.failed without run.attempt.*", () => {
    const running = [attemptRecord("att_run", "running")];
    const failed = [attemptRecord("att_run", "failed")];
    const liveEvents = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "message.final",
        message: "提问",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "tool_live",
        sequence: 2,
        eventType: "tool.completed",
        message: "Tool: Bash",
        runAttemptId: "att_run",
      }),
      runEvent({
        id: "delta_live",
        sequence: 3,
        eventType: "message.delta",
        message: "还在写",
        role: "coder",
        runAttemptId: "att_run",
        streamKey: "stream_1",
        streamState: "streaming",
      }),
    ];

    let record = createThreadFeedSkeletonRecord(emptySnapshot(), {
      attempts: mapAttempts(running),
      agents: [],
      historyRevision: 0,
      maxEventSequence: 0,
    });
    record.patchState = createFeedSkeletonPatchState(record.snapshot);
    for (const event of liveEvents) {
      record = patchThreadFeedSkeletonFromEvent(
        record,
        event,
        patchContext(mapAttempts(running), event.sequence),
      )!;
    }
    expect(feedSkeletonTimelineIds(record.snapshot)).toEqual(["user_1", "tool_live", "delta_live"]);

    record = patchThreadFeedSkeletonFromEvent(
      record,
      runEvent({
        id: "req_failed",
        sequence: 4,
        eventType: "request.failed",
        message: "请求失败",
        runAttemptId: "att_run",
      }),
      patchContext(mapAttempts(failed), 4),
    )!;

    expect(feedSkeletonTimelineIds(record.snapshot)).toEqual(["user_1"]);
    expect(
      isFeedMainTimelineEvent(
        runEvent({
          id: "req_failed",
          sequence: 4,
          eventType: "request.failed",
          message: "请求失败",
          runAttemptId: "att_run",
        }),
      ),
    ).toBe(true);
  });

  test("reconciles when attempt becomes terminal even without a terminal event type", () => {
    const running = [projectionAttempt("att_run", "running")];
    const failed = [projectionAttempt("att_run", "failed")];
    const record = createThreadFeedSkeletonRecord(
      {
        ...emptySnapshot(),
        attempts: running,
        timeline: [
          {
            id: "user_1",
            sequence: 1,
            eventType: "message.final",
            scope: "main",
            role: "user",
            text: "提问",
            at: "2026-01-01T00:00:01.000Z",
            metadata: { liveType: "thread.user_prompt" },
          },
          {
            id: "tool_live",
            sequence: 2,
            eventType: "tool.completed",
            scope: "main",
            role: "coder",
            text: "Tool: Bash",
            at: "2026-01-01T00:00:02.000Z",
            runAttemptId: "att_run",
          },
        ],
      },
      {
        attempts: running,
        agents: [],
        historyRevision: 0,
        maxEventSequence: 2,
      },
    );
    record.patchState = createFeedSkeletonPatchState(record.snapshot);

    const patched = patchThreadFeedSkeletonFromEvent(
      record,
      runEvent({
        id: "noise_after_stop",
        sequence: 3,
        eventType: "tool.completed",
        message: "Tool: Read",
        runAttemptId: "att_run",
      }),
      patchContext(failed, 3),
    );

    expect(patched).not.toBeNull();
    expect(feedSkeletonTimelineIds(patched!.snapshot)).toEqual(["user_1"]);
    expect(hasFeedSkeletonAttemptBecameTerminal(running, failed)).toBe(true);
  });
});

describe("feed skeleton incremental == full rebuild", () => {
  /**
   * Rich stream: request rows, stream deltas carrying SDK block ids, thread.status,
   * tool rows, an unattributed failure, plus an attempt that flips terminal mid-stream.
   * `terminalFromStep` is the first step whose events see the attempt as finished.
   */
  function buildRichStream(terminalFromStep: number): {
    events: ThreadRunEvent[];
    attemptsAt: (step: number) => RunAttemptRecord[];
  } {
    const running = [attemptRecord("att_run", "running")];
    const finished = [attemptRecord("att_run", "completed")];
    const event = (id: string, eventType: string, extra: Partial<ThreadRunEvent> = {}): ThreadRunEvent =>
      runEvent({
        id,
        sequence: 0,
        eventType,
        message: id,
        ...extra,
      });
    return {
      attemptsAt: (step) => (step >= terminalFromStep ? finished : running),
      events: [], // filled below
    };
  }

  test("matches the full projection after every event (running -> completed)", () => {
    const running = [attemptRecord("att_run", "running")];
    const finished = [attemptRecord("att_run", "completed")];
    const terminalFromStep = 9;
    const events: ThreadRunEvent[] = [
      runEvent({
        id: "user_1",
        sequence: 1,
        eventType: "message.final",
        message: "把排序做一下",
        role: "user",
        metadata: { liveType: "thread.user_prompt" },
      }),
      runEvent({
        id: "req_started",
        sequence: 2,
        eventType: "request.started",
        message: "Requesting model…",
        role: "main",
        runAttemptId: "att_run",
        requestId: "req_1",
      }),
      runEvent({
        id: "delta_1",
        sequence: 3,
        eventType: "message.delta",
        message: "先",
        role: "coder",
        runAttemptId: "att_run",
        requestId: "req_1",
        streamKey: "stream_1",
        streamState: "streaming",
        metadata: { sdkMessageId: "sdk_1" },
      }),
      runEvent({
        id: "delta_2",
        sequence: 4,
        eventType: "message.delta",
        message: "先看代码",
        role: "coder",
        runAttemptId: "att_run",
        requestId: "req_1",
        streamKey: "stream_1",
        streamState: "streaming",
        metadata: { sdkMessageId: "sdk_1" },
      }),
      runEvent({
        id: "final_1",
        sequence: 5,
        eventType: "message.final",
        message: "先看代码",
        role: "coder",
        runAttemptId: "att_run",
        requestId: "req_1",
        streamKey: "stream_1",
        streamState: "finalized",
        metadata: { sdkMessageId: "sdk_1" },
      }),
      runEvent({
        id: "tool_1",
        sequence: 6,
        eventType: "tool.completed",
        message: "Tool: Read",
        role: "tool",
        runAttemptId: "att_run",
        requestId: "req_1",
      }),
      runEvent({
        id: "status_1",
        sequence: 7,
        eventType: "thread.status",
        message: "状态已更新",
        role: "system",
      }),
      runEvent({
        id: "narr_2",
        sequence: 8,
        eventType: "message.final",
        message: "改完了，解释一下",
        role: "coder",
        runAttemptId: "att_run",
        requestId: "req_1",
      }),
      runEvent({
        id: "req_completed",
        sequence: 9,
        eventType: "request.completed",
        message: "Request finished",
        role: "main",
        runAttemptId: "att_run",
        requestId: "req_1",
      }),
      runEvent({
        id: "api_error_1",
        sequence: 10,
        eventType: "api.error",
        message: "上游 500",
        role: "coder",
      }),
    ];

    let record = createThreadFeedSkeletonRecord(emptySnapshot(), patchContext(running, 0));
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const attempts = index + 1 >= terminalFromStep ? finished : running;
      record = patchThreadFeedSkeletonFromEvent(
        record,
        event,
        patchContext(mapAttempts(attempts), event.sequence),
      )!;
      const reference = referenceFeedTimelineIds(events.slice(0, index + 1), attempts);
      expect(feedSkeletonTimelineIds(record.snapshot), `after step ${index + 1} (${event.id})`).toEqual(
        reference,
      );
      // The patched state must look fresh to the loader: a stale rules version or a
      // watermark mismatch would trigger a rebuild on every read.
      expect(isThreadFeedSkeletonFresh(record, record.historyRevision, record.maxEventSequence)).toBe(true);
      expect(record.patchState?.rulesVersion).toBe(FEED_SKELETON_RULES_VERSION);
    }
  });

  test("keeps tracked items bounded after the attempt finishes", () => {
    const running = [attemptRecord("att_run", "running")];
    const finished = [attemptRecord("att_run", "completed")];
    const events: ThreadRunEvent[] = [];
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      events.push(
        runEvent({
          id: `tool_${sequence}`,
          sequence,
          eventType: "tool.completed",
          message: `Tool: Bash ${sequence}`,
          role: "tool",
          runAttemptId: "att_run",
        }),
      );
    }
    events.push(
      runEvent({
        id: "final_1",
        sequence: 41,
        eventType: "message.final",
        message: "全部跑完了",
        role: "coder",
        runAttemptId: "att_run",
      }),
    );

    let record = createThreadFeedSkeletonRecord(emptySnapshot(), patchContext(running, 0));
    for (const event of events) {
      record = patchThreadFeedSkeletonFromEvent(
        record,
        event,
        patchContext(mapAttempts(running), event.sequence),
      )!;
    }
    // While running, the whole trail is tracked: that is exactly what select keeps.
    expect(record.patchState!.trackedItems.length).toBe(41);

    record = patchThreadFeedSkeletonFromEvent(
      record,
      runEvent({
        id: "noise_after_finish",
        sequence: 42,
        eventType: "tool.completed",
        message: "Tool: Read",
        role: "tool",
        runAttemptId: "att_run",
      }),
      patchContext(mapAttempts(finished), 42),
    )!;

    expect(feedSkeletonTimelineIds(record.snapshot)).toEqual(["final_1"]);
    expect(record.patchState!.trackedItems.map((item) => item.id)).toEqual(["final_1"]);
  });

  test("mirrors stream-delta replacement and settled SDK blocks", () => {
    const attempts = [attemptRecord("att_run", "running")];
    const events = [
      runEvent({
        id: "delta_a",
        sequence: 1,
        eventType: "message.delta",
        message: "第一版",
        role: "coder",
        runAttemptId: "att_run",
        streamKey: "stream_1",
        streamState: "streaming",
        metadata: { sdkMessageId: "sdk_a" },
      }),
      runEvent({
        id: "delta_b",
        sequence: 2,
        eventType: "message.delta",
        message: "第二版内容",
        role: "coder",
        runAttemptId: "att_run",
        streamKey: "stream_1",
        streamState: "streaming",
        metadata: { sdkMessageId: "sdk_a" },
      }),
      runEvent({
        id: "final_a",
        sequence: 3,
        eventType: "message.final",
        message: "第二版内容",
        role: "coder",
        runAttemptId: "att_run",
        streamKey: "stream_1",
        streamState: "finalized",
        metadata: { sdkMessageId: "sdk_a" },
      }),
      // Replayed duplicate of an already settled block: the projection drops it, so the
      // incremental path must drop it too.
      runEvent({
        id: "delta_replay",
        sequence: 4,
        eventType: "message.delta",
        message: "第二版内容",
        role: "coder",
        runAttemptId: "att_run",
        streamKey: "stream_1",
        streamState: "streaming",
        metadata: { sdkMessageId: "sdk_a" },
      }),
    ];

    let record = createThreadFeedSkeletonRecord(emptySnapshot(), patchContext(attempts, 0));
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      record = patchThreadFeedSkeletonFromEvent(
        record,
        event,
        patchContext(mapAttempts(attempts), event.sequence),
      )!;
      expect(feedSkeletonTimelineIds(record.snapshot), `after ${event.id}`).toEqual(
        referenceFeedTimelineIds(events.slice(0, index + 1), attempts),
      );
    }
    // The superseded delta was replaced in place, the replay was dropped.
    expect(feedSkeletonTimelineIds(record.snapshot)).toEqual(["final_a"]);
  });

  test("treats patch states from older rules as stale", () => {
    const attempts = [attemptRecord("att_run", "running")];
    const record = createThreadFeedSkeletonRecord(emptySnapshot(), patchContext(attempts, 0));
    expect(isThreadFeedSkeletonFresh(record, record.historyRevision, record.maxEventSequence)).toBe(true);
    expect(
      isThreadFeedSkeletonFresh(
        { ...record, patchState: { ...record.patchState!, rulesVersion: 1 } },
        record.historyRevision,
        record.maxEventSequence,
      ),
    ).toBe(false);
  });
});

/**
 * Regression suite driven by the *observed* shape space of real persisted run events
 * (dev + prod, 138 threads). Every shape that has ever been written to
 * `thread_run_events` is replayed through the incremental patch and compared against a full
 * rebuild after *every* event, so a rule that only holds for hand-picked scenarios fails.
 */
describe("feed skeleton parity on observed real event shapes", () => {
  const shapeFile = loadObservedShapeFile();
  const shapeCases = shapeFile.shapes.map((shape, index) => [shapeCaseLabel(shape, index), shape] as const);

  test("fixture is derived from real data and covers the guard-hole shapes", () => {
    expect(shapeFile.threadCount).toBeGreaterThan(100);
    expect(shapeFile.shapes.length).toBeGreaterThan(100);
    // Metrics-only live types are never persisted; if one ever is, the feed rules must
    // account for it instead of silently dropping it.
    expect(shapeFile.shapes.filter((shape) => !isPersistableShape(shape))).toEqual([]);
    // The shape that defeated the previous running-attempt guard: api.error with no
    // runAttemptId while an attempt is running.
    expect(shapeFile.shapes.some((shape) => shape.eventType === "api.error" && !shape.hasRunAttemptId)).toBe(
      true,
    );
    // The corpus generator derives stream keys per scope, which is only faithful because no
    // real stream identity spans two scopes (the store collapses deltas by identity alone).
    expect(shapeFile.crossScopeStreamIdentities).toBe(0);
  });

  test.each(shapeCases)("incremental patch equals a full rebuild around shape %s", (_label, shape) => {
    expectParityAfterEveryStep(buildShapeFocusedStream(shape));
  });

  test("fuzz: seeded random streams over the observed shapes stay identical to a rebuild", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const stream = generateStream({
        seed,
        shapes: shapeFile.shapes,
        count: 10 + (seed % 30),
        finishAttempt: seed % 3 !== 0,
        finalStatus: seed % 3 === 0 ? "cancelled" : seed % 2 === 0 ? "completed" : "failed",
      });
      expectParityAfterEveryStep(stream, `seed ${seed}`);
    }
  });

  test("fuzz: settled attempts keep the tracked set bounded and self-consistent", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const stream = generateStream({
        seed: seed * 7,
        shapes: shapeFile.shapes,
        count: 40,
        finalStatus: "completed",
      });
      const last = replayPatchRecordsForStream(stream).at(-1)!;
      const tracked = last.patchState!.trackedItems;
      const timelineIds = feedSkeletonTimelineIds(last.snapshot);
      expect(new Set(tracked.map((item) => item.id)).size).toBe(tracked.length);
      for (const id of timelineIds) {
        expect(tracked.some((item) => item.id === id)).toBe(true);
      }
      expect(tracked.length).toBeLessThanOrEqual(stream.events.length);
      expect(tracked.length).toBeGreaterThan(timelineIds.length - 1);
    }
  });

  test("mid-run: every narrative body survives while the attempt is still running", () => {
    // The reported bug: message.final while running collapsed the segment and dropped
    // earlier assistant bodies from the live feed (they only reappeared after a reload).
    const narrativeShapes = shapeFile.shapes.filter((shape) => isNarrativeBodyShape(shape));
    expect(narrativeShapes.length).toBeGreaterThan(0);
    const toolShape = shapeFile.shapes.find(
      (shape) => shape.eventType === "tool.started" && shape.scope !== "agent" && !shape.textEmpty,
    )!;
    const failureShape = shapeFile.shapes.find(
      (shape) => shape.eventType === "tool.failed" && !shape.textEmpty,
    )!;
    const narrative = narrativeShapes[0]!;

    const shapes: ObservedEventShape[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      shapes.push(narrative, toolShape, failureShape, narrativeShapes[turn % narrativeShapes.length]!);
    }
    const stream = corpusStream(shapes, { runningAttempt: true });
    const records = replayPatchRecordsForStream(stream);
    expect(records).toHaveLength(shapes.length);

    for (let step = 1; step <= records.length; step += 1) {
      const timeline = feedSkeletonTimelineIds(records[step - 1]!.snapshot);
      for (const event of stream.events.slice(0, step)) {
        if (!isNarrativeBodyEvent(event.eventType, event.role) || !event.message.trim()) {
          continue;
        }
        // Operational status lines ("已停止"/"正在…") are not dialogue and never reach the
        // feed; everything else must survive for as long as the attempt is running.
        if (isThreadFollowUpActivityMessage(event.message)) {
          continue;
        }
        expect(timeline, `step ${step} lost narrative ${event.id}`).toContain(event.id);
      }
    }
    expectParityAfterEveryStep(stream);
  });

  test("mid-run: api.error without runAttemptId does not drop the running trail", () => {
    const withAttempt = shapeFile.shapes.find(
      (shape) => shape.eventType === "api.error" && shape.hasRunAttemptId,
    )!;
    const withoutAttempt = shapeFile.shapes.find(
      (shape) => shape.eventType === "api.error" && !shape.hasRunAttemptId,
    )!;
    const narrative = shapeFile.shapes.find(
      (shape) =>
        shape.eventType === "message.final" &&
        shape.role === withAttempt.role &&
        !shape.textEmpty &&
        shape.scope !== "agent",
    )!;
    const stream = corpusStream([narrative, withAttempt, narrative, withoutAttempt, narrative], {
      runningAttempt: true,
    });

    const records = replayPatchRecordsForStream(stream);
    const timeline = feedSkeletonTimelineIds(records.at(-1)!.snapshot);
    // A row without runAttemptId still falls inside the running attempt's window, so it must
    // be attributed to that attempt rather than treated as a reason to drop the trail.
    expect(timeline).toContain(stream.events[0]!.id);
    expect(timeline).toContain(stream.events[2]!.id);
    expectParityAfterEveryStep(stream);
  });

  test("settling the attempt re-derives the selection from tracked items alone", () => {
    // Mirrors `syncThreadFeedSkeletonAttemptsFromStore`: attempt status change => re-select
    // from the tracked items (no event-log read) must equal a full rebuild.
    for (let seed = 1; seed <= 15; seed += 1) {
      const stream = generateStream({
        seed: seed * 13,
        shapes: shapeFile.shapes,
        count: 30,
        finishAttempt: false,
      });
      const last = replayPatchRecordsForStream(stream).at(-1)!;
      const settledAttempts = [attemptRecord("completed")];
      const settledProjectionAttempts = mapAttempts(settledAttempts);
      const settledIds = recomputeTimelineFromTrackedItems(last, settledProjectionAttempts);
      expect(settledIds).toEqual(
        // Register the agent instance: a rebuild with no agent rows would promote orphan
        // agent-scope rows onto the main timeline, which no patch can invent.
        rebuildFeedTimeline(stream.events, settledAttempts, { agents: [corpusAgentInstance()] }).map(
          (item) => item.id,
        ),
      );
      // And the running view keeps at least as much as the settled view.
      const runningTimeline = feedSkeletonTimelineIds(last.snapshot);
      expect(runningTimeline.length).toBeGreaterThanOrEqual(settledIds.length);
    }
  });
});

function shapeCaseLabel(shape: ObservedEventShape, index: number): string {
  return `${index}:${shape.eventType}/${shape.scope}/${shape.role ?? "-"}${
    shape.hasRunAttemptId ? "+att" : ""
  }`;
}

function isNarrativeBodyShape(shape: ObservedEventShape): boolean {
  return isNarrativeBodyEvent(shape.eventType, shape.role) && shape.scope !== "agent" && !shape.textEmpty;
}

function isNarrativeBodyEvent(eventType: string, role: string | undefined): boolean {
  return eventType === "message.final" && role !== "user" && role !== "tool" && role !== "thinking";
}

function corpusStream(
  shapes: readonly ObservedEventShape[],
  options: { runningAttempt?: boolean } = {},
): CorpusStream {
  return {
    events: shapes.map((shape, index) =>
      eventFromShape(shape, { sequence: index + 1, attemptId: CORPUS_ATTEMPT_ID }),
    ),
    shapes: [...shapes],
    attemptStatusBySequence: options.runningAttempt ? [] : [{ sequence: 1, status: "completed" }],
    finalStatus: options.runningAttempt ? "running" : "completed",
  };
}

/** One shape under test, wrapped in a user prompt so it has dialogue context. */
function buildShapeFocusedStream(shape: ObservedEventShape): CorpusStream {
  const prompt = loadObservedShapeFile().shapes.find(
    (candidate) => candidate.metadata?.liveType === "thread.user_prompt" && !candidate.textEmpty,
  )!;
  const narrative = loadObservedShapeFile().shapes.find((candidate) => isNarrativeBodyShape(candidate))!;
  // Keep the attempt running so the selection has to hold the whole trail: that is the case
  // the incremental path used to get wrong.
  return corpusStream([prompt, narrative, shape, narrative], { runningAttempt: true });
}

/** Replays a stream, deriving the patch context attempts at every step like the store does. */
function replayPatchRecordsForStream(stream: CorpusStream): ThreadFeedSkeletonRecord[] {
  let record = createThreadFeedSkeletonRecord(emptySnapshot(CORPUS_THREAD_ID), {
    attempts: mapAttempts(attemptsAtSequence(stream, 0)),
    agents: [corpusProjectionAgent()],
    historyRevision: 0,
    maxEventSequence: 0,
  });
  record.patchState = createFeedSkeletonPatchState(record.snapshot);

  const records: ThreadFeedSkeletonRecord[] = [];
  for (const event of stream.events) {
    const attempts = attemptsAtSequence(stream, event.sequence);
    const patched = patchThreadFeedSkeletonFromEvent(
      record,
      event,
      patchContext(mapAttempts(attempts), event.sequence, [corpusProjectionAgent()]),
    );
    expect(patched).not.toBeNull();
    record = patched!;
    records.push(record);
  }
  return records;
}

/** Compares the incremental patch against a full rebuild after every single event. */
function expectParityAfterEveryStep(stream: CorpusStream, label = "stream"): void {
  const records = replayPatchRecordsForStream(stream);
  expect(records.length).toBe(stream.events.length);
  for (let step = 1; step <= records.length; step += 1) {
    const attempts = attemptsAtSequence(stream, stream.events[step - 1]!.sequence);
    const patched = timelineSignature(records[step - 1]!.snapshot.timeline);
    const expected = timelineSignature(
      rebuildFeedTimeline(stream.events.slice(0, step), attempts, {
        agents: [corpusAgentInstance()],
      }),
    );
    expect(patched, `${label} step ${step} (${stream.events[step - 1]!.id})`).toEqual(expected);
  }
}

function recomputeTimelineFromTrackedItems(
  record: ThreadFeedSkeletonRecord,
  attempts: readonly ThreadRunProjectionAttempt[],
): string[] {
  return selectSkeletonTimelineItems(record.patchState!.trackedItems, attempts).map((item) => item.id);
}
