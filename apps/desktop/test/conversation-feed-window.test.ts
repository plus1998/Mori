import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { decodeConversationCursor, stableHash } from "@eco/shared";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { shouldDeliverFeedEvent } from "../src/main/renderer-feed-subscription";
import { boundConversationFeedState } from "../src/renderer/conversation-v2-feed-window-state";
import {
  applyConversationV2Effects,
  installConversationV2Bootstrap,
  mergeConversationV2ToolPage,
} from "../src/renderer/conversation-v2-renderer-state";
import { appendFeedEffect } from "../src/renderer/feed-effect-buffer";
import { replayFeedWindow } from "../scripts/feed-replay/feed-window";
import { mergeTimelineFeedWindow } from "../src/renderer/conversation-v2-feed-scroll-state";

test("long histories and a single tool-heavy run remain completely reachable through bounded pages", () => {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  const conversationId = "long";
  try {
    for (let i = 0; i < 180; i++)
      store.append({
        conversationId,
        eventId: `message_${i}`,
        type: "message.created",
        turnId: "turn",
        runId: "run",
        messageId: `message_${i}`,
        occurredAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        payload: { role: "assistant", body: `body ${i}` },
      });
    store.append({
      conversationId,
      eventId: "run",
      type: "run.started",
      turnId: "turn",
      runId: "run",
      occurredAt: "2026-01-01T00:00:00Z",
      payload: { status: "running" },
    });
    for (let i = 0; i < 250; i++)
      store.append({
        conversationId,
        eventId: `tool_${i}`,
        type: "tool.started",
        runId: "run",
        toolCallId: `tool_${i}`,
        occurredAt: "2026-01-01T00:00:00Z",
        payload: { name: "Read", input: { path: `file-${i}` } },
      });
    let page = store.feedWindow({ conversationId });
    const seen = new Set<string>();
    for (;;) {
      expect(page.messages.length).toBeLessThanOrEqual(60);
      expect(page.tools.length).toBeLessThanOrEqual(100);
      for (const message of page.messages) {
        expect(seen.has(message.messageId)).toBe(false);
        seen.add(message.messageId);
      }
      if (!page.hasOlder) break;
      page = store.feedWindow({ conversationId, beforeCursor: page.olderCursor! });
    }
    expect(seen.size).toBe(180);
    page = store.feedWindow({ conversationId, toolRunId: "run" });
    const tools = new Set<string>();
    for (;;) {
      for (const tool of page.tools) {
        expect(tools.has(tool.toolCallId)).toBe(false);
        tools.add(tool.toolCallId);
      }
      expect(page.tools.length).toBeLessThanOrEqual(100);
      const next = page.toolPages.run!;
      expect(next.total).toBe(250);
      if (!next.hasOlder) break;
      page = store.feedWindow({ conversationId, toolRunId: "run", toolCursor: next.olderCursor! });
    }
    expect(tools.size).toBe(250);
    let timeline = store.feedWindow({ conversationId, timeline: true });
    const entries = new Set<string>();
    for (;;) {
      expect(timeline.messages.length + timeline.tools.length).toBeLessThanOrEqual(60);
      for (const message of timeline.messages) {
        expect(entries.has(`m:${message.messageId}`)).toBe(false);
        entries.add(`m:${message.messageId}`);
      }
      for (const tool of timeline.tools) {
        expect(entries.has(`t:${tool.toolCallId}`)).toBe(false);
        entries.add(`t:${tool.toolCallId}`);
      }
      if (!timeline.hasOlder) break;
      timeline = store.feedWindow({
        conversationId,
        timeline: true,
        beforeFeedCursor: timeline.olderFeedCursor!,
      });
    }
    expect(entries.size).toBe(430);
    let forward = 0;
    while (timeline.hasNewer) {
      timeline = store.feedWindow({
        conversationId,
        timeline: true,
        afterFeedCursor: timeline.newerFeedCursor!,
      });
      forward += timeline.messages.length + timeline.tools.length;
    }
    expect(forward).toBe(420);
    expect(() => store.feedWindow({ conversationId, toolRunId: "foreign_run" })).toThrow("outside");
  } finally {
    db.close();
  }
});

