import { formatSubagentMissionMessage, parseSubagentMissionMessage } from "@eco/runtime";
import type {
  ThreadApiErrorInfo,
  ThreadRunBashApprovalMetadata,
  ThreadRunEventInput,
  ThreadRunEventScope,
  ThreadRunEventStreamState,
  ThreadRunEventType,
  ThreadRunToolMetadata,
} from "../shared/ipc";
import { SUBAGENT_ROLES } from "../shared/ipc";
import {
  isThreadFollowUpActivityMessage,
  isThreadFollowUpLiveEvent,
} from "../shared/thread-follow-up-events";
import { projectThreadRunToolMetadata } from "../shared/thread-run-tool-projection";

const subagentRoleSet = new Set<string>(SUBAGENT_ROLES);

/** Live events that update billing/context UI but are not narrative run timeline. */
const METRICS_ONLY_THREAD_LIVE_TYPES = new Set([
  "thread.usage_updated",
  "thread.context_updated",
  "thread.subagent_timing_updated",
  "thread.todos_updated",
  "thread.title_updated",
  "thread.title_delta",
  "thread.title_failed",
  "thread.title_generating",
  "thread.session_captured",
  "thread.unstarted_turn_discarded",
]);

/** Thread summary transitions. Keep the live event for UI state; never put them in the feed. */
const THREAD_STATUS_LIVE_TYPES_OMITTED_FROM_FEED = new Set([
  "thread.started",
  "thread.completed",
  "thread.follow_up_queue_paused",
  "thread.follow_up_queue_resumed",
]);

export function isMetricsOnlyThreadLiveEvent(liveType: string): boolean {
  return METRICS_ONLY_THREAD_LIVE_TYPES.has(liveType);
}

/**
 * Live events that must be persisted for projection state but never become a Feed row.
 * `tool.writing` is a fact about the current request (the model is writing a tool call),
 * not a row: the tool card itself appears when its arguments are complete.
 */
const PROJECTION_ONLY_THREAD_LIVE_TYPES = new Set(["tool.writing"]);

/** Status live types that skip run-event persist (still need feed projection refresh). */
export function isThreadStatusLiveTypeOmittedFromFeed(liveType: string): boolean {
  return THREAD_STATUS_LIVE_TYPES_OMITTED_FROM_FEED.has(liveType);
}

/**
 * Live events whose payload is metadata rather than a sentence. They are recorded — their
 * metadata is the point — but they never become a Feed row, and they never need a message
 * standing in for content they do not have.
 */
export function isMetadataOnlyThreadLiveEvent(liveType: string): boolean {
  return METRICS_ONLY_THREAD_LIVE_TYPES.has(liveType) || PROJECTION_ONLY_THREAD_LIVE_TYPES.has(liveType);
}

export function isMetricsOnlyThreadRunEvent(event: { metadata?: Record<string, unknown> }): boolean {
  const liveType = event.metadata?.liveType;
  if (typeof liveType !== "string") {
    return false;
  }
  return isMetadataOnlyThreadLiveEvent(liveType);
}

export interface BuildThreadRunEventFromLiveInput {
  threadId: string;
  eventId: string;
  liveType: string;
  message: string;
  role: string;
  stream: boolean;
  observedAt: string;
  runAttemptId?: string;
  agentId?: string;
  parentToolUseId?: string;
  requestId?: string;
  streamKey?: string;
  apiError?: ThreadApiErrorInfo;
  tool?: ThreadRunToolMetadata;
  bashApproval?: ThreadRunBashApprovalMetadata;
  metadata?: Record<string, unknown>;
}

export interface BuildSubagentLifecycleRunEventInput {
  threadId: string;
  agentId: string;
  role: string;
  lifecycle: "started" | "stopped" | "abandoned";
  observedAt: string;
  runAttemptId?: string;
  parentAgentId?: string;
  parentToolUseId?: string;
  missionKey?: string;
  todoId?: string;
  delegationPrompt?: string;
  delegationSummary?: string;
}

