import { composerReferenceToken, composerReferences } from "../shared/composer-references";
import type { ThreadPendingPlan, ThreadSummary } from "../shared/ipc";

/** Add an immutable plan reference without sending or discarding an existing draft. */
export function appendPlanReference(prompt: string, plan: ThreadPendingPlan, source: ThreadSummary, label: string): string {
  if (!plan.referenceId || source.id !== plan.threadId) throw new Error("计划与来源会话不匹配。");
  const token = composerReferenceToken({ kind: "plan", id: plan.referenceId, label, detail: source.title });
  return prompt ? `${prompt}${/\s$/.test(prompt) ? "" : "\n\n"}${token}` : token;
}

/** Only the explicit handoff is linked, and only while its reference remains in the message. */
export function planHandoffForSend(prompt: string, planId: string | undefined): string | undefined {
  return planId && composerReferences(prompt).some(ref => ref.kind === "plan" && ref.id === planId)
    ? planId : undefined;
}