test("the Feed skeleton keeps every user message and one final answer per turn without tools", () => {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  const conversationId = "skeleton";
  try {
    for (let i = 0; i < 12; i++) {
      store.append({
        conversationId,
        eventId: `user_${i}`,
        type: "message.created",
        turnId: `turn_${i}`,
        messageId: `user_${i}`,
        occurredAt: new Date(1_700_000_000_000 + i * 10_000).toISOString(),
        payload: { role: "user", channel: "answer", body: `question ${i}` },
      });
      store.append({
        conversationId,
        eventId: `thinking_${i}`,
        type: "message.created",
        turnId: `turn_${i}`,
        messageId: `thinking_${i}`,
        occurredAt: new Date(1_700_000_000_001 + i * 10_000).toISOString(),
        payload: { role: "assistant", channel: "thinking", body: `thought ${i}` },
      });
      store.append({
        conversationId,
        eventId: `answer_${i}`,
        type: "message.created",
        turnId: `turn_${i}`,
        messageId: `answer_${i}`,
        occurredAt: new Date(1_700_000_000_002 + i * 10_000).toISOString(),
        payload: { role: "assistant", channel: "answer", body: `answer ${i}` },
      });
      store.append({
        conversationId,
        eventId: `tool_${i}`,
        type: "tool.started",
        runId: `run_${i}`,
        toolCallId: `tool_${i}`,
        occurredAt: new Date(1_700_000_000_003 + i * 10_000).toISOString(),
        payload: { name: "Read", input: { path: `file-${i}` } },
      });
    }
    const skeleton = store.feedWindow({ conversationId, skeleton: true });
    expect(skeleton.skeleton).toBe(true);
    expect(skeleton.messages).toHaveLength(24);
    expect(skeleton.messages.every((message) => message.channel === "answer")).toBe(true);
    expect(skeleton.messages.filter((message) => message.role === "user")).toHaveLength(12);
    expect(skeleton.messages.filter((message) => message.role === "assistant")).toHaveLength(12);
    expect(skeleton.tools).toHaveLength(0);
    expect(skeleton.details).toHaveLength(0);
    expect(skeleton.hasOlder).toBe(false);
  } finally {
    db.close();
  }
});

test("the Feed skeleton keeps a queued or running turn fully loaded until it settles", () => {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  const conversationId = "live-skeleton";
  try {
    store.append({
      conversationId,
      eventId: "run_started",
      type: "run.started",
      turnId: "turn",
      runId: "run",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { status: "running" },
    });
    store.append({
      conversationId,
      eventId: "user",
      type: "message.created",
      turnId: "turn",
      runId: "run",
      messageId: "user",
      occurredAt: "2026-01-01T00:00:00.001Z",
      payload: { role: "user", channel: "answer", status: "final", body: "question" },
    });
    store.append({
      conversationId,
      eventId: "thinking",
      type: "message.created",
      turnId: "turn",
      runId: "run",
      messageId: "thinking",
      occurredAt: "2026-01-01T00:00:00.002Z",
      payload: { role: "assistant", channel: "thinking", status: "streaming", body: "thinking" },
    });
    store.append({
      conversationId,
      eventId: "answer",
      type: "message.created",
      turnId: "turn",
      runId: "run",
      messageId: "answer",
      occurredAt: "2026-01-01T00:00:00.003Z",
      payload: { role: "assistant", channel: "answer", status: "streaming", body: "answer" },
    });
    store.append({
      conversationId,
      eventId: "tool",
      type: "tool.started",
      runId: "run",
      toolCallId: "tool",
      occurredAt: "2026-01-01T00:00:00.004Z",
      payload: { name: "Read", input: { path: "file.txt" } },
    });
    store.append({
      conversationId,
      eventId: "detail",
      type: "detail.upserted",
      runId: "run",
      occurredAt: "2026-01-01T00:00:00.005Z",
      payload: { itemId: "detail", detailType: "note", content: "live detail" },
    });

    const live = store.feedWindow({ conversationId, skeleton: true });
    expect(live.messages.map((message) => message.messageId)).toEqual(["user", "thinking", "answer"]);
    expect(live.tools.map((tool) => tool.toolCallId)).toEqual(["tool"]);
    expect(live.tools[0]?.input).toEqual({ path: "file.txt" });
    expect(live.details.map((detail) => detail.itemId)).toEqual(["detail"]);
    expect(live.toolSummaryCounts).toEqual({ run: 1 });
    expect(live.toolPages.run).toEqual({ total: 1, hasOlder: false });

    const initial = installConversationV2Bootstrap(live);
    const liveState = boundConversationFeedState({
      ...initial,
      feedWindow: {
        mode: "latest",
        request: { conversationId, skeleton: true },
        toolPages: live.toolPages,
        skeleton: true,
      },
    });
    expect(liveState.messages.has("thinking")).toBe(true);
    expect(liveState.tools.has("tool")).toBe(true);
    expect(liveState.details.has("detail")).toBe(true);

    const completedState = boundConversationFeedState({
      ...liveState,
      runs: new Map(
        [...liveState.runs].map(([runId, run]) => [runId, { ...run, status: "completed" as const }]),
      ),
    });
    expect(completedState.messages.has("thinking")).toBe(false);
    expect(completedState.messages.has("answer")).toBe(true);
    expect(completedState.tools.size).toBe(0);
    expect(completedState.details.size).toBe(0);
    expect(completedState.toolSummaryCounts?.size).toBe(0);

    const hydrated = mergeConversationV2ToolPage(completedState, {
      protocolVersion: 2,
      storeEpoch: live.storeEpoch,
      conversationId,
      runId: "run",
      readSeq: live.snapshotSeq,
      historyRevision: live.historyRevision,
      tools: live.tools,
      details: live.details,
      totalCount: live.tools.length,
      hasMore: false,
    });
    const retainedHydrated = boundConversationFeedState(hydrated);
    expect(retainedHydrated.tools.has("tool")).toBe(true);
    expect(retainedHydrated.details.has("detail")).toBe(true);
  } finally {
    db.close();
  }
});

