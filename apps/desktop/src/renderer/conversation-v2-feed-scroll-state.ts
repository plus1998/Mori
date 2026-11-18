import {
  FEED_RESIDENT_BYTES,
  FEED_TIMELINE_PAGE_LIMIT,
  FEED_TIMELINE_RESIDENT_LIMIT,
  feedTimelineCursor,
  feedTimelineEntries,
} from "../shared/conversation-feed-window";
import type { ConversationV2RendererState } from "./conversation-v2-renderer-state";

const rowBytes = new WeakMap<object, number>();
function estimateRow(value: object): number {
  let size = rowBytes.get(value);
  if (size === undefined) {
    size = JSON.stringify(value).length * 2;
    rowBytes.set(value, size);
  }
  return size;
}

/** Keep the directional page and visible anchors inside a bounded resident set. */
export function boundTimelineFeedState(
  state: ConversationV2RendererState,
  direction: "older" | "newer" = "newer",
  protectedKeys: ReadonlySet<string> = new Set(),
  requiredKeys: ReadonlySet<string> = new Set(),
): ConversationV2RendererState {
  if (!state.feedWindow?.request.timeline) return state;
  const entries = feedTimelineEntries({ messages: state.messages.values(), tools: state.tools.values() });
  const protectedIndexes = entries.flatMap((row, index) => (protectedKeys.has(row.key) ? [index] : []));
  const requiredIndexes = entries.flatMap((row, index) => (requiredKeys.has(row.key) ? [index] : []));
  const mustKeepIndexes = new Set([...protectedIndexes, ...requiredIndexes]);
  const residentLimit =
    FEED_TIMELINE_RESIDENT_LIMIT + (protectedIndexes.length ? FEED_TIMELINE_PAGE_LIMIT : 0);
  if (mustKeepIndexes.size > residentLimit)
    throw new Error("Visible Feed content exceeds the resident window.");

  // Keep the directional page at the edge, then add visible rows that the
  // projection may place outside the chronological slice. The previous
  // contiguous-only range could keep the visible tail while evicting every
  // newly fetched older page; subsequent wheels then advanced the cursor over
  // history the user had never seen. A sparse bounded set preserves both the
  // page being read and the anchor rows, while still releasing the rest.
  const start = direction === "older" ? 0 : Math.max(0, entries.length - FEED_TIMELINE_RESIDENT_LIMIT);
  const end = direction === "older" ? Math.min(entries.length, FEED_TIMELINE_RESIDENT_LIMIT) : entries.length;
  const selectedIndexes = new Set<number>();
  for (let index = start; index < end; index += 1) selectedIndexes.add(index);
  for (const index of mustKeepIndexes) selectedIndexes.add(index);
  while (selectedIndexes.size > residentLimit) {
    const candidates = [...selectedIndexes]
      .filter((index) => !mustKeepIndexes.has(index))
      .sort((left, right) => direction === "older" ? right - left : left - right);
    const drop = candidates[0];
    if (drop === undefined) throw new Error("Visible Feed content exceeds the resident window.");
    selectedIndexes.delete(drop);
  }

  let bytes = [...selectedIndexes].reduce(
    (total, index) => total + estimateRow(entries[index]!.message ?? entries[index]!.tool),
    0,
  );
  while (bytes > FEED_RESIDENT_BYTES && selectedIndexes.size > 1) {
    const candidates = [...selectedIndexes]
      .filter((index) => !mustKeepIndexes.has(index))
      .sort((left, right) => direction === "older" ? right - left : left - right);
    const drop = candidates[0];
    if (drop === undefined) throw new Error("Visible Feed content exceeds its byte budget.");
    selectedIndexes.delete(drop);
    bytes -= estimateRow(entries[drop]!.message ?? entries[drop]!.tool);
  }
  const selected = entries.filter((_, index) => selectedIndexes.has(index));
  const first = selected[0],
    last = selected.at(-1);
  const messages = new Map(
    selected.flatMap((row) => (row.message ? [[row.message.messageId, row.message] as const] : [])),
  );
  const tools = new Map(
    selected.flatMap((row) => (row.tool ? [[row.tool.toolCallId, row.tool] as const] : [])),
  );
  const runIds = new Set([...messages.values()].flatMap((row) => (row.runId ? [row.runId] : [])));
  for (const tool of tools.values()) runIds.add(tool.runId);
  const keepOlder = first && entries[0] && first.key !== entries[0].key;
  const keepNewer = last && entries.at(-1) && last.key !== entries.at(-1)!.key;
  return {
    ...state,
    messages,
    tools,
    runs: new Map(
      [...state.runs].filter(
        ([id, run]) =>
          runIds.has(id) ||
          (state.feedWindow?.mode === "latest" && ["running", "queued"].includes(run.status)),
      ),
    ),
    agents: new Map(
      [...state.agents].filter(([, agent]) => !agent.runId || runIds.has(agent.runId)).slice(-120),
    ),
    details: new Map(
      [...state.details]
        .filter(
          ([, detail]) =>
            (detail.type.startsWith("context.compaction.") &&
              !!first &&
              detail.createdSeq >= first.seq &&
              (!(state.feedWindow?.hasNewer || keepNewer) || detail.createdSeq <= last!.seq)) ||
            (detail.toolCallId && tools.has(detail.toolCallId)),
        )
        .slice(-120),
    ),
    toolSummaryCounts: new Map([...(state.toolSummaryCounts ?? [])].filter(([id]) => runIds.has(id))),
    hasOlder: state.hasOlder || !!keepOlder,
    feedWindow: {
      ...state.feedWindow,
      mode: state.feedWindow.hasNewer || keepNewer ? "history" : state.feedWindow.mode,
      toolPages: {},
      hasNewer: state.feedWindow.hasNewer || !!keepNewer,
      ...(first ? { olderFeedCursor: feedTimelineCursor(state, first) } : {}),
      ...(last ? { newerFeedCursor: feedTimelineCursor(state, last) } : {}),
    },
  };
}

