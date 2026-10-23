import { isMainAgentRole } from "@eco/shared";
import {
  isSubagentMissionEnvelope,
  parseSubagentMissionMessage,
  resolveMissionDisplayText,
} from "@eco/runtime/agent-mission";
import { isSkillActivityLabel } from "@eco/runtime/skill-display";
import { isReadToolName } from "@eco/runtime/tool-target";
import { isAcpSubagentAgentId } from "../shared/acp-subagent";
import {
  bashApprovalPhaseToLifecycle,
  clampActivityPreviewLine,
  compareToolActionLifecyclePriority,
  formatToolDisplayLabel,
  formatToolStatusPreview,
  isToolProgressStatusText,
  readBashApprovalMetadata,
  resolveBashRunCardDisplay,
  resolveFileChangeCardDisplay,
  resolveWebSearchCardDisplay,
  type ToolActionLifecycle,
  toolStatusToLifecycle,
} from "../shared/activity-display";
import {
  type ContextCompactionTiming,
  resolveContextCompactionTiming,
} from "../shared/context-compaction-timing";
import type { ActionKindTranslate } from "../shared/feed-action-kind";
import { parseThreadRunFileChangeMetadata } from "../shared/file-change";
import type {
  ThreadRunProjectionAgent,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
  ThreadRunToolMetadata,
} from "../shared/ipc";
import {
  collapsePromptCacheTimelineItems,
  isPromptCacheTimelineEventType,
  promptCacheTimelineStepFromItem,
  readPromptCacheTimelineMetadata,
} from "../shared/prompt-cache-timeline";
import { type PromptImagePreview, readPromptImagePreviews } from "../shared/prompt-image-metadata";
import { normalizeAgentDisplayRole } from "../shared/subagent-roles";
import {
  isReconnectActivityOrigin,
  isRedundantApiFailureBlockedMessage,
  isRequestFailureFeedNoiseOrigin,
  isTimelineItemSupersededByRecovery,
  isUpstreamErrorPhaseOrigin,
  isUserInterruptedTurnFailure,
  resolveReconnectPhaseDisplay,
  resolveThreadActivityOrigin,
} from "../shared/thread-activity-origin";
import {
  isRecordedUserPromptLiveEvent,
  isThreadFollowUpActivityMessage,
  isThreadFollowUpLiveEvent,
} from "../shared/thread-follow-up-events";
import { isContextCompactionEventType, parseThreadRunCodemodeMetadata, parseThreadRunImageViewMetadata } from "../shared/thread-run-events";
import {
  formatThreadRunToolDetailLabel,
  parseThreadRunGrepToolTarget,
  parseThreadRunReadToolTarget,
  resolveGrepToolTargetDisplayFromToolMetadata,
  resolveReadToolTargetDisplayFromToolMetadata,
} from "../shared/tool-target";
import {
  type ActivityDetailBlock,
  iconForToolName,
  reasoningSummaryLabel,
  resolveSubagentRunDisplayTitle,
} from "./activity-log";
import { i18n } from "./i18n";
import type { RuntimeAgentDisplayNames } from "./runtime-agent-display";
import { type ThinkingDisplayMode, thinkingModeUsesEphemeralTip } from "./thinking-display-preferences";

const translateActionKind: ActionKindTranslate = (key, vars) => (vars ? i18n.t(key, vars) : i18n.t(key));

export interface ThreadRunProjectionViewModel {
  showThreadPrompt: boolean;
  mainFeedEntries: ThreadRunProjectionMainFeedEntry[];
  mainItemIds: string[];
  subagentCards: ThreadRunProjectionSubagentCard[];
}

export type ThreadRunProjectionTimelineFeedEntry = {
  kind: "timeline";
  key: string;
  item: ThreadRunProjectionTimelineItem;
  at: string;
  sequence: number;
};

export type ThreadRunProjectionAgentEchoFeedEntry = {
  kind: "agent-echo";
  key: string;
  item: ThreadRunProjectionTimelineItem;
  agent: ThreadRunProjectionAgent;
  agentLabel: string;
  at: string;
  sequence: number;
};

export type ThreadRunProjectionToolGroupFeedEntry = {
  kind: "tool-group";
  key: string;
  entries: Array<ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry>;
  at: string;
  sequence: number;
};

export type ThreadRunProjectionMainFeedEntry =
  | ThreadRunProjectionTimelineFeedEntry
  | ThreadRunProjectionAgentEchoFeedEntry
  | ThreadRunProjectionToolGroupFeedEntry
  | {
      kind: "agent-card";
      key: string;
      card: ThreadRunProjectionSubagentCard;
      at: string;
      sequence: number;
    };

export interface ThreadRunProjectionSubagentCard {
  key: string;
  agent: ThreadRunProjectionAgent;
  timelineIds: string[];
  running: boolean;
  statusText?: string;
  /** Resolved from the full agent timeline before display filtering. */
  missionText: string;
  /**
   * When false, the card is status-only (no Task drawer).
   * Cursor ACP nested subagents have no inspectable transcript on the wire.
   */
  openable: boolean;
  /** Images submitted with the user prompt and available to image_view. */
  promptImages?: PromptImagePreview[];
}

export function buildThreadRunProjectionViewModel(
  projection: ThreadRunProjectionSnapshot,
  thread?: { id: string; prompt: string },
  options: {
    agentDisplayNames?: RuntimeAgentDisplayNames | undefined;
    /** When false, prompt-cache / cache-break tips are omitted from the feed UI. Default true. */
    includePromptCacheTips?: boolean | undefined;
    /**
     * When `ephemeral`, raw thinking is presented like OpenAI reasoning summary tips
     * (reasoning-stage + collapse until superseded). Collapsed/expanded keep thinking cards.
     * Omit to leave raw thinking as cards (tests / callers that do not pass UI prefs).
     */
    thinkingDisplayMode?: ThinkingDisplayMode | undefined;
  } = {},
): ThreadRunProjectionViewModel {
  void options.agentDisplayNames;
  const includePromptCacheTips = options.includePromptCacheTips !== false;
  const thinkingDisplayMode = options.thinkingDisplayMode;
  const hasProjectedUserPrompt = projection.timeline.some(isProjectionUserPromptItem);
  const showThreadPrompt = Boolean(thread?.prompt.trim() && !hasProjectedUserPrompt);
  const conversationLive = !isThreadConversationStopped(projection.thread.status);
  const terminalAttemptIds = new Set(
    projection.attempts.filter((attempt) => attempt.status !== "running").map((attempt) => attempt.attemptId),
  );
  const requestSpansById = buildDisplayRequestSpansById(projection);
  const subagentCards = projection.agents
    .filter((agent) => agent.kind === "subagent")
    .map((agent) => {
      const running = agent.status === "active" || agent.status === "launching";
      const displayTimeline = filterProjectionTimelineForDetailFeed(
        agent.timeline,
        requestSpansById,
        includePromptCacheTips,
        thinkingDisplayMode,
        conversationLive && running,
        terminalAttemptIds,
      );
      const displayAgent: ThreadRunProjectionAgent = { ...agent, timeline: displayTimeline };
      // V2's latestActivity is copied from the raw timeline; it must not echo a tip
      // that the display lifecycle has already removed.
      if (
        agent.latestActivity &&
        agent.timeline.some(
          (item) =>
            (item.eventType === "thinking.delta" || item.eventType === "thinking.final") &&
            item.text.trim() === agent.latestActivity?.trim() &&
            !displayTimeline.some((visible) => visible.id === item.id),
        )
      ) {
        delete displayAgent.latestActivity;
      }
      const statusText = resolveProjectionAgentStatusText(displayAgent);
      const missionText = resolveSubagentCardMissionText(agent, {
        mainTimeline: projection.timeline,
      });
      return {
        key: agent.agentId,
        agent: displayAgent,
        timelineIds: displayTimeline.map((item) => item.id),
        running,
        missionText,
        openable: !isAcpSubagentAgentId(agent.agentId),
        promptImages: resolveSubagentPromptImages(agent, projection.timeline),
        ...(statusText && { statusText }),
      };
    });
  const mainFeedEntries = buildProjectionMainFeedEntries(
    projection.timeline,
    subagentCards,
    requestSpansById,
    includePromptCacheTips,
    thinkingDisplayMode,
    conversationLive,
    terminalAttemptIds,
  );
  return {
    showThreadPrompt,
    mainFeedEntries,
    mainItemIds: mainFeedEntries.map((entry) => {
      if (entry.kind === "timeline" || entry.kind === "agent-echo") {
        return entry.item.id;
      }
      if (entry.kind === "tool-group") {
        return entry.entries.map((child) => child.item.id).join(",");
      }
      return entry.key;
    }),
    subagentCards,
  };
}

function resolveSubagentPromptImages(
  agent: ThreadRunProjectionAgent,
  mainTimeline: readonly ThreadRunProjectionTimelineItem[],
): PromptImagePreview[] {
  if (normalizeAgentDisplayRole(agent.role) !== "vision") {
    return [];
  }
  for (let index = mainTimeline.length - 1; index >= 0; index -= 1) {
    const item = mainTimeline[index];
    if (!item || !isProjectionUserPromptItem(item)) {
      continue;
    }
    if (agent.startedAt && item.at && item.at > agent.startedAt) {
      continue;
    }
    return readPromptImagePreviews(item.metadata);
  }
  return [];
}

function buildDisplayRequestSpansById(
  projection: ThreadRunProjectionSnapshot,
): Map<string, ThreadRunProjectionSnapshot["requestSpans"][number]> {
  const terminalStatus = resolveTerminalDisplayRequestStatus(projection.thread.status);
  const endedAt = projection.thread.generatedAt;
  return new Map(
    projection.requestSpans.map((span) => {
      if (!terminalStatus || !isProjectionRequestActive(span)) {
        return [span.requestId, span];
      }
      return [
        span.requestId,
        {
          ...span,
          status: terminalStatus,
          endedAt: span.endedAt ?? endedAt,
        },
      ];
    }),
  );
}

