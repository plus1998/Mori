import {
  decodeConversationCursor,
  encodeConversationCursor,
  estimateConversationBytes,
  type ConversationBootstrap,
  type ConversationMessage,
  type ConversationToolCall,
} from "@eco/shared";

export const FEED_MESSAGE_LIMIT = 60;
export const FEED_TOOL_LIMIT = 100;
export const FEED_PAGE_BYTES = 512 * 1024;
export const FEED_RESIDENT_BYTES = 2 * 1024 * 1024;
export const FEED_TIMELINE_PAGE_LIMIT = 60;
export const FEED_TIMELINE_RESIDENT_LIMIT = 120;

export interface ConversationFeedWindowRequest {
  conversationId: string;
  skeleton?: boolean;
  beforeCursor?: string;
  toolRunId?: string;
  toolCursor?: string;
  timeline?: boolean;
  beforeFeedCursor?: string;
  afterFeedCursor?: string;
}

export interface ConversationFeedWindow extends ConversationBootstrap {
  /** The response is the complete lightweight Feed skeleton, not a timeline page. */
  skeleton?: boolean;
  timeline?: boolean;
  olderFeedCursor?: string;
  newerFeedCursor?: string;
  hasNewer?: boolean;
  toolPages: Record<string, { total: number; hasOlder: boolean; olderCursor?: string }>;
}

/** Prompts and failure notices are visible even with no active run or assistant answer. */
export function isStandaloneFeedSkeletonMessage(message: Pick<ConversationMessage, "role" | "channel">): boolean {
  return (message.role === "user" && message.channel === "answer") ||
    (message.role === "system" && message.channel === "system");
}

export type FeedTimelineEntry =
  | { key: string; seq: number; message: ConversationMessage; tool?: never }
  | { key: string; seq: number; tool: ConversationToolCall; message?: never };

export function feedTimelineEntries(source: {
  messages: Iterable<ConversationMessage>;
  tools: Iterable<ConversationToolCall>;
}): FeedTimelineEntry[] {
  return [
    ...[...source.messages].map((message) => ({
      key: `m:${message.messageId}`,
      seq: message.createdSeq,
      message,
    })),
    ...[...source.tools].map((tool) => ({ key: `t:${tool.toolCallId}`, seq: tool.createdSeq, tool })),
  ].sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key));
}

export function feedTimelineCursor(
  source: { storeEpoch: string; historyRevision: number },
  entry: FeedTimelineEntry,
): string {
  return encodeConversationCursor({
    kind: "feed",
    storeEpoch: source.storeEpoch,
    historyRevision: source.historyRevision,
    createdSeq: entry.seq,
    id: entry.key,
  });
}

/** A single chronological cursor covers messages AND tools, including a run with no new messages. */
export function buildTimelineFeedWindow(
  base: ConversationBootstrap,
  request: ConversationFeedWindowRequest,
): ConversationFeedWindow {
  if (request.beforeFeedCursor && request.afterFeedCursor)
    throw new Error("Feed cursor direction is ambiguous.");
  const value = request.beforeFeedCursor ?? request.afterFeedCursor;
  const cursor = value ? decodeConversationCursor(value, "feed") : undefined;
  if (cursor && (cursor.storeEpoch !== base.storeEpoch || cursor.historyRevision !== base.historyRevision))
    throw new Error("Feed cursor belongs to another history revision.");
  const entries = feedTimelineEntries(base);
  const candidates = entries.filter(
    (entry) =>
      !cursor ||
      (request.afterFeedCursor
        ? entry.seq > cursor.createdSeq || (entry.seq === cursor.createdSeq && entry.key > cursor.id)
        : entry.seq < cursor.createdSeq || (entry.seq === cursor.createdSeq && entry.key < cursor.id)),
  );
  if (!request.afterFeedCursor) candidates.reverse();
  let selected = candidates.slice(0, FEED_TIMELINE_PAGE_LIMIT);
  const build = (): ConversationFeedWindow => {
    const ascending = [...selected].sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key));
    const first = ascending[0],
      last = ascending.at(-1);
    const messages = ascending.flatMap((entry) => (entry.message ? [entry.message] : []));
    const tools = ascending.flatMap((entry) => (entry.tool ? [entry.tool] : []));
    const runIds = new Set([
      ...messages.flatMap((row) => (row.runId ? [row.runId] : [])),
      ...tools.map((row) => row.runId),
    ]);
    const hasOlder =
      !!first &&
      entries.some((entry) => entry.seq < first.seq || (entry.seq === first.seq && entry.key < first.key));
    const hasNewer =
      !!last &&
      entries.some((entry) => entry.seq > last.seq || (entry.seq === last.seq && entry.key > last.key));
    const { olderCursor: _oldCursor, ...metadata } = base;
    return {
      ...metadata,
      timeline: true,
      messages,
      tools,
      turns: [],
      runs: base.runs.filter(
        (run) =>
          runIds.has(run.runId) ||
          (!request.beforeFeedCursor &&
            !request.afterFeedCursor &&
            ["running", "queued"].includes(run.status)),
      ),
      toolSummaryCounts: Object.fromEntries(
        Object.entries(base.toolSummaryCounts ?? {}).filter(([id]) => runIds.has(id)),
      ),
      details: (base.details ?? []).filter(
        (detail) =>
          (detail.type.startsWith("context.compaction.") &&
            !!first &&
            detail.createdSeq >= first.seq &&
            (hasNewer ? detail.createdSeq <= last!.seq : true)) ||
          tools.some((tool) => tool.toolCallId === detail.toolCallId),
      ),
      hasOlder,
      hasNewer,
      toolPages: {},
      ...(first ? { olderFeedCursor: feedTimelineCursor(base, first) } : {}),
      ...(last ? { newerFeedCursor: feedTimelineCursor(base, last) } : {}),
    };
  };
  let response = build();
  while (estimateConversationBytes(response) > FEED_PAGE_BYTES && selected.length > 1) {
    selected = selected.slice(0, -1);
    response = build();
  }
  if (estimateConversationBytes(response) > FEED_PAGE_BYTES)
    throw new Error("Feed window exceeds its page byte budget.");
  return response;
}