export function buildThreadRunEventFromLiveEvent(
  input: BuildThreadRunEventFromLiveInput,
): ThreadRunEventInput | undefined {
  if (
    isMetricsOnlyThreadLiveEvent(input.liveType) ||
    isThreadFollowUpLiveEvent(input.liveType) ||
    THREAD_STATUS_LIVE_TYPES_OMITTED_FROM_FEED.has(input.liveType)
  ) {
    return undefined;
  }
  if (
    input.liveType.startsWith("thread.") &&
    input.liveType !== "thread.retry" &&
    input.liveType !== "thread.api_error" &&
    input.liveType !== "thread.user_prompt" &&
    isThreadFollowUpActivityMessage(input.message)
  ) {
    return undefined;
  }
  const eventType = resolveThreadRunEventType(input);
  if (!eventType) {
    return undefined;
  }
  const scope = resolveThreadRunEventScope({
    eventType,
    role: input.role,
    message: input.message,
    ...(input.agentId && { agentId: input.agentId }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
    ...(input.tool && { tool: input.tool }),
  });
  const streamState = resolveThreadRunEventStreamState(input);
  const requestId = input.requestId?.trim() || undefined;
  const streamRequestKey = requestId ?? input.runAttemptId?.trim() ?? "thread";
  const id =
    input.streamKey && (eventType === "message.delta" || eventType === "thinking.delta")
      ? `tre:stream:${input.threadId}:${streamRequestKey}:${eventType}:${input.streamKey}`
      : `tre:${input.eventId}`;

  return {
    id,
    threadId: input.threadId,
    eventType,
    scope,
    role: input.role,
    streamState,
    message: input.message,
    observedAt: input.observedAt,
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.agentId && { agentId: input.agentId }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
    ...(requestId && { requestId }),
    ...(input.streamKey && { streamKey: input.streamKey }),
    metadata: enrichThinkingTimingMetadata(buildLiveEventMetadata(input), eventType, input.observedAt),
  };
}

export function buildSubagentLifecycleRunEvent(
  input: BuildSubagentLifecycleRunEventInput,
): ThreadRunEventInput {
  const eventType = `agent.${input.lifecycle}` as ThreadRunEventType;
  return {
    id: `tre:${input.threadId}:agent:${input.agentId}:${input.lifecycle}`,
    threadId: input.threadId,
    eventType,
    scope: "agent",
    role: input.role,
    agentId: input.agentId,
    streamState: "none",
    message: `Subagent ${input.role} ${input.lifecycle}`,
    observedAt: input.observedAt,
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.parentAgentId && { parentAgentId: input.parentAgentId }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
    metadata: {
      lifecycle: input.lifecycle,
      ...(input.missionKey && { missionKey: input.missionKey }),
      ...(input.todoId && { todoId: input.todoId }),
      ...(input.delegationPrompt && { delegationPrompt: input.delegationPrompt }),
      ...(input.delegationSummary && { delegationSummary: input.delegationSummary }),
    },
  };
}

export interface BuildSubagentMissionAttributedRunEventInput {
  threadId: string;
  agentId: string;
  role: string;
  prompt: string;
  observedAt: string;
  runAttemptId?: string;
  parentToolUseId?: string;
}

export function buildSubagentMissionAttributedRunEvent(
  input: BuildSubagentMissionAttributedRunEventInput,
): ThreadRunEventInput {
  return {
    id: `tre:${input.threadId}:agent:${input.agentId}:mission`,
    threadId: input.threadId,
    eventType: "message.final",
    scope: "agent",
    role: input.role,
    agentId: input.agentId,
    streamState: "none",
    message: formatSubagentMissionMessage(input.role, input.prompt, { agentId: input.agentId }),
    observedAt: input.observedAt,
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
  };
}

function resolveThreadRunEventType(input: BuildThreadRunEventFromLiveInput): ThreadRunEventType | undefined {
  if (isSdkNoticeLiveType(input.liveType)) return "diagnostic";
  if (input.apiError || input.liveType === "thread.api_error") {
    return "api.error";
  }
  if (input.liveType === "tool.writing") {
    return "tool.writing";
  }
  if (input.liveType === "tool.started") {
    return "tool.started";
  }
  if (input.liveType === "tool.completed") {
    return "tool.completed";
  }
  if (input.liveType === "tool.failed") {
    return "tool.failed";
  }
  if (input.liveType === "request.started") {
    return "request.started";
  }
  if (input.liveType === "request.completed") {
    return "request.completed";
  }
  if (input.liveType === "request.failed") {
    return "request.failed";
  }
  if (input.liveType === "request.cancelled") {
    return "request.cancelled";
  }
  if (input.liveType === "request.retry_scheduled") {
    return "request.retry_scheduled";
  }
  if (input.liveType === "agent.started") {
    return "agent.started";
  }
  if (input.liveType === "message.delta") {
    if (input.role === "thinking") {
      return input.stream ? "thinking.delta" : "thinking.final";
    }
    return input.stream ? "message.delta" : "message.final";
  }
  if (input.liveType === "todo.updated") {
    if (input.tool) {
      return "tool.started";
    }
    return "thread.status";
  }
  if (input.liveType.startsWith("thread.")) {
    return "thread.status";
  }
  return input.stream ? "message.delta" : "message.final";
}

/** Protocol notices are system content, never assistant answers or agent lifecycle. */
export function isSdkNoticeLiveType(liveType: string): boolean {
  return (
    liveType === "sdk.notice" ||
    liveType === "sdk.session_state" ||
    liveType === "sdk.conversation_reset" ||
    liveType === "sdk.commands_changed" ||
    liveType === "request.rate_limit" ||
    liveType === "billing.warning"
  );
}

function resolveThreadRunEventScope(input: {
  eventType: ThreadRunEventType;
  role: string;
  agentId?: string;
  parentToolUseId?: string;
  message?: string;
  tool?: ThreadRunToolMetadata;
}): ThreadRunEventScope {
  if (input.eventType === "api.error" && input.agentId) {
    return "both";
  }
  if (isPlannerSubagentDelegationEvent(input)) {
    return "main";
  }
  if (input.agentId || input.parentToolUseId) {
    return "agent";
  }
  if (subagentRoleSet.has(input.role)) {
    return "agent";
  }
  return "main";
}

function isPlannerSubagentDelegationEvent(input: {
  eventType: ThreadRunEventType;
  agentId?: string;
  message?: string;
  tool?: ThreadRunToolMetadata;
}): boolean {
  if (input.eventType !== "tool.started") {
    return false;
  }
  const toolName = input.tool?.name.trim();
  // ACP stamps the Cursor session id on Agent/Task spawns; still treat as main-feed
  // delegation so Feed gets subagent styling (Cards come from agent.started separately).
  if (toolName === "Agent" || toolName === "Task") {
    return true;
  }
  if (input.agentId) {
    return false;
  }
  if (parseSubagentMissionMessage(input.message ?? "")) {
    return true;
  }
  return false;
}

function resolveThreadRunEventStreamState(
  input: BuildThreadRunEventFromLiveInput,
): ThreadRunEventStreamState {
  if (!input.stream) {
    if (input.liveType === "message.delta") {
      return "finalized";
    }
    return "none";
  }
  return input.message.trim() ? "streaming" : "placeholder";
}

function buildLiveEventMetadata(input: BuildThreadRunEventFromLiveInput): Record<string, unknown> {
  const tool = projectThreadRunToolMetadata(input.tool);
  const bashApproval = input.bashApproval
    ? normalizeThreadRunBashApprovalMetadata(input.bashApproval)
    : undefined;
  return {
    ...(input.metadata ?? {}),
    liveType: input.liveType,
    ...(input.apiError && { apiError: input.apiError }),
    ...(tool && { tool }),
    ...(bashApproval && { bashApproval }),
  };
}

/** Stamp thinking wall-clock start; never use request TTFT as thinking duration. */
function enrichThinkingTimingMetadata(
  metadata: Record<string, unknown>,
  eventType: ThreadRunEventType,
  observedAt: string,
): Record<string, unknown> {
  if (eventType !== "thinking.delta" && eventType !== "thinking.final") {
    return metadata;
  }
  const existingStarted =
    typeof metadata.thinkingStartedAt === "string" ? metadata.thinkingStartedAt.trim() : "";
  const thinkingStartedAt = existingStarted || observedAt;
  const next: Record<string, unknown> = {
    ...metadata,
    thinkingStartedAt,
  };
  if (eventType === "thinking.final") {
    const existingDuration = metadata.thinkingDurationMs;
    if (typeof existingDuration === "number" && Number.isFinite(existingDuration) && existingDuration >= 0) {
      return next;
    }
    const startedMs = Date.parse(thinkingStartedAt);
    const endedMs = Date.parse(observedAt);
    if (Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs) {
      next.thinkingDurationMs = endedMs - startedMs;
    }
  }
  return next;
}

function normalizeThreadRunBashApprovalMetadata(
  bashApproval: ThreadRunBashApprovalMetadata,
): ThreadRunBashApprovalMetadata | undefined {
  const toolUseId = bashApproval.toolUseId.trim();
  const toolName = bashApproval.toolName.trim();
  if (!toolUseId || !toolName) {
    return undefined;
  }
  return {
    toolUseId,
    phase: bashApproval.phase,
    toolName,
    ...(bashApproval.detail?.trim() && { detail: bashApproval.detail.trim() }),
    ...(bashApproval.description?.trim() && { description: bashApproval.description.trim() }),
  };
}
