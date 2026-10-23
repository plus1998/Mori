import type { PromptImageAttachment, ThreadPendingFollowUp, ThreadStatus } from "./ipc";

// `idle` is drainable so queue Resume after a user stop can send. Stop itself must
// auto-pause first; otherwise cancel cleanup would silently drain remaining follow-ups.
const DRAINABLE_FOLLOW_UP_STATUSES = ["completed", "failed", "blocked", "awaiting_plan", "idle"] as const;

export function shouldDrainThreadFollowUps(status: ThreadStatus): boolean {
  return (DRAINABLE_FOLLOW_UP_STATUSES as readonly string[]).includes(status);
}

/** Block auto-drain while plan approval, clarification, editing, or user/error pause is active. */
export function shouldBlockThreadFollowUpDrain(input: {
  hasPendingBridgeApproval: boolean;
  hasPendingClarification: boolean;
  hasEditingFollowUp?: boolean;
  /** User or session-error pause; explicit question answers are independent of this queue. */
  hasFollowUpQueuePaused?: boolean;
  /** The caller has verified the message's durable clarification resolution receipt. */
  isAsyncClarificationAnswer?: boolean;
  threadStatus?: ThreadStatus;
  hasStoredPendingPlan: boolean;
}): boolean {
  if (
    input.hasPendingBridgeApproval ||
    input.hasPendingClarification ||
    input.hasEditingFollowUp ||
    (input.hasFollowUpQueuePaused && !input.isAsyncClarificationAnswer)
  ) {
    return true;
  }
  return input.threadStatus === "awaiting_plan" && input.hasStoredPendingPlan;
}

/** Explicit question answers can progress while ordinary messages keep their order and pause. */
export function selectThreadFollowUpDrainTarget(input: {
  followUps: readonly ThreadPendingFollowUp[];
  forceEscalatedDrain: boolean;
  excludeFollowUpId?: string;
  isAsyncClarificationAnswer: (followUp: ThreadPendingFollowUp) => boolean;
}): { followUpId?: string; priority?: "escalated"; isAsyncClarificationAnswer: boolean } {
  const eligible = input.followUps.filter((followUp) =>
    followUp.status === "queued" && followUp.id !== input.excludeFollowUpId,
  );
  if (input.forceEscalatedDrain) return { priority: "escalated", isAsyncClarificationAnswer: false };
  const answer = eligible.find(input.isAsyncClarificationAnswer);
  if (answer) return { followUpId: answer.id, isAsyncClarificationAnswer: true };
  return {
    ...(eligible.some((followUp) => followUp.priority === "escalated") ? { priority: "escalated" as const } : {}),
    isAsyncClarificationAnswer: false,
  };
}

/**
 * Whether the thread can accept a new queued follow-up row.
 * Live run statuses always accept; paused queues also accept on drainable
 * statuses so new messages join the pause instead of starting a run ahead of
 * remaining items.
 */
export function threadAcceptsQueuedFollowUp(input: {
  status: ThreadStatus;
  followUpQueuePaused?: boolean;
  isAsyncClarificationAnswer?: boolean;
  hasPendingBridgeApproval?: boolean;
  hasPendingClarification?: boolean;
  hasPendingBashApproval?: boolean;
  hasPendingPlanApproval?: boolean;
  hasEditingFollowUp?: boolean;
}): boolean {
  if (input.status === "running" || input.status === "queued" || input.status === "awaiting_plan") {
    return true;
  }
  if ((input.followUpQueuePaused || input.isAsyncClarificationAnswer) && shouldDrainThreadFollowUps(input.status)) {
    return true;
  }
  return Boolean(
    input.hasPendingBridgeApproval ||
      input.hasPendingClarification ||
      input.hasPendingBashApproval ||
      input.hasPendingPlanApproval ||
      input.hasEditingFollowUp,
  );
}

/**
 * Auto-pause (session error / user stop) only protects rows that exist. An empty queue
 * must stay sendable: arming the pause there would silently queue the next message the
 * user composes, with no queued row explaining why.
 */
export function shouldAutoPauseFollowUpQueue(queuedCount: number): boolean {
  return queuedCount > 0;
}

/**
 * A pause with no queued rows left has no subject (the rows it held are gone), so it must
 * lift itself instead of holding back newly composed messages.
 */
export function shouldReleaseFollowUpQueuePause(input: { paused: boolean; queuedCount: number }): boolean {
  return input.paused && input.queuedCount === 0;
}

/**
 * Mid-turn inject leaves the row `queued` when it was skipped (paused queue,
 * interrupted turn, blocking approval, or no accepting port). That is not a
 * delivery, so callers must not treat it as a handled row.
 */
export function isFollowUpMidTurnResultDelivered(
  result: ThreadPendingFollowUp | undefined,
): result is ThreadPendingFollowUp {
  return Boolean(result && result.status !== "queued");
}

/**
 * A row that will never deliver the prompt it holds: the user cancelled it, or an
 * escalated sibling superseded it. Its accepted V2 prompt has to be discarded with
 * it — a leftover `queued` V2 message is re-sent as a brand-new run by startup
 * queued-message recovery, i.e. the prompt the user removed comes back.
 */
export function isAbandonedThreadFollowUp(followUp: ThreadPendingFollowUp): boolean {
  return followUp.status === "cancelled" || followUp.status === "superseded";
}

/** Abandoned queue rows holding the given V2 accepted prompt. */
export function abandonedFollowUpsForConversationMessage(
  followUps: readonly ThreadPendingFollowUp[],
  conversationMessageId: string,
): ThreadPendingFollowUp[] {
  const messageId = conversationMessageId.trim();
  if (!messageId) {
    return [];
  }
  return followUps.filter(
    (followUp) => followUp.conversationMessageId === messageId && isAbandonedThreadFollowUp(followUp),
  );
}

/**
 * Escalated ("handle now") may bypass a user-paused queue, but it still needs
 * something that can move: an active run to interrupt, or a drainable boundary.
 * Used after a skipped mid-turn inject so a paused queue cannot swallow the
 * Guide click while a starting run keeps the row queued instead of failing it.
 */
export function canEscalatedFollowUpProgressNow(input: {
  hasActiveRun: boolean;
  status?: ThreadStatus;
}): boolean {
  if (input.hasActiveRun) {
    return true;
  }
  return Boolean(input.status && shouldDrainThreadFollowUps(input.status));
}

export function buildThreadFollowUpDisplayPrompt(followUps: readonly ThreadPendingFollowUp[]): string {
  const next = nextDeliveredFollowUp(followUps);
  return next ? normalizeFollowUpPrompt(next) : "";
}

export function buildThreadFollowUpDrainPrompt(followUps: readonly ThreadPendingFollowUp[]): string {
  const next = nextDeliveredFollowUp(followUps);
  return next ? normalizeFollowUpPrompt(next) : "";
}

export function collectThreadFollowUpAttachments(
  followUps: readonly ThreadPendingFollowUp[],
): PromptImageAttachment[] {
  return [...(nextDeliveredFollowUp(followUps)?.attachments ?? [])];
}

function nextDeliveredFollowUp(
  followUps: readonly ThreadPendingFollowUp[],
): ThreadPendingFollowUp | undefined {
  return followUps.find((followUp) => followUp.status === "delivered");
}

function normalizeFollowUpPrompt(followUp: ThreadPendingFollowUp): string {
  return followUp.prompt.trim();
}