test("a finalized mid-turn user message without a run id stays visible before and after collapse", () => {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  const conversationId = "mid-turn-skeleton";
  try {
    store.append({
      conversationId,
      eventId: "run_started",
      type: "run.started",
      turnId: "run_turn",
      runId: "run",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { status: "running" },
    });
    store.append({
      conversationId,
      eventId: "initial_user",
      type: "message.created",
      turnId: "initial_turn",
      messageId: "initial_user",
      occurredAt: "2026-01-01T00:00:00.001Z",
      payload: { role: "user", channel: "answer", status: "final", body: "开始" },
    });
    store.append({
      conversationId,
      eventId: "before_steer",
      type: "message.created",
      turnId: "run_turn",
      runId: "run",
      messageId: "before_steer",
      occurredAt: "2026-01-01T00:00:00.002Z",
      payload: { role: "assistant", channel: "answer", status: "final", body: "插话前的输出" },
    });
    store.append({
      conversationId,
      eventId: "mid_turn_accept",
      type: "message.accepted",
      turnId: "mid_turn",
      messageId: "mid_turn",
      occurredAt: "2026-01-01T00:00:00.003Z",
      payload: { role: "user", channel: "answer", status: "queued", body: "中途补充要求" },
    });
    store.append({
      conversationId,
      eventId: "mid_turn_finalize",
      type: "message.finalized",
      messageId: "mid_turn",
      occurredAt: "2026-01-01T00:00:00.004Z",
      payload: { status: "final" },
    });
    store.append({
      conversationId,
      eventId: "after_steer",
      type: "message.created",
      turnId: "run_turn",
      runId: "run",
      messageId: "after_steer",
      occurredAt: "2026-01-01T00:00:00.005Z",
      payload: { role: "assistant", channel: "answer", status: "final", body: "插话后的输出" },
    });

    const live = store.feedWindow({ conversationId, skeleton: true });
    expect(live.messages.map((message) => message.messageId)).toEqual([
      "initial_user",
      "before_steer",
      "mid_turn",
      "after_steer",
    ]);
    expect(live.messages.find((message) => message.messageId === "mid_turn")?.runId).toBeUndefined();

    store.append({
      conversationId,
      eventId: "run_completed",
      type: "run.completed",
      turnId: "run_turn",
      runId: "run",
      occurredAt: "2026-01-01T00:00:00.006Z",
      payload: { status: "completed" },
    });
    const settled = store.feedWindow({ conversationId, skeleton: true });
    expect(settled.messages.map((message) => message.messageId)).toEqual([
      "initial_user",
      "mid_turn",
      "after_steer",
    ]);
  } finally {
    db.close();
  }
});

