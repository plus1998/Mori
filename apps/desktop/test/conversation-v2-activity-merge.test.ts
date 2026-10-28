import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import type {
  ConversationAgent,
  ConversationMessage,
  ConversationRun,
  ConversationToolCall,
} from "@eco/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveNonRewindRetryUserMessage } from "../src/main/conversation-nonrewind-retry-command";
import { appendLegacyThreadRunEventToConversationV2 } from "../src/main/conversation-v2-legacy-adapter";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import {
  ActivityLogView,
  ConversationV2ProjectionActivityLogView,
  buildConversationV2OnlyProjection,
  mergeConversationV2IntoProjection,
  mergeConversationV2MessagesIntoProjection,
} from "../src/renderer/ActivityLogView";
import type { ThreadRunProjectionMainFeedEntry } from "../src/renderer/conversation-v2-projection-view";
import {
  buildThreadRunProjectionViewModel,
  projectionItemToDetailBlock,
} from "../src/renderer/conversation-v2-projection-view";
import type { ConversationV2RendererState } from "../src/renderer/conversation-v2-renderer-state";
import { buildThreadRunTurnFeedSections } from "../src/renderer/conversation-v2-turn-feed";
import {
  buildRequestFailureRetryTargets,
  isRetryableRequestFailureItem,
} from "../src/renderer/request-failure-retry";
import type { ThreadRunProjectionSnapshot, ThreadRunProjectionTimelineItem } from "../src/shared/ipc";
import { buildCodexAsyncQuestionReplyText } from "../src/shared/codex-async-questions";

function message(messageId: string, createdSeq: number): ConversationMessage {
  return {
    messageId,
    conversationId: "thread_merge",
    turnId: `turn_${createdSeq}`,
    role: "user",
    channel: "answer",
    createdSeq,
    versionSeq: createdSeq,
    contentVersion: 0,
    body: "same prompt",
    status: "final",
    isDeleted: false,
  };
}

function queuedMessage(messageId: string, createdSeq: number): ConversationMessage {
  return {
    ...message(messageId, createdSeq),
    status: "queued",
  };
}

function legacyUserItem(id: string, sequence: number): ThreadRunProjectionTimelineItem {
  return {
    id,
    sequence,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    text: "same prompt",
    at: `2026-09-14T00:00:0${sequence}.000Z`,
    metadata: { liveType: "thread.user_prompt" },
  };
}

function legacyAssistantItem(
  id: string,
  sequence: number,
  runAttemptId = "run_1",
): ThreadRunProjectionTimelineItem {
  return {
    id,
    sequence,
    eventType: "message.final",
    scope: "agent",
    role: "assistant",
    text: id,
    at: `2026-09-14T00:00:0${sequence}.000Z`,
    runAttemptId,
    metadata: {},
  };
}

function v2State(
  messages: ConversationMessage[],
  runs: ConversationRun[] = [],
  tools: ConversationToolCall[] = [],
  agents: ConversationAgent[] = [],
): ConversationV2RendererState {
  return {
    conversationId: "thread_merge",
    storeEpoch: "epoch_1",
    appliedSeq: 2,
    historyRevision: 0,
    messages: new Map(messages.map((value) => [value.messageId, value])),
    runs: new Map(runs.map((value) => [value.runId, value])),
    agents: new Map(agents.map((value) => [value.agentId, value])),
    tools: new Map(tools.map((value) => [value.toolCallId, value])),
    details: new Map(),
    effectHashes: new Map(),
    // The renderer state is read through the production paging path in the app; this
    // helper hands the projection one window, which is all these tests need.
    hasOlder: false,
  };
}

function projection(timeline: ThreadRunProjectionTimelineItem[]): ThreadRunProjectionSnapshot {
  return {
    thread: {
      threadId: "thread_merge",
      status: "completed",
      generatedAt: "2026-09-14T00:00:00.000Z",
    },
    attempts: [],
    agents: [],
    requestSpans: [],
    timeline,
    diagnostics: [],
    sourceEventCount: timeline.length,
  };
}

