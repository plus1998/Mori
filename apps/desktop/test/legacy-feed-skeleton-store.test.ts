import { describe, expect, test } from "vitest";
import {
  FEED_SKELETON_RULES_VERSION,
  hydrateThreadFeedSkeletonSnapshot,
  isThreadFeedSkeletonFresh,
  resolveFeedSkeletonPatchAgents,
} from "../src/main/legacy-feed-skeleton-store";
import type { ThreadRunProjectionSnapshot } from "../src/shared/conversation-v2-projection";

const baseSnapshot = (): ThreadRunProjectionSnapshot => ({
  thread: {
    threadId: "thr_1",
    status: "idle",
    generatedAt: "2026-01-01T00:00:00.000Z",
  },
  attempts: [
    {
      attemptId: "att_1",
      phase: "execution",
      retryIndex: 0,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  agents: [],
  requestSpans: [],
  timeline: [
    {
      id: "user_1",
      sequence: 1,
      eventType: "message.final",
      scope: "thread",
      role: "user",
      text: "hello",
      at: "2026-01-01T00:00:00.000Z",
    },
  ],
  diagnostics: [],
  sourceEventCount: 1,
  historyRevision: 0,
});

describe("thread feed skeleton store", () => {
  test("isThreadFeedSkeletonFresh matches revision, sequence and rules version", () => {
    const patchState = {
      trackedItems: [],
      finalizedSdkBlocks: [],
      rulesVersion: FEED_SKELETON_RULES_VERSION,
    };
    const record = {
      historyRevision: 2,
      maxEventSequence: 42,
      snapshot: baseSnapshot(),
      patchState,
    };
    expect(isThreadFeedSkeletonFresh(record, 2, 42)).toBe(true);
    expect(isThreadFeedSkeletonFresh(record, 1, 42)).toBe(false);
    expect(isThreadFeedSkeletonFresh(record, 2, 41)).toBe(false);
    // A skeleton without a current-version patch state cannot be patched with the current
    // rules (older build, or parsed from an older auxiliary_json) so it must be rebuilt.
    expect(isThreadFeedSkeletonFresh({ ...record, patchState: undefined }, 2, 42)).toBe(false);
    expect(
      isThreadFeedSkeletonFresh(
        { ...record, patchState: { ...patchState, rulesVersion: FEED_SKELETON_RULES_VERSION - 1 } },
        2,
        42,
      ),
    ).toBe(false);
  });

  test("hydrateThreadFeedSkeletonSnapshot refreshes running attempt to terminal", () => {
    const snapshot = baseSnapshot();
    snapshot.thread.status = "running";
    snapshot.attempts = [
      {
        attemptId: "att_1",
        phase: "execution",
        retryIndex: 0,
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const hydrated = hydrateThreadFeedSkeletonSnapshot(snapshot, "thr_1", {
      getThread: () => ({
        id: "thr_1",
        title: "Title",
        prompt: "hello",
        workspacePath: "/tmp",
        status: "completed",
        message: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
      listRunAttempts: () => [
        {
          attemptId: "att_1",
          threadId: "thr_1",
          phase: "execution",
          retryIndex: 0,
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      getBilling: () => undefined,
      getContext: () => undefined,
      getHistoryRevision: () => 0,
      getSubagentTimings: () => [],
    });
    expect(hydrated.thread.status).toBe("completed");
    expect(hydrated.attempts[0]?.status).toBe("completed");
    expect(hydrated.attempts[0]?.endedAt).toBe("2026-01-01T00:00:01.000Z");
  });

  test("hydrateThreadFeedSkeletonSnapshot refreshes volatile thread fields", () => {
    const hydrated = hydrateThreadFeedSkeletonSnapshot(baseSnapshot(), "thr_1", {
      getThread: () => ({
        id: "thr_1",
        title: "Title",
        prompt: "hello",
        workspacePath: "/tmp",
        status: "running",
        message: "working",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      listRunAttempts: () => [
        {
          attemptId: "att_2",
          threadId: "thr_1",
          phase: "execution",
          retryIndex: 0,
          status: "running",
          startedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      getBilling: () => undefined,
      getContext: () => undefined,
      getHistoryRevision: () => 3,
      getSubagentTimings: () => [],
    });

    expect(hydrated.thread.status).toBe("running");
    expect(hydrated.thread.message).toBe("working");
    expect(hydrated.thread.currentAttemptId).toBe("att_2");
    expect(hydrated.historyRevision).toBe(3);
    expect(hydrated.timeline).toHaveLength(1);
  });

  test("hydrateThreadFeedSkeletonSnapshot drops agent-scoped items from the main timeline", () => {
    const snapshot = baseSnapshot();
    snapshot.timeline = [
      ...snapshot.timeline,
      {
        id: "explore_prompt",
        sequence: 2,
        eventType: "message.final",
        scope: "agent",
        role: "explore",
        text: "请只读探索当前仓库",
        at: "2026-01-01T00:00:01.000Z",
        metadata: { liveType: "message.user" },
      },
    ];
    const hydrated = hydrateThreadFeedSkeletonSnapshot(snapshot, "thr_1", {
      getThread: () => undefined,
      listRunAttempts: () => [],
      getBilling: () => undefined,
      getContext: () => undefined,
      getHistoryRevision: () => 0,
      getSubagentTimings: () => [],
    });

    expect(hydrated.timeline.map((item) => item.id)).toEqual(["user_1"]);
  });

  test("hydrateThreadFeedSkeletonSnapshot re-selects skeleton when no attempt is running", () => {
    const snapshot = baseSnapshot();
    snapshot.timeline = [
      {
        id: "user_1",
        sequence: 1,
        eventType: "message.final",
        scope: "main",
        role: "user",
        text: "hello",
        at: "2026-01-01T00:00:00.000Z",
        metadata: { liveType: "thread.user_prompt" },
      },
      {
        id: "tool_live",
        sequence: 2,
        eventType: "tool.completed",
        scope: "main",
        role: "coder",
        text: "Tool: Bash",
        at: "2026-01-01T00:00:01.000Z",
        runAttemptId: "att_1",
      },
      {
        id: "final_1",
        sequence: 3,
        eventType: "message.final",
        scope: "main",
        role: "coder",
        text: "done",
        at: "2026-01-01T00:00:02.000Z",
        runAttemptId: "att_1",
      },
    ];
    const hydrated = hydrateThreadFeedSkeletonSnapshot(snapshot, "thr_1", {
      getThread: () => undefined,
      listRunAttempts: () => [
        {
          attemptId: "att_1",
          threadId: "thr_1",
          phase: "execution",
          retryIndex: 0,
          status: "failed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:10:00.000Z",
        },
      ],
      getBilling: () => undefined,
      getContext: () => undefined,
      getHistoryRevision: () => 0,
      getSubagentTimings: () => [],
    });

    expect(hydrated.timeline.map((item) => item.id)).toEqual(["user_1", "final_1"]);
  });

  test("resolveFeedSkeletonPatchAgents heals empty cached agents from store instances", () => {
    const healed = resolveFeedSkeletonPatchAgents(
      [],
      [
        {
          threadId: "thr_1",
          agentId: "main:attempt_execution_0",
          role: "main",
          kind: "main",
          status: "stopped",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          runAttemptId: "attempt_execution_0",
        },
      ],
    );

    expect(healed).toHaveLength(1);
    expect(healed[0]).toMatchObject({
      agentId: "main:attempt_execution_0",
      kind: "main",
      timeline: [],
    });
  });
});
