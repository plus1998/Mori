import { expect, test } from "bun:test";
import {
  mergeThreadRunProjectionDetail,
  mergeThreadRunProjectionUpdate,
} from "../src/renderer/conversation-v2-projection-merge";
import { FEED_PROJECTION_MAX_MAIN_TIMELINE_ITEMS } from "../src/shared/conversation-v2-projection-limits";
import type { ThreadRunProjectionSnapshot, ThreadRunProjectionTimelineItem } from "../src/shared/ipc";

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function makeProjection(
  overrides: Partial<ThreadRunProjectionSnapshot> & Pick<ThreadRunProjectionSnapshot, "sourceEventCount">,
): ThreadRunProjectionSnapshot {
  const timeline =
    overrides.timeline ??
    Array.from({ length: overrides.sourceEventCount > 80 ? 120 : 40 }, (_, index) => ({
      id: `evt_${index}`,
      kind: "narrative" as const,
      text: `line ${index}`,
      role: "main" as const,
      observedAt: new Date().toISOString(),
    }));
  return {
    generatedAt: overrides.generatedAt ?? new Date().toISOString(),
    thread: {
      threadId: "thr_1",
      status: "running",
      generatedAt: overrides.generatedAt ?? new Date().toISOString(),
      message: "",
    },
    timeline,
    agents: [],
    requestSpans: [],
    diagnostics: [],
    ...overrides,
    sourceEventCount: overrides.sourceEventCount,
  };
}

test("mergeThreadRunProjectionUpdate keeps fuller timeline for an older update with matching event count", () => {
  const full = makeProjection({
    generatedAt: "2026-01-01T00:00:01.000Z",
    sourceEventCount: 100,
    timeline: Array.from({ length: 120 }, (_, i) => ({
      id: `evt_${i}`,
      kind: "narrative" as const,
      text: `line ${i}`,
      role: "main" as const,
      observedAt: new Date().toISOString(),
    })),
  });
  const trimmed = makeProjection({
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceEventCount: 100,
    timeline: Array.from({ length: 80 }, (_, i) => ({
      id: `evt_${i + 40}`,
      kind: "narrative" as const,
      text: `line ${i + 40}`,
      role: "main" as const,
      observedAt: new Date().toISOString(),
    })),
  });

  expect(mergeThreadRunProjectionUpdate(full, trimmed)).toBe(full);
  const mergedFromTrimmed = mergeThreadRunProjectionUpdate(trimmed, full);
  expect(mergedFromTrimmed.timeline).toHaveLength(120);
  expect(mergedFromTrimmed.timeline.some((item) => item.id === "evt_0")).toBe(true);
  expect(mergedFromTrimmed.timeline.some((item) => item.id === "evt_119")).toBe(true);
});

test("mergeThreadRunProjectionUpdate accepts final output after source event count is capped", () => {
  const current = makeProjection({
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceEventCount: 1_000,
    timeline: Array.from({ length: FEED_PROJECTION_MAX_MAIN_TIMELINE_ITEMS }, (_, index) => ({
      id: `evt_${index + 1}`,
      sequence: index + 1,
      eventType: "tool.completed" as const,
      scope: "main" as const,
      text: `line ${index + 1}`,
      at: "2026-01-01T00:00:00.000Z",
    })),
  });
  const incoming = makeProjection({
    generatedAt: "2026-01-01T00:00:01.000Z",
    sourceEventCount: 1_000,
    thread: {
      threadId: "thr_1",
      status: "completed",
      generatedAt: "2026-01-01T00:00:01.000Z",
      message: "执行完成。",
    },
    timeline: [
      {
        id: "final_message",
        sequence: 1_001,
        eventType: "message.final",
        scope: "main",
        text: "最终结果",
        at: "2026-01-01T00:00:01.000Z",
      },
    ],
  });

  const merged = mergeThreadRunProjectionUpdate(current, incoming);

  expect(merged.thread.status).toBe("completed");
  expect(merged.timeline).toHaveLength(FEED_PROJECTION_MAX_MAIN_TIMELINE_ITEMS + 1);
  expect(merged.timeline.at(-1)?.id).toBe("final_message");
  expect(merged.timeline.at(-1)?.text).toBe("最终结果");
});

