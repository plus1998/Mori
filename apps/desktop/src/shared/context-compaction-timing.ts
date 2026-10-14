import { isContextCompactionEventType } from "./thread-run-events";

export interface ContextCompactionTiming {
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
}

export interface ContextCompactionTimingItem {
  eventType: string;
  at: string;
  scope: string;
  runAttemptId?: string;
  agentId?: string;
  requestId?: string;
  streamKey?: string;
  metadata?: Record<string, unknown>;
}

/** Measures only a matching, still-open compaction; unrelated turns cannot supply its start. */
export function resolveContextCompactionTiming(
  item: ContextCompactionTimingItem,
  previous: readonly ContextCompactionTimingItem[],
): ContextCompactionTiming | undefined {
  if (!Number.isFinite(Date.parse(item.at))) return undefined;
  if (item.eventType === "context.compaction.started") return { startedAt: item.at };
  if (item.eventType !== "context.compaction.completed" && item.eventType !== "context.compaction.failed") {
    return undefined;
  }
  for (let index = previous.length - 1; index >= 0; index--) {
    const candidate = previous[index];
    if (!candidate || !isContextCompactionEventType(candidate.eventType) || !sameOperation(item, candidate)) {
      continue;
    }
    if (candidate.eventType === "context.compaction.suspended") continue;
    if (candidate.eventType !== "context.compaction.started") return undefined;
    const durationMs = Date.parse(item.at) - Date.parse(candidate.at);
    return Number.isFinite(durationMs) && durationMs >= 0
      ? { startedAt: candidate.at, endedAt: item.at, durationMs }
      : undefined;
  }
  return undefined;
}

function sameOperation(left: ContextCompactionTimingItem, right: ContextCompactionTimingItem): boolean {
  return (
    left.scope === right.scope &&
    left.runAttemptId === right.runAttemptId &&
    left.agentId === right.agentId &&
    (left.requestId ?? text(left.metadata?.turnId)) === (right.requestId ?? text(right.metadata?.turnId)) &&
    (left.streamKey ?? text(left.metadata?.itemId)) === (right.streamKey ?? text(right.metadata?.itemId)) &&
    text(left.metadata?.codexThreadId) === text(right.metadata?.codexThreadId) &&
    compatibleCompactionIdentity(left.metadata?.compaction, right.metadata?.compaction)
  );
}

function compatibleCompactionIdentity(left: unknown, right: unknown): boolean {
  const a = left && typeof left === "object" ? (left as Record<string, unknown>) : {};
  const b = right && typeof right === "object" ? (right as Record<string, unknown>) : {};
  return ["sessionId", "archiveId", "trigger"].every(
    (key) => !text(a[key]) || !text(b[key]) || a[key] === b[key],
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