function resolveTerminalDisplayRequestStatus(
  threadStatus: string,
): ThreadRunProjectionSnapshot["requestSpans"][number]["status"] | undefined {
  switch (threadStatus) {
    case "completed":
      return "completed";
    case "failed":
    case "blocked":
      return "failed";
    case "idle":
    case "awaiting_plan":
    case "cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

function buildProjectionMainFeedEntries(
  mainTimeline: readonly ThreadRunProjectionTimelineItem[],
  subagentCards: readonly ThreadRunProjectionSubagentCard[],
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
  includePromptCacheTips = true,
  thinkingDisplayMode: ThinkingDisplayMode = "collapsed",
  conversationLive = true,
  terminalAttemptIds?: ReadonlySet<string>,
): ThreadRunProjectionMainFeedEntry[] {
  const displayMainTimeline = filterAbsorbedSubagentDelegations(
    filterMainTimelineForFeed(
      mainTimeline,
      requestSpansById,
      includePromptCacheTips,
      thinkingDisplayMode,
      conversationLive,
      terminalAttemptIds,
    ),
    subagentCards,
    requestSpansById,
  );
  const toolSortAnchors = buildToolLifecycleSortAnchors([
    ...mainTimeline,
    ...subagentCards.flatMap((card) => card.agent.timeline),
  ]);
  const entries: Array<Exclude<ThreadRunProjectionMainFeedEntry, ThreadRunProjectionToolGroupFeedEntry>> =
    displayMainTimeline.map((item) => {
      const sortAnchor = resolveFeedEntrySortAnchor(item, toolSortAnchors);
      return {
        kind: "timeline",
        key: projectionMainFeedEntryKey(item, { requestSpansById, timeline: mainTimeline }),
        item,
        at: sortAnchor.at,
        sequence: sortAnchor.sequence,
      };
    });

  for (const card of subagentCards) {
    const cardSortAnchor = resolveSubagentCardSortAnchor(card, toolSortAnchors, mainTimeline);
    entries.push({
      kind: "agent-card",
      key: `agent-card:${card.agent.agentId}`,
      card,
      at: cardSortAnchor.at,
      sequence: cardSortAnchor.sequence,
    });
  }

  const sortedEntries = entries.sort((left, right) => compareMainFeedEntries(left, right, requestSpansById));
  const groupedTools = groupProjectionToolFeedEntries(sortedEntries);
  const groupedThinking = groupProjectionThinkingFeedEntries(groupedTools);
  const groupedReasoningStages = groupProjectionReasoningStageFeedEntries(groupedThinking);
  return replaceLatestToolWithReasoningStage(groupedReasoningStages);
}

/** Merge adjacent summary rows so one carousel owns all newline-delimited stages. */
function groupProjectionReasoningStageFeedEntries(
  entries: readonly ThreadRunProjectionMainFeedEntry[],
): ThreadRunProjectionMainFeedEntry[] {
  const grouped: ThreadRunProjectionMainFeedEntry[] = [];
  let pending: ThreadRunProjectionTimelineFeedEntry[] = [];

  const flush = () => {
    const first = pending[0];
    const last = pending.at(-1);
    if (!first || !last) {
      pending = [];
      return;
    }
    if (pending.length === 1) {
      grouped.push(first);
      pending = [];
      return;
    }
    const text = pending
      .map((entry) => entry.item.text.trim())
      .filter(Boolean)
      .join("\n");
    const item: ThreadRunProjectionTimelineItem = {
      ...first.item,
      eventType: pending.some((entry) => entry.item.eventType === "thinking.delta")
        ? "thinking.delta"
        : "thinking.final",
      text,
      at: last.item.at,
      metadata: {
        ...(first.item.metadata ?? {}),
        ...(last.item.metadata ?? {}),
      },
    };
    grouped.push({ ...first, item });
    pending = [];
  };

  for (const entry of entries) {
    if (entry.kind === "timeline" && isReasoningStageFeedEntry(entry)) {
      pending.push(entry);
      continue;
    }
    flush();
    grouped.push(entry);
  }
  flush();
  return grouped;
}

/** Keep Summary and the current process/tool aggregate mutually exclusive. */
function replaceLatestToolWithReasoningStage(
  entries: readonly ThreadRunProjectionMainFeedEntry[],
): ThreadRunProjectionMainFeedEntry[] {
  let summaryIndex = -1;
  let toolIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (summaryIndex < 0 && entry && isReasoningStageFeedEntry(entry)) {
      summaryIndex = index;
    }
    if (
      summaryIndex >= 0 &&
      entry &&
      isToolFeedEntry(entry) &&
      !hasReasoningSummaryBoundaryBetween(entries, entry, entries[summaryIndex])
    ) {
      toolIndex = index;
      break;
    }
  }
  if (summaryIndex <= toolIndex || summaryIndex < 0 || toolIndex < 0) {
    return [...entries];
  }
  const summary = entries[summaryIndex];
  const tool = entries[toolIndex];
  if (!summary || !tool) {
    return [...entries];
  }
  return [
    ...entries.slice(0, toolIndex),
    {
      ...summary,
      key: tool.key,
      at: tool.at,
      sequence: tool.sequence,
    },
    ...entries.slice(toolIndex + 1, summaryIndex),
    ...entries.slice(summaryIndex + 1),
  ];
}

function isReasoningStageFeedEntry(entry: ThreadRunProjectionMainFeedEntry): boolean {
  if (entry.kind !== "timeline" && entry.kind !== "agent-echo") {
    return false;
  }
  if (entry.item.eventType !== "thinking.delta" && entry.item.eventType !== "thinking.final") return false;
  return projectionItemToDetailBlock(entry.item)?.kind === "reasoning-stage";
}

function isToolFeedEntry(entry: ThreadRunProjectionMainFeedEntry): boolean {
  if (entry.kind === "tool-group") {
    return entry.entries.some((child) => isToolTimelineEntry(child.item));
  }
  if (entry.kind !== "timeline" && entry.kind !== "agent-echo") {
    return false;
  }
  return isToolTimelineEntry(entry.item);
}

function isToolTimelineEntry(item: ThreadRunProjectionTimelineItem): boolean {
  const block = projectionItemToDetailBlock(item);
  return block?.kind === "action" || block?.kind === "tool-failed";
}

function isReasoningSummaryBoundaryFeedEntry(entry: ThreadRunProjectionMainFeedEntry): boolean {
  if (entry.kind !== "timeline" && entry.kind !== "agent-echo") {
    return false;
  }
  if (entry.item.eventType !== "message.delta" && entry.item.eventType !== "message.final") return false;
  const block = projectionItemToDetailBlock(entry.item);
  return block?.kind === "narrative" && Boolean(block.text.trim());
}

function hasReasoningSummaryBoundaryBetween(
  entries: readonly ThreadRunProjectionMainFeedEntry[],
  tool: ThreadRunProjectionMainFeedEntry,
  summary: ThreadRunProjectionMainFeedEntry | undefined,
): boolean {
  if (!summary || (summary.kind !== "timeline" && summary.kind !== "agent-echo")) {
    return false;
  }
  return entries.some((entry) => {
    if (!isReasoningSummaryBoundaryFeedEntry(entry)) {
      return false;
    }
    return entry.sequence > tool.sequence && entry.sequence < summary.sequence;
  });
}

function groupProjectionToolFeedEntries(
  entries: readonly Exclude<ThreadRunProjectionMainFeedEntry, ThreadRunProjectionToolGroupFeedEntry>[],
): ThreadRunProjectionMainFeedEntry[] {
  const grouped: ThreadRunProjectionMainFeedEntry[] = [];
  let pending: Array<ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry> = [];

  const flush = () => {
    const first = pending[0];
    if (!first) {
      pending = [];
      return;
    }
    grouped.push({
      kind: "tool-group",
      // Keep the group mounted while adjacent tool events are appended so its
      // user-controlled expanded state is not reset by a changing React key.
      key: `tool-group:${first.key}`,
      entries: pending,
      at: first.at,
      sequence: first.sequence,
    });
    pending = [];
  };

  for (const entry of entries) {
    if (isGroupableToolFeedEntry(entry)) {
      pending.push(entry);
      continue;
    }
    flush();
    grouped.push(entry);
  }
  flush();
  return grouped;
}

function isGroupableToolFeedEntry(
  entry: Exclude<ThreadRunProjectionMainFeedEntry, ThreadRunProjectionToolGroupFeedEntry>,
): entry is ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry {
  if (entry.kind !== "timeline" && entry.kind !== "agent-echo") {
    return false;
  }
  const block = projectionItemToDetailBlock(entry.item);
  return (
    (block?.kind === "action" && !block.imageView && !block.imageDisplay && !block.htmlHost) ||
    block?.kind === "tool-failed"
  );
}

function groupProjectionThinkingFeedEntries(
  entries: readonly ThreadRunProjectionMainFeedEntry[],
): ThreadRunProjectionMainFeedEntry[] {
  const grouped: ThreadRunProjectionMainFeedEntry[] = [];
  let pending: Array<ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry> = [];

  const flush = () => {
    const first = pending[0];
    if (!first) {
      pending = [];
      return;
    }
    const mergedItem = collapseConsecutiveThinkingTimelineItems(pending.map((entry) => entry.item))[0];
    if (!mergedItem) {
      pending = [];
      return;
    }
    grouped.push({ ...first, item: mergedItem });
    pending = [];
  };

  for (const entry of entries) {
    if (isGroupableThinkingFeedEntry(entry)) {
      const previous = pending.at(-1);
      if (
        previous &&
        (previous.kind !== entry.kind || !canJoinConsecutiveThinkingItems(previous.item, entry.item))
      ) {
        flush();
      }
      pending.push(entry);
      continue;
    }
    flush();
    grouped.push(entry);
  }
  flush();
  return grouped;
}

function isGroupableThinkingFeedEntry(
  entry: ThreadRunProjectionMainFeedEntry,
): entry is ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry {
  if (entry.kind !== "timeline" && entry.kind !== "agent-echo") {
    return false;
  }
  if (entry.item.eventType !== "thinking.delta" && entry.item.eventType !== "thinking.final") return false;
  return projectionItemToDetailBlock(entry.item)?.kind === "thinking";
}

function filterMainTimelineForFeed(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
  includePromptCacheTips = true,
  thinkingDisplayMode: ThinkingDisplayMode = "collapsed",
  conversationLive = true,
  terminalAttemptIds?: ReadonlySet<string>,
): ThreadRunProjectionTimelineItem[] {
  const displayTimeline = filterProjectionTimelineForDetailFeed(
    timeline,
    requestSpansById,
    includePromptCacheTips,
    thinkingDisplayMode,
    conversationLive,
    terminalAttemptIds,
  );
  const requestFiltered = displayTimeline.filter(
    (item) => item.scope !== "agent" && !isMainTimelineNoiseItem(item, displayTimeline),
  );
  return filterCompactionTimelineForFeed(normalizePlanDismissalTimeline(requestFiltered));
}

function normalizePlanDismissalTimeline(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  const normalized: ThreadRunProjectionTimelineItem[] = [];
  for (const item of timeline) {
    if (!isPlanDismissalText(item.text)) {
      normalized.push(item);
      continue;
    }
    if (normalized.at(-1)?.text === i18n.t("projection.planDismissed")) {
      continue;
    }
    normalized.push({ ...item, text: i18n.t("projection.planDismissed") });
  }
  return normalized;
}

function isPlanDismissalText(text: string): boolean {
  const trimmed = text.trim();
  // Compatibility literals from persisted runtime history; do not localize matching.
  return (
    trimmed === "计划忽略" ||
    trimmed === "已忽略计划。" ||
    trimmed.startsWith("已忽略计划。可在下方继续对话说明修改意见")
  );
}

function filterAbsorbedSubagentDelegations(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  subagentCards: readonly ThreadRunProjectionSubagentCard[],
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): ThreadRunProjectionTimelineItem[] {
  const absorbedToolUseIds = collectAgentTimelineToolUseIds(subagentCards, requestSpansById);
  const subagentAgentIds = new Set(subagentCards.map((card) => card.agent.agentId));
  for (const card of subagentCards) {
    const parentToolUseId = card.agent.parentToolUseId?.trim();
    if (parentToolUseId) {
      absorbedToolUseIds.add(parentToolUseId);
    }
  }
  if (absorbedToolUseIds.size === 0 && subagentAgentIds.size === 0) {
    return [...timeline];
  }
  return timeline.filter((item) => {
    if (isSubagentMissionEnvelope(item.text)) {
      const mission = parseSubagentMissionMessage(item.text);
      if (mission) {
        const missionAgentId = mission.agentId?.trim();
        if (missionAgentId && subagentAgentIds.has(missionAgentId)) {
          return false;
        }
      }
      const itemAgentId = item.agentId?.trim();
      if (itemAgentId && subagentAgentIds.has(itemAgentId)) {
        return false;
      }
      const toolUseId =
        readProjectionToolMetadata(item)?.toolUseId?.trim() ??
        readProjectionBashApprovalMetadata(item)?.toolUseId?.trim();
      if (toolUseId && absorbedToolUseIds.has(toolUseId)) {
        return false;
      }
    }
    const bashApproval = readProjectionBashApprovalMetadata(item);
    if (bashApproval?.toolUseId?.trim() && absorbedToolUseIds.has(bashApproval.toolUseId.trim())) {
      return false;
    }
    if (item.eventType !== "tool.started" && item.eventType !== "tool.completed") {
      return true;
    }
    const toolUseId = readProjectionToolMetadata(item)?.toolUseId?.trim();
    return !toolUseId || !absorbedToolUseIds.has(toolUseId);
  });
}

function collectAgentTimelineToolUseIds(
  subagentCards: readonly ThreadRunProjectionSubagentCard[],
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): Set<string> {
  const ids = new Set<string>();
  for (const card of subagentCards) {
    const displayTimeline = filterProjectionTimelineForDetailFeed(card.agent.timeline, requestSpansById);
    for (const item of displayTimeline) {
      const toolUseId =
        readProjectionToolMetadata(item)?.toolUseId?.trim() ??
        readProjectionBashApprovalMetadata(item)?.toolUseId?.trim();
      if (toolUseId) {
        ids.add(toolUseId);
      }
    }
  }
  return ids;
}

function filterToolFailureDuplicateTimelineItems(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  const failedTools = new Set(
    timeline
      .filter((item) => item.eventType === "tool.failed")
      .map((item) => resolveProjectionToolName(item).toLowerCase()),
  );
  if (failedTools.size === 0) {
    return [...timeline];
  }
  return timeline.filter((item) => !isProjectionToolFailureDuplicateMessage(item, failedTools));
}

function isProjectionToolFailureDuplicateMessage(
  item: ThreadRunProjectionTimelineItem,
  failedTools: ReadonlySet<string>,
): boolean {
  if (item.eventType === "tool.failed") {
    return false;
  }
  const text = item.text.trim();
  if (!text) {
    return false;
  }
  // Compatibility literal emitted by older runtimes.
  if (text === "工具调用被拒绝") {
    return true;
  }
  const shortMatch = text.match(/^Permission denied for ([A-Za-z0-9_]+)$/i);
  if (shortMatch?.[1] && failedTools.has(shortMatch[1].toLowerCase())) {
    return true;
  }
  const fullMatch = text.match(/^Permission denied for ([A-Za-z0-9_]+):/i);
  if (fullMatch?.[1] && failedTools.has(fullMatch[1].toLowerCase())) {
    return true;
  }
  return false;
}

export function filterProjectionTimelineForDetailFeed(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
  includePromptCacheTips = true,
  thinkingDisplayMode: ThinkingDisplayMode = "collapsed",
  conversationLive = true,
  terminalAttemptIds?: ReadonlySet<string>,
): ThreadRunProjectionTimelineItem[] {
  const built = buildProjectionDisplayTimelineItems(
    withContextCompactionTimings(closeDanglingToolItemsForTerminalAttempts(timeline, terminalAttemptIds)),
    requestSpansById,
  ).filter(
    (item) =>
      !isEmptyTerminalThinkingItem(item) &&
      // Mission envelopes belong on the card/header, not as echoed speech in agent timelines.
      // (Previously dropped as a side effect of owner-key stream collapse on agent scope.)
      !isSubagentMissionEnvelope(item.text) &&
      (includePromptCacheTips || !isPromptCacheTimelineEventType(item.eventType)),
  );
  // 阅后即焚 → tip path; 折叠/展开 → keep raw thinking as cards.
  const forCollapse = thinkingModeUsesEphemeralTip(thinkingDisplayMode)
    ? presentThinkingAsEphemeralSummaryTips(built)
    : built;
  const displayTimeline = collapseEphemeralReasoningSummaryTimeline(
    collapsePromptCacheTimelineItems(forCollapse),
    conversationLive,
    terminalAttemptIds,
  );
  const requestsWithStreamRows = new Set(
    displayTimeline
      .filter(isStreamingRequestDisplayItem)
      .map(projectionRequestKey)
      .filter((key): key is string => Boolean(key)),
  );
  const latestActiveRequestStartedByOwner = buildLatestActiveRequestStartedByOwner(
    displayTimeline,
    requestSpansById,
  );

  return filterToolFailureDuplicateTimelineItems(
    filterProjectionToolProgressNoiseItems(
      displayTimeline.filter((item) => {
        if (isProjectionRequestTerminalItem(item)) {
          return false;
        }
        if (item.eventType !== "request.started") {
          return true;
        }
        const requestSpan = projectionRequestSpan(item, requestSpansById);
        if (requestSpan && !isProjectionRequestActive(requestSpan)) {
          const requestId = item.requestId?.trim();
          if (requestId && requestsWithStreamRows.has(`request:${requestId}`)) {
            return (
              !requestHasThinkingStream(requestId, displayTimeline) &&
              !requestHasMessageStream(requestId, displayTimeline)
            );
          }
          return false;
        }
        const requestKey = projectionRequestKey(item);
        if (requestKey && requestsWithStreamRows.has(requestKey)) {
          return false;
        }
        const ownerKey = projectionOwnerKey(item);
        if (ownerKey) {
          const latest = latestActiveRequestStartedByOwner.get(ownerKey);
          if (latest && latest.id !== item.id) {
            return false;
          }
        }
        if (
          displayTimeline.some((streamItem) =>
            isStreamRowSuppressingRequestStarted(streamItem, item, requestSpansById),
          )
        ) {
          const requestId = item.requestId?.trim();
          if (
            requestSpan &&
            !isProjectionRequestActive(requestSpan) &&
            requestId &&
            !requestHasThinkingStream(requestId, displayTimeline) &&
            !requestHasMessageStream(requestId, displayTimeline)
          ) {
            return true;
          }
          return false;
        }
        return true;
      }),
    ),
  );
}

/**
 * Stream/tool collapse shared with the main feed path.
 * Prefer {@link filterProjectionTimelineForDetailFeed} for full display prep
 * (request placeholders, thinking mode, prompt-cache tips).
 */
export function collapseProjectionTimelineStreamsForDetail(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]> = new Map(),
): ThreadRunProjectionTimelineItem[] {
  return buildProjectionDisplayTimelineItems(timeline, requestSpansById).filter(
    (item) => !isEmptyTerminalThinkingItem(item),
  );
}

/** Combines adjacent displayed thinking blocks while keeping the first item stable. */
export function collapseConsecutiveThinkingTimelineItems(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  const collapsed: ThreadRunProjectionTimelineItem[] = [];
  let pending: ThreadRunProjectionTimelineItem[] = [];

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    const first = pending[0];
    collapsed.push(pending.length === 1 && first ? first : mergeConsecutiveThinkingItems(pending));
    pending = [];
  };

  for (const item of timeline) {
    const previous = pending.at(-1);
    if (
      isThinkingTimelineItem(item) &&
      (pending.length === 0 || (previous && canJoinConsecutiveThinkingItems(previous, item)))
    ) {
      pending.push(item);
      continue;
    }
    flush();
    if (isThinkingTimelineItem(item)) {
      pending.push(item);
    } else {
      collapsed.push(item);
    }
  }
  flush();
  return collapsed;
}

function isThinkingTimelineItem(item: ThreadRunProjectionTimelineItem): boolean {
  return item.eventType === "thinking.delta" || item.eventType === "thinking.final";
}

function canJoinConsecutiveThinkingItems(
  previous: ThreadRunProjectionTimelineItem,
  next: ThreadRunProjectionTimelineItem,
): boolean {
  if (
    !isThinkingTimelineItem(previous) ||
    !isThinkingTimelineItem(next) ||
    normalizeThinkingContext(previous.agentId) !== normalizeThinkingContext(next.agentId) ||
    normalizeThinkingContext(previous.runAttemptId) !== normalizeThinkingContext(next.runAttemptId) ||
    normalizeThinkingContext(previous.requestId) !== normalizeThinkingContext(next.requestId)
  ) {
    return false;
  }
  const previousDisplay = readReasoningDisplay(previous.metadata);
  const nextDisplay = readReasoningDisplay(next.metadata);
  // Keep reasoning-summary stage rows distinct from raw thinking, and never glue
  // summary segments to non-summary thinking.
  if (previousDisplay === "summary" || nextDisplay === "summary") {
    if (previousDisplay !== nextDisplay) {
      return false;
    }
    const previousKey = previous.streamKey?.trim() || previous.id;
    const nextKey = next.streamKey?.trim() || next.id;
    return previousKey === nextKey;
  }
  return true;
}

function normalizeThinkingContext(value: string | undefined): string {
  return value?.trim() ?? "";
}

function mergeConsecutiveThinkingItems(
  items: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem {
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    throw new Error("Cannot merge an empty thinking group");
  }
  const text = items
    .map((item) => item.text.trim())
    .filter((value) => value.length > 0)
    .join("\n\n");
  const metadata = mergeConsecutiveThinkingMetadata(items);
  return {
    ...first,
    eventType: items.some((item) => item.eventType === "thinking.delta")
      ? "thinking.delta"
      : "thinking.final",
    text,
    at: last.at,
    ...(metadata ? { metadata } : {}),
  };
}

function mergeConsecutiveThinkingMetadata(
  items: readonly ThreadRunProjectionTimelineItem[],
): Record<string, unknown> | undefined {
  const metadata = Object.assign({}, ...items.map((item) => item.metadata ?? {}));
  const startedAt = items
    .map((item) => readThinkingStartedAt(item.metadata))
    .find((value): value is string => Boolean(value));
  if (startedAt) {
    metadata.thinkingStartedAt = startedAt;
  }
  const durations = items
    .map((item) => readFiniteNonNegativeNumber(item.metadata?.thinkingDurationMs))
    .filter((value): value is number => value !== undefined && value > 0);
  if (durations.length > 0) {
    metadata.thinkingDurationMs = durations.reduce((total, value) => total + value, 0);
  } else if (startedAt) {
    const endedAt = items.at(-1)?.at;
    const endedMs = endedAt ? Date.parse(endedAt) : Number.NaN;
    const startedMs = Date.parse(startedAt);
    if (Number.isFinite(endedMs) && Number.isFinite(startedMs) && endedMs >= startedMs) {
      metadata.thinkingDurationMs = endedMs - startedMs;
    }
  }
  // Prefer earliest summary/raw stamp when merging (all segments should agree when canJoin passed).
  const reasoningDisplay = items
    .map((item) => readReasoningDisplay(item.metadata))
    .find((value): value is "summary" | "raw" => value !== undefined);
  if (reasoningDisplay) {
    metadata.reasoningDisplay = reasoningDisplay;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function isEmptyTerminalThinkingItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (item.eventType !== "thinking.delta" && item.eventType !== "thinking.final") {
    return false;
  }
  // Empty thinking.delta rows used to linger as inline「正在思考」after tools moved on.
  // Waiting UI comes from active-tail / request.started instead.
  return item.text.trim().length === 0;
}

/** OpenAI/Codex reasoning summary (not Claude raw thinking / raw CoT). */
function isReasoningSummaryItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (item.eventType !== "thinking.delta" && item.eventType !== "thinking.final") {
    return false;
  }
  if (item.text.trim().length === 0) {
    return false;
  }
  if (readReasoningDisplay(item.metadata) === "summary") {
    return true;
  }
  // Delta path stamp before projection merge may only keep codexMethod on some rows.
  const method = item.metadata?.codexMethod;
  return method === "item/reasoning/summaryTextDelta";
}

/**
 * Events that replace the ephemeral reasoning-summary status line
 * (tools, assistant speech, true thinking, …).
 */
function isReasoningSummarySupersedingItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (isReasoningSummaryItem(item) || isEmptyTerminalThinkingItem(item)) {
    return false;
  }
  if (item.eventType.startsWith("tool.")) {
    return true;
  }
  if (item.eventType === "message.delta" || item.eventType === "message.final") {
    return item.text.trim().length > 0;
  }
  if (item.eventType === "thinking.delta" || item.eventType === "thinking.final") {
    // raw / untagged thinking is a different feed kind — supersedes summary status.
    return item.text.trim().length > 0;
  }
  if (
    item.eventType === "thread.status" ||
    item.eventType === "api.error" ||
    item.eventType === "tool.failed"
  ) {
    return true;
  }
  return false;
}

/**
 * Display-only fork onto the tip path (effect 1): stamp raw/untagged thinking
 * as `reasoningDisplay: "summary"` so `reasoning-stage` +
 * `collapseEphemeralReasoningSummaryTimeline` apply. Does not mutate persisted activity.
 */
export function presentThinkingAsEphemeralSummaryTips(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  return timeline.map((item) => {
    if (item.eventType !== "thinking.delta" && item.eventType !== "thinking.final") {
      return item;
    }
    if (!item.text.trim()) {
      return item;
    }
    if (readReasoningDisplay(item.metadata) === "summary") {
      return item;
    }
    return {
      ...item,
      metadata: {
        ...(item.metadata ?? {}),
        reasoningDisplay: "summary",
      },
    };
  });
}

/**
 * Reasoning summary follows the same lifecycle as a growing tool aggregate:
 * - later summaries replace the current temporary row
 * - tools,正文, and other process events replace that temporary row
 * - Summary is never retained as fixed history
 * - may be delta or final (final still shows until superseded — not only while streaming)
 *
 * @deprecated alias retained for ActivityLogView import
 */
