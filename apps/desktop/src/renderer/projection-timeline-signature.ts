import type { ThreadRunProjectionTimelineItem } from "../shared/ipc";

// Projection reducers replace changed items and metadata. A WeakMap lets settled
// history reuse serialization across layout, row and agent-card comparisons.
const signatures = new WeakMap<ThreadRunProjectionTimelineItem, string>();

export function projectionTimelineItemRenderSignature(item: ThreadRunProjectionTimelineItem): string {
  const cached = signatures.get(item);
  if (cached !== undefined) return cached;
  const signature = JSON.stringify([
    item.id,
    item.sequence,
    item.eventType,
    item.scope,
    item.role ?? "",
    item.agentId ?? "",
    item.runAttemptId ?? "",
    item.requestId ?? "",
    item.streamKey ?? "",
    item.at,
    item.text,
    item.summary ?? "",
    item.contentLoaded,
    item.contentAvailable,
    item.metadata ?? null,
  ]);
  signatures.set(item, signature);
  return signature;
}
