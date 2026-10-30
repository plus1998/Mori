import type { ThreadStatus, ThreadSummary } from "../shared/ipc";

// A failed or blocked run has ended. Its terminal status must not leave a due
// message pending forever. Runtime activity, approvals and pauses are checked
// separately by the scheduler before dispatch.
export function canDispatchScheduledMessageStatus(status: ThreadStatus): boolean {
  return status === "idle" || status === "completed" || status === "failed" || status === "blocked";
}

/** Ordinary queue pause does not cancel a timed send; error pauses still require recovery. */
export function canDispatchScheduledMessage(input: {
  thread: Pick<ThreadSummary, "status" | "followUpQueuePaused">;
  hasActiveRun: boolean;
  isCompacting: boolean;
  hasPendingUserAction: boolean;
  hasEditingFollowUp: boolean;
}): boolean {
  const { thread } = input;
  return (
    canDispatchScheduledMessageStatus(thread.status) &&
    !(thread.followUpQueuePaused && (thread.status === "failed" || thread.status === "blocked")) &&
    !input.hasActiveRun &&
    !input.isCompacting &&
    !input.hasPendingUserAction &&
    !input.hasEditingFollowUp
  );
}
