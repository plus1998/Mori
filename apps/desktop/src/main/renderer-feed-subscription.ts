import type { ConversationSyncEffect } from "@eco/shared";

/** Filter before Electron structured-clones background Feed bodies. Notifications stay independent. */
export function shouldDeliverFeedEvent(selectedId: string | undefined, payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return true;
  const event = payload as {
    conversationId?: string;
    threadId?: string;
    effect?: ConversationSyncEffect;
    stream?: boolean;
  };
  if (event.conversationId && event.effect) {
    if (event.conversationId === selectedId) return true;
    const effect = event.effect.effect;
    return effect.type === "detail.upsert" && effect.detail.type.startsWith("clarification.");
  }
  return !event.stream || event.threadId === selectedId;
}
