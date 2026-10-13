import type { ThreadRunProjectionMainFeedEntry } from "./conversation-v2-projection-view";
import { projectionItemToDetailBlock } from "./conversation-v2-projection-view";
import type { ThreadRunTurnFeedSection } from "./conversation-v2-turn-feed";

/**
 * Typing pace follows only the last still-streaming feed entry in display order
 * (turn processEntries then finalEntry). Earlier streaming rows (e.g. thinking)
 * must snap to full text so later narrative does not appear while thinking is
 * still catching up.
 */
export function resolveFeedPaceTargetKey(sections: readonly ThreadRunTurnFeedSection[]): string | null {
  let targetKey: string | null = null;
  for (const section of sections) {
    if (section.kind === "entry") {
      const key = resolvePaceEntryKey(section.entry);
      if (key) {
        targetKey = key;
      }
      continue;
    }
    if (section.kind === "active-tail") {
      continue;
    }
    for (const entry of section.processEntries) {
      const key = resolvePaceEntryKey(entry);
      if (key) {
        targetKey = key;
      }
    }
    if (section.finalEntry) {
      const key = resolvePaceEntryKey(section.finalEntry);
      if (key) {
        targetKey = key;
      }
    }
  }
  return targetKey;
}

function resolvePaceEntryKey(entry: ThreadRunProjectionMainFeedEntry): string | null {
  if (entry.kind !== "timeline" && entry.kind !== "agent-echo") {
    return null;
  }
  const block = projectionItemToDetailBlock(entry.item);
  if (!block || (block.kind !== "thinking" && block.kind !== "narrative")) {
    return null;
  }
  if (!block.streaming || !block.text.trim()) {
    return null;
  }
  return entry.key;
}
