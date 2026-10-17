import type {
  ThreadBillingSnapshot,
  ThreadContextSnapshot,
  ThreadRunEvent,
  ThreadRunProjectionAgent,
  ThreadRunProjectionAttempt,
  ThreadRunProjectionContext,
  ThreadRunProjectionDiagnostic,
  ThreadRunProjectionRequestSpan,
  ThreadRunProjectionRequestStatus,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
  ThreadRunProjectionUsage,
  ThreadRunProjectionWritingTool,
  ThreadStatus,
  ThreadSubagentSessionTiming,
  ToolWritingActivity,
} from "../shared/ipc";
import { SUBAGENT_ROLES } from "../shared/ipc";
import { legacyMessageId } from "./conversation-v2-legacy-identity";
import { isMetricsOnlyThreadRunEvent } from "./thread-run-event-normalizer";
import { dedupeSettledSdkMessageBlocks } from "./thread-run-message-blocks";
import type { AgentInstanceRecord, RunAttemptRecord } from "./usage-ledger";

const subagentRoleSet = new Set<string>(SUBAGENT_ROLES);

export interface BuildThreadRunProjectionInput {
  threadId: string;
  status: ThreadStatus | string;
  message?: string;
  attempts: readonly RunAttemptRecord[];
  agents: readonly AgentInstanceRecord[];
  events: readonly ThreadRunEvent[];
  billing?: ThreadBillingSnapshot;
  context?: ThreadContextSnapshot;
  subagentTimings?: readonly ThreadSubagentSessionTiming[];
  nowMs?: number;
  /** False when events are a bounded tail and earlier lifecycle events may be absent. */
  historyComplete?: boolean;
}

interface MutableRequestSpan {
  requestId: string;
  runAttemptId?: string;
  ownerAgentId?: string;
  role?: string;
  source?: string;
  status: ThreadRunProjectionRequestStatus;
  startedAt: string;
  firstTokenAt?: string;
  endedAt?: string;
  error?: string;
  providerRequestId?: string;
  writingTool?: ThreadRunProjectionWritingTool;
  pendingThinkingSince?: string;
  pendingThinkingMessageId?: string;
  sawStreamStart: boolean;
}