test("V2 Feed retry identities resolve before and after provider user-message binding", () => {
  for (const coreKind of ["codex", "acp"] as const) {
    for (const bound of [false, true]) {
      const db = new DatabaseSync(":memory:");
      const store = new ConversationV2Store(db);
      store.initialize();
      store.append({
        conversationId: "thread_merge",
        eventId: "user_created",
        type: "message.created",
        occurredAt: "2026-10-03T00:00:00.000Z",
        turnId: "turn_retry",
        messageId: "local_user",
        payload: {
          role: "user",
          body: "retry this request",
          status: "final",
          ...(bound
            ? { historyTarget: { activityLineId: "sdk:provider_user", userMessageId: "provider_user" } }
            : {}),
        },
      });
      store.append({
        conversationId: "thread_merge",
        eventId: "capacity_notice",
        type: "message.created",
        occurredAt: "2026-10-03T00:00:01.000Z",
        turnId: "turn_retry",
        messageId: "capacity_error",
        payload: {
          role: "system",
          channel: "system",
          body: "Selected model is at capacity. Please try a different model.",
          status: "final",
        },
      });
      const user = store.getMessage("thread_merge", "local_user");
      const notice = store.getMessage("thread_merge", "capacity_error");
      if (!user || !notice) throw new Error("Missing persisted retry fixture messages.");
      const projection = buildConversationV2OnlyProjection(v2State([user, notice]), { status: "failed" });
      const targets = buildRequestFailureRetryTargets({
        coreKind,
        threadStatus: "failed",
        items: projection.timeline,
      });
      const target = targets.get("conversation-v2:capacity_error");
      if (!target) throw new Error("Missing capacity-error retry target.");
      expect(target).toMatchObject({ activityLineId: "local_user", prompt: "retry this request" });
      expect(
        resolveNonRewindRetryUserMessage(store, "thread_merge", target.activityLineId, coreKind === "codex"),
      ).toEqual(user);
      if (bound) {
        expect(
          resolveNonRewindRetryUserMessage(store, "thread_merge", "sdk:provider_user", coreKind === "codex"),
        ).toEqual(user);
      }
      db.close();
    }
  }
});

test("V2-only runtime write failures retain their Feed error title without a provider row", () => {
  const errorMessage: ConversationMessage = {
    ...message("runtime-error", 2),
    role: "system",
    channel: "system",
    providerRole: "eco_runtime_error",
    body: "记录 agent.stopped 事件失败：Agent child changed identity or ownership.",
  };
  const merged = mergeConversationV2MessagesIntoProjection(projection([]), v2State([errorMessage]));
  const item = merged.timeline[0];
  expect(item).toBeDefined();
  expect(projectionItemToDetailBlock(item!)).toMatchObject({
    kind: "api-error",
    title: "会话事件记录失败",
    message: errorMessage.body,
  });
  expect(isRetryableRequestFailureItem(item!)).toBe(false);
  const html = renderToStaticMarkup(
    createElement(ActivityLogView, { conversationV2: v2State([errorMessage]) }),
  );
  expect(html).toContain("会话事件记录失败");
  expect(html).toContain("Agent child changed identity or ownership");
});

test("does not render an accepted queued follow-up as a sent user message", () => {
  const queued = queuedMessage("queued_follow_up", 3);
  const merged = mergeConversationV2MessagesIntoProjection(projection([]), v2State([queued]));

  expect(merged.timeline).toEqual([]);
  expect(
    renderToStaticMarkup(createElement(ActivityLogView, { conversationV2: v2State([queued]) })),
  ).not.toContain("same prompt");
});

test("renders the follow-up after its accepted message is finalized", () => {
  const finalized = message("queued_follow_up", 3);
  const merged = mergeConversationV2MessagesIntoProjection(projection([]), v2State([finalized]));

  expect(merged.timeline.map((item) => item.text)).toEqual(["same prompt"]);
});

test("native history and V2 approval feedback render a card while retaining the model envelope", () => {
  const wireText = [
    "The user rejected the preceding Bash approval.",
    "User feedback: 你要查什么给我语句查\n保留 <原文> & 换行",
    "Do not retry the rejected request unless the user explicitly asks for it again.",
  ].join("\n");
  const state = v2State([{ ...message("approval-feedback", 1), body: wireText }]);
  const native = projection([{ ...legacyUserItem("sdk:approval-feedback", 1), text: wireText }]);
  for (const element of [
    createElement(ActivityLogView, { conversationV2: state }),
    createElement(ConversationV2ProjectionActivityLogView, { projection: native }),
  ]) {
    const html = renderToStaticMarkup(element);
    expect(html).toContain("approval-feedback-card");
    expect(html).toContain("你要查什么给我语句查\n保留 &lt;原文&gt; &amp; 换行");
    expect(html).not.toContain("The user rejected");
    expect(html).not.toContain("Do not retry");
  }
  expect(state.messages.get("approval-feedback")?.body).toBe(wireText);
});

