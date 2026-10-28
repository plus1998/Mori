import type { ThreadPendingFollowUp } from "../shared/ipc";
import { coreSupportsMidTurnFollowUp, coreUsesInterruptForSteer } from "../shared/thread-follow-up-core";
import { isFollowUpMidTurnResultDelivered } from "../shared/thread-follow-up-drain";

/** A Guide uses the same ingress as a live send; a missed ingress is not an interrupt request. */
export async function deliverThreadFollowUpGuide(
  coreKind: string | undefined,
  followUp: ThreadPendingFollowUp,
  deps: {
    push: () => Promise<ThreadPendingFollowUp | undefined>;
    current: () => ThreadPendingFollowUp;
    wait: () => void;
    interrupt: () => Promise<ThreadPendingFollowUp>;
  },
): Promise<ThreadPendingFollowUp> {
  if (coreSupportsMidTurnFollowUp(coreKind)) {
    const pushed = await deps.push();
    if (isFollowUpMidTurnResultDelivered(pushed)) return pushed;
    const current = deps.current();
    if (current.status === "queued") deps.wait();
    return current;
  }
  if (coreUsesInterruptForSteer(coreKind)) return deps.interrupt();
  throw new Error(`Runtime ${coreKind ?? "unknown"} does not support follow-up guidance (${followUp.id}).`);
}
