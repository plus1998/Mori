import type { ScheduleOccurrence } from "../shared/scheduling";
import type { ConversationStore } from "./conversation-store";
import type { PromptImageFileStore } from "./prompt-image-file-store";
import type { ThreadPendingFollowUp } from "../shared/ipc";

/** Identify scheduled delivery from persisted V2 provenance, never queue text or priority. */
export function isScheduledMessageFollowUp(
  followUp: ThreadPendingFollowUp,
  store: Pick<ConversationStore, "conversationV2">,
): boolean {
  if (!followUp.conversationMessageId) return false;
  const message = store.conversationV2().getMessage(followUp.threadId, followUp.conversationMessageId);
  return Boolean(
    message && !message.isDeleted && message.role === "user" && message.origin?.kind === "scheduled_message",
  );
}

/** Persist image ownership before accepting the message and enqueue its exact attachments. */
export async function enqueueScheduledMessage(
  occurrence: ScheduleOccurrence,
  store: Pick<
    ConversationStore,
    "getThread" | "conversationV2" | "listThreadFollowUps" | "enqueueThreadFollowUp"
  >,
  images: Pick<PromptImageFileStore, "persistMessageAttachments">,
) {
  const definition = occurrence.definition;
  if (definition.kind !== "session_message" || !definition.threadId) throw new Error("不是定时消息。");
  const threadId = definition.threadId;
  if (!store.getThread(threadId)) throw new Error("目标会话已删除。");
  const messageId = `message_${occurrence.id}`;
  const attachments = definition.attachments?.length
    ? await images.persistMessageAttachments(threadId, `conversation-v2:${messageId}`, definition.attachments)
    : undefined;
  const accepted = store.conversationV2().sendMessage({
    principalId: "eco-scheduler",
    conversationId: threadId,
    clientCommandId: occurrence.id,
    messageId,
    text: definition.prompt,
    ...(attachments?.length ? { attachments } : {}),
    origin: { kind: "scheduled_message", scheduleId: definition.id, name: definition.name },
  });
  const existing = store
    .listThreadFollowUps(threadId)
    .find((item) => item.conversationMessageId === accepted.messageId);
  return (
    existing ??
    store.enqueueThreadFollowUp({
      threadId,
      prompt: definition.prompt,
      conversationMessageId: accepted.messageId,
      ...(attachments?.length ? { attachments } : {}),
      deliveryMode: "queued",
      priority: "normal",
    })
  );
}