export function buildThreadRunProjection(input: BuildThreadRunProjectionInput): ThreadRunProjectionSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const sortedEvents = [...input.events].sort((left, right) => {
    const sequenceDiff = left.sequence - right.sequence;
    return sequenceDiff !== 0 ? sequenceDiff : left.observedAt.localeCompare(right.observedAt);
  });
  const events = dedupeSettledSdkMessageBlocks(sortedEvents);
  const attempts = input.attempts
    .map(mapAttempt)
    .sort(
      (left, right) => left.startedAt.localeCompare(right.startedAt) || left.retryIndex - right.retryIndex,
    );
  const currentAttemptId =
    attempts.find((attempt) => attempt.status === "running")?.attemptId ??
    attempts[attempts.length - 1]?.attemptId;

  // Facts that only exist to drive projection state (request spans, timings) must not grow
  // a Feed row; every other feed path already filters them the same way.
  const timeline = events
    .filter((event) => !isMetricsOnlyThreadRunEvent(event))
    .map((event) => eventToTimelineItem(event));
  const diagnostics: ThreadRunProjectionDiagnostic[] = [];
  const agentsById = new Map<string, ThreadRunProjectionAgent>();
  const eventsByAgentId = new Map<string, ThreadRunProjectionTimelineItem[]>();
  const agentsByParentToolUseId = buildAgentsByParentToolUseId(input.agents);
  const discoveredAgentsById = new Map<string, AgentInstanceRecord>();
  const pendingByParentToolUseId = new Map<string, ThreadRunEvent[]>();

  const appendAgentTimelineItem = (agentId: string, item: ThreadRunProjectionTimelineItem): void => {
    const rows = eventsByAgentId.get(agentId) ?? [];
    rows.push(item);
    eventsByAgentId.set(agentId, rows);
  };

  const flushPendingForParentToolUseId = (parentToolUseId: string): void => {
    const pending = pendingByParentToolUseId.get(parentToolUseId);
    if (!pending?.length) {
      return;
    }
    const linked = agentsByParentToolUseId.get(parentToolUseId);
    if (!linked) {
      return;
    }
    for (const pendingEvent of pending) {
      appendAgentTimelineItem(linked.agentId, eventToTimelineItem(pendingEvent, linked.agentId));
    }
    pendingByParentToolUseId.delete(parentToolUseId);
  };

  const registerAgentParentLink = (event: ThreadRunEvent, parentToolUseId: string): void => {
    const agentId = event.agentId?.trim();
    if (!agentId) {
      return;
    }
    if (event.eventType === "agent.started") {
      const discovered = agentRecordFromStartedEvent(event);
      if (discovered) {
        discoveredAgentsById.set(discovered.agentId, discovered);
      }
    }
    if (!agentsByParentToolUseId.has(parentToolUseId)) {
      const linked =
        input.agents.find((candidate) => candidate.agentId === agentId) ??
        input.agents.find((candidate) => candidate.parentToolUseId?.trim() === parentToolUseId) ??
        discoveredAgentsById.get(agentId) ??
        agentRecordFromStartedEvent(event) ??
        agentRecordFromDelegationLink(event, parentToolUseId);
      if (!linked) {
        return;
      }
      const withParent =
        linked.parentToolUseId?.trim() === parentToolUseId
          ? linked
          : { ...linked, parentToolUseId, updatedAt: event.observedAt };
      discoveredAgentsById.set(agentId, withParent);
      agentsByParentToolUseId.set(parentToolUseId, withParent);
    }
    flushPendingForParentToolUseId(parentToolUseId);
  };

  for (const event of events) {
    if (isMetricsOnlyThreadRunEvent(event)) {
      continue;
    }
    const parentToolUseId = event.parentToolUseId?.trim() ?? readEventParentToolUseId(event);
    if (parentToolUseId && event.agentId?.trim()) {
      registerAgentParentLink(event, parentToolUseId);
    } else if (event.eventType === "agent.started" && event.agentId) {
      const discovered = agentRecordFromStartedEvent(event);
      if (discovered) {
        discoveredAgentsById.set(discovered.agentId, discovered);
      }
    }
    const resolvedAgentId = resolveProjectionEventAgentId(
      event,
      agentsByParentToolUseId,
      input.agents,
      discoveredAgentsById,
      diagnostics,
    );
    if (event.scope !== "agent" && event.scope !== "both") {
      continue;
    }
    if (resolvedAgentId) {
      appendAgentTimelineItem(resolvedAgentId, eventToTimelineItem(event, resolvedAgentId));
      continue;
    }
    if (parentToolUseId) {
      const pending = pendingByParentToolUseId.get(parentToolUseId) ?? [];
      pending.push(event);
      pendingByParentToolUseId.set(parentToolUseId, pending);
    }
  }

  for (const [parentToolUseId, pending] of pendingByParentToolUseId) {
    const linked = agentsByParentToolUseId.get(parentToolUseId);
    if (linked) {
      for (const pendingEvent of pending) {
        appendAgentTimelineItem(linked.agentId, eventToTimelineItem(pendingEvent, linked.agentId));
      }
      continue;
    }
    for (const pendingEvent of pending) {
      diagnostics.push({
        code: "missing_agent_id",
        message: `Agent-scoped event is waiting for parent tool link ${parentToolUseId}.`,
        eventId: pendingEvent.id,
      });
    }
  }

  const usageByAgentId = buildUsageByAgentId(input.billing);
  const contextByAgentId = buildContextByAgentId(input.context);
  const timingByAgentId = new Map((input.subagentTimings ?? []).map((timing) => [timing.agentId, timing]));

  const projectionAgents = applyLifecycleEventsToAgents(
    mergeProjectionAgentRecords(input.agents, discoveredAgentsById),
    events,
  );
  const knownAgentIds = new Set(projectionAgents.map((agent) => agent.agentId));
  // Orphan agent-scoped rows (e.g. main Codex id mis-tagged as general without
  // agent.started) never grow an agent card — reclaim them for the main feed.
  for (const agentId of eventsByAgentId.keys()) {
    if (!knownAgentIds.has(agentId)) {
      eventsByAgentId.delete(agentId);
    }
  }
  for (const agent of projectionAgents) {
    const timelineItems = eventsByAgentId.get(agent.agentId) ?? [];
    const startedAt = agent.startedAt;
    const endedAt = agent.endedAt;
    const timing = timingByAgentId.get(agent.agentId);
    const usage = usageByAgentId.get(agent.agentId);
    const context = contextByAgentId.get(agent.agentId);
    const activity = latestActivity(timelineItems);
    const delegation = resolveAgentDelegationFromEvents(events, agent.agentId);
    const identity = resolveAgentCardIdentityFromEvents(events, agent.agentId);
    const durationMs =
      timing?.durationMs ?? computeDurationMs(startedAt, endedAt, nowMs, diagnostics, agent.agentId);
    agentsById.set(agent.agentId, {
      agentId: agent.agentId,
      role: agent.role,
      kind: agent.kind,
      status: agent.status,
      startedAt,
      durationMs,
      timeline: timelineItems,
      ...(agent.runAttemptId && { runAttemptId: agent.runAttemptId }),
      ...(agent.parentAgentId && { parentAgentId: agent.parentAgentId }),
      ...(agent.parentToolUseId && { parentToolUseId: agent.parentToolUseId }),
      ...(agent.missionKey && { mission: agent.missionKey }),
      ...(delegation.delegationSummary && { delegationSummary: delegation.delegationSummary }),
      ...(delegation.delegationPrompt && { delegationPrompt: delegation.delegationPrompt }),
      ...(identity.taskName && { taskName: identity.taskName }),
      ...(identity.nickname && { nickname: identity.nickname }),
      ...(agent.todoId && { todoId: agent.todoId }),
      ...(endedAt && { endedAt }),
      ...(activity && { latestActivity: activity }),
      ...(usage && { usage }),
      ...(context && { context }),
    });
  }

  const requestSpans = buildRequestSpans(
    events,
    input.status,
    diagnostics,
    input.agents,
    input.historyComplete ?? true,
  );
  const projectedAgentIds = new Set(agentsById.keys());
  const mainTimeline = timeline.flatMap((item) => {
    if (item.scope === "main" || item.scope === "both") {
      return [item];
    }
    if (item.scope !== "agent") {
      return [];
    }
    const agentId = item.agentId?.trim();
    // Pending agent tools (no agentId yet) stay off main so they can land on a card.
    // Only promote concrete orphan owners (mis-tagged root id with no agent.started).
    if (!agentId || projectedAgentIds.has(agentId)) {
      return [];
    }
    return [
      {
        ...item,
        scope: "main" as const,
        ...(item.role === "general" || item.role === "subagent" ? { role: "assistant" as const } : {}),
      },
    ];
  });

  return {
    thread: {
      threadId: input.threadId,
      status: input.status,
      generatedAt: new Date(nowMs).toISOString(),
      ...(input.message && { message: input.message }),
      ...(currentAttemptId && { currentAttemptId }),
    },
    attempts,
    agents: [...agentsById.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    requestSpans,
    timeline: mainTimeline,
    diagnostics,
    sourceEventCount: input.events.length,
  };
}

