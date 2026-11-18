import type { ThreadRunProjectionTimelineItem } from "./conversation-v2-projection";

export const CODEX_CAPACITY_RETRY_LIMIT = 5;

export type CodexCapacityRetryNotice = {
  id: string;
  runAttemptId: string;
  retryAt?: string;
};

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

/** Return the newest provider capacity retry row for the active Codex attempt. */
export function latestCodexCapacityRetryNotice(
  items: readonly ThreadRunProjectionTimelineItem[],
  attemptId: string,
): CodexCapacityRetryNotice | undefined {
  if (!attemptId) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      !item ||
      item.scope === "agent" ||
      item.runAttemptId !== attemptId ||
      item.eventType !== "request.retry_scheduled" ||
      !isCodexCapacityFailureItem(item)
    ) {
      continue;
    }
    const retryAt = item.metadata?.retryAt;
    return {
      id: item.id,
      runAttemptId: attemptId,
      ...(typeof retryAt === "string" && Number.isFinite(Date.parse(retryAt)) ? { retryAt } : {}),
    };
  }
  return undefined;
}