test("mergeThreadRunProjectionUpdate replaces history after a rewind and ignores stale updates", () => {
  const beforeRewind = makeProjection({
    sourceEventCount: 4,
    historyRevision: 0,
    timeline: [
      {
        id: "prompt_old",
        sequence: 1,
        eventType: "thread.status",
        scope: "main",
        text: "旧消息",
        at: "2026-01-01T00:00:01.000Z",
        metadata: { liveType: "thread.user_prompt" },
      },
      {
        id: "reply_old",
        sequence: 2,
        eventType: "message.final",
        scope: "main",
        text: "旧回复",
        at: "2026-01-01T00:00:02.000Z",
      },
    ],
  });
  const afterRewind = makeProjection({
    sourceEventCount: 1,
    historyRevision: 1,
    timeline: [
      {
        id: "prompt_new",
        sequence: 1,
        eventType: "thread.status",
        scope: "main",
        text: "新消息",
        at: "2026-01-01T00:00:03.000Z",
        metadata: { liveType: "thread.user_prompt" },
      },
    ],
  });

  const replaced = mergeThreadRunProjectionUpdate(beforeRewind, afterRewind);
  expect(replaced).toBe(afterRewind);
  expect(replaced.timeline.map((item) => item.id)).toEqual(["prompt_new"]);
  expect(mergeThreadRunProjectionUpdate(replaced, beforeRewind)).toBe(replaced);
});

test("mergeThreadRunProjectionUpdate hard-replaces shortened feed after historyRevision bump", () => {
  const dirtyLive = makeProjection({
    sourceEventCount: 4,
    historyRevision: 0,
    timeline: [
      {
        id: "user_1",
        sequence: 1,
        eventType: "message.final",
        scope: "main",
        text: "提问",
        at: "2026-01-01T00:00:01.000Z",
        metadata: { liveType: "thread.user_prompt" },
      },
      {
        id: "tool_live",
        sequence: 2,
        eventType: "tool.completed",
        scope: "main",
        text: "Tool: Bash",
        at: "2026-01-01T00:00:02.000Z",
      },
      {
        id: "delta_live",
        sequence: 3,
        eventType: "message.delta",
        scope: "main",
        text: "还在写",
        at: "2026-01-01T00:00:03.000Z",
      },
    ],
  });
  const compacted = makeProjection({
    sourceEventCount: 5,
    historyRevision: 1,
    generatedAt: "2026-01-01T00:00:10.000Z",
    timeline: [
      {
        id: "user_1",
        sequence: 1,
        eventType: "message.final",
        scope: "main",
        text: "提问",
        at: "2026-01-01T00:00:01.000Z",
        metadata: { liveType: "thread.user_prompt" },
      },
    ],
  });

  const replaced = mergeThreadRunProjectionUpdate(dirtyLive, compacted);
  expect(replaced).toBe(compacted);
  expect(replaced.timeline.map((item) => item.id)).toEqual(["user_1"]);
  expect(replaced.timeline.some((item) => item.id === "tool_live")).toBe(false);
});

test("mergeThreadRunProjectionUpdate merges trimmed newer feed without dropping history", () => {
  const full = makeProjection({
    sourceEventCount: 100,
    timeline: Array.from({ length: 120 }, (_, i) => ({
      id: `evt_${i}`,
      kind: "narrative" as const,
      text: `line ${i}`,
      role: "main" as const,
      observedAt: new Date().toISOString(),
    })),
  });
  const trimmed = makeProjection({
    sourceEventCount: 101,
    timeline: Array.from({ length: 80 }, (_, i) => ({
      id: `evt_${i + 40}`,
      kind: "narrative" as const,
      text: `updated ${i + 40}`,
      role: "main" as const,
      observedAt: new Date().toISOString(),
    })),
  });

  const merged = mergeThreadRunProjectionUpdate(full, trimmed, { preserveHistory: false });
  expect(merged.timeline).toHaveLength(120);
  expect(merged.sourceEventCount).toBe(101);
  expect(merged.timeline[40]?.text).toBe("updated 40");
  expect(merged.timeline[0]?.text).toBe("line 0");
});