export function isSettledReasoningSummaryItem(item: ThreadRunProjectionTimelineItem): boolean {
  // Historical name: previously meant "hide all finals". No longer used as a bulk hide.
  void item;
  return false;
}

/**
 * @deprecated use collapseEphemeralReasoningSummaryTimeline
 */
export function collapseLiveReasoningSummaryTimeline(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  return collapseEphemeralReasoningSummaryTimeline(timeline);
}

/**
 * Statuses where the conversation has left its live statuses. Kept next to the tip
 * lifecycle so the Feed's「正在思考」gate and the tip's own expiry cannot drift apart.
 */
export function isThreadConversationStopped(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled" ||
    status === "idle"
  );
}

/**
 * A `tool.started` row belongs to the attempt that wrote the call, and a tool cannot outlive
 * that attempt: when a run is stopped, superseded by a retry, or lost, its in-flight calls die
 * without ever reporting `tool.completed`/`tool.failed`. The row would otherwise present itself
 * as live forever — shimmering, counting elapsed time, and holding the Feed's live slot shut so
 * every later turn loses its 「正在思考」row.
 *
 * This closes those rows the way the runtime closes request spans for terminal owners
 * (`closeRequestSpansForTerminalAgents` / `closeRequestSpanForTerminalThread`). The call was
 * interrupted rather than finished, and the tool vocabulary has no `cancelled`, so it reads as
 * incomplete — the mapping the legacy adapter already applies to a cancelled tool
 * (`conversationV2ToolProjectionStatus`).
 */
function closeDanglingToolItemsForTerminalAttempts(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  terminalAttemptIds: ReadonlySet<string> | undefined,
): ThreadRunProjectionTimelineItem[] {
  if (!terminalAttemptIds?.size) {
    return [...timeline];
  }
  // A call that did report a terminal row is not dangling; the display collapse keeps that row.
  const settledToolKeys = new Set<string>();
  for (const item of timeline) {
    const lifecycle = resolveProjectionToolLifecycle(item);
    if (lifecycle !== "completed" && lifecycle !== "failed") {
      continue;
    }
    const key = projectionToolLifecycleKey(item);
    if (key) {
      settledToolKeys.add(key);
    }
  }
  let closed = false;
  const output = timeline.map((item) => {
    if (resolveProjectionToolLifecycle(item) !== "running") {
      return item;
    }
    const attemptId = item.runAttemptId?.trim();
    if (!attemptId || !terminalAttemptIds.has(attemptId)) {
      return item;
    }
    const key = projectionToolLifecycleKey(item);
    if (key && settledToolKeys.has(key)) {
      return item;
    }
    const closedItem = withInterruptedToolStatus(item);
    if (closedItem !== item) {
      closed = true;
    }
    return closedItem;
  });
  return closed ? output : [...timeline];
}

/** Marks an orphaned `tool.started` row as interrupted so its lifecycle stops resolving `running`. */
function withInterruptedToolStatus(
  item: ThreadRunProjectionTimelineItem,
): ThreadRunProjectionTimelineItem {
  const raw = item.metadata?.tool;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return item;
  }
  const record = raw as Record<string, unknown>;
  if (record.status === "failed") {
    return item;
  }
  return {
    ...item,
    metadata: {
      ...item.metadata,
      tool: { ...record, status: "failed" },
    },
  };
}

export function collapseEphemeralReasoningSummaryTimeline(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  conversationLive = true,
  terminalAttemptIds?: ReadonlySet<string>,
): ThreadRunProjectionTimelineItem[] {
  if (!conversationLive) {
    // Supersede-by-event only works while the run keeps producing. A conversation that
    // stopped without landing a hard event after the tip (crash, lost runtime, restart
    // recovery) would otherwise park the tip as a durable Feed row — still shimmering and
    // cycling its stages long after the run ended. 阅后即焚 has no durable form.
    return timeline.filter((item) => !isReasoningSummaryItem(item));
  }
  let lastSupersedingIndex = -1;
  let tipSummaryIndex = -1;
  const slotKeyBySummaryIndex = new Map<number, string>();
  let activeSlotKey: string | undefined;

  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (!item) {
      continue;
    }
    if (isReasoningSummarySupersedingItem(item)) {
      lastSupersedingIndex = index;
      activeSlotKey = undefined;
      continue;
    }
    if (isReasoningSummaryItem(item)) {
      activeSlotKey ??= resolveReasoningSummarySlotKey(item, timeline[index - 1]);
      slotKeyBySummaryIndex.set(index, activeSlotKey);
      tipSummaryIndex = index;
    }
  }

  return timeline
    .map((item, index) => {
      if (!isReasoningSummaryItem(item)) {
        return item;
      }
      if (
        index <= lastSupersedingIndex ||
        index !== tipSummaryIndex ||
        (item.runAttemptId && terminalAttemptIds?.has(item.runAttemptId))
      ) {
        return undefined;
      }
      const slotKey = slotKeyBySummaryIndex.get(index);
      return slotKey ? withReasoningSummarySlotKey(item, slotKey) : item;
    })
    .filter((item): item is ThreadRunProjectionTimelineItem => Boolean(item));
}

function resolveReasoningSummarySlotKey(
  item: ThreadRunProjectionTimelineItem,
  previous: ThreadRunProjectionTimelineItem | undefined,
): string {
  const previousSlot = previous?.metadata?.reasoningSummarySlotKey;
  if (typeof previousSlot === "string" && previousSlot.trim()) {
    return previousSlot.trim();
  }
  const owner = item.agentId?.trim() || item.requestId?.trim() || item.runAttemptId?.trim();
  const stream = item.streamKey?.trim() || item.id;
  return owner ? `${owner}:${stream}` : stream;
}

function withReasoningSummarySlotKey(
  item: ThreadRunProjectionTimelineItem,
  slotKey: string,
): ThreadRunProjectionTimelineItem {
  return {
    ...item,
    metadata: {
      ...(item.metadata ?? {}),
      reasoningSummarySlotKey: slotKey,
    },
  };
}

function filterProjectionToolProgressNoiseItems(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  return timeline.filter((item) => !isProjectionToolProgressNoiseItem(item, timeline));
}

function isStructuredFilesystemToolItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (item.eventType !== "tool.started" && item.eventType !== "tool.completed") {
    return false;
  }
  const metadataTool = readProjectionToolMetadata(item);
  if (!metadataTool) {
    return false;
  }
  return Boolean(
    resolveReadToolTargetDisplayFromToolMetadata(metadataTool) ||
      resolveGrepToolTargetDisplayFromToolMetadata(metadataTool),
  );
}

function isFilesystemToolEvent(item: ThreadRunProjectionTimelineItem): boolean {
  if (item.eventType !== "tool.started" && item.eventType !== "tool.completed") {
    return false;
  }
  const metadataTool = readProjectionToolMetadata(item);
  if (!metadataTool) {
    return false;
  }
  return metadataTool.name === "Read" || metadataTool.name === "NotebookRead" || metadataTool.name === "Grep";
}

function isProjectionToolProgressNoiseItem(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  const metadataTool = readProjectionToolMetadata(item);
  const text = item.text.trim();
  const detail = metadataTool?.detail?.trim() ?? "";

  if (item.eventType === "thread.status" && isToolProgressStatusText(text)) {
    return true;
  }

  if (item.eventType === "message.delta" || item.eventType === "message.final") {
    if (!isToolProgressStatusText(text)) {
      return false;
    }
    return timeline.some(
      (other) =>
        other.id !== item.id && (isStructuredFilesystemToolItem(other) || isFilesystemToolEvent(other)),
    );
  }

  if (item.eventType !== "tool.started" && item.eventType !== "tool.completed") {
    return false;
  }

  if (isStructuredFilesystemToolItem(item)) {
    return false;
  }

  if (!metadataTool) {
    return isToolProgressStatusText(text);
  }

  const isFilesystemTool =
    metadataTool.name === "Read" || metadataTool.name === "NotebookRead" || metadataTool.name === "Grep";

  if (!isFilesystemTool) {
    return false;
  }

  const isNoise = isToolProgressStatusText(text) || isToolProgressStatusText(detail);
  return isNoise;
}

function buildLatestActiveRequestStartedByOwner(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): Map<string, ThreadRunProjectionTimelineItem> {
  const latestByOwner = new Map<string, ThreadRunProjectionTimelineItem>();
  for (const item of timeline) {
    if (item.eventType !== "request.started") {
      continue;
    }
    const requestSpan = projectionRequestSpan(item, requestSpansById);
    if (requestSpan && !isProjectionRequestActive(requestSpan)) {
      continue;
    }
    const ownerKey = projectionOwnerKey(item);
    if (!ownerKey) {
      continue;
    }
    const current = latestByOwner.get(ownerKey);
    if (!current || compareTimelineItems(current, item) <= 0) {
      latestByOwner.set(ownerKey, item);
    }
  }
  return latestByOwner;
}

function isMainTimelineNoiseItem(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  if (isProjectionUserPromptItem(item)) {
    return false;
  }
  if (isSupersededClarificationWaitingItem(item, timeline)) {
    return true;
  }
  if (isSpuriousClarificationAnsweredItem(item)) {
    return true;
  }
  if (isSupersededAskUserQuestionToolItem(item, timeline)) {
    return true;
  }
  if (isRequestFailureFeedNoiseItem(item)) {
    return true;
  }
  if (isProjectionInternalMessageText(item.text) || isThreadFollowUpActivityMessage(item.text)) {
    return true;
  }
  const liveType = projectionLiveType(item);
  if (
    liveType === "plan.ready" ||
    liveType === "thread.awaiting_plan" ||
    liveType === "thread.plan_cleared" ||
    liveType === "clarification.requested" ||
    liveType === "plan_approval.requested"
  ) {
    return true;
  }
  if (liveType === "codex.item.unprojected") {
    return false;
  }
  if (liveType && isThreadFollowUpLiveEvent(liveType)) {
    return true;
  }
  if (
    item.eventType === "agent.started" ||
    item.eventType === "agent.stopped" ||
    item.eventType === "agent.abandoned" ||
    item.eventType === "diagnostic"
  ) {
    return true;
  }
  if (item.eventType === "run.attempt.started" || item.eventType === "run.attempt.completed") {
    return true;
  }
  if (item.eventType !== "thread.status") {
    return false;
  }
  if (projectionLiveType(item) === "codex.item.unprojected") {
    return false;
  }
  const text = item.text.trim();
  return (
    !text || text === "状态已更新" || isProjectionLifecycleText(text) || isProjectionUsageNoiseText(text)
  );
}

function isSpuriousClarificationAnsweredItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (projectionLiveType(item) !== "clarification.answered") {
    return false;
  }
  const text = item.text.trim();
  // Placeholder IPC emits and non-summary answered events must not occupy feed slots.
  return !text || text === "状态已更新" || text.endsWith("的 MCP 表单已提交。");
}

function isSupersededAskUserQuestionToolItem(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  if (item.eventType !== "tool.started" && item.eventType !== "tool.completed") {
    return false;
  }
  const metadataTool = readProjectionToolMetadata(item);
  const toolUseId = metadataTool?.toolUseId?.trim();
  if (!toolUseId || metadataTool?.name !== "AskUserQuestion") {
    return false;
  }
  return timeline.some((candidate) => {
    if (projectionLiveType(candidate) !== "clarification.answered") {
      return false;
    }
    if (isSpuriousClarificationAnsweredItem(candidate)) {
      return false;
    }
    return readProjectionToolMetadata(candidate)?.toolUseId?.trim() === toolUseId;
  });
}

function isSupersededClarificationWaitingItem(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  if (item.eventType !== "thread.status" || item.text.trim() !== "等待你的回答…") {
    return false;
  }
  return timeline.some(
    (candidate) =>
      projectionLiveType(candidate) === "clarification.answered" &&
      !isSpuriousClarificationAnsweredItem(candidate) &&
      compareTimelineItems(item, candidate) < 0,
  );
}

function isProjectionUsageNoiseText(text: string): boolean {
  return /^[↑↓⊙][↑↓⊙\d\s.,kKmM$%·+()-]*$/u.test(text);
}

function isRequestFailureFeedNoiseItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (isUserInterruptedTurnFailure({ eventType: item.eventType, text: item.text, metadata: item.metadata })) {
    return true;
  }
  const origin = resolveThreadActivityOrigin(item);
  if (isRequestFailureFeedNoiseOrigin(origin)) {
    return true;
  }
  // Keep primary infrastructure blocks (e.g. eco-bridge EADDRINUSE); drop only API wrap rows.
  if (origin === "eco.thread_blocked") {
    return isRedundantApiFailureBlockedMessage(item.text);
  }
  if (item.eventType === "message.delta" && isUpstreamErrorPhaseOrigin(origin)) {
    return true;
  }
  return false;
}

function isProjectionInternalMessageText(text: string): boolean {
  const trimmed = text.trim();
  // Protocol/history strings are matched verbatim across app versions.
  return (
    trimmed.startsWith("__eco_worktree_merge__") ||
    trimmed === "回答完成。" ||
    trimmed === "执行完成。" ||
    trimmed === "PI 任务完成。" ||
    trimmed === "PI 运行已结束。" ||
    trimmed === "执行完成，变更已写入项目目录。" ||
    trimmed === "执行完成，工作树内无相对基线的文件变更。" ||
    trimmed === "执行已结束，但无法确认文件变更。" ||
    trimmed === "计划已生成，等待确认。" ||
    trimmed === "计划已生成，请确认是否执行。" ||
    trimmed === "计划已提交，等待你确认。" ||
    trimmed === "计划已进入执行阶段。" ||
    trimmed === "计划已进入执行阶段" ||
    /^ACP\s*已完成/u.test(trimmed) ||
    /^等待你完成 .+ 的 MCP 表单…$/u.test(trimmed) ||
    /^.+ 的 MCP 表单已提交。$/u.test(trimmed) ||
    isProjectionApprovalTransitionStatus(trimmed)
  );
}

function isProjectionApprovalTransitionStatus(text: string): boolean {
  // Protocol/history strings are matched verbatim across app versions.
  return (
    text === "等待工具权限确认…" ||
    text === "等待工具读取确认…" ||
    text === "等待 Bash 执行确认…" ||
    text === "读取已确认，继续执行…" ||
    text === "读取已拒绝，等待 Agent 调整…" ||
    text === "Bash 已确认，继续执行…" ||
    text === "Bash 已拒绝，等待 Agent 调整…"
  );
}

export function buildProjectionDisplayTimelineItems(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): ThreadRunProjectionTimelineItem[] {
  const streamKeys = new Map<ThreadRunProjectionTimelineItem, string | undefined>();
  const latestStreamDisplayByKey = new Map<string, ThreadRunProjectionTimelineItem>();
  const latestToolDisplayByKey = new Map<string, ThreadRunProjectionTimelineItem>();
  const latestLifecycleDisplayByKey = new Map<string, ThreadRunProjectionTimelineItem>();
  const latestReconnectDisplayByKey = new Map<string, ThreadRunProjectionTimelineItem>();
  const reconnectCollapseByKey = new Map<string, ReconnectCollapseMetadata>();
  const latestOriginalApiErrorDisplayByKey = new Map<string, ThreadRunProjectionTimelineItem>();
  for (const item of timeline) {
    const reconnectKey = projectionReconnectDisplayKey(item);
    if (reconnectKey) {
      const reconnect = resolveReconnectPhaseDisplay({
        text: item.text.trim(),
        metadata: item.metadata,
        apiError: readProjectionApiError(item),
      });
      const currentStats = reconnectCollapseByKey.get(reconnectKey) ?? { count: 0, failedCount: 0 };
      reconnectCollapseByKey.set(reconnectKey, {
        count: currentStats.count + 1,
        failedCount: currentStats.failedCount + (reconnect?.failed ? 1 : 0),
      });
      const current = latestReconnectDisplayByKey.get(reconnectKey);
      if (!current || compareTimelineItems(current, item) <= 0) {
        latestReconnectDisplayByKey.set(reconnectKey, item);
      }
    }

    const upstreamErrorKey = projectionUpstreamErrorDisplayKey(item);
    if (upstreamErrorKey && !isRequestFailureFeedNoiseItem(item)) {
      const current = latestOriginalApiErrorDisplayByKey.get(upstreamErrorKey);
      if (!current || compareTimelineItems(current, item) <= 0) {
        latestOriginalApiErrorDisplayByKey.set(upstreamErrorKey, item);
      }
    }

    const lifecycleKey = projectionToolLifecycleKey(item);
    if (lifecycleKey) {
      const current = latestLifecycleDisplayByKey.get(lifecycleKey);
      if (!current || compareProjectionLifecycleDisplayItems(item, current) > 0) {
        latestLifecycleDisplayByKey.set(lifecycleKey, mergeToolDisplayTimelineItem(current, item));
      }
    }

    const streamKey = projectionStreamDisplayKey(item, requestSpansById, timeline);
    streamKeys.set(item, streamKey);
    if (streamKey) {
      const current = latestStreamDisplayByKey.get(streamKey);
      if (!current || compareTimelineItems(current, item) <= 0) {
        latestStreamDisplayByKey.set(streamKey, mergeStreamDisplayTimelineItem(current, item, timeline));
      }
    }

    const toolKey = projectionToolDisplayKey(item);
    if (toolKey) {
      const current = latestToolDisplayByKey.get(toolKey);
      if (!current || compareProjectionToolDisplayItems(current, item) <= 0) {
        latestToolDisplayByKey.set(toolKey, mergeToolDisplayTimelineItem(current, item));
      }
    }
  }

  const displayItems: ThreadRunProjectionTimelineItem[] = [];
  for (const item of timeline) {
    if (isRequestFailureFeedNoiseItem(item)) {
      continue;
    }
    let displayItem = item;
    const reconnectKey = projectionReconnectDisplayKey(item);
    if (reconnectKey) {
      if (latestReconnectDisplayByKey.get(reconnectKey)?.id !== item.id) {
        continue;
      }
      if (isTimelineItemSupersededByRecovery(timeline, item, compareTimelineOrder)) {
        continue;
      }
      displayItem = withReconnectCollapseMetadata(displayItem, reconnectCollapseByKey.get(reconnectKey));
    }
    const upstreamErrorKey = projectionUpstreamErrorDisplayKey(item);
    if (upstreamErrorKey) {
      if (latestOriginalApiErrorDisplayByKey.get(upstreamErrorKey)?.id !== item.id) {
        continue;
      }
      if (isTimelineItemSupersededByRecovery(timeline, item, compareTimelineOrder)) {
        continue;
      }
    }
    const lifecycleKey = projectionToolLifecycleKey(item);
    if (lifecycleKey) {
      const latestLifecycle = latestLifecycleDisplayByKey.get(lifecycleKey);
      if (!latestLifecycle || latestLifecycle.id !== item.id) {
        continue;
      }
      displayItem = latestLifecycle;
    }
    const streamKey = streamKeys.get(item);
    if (streamKey) {
      const latestStream = latestStreamDisplayByKey.get(streamKey);
      if (!latestStream || latestStream.id !== item.id) {
        continue;
      }
      displayItem = latestStream;
    }
    const toolKey = projectionToolDisplayKey(item);
    if (toolKey && latestToolDisplayByKey.get(toolKey)?.id !== item.id) {
      continue;
    }
    if (isDuplicateStreamBlockFinalEcho(displayItem, timeline, requestSpansById)) {
      continue;
    }
    if (isDuplicateLegacyStreamFinalEcho(displayItem, timeline)) {
      continue;
    }
    if (isDuplicateTaskNotificationSummaryEcho(displayItem, timeline)) {
      continue;
    }
    const settled = settleTerminalStreamDisplayItem(displayItem, requestSpansById);
    if (settled && !isEmptyTerminalThinkingItem(settled)) {
      displayItems.push(settled);
    }
  }
  return collapseRedundantMessageDisplayItems(displayItems);
}