function mapAttempt(attempt: RunAttemptRecord): ThreadRunProjectionAttempt {
  return {
    attemptId: attempt.attemptId,
    phase: attempt.phase,
    retryIndex: attempt.retryIndex,
    status: attempt.status,
    startedAt: attempt.startedAt,
    ...(attempt.endedAt && { endedAt: attempt.endedAt }),
  };
}

export function eventToTimelineItem(
  event: ThreadRunEvent,
  resolvedAgentId?: string,
): ThreadRunProjectionTimelineItem {
  return {
    id: event.id,
    sequence: event.sequence,
    eventType: event.eventType,
    scope: event.scope,
    text: event.message,
    at: event.observedAt,
    ...(event.role && { role: event.role }),
    ...(resolvedAgentId || event.agentId ? { agentId: resolvedAgentId ?? event.agentId } : {}),
    ...(event.runAttemptId && { runAttemptId: event.runAttemptId }),
    ...(event.requestId && { requestId: event.requestId }),
    ...(event.streamKey && { streamKey: event.streamKey }),
    ...(event.metadata && { metadata: event.metadata }),
  };
}

function buildAgentsByParentToolUseId(
  agents: readonly AgentInstanceRecord[],
): Map<string, AgentInstanceRecord> {
  const map = new Map<string, AgentInstanceRecord>();
  for (const agent of agents) {
    const parentToolUseId = agent.parentToolUseId?.trim();
    if (parentToolUseId) {
      map.set(parentToolUseId, agent);
    }
  }
  return map;
}

function resolveProjectionEventAgentId(
  event: ThreadRunEvent,
  agentsByParentToolUseId: ReadonlyMap<string, AgentInstanceRecord>,
  agents: readonly AgentInstanceRecord[],
  discoveredAgentsById: ReadonlyMap<string, AgentInstanceRecord>,
  diagnostics: ThreadRunProjectionDiagnostic[],
): string | undefined {
  if (event.scope !== "agent" && event.scope !== "both") {
    return event.agentId;
  }
  if (event.agentId) {
    return event.agentId;
  }

  const parentToolUseId = event.parentToolUseId?.trim() ?? readEventParentToolUseId(event);
  if (parentToolUseId) {
    const linked = agentsByParentToolUseId.get(parentToolUseId);
    if (linked) {
      return linked.agentId;
    }
    return undefined;
  }

  const uniqueRoleAgentId = resolveUniqueSubagentForRole(event, agents, discoveredAgentsById);
  if (uniqueRoleAgentId) {
    return uniqueRoleAgentId;
  }

  if (!event.role || !subagentRoleSet.has(event.role)) {
    return undefined;
  }

  diagnostics.push({
    code: "missing_agent_id",
    message: `Agent-scoped event for role ${event.role} is missing agentId.`,
    eventId: event.id,
  });
  return undefined;
}

/** Resolve role-only agent events when the run has exactly one subagent of that role. */
function resolveUniqueSubagentForRole(
  event: ThreadRunEvent,
  agents: readonly AgentInstanceRecord[],
  discoveredAgentsById: ReadonlyMap<string, AgentInstanceRecord>,
): string | undefined {
  if (!event.role || !subagentRoleSet.has(event.role)) {
    return undefined;
  }
  const attemptId = event.runAttemptId?.trim();
  const pool = [...agents, ...discoveredAgentsById.values()].filter(
    (agent) =>
      agent.kind === "subagent" &&
      agent.role === event.role &&
      (!attemptId || agent.runAttemptId === attemptId),
  );
  const uniqueById = new Map(pool.map((agent) => [agent.agentId, agent]));
  if (uniqueById.size !== 1) {
    return undefined;
  }
  const agent = [...uniqueById.values()][0];
  if (!agent) {
    return undefined;
  }
  const observedMs = Date.parse(event.observedAt);
  const startedMs = Date.parse(agent.startedAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(startedMs)) {
    return agent.agentId;
  }
  const preStartGraceMs = 15_000;
  const endedMs = agent.endedAt ? Date.parse(agent.endedAt) : Number.POSITIVE_INFINITY;
  if (observedMs < startedMs - preStartGraceMs) {
    return undefined;
  }
  if (Number.isFinite(endedMs) && observedMs > endedMs + preStartGraceMs) {
    return undefined;
  }
  return agent.agentId;
}

