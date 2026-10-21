import { parseThreadRunFileChangeMetadata } from "./file-change";
import type { ThreadRunProjectionTimelineItem } from "./ipc";
import {
  isReconnectActivityOrigin,
  isRedundantApiFailureBlockedMessage,
  isUpstreamErrorPhaseOrigin,
  isUserInterruptedTurnFailure,
  resolveThreadActivityOrigin,
} from "./thread-activity-origin";

const AGENT_ROLES = new Set([
  "assistant",
  "agent",
  "main",
  "explore",
  "architect",
  "coder",
  "reviewer",
  "tester",
]);

/**
 * Lightweight failure-row detector for Codex retry gating (shared main + renderer).
 * Matches the retryable origins used by one-click retry; not a full UI detail-block parse.
 */
export function isCodexRetryIgnorableFailureItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (item.scope === "agent") {
    return false;
  }
  if (isUserInterruptedTurnFailure({ eventType: item.eventType, text: item.text, metadata: item.metadata })) {
    return false;
  }
  const origin = resolveThreadActivityOrigin(item);
  if (origin === "sdk.api_retry") {
    return true;
  }
  if (origin === "proxy.connection_error" || origin === "eco.thread_failed") {
    return true;
  }
  if (origin === "eco.thread_blocked") {
    return !isRedundantApiFailureBlockedMessage(item.text);
  }
  if (isUpstreamErrorPhaseOrigin(origin) && item.eventType === "message.final") {
    return true;
  }
  if (item.eventType === "api.error") {
    return true;
  }
  if (isReconnectActivityOrigin(origin) && item.metadata?.reconnectFailed === true) {
    return true;
  }
  return false;
}

/**
 * True when a timeline item means the agent already produced work in the turn
 * (messages, tools, or file edits). Ignorable failure rows are not progress.
 */
export function isCodexRetryBlockingProgressItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (isCodexRetryIgnorableFailureItem(item)) {
    return false;
  }
  if (item.eventType.startsWith("tool.")) {
    return true;
  }
  if (parseThreadRunFileChangeMetadata(item.metadata?.fileChange)) {
    return true;
  }
  if (item.scope === "agent") {
    return true;
  }
  const role = (item.role ?? "").trim().toLowerCase();
  if (role === "user" || role === "system") {
    return false;
  }
  if (AGENT_ROLES.has(role) && item.text.trim().length > 0) {
    return true;
  }
  if (
    (item.eventType === "message.final" || item.eventType === "message.delta") &&
    item.text.trim().length > 0
  ) {
    return true;
  }
  return false;
}

function readUserActivityLineId(item: ThreadRunProjectionTimelineItem): string | undefined {
  const rewind = item.metadata?.rewindTarget;
  if (rewind && typeof rewind === "object" && !Array.isArray(rewind)) {
    const activityLineId = (rewind as { activityLineId?: unknown }).activityLineId;
    if (typeof activityLineId === "string" && activityLineId.trim()) {
      return activityLineId.trim();
    }
  }
  const streamKey = item.streamKey?.trim();
  if (streamKey) {
    return streamKey;
  }
  const id = item.id.trim();
  return id || undefined;
}

function isLikelyUserPromptItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (item.role === "user" && item.text.trim().length > 0) {
    return true;
  }
  const liveType = item.metadata?.liveType;
  return (
    typeof liveType === "string" &&
    (liveType === "thread.user_prompt" || liveType === "message.user") &&
    item.text.trim().length > 0
  );
}

/**
 * After `userActivityLineId`, before the next user prompt: any blocking progress?
 * Unknown / missing user id is treated as blocking (refuse retry).
 */
export function codexTurnHasRetryBlockingProgress(
  items: readonly ThreadRunProjectionTimelineItem[],
  userActivityLineId: string,
): boolean {
  const target = userActivityLineId.trim();
  if (!target) {
    return true;
  }
  let inTurn = false;
  for (const item of items) {
    if (isLikelyUserPromptItem(item)) {
      const itemUserId = readUserActivityLineId(item);
      if (inTurn) {
        break;
      }
      if (itemUserId === target) {
        inTurn = true;
      }
      continue;
    }
    if (!inTurn) {
      continue;
    }
    if (isCodexRetryBlockingProgressItem(item)) {
      return true;
    }
  }
  return !inTurn;
}
