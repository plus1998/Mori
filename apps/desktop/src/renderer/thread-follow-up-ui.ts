import type { ThreadFollowUpPriority, ThreadPendingFollowUp, ThreadStatus } from "../shared/ipc";
import {
  formatCodexAsyncQuestionReplySummary,
  parseCodexAsyncQuestionReplyText,
} from "../shared/codex-async-questions";
import { i18n } from "./i18n";

export function isLiveFollowUpThreadStatus(status?: ThreadStatus): boolean {
  return status === "running" || status === "queued";
}

/** Composer should enqueue (not continue/start) while live, editing, or queue-paused. */
export function shouldComposerUseFollowUpQueue(input: {
  status?: ThreadStatus;
  editingFollowUpId?: string | null;
  followUpQueuePaused?: boolean;
}): boolean {
  return Boolean(
    isLiveFollowUpThreadStatus(input.status) || input.editingFollowUpId || input.followUpQueuePaused,
  );
}

/**
 * Whether the row's Guide action can be clicked.
 * Normal rows are always escalatable. An already-escalated row only becomes clickable
 * again while the queue is paused: there it is stuck (escalate does not auto-drain past
 * the pause), so a click is the user's "send this one now".
 */
export function canEscalateThreadFollowUp(input: {
  priority: ThreadFollowUpPriority;
  coreSupportsEscalate: boolean;
  queuePaused: boolean;
}): boolean {
  if (!input.coreSupportsEscalate) {
    return false;
  }
  return input.priority !== "escalated" || input.queuePaused;
}

export function sortThreadFollowUps(followUps: readonly ThreadPendingFollowUp[]): ThreadPendingFollowUp[] {
  return [...followUps].sort(compareThreadFollowUps);
}

export function queuedThreadFollowUps(followUps: readonly ThreadPendingFollowUp[]): ThreadPendingFollowUp[] {
  return sortThreadFollowUps(followUps).filter((followUp) => followUp.status === "queued");
}

export function mergeThreadFollowUp(
  current: readonly ThreadPendingFollowUp[],
  followUp: ThreadPendingFollowUp,
): ThreadPendingFollowUp[] {
  return mergeThreadFollowUps(current, [followUp]);
}

/** Merge RPC snapshots and live events without undoing a later queue transition. */
export function mergeThreadFollowUps(
  current: readonly ThreadPendingFollowUp[],
  incoming: readonly ThreadPendingFollowUp[],
): ThreadPendingFollowUp[] {
  const next = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = next.get(item.id);
    if (existing) {
      if (existing.updatedAt > item.updatedAt) continue;
      if (existing.updatedAt === item.updatedAt && isTerminalFollowUp(existing) && !isTerminalFollowUp(item))
        continue;
      if (
        existing.updatedAt === item.updatedAt &&
        ["cancelled", "superseded", "failed"].includes(existing.status) &&
        item.status === "applied"
      )
        continue;
    }
    next.set(item.id, item);
  }
  return sortThreadFollowUps([...next.values()]);
}

function isTerminalFollowUp(item: ThreadPendingFollowUp): boolean {
  return item.status !== "queued" && item.status !== "delivered";
}

export function formatThreadFollowUpPreview(followUp: ThreadPendingFollowUp, maxLength = 120): string {
  const replies = parseCodexAsyncQuestionReplyText(followUp.prompt);
  const prompt = replies ? formatCodexAsyncQuestionReplySummary(replies) : followUp.prompt.trim();
  const imageCount = followUp.attachments?.length ?? 0;
  const clipped = prompt.length > maxLength ? `${prompt.slice(0, maxLength - 3)}...` : prompt;
  const imageLabel = i18n.t("thread.followUpImages", { count: imageCount });
  if (clipped && imageCount > 0) {
    return `${clipped} (${imageLabel})`;
  }
  if (clipped) {
    return clipped;
  }
  return imageCount > 0 ? imageLabel : i18n.t("thread.followUpEmpty");
}

function compareThreadFollowUps(left: ThreadPendingFollowUp, right: ThreadPendingFollowUp): number {
  const positionDelta =
    (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER);
  if (positionDelta !== 0) {
    return positionDelta;
  }
  const priorityDelta = priorityRank(left) - priorityRank(right);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  if (positionDelta !== 0) {
    return positionDelta;
  }
  const createdDelta = left.createdAt.localeCompare(right.createdAt);
  if (createdDelta !== 0) {
    return createdDelta;
  }
  return left.id.localeCompare(right.id);
}

function priorityRank(followUp: ThreadPendingFollowUp): number {
  return followUp.priority === "escalated" ? 0 : 1;
}
