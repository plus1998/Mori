import { expect, test } from "bun:test";
import type { ThreadPendingFollowUp } from "../src/shared/ipc";
import type { ThreadStatus } from "../src/shared/ipc";
import {
  abandonedFollowUpsForConversationMessage,
  buildThreadFollowUpDisplayPrompt,
  buildThreadFollowUpDrainPrompt,
  canEscalatedFollowUpProgressNow,
  collectThreadFollowUpAttachments,
  isAbandonedThreadFollowUp,
  isFollowUpMidTurnResultDelivered,
  shouldAutoPauseFollowUpQueue,
  shouldBlockThreadFollowUpDrain,
  shouldDrainThreadFollowUps,
  shouldReleaseFollowUpQueuePause,
  threadAcceptsQueuedFollowUp,
} from "../src/shared/thread-follow-up-drain";

function followUp(id: string, patch: Partial<ThreadPendingFollowUp> = {}): ThreadPendingFollowUp {
  return {
    id,
    threadId: "thr_1",
    prompt: `后续 ${id}`,
    priority: "normal",
    status: "delivered",
    deliveryMode: "resume",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    deliveredAt: "2024-01-01T00:00:01.000Z",
    ...patch,
  };
}

test("all 224 status/pause/edit/approval/question/plan combinations obey queue gates", () => {
  const statuses: ThreadStatus[] = ["queued", "running", "idle", "completed", "failed", "blocked", "awaiting_plan"];
  for (const status of statuses) {
    for (let flags = 0; flags < 32; flags += 1) {
      const paused = Boolean(flags & 1);
      const editing = Boolean(flags & 2);
      const approval = Boolean(flags & 4);
      const question = Boolean(flags & 8);
      const plan = Boolean(flags & 16);
      const blocked = shouldBlockThreadFollowUpDrain({
        hasPendingBridgeApproval: approval, hasPendingClarification: question,
        hasEditingFollowUp: editing, hasFollowUpQueuePaused: paused,
        threadStatus: status, hasStoredPendingPlan: plan,
      });
      const canDrain = shouldDrainThreadFollowUps(status) && !blocked;
      expect(canDrain).toBe(
        status !== "queued" && status !== "running" && !paused && !editing &&
        !approval && !question && !(status === "awaiting_plan" && plan),
      );
      // Guide bypasses pause only; it cannot bypass editing or a blocking user gate.
      const guideBlocked = shouldBlockThreadFollowUpDrain({
        hasPendingBridgeApproval: approval, hasPendingClarification: question,
        hasEditingFollowUp: editing, hasFollowUpQueuePaused: false,
        threadStatus: status, hasStoredPendingPlan: plan,
      });
      expect(guideBlocked).toBe(editing || approval || question || (status === "awaiting_plan" && plan));
    }
  }
});

test("abandonedFollowUpsForConversationMessage only matches rows the queue can never deliver", () => {
  const queuedRow = followUp("tfu_queued", { status: "queued", conversationMessageId: "message_a" });
  const cancelledRow = followUp("tfu_cancelled", {
    status: "cancelled",
    conversationMessageId: "message_b",
  });
  const supersededRow = followUp("tfu_superseded", {
    status: "superseded",
    conversationMessageId: "message_c",
  });
  const followUps = [queuedRow, cancelledRow, supersededRow];

  expect(isAbandonedThreadFollowUp(queuedRow)).toBe(false);
  expect(isAbandonedThreadFollowUp(cancelledRow)).toBe(true);
  expect(isAbandonedThreadFollowUp(supersededRow)).toBe(true);
  expect(abandonedFollowUpsForConversationMessage(followUps, "message_a")).toEqual([]);
  expect(abandonedFollowUpsForConversationMessage(followUps, "message_b").map((row) => row.id)).toEqual([
    "tfu_cancelled",
  ]);
  expect(abandonedFollowUpsForConversationMessage(followUps, "message_c").map((row) => row.id)).toEqual([
    "tfu_superseded",
  ]);
  expect(abandonedFollowUpsForConversationMessage(followUps, "message_unknown")).toEqual([]);
  expect(abandonedFollowUpsForConversationMessage(followUps, "   ")).toEqual([]);
});

