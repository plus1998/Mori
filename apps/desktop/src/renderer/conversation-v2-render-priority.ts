import type { ConversationSyncEffect } from "@eco/shared";

/** Prompt acknowledgements and terminal run facts must not wait behind streamed text. */
export function isConversationV2InteractionEffect(effect: ConversationSyncEffect["effect"]): boolean {
  return (
    (effect.type === "message.create" && effect.message.role === "user") ||
    (effect.type === "run.upsert" && effect.run.status !== "running" && effect.run.status !== "queued")
  );
}
