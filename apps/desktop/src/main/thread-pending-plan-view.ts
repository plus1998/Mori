import type { ThreadPendingPlan } from "../shared/ipc";

export type ThreadPendingPlanInternal = ThreadPendingPlan & { routesJson?: string };

export function buildThreadPendingPlanView(
  pending: ThreadPendingPlanInternal | undefined,
): ThreadPendingPlan | undefined {
  if (!pending) {
    return undefined;
  }
  return {
    ...(pending.referenceId ? { referenceId: pending.referenceId, version: pending.version } : {}),
    threadId: pending.threadId,
    userPrompt: pending.userPrompt,
    analysis: pending.analysis,
    plan: pending.plan,
    workspacePath: pending.workspacePath,
    worktreePath: pending.worktreePath,
    ...(pending.planFilePath ? { planFilePath: pending.planFilePath } : {}),
  };
}

export function buildThreadPlanLivePayload(
  pending: Pick<ThreadPendingPlan, "userPrompt" | "analysis" | "plan" | "planFilePath">,
): Pick<ThreadPendingPlan, "userPrompt" | "analysis" | "plan" | "planFilePath"> {
  return {
    userPrompt: pending.userPrompt,
    analysis: pending.analysis,
    plan: pending.plan,
    ...(pending.planFilePath ? { planFilePath: pending.planFilePath } : {}),
  };
}
