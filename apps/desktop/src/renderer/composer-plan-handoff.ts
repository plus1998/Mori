import { composerReferenceToken } from "../shared/composer-references";
import type { ThreadPendingPlan, ThreadSummary } from "../shared/ipc";

/** Add an immutable plan reference without sending or discarding an existing draft. */
export function appendPlanReference(prompt: string, plan: ThreadPendingPlan, source: ThreadSummary, label: string): string {
  if (!plan.referenceId || source.id !== plan.threadId) throw new Error("计划与来源会话不匹配。");
  const token = composerReferenceToken({ kind: "plan", id: plan.referenceId, label, detail: source.title });
  return prompt ? `${prompt}${/\s$/.test(prompt) ? "" : "\n\n"}${token}` : token;
}