/**
 * Drop echoed assistant speech that slipped past stream-key collapse:
 * - exact duplicate text in the same attempt (even across tools)
 * - strict prefix growth of the same speech act (no tool / user between)
 */
export function collapseRedundantMessageDisplayItems(
  items: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  const lookup = timelineLookup(items);
  const messageGroups = new Map<string, number[]>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item && isMessageSpeechDisplayItem(item) && item.text.trim()) {
      // Different agents, attempts and user turns can never collapse together.
      // Compare only speech in that scope, rather than every historical pair.
      const key = JSON.stringify([
        normalizeThinkingContext(item.agentId),
        normalizeThinkingContext(item.runAttemptId),
        lookup.userCounts[index],
      ]);
      const group = messageGroups.get(key);
      if (group) group.push(index);
      else messageGroups.set(key, [index]);
    }
  }

  const drop = new Set<number>();
  for (const messageIndexes of messageGroups.values()) {
    for (let leftPos = 0; leftPos < messageIndexes.length; leftPos += 1) {
      const leftIndex = messageIndexes[leftPos];
      if (leftIndex === undefined || drop.has(leftIndex)) {
        continue;
      }
      const earlier = items[leftIndex];
      if (!earlier) {
        continue;
      }
      const earlierText = earlier.text.trim();
      for (let rightPos = leftPos + 1; rightPos < messageIndexes.length; rightPos += 1) {
        const rightIndex = messageIndexes[rightPos];
        if (rightIndex === undefined || drop.has(rightIndex)) {
          continue;
        }
        const later = items[rightIndex];
        if (!later || !sameMessageCollapseScope(earlier, later)) {
          continue;
        }
        const laterText = later.text.trim();
        if (laterText === earlierText) {
          drop.add(leftIndex);
          break;
        }
        if (hasToolBoundaryBetween(items, earlier, later)) {
          continue;
        }
        if (laterText.startsWith(earlierText) && laterText.length > earlierText.length) {
          drop.add(leftIndex);
          break;
        }
        if (earlierText.startsWith(laterText) && earlierText.length > laterText.length) {
          drop.add(rightIndex);
        }
      }
    }
  }

  if (drop.size === 0) {
    return [...items];
  }
  return items.filter((_, index) => !drop.has(index));
}

function isMessageSpeechDisplayItem(item: ThreadRunProjectionTimelineItem): boolean {
  // A user prompt is not assistant speech, and the rule below drops exact duplicates: a
  // reader who sends the same short message twice ("继续" again) has two rows in the log and
  // must see two turns. The V2 read model gives a prompt the same event type an answer has
  // (`message.final`), which is what made this collapse eat the second prompt.
  if (isProjectionUserPromptItem(item) || item.role === "user") {
    return false;
  }
  return item.eventType === "message.delta" || item.eventType === "message.final";
}

function sameMessageCollapseScope(
  left: ThreadRunProjectionTimelineItem,
  right: ThreadRunProjectionTimelineItem,
): boolean {
  if (normalizeThinkingContext(left.agentId) !== normalizeThinkingContext(right.agentId)) {
    return false;
  }
  if (normalizeThinkingContext(left.runAttemptId) !== normalizeThinkingContext(right.runAttemptId)) {
    return false;
  }
  const leftRequest = left.requestId?.trim();
  const rightRequest = right.requestId?.trim();
  if (leftRequest && rightRequest && leftRequest !== rightRequest) {
    return false;
  }
  return true;
}

function hasToolBoundaryBetween(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  current: ThreadRunProjectionTimelineItem,
  item: ThreadRunProjectionTimelineItem,
): boolean {
  const lookup = timelineLookup(timeline);
  return hasIndexedBoundaryBetween(lookup, lookup.toolCounts, current, item);
}

/** Timeline arrays are immutable projection inputs; an index lives only as long as its array. */
const timelineLookups = new WeakMap<readonly ThreadRunProjectionTimelineItem[], TimelineLookup>();
interface TimelineLookup {
  positions: Map<string, number>;
  userCounts: Uint32Array;
  toolCounts: Uint32Array;
  thinkingBoundaryCounts: Uint32Array;
  turnBoundaryBefore: Int32Array;
  userBoundaryBefore: Int32Array;
  userBoundaryAfter: Int32Array;
  explicitFinals: Map<string, ThreadRunProjectionTimelineItem[]>;
}

function timelineLookup(timeline: readonly ThreadRunProjectionTimelineItem[]): TimelineLookup {
  const cached = timelineLookups.get(timeline);
  if (cached) return cached;
  const lookup: TimelineLookup = {
    positions: new Map(),
    userCounts: new Uint32Array(timeline.length + 1),
    toolCounts: new Uint32Array(timeline.length + 1),
    thinkingBoundaryCounts: new Uint32Array(timeline.length + 1),
    turnBoundaryBefore: new Int32Array(timeline.length),
    userBoundaryBefore: new Int32Array(timeline.length),
    userBoundaryAfter: new Int32Array(timeline.length),
    explicitFinals: new Map(),
  };
  let userBoundary = -1;
  let turnBoundary = -1;
  for (const [index, item] of timeline.entries()) {
    // Match findIndex semantics if a caller supplies repeated ids.
    if (!lookup.positions.has(item.id)) lookup.positions.set(item.id, index);
    lookup.userBoundaryBefore[index] = userBoundary;
    lookup.turnBoundaryBefore[index] = turnBoundary;
    const user = isProjectionUserPromptItem(item);
    const tool = ["tool.started", "tool.completed", "tool.failed"].includes(item.eventType);
    const final = item.eventType === "thinking.final" || item.eventType === "message.final";
    lookup.userCounts[index + 1] = lookup.userCounts[index]! + Number(user);
    lookup.toolCounts[index + 1] = lookup.toolCounts[index]! + Number(tool);
    lookup.thinkingBoundaryCounts[index + 1] =
      lookup.thinkingBoundaryCounts[index]! + Number(user || tool || final);
    if (user) userBoundary = index;
    if (user || item.eventType === "thinking.final" || (item.eventType === "message.final" && isMainAgentRole(item.role)))
      turnBoundary = index;
    if (final && isExplicitStreamBlockItem(item)) {
      const key = JSON.stringify([item.eventType, item.text.trim()]);
      const candidates = lookup.explicitFinals.get(key);
      if (candidates) candidates.push(item);
      else lookup.explicitFinals.set(key, [item]);
    }
  }
  let nextUser = timeline.length;
  for (let index = timeline.length - 1; index >= 0; index--) {
    lookup.userBoundaryAfter[index] = nextUser;
    if (isProjectionUserPromptItem(timeline[index]!)) nextUser = index;
  }
  timelineLookups.set(timeline, lookup);
  return lookup;
}

function hasIndexedBoundaryBetween(
  lookup: TimelineLookup,
  counts: Uint32Array,
  current: ThreadRunProjectionTimelineItem,
  item: ThreadRunProjectionTimelineItem,
): boolean {
  const left = lookup.positions.get(current.id);
  const right = lookup.positions.get(item.id);
  return left !== undefined && right !== undefined && right > left && counts[right]! > counts[left + 1]!;
}

interface ReconnectCollapseMetadata {
  count: number;
  failedCount: number;
}

function withReconnectCollapseMetadata(
  item: ThreadRunProjectionTimelineItem,
  collapse: ReconnectCollapseMetadata | undefined,
): ThreadRunProjectionTimelineItem {
  if (!collapse || collapse.count <= 1) {
    return item;
  }
  return {
    ...item,
    metadata: {
      ...(item.metadata ?? {}),
      reconnectCollapse: collapse,
    },
  };
}

function readReconnectCollapseMetadata(
  metadata: Record<string, unknown> | undefined,
): ReconnectCollapseMetadata | undefined {
  const raw = metadata?.reconnectCollapse;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const count = typeof record.count === "number" && Number.isFinite(record.count) ? record.count : 0;
  const failedCount =
    typeof record.failedCount === "number" && Number.isFinite(record.failedCount) ? record.failedCount : 0;
  if (count <= 1 && failedCount <= 1) {
    return undefined;
  }
  return { count, failedCount };
}

function readFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readThinkingStartedAt(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.thinkingStartedAt;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readReasoningDisplay(metadata: Record<string, unknown> | undefined): "summary" | "raw" | undefined {
  const value = metadata?.reasoningDisplay;
  return value === "summary" || value === "raw" ? value : undefined;
}

function isDuplicateStreamBlockFinalEcho(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
  requestSpansById?: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): boolean {
  if (item.eventType !== "message.final" && item.eventType !== "thinking.final") {
    return false;
  }
  if (!isExplicitStreamBlockItem(item) || item.requestId?.trim()) {
    return false;
  }
  const streamKey = item.streamKey?.trim();
  const text = item.text.trim();
  if (!streamKey || !text) {
    return false;
  }
  const channel = streamDisplayChannel(item);
  const itemDisplayKey = projectionStreamDisplayKey(item, requestSpansById, timeline);
  return timeline.some((other) => {
    if (other.id === item.id || other.streamKey?.trim() !== streamKey) {
      return false;
    }
    if (!other.requestId?.trim() || streamDisplayChannel(other) !== channel) {
      return false;
    }
    if (!isStreamDisplayTimelineItem(other) || other.text.trim() !== text) {
      return false;
    }
    // Request-scoped deltas and the no-requestId final often share one stream
    // display key; collapse already keeps a single survivor. Treating that
    // survivor as an "echo" of its collapsed sibling drops the only visible row.
    const otherDisplayKey = projectionStreamDisplayKey(other, requestSpansById, timeline);
    if (itemDisplayKey && otherDisplayKey && itemDisplayKey === otherDisplayKey) {
      return false;
    }
    return !hasUserPromptBetweenTimelineItems(timeline, item, other);
  });
}

function isDuplicateTaskNotificationSummaryEcho(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  if (item.eventType !== "thread.status" || projectionLiveType(item) !== "todo.updated") {
    return false;
  }
  if (item.metadata?.sdkTaskKind !== "task_notification") {
    return false;
  }
  const summary = item.text.trim();
  if (!summary) {
    return false;
  }
  const agentId = item.agentId?.trim();
  const notificationToolUseId = readProjectionTaskNotificationToolUseId(item);
  return timeline.some((other) => {
    if (other.id === item.id || other.eventType !== "message.final") {
      return false;
    }
    if (other.text.trim() !== summary) {
      return false;
    }
    if (agentId && other.agentId?.trim() !== agentId) {
      return false;
    }
    if (notificationToolUseId) {
      const messageToolUseId = readProjectionTaskNotificationToolUseId(other);
      if (messageToolUseId && messageToolUseId !== notificationToolUseId) {
        return false;
      }
    }
    return compareTimelineItems(other, item) <= 0;
  });
}

function readProjectionTaskNotificationToolUseId(item: ThreadRunProjectionTimelineItem): string | undefined {
  const metadata = item.metadata;
  if (!metadata) {
    return undefined;
  }
  const sdkTaskToolUseId =
    typeof metadata.sdkTaskToolUseId === "string" ? metadata.sdkTaskToolUseId.trim() : "";
  if (sdkTaskToolUseId) {
    return sdkTaskToolUseId;
  }
  const parentToolUseId =
    typeof metadata.parent_tool_use_id === "string" ? metadata.parent_tool_use_id.trim() : "";
  return parentToolUseId || undefined;
}

function isDuplicateLegacyStreamFinalEcho(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  if (item.eventType !== "message.final" && item.eventType !== "thinking.final") {
    return false;
  }
  if (isExplicitStreamBlockItem(item)) {
    return false;
  }
  const text = item.text.trim();
  if (!text) {
    return false;
  }
  const channel = streamDisplayChannel(item);
  const candidates = timelineLookup(timeline).explicitFinals.get(JSON.stringify([item.eventType, text]));
  return candidates?.some((other) => {
    if (other.id === item.id || !isExplicitStreamBlockItem(other)) {
      return false;
    }
    if (other.eventType !== item.eventType || streamDisplayChannel(other) !== channel) {
      return false;
    }
    if (other.text.trim() !== text) {
      return false;
    }
    return !hasUserPromptBetweenTimelineItems(timeline, item, other);
  }) ?? false;
}

function isExplicitStreamBlockItem(item: ThreadRunProjectionTimelineItem): boolean {
  return Boolean(item.streamKey?.includes(":block:"));
}

function isStreamDisplayTimelineItem(item: ThreadRunProjectionTimelineItem): boolean {
  return (
    item.eventType === "thinking.delta" ||
    item.eventType === "thinking.final" ||
    item.eventType === "message.delta" ||
    item.eventType === "message.final"
  );
}

function streamDisplayChannel(item: ThreadRunProjectionTimelineItem): "thinking" | "message" {
  return item.eventType === "thinking.delta" || item.eventType === "thinking.final" ? "thinking" : "message";
}

function hasUserPromptBetweenTimelineItems(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  left: ThreadRunProjectionTimelineItem,
  right: ThreadRunProjectionTimelineItem,
): boolean {
  const [earlier, later] = compareTimelineItems(left, right) <= 0 ? [left, right] : [right, left];
  return hasUserPromptBetween(timeline, earlier, later);
}

function appendStreamScopeSuffix(
  key: string,
  item: ThreadRunProjectionTimelineItem,
  effectiveRequestId?: string,
  timeline: readonly ThreadRunProjectionTimelineItem[] = [],
): string {
  const isStream =
    item.eventType === "thinking.delta" ||
    item.eventType === "thinking.final" ||
    item.eventType === "message.delta" ||
    item.eventType === "message.final";
  if (!isStream) {
    return key;
  }
  let scoped = key;
  const requestId = effectiveRequestId?.trim() || item.requestId?.trim();
  if (requestId) {
    // Request-scoped streams are already turn-isolated for PI/Claude; do not also
    // stamp afterUser (keeps display keys stable when requestId is present).
    if (!scoped.includes(`:req:${requestId}`) && !scoped.includes(`:request:${requestId}`)) {
      scoped = `${scoped}:req:${requestId}`;
    }
    return scoped;
  }
  const attemptId = item.runAttemptId?.trim();
  // Skip when streamKey already embeds attempt (new write path).
  if (attemptId && !scoped.includes(`:attempt:${attemptId}`) && !/:attempt:[^:]+:block:/.test(scoped)) {
    scoped = `${scoped}:attempt:${attemptId}`;
  }
  // Hard boundary for mid-turn steer that reuses streamKey inside one attempt.
  const afterUser = resolvePrecedingUserPromptSequence(item, timeline);
  return `${scoped}:afterUser:${afterUser}`;
}

/** Last user_prompt sequence strictly before this item; 0 when none (hard turn boundary). */
const userPromptIndexes = new WeakMap<
  readonly ThreadRunProjectionTimelineItem[],
  readonly ThreadRunProjectionTimelineItem[]
>();

function resolvePrecedingUserPromptSequence(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): number {
  let prompts = userPromptIndexes.get(timeline);
  if (!prompts) {
    prompts = timeline.filter(isProjectionUserPromptItem).sort(compareTimelineItems);
    userPromptIndexes.set(timeline, prompts);
  }
  // Display keys are read multiple times for every row. Scanning the full
  // history each time made a send quadratic in accumulated message count.
  let low = 0;
  let high = prompts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareTimelineItems(prompts[mid]!, item) < 0) low = mid + 1;
    else high = mid;
  }
  return low > 0 ? prompts[low - 1]!.sequence : 0;
}

function hasUserPromptBetween(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  current: ThreadRunProjectionTimelineItem,
  item: ThreadRunProjectionTimelineItem,
): boolean {
  const lookup = timelineLookup(timeline);
  return hasIndexedBoundaryBetween(lookup, lookup.userCounts, current, item);
}

/** Same thinking block grows by prefix extension; a new block is not a continuation. */
export function isThinkingTextContinuation(previous: string, next: string): boolean {
  const prev = previous.trim();
  const nextTrim = next.trim();
  if (!nextTrim) {
    return true;
  }
  if (!prev) {
    return true;
  }
  return nextTrim.startsWith(prev) || prev.startsWith(nextTrim);
}

