import { resolveProjectionDetailMergedAgent } from "../shared/conversation-v2-projection";
import { FEED_PROJECTION_MAX_AGENT_TIMELINE_ITEMS } from "../shared/conversation-v2-projection-limits";
import { excludeAgentScopedFeedTimelineItems } from "../shared/conversation-v2-projection-skeleton";
import type {
  ThreadRunProjectionAgent,
  ThreadRunProjectionDetailResult,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
} from "../shared/ipc";
import {
  isRecordedUserPromptLiveEvent,
  isThreadFollowUpActivityMessage,
} from "../shared/thread-follow-up-events";
import { isThinkingTextContinuation } from "./conversation-v2-projection-view";

export interface MergeThreadRunProjectionOptions {
  /** When true, reject trimmed feed updates that would drop older timeline items. */
  preserveHistory?: boolean;
}

function projectionHistoryRevision(snapshot: ThreadRunProjectionSnapshot): number {
  const revision = snapshot.historyRevision;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : 0;
}

function compareTimelineItems(
  left: ThreadRunProjectionTimelineItem,
  right: ThreadRunProjectionTimelineItem,
): number {
  const sequenceDiff = left.sequence - right.sequence;
  if (sequenceDiff !== 0) {
    return sequenceDiff;
  }
  return left.at.localeCompare(right.at);
}

function isStreamTimelineItem(item: ThreadRunProjectionTimelineItem): boolean {
  return (
    item.eventType === "thinking.delta" ||
    item.eventType === "thinking.final" ||
    item.eventType === "message.delta" ||
    item.eventType === "message.final"
  );
}

function projectionLiveType(item: ThreadRunProjectionTimelineItem): string | undefined {
  const liveType = item.metadata?.liveType;
  return typeof liveType === "string" ? liveType : undefined;
}

function isProjectionUserPromptItem(item: ThreadRunProjectionTimelineItem): boolean {
  const liveType = projectionLiveType(item);
  const textOk = item.text.trim().length > 0 && !isThreadFollowUpActivityMessage(item.text);
  if (!textOk) {
    return false;
  }
  if (isRecordedUserPromptLiveEvent(liveType)) {
    return true;
  }
  return liveType === "message.user" && item.role === "user" && item.scope !== "agent";
}

function hasUserPromptBetween(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  current: ThreadRunProjectionTimelineItem,
  incoming: ThreadRunProjectionTimelineItem,
): boolean {
  if (compareTimelineItems(current, incoming) >= 0) {
    return false;
  }
  return timeline.some(
    (item) =>
      isProjectionUserPromptItem(item) &&
      compareTimelineItems(current, item) < 0 &&
      compareTimelineItems(item, incoming) < 0,
  );
}

function preserveStreamTimelineText(
  current: ThreadRunProjectionTimelineItem,
  incoming: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): string {
  // A mid-turn prompt starts a new speech segment even when the provider
  // reuses the same stream id. Do not let the longer pre-steer text win the
  // cumulative-text merge and keep the old segment visible as if it were live.
  if (hasUserPromptBetween(timeline, current, incoming)) {
    return incoming.text;
  }
  if (shouldResetThinkingStreamMergeForMerge(current, incoming, timeline)) {
    return incoming.text;
  }
  if (!incoming.text.trim()) {
    return current.text;
  }
  if (!current.text.trim()) {
    return incoming.text;
  }
  return incoming.text.length >= current.text.length ? incoming.text : current.text;
}

function shouldResetThinkingStreamMergeForMerge(
  current: ThreadRunProjectionTimelineItem,
  incoming: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  const isThinking =
    current.eventType === "thinking.delta" ||
    current.eventType === "thinking.final" ||
    incoming.eventType === "thinking.delta" ||
    incoming.eventType === "thinking.final";
  if (!isThinking) {
    return false;
  }
  const currentRequestId = current.requestId?.trim();
  const incomingRequestId = incoming.requestId?.trim();
  if (currentRequestId && incomingRequestId && currentRequestId !== incomingRequestId) {
    return true;
  }
  if (hasUserPromptBetween(timeline, current, incoming)) {
    return true;
  }
  if (current.eventType === "thinking.final" && current.id !== incoming.id) {
    return true;
  }
  if (current.id !== incoming.id && !isThinkingTextContinuation(current.text, incoming.text)) {
    return true;
  }
  return false;
}