export function mergeTimelineFeedWindow(
  current: ConversationV2RendererState,
  page: ConversationV2RendererState,
  direction: "older" | "newer",
  protectedKeys?: ReadonlySet<string>,
): ConversationV2RendererState {
  if (
    current.conversationId !== page.conversationId ||
    current.storeEpoch !== page.storeEpoch ||
    current.historyRevision !== page.historyRevision
  )
    throw new Error("Feed history changed while scrolling. Return to the latest messages to reload it.");
  const combined = {
    ...page,
    messages: new Map([...current.messages, ...page.messages]),
    tools: new Map([...current.tools, ...page.tools]),
    runs: new Map([...current.runs, ...page.runs]),
    agents: new Map([...current.agents, ...page.agents]),
    details: new Map([...current.details, ...page.details]),
    toolSummaryCounts: new Map([...(current.toolSummaryCounts ?? []), ...(page.toolSummaryCounts ?? [])]),
    appliedSeq: Math.max(current.appliedSeq, page.appliedSeq),
    hasOlder: direction === "older" ? page.hasOlder : current.hasOlder,
    feedWindow: {
      ...page.feedWindow!,
      hasNewer:
        direction === "older"
          ? (current.feedWindow?.hasNewer ?? false)
          : (page.feedWindow?.hasNewer ?? false),
    },
  };
  const pageKeys = new Set([
    ...[...page.messages.values()].map((message) => `m:${message.messageId}`),
    ...[...page.tools.values()].map((tool) => `t:${tool.toolCallId}`),
  ]);
  const bounded = boundTimelineFeedState(combined, direction, protectedKeys, pageKeys);
  // The resident window may have to keep a visible row that sits after the
  // fetched page. In that case its first/last resident row is not the page
  // boundary; using that row as the next cursor would request the same page
  // forever. Advance the directional cursor from the page we actually
  // consumed, even when its rows were evicted immediately to protect the
  // viewport.
  const pageContributed = [...pageKeys].some((key) =>
    bounded.messages.has(key.slice(2)) || bounded.tools.has(key.slice(2)),
  );
  if (pageContributed && bounded.feedWindow && page.feedWindow) {
    if (direction === "older") {
      const { olderFeedCursor: _currentCursor, ...withoutCursor } = bounded.feedWindow;
      bounded.feedWindow = {
        ...withoutCursor,
        ...(page.feedWindow.olderFeedCursor
          ? { olderFeedCursor: page.feedWindow.olderFeedCursor }
          : {}),
      };
    } else {
      const { newerFeedCursor: _currentCursor, ...withoutCursor } = bounded.feedWindow;
      bounded.feedWindow = {
        ...withoutCursor,
        ...(page.feedWindow.newerFeedCursor
          ? { newerFeedCursor: page.feedWindow.newerFeedCursor }
          : {}),
      };
    }
  }
  if (current.projectionExtras && bounded.projectionExtras) {
    const visibleIds = new Set([
      ...bounded.runs.keys(),
      ...[...bounded.messages.values()].map((message) => message.turnId),
    ]);
    const spans = new Map(
      [...current.projectionExtras.requestSpans, ...bounded.projectionExtras.requestSpans].map((row) => [
        row.requestId,
        row,
      ]),
    );
    bounded.projectionExtras = {
      ...bounded.projectionExtras,
      requestSpans: [...spans.values()].filter((row) => visibleIds.has(row.requestId)).slice(-120),
    };
  }
  return bounded;
}
