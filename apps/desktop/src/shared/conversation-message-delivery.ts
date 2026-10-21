import type { ConversationMessage } from "@eco/shared";
import type { ClarificationAsyncDelivery, ThreadPendingFollowUp } from "./ipc";

/** Undefined means this acceptance can still be scheduled. Terminal failures cannot be retried as success. */
export function terminalAcceptedMessageDelivery(
  message: Pick<ConversationMessage, "status" | "isDeleted" | "historyTarget"> | undefined,
  requireProviderReceipt = false,
): ClarificationAsyncDelivery | undefined {
  if (!message || message.isDeleted) {
    return { state: "unknown", message: "回答消息不存在或已删除，未确认投递。" };
  }
  if (message.status === "final") {
    if (requireProviderReceipt && !message.historyTarget?.userMessageId) {
      return { state: "unknown", message: "回答已记录，但缺少 Codex 接收确认；不会自动重发。" };
    }
    return { state: "delivered" };
  }
  if (message.status === "failed" || message.status === "cancelled" || message.status === "deleted") {
    return { state: "unknown", message: `回答消息状态为 ${message.status}，未确认投递。` };
  }
  return undefined;
}

/** A scheduled run awaits its receipt, while an observed terminal failure stays unknown. */
export function scheduledAcceptedMessageDelivery(
  message: Pick<ConversationMessage, "status" | "isDeleted" | "historyTarget"> | undefined,
  requireProviderReceipt = false,
): ClarificationAsyncDelivery {
  const terminal = terminalAcceptedMessageDelivery(message, requireProviderReceipt);
  if (
    terminal &&
    (terminal.state === "delivered" || !message || message.isDeleted || message.status !== "final")
  ) {
    return terminal;
  }
  return { state: "queued", message: "回答已记录，正在等待 Harness 接收。" };
}

export function describeFollowUpDelivery(followUp: ThreadPendingFollowUp): ClarificationAsyncDelivery {
  const base = {
    followUpId: followUp.id,
    ...(followUp.conversationMessageId ? { followUpMessageId: followUp.conversationMessageId } : {}),
  };
  if (followUp.status === "delivered" || followUp.status === "applied") {
    return { state: "delivered", ...base };
  }
  if (followUp.status === "failed" || followUp.status === "cancelled" || followUp.status === "superseded") {
    return { state: "unknown", ...base, message: followUp.error ?? `回答未投递（${followUp.status}）。` };
  }
  return { state: "queued", ...base, message: "回答已排队，将在当前步骤结束后作为普通消息发送。" };
}