test("shouldBlockThreadFollowUpDrain while plan or clarification awaits user", () => {
  expect(
    shouldBlockThreadFollowUpDrain({
      hasPendingBridgeApproval: true,
      hasPendingClarification: false,
      threadStatus: "running",
      hasStoredPendingPlan: false,
    }),
  ).toBe(true);
  expect(
    shouldBlockThreadFollowUpDrain({
      hasPendingBridgeApproval: false,
      hasPendingClarification: true,
      threadStatus: "running",
      hasStoredPendingPlan: false,
    }),
  ).toBe(true);
  expect(
    shouldBlockThreadFollowUpDrain({
      hasPendingBridgeApproval: false,
      hasPendingClarification: false,
      threadStatus: "awaiting_plan",
      hasStoredPendingPlan: true,
    }),
  ).toBe(true);
  expect(
    shouldBlockThreadFollowUpDrain({
      hasPendingBridgeApproval: false,
      hasPendingClarification: false,
      threadStatus: "completed",
      hasStoredPendingPlan: true,
    }),
  ).toBe(false);
});

test("shouldBlockThreadFollowUpDrain while a queued message is being edited", () => {
  expect(
    shouldBlockThreadFollowUpDrain({
      hasPendingBridgeApproval: false,
      hasPendingClarification: false,
      hasEditingFollowUp: true,
      threadStatus: "completed",
      hasStoredPendingPlan: false,
    }),
  ).toBe(true);
});

test("shouldBlockThreadFollowUpDrain while follow-up queue is paused", () => {
  expect(
    shouldBlockThreadFollowUpDrain({
      hasPendingBridgeApproval: false,
      hasPendingClarification: false,
      hasFollowUpQueuePaused: true,
      threadStatus: "completed",
      hasStoredPendingPlan: false,
    }),
  ).toBe(true);
  expect(
    shouldBlockThreadFollowUpDrain({
      hasPendingBridgeApproval: false,
      hasPendingClarification: false,
      hasEditingFollowUp: true,
      hasFollowUpQueuePaused: true,
      threadStatus: "failed",
      hasStoredPendingPlan: false,
    }),
  ).toBe(true);
  expect(
    shouldBlockThreadFollowUpDrain({
      hasPendingBridgeApproval: false,
      hasPendingClarification: false,
      hasFollowUpQueuePaused: false,
      threadStatus: "completed",
      hasStoredPendingPlan: false,
    }),
  ).toBe(false);
});

test("threadAcceptsQueuedFollowUp allows paused drainable statuses", () => {
  expect(threadAcceptsQueuedFollowUp({ status: "completed", hasEditingFollowUp: true })).toBe(true);
  expect(threadAcceptsQueuedFollowUp({ status: "completed", hasEditingFollowUp: false })).toBe(false);
  expect(
    threadAcceptsQueuedFollowUp({
      status: "idle",
      followUpQueuePaused: true,
    }),
  ).toBe(true);
  expect(
    threadAcceptsQueuedFollowUp({
      status: "completed",
      followUpQueuePaused: true,
    }),
  ).toBe(true);
  expect(
    threadAcceptsQueuedFollowUp({
      status: "failed",
      followUpQueuePaused: true,
    }),
  ).toBe(true);
  expect(
    threadAcceptsQueuedFollowUp({
      status: "idle",
      followUpQueuePaused: false,
    }),
  ).toBe(false);
  expect(
    threadAcceptsQueuedFollowUp({
      status: "running",
      followUpQueuePaused: false,
    }),
  ).toBe(true);
  expect(
    threadAcceptsQueuedFollowUp({
      status: "idle",
      followUpQueuePaused: false,
      hasPendingBashApproval: true,
    }),
  ).toBe(true);
});

test("shouldDrainThreadFollowUps only allows safe boundary statuses", () => {
  expect(shouldDrainThreadFollowUps("completed")).toBe(true);
  expect(shouldDrainThreadFollowUps("failed")).toBe(true);
  expect(shouldDrainThreadFollowUps("blocked")).toBe(true);
  expect(shouldDrainThreadFollowUps("awaiting_plan")).toBe(true);
  // idle: Resume after user stop must be able to drain; stop path auto-pauses first.
  expect(shouldDrainThreadFollowUps("idle")).toBe(true);
  expect(shouldDrainThreadFollowUps("running")).toBe(false);
  expect(shouldDrainThreadFollowUps("queued")).toBe(false);
});

test("auto-pause needs queued rows, and lifts itself once they are gone", () => {
  // Session error / user stop with an empty queue: nothing to protect, and pausing would
  // silently queue the next message the user composes.
  expect(shouldAutoPauseFollowUpQueue(0)).toBe(false);
  expect(shouldAutoPauseFollowUpQueue(1)).toBe(true);
  expect(shouldAutoPauseFollowUpQueue(3)).toBe(true);

  // Rows cancelled or force-drained while paused: the pause has no subject left.
  expect(shouldReleaseFollowUpQueuePause({ paused: true, queuedCount: 0 })).toBe(true);
  expect(shouldReleaseFollowUpQueuePause({ paused: true, queuedCount: 1 })).toBe(false);
  expect(shouldReleaseFollowUpQueuePause({ paused: false, queuedCount: 0 })).toBe(false);
});