function hasThinkingStreamBoundaryBetween(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  current: ThreadRunProjectionTimelineItem,
  item: ThreadRunProjectionTimelineItem,
): boolean {
  const lookup = timelineLookup(timeline);
  return hasIndexedBoundaryBetween(lookup, lookup.thinkingBoundaryCounts, current, item);
}

function hasOnlyEmptyThinkingBefore(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  item: ThreadRunProjectionTimelineItem,
): boolean {
  const itemIndex = timelineLookup(timeline).positions.get(item.id) ?? -1;
  if (itemIndex <= 0) {
    return false;
  }
  let sawEmptyThinking = false;
  for (let index = itemIndex - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (!entry) {
      continue;
    }
    const isThinking = entry.eventType === "thinking.delta" || entry.eventType === "thinking.final";
    if (!isThinking) {
      return false;
    }
    if (entry.text.trim()) {
      return sawEmptyThinking;
    }
    sawEmptyThinking = true;
  }
  return false;
}

function shouldResetThinkingStreamMerge(
  current: ThreadRunProjectionTimelineItem,
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  const currentRequestId = current.requestId?.trim();
  const itemRequestId = item.requestId?.trim();
  if (currentRequestId && itemRequestId && currentRequestId !== itemRequestId) {
    return true;
  }
  if (current.eventType === "thinking.final") {
    return true;
  }
  if (hasUserPromptBetween(timeline, current, item)) {
    return true;
  }
  if (
    current.id !== item.id &&
    !item.text.trim() &&
    current.text.trim() &&
    hasThinkingStreamBoundaryBetween(timeline, current, item)
  ) {
    return true;
  }
  if (current.id !== item.id && !isThinkingTextContinuation(current.text, item.text)) {
    if (hasThinkingStreamBoundaryBetween(timeline, current, item)) {
      return true;
    }
    if (
      item.text.trim() &&
      item.text.length < current.text.length &&
      hasOnlyEmptyThinkingBefore(timeline, item)
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function mergeStreamDisplayTimelineItem(
  current: ThreadRunProjectionTimelineItem | undefined,
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem {
  if (!current || compareTimelineItems(current, item) > 0) {
    return item;
  }
  const isThinkingStream = item.eventType === "thinking.delta" || item.eventType === "thinking.final";
  if (!isThinkingStream) {
    return item;
  }
  const shouldReset = shouldResetThinkingStreamMerge(current, item, timeline);
  if (shouldReset) {
    return item;
  }
  const preservedText = !item.text.trim()
    ? current.text
    : !current.text.trim()
      ? item.text
      : item.text.length >= current.text.length
        ? item.text
        : current.text;
  const metadata = mergeThinkingTimingMetadata(current.metadata, item.metadata);
  return {
    ...item,
    text: preservedText,
    ...(metadata ? { metadata } : {}),
  };
}

function mergeThinkingTimingMetadata(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!existing && !incoming) {
    return undefined;
  }
  const merged: Record<string, unknown> = {
    ...(existing ?? {}),
    ...(incoming ?? {}),
  };
  const existingStarted =
    typeof existing?.thinkingStartedAt === "string" ? existing.thinkingStartedAt.trim() : "";
  const incomingStarted =
    typeof incoming?.thinkingStartedAt === "string" ? incoming.thinkingStartedAt.trim() : "";
  const thinkingStartedAt = existingStarted || incomingStarted;
  if (thinkingStartedAt) {
    merged.thinkingStartedAt = thinkingStartedAt;
  }
  const existingDuration = readFiniteNonNegativeNumber(existing?.thinkingDurationMs);
  const incomingDuration = readFiniteNonNegativeNumber(incoming?.thinkingDurationMs);
  const positiveDurations = [existingDuration, incomingDuration].filter(
    (value): value is number => value !== undefined && value > 0,
  );
  if (positiveDurations.length > 0) {
    merged.thinkingDurationMs = Math.max(...positiveDurations);
  } else {
    delete merged.thinkingDurationMs;
  }
  const reasoningDisplay = readReasoningDisplay(incoming) ?? readReasoningDisplay(existing);
  if (reasoningDisplay) {
    merged.reasoningDisplay = reasoningDisplay;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeToolDisplayTimelineItem(
  current: ThreadRunProjectionTimelineItem | undefined,
  item: ThreadRunProjectionTimelineItem,
): ThreadRunProjectionTimelineItem {
  if (!current) {
    return item;
  }
  if (compareProjectionToolDisplayItems(item, current) >= 0) {
    return mergeFilesystemToolTimelineMetadata(current, item);
  }
  return mergeFilesystemToolTimelineMetadata(item, current);
}

function mergeFilesystemToolTimelineMetadata(
  placeholder: ThreadRunProjectionTimelineItem,
  richer: ThreadRunProjectionTimelineItem,
): ThreadRunProjectionTimelineItem {
  const placeholderTool = readProjectionToolMetadata(placeholder);
  const richerTool = readProjectionToolMetadata(richer);
  if (!richerTool) {
    return richer;
  }
  const preserveStartedBashDetail =
    richer.eventType === "tool.failed" && richerTool.name.trim().toLowerCase() === "bash";
  const detail = preserveStartedBashDetail
    ? (placeholderTool?.detail ?? richerTool.detail)
    : (richerTool.detail ?? placeholderTool?.detail);
  const readTarget = richerTool.readTarget ?? placeholderTool?.readTarget;
  const grepTarget = richerTool.grepTarget ?? placeholderTool?.grepTarget;
  const imageView = richerTool.imageView ?? placeholderTool?.imageView;
  const imageDisplay = richerTool.imageDisplay ?? placeholderTool?.imageDisplay;
  const htmlHost = richerTool.htmlHost ?? placeholderTool?.htmlHost;
  const mcpDiscovery = richerTool.mcpDiscovery ?? placeholderTool?.mcpDiscovery;
  const fileChange = richerTool.fileChange ?? placeholderTool?.fileChange;
  const status =
    placeholderTool?.status === "failed" || richerTool.status === "failed"
      ? "failed"
      : (richerTool.status ?? placeholderTool?.status);
  const mergedTool: ThreadRunToolMetadata = {
    ...placeholderTool,
    ...richerTool,
    ...(readTarget !== undefined ? { readTarget } : {}),
    ...(grepTarget !== undefined ? { grepTarget } : {}),
    ...(imageView !== undefined ? { imageView } : {}),
    ...(imageDisplay !== undefined ? { imageDisplay } : {}),
    ...(htmlHost !== undefined ? { htmlHost } : {}),
    ...(mcpDiscovery !== undefined ? { mcpDiscovery } : {}),
    ...(fileChange !== undefined ? { fileChange } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(status !== undefined ? { status } : {}),
  };
  const failedItem =
    placeholder.eventType === "tool.failed"
      ? placeholder
      : richer.eventType === "tool.failed"
        ? richer
        : undefined;
  return {
    ...(failedItem ?? richer),
    text: richer.text.trim() || placeholder.text,
    metadata: {
      ...(placeholder.metadata ?? {}),
      ...(richer.metadata ?? {}),
      tool: mergedTool,
    },
  };
}

function shouldSuppressFilesystemToolPlaceholder(
  block: ActivityDetailBlock,
  metadataTool: ThreadRunToolMetadata | undefined,
): boolean {
  if (block.kind !== "action" || !metadataTool) {
    return false;
  }
  if (isReadToolName(metadataTool.name)) {
    if (block.readTarget) {
      return false;
    }
    // Skill reads carry no file target; the row is labeled by skill name — keep it.
    return !isSkillActivityLabel(metadataTool.detail ?? "");
  }
  if (metadataTool.name === "Grep") {
    return !block.grepTarget;
  }
  return false;
}

function settleTerminalStreamDisplayItem(
  item: ThreadRunProjectionTimelineItem,
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): ThreadRunProjectionTimelineItem | undefined {
  if (item.eventType !== "message.delta" && item.eventType !== "thinking.delta") {
    return item;
  }
  if (!item.text.trim()) {
    return undefined;
  }
  const span = projectionRequestSpan(item, requestSpansById);
  if (!span || isProjectionRequestActive(span)) {
    return item;
  }
  return {
    ...item,
    eventType: item.eventType === "thinking.delta" ? "thinking.final" : "message.final",
  };
}

function withContextCompactionTimings(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  const previous: ThreadRunProjectionTimelineItem[] = [];
  return timeline.map((item) => {
    if (!isContextCompactionEventType(item.eventType)) return item;
    const timing = readContextCompactionTiming(item) ?? resolveContextCompactionTiming(item, previous);
    previous.push(item);
    return timing ? { ...item, metadata: { ...item.metadata, compactionTiming: timing } } : item;
  });
}

function readContextCompactionTiming(
  item: ThreadRunProjectionTimelineItem,
): ContextCompactionTiming | undefined {
  const timing = item.metadata?.compactionTiming;
  if (timing === undefined) return undefined;
  if (!timing || typeof timing !== "object" || Array.isArray(timing)) {
    throw new Error(`Compaction timing for ${item.id} is invalid.`);
  }
  const value = timing as ContextCompactionTiming;
  if (
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    (value.endedAt !== undefined && !Number.isFinite(Date.parse(value.endedAt))) ||
    (value.durationMs !== undefined && (!Number.isFinite(value.durationMs) || value.durationMs < 0))
  ) {
    throw new Error(`Compaction timing for ${item.id} is invalid.`);
  }
  return value;
}

function filterCompactionTimelineForFeed(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  return timeline.filter((item, index) => {
    if (item.eventType !== "context.compaction.started") {
      return true;
    }
    return !timeline.slice(index + 1).some((later) => isProjectionContextCompactionItem(later));
  });
}

function isProjectionContextCompactionItem(item: ThreadRunProjectionTimelineItem): boolean {
  return (
    item.eventType === "context.compaction.started" ||
    item.eventType === "context.compaction.completed" ||
    item.eventType === "context.compaction.failed" ||
    item.eventType === "context.compaction.suspended"
  );
}

/** Auto compaction circuit breaker tripped until a successful manual/auto compact completes. */
export function isThreadAutoCompactSuspended(projection: ThreadRunProjectionSnapshot | undefined): boolean {
  if (!projection?.timeline.length) {
    return false;
  }
  let suspended = false;
  for (const item of projection.timeline) {
    if (item.eventType === "context.compaction.completed") {
      suspended = false;
      continue;
    }
    if (item.eventType === "context.compaction.suspended") {
      suspended = true;
    }
  }
  return suspended;
}

/** Prompt cache was invalidated at least once in this thread projection. */
export function isThreadPromptCacheInvalidated(projection: ThreadRunProjectionSnapshot | undefined): boolean {
  return projection?.timeline.some((item) => item.eventType === "context.cache_invalidated") ?? false;
}

/** Orphaned compaction.started without a terminal event stops blocking the UI after this long. */
const COMPACTION_IN_FLIGHT_STALE_MS = 4 * 60 * 1000;

export function isThreadContextCompactionInFlight(
  projection: ThreadRunProjectionSnapshot | undefined,
  nowMs = Date.now(),
): boolean {
  if (!projection?.timeline.length) {
    return false;
  }
  let lastStage: "started" | "completed" | "failed" | undefined;
  let lastStartedAt: string | undefined;
  for (const item of projection.timeline) {
    if (item.eventType === "context.compaction.started") {
      lastStage = "started";
      lastStartedAt = item.at;
      continue;
    }
    if (item.eventType === "context.compaction.completed") {
      lastStage = "completed";
      continue;
    }
    if (item.eventType === "context.compaction.failed") {
      lastStage = "failed";
    }
  }
  if (lastStage !== "started") {
    return false;
  }
  if (lastStartedAt) {
    const startedAtMs = Date.parse(lastStartedAt);
    if (Number.isFinite(startedAtMs) && nowMs - startedAtMs > COMPACTION_IN_FLIGHT_STALE_MS) {
      return false;
    }
  }
  return true;
}

function requestHasThinkingStream(
  requestId: string,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  return timeline.some(
    (streamItem) =>
      streamItem.requestId === requestId &&
      (streamItem.eventType === "thinking.delta" || streamItem.eventType === "thinking.final"),
  );
}

function requestHasMessageStream(
  requestId: string,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  return timeline.some(
    (streamItem) =>
      streamItem.requestId === requestId &&
      (streamItem.eventType === "message.delta" || streamItem.eventType === "message.final"),
  );
}

function isStreamRowSuppressingRequestStarted(
  streamItem: ThreadRunProjectionTimelineItem,
  requestStarted: ThreadRunProjectionTimelineItem,
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): boolean {
  if (!isStreamingRequestDisplayItem(streamItem)) {
    return false;
  }
  const startedOwner = projectionOwnerKey(requestStarted);
  const streamOwner = projectionOwnerKey(streamItem);
  if (!startedOwner || startedOwner !== streamOwner) {
    return false;
  }
  const startedRequestId = requestStarted.requestId?.trim();
  const streamRequestId = streamItem.requestId?.trim();
  if (startedRequestId && streamRequestId) {
    return streamRequestId === startedRequestId;
  }
  const span = projectionRequestSpan(requestStarted, requestSpansById);
  return (
    Boolean(span && isProjectionRequestActive(span)) && compareTimelineItems(streamItem, requestStarted) > 0
  );
}

function isStreamingRequestDisplayItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (isProjectionTodoStatusItem(item)) {
    return false;
  }
  return (
    item.eventType === "message.delta" ||
    item.eventType === "message.final" ||
    item.eventType === "thinking.delta" ||
    item.eventType === "thinking.final"
  );
}

function isProjectionRequestTerminalItem(item: ThreadRunProjectionTimelineItem): boolean {
  return (
    item.eventType === "request.completed" ||
    item.eventType === "request.failed" ||
    item.eventType === "request.cancelled"
  );
}

function projectionRequestKey(item: ThreadRunProjectionTimelineItem): string | undefined {
  if (item.requestId) {
    return `request:${item.requestId}`;
  }
  return undefined;
}

function projectionRequestSpan(
  item: ThreadRunProjectionTimelineItem,
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): ThreadRunProjectionSnapshot["requestSpans"][number] | undefined {
  const spanId = projectionRequestSpanId(item);
  return spanId ? requestSpansById.get(spanId) : undefined;
}

function projectionRequestSpanId(item: ThreadRunProjectionTimelineItem): string | undefined {
  return item.requestId?.trim() || undefined;
}

function projectionReconnectDisplayKey(item: ThreadRunProjectionTimelineItem): string | undefined {
  return isReconnectActivityOrigin(resolveThreadActivityOrigin(item)) ? "reconnect" : undefined;
}

function projectionUpstreamErrorDisplayKey(item: ThreadRunProjectionTimelineItem): string | undefined {
  if (item.eventType !== "message.final") {
    return undefined;
  }
  return isUpstreamErrorPhaseOrigin(resolveThreadActivityOrigin(item)) ? "upstream-api-error" : undefined;
}

export function projectionMainFeedEntryKey(
  item: ThreadRunProjectionTimelineItem,
  options?: {
    agentId?: string;
    requestSpansById?: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>;
    timeline?: readonly ThreadRunProjectionTimelineItem[];
  },
): string {
  const scope = options?.agentId ? `agent:${options.agentId}` : "main";
  const reasoningSummarySlotKey = item.metadata?.reasoningSummarySlotKey;
  if (typeof reasoningSummarySlotKey === "string" && reasoningSummarySlotKey.trim()) {
    return `${scope}:reasoning-summary:${reasoningSummarySlotKey.trim()}`;
  }
  const streamKey = projectionStreamDisplayKey(item, options?.requestSpansById, options?.timeline);
  if (streamKey) {
    return `${scope}:stream:${streamKey}`;
  }
  const lifecycleKey = projectionToolLifecycleKey(item);
  if (lifecycleKey) {
    return `${scope}:${lifecycleKey}`;
  }
  const toolKey = projectionToolDisplayKey(item);
  if (toolKey) {
    return `${scope}:${toolKey}`;
  }
  return `${scope}:${item.id}`;
}

function resolveTurnBoundaryIndex(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  itemIndex: number,
): number {
  return timelineLookup(timeline).turnBoundaryBefore[itemIndex] ?? -1;
}

function resolveTurnSegmentEndIndex(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  itemIndex: number,
): number {
  return timelineLookup(timeline).userBoundaryAfter[itemIndex] ?? timeline.length;
}

function resolveUserPromptBoundaryIndex(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  itemIndex: number,
): number {
  return timelineLookup(timeline).userBoundaryBefore[itemIndex] ?? -1;
}

function resolveExpectedStreamRequestRole(item: ThreadRunProjectionTimelineItem): string | undefined {
  if (
    item.role === "thinking" ||
    item.eventType === "thinking.delta" ||
    item.eventType === "thinking.final"
  ) {
    return "main";
  }
  const role = item.role?.trim();
  if (!role || role === "tool" || role === "system" || role === "user") {
    return undefined;
  }
  return role;
}

function streamRequestCandidateMatchesItem(
  candidate: ThreadRunProjectionTimelineItem,
  item: ThreadRunProjectionTimelineItem,
  requestSpansById?: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): boolean {
  const requestId = candidate.requestId?.trim();
  if (!requestId) {
    return false;
  }
  const span = requestSpansById?.get(requestId);
  const itemAgentId = item.agentId?.trim();
  if (itemAgentId && span?.ownerAgentId && span.ownerAgentId !== itemAgentId) {
    return false;
  }
  const expectedRole = resolveExpectedStreamRequestRole(item);
  const candidateRole = span?.role ?? candidate.role;
  if (expectedRole && candidateRole && candidateRole !== expectedRole) {
    return false;
  }
  return true;
}

function resolveNearestStreamRequestIdInUserTurn(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
  requestSpansById?: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): string | undefined {
  const itemIndex = timelineLookup(timeline).positions.get(item.id) ?? -1;
  if (itemIndex < 0) {
    return undefined;
  }
  const userBoundaryIndex = resolveUserPromptBoundaryIndex(timeline, itemIndex);
  const searchStart = userBoundaryIndex >= 0 ? userBoundaryIndex + 1 : 0;
  const searchEnd = resolveTurnSegmentEndIndex(timeline, itemIndex);
  let fallbackRequestId: string | undefined;

  for (let index = itemIndex; index >= searchStart; index -= 1) {
    const entry = timeline[index];
    if (!entry || !streamRequestCandidateMatchesItem(entry, item, requestSpansById)) {
      continue;
    }
    const requestId = entry.requestId?.trim();
    if (entry.eventType === "request.started") {
      return requestId;
    }
    fallbackRequestId ??= requestId;
  }
  if (fallbackRequestId) {
    return fallbackRequestId;
  }

  for (let index = itemIndex + 1; index < searchEnd; index += 1) {
    const entry = timeline[index];
    if (!entry || !streamRequestCandidateMatchesItem(entry, item, requestSpansById)) {
      continue;
    }
    const requestId = entry.requestId?.trim();
    if (entry.eventType === "request.started") {
      return requestId;
    }
    fallbackRequestId ??= requestId;
  }
  return fallbackRequestId;
}

function resolveNearestPlannerRequestId(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
  requestSpansById?: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): string | undefined {
  const itemIndex = timelineLookup(timeline).positions.get(item.id) ?? -1;
  if (itemIndex < 0) {
    return undefined;
  }
  const turnBoundaryIndex = resolveTurnBoundaryIndex(timeline, itemIndex);
  const searchStart = turnBoundaryIndex >= 0 ? turnBoundaryIndex + 1 : 0;
  const searchEnd = resolveTurnSegmentEndIndex(timeline, itemIndex);
  for (let index = itemIndex; index >= searchStart; index -= 1) {
    const entry = timeline[index];
    if (!entry) {
      continue;
    }
    const requestId = entry.requestId?.trim();
    if (!requestId) {
      continue;
    }
    if (entry.eventType === "request.started" && isMainAgentRole(entry.role)) {
      return requestId;
    }
    if (isMainAgentRole(entry.role) && requestSpansById?.has(requestId)) {
      return requestId;
    }
  }
  for (let index = itemIndex + 1; index < searchEnd; index += 1) {
    const entry = timeline[index];
    if (!entry) {
      continue;
    }
    const requestId = entry.requestId?.trim();
    if (!requestId) {
      continue;
    }
    if (entry.eventType === "request.started" && isMainAgentRole(entry.role)) {
      return requestId;
    }
    if (isMainAgentRole(entry.role) && requestSpansById?.has(requestId)) {
      return requestId;
    }
  }
  return undefined;
}

function resolveEffectiveStreamRequestId(
  item: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
  requestSpansById?: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): string | undefined {
  const isThinkingStream =
    item.role === "thinking" || item.eventType === "thinking.delta" || item.eventType === "thinking.final";
  const itemRequestId = item.requestId?.trim();
  const hasExplicitStreamBlockKey = Boolean(item.streamKey?.includes(":block:"));
  if (!isThinkingStream) {
    if (itemRequestId) {
      return itemRequestId;
    }
    if (hasExplicitStreamBlockKey) {
      return resolveNearestStreamRequestIdInUserTurn(item, timeline, requestSpansById);
    }
    return undefined;
  }
  if (hasExplicitStreamBlockKey && !itemRequestId) {
    const inferredRequestId = resolveNearestStreamRequestIdInUserTurn(item, timeline, requestSpansById);
    if (inferredRequestId) {
      return inferredRequestId;
    }
  }
  const plannerRequestId = resolveNearestPlannerRequestId(item, timeline, requestSpansById);
  if (plannerRequestId) {
    return plannerRequestId;
  }
  const itemIndex = timelineLookup(timeline).positions.get(item.id) ?? -1;
  const turnBoundaryIndex = itemIndex >= 0 ? resolveTurnBoundaryIndex(timeline, itemIndex) : -1;
  const boundaryItem = turnBoundaryIndex >= 0 ? timeline[turnBoundaryIndex] : undefined;
  const hasUserPromptInTurn = Boolean(boundaryItem && isProjectionUserPromptItem(boundaryItem));
  if (!hasUserPromptInTurn) {
    if (itemRequestId && requestSpansById?.has(itemRequestId)) {
      return itemRequestId;
    }
  }
  return undefined;
}

function projectionStreamDisplayKey(
  item: ThreadRunProjectionTimelineItem,
  requestSpansById?: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
  timeline: readonly ThreadRunProjectionTimelineItem[] = [],
): string | undefined {
  if (!isStreamingRequestDisplayItem(item)) {
    return undefined;
  }
  const liveType = projectionLiveType(item);
  // Clarification Q&A must stay as discrete feed rows; collapsing them into the planner
  // role stream plants the answer inside (or drops it behind) later planner speech.
  if (
    liveType === "clarification.answered" ||
    liveType === "clarification.requested" ||
    item.text.trim().startsWith("澄清回答：")
  ) {
    return undefined;
  }
  // Subagent user prompts are turn boundaries in the detail feed — never fold them
  // into the agent message stream (shared requestId / owner would otherwise merge them).
  if (isProjectionSubagentPromptItem(item)) {
    return undefined;
  }
  const origin = resolveThreadActivityOrigin(item);
  if (isRequestFailureFeedNoiseOrigin(origin) || isUpstreamErrorPhaseOrigin(origin)) {
    return undefined;
  }
  const channel =
    item.eventType === "thinking.delta" || item.eventType === "thinking.final" ? "thinking" : "message";
  const requestId = resolveEffectiveStreamRequestId(item, timeline, requestSpansById);
  const streamKey = item.streamKey?.trim();
  const hasExplicitStreamBlockKey = Boolean(streamKey?.includes(":block:"));
  const hasExplicitLogicalItemKey = Boolean(
    streamKey && (item.metadata?.logicalEntityId === streamKey || item.metadata?.itemId === streamKey),
  );
  if (streamKey && (hasExplicitStreamBlockKey || hasExplicitLogicalItemKey)) {
    return appendStreamScopeSuffix(`${channel}:sk:${streamKey}`, item, requestId, timeline);
  }
  // Agent detail history often omits streamKeys between speech acts. Main-feed
  // owner/request collapse is for live planner streaming; without an explicit
  // stream identity, keep agent rows discrete (matches prior detail-only collapse).
  if (item.scope === "agent") {
    if (streamKey) {
      return appendStreamScopeSuffix(`${channel}:sk:${streamKey}`, item, requestId, timeline);
    }
    return undefined;
  }
  if (requestId && requestSpansById) {
    const span = requestSpansById.get(requestId);
    if (span && !isProjectionRequestActive(span)) {
      return appendStreamScopeSuffix(`${channel}:request:${requestId}`, item, requestId, timeline);
    }
  }
  if (streamKey) {
    return appendStreamScopeSuffix(`${channel}:sk:${streamKey}`, item, requestId, timeline);
  }
  const ownerKey = projectionOwnerKey(item);
  if (ownerKey) {
    return appendStreamScopeSuffix(`${channel}:${ownerKey}`, item, requestId, timeline);
  }
  const requestKey = projectionRequestKey(item);
  if (requestKey) {
    return appendStreamScopeSuffix(`${channel}:${requestKey}`, item, requestId, timeline);
  }
  return appendStreamScopeSuffix(`${channel}:${item.id}`, item, requestId, timeline);
}

const FEED_SORT_LANE_NORMAL = 0;
const FEED_SORT_LANE_STREAM_MESSAGE = 1;

function buildToolLifecycleSortAnchors(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): Map<string, { at: string; sequence: number }> {
  const anchors = new Map<string, { at: string; sequence: number }>();
  for (const item of timeline) {
    const toolUseId =
      readProjectionToolMetadata(item)?.toolUseId?.trim() ??
      readProjectionBashApprovalMetadata(item)?.toolUseId?.trim();
    const anchorKey =
      toolUseId ??
      (item.eventType === "tool.started" ||
      item.eventType === "tool.completed" ||
      item.eventType === "tool.failed"
        ? item.id
        : undefined);
    if (!anchorKey) {
      continue;
    }
    const candidate = { at: item.at, sequence: item.sequence };
    const existing = anchors.get(anchorKey);
    if (!existing || candidate.sequence < existing.sequence) {
      anchors.set(anchorKey, candidate);
    }
  }
  return anchors;
}

function resolveFeedEntrySortAnchor(
  item: ThreadRunProjectionTimelineItem,
  toolAnchors: ReadonlyMap<string, { at: string; sequence: number }>,
): { at: string; sequence: number } {
  const toolUseId =
    readProjectionToolMetadata(item)?.toolUseId?.trim() ??
    readProjectionBashApprovalMetadata(item)?.toolUseId?.trim();
  const anchorKey =
    toolUseId ??
    (item.eventType === "tool.started" ||
    item.eventType === "tool.completed" ||
    item.eventType === "tool.failed"
      ? item.id
      : undefined);
  if (anchorKey) {
    const anchored = toolAnchors.get(anchorKey);
    if (anchored) {
      return anchored;
    }
  }
  return { at: item.at, sequence: item.sequence };
}

/**
 * Prefer the parent Agent/Task tool lifecycle anchor so cards stay where the
 * spawn tool appeared. Live minting often stamps agent.startedAt later than
 * tool.started, which previously parked cards at the bottom of the running feed.
 */
function resolveSubagentCardSortAnchor(
  card: ThreadRunProjectionSubagentCard,
  toolAnchors: ReadonlyMap<string, { at: string; sequence: number }>,
  mainTimeline: readonly ThreadRunProjectionTimelineItem[],
): { at: string; sequence: number } {
  const parentToolUseId = card.agent.parentToolUseId?.trim();
  if (parentToolUseId) {
    const anchored = toolAnchors.get(parentToolUseId);
    if (anchored) {
      return anchored;
    }
  }

  const userBoundary = resolveSubagentCardUserBoundary(card, mainTimeline);
  if (userBoundary) {
    // Stopped skeleton cards have empty agent timelines, which otherwise leaves
    // card sequence at 0. Keep unanchored cards below the prompt that opened the
    // turn even when lifecycle tool rows were compacted out of the skeleton.
    return {
      at: card.agent.startedAt > userBoundary.at ? card.agent.startedAt : userBoundary.at,
      sequence: Math.max(card.agent.timeline[0]?.sequence ?? 0, userBoundary.sequence + 1),
    };
  }

  return {
    at: card.agent.startedAt,
    sequence: card.agent.timeline[0]?.sequence ?? 0,
  };
}

function resolveSubagentCardUserBoundary(
  card: ThreadRunProjectionSubagentCard,
  mainTimeline: readonly ThreadRunProjectionTimelineItem[],
): { at: string; sequence: number } | undefined {
  const boundaries = mainTimeline
    .filter(isProjectionUserPromptItem)
    .sort(compareTimelineItems)
    .map((item) => ({ at: item.at, sequence: item.sequence }));
  if (boundaries.length === 0) {
    return undefined;
  }

  let latestBeforeStart: { at: string; sequence: number } | undefined;
  for (const boundary of boundaries) {
    if (boundary.at > card.agent.startedAt) {
      break;
    }
    latestBeforeStart = boundary;
  }
  // A skeletal card can retain an early or missing startedAt while its spawn
  // lifecycle row is compacted away. In that case, the first visible prompt is
  // the only safe lower bound; never sort the card above it.
  return latestBeforeStart ?? boundaries[0];
}

function resolveFeedEntrySortLane(
  item: ThreadRunProjectionTimelineItem,
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): number {
  if (item.eventType === "message.delta") {
    const span = projectionRequestSpan(item, requestSpansById);
    if (!span || isProjectionRequestActive(span)) {
      return FEED_SORT_LANE_STREAM_MESSAGE;
    }
  }
  return FEED_SORT_LANE_NORMAL;
}

function resolveMainFeedEntrySortLane(
  entry: ThreadRunProjectionMainFeedEntry,
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): number {
  if (entry.kind === "timeline" || entry.kind === "agent-echo") {
    return resolveFeedEntrySortLane(entry.item, requestSpansById);
  }
  return FEED_SORT_LANE_NORMAL;
}

function projectionToolDisplayKey(item: ThreadRunProjectionTimelineItem): string | undefined {
  if (item.eventType !== "tool.started" && item.eventType !== "tool.completed") {
    return undefined;
  }
  const metadataTool = readProjectionToolMetadata(item);
  if (metadataTool?.toolUseId?.trim()) {
    return `tool:${metadataTool.toolUseId.trim()}`;
  }
  const bashApproval = readProjectionBashApprovalMetadata(item);
  if (bashApproval?.toolUseId?.trim()) {
    return `tool:${bashApproval.toolUseId.trim()}`;
  }
  return `tool:${item.id}`;
}

function projectionToolLifecycleKey(item: ThreadRunProjectionTimelineItem): string | undefined {
  const bashApproval = readProjectionBashApprovalMetadata(item);
  if (bashApproval?.toolUseId) {
    return `lifecycle:${bashApproval.toolUseId}`;
  }
  const metadataTool = readProjectionToolMetadata(item);
  if (
    metadataTool?.toolUseId?.trim() &&
    (item.eventType === "tool.started" ||
      item.eventType === "tool.completed" ||
      item.eventType === "tool.failed")
  ) {
    return `lifecycle:${metadataTool.toolUseId.trim()}`;
  }
  if (
    item.eventType === "tool.started" ||
    item.eventType === "tool.completed" ||
    item.eventType === "tool.failed"
  ) {
    return `lifecycle:${item.id}`;
  }
  return undefined;
}

function resolveProjectionToolLifecycle(
  item: ThreadRunProjectionTimelineItem,
): ToolActionLifecycle | undefined {
  const bashApproval = readProjectionBashApprovalMetadata(item);
  if (bashApproval) {
    return bashApprovalPhaseToLifecycle(bashApproval.phase);
  }
  const metadataTool = readProjectionToolMetadata(item);
  return toolStatusToLifecycle(metadataTool?.status, item.eventType);
}

function compareProjectionLifecycleDisplayItems(
  left: ThreadRunProjectionTimelineItem,
  right: ThreadRunProjectionTimelineItem,
): number {
  const leftLifecycle = resolveProjectionToolLifecycle(left);
  const rightLifecycle = resolveProjectionToolLifecycle(right);
  if (leftLifecycle && rightLifecycle && leftLifecycle !== rightLifecycle) {
    return compareToolActionLifecyclePriority(leftLifecycle, rightLifecycle);
  }
  const richnessDiff = projectionToolDisplayRichness(left) - projectionToolDisplayRichness(right);
  if (richnessDiff !== 0) {
    return richnessDiff;
  }
  return compareTimelineItems(left, right);
}

function compareProjectionToolDisplayItems(
  left: ThreadRunProjectionTimelineItem,
  right: ThreadRunProjectionTimelineItem,
): number {
  const richnessDiff = projectionToolDisplayRichness(left) - projectionToolDisplayRichness(right);
  if (richnessDiff !== 0) {
    return richnessDiff;
  }
  return compareTimelineItems(left, right);
}

function projectionToolDisplayRichness(item: ThreadRunProjectionTimelineItem): number {
  const metadataTool = readProjectionToolMetadata(item);
  if (!metadataTool) {
    return 0;
  }
  return (
    (metadataTool.readTarget ? 6 : 0) +
    (metadataTool.grepTarget ? 6 : 0) +
    (metadataTool.detail ? 4 : 0) +
    (metadataTool.fileChange ? 8 : 0) +
    (metadataTool.durationMs !== undefined ? 2 : 0) +
    (item.eventType === "tool.completed" ? 1 : 0)
  );
}

function projectionOwnerKey(item: ThreadRunProjectionTimelineItem): string | undefined {
  if (item.agentId) {
    return `agent:${item.agentId}`;
  }
  if (item.role) {
    return `role:${item.role}`;
  }
  return item.scope ? `scope:${item.scope}` : undefined;
}

function compareTimelineOrder(
  left: { at: string; sequence: number; id: string },
  right: { at: string; sequence: number; id: string },
): number {
  const atDiff = left.at.localeCompare(right.at);
  if (atDiff !== 0) {
    return atDiff;
  }
  const sequenceDiff = left.sequence - right.sequence;
  if (sequenceDiff !== 0) {
    return sequenceDiff;
  }
  return left.id.localeCompare(right.id);
}

function compareTimelineItems(
  left: ThreadRunProjectionTimelineItem,
  right: ThreadRunProjectionTimelineItem,
): number {
  return compareTimelineOrder(left, right);
}

function compareMainFeedEntries(
  left: ThreadRunProjectionMainFeedEntry,
  right: ThreadRunProjectionMainFeedEntry,
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): number {
  const laneDiff =
    resolveMainFeedEntrySortLane(left, requestSpansById) -
    resolveMainFeedEntrySortLane(right, requestSpansById);
  if (laneDiff !== 0) {
    return laneDiff;
  }
  const atDiff = left.at.localeCompare(right.at);
  if (atDiff !== 0) {
    return atDiff;
  }
  const sequenceDiff = left.sequence - right.sequence;
  if (sequenceDiff !== 0) {
    return sequenceDiff;
  }
  return left.key.localeCompare(right.key);
}

function resolveProjectionSubagent(item: ThreadRunProjectionTimelineItem): string | undefined {
  const role = normalizeAgentDisplayRole(item.role);
  if (!role || role === "tool") {
    return undefined;
  }
  return role;
}

function readProjectionBashApprovalMetadata(
  item: ThreadRunProjectionTimelineItem,
): ReturnType<typeof readBashApprovalMetadata> {
  return readBashApprovalMetadata(item.metadata);
}

function buildProjectionToolActionBlock(
  item: ThreadRunProjectionTimelineItem,
  input: {
    toolName: string;
    label: string;
    lifecycle?: ToolActionLifecycle;
    description?: string;
  },
): ActivityDetailBlock {
  const subagent = resolveProjectionSubagent(item);
  const metadataTool = readProjectionToolMetadata(item);
  const bashApproval = readProjectionBashApprovalMetadata(item);
  const description = input.description ?? metadataTool?.description ?? bashApproval?.description;
  const command = metadataTool?.detail?.trim() || bashApproval?.detail?.trim();
  const bashRun = resolveBashRunCardDisplay({
    toolName: input.toolName,
    ...(command && { command }),
    ...(metadataTool?.outputPreview && { output: metadataTool.outputPreview }),
    ...(metadataTool?.durationMs !== undefined && { durationMs: metadataTool.durationMs }),
    ...(description && { description }),
  });
  const fileChange = resolveFileChangeCardDisplay(metadataTool?.fileChange);
  const webSearch = resolveWebSearchCardDisplay(
    {
      toolName: input.toolName,
      ...(metadataTool?.detail && { detail: metadataTool.detail }),
      ...(metadataTool?.durationMs !== undefined && { durationMs: metadataTool.durationMs }),
      ...(metadataTool?.status && { status: metadataTool.status }),
      ...(metadataTool?.webSearch && { webSearch: metadataTool.webSearch }),
    },
    translateActionKind,
  );
  const imagePath = metadataTool?.imageView?.path.trim();
  const imageViewPrompt = metadataTool?.imageView?.prompt?.trim();
  const imageView = imagePath
    ? { path: imagePath, eventId: item.id, ...(imageViewPrompt ? { prompt: imageViewPrompt } : {}) }
    : undefined;
  const artifactId = metadataTool?.imageDisplay?.artifactId.trim();
  const imageDisplay = artifactId
    ? {
        artifactId,
        eventId: item.id,
        ...(metadataTool?.imageDisplay?.title ? { title: metadataTool.imageDisplay.title } : {}),
      }
    : undefined;
  const htmlHostMeta = metadataTool?.htmlHost;
  const htmlHost =
    htmlHostMeta?.pageId?.trim() && htmlHostMeta.publicUrl?.trim()
      ? {
          pageId: htmlHostMeta.pageId.trim(),
          publicUrl: htmlHostMeta.publicUrl.trim(),
          eventId: item.id,
          ...(htmlHostMeta.title?.trim() ? { title: htmlHostMeta.title.trim() } : {}),
          ...(htmlHostMeta.expiresAt?.trim() ? { expiresAt: htmlHostMeta.expiresAt.trim() } : {}),
          ...(typeof htmlHostMeta.canExtend === "boolean" ? { canExtend: htmlHostMeta.canExtend } : {}),
        }
      : undefined;
  const mcpDiscovery =
    metadataTool?.mcpDiscovery?.kind === "search" ? { kind: "search" as const } : undefined;
  const readTarget = metadataTool ? resolveReadToolTargetDisplayFromToolMetadata(metadataTool) : undefined;
  const grepTarget = metadataTool ? resolveGrepToolTargetDisplayFromToolMetadata(metadataTool) : undefined;
  const toolOutput = metadataTool?.outputPreview?.trim();
  const codemodeRun = metadataTool?.codemode;
  return {
    kind: "action",
    icon: iconForToolName(input.toolName),
    label: input.label,
    toolName: input.toolName,
    ...(input.lifecycle && { lifecycle: input.lifecycle }),
    // The row's event timestamp is the call's start time (occurredAt on V2 rows, the
    // tool.started insert on legacy rows); the live elapsed display derives from it.
    ...(item.at.trim() && { startedAt: item.at }),
    ...(bashRun && { bashRun }),
    ...(fileChange && { fileChange }),
    ...(webSearch && { webSearch }),
    ...(imageView && { imageView }),
    ...(imageDisplay && { imageDisplay }),
    ...(htmlHost && { htmlHost }),
    ...(mcpDiscovery && { mcpDiscovery }),
    ...(readTarget && { readTarget }),
    ...(grepTarget && { grepTarget }),
    ...(codemodeRun && { codemodeRun }),
    ...(toolOutput && { toolOutput }),
    ...(subagent && { subagent }),
    ...(item.agentId && { agentId: item.agentId }),
  };
}

export function projectionItemToDetailBlock(
  item: ThreadRunProjectionTimelineItem,
): ActivityDetailBlock | undefined {
  const text = item.text.trim();
  if (isUserInterruptedTurnFailure({ eventType: item.eventType, text, metadata: item.metadata })) {
    return undefined;
  }
  const reconnect = resolveReconnectPhaseDisplay({
    text,
    metadata: item.metadata,
    apiError: readProjectionApiError(item),
  });
  if (reconnect) {
    return {
      kind: "phase",
      label: formatReconnectPhaseSummary(reconnect.summary, reconnect, item.metadata),
      reconnecting: true,
      ...(reconnect.failed && { reconnectFailed: true }),
      ...(reconnect.detail && { reconnectDetail: reconnect.detail }),
    };
  }

  const unprojected = readUnprojectedCodexItem(item);
  if (unprojected) {
    const subagent = resolveProjectionSubagent(item);
    const imagePath = readPersistedUnprojectedImageViewPath(unprojected);
    if (imagePath) {
      const lifecycle = unprojected.phase === "started" ? "running" : "completed";
      return {
        kind: "action",
        icon: "images",
        label: i18n.t(lifecycle === "running" ? "activity.imageView.viewing" : "activity.imageView.viewed"),
        toolName: "ViewImage",
        lifecycle,
        imageView: { path: imagePath, eventId: item.id },
        ...(subagent && { subagent }),
        ...(item.agentId && { agentId: item.agentId }),
      };
    }
    return {
      kind: "unknown-item",
      itemType: unprojected.itemType,
      ...(unprojected.phase && { phase: unprojected.phase }),
      ...(unprojected.payload && { payload: unprojected.payload }),
      streaming: unprojected.phase === "started",
      ...(subagent && { subagent }),
      ...(item.agentId && { agentId: item.agentId }),
    };
  }

  if (item.eventType === "agent.started") {
    const delegation = readProjectionDelegationMetadata(item);
    if (delegation) {
      const subagent = resolveProjectionSubagent(item) ?? delegation.subagent;
      return {
        kind: "subagent-mission",
        subagent,
        summary: delegation.summary,
        ...(delegation.prompt && { prompt: delegation.prompt }),
        ...(item.agentId && { agentId: item.agentId }),
      };
    }
  }

  if (isProjectionTodoToolActionItem(item)) {
    return buildProjectionToolActionBlock(item, {
      toolName: resolveProjectionToolName(item),
      label: resolveProjectionToolActionLabel(item),
    });
  }

  if (isProjectionSubagentPromptItem(item)) {
    const subagent = resolveProjectionSubagent(item);
    return {
      kind: "subagent-prompt",
      text: item.text,
      ...(subagent && { subagent }),
      ...(item.agentId && { agentId: item.agentId }),
    };
  }

  const bashApproval = readProjectionBashApprovalMetadata(item);
  if (bashApproval) {
    return buildProjectionToolActionBlock(item, {
      toolName: bashApproval.toolName,
      label: formatToolDisplayLabel(bashApproval.toolName, bashApproval.detail, translateActionKind),
      lifecycle: bashApprovalPhaseToLifecycle(bashApproval.phase),
      ...(bashApproval.description && { description: bashApproval.description }),
    });
  }

  if (item.eventType === "message.delta" || item.eventType === "message.final") {
    if (!text && item.eventType !== "message.delta") {
      return undefined;
    }
    // User role / message.user on the main timeline is handled by UserPromptBlock;
    // never surface as agent narrative (mid-turn Codex historically hit this path).
    const liveType = projectionLiveType(item);
    if (item.role === "user" || liveType === "message.user" || item.metadata?.itemType === "userMessage") {
      if (item.scope === "agent") {
        // Subagent user prompts still go through projection detail blocks.
      } else {
        return undefined;
      }
    }
    const origin = resolveThreadActivityOrigin(item);
    if (isRequestFailureFeedNoiseOrigin(origin)) {
      return undefined;
    }
    if (isUpstreamErrorPhaseOrigin(origin) && item.eventType === "message.final") {
      return { kind: "phase", label: text };
    }
    const subagent = resolveProjectionSubagent(item);
    return {
      kind: "narrative",
      text: item.text,
      streaming: item.eventType === "message.delta",
      ...(subagent && { subagent }),
      ...(item.agentId && { agentId: item.agentId }),
    };
  }

  if (item.eventType === "thinking.delta" || item.eventType === "thinking.final") {
    if (!text && item.eventType === "thinking.final") {
      return undefined;
    }
    const streaming = item.eventType === "thinking.delta";
    const asSummary = readReasoningDisplay(item.metadata) === "summary" || isReasoningSummaryItem(item);
    if (asSummary) {
      // Tip status (ephemeral): shimmer while this row is on the Feed tip.
      // Visibility of finals is decided by collapseEphemeralReasoningSummaryTimeline.
      const label = reasoningSummaryLabel(item.text);
      if (!label) {
        return undefined;
      }
      return {
        kind: "reasoning-stage",
        label,
        streaming: true,
        ...(item.role && { subagent: item.role }),
        ...(item.agentId && { agentId: item.agentId }),
      };
    }
    const thinkingStartedAt = readThinkingStartedAt(item.metadata);
    const thinkingDurationMs = readFiniteNonNegativeNumber(item.metadata?.thinkingDurationMs);
    return {
      kind: "thinking",
      text: item.text,
      streaming,
      ...(item.role && { subagent: item.role }),
      ...(item.agentId && { agentId: item.agentId }),
      ...(thinkingStartedAt && { startedAt: thinkingStartedAt }),
      ...(!streaming && { endedAt: item.at }),
      ...(!streaming && thinkingDurationMs !== undefined && { durationMs: thinkingDurationMs }),
    };
  }

  if (item.eventType === "request.started") {
    if (item.scope === "agent" || item.agentId) {
      const subagent = resolveProjectionSubagent(item);
      return {
        kind: "agent-request",
        ...(subagent && { subagent }),
        ...(item.agentId && { agentId: item.agentId }),
      };
    }
    return {
      kind: "model-request",
      ...(item.role && { role: item.role }),
    };
  }

  if (item.eventType === "api.error") {
    const apiError = readProjectionApiError(item);
    const subagent = resolveProjectionSubagent(item);
    return {
      kind: "api-error",
      message: apiError?.message ?? text,
      ...(apiError?.title && { title: apiError.title }),
      ...(apiError?.statusCode !== undefined && { statusCode: apiError.statusCode }),
      ...(apiError?.code && { code: apiError.code }),
      ...(apiError?.accountId && { accountId: apiError.accountId }),
      ...(subagent && { subagent }),
      ...(item.agentId && { agentId: item.agentId }),
    };
  }

  if (item.eventType === "tool.failed") {
    const subagent = resolveProjectionSubagent(item);
    const tool = resolveProjectionToolName(item);
    const metadataTool = readProjectionToolMetadata(item);
    const command = tool === "Bash" ? metadataTool?.detail?.trim() : undefined;
    const output = metadataTool?.outputPreview?.trim();
    const recoveredResult = resolvePatchAppliedNegativeSearchResult({
      ...(command && { command }),
      ...(output && { output }),
      ...(metadataTool?.exitCode !== undefined && { exitCode: metadataTool.exitCode }),
    });
    const commandMessage = command ? i18n.t("projection.bashCommand", { command }) : undefined;
    const failureMessage = stripProjectionToolFailurePrefix(text, tool);
    const error = recoveredResult ? "" : output || (text !== commandMessage ? failureMessage : "");
    const fileChange =
      resolveFileChangeCardDisplay(metadataTool?.fileChange) ??
      (metadataTool?.fileChange?.path
        ? {
            path: metadataTool.fileChange.path,
            ...(metadataTool.fileChange.path.split(/[/\\]/).pop()
              ? { fileName: metadataTool.fileChange.path.split(/[/\\]/).pop()! }
              : {}),
          }
        : undefined);
    return {
      kind: "tool-failed",
      tool,
      ...(command && { command }),
      ...(fileChange && { fileChange }),
      ...(error && { error }),
      ...(recoveredResult && { recoveredResult }),
      ...(subagent && { subagent }),
      ...(item.agentId && { agentId: item.agentId }),
    };
  }

  if (item.eventType === "tool.started" || item.eventType === "tool.completed") {
    const metadataTool = readProjectionToolMetadata(item);
    const lifecycle = toolStatusToLifecycle(metadataTool?.status, item.eventType);
    const block = buildProjectionToolActionBlock(item, {
      toolName: resolveProjectionToolName(item),
      label: resolveProjectionToolActionLabel(item),
      ...(lifecycle && { lifecycle }),
    });
    if (shouldSuppressFilesystemToolPlaceholder(block, metadataTool)) {
      return undefined;
    }
    return block;
  }

  if (isProjectionThreadFailure(item)) {
    return {
      kind: "api-error",
      message: text || i18n.t("activity.executionFailed"),
      title: i18n.t("activity.executionFailed"),
    };
  }

  const phaseLabel = resolveProjectionPhaseLabel(item);
  if (phaseLabel) {
    if (isContextCompactionEventType(item.eventType)) {
      const timing = readContextCompactionTiming(item) ?? resolveContextCompactionTiming(item, []);
      return {
        kind: "phase",
        label: phaseLabel,
        compaction: {
          lifecycle:
            item.eventType === "context.compaction.started"
              ? "running"
              : item.eventType === "context.compaction.completed"
                ? "completed"
                : "failed",
          ...timing,
        },
      };
    }
    const timeline = readPromptCacheTimelineMetadata(item.metadata);
    if (timeline) {
      return {
        kind: "prompt-cache-timeline",
        narrative: timeline.narrative,
        steps: timeline.steps,
      };
    }
    if (isPromptCacheTimelineEventType(item.eventType)) {
      const step = promptCacheTimelineStepFromItem(item);
      return {
        kind: "prompt-cache-timeline",
        narrative: phaseLabel,
        steps: step ? [step] : [],
      };
    }
    return { kind: "phase", label: phaseLabel };
  }
  return undefined;
}

function isProjectionThreadFailure(item: ThreadRunProjectionTimelineItem): boolean {
  if (item.eventType !== "thread.status") {
    return false;
  }
  const liveType = projectionLiveType(item);
  return (
    liveType === "thread.blocked" || liveType === "thread.execution_failed" || liveType === "thread.failed"
  );
}

function stripProjectionToolFailurePrefix(message: string, toolName: string): string {
  const prefix = `Tool failed: ${toolName}:`;
  return message.startsWith(prefix) ? message.slice(prefix.length).trim() : message;
}

function resolvePatchAppliedNegativeSearchResult(input: {
  command?: string;
  output?: string;
  exitCode?: number;
}):
  | {
      kind: "patch-applied-verification-empty";
      files: Array<{ status: string; path: string }>;
    }
  | undefined {
  if (input.exitCode !== 1 || !input.command || !input.output) {
    return undefined;
  }
  const heredoc = input.command.match(/apply_patch\s+<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/u);
  const delimiter = heredoc?.[1];
  if (!delimiter) {
    return undefined;
  }
  const delimiterOffset = input.command.lastIndexOf(`\n${delimiter}\n`);
  if (delimiterOffset < 0) {
    return undefined;
  }
  const trailingCommand = input.command
    .slice(delimiterOffset + delimiter.length + 2)
    .replace(/["']\s*$/u, "")
    .trim();
  if (!/^rg(?:\s|$)/u.test(trailingCommand)) {
    return undefined;
  }

  const lines = input.output.split(/\r?\n/u).filter(Boolean);
  if (lines[0] !== "Success. Updated the following files:") {
    return undefined;
  }
  const files = lines.slice(1).map((line) => {
    const match = line.match(/^([AMDR])\s+(.+)$/u);
    return match?.[1] && match[2] ? { status: match[1], path: match[2] } : undefined;
  });
  if (files.length === 0 || files.some((file) => !file)) {
    return undefined;
  }
  return {
    kind: "patch-applied-verification-empty",
    files: files.filter((file): file is { status: string; path: string } => Boolean(file)),
  };
}

function formatReconnectPhaseSummary(
  summary: string,
  reconnect: NonNullable<ReturnType<typeof resolveReconnectPhaseDisplay>>,
  metadata: Record<string, unknown> | undefined,
): string {
  const collapse = readReconnectCollapseMetadata(metadata);
  if (!collapse) {
    return summary;
  }
  if (reconnect.failed) {
    const failedCount = collapse.failedCount || collapse.count;
    return failedCount > 1 ? `${summary} ×${failedCount}` : summary;
  }
  if (collapse.failedCount > 1) {
    return i18n.t("projection.reconnectFailures", {
      summary,
      count: collapse.failedCount,
    });
  }
  return summary;
}

export function isProjectionRequestActive(
  span: ThreadRunProjectionSnapshot["requestSpans"][number] | undefined,
): boolean {
  return span?.status === "waiting_first_token" || span?.status === "streaming";
}

export function isProjectionUserPromptItem(item: ThreadRunProjectionTimelineItem): boolean {
  const liveType = projectionLiveType(item);
  // Assistant replies (including long Markdown) cannot be user prompts. Avoid
  // trimming and running operational-status regexes on them in boundary scans.
  if (
    !isRecordedUserPromptLiveEvent(liveType) &&
    !(liveType === "message.user" && item.role === "user" && item.scope !== "agent")
  ) {
    return false;
  }
  const text = item.text.trim();
  const hasContent = text
    ? !isThreadFollowUpActivityMessage(text)
    : readPromptImagePreviews(item.metadata).length > 0;
  if (!hasContent) {
    return false;
  }
  if (isRecordedUserPromptLiveEvent(liveType)) {
    return true;
  }
  // Unbound main-scope user messages (e.g. Codex mid-turn before recordUserPrompt existed)
  // must render as user bubbles, not agent narrative.
  if (liveType === "message.user" && item.role === "user" && item.scope !== "agent") {
    return true;
  }
  return false;
}

export function isProjectionSubagentPromptItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (item.scope !== "agent" || item.text.trim().length === 0) {
    return false;
  }
  const liveType = projectionLiveType(item);
  return (
    liveType === "message.user" ||
    item.role === "user" ||
    item.metadata?.itemType === "userMessage"
  );
}

export function resolveProjectionAgentStatusText(agent: ThreadRunProjectionAgent): string | undefined {
  const speech = findLatestAgentSpeechSummary(agent.timeline);
  if (speech) {
    return speech;
  }
  const latest = agent.latestActivity?.trim();
  if (!latest || isProjectionLifecycleText(latest) || latest === "状态已更新") {
    const action = findLatestAgentToolAction(agent.timeline);
    return action ? resolveProjectionToolStatusPreview(action) : undefined;
  }
  return clampActivityPreviewLine(latest);
}

function findLatestAgentSpeechSummary(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): string | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (!item) {
      continue;
    }
    const text = firstReadableLine(item.text);
    if (!text) {
      continue;
    }
    if (isProjectionTodoStatusItem(item)) {
      continue;
    }
    if (isSubagentMissionEnvelope(item.text)) {
      continue;
    }
    if (item.eventType === "message.delta" || item.eventType === "message.final") {
      return text;
    }
    if (item.eventType === "thinking.delta" || item.eventType === "thinking.final") {
      return i18n.t("projection.thinking", { text });
    }
  }
  return undefined;
}

function findLatestAgentToolAction(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (!item) {
      continue;
    }
    if (
      item.eventType === "tool.started" ||
      item.eventType === "tool.completed" ||
      item.eventType === "tool.failed" ||
      isProjectionTodoToolActionItem(item)
    ) {
      return item;
    }
  }
  return undefined;
}

function firstReadableLine(text: string): string {
  return clampActivityPreviewLine(
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? "",
  );
}

function projectionLiveType(item: ThreadRunProjectionTimelineItem): string | undefined {
  const liveType = item.metadata?.liveType;
  return typeof liveType === "string" ? liveType : undefined;
}

function readUnprojectedCodexItem(item: ThreadRunProjectionTimelineItem):
  | {
      itemType: string;
      phase?: "started" | "completed";
      payload?: string;
    }
  | undefined {
  if (projectionLiveType(item) !== "codex.item.unprojected") {
    return undefined;
  }
  const itemTypeRaw = item.metadata?.itemType;
  const itemType =
    typeof itemTypeRaw === "string" && itemTypeRaw.trim()
      ? itemTypeRaw.trim()
      : item.text.replace(/^未知类型\s*·\s*/u, "").trim() || "unknown";
  const phaseRaw = item.metadata?.unprojectedPhase;
  const phase: "started" | "completed" =
    phaseRaw === "started" || phaseRaw === "completed" ? phaseRaw : "completed";
  const payloadRaw = item.metadata?.payloadJson;
  const payload = typeof payloadRaw === "string" && payloadRaw.trim() ? payloadRaw : undefined;
  return {
    itemType,
    phase,
    ...(payload ? { payload } : {}),
  };
}

function readPersistedUnprojectedImageViewPath(input: {
  itemType: string;
  payload?: string;
}): string | undefined {
  if (input.itemType !== "imageView" || !input.payload) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(input.payload) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type !== "imageView" || typeof record.path !== "string") {
      return undefined;
    }
    return record.path.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isProjectionTodoStatusItem(item: ThreadRunProjectionTimelineItem): boolean {
  return projectionLiveType(item) === "todo.updated";
}

function isProjectionTodoToolActionItem(item: ThreadRunProjectionTimelineItem): boolean {
  return isProjectionTodoStatusItem(item) && Boolean(readProjectionToolMetadata(item));
}

function readProjectionApiError(
  item: ThreadRunProjectionTimelineItem,
): {
  message: string;
  title?: string;
  statusCode?: number;
  code?: string;
  accountId?: string;
} | undefined {
  const raw = item.metadata?.apiError;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!message) {
    return undefined;
  }
  return {
    message,
    ...(typeof record.title === "string" && record.title.trim() && { title: record.title.trim() }),
    ...(typeof record.statusCode === "number" && { statusCode: record.statusCode }),
    ...(typeof record.code === "string" && record.code.trim() && { code: record.code.trim() }),
    ...(typeof record.accountId === "string" &&
      record.accountId.trim() && { accountId: record.accountId.trim() }),
  };
}

const projectionToolMetadataCache = new WeakMap<object, ThreadRunToolMetadata | undefined>();

export function readProjectionToolMetadata(
  item: ThreadRunProjectionTimelineItem,
): ThreadRunToolMetadata | undefined {
  const raw = item.metadata?.tool;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  // Projection metadata is immutable. Grouping, sorting and rendering read the
  // same tool repeatedly; parse its file previews and targets once per version.
  if (projectionToolMetadataCache.has(raw)) return projectionToolMetadataCache.get(raw);
  const parsed = parseProjectionToolMetadata(raw as Record<string, unknown>);
  projectionToolMetadataCache.set(raw, parsed);
  return parsed;
}

function parseProjectionToolMetadata(record: Record<string, unknown>): ThreadRunToolMetadata | undefined {
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) {
    return undefined;
  }
  const fileChange = parseThreadRunFileChangeMetadata(record.fileChange);
  const readTarget = parseThreadRunReadToolTarget(record.readTarget);
  const grepTarget = parseThreadRunGrepToolTarget(record.grepTarget);
  const imageView = parseThreadRunImageViewMetadata(record.imageView);
  const rawImageDisplay = record.imageDisplay;
  const imageDisplayArtifactId =
    rawImageDisplay && typeof rawImageDisplay === "object"
      ? (rawImageDisplay as Record<string, unknown>).artifactId
      : undefined;
  const imageDisplayTitle =
    rawImageDisplay && typeof rawImageDisplay === "object"
      ? (rawImageDisplay as Record<string, unknown>).title
      : undefined;
  const imageDisplay =
    typeof imageDisplayArtifactId === "string" && imageDisplayArtifactId.trim()
      ? {
          artifactId: imageDisplayArtifactId.trim(),
          ...(typeof imageDisplayTitle === "string" && imageDisplayTitle.trim()
            ? { title: imageDisplayTitle.trim() }
            : {}),
        }
      : undefined;
  const rawHtmlHost = record.htmlHost;
  const htmlHostRecord =
    rawHtmlHost && typeof rawHtmlHost === "object" ? (rawHtmlHost as Record<string, unknown>) : undefined;
  const htmlHostPageId = typeof htmlHostRecord?.pageId === "string" ? htmlHostRecord.pageId.trim() : "";
  const htmlHostPublicUrl =
    typeof htmlHostRecord?.publicUrl === "string" ? htmlHostRecord.publicUrl.trim() : "";
  const htmlHost =
    htmlHostPageId && htmlHostPublicUrl
      ? {
          pageId: htmlHostPageId,
          publicUrl: htmlHostPublicUrl,
          ...(typeof htmlHostRecord?.title === "string" && htmlHostRecord.title.trim()
            ? { title: htmlHostRecord.title.trim() }
            : {}),
          ...(typeof htmlHostRecord?.expiresAt === "string" && htmlHostRecord.expiresAt.trim()
            ? { expiresAt: htmlHostRecord.expiresAt.trim() }
            : {}),
          ...(typeof htmlHostRecord?.canExtend === "boolean" ? { canExtend: htmlHostRecord.canExtend } : {}),
        }
      : undefined;
  const rawMcpDiscovery = record.mcpDiscovery;
  const mcpDiscovery =
    rawMcpDiscovery &&
    typeof rawMcpDiscovery === "object" &&
    (rawMcpDiscovery as Record<string, unknown>).kind === "search"
      ? { kind: "search" as const }
      : undefined;
  const webSearch = parseProjectionWebSearchMetadata(record.webSearch);
  const codemode = parseThreadRunCodemodeMetadata(record.codemode);
  return {
    name,
    ...(typeof record.detail === "string" && record.detail.trim() && { detail: record.detail.trim() }),
    ...(typeof record.outputPreview === "string" &&
      record.outputPreview.trim() && { outputPreview: record.outputPreview.trim() }),
    ...(record.outputPreviewTruncated === true && { outputPreviewTruncated: true }),
    ...(typeof record.toolUseId === "string" &&
      record.toolUseId.trim() && { toolUseId: record.toolUseId.trim() }),
    ...(typeof record.durationMs === "number" &&
      Number.isFinite(record.durationMs) && { durationMs: record.durationMs }),
    ...(typeof record.exitCode === "number" &&
      Number.isFinite(record.exitCode) && { exitCode: record.exitCode }),
    ...(isProjectionToolStatus(record.status) && { status: record.status }),
    ...(typeof record.description === "string" &&
      record.description.trim() && { description: record.description.trim() }),
    ...(fileChange && { fileChange }),
    ...(readTarget && { readTarget }),
    ...(grepTarget && { grepTarget }),
    ...(webSearch && { webSearch }),
    ...(imageView && { imageView }),
    ...(imageDisplay && { imageDisplay }),
    ...(htmlHost && { htmlHost }),
    ...(mcpDiscovery && { mcpDiscovery }),
    ...(codemode && { codemode }),
  };
}

function parseProjectionWebSearchMetadata(value: unknown): ThreadRunToolMetadata["webSearch"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query.trim() : "";
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const pattern = typeof record.pattern === "string" ? record.pattern.trim() : "";
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const queries = Array.isArray(record.queries)
    ? record.queries
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
        .slice(0, 12)
    : undefined;
  const results = Array.isArray(record.results)
    ? record.results
        .map((entry) => {
          if (!entry || typeof entry !== "object") return undefined;
          const hit = entry as Record<string, unknown>;
          const title = typeof hit.title === "string" ? hit.title.trim() : "";
          const hitUrl = typeof hit.url === "string" ? hit.url.trim() : "";
          const description = typeof hit.description === "string" ? hit.description.trim() : undefined;
          if (!title && !hitUrl && !description) return undefined;
          return {
            title,
            url: hitUrl,
            ...(description ? { description } : {}),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .slice(0, 12)
    : undefined;
  const actionType =
    record.actionType === "search" ||
    record.actionType === "openPage" ||
    record.actionType === "findInPage" ||
    record.actionType === "other"
      ? record.actionType
      : undefined;
  const mode = record.mode === "fetch" || record.mode === "search" ? record.mode : undefined;
  if (
    !query &&
    !url &&
    !pattern &&
    !provider &&
    !(queries && queries.length > 0) &&
    !(results && results.length > 0) &&
    !actionType &&
    !mode
  ) {
    return undefined;
  }
  return {
    ...(query && { query }),
    ...(url && { url }),
    ...(pattern && { pattern }),
    ...(provider && { provider }),
    ...(queries && queries.length > 0 && { queries }),
    ...(results && results.length > 0 && { results }),
    ...(actionType && { actionType }),
    ...(mode && { mode }),
  };
}

function isProjectionToolStatus(value: unknown): value is NonNullable<ThreadRunToolMetadata["status"]> {
  return value === "started" || value === "completed" || value === "failed";
}

function isProjectionLifecycleText(text: string): boolean {
  return /^Subagent\s+\S+\s+(started|stopped|abandoned)$/i.test(text);
}

function resolveProjectionPhaseLabel(item: ThreadRunProjectionTimelineItem): string | undefined {
  const text = item.text.trim();
  if (item.eventType === "context.compaction.started") {
    return text || i18n.t("projection.compactionStarted");
  }
  if (item.eventType === "context.compaction.completed") {
    return text || i18n.t("projection.compactionCompleted");
  }
  if (item.eventType === "context.compaction.failed") {
    return text || i18n.t("projection.compactionFailed");
  }
  if (item.eventType === "context.compaction.suspended") {
    return text || i18n.t("projection.compactionSuspended");
  }
  if (item.eventType === "context.cache_config_drift") {
    return text || i18n.t("projection.configChanged");
  }
  if (item.eventType === "context.cache_invalidated") {
    return text || i18n.t("projection.cacheInvalidated");
  }
  if (item.eventType === "billing.cache_hit_dropped") {
    return text || i18n.t("projection.cacheHitDropped");
  }
  if (item.eventType === "agent.started") {
    return i18n.t("projection.agentStarted", {
      agent: resolveSubagentRunDisplayTitle(item.role ?? i18n.t("projection.subagent")),
    });
  }
  if (item.eventType === "agent.stopped") {
    return i18n.t("projection.agentCompleted", {
      agent: resolveSubagentRunDisplayTitle(item.role ?? i18n.t("projection.subagent")),
    });
  }
  if (item.eventType === "agent.abandoned") {
    return i18n.t("projection.agentAbandoned", {
      agent: resolveSubagentRunDisplayTitle(item.role ?? i18n.t("projection.subagent")),
    });
  }
  if (item.eventType === "request.retry_scheduled") {
    return text || i18n.t("projection.retrying");
  }
  if (
    item.eventType === "request.completed" ||
    item.eventType === "request.failed" ||
    item.eventType === "request.cancelled"
  ) {
    return undefined;
  }
  if (item.eventType === "diagnostic") {
    return text || i18n.t("projection.diagnostic");
  }
  if (item.eventType === "thread.status") {
    if (!text || text === "状态已更新" || isProjectionLifecycleText(text)) {
      return undefined;
    }
    return text;
  }
  return undefined;
}

function resolveProjectionToolName(item: ThreadRunProjectionTimelineItem): string {
  const metadataTool = readProjectionToolMetadata(item);
  if (metadataTool?.name.trim()) {
    return metadataTool.name;
  }
  return i18n.t("projection.tool");
}

function resolveProjectionToolActionLabel(item: ThreadRunProjectionTimelineItem): string {
  const metadataTool = readProjectionToolMetadata(item);
  if (metadataTool) {
    return formatProjectionToolActionLabel(metadataTool);
  }
  return item.eventType === "tool.completed"
    ? i18n.t("projection.toolCompleted")
    : i18n.t("projection.toolCall");
}

function formatProjectionToolActionLabel(tool: ThreadRunToolMetadata): string {
  const base = formatProjectionToolBaseLabel(tool);
  if (tool.durationMs === undefined) {
    return base;
  }
  return `${base} (${(tool.durationMs / 1000).toFixed(1)}s)`;
}

function resolveProjectionToolStatusPreview(item: ThreadRunProjectionTimelineItem): string {
  const metadataTool = readProjectionToolMetadata(item);
  if (metadataTool) {
    const base = formatToolStatusPreview(
      metadataTool.name,
      formatThreadRunToolDetailLabel(metadataTool),
      translateActionKind,
    );
    if (metadataTool.durationMs === undefined) {
      return base;
    }
    return `${base} (${(metadataTool.durationMs / 1000).toFixed(1)}s)`;
  }
  const label = resolveProjectionToolActionLabel(item);
  return clampActivityPreviewLine(
    label
      .replace(/^Tool:\s*/iu, "")
      .replace(/\s+\(\d+(?:\.\d+)?s\)$/iu, "")
      .trim(),
  );
}

function formatProjectionToolBaseLabel(tool: ThreadRunToolMetadata): string {
  const structuredDetail = formatThreadRunToolDetailLabel(tool);
  return formatToolDisplayLabel(tool.name, structuredDetail, translateActionKind);
}

function readProjectionDelegationMetadata(
  item: ThreadRunProjectionTimelineItem,
): { subagent: string; summary: string; prompt?: string } | undefined {
  const metadata = item.metadata;
  const summary = typeof metadata?.delegationSummary === "string" ? metadata.delegationSummary.trim() : "";
  const prompt = typeof metadata?.delegationPrompt === "string" ? metadata.delegationPrompt.trim() : "";
  const role = normalizeAgentDisplayRole(item.role) ?? item.role?.trim();
  if (!summary && !prompt) {
    return undefined;
  }
  return {
    subagent: role || i18n.t("projection.subagent"),
    summary: summary || prompt.slice(0, 200),
    ...(prompt && { prompt }),
  };
}

export function readProjectionAgentDelegation(
  agent: Pick<ThreadRunProjectionAgent, "role" | "delegationSummary" | "delegationPrompt">,
): { subagent: string; summary: string; prompt?: string } | undefined {
  const summary = agent.delegationSummary?.trim() ?? "";
  const prompt = agent.delegationPrompt?.trim() ?? "";
  if (!summary && !prompt) {
    return undefined;
  }
  const subagent = normalizeAgentDisplayRole(agent.role) ?? agent.role;
  return {
    subagent,
    summary: summary || prompt.slice(0, 200),
    ...(prompt && { prompt }),
  };
}

/** Mission body for subagent cards — structured attribution only (delegation / parentToolUseId). */
export function resolveSubagentCardMissionText(
  agent: ThreadRunProjectionAgent,
  context: {
    mainTimeline?: readonly ThreadRunProjectionTimelineItem[];
  } = {},
): string {
  const delegation = readProjectionAgentDelegation(agent);
  if (delegation) {
    const text = resolveMissionDisplayText(delegation.prompt?.trim() || delegation.summary);
    if (text) {
      return text;
    }
  }
  for (const item of agent.timeline) {
    if (item.eventType === "agent.started") {
      const timelineDelegation = readProjectionDelegationMetadata(item);
      if (timelineDelegation) {
        const text = resolveMissionDisplayText(
          timelineDelegation.prompt?.trim() || timelineDelegation.summary,
        );
        if (text) {
          return text;
        }
      }
    }
    const mission = parseSubagentMissionMessage(item.text);
    if (mission) {
      if (mission.agentId?.trim() && mission.agentId.trim() !== agent.agentId) {
        continue;
      }
      if (item.agentId?.trim() && item.agentId.trim() !== agent.agentId) {
        continue;
      }
      const text = resolveMissionDisplayText(mission.prompt || mission.summary);
      if (text) {
        return text;
      }
    }
  }

  const parentToolUseId = agent.parentToolUseId?.trim();
  if (parentToolUseId && context.mainTimeline) {
    for (const item of context.mainTimeline) {
      const toolUseId =
        readProjectionToolMetadata(item)?.toolUseId?.trim() ??
        readProjectionBashApprovalMetadata(item)?.toolUseId?.trim();
      if (toolUseId !== parentToolUseId) {
        continue;
      }
      const mission = parseSubagentMissionMessage(item.text);
      if (!mission) {
        break;
      }
      if (mission.agentId?.trim() && mission.agentId.trim() !== agent.agentId) {
        break;
      }
      const text = resolveMissionDisplayText(mission.prompt || mission.summary);
      if (text) {
        return text;
      }
      break;
    }
  }

  return "";
}
