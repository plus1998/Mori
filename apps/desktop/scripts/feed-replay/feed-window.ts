import { decodeConversationCursor, estimateConversationBytes } from "@eco/shared";
import type {
  ConversationFeedWindow,
  ConversationFeedWindowRequest,
} from "../../src/shared/conversation-feed-window";
import { FEED_PAGE_BYTES, buildTimelineFeedWindow } from "../../src/shared/conversation-feed-window";
import { boundConversationFeedState } from "../../src/renderer/conversation-v2-feed-window-state";
import type { ConversationV2RendererState } from "../../src/renderer/conversation-v2-renderer-state";

/** Recorded read-model adapter. The fixture owns the full history; App receives only its requested window. */
export function replayFeedWindow(
  source: ConversationV2RendererState,
  request: ConversationFeedWindowRequest,
): ConversationFeedWindow {
  if (request.conversationId !== source.conversationId) throw new Error("Replay Feed conversation mismatch.");
  if (request.timeline) {
    const counts: Record<string, number> = {};
    for (const tool of source.tools.values()) counts[tool.runId] = (counts[tool.runId] ?? 0) + 1;
    return buildTimelineFeedWindow(
      {
        protocolVersion: 2,
        conversationId: source.conversationId,
        storeEpoch: source.storeEpoch,
        snapshotSeq: source.appliedSeq,
        historyRevision: source.historyRevision,
        messages: [...source.messages.values()],
        tools: [...source.tools.values()],
        turns: [],
        runs: [...source.runs.values()],
        agents: [...source.agents.values()],
        todos: [...source.todos.values()],
        details: [...source.details.values()],
        toolSummaryCounts: counts,
        hasOlder: false,
      },
      request,
    );
  }
  const cursor = (value: string | undefined, kind: "messages" | "tools") => {
    if (!value) return undefined;
    const decoded = decodeConversationCursor(value, kind);
    if (decoded.storeEpoch !== source.storeEpoch || decoded.historyRevision !== source.historyRevision)
      throw new Error("Replay Feed cursor belongs to another history revision.");
    return decoded;
  };
  const before = cursor(request.beforeCursor, "messages");
  const toolBefore = cursor(request.toolCursor, "tools");
  const messages = new Map(
    [...source.messages].filter(([, message]) => {
      if (message.isDeleted) return false;
      if (!before) return true;
      const at = message.occurredAt ?? "";
      return (
        at < (before.occurredAt ?? "") ||
        (at === (before.occurredAt ?? "") &&
          (message.createdSeq < before.createdSeq ||
            (message.createdSeq === before.createdSeq && message.messageId < before.id)))
      );
    }),
  );
  const toolSummaryCounts = new Map<string, number>();
  for (const tool of source.tools.values())
    toolSummaryCounts.set(tool.runId, (toolSummaryCounts.get(tool.runId) ?? 0) + 1);
  let bounded = boundConversationFeedState({
    ...source,
    messages,
    toolSummaryCounts,
    hasOlder: false,
    feedWindow: { mode: "latest", request, toolPages: {} },
  });
  const visibleRuns = new Set(
    [...bounded.messages.values()].flatMap((message) => (message.runId ? [message.runId] : [])),
  );
  if (!before)
    for (const run of source.runs.values())
      if (["running", "queued"].includes(run.status)) visibleRuns.add(run.runId);
  if (!visibleRuns.size && !bounded.messages.size)
    for (const run of bounded.runs.values()) visibleRuns.add(run.runId);
  if (request.toolRunId && !visibleRuns.has(request.toolRunId))
    throw new Error("Replay tool run is outside the Feed window.");
  const tools = new Map(
    [...source.tools].filter(([, tool]) => {
      if (!visibleRuns.has(tool.runId) || (request.toolRunId && tool.runId !== request.toolRunId))
        return false;
      return (
        !toolBefore ||
        tool.createdSeq < toolBefore.createdSeq ||
        (tool.createdSeq === toolBefore.createdSeq && tool.toolCallId < toolBefore.id)
      );
    }),
  );
  bounded = boundConversationFeedState({ ...bounded, tools, toolSummaryCounts });
  const response: ConversationFeedWindow = {
    protocolVersion: 2,
    conversationId: source.conversationId,
    storeEpoch: source.storeEpoch,
    snapshotSeq: source.appliedSeq,
    historyRevision: source.historyRevision,
    messages: [...bounded.messages.values()],
    turns: [],
    runs: [...source.runs.values()].filter((run) => visibleRuns.has(run.runId)),
    tools: [...bounded.tools.values()],
    agents: [...bounded.agents.values()],
    todos: [...bounded.todos.values()],
    details: [...bounded.details.values()],
    toolSummaryCounts: Object.fromEntries([...toolSummaryCounts].filter(([runId]) => visibleRuns.has(runId))),
    hasOlder: bounded.hasOlder,
    ...(bounded.olderCursor ? { olderCursor: bounded.olderCursor } : {}),
    toolPages: Object.fromEntries(
      Object.entries(bounded.feedWindow!.toolPages).filter(([runId]) => visibleRuns.has(runId)),
    ),
  };
  if (request.toolRunId) {
    const remaining = [...tools.values()].filter(
      (tool) => !response.tools.some((row) => row.toolCallId === tool.toolCallId),
    );
    response.toolPages[request.toolRunId]!.hasOlder = remaining.length > 0;
    if (!remaining.length) delete response.toolPages[request.toolRunId]!.olderCursor;
  }
  // Fail explicitly if the recording needs a richer payload-budget adapter; never return unbounded data.
  if (estimateConversationBytes(response) > FEED_PAGE_BYTES)
    throw new Error("Replay Feed window exceeds its recorded page budget.");
  return response;
}