test("mergeThreadRunProjectionUpdate keeps longer thinking text when feed update is truncated", () => {
  const current = makeProjection({
    sourceEventCount: 10,
    timeline: [
      {
        id: "think_1",
        sequence: 1,
        scope: "main" as const,
        eventType: "thinking.delta",
        text: "a".repeat(1500),
        role: "thinking" as const,
        at: "2026-01-01T00:00:01.000Z",
      },
    ],
  });
  const incoming = makeProjection({
    sourceEventCount: 11,
    timeline: [
      {
        id: "think_1",
        sequence: 1,
        scope: "main" as const,
        eventType: "thinking.delta",
        text: "a".repeat(1200),
        role: "thinking" as const,
        at: "2026-01-01T00:00:01.000Z",
      },
    ],
  });

  const merged = mergeThreadRunProjectionUpdate(current, incoming);
  expect(merged.timeline[0]?.text).toHaveLength(1500);
});

test("mergeThreadRunProjectionUpdate resets thinking text across user prompt boundary", () => {
  const current = makeProjection({
    sourceEventCount: 10,
    timeline: [
      {
        id: "think_1",
        sequence: 1,
        scope: "main" as const,
        eventType: "thinking.delta",
        text: "old thinking text that is much longer",
        role: "thinking" as const,
        streamKey: "thr_1:thinking",
        at: "2026-01-01T00:00:01.000Z",
      },
    ],
  });
  const incoming = makeProjection({
    sourceEventCount: 12,
    timeline: [
      {
        id: "prompt_2",
        sequence: 2,
        scope: "main" as const,
        eventType: "thread.status",
        text: "继续。",
        role: "user" as const,
        at: "2026-01-01T00:00:10.000Z",
        metadata: { liveType: "thread.user_prompt" },
      },
      {
        id: "think_1",
        sequence: 3,
        scope: "main" as const,
        eventType: "thinking.delta",
        text: "new",
        role: "thinking" as const,
        streamKey: "thr_1:thinking",
        at: "2026-01-01T00:00:11.000Z",
      },
    ],
  });

  const merged = mergeThreadRunProjectionUpdate(current, incoming);
  const thinking = merged.timeline.find((item) => item.id === "think_1");
  expect(thinking?.text).toBe("new");
});

test("mergeThreadRunProjectionUpdate appends subagent timeline without dropping existing entries", () => {
  const existingItem: ThreadRunProjectionTimelineItem = {
    id: "agent_evt_1",
    sequence: 1,
    scope: "agent",
    eventType: "message.final",
    text: "first",
    role: "coder",
    agentId: "agent_1",
    at: "2026-01-01T00:00:01.000Z",
  };
  const current = makeProjection({
    sourceEventCount: 1,
    timeline: [],
    agents: [
      {
        agentId: "agent_1",
        role: "coder",
        kind: "subagent",
        status: "active",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 1_000,
        timeline: [existingItem],
      },
    ],
  });
  const incoming = makeProjection({
    sourceEventCount: 2,
    timeline: [],
    agents: [
      {
        agentId: "agent_1",
        role: "coder",
        kind: "subagent",
        status: "active",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 2_000,
        timeline: [
          {
            id: "agent_evt_2",
            sequence: 2,
            scope: "agent",
            eventType: "message.final",
            text: "second",
            role: "coder",
            agentId: "agent_1",
            at: "2026-01-01T00:00:02.000Z",
          },
        ],
      },
    ],
  });

  const merged = mergeThreadRunProjectionUpdate(current, incoming);

  expect(merged.agents[0]?.timeline.map((item) => item.id)).toEqual(["agent_evt_1", "agent_evt_2"]);
  expect(merged.agents[0]?.timeline[0]).toBe(existingItem);
});

test("mergeThreadRunProjectionUpdate preserves subagent timeline when an update has no detail delta", () => {
  const current = makeProjection({
    sourceEventCount: 1,
    timeline: [],
    agents: [
      {
        agentId: "agent_1",
        role: "coder",
        kind: "subagent",
        status: "active",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 1_000,
        timeline: [
          {
            id: "agent_evt_1",
            sequence: 1,
            scope: "agent",
            eventType: "message.final",
            text: "first",
            at: "2026-01-01T00:00:01.000Z",
          },
        ],
      },
    ],
  });
  const incoming = makeProjection({
    sourceEventCount: 2,
    timeline: [],
    agents: [
      {
        ...requireValue(current.agents[0], "current agent"),
        durationMs: 2_000,
        timeline: [],
      },
    ],
  });

  const merged = mergeThreadRunProjectionUpdate(current, incoming);

  expect(merged.agents[0]?.timeline).toEqual(current.agents[0]?.timeline ?? []);
});

