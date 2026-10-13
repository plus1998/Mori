import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeClarificationResolutionCommand } from "../src/main/conversation-interaction-command";
import { createConversationStore } from "../src/main/conversation-store";
import type { ThreadPendingFollowUp } from "../src/shared/ipc";
import {
  selectThreadFollowUpDrainTarget,
  shouldBlockThreadFollowUpDrain,
  threadAcceptsQueuedFollowUp,
} from "../src/shared/thread-follow-up-drain";
import { removeTempDirectorySync } from "./helpers/temp-directory";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) removeTempDirectorySync(directory);
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "eco-paused-answer-"));
  directories.push(directory);
  const dbPath = join(directory, "test.sqlite");
  const store = await createConversationStore(dbPath);
  const threadId = "thread-paused-answer";
  store.saveThread({
    id: threadId,
    title: "paused answer",
    prompt: "start",
    workspacePath: directory,
    status: "completed",
    message: "",
    coreKind: "codex",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
  });
  const v2 = store.conversationV2();
  const ordinaryMessage = v2.sendMessage({
    principalId: "desktop",
    conversationId: threadId,
    clientCommandId: "ordinary",
    text: "ordinary queued message",
  });
  const ordinary = store.enqueueThreadFollowUp({
    threadId,
    prompt: "ordinary queued message",
    conversationMessageId: ordinaryMessage.messageId,
  });
  store.setThreadFollowUpQueuePaused(threadId, true);
  const text =
    '<send_user_message_question_reply>[{"questionItemId":"q1","question":"选哪项？","answer":"A"}]</send_user_message_question_reply>';
  const resolution = executeClarificationResolutionCommand(
    {
      principalId: "desktop",
      conversationId: threadId,
      clientCommandId: "submitted-answer",
      toolUseId: "question",
      resolution: "submit",
      expectedHistoryRevision: 0,
      answers: { toolUseId: "question", selections: [["A"]] },
    },
    {
      v2,
      getPending: () => ({ threadId, toolUseId: "question", questions: [], delivery: "async" }),
      buildDismissAnswers: () => ({ toolUseId: "question", selections: [] }),
      buildAsyncReplyText: () => text,
      errorMessage: String,
    },
  );
  if (!resolution.asyncMessage) throw new Error("Missing durable answer.");
  const answer = store.enqueueThreadFollowUp({
    threadId,
    prompt: text,
    conversationMessageId: resolution.asyncMessage.messageId,
  });
  return { store, dbPath, threadId, v2, ordinary, answer, text };
}

const gates = {
  hasPendingBridgeApproval: false,
  hasPendingClarification: false,
  hasStoredPendingPlan: false,
  hasFollowUpQueuePaused: true,
  threadStatus: "completed" as const,
};

function targetFor(store: Awaited<ReturnType<typeof createConversationStore>>, threadId: string) {
  return selectThreadFollowUpDrainTarget({
    followUps: store.listThreadFollowUps(threadId, { statuses: ["queued"] }),
    forceEscalatedDrain: false,
    isAsyncClarificationAnswer: (row) =>
      Boolean(
        row.conversationMessageId &&
          store.conversationV2().isAsyncClarificationAnswer(threadId, row.conversationMessageId),
      ),
  });
}

test("paused queue claims only the submitted answer and keeps ordinary messages paused", async () => {
  const { store, threadId, ordinary, answer } = await fixture();
  const target = targetFor(store, threadId);
  expect(target).toEqual({ followUpId: answer.id, isAsyncClarificationAnswer: true });
  expect(
    shouldBlockThreadFollowUpDrain({
      ...gates,
      isAsyncClarificationAnswer: target.isAsyncClarificationAnswer,
    }),
  ).toBe(false);
  expect(
    store.claimQueuedThreadFollowUps(threadId, { followUpId: target.followUpId }).map((row) => row.id),
  ).toEqual([answer.id]);
  expect(store.getThreadFollowUp(threadId, ordinary.id)?.status).toBe("queued");
  expect(store.getThread(threadId)?.followUpQueuePaused).toBe(true);
  const remaining = targetFor(store, threadId);
  expect(remaining.isAsyncClarificationAnswer).toBe(false);
  expect(
    shouldBlockThreadFollowUpDrain({
      ...gates,
      isAsyncClarificationAnswer: remaining.isAsyncClarificationAnswer,
    }),
  ).toBe(true);
  expect(store.claimQueuedThreadFollowUps(threadId, { followUpId: answer.id })).toEqual([]);
});

test("restart still identifies the answer from its persisted resolution with no pending panel", async () => {
  const { dbPath, threadId, answer, ordinary } = await fixture();
  const reopened = await createConversationStore(dbPath);
  expect(reopened.getThread(threadId)?.followUpQueuePaused).toBe(true);
  const target = targetFor(reopened, threadId);
  expect(target).toEqual({ followUpId: answer.id, isAsyncClarificationAnswer: true });
  expect(
    reopened.claimQueuedThreadFollowUps(threadId, { followUpId: target.followUpId }).map((row) => row.id),
  ).toEqual([answer.id]);
  expect(reopened.getThreadFollowUp(threadId, ordinary.id)?.status).toBe("queued");
});

test("ordinary messages cannot bypass pause by copying a reply envelope or command prefix", async () => {
  const { v2, threadId, text } = await fixture();
  const ordinary = v2.sendMessage({
    principalId: "desktop",
    conversationId: threadId,
    clientCommandId: "async-clarification:forged",
    text,
  });
  expect(v2.isAsyncClarificationAnswer(threadId, ordinary.messageId)).toBe(false);
});

test("a recovered submitted answer is accepted at an idle boundary without a pending panel", () => {
  for (const status of ["idle", "completed", "failed", "blocked"] as const) {
    expect(threadAcceptsQueuedFollowUp({ status, isAsyncClarificationAnswer: true })).toBe(true);
    expect(threadAcceptsQueuedFollowUp({ status, isAsyncClarificationAnswer: false })).toBe(false);
  }
});

test("question answers only bypass queue pause; unresolved gates still block delivery", () => {
  const answer = { ...gates, isAsyncClarificationAnswer: true };
  expect(shouldBlockThreadFollowUpDrain(answer)).toBe(false);
  for (const gate of ["hasPendingBridgeApproval", "hasPendingClarification", "hasEditingFollowUp"] as const) {
    expect(shouldBlockThreadFollowUpDrain({ ...answer, [gate]: true })).toBe(true);
  }
  expect(
    shouldBlockThreadFollowUpDrain({ ...answer, threadStatus: "awaiting_plan", hasStoredPendingPlan: true }),
  ).toBe(true);
});

test("an explicit Guide or an edited answer retains its own queue selection", () => {
  const answer = { id: "answer", status: "queued", priority: "normal" } as ThreadPendingFollowUp;
  const guide = { id: "guide", status: "queued", priority: "escalated" } as ThreadPendingFollowUp;
  const base = {
    followUps: [guide, answer],
    isAsyncClarificationAnswer: (row: ThreadPendingFollowUp) => row.id === "answer",
  };
  expect(selectThreadFollowUpDrainTarget({ ...base, forceEscalatedDrain: true })).toEqual({
    priority: "escalated",
    isAsyncClarificationAnswer: false,
  });
  expect(
    selectThreadFollowUpDrainTarget({ ...base, forceEscalatedDrain: false, excludeFollowUpId: "answer" }),
  ).toEqual({ priority: "escalated", isAsyncClarificationAnswer: false });
});
