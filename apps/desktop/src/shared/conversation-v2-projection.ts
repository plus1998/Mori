import { isMainAgentId, type ToolWriteKind } from "@eco/shared";
import type { ThreadRunEventScope, ThreadRunEventType } from "./thread-run-events";

export type ThreadRunProjectionAgentKind = "main" | "subagent";

export type ThreadRunProjectionAgentStatus = "launching" | "active" | "stopped" | "abandoned";

export type ThreadRunProjectionAttemptStatus = "running" | "completed" | "failed" | "cancelled";

export type ThreadRunProjectionRequestStatus =
  | "waiting_first_token"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export type ThreadRunProjectionDiagnosticCode =
  | "missing_agent_id"
  | "ambiguous_subagent_role"
  | "orphan_stream_finalize"
  | "negative_duration"
  | "request_span_left_open";

export interface ThreadRunProjectionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  ecoCostUsd: number;
  modelId?: string;
}

export interface ThreadRunProjectionContext {
  occupied: number;
  limit: number;
  occupancyPct: number;
  modelId?: string;
}

export interface ThreadRunProjectionTimelineItem {
  id: string;
  /** Timeline order and incremental sync version; newer versions replace the same id on clients. */
  sequence: number;
  eventType: ThreadRunEventType;
  scope: ThreadRunEventScope;
  role?: string;
  agentId?: string;
  runAttemptId?: string;
  requestId?: string;
  streamKey?: string;
  text: string;
  /** Short text used by skeleton Feed rows when full content is deferred. */
  summary?: string;
  /** True when `text` contains the complete content rather than a skeleton preview. */
  contentLoaded?: boolean;
  /** True when a detail request can retrieve complete content for this item. */
  contentAvailable?: boolean;
  at: string;
  metadata?: Record<string, unknown>;
}

export interface ThreadRunProjectionAttempt {
  attemptId: string;
  phase: string;
  retryIndex: number;
  status: ThreadRunProjectionAttemptStatus;
  startedAt: string;
  endedAt?: string;
}

export interface ThreadRunProjectionAgent {
  agentId: string;
  role: string;
  kind: ThreadRunProjectionAgentKind;
  status: ThreadRunProjectionAgentStatus;
  startedAt: string;
  durationMs: number;
  runAttemptId?: string;
  parentAgentId?: string;
  parentToolUseId?: string;
  mission?: string;
  delegationSummary?: string;
  delegationPrompt?: string;
  /** Codex spawn `task_name` / agentPath label when present. */
  taskName?: string;
  /** Codex child-thread `agentNickname` when present. */
  nickname?: string;
  todoId?: string;
  endedAt?: string;
  latestActivity?: string;
  usage?: ThreadRunProjectionUsage;
  context?: ThreadRunProjectionContext;
  timeline: ThreadRunProjectionTimelineItem[];
}

/**
 * What the model is writing, as carried by the `tool.writing` fact.
 *
 * Refined in tiers, so the Feed never has to fall back to "something is happening": the target
 * (file or command line) once the arguments name it, the kind while they still have not, and
 * nothing at all for the provider-side items that name neither.
 */
export interface ToolWritingActivity {
  /** Tool name as the core reports it; absent when the call does not name itself. */
  name?: string;
  kind?: ToolWriteKind;
  /** File path or command line, once the arguments have revealed it. */
  target?: string;
}

export interface ThreadRunProjectionWritingTool extends ToolWritingActivity {
  /** observedAt of the `tool.writing` fact — lets the UI show the wait as bounded. */
  since: string;
  /** Arguments have finished; the matching tool has not started yet. */
  phase?: "dispatching";
}