test("mergeThreadRunProjectionUpdate keeps unchanged subagent item identity during full refresh", () => {
  const existingItem: ThreadRunProjectionTimelineItem = {
    id: "agent_evt_1",
    sequence: 1,
    scope: "agent",
    eventType: "message.final",
    text: "first",
    at: "2026-01-01T00:00:01.000Z",
  };
  const current = makeProjection({
    sourceEventCount: 2,
    timeline: [],
    agents: [
      {
        agentId: "agent_1",
        role: "coder",
        kind: "subagent",
        status: "active",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 1_000,
        timeline: [existingItem],
      },
    ],
    generatedAt: "2026-01-01T00:00:02.000Z",
  });
  const incoming = makeProjection({
    sourceEventCount: 2,
    timeline: [],
    agents: [
      {
        ...requireValue(current.agents[0], "current agent"),
        durationMs: 2_000,
        timeline: [
          { ...existingItem },
          {
            id: "agent_evt_2",
            sequence: 2,
            scope: "agent",
            eventType: "message.final",
            text: "second",
            at: "2026-01-01T00:00:02.000Z",
          },
        ],
      },
    ],
    generatedAt: "2026-01-01T00:00:03.000Z",
  });

  const merged = mergeThreadRunProjectionUpdate(current, incoming);

  expect(merged.agents[0]?.timeline.map((item) => item.id)).toEqual(["agent_evt_1", "agent_evt_2"]);
  expect(merged.agents[0]?.timeline[0]).toBe(existingItem);
});

test("mergeThreadRunProjectionUpdate reuses projection on generatedAt-only full refresh", () => {
  const current = makeProjection({
    sourceEventCount: 2,
    timeline: [
      {
        id: "evt_1",
        sequence: 1,
        scope: "main" as const,
        eventType: "message.final" as const,
        text: "first",
        at: "2026-01-01T00:00:01.000Z",
      },
    ],
    generatedAt: "2026-01-01T00:00:02.000Z",
  });
  const incoming = {
    ...current,
    thread: {
      ...current.thread,
      generatedAt: "2026-01-01T00:00:03.000Z",
    },
  };

  expect(mergeThreadRunProjectionUpdate(current, incoming)).toBe(current);
});

test("mergeThreadRunProjectionUpdate ignores active subagent duration-only refresh", () => {
  const current = makeProjection({
    sourceEventCount: 2,
    timeline: [],
    agents: [
      {
        agentId: "agent_1",
        role: "coder",
        kind: "subagent",
        status: "active",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 1_000,
        timeline: [
          {
            id: "agent_evt_1",
            sequence: 1,
            scope: "agent" as const,
            eventType: "message.final" as const,
            text: "first",
            at: "2026-01-01T00:00:01.000Z",
          },
        ],
      },
    ],
  });
  const incoming = {
    ...current,
    agents: [
      {
        ...requireValue(current.agents[0], "current agent"),
        durationMs: 2_000,
      },
    ],
  };

  expect(mergeThreadRunProjectionUpdate(current, incoming)).toBe(current);
});

test("mergeThreadRunProjectionUpdate keeps the full main skeleton instead of slicing to a page", () => {
  const makeItems = (start: number, count: number): ThreadRunProjectionTimelineItem[] =>
    Array.from({ length: count }, (_, offset) => {
      const sequence = start + offset;
      return {
        id: `evt_${sequence}`,
        sequence,
        eventType: "message.final",
        scope: "main",
        text: `line ${sequence}`,
        at: "2026-01-01T00:00:00.000Z",
      };
    });
  const current = makeProjection({
    sourceEventCount: 180,
    timeline: makeItems(1, 180),
  });
  const incoming = makeProjection({
    sourceEventCount: 260,
    timeline: makeItems(181, 80),
  });

  const merged = mergeThreadRunProjectionUpdate(current, incoming);
  expect(merged.timeline).toHaveLength(260);
  expect(merged.timeline[0]?.id).toBe("evt_1");
  expect(merged.timeline.at(-1)?.id).toBe("evt_260");
});

