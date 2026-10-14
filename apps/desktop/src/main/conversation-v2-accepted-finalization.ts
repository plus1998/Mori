import { type ConversationMessage, stableHash } from "@eco/shared";
import type { PromptImageAttachment } from "../shared/ipc";
import type { PromptImagePreview } from "../shared/prompt-image-metadata";
import { buildAcceptedConversationMessageSchedule } from "./conversation-v2-request";
import type { ConversationV2Store } from "./conversation-v2-store";

/** Confirm delivery together with previews derived from each accepted message's own images. */
export async function finalizeAcceptedConversationV2Messages(input: {
  store: Pick<ConversationV2Store, "getMessage" | "appendRuntime">;
  conversationId: string;
  messageIds: readonly string[];
  resolveAttachments: (attachments: readonly PromptImageAttachment[]) => Promise<PromptImageAttachment[]>;
  createPreviews: (attachments: readonly PromptImageAttachment[]) => Array<PromptImagePreview | undefined>;
  signal?: AbortSignal;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const messages = [...new Set(input.messageIds.map((id) => id.trim()).filter(Boolean))]
    .map((id) => input.store.getMessage(input.conversationId, id))
    .filter((message): message is ConversationMessage =>
      Boolean(message && !message.isDeleted && message.status === "queued"),
    );
  const prepared = await Promise.all(
    messages.map(async (message) => {
      const attachments = buildAcceptedConversationMessageSchedule(message).attachments ?? [];
      if (!attachments.length) return { message, attachments: [] };
      const resolved = await input.resolveAttachments(attachments);
      const previews = input.createPreviews(resolved);
      const durableAttachments = attachments.map((attachment, index) => {
        const preview = previews[index];
        if (!preview?.data) throw new Error("无法生成排队消息的图片预览。");
        return {
          mediaType: attachment.mediaType,
          ...(attachment.contentRef ? { contentRef: attachment.contentRef } : {}),
          ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
          data: preview.data,
        };
      });
      return { message, attachments: durableAttachments };
    }),
  );
  // Pause/Stop may revoke preparation while image objects are being read. Do not
  // expose the bubble or dispatch the runtime after that cancellation.
  input.signal?.throwIfAborted();
  for (const { message, attachments } of prepared) {
    const current = input.store.getMessage(input.conversationId, message.messageId);
    if (!current || current.isDeleted || current.status !== "queued") continue;
    if (current.contentVersion !== message.contentVersion) {
      throw new Error("排队消息在图片预览准备期间被修改，无法确认投递。");
    }
    const sourceEventKey = `desktop:user:accepted-mid-turn:${input.conversationId}:${message.messageId}`;
    input.store.appendRuntime({
      conversationId: input.conversationId,
      eventId: `desktop_v2_user_finalize_mid_turn_${stableHash(sourceEventKey)}`,
      sourceEventKey,
      type: "message.finalized",
      occurredAt: new Date().toISOString(),
      messageId: message.messageId,
      payload: { status: "final", ...(attachments.length ? { attachments } : {}) },
    });
  }
}
