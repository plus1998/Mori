import { composerReferenceToken } from "../shared/composer-references";
import type {
  ThreadPendingPlan,
  ThreadRuntimeConfig,
  ThreadStartRequest,
  ThreadSummary,
} from "../shared/ipc";

/** Only this explicit action binds execution; mentioning a plan remains ordinary context. */
export function buildPlanExecutionRequest(
  plan: ThreadPendingPlan,
  source: ThreadSummary,
  runtimeConfig: ThreadRuntimeConfig,
  label: string,
): ThreadStartRequest {
  if (!plan.referenceId || source.id !== plan.threadId) throw new Error("计划与来源会话不匹配。");
  if (
    source.workLocation?.mode === "needs_choice" ||
    (source.workLocation?.mode === "isolated" && !source.workLocation.worktree)
  ) {
    throw new Error("来源会话的工作位置尚未就绪，请先选择可用的工作位置。");
  }
  return {
    planExecutionId: plan.referenceId,
    workspacePath: plan.workspacePath,
    prompt: composerReferenceToken({ kind: "plan", id: plan.referenceId, label, detail: source.title }),
    coreKind: source.coreKind ?? "claude",
    runtimeConfig: { ...runtimeConfig, sessionMode: "agent" },
    developmentMode: "direct",
    ...(source.workLocation?.mode === "isolated" && source.workLocation.worktree
      ? { managedWorktreeId: source.workLocation.worktree.id }
      : {}),
  };
}