test("native history and V2 async answer messages render answer cards without showing the wire envelope", () => {
  const wireText = buildCodexAsyncQuestionReplyText([
    { questionItemId: "q1", question: "处理方式？", answer: "保留记录\n保留 <原始内容> & 换行" },
    { questionItemId: "q2", question: "何时执行？", answer: "下周" },
  ]);
  const state = v2State([{ ...message("async-answer", 1), body: wireText }]);
  const native = projection([{ ...legacyUserItem("sdk:async-answer", 1), text: wireText }]);
  for (const element of [
    createElement(ActivityLogView, { conversationV2: state }),
    createElement(ConversationV2ProjectionActivityLogView, { projection: native }),
  ]) {
    const html = renderToStaticMarkup(element);
    expect(html).toContain("clarification-answer-card--user");
    expect(html).toContain("处理方式？");
    expect(html).toContain("保留记录\n保留 &lt;原始内容&gt; &amp; 换行");
    expect(html).toContain("何时执行？");
    expect(html).toContain("下周");
    expect(html).not.toContain("send_user_message_question_reply");
    expect(html).not.toContain("questionItemId");
  }
  expect(state.messages.get("async-answer")?.body).toBe(wireText);
  expect(native.timeline[0]?.text).toBe(wireText);
});

test("places a finalized queued follow-up after the turn that accepted it", () => {
  const firstAnswer: ConversationMessage = {
    ...message("first_answer", 5),
    role: "assistant",
    body: "第一轮回答",
    versionSeq: 5,
    occurredAt: "2026-09-14T00:00:05.000Z",
  };
  const finalizedQueued: ConversationMessage = {
    ...queuedMessage("queued_follow_up", 3),
    status: "final",
    versionSeq: 8,
    body: "第二轮问题",
    occurredAt: "2026-09-14T00:00:08.000Z",
  };
  const onlyV2 = buildConversationV2OnlyProjection(v2State([firstAnswer, finalizedQueued]), {
    createdAt: "2026-09-14T00:00:00.000Z",
    status: "completed",
  });

  expect(onlyV2.timeline.map((item) => item.text)).toEqual(["第一轮回答", "第二轮问题"]);
});

test("keeps a directly accepted continuation out of the Feed until finalization", () => {
  const queued = queuedMessage("direct_continuation", 3);
  const projection = buildConversationV2OnlyProjection(v2State([queued]), {
    createdAt: "2026-09-14T00:00:00.000Z",
    status: "completed",
  });

  expect(projection.timeline).toEqual([]);
});

test("keeps two user prompts that say the same thing as two rows", () => {
  // A reader who sends the same short message twice ("继续" again) wrote two prompts; the log
  // holds two V2 messages and both turns have to be in the Feed. The redundancy rule that
  // drops echoed assistant speech must not read a prompt as an answer: in the V2 read model a
  // prompt carries the same event type an answer does.
  const state = v2State([message("message_1", 1), message("message_2", 2)]);
  const viewModel = buildThreadRunProjectionViewModel(
    buildConversationV2OnlyProjection(state, {
      createdAt: "2026-09-14T00:00:00.000Z",
      status: "completed",
    }),
    { id: "thread_merge", prompt: "same prompt" },
  );
  const rows = viewModel.mainFeedEntries.flatMap((entry) =>
    entry.kind === "timeline" && entry.item.role === "user" ? [entry.item.text] : [],
  );
  expect(rows).toEqual(["same prompt", "same prompt"]);
});

test("does not infer V2 user-message identity from equal body text", () => {
  const merged = mergeConversationV2MessagesIntoProjection(
    projection([legacyUserItem("legacy_1", 1), legacyUserItem("legacy_2", 2)]),
    v2State([message("message_1", 1), message("message_2", 2)]),
  );

  expect(merged.timeline.filter((item) => item.id.startsWith("legacy_")).map((item) => item.id)).toEqual([
    "legacy_1",
    "legacy_2",
  ]);
  expect(
    merged.timeline.filter((item) => item.id.startsWith("conversation-v2:")).map((item) => item.id),
  ).toEqual(["conversation-v2:message_1", "conversation-v2:message_2"]);
});

test("uses an explicit V2 message id to remove only its legacy row", () => {
  const first = legacyUserItem("legacy_1", 1);
  first.metadata = { ...first.metadata, conversationV2MessageId: "message_1" };
  const merged = mergeConversationV2MessagesIntoProjection(
    projection([first, legacyUserItem("legacy_2", 2)]),
    v2State([message("message_1", 1), message("message_2", 2)]),
  );

  expect(merged.timeline.map((item) => item.id)).toEqual([
    "conversation-v2:message_1",
    "legacy_2",
    "conversation-v2:message_2",
  ]);
});

