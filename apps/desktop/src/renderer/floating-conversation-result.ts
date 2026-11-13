import { isMainAgentRole } from "@eco/shared";
import type { ThreadRunProjectionTimelineItem } from "../shared/ipc";

/** Preview actual main-agent output, never a user prompt or a child task result. */
export function floatingConversationResultPreview(timeline: readonly ThreadRunProjectionTimelineItem[]): string {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index]!;
    if (item.scope === "agent") continue;
    if (item.role === "user" || item.eventType === "run.attempt.started") break;
    if (item.eventType !== "message.final" || (item.role && !isMainAgentRole(item.role)) || !item.text.trim()) continue;
    return item.text.replace(/\s+/g, " ").trim();
  }
  return "";
}
