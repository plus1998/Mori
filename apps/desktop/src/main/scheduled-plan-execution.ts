import type { ThreadApprovePlanRequest, ThreadPendingPlan, ThreadSummary } from "../shared/ipc";
import type {
  ScheduledPlanApproval,
  ScheduleOccurrence,
  ScheduleOccurrenceStatus,
} from "../shared/scheduling";
import type { ConversationCommandJob } from "./conversation-v2-store";

export function assertScheduledPlanCurrent(
  approval: ScheduledPlanApproval,
  plan: string,
  current: {
    thread: Pick<ThreadSummary, "status"> | undefined;
    pendingPlan: Pick<ThreadPendingPlan, "plan"> | undefined;
    historyRevision: number;
  },
): void {
  if (!current.thread) throw new Error("目标会话已删除。");
  if (current.thread.status !== "awaiting_plan" || !current.pendingPlan) {
    throw new Error("该计划已执行或已取消，未再次执行。");
  }
  if (
    !plan.trim() ||
    current.pendingPlan.plan.trim() !== plan.trim() ||
    current.historyRevision !== approval.expectedHistoryRevision
  ) {
    throw new Error("计划或会话内容已变更，请重新设置执行时间。");
  }
}

export function scheduledPlanCommandId(occurrenceId: string): string {
  return `scheduled_plan_${occurrenceId}`;
}

export async function approveScheduledPlan(
  occurrence: ScheduleOccurrence,
  current: Parameters<typeof assertScheduledPlanCurrent>[2],
  approve: (request: ThreadApprovePlanRequest) => Promise<unknown>,
): Promise<{ threadId: string }> {
  const { definition } = occurrence;
  if (definition.kind !== "session_message" || !definition.planApproval || !definition.threadId) {
    throw new Error("不是定时执行计划。");
  }
  assertScheduledPlanCurrent(definition.planApproval, definition.prompt, current);
  await approve({
    principalId: "eco-scheduler",
    clientCommandId: scheduledPlanCommandId(occurrence.id),
    threadId: definition.threadId,
    expectedHistoryRevision: definition.planApproval.expectedHistoryRevision,
  });
  return { threadId: definition.threadId };
}

/** The schedule tracks delivery of approval; the conversation owns the ensuing run. */
export function inspectScheduledPlanCommand(
  job: Pick<ConversationCommandJob, "status" | "error"> | undefined,
): { status: ScheduleOccurrenceStatus; error?: string } {
  if (!job) return { status: "failed", error: "定时计划尚未提交执行。" };
  if (job.status === "completed") return { status: "completed" };
  if (job.status === "failed")
    return { status: "failed", error: JSON.stringify(job.error) ?? "计划执行请求失败。" };
  return { status: "unknown", error: "计划批准的送达结果尚未确认，请检查关联会话。" };
}