function readEventParentToolUseId(event: ThreadRunEvent): string | undefined {
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const parentToolUseId = metadata.parentToolUseId ?? metadata.parent_tool_use_id;
  if (typeof parentToolUseId === "string" && parentToolUseId.trim()) {
    return parentToolUseId.trim();
  }
  return undefined;
}

function agentRecordFromStartedEvent(event: ThreadRunEvent): AgentInstanceRecord | undefined {
  if (event.eventType !== "agent.started" || !event.agentId) {
    return undefined;
  }
  const parentToolUseId = event.parentToolUseId?.trim() ?? readEventParentToolUseId(event);
  return {
    threadId: event.threadId,
    agentId: event.agentId,
    role: event.role ?? "coder",
    kind: "subagent",
    status: "active",
    startedAt: event.observedAt,
    updatedAt: event.observedAt,
    ...(event.runAttemptId && { runAttemptId: event.runAttemptId }),
    ...(parentToolUseId && { parentToolUseId }),
  };
}

function agentRecordFromDelegationLink(
  event: ThreadRunEvent,
  parentToolUseId: string,
): AgentInstanceRecord | undefined {
  const agentId = event.agentId?.trim();
  if (!agentId) {
    return undefined;
  }
  // Stop/abandon alone must not mint a card. Inverted child-turn completion can attach
  // parentToolUseId + main codex thread id as "agent.stopped", which previously created a
  // phantom general card that swallowed the main agent wrap-up.
  if (event.eventType === "agent.stopped" || event.eventType === "agent.abandoned") {
    return undefined;
  }
  return {
    threadId: event.threadId,
    agentId,
    role: event.role ?? "coder",
    kind: "subagent",
    status: "active",
    startedAt: event.observedAt,
    updatedAt: event.observedAt,
    parentToolUseId,
    ...(event.runAttemptId && { runAttemptId: event.runAttemptId }),
  };
}

function mergeProjectionAgentRecords(
  agents: readonly AgentInstanceRecord[],
  discoveredAgentsById: ReadonlyMap<string, AgentInstanceRecord>,
): AgentInstanceRecord[] {
  const merged = new Map<string, AgentInstanceRecord>();
  for (const agent of discoveredAgentsById.values()) {
    merged.set(agent.agentId, agent);
  }
  for (const agent of agents) {
    const existing = merged.get(agent.agentId);
    merged.set(agent.agentId, existing ? { ...existing, ...agent } : agent);
  }
  return [...merged.values()];
}

/** Overlay agent.stopped / agent.abandoned onto cards even when the instance row is still active. */
function applyLifecycleEventsToAgents(
  agents: readonly AgentInstanceRecord[],
  events: readonly ThreadRunEvent[],
): AgentInstanceRecord[] {
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
  for (const event of events) {
    if (event.eventType !== "agent.stopped" && event.eventType !== "agent.abandoned") {
      continue;
    }
    const agentId = event.agentId?.trim();
    if (!agentId) {
      continue;
    }
    const existing = byId.get(agentId);
    if (!existing) {
      continue;
    }
    const status = event.eventType === "agent.abandoned" ? "abandoned" : "stopped";
    if (existing.status === "abandoned" && status === "stopped") {
      continue;
    }
    byId.set(agentId, {
      ...existing,
      status,
      endedAt: event.observedAt,
      updatedAt: event.observedAt,
    });
  }
  return [...byId.values()];
}

function buildUsageByAgentId(
  billing: ThreadBillingSnapshot | undefined,
): Map<string, ThreadRunProjectionUsage> {
  const map = new Map<string, ThreadRunProjectionUsage>();
  for (const row of billing?.subagents ?? []) {
    map.set(row.agentId, {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      ecoCostUsd: row.ecoCostUsd,
      ...(row.modelId && { modelId: row.modelId }),
    });
  }
  return map;
}

function buildContextByAgentId(
  context: ThreadContextSnapshot | undefined,
): Map<string, ThreadRunProjectionContext> {
  const map = new Map<string, ThreadRunProjectionContext>();
  for (const row of context?.instances ?? []) {
    map.set(row.agentId, {
      occupied: row.occupied,
      limit: row.limit,
      occupancyPct: row.occupancyPct,
      ...(row.modelId && { modelId: row.modelId }),
    });
  }
  return map;
}

function computeDurationMs(
  startedAt: string,
  endedAt: string | undefined,
  nowMs: number,
  diagnostics: ThreadRunProjectionDiagnostic[],
  agentId: string,
): number {
  const startMs = Date.parse(startedAt);
  const endMs = endedAt ? Date.parse(endedAt) : nowMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0;
  }
  const durationMs = endMs - startMs;
  if (durationMs < 0) {
    diagnostics.push({
      code: "negative_duration",
      message: `Agent ${agentId} has negative duration.`,
      agentId,
    });
    return 0;
  }
  return durationMs;
}

