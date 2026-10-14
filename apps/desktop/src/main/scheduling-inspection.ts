import type { ThreadPendingFollowUp, ThreadSummary } from "../shared/ipc";
import type { ScheduleDefinition, ScheduleOccurrenceStatus } from "../shared/scheduling";

export function inspectScheduledRun(input: {
  kind: ScheduleDefinition["kind"];
  thread: Pick<ThreadSummary, "status" | "message" | "followUpQueuePaused"> | undefined;
  followUp: Pick<ThreadPendingFollowUp, "status" | "error"> | undefined;
  hasAcceptedMessage: boolean;
  hasActiveRun: boolean;
  isDraining: boolean;
}): { status: ScheduleOccurrenceStatus; error?: string } {
  const { thread, followUp } = input;
  if (!thread) return { status: "failed", error: "目标会话不存在或尚未创建。" };
  if (input.kind === "session_message") {
    if (!followUp) return input.hasAcceptedMessage
      ? { status: "unknown", error: "消息已接受，但缺少队列回执；请检查会话。" }
      : { status: "failed", error: "消息尚未进入会话队列。" };
    if (followUp.status === "queued") return thread.followUpQueuePaused
      ? { status: "waiting_user", error: "消息队列已暂停，请在关联会话中处理。" }
      : { status: "running" };
    // The queue claim is durable before async Core startup changes the thread to running.
    // Only the live drain proves this is in flight; a restart must inspect it as unknown.
    if (followUp.status === "delivered" && input.isDraining) return { status: "running" };
    if (followUp.status === "failed") return { status: "failed", error: followUp.error ?? "定时消息执行失败。" };
    if (followUp.status === "cancelled" || followUp.status === "superseded") return { status: "cancelled" };
  }
  if (thread.status === "running" || thread.status === "queued" || input.hasActiveRun) return { status: "running" };
  if (thread.status === "completed") return { status: "completed" };
  if (thread.status === "failed") return { status: "failed", error: thread.message || "执行失败。" };
  if (thread.status === "blocked" || thread.status === "awaiting_plan") return { status: "waiting_user", error: thread.message || "会话需要用户处理，请打开关联会话。" };
  return { status: "unknown", error: "运行未完成或被中断，请检查关联会话。" };
}