test("live message growth evicts old bodies without breaking verified sequence continuity", () => {
  const initial = installConversationV2Bootstrap({
    protocolVersion: 2,
    storeEpoch: "epoch",
    conversationId: "long",
    snapshotSeq: 0,
    historyRevision: 0,
    messages: [],
    runs: [],
    tools: [],
    turns: [],
    hasOlder: false,
  });
  let state = {
    ...initial,
    feedWindow: { mode: "latest" as const, request: { conversationId: "long" }, toolPages: {} },
  };
  for (let seq = 1; seq <= 300; seq++) {
    const effect = {
      type: "message.create" as const,
      message: {
        messageId: `m${seq}`,
        conversationId: "long",
        turnId: "turn",
        role: "assistant" as const,
        channel: "answer" as const,
        createdSeq: seq,
        versionSeq: seq,
        contentVersion: 0,
        body: "a".repeat(8000),
        status: "streaming" as const,
        isDeleted: false,
        occurredAt: new Date(1_700_000_000_000 + seq).toISOString(),
      },
    };
    state = applyConversationV2Effects(state, [
      { seq, effectVersion: 1, effectHash: stableHash(effect), effect },
    ]) as typeof state;
    expect(state.messages.size).toBeLessThanOrEqual(60);
  }
  expect(state.messages.has("m1")).toBe(false);
  expect(state.messages.has("m300")).toBe(true);
  expect(state.hasOlder).toBe(true);
  expect(state.olderCursor).toBeString();
  const late = {
    type: "message.append" as const,
    messageId: "m1",
    baseContentVersion: 0,
    nextContentVersion: 1,
    delta: "late",
    versionSeq: 301,
  };
  const next = applyConversationV2Effects(state, [
    { seq: 301, effectVersion: 1, effectHash: stableHash(late), effect: late },
  ]);
  expect(next.appliedSeq).toBe(301);
  expect(next.messages.has("m1")).toBe(false);
  expect(next.effectHashes.get(301)).toBe(stableHash(late));
  expect(boundConversationFeedState(initial)).toBe(initial);
});

test("background Feed payloads are filtered before IPC but clarification and lifecycle notifications survive", () => {
  const effect = { type: "message.append", delta: "large body" };
  const event = { conversationId: "long", effect: { effect } };
  expect(shouldDeliverFeedEvent("other", event)).toBe(false);
  expect(shouldDeliverFeedEvent("long", event)).toBe(true);
  expect(
    shouldDeliverFeedEvent(undefined, {
      conversationId: "long",
      effect: {
        effect: {
          type: "detail.upsert",
          detail: { type: "clarification.requested" },
        },
      },
    }),
  ).toBe(true);
  expect(shouldDeliverFeedEvent(undefined, { threadId: "long", type: "thread.completed" })).toBe(true);
  expect(shouldDeliverFeedEvent(undefined, { threadId: "long", stream: true })).toBe(false);
});

