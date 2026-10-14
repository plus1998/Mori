export const planExecutionFailurePrefix = "执行失败，已回退更改。";
export const planDelegationFailurePrefix = "计划委派失败。";

export function buildPlanExecutionFailureMessage(detail: string): string {
  const trimmed = detail.trim();
  return trimmed ? `${planExecutionFailurePrefix}${trimmed}` : planExecutionFailurePrefix;
}

export function extractPlanFailureMessage(threadMessage: string): string | undefined {
  const prefix = [planExecutionFailurePrefix, planDelegationFailurePrefix].find((value) =>
    threadMessage.startsWith(value),
  );
  if (!prefix) {
    return undefined;
  }
  const detail = threadMessage.slice(prefix.length).trim();
  return detail.length > 0 ? detail : undefined;
}

export function persistThreadSummaryMessage(status: string, message: string): string {
  if (status === "failed" || status === "blocked") {
    return message;
  }
  if (message.startsWith(planExecutionFailurePrefix) || message.startsWith(planDelegationFailurePrefix)) {
    return message;
  }
  return "";
}

export function resolveThreadMessageFromLiveEvent(eventType: string, eventMessage: string): string {
  if (eventType === "thread.execution_failed") {
    return buildPlanExecutionFailureMessage(eventMessage);
  }
  if (
    eventType === "thread.failed" ||
    eventType === "thread.blocked" ||
    eventType === "thread.unstarted_turn_discarded"
  ) {
    return eventMessage;
  }
  if (
    eventMessage.startsWith(planExecutionFailurePrefix) ||
    eventMessage.startsWith(planDelegationFailurePrefix)
  ) {
    return eventMessage;
  }
  return "";
}

const threadSummaryMessageExclusions = new Set([
  "thread.context_updated",
  "thread.usage_updated",
  "thread.todos_updated",
  "thread.title_updated",
  "thread.title_delta",
  "thread.title_failed",
  "thread.title_generating",
  "thread.runtime_config_updated",
  "thread.session_captured",
  "thread.follow_up_queue_paused",
  "thread.follow_up_queue_resumed",
]);

export function shouldUpdateThreadSummaryFromLiveEvent(eventType: string): boolean {
  if (threadSummaryMessageExclusions.has(eventType)) {
    return false;
  }
  return eventType.startsWith("thread.");
}