function latestActivity(items: readonly ThreadRunProjectionTimelineItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const text = items[index]?.text.trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

/**
 * Attach "the model is writing a tool call" to the request the model was on when it wrote it.
 *
 * Tool facts are the one event family that carries no `requestId` — the bridge keys them by
 * `tool:<callId>` and a call outlives the request that wrote it — so the per-span pass above
 * never sees them. They still belong to a request: the call is written *by* the model's last
 * request, and it is observed milliseconds after that request reports terminal, before the
 * tool row lands. Attribute it to the latest started request of the same agent, using the
 * explicit agent id or its parent-tool link rather than another concurrent agent's request.
 *
 * State is cleared by the real tool row landing (the wait is over even when the call itself
 * keeps running) and by the thread leaving `running`, so a write interrupted before its call
 * is ever made cannot leave the Feed naming it forever.
 */
function applyToolWritingState(
  spans: ReadonlyMap<string, MutableRequestSpan>,
  events: readonly ThreadRunEvent[],
  threadStatus: string,
  agents: readonly AgentInstanceRecord[],
): void {
  if (!ACTIVE_THREAD_STATUSES.has(threadStatus)) {
    return;
  }
  const orderedByOwner = new Map<string | undefined, MutableRequestSpan[]>();
  for (const span of spans.values()) {
    const owned = orderedByOwner.get(span.ownerAgentId) ?? [];
    owned.push(span);
    orderedByOwner.set(span.ownerAgentId, owned);
  }
  for (const owned of orderedByOwner.values()) {
    owned.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }
  const agentsByParentToolUseId = buildAgentsByParentToolUseId(agents);
  const attachedByOwner = new Map<string | undefined, MutableRequestSpan>();
  const callIdsByOwner = new Map<string | undefined, string>();
  const resolveTarget = (event: ThreadRunEvent): MutableRequestSpan | undefined => {
    if (event.requestId) {
      return spans.get(event.requestId);
    }
    const parentToolUseId = event.parentToolUseId?.trim() ?? readEventParentToolUseId(event);
    const ownerAgentId =
      event.agentId?.trim() ||
      (parentToolUseId ? agentsByParentToolUseId.get(parentToolUseId)?.agentId : undefined);
    // An unresolved agent-scoped fact has no main-agent ownership to borrow.
    if (!ownerAgentId && (parentToolUseId || event.scope !== "main")) {
      return undefined;
    }
    const ordered = orderedByOwner.get(ownerAgentId);
    return ordered ? latestSpanStartedBy(ordered, event.observedAt, event.runAttemptId) : undefined;
  };
  for (const event of events) {
    const target = resolveTarget(event);
    if (!target || orderedByOwner.get(target.ownerAgentId)?.at(-1) !== target) continue;
    if (event.eventType === "tool.writing") {
      const writing = resolveToolWritingActivity(event);
      if (!writing) {
        continue;
      }
      // Gateway argument deltas can arrive after cancellation. A later running
      // turn must not revive that old request's waiting line (or inherit it).
      // Completed narrative streams remain eligible: the model may write its
      // tool arguments after closing the text block.
      if (target.status === "cancelled" || target.status === "failed") {
        continue;
      }
      target.writingTool = { ...writing, since: event.observedAt };
      attachedByOwner.set(target.ownerAgentId, target);
      const callId = toolWritingCallId(event);
      if (callId) callIdsByOwner.set(target.ownerAgentId, callId);
      else callIdsByOwner.delete(target.ownerAgentId);
      continue;
    }
    const attached = attachedByOwner.get(target.ownerAgentId);
    if (!attached?.writingTool) continue;
    if (event.eventType === "thinking.delta" || event.eventType === "thinking.final") {
      const startedAt =
        typeof event.metadata?.thinkingStartedAt === "string"
          ? event.metadata.thinkingStartedAt
          : event.observedAt;
      if (startedAt < attached.writingTool.since) continue;
    } else if (event.eventType !== "request.completed") {
      const tool = event.metadata?.tool;
      const status =
        tool && typeof tool === "object" && !Array.isArray(tool)
          ? (tool as Record<string, unknown>).status
          : undefined;
      if (
        event.eventType !== "tool.writing.completed" &&
        event.eventType !== "tool.started" &&
        event.eventType !== "tool.completed" &&
        event.eventType !== "tool.failed" &&
        status !== "started" &&
        status !== "completed" &&
        status !== "failed"
      )
        continue;
      const callId = toolWritingCallId(event);
      const writingCallId = callIdsByOwner.get(target.ownerAgentId);
      if (callId && writingCallId && callId !== writingCallId) continue;
    }
    if (event.observedAt < attached.writingTool.since) continue;
    delete attached.writingTool;
    attachedByOwner.delete(target.ownerAgentId);
    callIdsByOwner.delete(target.ownerAgentId);
  }
}

function toolWritingCallId(event: ThreadRunEvent): string | undefined {
  const tool = event.metadata?.tool;
  const toolUseId =
    tool && typeof tool === "object" && !Array.isArray(tool)
      ? (tool as Record<string, unknown>).toolUseId
      : undefined;
  const callId = event.metadata?.toolCallId ?? toolUseId ?? event.streamKey;
  return typeof callId === "string" && callId.trim() ? callId.trim() : undefined;
}

const ACTIVE_THREAD_STATUSES = new Set(["running", "queued"]);

/**
 * The `tool.writing` fact carries what is known about the call in `metadata.toolWriting`. Rows
 * written before the fact was refined carry only the tool name in their message, so they are
 * still read — the Feed shows the tier that fact supports rather than nothing.
 */
function resolveToolWritingActivity(event: ThreadRunEvent): ToolWritingActivity | undefined {
  const metadata = event.metadata?.toolWriting;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const record = metadata as Record<string, unknown>;
    const kind = record.kind;
    const activity: ToolWritingActivity = {
      ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}),
      ...(isToolWriteKind(kind) ? { kind } : {}),
      ...(typeof record.target === "string" && record.target.trim() ? { target: record.target.trim() } : {}),
    };
    if (activity.name || activity.kind || activity.target) {
      return activity;
    }
  }
  const name = event.message.trim();
  return name ? { name } : undefined;
}