test("keeps an explicitly bound user message above a later agent row", () => {
  const user = legacyUserItem("legacy_user", 1);
  user.metadata = { ...user.metadata, conversationV2MessageId: "message_1" };
  const merged = mergeConversationV2MessagesIntoProjection(
    projection([user, legacyAssistantItem("legacy_agent", 2)]),
    v2State([message("message_1", 1)]),
  );

  expect(merged.timeline.map((item) => item.id)).toEqual(["conversation-v2:message_1", "legacy_agent"]);
});

test("places an unanchored user message before a later legacy agent row", () => {
  const merged = mergeConversationV2MessagesIntoProjection(
    projection([legacyAssistantItem("legacy_agent", 2)]),
    v2State([message("message_1", 1)]),
  );

  expect(merged.timeline.map((item) => item.id)).toEqual(["conversation-v2:message_1", "legacy_agent"]);
});

test("does not remove an unmapped message from the same run and channel", () => {
  const mapped = legacyAssistantItem("legacy_mapped", 1);
  mapped.metadata = { conversationV2MessageId: "message_1" };
  const unmapped = legacyAssistantItem("legacy_unmapped", 2);
  const merged = mergeConversationV2MessagesIntoProjection(
    projection([mapped, unmapped]),
    v2State([
      { ...message("message_1", 1), role: "assistant", runId: "run_1" },
      { ...message("message_2", 2), role: "assistant", runId: "run_1" },
    ]),
  );

  expect(merged.timeline.map((item) => item.id)).toEqual([
    "conversation-v2:message_1",
    "legacy_unmapped",
    "conversation-v2:message_2",
  ]);
});

test("renders a V2 message when the legacy projection is unavailable", () => {
  const html = renderToStaticMarkup(
    createElement(ActivityLogView, {
      conversationV2: v2State([message("message_1", 1)]),
    }),
  );

  expect(html).toContain("same prompt");
  expect(html).not.toContain("run-log-projection-loading");
});

test("renders V2 running execution and tool state when the legacy projection is empty", () => {
  const run: ConversationRun = {
    runId: "run_live",
    conversationId: "thread_merge",
    turnId: "turn_live",
    status: "running",
    startedAt: "2026-09-14T00:00:01.000Z",
    versionSeq: 2,
    timingQuality: "recorded",
  };
  const tool: ConversationToolCall = {
    toolCallId: "tool_live",
    conversationId: "thread_merge",
    runId: run.runId,
    name: "mcp__eco__inspect",
    status: "running",
    createdSeq: 3,
    versionSeq: 3,
  };

  const html = renderToStaticMarkup(
    createElement(ActivityLogView, {
      conversationV2: v2State([], [run], [tool]),
    }),
  );

  expect(html).toContain("处理中");
  expect(html).toContain("正在调用 eco · inspect");
  expect(html).toContain("run-log-shimmer-text");
  expect(html).not.toContain("run-log-projection-loading");
  expect(html).not.toContain("正在思考");
});

test("a conflicting terminal V2 run cannot overwrite the attempt that settled it", () => {
  const base = projection([legacyAssistantItem("legacy_final", 1)]);
  base.attempts = [
    {
      attemptId: "run_1",
      phase: "initial",
      retryIndex: 0,
      status: "failed",
      startedAt: "2026-09-16T09:41:36.822Z",
      endedAt: "2026-09-16T09:57:27.208Z",
    },
  ];
  const run: ConversationRun = {
    runId: "run_1",
    conversationId: "thread_merge",
    turnId: "run_1",
    status: "completed",
    startedAt: "2026-09-16T09:41:36.822Z",
    endedAt: "2026-09-16T09:41:47.944Z",
    versionSeq: 2,
    timingQuality: "unknown",
  };

  const merged = mergeConversationV2IntoProjection(base, v2State([], [run]));

  // Only a stale mirror can disagree with the attempt lifecycle on how a run
  // ended, so the attempt keeps its own verdict and duration.
  expect(merged.attempts[0]).toMatchObject({
    attemptId: "run_1",
    status: "failed",
    startedAt: "2026-09-16T09:41:36.822Z",
    endedAt: "2026-09-16T09:57:27.208Z",
  });
});

