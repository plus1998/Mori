import { z } from "zod";

const id = z.string().trim().min(1).max(200);
export const moriScheduledActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("reminder") }),
  z.strictObject({ type: z.literal("check_task"), taskThreadId: id }),
  z.strictObject({
    type: z.literal("execute"),
    projectPath: z.string().trim().min(1).max(4096).optional(),
    agentThreadId: id.optional(),
  }),
]);
export type MoriScheduledAction = z.infer<typeof moriScheduledActionSchema>;
export const moriScheduledNotificationSchema = z.strictObject({
  channel: z.enum(["desktop", "wechat"]),
  messageId: id.optional(),
});
export type MoriScheduledNotification = z.infer<typeof moriScheduledNotificationSchema>;

export interface MoriScheduledReceipt {
  phase: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown" | "skipped";
  actualAt: string;
  result?: string;
  error?: string;
  agents?: Array<{ threadId: string; messageId?: string }>;
  agentsCompleted?: boolean;
  notification?: {
    status: "sending" | "sent" | "failed" | "unknown";
    attemptedAt: string;
    stage: "waiting_user" | "result";
    error?: string;
  };
}

export class MoriNotificationUncertainError extends Error {}

export function moriScheduledActionLabel(action: MoriScheduledAction): string {
  return action.type === "reminder" ? "提醒" : action.type === "check_task" ? "检查任务" : "延时执行";
}