test("a paused queue only blocks drains that are not already an escalated force", () => {
  const base = {
    hasPendingBridgeApproval: false,
    hasPendingClarification: false,
    hasStoredPendingPlan: false,
    threadStatus: "idle" as const,
  };
  expect(shouldBlockThreadFollowUpDrain({ ...base, hasFollowUpQueuePaused: true })).toBe(true);
  // drainNextQueuedThreadFollowUp passes `queuePaused && !forceEscalatedDrain`, so a Guide
  // click that armed the forced drain is not blocked while the other rows stay paused.
  expect(shouldBlockThreadFollowUpDrain({ ...base, hasFollowUpQueuePaused: false })).toBe(false);
});

test("escalated Guide must not treat a still-queued mid-turn skip as delivered", () => {
  // tryDeliverFollowUpViaMidTurn returns the row as-is when the inject was skipped
  // (paused queue / interrupted turn / no accepting port).
  expect(isFollowUpMidTurnResultDelivered(followUp("skipped", { status: "queued" }))).toBe(false);
  expect(isFollowUpMidTurnResultDelivered(undefined)).toBe(false);
  // Applied / failed / unknown rows are terminal for this click.
  expect(isFollowUpMidTurnResultDelivered(followUp("applied", { status: "applied" }))).toBe(true);
  expect(isFollowUpMidTurnResultDelivered(followUp("failed", { status: "failed" }))).toBe(true);
});

test("escalated Guide can still progress through the paused queue when a run or boundary exists", () => {
  // Paused + running: interrupt is available, the forced drain bypasses the pause.
  expect(canEscalatedFollowUpProgressNow({ hasActiveRun: true, status: "running" })).toBe(true);
  // Paused + idle/completed: drainable boundary, armed as one forced drain.
  expect(canEscalatedFollowUpProgressNow({ hasActiveRun: false, status: "idle" })).toBe(true);
  expect(canEscalatedFollowUpProgressNow({ hasActiveRun: false, status: "completed" })).toBe(true);
  expect(canEscalatedFollowUpProgressNow({ hasActiveRun: false, status: "failed" })).toBe(true);
  // A run that is still starting up has nothing to interrupt and no safe boundary:
  // keep the row queued instead of failing it.
  expect(canEscalatedFollowUpProgressNow({ hasActiveRun: false, status: "queued" })).toBe(false);
  expect(canEscalatedFollowUpProgressNow({ hasActiveRun: false, status: undefined })).toBe(false);
});

test("buildThreadFollowUpDisplayPrompt only includes the first delivered message", () => {
  const prompt = buildThreadFollowUpDisplayPrompt([
    followUp("1", {
      prompt: "api端口是什么",
      queuedDuringPhase: "execution",
      deliveryBoundary: "forced_interrupt",
    }),
    followUp("2", {
      prompt: "再更新文档",
      priority: "escalated",
      queuedDuringPhase: "execution",
      deliveryBoundary: "forced_interrupt",
    }),
  ]);

  expect(prompt).toBe("api端口是什么");
  expect(prompt).not.toContain("以下是用户要求立即处理");
  expect(prompt).not.toContain("queuedDuringPhase");
  expect(prompt).not.toContain("后续消息");
});

test("buildThreadFollowUpDrainPrompt sends only the first delivered follow-up", () => {
  const prompt = buildThreadFollowUpDrainPrompt([
    followUp("1", {
      prompt: "先补测试",
      queuedDuringPhase: "execution",
      deliveryBoundary: "safe_boundary",
    }),
    followUp("2", {
      prompt: "再更新文档",
      priority: "escalated",
      queuedDuringPhase: "execution",
      deliveryBoundary: "forced_interrupt",
    }),
  ]);

  expect(prompt).toBe("先补测试");
});

test("buildThreadFollowUpDrainPrompt ignores queued records until claimed", () => {
  expect(
    buildThreadFollowUpDrainPrompt([followUp("queued", { status: "queued", deliveryMode: "queued" })]),
  ).toBe("");
});

test("collectThreadFollowUpAttachments only includes the first delivered message attachments", () => {
  const attachments = collectThreadFollowUpAttachments([
    followUp("delivered", { attachments: [{ mediaType: "image/png", data: "abc" }] }),
    followUp("later", { attachments: [{ mediaType: "image/webp", data: "later" }] }),
    followUp("queued", {
      status: "queued",
      deliveryMode: "queued",
      attachments: [{ mediaType: "image/jpeg", data: "def" }],
    }),
  ]);

  expect(attachments).toEqual([{ mediaType: "image/png", data: "abc" }]);
});