test("mergeThreadRunProjectionUpdate does not drop an older user prompt when later skeleton items arrive", () => {
  const current = makeProjection({
    sourceEventCount: 10,
    timeline: [
      {
        id: "user_mid",
        sequence: 5,
        eventType: "thread.status",
        scope: "main",
        text: "要啊，不然我怎么设置呢",
        at: "2026-01-01T00:00:05.000Z",
        metadata: { liveType: "thread.user_prompt" },
      },
    ],
  });
  const incoming = makeProjection({
    sourceEventCount: 20,
    timeline: [
      {
        id: "user_later",
        sequence: 18,
        eventType: "thread.status",
        scope: "main",
        text: "后面一句",
        at: "2026-01-01T00:00:18.000Z",
        metadata: { liveType: "thread.user_prompt" },
      },
      {
        id: "final_later",
        sequence: 20,
        eventType: "message.final",
        scope: "main",
        text: "最终输出",
        at: "2026-01-01T00:00:20.000Z",
      },
    ],
  });

  const merged = mergeThreadRunProjectionUpdate(current, incoming);
  expect(merged.timeline.map((row) => row.id)).toEqual(["user_mid", "user_later", "final_later"]);
});

test("mergeThreadRunProjectionDetail keeps planner attempt echoes as planner agents, not coder subagents", () => {
  const current = makeProjection({
    sourceEventCount: 368,
    timeline: [
      {
        id: "user_1",
        sequence: 1,
        eventType: "thread.status",
        scope: "main",
        text: "改预设",
        at: "2026-01-01T00:00:01.000Z",
        metadata: { liveType: "thread.user_prompt" },
      },
      {
        id: "final_1",
        sequence: 368,
        eventType: "message.final",
        scope: "main",
        text: "测试已通过。",
        at: "2026-01-01T00:06:00.000Z",
      },
    ],
    agents: [],
  });
  const merged = mergeThreadRunProjectionDetail(current, {
    threadId: "thr_1",
    kind: "turn",
    key: "attempt_execution_0",
    generatedAt: "2026-01-01T00:06:00.000Z",
    sourceEventCount: 368,
    hasMore: false,
    timeline: [
      {
        id: "approval_fetch",
        sequence: 124,
        eventType: "message.final",
        scope: "agent",
        role: "tool",
        agentId: "main:attempt_execution_0",
        text: "辅助模型已允许 Fetch：Fetch https://example.com/provider.ts",
        at: "2026-01-01T00:02:00.000Z",
        runAttemptId: "attempt_execution_0",
      },
    ],
  });

  expect(merged.agents).toHaveLength(1);
  expect(merged.agents[0]).toMatchObject({
    agentId: "main:attempt_execution_0",
    role: "main",
    kind: "main",
  });
});

test("mergeThreadRunProjectionUpdate strips leaked agent-scoped items from the main timeline", () => {
  const leaked = {
    id: "explore_prompt",
    sequence: 2,
    eventType: "message.final" as const,
    scope: "agent" as const,
    role: "explore",
    agentId: "explore_a",
    text: "请只读探索当前仓库",
    at: "2026-01-01T00:00:02.000Z",
    metadata: { liveType: "message.user" },
  };
  const current = makeProjection({
    sourceEventCount: 2,
    timeline: [
      {
        id: "user_1",
        sequence: 1,
        eventType: "thread.status",
        scope: "main",
        text: "加产品排行",
        at: "2026-01-01T00:00:01.000Z",
        metadata: { liveType: "thread.user_prompt" },
      },
      leaked,
    ],
  });
  const merged = mergeThreadRunProjectionUpdate(
    current,
    makeProjection({
      sourceEventCount: 3,
      generatedAt: "2026-01-01T00:00:03.000Z",
      timeline: [
        {
          id: "planner_says",
          sequence: 3,
          eventType: "message.final",
          scope: "main",
          text: "我先勘察",
          at: "2026-01-01T00:00:03.000Z",
        },
        leaked,
      ],
    }),
  );

  expect(merged.timeline.map((row) => row.id)).toEqual(["user_1", "planner_says"]);
  expect(merged.timeline.some((row) => row.scope === "agent")).toBe(false);
});