test("V2 terminal tool state upgrades its legacy row without duplicating it", () => {
  const legacy = legacyAssistantItem("tool_started", 1);
  legacy.eventType = "tool.started";
  legacy.role = "tool";
  legacy.text = "Tool: Read";
  legacy.metadata = {
    tool: {
      name: "Read",
      toolUseId: "tool_1",
      status: "started",
    },
  };
  const run: ConversationRun = {
    runId: "run_1",
    conversationId: "thread_merge",
    turnId: "turn_1",
    status: "completed",
    startedAt: "2026-09-14T00:00:00.000Z",
    endedAt: "2026-09-14T00:00:02.000Z",
    versionSeq: 3,
    timingQuality: "recorded",
  };
  const tool: ConversationToolCall = {
    toolCallId: "tool_1",
    conversationId: "thread_merge",
    runId: run.runId,
    name: "Read",
    status: "completed",
    createdSeq: 1,
    versionSeq: 2,
  };

  const merged = mergeConversationV2IntoProjection(projection([legacy]), v2State([], [run], [tool]));

  expect(merged.timeline).toHaveLength(1);
  expect(merged.timeline[0]?.eventType).toBe("tool.completed");
  expect(merged.timeline[0]?.metadata?.tool).toMatchObject({
    toolUseId: "tool_1",
    status: "completed",
  });
  expect(merged.attempts).toHaveLength(1);
  expect(merged.attempts[0]?.status).toBe("completed");
});

test("V2 tool input keeps the rich desktop presentation metadata", () => {
  const edit: ConversationToolCall = {
    toolCallId: "tool_edit",
    conversationId: "thread_merge",
    runId: "run_1",
    name: "Edit",
    status: "completed",
    createdSeq: 1,
    versionSeq: 2,
    input: {
      file_path: "/workspace/src/app.ts",
      old_string: "old()",
      new_string: "new()",
    },
  };
  const search: ConversationToolCall = {
    toolCallId: "tool_search",
    conversationId: "thread_merge",
    runId: "run_1",
    name: "WebSearch",
    status: "completed",
    createdSeq: 3,
    versionSeq: 4,
    input: {
      query: "conversation v2 mobile parity",
      mode: "search",
      provider: "brave",
    },
    output: { results: [{ title: "Result", url: "https://example.com" }] },
  };

  const merged = mergeConversationV2IntoProjection(projection([]), v2State([], [], [edit, search]));

  expect(merged.timeline).toHaveLength(2);
  expect(merged.timeline[0]?.metadata?.tool).toMatchObject({
    name: "Edit",
    detail: "/workspace/src/app.ts",
    fileChange: { path: "/workspace/src/app.ts" },
  });
  expect(merged.timeline[1]?.metadata?.tool).toMatchObject({
    name: "WebSearch",
    detail: "conversation v2 mobile parity",
    webSearch: {
      query: "conversation v2 mobile parity",
      mode: "search",
      provider: "brave",
    },
    outputPreview: '{"results":[{"title":"Result","url":"https://example.com"}]}',
  });
});

function assistantMessage(messageId: string, createdSeq: number, body: string): ConversationMessage {
  return {
    ...message(messageId, createdSeq),
    role: "assistant",
    runId: "run_1",
    body,
  };
}

function feedEntryMessageId(entry: ThreadRunProjectionMainFeedEntry): string | undefined {
  if (entry.kind !== "timeline") return undefined;
  const messageId = entry.item.metadata?.conversationV2MessageId;
  return typeof messageId === "string" ? messageId : undefined;
}

test("SDK state notices neither render a request failure nor replace the final answer", () => {
  const answer = { ...assistantMessage("real-answer", 2, "ECO_289_FIXED_BASH"), providerRole: "main" };
  const notice: ConversationMessage = {
    ...message("idle-notice", 3),
    role: "system",
    channel: "commentary",
    runId: "run_1",
    body: "Session state: idle",
  };
  const state = v2State([answer, notice]);
  const base = projection([]);
  base.attempts = [
    {
      attemptId: "run_1",
      phase: "initial",
      retryIndex: 0,
      status: "completed",
      startedAt: "2026-09-16T09:19:40.332Z",
      endedAt: "2026-09-16T09:40:57.629Z",
    },
  ];
  const merged = mergeConversationV2IntoProjection(base, state);
  expect(merged.timeline.every((item) => item.eventType !== "api.error")).toBe(true);
  expect(merged.agents).toHaveLength(0);
  const sections = buildThreadRunTurnFeedSections(
    buildThreadRunProjectionViewModel(merged).mainFeedEntries,
    merged,
  );
  const turn = sections.find((section) => section.kind === "turn");
  if (turn?.kind !== "turn") throw new Error("Missing completed turn");
  expect(feedEntryMessageId(turn.finalEntry!)).toBe("real-answer");
  const html = renderToStaticMarkup(createElement(ActivityLogView, { conversationV2: state }));
  expect(html).toContain("ECO_289_FIXED_BASH");
  expect(html).not.toContain("连接失败");
});

