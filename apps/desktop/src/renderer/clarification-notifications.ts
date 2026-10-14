import type { ConversationSyncEffect } from "@eco/shared";
import type { ThreadLiveEvent } from "../shared/ipc";

/** Question reminders are independent of whether the conversation Feed has been loaded. */
export function createClarificationNotifications(deps: {
  refreshPending(threadId: string): Promise<void>;
  notify(threadId: string, toolUseId: string): void;
  onError(error: unknown): void;
}) {
  const seen = new Set<string>();
  const remember = (threadId: string, toolUseId: string): boolean => {
    const key = JSON.stringify([threadId, toolUseId]);
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 512) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };
  const refresh = (threadId: string) => {
    void deps.refreshPending(threadId).catch(deps.onError);
  };

  return {
    handleSyncEffect(threadId: string, effect: ConversationSyncEffect["effect"]): void {
      if (effect.type !== "detail.upsert") return;
      const detail = effect.detail;
      if (detail.type !== "clarification.requested" && detail.type !== "clarification.resolved") return;
      refresh(threadId);
      if (
        detail.toolCallId &&
        remember(threadId, detail.toolCallId) &&
        detail.type === "clarification.requested"
      ) {
        deps.notify(threadId, detail.toolCallId);
      }
    },
    handleLiveEvent(event: ThreadLiveEvent): void {
      if (!event.type.startsWith("clarification.")) return;
      refresh(event.threadId);
      const toolUseId = event.clarification?.toolUseId ?? event.tool?.toolUseId;
      if (toolUseId && remember(event.threadId, toolUseId) && event.type === "clarification.requested") {
        deps.notify(event.threadId, toolUseId);
      }
    },
  };
}