function isToolWriteKind(value: unknown): value is "file" | "read" | "command" | "tool" {
  return value === "file" || value === "read" || value === "command" || value === "tool";
}

/** The latest request of this agent that had already started when `at` was observed. */
function latestSpanStartedBy(
  orderedSpans: readonly MutableRequestSpan[],
  at: string,
  runAttemptId?: string,
): MutableRequestSpan | undefined {
  let found: MutableRequestSpan | undefined;
  for (const span of orderedSpans) {
    if (span.startedAt > at) {
      break;
    }
    if (runAttemptId && span.runAttemptId && span.runAttemptId !== runAttemptId) {
      continue;
    }
    found = span;
  }
  return found;
}

/** Keep an empty thinking start as request state, never as an unfinished V2 message. */
function applyPendingThinkingState(
  spans: ReadonlyMap<string, MutableRequestSpan>,
  events: readonly ThreadRunEvent[],
  threadStatus: string,
): void {
  if (!ACTIVE_THREAD_STATUSES.has(threadStatus)) return;
  const pending = new Set<MutableRequestSpan>();
  const clear = (span: MutableRequestSpan): void => {
    delete span.pendingThinkingSince;
    delete span.pendingThinkingMessageId;
    pending.delete(span);
  };
  for (const event of events) {
    const target = event.requestId ? spans.get(event.requestId) : undefined;
    if (event.eventType === "request.started" && target) {
      for (const span of pending) {
        if (span !== target && span.ownerAgentId === target.ownerAgentId) clear(span);
      }
    }
    if (
      event.eventType === "thinking.delta" &&
      !event.message.trim() &&
      (event.streamState === "placeholder" || event.streamState === "streaming")
    ) {
      if (!target || target.status === "cancelled" || target.status === "failed") continue;
      for (const span of pending) {
        if (span !== target && span.ownerAgentId === target.ownerAgentId) clear(span);
      }
      target.pendingThinkingSince =
        typeof event.metadata?.thinkingStartedAt === "string"
          ? event.metadata.thinkingStartedAt
          : event.observedAt;
      pending.add(target);
      target.pendingThinkingMessageId = legacyMessageId(event);
      continue;
    }
    if (
      event.eventType.startsWith("tool.") ||
      event.eventType === "message.delta" ||
      event.eventType === "message.final" ||
      event.eventType === "thinking.delta" ||
      event.eventType === "thinking.final" ||
      event.eventType === "request.completed" ||
      event.eventType === "request.failed" ||
      event.eventType === "request.cancelled" ||
      event.eventType === "api.error"
    ) {
      if (target) {
        clear(target);
      } else if (event.eventType.startsWith("tool.")) {
        // Tools have no request id; their explicit agent ownership ends only that agent's wait.
        for (const span of pending) {
          if (span.ownerAgentId === event.agentId) clear(span);
        }
      }
    }
  }
}