test("keeps the V2 order of a turn whose narrative rows left the feed skeleton", () => {
  // The desktop feed skeleton keeps one narrative row per finished segment, so the
  // turn's other messages reach the renderer only through V2 and have no legacy row
  // to anchor to. Their V2 order is what the Feed must show.
  const prompt = legacyUserItem("legacy_prompt", 10);
  prompt.at = "2026-09-16T09:19:38.903Z";
  const keptFinal = legacyAssistantItem("legacy_kept_final", 20);
  keptFinal.scope = "main";
  keptFinal.at = "2026-09-16T09:40:56.925Z";
  keptFinal.metadata = { conversationV2MessageId: "legacy_message_aabbcc03" };
  const base = projection([prompt, keptFinal]);
  base.attempts = [
    {
      attemptId: "run_1",
      phase: "initial",
      retryIndex: 0,
      status: "completed",
      startedAt: "2026-09-16T09:19:40.332Z",
      endedAt: "2026-09-16T09:40:57.629Z",
    },
  ];
  const merged = mergeConversationV2IntoProjection(
    base,
    v2State([
      assistantMessage("legacy_message_c0ffee01", 101, "first"),
      assistantMessage("legacy_message_00beef02", 102, "second"),
      assistantMessage("legacy_message_aabbcc03", 103, "final"),
    ]),
  );
  const viewModel = buildThreadRunProjectionViewModel(merged);
  const sections = buildThreadRunTurnFeedSections(viewModel.mainFeedEntries, merged);
  const turn = sections.find((section) => section.kind === "turn");
  if (turn?.kind !== "turn") {
    throw new Error("expected the merged feed to keep one turn section");
  }

  expect(turn.processEntries.map(feedEntryMessageId)).toEqual([
    "legacy_message_c0ffee01",
    "legacy_message_00beef02",
  ]);
  // The turn's last message stays its final output: with every message collapsed
  // onto one position the feed ordered them by message id instead.
  expect(feedEntryMessageId(turn.finalEntry!)).toBe("legacy_message_aabbcc03");
});

function feedEntryItemIds(entry: ThreadRunProjectionMainFeedEntry): string[] {
  if (entry.kind === "tool-group") {
    return entry.entries.flatMap(feedEntryItemIds);
  }
  return entry.kind === "timeline" || entry.kind === "agent-echo" ? [entry.item.id] : [];
}

test("keeps a V2 tool of a finished turn inside that turn", () => {
  // The feed skeleton drops a finished turn's tool rows, and V2 stores no
  // timestamps, so an unanchored tool used to be stamped with `generatedAt`:
  // every tool of every turn piled onto the bottom of the feed as extra turns.
  const prompt = legacyUserItem("legacy_prompt", 10);
  prompt.at = "2026-09-14T00:00:01.000Z";
  const keptFinal = legacyAssistantItem("legacy_kept_final", 20);
  keptFinal.scope = "main";
  keptFinal.at = "2026-09-14T00:00:20.000Z";
  const base = projection([prompt, keptFinal]);
  base.thread.generatedAt = "2026-09-14T02:00:00.000Z";
  base.attempts = [
    {
      attemptId: "run_1",
      phase: "initial",
      retryIndex: 0,
      status: "completed",
      startedAt: "2026-09-14T00:00:05.000Z",
      endedAt: "2026-09-14T00:00:30.000Z",
    },
  ];
  const tool: ConversationToolCall = {
    toolCallId: "tool_1",
    conversationId: "thread_merge",
    runId: "run_1",
    name: "Bash",
    status: "completed",
    createdSeq: 15,
    versionSeq: 15,
    input: { command: "npm test" },
  };

  const merged = mergeConversationV2IntoProjection(base, v2State([], [], [tool]));

  const toolItem = merged.timeline.find((item) => item.id === "conversation-v2:tool:tool_1");
  expect(toolItem?.at).toBe("2026-09-14T00:00:30.000Z");
  // Just after the row the run kept, not after everything else in the feed.
  expect(toolItem?.sequence).toBe(21);

  const sections = buildThreadRunTurnFeedSections(
    buildThreadRunProjectionViewModel(merged).mainFeedEntries,
    merged,
  );
  expect(sections.filter((section) => section.kind === "turn")).toHaveLength(1);
  const turn = sections.find((section) => section.kind === "turn");
  if (turn?.kind !== "turn") {
    throw new Error("expected the merged feed to keep one turn section");
  }
  expect(
    [...turn.processEntries, ...(turn.finalEntry ? [turn.finalEntry] : [])].flatMap(feedEntryItemIds),
  ).toContain("conversation-v2:tool:tool_1");
});

