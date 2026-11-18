import type { ConversationSyncEffect } from "@eco/shared";

const sizes = new WeakMap<ConversationSyncEffect, number>();
function bytes(effect: ConversationSyncEffect): number {
  let size = sizes.get(effect);
  if (size === undefined) {
    size = JSON.stringify(effect).length * 2;
    sizes.set(effect, size);
  }
  return size;
}

/** An overflow requires a fresh durable snapshot, rather than retaining an ever growing event queue. */
export function appendFeedEffect(pending: ConversationSyncEffect[], effect: ConversationSyncEffect): boolean {
  if (
    pending.length >= 512 ||
    pending.reduce((total, row) => total + bytes(row), bytes(effect)) > 2 * 1024 * 1024
  )
    return false;
  pending.push(effect);
  return true;
}