function mergeStreamTimelineItem(
  current: ThreadRunProjectionTimelineItem,
  incoming: ThreadRunProjectionTimelineItem,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem {
  const preserveLoadedContent =
    current.contentLoaded === true && incoming.contentLoaded !== true && current.contentAvailable === true;
  if (!isStreamTimelineItem(current) || !isStreamTimelineItem(incoming)) {
    return preserveLoadedContent
      ? {
          ...incoming,
          text: current.text,
          ...(current.summary !== undefined ? { summary: current.summary } : {}),
          contentLoaded: true,
          contentAvailable: true,
        }
      : incoming;
  }
  const text = preserveStreamTimelineText(current, incoming, timeline);
  if (text === incoming.text && !preserveLoadedContent) {
    return incoming;
  }
  return {
    ...incoming,
    text,
    ...(preserveLoadedContent
      ? {
          ...(current.summary !== undefined ? { summary: current.summary } : {}),
          contentLoaded: true,
          contentAvailable: true,
        }
      : {}),
  };
}

function timelineItemsEqual(
  current: ThreadRunProjectionTimelineItem,
  incoming: ThreadRunProjectionTimelineItem,
): boolean {
  return (
    current === incoming ||
    (current.id === incoming.id &&
      current.sequence === incoming.sequence &&
      current.eventType === incoming.eventType &&
      current.scope === incoming.scope &&
      current.role === incoming.role &&
      current.agentId === incoming.agentId &&
      current.requestId === incoming.requestId &&
      current.streamKey === incoming.streamKey &&
      current.text === incoming.text &&
      current.at === incoming.at &&
      JSON.stringify(current.metadata ?? null) === JSON.stringify(incoming.metadata ?? null))
  );
}

function mergeProjectionTimelines(
  current: readonly ThreadRunProjectionTimelineItem[],
  incoming: readonly ThreadRunProjectionTimelineItem[],
  maxItems?: number,
): ThreadRunProjectionTimelineItem[] {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  let changed = false;
  const merged = current.map((item) => {
    const update = incomingById.get(item.id);
    if (!update) {
      return item;
    }
    const next = mergeStreamTimelineItem(item, update, incoming);
    if (timelineItemsEqual(item, next)) {
      return item;
    }
    changed = true;
    return next;
  });
  const knownIds = new Set(merged.map((item) => item.id));
  for (const item of incoming) {
    if (!knownIds.has(item.id)) {
      merged.push(item);
      knownIds.add(item.id);
      changed = true;
    }
  }
  if (!changed && (maxItems === undefined || current.length <= maxItems)) {
    return current as ThreadRunProjectionTimelineItem[];
  }
  if (changed) {
    merged.sort(compareTimelineItems);
  }
  return maxItems === undefined ? merged : merged.slice(-maxItems);
}

function projectionAgentStableSignature(agent: ThreadRunProjectionAgent): string {
  const isActive = agent.status === "active" || agent.status === "launching";
  return JSON.stringify({
    agentId: agent.agentId,
    role: agent.role,
    kind: agent.kind,
    status: agent.status,
    startedAt: agent.startedAt,
    durationMs: isActive ? undefined : agent.durationMs,
    runAttemptId: agent.runAttemptId,
    parentAgentId: agent.parentAgentId,
    parentToolUseId: agent.parentToolUseId,
    mission: agent.mission,
    delegationSummary: agent.delegationSummary,
    delegationPrompt: agent.delegationPrompt,
    taskName: agent.taskName,
    nickname: agent.nickname,
    todoId: agent.todoId,
    endedAt: agent.endedAt,
    latestActivity: agent.latestActivity,
    usage: agent.usage,
    context: agent.context,
  });
}

function mergeProjectionAgents(
  current: readonly ThreadRunProjectionAgent[],
  incoming: readonly ThreadRunProjectionAgent[],
): ThreadRunProjectionAgent[] {
  const currentById = new Map(current.map((agent) => [agent.agentId, agent]));
  const incomingIds = new Set(incoming.map((agent) => agent.agentId));
  let changed = false;
  const merged = incoming.map((agent) => {
    const currentAgent = currentById.get(agent.agentId);
    if (!currentAgent) {
      changed = true;
      return agent;
    }
    const timeline = mergeProjectionTimelines(
      currentAgent.timeline,
      agent.timeline,
      FEED_PROJECTION_MAX_AGENT_TIMELINE_ITEMS,
    );
    const nextAgent = {
      ...agent,
      timeline,
    };
    if (
      timeline === currentAgent.timeline &&
      projectionAgentStableSignature(currentAgent) === projectionAgentStableSignature(nextAgent)
    ) {
      return currentAgent;
    }
    changed = true;
    return {
      ...nextAgent,
    };
  });

  for (const agent of current) {
    if (!incomingIds.has(agent.agentId)) {
      merged.push(agent);
    }
  }
  if (!changed) {
    return current as ThreadRunProjectionAgent[];
  }
  return merged;
}

function mergeTrimmedIncomingProjection(
  current: ThreadRunProjectionSnapshot,
  incoming: ThreadRunProjectionSnapshot,
): ThreadRunProjectionSnapshot {
  const timeline = mergeProjectionTimelines(
    excludeAgentScopedFeedTimelineItems(current.timeline),
    excludeAgentScopedFeedTimelineItems(incoming.timeline),
  );
  const agents = mergeProjectionAgents(current.agents, incoming.agents);
  if (
    timeline === current.timeline &&
    agents === current.agents &&
    incoming.sourceEventCount === current.sourceEventCount &&
    projectionThreadStableSignature(incoming) === projectionThreadStableSignature(current) &&
    JSON.stringify(incoming.attempts) === JSON.stringify(current.attempts) &&
    JSON.stringify(incoming.requestSpans) === JSON.stringify(current.requestSpans) &&
    JSON.stringify(incoming.diagnostics) === JSON.stringify(current.diagnostics)
  ) {
    return current;
  }
  return {
    ...incoming,
    timeline,
    agents,
    sourceEventCount: Math.max(current.sourceEventCount, incoming.sourceEventCount),
  };
}

function mergeIncomingProjection(
  current: ThreadRunProjectionSnapshot,
  incoming: ThreadRunProjectionSnapshot,
): ThreadRunProjectionSnapshot {
  const timeline = mergeProjectionTimelines(
    excludeAgentScopedFeedTimelineItems(current.timeline),
    excludeAgentScopedFeedTimelineItems(incoming.timeline),
  );
  const agents = mergeProjectionAgents(current.agents, incoming.agents);
  if (
    timeline === current.timeline &&
    agents === current.agents &&
    incoming.sourceEventCount === current.sourceEventCount &&
    projectionThreadStableSignature(incoming) === projectionThreadStableSignature(current) &&
    JSON.stringify(incoming.attempts) === JSON.stringify(current.attempts) &&
    JSON.stringify(incoming.requestSpans) === JSON.stringify(current.requestSpans) &&
    JSON.stringify(incoming.diagnostics) === JSON.stringify(current.diagnostics)
  ) {
    return current;
  }
  return {
    ...incoming,
    timeline,
    agents,
    sourceEventCount: Math.max(current.sourceEventCount, incoming.sourceEventCount),
  };
}

function projectionThreadStableSignature(snapshot: ThreadRunProjectionSnapshot): string {
  return JSON.stringify({
    threadId: snapshot.thread.threadId,
    status: snapshot.thread.status,
    message: snapshot.thread.message,
    currentAttemptId: snapshot.thread.currentAttemptId,
  });
}

export function mergeThreadRunProjectionUpdate(
  current: ThreadRunProjectionSnapshot | undefined,
  incoming: ThreadRunProjectionSnapshot,
  options?: MergeThreadRunProjectionOptions,
): ThreadRunProjectionSnapshot {
  const sanitizedTimeline = excludeAgentScopedFeedTimelineItems(incoming.timeline);
  const sanitizedIncoming =
    sanitizedTimeline === incoming.timeline ? incoming : { ...incoming, timeline: sanitizedTimeline };
  if (!current) {
    return sanitizedIncoming;
  }

  const currentHistoryRevision = projectionHistoryRevision(current);
  const incomingHistoryRevision = projectionHistoryRevision(sanitizedIncoming);
  if (incomingHistoryRevision < currentHistoryRevision) {
    return current;
  }
  if (incomingHistoryRevision > currentHistoryRevision) {
    return sanitizedIncoming;
  }

  const preserveHistory = options?.preserveHistory === true;

  if (sanitizedIncoming.sourceEventCount > current.sourceEventCount) {
    if (sanitizedIncoming.timeline.length < current.timeline.length) {
      return mergeTrimmedIncomingProjection(current, sanitizedIncoming);
    }
    return mergeIncomingProjection(current, sanitizedIncoming);
  }

  if (sanitizedIncoming.sourceEventCount === current.sourceEventCount) {
    if (sanitizedIncoming.timeline.length > current.timeline.length) {
      return mergeIncomingProjection(current, sanitizedIncoming);
    }
    if (sanitizedIncoming.timeline.length < current.timeline.length) {
      return sanitizedIncoming.thread.generatedAt >= current.thread.generatedAt
        ? mergeTrimmedIncomingProjection(current, sanitizedIncoming)
        : current;
    }
    if (sanitizedIncoming.thread.generatedAt >= current.thread.generatedAt) {
      return mergeIncomingProjection(current, sanitizedIncoming);
    }
    return current;
  }

  // sourceEventCount decreased — likely due to context compaction.
  // Always merge so that post-compaction timeline items are not lost.
  if (sanitizedIncoming.timeline.length > current.timeline.length) {
    return mergeTrimmedIncomingProjection(current, sanitizedIncoming);
  }
  if (preserveHistory) {
    return mergeTrimmedIncomingProjection(current, sanitizedIncoming);
  }
  return mergeTrimmedIncomingProjection(current, sanitizedIncoming);
}

/** Merge an explicitly requested detail page without applying Feed page limits. */
export function mergeThreadRunProjectionDetail(
  current: ThreadRunProjectionSnapshot,
  detail: ThreadRunProjectionDetailResult,
): ThreadRunProjectionSnapshot {
  const mainItems = detail.timeline.filter((item) => item.scope !== "agent");
  const agentItems = new Map<string, ThreadRunProjectionTimelineItem[]>();
  for (const item of detail.timeline) {
    const agentId = item.agentId?.trim();
    if (item.scope === "agent" && agentId) {
      agentItems.set(agentId, [...(agentItems.get(agentId) ?? []), item]);
    }
  }
  const mergeTimeline = (
    left: readonly ThreadRunProjectionTimelineItem[],
    right: readonly ThreadRunProjectionTimelineItem[],
  ) => {
    const byId = new Map(left.map((item) => [item.id, item]));
    for (const item of right) byId.set(item.id, item);
    return [...byId.values()].sort(compareTimelineItems);
  };
  const agents = current.agents.map((agent) => {
    const incoming = agentItems.get(agent.agentId);
    return incoming ? { ...agent, timeline: mergeTimeline(agent.timeline, incoming) } : agent;
  });
  for (const [agentId, incoming] of agentItems) {
    if (agents.some((agent) => agent.agentId === agentId)) continue;
    agents.push({
      agentId,
      ...resolveProjectionDetailMergedAgent(agentId, detail, incoming),
      timeline: incoming,
    });
  }
  return {
    ...current,
    timeline: mergeTimeline(excludeAgentScopedFeedTimelineItems(current.timeline), mainItems),
    agents,
  };
}