function subagentMessage(messageId: string, createdSeq: number, agentId: string): ConversationMessage {
  return {
    ...assistantMessage(messageId, createdSeq, "辅助模型已允许 Grep：/repo"),
    agentId,
    agentInstanceId: agentId,
  };
}

function projectionWithAgent(
  timeline: ThreadRunProjectionTimelineItem[],
  agentId: string,
): ThreadRunProjectionSnapshot {
  const base = projection(timeline);
  return {
    ...base,
    agents: [
      {
        agentId,
        role: "main",
        kind: "main",
        status: "completed",
        startedAt: "2026-09-14T00:00:00.000Z",
        durationMs: 1_000,
        timeline: [],
      },
    ],
  };
}

test("routes a subagent's V2 narration to its agent card instead of the main feed", () => {
  const owner = "main:attempt_execution_1";
  const merged = mergeConversationV2MessagesIntoProjection(
    projectionWithAgent([legacyUserItem("legacy_user", 1)], owner),
    v2State([message("message_1", 1), subagentMessage("message_agent", 2, owner)]),
  );

  expect(merged.timeline.map((item) => item.id)).not.toContain("conversation-v2:message_agent");
  const [cardItem] = merged.agents[0]?.timeline ?? [];
  expect(cardItem?.id).toBe("conversation-v2:message_agent");
  expect(cardItem?.scope).toBe("agent");
  expect(cardItem?.agentId).toBe(owner);
});

test("keeps complete V2 message and tool ownership facts in the agent Feed projection", () => {
  const owner = "agent_instance_1";
  const state = v2State(
    [
      {
        messageId: "message_agent_facts",
        conversationId: "thread_merge",
        turnId: "turn_1",
        runId: "run_1",
        role: "assistant",
        channel: "answer",
        createdSeq: 7,
        versionSeq: 9,
        contentVersion: 2,
        body: "agent answer",
        agentId: owner,
        agentInstanceId: owner,
        occurredAt: "2026-09-14T00:00:07.000Z",
        providerRole: "coder",
        status: "final",
        isDeleted: false,
      },
    ],
    [],
    [
      {
        toolCallId: "tool_agent_facts",
        conversationId: "thread_merge",
        runId: "run_1",
        agentId: owner,
        agentInstanceId: owner,
        parentAgentInstanceId: "parent_agent_1",
        parentToolCallId: "parent_tool_1",
        name: "Bash",
        status: "completed",
        createdSeq: 5,
        versionSeq: 6,
        occurredAt: "2026-09-14T00:00:05.000Z",
        providerRole: "coder",
        input: { command: "bun test" },
        output: { exitCode: 0 },
      },
    ],
    [
      {
        agentId: owner,
        conversationId: "thread_merge",
        role: "coder",
        kind: "subagent",
        status: "completed",
        versionSeq: 10,
      },
    ],
  );

  const projection = buildConversationV2OnlyProjection(state, {
    createdAt: "2026-09-14T00:00:00.000Z",
    status: "completed",
  });
  expect(projection.timeline).toEqual([]);
  const rows = projection.agents[0]?.timeline ?? [];
  expect(rows.map((row) => row.id)).toEqual([
    "conversation-v2:tool:tool_agent_facts",
    "conversation-v2:message_agent_facts",
  ]);
  const [tool, messageRow] = rows;
  expect({ scope: tool?.scope, agentId: tool?.agentId, role: tool?.role }).toEqual({
    scope: "agent",
    agentId: owner,
    role: "coder",
  });
  expect(tool?.metadata).toEqual({
    liveType: "tool.completed",
    conversationV2ToolCallId: "tool_agent_facts",
    conversationV2VersionSeq: 6,
    conversationV2AgentInstanceId: owner,
    conversationV2ParentAgentInstanceId: "parent_agent_1",
    conversationV2ParentToolCallId: "parent_tool_1",
    tool: {
      name: "Bash",
      toolUseId: "tool_agent_facts",
      status: "completed",
      detail: "bun test",
      outputPreview: '{"exitCode":0}',
    },
  });
  expect({
    scope: messageRow?.scope,
    agentId: messageRow?.agentId,
    role: messageRow?.role,
    streamKey: messageRow?.streamKey,
    metadata: messageRow?.metadata,
  }).toEqual({
    scope: "agent",
    agentId: owner,
    role: "coder",
    streamKey: "message_agent_facts",
    metadata: {
      conversationV2MessageId: "message_agent_facts",
      conversationV2TurnId: "turn_1",
      conversationV2VersionSeq: 9,
      conversationV2ContentVersion: 2,
      conversationV2Channel: "answer",
      conversationV2Status: "final",
      conversationV2AgentInstanceId: owner,
      logicalEntityId: "message_agent_facts",
    },
  });
});

