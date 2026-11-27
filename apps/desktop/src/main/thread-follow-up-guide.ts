import { isCompactCommand } from "@eco/shared";
import type { PromptImageAttachment, ThreadPendingFollowUp } from "../shared/ipc";
import { coreSupportsMidTurnFollowUp, coreUsesInterruptForSteer } from "../shared/thread-follow-up-core";
import { isFollowUpMidTurnResultDelivered } from "../shared/thread-follow-up-drain";

/** Mid-turn and normal sends must carry the same composer references, including image-only input. */
export async function resolveThreadFollowUpMidTurnPrompt(
  followUp: ThreadPendingFollowUp,
  deps: {
    resolveAttachments: (attachments: readonly PromptImageAttachment[]) => Promise<readonly PromptImageAttachment[]>;
    resolvePrompt: (input: {
      threadId: string;
      prompt: string;
      attachments?: readonly PromptImageAttachment[];
    }) => Promise<string>;
  },
): Promise<string | undefined> {
  const prompt = followUp.prompt.trim();
  // Session commands wait for an idle boundary; steer only accepts model input.
  if (isCompactCommand(prompt)) return undefined;
  if (!prompt && !followUp.attachments?.length) return undefined;
  // Recording the accepted message moves its queued files. The runtime prompt
  // must point at the shared image objects, not at the queue's temporary paths.
  const attachments = followUp.attachments?.length
    ? await deps.resolveAttachments(followUp.attachments)
    : undefined;
  const resolved = await deps.resolvePrompt({
    threadId: followUp.threadId,
    prompt,
    ...(attachments ? { attachments } : {}),
  });
  if (!resolved.trim()) throw new Error("后续消息没有可发送的文字或图片引用。");
  return resolved;
}

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
