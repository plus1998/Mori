import { encodeConversationCursor } from "@eco/shared";
import type { ConversationMessage } from "@eco/shared";
import {
  FEED_MESSAGE_LIMIT, FEED_TOOL_LIMIT, FEED_RESIDENT_BYTES, isStandaloneFeedSkeletonMessage,
} from "../shared/conversation-feed-window";
import type { ConversationV2RendererState } from "./conversation-v2-renderer-state";
import { boundTimelineFeedState } from "./conversation-v2-feed-scroll-state";

// Unchanged entities are shared across stream commits; do not serialize their bodies on every token.
const entityBytes = new WeakMap<object, number>();
function residentBytes(value: object): number {
  const cached = entityBytes.get(value);
  if (cached !== undefined) return cached;
  const size = JSON.stringify(value).length * 2;
  entityBytes.set(value, size);
  return size;
}

/** Bound resident entities, not just DOM rows. A single oversized message is never silently truncated. */
export function boundConversationFeedState(state: ConversationV2RendererState): ConversationV2RendererState {
  if (state.feedWindow?.skeleton) {
    const activeRunIds = new Set(
      [...state.runs.values()]
        .filter((run) => run.status === "queued" || run.status === "running")
        .map((run) => run.runId),
    );
    // A tool can arrive before its lifecycle row in a live effect batch. Keep
    // started/running calls until the corresponding run upsert is folded so a
    // valid active call is not discarded at the batch boundary.
    for (const tool of state.tools.values()) {
      const run = state.runs.get(tool.runId);
      if (
        (tool.status === "started" || tool.status === "running") &&
        (!run || run.status === "queued" || run.status === "running")
      ) {
        activeRunIds.add(tool.runId);
      }
    }
    const residentRunIds = new Set([
      ...activeRunIds,
      ...(state.feedWindow.hydratedToolRunIds ?? []),
    ]);
    const finalAnswerByTurn = new Map<string, ConversationMessage>();
    const messages = new Map<string, ConversationMessage>();
    for (const message of state.messages.values()) {
      if (message.isDeleted || message.status === "deleted") continue;
      if (isStandaloneFeedSkeletonMessage(message)) {
        messages.set(message.messageId, message);
        continue;
      }
      if (message.role !== "assistant" || message.channel !== "answer") continue;
      const previous = finalAnswerByTurn.get(message.turnId);
      if (
        !previous ||
        message.versionSeq > previous.versionSeq ||
        (message.versionSeq === previous.versionSeq && message.createdSeq > previous.createdSeq)
      ) {
        finalAnswerByTurn.set(message.turnId, message);
      }
    }
    for (const message of finalAnswerByTurn.values()) {
      messages.set(message.messageId, message);
    }
    for (const message of state.messages.values()) {
      if (message.isDeleted || message.status === "deleted") continue;
      if (message.runId && residentRunIds.has(message.runId)) {
        messages.set(message.messageId, message);
      }
    }
    const tools = new Map(
      [...state.tools].filter(([, tool]) => residentRunIds.has(tool.runId)),
    );
    const details = new Map(
      [...state.details].filter(([, detail]) => residentRunIds.has(detail.runId)),
    );
    const toolSummaryCounts = new Map(
      [...(state.toolSummaryCounts ?? [])].filter(([runId]) => residentRunIds.has(runId)),
    );
    const toolPages: NonNullable<ConversationV2RendererState["feedWindow"]>["toolPages"] = {};
    for (const runId of residentRunIds) {
      const total = toolSummaryCounts.get(runId);
      const toolCount = [...tools.values()].filter((tool) => tool.runId === runId).length;
      if (total === undefined && toolCount === 0) continue;
      toolPages[runId] = { total: total ?? toolCount, hasOlder: false };
    }
    const sameEntries = <T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>) =>
      left.size === right.size && [...left].every(([id, value]) => right.get(id) === value);
    const existingToolPages = state.feedWindow.toolPages;
    const sameToolPages =
      Object.keys(existingToolPages).length === Object.keys(toolPages).length &&
      Object.entries(toolPages).every(([runId, page]) => {
        const previous = existingToolPages[runId];
        return previous?.total === page.total && previous.hasOlder === page.hasOlder;
      });
    if (
      sameEntries(state.messages, messages) &&
      sameEntries(state.tools, tools) &&
      sameEntries(state.details, details) &&
      sameEntries(state.toolSummaryCounts ?? new Map(), toolSummaryCounts) &&
      sameToolPages
    ) {
      return state;
    }
    return {
      ...state,
      messages,
      tools,
      details,
      toolSummaryCounts,
      feedWindow: { ...state.feedWindow, toolPages },
    };
  }
  if (state.feedWindow?.request.timeline && state.feedWindow.mode === "latest")
    return boundTimelineFeedState(state);
  if (!state.feedWindow || state.feedWindow.mode === "history") return state;
  let bytes = 0;
  const retain = <T extends object>(
    source: ReadonlyMap<string, T>,
    limit: number,
    compare: (left: T, right: T) => number,
  ) => {
    const rows = [...source.entries()].sort((a, b) => compare(b[1], a[1]) || b[0].localeCompare(a[0]));
    const result = new Map<string, T>();
    for (const [id, value] of rows) {
      const size = residentBytes(value);
      // Keep a contiguous suffix. Skipping an oversized row would make it unreachable by cursor.
      if (result.size >= limit || (bytes + size > FEED_RESIDENT_BYTES && result.size > 0)) break;
      result.set(id, value);
      bytes += size;
    }
    return result.size === source.size ? source : result;
  };
  const messages = retain(
    state.messages,
    FEED_MESSAGE_LIMIT,
    (a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? "") || a.createdSeq - b.createdSeq,
  );
  const tools = retain(state.tools, FEED_TOOL_LIMIT, (a, b) => a.createdSeq - b.createdSeq);
  const runIds = new Set([
    ...[...messages.values()].flatMap((message) => (message.runId ? [message.runId] : [])),
    ...[...tools.values()].map((tool) => tool.runId),
  ]);
  const runs = retain(
    new Map(
      [...state.runs].filter(
        ([id, run]) => runIds.has(id) || run.status === "running" || run.status === "queued",
      ),
    ),
    FEED_MESSAGE_LIMIT,
    (a, b) => a.versionSeq - b.versionSeq,
  );
  const details = retain(state.details, 100, (a, b) => a.createdSeq - b.createdSeq);
  const agents = retain(state.agents, 100, (a, b) => a.versionSeq - b.versionSeq);
  const toolSummaryCounts = new Map([...(state.toolSummaryCounts ?? [])].filter(([id]) => runs.has(id)));
  const toolPages: NonNullable<ConversationV2RendererState["feedWindow"]>["toolPages"] = {};
  for (const [runId, total] of toolSummaryCounts) {
    const rows = [...tools.values()]
      .filter((tool) => tool.runId === runId)
      .sort((a, b) => a.createdSeq - b.createdSeq);
    const oldest = rows[0];
    toolPages[runId] = {
      total,
      hasOlder: rows.length < total,
      ...(oldest && rows.length < total
        ? {
            olderCursor: encodeConversationCursor({
              kind: "tools",
              storeEpoch: state.storeEpoch,
              historyRevision: state.historyRevision,
              createdSeq: oldest.createdSeq,
              id: oldest.toolCallId,
            }),
          }
        : {}),
    };
  }
  // Persist the oldest boundary so evicted messages remain reachable from the database.
  const oldest = [...messages.values()].sort(
    (a, b) =>
      (a.occurredAt ?? "").localeCompare(b.occurredAt ?? "") ||
      a.createdSeq - b.createdSeq ||
      a.messageId.localeCompare(b.messageId),
  )[0];
  const evicted = messages.size < state.messages.size;
  return {
    ...state,
    messages,
    tools,
    runs,
    details,
    agents,
    toolSummaryCounts,
    hasOlder: state.hasOlder || evicted,
    ...((state.hasOlder || evicted) && oldest
      ? {
          olderCursor: encodeConversationCursor({
            kind: "messages",
            storeEpoch: state.storeEpoch,
            historyRevision: state.historyRevision,
            createdSeq: oldest.createdSeq,
            id: oldest.messageId,
            occurredAt: oldest.occurredAt ?? "",
          }),
        }
      : {}),
    feedWindow: { ...state.feedWindow, toolPages },
  };
}