export interface ThreadRunProjectionRequestSpan {
  requestId: string;
  ownerAgentId?: string;
  role?: string;
  source?: string;
  status: ThreadRunProjectionRequestStatus;
  startedAt: string;
  /** First assistant message.delta observedAt — live waiting/TTFT display only. */
  firstTokenAt?: string;
  endedAt?: string;
  error?: string;
  /**
   * Upstream / gateway request id when known. Used to join ledger usage that
   * keys off `providerRequestId` rather than the Eco logical `requestId`.
   */
  providerRequestId?: string;
  /**
   * Tool call being prepared or dispatched on this request. Set from a
   * `tool.writing` fact and cleared the moment the real tool row starts, so the Feed
   * can name the wait instead of reading an unmoving timeline as "stalled".
   */
  writingTool?: ThreadRunProjectionWritingTool;
  /** Native thinking block started, but has not produced visible content yet. */
  pendingThinkingSince?: string;
  /** Exact V2 message identity that will replace the empty thinking start. */
  pendingThinkingMessageId?: string;
  /**
   * Provider-reported completion tokens for this request when ledger usage can
   * be joined. Absent for cores that never emit usage (e.g. Cursor ACP).
   */
  outputTokens?: number;
  /** Subset of {@link outputTokens} billed as reasoning/thinking, when provider reports it. */
  reasoningTokens?: number;
  /**
   * Gateway-measured time to first upstream response chunk (ms), summed across
   * matched ledger invocations for the turn (new-api TTFT).
   */
  ttftMs?: number;
  /**
   * Gateway-measured first-chunk → stream-end window (ms), summed across matched
   * ledger invocations — tok/s denominator (new-api generationMs).
   */
  generationMs?: number;
  /** Gateway-measured network RTT estimate (ms): upstream start → first headers. */
  firstHeadersMs?: number;
  /** Gateway-measured time to first text token delta (ms): upstream start → first content token. */
  firstTokenMs?: number;
  /** Provider input tokens (non-cache) joined from ledger usage, when available. */
  inputTokens?: number;
  /** Provider cache-read tokens joined from ledger usage, when available. */
  cacheReadTokens?: number;
}

export interface ThreadRunProjectionDiagnostic {
  code: ThreadRunProjectionDiagnosticCode;
  message: string;
  eventId?: string;
  agentId?: string;
  requestId?: string;
}

export interface ThreadRunProjectionSnapshot {
  thread: {
    threadId: string;
    status: string;
    generatedAt: string;
    message?: string;
    currentAttemptId?: string;
  };
  attempts: ThreadRunProjectionAttempt[];
  agents: ThreadRunProjectionAgent[];
  requestSpans: ThreadRunProjectionRequestSpan[];
  timeline: ThreadRunProjectionTimelineItem[];
  diagnostics: ThreadRunProjectionDiagnostic[];
  sourceEventCount: number;
  /** @deprecated Feed is a full skeleton; older history is no longer paged on the main list. */
  hasEarlier?: boolean;
  /** Increments when the conversation history is intentionally rewound. */
  historyRevision?: number;
  /** Hydration extras from main/demo; optional on bare wire snapshots. */
  billing?: import("./ipc").ThreadBillingSnapshot;
  context?: import("./ipc").ThreadContextSnapshot;
  subagentTimings?: readonly import("./ipc").ThreadSubagentSessionTiming[];
  subagentMetrics?: readonly import("./ipc").ThreadSubagentMetricsSummary[];
}

export type ThreadRunProjectionDetailKind = "agent" | "tool" | "main" | "turn";

export interface ThreadRunProjectionDetailRequest {
  threadId: string;
  kind: ThreadRunProjectionDetailKind;
  key: string;
  afterSequence?: number;
  beforeSequence?: number;
  /** Return the newest page when no forward cursor is supplied. */
  tail?: boolean;
  limit?: number;
}

export interface ThreadRunProjectionDetailResult {
  threadId: string;
  kind: ThreadRunProjectionDetailKind;
  key: string;
  generatedAt: string;
  timeline: ThreadRunProjectionTimelineItem[];
  sourceEventCount: number;
  agent?: ThreadRunProjectionAgent;
  hasMore: boolean;
  nextAfterSequence?: number;
  hasEarlier?: boolean;
  previousBeforeSequence?: number;
}

export function isPlannerProjectionAgentId(agentId: string): boolean {
  return isMainAgentId(agentId);
}

/** Resolve agent metadata when detail merge mints a row missing from the feed skeleton. */
export function resolveProjectionDetailMergedAgent(
  agentId: string,
  detail: Pick<ThreadRunProjectionDetailResult, "agent">,
  incoming: readonly ThreadRunProjectionTimelineItem[],
): Pick<ThreadRunProjectionAgent, "role" | "kind" | "status" | "startedAt" | "durationMs"> {
  if (detail.agent?.agentId === agentId) {
    return {
      role: detail.agent.role,
      kind: detail.agent.kind,
      status: detail.agent.status,
      startedAt: detail.agent.startedAt,
      durationMs: detail.agent.durationMs ?? 0,
    };
  }
  if (isPlannerProjectionAgentId(agentId)) {
    return {
      role: "main",
      kind: "main",
      status: "stopped",
      startedAt: incoming[0]?.at ?? "",
      durationMs: 0,
    };
  }
  return {
    role: detail.agent?.role ?? "coder",
    kind: "subagent",
    status: detail.agent?.status ?? "stopped",
    startedAt: detail.agent?.startedAt ?? incoming[0]?.at ?? "",
    durationMs: detail.agent?.durationMs ?? 0,
  };
}