test("keeps a subagent message in the main feed when no agent card can hold it", () => {
  const merged = mergeConversationV2MessagesIntoProjection(
    projection([legacyUserItem("legacy_user", 1)]),
    v2State([subagentMessage("message_orphan", 2, "main:missing_card")]),
  );

  const orphan = merged.timeline.find((item) => item.id === "conversation-v2:message_orphan");
  expect(orphan?.scope).toBe("main");
});

test("an image-view failure stays visible without inventing a running subagent", () => {
  const owner = "image_view:thread_merge:failed_request";
  const failure: ConversationMessage = {
    ...message("image_failure", 2),
    role: "system",
    channel: "system",
    providerRole: "vision",
    agentId: owner,
    agentInstanceId: owner,
    body: "【连接失败】HTTP 400：upstream unavailable",
  };
  const projection = buildConversationV2OnlyProjection(v2State([failure]), {
    createdAt: "2026-09-14T00:00:00.000Z",
    status: "completed",
  });
  expect(projection.agents).toEqual([]);
  expect(projection.timeline).toHaveLength(1);
  expect(projection.timeline[0]).toMatchObject({
    scope: "main",
    agentId: owner,
    text: failure.body,
  });
  expect(buildThreadRunProjectionViewModel(projection).subagentCards).toEqual([]);
  const html = renderToStaticMarkup(createElement(ActivityLogView, { conversationV2: v2State([failure]) }));
  expect(html).toContain("连接失败 · HTTP 400");
  expect(html).not.toContain("subagent-run-row-wrap");
});

test("an unregistered tool owner does not create an agent card or hide the tool", () => {
  const projection = buildConversationV2OnlyProjection(
    v2State(
      [],
      [],
      [
        {
          toolCallId: "unregistered_tool",
          conversationId: "thread_merge",
          runId: "run_1",
          agentId: "unregistered_owner",
          name: "Bash",
          status: "completed",
          createdSeq: 2,
          versionSeq: 3,
          input: { command: "bun test" },
        },
      ],
    ),
  );
  expect(projection.agents).toEqual([]);
  expect(projection.timeline).toHaveLength(1);
  expect(projection.timeline[0]).toMatchObject({
    scope: "main",
    agentId: "unregistered_owner",
    metadata: { tool: { name: "Bash", toolUseId: "unregistered_tool" } },
  });
});

test("a legacy subagent row keeps its owner from the adapter to the agent card", () => {
  // The whole pipeline, not just one layer: legacy row → V2 event → read model →
  // renderer merge. A layer that drops the agent identity makes a subagent's
  // narration show up in the main Feed, which is what this test exists to catch.
  const store = new ConversationV2Store(new DatabaseSync(":memory:"));
  store.initialize();
  appendLegacyThreadRunEventToConversationV2(store, {
    id: "legacy_agent_event",
    threadId: "thread_merge",
    sequence: 5,
    eventType: "message.final",
    scope: "agent",
    streamState: "finalized",
    message: "辅助模型已允许 Grep：/repo",
    observedAt: "2026-09-14T00:00:05.000Z",
    role: "coder",
    agentId: "main:attempt_1",
    runAttemptId: "attempt_1",
    streamKey: "answer_agent",
  });
  const stored = store.bootstrap("thread_merge").messages[0];
  expect(stored).toMatchObject({
    agentId: "main:attempt_1",
    agentInstanceId: "main:attempt_1",
  });

  const merged = mergeConversationV2MessagesIntoProjection(
    projectionWithAgent([legacyUserItem("legacy_user", 1)], "main:attempt_1"),
    v2State([stored as ConversationMessage]),
  );
  expect(merged.timeline.map((item) => item.id)).not.toContain(`conversation-v2:${stored?.messageId}`);
  expect(merged.agents[0]?.timeline.map((item) => item.id)).toEqual([`conversation-v2:${stored?.messageId}`]);
});