function buildRequestSpans(
  events: readonly ThreadRunEvent[],
  threadStatus: string,
  diagnostics: ThreadRunProjectionDiagnostic[],
  agents: readonly AgentInstanceRecord[] = [],
  historyComplete = true,
): ThreadRunProjectionRequestSpan[] {
  const spans = new Map<string, MutableRequestSpan>();
  const seenStreamingKeys = new Set<string>();

  for (const event of events) {
    const requestId = resolveProjectionRequestId(event);
    if (!requestId) {
      continue;
    }
    const span = spans.get(requestId) ?? createRequestSpan(event, requestId);
    spans.set(requestId, span);
    applyEventToRequestSpan(span, event, diagnostics, seenStreamingKeys, historyComplete);
  }

  applyToolWritingState(spans, events, threadStatus, agents);
  applyPendingThinkingState(spans, events, threadStatus);

  closeRequestSpansForTerminalAgents(spans, agents);

  const terminalThread = ["completed", "failed", "blocked", "idle", "awaiting_plan"].includes(threadStatus);
  const terminalAt = events[events.length - 1]?.observedAt;
  const output: ThreadRunProjectionRequestSpan[] = [];
  for (const span of spans.values()) {
    if (
      historyComplete &&
      terminalThread &&
      (span.status === "waiting_first_token" || span.status === "streaming")
    ) {
      diagnostics.push({
        code: "request_span_left_open",
        message: `Request span ${span.requestId} is still open after terminal thread status ${threadStatus}.`,
        requestId: span.requestId,
      });
      closeRequestSpanForTerminalThread(span, threadStatus, terminalAt);
    }
    output.push({
      requestId: span.requestId,
      status: span.status,
      startedAt: span.startedAt,
      ...(span.ownerAgentId && { ownerAgentId: span.ownerAgentId }),
      ...(span.role && { role: span.role }),
      ...(span.source && { source: span.source }),
      ...(span.firstTokenAt && { firstTokenAt: span.firstTokenAt }),
      ...(span.endedAt && { endedAt: span.endedAt }),
      ...(span.error && { error: span.error }),
      ...(span.providerRequestId && { providerRequestId: span.providerRequestId }),
      ...(span.writingTool && { writingTool: span.writingTool }),
      ...(span.pendingThinkingSince && { pendingThinkingSince: span.pendingThinkingSince }),
      ...(span.pendingThinkingMessageId && { pendingThinkingMessageId: span.pendingThinkingMessageId }),
    });
  }
  return output.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/** Rebuild request spans from persisted events (feed skeleton hydration). */
export function buildThreadRunProjectionRequestSpans(input: {
  events: readonly ThreadRunEvent[];
  threadStatus: string;
  agents?: readonly AgentInstanceRecord[];
  historyComplete?: boolean;
}): ThreadRunProjectionRequestSpan[] {
  const diagnostics: ThreadRunProjectionDiagnostic[] = [];
  return buildRequestSpans(
    input.events,
    input.threadStatus,
    diagnostics,
    input.agents ?? [],
    input.historyComplete ?? true,
  );
}

function closeRequestSpansForTerminalAgents(
  spans: ReadonlyMap<string, MutableRequestSpan>,
  agents: readonly AgentInstanceRecord[],
): void {
  for (const agent of agents) {
    if (agent.status === "active" || agent.status === "launching") {
      continue;
    }
    for (const span of spans.values()) {
      if (span.ownerAgentId !== agent.agentId) continue;
      // Completed narrative streams may still carry a tool call being written.
      delete span.writingTool;
      delete span.pendingThinkingSince;
      delete span.pendingThinkingMessageId;
      if (!isOpenRequestSpan(span)) continue;
      if (agent.status === "abandoned") {
        span.status = "cancelled";
      } else {
        span.status = "completed";
      }
      span.endedAt = span.endedAt ?? agent.endedAt ?? agent.updatedAt;
    }
  }
}

function isOpenRequestSpan(span: MutableRequestSpan): boolean {
  return span.status === "waiting_first_token" || span.status === "streaming";
}

function closeRequestSpanForTerminalThread(
  span: MutableRequestSpan,
  threadStatus: string,
  terminalAt: string | undefined,
): void {
  // Once the request is over nothing is being written, so the wait label must not outlive it.
  delete span.writingTool;
  delete span.pendingThinkingSince;
  delete span.pendingThinkingMessageId;
  if (threadStatus === "failed" || threadStatus === "blocked") {
    span.status = "failed";
    span.error = span.error ?? `Thread ended with status ${threadStatus}.`;
  } else if (threadStatus === "cancelled") {
    span.status = "cancelled";
  } else {
    span.status = "completed";
  }
  span.endedAt = span.endedAt ?? terminalAt ?? span.startedAt;
}

function resolveProjectionRequestId(event: ThreadRunEvent): string | undefined {
  const requestId = event.requestId?.trim();
  return requestId || undefined;
}

function readProviderRequestId(event: ThreadRunEvent): string | undefined {
  const value = event.metadata?.providerRequestId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function createRequestSpan(event: ThreadRunEvent, requestId: string): MutableRequestSpan {
  return {
    requestId,
    ...(event.runAttemptId && { runAttemptId: event.runAttemptId }),
    ...(event.agentId && { ownerAgentId: event.agentId }),
    ...(event.role && { role: event.role }),
    ...(typeof event.metadata?.source === "string" && { source: event.metadata.source }),
    status: "waiting_first_token",
    startedAt: event.observedAt,
    sawStreamStart: false,
  };
}

function isNarrativeMessageStreamEvent(event: ThreadRunEvent): boolean {
  if (event.eventType !== "message.delta" && event.eventType !== "message.final") {
    return false;
  }
  const role = event.role;
  return role !== "user" && role !== "tool" && role !== "thinking" && role !== "system";
}

/** Decode timing (TTFT / tok/s) follows visible narrative message stream — not thinking or tools. */
function applyNarrativeMessageStreamTiming(
  span: MutableRequestSpan,
  event: ThreadRunEvent,
  seenStreamingKeys: Set<string>,
): void {
  if (event.streamState === "placeholder") {
    return;
  }
  const isFinal =
    event.eventType === "message.final" ||
    (event.eventType === "message.delta" && event.streamState === "finalized");

  if (!isFinal) {
    span.status = "streaming";
    if (!span.firstTokenAt) {
      span.firstTokenAt = event.observedAt;
    }
    span.sawStreamStart = true;
    seenStreamingKeys.add(span.requestId);
    return;
  }

  if (!span.firstTokenAt) {
    span.firstTokenAt = event.observedAt;
  }
  span.endedAt = event.observedAt;
  span.status = "completed";
  span.sawStreamStart = true;
  seenStreamingKeys.add(span.requestId);
}

function applyEventToRequestSpan(
  span: MutableRequestSpan,
  event: ThreadRunEvent,
  diagnostics: ThreadRunProjectionDiagnostic[],
  seenStreamingKeys: Set<string>,
  historyComplete: boolean,
): void {
  if (!span.runAttemptId && event.runAttemptId) {
    span.runAttemptId = event.runAttemptId;
  }
  if (!span.ownerAgentId && event.agentId) {
    span.ownerAgentId = event.agentId;
  }
  if (!span.role && event.role) {
    span.role = event.role;
  }
  const providerRequestId = readProviderRequestId(event);
  if (providerRequestId) {
    span.providerRequestId = providerRequestId;
  }

  if (event.eventType === "request.started") {
    if (
      span.status === "streaming" ||
      span.status === "completed" ||
      span.status === "failed" ||
      span.status === "cancelled"
    ) {
      return;
    }
    // Bridge request.started is the authority for TTFT — do not inherit a later delta timestamp.
    span.startedAt = event.observedAt;
    span.status = "waiting_first_token";
    span.sawStreamStart = true;
  }
  if (event.streamState === "placeholder") {
    span.status = "waiting_first_token";
    span.sawStreamStart = true;
    seenStreamingKeys.add(span.requestId);
  }
  if (isNarrativeMessageStreamEvent(event)) {
    applyNarrativeMessageStreamTiming(span, event, seenStreamingKeys);
  } else if (event.streamState === "streaming") {
    // thinking.delta and other non-message streams must not anchor decode timing.
    span.sawStreamStart = true;
    seenStreamingKeys.add(span.requestId);
  } else if (event.streamState === "finalized") {
    if (historyComplete && !span.sawStreamStart && !seenStreamingKeys.has(span.requestId)) {
      diagnostics.push({
        code: "orphan_stream_finalize",
        message: `Stream finalized without a prior stream start for ${span.requestId}.`,
        eventId: event.id,
        requestId: span.requestId,
      });
    }
  }
  if (event.eventType === "request.completed") {
    span.status = "completed";
    if (!span.endedAt) {
      span.endedAt = event.observedAt;
    }
  }
  if (event.eventType === "request.cancelled") {
    span.status = "cancelled";
    span.endedAt = event.observedAt;
  }
  if (event.eventType === "request.failed" || event.eventType === "api.error") {
    span.status = "failed";
    span.endedAt = event.observedAt;
    span.error = resolveErrorMessage(event);
  }
}

function resolveErrorMessage(event: ThreadRunEvent): string {
  const apiError = event.metadata?.apiError;
  if (apiError && typeof apiError === "object" && "message" in apiError) {
    const message = (apiError as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return event.message;
}

function resolveAgentDelegationFromEvents(
  events: readonly ThreadRunEvent[],
  agentId: string,
): { delegationSummary?: string; delegationPrompt?: string } {
  let delegationSummary: string | undefined;
  let delegationPrompt: string | undefined;
  for (const event of events) {
    if (event.eventType !== "agent.started" || event.agentId !== agentId) {
      continue;
    }
    const metadata = event.metadata;
    const summary = typeof metadata?.delegationSummary === "string" ? metadata.delegationSummary.trim() : "";
    const prompt = typeof metadata?.delegationPrompt === "string" ? metadata.delegationPrompt.trim() : "";
    if (summary) {
      delegationSummary = summary;
    }
    if (prompt) {
      delegationPrompt = prompt;
    }
  }
  return {
    ...(delegationSummary && { delegationSummary }),
    ...(delegationPrompt && { delegationPrompt }),
  };
}

function resolveAgentCardIdentityFromEvents(
  events: readonly ThreadRunEvent[],
  agentId: string,
): { taskName?: string; nickname?: string } {
  let taskName: string | undefined;
  let nickname: string | undefined;
  for (const event of events) {
    if (event.eventType !== "agent.started" || event.agentId !== agentId) {
      continue;
    }
    const metadata = event.metadata;
    const nick =
      typeof metadata?.agentNickname === "string"
        ? metadata.agentNickname.trim()
        : typeof metadata?.nickname === "string"
          ? metadata.nickname.trim()
          : "";
    if (nick) {
      nickname = nick;
    }
    let nextTaskName = typeof metadata?.taskName === "string" ? metadata.taskName.trim() : "";
    if (!nextTaskName && typeof metadata?.agentPath === "string") {
      nextTaskName = taskNameFromAgentPathMetadata(metadata.agentPath) ?? "";
    }
    if (nextTaskName) {
      taskName = nextTaskName;
    }
  }
  return {
    ...(taskName && { taskName }),
    ...(nickname && { nickname }),
  };
}

function taskNameFromAgentPathMetadata(agentPath: string): string | undefined {
  const segments = agentPath
    .trim()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last || last === "root") {
    return undefined;
  }
  return last;
}
