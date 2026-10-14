import { expect, test } from "bun:test";
import type { ConversationSyncEffect } from "@eco/shared";
import {
  getPendingClarificationByToolUseId,
  getPendingClarificationForThread,
  registerPendingClarification,
  submitClarification,
} from "../src/main/clarification-bridge";
import { createClarificationNotifications } from "../src/renderer/clarification-notifications";
import { createClarificationQueueSync } from "../src/renderer/clarification-queue-sync";
import type { ClarificationRequest, ThreadLiveEvent } from "../src/shared/ipc";
import { buildThreadClarificationNotificationContent } from "../src/shared/thread-completion-notification";

function detail(toolUseId: string, type = "clarification.requested"): ConversationSyncEffect["effect"] {
  return {
    type: "detail.upsert",
    detail: {
      itemId: `detail-${toolUseId}-${type}`,
      conversationId: "thread-1",
      runId: "run-1",
      toolCallId: toolUseId,
      type,
      createdSeq: 1,
      versionSeq: 1,
    },
  };
}

function live(toolUseId: string, type = "clarification.requested"): ThreadLiveEvent {
  return {
    threadId: "thread-1",
    type,
    message: "需要回答",
    clarification: { threadId: "thread-1", toolUseId, questions: [{ question: "选什么？", options: [] }] },
  };
}

function harness() {
  const refreshed: string[] = [];
  const notifications: Array<[string, string]> = [];
  const errors: unknown[] = [];
  const handler = createClarificationNotifications({
    refreshPending: async (threadId) => {
      refreshed.push(threadId);
    },
    notify: (threadId, toolUseId) => {
      notifications.push([threadId, toolUseId]);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return { handler, refreshed, notifications, errors };
}

test("V2-only questions notify and refresh without a loaded Feed", () => {
  const { handler, notifications, refreshed } = harness();
  handler.handleSyncEffect("thread-1", detail("question-1"));
  expect(notifications).toEqual([["thread-1", "question-1"]]);
  expect(refreshed).toEqual(["thread-1"]);
});

test.each([
  "v2-first",
  "live-first",
])("one question notifies once across both event streams (%s)", (order) => {
  const { handler, notifications } = harness();
  const v2 = () => handler.handleSyncEffect("thread-1", detail("question-1"));
  const legacy = () => handler.handleLiveEvent(live("question-1"));
  if (order === "v2-first") {
    v2();
    legacy();
  } else {
    legacy();
    v2();
  }
  v2();
  legacy();
  handler.handleSyncEffect("thread-1", detail("question-2"));
  handler.handleLiveEvent(live("question-2"));
  expect(notifications).toEqual([
    ["thread-1", "question-1"],
    ["thread-1", "question-2"],
  ]);
});

test("resolved questions refresh attention and suppress delayed requested events", () => {
  const { handler, notifications, refreshed } = harness();
  handler.handleSyncEffect("thread-1", detail("question-1", "clarification.resolved"));
  handler.handleLiveEvent(live("question-1"));
  handler.handleLiveEvent(live("question-2", "clarification.answered"));
  handler.handleSyncEffect("thread-1", detail("question-2"));
  expect(notifications).toEqual([]);
  expect(refreshed).toHaveLength(4);
});

test("ignores unrelated stream effects and keeps question identities scoped to their thread", () => {
  const { handler, notifications, refreshed } = harness();
  handler.handleSyncEffect("thread-1", { type: "noop", reason: "stream" });
  handler.handleSyncEffect("thread-1", detail("tool-1", "approval.requested"));
  handler.handleLiveEvent({ threadId: "thread-1", type: "thread.running", message: "" });
  expect(refreshed).toEqual([]);
  handler.handleSyncEffect("thread-1", detail("question-1"));
  const second = live("question-1");
  handler.handleLiveEvent({
    ...second,
    threadId: "thread-2",
    clarification: { threadId: "thread-2", toolUseId: "question-1", questions: [] },
  });
  expect(notifications).toEqual([
    ["thread-1", "question-1"],
    ["thread-2", "question-1"],
  ]);
});

test("queue refresh errors are surfaced", async () => {
  const failure = new Error("IPC unavailable");
  const errors: unknown[] = [];
  const handler = createClarificationNotifications({
    refreshPending: async () => {
      throw failure;
    },
    notify: () => {},
    onError: (error) => {
      errors.push(error);
    },
  });
  handler.handleSyncEffect("thread-1", detail("question-1"));
  await Promise.resolve();
  expect(errors).toEqual([failure]);
});

test("each async question notifies its own text while the panel retains the queue head", async () => {
  const threadId = "notification-queue";
  let displayed: ClarificationRequest | undefined;
  const bodies: string[] = [];
  const refreshPending = createClarificationQueueSync({
    getPending: async (id) => getPendingClarificationForThread(id),
    apply: (_id, request) => {
      displayed = request;
    },
  });
  const handler = createClarificationNotifications({
    refreshPending,
    notify: (_id, toolUseId) => {
      const request = getPendingClarificationByToolUseId(toolUseId);
      if (!request) throw new Error(`Missing pending question ${toolUseId}`);
      const content = buildThreadClarificationNotificationContent({ title: "问题队列" }, request);
      if (!content) throw new Error(`Missing notification content for ${toolUseId}`);
      bodies.push(content.body);
    },
    onError: (error) => {
      throw error;
    },
  });
  const promises = ["first", "second"].map((id) =>
    registerPendingClarification(threadId, id, {
      questions: [{ question: `${id} question`, options: [] }],
      delivery: "async",
      blocking: false,
    }),
  );
  try {
    handler.handleSyncEffect(threadId, detail("first"));
    handler.handleSyncEffect(threadId, detail("second"));
    await Promise.resolve();
    expect(bodies).toEqual(["等待你的回答：first question", "等待你的回答：second question"]);
    expect(displayed?.toolUseId).toBe("first");
    submitClarification("first", { toolUseId: "first", selections: [["A"]] });
    handler.handleSyncEffect(threadId, detail("first", "clarification.resolved"));
    await Promise.resolve();
    expect(displayed?.toolUseId).toBe("second");
    submitClarification("second", { toolUseId: "second", selections: [["B"]] });
    handler.handleSyncEffect(threadId, detail("second", "clarification.resolved"));
    await Promise.resolve();
    expect(displayed).toBeUndefined();
  } finally {
    for (const id of ["first", "second"]) submitClarification(id, { toolUseId: id, selections: [["done"]] });
    await Promise.all(promises);
  }
});
