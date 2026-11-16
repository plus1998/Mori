import type { ThreadRunProjectionTimelineItem } from "./conversation-v2-projection";

export const CODEX_CAPACITY_RETRY_LIMIT = 5;
export const CODEX_CAPACITY_RETRY_DELAY_MS = 5 * 60 * 1_000;

export function isCodexCapacityFailureItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (
    item.eventType !== "api.error" &&
    item.eventType !== "message.final" &&
    item.eventType !== "request.retry_scheduled"
  ) {
    return false;
  }
  return /selected model is at capacity/i.test(item.text);
}

export function hasCodexCapacityFailure(
  items: readonly ThreadRunProjectionTimelineItem[],
  attemptId: string,
): boolean {
  if (!attemptId) return false;
  return items.some((item) => item.runAttemptId === attemptId && isCodexCapacityFailureItem(item));
}