test("equal message timestamps retain the newest contiguous suffix, with usable replay and revision cursors", () => {
  const messages = Array.from({ length: 180 }, (_, i) => ({
    messageId: `m${i + 1}`,
    conversationId: "long",
    turnId: "turn",
    role: "assistant" as const,
    channel: "answer" as const,
    createdSeq: i + 1,
    versionSeq: i + 1,
    contentVersion: 0,
    body: "body",
    status: "final" as const,
    isDeleted: false,
    occurredAt: "2026-01-01T00:00:00Z",
  }));
  const source = installConversationV2Bootstrap({
    protocolVersion: 2,
    storeEpoch: "epoch",
    conversationId: "long",
    snapshotSeq: 180,
    historyRevision: 0,
    messages,
    runs: [],
    tools: [],
    turns: [],
    hasOlder: false,
  });
  const latest = replayFeedWindow(source, { conversationId: "long" });
  expect(latest.messages.map((message) => message.createdSeq).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 60 }, (_, i) => i + 121),
  );
  const older = replayFeedWindow(source, { conversationId: "long", beforeCursor: latest.olderCursor! });
  expect(older.messages.map((message) => message.createdSeq).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 60 }, (_, i) => i + 61),
  );
  let state = {
    ...installConversationV2Bootstrap(latest),
    feedWindow: { mode: "latest" as const, request: { conversationId: "long" }, toolPages: {} },
  };
  const effect = { type: "history.invalidation" as const, historyRevision: 1 };
  state = applyConversationV2Effects(state, [
    { seq: 181, effectVersion: 1, effectHash: stableHash(effect), effect },
  ]) as typeof state;
  expect(decodeConversationCursor(state.olderCursor!, "messages").historyRevision).toBe(1);
  const read = (request: Parameters<typeof replayFeedWindow>[1]) => {
    const snapshot = replayFeedWindow(source, request);
    return {
      ...installConversationV2Bootstrap(snapshot),
      feedWindow: {
        mode: "history" as const,
        request,
        toolPages: {},
        hasNewer: snapshot.hasNewer!,
        olderFeedCursor: snapshot.olderFeedCursor!,
        newerFeedCursor: snapshot.newerFeedCursor!,
      },
    };
  };
  for (const seq of [10, 100, 170])
    source.details.set(`compact${seq}`, {
      itemId: `compact${seq}`,
      conversationId: "long",
      runId: "run",
      type: "context.compaction.completed",
      createdSeq: seq,
      versionSeq: seq,
    });
  const head = read({ conversationId: "long", timeline: true });
  expect([...head.details.keys()]).toEqual(["compact170"]);
  const previous = read({
    conversationId: "long",
    timeline: true,
    beforeFeedCursor: head.feedWindow.olderFeedCursor,
  });
  const joined = mergeTimelineFeedWindow(head, previous, "older");
  expect([...joined.details.keys()].sort()).toEqual(["compact100", "compact170"]);
  expect(joined.messages.size).toBe(120);
  expect(joined.messages.has("m180")).toBe(true);
  expect(joined.feedWindow?.hasNewer).toBe(false);
  const oldest = read({
    conversationId: "long",
    timeline: true,
    beforeFeedCursor: joined.feedWindow!.olderFeedCursor!,
  });
  // A page request must retain the directional page as well as visible rows,
  // even when the projection places those rows at the opposite end.
  const held = mergeTimelineFeedWindow(joined, oldest, "older", new Set(["m:m121", "m:m180"]));
  expect(held.messages.size).toBeLessThanOrEqual(180);
  expect(held.messages.has("m1")).toBe(true);
  expect(held.messages.has("m180")).toBe(true);
  expect(held.feedWindow?.olderFeedCursor).toBeString();
  const partial = mergeTimelineFeedWindow(joined, oldest, "older", new Set(["m:m100", "m:m130"]));
  // The visible overlap keeps the current page plus one fetched page alive
  // until the reading anchor is restored; it is bounded and released on the
  // next directional merge.
  expect(partial.messages.size).toBeLessThanOrEqual(180);
  expect(partial.messages.has("m100")).toBe(true);
  expect(partial.messages.has("m130")).toBe(true);
  expect(partial.messages.has("m11")).toBe(true);
  expect(partial.messages.has("m1")).toBe(true);
  expect(partial.hasOlder).toBe(false);
  expect(partial.feedWindow?.hasNewer).toBe(true);
  const moved = mergeTimelineFeedWindow(joined, oldest, "older");
  expect([...moved.details.keys()].sort()).toEqual(["compact10", "compact100"]);
  expect(moved.messages.size).toBe(120);
  expect(moved.messages.has("m180")).toBe(false);
  expect(moved.messages.has("m1")).toBe(true);
  expect(moved.hasOlder).toBe(false);
  expect(moved.feedWindow?.hasNewer).toBe(true);
  const nextPage = read({
    conversationId: "long",
    timeline: true,
    afterFeedCursor: moved.feedWindow!.newerFeedCursor!,
  });
  const latestPage = { ...nextPage, feedWindow: { ...nextPage.feedWindow, mode: "latest" as const } };
  const heldAtOldEnd = mergeTimelineFeedWindow(moved, latestPage, "newer", new Set(["m:m1", "m:m90"]));
  expect(heldAtOldEnd.messages.size).toBeLessThanOrEqual(180);
  expect(heldAtOldEnd.messages.has("m1")).toBe(true);
  expect(heldAtOldEnd.messages.has("m180")).toBe(true);
  expect(heldAtOldEnd.feedWindow?.hasNewer).toBe(false);
  expect(heldAtOldEnd.feedWindow?.mode).toBe("latest");
  const returned = mergeTimelineFeedWindow(moved, latestPage, "newer");
  expect(returned.messages.size).toBe(120);
  expect(returned.messages.has("m180")).toBe(true);
  expect(returned.messages.has("m1")).toBe(false);
  expect(returned.feedWindow?.hasNewer).toBe(false);
  expect(returned.feedWindow?.mode).toBe("latest");
});

test("a stalled Feed event queue has byte and event limits and never silently accepts overflow", () => {
  const queue: Parameters<typeof appendFeedEffect>[0] = [];
  const effect = {
    seq: 1,
    effectVersion: 1,
    effectHash: "hash",
    effect: { type: "noop" as const, reason: "x".repeat(600000) },
  };
  expect(appendFeedEffect(queue, effect)).toBe(true);
  expect(appendFeedEffect(queue, { ...effect, seq: 2 })).toBe(false);
  expect(queue.length).toBe(1);
  const small: typeof queue = [];
  for (let seq = 1; seq <= 512; seq++)
    expect(appendFeedEffect(small, { ...effect, seq, effect: { type: "noop", reason: "small" } })).toBe(true);
  expect(appendFeedEffect(small, { ...effect, seq: 513 })).toBe(false);
  expect(small.length).toBe(512);
});
