import type { ThreadStatus } from "../shared/ipc";

// A failed or blocked run has ended. Its terminal status must not leave a due
// message pending forever. Runtime activity, approvals and pauses are checked
// separately by the scheduler before dispatch.
export function canDispatchScheduledMessageStatus(status: ThreadStatus): boolean {
  return status === "idle" || status === "completed" || status === "failed" || status === "blocked";
}
