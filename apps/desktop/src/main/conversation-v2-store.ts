import crypto from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  CONVERSATION_V2_DEFAULT_MAX_BYTES,
  CONVERSATION_V2_EFFECT_VERSION,
  CONVERSATION_V2_ERROR,
  CONVERSATION_V2_MAX_PAGE_SIZE,
  CONVERSATION_V2_MAX_SYNC_EVENTS,
  CONVERSATION_V2_PROTOCOL_VERSION,
  CONVERSATION_V2_SCHEMA_VERSION,
  type ConversationAgent,
  type ConversationBootstrap,
  type ConversationCapabilities,
  type ConversationDetailItem,
  type ConversationDetailsPage,
  type ConversationEffect,
  type ConversationEventInput,
  type ConversationEventRecord,
  type ConversationHead,
  type ConversationMessage,
  type ConversationMessageOrigin,
  type ConversationMessageHistoryTarget,
  type ConversationMessagesPage,
  type ConversationRun,
  type ConversationSendMessageResult,
  type ConversationSyncEffect,
  type ConversationSyncPage,
  type ConversationTodo,
  type ConversationToolCall,
  type ConversationToolsPage,
  type ConversationTurnSummary,
  ConversationV2Error,
  decodeConversationCursor,
  encodeConversationCursor,
  estimateConversationBytes,
  isConversationMessageOrigin,
  limitConversationToolSummaryPayload,
  stableHash,
  stableJson,
} from "@eco/shared";
import {
  type ContextCompactionTimingItem,
  resolveContextCompactionTiming,
} from "../shared/context-compaction-timing";
import { isContextCompactionEventType } from "../shared/thread-run-events";
import {
  type LegacyEventIdentityRow,
  legacyIdentityEventFromRow,
  legacyMessageId,
  legacyProviderRole,
  legacyToolCallId,
} from "./conversation-v2-legacy-identity";
import { conversationV2EventHash } from "./conversation-v2-event-integrity";
import { logEcoDiag } from "./eco-diag-log";
import { collectPromptImageContentRefs, isPromptImageContentRef } from "./prompt-image-file-store";

const META_KEY = "conversation_v2_store_epoch";
const STORAGE_MODE_KEY = "conversation_v2_storage_mode";

/**
 * Durable payloads that can hold a prompt-image `sha256:` reference, cheapest
 * first. `hasPromptImageContentRef` reads one owner's rows; the GC walks the
 * same sources without an owner filter.
 */
const PROMPT_IMAGE_REF_SOURCES = [
  ["conversation_command_receipts_v2", "result_json", "conversation_id"],
  ["conversation_command_checkpoints_v2", "payload_json", "conversation_id"],
  ["conversation_command_jobs_v2", "request_json", "conversation_id"],
  ["conversation_command_jobs_v2", "result_json", "conversation_id"],
  ["conversation_command_jobs_v2", "error_json", "conversation_id"],
  ["conversation_native_facts_v2", "payload_json", "conversation_id"],
  ["conversation_native_facts_v2", "attachment_summary_json", "conversation_id"],
  ["conversation_projection_snapshots_v2", "snapshot_json", "conversation_id"],
  ["conversation_followups_v2", "attachments_json", "thread_id"],
  ["conversation_messages_v2", "attachments_json", "conversation_id"],
  ["conversation_feed_skeletons_v2", "snapshot_json", "conversation_id"],
  ["conversation_feed_skeletons_v2", "auxiliary_json", "conversation_id"],
  ["conversation_provider_inputs_v2", "source_json", "conversation_id"],
  ["conversation_sync_effects_v2", "effect_json", "conversation_id"],
  ["conversation_events_v2", "payload_json", "conversation_id"],
] as const;

/** Rows per reference-scan window; each window yields before reading the next. */
const PROMPT_IMAGE_REF_SCAN_WINDOW_ROWS = 5_000;

export type ConversationV2StorageMode = "legacy_compat" | "v2_only";

const LEGACY_STORAGE_TABLES = [
  "thread_activity",
  "thread_coder_todos",
  "thread_pending_plans",
  "thread_run_events",
  "thread_user_messages",
  "thread_pending_followups",
  "thread_feed_skeleton",
  "thread_metrics_snapshots",
  "thread_agent_instances",
  "thread_subagent_sessions",
  "thread_subagent_metrics",
  "thread_run_attempts",
  "thread_usage_ledger_events",
] as const;

/**
 * Legacy event types that produce a message row, and the ones that produce a tool row.
 * The backfill only reads these, so it never asks the identity formulas to name a row
 * for an event that cannot have produced one.
 */
const LEGACY_MESSAGE_EVENT_TYPES = [
  "message.delta",
  "message.final",
  "thinking.delta",
  "thinking.final",
] as const;
const LEGACY_TOOL_EVENT_TYPES = ["tool.started", "tool.completed", "tool.failed"] as const;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const AGENT_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "abandoned",
  "stopped",
]);

function isGenericToolLabel(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "mcp: tool" || normalized === "mcp tool" || normalized === "tool";
}

function chooseToolName(existingName: string, incomingName: string): string {
  // Providers sometimes emit a placeholder label for the initial tool row and a concrete
  // label on the approval row. Prefer the concrete label, while preserving the first value
  // when both labels are equally specific so replay stays deterministic.
  if (isGenericToolLabel(existingName) && !isGenericToolLabel(incomingName)) return incomingName;
  return existingName;
}

const CONVERSATION_V2_EVENT_TYPES = new Set<ConversationEventInput["type"]>([
  "agent.created",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  "agent.interrupted",
  "message.accepted",
  "message.created",
  "message.delta",
  "message.replaced",
  "message.finalized",
  "message.history_targeted",
  "message.tombstoned",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "run.corrected",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "tool.failed",
  "detail.upserted",
  "approval.requested",
  "approval.resolved",
  "clarification.requested",
  "clarification.resolved",
  "todo.updated",
  "history.edited",
  "history.deleted",
  "history.branch_created",
  "history.regenerated",
  "run.input_appended",
  "noop",
]);
const CONVERSATION_V2_EFFECT_TYPES = new Set<ConversationEffect["type"]>([
  "message.create",
  "message.append",
  "message.replace",
  "message.finalize",
  "message.tombstone",
  "message.history_target",
  "run.upsert",
  "tool.summary.upsert",
  "agent.upsert",
  "todo.list.replace",
  "detail.upsert",
  "detail.invalidation",
  "history.invalidation",
  "noop",
]);
const CONVERSATION_COMMAND_JOB_TYPES = new Set<ConversationCommandJobType>([
  "history.rewrite",
  "history.retry",
  "history.delete",
  "history.branch",
  "history.regenerate",
  "approval.resolve",
  "clarification.resolve",
  "plan.resolve",
  "todo.update",
  "run.cancel",
  "followup.mutate",
  "runtime-config.mutate",
]);

export interface ConversationV2StoreOptions {
  now?: () => string;
  idFactory?: () => string;
}

export interface ConversationAppendResult {
  event: ConversationEventRecord;
  effect: ConversationSyncEffect;
  duplicate: boolean;
}

export interface ConversationSendMessageInput {
  principalId: string;
  conversationId: string;
  clientCommandId: string;
  text: string;
  origin?: ConversationMessageOrigin;
  turnId?: string;
  messageId?: string;
  attachments?: unknown[];
}

/**
 * Audited repair of a run that was already written with an incorrect terminal
 * outcome or timing boundary. The expected status is a compare-and-swap guard;
 * a stale operator command must fail instead of overwriting a newer lifecycle
 * observation. The correction itself is an append-only `run.corrected` event,
 * never a direct read-model update.
 */
export interface ConversationRunCorrectionInput {
  conversationId: string;
  runId: string;
  actorPrincipalId: string;
  reason: string;
  expectedPreviousStatus: ConversationRun["status"];
  status: ConversationRun["status"];
  startedAt?: string | null;
  endedAt?: string | null;
  timingQuality?: ConversationRun["timingQuality"];
}

export type ConversationCommandJobType =
  | "history.rewrite"
  | "history.retry"
  | "history.delete"
  | "history.branch"
  | "history.regenerate"
  | "approval.resolve"
  | "clarification.resolve"
  | "plan.resolve"
  | "todo.update"
  | "run.cancel"
  | "followup.mutate"
  | "runtime-config.mutate";

export type ConversationCommandJobStatus = "accepted" | "running" | "completed" | "failed";

export type ConversationCommandCheckpointName =
  | "execution.claimed"
  | "history.sdk_fork_requested"
  | "history.sdk_fork_created"
  | "history.sdk_fork_skipped"
  | "history.local_rewrite_committed"
  | "history.runtime_dispatch_prepared"
  | "history.runtime_dispatched"
  | "plan.context_frozen"
  | "plan.snapshot_persisted"
  | "plan.session_mode_committed"
  | "plan.bridge_resolved"
  | "plan.bridge_continuation_resumed"
  | "plan.runtime_dispatch_prepared"
  | "plan.runtime_dispatched"
  | "plan.pending_cleared"
  | "plan.dismissal_committed";

export interface ConversationCommandCheckpoint {
  ordinal: number;
  name: ConversationCommandCheckpointName;
  payload: Record<string, unknown>;
  recordedAt: string;
}

export interface ConversationCommandJob {
  protocolVersion: typeof CONVERSATION_V2_PROTOCOL_VERSION;
  principalId: string;
  conversationId: string;
  clientCommandId: string;
  commandType: ConversationCommandJobType;
  requestHash: string;
  request: Record<string, unknown>;
  expectedHistoryRevision: number;
  status: ConversationCommandJobStatus;
  acceptedSeq: number;
  acceptedAt: string;
  updatedAt: string;
  checkpoints: ConversationCommandCheckpoint[];
  result?: unknown;
  error?: unknown;
}

export interface ConversationAcceptCommandInput {
  principalId: string;
  conversationId: string;
  clientCommandId: string;
  commandType: ConversationCommandJobType;
  request: Record<string, unknown>;
  expectedHistoryRevision: number;
}

export interface ConversationCommandExecutionClaim {
  job: ConversationCommandJob;
  acquired: boolean;
}

interface StreamRow {
  conversation_id: string;
  store_epoch: string;
  last_seq: number;
  history_revision: number;
  reducer_version: number;
}

interface TurnRow {
  turn_id: string;
  conversation_id: string;
  created_seq: number;
  active_run_id: string | null;
  version_seq: number;
}

interface EventRow {
  conversation_id: string;
  store_epoch: string;
  seq: number;
  event_id: string;
  type: ConversationEventInput["type"];
  turn_id: string | null;
  run_id: string | null;
  message_id: string | null;
  tool_call_id: string | null;
  agent_id: string | null;
  agent_instance_id: string | null;
  parent_agent_instance_id: string | null;
  parent_agent_id: string | null;
  parent_tool_call_id: string | null;
  occurred_at: string;
  recorded_at: string;
  schema_version: number;
  source_event_key: string | null;
  payload_json: string;
  event_hash: string;
}

interface MessageRow {
  message_id: string;
  conversation_id: string;
  turn_id: string;
  run_id: string | null;
  role: ConversationMessage["role"];
  channel: ConversationMessage["channel"];
  created_seq: number;
  version_seq: number;
  content_version: number;
  body: string;
  attachments_json: string | null;
  origin_json?: string | null;
  agent_id?: string | null;
  agent_instance_id?: string | null;
  // When the row happened, taken from the event that produced it. Placement in a
  // conversation is not a matter of row order: `created_seq` says when a reader learned
  // about a row, not when it happened, so a Feed that only has sequence numbers cannot
  // put a message between two tools of the same turn.
  occurred_at?: string | null;
  provider_role?: string | null;
  history_activity_line_id?: string | null;
  history_user_message_id?: string | null;
  status: ConversationMessage["status"];
  is_deleted: number;
}

interface RunRow {
  run_id: string;
  conversation_id: string;
  turn_id: string;
  status: ConversationRun["status"];
  started_at: string | null;
  ended_at: string | null;
  version_seq: number;
  timing_quality: ConversationRun["timingQuality"];
  retry_of_run_id: string | null;
  regeneration_of_run_id: string | null;
  tool_count?: number;
}

interface AgentRow {
  agent_instance_id: string;
  conversation_id: string;
  agent_id: string | null;
  role: string;
  kind: string;
  status: string;
  run_id: string | null;
  parent_agent_instance_id: string | null;
  parent_tool_call_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  mission: string | null;
  todo_id: string | null;
  task_name: string | null;
  delegation_summary: string | null;
  delegation_prompt: string | null;
  version_seq: number;
}

interface ToolRow {
  tool_call_id: string;
  conversation_id: string;
  run_id: string;
  agent_id: string | null;
  agent_instance_id: string | null;
  parent_agent_instance_id: string | null;
  parent_tool_call_id: string | null;
  name: string;
  status: ConversationToolCall["status"];
  created_seq: number;
  version_seq: number;
  input_json: string | null;
  output_json: string | null;
  occurred_at?: string | null;
  provider_role?: string | null;
  run_known?: number;
}

interface DetailRow {
  item_id: string;
  conversation_id: string;
  run_id: string;
  agent_id: string | null;
  agent_instance_id: string | null;
  parent_agent_instance_id: string | null;
  parent_agent_id: string | null;
  parent_tool_call_id: string | null;
  tool_call_id: string | null;
  type: string;
  created_seq: number;
  version_seq: number;
  content: string | null;
  ref: string | null;
}

interface TodoRow {
  todo_id: string;
  conversation_id: string;
  title: string;
  detail: string;
  status: ConversationTodo["status"];
  position: number;
  updated_at: string;
  version_seq: number;
}

interface EffectRow {
  conversation_id: string;
  seq: number;
  effect_version: number;
  effect_hash: string;
  effect_json: string;
}

/** Durable V2 copy of one usage observation. Kept as a storage row so billing
 * reconciliation can update attribution without rewriting the conversation log. */
export interface ConversationV2UsageLedgerRow {
  conversation_id: string;
  id: string;
  idempotency_key: string;
  run_attempt_id: string | null;
  agent_id: string | null;
  parent_tool_use_id: string | null;
  source: string;
  source_event_id: string;
  request_key: string | null;
  provider_request_id: string | null;
  sdk_message_id: string | null;
  usage_kind: string;
  role: string;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  reported_cost_usd: number | null;
  attribution_json: string;
  metadata_json: string | null;
  observed_at: string;
}

/** Durable V2 runtime state for a plan waiting for user approval. */
export interface ConversationPendingPlanV2 {
  conversationId: string;
  userPrompt: string;
  analysis: string;
  plan: string;
  workspacePath: string;
  worktreePath: string;
  routesJson: string;
  planFilePath?: string | null;
  deferredExitPlanToolUseId?: string | null;
  createdAt: string;
}

interface FeedSkeletonRow {
  conversation_id: string;
  history_revision: number;
  max_event_sequence: number;
  snapshot_json: string;
  auxiliary_json: string | null;
  updated_at: string;
}

interface ReceiptRow {
  result_json: string;
  request_hash: string;
  accepted_seq: number;
}

interface CommandJobRow {
  principal_id: string;
  conversation_id: string;
  client_command_id: string;
  command_type: string;
  request_hash: string;
  request_json: string;
  expected_history_revision: number;
  status: string;
  result_json: string | null;
  error_json: string | null;
  accepted_seq: number;
  accepted_at: string;
  updated_at: string;
}

interface CommandCheckpointRow {
  principal_id: string;
  conversation_id: string;
  client_command_id: string;
  ordinal: number;
  name: string;
  payload_hash: string;
  payload_json: string;
  recorded_at: string;
}

export interface ConversationNativeFact {
  conversationId: string;
  nativeSeq: number;
  eventId: string;
  type: string;
  turnId?: string | null;
  runId?: string | null;
  messageId?: string | null;
  toolCallId?: string | null;
  agentId?: string | null;
  agentInstanceId?: string | null;
  parentAgentInstanceId?: string | null;
  parentAgentId?: string | null;
  parentToolCallId?: string | null;
  occurredAt: string;
  recordedAt: string;
  schemaVersion: number;
  sourceEventKey?: string | null;
  payloadJson: string;
  payloadHash: string;
  eventHash: string;
  disposition: "equivalent" | "collapsed" | "modified" | "unmatched";
  matchedSourceId?: string | null;
  reconciliationReason?: string | null;
  attachmentSummaryJson: string;
}

/**
 * SQLite implementation of the V2 event log and its query read models.
 *
 * The class is deliberately independent from the legacy projection store. A
 * caller can run migration/replay against this store without accidentally
 * updating the old tables or treating a push notification as durable state.
 */
export class ConversationV2Store {
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly listeners = new Set<(result: ConversationAppendResult) => void>();
  private initialized = false;

  constructor(
    private readonly db: DatabaseSyncType,
    options: ConversationV2StoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  initialize(): void {
    if (this.initialized) return;
    // The agent registry is the one read table whose payload (role, kind, mission,
    // boundaries) is not fully derivable from the V2 log alone, so a database that
    // predates it needs a one-time seed from the legacy instances it already recorded.
    const agentRegistryExisted = Boolean(
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_agents_v2'`)
        .get(),
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_store_meta_v2 (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_streams_v2 (
        conversation_id TEXT PRIMARY KEY,
        store_epoch TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        history_revision INTEGER NOT NULL DEFAULT 0,
        reducer_version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS conversation_events_v2 (
        conversation_id TEXT NOT NULL,
        store_epoch TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        turn_id TEXT,
        run_id TEXT,
        message_id TEXT,
        tool_call_id TEXT,
        agent_id TEXT,
        agent_instance_id TEXT,
        parent_agent_instance_id TEXT,
        parent_agent_id TEXT,
        parent_tool_call_id TEXT,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        source_event_key TEXT,
        payload_json TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq),
        UNIQUE (event_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_events_v2_source
        ON conversation_events_v2(conversation_id, source_event_key)
        WHERE source_event_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_conversation_events_v2_run
        ON conversation_events_v2(conversation_id, run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_conversation_events_v2_agent
        ON conversation_events_v2(conversation_id, agent_instance_id, seq);
      CREATE INDEX IF NOT EXISTS idx_conversation_events_v2_tool
        ON conversation_events_v2(conversation_id, tool_call_id, seq);
      CREATE INDEX IF NOT EXISTS idx_conversation_events_v2_message
        ON conversation_events_v2(conversation_id, message_id, seq);

      CREATE TABLE IF NOT EXISTS conversation_messages_v2 (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        run_id TEXT,
        role TEXT NOT NULL,
        channel TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        version_seq INTEGER NOT NULL,
        content_version INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL DEFAULT '',
        attachments_json TEXT,
        origin_json TEXT,
        agent_id TEXT,
        agent_instance_id TEXT,
        occurred_at TEXT,
        provider_role TEXT,
        history_activity_line_id TEXT,
        history_user_message_id TEXT,
        status TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_v2_position
        ON conversation_messages_v2(conversation_id, created_seq DESC, message_id);
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_v2_visible
        ON conversation_messages_v2(conversation_id, is_deleted, channel, created_seq DESC, message_id);

      CREATE TABLE IF NOT EXISTS conversation_runs_v2 (
        run_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        version_seq INTEGER NOT NULL,
        timing_quality TEXT NOT NULL,
        retry_of_run_id TEXT,
        regeneration_of_run_id TEXT,
        tool_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_runs_v2_conversation
        ON conversation_runs_v2(conversation_id, version_seq DESC, run_id);

      CREATE TABLE IF NOT EXISTS conversation_turns_v2 (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        active_run_id TEXT,
        version_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_v2_conversation
        ON conversation_turns_v2(conversation_id, created_seq DESC, turn_id);

      CREATE TABLE IF NOT EXISTS conversation_tool_calls_v2 (
        tool_call_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        agent_id TEXT,
        agent_instance_id TEXT,
        parent_agent_instance_id TEXT,
        parent_tool_call_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        version_seq INTEGER NOT NULL,
        input_json TEXT,
        output_json TEXT,
        occurred_at TEXT,
        provider_role TEXT,
        run_known INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_tools_v2_run
        ON conversation_tool_calls_v2(conversation_id, run_id, created_seq, tool_call_id);

      CREATE TABLE IF NOT EXISTS conversation_detail_items_v2 (
        item_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        agent_id TEXT,
        agent_instance_id TEXT,
        parent_agent_instance_id TEXT,
        parent_agent_id TEXT,
        parent_tool_call_id TEXT,
        tool_call_id TEXT,
        type TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        version_seq INTEGER NOT NULL,
        content TEXT,
        ref TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_details_v2_run
        ON conversation_detail_items_v2(conversation_id, run_id, created_seq, item_id);
      CREATE INDEX IF NOT EXISTS idx_conversation_details_v2_tool
        ON conversation_detail_items_v2(conversation_id, tool_call_id, created_seq, item_id);

      CREATE TABLE IF NOT EXISTS conversation_agents_v2 (
        agent_instance_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_id TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        parent_agent_instance_id TEXT,
        parent_tool_call_id TEXT,
        started_at TEXT,
        ended_at TEXT,
        mission TEXT,
        todo_id TEXT,
        task_name TEXT,
        delegation_summary TEXT,
        delegation_prompt TEXT,
        version_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_agents_v2_conversation
        ON conversation_agents_v2(conversation_id, version_seq, agent_instance_id);

      CREATE TABLE IF NOT EXISTS conversation_todos_v2 (
        todo_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        status TEXT NOT NULL,
        position INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        version_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_todos_v2_position
        ON conversation_todos_v2(conversation_id, position, todo_id);

      -- A pending plan is mutable runtime state, but it is still part of the V2
      -- storage boundary. The old thread_pending_plans table is migration input
      -- only and is never recreated by a V2-only runtime.
      CREATE TABLE IF NOT EXISTS conversation_pending_plans_v2 (
        conversation_id TEXT PRIMARY KEY,
        user_prompt TEXT NOT NULL,
        analysis TEXT NOT NULL,
        plan TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        routes_json TEXT NOT NULL,
        plan_file_path TEXT,
        deferred_exit_plan_tool_use_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_pending_plans_v2_created
        ON conversation_pending_plans_v2(created_at, conversation_id);

      -- The live follow-up queue is runtime state, but it still belongs to the
      -- V2 storage boundary. Keep the public API's threadId naming at the
      -- adapter edge while giving the durable table an explicit V2 identity.
      CREATE TABLE IF NOT EXISTS conversation_followups_v2 (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        attachments_json TEXT,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_mode TEXT NOT NULL,
        source_run_attempt_id TEXT,
        target_run_attempt_id TEXT,
        queued_during_phase TEXT,
        delivery_boundary TEXT,
        error TEXT,
        queue_position INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        applied_at TEXT,
        conversation_message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_followups_v2_thread_status
        ON conversation_followups_v2(thread_id, status, priority, created_at);

      CREATE TABLE IF NOT EXISTS conversation_sync_effects_v2 (
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        effect_version INTEGER NOT NULL,
        effect_hash TEXT NOT NULL,
        effect_json TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      );

      CREATE TABLE IF NOT EXISTS conversation_feed_skeletons_v2 (
        conversation_id TEXT PRIMARY KEY,
        history_revision INTEGER NOT NULL DEFAULT 0,
        max_event_sequence INTEGER NOT NULL DEFAULT 0,
        snapshot_json TEXT NOT NULL,
        auxiliary_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_feed_skeletons_v2_updated
        ON conversation_feed_skeletons_v2(updated_at);

      CREATE TABLE IF NOT EXISTS conversation_projection_snapshots_v2 (
        conversation_id TEXT PRIMARY KEY,
        snapshot_version INTEGER NOT NULL DEFAULT 1,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_projection_snapshots_v2_updated
        ON conversation_projection_snapshots_v2(updated_at);

      CREATE TABLE IF NOT EXISTS conversation_usage_ledger_events_v2 (
        conversation_id TEXT NOT NULL,
        id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        run_attempt_id TEXT,
        agent_id TEXT,
        parent_tool_use_id TEXT,
        source TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        request_key TEXT,
        provider_request_id TEXT,
        sdk_message_id TEXT,
        usage_kind TEXT NOT NULL,
        role TEXT NOT NULL,
        model_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        reported_cost_usd REAL,
        attribution_json TEXT NOT NULL,
        metadata_json TEXT,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, id),
        UNIQUE (conversation_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_usage_ledger_v2_observed
        ON conversation_usage_ledger_events_v2(conversation_id, observed_at, id);

      CREATE TABLE IF NOT EXISTS conversation_provider_inputs_v2 (
        conversation_id TEXT NOT NULL,
        input_id TEXT NOT NULL,
        first_seq INTEGER NOT NULL,
        version_seq INTEGER NOT NULL,
        source_json TEXT NOT NULL,
        message_id TEXT,
        message TEXT,
        visible INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (conversation_id, input_id)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_provider_inputs_v2_sequence
        ON conversation_provider_inputs_v2(conversation_id, version_seq);
      CREATE VIEW IF NOT EXISTS conversation_provider_events_v2 AS
        SELECT p.input_id AS id, p.conversation_id AS thread_id,
          p.version_seq AS sequence,
          json_extract(p.source_json, '$.eventType') AS event_type,
          json_extract(p.source_json, '$.scope') AS scope,
          json_extract(p.source_json, '$.role') AS role,
          json_extract(p.source_json, '$.agentId') AS agent_id,
          json_extract(p.source_json, '$.parentAgentId') AS parent_agent_id,
          json_extract(p.source_json, '$.parentToolUseId') AS parent_tool_use_id,
          json_extract(p.source_json, '$.runAttemptId') AS run_attempt_id,
          json_extract(p.source_json, '$.requestId') AS request_id,
          json_extract(p.source_json, '$.streamKey') AS stream_key,
          json_extract(p.source_json, '$.streamState') AS stream_state,
          CASE WHEN p.message_id IS NULL THEN p.message ELSE COALESCE(m.body, '') END AS message,
          json_extract(p.source_json, '$.metadata') AS metadata_json,
          json_extract(p.source_json, '$.observedAt') AS observed_at
        FROM conversation_provider_inputs_v2 p
        LEFT JOIN conversation_messages_v2 m
          ON m.conversation_id = p.conversation_id AND m.message_id = p.message_id
        WHERE p.visible = 1;

      CREATE TABLE IF NOT EXISTS conversation_command_receipts_v2 (
        principal_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        client_command_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        accepted_seq INTEGER NOT NULL,
        PRIMARY KEY (principal_id, conversation_id, client_command_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_command_jobs_v2 (
        principal_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        client_command_id TEXT NOT NULL,
        command_type TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        expected_history_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        accepted_seq INTEGER NOT NULL,
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (principal_id, conversation_id, client_command_id)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_command_jobs_v2_recovery
        ON conversation_command_jobs_v2(status, accepted_seq, conversation_id);

      CREATE TABLE IF NOT EXISTS conversation_command_checkpoints_v2 (
        principal_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        client_command_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        name TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (principal_id, conversation_id, client_command_id, ordinal),
        UNIQUE (principal_id, conversation_id, client_command_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_command_checkpoints_v2_job
        ON conversation_command_checkpoints_v2(
          principal_id, conversation_id, client_command_id, ordinal
        );

      CREATE TABLE IF NOT EXISTS conversation_migrations_v2 (
        migration_version INTEGER NOT NULL,
        conversation_id TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        phase TEXT NOT NULL,
        checkpoint TEXT,
        validation_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (migration_version, conversation_id)
      );

      -- One-time data repairs, recorded per conversation. A repair is a durable
      -- fact ("this conversation has already been through repair X"), so startup
      -- and conversation loads can skip it instead of rescanning the log.
      CREATE TABLE IF NOT EXISTS conversation_repairs_v2 (
        repair_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        repaired_at TEXT NOT NULL,
        PRIMARY KEY (repair_key, conversation_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_native_facts_v2 (
        conversation_id TEXT NOT NULL,
        native_seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        turn_id TEXT,
        run_id TEXT,
        message_id TEXT,
        tool_call_id TEXT,
        agent_id TEXT,
        agent_instance_id TEXT,
        parent_agent_instance_id TEXT,
        parent_agent_id TEXT,
        parent_tool_call_id TEXT,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        source_event_key TEXT,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        disposition TEXT NOT NULL,
        matched_source_id TEXT,
        reconciliation_reason TEXT,
        attachment_summary_json TEXT NOT NULL,
        stored_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, event_id),
        UNIQUE (conversation_id, native_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_native_facts_v2_disposition
        ON conversation_native_facts_v2(conversation_id, disposition, native_seq);
    `);
    const runColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(conversation_runs_v2)`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!runColumns.has("tool_count")) {
      this.db.exec(`ALTER TABLE conversation_runs_v2 ADD COLUMN tool_count INTEGER NOT NULL DEFAULT 0`);
    }
    // Counts are a derived read-model cache. Reconcile once on open so older
    // V2 databases gain O(1) bootstrap/messages metadata without changing the
    // immutable event log or fabricating tool facts.
    this.db.exec(`
      UPDATE conversation_runs_v2
         SET tool_count = (
           SELECT COUNT(*) FROM conversation_tool_calls_v2 tools
            WHERE tools.conversation_id = conversation_runs_v2.conversation_id
              AND tools.run_id = conversation_runs_v2.run_id
         )
    `);
    const toolColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(conversation_tool_calls_v2)`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!toolColumns.has("run_known")) {
      this.db.exec(`ALTER TABLE conversation_tool_calls_v2 ADD COLUMN run_known INTEGER NOT NULL DEFAULT 0`);
    }
    this.db.exec(`
      UPDATE conversation_tool_calls_v2 AS tools
         SET run_known = EXISTS (
           SELECT 1 FROM conversation_runs_v2 AS runs
            WHERE runs.conversation_id = tools.conversation_id
              AND runs.run_id = tools.run_id
         )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversation_tools_v2_orphan
        ON conversation_tool_calls_v2(conversation_id, run_known, created_seq, tool_call_id)
    `);
    const existing = this.db
      .prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = ?`)
      .get(META_KEY) as { value?: unknown } | undefined;
    if (!existing) {
      this.db
        .prepare(`INSERT OR IGNORE INTO conversation_store_meta_v2(key, value) VALUES (?, ?)`)
        .run(META_KEY, `epoch_${this.idFactory()}`);
    } else {
      rowRequiredText(existing.value, "store epoch");
    }
    this.db
      .prepare(`INSERT OR IGNORE INTO conversation_store_meta_v2(key, value) VALUES (?, ?)`)
      .run(STORAGE_MODE_KEY, "legacy_compat");
    for (const [table, columns] of [
      [
        "conversation_events_v2",
        ["agent_instance_id", "parent_agent_instance_id", "parent_agent_id", "parent_tool_call_id"],
      ],
      [
        "conversation_tool_calls_v2",
        [
          "agent_instance_id",
          "parent_agent_instance_id",
          "parent_tool_call_id",
          "occurred_at",
          "provider_role",
        ],
      ],
      [
        "conversation_detail_items_v2",
        ["agent_instance_id", "parent_agent_instance_id", "parent_agent_id", "parent_tool_call_id"],
      ],
      [
        "conversation_messages_v2",
        [
          "attachments_json",
          "origin_json",
          "agent_id",
          "agent_instance_id",
          "occurred_at",
          "provider_role",
          "history_activity_line_id",
          "history_user_message_id",
        ],
      ],
      ["conversation_agents_v2", ["task_name", "delegation_summary", "delegation_prompt"]],
    ] as const) {
      const existingColumns = new Set(
        (
          this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      const addedColumns: string[] = [];
      for (const column of columns) {
        if (!existingColumns.has(column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
          addedColumns.push(column);
        }
      }
      // A message's agent ownership only ever lived in the event row, so a read table
      // that predates the columns has to be filled from the log it was derived from —
      // a plain re-derivation, not a correction: rebuilding the read model produces the
      // same values. Only agents of an existing conversation are written, per message.
      if (
        table === "conversation_messages_v2" &&
        (addedColumns.includes("agent_id") || addedColumns.includes("agent_instance_id"))
      ) {
        this.backfillMessageAgentOwnership();
      }
      // Placement times are the same kind of fact: the read table learned when a row
      // happened from the event that produced it, so a table that predates the column
      // is filled from that log. Rebuilding the read model produces the same values.
      if (addedColumns.includes("occurred_at")) {
        this.backfillOccurredAt(table);
      }
      // The provider's own role label is the same kind of fact: the read table learned
      // it from the event that produced the row, so a table that predates the column is
      // filled from the legacy log by recomputing each row's identity. A Feed identifies
      // a turn's final output by `role === "planner"`; without the label that question
      // cannot be answered at all.
      if (addedColumns.includes("provider_role")) {
        this.backfillProviderRole(table);
      }
      // History identities are sourced from the immutable provider-input receipt. This
      // repairs databases created before V2 exposed Claude's rewind target without
      // consulting a retired projection table.
      // An agent card's label is its task name and its delegation text, and both only
      // ever lived in the `agent.started` row that opened the agent outside V2. A
      // registry that predates the columns is filled from that log: same derivation the
      // mirror performs when the row is written live.
      if (table === "conversation_agents_v2" && addedColumns.length > 0) {
        this.backfillAgentDelegation();
      }
    }
    // The agent registry is new, so existing conversations have no rows for the
    // agents they already ran. Role, kind, mission and boundaries only ever lived in
    // the legacy instance table; seeding them here is a plain re-derivation for the
    // agents a conversation already knew about, not a correction.
    if (!agentRegistryExisted) {
      this.backfillAgentRegistry();
    }
    // Re-run this idempotent, source-only enrichment on every startup. A provider
    // receipt can be written after the columns were introduced (for example when
    // an older migration had no V2 message id), and a later startup can then prove
    // the same user row by its exact prompt text. COALESCE keeps an established
    // identity immutable.
    this.backfillMessageHistoryTargets();
    this.initialized = true;
  }

  /**
   * Fills placement times of rows written before the read tables carried them.
   *
   * The event log already recorded when each row happened, so this is a plain
   * re-derivation for rows that only lacked the column — never a correction of a value
   * the log does not support. Only the earliest event of a row is used, because that is
   * when the row appeared.
   */
  private backfillOccurredAt(table: string): void {
    const spec =
      table === "conversation_messages_v2"
        ? { column: "message_id", eventColumn: "message_id" }
        : table === "conversation_tool_calls_v2"
          ? { column: "tool_call_id", eventColumn: "tool_call_id" }
          : undefined;
    if (!spec) return;
    const hasEvents = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_events_v2'`)
      .get() as { name?: unknown } | undefined;
    if (!hasEvents) return;
    this.db.exec(
      `UPDATE ${table}
          SET occurred_at = (
            SELECT MIN(e.occurred_at)
              FROM conversation_events_v2 e
             WHERE e.${spec.eventColumn} = ${table}.${spec.column}
          )
        WHERE occurred_at IS NULL
          AND EXISTS (
            SELECT 1 FROM conversation_events_v2 e
             WHERE e.${spec.eventColumn} = ${table}.${spec.column}
          )`,
    );
  }

  /**
   * Fills the provider role of rows written before the read tables carried it.
   *
   * The legacy log is where the label came from in the first place, so this is a plain
   * re-derivation: the same identity formulas the mirror uses turn each legacy row into
   * the V2 row it produced, and only that row is given the label. Rows the legacy log
   * does not identify are left alone — a guessed owner would put a fact on a row that is
   * not its own, which is worse than a missing label.
   */
  private backfillProviderRole(table: string): void {
    const messageTable = table === "conversation_messages_v2";
    const spec = messageTable
      ? {
          id: legacyMessageId,
          eventTypes: LEGACY_MESSAGE_EVENT_TYPES,
          column: "message_id",
        }
      : table === "conversation_tool_calls_v2"
        ? {
            id: legacyToolCallId,
            eventTypes: LEGACY_TOOL_EVENT_TYPES,
            column: "tool_call_id",
          }
        : undefined;
    if (!spec) return;
    const hasLegacyEvents = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_run_events'`)
      .get() as { name?: unknown } | undefined;
    if (!hasLegacyEvents) return;
    const placeholders = spec.eventTypes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT e.id, e.thread_id, e.sequence, e.event_type, e.scope, e.stream_state,
                e.role, e.run_attempt_id, e.request_id, e.stream_key, e.metadata_json
           FROM thread_run_events e
          WHERE e.event_type IN (${placeholders})
            AND e.role IS NOT NULL
            AND e.role <> ''
            AND EXISTS (
              SELECT 1 FROM conversation_streams_v2 s
               WHERE s.conversation_id = e.thread_id
            )
          ORDER BY e.thread_id, e.sequence, e.id`,
      )
      .all(...spec.eventTypes) as unknown as LegacyEventIdentityRow[];
    if (rows.length === 0) return;
    const update = this.db.prepare(
      `UPDATE ${table} SET provider_role = ?
        WHERE ${spec.column} = ? AND conversation_id = ? AND provider_role IS NULL`,
    );
    // `initialize` is not wrapped in a transaction of its own, so this loop owns one:
    // without it every row would be its own commit.
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const event = legacyIdentityEventFromRow(row);
        if (!event) continue;
        const providerRole = legacyProviderRole(event);
        if (!providerRole) continue;
        update.run(providerRole, spec.id(event), event.threadId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the backfill error.
      }
      throw error;
    }
  }

  private backfillMessageHistoryTargets(): void {
    const rows = this.db
      .prepare(
        `SELECT conversation_id, input_id, message_id, message, source_json
           FROM conversation_provider_inputs_v2
          WHERE visible = 1
            AND source_json IS NOT NULL`,
      )
      .all() as Array<{
      conversation_id: string;
      input_id: string;
      message_id: string | null;
      message: string | null;
      source_json: string;
    }>;
    if (rows.length === 0) return;
    const messageRows = this.db
      .prepare(
        `SELECT conversation_id, message_id, body
           FROM conversation_messages_v2
          WHERE role = 'user'`,
      )
      .all() as Array<{ conversation_id: string; message_id: string; body: string }>;
    const messageIdsByBody = new Map<string, string[]>();
    for (const row of messageRows) {
      const key = `${row.conversation_id}\u0000${row.body}`;
      const ids = messageIdsByBody.get(key) ?? [];
      ids.push(row.message_id);
      messageIdsByBody.set(key, ids);
    }
    const update = this.db.prepare(
      `UPDATE conversation_messages_v2
          SET history_activity_line_id = COALESCE(history_activity_line_id, ?),
              history_user_message_id = COALESCE(history_user_message_id, ?)
        WHERE conversation_id = ?
          AND message_id = ?
          AND role = 'user'`,
    );
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        let source: Record<string, unknown>;
        try {
          const parsed = JSON.parse(row.source_json) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          source = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        const metadata = source.metadata;
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
        const rewind = (metadata as Record<string, unknown>).rewindTarget;
        if (!rewind || typeof rewind !== "object" || Array.isArray(rewind)) continue;
        const target = rewind as Record<string, unknown>;
        const activityLineId = typeof target.activityLineId === "string" ? target.activityLineId.trim() : "";
        const userMessageId = typeof target.userMessageId === "string" ? target.userMessageId.trim() : "";
        let messageId =
          row.message_id?.trim() ||
          (typeof (metadata as Record<string, unknown>).conversationV2MessageId === "string"
            ? ((metadata as Record<string, unknown>).conversationV2MessageId as string).trim()
            : "");
        if (
          (!messageId ||
            !this.db
              .prepare(
                `SELECT 1 FROM conversation_messages_v2
                  WHERE conversation_id = ? AND message_id = ? AND role = 'user'`,
              )
              .get(row.conversation_id, messageId)) &&
          typeof row.message === "string"
        ) {
          const candidates = messageIdsByBody.get(`${row.conversation_id}\u0000${row.message}`) ?? [];
          // Exact text is a proof only when it identifies one V2 user row. Repeated
          // prompts remain deliberately ambiguous and are left without a target.
          messageId = candidates.length === 1 ? candidates[0]! : "";
        }
        if (!activityLineId || !messageId) continue;
        update.run(activityLineId, userMessageId || null, row.conversation_id, messageId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the source error if SQLite already rolled back the transaction.
      }
      throw error;
    }
  }

  /**
   * Seeds `conversation_agents_v2` from the legacy agent instances of the agents the
   * conversations already recorded.
   *
   * Only fills what the event log cannot say: role, kind, mission, todo and the
   * boundaries of agents whose lifecycle rows predate the registry. Existing rows are
   * never overwritten, so a lifecycle event always wins over the seed.
   */
  private backfillAgentRegistry(conversationId?: string): void {
    const legacyTable = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_agent_instances'`)
      .get() as { name?: unknown } | undefined;
    if (!legacyTable) return;
    // Without a conversation the call is the once-per-install upgrade: it only makes sense
    // in an install that already ran under V2. A conversation being migrated has no stream
    // yet, and the migration asks for its own agents by id.
    if (conversationId === undefined) {
      const hasStream = this.db.prepare(`SELECT 1 AS present FROM conversation_streams_v2 LIMIT 1`).get() as
        | { present?: number }
        | undefined;
      if (!hasStream?.present) return;
    }
    const select = `SELECT thread_id, agent_id, role, kind, status, run_attempt_id, parent_agent_id,
                parent_tool_use_id, mission_key, todo_id, started_at, ended_at
           FROM thread_agent_instances`;
    const rows = (conversationId === undefined
      ? this.db.prepare(select).all()
      : this.db.prepare(`${select} WHERE thread_id = ?`).all(conversationId)) as unknown as Array<{
      thread_id: string;
      agent_id: string;
      role: string;
      kind: string;
      status: string;
      run_attempt_id: string | null;
      parent_agent_id: string | null;
      parent_tool_use_id: string | null;
      mission_key: string | null;
      todo_id: string | null;
      started_at: string | null;
      ended_at: string | null;
    }>;
    for (const row of rows) {
      this.seedAgentFromLegacyInstance({
        agentId: rowRequiredText(row.agent_id, "agent.agent_id"),
        conversationId: row.thread_id,
        role: row.role,
        kind: row.kind,
        status: row.status,
        runId: row.run_attempt_id,
        parentAgentInstanceId: row.parent_agent_id,
        parentToolCallId: row.parent_tool_use_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        mission: row.mission_key,
        todoId: row.todo_id,
      });
    }
    // The card's own text only ever lived outside the registry, so the rows just seeded
    // are filled from the log they came from.
    this.backfillAgentDelegation(conversationId);
  }

  /**
   * Seeds the registry from the legacy instance table for one conversation.
   *
   * The once-per-install `backfillAgentRegistry` only runs when a V2 stream already exists,
   * so a conversation migrated *into* V2 — which by definition has none — would keep its
   * agent rows unseeded. What that costs is not cosmetic: the role and kind of an agent are
   * the only thing that says whether a row's owner is a subagent with a card of its own or
   * the attempt's own planner instance, and without them the Feed draws a card per attempt
   * for the main agent, named after its id.
   *
   * Seeding is a re-derivation from rows the conversation already had, never a correction:
   * an agent the event log already wrote is left as the log wrote it.
   */
  seedLegacyAgents(conversationId: string): void {
    this.ensureInitialized();
    this.backfillAgentRegistry(requireText(conversationId, "conversationId"));
  }

  /**
   * Seeds one agent the way an upgraded install does.
   *
   * `conversation_agents_v2` is a read model, and a conversation that already ran before
   * V2 was in use has no `agent.*` events: its agents are only known from the legacy
   * instance row. The seeding is idempotent and never overwrites a row the log wrote —
   * the same rules as `backfillAgentRegistry`, exposed because handing the registry the
   * agents a conversation already had has no other entry point.
   */
  seedAgentFromLegacyInstance(input: {
    agentId: string;
    conversationId: string;
    role: string;
    kind: string;
    status: string;
    runId?: string | null;
    parentAgentInstanceId?: string | null;
    parentToolCallId?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    mission?: string | null;
    todoId?: string | null;
    taskName?: string | null;
    delegationSummary?: string | null;
    delegationPrompt?: string | null;
  }): boolean {
    this.ensureInitialized();
    const agentInstanceId = requireText(input.agentId, "agent.agentId");
    const conversationId = requireText(input.conversationId, "conversationId");
    const headSeq = this.headSeq(conversationId);
    // A seeded row is only meaningful inside a stream that already has events: the
    // version has to be a real sequence the client can hold (and never above the head),
    // otherwise the read model it lands in is not readable at all.
    if (headSeq < 1) return false;
    const versionSeq = Math.min(headSeq, Math.max(1, this.maxSeqForAgent(conversationId, agentInstanceId)));
    return this.insertSeededAgent({
      ...input,
      agentId: agentInstanceId,
      conversationId,
      versionSeq,
    });
  }

  private insertSeededAgent(input: {
    agentId: string;
    conversationId: string;
    role: string;
    kind: string;
    status: string;
    versionSeq: number;
    runId?: string | null;
    parentAgentInstanceId?: string | null;
    parentToolCallId?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    mission?: string | null;
    todoId?: string | null;
    taskName?: string | null;
    delegationSummary?: string | null;
    delegationPrompt?: string | null;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO conversation_agents_v2
         (agent_instance_id, conversation_id, agent_id, role, kind, status, run_id,
          parent_agent_instance_id, parent_tool_call_id, started_at, ended_at, mission,
          todo_id, task_name, delegation_summary, delegation_prompt, version_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_instance_id) DO NOTHING`,
      )
      .run(
        input.agentId,
        input.conversationId,
        input.agentId,
        input.role,
        input.kind,
        input.status,
        input.runId ?? null,
        input.parentAgentInstanceId ?? null,
        input.parentToolCallId ?? null,
        input.startedAt ?? null,
        input.endedAt ?? null,
        input.mission ?? null,
        input.todoId ?? null,
        input.taskName ?? null,
        input.delegationSummary ?? null,
        input.delegationPrompt ?? null,
        input.versionSeq,
      );
    return info.changes > 0;
  }

  private headSeq(conversationId: string): number {
    const row = this.db
      .prepare(`SELECT last_seq AS seq FROM conversation_streams_v2 WHERE conversation_id = ?`)
      .get(conversationId) as { seq?: number | null } | undefined;
    return typeof row?.seq === "number" ? row.seq : 0;
  }

  /**
   * Fills the card text of agents that were registered before the registry carried it.
   *
   * A card's label is its task name and its delegation text, and both only ever lived in
   * the `agent.started` row written outside V2. Reading them back out of that log is the
   * same derivation the live mirror performs, not a correction, so a registry that
   * predates the columns ends up exactly where a rebuilt one would.
   */
  private backfillAgentDelegation(conversationId?: string): void {
    const legacyTable = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_run_events'`)
      .get() as { name?: unknown } | undefined;
    if (!legacyTable) return;
    const scope = conversationId === undefined ? "" : "WHERE agent.conversation_id = ?";
    for (const field of [
      ["task_name", "taskName"],
      ["delegation_summary", "delegationSummary"],
      ["delegation_prompt", "delegationPrompt"],
    ] as const) {
      const [column, key] = field;
      this.db
        .prepare(
          `UPDATE conversation_agents_v2 AS agent
              SET ${column} = COALESCE(
                    agent.${column},
                    (SELECT json_extract(event.metadata_json, '$.${key}')
                       FROM thread_run_events AS event
                      WHERE event.thread_id = agent.conversation_id
                        AND event.agent_id = agent.agent_instance_id
                        AND event.event_type = 'agent.started'
                        AND json_extract(event.metadata_json, '$.${key}') IS NOT NULL
                      ORDER BY event.sequence
                      LIMIT 1)
                  )
            ${scope}`,
        )
        .run(...(conversationId === undefined ? [] : [conversationId]));
    }
  }

  /** Positions a seeded agent row after the events that already mention it. */
  private maxSeqForAgent(conversationId: string, agentInstanceId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(seq) AS seq FROM conversation_events_v2
          WHERE conversation_id = ?
            AND (agent_instance_id = ? OR agent_id = ?)`,
      )
      .get(conversationId, agentInstanceId, agentInstanceId) as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }

  /**
   * Fills `conversation_messages_v2.agent_id` / `agent_instance_id` from the message
   * events that carry them.
   *
   * Every message row of a subagent keeps its events' `agent_id` (the adapter has
   * always set it), but the read model used to drop it, so consumers could not tell
   * a subagent's narration from the main agent's and rendered both in the main Feed.
   */
  private backfillMessageAgentOwnership(): void {
    this.db.exec(`
      UPDATE conversation_messages_v2 AS m
         SET agent_id = (
               SELECT e.agent_id FROM conversation_events_v2 AS e
                WHERE e.conversation_id = m.conversation_id
                  AND e.message_id = m.message_id
                  AND e.agent_id IS NOT NULL
                LIMIT 1
             ),
             agent_instance_id = (
               SELECT e.agent_instance_id FROM conversation_events_v2 AS e
                WHERE e.conversation_id = m.conversation_id
                  AND e.message_id = m.message_id
                  AND e.agent_instance_id IS NOT NULL
                LIMIT 1
             )
       WHERE m.agent_id IS NULL
         AND EXISTS (
               SELECT 1 FROM conversation_events_v2 AS e
                WHERE e.conversation_id = m.conversation_id
                  AND e.message_id = m.message_id
                  AND e.agent_id IS NOT NULL
             )
    `);
  }

  onCommitted(listener: (result: ConversationAppendResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStoreEpoch(): string {
    this.ensureInitialized();
    const row = this.db.prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = ?`).get(META_KEY) as
      | { value?: unknown }
      | undefined;
    if (!row) {
      throw new ConversationV2Error(CONVERSATION_V2_ERROR.integrityFailure, "V2 store epoch is missing.");
    }
    return rowRequiredText(row.value, "store epoch");
  }

  getStorageMode(): ConversationV2StorageMode {
    this.ensureInitialized();
    const row = this.db
      .prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = ?`)
      .get(STORAGE_MODE_KEY) as { value?: unknown } | undefined;
    return row?.value === "v2_only" ? "v2_only" : "legacy_compat";
  }

  /**
   * Return every durable image reference still present in V2-owned JSON.
   * Content-addressed objects are garbage collected only after this mark set
   * has been collected, so event history, queued commands, effects and the
   * read models all remain protected during cleanup.
   *
   * The reference sources include the whole event log, which is by far the
   * largest table in the store. Scanning it holds the synchronous SQLite
   * connection and regex-walks every payload, so a large store used to stall
   * the desktop main process for many seconds. Two changes keep that cost off
   * the main thread's critical path: the `instr` prefilter decides inside
   * SQLite which rows can contain a content ref, and the walk proceeds in
   * rowid windows that yield to the event loop between batches.
   */
  async collectReferencedPromptImageContentRefs(): Promise<Set<string>> {
    this.ensureInitialized();
    const refs = new Set<string>();
    for (const [table, column] of PROMPT_IMAGE_REF_SOURCES) {
      const bounds = this.db
        .prepare(`SELECT MIN(rowid) AS low, MAX(rowid) AS high FROM ${table}`)
        .get() as { low: number | null; high: number | null } | undefined;
      if (!bounds || bounds.low === null || bounds.high === null) continue;
      const select = this.db.prepare(
        `SELECT ${column} AS value FROM ${table}
          WHERE rowid > ? AND rowid <= ? AND instr(${column}, 'sha256:') > 0`,
      );
      for (let low = bounds.low - 1; low < bounds.high; low += PROMPT_IMAGE_REF_SCAN_WINDOW_ROWS) {
        const rows = select.all(low, low + PROMPT_IMAGE_REF_SCAN_WINDOW_ROWS) as Array<{
          value: string | null;
        }>;
        for (const row of rows) {
          if (row.value === null) continue;
          collectPromptImageContentRefs(row.value, refs);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return refs;
  }

  /**
   * Prove that a durable prompt-image reference belongs to one conversation.
   *
   * The CAS object store is intentionally global to the desktop profile, so a
   * hash alone is not an authorization boundary. Read only JSON owned by the
   * requested V2 conversation; the event log and command receipts are included
   * because a mobile resend can race a read-model update.
   */
  hasPromptImageContentRef(conversationId: string, contentRef: string): boolean {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    const ref = contentRef.trim();
    if (!isPromptImageContentRef(ref) || !this.hasConversation(id)) {
      return false;
    }
    for (const [table, column, ownerColumn] of PROMPT_IMAGE_REF_SOURCES) {
      const rows = this.db
        .prepare(`SELECT ${column} AS value FROM ${table} WHERE ${ownerColumn} = ?`)
        .all(id) as Array<{ value: string | null }>;
      for (const row of rows) {
        if (!row.value) continue;
        const refs = collectPromptImageContentRefs(row.value);
        if (refs.has(ref)) return true;
      }
    }
    return false;
  }

  setStorageModeInCurrentTransaction(mode: ConversationV2StorageMode): void {
    this.ensureInitialized();
    if (mode !== "legacy_compat" && mode !== "v2_only") {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        `Unsupported Conversation V2 storage mode: ${String(mode)}`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO conversation_store_meta_v2(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(STORAGE_MODE_KEY, mode);
  }

  /** Drop only after a maintenance-window validator has switched the durable mode. */
  retireLegacyStorageTablesInCurrentTransaction(): void {
    this.ensureInitialized();
    for (const table of LEGACY_STORAGE_TABLES) {
      this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  }

  /**
   * V2-only never reads the transitional feed skeleton. Remove rows copied from
   * the compatibility period while the storage-mode transaction is still open,
   * so a reopen cannot leave a second, dead read model behind.
   */
  retireTransitionalFeedSkeletonsInCurrentTransaction(): void {
    this.ensureInitialized();
    this.db.exec("DELETE FROM conversation_feed_skeletons_v2");
  }

  hasConversation(conversationId: string): boolean {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    const row = this.db
      .prepare(`SELECT 1 AS present FROM conversation_streams_v2 WHERE conversation_id = ?`)
      .get(id) as { present?: number } | undefined;
    return row?.present === 1;
  }

  /**
   * Whether a one-time conversation repair has already been applied. Repairs are
   * recorded so a later start (or a later open of the same conversation) can skip
   * the scan instead of repeating it forever.
   */
  hasConversationRepair(repairKey: string, conversationId: string): boolean {
    this.ensureInitialized();
    const key = requireText(repairKey, "repairKey");
    const id = requireText(conversationId, "conversationId");
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM conversation_repairs_v2
          WHERE repair_key = ? AND conversation_id = ?`,
      )
      .get(key, id) as { present?: number } | undefined;
    return row?.present === 1;
  }

  /** Record that a conversation has been through the named one-time repair. */
  markConversationRepaired(repairKey: string, conversationId: string): void {
    this.ensureInitialized();
    const key = requireText(repairKey, "repairKey");
    const id = requireText(conversationId, "conversationId");
    this.db
      .prepare(
        `INSERT INTO conversation_repairs_v2(repair_key, conversation_id, repaired_at)
         VALUES (?, ?, ?)
         ON CONFLICT(repair_key, conversation_id) DO NOTHING`,
      )
      .run(key, id, this.now());
  }

  /** V2 conversations that have not been through the named one-time repair. */
  listConversationsMissingRepair(repairKey: string): string[] {
    this.ensureInitialized();
    const key = requireText(repairKey, "repairKey");
    const rows = this.db
      .prepare(
        `SELECT streams.conversation_id
           FROM conversation_streams_v2 AS streams
          WHERE NOT EXISTS (
            SELECT 1 FROM conversation_repairs_v2 AS repairs
             WHERE repairs.repair_key = ? AND repairs.conversation_id = streams.conversation_id
          )
          ORDER BY streams.conversation_id ASC`,
      )
      .all(key) as Array<{ conversation_id: string }>;
    return rows.map((row) => row.conversation_id);
  }

  rotateStoreEpoch(): string {
    this.ensureInitialized();
    const existing = this.db.prepare(`SELECT COUNT(*) AS count FROM conversation_events_v2`).get() as {
      count: number;
    };
    if (Number(existing.count) > 0) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.storageFailure,
        "Cannot rotate a non-empty V2 store without an epoch-aware archive migration.",
      );
    }
    const epoch = `epoch_${this.idFactory()}`;
    this.beginWrite();
    try {
      this.db.prepare(`UPDATE conversation_store_meta_v2 SET value = ? WHERE key = ?`).run(epoch, META_KEY);
      this.db.prepare(`UPDATE conversation_streams_v2 SET store_epoch = ?, last_seq = 0`).run(epoch);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error if SQLite already rolled back the transaction.
      }
      throw error;
    }
    return epoch;
  }

  capabilities(): ConversationCapabilities {
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      eventSchemaVersion: CONVERSATION_V2_SCHEMA_VERSION,
      effectVersion: CONVERSATION_V2_EFFECT_VERSION,
      maxEvents: CONVERSATION_V2_MAX_SYNC_EVENTS,
      maxBytes: CONVERSATION_V2_DEFAULT_MAX_BYTES,
      storeEpoch: this.getStoreEpoch(),
    };
  }

  append(input: ConversationEventInput): ConversationAppendResult {
    this.ensureInitialized();
    // The generic append API is also used by maintenance and tests that may be
    // replaying an untrusted database. Keep its deep preflight so a damaged
    // historical event/effect cannot be hidden by a successful duplicate.
    const results = this.appendBatch([input], { verifyExistingIntegrity: true });
    return results[0]!;
  }

  /**
   * Append a live runtime fact after the caller has established the V2 stream.
   * Runtime ingestion still validates the new event and its effect, but skips
   * replaying the entire conversation before every token/event. Maintenance
   * callers that need a full historical audit must use append()/validateIntegrity().
   */
  appendRuntime(input: ConversationEventInput): ConversationAppendResult {
    this.ensureInitialized();
    return this.appendBatch([input])[0]!;
  }

  /**
   * Append an auditable administrator correction for an existing run.
   *
   * This is intentionally the only public repair helper. Callers cannot patch
   * `conversation_runs_v2` directly: the event log, sync effect and read model
   * advance in one transaction, and the event payload retains who corrected it,
   * why, and which prior status was observed.
   */
  correctRun(input: ConversationRunCorrectionInput): ConversationAppendResult {
    this.ensureInitialized();
    const conversationId = requireText(input.conversationId, "conversationId");
    const runId = requireText(input.runId, "runId");
    const actorPrincipalId = requireText(input.actorPrincipalId, "actorPrincipalId");
    const reason = requireText(input.reason, "reason");
    validateRunStatusValue(input.expectedPreviousStatus, "expectedPreviousStatus");
    validateRunStatusValue(input.status, "status");
    if (input.timingQuality !== undefined) timingQualityValue(input.timingQuality);
    validateNullableTimestamp(input.startedAt, "startedAt");
    validateNullableTimestamp(input.endedAt, "endedAt");
    const current = this.getRun(conversationId, runId);
    if (!current) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.conversationNotFound,
        `Conversation V2 run does not exist: ${conversationId}/${runId}`,
      );
    }
    const sourceEventKey = `admin:run.corrected:${stableHash({
      conversationId,
      runId,
      actorPrincipalId,
      reason,
      expectedPreviousStatus: input.expectedPreviousStatus,
      status: input.status,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      timingQuality: input.timingQuality,
    })}`;
    const eventId = `desktop_v2_run_corrected_${stableHash(sourceEventKey)}`;
    // Reusing the same correction command must reproduce the original event
    // envelope byte-for-byte. Prefer an already persisted occurrence time;
    // otherwise derive one from the correction's explicit boundaries before
    // falling back to the store clock for a boundary-less repair.
    const existingCorrection = this.db
      .prepare(
        `SELECT occurred_at FROM conversation_events_v2
          WHERE event_id = ? OR (conversation_id = ? AND source_event_key = ?)
          LIMIT 1`,
      )
      .get(eventId, conversationId, sourceEventKey) as { occurred_at?: string } | undefined;
    const occurredAt =
      existingCorrection?.occurred_at ??
      input.endedAt ??
      input.startedAt ??
      current.endedAt ??
      current.startedAt ??
      this.now();
    return this.append({
      conversationId,
      eventId,
      sourceEventKey,
      type: "run.corrected",
      occurredAt,
      turnId: current.turnId,
      runId,
      payload: {
        authority: "admin",
        actorPrincipalId,
        reason,
        expectedPreviousStatus: input.expectedPreviousStatus,
        status: input.status,
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
        ...(input.timingQuality !== undefined ? { timingQuality: input.timingQuality } : {}),
      },
    });
  }

  appendBatch(
    inputs: readonly ConversationEventInput[],
    options: { verifyExistingIntegrity?: boolean } = {},
  ): ConversationAppendResult[] {
    this.ensureInitialized();
    if (inputs.length === 0) return [];
    const results: ConversationAppendResult[] = [];
    this.beginWrite();
    try {
      if (options.verifyExistingIntegrity) {
        const conversationIds = new Set(
          inputs.map((input) => requireText(input.conversationId, "conversationId")),
        );
        for (const conversationId of conversationIds) {
          const stream = this.db
            .prepare(
              `SELECT conversation_id, store_epoch, last_seq, history_revision, reducer_version
                 FROM conversation_streams_v2 WHERE conversation_id = ?`,
            )
            .get(conversationId) as StreamRow | undefined;
          if (stream) this.assertStreamConsistency(stream, true);
        }
      }
      for (const input of inputs) results.push(this.appendInTransaction(input));
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error if SQLite already rolled back the transaction.
      }
      throw error;
    }
    for (const result of results) {
      if (!result.duplicate) this.notifyCommitted(result);
    }
    return results;
  }

  /**
   * Append one event while the caller owns the surrounding SQLite write
   * transaction. This is intentionally separate from append(): it does not
   * BEGIN/COMMIT and it does not publish a post-commit hint before the caller
   * has committed its other tables.
   */
  appendInCurrentTransaction(input: ConversationEventInput): ConversationAppendResult {
    this.ensureInitialized();
    return this.appendInTransaction(input);
  }

  /** Create an empty readable stream without inventing a synthetic event. */
  ensureConversation(conversationId: string): void {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    this.beginWrite();
    try {
      this.ensureStream(id);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error if SQLite already rolled back the transaction.
      }
      throw error;
    }
  }

  /** Ensure a stream while the caller owns the surrounding SQLite write transaction. */
  ensureConversationInCurrentTransaction(conversationId: string): void {
    this.ensureInitialized();
    this.ensureStream(requireText(conversationId, "conversationId"));
  }

  /** Publish V2 commit hints after an external transaction has committed. */
  publishCommitted(results: readonly ConversationAppendResult[]): void {
    for (const result of results) {
      if (!result.duplicate) this.notifyCommitted(result);
    }
  }

  sendMessage(input: ConversationSendMessageInput): ConversationSendMessageResult {
    this.ensureInitialized();
    const principalId = requireText(input.principalId, "principalId");
    const conversationId = requireText(input.conversationId, "conversationId");
    const commandId = requireText(input.clientCommandId, "clientCommandId");
    const text = input.text;
    if (typeof text !== "string") throw v2Invalid("message text must be a string");
    const storedAttachments = sanitizeConversationV2Attachments(input.attachments);
    const origin = parseMessageOrigin(input.origin, "origin");
    const requestHash = stableHash({
      text,
      attachments: storedAttachments,
      ...(origin ? { origin } : {}),
    });
    this.beginWrite();
    let appendResult: ConversationAppendResult;
    let response: ConversationSendMessageResult;
    try {
      const receipt = this.db
        .prepare(
          `SELECT request_hash, result_json, accepted_seq FROM conversation_command_receipts_v2
           WHERE principal_id = ? AND conversation_id = ? AND client_command_id = ?`,
        )
        .get(principalId, conversationId, commandId) as ReceiptRow | undefined;
      if (receipt) {
        if (receipt.request_hash !== requestHash) {
          throw new ConversationV2Error(
            CONVERSATION_V2_ERROR.idempotencyConflict,
            "clientCommandId was already used with a different request.",
          );
        }
        const storedResult = this.validateStoredSendMessageReceipt(receipt, conversationId, commandId);
        this.db.exec("ROLLBACK");
        return storedResult;
      }
      const turnId = requireText(input.turnId ?? `turn_${this.idFactory()}`, "turnId");
      const messageId = requireText(input.messageId ?? `message_${this.idFactory()}`, "messageId");
      appendResult = this.appendInTransaction({
        conversationId,
        eventId: `event_${this.idFactory()}`,
        type: "message.accepted",
        occurredAt: this.now(),
        sourceEventKey: `command:${principalId}:${commandId}`,
        turnId,
        messageId,
        payload: {
          role: "user",
          channel: "answer",
          body: text,
          ...(origin ? { origin } : {}),
          status: "queued",
          ...(storedAttachments.length ? { attachments: storedAttachments } : {}),
        },
      });
      response = {
        protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
        conversationId,
        clientCommandId: commandId,
        messageId,
        turnId,
        acceptedSeq: appendResult.event.seq,
        status: "queued",
      };
      this.db
        .prepare(
          `INSERT INTO conversation_command_receipts_v2
           (principal_id, conversation_id, client_command_id, request_hash, result_json, accepted_seq)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          principalId,
          conversationId,
          commandId,
          requestHash,
          JSON.stringify(response),
          response.acceptedSeq,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error.
      }
      throw error;
    }
    if (!appendResult!.duplicate) this.notifyCommitted(appendResult!);
    return response!;
  }

  /**
   * Durably accept a non-message command before any destructive or external work.
   * Reusing the same id with the same request returns the existing job; changing any
   * request field or the expected history revision is an explicit conflict.
   */
  acceptCommand(input: ConversationAcceptCommandInput): ConversationCommandJob {
    this.ensureInitialized();
    const principalId = requireText(input.principalId, "principalId");
    const conversationId = requireText(input.conversationId, "conversationId");
    const clientCommandId = requireText(input.clientCommandId, "clientCommandId");
    const commandType = requireCommandJobType(input.commandType);
    const expectedHistoryRevision = requireNonNegativeInteger(
      input.expectedHistoryRevision,
      "expectedHistoryRevision",
    );
    const request = durableJsonRecord(input.request, "command request");
    const requestHash = stableHash({
      commandType,
      request,
      expectedHistoryRevision,
    });
    this.beginWrite();
    let appendResult: ConversationAppendResult | undefined;
    let job: ConversationCommandJob | undefined;
    try {
      const existing = this.selectCommandJob(principalId, conversationId, clientCommandId);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ConversationV2Error(
            CONVERSATION_V2_ERROR.idempotencyConflict,
            "clientCommandId was already used with a different command request.",
          );
        }
        job = this.validateStoredCommandJob(existing);
        this.db.exec("ROLLBACK");
        return job;
      }
      const stream = this.requireExistingStream(conversationId);
      if (stream.history_revision !== expectedHistoryRevision) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.cursorStale,
          "Conversation history changed before the command was accepted.",
          {
            expectedHistoryRevision,
            actualHistoryRevision: stream.history_revision,
          },
        );
      }
      const acceptedAt = this.now();
      appendResult = this.appendInTransaction({
        conversationId,
        eventId: `event_${this.idFactory()}`,
        type: "noop",
        occurredAt: acceptedAt,
        sourceEventKey: `command-job:${principalId}:${clientCommandId}`,
        payload: {
          reason: "command.accepted",
          principalId,
          clientCommandId,
          commandType,
          requestHash,
          expectedHistoryRevision,
        },
      });
      this.db
        .prepare(
          `INSERT INTO conversation_command_jobs_v2
           (principal_id, conversation_id, client_command_id, command_type,
            request_hash, request_json, expected_history_revision, status,
            result_json, error_json, accepted_seq, accepted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, NULL, ?, ?, ?)`,
        )
        .run(
          principalId,
          conversationId,
          clientCommandId,
          commandType,
          requestHash,
          JSON.stringify(request),
          expectedHistoryRevision,
          appendResult.event.seq,
          acceptedAt,
          acceptedAt,
        );
      const stored = this.selectCommandJob(principalId, conversationId, clientCommandId);
      if (!stored) throw integrity("Accepted command job was not stored.");
      job = this.validateStoredCommandJob(stored);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error.
      }
      throw error;
    }
    if (!appendResult || !job) {
      throw integrity("Accepted command job did not produce a durable result.");
    }
    if (!appendResult.duplicate) this.notifyCommitted(appendResult);
    return job;
  }

  getCommandJob(
    principalId: string,
    conversationId: string,
    clientCommandId: string,
  ): ConversationCommandJob | undefined {
    this.ensureInitialized();
    const row = this.selectCommandJob(
      requireText(principalId, "principalId"),
      requireText(conversationId, "conversationId"),
      requireText(clientCommandId, "clientCommandId"),
    );
    return row ? this.validateStoredCommandJob(row) : undefined;
  }

  listRecoverableCommandJobs(): ConversationCommandJob[] {
    this.ensureInitialized();
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_command_jobs_v2
         WHERE status IN ('accepted', 'running')
         ORDER BY accepted_seq ASC, conversation_id ASC, client_command_id ASC`,
      )
      .all() as unknown as CommandJobRow[];
    return rows.map((row) => this.validateStoredCommandJob(row));
  }

  /** Validate every durable command receipt/job owned by one conversation. */
  validateCommandState(conversationId: string): void {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    const receipts = this.db
      .prepare(
        `SELECT result_json, request_hash, accepted_seq
           FROM conversation_command_receipts_v2
          WHERE conversation_id = ?`,
      )
      .all(id) as unknown as Array<ReceiptRow>;
    for (const receipt of receipts) {
      const parsed = parseJson(receipt.result_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw integrity("Stored conversation command receipt is not an object.");
      }
      const value = parsed as Record<string, unknown>;
      const clientCommandId = value.clientCommandId;
      if (typeof clientCommandId !== "string") {
        throw integrity("Stored conversation command receipt is missing its command identity.");
      }
      this.validateStoredSendMessageReceipt(receipt, id, clientCommandId);
    }
    const jobs = this.db
      .prepare(`SELECT * FROM conversation_command_jobs_v2 WHERE conversation_id = ?`)
      .all(id) as unknown as CommandJobRow[];
    for (const job of jobs) this.validateStoredCommandJob(job);
  }

  beginCommandExecution(
    principalId: string,
    conversationId: string,
    clientCommandId: string,
  ): ConversationCommandExecutionClaim {
    this.ensureInitialized();
    const key = {
      principalId: requireText(principalId, "principalId"),
      conversationId: requireText(conversationId, "conversationId"),
      clientCommandId: requireText(clientCommandId, "clientCommandId"),
    };
    this.beginWrite();
    try {
      const row = this.selectCommandJob(key.principalId, key.conversationId, key.clientCommandId);
      if (!row) throw v2Invalid("Conversation command job was not found.");
      const current = this.validateStoredCommandJob(row);
      if (current.status !== "accepted") {
        this.db.exec("ROLLBACK");
        return { job: current, acquired: false };
      }
      const stream = this.requireExistingStream(key.conversationId);
      const updatedAt = this.now();
      if (stream.history_revision !== current.expectedHistoryRevision) {
        const error = {
          code: CONVERSATION_V2_ERROR.cursorStale,
          message: "Conversation history changed before command execution.",
          expectedHistoryRevision: current.expectedHistoryRevision,
          actualHistoryRevision: stream.history_revision,
        };
        this.db
          .prepare(
            `UPDATE conversation_command_jobs_v2
             SET status = 'failed', error_json = ?, updated_at = ?
             WHERE principal_id = ? AND conversation_id = ? AND client_command_id = ?
               AND status = 'accepted'`,
          )
          .run(JSON.stringify(error), updatedAt, key.principalId, key.conversationId, key.clientCommandId);
        const failed = this.selectCommandJob(key.principalId, key.conversationId, key.clientCommandId);
        if (!failed) throw integrity("Failed command job disappeared.");
        const job = this.validateStoredCommandJob(failed);
        this.db.exec("COMMIT");
        return { job, acquired: false };
      }
      const changed = this.db
        .prepare(
          `UPDATE conversation_command_jobs_v2
           SET status = 'running', updated_at = ?
           WHERE principal_id = ? AND conversation_id = ? AND client_command_id = ?
             AND status = 'accepted'`,
        )
        .run(updatedAt, key.principalId, key.conversationId, key.clientCommandId);
      if (changed.changes !== 1) {
        throw integrity("Command job execution claim was not atomic.");
      }
      this.insertCommandCheckpointInCurrentTransaction(key, "execution.claimed", {}, updatedAt);
      const running = this.selectCommandJob(key.principalId, key.conversationId, key.clientCommandId);
      if (!running) throw integrity("Running command job disappeared.");
      const job = this.validateStoredCommandJob(running);
      this.db.exec("COMMIT");
      return { job, acquired: true };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error.
      }
      throw error;
    }
  }

  recordCommandCheckpoint(
    principalId: string,
    conversationId: string,
    clientCommandId: string,
    name: ConversationCommandCheckpointName,
    payload: Record<string, unknown>,
  ): ConversationCommandJob {
    this.ensureInitialized();
    const key = {
      principalId: requireText(principalId, "principalId"),
      conversationId: requireText(conversationId, "conversationId"),
      clientCommandId: requireText(clientCommandId, "clientCommandId"),
    };
    const normalizedName = requireCommandCheckpointName(name);
    const normalizedPayload = durableJsonRecord(payload, "command checkpoint payload");
    this.beginWrite();
    try {
      const job = this.recordCommandCheckpointInCurrentTransaction({
        ...key,
        name: normalizedName,
        payload: normalizedPayload,
      });
      this.db.exec("COMMIT");
      return job;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error.
      }
      throw error;
    }
  }

  /**
   * Persist a command checkpoint while the caller owns the SQLite transaction.
   * Used to commit a destructive history rewrite and its recovery marker atomically.
   */
  recordCommandCheckpointInCurrentTransaction(input: {
    principalId: string;
    conversationId: string;
    clientCommandId: string;
    name: ConversationCommandCheckpointName;
    payload: Record<string, unknown>;
  }): ConversationCommandJob {
    this.ensureInitialized();
    const key = {
      principalId: requireText(input.principalId, "principalId"),
      conversationId: requireText(input.conversationId, "conversationId"),
      clientCommandId: requireText(input.clientCommandId, "clientCommandId"),
    };
    const name = requireCommandCheckpointName(input.name);
    const payload = durableJsonRecord(input.payload, "command checkpoint payload");
    const currentRow = this.selectCommandJob(key.principalId, key.conversationId, key.clientCommandId);
    if (!currentRow) throw v2Invalid("Conversation command job was not found.");
    const current = this.validateStoredCommandJob(currentRow);
    if (current.status !== "running") {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.idempotencyConflict,
        `Cannot checkpoint a ${current.status} command job.`,
      );
    }
    if (isPlanCommandCheckpoint(name) && current.commandType !== "plan.resolve") {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.idempotencyConflict,
        "Plan checkpoints are only valid for plan.resolve commands.",
      );
    }
    const existing = current.checkpoints.find((checkpoint) => checkpoint.name === name);
    if (existing) {
      if (stableHash(existing.payload) !== stableHash(payload)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.idempotencyConflict,
          `Command checkpoint ${name} already has different data.`,
        );
      }
      return current;
    }
    if (
      current.checkpoints.at(-1)?.name === "execution.claimed" &&
      name === "history.runtime_dispatch_prepared" &&
      !isNonRewindRetryCommand(current)
    ) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.idempotencyConflict,
        "Only a non-rewind retry may prepare runtime dispatch without a local rewrite checkpoint.",
      );
    }
    const recordedAt = this.now();
    this.insertCommandCheckpointInCurrentTransaction(key, name, payload, recordedAt);
    this.db
      .prepare(
        `UPDATE conversation_command_jobs_v2 SET updated_at = ?
         WHERE principal_id = ? AND conversation_id = ? AND client_command_id = ?`,
      )
      .run(recordedAt, key.principalId, key.conversationId, key.clientCommandId);
    const updated = this.selectCommandJob(key.principalId, key.conversationId, key.clientCommandId);
    if (!updated) throw integrity("Checkpointed command job disappeared.");
    return this.validateStoredCommandJob(updated);
  }

  completeCommand(
    principalId: string,
    conversationId: string,
    clientCommandId: string,
    result: unknown,
  ): ConversationCommandJob {
    return this.finishCommand(principalId, conversationId, clientCommandId, "completed", result);
  }

  failCommand(
    principalId: string,
    conversationId: string,
    clientCommandId: string,
    error: unknown,
  ): ConversationCommandJob {
    return this.finishCommand(principalId, conversationId, clientCommandId, "failed", error);
  }

  finishCommandInCurrentTransaction(input: {
    principalId: string;
    conversationId: string;
    clientCommandId: string;
    status: "completed" | "failed";
    value: unknown;
  }): ConversationCommandJob {
    this.ensureInitialized();
    const key = {
      principalId: requireText(input.principalId, "principalId"),
      conversationId: requireText(input.conversationId, "conversationId"),
      clientCommandId: requireText(input.clientCommandId, "clientCommandId"),
    };
    const storedJson = durableJson(input.value, `command ${input.status} value`);
    return this.finishCommandInTransaction(key, input.status, storedJson);
  }

  head(conversationId: string): ConversationHead {
    const stream = this.requireExistingStream(conversationId);
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      storeEpoch: stream.store_epoch,
      conversationId,
      lastSeq: stream.last_seq,
      historyRevision: stream.history_revision,
    };
  }

  /**
   * Read the V2-owned panel projection. This is deliberately separate from the
   * message/run bootstrap because request timing and usage panels are mutable
   * read-model facts rather than conversation content.
   */
  getProjectionSnapshot(conversationId: string): Record<string, unknown> | undefined {
    this.requireExistingStream(conversationId);
    const row = this.db
      .prepare(
        `SELECT snapshot_version, snapshot_json
         FROM conversation_projection_snapshots_v2
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as { snapshot_version?: number; snapshot_json?: string } | undefined;
    if (!row) return undefined;
    if (row.snapshot_version !== 1 || typeof row.snapshot_json !== "string") {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Conversation V2 projection snapshot is invalid: ${conversationId}`,
      );
    }
    const parsed = parseJson(row.snapshot_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Conversation V2 projection snapshot JSON is invalid: ${conversationId}`,
      );
    }
    return parsed as Record<string, unknown>;
  }

  saveProjectionSnapshot(
    conversationId: string,
    snapshot: Record<string, unknown>,
    options: { inCurrentTransaction?: boolean } = {},
  ): void {
    this.requireExistingStream(conversationId);
    const serialized = durableJson(snapshot, `projection snapshot ${conversationId}`);
    const write = () => {
      this.db
        .prepare(
          `INSERT INTO conversation_projection_snapshots_v2 (
             conversation_id, snapshot_version, snapshot_json, updated_at
           ) VALUES (?, 1, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             snapshot_version = excluded.snapshot_version,
             snapshot_json = excluded.snapshot_json,
             updated_at = excluded.updated_at`,
        )
        .run(conversationId, serialized, new Date().toISOString());
    };
    if (options.inCurrentTransaction) {
      write();
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      write();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error.
      }
      throw error;
    }
  }

  bootstrap(
    conversationId: string,
    pageSize = 30,
    maxBytes = CONVERSATION_V2_DEFAULT_MAX_BYTES,
  ): ConversationBootstrap {
    return this.readTransaction(() => {
      const stream = this.requireExistingStream(conversationId);
      let messages = this.readMessages(conversationId, pageSize, maxBytes);
      const turns = this.listTurns(conversationId, pageSize);
      const runs = this.listRuns(conversationId, pageSize);
      // Keep a bounded history plus every owner's latest state. A busy child
      // must not push the main agent's current compaction state out of bootstrap.
      const detailRows = this.db
        .prepare(
          `WITH compaction AS (
             SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(agent_instance_id, agent_id, '')
                 ORDER BY created_seq DESC, item_id DESC
               ) AS owner_rank,
               ROW_NUMBER() OVER (ORDER BY created_seq DESC, item_id DESC) AS recent_rank
             FROM conversation_detail_items_v2
             WHERE conversation_id = ? AND type IN (
               'context.compaction.started', 'context.compaction.completed',
               'context.compaction.failed', 'context.compaction.suspended'
             )
           ) SELECT * FROM compaction WHERE owner_rank = 1 OR recent_rank <= ?
             ORDER BY created_seq ASC, item_id ASC`,
        )
        .all(conversationId, CONVERSATION_V2_MAX_PAGE_SIZE) as unknown as (DetailRow & {
        owner_rank: number;
      })[];
      const details = detailRows.map(rowToDetail);
      const latestCompactionIds = new Set(
        detailRows.filter((row) => row.owner_rank === 1).map((row) => row.item_id),
      );
      const supersededDetailIndex = () =>
        details.findIndex((detail) => !latestCompactionIds.has(detail.itemId));
      const toolRunIdsForMessages = (visibleMessages: readonly ConversationMessage[]) => [
        ...new Set([
          ...(visibleMessages.length === 0
            ? runs.map((run) => run.runId)
            : visibleMessages
                .map((message) => message.runId)
                .filter((runId): runId is string => Boolean(runId))),
          ...(visibleMessages.length > 0
            ? runs
                .filter((run) => run.status === "queued" || run.status === "running")
                .map((run) => run.runId)
            : []),
        ]),
      ];
      let toolRunIds = toolRunIdsForMessages(messages);
      let tools = this.listToolSummaries(conversationId, toolRunIds, CONVERSATION_V2_MAX_PAGE_SIZE);
      let toolSummaryCounts = this.listToolSummaryCounts(conversationId, toolRunIds);
      const safeBytes = normalizeBytes(maxBytes);
      const buildResponse = () =>
        buildBootstrapResponse(
          stream,
          conversationId,
          messages,
          turns,
          runs,
          tools,
          toolSummaryCounts,
          this.listAgents(conversationId),
          this.listTodos(conversationId),
          details,
          (oldest) => this.hasOlderMessages(conversationId, oldest),
        );
      let response = buildResponse();
      while (
        estimateConversationBytes(response) > safeBytes &&
        (tools.length > 0 || supersededDetailIndex() >= 0 || messages.length > 1)
      ) {
        // Tool summaries have their own cursor. Trim them before shrinking the
        // message window so a large run cannot make bootstrap fail or discard
        // useful history merely because its summary list is long.
        if (tools.length > 0) {
          tools = tools.slice(1);
        } else if (supersededDetailIndex() >= 0) {
          details.splice(supersededDetailIndex(), 1);
        } else {
          // readMessages returns newest-first. Drop the oldest item from this
          // bounded snapshot so the returned cursor still advances backwards.
          messages = messages.slice(0, -1);
          toolRunIds = toolRunIdsForMessages(messages);
          tools = this.listToolSummaries(conversationId, toolRunIds, CONVERSATION_V2_MAX_PAGE_SIZE);
          toolSummaryCounts = this.listToolSummaryCounts(conversationId, toolRunIds);
        }
        response = buildResponse();
      }
      if (estimateConversationBytes(response) > safeBytes) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.payloadTooLarge,
          "The Conversation V2 bootstrap exceeds maxBytes.",
        );
      }
      return response;
    });
  }

  messagesPage(
    conversationId: string,
    beforeCursor?: string,
    limit = 30,
    maxBytes = CONVERSATION_V2_DEFAULT_MAX_BYTES,
  ): ConversationMessagesPage {
    return this.readTransaction(() => {
      const stream = this.requireExistingStream(conversationId);
      const cursor = beforeCursor ? decodeConversationCursor(beforeCursor, "messages") : undefined;
      this.validateCursor(cursor, stream);
      let messages = this.readMessages(conversationId, limit, maxBytes, cursor);
      let runIds = [
        ...new Set(
          messages.map((message) => message.runId).filter((runId): runId is string => Boolean(runId)),
        ),
      ];
      let runs = this.listRunsForIds(conversationId, runIds);
      let tools = this.listToolSummaries(conversationId, runIds, CONVERSATION_V2_MAX_PAGE_SIZE);
      let toolSummaryCounts = this.listToolSummaryCounts(conversationId, runIds);
      const buildResponse = () => {
        const last = messages.at(-1);
        const hasMore = this.hasOlderMessages(conversationId, last);
        return {
          protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
          storeEpoch: stream.store_epoch,
          conversationId,
          readSeq: stream.last_seq,
          historyRevision: stream.history_revision,
          messages: [...messages].reverse(),
          runs,
          tools,
          toolSummaryCounts,
          agents: this.listAgents(conversationId),
          ...(last && hasMore
            ? {
                nextCursor: encodeConversationCursor({
                  kind: "messages" as const,
                  storeEpoch: stream.store_epoch,
                  historyRevision: stream.history_revision,
                  createdSeq: last.createdSeq,
                  id: last.messageId,
                }),
              }
            : {}),
          hasMore,
        } satisfies ConversationMessagesPage;
      };
      let response = buildResponse();
      while (
        estimateConversationBytes(response) > normalizeBytes(maxBytes) &&
        (tools.length > 0 || messages.length > 1)
      ) {
        if (tools.length > 0) {
          tools = tools.slice(1);
        } else {
          messages = messages.slice(0, -1);
          runIds = [
            ...new Set(
              messages.map((message) => message.runId).filter((runId): runId is string => Boolean(runId)),
            ),
          ];
          runs = this.listRunsForIds(conversationId, runIds);
          tools = this.listToolSummaries(conversationId, runIds, CONVERSATION_V2_MAX_PAGE_SIZE);
          toolSummaryCounts = this.listToolSummaryCounts(conversationId, runIds);
        }
        response = buildResponse();
      }
      if (estimateConversationBytes(response) > normalizeBytes(maxBytes)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.payloadTooLarge,
          "The Conversation V2 messages page exceeds maxBytes.",
        );
      }
      return response;
    });
  }

  detailsPage(
    conversationId: string,
    runId: string,
    cursorValue?: string,
    limit = 50,
    maxBytes = CONVERSATION_V2_DEFAULT_MAX_BYTES,
    toolCallId?: string,
    agentInstanceId?: string,
  ): ConversationDetailsPage {
    return this.readTransaction(() => {
      const stream = this.requireExistingStream(conversationId);
      const cursor = cursorValue ? decodeConversationCursor(cursorValue, "details") : undefined;
      this.validateCursor(cursor, stream);
      const safeLimit = normalizeLimit(limit, CONVERSATION_V2_MAX_PAGE_SIZE);
      const safeBytes = normalizeBytes(maxBytes);
      const params: Array<string | number> = [conversationId, runId];
      let where = `conversation_id = ? AND run_id = ?`;
      if (toolCallId) {
        where += ` AND tool_call_id = ?`;
        params.push(toolCallId);
      }
      if (agentInstanceId) {
        where += ` AND agent_instance_id = ?`;
        params.push(agentInstanceId);
      }
      if (cursor) {
        where += ` AND (created_seq < ? OR (created_seq = ? AND item_id < ?))`;
        params.push(cursor.createdSeq, cursor.createdSeq, cursor.id);
      }
      const rows = this.db
        .prepare(
          `SELECT item_id, conversation_id, run_id, agent_id, agent_instance_id,
                  parent_agent_instance_id, parent_agent_id, parent_tool_call_id, tool_call_id, type,
                  created_seq, version_seq, content, ref
           FROM conversation_detail_items_v2 WHERE ${where}
           ORDER BY created_seq DESC, item_id DESC LIMIT ?`,
        )
        .all(...params, safeLimit + 1) as unknown as DetailRow[];
      const selected = fitPage(rows.map(rowToDetail), safeLimit, safeBytes);
      const last = selected.at(-1);
      const hasMore = rows.length > selected.length;
      return {
        protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
        storeEpoch: stream.store_epoch,
        conversationId,
        readSeq: stream.last_seq,
        historyRevision: stream.history_revision,
        items: selected.reverse(),
        ...(last && hasMore
          ? {
              nextCursor: encodeConversationCursor({
                kind: "details",
                storeEpoch: stream.store_epoch,
                historyRevision: stream.history_revision,
                createdSeq: last.createdSeq,
                id: last.itemId,
              }),
            }
          : {}),
        hasMore,
      };
    });
  }

  toolsPage(
    conversationId: string,
    runId: string,
    cursorValue?: string,
    limit = 50,
    maxBytes = CONVERSATION_V2_DEFAULT_MAX_BYTES,
    toolCallId?: string,
    agentInstanceId?: string,
  ): ConversationToolsPage {
    return this.readTransaction(() => {
      const stream = this.requireExistingStream(conversationId);
      const cursor = cursorValue ? decodeConversationCursor(cursorValue, "tools") : undefined;
      this.validateCursor(cursor, stream);
      const safeLimit = normalizeLimit(limit, CONVERSATION_V2_MAX_PAGE_SIZE);
      const safeBytes = normalizeBytes(maxBytes);
      const baseParams: Array<string | number> = [conversationId, runId];
      let where = `conversation_id = ? AND run_id = ?`;
      if (toolCallId) {
        where += ` AND tool_call_id = ?`;
        baseParams.push(toolCallId);
      }
      if (agentInstanceId) {
        where += ` AND agent_instance_id = ?`;
        baseParams.push(agentInstanceId);
      }
      let totalCount: number;
      if (!toolCallId && !agentInstanceId) {
        const cached = this.db
          .prepare(
            `SELECT tool_count AS count FROM conversation_runs_v2
              WHERE conversation_id = ? AND run_id = ?`,
          )
          .get(conversationId, runId) as { count?: number } | undefined;
        if (cached) {
          totalCount = Number(cached.count ?? 0);
        } else {
          const fallback = this.db
            .prepare(`SELECT COUNT(*) AS count FROM conversation_tool_calls_v2 WHERE ${where}`)
            .get(...baseParams) as { count?: number } | undefined;
          totalCount = Number(fallback?.count ?? 0);
        }
      } else {
        const filtered = this.db
          .prepare(`SELECT COUNT(*) AS count FROM conversation_tool_calls_v2 WHERE ${where}`)
          .get(...baseParams) as { count?: number } | undefined;
        totalCount = Number(filtered?.count ?? 0);
      }
      const params = [...baseParams];
      if (cursor) {
        where += ` AND (created_seq < ? OR (created_seq = ? AND tool_call_id < ?))`;
        params.push(cursor.createdSeq, cursor.createdSeq, cursor.id);
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM conversation_tool_calls_v2
           WHERE ${where}
           ORDER BY created_seq DESC, tool_call_id DESC LIMIT ?`,
        )
        .all(...params, safeLimit + 1) as unknown as ToolRow[];
      let selected = fitPage(rows.map(rowToTool).map(limitConversationToolSummaryPayload), safeLimit, safeBytes);
      const buildPage = (pageTools: readonly ConversationToolCall[]): ConversationToolsPage => {
        const last = pageTools.at(-1);
        const hasMore = rows.length > pageTools.length;
        return {
          protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
          storeEpoch: stream.store_epoch,
          conversationId,
          runId,
          readSeq: stream.last_seq,
          historyRevision: stream.history_revision,
          tools: [...pageTools].reverse(),
          totalCount,
          ...(last && hasMore
            ? {
                nextCursor: encodeConversationCursor({
                  kind: "tools",
                  storeEpoch: stream.store_epoch,
                  historyRevision: stream.history_revision,
                  createdSeq: last.createdSeq,
                  id: last.toolCallId,
                }),
              }
            : {}),
          hasMore,
        };
      };
      let response = buildPage(selected);
      while (estimateConversationBytes(response) > safeBytes && selected.length > 1) {
        selected = selected.slice(0, -1);
        response = buildPage(selected);
      }
      if (estimateConversationBytes(response) > safeBytes) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.payloadTooLarge,
          "The Conversation V2 tool summary page exceeds maxBytes.",
        );
      }
      return response;
    });
  }

  sync(
    conversationId: string,
    storeEpoch: string,
    afterSeq: number,
    throughSeq?: number,
    maxEvents = 200,
    maxBytes = CONVERSATION_V2_DEFAULT_MAX_BYTES,
  ): ConversationSyncPage {
    return this.readTransaction(() => {
      const stream = this.requireExistingStream(conversationId);
      if (storeEpoch !== stream.store_epoch) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.epochMismatch,
          "Conversation store epoch does not match.",
          {
            expected: stream.store_epoch,
          },
        );
      }
      if (!Number.isInteger(afterSeq) || afterSeq < 0 || afterSeq > stream.last_seq) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.rangeUnavailable,
          "Requested sync range is unavailable.",
        );
      }
      const target = Math.min(throughSeq === undefined ? stream.last_seq : throughSeq, stream.last_seq);
      if (!Number.isInteger(target) || target < afterSeq) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.invalidParams,
          "throughSeq must be after afterSeq.",
        );
      }
      const safeEvents = normalizeLimit(maxEvents, CONVERSATION_V2_MAX_SYNC_EVENTS);
      const safeBytes = normalizeBytes(maxBytes);
      const rows = this.db
        .prepare(
          `SELECT conversation_id, seq, effect_version, effect_hash, effect_json
           FROM conversation_sync_effects_v2
           WHERE conversation_id = ? AND seq > ? AND seq <= ?
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(conversationId, afterSeq, target, safeEvents + 1) as unknown as EffectRow[];
      if (target > afterSeq && (rows.length === 0 || rows[0]!.seq !== afterSeq + 1)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          "Conversation V2 effect range is not contiguous.",
          { expectedSeq: afterSeq + 1, actualSeq: rows[0]?.seq },
        );
      }
      const effects: ConversationSyncEffect[] = [];
      let bytes = 0;
      let expectedSeq = afterSeq + 1;
      for (const row of rows.slice(0, safeEvents)) {
        this.validateEffectRow(row, expectedSeq);
        expectedSeq += 1;
        const effect = rowToEffect(row);
        const effectBytes = estimateConversationBytes(effect);
        if (effects.length > 0 && bytes + effectBytes > safeBytes) break;
        if (effects.length === 0 && effectBytes > safeBytes) {
          throw new ConversationV2Error(
            CONVERSATION_V2_ERROR.payloadTooLarge,
            "The first sync effect exceeds maxBytes.",
          );
        }
        effects.push(effect);
        bytes += effectBytes;
      }
      const through = effects.at(-1)?.seq ?? afterSeq;
      return {
        protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
        storeEpoch: stream.store_epoch,
        conversationId,
        fromSeq: afterSeq + 1,
        throughSeq: through,
        headSeq: stream.last_seq,
        hasMore: through < stream.last_seq || rows.length > effects.length,
        effects,
      };
    });
  }

  /**
   * Feed skeletons are a V2 read cache, never a second source of conversation facts.
   * Keep the row API raw so the desktop projection package can own its snapshot shape
   * without making this storage layer depend on renderer-only types.
   */
  getFeedSkeletonRow(conversationId: string): FeedSkeletonRow | undefined {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    return this.db
      .prepare(
        `SELECT conversation_id, history_revision, max_event_sequence,
                snapshot_json, auxiliary_json, updated_at
         FROM conversation_feed_skeletons_v2
         WHERE conversation_id = ?`,
      )
      .get(id) as FeedSkeletonRow | undefined;
  }

  saveFeedSkeletonRow(input: {
    conversationId: string;
    historyRevision: number;
    maxEventSequence: number;
    snapshotJson: string;
    auxiliaryJson?: string | null;
    updatedAt: string;
  }): void {
    this.ensureInitialized();
    const conversationId = requireText(input.conversationId, "conversationId");
    if (!Number.isSafeInteger(input.historyRevision) || input.historyRevision < 0) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        "Feed skeleton history revision must be a non-negative integer.",
      );
    }
    if (!Number.isSafeInteger(input.maxEventSequence) || input.maxEventSequence < 0) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        "Feed skeleton max event sequence must be a non-negative integer.",
      );
    }
    const snapshotJson = requireText(input.snapshotJson, "snapshotJson");
    const updatedAt = requireText(input.updatedAt, "updatedAt");
    this.db
      .prepare(
        `INSERT INTO conversation_feed_skeletons_v2 (
           conversation_id, history_revision, max_event_sequence,
           snapshot_json, auxiliary_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           history_revision = excluded.history_revision,
           max_event_sequence = excluded.max_event_sequence,
           snapshot_json = excluded.snapshot_json,
           auxiliary_json = excluded.auxiliary_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        conversationId,
        input.historyRevision,
        input.maxEventSequence,
        snapshotJson,
        input.auxiliaryJson ?? null,
        updatedAt,
      );
  }

  touchFeedSkeletonSequence(conversationId: string, maxEventSequence: number, updatedAt: string): void {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    if (!Number.isSafeInteger(maxEventSequence) || maxEventSequence < 0) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        "Feed skeleton max event sequence must be a non-negative integer.",
      );
    }
    this.db
      .prepare(
        `UPDATE conversation_feed_skeletons_v2
            SET max_event_sequence = ?, updated_at = ?
          WHERE conversation_id = ?`,
      )
      .run(maxEventSequence, requireText(updatedAt, "updatedAt"), id);
  }

  deleteFeedSkeleton(conversationId: string): void {
    this.ensureInitialized();
    this.db
      .prepare(`DELETE FROM conversation_feed_skeletons_v2 WHERE conversation_id = ?`)
      .run(requireText(conversationId, "conversationId"));
  }

  getMessage(conversationId: string, messageId: string): ConversationMessage | undefined {
    const id = this.requireExistingStream(conversationId).conversation_id;
    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, turn_id, run_id, role, channel,
                created_seq, version_seq, content_version, body, attachments_json,
                origin_json,
                agent_id, agent_instance_id, occurred_at, provider_role,
                history_activity_line_id, history_user_message_id,
                status, is_deleted
         FROM conversation_messages_v2 WHERE conversation_id = ? AND message_id = ?`,
      )
      .get(id, messageId) as MessageRow | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  /** Read the durable user-message projection without consulting the legacy tables. */
  listUserMessages(conversationId: string): ConversationMessage[] {
    return this.readTransaction(() => {
      const id = this.requireExistingStream(conversationId).conversation_id;
      const rows = this.db
        .prepare(
          `SELECT * FROM conversation_messages_v2
           WHERE conversation_id = ? AND role = 'user' AND is_deleted = 0
           ORDER BY created_seq ASC, message_id ASC`,
        )
        .all(id) as unknown as MessageRow[];
      return rows.map(rowToMessage);
    });
  }

  /** Accepted user messages that have not yet been handed to a runtime. */
  listQueuedUserMessages(): ConversationMessage[] {
    return this.readTransaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM conversation_messages_v2
           WHERE role = 'user' AND status = 'queued' AND is_deleted = 0
           ORDER BY created_seq ASC, message_id ASC`,
        )
        .all() as unknown as MessageRow[];
      return rows.map(rowToMessage);
    });
  }

  /**
   * Decide whether a user turn already contains model/tool work that makes a
   * non-rewind retry unsafe.  This is deliberately a V2-owned query: retry
   * gating must keep working after the legacy projection tables are retired.
   * Accept either the durable V2 message id or the provider history target.
   * Early provider failures may never receive a provider history target.
   * Missing or ambiguous user identity is treated as blocking so callers
   * cannot turn an incomplete migration into a destructive retry.
   */
  hasRetryBlockingProgress(conversationId: string, activityLineId: string): boolean {
    return this.readTransaction(() => {
      const id = this.requireExistingStream(conversationId).conversation_id;
      const activity = requireText(activityLineId, "activityLineId");
      const targetRows = this.db
        .prepare(
          `SELECT created_seq
             FROM conversation_messages_v2
            WHERE conversation_id = ?
              AND role = 'user'
              AND is_deleted = 0
              AND (message_id = ? OR history_activity_line_id = ?)
            ORDER BY created_seq ASC, message_id ASC`,
        )
        .all(id, activity, activity) as Array<{ created_seq?: unknown }>;
      // A retry without one and only one durable V2 target cannot prove which
      // turn the caller means. Refuse it instead of consulting V1 or guessing.
      if (targetRows.length !== 1) return true;
      const startSeq = rowPositiveInteger(targetRows[0]?.created_seq, "retry.target.created_seq");
      const nextUser = this.db
        .prepare(
          `SELECT MIN(created_seq) AS created_seq
             FROM conversation_messages_v2
            WHERE conversation_id = ?
              AND role = 'user'
              AND is_deleted = 0
              AND created_seq > ?`,
        )
        .get(id, startSeq) as { created_seq?: unknown } | undefined;
      const endSeq =
        nextUser?.created_seq === null || nextUser?.created_seq === undefined
          ? Number.MAX_SAFE_INTEGER
          : rowPositiveInteger(nextUser.created_seq, "retry.next_user.created_seq");

      const hasMessageProgress = this.db
        .prepare(
          `SELECT 1 AS present
             FROM conversation_messages_v2
            WHERE conversation_id = ?
              AND created_seq > ?
              AND created_seq < ?
              AND is_deleted = 0
              AND role <> 'user'
              AND channel <> 'system'
              AND (length(body) > 0 OR agent_id IS NOT NULL)
            LIMIT 1`,
        )
        .get(id, startSeq, endSeq);
      if (hasMessageProgress) return true;

      const hasToolProgress = this.db
        .prepare(
          `SELECT 1 AS present
             FROM conversation_tool_calls_v2
            WHERE conversation_id = ?
              AND created_seq > ?
              AND created_seq < ?
            LIMIT 1`,
        )
        .get(id, startSeq, endSeq);
      if (hasToolProgress) return true;

      // File changes may be represented as a detail item without a tool row
      // (for example an approval bridge can persist the change before the
      // provider emits its terminal tool fact). Keep that V2-only evidence
      // blocking as well.
      const hasFileChange = this.db
        .prepare(
          `SELECT 1 AS present
             FROM conversation_detail_items_v2
            WHERE conversation_id = ?
              AND created_seq > ?
              AND created_seq < ?
              AND lower(type) IN ('filechange', 'file_change', 'file-change')
            LIMIT 1`,
        )
        .get(id, startSeq, endSeq);
      return Boolean(hasFileChange);
    });
  }

  /** Record a legacy history rewrite without deleting the V2 event log. */
  appendHistoryRewriteInCurrentTransaction(input: {
    conversationId: string;
    eventId: string;
    sourceEventKey: string;
    occurredAt: string;
    type: "history.edited" | "history.deleted";
    affectedMessageIds: readonly string[];
    affectedProviderInputIds?: readonly string[];
    reason: string;
  }): ConversationAppendResult[] {
    this.ensureInitialized();
    const results: ConversationAppendResult[] = [];
    // History rewrites must use explicit identities supplied by the caller.
    // A timestamp range is not a safe association: provider clocks can move
    // backwards and unrelated messages can share the same observed time.
    const affected = [
      ...new Set(input.affectedMessageIds.map((id) => requireText(id, "affectedMessageId"))),
    ].sort();
    results.push(
      this.appendInTransaction({
        conversationId: input.conversationId,
        eventId: input.eventId,
        sourceEventKey: input.sourceEventKey,
        type: input.type,
        occurredAt: input.occurredAt,
        payload: {
          reason: input.reason,
          affectedMessageIds: affected,
          ...(input.affectedProviderInputIds
            ? { affectedProviderInputIds: input.affectedProviderInputIds }
            : {}),
        },
      }),
    );
    for (const messageId of affected) {
      const sourceEventKey = `${input.sourceEventKey}:message:${messageId}`;
      results.push(
        this.appendInTransaction({
          conversationId: input.conversationId,
          eventId: `history_v2_tombstone_${stableHash(sourceEventKey)}`,
          sourceEventKey,
          type: "message.tombstoned",
          occurredAt: input.occurredAt,
          messageId,
          payload: { reason: input.reason },
        }),
      );
    }
    return results;
  }

  appendProviderInputPatch(input: {
    conversationId: string;
    eventId: string;
    sourceEventKey: string;
    occurredAt: string;
    inputIds: readonly string[];
    patch: Record<string, unknown>;
    reason: string;
  }): ConversationAppendResult {
    return this.appendProviderInputPatchInternal(input, false);
  }

  /** Append a provider identity patch while the caller owns the SQLite transaction. */
  appendProviderInputPatchInCurrentTransaction(
    input: {
      conversationId: string;
      eventId: string;
      sourceEventKey: string;
      occurredAt: string;
      inputIds: readonly string[];
      patch: Record<string, unknown>;
      reason: string;
    },
    onAppendResult?: (result: ConversationAppendResult) => void,
  ): ConversationAppendResult {
    return this.appendProviderInputPatchInternal(input, true, onAppendResult);
  }

  private appendProviderInputPatchInternal(
    input: {
      conversationId: string;
      eventId: string;
      sourceEventKey: string;
      occurredAt: string;
      inputIds: readonly string[];
      patch: Record<string, unknown>;
      reason: string;
    },
    inCurrentTransaction: boolean,
    onAppendResult?: (result: ConversationAppendResult) => void,
  ): ConversationAppendResult {
    const ids = [...new Set(input.inputIds.map((id) => requireText(id, "providerInputId")))].sort();
    if (ids.length === 0) {
      throw integrity("Provider input patch has no identities.");
    }
    const event: ConversationEventInput = {
      conversationId: input.conversationId,
      eventId: input.eventId,
      sourceEventKey: input.sourceEventKey,
      type: "noop",
      occurredAt:
        this.existingEventOccurredAt(input.conversationId, input.eventId, input.sourceEventKey) ??
        input.occurredAt,
      payload: {
        reason: "provider.patch",
        patchReason: input.reason,
        inputIds: ids,
        patch: input.patch,
      },
    };
    const historyTarget = providerHistoryTargetPatch(input.patch);
    const messageIds = historyTarget ? this.providerInputMessageIds(input.conversationId, ids) : [];
    const targetEvents = messageIds.map((messageId) => {
      const eventId = `provider_history_target_${stableHash(`${input.sourceEventKey}:${messageId}`)}`;
      const sourceEventKey = `${input.sourceEventKey}:history-target:${messageId}`;
      return {
        conversationId: input.conversationId,
        eventId,
        sourceEventKey,
        type: "message.history_targeted" as const,
        occurredAt:
          this.existingEventOccurredAt(input.conversationId, eventId, sourceEventKey) ?? input.occurredAt,
        messageId,
        payload: { historyTarget },
      };
    });
    if (inCurrentTransaction) {
      const result = this.appendInCurrentTransaction(event);
      onAppendResult?.(result);
      for (const targetEvent of targetEvents) {
        onAppendResult?.(this.appendInCurrentTransaction(targetEvent));
      }
      return result;
    }
    return this.appendBatch([event, ...targetEvents], { verifyExistingIntegrity: true })[0]!;
  }

  private existingEventOccurredAt(
    conversationId: string,
    eventId: string,
    sourceEventKey: string,
  ): string | undefined {
    const row = this.db
      .prepare(
        `SELECT occurred_at FROM conversation_events_v2
         WHERE event_id = ? OR (conversation_id = ? AND source_event_key = ?)
         LIMIT 1`,
      )
      .get(eventId, conversationId, sourceEventKey) as { occurred_at?: string } | undefined;
    return row?.occurred_at;
  }

  private providerInputMessageIds(conversationId: string, inputIds: readonly string[]): string[] {
    const ids = new Set<string>();
    const select = this.db.prepare(
      `SELECT message_id, message, source_json
         FROM conversation_provider_inputs_v2
        WHERE conversation_id = ? AND input_id = ?`,
    );
    const hasUserMessage = this.db.prepare(
      `SELECT 1 FROM conversation_messages_v2
        WHERE conversation_id = ? AND message_id = ? AND role = 'user'`,
    );
    const byBody = this.db.prepare(
      `SELECT message_id FROM conversation_messages_v2
        WHERE conversation_id = ? AND role = 'user' AND body = ?`,
    );
    for (const inputId of inputIds) {
      const row = select.get(conversationId, inputId) as
        | { message_id?: string | null; message?: string | null; source_json?: string | null }
        | undefined;
      if (!row) continue;
      let resolved = false;
      const directMessageId = row.message_id?.trim();
      if (directMessageId && hasUserMessage.get(conversationId, directMessageId)) {
        ids.add(directMessageId);
        resolved = true;
      }
      try {
        if (!resolved && row.source_json) {
          const source = JSON.parse(row.source_json) as Record<string, unknown>;
          const metadata = source.metadata;
          const candidate =
            metadata && typeof metadata === "object" && !Array.isArray(metadata)
              ? (metadata as Record<string, unknown>).conversationV2MessageId
              : undefined;
          const candidateId = typeof candidate === "string" ? candidate.trim() : "";
          if (candidateId && hasUserMessage.get(conversationId, candidateId)) {
            ids.add(candidateId);
            resolved = true;
          }
        }
      } catch {
        // The patch reducer will report malformed source JSON. Do not invent an identity here.
      }
      if (!resolved && typeof row.message === "string") {
        const candidates = byBody.all(conversationId, row.message) as Array<{ message_id: string }>;
        // Exact text is a proof only when it identifies one V2 user row. Repeated
        // prompts remain deliberately ambiguous and are left without a target.
        if (candidates.length === 1) ids.add(candidates[0]!.message_id);
      }
    }
    return [...ids].sort();
  }

  appendUsageLedgerEvent(row: ConversationV2UsageLedgerRow): boolean {
    this.ensureInitialized();
    this.requireExistingStream(row.conversation_id);
    this.beginWrite();
    try {
      const inserted = this.appendUsageLedgerEventInCurrentTransaction(row);
      this.db.exec("COMMIT");
      return inserted;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error if SQLite already rolled back the transaction.
      }
      throw error;
    }
  }

  appendUsageLedgerEventInCurrentTransaction(row: ConversationV2UsageLedgerRow): boolean {
    this.ensureInitialized();
    this.requireExistingStream(row.conversation_id);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_usage_ledger_events_v2 (
           conversation_id, id, idempotency_key, run_attempt_id, agent_id, parent_tool_use_id,
           source, source_event_id, request_key, provider_request_id, sdk_message_id,
           usage_kind, role, model_id,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
           reported_cost_usd, attribution_json, metadata_json, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.conversation_id,
        row.id,
        row.idempotency_key,
        row.run_attempt_id,
        row.agent_id,
        row.parent_tool_use_id,
        row.source,
        row.source_event_id,
        row.request_key,
        row.provider_request_id,
        row.sdk_message_id,
        row.usage_kind,
        row.role,
        row.model_id,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_creation_tokens,
        row.reasoning_tokens,
        row.reported_cost_usd,
        row.attribution_json,
        row.metadata_json,
        row.observed_at,
      ) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  listUsageLedgerEventRows(conversationId: string): ConversationV2UsageLedgerRow[] {
    this.ensureInitialized();
    const id = this.requireExistingStream(conversationId).conversation_id;
    return this.db
      .prepare(
        `SELECT conversation_id, id, idempotency_key, run_attempt_id, agent_id, parent_tool_use_id,
                source, source_event_id, request_key, provider_request_id, sdk_message_id,
                usage_kind, role, model_id,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                reported_cost_usd, attribution_json, metadata_json, observed_at
           FROM conversation_usage_ledger_events_v2
          WHERE conversation_id = ?
          ORDER BY observed_at ASC, id ASC`,
      )
      .all(id) as unknown as ConversationV2UsageLedgerRow[];
  }

  /**
   * Repair historical ledger rows whose agent identity can be proven by the V2
   * agent registry. Rows with an explicit parent tool require a unique matching
   * `(parent_tool_call_id, run_attempt_id, role)`; rows without one may use a
   * unique `(run_attempt_id, role)` match. Ambiguous or conflicting rows stay
   * untouched so a maintenance pass cannot invent billing ownership. This
   * updates the ledger projection in place and never appends a conversation
   * event.
   */
  reconcileUsageLedgerAgentAttribution(conversationId: string): {
    scanned: number;
    attributed: number;
    ambiguous: number;
  } {
    this.ensureInitialized();
    const id = this.requireExistingStream(conversationId).conversation_id;
    const rows = this.db
      .prepare(
        `SELECT id, run_attempt_id, parent_tool_use_id, role, attribution_json
           FROM conversation_usage_ledger_events_v2
          WHERE conversation_id = ? AND agent_id IS NULL
          ORDER BY observed_at ASC, id ASC`,
      )
      .all(id) as Array<{
      id: string;
      run_attempt_id: string | null;
      parent_tool_use_id: string | null;
      role: string;
      attribution_json: string;
    }>;
    if (rows.length === 0) return { scanned: 0, attributed: 0, ambiguous: 0 };

    const agents = this.db
      .prepare(
        `SELECT agent_instance_id, agent_id, run_id, parent_tool_call_id, role
           FROM conversation_agents_v2
          WHERE conversation_id = ? AND run_id IS NOT NULL`,
      )
      .all(id) as Array<{
      agent_instance_id: string;
      agent_id: string | null;
      run_id: string;
      parent_tool_call_id: string | null;
      role: string;
    }>;
    const byRunAndRole = new Map<string, Set<string>>();
    const byParentToolAndRole = new Map<string, Set<string>>();
    const agentRunById = new Map<string, string>();
    for (const agent of agents) {
      const agentId = agent.agent_id?.trim() || agent.agent_instance_id.trim();
      const runId = agent.run_id.trim();
      const role = agent.role.trim();
      if (!agentId || !runId || !role) continue;
      agentRunById.set(agentId, runId);
      const key = `${runId}\u001f${role}`;
      const candidates = byRunAndRole.get(key) ?? new Set<string>();
      candidates.add(agentId);
      byRunAndRole.set(key, candidates);
      const parentToolCallId = agent.parent_tool_call_id?.trim();
      if (parentToolCallId) {
        const parentCandidates =
          byParentToolAndRole.get(`${parentToolCallId}\u001f${role}`) ?? new Set<string>();
        parentCandidates.add(agentId);
        byParentToolAndRole.set(`${parentToolCallId}\u001f${role}`, parentCandidates);
      }
    }

    let attributed = 0;
    let ambiguous = 0;
    this.beginWrite();
    try {
      const update = this.db.prepare(
        `UPDATE conversation_usage_ledger_events_v2
            SET agent_id = ?, attribution_json = ?
          WHERE conversation_id = ? AND id = ? AND agent_id IS NULL`,
      );
      for (const row of rows) {
        const runId = row.run_attempt_id?.trim();
        if (!runId) continue;
        let attribution: { status?: unknown };
        try {
          const parsed: unknown = JSON.parse(row.attribution_json);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          attribution = parsed as { status?: unknown };
        } catch {
          continue;
        }
        if (attribution.status !== "pending" && attribution.status !== "unattributed") continue;
        const role = row.role.trim();
        const parentToolUseId = row.parent_tool_use_id?.trim();
        let candidates: Set<string> | undefined;
        if (parentToolUseId) {
          const parentCandidates = byParentToolAndRole.get(`${parentToolUseId}\u001f${role}`);
          if (parentCandidates) {
            candidates = new Set(
              [...parentCandidates].filter((agentId) => agentRunById.get(agentId) === runId),
            );
          }
          // An explicit parent identity is evidence that must agree with the
          // registry. Never fall back to role-only matching when it is absent
          // or belongs to another run; doing so could bill the wrong agent.
        } else {
          candidates = byRunAndRole.get(`${runId}\u001f${role}`);
        }
        if (!candidates || candidates.size === 0) continue;
        if (candidates.size !== 1) {
          ambiguous += 1;
          continue;
        }
        const agentId = [...candidates][0];
        if (!agentId) continue;
        const result = update.run(agentId, JSON.stringify({ status: "attributed", agentId }), id, row.id) as {
          changes?: number;
        };
        if ((result.changes ?? 0) > 0) attributed += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error if SQLite already rolled back.
      }
      throw error;
    }
    return { scanned: rows.length, attributed, ambiguous };
  }

  updateUsageLedgerEventAttributionInCurrentTransaction(
    conversationId: string,
    eventId: string,
    input: {
      agentId: string | null;
      role?: string;
      parentToolUseId?: string;
      attributionJson: string;
      metadataJson?: string;
    },
  ): boolean {
    this.ensureInitialized();
    this.requireExistingStream(conversationId);
    const result = this.db
      .prepare(
        `UPDATE conversation_usage_ledger_events_v2
            SET agent_id = ?,
                role = COALESCE(?, role),
                parent_tool_use_id = COALESCE(?, parent_tool_use_id),
                attribution_json = ?,
                metadata_json = COALESCE(?, metadata_json)
          WHERE conversation_id = ? AND id = ?`,
      )
      .run(
        input.agentId,
        input.role ?? null,
        input.parentToolUseId ?? null,
        input.attributionJson,
        input.metadataJson ?? null,
        conversationId,
        eventId,
      ) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  deleteUsageLedgerEventsFromInCurrentTransaction(conversationId: string, observedAt: string): number {
    this.ensureInitialized();
    this.requireExistingStream(conversationId);
    const result = this.db
      .prepare(
        `DELETE FROM conversation_usage_ledger_events_v2
          WHERE conversation_id = ? AND observed_at >= ?`,
      )
      .run(conversationId, observedAt) as { changes?: number };
    return result.changes ?? 0;
  }

  clearUsageLedgerInCurrentTransaction(conversationId: string): number {
    this.ensureInitialized();
    this.requireExistingStream(conversationId);
    const result = this.db
      .prepare(`DELETE FROM conversation_usage_ledger_events_v2 WHERE conversation_id = ?`)
      .run(conversationId) as { changes?: number };
    return result.changes ?? 0;
  }

  deleteConversationInCurrentTransaction(conversationId: string): void {
    this.ensureInitialized();
    for (const table of [
      "conversation_command_checkpoints_v2",
      "conversation_command_jobs_v2",
      "conversation_command_receipts_v2",
      "conversation_usage_ledger_events_v2",
      "conversation_provider_inputs_v2",
      "conversation_feed_skeletons_v2",
      "conversation_pending_plans_v2",
      "conversation_agents_v2",
      "conversation_sync_effects_v2",
      "conversation_detail_items_v2",
      "conversation_todos_v2",
      "conversation_tool_calls_v2",
      "conversation_turns_v2",
      "conversation_runs_v2",
      "conversation_messages_v2",
      "conversation_events_v2",
      "conversation_streams_v2",
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE conversation_id = ?`).run(conversationId);
    }
  }

  /**
   * Preserve an already-written native V2 event before a maintenance rebuild.
   *
   * The canonical event log is intentionally rebuilt from the immutable V1 input,
   * but native facts must remain addressable after the six legacy tables are retired.
   * This table is an append-only V2 audit/facts ledger; it is never used as a V1
   * fallback and is excluded from `deleteConversationInCurrentTransaction` so a
   * rebuild cannot silently discard the original payload or attachment references.
   */
  persistNativeFactInCurrentTransaction(fact: ConversationNativeFact): void {
    this.ensureInitialized();
    const conversationId = requireText(fact.conversationId, "conversationId");
    const eventId = requireText(fact.eventId, "nativeFact.eventId");
    const disposition = fact.disposition;
    if (!new Set(["equivalent", "collapsed", "modified", "unmatched"]).has(disposition)) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        `Invalid native fact disposition: ${String(disposition)}`,
      );
    }
    const existing = this.db
      .prepare(
        `SELECT payload_hash, event_hash, payload_json, disposition, reconciliation_reason
           FROM conversation_native_facts_v2
          WHERE conversation_id = ? AND event_id = ?`,
      )
      .get(conversationId, eventId) as
      | {
          payload_hash: string;
          event_hash: string;
          payload_json: string;
          disposition: string;
          reconciliation_reason: string | null;
        }
      | undefined;
    if (existing) {
      if (
        existing.payload_hash !== fact.payloadHash ||
        existing.event_hash !== fact.eventHash ||
        existing.payload_json !== fact.payloadJson ||
        existing.disposition !== disposition ||
        existing.reconciliation_reason !== (fact.reconciliationReason ?? null)
      ) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Native fact ${eventId} changed during maintenance reconciliation.`,
          { conversationId, eventId },
        );
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO conversation_native_facts_v2
         (conversation_id, native_seq, event_id, type, turn_id, run_id, message_id, tool_call_id,
          agent_id, agent_instance_id, parent_agent_instance_id, parent_agent_id, parent_tool_call_id,
          occurred_at, recorded_at, schema_version, source_event_key, payload_json, payload_hash,
          event_hash, disposition, matched_source_id, reconciliation_reason, attachment_summary_json,
          stored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversationId,
        fact.nativeSeq,
        eventId,
        requireText(fact.type, "nativeFact.type"),
        fact.turnId ?? null,
        fact.runId ?? null,
        fact.messageId ?? null,
        fact.toolCallId ?? null,
        fact.agentId ?? null,
        fact.agentInstanceId ?? null,
        fact.parentAgentInstanceId ?? null,
        fact.parentAgentId ?? null,
        fact.parentToolCallId ?? null,
        requireText(fact.occurredAt, "nativeFact.occurredAt"),
        requireText(fact.recordedAt, "nativeFact.recordedAt"),
        fact.schemaVersion,
        fact.sourceEventKey ?? null,
        requireText(fact.payloadJson, "nativeFact.payloadJson"),
        requireText(fact.payloadHash, "nativeFact.payloadHash"),
        requireText(fact.eventHash, "nativeFact.eventHash"),
        disposition,
        fact.matchedSourceId ?? null,
        fact.reconciliationReason ?? null,
        requireText(fact.attachmentSummaryJson, "nativeFact.attachmentSummaryJson"),
        this.now(),
      );
  }

  /** Return preserved native facts for maintenance audit and post-cutover checks. */
  listNativeFacts(conversationId?: string): ConversationNativeFact[] {
    this.ensureInitialized();
    const rows = (
      conversationId
        ? this.db
            .prepare(
              `SELECT conversation_id, native_seq, event_id, type, turn_id, run_id, message_id,
                    tool_call_id, agent_id, agent_instance_id, parent_agent_instance_id,
                    parent_agent_id, parent_tool_call_id, occurred_at, recorded_at, schema_version,
                    source_event_key, payload_json, payload_hash, event_hash, disposition,
                    matched_source_id, reconciliation_reason, attachment_summary_json
               FROM conversation_native_facts_v2
              WHERE conversation_id = ? ORDER BY native_seq ASC`,
            )
            .all(conversationId)
        : this.db
            .prepare(
              `SELECT conversation_id, native_seq, event_id, type, turn_id, run_id, message_id,
                    tool_call_id, agent_id, agent_instance_id, parent_agent_instance_id,
                    parent_agent_id, parent_tool_call_id, occurred_at, recorded_at, schema_version,
                    source_event_key, payload_json, payload_hash, event_hash, disposition,
                    matched_source_id, reconciliation_reason, attachment_summary_json
               FROM conversation_native_facts_v2 ORDER BY conversation_id ASC, native_seq ASC`,
            )
            .all()
    ) as Array<{
      conversation_id: string;
      native_seq: number;
      event_id: string;
      type: string;
      turn_id: string | null;
      run_id: string | null;
      message_id: string | null;
      tool_call_id: string | null;
      agent_id: string | null;
      agent_instance_id: string | null;
      parent_agent_instance_id: string | null;
      parent_agent_id: string | null;
      parent_tool_call_id: string | null;
      occurred_at: string;
      recorded_at: string;
      schema_version: number;
      source_event_key: string | null;
      payload_json: string;
      payload_hash: string;
      event_hash: string;
      disposition: ConversationNativeFact["disposition"];
      matched_source_id: string | null;
      reconciliation_reason: string | null;
      attachment_summary_json: string;
    }>;
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      nativeSeq: row.native_seq,
      eventId: row.event_id,
      type: row.type,
      turnId: row.turn_id,
      runId: row.run_id,
      messageId: row.message_id,
      toolCallId: row.tool_call_id,
      agentId: row.agent_id,
      agentInstanceId: row.agent_instance_id,
      parentAgentInstanceId: row.parent_agent_instance_id,
      parentAgentId: row.parent_agent_id,
      parentToolCallId: row.parent_tool_call_id,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      schemaVersion: row.schema_version,
      sourceEventKey: row.source_event_key,
      payloadJson: row.payload_json,
      payloadHash: row.payload_hash,
      eventHash: row.event_hash,
      disposition: row.disposition,
      matchedSourceId: row.matched_source_id,
      reconciliationReason: row.reconciliation_reason,
      attachmentSummaryJson: row.attachment_summary_json,
    }));
  }

  /**
   * Remove rebuildable V2 rows while retaining the native facts ledger.
   * Command state is deliberately checked by the caller before this method: a command
   * receipt is a user action fact and cannot be reconstructed from the V1 mirror.
   */
  resetConversationForMaintenanceInCurrentTransaction(conversationId: string): void {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    for (const table of [
      "conversation_command_checkpoints_v2",
      "conversation_command_jobs_v2",
      "conversation_command_receipts_v2",
      "conversation_usage_ledger_events_v2",
      "conversation_provider_inputs_v2",
      "conversation_feed_skeletons_v2",
      "conversation_agents_v2",
      "conversation_sync_effects_v2",
      "conversation_detail_items_v2",
      "conversation_todos_v2",
      "conversation_tool_calls_v2",
      "conversation_turns_v2",
      "conversation_runs_v2",
      "conversation_messages_v2",
      "conversation_events_v2",
      "conversation_streams_v2",
      "conversation_migrations_v2",
      "conversation_repairs_v2",
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE conversation_id = ?`).run(id);
    }
  }

  getRun(conversationId: string, runId: string): ConversationRun | undefined {
    const id = this.requireExistingStream(conversationId).conversation_id;
    const row = this.db
      .prepare(
        `SELECT run_id, conversation_id, turn_id, status, started_at, ended_at,
                version_seq, timing_quality, retry_of_run_id, regeneration_of_run_id
         FROM conversation_runs_v2 WHERE conversation_id = ? AND run_id = ?`,
      )
      .get(id, runId) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  /**
   * Recover a late runtime event's Eco run from an already persisted provider
   * event in the same Codex turn. The in-memory lifecycle can clear the active
   * attempt before a terminal item notification arrives, so the event itself
   * may have no `runAttemptId`. Only a single durable candidate is safe to use;
   * ambiguous or unknown correlations deliberately return undefined so the
   * runtime boundary still fails loudly instead of inventing ownership.
   */
  resolveRuntimeRunAttemptId(conversationId: string, requestId: string): string | undefined {
    const id = this.requireExistingStream(conversationId).conversation_id;
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) return undefined;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT json_extract(source_json, '$.runAttemptId') AS run_id
         FROM conversation_provider_inputs_v2
         WHERE conversation_id = ?
           AND visible = 1
           AND json_extract(source_json, '$.requestId') = ?
           AND json_extract(source_json, '$.runAttemptId') IS NOT NULL
           AND trim(json_extract(source_json, '$.runAttemptId')) <> ''`,
      )
      .all(id, normalizedRequestId) as Array<{ run_id: string | null }>;
    const candidates = [...new Set(rows.map((row) => row.run_id?.trim()).filter(Boolean))] as string[];
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  getDetail(conversationId: string, itemId: string): ConversationDetailItem | undefined {
    const id = this.requireExistingStream(conversationId).conversation_id;
    const row = this.db
      .prepare(
        `SELECT item_id, conversation_id, run_id, agent_id, agent_instance_id,
                parent_agent_instance_id, parent_agent_id, parent_tool_call_id, tool_call_id, type,
                created_seq, version_seq, content, ref
         FROM conversation_detail_items_v2 WHERE conversation_id = ? AND item_id = ?`,
      )
      .get(id, itemId) as DetailRow | undefined;
    return row ? rowToDetail(row) : undefined;
  }

  rebuildReadModels(conversationId?: string): void {
    this.ensureInitialized();
    this.beginWrite();
    try {
      this.rebuildReadModelsInCurrentTransaction(conversationId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original read/reducer error if SQLite already rolled back the transaction.
      }
      throw error;
    }
  }

  /**
   * Rebuild V2 projections while the caller owns an IMMEDIATE transaction.
   * Maintenance repair uses this to make event-payload normalization and its
   * derived read models one atomic operation; callers must commit or rollback.
   */
  rebuildReadModelsInCurrentTransaction(conversationId?: string): void {
    this.ensureInitialized();
    const target = conversationId === undefined ? undefined : requireText(conversationId, "conversationId");
    const streams = target
      ? (
          this.db
            .prepare(`SELECT * FROM conversation_streams_v2 WHERE conversation_id = ?`)
            .all(target) as unknown as StreamRow[]
        ).map(rowToStream)
      : (this.db.prepare(`SELECT * FROM conversation_streams_v2`).all() as unknown as StreamRow[]).map(
          rowToStream,
        );
    if (target && streams.length === 0) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.conversationNotFound,
        `Conversation V2 stream does not exist: ${target}`,
      );
    }
    const eventsByConversation = new Map<string, EventRow[]>();
    for (const stream of streams) {
      const events = this.db
        .prepare(`SELECT * FROM conversation_events_v2 WHERE conversation_id = ? ORDER BY seq ASC`)
        .all(stream.conversation_id) as unknown as EventRow[];
      this.validateEventLogForReplay(stream, events);
      eventsByConversation.set(stream.conversation_id, events);
    }
    const tables = [
      "conversation_provider_inputs_v2",
      "conversation_agents_v2",
      "conversation_messages_v2",
      "conversation_runs_v2",
      "conversation_turns_v2",
      "conversation_tool_calls_v2",
      "conversation_detail_items_v2",
      "conversation_todos_v2",
      "conversation_sync_effects_v2",
    ];
    for (const table of tables) {
      this.db
        .prepare(target ? `DELETE FROM ${table} WHERE conversation_id = ?` : `DELETE FROM ${table}`)
        .run(...(target ? [target] : []));
    }
    for (const stream of streams) {
      this.db
        .prepare(
          `UPDATE conversation_streams_v2 SET last_seq = 0, history_revision = 0 WHERE conversation_id = ?`,
        )
        .run(stream.conversation_id);
    }
    for (const stream of streams) {
      for (const row of eventsByConversation.get(stream.conversation_id) ?? []) {
        const record = rowToEvent(row);
        const effect = this.applyEvent(record);
        this.insertEffect(record.conversationId, record.seq, effect);
      }
      const rebuiltStream = this.getStream(stream.conversation_id);
      this.db
        .prepare(
          `UPDATE conversation_streams_v2 SET last_seq = ?, history_revision = ? WHERE conversation_id = ?`,
        )
        .run(
          eventsByConversation.get(stream.conversation_id)?.length ?? 0,
          rebuiltStream.history_revision,
          stream.conversation_id,
        );
    }
  }

  validateIntegrity(conversationId: string): {
    headSeq: number;
    eventCount: number;
    effectCount: number;
  } {
    return this.readTransaction(() => {
      const stream = this.requireExistingStream(conversationId);
      const events = this.db
        .prepare(`SELECT * FROM conversation_events_v2 WHERE conversation_id = ? ORDER BY seq ASC`)
        .all(conversationId) as unknown as EventRow[];
      const effects = this.db
        .prepare(`SELECT * FROM conversation_sync_effects_v2 WHERE conversation_id = ? ORDER BY seq ASC`)
        .all(conversationId) as unknown as EffectRow[];
      this.validateEventLogForReplay(stream, events);
      if (effects.length !== events.length) {
        throw integrity("Conversation V2 event/effect counts do not match.");
      }
      for (const [index, row] of effects.entries()) {
        this.validateEffectRow(row, index + 1);
      }
      return {
        headSeq: stream.last_seq,
        eventCount: events.length,
        effectCount: effects.length,
      };
    });
  }

  private appendInTransaction(input: ConversationEventInput): ConversationAppendResult {
    let normalized = normalizeEventInput(input);
    // Most historical event IDs are derived from a 32-bit stableHash. The ID
    // column is global, so two unrelated source keys can occasionally produce
    // the same ID after enough events have accumulated. Resolve that narrow
    // collision without weakening idempotency: the source key remains the
    // authoritative identity, and the alternate ID is deterministic.
    let existing = normalized.sourceEventKey
      ? (this.db
          .prepare(
            `SELECT * FROM conversation_events_v2
             WHERE conversation_id = ? AND source_event_key = ?
             LIMIT 1`,
          )
          .get(normalized.conversationId, normalized.sourceEventKey) as EventRow | undefined)
      : undefined;
    if (existing && existing.event_id !== normalized.eventId && isDerivedEventId(normalized.eventId)) {
      normalized = { ...normalized, eventId: existing.event_id };
    }
    if (!existing) {
      existing = this.db
        .prepare(`SELECT * FROM conversation_events_v2 WHERE event_id = ? LIMIT 1`)
        .get(normalized.eventId) as EventRow | undefined;
      if (
        existing &&
        (existing.conversation_id !== normalized.conversationId ||
          existing.source_event_key !== (normalized.sourceEventKey ?? null)) &&
        normalized.sourceEventKey &&
        isDerivedEventId(normalized.eventId)
      ) {
        const originalEventId = normalized.eventId;
        let collisionAttempt = 0;
        do {
          const resolvedEventId = resolveEventIdCollision(normalized, collisionAttempt);
          logEcoDiag("conversation-v2.event-id-collision", {
            conversationId: normalized.conversationId,
            sourceEventKey: normalized.sourceEventKey,
            originalEventId,
            resolvedEventId,
            existingConversationId: existing.conversation_id,
            existingSequence: existing.seq,
            existingSourceEventKey: existing.source_event_key,
          });
          normalized = { ...normalized, eventId: resolvedEventId };
          existing = this.db
            .prepare(`SELECT * FROM conversation_events_v2 WHERE event_id = ? LIMIT 1`)
            .get(normalized.eventId) as EventRow | undefined;
          collisionAttempt += 1;
        } while (
          existing &&
          (existing.conversation_id !== normalized.conversationId ||
            existing.source_event_key !== (normalized.sourceEventKey ?? null))
        );
      }
    }
    const eventHash = conversationV2EventHash(normalized);
    if (existing) {
      if (existing.event_hash !== eventHash) {
        const conflictDetails = {
          conversationId: normalized.conversationId,
          eventId: normalized.eventId,
          sourceEventKey: normalized.sourceEventKey,
          attemptedType: normalized.type,
          attemptedEventHash: eventHash,
          existingConversationId: existing.conversation_id,
          existingSequence: existing.seq,
          existingEventId: existing.event_id,
          existingSourceEventKey: existing.source_event_key,
          existingType: existing.type,
          existingEventHash: existing.event_hash,
        };
        logEcoDiag("conversation-v2.source-event-conflict", conflictDetails);
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.idempotencyConflict,
          `Source event was replayed with different content (eventId=${normalized.eventId}, existing=${existing.type}@${existing.seq}).`,
          conflictDetails,
        );
      }
      const event = rowToEvent(existing);
      const stream = this.requireExistingStream(event.conversationId);
      this.assertStreamConsistency(stream);
      const effectRow = this.db
        .prepare(
          `SELECT conversation_id, seq, effect_version, effect_hash, effect_json FROM conversation_sync_effects_v2 WHERE conversation_id = ? AND seq = ?`,
        )
        .get(event.conversationId, event.seq) as EffectRow | undefined;
      if (!effectRow)
        throw new ConversationV2Error(CONVERSATION_V2_ERROR.integrityFailure, "Event effect is missing.");
      this.validateEffectRow(effectRow, event.seq);
      return { event, effect: rowToEffect(effectRow), duplicate: true };
    }

    const stream = this.ensureStream(normalized.conversationId);
    this.assertStreamConsistency(stream);
    const seq = stream.last_seq + 1;
    const record: ConversationEventRecord = {
      ...normalized,
      storeEpoch: stream.store_epoch,
      seq,
      recordedAt: this.now(),
      schemaVersion: CONVERSATION_V2_SCHEMA_VERSION,
      payload: normalized.payload ?? {},
      eventHash,
    };
    this.db
      .prepare(
        `INSERT INTO conversation_events_v2
         (conversation_id, store_epoch, seq, event_id, type, turn_id, run_id, message_id,
          tool_call_id, agent_id, agent_instance_id, parent_agent_instance_id, parent_agent_id, parent_tool_call_id, occurred_at, recorded_at, schema_version,
          source_event_key, payload_json, event_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.conversationId,
        record.storeEpoch,
        record.seq,
        record.eventId,
        record.type,
        record.turnId ?? null,
        record.runId ?? null,
        record.messageId ?? null,
        record.toolCallId ?? null,
        record.agentId ?? null,
        record.agentInstanceId ?? null,
        record.parentAgentInstanceId ?? null,
        record.parentAgentId ?? null,
        record.parentToolCallId ?? null,
        record.occurredAt,
        record.recordedAt,
        record.schemaVersion,
        record.sourceEventKey ?? null,
        JSON.stringify(record.payload),
        record.eventHash,
      );
    const effect = JSON.parse(JSON.stringify(this.applyEvent(record))) as ConversationEffect;
    this.insertEffect(record.conversationId, seq, effect);
    this.db
      .prepare(`UPDATE conversation_streams_v2 SET last_seq = ? WHERE conversation_id = ?`)
      .run(seq, record.conversationId);
    return {
      event: record,
      effect: {
        seq,
        effectVersion: CONVERSATION_V2_EFFECT_VERSION,
        effectHash: stableHash(effect),
        effect,
      },
      duplicate: false,
    };
  }

  private applyEvent(record: ConversationEventRecord): ConversationEffect {
    switch (record.type) {
      case "agent.created":
      case "agent.started":
      case "agent.completed":
      case "agent.failed":
      case "agent.cancelled":
      case "agent.interrupted":
        return this.applyAgentLifecycle(record);
      case "message.accepted":
      case "message.created":
        return this.applyMessageCreate(record);
      case "message.delta":
        return this.applyMessageDelta(record);
      case "message.replaced":
        return this.applyMessageReplace(record);
      case "message.finalized":
        return this.applyMessageFinalize(record);
      case "message.history_targeted":
        return this.applyMessageHistoryTarget(record);
      case "message.tombstoned":
        return this.applyMessageTombstone(record);
      case "run.started":
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "run.interrupted":
      case "run.corrected":
        return this.applyRun(record);
      case "tool.started":
      case "tool.updated":
      case "tool.completed":
      case "tool.failed":
        return this.applyTool(record);
      case "detail.upserted":
        return this.applyDetail(record);
      case "approval.requested":
      case "approval.resolved":
      case "clarification.requested":
      case "clarification.resolved":
        return this.applyDetail({ ...record, type: "detail.upserted" });
      case "todo.updated":
        return this.applyTodoList(record);
      case "history.edited":
      case "history.deleted":
      case "history.branch_created":
      case "history.regenerated":
        return this.applyHistoryInvalidation(record);
      case "run.input_appended":
        return {
          type: "detail.invalidation",
          ...(record.runId ? { runId: record.runId } : {}),
        };
      case "noop":
        if (record.payload.reason === "runtime.input") this.applyProviderInput(record);
        if (record.payload.reason === "provider.patch") this.applyProviderInputPatch(record);
        return {
          type: "noop",
          reason: payloadString(record.payload.reason, "reason") ?? "noop",
        };
      default:
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.unsupportedVersion,
          `Unsupported Conversation V2 event type: ${String(record.type)}`,
        );
    }
  }

  private applyMessageCreate(record: ConversationEventRecord): ConversationEffect {
    const messageId = requireEventId(record.messageId ?? record.payload.messageId, "messageId");
    const turnId = requireEventId(record.turnId ?? record.payload.turnId ?? `turn_${messageId}`, "turnId");
    const role = messageRole(record.payload.role);
    const channel = messageChannel(record.payload.channel);
    const status = messageStatus(
      record.payload.status,
      record.type === "message.accepted" ? "queued" : "streaming",
    );
    if (record.type === "message.accepted" && status !== "queued") {
      throw v2Invalid("message.accepted must create a queued message");
    }
    const body =
      payloadString(record.payload.body, "body") ?? payloadString(record.payload.text, "text") ?? "";
    const attachments = optionalPayloadArray(record.payload.attachments, "attachments");
    const origin = parseMessageOrigin(record.payload.origin, "origin");
    if (origin && role !== "user") throw v2Invalid("message origin is only valid for user messages");
    const runId = optionalText(record.runId) ?? optionalPayloadText(record.payload.runId, "runId");
    // Agent ownership is part of a message's identity for display purposes: without
    // it a subagent's narration is indistinguishable from the main agent's.
    const agentId = optionalText(record.agentId) ?? optionalPayloadText(record.payload.agentId, "agentId");
    const agentInstanceId =
      optionalText(record.agentInstanceId) ??
      optionalPayloadText(record.payload.agentInstanceId, "agentInstanceId");
    // The provider's own label for this row (`planner`, `coder`, ...). It is not a
    // rendering of `role`: `role` is the normalized channel role a client switches on,
    // while this is the fact the Feed uses to tell a turn's final output from any other
    // assistant text. The two are stored separately so neither has to guess the other.
    const providerRole = optionalPayloadText(record.payload.providerRole, "providerRole");
    const historyTarget = optionalPayloadHistoryTarget(record.payload.historyTarget, "historyTarget");
    const existing = this.db
      .prepare(`SELECT * FROM conversation_messages_v2 WHERE message_id = ?`)
      .get(messageId) as MessageRow | undefined;
    if (existing) {
      if (existing.conversation_id !== record.conversationId)
        throw integrity("Message belongs to another conversation.");
      if (
        existing.turn_id !== turnId ||
        existing.run_id !== (runId ?? null) ||
        existing.role !== role ||
        existing.channel !== channel ||
        existing.body !== body ||
        !sameJsonValue(parseJson(existing.attachments_json), attachments) ||
        !sameJsonValue(parseJson(existing.origin_json ?? null), origin) ||
        existing.status !== status ||
        (historyTarget?.activityLineId !== undefined &&
          existing.history_activity_line_id !== historyTarget.activityLineId) ||
        (historyTarget?.userMessageId !== undefined &&
          existing.history_user_message_id !== historyTarget.userMessageId) ||
        // Ownership must not drift silently. An event that omits it (a replayed
        // legacy row, or a row whose owner the backfill recovered) is not a change.
        (agentId !== undefined && existing.agent_id !== agentId) ||
        (providerRole !== undefined && existing.provider_role !== providerRole)
      ) {
        throw integrity(`Message ${messageId} was created with conflicting identity or content.`);
      }
      return { type: "message.create", message: rowToMessage(existing) };
    }
    this.db
      .prepare(
        `INSERT INTO conversation_messages_v2
         (message_id, conversation_id, turn_id, run_id, role, channel, created_seq,
          version_seq, content_version, body, attachments_json, origin_json, agent_id,
          agent_instance_id, occurred_at, provider_role, history_activity_line_id,
          history_user_message_id, status, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        messageId,
        record.conversationId,
        turnId,
        runId ?? null,
        role,
        channel,
        record.seq,
        record.seq,
        body,
        attachments === undefined ? null : JSON.stringify(attachments),
        origin === undefined ? null : JSON.stringify(origin),
        agentId ?? null,
        agentInstanceId ?? null,
        record.occurredAt,
        providerRole ?? null,
        historyTarget?.activityLineId ?? null,
        historyTarget?.userMessageId ?? null,
        status,
      );
    this.ensureTurn(record.conversationId, turnId, record.seq, record.seq, runId);
    return {
      type: "message.create",
      message: this.getMessage(record.conversationId, messageId)!,
    };
  }

  private applyMessageDelta(record: ConversationEventRecord): ConversationEffect {
    const messageId = requireEventId(record.messageId ?? record.payload.messageId, "messageId");
    const row = this.getMessageRow(record.conversationId, messageId);
    if (!row) throw integrity(`Message ${messageId} does not exist for delta.`);
    if (TERMINAL_MESSAGE_STATUSES.has(row.status)) {
      return {
        type: "noop",
        reason: `late_message_delta_ignored:${messageId}`,
      };
    }
    const delta = payloadString(record.payload.delta, "delta") ?? payloadString(record.payload.text, "text");
    if (delta === undefined) throw v2Invalid("message.delta requires delta");
    const base =
      optionalInteger(record.payload.baseContentVersion, "baseContentVersion") ?? row.content_version;
    if (base !== row.content_version) throw integrity(`Message ${messageId} content version mismatch.`);
    const next = optionalInteger(record.payload.nextContentVersion, "nextContentVersion") ?? base + 1;
    if (next !== base + 1) throw integrity(`Message ${messageId} next content version is invalid.`);
    const status = TERMINAL_MESSAGE_STATUSES.has(row.status) ? row.status : "streaming";
    this.db
      .prepare(
        `UPDATE conversation_messages_v2 SET body = ?, version_seq = ?, content_version = ?, status = ? WHERE message_id = ?`,
      )
      .run(row.body + delta, record.seq, next, status, messageId);
    return {
      type: "message.append",
      messageId,
      baseContentVersion: base,
      nextContentVersion: next,
      delta,
      versionSeq: record.seq,
    };
  }

  private applyMessageReplace(record: ConversationEventRecord): ConversationEffect {
    const messageId = requireEventId(record.messageId ?? record.payload.messageId, "messageId");
    const row = this.getMessageRow(record.conversationId, messageId);
    if (!row) throw integrity(`Message ${messageId} does not exist for replace.`);
    if (row.status === "deleted" || row.is_deleted === 1) {
      return {
        type: "noop",
        reason: `message_replace_ignored_deleted:${messageId}`,
      };
    }
    if (TERMINAL_MESSAGE_STATUSES.has(row.status)) {
      return {
        type: "noop",
        reason: `late_message_replace_ignored:${messageId}`,
      };
    }
    const base =
      optionalInteger(record.payload.baseContentVersion, "baseContentVersion") ?? row.content_version;
    if (base !== row.content_version) throw integrity(`Message ${messageId} content version mismatch.`);
    const body = payloadString(record.payload.body, "body") ?? payloadString(record.payload.text, "text");
    if (body === undefined) throw v2Invalid("message.replaced requires body");
    const next = optionalInteger(record.payload.nextContentVersion, "nextContentVersion") ?? base + 1;
    if (next <= base) throw integrity(`Message ${messageId} next content version is invalid.`);
    const attachments = optionalPayloadArray(record.payload.attachments, "attachments");
    this.db
      .prepare(
        `UPDATE conversation_messages_v2 SET body = ?, version_seq = ?, content_version = ?,
         attachments_json = COALESCE(?, attachments_json) WHERE message_id = ?`,
      )
      .run(body, record.seq, next, attachments === undefined ? null : JSON.stringify(attachments), messageId);
    return {
      type: "message.replace",
      messageId,
      baseContentVersion: base,
      nextContentVersion: next,
      body,
      versionSeq: record.seq,
      ...(attachments === undefined ? {} : { attachments }),
    };
  }

  private applyMessageFinalize(record: ConversationEventRecord): ConversationEffect {
    const messageId = requireEventId(record.messageId ?? record.payload.messageId, "messageId");
    const row = this.getMessageRow(record.conversationId, messageId);
    if (!row) throw integrity(`Message ${messageId} does not exist for finalize.`);
    if (TERMINAL_MESSAGE_STATUSES.has(row.status) && record.payload.authority !== "maintenance") {
      return {
        type: "noop",
        reason: `late_message_finalize_ignored:${messageId}`,
      };
    }
    const body = payloadString(record.payload.body, "body");
    const nextVersion =
      body !== undefined && body !== row.body ? row.content_version + 1 : row.content_version;
    const requestedStatus = messageStatus(record.payload.status, "final");
    const explicitContentVersion = optionalInteger(record.payload.contentVersion, "contentVersion");
    if (explicitContentVersion !== undefined && explicitContentVersion !== nextVersion) {
      throw integrity(`Message ${messageId} final content version is invalid.`);
    }
    if (requestedStatus !== "final" && requestedStatus !== "failed" && requestedStatus !== "cancelled") {
      throw v2Invalid(`message.finalized cannot use status ${requestedStatus}`);
    }
    const status =
      requestedStatus === "failed" || requestedStatus === "cancelled" ? requestedStatus : "final";
    const attachments = optionalPayloadArray(record.payload.attachments, "attachments");
    this.db
      .prepare(
        `UPDATE conversation_messages_v2
         SET body = COALESCE(?, body), version_seq = ?, content_version = ?, occurred_at = ?,
             attachments_json = COALESCE(?, attachments_json), status = ?, is_deleted = 0
         WHERE message_id = ?`,
      )
      .run(
        body ?? null,
        record.seq,
        nextVersion,
        record.occurredAt,
        attachments === undefined ? null : JSON.stringify(attachments),
        status,
        messageId,
      );
    return {
      type: "message.finalize",
      messageId,
      contentVersion: nextVersion,
      versionSeq: record.seq,
      status,
      occurredAt: record.occurredAt,
      ...(attachments === undefined ? {} : { attachments }),
    };
  }

  private applyMessageTombstone(record: ConversationEventRecord): ConversationEffect {
    const messageId = requireEventId(record.messageId ?? record.payload.messageId, "messageId");
    const row = this.getMessageRow(record.conversationId, messageId);
    if (!row) throw integrity(`Message ${messageId} does not exist for tombstone.`);
    this.db
      .prepare(
        `UPDATE conversation_messages_v2 SET version_seq = ?, status = 'deleted', is_deleted = 1 WHERE message_id = ?`,
      )
      .run(record.seq, messageId);
    return { type: "message.tombstone", messageId, versionSeq: record.seq };
  }

  private applyMessageHistoryTarget(record: ConversationEventRecord): ConversationEffect {
    const messageId = requireEventId(record.messageId ?? record.payload.messageId, "messageId");
    const row = this.getMessageRow(record.conversationId, messageId);
    if (!row) throw integrity(`Message ${messageId} does not exist for history target.`);
    if (row.role !== "user") {
      throw integrity(`Message ${messageId} is not a user message.`);
    }
    const historyTarget = optionalPayloadHistoryTarget(record.payload.historyTarget, "historyTarget");
    if (!historyTarget) throw v2Invalid("message.history_targeted requires historyTarget");
    const promotesLegacyCodexPendingTarget =
      row.history_activity_line_id?.startsWith("codex-pending:") === true &&
      !row.history_user_message_id &&
      historyTarget.activityLineId.startsWith("sdk:") &&
      Boolean(historyTarget.userMessageId);
    if (
      (row.history_activity_line_id && row.history_activity_line_id !== historyTarget.activityLineId) ||
      (row.history_user_message_id && row.history_user_message_id !== (historyTarget.userMessageId ?? null))
    ) {
      if (promotesLegacyCodexPendingTarget) {
        // Older DEV builds persisted the temporary `codex-pending:*` attachment
        // identity as if it were the provider rewind target. It is the only
        // provisional target that may be promoted; all canonical targets remain
        // immutable and still fail closed below.
      } else {
        const existingHistoryTarget = {
          activityLineId: row.history_activity_line_id ?? null,
          userMessageId: row.history_user_message_id ?? null,
        };
        const conflictDetails = {
          conversationId: record.conversationId,
          messageId,
          eventId: record.eventId,
          sequence: record.seq,
          existingHistoryTarget,
          attemptedHistoryTarget: historyTarget,
        };
        logEcoDiag("conversation-v2.history-target-conflict", conflictDetails);
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Message ${messageId} history target changed (existing=${JSON.stringify(existingHistoryTarget)}, attempted=${JSON.stringify(historyTarget)}, eventId=${record.eventId}, seq=${record.seq}).`,
          conflictDetails,
        );
      }
    }
    this.db
      .prepare(
        `UPDATE conversation_messages_v2
            SET history_activity_line_id = ?, history_user_message_id = ?, version_seq = MAX(version_seq, ?)
          WHERE conversation_id = ? AND message_id = ?`,
      )
      .run(
        historyTarget.activityLineId,
        historyTarget.userMessageId ?? null,
        record.seq,
        record.conversationId,
        messageId,
      );
    return {
      type: "message.history_target",
      messageId,
      historyTarget,
      versionSeq: record.seq,
    };
  }

  private applyRun(record: ConversationEventRecord): ConversationEffect {
    const runId = requireEventId(record.runId ?? record.payload.runId, "runId");
    const existing = this.db.prepare(`SELECT * FROM conversation_runs_v2 WHERE run_id = ?`).get(runId) as
      | RunRow
      | undefined;
    if (existing && existing.conversation_id !== record.conversationId) {
      throw integrity(`Run ${runId} belongs to another conversation.`);
    }
    const turnId = requireEventId(record.turnId ?? record.payload.turnId ?? existing?.turn_id, "turnId");
    if (existing && existing.turn_id !== turnId) {
      throw integrity(`Run ${runId} belongs to another turn.`);
    }
    const correctionAuthority = record.type === "run.corrected";
    if (correctionAuthority) {
      validateRunCorrectionPayload(record.payload, existing?.status);
      if (!existing) {
        throw integrity(`Run ${runId} cannot be corrected before it exists.`);
      }
    }
    const incomingStatus = runStatusForEvent(record.type, record.payload.status);
    // The attempt lifecycle is the only authority for a run's outcome: a tool
    // finishing, a replayed legacy row or any other source can be wrong about it
    // and the log has no way to undo that. A lifecycle event therefore corrects an
    // existing status (including a terminal one, which an older build may have
    // closed early), while every other source stays sticky — first terminal wins —
    // so a late duplicate can never rewrite an outcome.
    const lifecycleAuthority = record.payload.authority === "lifecycle" || correctionAuthority;
    if (
      existing &&
      TERMINAL_RUN_STATUSES.has(existing.status) &&
      TERMINAL_RUN_STATUSES.has(incomingStatus) &&
      existing.status !== incomingStatus &&
      !lifecycleAuthority
    ) {
      throw integrity(`Run ${runId} has conflicting terminal statuses.`);
    }
    const status =
      existing && TERMINAL_RUN_STATUSES.has(existing.status) && !lifecycleAuthority
        ? existing.status
        : incomingStatus;
    // A lifecycle event carries the boundaries it recorded; inheriting the
    // mirrored ones would preserve exactly the wrong duration that the correction
    // exists to fix.
    const inheritedStartedAt =
      lifecycleAuthority && !correctionAuthority ? undefined : (existing?.started_at ?? undefined);
    const inheritedEndedAt =
      lifecycleAuthority && !correctionAuthority ? undefined : (existing?.ended_at ?? undefined);
    const startedAt = correctionAuthority
      ? correctionTimestamp(record.payload, "startedAt", inheritedStartedAt ?? record.occurredAt)
      : (payloadString(record.payload.startedAt, "startedAt") ??
        inheritedStartedAt ??
        (record.type === "run.started" ? record.occurredAt : undefined));
    const endedAt = correctionAuthority
      ? TERMINAL_RUN_STATUSES.has(status)
        ? correctionTimestamp(record.payload, "endedAt", inheritedEndedAt ?? record.occurredAt)
        : correctionTimestamp(record.payload, "endedAt", undefined)
      : TERMINAL_RUN_STATUSES.has(status)
        ? (payloadString(record.payload.endedAt, "endedAt") ?? inheritedEndedAt ?? record.occurredAt)
        : (payloadString(record.payload.endedAt, "endedAt") ?? inheritedEndedAt);
    const timingQuality =
      record.payload.timingQuality === undefined
        ? (existing?.timing_quality ?? "recorded")
        : timingQualityValue(record.payload.timingQuality);
    const retryOfRunId = optionalPayloadText(record.payload.retryOfRunId, "retryOfRunId");
    const regenerationOfRunId = optionalPayloadText(
      record.payload.regenerationOfRunId,
      "regenerationOfRunId",
    );
    if (existing?.retry_of_run_id && retryOfRunId && existing.retry_of_run_id !== retryOfRunId) {
      throw integrity(`Run ${runId} changed retry lineage.`);
    }
    if (
      existing?.regeneration_of_run_id &&
      regenerationOfRunId &&
      existing.regeneration_of_run_id !== regenerationOfRunId
    ) {
      throw integrity(`Run ${runId} changed regeneration lineage.`);
    }
    this.db
      .prepare(
        `INSERT INTO conversation_runs_v2
         (run_id, conversation_id, turn_id, status, started_at, ended_at, version_seq,
          timing_quality, retry_of_run_id, regeneration_of_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status, started_at = excluded.started_at, ended_at = excluded.ended_at,
           version_seq = excluded.version_seq, timing_quality = excluded.timing_quality,
           retry_of_run_id = excluded.retry_of_run_id, regeneration_of_run_id = excluded.regeneration_of_run_id`,
      )
      .run(
        runId,
        record.conversationId,
        turnId,
        status,
        startedAt ?? null,
        endedAt ?? null,
        record.seq,
        timingQuality,
        retryOfRunId ?? existing?.retry_of_run_id ?? null,
        regenerationOfRunId ?? existing?.regeneration_of_run_id ?? null,
      );
    this.db
      .prepare(
        `UPDATE conversation_tool_calls_v2
            SET run_known = 1
          WHERE conversation_id = ? AND run_id = ?`,
      )
      .run(record.conversationId, runId);
    this.db
      .prepare(
        `UPDATE conversation_runs_v2
            SET tool_count = (
              SELECT COUNT(*) FROM conversation_tool_calls_v2 tools
               WHERE tools.conversation_id = conversation_runs_v2.conversation_id
                 AND tools.run_id = conversation_runs_v2.run_id
            )
          WHERE conversation_id = ? AND run_id = ?`,
      )
      .run(record.conversationId, runId);
    this.ensureTurn(record.conversationId, turnId, record.seq, record.seq, runId);
    if (TERMINAL_RUN_STATUSES.has(status)) {
      this.db
        .prepare(
          `UPDATE conversation_turns_v2 SET active_run_id = NULL WHERE conversation_id = ? AND turn_id = ? AND active_run_id = ?`,
        )
        .run(record.conversationId, turnId, runId);
    }
    return {
      type: "run.upsert",
      run: this.getRun(record.conversationId, runId)!,
    };
  }

  /**
   * Maintains the agent registry the Feed needs to draw agent cards.
   *
   * Agent lifecycle events used to only invalidate details of their run, which left
   * the read model without the very thing an agent card is made of — role, kind,
   * mission, parent links and terminal status. Every other row that belongs to an
   * agent (message, tool call, detail item) references it as
   * `agent_instance_id`, so that is the registry key; `agent_id` keeps the
   * provider-side identity for display.
   */
  private applyAgentLifecycle(record: ConversationEventRecord): ConversationEffect {
    const agentInstanceId = requireEventId(
      record.agentInstanceId ?? optionalText(record.agentId) ?? record.payload.agentInstanceId,
      "agentInstanceId",
    );
    const existing = this.db
      .prepare(`SELECT * FROM conversation_agents_v2 WHERE agent_instance_id = ?`)
      .get(agentInstanceId) as AgentRow | undefined;
    if (existing && existing.conversation_id !== record.conversationId) {
      throw integrity(`Agent ${agentInstanceId} belongs to another conversation.`);
    }
    const role = payloadString(record.payload.role, "role") ?? existing?.role ?? "subagent";
    const kind =
      payloadString(record.payload.kind, "kind") ??
      existing?.kind ??
      (role === "planner" ? "planner" : "subagent");
    const status = payloadString(record.payload.status, "status") ?? agentStatusForEvent(record.type);
    const terminal = AGENT_TERMINAL_STATUSES.has(status);
    const startedAt =
      payloadString(record.payload.startedAt, "startedAt") ??
      existing?.started_at ??
      (record.type === "agent.created" || record.type === "agent.started" ? record.occurredAt : undefined);
    const endedAt = terminal
      ? (payloadString(record.payload.endedAt, "endedAt") ?? existing?.ended_at ?? record.occurredAt)
      : (payloadString(record.payload.endedAt, "endedAt") ?? existing?.ended_at);
    const mission =
      payloadString(record.payload.mission, "mission") ??
      payloadString(record.payload.delegationPrompt, "delegationPrompt") ??
      existing?.mission;
    const todoId = payloadString(record.payload.todoId, "todoId") ?? existing?.todo_id;
    const taskName = payloadString(record.payload.taskName, "taskName") ?? existing?.task_name;
    const delegationSummary =
      payloadString(record.payload.delegationSummary, "delegationSummary") ?? existing?.delegation_summary;
    const delegationPrompt =
      payloadString(record.payload.delegationPrompt, "delegationPrompt") ?? existing?.delegation_prompt;
    if (
      taskName !== undefined &&
      taskName !== null &&
      delegationSummary !== undefined &&
      delegationSummary !== null
    ) {
      // Both are the card's own text and neither can be re-derived later: the event
      // that carried them stays the authority, so a rewrite has to agree with it.
      const conflict =
        existing?.task_name && existing.task_name !== taskName
          ? `task name ${existing.task_name}`
          : existing?.delegation_summary && existing.delegation_summary !== delegationSummary
            ? `delegation ${existing.delegation_summary}`
            : undefined;
      if (conflict) {
        throw integrity(`Agent ${agentInstanceId} already has ${conflict}.`);
      }
    }
    const parentAgentInstanceId =
      optionalText(record.parentAgentInstanceId) ??
      payloadString(record.payload.parentAgentInstanceId, "parentAgentInstanceId") ??
      existing?.parent_agent_instance_id;
    const parentToolCallId =
      optionalText(record.parentToolCallId) ??
      payloadString(record.payload.parentToolCallId, "parentToolCallId") ??
      existing?.parent_tool_call_id;
    const runId = record.runId ?? existing?.run_id;
    const agentId = optionalText(record.agentId) ?? existing?.agent_id;
    if (
      existing &&
      (existing.role !== role ||
        existing.kind !== kind ||
        (existing.run_id && existing.run_id !== runId) ||
        (existing.parent_agent_instance_id && existing.parent_agent_instance_id !== parentAgentInstanceId) ||
        (existing.parent_tool_call_id && existing.parent_tool_call_id !== parentToolCallId))
    ) {
      throw integrity(`Agent ${agentInstanceId} changed identity or ownership.`);
    }
    if (agentInstanceId === parentAgentInstanceId) throw integrity("Agent cannot be its own parent.");
    this.db
      .prepare(
        `INSERT INTO conversation_agents_v2
         (agent_instance_id, conversation_id, agent_id, role, kind, status, run_id,
          parent_agent_instance_id, parent_tool_call_id, started_at, ended_at, mission,
          todo_id, task_name, delegation_summary, delegation_prompt, version_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_instance_id) DO UPDATE SET
           agent_id = excluded.agent_id, role = excluded.role, kind = excluded.kind,
           status = excluded.status, run_id = excluded.run_id,
           parent_agent_instance_id = excluded.parent_agent_instance_id,
           parent_tool_call_id = excluded.parent_tool_call_id,
           started_at = excluded.started_at, ended_at = excluded.ended_at,
           mission = excluded.mission, todo_id = excluded.todo_id,
           task_name = COALESCE(excluded.task_name, conversation_agents_v2.task_name),
           delegation_summary = COALESCE(
             excluded.delegation_summary, conversation_agents_v2.delegation_summary),
           delegation_prompt = COALESCE(
             excluded.delegation_prompt, conversation_agents_v2.delegation_prompt),
           version_seq = excluded.version_seq`,
      )
      .run(
        agentInstanceId,
        record.conversationId,
        agentId ?? null,
        role,
        kind,
        status,
        runId ?? null,
        parentAgentInstanceId ?? null,
        parentToolCallId ?? null,
        startedAt ?? null,
        endedAt ?? null,
        mission ?? null,
        todoId ?? null,
        taskName ?? null,
        delegationSummary ?? null,
        delegationPrompt ?? null,
        record.seq,
      );
    const agent = this.getAgent(record.conversationId, agentInstanceId);
    if (!agent) throw integrity(`Agent ${agentInstanceId} disappeared after upsert.`);
    return {
      type: "agent.upsert",
      agent,
    };
  }

  private applyTool(record: ConversationEventRecord): ConversationEffect {
    const toolCallId = requireEventId(record.toolCallId ?? record.payload.toolCallId, "toolCallId");
    const runId = requireEventId(record.runId ?? record.payload.runId, "runId");
    const existing = this.db
      .prepare(`SELECT * FROM conversation_tool_calls_v2 WHERE tool_call_id = ?`)
      .get(toolCallId) as ToolRow | undefined;
    if (existing && existing.conversation_id !== record.conversationId) {
      throw integrity(`Tool call ${toolCallId} belongs to another conversation.`);
    }
    if (existing && existing.run_id !== runId) {
      throw integrity(`Tool call ${toolCallId} belongs to another run.`);
    }
    const incomingStatus = toolStatusForEvent(record.type, record.payload.status);
    if (
      existing &&
      TERMINAL_TOOL_STATUSES.has(existing.status) &&
      TERMINAL_TOOL_STATUSES.has(incomingStatus) &&
      existing.status !== incomingStatus
    ) {
      throw integrity(`Tool call ${toolCallId} has conflicting terminal statuses.`);
    }
    const status = existing && TERMINAL_TOOL_STATUSES.has(existing.status) ? existing.status : incomingStatus;
    const incomingName = optionalPayloadText(record.payload.name, "name");
    // A call's name is a label, not its identity. The legacy log can report one call under a
    // placeholder (`MCP: tool`) and then provide its concrete name on the approval row (`Bash`).
    // Keep the call id as the identity and replace only that placeholder; equally specific
    // disagreements keep the first value for deterministic replay.
    const nameConflicts =
      existing !== undefined && incomingName !== undefined && existing.name !== incomingName;
    const name =
      existing && nameConflicts && incomingName
        ? chooseToolName(existing.name, incomingName)
        : (incomingName ?? existing?.name);
    if (
      nameConflicts &&
      incomingName &&
      name === existing?.name &&
      !isGenericToolLabel(existing.name) &&
      !isGenericToolLabel(incomingName)
    ) {
      logEcoDiag("conversation-v2.tool-name-conflict", {
        toolCallId,
        kept: existing?.name,
        incoming: incomingName,
      });
    }
    if (!name) throw v2Invalid("tool event requires name on first write");
    const agentId = optionalText(record.agentId) ?? optionalPayloadText(record.payload.agentId, "agentId");
    const agentInstanceId =
      optionalText(record.agentInstanceId) ??
      optionalPayloadText(record.payload.agentInstanceId, "agentInstanceId");
    const parentAgentInstanceId =
      optionalText(record.parentAgentInstanceId) ??
      optionalPayloadText(record.payload.parentAgentInstanceId, "parentAgentInstanceId");
    const parentToolCallId =
      optionalText(record.parentToolCallId) ??
      optionalPayloadText(record.payload.parentToolCallId, "parentToolCallId");
    // Same fact as on a message row: the provider's own label for the call, kept beside
    // the normalized role instead of replacing it. Unlike ownership it is not immutable —
    // the legacy log really does relabel a call as it moves between agents (a `tool` row
    // that later arrives attributed to the `coder` that ran it), so the latest event wins
    // the same way `status` and `name` do.
    const providerRole = optionalPayloadText(record.payload.providerRole, "providerRole");
    if (existing && agentId && existing.agent_id && existing.agent_id !== agentId) {
      throw integrity(`Tool call ${toolCallId} changed agent ownership.`);
    }
    if (
      existing &&
      agentInstanceId &&
      existing.agent_instance_id &&
      existing.agent_instance_id !== agentInstanceId
    ) {
      throw integrity(`Tool call ${toolCallId} changed agent instance ownership.`);
    }
    if (
      existing &&
      parentAgentInstanceId &&
      existing.parent_agent_instance_id &&
      existing.parent_agent_instance_id !== parentAgentInstanceId
    ) {
      throw integrity(`Tool call ${toolCallId} changed parent agent ownership.`);
    }
    if (
      existing &&
      parentToolCallId &&
      existing.parent_tool_call_id &&
      existing.parent_tool_call_id !== parentToolCallId
    ) {
      throw integrity(`Tool call ${toolCallId} changed parent tool ownership.`);
    }
    const input = record.payload.input ?? (existing ? parseJson(existing.input_json) : undefined);
    const output = record.payload.output ?? (existing ? parseJson(existing.output_json) : undefined);
    const runKnown = Boolean(
      this.db
        .prepare(
          `SELECT 1 AS present FROM conversation_runs_v2
            WHERE conversation_id = ? AND run_id = ?`,
        )
        .get(record.conversationId, runId),
    );
    this.db
      .prepare(
        `INSERT INTO conversation_tool_calls_v2
         (tool_call_id, conversation_id, run_id, agent_id, agent_instance_id, parent_agent_instance_id, parent_tool_call_id, name, status, created_seq, version_seq, input_json, output_json, occurred_at, provider_role, run_known)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tool_call_id) DO UPDATE SET
           agent_id = COALESCE(excluded.agent_id, conversation_tool_calls_v2.agent_id),
           agent_instance_id = COALESCE(excluded.agent_instance_id, conversation_tool_calls_v2.agent_instance_id),
           parent_agent_instance_id = COALESCE(excluded.parent_agent_instance_id, conversation_tool_calls_v2.parent_agent_instance_id),
           parent_tool_call_id = COALESCE(excluded.parent_tool_call_id, conversation_tool_calls_v2.parent_tool_call_id),
           name = excluded.name, status = excluded.status, version_seq = excluded.version_seq,
           input_json = COALESCE(excluded.input_json, conversation_tool_calls_v2.input_json),
           output_json = COALESCE(excluded.output_json, conversation_tool_calls_v2.output_json),
           occurred_at = COALESCE(conversation_tool_calls_v2.occurred_at, excluded.occurred_at),
           provider_role = COALESCE(conversation_tool_calls_v2.provider_role, excluded.provider_role),
           run_known = MAX(conversation_tool_calls_v2.run_known, excluded.run_known)`,
      )
      .run(
        toolCallId,
        record.conversationId,
        runId,
        agentId ?? existing?.agent_id ?? null,
        agentInstanceId ?? existing?.agent_instance_id ?? null,
        parentAgentInstanceId ?? existing?.parent_agent_instance_id ?? null,
        parentToolCallId ?? existing?.parent_tool_call_id ?? null,
        name,
        status,
        existing?.created_seq ?? record.seq,
        record.seq,
        input === undefined ? null : JSON.stringify(input),
        output === undefined ? null : JSON.stringify(output),
        record.occurredAt,
        providerRole ?? existing?.provider_role ?? null,
        runKnown ? 1 : 0,
      );
    if (!existing) {
      this.db
        .prepare(
          `UPDATE conversation_runs_v2
              SET tool_count = tool_count + 1
            WHERE conversation_id = ? AND run_id = ?`,
        )
        .run(record.conversationId, runId);
    }
    return {
      type: "tool.summary.upsert",
      toolCall: this.getTool(record.conversationId, toolCallId)!,
    };
  }

  private applyDetail(record: ConversationEventRecord): ConversationEffect {
    const p = record.payload;
    const itemId = requireEventId(optionalPayloadText(p.itemId, "itemId") ?? record.eventId, "itemId");
    const runId = requireEventId(record.runId ?? p.runId, "runId");
    const existing = this.db
      .prepare(`SELECT * FROM conversation_detail_items_v2 WHERE item_id = ?`)
      .get(itemId) as DetailRow | undefined;
    if (existing && existing.conversation_id !== record.conversationId) {
      throw integrity(`Detail ${itemId} belongs to another conversation.`);
    }
    if (existing && existing.run_id !== runId) {
      throw integrity(`Detail ${itemId} belongs to another run.`);
    }
    const agentId = optionalText(record.agentId) ?? optionalPayloadText(p.agentId, "agentId");
    const agentInstanceId =
      optionalText(record.agentInstanceId) ?? optionalPayloadText(p.agentInstanceId, "agentInstanceId");
    const parentAgentInstanceId =
      optionalText(record.parentAgentInstanceId) ??
      optionalPayloadText(p.parentAgentInstanceId, "parentAgentInstanceId");
    const parentAgentId =
      optionalText(record.parentAgentId) ?? optionalPayloadText(p.parentAgentId, "parentAgentId");
    const parentToolCallId =
      optionalText(record.parentToolCallId) ?? optionalPayloadText(p.parentToolCallId, "parentToolCallId");
    const toolCallId = optionalText(record.toolCallId) ?? optionalPayloadText(p.toolCallId, "toolCallId");
    if (existing && agentId && existing.agent_id && existing.agent_id !== agentId) {
      throw integrity(`Detail ${itemId} changed agent ownership.`);
    }
    if (
      existing &&
      agentInstanceId &&
      existing.agent_instance_id &&
      existing.agent_instance_id !== agentInstanceId
    ) {
      throw integrity(`Detail ${itemId} changed agent instance ownership.`);
    }
    if (
      existing &&
      parentAgentInstanceId &&
      existing.parent_agent_instance_id &&
      existing.parent_agent_instance_id !== parentAgentInstanceId
    ) {
      throw integrity(`Detail ${itemId} changed parent agent ownership.`);
    }
    if (existing && parentAgentId && existing.parent_agent_id && existing.parent_agent_id !== parentAgentId) {
      throw integrity(`Detail ${itemId} changed parent agent ownership.`);
    }
    if (
      existing &&
      parentToolCallId &&
      existing.parent_tool_call_id &&
      existing.parent_tool_call_id !== parentToolCallId
    ) {
      throw integrity(`Detail ${itemId} changed parent tool ownership.`);
    }
    if (existing && toolCallId && existing.tool_call_id && existing.tool_call_id !== toolCallId) {
      throw integrity(`Detail ${itemId} changed tool ownership.`);
    }
    const incomingType = optionalPayloadText(p.detailType, "detailType");
    if (existing && incomingType && existing.type !== incomingType) {
      throw integrity(`Detail ${itemId} changed type.`);
    }
    const type = incomingType ?? existing?.type ?? record.type;
    let content = payloadString(p.content, "content") ?? existing?.content ?? null;
    if (isContextCompactionEventType(type)) {
      content = this.withCompactionDetailTiming(
        record,
        type,
        content,
        runId,
        agentInstanceId ?? agentId ?? existing?.agent_instance_id ?? existing?.agent_id ?? undefined,
      );
    }
    const ref = payloadString(p.ref, "ref") ?? existing?.ref ?? null;
    this.db
      .prepare(
        `INSERT INTO conversation_detail_items_v2
         (item_id, conversation_id, run_id, agent_id, agent_instance_id, parent_agent_instance_id, parent_agent_id, parent_tool_call_id, tool_call_id, type, created_seq, version_seq, content, ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           version_seq = excluded.version_seq, content = excluded.content, ref = excluded.ref,
           type = excluded.type`,
      )
      .run(
        itemId,
        record.conversationId,
        runId,
        agentId ?? existing?.agent_id ?? null,
        agentInstanceId ?? existing?.agent_instance_id ?? null,
        parentAgentInstanceId ?? existing?.parent_agent_instance_id ?? null,
        parentAgentId ?? existing?.parent_agent_id ?? null,
        parentToolCallId ?? existing?.parent_tool_call_id ?? null,
        toolCallId ?? existing?.tool_call_id ?? null,
        type,
        existing?.created_seq ?? record.seq,
        record.seq,
        content,
        ref,
      );
    return {
      type: "detail.upsert",
      detail: this.getDetailOrThrow(record.conversationId, itemId),
    };
  }

  private withCompactionDetailTiming(
    record: ConversationEventRecord,
    type: string,
    content: string | null,
    runId: string,
    agentId: string | undefined,
  ): string {
    const parse = (eventType: string, stored: string | null) => {
      const value = JSON.parse(stored ?? "null");
      if (!value || typeof value.observedAt !== "string" || typeof value.scope !== "string") {
        throw integrity(`Compaction detail ${record.eventId} has invalid lifecycle content.`);
      }
      const item: ContextCompactionTimingItem = {
        eventType,
        at: value.observedAt,
        scope: value.scope,
        runAttemptId: runId,
        ...(agentId ? { agentId } : {}),
        ...(value.requestId ? { requestId: value.requestId } : {}),
        ...(value.streamKey ? { streamKey: value.streamKey } : {}),
        ...(value.metadata ? { metadata: value.metadata } : {}),
      };
      return { value, item };
    };
    const current = parse(type, content);
    const previous =
      type === "context.compaction.started"
        ? []
        : (
            this.db
              .prepare(
                `SELECT type, content FROM conversation_detail_items_v2
         WHERE conversation_id = ? AND run_id = ?
           AND COALESCE(agent_instance_id, agent_id, '') = ? AND created_seq < ?
           AND type IN ('context.compaction.started', 'context.compaction.completed', 'context.compaction.failed')
         ORDER BY created_seq ASC, item_id ASC`,
              )
              .all(record.conversationId, runId, agentId ?? "", record.seq) as Array<{
              type: string;
              content: string | null;
            }>
          ).map((row) => parse(row.type, row.content).item);
    const timing = resolveContextCompactionTiming(current.item, previous);
    return JSON.stringify({ ...current.value, timing });
  }

  private applyHistoryInvalidation(record: ConversationEventRecord): ConversationEffect {
    const inputIds = record.payload.affectedProviderInputIds;
    if (inputIds !== undefined) {
      if (!Array.isArray(inputIds) || inputIds.some((id) => typeof id !== "string" || !id.trim())) {
        throw integrity("History change has invalid provider input identities.");
      }
      const hide = this.db.prepare(`UPDATE conversation_provider_inputs_v2 SET visible = 0
        WHERE conversation_id = ? AND input_id = ?`);
      for (const id of inputIds) {
        if (Number(hide.run(record.conversationId, id).changes) !== 1) {
          throw integrity(`History change refers to an unknown provider input: ${id}.`);
        }
      }
    }
    const messageIds = record.payload.affectedMessageIds;
    if (Array.isArray(messageIds)) {
      const hide = this.db.prepare(`UPDATE conversation_provider_inputs_v2 SET visible = 0
        WHERE conversation_id = ? AND message_id = ?`);
      for (const id of messageIds) {
        if (typeof id !== "string" || !id.trim())
          throw integrity("History change has invalid message identities.");
        hide.run(record.conversationId, id);
      }
    }
    const stream = this.getStream(record.conversationId);
    const revision = stream.history_revision + 1;
    this.db
      .prepare(`UPDATE conversation_streams_v2 SET history_revision = ? WHERE conversation_id = ?`)
      .run(revision, record.conversationId);
    const messageId =
      optionalText(record.messageId) ?? optionalPayloadText(record.payload.messageId, "messageId");
    if (messageId) {
      this.db
        .prepare(
          `UPDATE conversation_messages_v2
           SET version_seq = ?, status = CASE WHEN ? = 'history.deleted' THEN 'deleted' ELSE status END,
               is_deleted = CASE WHEN ? = 'history.deleted' THEN 1 ELSE is_deleted END
           WHERE conversation_id = ? AND message_id = ?`,
        )
        .run(record.seq, record.type, record.type, record.conversationId, messageId);
    }
    return { type: "history.invalidation", historyRevision: revision };
  }

  /** Host-only provider identity index, rebuilt exclusively from V2 input receipts. */
  private applyProviderInput(record: ConversationEventRecord): void {
    const source = record.payload.source;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw integrity("Runtime input receipt is missing its source envelope.");
    }
    const input = source as Record<string, unknown>;
    if (input.threadId !== record.conversationId || typeof input.id !== "string" || !input.id.trim()) {
      throw integrity("Runtime input receipt changed conversation or source identity.");
    }
    if (record.payload.message !== undefined && typeof record.payload.message !== "string") {
      throw integrity("Runtime input receipt has invalid text.");
    }
    if (
      record.messageId &&
      !this.db
        .prepare(`SELECT 1 FROM conversation_messages_v2
      WHERE conversation_id = ? AND message_id = ?`)
        .get(record.conversationId, record.messageId)
    ) {
      throw integrity(`Provider input ${input.id} references a missing V2 message: ${record.messageId}.`);
    }
    this.db
      .prepare(`INSERT INTO conversation_provider_inputs_v2
      (conversation_id, input_id, first_seq, version_seq, source_json, message_id, message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, input_id) DO UPDATE SET
        version_seq = excluded.version_seq, source_json = excluded.source_json,
        message_id = excluded.message_id, message = excluded.message`)
      .run(
        record.conversationId,
        input.id,
        record.seq,
        record.seq,
        JSON.stringify(input),
        record.messageId ?? null,
        record.payload.message ?? null,
      );
  }

  private applyProviderInputPatch(record: ConversationEventRecord): void {
    const ids = record.payload.inputIds;
    const patch = record.payload.patch;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw integrity("Provider input patch has invalid identities.");
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw integrity("Provider input patch has invalid fields.");
    }
    const update = this.db.prepare(`UPDATE conversation_provider_inputs_v2
      SET source_json = ?, version_seq = ? WHERE conversation_id = ? AND input_id = ?`);
    for (const id of ids as string[]) {
      const row = this.db
        .prepare(`SELECT source_json FROM conversation_provider_inputs_v2
        WHERE conversation_id = ? AND input_id = ?`)
        .get(record.conversationId, id) as { source_json: string } | undefined;
      if (!row) throw integrity(`Provider input patch refers to an unknown input: ${id}.`);
      let source: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.source_json) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
        source = { ...(parsed as Record<string, unknown>) };
      } catch {
        throw integrity(`Provider input ${id} has invalid source JSON.`);
      }
      const next = patch as Record<string, unknown>;
      for (const [key, value] of Object.entries(next)) {
        if (key === "metadataMerge") {
          const current = source.metadata;
          if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) {
            throw integrity(`Provider input ${id} has invalid metadata.`);
          }
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw integrity("Provider input metadata patch is invalid.");
          }
          source.metadata = {
            ...(current as Record<string, unknown> | undefined),
            ...(value as Record<string, unknown>),
          };
        } else {
          source[key] = value;
        }
      }
      update.run(JSON.stringify(source), record.seq, record.conversationId, id);
    }
  }

  private applyTodoList(record: ConversationEventRecord): ConversationEffect {
    const rawTodos = record.payload.todos;
    if (!Array.isArray(rawTodos)) throw v2Invalid("todo.updated todos must be an array");
    const todos = rawTodos.map((value, index) =>
      todoFromEventPayload(value, `todo.updated.todos[${index}]`, record.seq),
    );
    const ids = new Set<string>();
    const positions = new Set<number>();
    for (const todo of todos) {
      if (todo.conversationId !== record.conversationId) {
        throw v2Invalid("todo.updated contains a todo for another conversation");
      }
      if (ids.has(todo.todoId) || positions.has(todo.position)) {
        throw v2Invalid("todo.updated contains duplicate todo identity or position");
      }
      ids.add(todo.todoId);
      positions.add(todo.position);
    }
    this.db.prepare(`DELETE FROM conversation_todos_v2 WHERE conversation_id = ?`).run(record.conversationId);
    const insert = this.db.prepare(
      `INSERT INTO conversation_todos_v2 (
         todo_id, conversation_id, title, detail, status, position, updated_at, version_seq
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const todo of todos) {
      insert.run(
        todo.todoId,
        todo.conversationId,
        todo.title,
        todo.detail,
        todo.status,
        todo.position,
        todo.updatedAt,
        todo.versionSeq,
      );
    }
    return { type: "todo.list.replace", todos };
  }

  private insertEffect(conversationId: string, seq: number, effect: ConversationEffect): void {
    this.db
      .prepare(
        `INSERT INTO conversation_sync_effects_v2 (conversation_id, seq, effect_version, effect_hash, effect_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(conversationId, seq, CONVERSATION_V2_EFFECT_VERSION, stableHash(effect), JSON.stringify(effect));
  }

  private getStream(conversationId: string): StreamRow {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    const row = this.db
      .prepare(
        `SELECT conversation_id, store_epoch, last_seq, history_revision, reducer_version FROM conversation_streams_v2 WHERE conversation_id = ?`,
      )
      .get(id) as StreamRow | undefined;
    if (!row) return this.ensureStream(id);
    const stream = rowToStream(row);
    this.assertStreamEpoch(stream);
    return stream;
  }

  private requireExistingStream(conversationId: string): StreamRow {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    const row = this.db
      .prepare(
        `SELECT conversation_id, store_epoch, last_seq, history_revision, reducer_version
         FROM conversation_streams_v2 WHERE conversation_id = ?`,
      )
      .get(id) as StreamRow | undefined;
    if (!row) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.conversationNotFound,
        `Conversation V2 stream does not exist: ${id}`,
      );
    }
    const stream = rowToStream(row);
    this.assertStreamEpoch(stream);
    return stream;
  }

  private ensureStream(conversationId: string): StreamRow {
    const epoch = this.getStoreEpoch();
    this.db
      .prepare(`INSERT OR IGNORE INTO conversation_streams_v2 (conversation_id, store_epoch) VALUES (?, ?)`)
      .run(conversationId, epoch);
    const row = this.db
      .prepare(
        `SELECT conversation_id, store_epoch, last_seq, history_revision, reducer_version FROM conversation_streams_v2 WHERE conversation_id = ?`,
      )
      .get(conversationId);
    if (!row) throw integrity("Conversation stream could not be created.");
    const stream = rowToStream(row as unknown as StreamRow);
    this.assertStreamEpoch(stream);
    return stream;
  }

  private assertStreamEpoch(stream: StreamRow): void {
    if (stream.store_epoch !== this.getStoreEpoch()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.epochMismatch,
        `Conversation V2 stream epoch does not match the store epoch: ${stream.conversation_id}`,
        { expected: this.getStoreEpoch(), actual: stream.store_epoch },
      );
    }
  }

  private assertStreamConsistency(stream: StreamRow, deep = false): void {
    if (deep) {
      const events = this.db
        .prepare(`SELECT * FROM conversation_events_v2 WHERE conversation_id = ? ORDER BY seq ASC`)
        .all(stream.conversation_id) as unknown as EventRow[];
      const effects = this.db
        .prepare(`SELECT * FROM conversation_sync_effects_v2 WHERE conversation_id = ? ORDER BY seq ASC`)
        .all(stream.conversation_id) as unknown as EffectRow[];
      this.validateEventLogForReplay(stream, events);
      if (effects.length !== events.length) {
        throw integrity(`Conversation V2 event/effect counts do not match for ${stream.conversation_id}.`);
      }
      for (const [index, row] of effects.entries()) {
        this.validateEffectRow(row, index + 1);
      }
      return;
    }
    // This runs for every append, including a large migration batch. A full
    // event/effect replay here makes the write path O(n²) and turned a 2k event
    // corpus into a multi-minute operation. The maintenance/read-side
    // validateIntegrity() path still hashes and replays every row; the hot path
    // only checks the indexed contiguous ranges and validates the event being
    // appended (plus the exact effect on an idempotent duplicate).
    const latestEvent = this.db
      .prepare(
        `SELECT seq, store_epoch FROM conversation_events_v2
          WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(stream.conversation_id) as { seq?: number; store_epoch?: string } | undefined;
    const latestEffect = this.db
      .prepare(
        `SELECT seq FROM conversation_sync_effects_v2
          WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(stream.conversation_id) as { seq?: number } | undefined;
    const expectedLatestSeq = stream.last_seq > 0 ? stream.last_seq : undefined;
    if (
      latestEvent?.seq !== expectedLatestSeq ||
      latestEffect?.seq !== expectedLatestSeq ||
      (latestEvent && latestEvent.store_epoch !== stream.store_epoch)
    ) {
      throw integrity(`Conversation V2 event/effect counts do not match for ${stream.conversation_id}.`);
    }
  }

  private validateEffectRow(row: EffectRow, expectedSeq: number): void {
    const conversationId = rowRequiredText(row.conversation_id, "effect.conversation_id");
    if (
      conversationId.length === 0 ||
      row.seq !== expectedSeq ||
      row.effect_version !== CONVERSATION_V2_EFFECT_VERSION
    ) {
      throw integrity("Conversation V2 effect range is not contiguous or uses an unsupported version.");
    }
    const effect = rowToEffect(row);
    if (row.effect_hash !== stableHash(effect.effect)) {
      throw integrity(`Conversation V2 effect hash mismatch at sequence ${row.seq}.`);
    }
  }

  private selectCommandJob(
    principalId: string,
    conversationId: string,
    clientCommandId: string,
  ): CommandJobRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM conversation_command_jobs_v2
         WHERE principal_id = ? AND conversation_id = ? AND client_command_id = ?`,
      )
      .get(principalId, conversationId, clientCommandId) as CommandJobRow | undefined;
  }

  private insertCommandCheckpointInCurrentTransaction(
    key: {
      principalId: string;
      conversationId: string;
      clientCommandId: string;
    },
    name: ConversationCommandCheckpointName,
    payload: Record<string, unknown>,
    recordedAt: string,
  ): void {
    const checkpoints = this.readStoredCommandCheckpoints(key);
    assertNextCommandCheckpoint(checkpoints, name);
    const ordinal = checkpoints.length + 1;
    const payloadJson = JSON.stringify(payload);
    this.db
      .prepare(
        `INSERT INTO conversation_command_checkpoints_v2
         (principal_id, conversation_id, client_command_id, ordinal, name,
          payload_hash, payload_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key.principalId,
        key.conversationId,
        key.clientCommandId,
        ordinal,
        name,
        stableHash(payload),
        payloadJson,
        recordedAt,
      );
  }

  private readStoredCommandCheckpoints(key: {
    principalId: string;
    conversationId: string;
    clientCommandId: string;
  }): ConversationCommandCheckpoint[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_command_checkpoints_v2
         WHERE principal_id = ? AND conversation_id = ? AND client_command_id = ?
         ORDER BY ordinal ASC`,
      )
      .all(key.principalId, key.conversationId, key.clientCommandId) as unknown as CommandCheckpointRow[];
    const checkpoints: ConversationCommandCheckpoint[] = [];
    for (const row of rows) {
      if (
        row.principal_id !== key.principalId ||
        row.conversation_id !== key.conversationId ||
        row.client_command_id !== key.clientCommandId ||
        row.ordinal !== checkpoints.length + 1
      ) {
        throw integrity("Stored command checkpoints are not contiguous.");
      }
      const name = storedCommandCheckpointName(row.name);
      const payload = parseDurableJsonRecord(row.payload_json, "command checkpoint payload");
      if (row.payload_hash !== stableHash(payload)) {
        throw integrity("Stored command checkpoint payload hash does not match.");
      }
      const checkpoint = {
        ordinal: row.ordinal,
        name,
        payload,
        recordedAt: rowRequiredText(row.recorded_at, "command checkpoint recorded_at"),
      } satisfies ConversationCommandCheckpoint;
      assertNextCommandCheckpoint(checkpoints, name, true);
      checkpoints.push(checkpoint);
    }
    return checkpoints;
  }

  private finishCommand(
    principalId: string,
    conversationId: string,
    clientCommandId: string,
    status: "completed" | "failed",
    value: unknown,
  ): ConversationCommandJob {
    this.ensureInitialized();
    const key = {
      principalId: requireText(principalId, "principalId"),
      conversationId: requireText(conversationId, "conversationId"),
      clientCommandId: requireText(clientCommandId, "clientCommandId"),
    };
    const storedJson = durableJson(value, `command ${status} value`);
    this.beginWrite();
    try {
      const job = this.finishCommandInTransaction(key, status, storedJson);
      this.db.exec("COMMIT");
      return job;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error.
      }
      throw error;
    }
  }

  private finishCommandInTransaction(
    key: {
      principalId: string;
      conversationId: string;
      clientCommandId: string;
    },
    status: "completed" | "failed",
    storedJson: string,
  ): ConversationCommandJob {
    const row = this.selectCommandJob(key.principalId, key.conversationId, key.clientCommandId);
    if (!row) throw v2Invalid("Conversation command job was not found.");
    const current = this.validateStoredCommandJob(row);
    if (current.status === status) {
      const currentValue = status === "completed" ? current.result : current.error;
      if (stableHash(currentValue) !== stableHash(JSON.parse(storedJson))) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.idempotencyConflict,
          `Command job was already ${status} with a different value.`,
        );
      }
      return current;
    }
    if (current.status !== "running") {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.idempotencyConflict,
        `Cannot mark a ${current.status} command job as ${status}.`,
      );
    }
    const resultColumn = status === "completed" ? "result_json" : "error_json";
    const updatedAt = this.now();
    const changed = this.db
      .prepare(
        `UPDATE conversation_command_jobs_v2
         SET status = ?, ${resultColumn} = ?, updated_at = ?
         WHERE principal_id = ? AND conversation_id = ? AND client_command_id = ?
           AND status = 'running'`,
      )
      .run(status, storedJson, updatedAt, key.principalId, key.conversationId, key.clientCommandId);
    if (changed.changes !== 1) {
      throw integrity("Command job terminal transition was not atomic.");
    }
    const finished = this.selectCommandJob(key.principalId, key.conversationId, key.clientCommandId);
    if (!finished) throw integrity("Finished command job disappeared.");
    return this.validateStoredCommandJob(finished);
  }

  private validateStoredCommandJob(row: CommandJobRow): ConversationCommandJob {
    const principalId = rowRequiredText(row.principal_id, "command.principal_id");
    const conversationId = rowRequiredText(row.conversation_id, "command.conversation_id");
    const clientCommandId = rowRequiredText(row.client_command_id, "command.client_command_id");
    const commandType = storedCommandJobType(row.command_type);
    const requestHash = rowRequiredText(row.request_hash, "command.request_hash");
    const request = parseDurableJsonRecord(row.request_json, "command.request_json");
    const expectedHistoryRevision = rowNonNegativeInteger(
      row.expected_history_revision,
      "command.expected_history_revision",
    );
    const acceptedSeq = rowPositiveInteger(row.accepted_seq, "command.accepted_seq");
    const acceptedAt = rowRequiredText(row.accepted_at, "command.accepted_at");
    const updatedAt = rowRequiredText(row.updated_at, "command.updated_at");
    const status = storedCommandJobStatus(row.status);
    const checkpoints = this.readStoredCommandCheckpoints({
      principalId,
      conversationId,
      clientCommandId,
    });
    if (
      checkpoints.some((checkpoint) => isPlanCommandCheckpoint(checkpoint.name)) &&
      commandType !== "plan.resolve"
    ) {
      throw integrity("A non-plan command contains plan checkpoints.");
    }
    if (
      checkpoints[1]?.name === "history.runtime_dispatch_prepared" &&
      !(commandType === "history.retry" && request.rewind === false)
    ) {
      throw integrity("Only a non-rewind retry may skip history side-effect checkpoints.");
    }
    if (requestHash !== stableHash({ commandType, request, expectedHistoryRevision })) {
      throw integrity("Stored command job request hash does not match its request.");
    }
    const result = parseOptionalDurableJson(row.result_json, "command.result_json");
    const error = parseOptionalDurableJson(row.error_json, "command.error_json");
    if (
      (status === "completed" && (row.result_json === null || row.error_json !== null)) ||
      (status === "failed" && (row.error_json === null || row.result_json !== null)) ||
      ((status === "accepted" || status === "running") &&
        (row.result_json !== null || row.error_json !== null))
    ) {
      throw integrity("Stored command job terminal fields do not match its status.");
    }
    if (status === "accepted" && checkpoints.length > 0) {
      throw integrity("An accepted command job cannot have execution checkpoints.");
    }
    if (status === "running" && checkpoints[0]?.name !== "execution.claimed") {
      throw integrity("A running command job is missing its execution claim.");
    }
    if (
      status === "completed" &&
      (commandType === "history.rewrite" || commandType === "history.retry") &&
      checkpoints.at(-1)?.name !== "history.runtime_dispatched"
    ) {
      throw integrity("A completed history command is missing runtime dispatch.");
    }
    const acceptedEvent = this.db
      .prepare(
        `SELECT type, source_event_key, payload_json
         FROM conversation_events_v2 WHERE conversation_id = ? AND seq = ?`,
      )
      .get(conversationId, acceptedSeq) as
      | {
          type?: string;
          source_event_key?: string | null;
          payload_json?: string;
        }
      | undefined;
    const eventPayload = parseDurableJsonRecord(
      acceptedEvent?.payload_json,
      "command accepted event payload",
    );
    if (
      acceptedEvent?.type !== "noop" ||
      acceptedEvent.source_event_key !== `command-job:${principalId}:${clientCommandId}` ||
      eventPayload.reason !== "command.accepted" ||
      eventPayload.principalId !== principalId ||
      eventPayload.clientCommandId !== clientCommandId ||
      eventPayload.commandType !== commandType ||
      eventPayload.requestHash !== requestHash ||
      eventPayload.expectedHistoryRevision !== expectedHistoryRevision
    ) {
      throw integrity("Stored command job does not match its accepted event.");
    }
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      principalId,
      conversationId,
      clientCommandId,
      commandType,
      requestHash,
      request,
      expectedHistoryRevision,
      status,
      acceptedSeq,
      acceptedAt,
      updatedAt,
      checkpoints,
      ...(row.result_json !== null ? { result } : {}),
      ...(row.error_json !== null ? { error } : {}),
    };
  }

  private validateStoredSendMessageReceipt(
    receipt: ReceiptRow,
    conversationId: string,
    clientCommandId: string,
  ): ConversationSendMessageResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(receipt.result_json);
    } catch {
      throw integrity("Stored conversation command receipt is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw integrity("Stored conversation command receipt is not an object.");
    }
    const value = parsed as Record<string, unknown>;
    const acceptedSeq = value.acceptedSeq;
    const messageId = value.messageId;
    const turnId = value.turnId;
    if (
      value.protocolVersion !== CONVERSATION_V2_PROTOCOL_VERSION ||
      value.conversationId !== conversationId ||
      value.clientCommandId !== clientCommandId ||
      typeof messageId !== "string" ||
      !messageId.trim() ||
      typeof turnId !== "string" ||
      !turnId.trim() ||
      typeof acceptedSeq !== "number" ||
      !Number.isSafeInteger(acceptedSeq) ||
      acceptedSeq < 1 ||
      value.status !== "queued" ||
      receipt.accepted_seq !== acceptedSeq
    ) {
      throw integrity("Stored conversation command receipt metadata is invalid.");
    }
    const event = this.db
      .prepare(
        `SELECT type, message_id, turn_id
         FROM conversation_events_v2
         WHERE conversation_id = ? AND seq = ?`,
      )
      .get(conversationId, acceptedSeq) as
      | { type?: string; message_id?: string | null; turn_id?: string | null }
      | undefined;
    if (event?.type !== "message.accepted" || event.message_id !== messageId || event.turn_id !== turnId) {
      throw integrity("Stored conversation command receipt does not match its accepted event.");
    }
    const message = this.getMessage(conversationId, messageId);
    if (!message || message.turnId !== turnId || message.createdSeq > acceptedSeq) {
      throw integrity("Stored conversation command receipt does not match its message.");
    }
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      conversationId,
      clientCommandId,
      messageId,
      turnId,
      acceptedSeq,
      status: "queued",
    };
  }

  private validateEventLogForReplay(stream: StreamRow, events: readonly EventRow[]): void {
    if (events.length !== stream.last_seq) {
      throw integrity(
        `Conversation V2 event count does not match stream head for ${stream.conversation_id}.`,
      );
    }
    for (const [index, row] of events.entries()) {
      const expectedSeq = index + 1;
      if (
        row.conversation_id !== stream.conversation_id ||
        row.store_epoch !== stream.store_epoch ||
        row.seq !== expectedSeq ||
        row.schema_version !== CONVERSATION_V2_SCHEMA_VERSION
      ) {
        throw integrity(`Conversation V2 event log is invalid at sequence ${row.seq}.`);
      }
      const record = rowToEvent(row);
      const actualHash = conversationV2EventHash(record);
      if (row.event_hash !== actualHash) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 event hash mismatch at sequence ${row.seq}.`,
          {
            conversationId: stream.conversation_id,
            seq: row.seq,
            eventId: row.event_id,
            expectedHash: row.event_hash,
            actualHash,
          },
        );
      }
    }
  }

  private getMessageRow(conversationId: string, messageId: string): MessageRow | undefined {
    return this.db
      .prepare(`SELECT * FROM conversation_messages_v2 WHERE conversation_id = ? AND message_id = ?`)
      .get(conversationId, messageId) as MessageRow | undefined;
  }

  private ensureTurn(
    conversationId: string,
    turnId: string,
    createdSeq: number,
    versionSeq: number,
    activeRunId?: string,
  ): void {
    const existing = this.db
      .prepare(`SELECT conversation_id FROM conversation_turns_v2 WHERE turn_id = ?`)
      .get(turnId) as { conversation_id: string } | undefined;
    if (existing && existing.conversation_id !== conversationId) {
      throw integrity(`Turn ${turnId} belongs to another conversation.`);
    }
    this.db
      .prepare(
        `INSERT INTO conversation_turns_v2
         (turn_id, conversation_id, created_seq, active_run_id, version_seq)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(turn_id) DO UPDATE SET
           active_run_id = COALESCE(excluded.active_run_id, conversation_turns_v2.active_run_id),
           version_seq = excluded.version_seq`,
      )
      .run(turnId, conversationId, createdSeq, activeRunId ?? null, versionSeq);
  }

  /** Read one tool summary for migration-time reconciliation and internal projection checks. */
  getTool(conversationId: string, toolCallId: string): ConversationToolCall {
    const row = this.db
      .prepare(`SELECT * FROM conversation_tool_calls_v2 WHERE conversation_id = ? AND tool_call_id = ?`)
      .get(conversationId, toolCallId) as ToolRow | undefined;
    if (!row) throw integrity("Tool read model was not written.");
    return rowToTool(row);
  }

  /** Read a parent tool when legacy owner resolution has an explicit tool link. */
  findTool(conversationId: string, toolCallId: string): ConversationToolCall | undefined {
    this.ensureInitialized();
    const row = this.db
      .prepare(`SELECT * FROM conversation_tool_calls_v2 WHERE conversation_id = ? AND tool_call_id = ?`)
      .get(conversationId, toolCallId) as ToolRow | undefined;
    return row ? rowToTool(row) : undefined;
  }

  /**
   * Close tool calls whose owning run is already terminal after recovery. The
   * event records that the app lost the terminal result; it does not claim the
   * underlying command had no side effects.
   */
  reconcileTerminalRunTools(conversationId: string): { scanned: number; settled: number } {
    this.ensureInitialized();
    const id = conversationId.trim();
    if (!id) return { scanned: 0, settled: 0 };
    const rows = this.db
      .prepare(
        `SELECT tools.run_id, tools.tool_call_id, tools.name, runs.ended_at
           FROM conversation_tool_calls_v2 AS tools
           JOIN conversation_runs_v2 AS runs
             ON runs.conversation_id = tools.conversation_id
            AND runs.run_id = tools.run_id
          WHERE tools.conversation_id = ?
            AND tools.status IN ('started', 'running')
            AND runs.status IN ('failed', 'cancelled')
            AND runs.ended_at IS NOT NULL
          ORDER BY tools.created_seq ASC, tools.tool_call_id ASC`,
      )
      .all(id) as Array<{
      run_id: string;
      tool_call_id: string;
      name: string;
      ended_at: string;
    }>;
    if (rows.length === 0) return { scanned: 0, settled: 0 };
    const inputs: ConversationEventInput[] = rows.map((row) => {
      const sourceEventKey = `recovery:terminal-run-tool:${id}:${row.run_id}:${row.tool_call_id}`;
      return {
        conversationId: id,
        eventId: `recovery_terminal_tool_failed_${stableHash(sourceEventKey)}`,
        sourceEventKey,
        type: "tool.failed",
        occurredAt: row.ended_at,
        runId: row.run_id,
        toolCallId: row.tool_call_id,
        payload: {
          name: row.name,
          status: "failed",
          recoveryReason:
            "The application stopped before a terminal tool result was durably recorded; the tool's side-effect outcome is unknown.",
        },
      };
    });
    const results = this.appendBatch(inputs);
    return {
      scanned: rows.length,
      settled: results.reduce((count, result) => count + Number(!result.duplicate), 0),
    };
  }

  private getDetailOrThrow(conversationId: string, itemId: string): ConversationDetailItem {
    const row = this.db
      .prepare(`SELECT * FROM conversation_detail_items_v2 WHERE conversation_id = ? AND item_id = ?`)
      .get(conversationId, itemId) as DetailRow | undefined;
    if (!row) throw integrity("Detail read model was not written.");
    return rowToDetail(row);
  }

  private notifyCommitted(result: ConversationAppendResult): void {
    for (const listener of this.listeners) {
      try {
        listener(result);
      } catch (error) {
        // The durable transaction has already committed. A failed push hint
        // must be recoverable through sync and must not turn a successful
        // append into a false storage failure.
        process.stderr.write(
          `[eco] conversation V2 commit listener failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  private readTransaction<T>(read: () => T): T {
    this.ensureInitialized();
    try {
      this.db.exec("BEGIN");
      const result = read();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original read/reducer error.
      }
      throw error;
    }
  }

  private readMessages(
    conversationId: string,
    limit: number,
    maxBytes: number,
    cursor?: { createdSeq: number; id: string },
  ): ConversationMessage[] {
    const safeLimit = normalizeLimit(limit, CONVERSATION_V2_MAX_PAGE_SIZE);
    const safeBytes = normalizeBytes(maxBytes);
    const params: Array<string | number> = [conversationId];
    let where = `conversation_id = ?`;
    if (cursor) {
      where += ` AND (created_seq < ? OR (created_seq = ? AND message_id < ?))`;
      params.push(cursor.createdSeq, cursor.createdSeq, cursor.id);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_messages_v2 WHERE ${where}
         ORDER BY created_seq DESC, message_id DESC LIMIT ?`,
      )
      .all(...params, safeLimit + 1) as unknown as MessageRow[];
    return fitPage(rows.map(rowToMessage), safeLimit, safeBytes);
  }

  private listTurns(conversationId: string, limit: number): ConversationTurnSummary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_turns_v2 WHERE conversation_id = ? ORDER BY created_seq DESC, turn_id DESC LIMIT ?`,
      )
      .all(conversationId, normalizeLimit(limit, CONVERSATION_V2_MAX_PAGE_SIZE)) as unknown as TurnRow[];
    return rows.map(rowToTurn);
  }

  private listRuns(conversationId: string, limit: number): ConversationRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_runs_v2 WHERE conversation_id = ? ORDER BY version_seq DESC, run_id DESC LIMIT ?`,
      )
      .all(conversationId, normalizeLimit(limit, CONVERSATION_V2_MAX_PAGE_SIZE)) as unknown as RunRow[];
    return rows.map(rowToRun);
  }

  /** Public read of a conversation's agents (used by the legacy bridge to resolve owners). */
  agentsOf(conversationId: string): ConversationAgent[] {
    return this.listAgents(conversationId);
  }

  todosOf(conversationId: string): ConversationTodo[] {
    this.requireExistingStream(conversationId);
    return this.listTodos(conversationId);
  }

  savePendingPlan(plan: ConversationPendingPlanV2, options: { inCurrentTransaction?: boolean } = {}): void {
    this.ensureInitialized();
    const conversationId = requireText(plan.conversationId, "conversationId");
    this.requireExistingStream(conversationId);
    const userPrompt = requireString(plan.userPrompt, "pending plan userPrompt");
    const analysis = requireString(plan.analysis, "pending plan analysis");
    const planText = requireString(plan.plan, "pending plan plan");
    const workspacePath = requireString(plan.workspacePath, "pending plan workspacePath");
    const worktreePath = requireString(plan.worktreePath, "pending plan worktreePath");
    const routesJson = requireString(plan.routesJson, "pending plan routesJson");
    const createdAt = requireText(plan.createdAt, "pending plan createdAt");
    const write = () => {
      this.db
        .prepare(
          `INSERT INTO conversation_pending_plans_v2 (
             conversation_id, user_prompt, analysis, plan, workspace_path, worktree_path,
             routes_json, plan_file_path, deferred_exit_plan_tool_use_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             user_prompt = excluded.user_prompt,
             analysis = excluded.analysis,
             plan = excluded.plan,
             workspace_path = excluded.workspace_path,
             worktree_path = excluded.worktree_path,
             routes_json = excluded.routes_json,
             plan_file_path = excluded.plan_file_path,
             deferred_exit_plan_tool_use_id = excluded.deferred_exit_plan_tool_use_id,
             created_at = excluded.created_at`,
        )
        .run(
          conversationId,
          userPrompt,
          analysis,
          planText,
          workspacePath,
          worktreePath,
          routesJson,
          plan.planFilePath?.trim() || null,
          plan.deferredExitPlanToolUseId?.trim() || null,
          createdAt,
        );
    };
    if (options.inCurrentTransaction) {
      write();
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      write();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error.
      }
      throw error;
    }
  }

  getPendingPlan(conversationId: string): ConversationPendingPlanV2 | undefined {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    const row = this.db
      .prepare(
        `SELECT conversation_id, user_prompt, analysis, plan, workspace_path, worktree_path,
                routes_json, plan_file_path, deferred_exit_plan_tool_use_id, created_at
           FROM conversation_pending_plans_v2
          WHERE conversation_id = ?`,
      )
      .get(id) as
      | {
          conversation_id: string;
          user_prompt: string;
          analysis: string;
          plan: string;
          workspace_path: string;
          worktree_path: string;
          routes_json: string;
          plan_file_path: string | null;
          deferred_exit_plan_tool_use_id: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      conversationId: row.conversation_id,
      userPrompt: row.user_prompt,
      analysis: row.analysis,
      plan: row.plan,
      workspacePath: row.workspace_path,
      worktreePath: row.worktree_path,
      routesJson: row.routes_json,
      planFilePath: row.plan_file_path,
      deferredExitPlanToolUseId: row.deferred_exit_plan_tool_use_id,
      createdAt: row.created_at,
    };
  }

  clearPendingPlan(conversationId: string, options: { inCurrentTransaction?: boolean } = {}): void {
    this.ensureInitialized();
    const id = requireText(conversationId, "conversationId");
    const write = () => {
      this.db.prepare(`DELETE FROM conversation_pending_plans_v2 WHERE conversation_id = ?`).run(id);
    };
    if (options.inCurrentTransaction) {
      write();
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      write();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error.
      }
      throw error;
    }
  }

  private listTodos(conversationId: string): ConversationTodo[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_todos_v2 WHERE conversation_id = ?
         ORDER BY position, todo_id`,
      )
      .all(conversationId) as unknown as TodoRow[];
    return rows.map(rowToTodo);
  }

  private listAgents(conversationId: string, limit = CONVERSATION_V2_MAX_PAGE_SIZE): ConversationAgent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_agents_v2 WHERE conversation_id = ?
         ORDER BY version_seq, agent_instance_id LIMIT ?`,
      )
      .all(conversationId, normalizeLimit(limit, CONVERSATION_V2_MAX_PAGE_SIZE)) as unknown as AgentRow[];
    return rows.map(rowToAgent);
  }

  private getAgent(conversationId: string, agentInstanceId: string): ConversationAgent | undefined {
    const row = this.db
      .prepare(`SELECT * FROM conversation_agents_v2 WHERE conversation_id = ? AND agent_instance_id = ?`)
      .get(conversationId, agentInstanceId) as AgentRow | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  private listRunsForIds(conversationId: string, runIds: readonly string[]): ConversationRun[] {
    const normalized = [...new Set(runIds.map((runId) => runId.trim()).filter(Boolean))];
    if (normalized.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_runs_v2
         WHERE conversation_id = ? AND run_id IN (${normalized.map(() => "?").join(", ")})
         ORDER BY version_seq DESC, run_id DESC`,
      )
      .all(conversationId, ...normalized) as unknown as RunRow[];
    return rows.map(rowToRun);
  }

  private listToolSummaries(
    conversationId: string,
    runIds: readonly string[] = [],
    limit?: number,
  ): ConversationToolCall[] {
    const normalizedRunIds = [...new Set(runIds.map((runId) => runId.trim()).filter(Boolean))];
    const safeLimit = limit === undefined ? undefined : normalizeLimit(limit, CONVERSATION_V2_MAX_PAGE_SIZE);
    const directRows =
      normalizedRunIds.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT * FROM conversation_tool_calls_v2
                WHERE conversation_id = ?
                  AND run_id IN (${normalizedRunIds.map(() => "?").join(", ")})
                ORDER BY created_seq ${safeLimit === undefined ? "ASC" : "DESC"}, tool_call_id ${safeLimit === undefined ? "ASC" : "DESC"}
                ${safeLimit === undefined ? "" : "LIMIT ?"}`,
            )
            .all(
              conversationId,
              ...normalizedRunIds,
              ...(safeLimit === undefined ? [] : [safeLimit]),
            ) as unknown as ToolRow[]);
    const orphanRows = this.db
      .prepare(
        `SELECT * FROM conversation_tool_calls_v2
          WHERE conversation_id = ? AND run_known = 0
            ${normalizedRunIds.length > 0 ? `AND run_id NOT IN (${normalizedRunIds.map(() => "?").join(", ")})` : ""}
          ORDER BY created_seq ${safeLimit === undefined ? "ASC" : "DESC"}, tool_call_id ${safeLimit === undefined ? "ASC" : "DESC"}
          ${safeLimit === undefined ? "" : "LIMIT ?"}`,
      )
      .all(
        conversationId,
        ...(normalizedRunIds.length > 0 ? normalizedRunIds : []),
        ...(safeLimit === undefined ? [] : [safeLimit]),
      ) as unknown as ToolRow[];
    const orderedRows = [...directRows, ...orphanRows].sort((left, right) =>
      safeLimit === undefined
        ? left.created_seq - right.created_seq || left.tool_call_id.localeCompare(right.tool_call_id)
        : right.created_seq - left.created_seq || right.tool_call_id.localeCompare(left.tool_call_id),
    );
    const rows = safeLimit === undefined ? orderedRows : orderedRows.slice(0, safeLimit);
    // Bootstrap is a summary endpoint, but dropping input/output entirely
    // makes the mobile presentation lose command/path/search semantics that
    // desktop already renders. Keep the payload bounded and structured: full
    // tool detail remains available through detailsPage().
    const tools = rows.map(rowToTool).map(limitConversationToolSummaryPayload);
    return limit === undefined ? tools : tools.reverse();
  }

  private listToolSummaryCounts(
    conversationId: string,
    runIds: readonly string[] = [],
  ): Record<string, number> {
    const normalizedRunIds = [...new Set(runIds.map((runId) => runId.trim()).filter(Boolean))];
    if (normalizedRunIds.length === 0) return {};
    const rows = this.db
      .prepare(
        `SELECT run_id, tool_count AS count
           FROM conversation_runs_v2
          WHERE conversation_id = ? AND run_id IN (${normalizedRunIds.map(() => "?").join(", ")})`,
      )
      .all(conversationId, ...normalizedRunIds) as unknown as Array<{ run_id?: string; count?: number }>;
    const counts = new Map(rows.map((row) => [row.run_id, Number(row.count ?? 0)]));
    // A legacy V2 migration can contain an orphan tool row without a run row.
    // Preserve its count through the indexed fallback rather than silently
    // reporting zero; normal runtime runs use the cached column above.
    const missing = normalizedRunIds.filter((runId) => !counts.has(runId));
    if (missing.length > 0) {
      const fallback = this.db
        .prepare(
          `SELECT run_id, COUNT(*) AS count
             FROM conversation_tool_calls_v2
            WHERE conversation_id = ? AND run_id IN (${missing.map(() => "?").join(", ")})
            GROUP BY run_id`,
        )
        .all(conversationId, ...missing) as unknown as Array<{ run_id?: string; count?: number }>;
      for (const row of fallback) counts.set(row.run_id, Number(row.count ?? 0));
    }
    return Object.fromEntries(normalizedRunIds.map((runId) => [runId, counts.get(runId) ?? 0]));
  }

  private hasOlderMessages(conversationId: string, last?: ConversationMessage): boolean {
    if (!last) return false;
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM conversation_messages_v2 WHERE conversation_id = ? AND (created_seq < ? OR (created_seq = ? AND message_id < ?)) LIMIT 1`,
      )
      .get(conversationId, last.createdSeq, last.createdSeq, last.messageId) as
      | { present?: number }
      | undefined;
    return row?.present === 1;
  }

  private validateCursor(
    cursor: { storeEpoch: string; historyRevision: number } | undefined,
    stream: StreamRow,
  ): void {
    if (!cursor) return;
    if (cursor.storeEpoch !== stream.store_epoch)
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.epochMismatch,
        "Cursor store epoch does not match.",
      );
    if (cursor.historyRevision !== stream.history_revision)
      throw new ConversationV2Error(CONVERSATION_V2_ERROR.cursorStale, "History cursor is no longer valid.");
  }

  private beginWrite(): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.storageFailure,
        `Could not begin conversation transaction: ${String(error)}`,
      );
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) this.initialize();
  }
}

const TERMINAL_MESSAGE_STATUSES = new Set(["final", "failed", "cancelled", "deleted"]);

/** Event ID prefixes generated from a short hash and therefore eligible for collision repair. */
const DERIVED_EVENT_ID_PREFIXES = [
  "runtime_input_",
  "legacy_v2_",
  "desktop_v2_",
  "provider_patch_",
  "provider_history_target_",
  "history_v2_",
  "todo_v2_",
  "migration_event_",
  "maintenance_native_",
  "recovery_terminal_tool_failed_",
  "codex_user_duplicate_",
  "accepted_prompt_duplicate_",
] as const;

function isDerivedEventId(eventId: string): boolean {
  return DERIVED_EVENT_ID_PREFIXES.some((prefix) => eventId.startsWith(prefix));
}

function resolveEventIdCollision(
  input: Pick<ConversationEventInput, "conversationId" | "eventId" | "sourceEventKey">,
  attempt: number,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      stableJson({
        conversationId: input.conversationId,
        sourceEventKey: input.sourceEventKey,
        eventId: input.eventId,
        attempt,
      }),
      "utf8",
    )
    .digest("hex");
  return `${input.eventId}_collision_${digest}`;
}

function normalizeEventInput(
  input: ConversationEventInput,
): ConversationEventInput & { payload: Record<string, unknown> } {
  const conversationId = requireText(input.conversationId, "conversationId");
  const eventId = requireText(input.eventId, "eventId");
  const occurredAt = requireText(input.occurredAt, "occurredAt");
  if (!CONVERSATION_V2_EVENT_TYPES.has(input.type)) {
    throw new ConversationV2Error(
      CONVERSATION_V2_ERROR.unsupportedVersion,
      `Unsupported Conversation V2 event type: ${String(input.type)}`,
    );
  }
  if (
    input.payload !== undefined &&
    (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload))
  ) {
    throw v2Invalid("event payload must be an object");
  }
  // Hash and reduce the same JSON snapshot that SQLite persists. In-memory SDK
  // metadata can contain undefined properties (notably informational.tag),
  // which stableHash includes but JSON.stringify omits. Hashing the original
  // object made a successful write fail integrity checks on the next startup.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(JSON.stringify(input.payload ?? {}));
  } catch {
    throw v2Invalid("event payload must be JSON serializable");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw v2Invalid("serialized event payload must be an object");
  }
  const sourceEventKey = optionalInputText(input.sourceEventKey, "sourceEventKey");
  const turnId = optionalInputText(input.turnId, "turnId");
  const runId = optionalInputText(input.runId, "runId");
  const messageId = optionalInputText(input.messageId, "messageId");
  const toolCallId = optionalInputText(input.toolCallId, "toolCallId");
  const agentId = optionalInputText(input.agentId, "agentId");
  const agentInstanceId = optionalInputText(
    input.agentInstanceId ?? payload.agentInstanceId,
    "agentInstanceId",
  );
  const parentAgentInstanceId = optionalInputText(
    input.parentAgentInstanceId ?? payload.parentAgentInstanceId,
    "parentAgentInstanceId",
  );
  const parentAgentId = optionalInputText(input.parentAgentId ?? payload.parentAgentId, "parentAgentId");
  const parentToolCallId = optionalInputText(
    input.parentToolCallId ?? payload.parentToolCallId,
    "parentToolCallId",
  );
  return {
    conversationId,
    eventId,
    type: input.type,
    occurredAt,
    ...(sourceEventKey ? { sourceEventKey } : {}),
    ...(turnId ? { turnId } : {}),
    ...(runId ? { runId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentInstanceId ? { agentInstanceId } : {}),
    ...(parentAgentInstanceId ? { parentAgentInstanceId } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
    payload,
  };
}

function rowToStream(row: StreamRow): StreamRow {
  return {
    conversation_id: rowRequiredText(row.conversation_id, "stream.conversation_id"),
    store_epoch: rowRequiredText(row.store_epoch, "stream.store_epoch"),
    last_seq: rowNonNegativeInteger(row.last_seq, "stream.last_seq"),
    history_revision: rowNonNegativeInteger(row.history_revision, "stream.history_revision"),
    reducer_version: rowPositiveInteger(row.reducer_version, "stream.reducer_version"),
  };
}

function rowToTurn(row: TurnRow): ConversationTurnSummary {
  const turnId = rowRequiredText(row.turn_id, "turn.turn_id");
  const conversationId = rowRequiredText(row.conversation_id, "turn.conversation_id");
  const createdSeq = rowPositiveInteger(row.created_seq, "turn.created_seq");
  const versionSeq = rowPositiveInteger(row.version_seq, "turn.version_seq");
  const activeRunId = rowOptionalText(row.active_run_id, "turn.active_run_id");
  if (versionSeq < createdSeq) throw integrity(`Stored turn ${turnId} has an invalid version.`);
  return {
    turnId,
    conversationId,
    createdSeq,
    versionSeq,
    ...(activeRunId ? { activeRunId } : {}),
  };
}

function rowToEvent(row: EventRow): ConversationEventRecord {
  if (row.schema_version !== CONVERSATION_V2_SCHEMA_VERSION) {
    throw new ConversationV2Error(
      CONVERSATION_V2_ERROR.unsupportedVersion,
      `Unsupported Conversation V2 event schema version: ${String(row.schema_version)}`,
    );
  }
  const conversationId = rowRequiredText(row.conversation_id, "event.conversation_id");
  const storeEpoch = rowRequiredText(row.store_epoch, "event.store_epoch");
  const seq = rowPositiveInteger(row.seq, "event.seq");
  const eventId = rowRequiredText(row.event_id, "event.event_id");
  const type = storedEventType(row.type);
  const occurredAt = rowRequiredText(row.occurred_at, "event.occurred_at");
  const recordedAt = rowRequiredText(row.recorded_at, "event.recorded_at");
  const eventHash = rowRequiredText(row.event_hash, "event.event_hash");
  const payload = parseJson(row.payload_json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw integrity("Event payload JSON is invalid.");
  const sourceEventKey = rowOptionalText(row.source_event_key, "event.source_event_key");
  const turnId = rowOptionalText(row.turn_id, "event.turn_id");
  const runId = rowOptionalText(row.run_id, "event.run_id");
  const messageId = rowOptionalText(row.message_id, "event.message_id");
  const toolCallId = rowOptionalText(row.tool_call_id, "event.tool_call_id");
  const agentId = rowOptionalText(row.agent_id, "event.agent_id");
  const agentInstanceId = rowOptionalText(row.agent_instance_id, "event.agent_instance_id");
  const parentAgentInstanceId = rowOptionalText(
    row.parent_agent_instance_id,
    "event.parent_agent_instance_id",
  );
  const parentAgentId = rowOptionalText(row.parent_agent_id, "event.parent_agent_id");
  const parentToolCallId = rowOptionalText(row.parent_tool_call_id, "event.parent_tool_call_id");
  return {
    conversationId,
    storeEpoch,
    seq,
    eventId,
    type,
    occurredAt,
    recordedAt,
    schemaVersion: row.schema_version as typeof CONVERSATION_V2_SCHEMA_VERSION,
    payload: payload as Record<string, unknown>,
    eventHash,
    ...(sourceEventKey ? { sourceEventKey } : {}),
    ...(turnId ? { turnId } : {}),
    ...(runId ? { runId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentInstanceId ? { agentInstanceId } : {}),
    ...(parentAgentInstanceId ? { parentAgentInstanceId } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}

function rowToEffect(row: EffectRow): ConversationSyncEffect {
  if (row.effect_version !== CONVERSATION_V2_EFFECT_VERSION) {
    throw new ConversationV2Error(
      CONVERSATION_V2_ERROR.unsupportedVersion,
      `Unsupported Conversation V2 effect version: ${String(row.effect_version)}`,
    );
  }
  const seq = rowPositiveInteger(row.seq, "effect.seq");
  const effectHash = rowRequiredText(row.effect_hash, "effect.effect_hash");
  const effect = parseJson(row.effect_json);
  const validatedEffect = storedEffect(effect, seq);
  return {
    seq,
    effectVersion: row.effect_version as typeof CONVERSATION_V2_EFFECT_VERSION,
    effectHash,
    effect: validatedEffect,
  };
}

function rowToMessage(row: MessageRow): ConversationMessage {
  const messageId = rowRequiredText(row.message_id, "message.message_id");
  const conversationId = rowRequiredText(row.conversation_id, "message.conversation_id");
  const turnId = rowRequiredText(row.turn_id, "message.turn_id");
  const runId = rowOptionalText(row.run_id, "message.run_id");
  const role = storedMessageRole(row.role);
  const channel = storedMessageChannel(row.channel);
  const createdSeq = rowPositiveInteger(row.created_seq, "message.created_seq");
  const versionSeq = rowPositiveInteger(row.version_seq, "message.version_seq");
  const occurredAt = rowOptionalText(row.occurred_at, "message.occurred_at");
  const providerRole = rowOptionalText(row.provider_role, "message.provider_role");
  const historyActivityLineId = rowOptionalText(
    row.history_activity_line_id,
    "message.history_activity_line_id",
  );
  const historyUserMessageId = rowOptionalText(
    row.history_user_message_id,
    "message.history_user_message_id",
  );
  const contentVersion = rowNonNegativeInteger(row.content_version, "message.content_version");
  const body = rowRequiredTextAllowEmpty(row.body, "message.body");
  const origin = row.origin_json == null ? undefined : parseMessageOrigin(parseJson(row.origin_json), "message.origin", true);
  const agentId = rowOptionalText(row.agent_id ?? null, "message.agent_id");
  const agentInstanceId = rowOptionalText(row.agent_instance_id ?? null, "message.agent_instance_id");
  const status = storedMessageStatus(row.status);
  const isDeleted = rowBoolean(row.is_deleted, "message.is_deleted");
  if (versionSeq < createdSeq || (status === "deleted") !== isDeleted) {
    throw integrity(`Stored message ${messageId} has invalid version or deletion state.`);
  }
  return {
    messageId,
    conversationId,
    turnId,
    ...(runId ? { runId } : {}),
    role,
    channel,
    createdSeq,
    versionSeq,
    contentVersion,
    body,
    ...(origin ? { origin } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentInstanceId ? { agentInstanceId } : {}),
    ...(occurredAt ? { occurredAt } : {}),
    ...(providerRole ? { providerRole } : {}),
    ...(historyActivityLineId
      ? {
          historyTarget: {
            activityLineId: historyActivityLineId,
            ...(historyUserMessageId ? { userMessageId: historyUserMessageId } : {}),
          },
        }
      : {}),
    ...(row.attachments_json !== null && row.attachments_json !== undefined
      ? {
          attachments: requiredArray(parseJson(row.attachments_json), "message.attachments"),
        }
      : {}),
    status,
    isDeleted,
  };
}

function rowToAgent(row: AgentRow): ConversationAgent {
  const agentId = rowRequiredText(row.agent_instance_id, "agent.agent_id");
  const conversationId = rowRequiredText(row.conversation_id, "agent.conversation_id");
  const role = rowRequiredText(row.role, "agent.role");
  const kind = rowRequiredText(row.kind, "agent.kind");
  const status = rowRequiredText(row.status, "agent.status");
  const versionSeq = rowPositiveInteger(row.version_seq, "agent.version_seq");
  const runId = rowOptionalText(row.run_id, "agent.run_id");
  const parentAgentInstanceId = rowOptionalText(
    row.parent_agent_instance_id,
    "agent.parent_agent_instance_id",
  );
  const parentToolCallId = rowOptionalText(row.parent_tool_call_id, "agent.parent_tool_call_id");
  const startedAt = rowOptionalText(row.started_at, "agent.started_at");
  const endedAt = rowOptionalText(row.ended_at, "agent.ended_at");
  const mission = rowOptionalTextAllowEmpty(row.mission, "agent.mission");
  const todoId = rowOptionalText(row.todo_id, "agent.todo_id");
  const taskName = rowOptionalText(row.task_name, "agent.task_name");
  const delegationSummary = rowOptionalText(row.delegation_summary, "agent.delegation_summary");
  const delegationPrompt = rowOptionalText(row.delegation_prompt, "agent.delegation_prompt");
  return {
    agentId,
    conversationId,
    role,
    kind,
    status,
    versionSeq,
    ...(runId ? { runId } : {}),
    ...(parentAgentInstanceId ? { parentAgentInstanceId } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(mission !== undefined ? { mission } : {}),
    ...(todoId ? { todoId } : {}),
    ...(taskName ? { taskName } : {}),
    ...(delegationSummary ? { delegationSummary } : {}),
    ...(delegationPrompt ? { delegationPrompt } : {}),
  };
}

function rowToRun(row: RunRow): ConversationRun {
  const runId = rowRequiredText(row.run_id, "run.run_id");
  const conversationId = rowRequiredText(row.conversation_id, "run.conversation_id");
  const turnId = rowRequiredText(row.turn_id, "run.turn_id");
  const status = storedRunStatus(row.status);
  const versionSeq = rowPositiveInteger(row.version_seq, "run.version_seq");
  const timingQuality = storedTimingQuality(row.timing_quality);
  const startedAt = rowOptionalText(row.started_at, "run.started_at");
  const endedAt = rowOptionalText(row.ended_at, "run.ended_at");
  const retryOfRunId = rowOptionalText(row.retry_of_run_id, "run.retry_of_run_id");
  const regenerationOfRunId = rowOptionalText(row.regeneration_of_run_id, "run.regeneration_of_run_id");
  if (retryOfRunId === runId || regenerationOfRunId === runId) {
    throw integrity(`Stored run ${runId} has self-referential lineage.`);
  }
  return {
    runId,
    conversationId,
    turnId,
    status,
    versionSeq,
    timingQuality,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(retryOfRunId ? { retryOfRunId } : {}),
    ...(regenerationOfRunId ? { regenerationOfRunId } : {}),
  };
}

function rowToTool(row: ToolRow): ConversationToolCall {
  const toolCallId = rowRequiredText(row.tool_call_id, "tool.tool_call_id");
  const conversationId = rowRequiredText(row.conversation_id, "tool.conversation_id");
  const runId = rowRequiredText(row.run_id, "tool.run_id");
  const agentId = rowOptionalText(row.agent_id, "tool.agent_id");
  const agentInstanceId = rowOptionalText(row.agent_instance_id, "tool.agent_instance_id");
  const parentAgentInstanceId = rowOptionalText(
    row.parent_agent_instance_id,
    "tool.parent_agent_instance_id",
  );
  const parentToolCallId = rowOptionalText(row.parent_tool_call_id, "tool.parent_tool_call_id");
  const name = rowRequiredText(row.name, "tool.name");
  const status = storedToolStatus(row.status);
  const createdSeq = rowPositiveInteger(row.created_seq, "tool.created_seq");
  const versionSeq = rowPositiveInteger(row.version_seq, "tool.version_seq");
  const occurredAt = rowOptionalText(row.occurred_at, "tool.occurred_at");
  const providerRole = rowOptionalText(row.provider_role, "tool.provider_role");
  if (versionSeq < createdSeq) throw integrity(`Stored tool ${toolCallId} has an invalid version.`);
  return {
    toolCallId,
    conversationId,
    runId,
    ...(agentId ? { agentId } : {}),
    ...(agentInstanceId ? { agentInstanceId } : {}),
    ...(parentAgentInstanceId ? { parentAgentInstanceId } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
    name,
    status,
    createdSeq,
    versionSeq,
    ...(occurredAt ? { occurredAt } : {}),
    ...(providerRole ? { providerRole } : {}),
    ...(row.input_json !== null ? { input: parseJson(row.input_json) } : {}),
    ...(row.output_json !== null ? { output: parseJson(row.output_json) } : {}),
  };
}

function rowToDetail(row: DetailRow): ConversationDetailItem {
  const itemId = rowRequiredText(row.item_id, "detail.item_id");
  const conversationId = rowRequiredText(row.conversation_id, "detail.conversation_id");
  const runId = rowRequiredText(row.run_id, "detail.run_id");
  const agentId = rowOptionalText(row.agent_id, "detail.agent_id");
  const agentInstanceId = rowOptionalText(row.agent_instance_id, "detail.agent_instance_id");
  const parentAgentInstanceId = rowOptionalText(
    row.parent_agent_instance_id,
    "detail.parent_agent_instance_id",
  );
  const parentAgentId = rowOptionalText(row.parent_agent_id, "detail.parent_agent_id");
  const parentToolCallId = rowOptionalText(row.parent_tool_call_id, "detail.parent_tool_call_id");
  const toolCallId = rowOptionalText(row.tool_call_id, "detail.tool_call_id");
  const type = rowRequiredText(row.type, "detail.type");
  const createdSeq = rowPositiveInteger(row.created_seq, "detail.created_seq");
  const versionSeq = rowPositiveInteger(row.version_seq, "detail.version_seq");
  if (versionSeq < createdSeq) throw integrity(`Stored detail ${itemId} has an invalid version.`);
  const content = rowOptionalTextAllowEmpty(row.content, "detail.content");
  const ref = rowOptionalTextAllowEmpty(row.ref, "detail.ref");
  return {
    itemId,
    conversationId,
    runId,
    ...(agentId ? { agentId } : {}),
    ...(agentInstanceId ? { agentInstanceId } : {}),
    ...(parentAgentInstanceId ? { parentAgentInstanceId } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    type,
    createdSeq,
    versionSeq,
    ...(content !== undefined ? { content } : {}),
    ...(ref !== undefined ? { ref } : {}),
  };
}

function rowToTodo(row: TodoRow): ConversationTodo {
  const todoId = rowRequiredText(row.todo_id, "todo.todo_id");
  const conversationId = rowRequiredText(row.conversation_id, "todo.conversation_id");
  const title = rowRequiredTextAllowEmpty(row.title, "todo.title");
  const detail = rowRequiredTextAllowEmpty(row.detail, "todo.detail");
  const status = storedTodoStatus(row.status);
  const position = rowNonNegativeInteger(row.position, "todo.position");
  const updatedAt = rowRequiredText(row.updated_at, "todo.updated_at");
  const versionSeq = rowPositiveInteger(row.version_seq, "todo.version_seq");
  return { todoId, conversationId, title, detail, status, position, updatedAt, versionSeq };
}

function storedEffect(value: unknown, effectSeq?: number): ConversationEffect {
  const object = storedObject(value, "effect");
  const type = object.type;
  if (typeof type !== "string" || !isKnownEffectType(type)) {
    throw integrity(`Stored effect type is invalid: ${String(type)}`);
  }
  switch (type) {
    case "message.create": {
      const message = storedMessage(object.message, "effect.message");
      if (effectSeq !== undefined && (message.createdSeq > effectSeq || message.versionSeq > effectSeq)) {
        throw integrity("Stored message.create effect is ahead of its event sequence.");
      }
      return { type, message };
    }
    case "message.append": {
      const messageId = rowRequiredText(object.messageId, "effect.messageId");
      const baseContentVersion = rowNonNegativeInteger(
        object.baseContentVersion,
        "effect.baseContentVersion",
      );
      const nextContentVersion = rowNonNegativeInteger(
        object.nextContentVersion,
        "effect.nextContentVersion",
      );
      if (nextContentVersion !== baseContentVersion + 1) {
        throw integrity(`Stored message ${messageId} append version is invalid.`);
      }
      const versionSeq = rowPositiveInteger(object.versionSeq, "effect.versionSeq");
      if (effectSeq !== undefined && versionSeq > effectSeq) {
        throw integrity(`Stored message ${messageId} append is ahead of its event sequence.`);
      }
      return {
        type,
        messageId,
        baseContentVersion,
        nextContentVersion,
        delta: rowRequiredTextAllowEmpty(object.delta, "effect.delta"),
        versionSeq,
      };
    }
    case "message.replace": {
      const messageId = rowRequiredText(object.messageId, "effect.messageId");
      const baseContentVersion = rowNonNegativeInteger(
        object.baseContentVersion,
        "effect.baseContentVersion",
      );
      const nextContentVersion = rowNonNegativeInteger(
        object.nextContentVersion,
        "effect.nextContentVersion",
      );
      if (nextContentVersion <= baseContentVersion) {
        throw integrity(`Stored message ${messageId} replace version is invalid.`);
      }
      const versionSeq = rowPositiveInteger(object.versionSeq, "effect.versionSeq");
      if (effectSeq !== undefined && versionSeq > effectSeq) {
        throw integrity(`Stored message ${messageId} replace is ahead of its event sequence.`);
      }
      const attachments = optionalStoredArray(object.attachments, "effect.attachments");
      return {
        type,
        messageId,
        baseContentVersion,
        nextContentVersion,
        body: rowRequiredTextAllowEmpty(object.body, "effect.body"),
        versionSeq,
        ...(attachments === undefined ? {} : { attachments }),
      };
    }
    case "message.finalize": {
      const messageId = rowRequiredText(object.messageId, "effect.messageId");
      const contentVersion = rowNonNegativeInteger(object.contentVersion, "effect.contentVersion");
      const versionSeq = rowPositiveInteger(object.versionSeq, "effect.versionSeq");
      if (effectSeq !== undefined && versionSeq > effectSeq) {
        throw integrity(`Stored message ${messageId} finalize is ahead of its event sequence.`);
      }
      const status = object.status;
      if (status !== "final" && status !== "failed" && status !== "cancelled") {
        throw integrity(`Stored message ${messageId} final status is invalid: ${String(status)}`);
      }
      const attachments = optionalStoredArray(object.attachments, "effect.attachments");
      const occurredAt = storedEffectOptionalText(object.occurredAt, "effect.occurredAt");
      return {
        type,
        messageId,
        contentVersion,
        versionSeq,
        status,
        ...(occurredAt ? { occurredAt } : {}),
        ...(attachments === undefined ? {} : { attachments }),
      };
    }
    case "message.tombstone": {
      const versionSeq = rowPositiveInteger(object.versionSeq, "effect.versionSeq");
      if (effectSeq !== undefined && versionSeq > effectSeq) {
        throw integrity("Stored message.tombstone effect is ahead of its event sequence.");
      }
      return {
        type,
        messageId: rowRequiredText(object.messageId, "effect.messageId"),
        versionSeq,
      };
    }
    case "message.history_target": {
      const versionSeq = rowPositiveInteger(object.versionSeq, "effect.versionSeq");
      if (effectSeq !== undefined && versionSeq > effectSeq) {
        throw integrity("Stored message.history_target effect is ahead of its event sequence.");
      }
      const historyTarget = storedHistoryTarget(object.historyTarget, "effect.historyTarget");
      if (!historyTarget) throw integrity("Stored message.history_target is missing its target.");
      return {
        type,
        messageId: rowRequiredText(object.messageId, "effect.messageId"),
        historyTarget,
        versionSeq,
      };
    }
    case "run.upsert": {
      const run = storedRun(object.run, "effect.run");
      if (effectSeq !== undefined && run.versionSeq > effectSeq) {
        throw integrity(`Stored run ${run.runId} is ahead of its event sequence.`);
      }
      return { type, run };
    }
    case "agent.upsert": {
      const agent = storedAgent(object.agent);
      if (effectSeq !== undefined && agent.versionSeq > effectSeq) {
        throw integrity(`Stored agent ${agent.agentId} is ahead of its event sequence.`);
      }
      return { type, agent };
    }
    case "tool.summary.upsert": {
      const toolCall = storedTool(object.toolCall, "effect.toolCall");
      if (effectSeq !== undefined && toolCall.versionSeq > effectSeq) {
        throw integrity(`Stored tool ${toolCall.toolCallId} is ahead of its event sequence.`);
      }
      return { type, toolCall };
    }
    case "detail.upsert": {
      const detail = storedDetail(object.detail, "effect.detail");
      if (effectSeq !== undefined && detail.versionSeq > effectSeq) {
        throw integrity(`Stored detail ${detail.itemId} is ahead of its event sequence.`);
      }
      return { type, detail };
    }
    case "todo.list.replace": {
      const rawTodos = requiredArray(object.todos, "effect.todos");
      const todos = rawTodos.map((value, index) => storedTodo(value, `effect.todos[${index}]`, effectSeq));
      return { type, todos };
    }
    case "detail.invalidation": {
      const runId = storedEffectOptionalText(object.runId, "effect.runId");
      const toolCallId = storedEffectOptionalText(object.toolCallId, "effect.toolCallId");
      return {
        type,
        ...(runId === undefined ? {} : { runId }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
      };
    }
    case "history.invalidation":
      return {
        type,
        historyRevision: rowPositiveInteger(object.historyRevision, "effect.historyRevision"),
      };
    case "noop":
      return { type, reason: rowRequiredText(object.reason, "effect.reason") };
  }
}

function storedMessage(value: unknown, field: string): ConversationMessage {
  const object = storedObject(value, field);
  const messageId = rowRequiredText(object.messageId, `${field}.messageId`);
  const conversationId = rowRequiredText(object.conversationId, `${field}.conversationId`);
  const turnId = rowRequiredText(object.turnId, `${field}.turnId`);
  const runId = storedEffectOptionalText(object.runId, `${field}.runId`);
  const role = storedMessageRole(object.role);
  const channel = storedMessageChannel(object.channel);
  const createdSeq = rowPositiveInteger(object.createdSeq, `${field}.createdSeq`);
  const versionSeq = rowPositiveInteger(object.versionSeq, `${field}.versionSeq`);
  const contentVersion = rowNonNegativeInteger(object.contentVersion, `${field}.contentVersion`);
  const body = rowRequiredTextAllowEmpty(object.body, `${field}.body`);
  const origin = parseMessageOrigin(object.origin, `${field}.origin`, true);
  const agentId = storedEffectOptionalText(object.agentId, `${field}.agentId`);
  const agentInstanceId = storedEffectOptionalText(object.agentInstanceId, `${field}.agentInstanceId`);
  const occurredAt = storedEffectOptionalText(object.occurredAt, `${field}.occurredAt`);
  const providerRole = storedEffectOptionalText(object.providerRole, `${field}.providerRole`);
  const historyTarget = storedHistoryTarget(object.historyTarget, `${field}.historyTarget`);
  const status = storedMessageStatus(object.status);
  const isDeleted = storedWireBoolean(object.isDeleted, `${field}.isDeleted`);
  if (versionSeq < createdSeq || (status === "deleted") !== isDeleted) {
    throw integrity(`Stored ${field} has invalid version or deletion state.`);
  }
  return {
    messageId,
    conversationId,
    turnId,
    ...(runId ? { runId } : {}),
    role,
    channel,
    createdSeq,
    versionSeq,
    contentVersion,
    body,
    ...(origin ? { origin } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentInstanceId ? { agentInstanceId } : {}),
    ...(occurredAt ? { occurredAt } : {}),
    ...(providerRole ? { providerRole } : {}),
    ...(historyTarget ? { historyTarget } : {}),
    ...(object.attachments !== undefined
      ? {
          attachments: requiredArray(object.attachments, `${field}.attachments`),
        }
      : {}),
    status,
    isDeleted,
  };
}

function storedAgent(value: unknown): ConversationAgent {
  const object = storedObject(value, "effect.agent");
  const agent: ConversationAgent = {
    agentId: rowRequiredText(object.agentId, "effect.agent.agentId"),
    conversationId: rowRequiredText(object.conversationId, "effect.agent.conversationId"),
    role: rowRequiredText(object.role, "effect.agent.role"),
    kind: rowRequiredText(object.kind, "effect.agent.kind"),
    status: rowRequiredText(object.status, "effect.agent.status"),
    versionSeq: rowPositiveInteger(object.versionSeq, "effect.agent.versionSeq"),
  };
  for (const key of [
    "runId",
    "parentAgentInstanceId",
    "parentToolCallId",
    "startedAt",
    "endedAt",
    "taskName",
    "delegationSummary",
    "delegationPrompt",
    "todoId",
  ] as const) {
    const text = storedEffectOptionalText(object[key], `effect.agent.${key}`);
    if (text !== undefined) agent[key] = text;
  }
  const mission = rowOptionalTextAllowEmpty(object.mission, "effect.agent.mission");
  if (mission !== undefined) agent.mission = mission;
  if (agent.agentId === agent.parentAgentInstanceId) throw integrity("Stored agent is its own parent.");
  return agent;
}

function storedRun(value: unknown, field: string): ConversationRun {
  const object = storedObject(value, field);
  const runId = rowRequiredText(object.runId, `${field}.runId`);
  const conversationId = rowRequiredText(object.conversationId, `${field}.conversationId`);
  const turnId = rowRequiredText(object.turnId, `${field}.turnId`);
  const status = storedRunStatus(object.status);
  const versionSeq = rowPositiveInteger(object.versionSeq, `${field}.versionSeq`);
  const timingQuality = storedTimingQuality(object.timingQuality);
  const startedAt = storedEffectOptionalText(object.startedAt, `${field}.startedAt`);
  const endedAt = storedEffectOptionalText(object.endedAt, `${field}.endedAt`);
  const retryOfRunId = storedEffectOptionalText(object.retryOfRunId, `${field}.retryOfRunId`);
  const regenerationOfRunId = storedEffectOptionalText(
    object.regenerationOfRunId,
    `${field}.regenerationOfRunId`,
  );
  if (retryOfRunId === runId || regenerationOfRunId === runId) {
    throw integrity(`Stored run ${runId} has self-referential lineage.`);
  }
  return {
    runId,
    conversationId,
    turnId,
    status,
    versionSeq,
    timingQuality,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(retryOfRunId ? { retryOfRunId } : {}),
    ...(regenerationOfRunId ? { regenerationOfRunId } : {}),
  };
}

function storedTool(value: unknown, field: string): ConversationToolCall {
  const object = storedObject(value, field);
  const toolCallId = rowRequiredText(object.toolCallId, `${field}.toolCallId`);
  const conversationId = rowRequiredText(object.conversationId, `${field}.conversationId`);
  const runId = rowRequiredText(object.runId, `${field}.runId`);
  const agentId = storedEffectOptionalText(object.agentId, `${field}.agentId`);
  const agentInstanceId = storedEffectOptionalText(object.agentInstanceId, `${field}.agentInstanceId`);
  const parentAgentInstanceId = storedEffectOptionalText(
    object.parentAgentInstanceId,
    `${field}.parentAgentInstanceId`,
  );
  const parentToolCallId = storedEffectOptionalText(object.parentToolCallId, `${field}.parentToolCallId`);
  const name = rowRequiredText(object.name, `${field}.name`);
  const status = storedToolStatus(object.status);
  const occurredAt = storedEffectOptionalText(object.occurredAt, `${field}.occurredAt`);
  const providerRole = storedEffectOptionalText(object.providerRole, `${field}.providerRole`);
  const createdSeq = rowPositiveInteger(object.createdSeq, `${field}.createdSeq`);
  const versionSeq = rowPositiveInteger(object.versionSeq, `${field}.versionSeq`);
  if (versionSeq < createdSeq) throw integrity(`Stored tool ${toolCallId} has an invalid version.`);
  return {
    toolCallId,
    conversationId,
    runId,
    ...(agentId ? { agentId } : {}),
    ...(agentInstanceId ? { agentInstanceId } : {}),
    ...(parentAgentInstanceId ? { parentAgentInstanceId } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
    name,
    status,
    createdSeq,
    versionSeq,
    ...(occurredAt ? { occurredAt } : {}),
    ...(providerRole ? { providerRole } : {}),
    ...(Object.hasOwn(object, "input") ? { input: object.input } : {}),
    ...(Object.hasOwn(object, "output") ? { output: object.output } : {}),
  };
}

function storedTodo(value: unknown, field: string, effectSeq?: number): ConversationTodo {
  const object = storedObject(value, field);
  const todoId = rowRequiredText(object.todoId, `${field}.todoId`);
  const conversationId = rowRequiredText(object.conversationId, `${field}.conversationId`);
  const title = rowRequiredTextAllowEmpty(object.title, `${field}.title`);
  const detail = rowRequiredTextAllowEmpty(object.detail, `${field}.detail`);
  const status = storedTodoStatus(object.status);
  const position = rowNonNegativeInteger(object.position, `${field}.position`);
  const updatedAt = rowRequiredText(object.updatedAt, `${field}.updatedAt`);
  const versionSeq = rowPositiveInteger(object.versionSeq, `${field}.versionSeq`);
  if (effectSeq !== undefined && versionSeq > effectSeq) {
    throw integrity(`Stored todo ${todoId} is ahead of its event sequence.`);
  }
  return { todoId, conversationId, title, detail, status, position, updatedAt, versionSeq };
}

function todoFromEventPayload(value: unknown, field: string, versionSeq: number): ConversationTodo {
  const object = payloadObject(value, field);
  const todoId = requireText(object.todoId, `${field}.todoId`);
  const conversationId = requireText(object.conversationId, `${field}.conversationId`);
  if (typeof object.title !== "string") throw v2Invalid(`${field}.title must be a string`);
  if (typeof object.detail !== "string") throw v2Invalid(`${field}.detail must be a string`);
  const status = todoStatusFromEventPayload(object.status, `${field}.status`);
  const position = requireNonNegativeInteger(object.position, `${field}.position`);
  const updatedAt = requireText(object.updatedAt, `${field}.updatedAt`);
  return {
    todoId,
    conversationId,
    title: object.title,
    detail: object.detail,
    status,
    position,
    updatedAt,
    versionSeq,
  };
}

function storedDetail(value: unknown, field: string): ConversationDetailItem {
  const object = storedObject(value, field);
  const itemId = rowRequiredText(object.itemId, `${field}.itemId`);
  const conversationId = rowRequiredText(object.conversationId, `${field}.conversationId`);
  const runId = rowRequiredText(object.runId, `${field}.runId`);
  const agentId = storedEffectOptionalText(object.agentId, `${field}.agentId`);
  const agentInstanceId = storedEffectOptionalText(object.agentInstanceId, `${field}.agentInstanceId`);
  const parentAgentInstanceId = storedEffectOptionalText(
    object.parentAgentInstanceId,
    `${field}.parentAgentInstanceId`,
  );
  const parentAgentId = storedEffectOptionalText(object.parentAgentId, `${field}.parentAgentId`);
  const parentToolCallId = storedEffectOptionalText(object.parentToolCallId, `${field}.parentToolCallId`);
  const toolCallId = storedEffectOptionalText(object.toolCallId, `${field}.toolCallId`);
  const type = rowRequiredText(object.type, `${field}.type`);
  const createdSeq = rowPositiveInteger(object.createdSeq, `${field}.createdSeq`);
  const versionSeq = rowPositiveInteger(object.versionSeq, `${field}.versionSeq`);
  if (versionSeq < createdSeq) throw integrity(`Stored detail ${itemId} has an invalid version.`);
  const content = storedEffectOptionalTextAllowEmpty(object.content, `${field}.content`);
  const ref = storedEffectOptionalTextAllowEmpty(object.ref, `${field}.ref`);
  return {
    itemId,
    conversationId,
    runId,
    ...(agentId ? { agentId } : {}),
    ...(agentInstanceId ? { agentInstanceId } : {}),
    ...(parentAgentInstanceId ? { parentAgentInstanceId } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    type,
    createdSeq,
    versionSeq,
    ...(content !== undefined ? { content } : {}),
    ...(ref !== undefined ? { ref } : {}),
  };
}

function buildBootstrapResponse(
  stream: StreamRow,
  conversationId: string,
  messagesNewestFirst: readonly ConversationMessage[],
  turns: readonly ConversationTurnSummary[],
  runs: readonly ConversationRun[],
  tools: readonly ConversationToolCall[],
  toolSummaryCounts: Readonly<Record<string, number>>,
  agents: readonly ConversationAgent[],
  todos: readonly ConversationTodo[],
  details: readonly ConversationDetailItem[],
  hasOlderFor: (oldest: ConversationMessage | undefined) => boolean,
): ConversationBootstrap {
  const oldest = messagesNewestFirst.at(-1);
  const hasOlder = hasOlderFor(oldest);
  return {
    protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
    storeEpoch: stream.store_epoch,
    conversationId,
    snapshotSeq: stream.last_seq,
    historyRevision: stream.history_revision,
    messages: [...messagesNewestFirst].reverse(),
    turns: [...turns],
    runs: [...runs],
    tools: [...tools],
    ...(Object.keys(toolSummaryCounts).length > 0 ? { toolSummaryCounts: { ...toolSummaryCounts } } : {}),
    agents: [...agents],
    todos: [...todos],
    ...(details.length > 0 ? { details: [...details] } : {}),
    ...(oldest && hasOlder
      ? {
          olderCursor: encodeConversationCursor({
            kind: "messages",
            storeEpoch: stream.store_epoch,
            historyRevision: stream.history_revision,
            createdSeq: oldest.createdSeq,
            id: oldest.messageId,
          }),
        }
      : {}),
    hasOlder,
  };
}

function fitPage<T>(rows: T[], limit: number, maxBytes: number): T[] {
  const selected: T[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const rowBytes = estimateConversationBytes(row);
    if (selected.length > 0 && bytes + rowBytes > maxBytes) break;
    if (selected.length === 0 && rowBytes > maxBytes)
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.payloadTooLarge,
        "The first page item exceeds maxBytes.",
      );
    selected.push(row);
    bytes += rowBytes;
  }
  return selected;
}

function normalizeLimit(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw v2Invalid("Conversation V2 limit must be a positive integer.");
  }
  return Math.min(value, maximum);
}

function normalizeBytes(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw v2Invalid("Conversation V2 maxBytes must be a positive integer.");
  }
  return Math.min(value, 8 * 1024 * 1024);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw v2Invalid(`${field} is required`);
  return value.trim();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw v2Invalid(`${field} must be a string`);
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw v2Invalid(`${field} must be a non-negative integer`);
  }
  return value;
}

function requireCommandJobType(value: unknown): ConversationCommandJobType {
  if (typeof value !== "string" || !CONVERSATION_COMMAND_JOB_TYPES.has(value as ConversationCommandJobType)) {
    throw v2Invalid("commandType is unsupported");
  }
  return value as ConversationCommandJobType;
}

function storedCommandJobType(value: unknown): ConversationCommandJobType {
  try {
    return requireCommandJobType(value);
  } catch {
    throw integrity("Stored command job type is unsupported.");
  }
}

function storedCommandJobStatus(value: unknown): ConversationCommandJobStatus {
  if (value !== "accepted" && value !== "running" && value !== "completed" && value !== "failed") {
    throw integrity("Stored command job status is unsupported.");
  }
  return value;
}

function requireCommandCheckpointName(value: unknown): ConversationCommandCheckpointName {
  if (
    value !== "execution.claimed" &&
    value !== "history.sdk_fork_requested" &&
    value !== "history.sdk_fork_created" &&
    value !== "history.sdk_fork_skipped" &&
    value !== "history.local_rewrite_committed" &&
    value !== "history.runtime_dispatch_prepared" &&
    value !== "history.runtime_dispatched" &&
    value !== "plan.context_frozen" &&
    value !== "plan.snapshot_persisted" &&
    value !== "plan.session_mode_committed" &&
    value !== "plan.bridge_resolved" &&
    value !== "plan.bridge_continuation_resumed" &&
    value !== "plan.runtime_dispatch_prepared" &&
    value !== "plan.runtime_dispatched" &&
    value !== "plan.pending_cleared" &&
    value !== "plan.dismissal_committed"
  ) {
    throw v2Invalid("command checkpoint name is unsupported");
  }
  return value;
}

function storedCommandCheckpointName(value: unknown): ConversationCommandCheckpointName {
  try {
    return requireCommandCheckpointName(value);
  } catch {
    throw integrity("Stored command checkpoint name is unsupported.");
  }
}

function assertNextCommandCheckpoint(
  checkpoints: readonly ConversationCommandCheckpoint[],
  next: ConversationCommandCheckpointName,
  stored = false,
): void {
  const previous = checkpoints.at(-1)?.name;
  const allowed =
    previous === undefined
      ? next === "execution.claimed"
      : previous === "execution.claimed"
        ? next === "history.sdk_fork_requested" ||
          next === "history.sdk_fork_skipped" ||
          next === "history.runtime_dispatch_prepared" ||
          next === "plan.context_frozen"
        : previous === "history.sdk_fork_requested"
          ? next === "history.sdk_fork_created"
          : previous === "history.sdk_fork_created" || previous === "history.sdk_fork_skipped"
            ? next === "history.local_rewrite_committed"
            : previous === "history.local_rewrite_committed"
              ? next === "history.runtime_dispatch_prepared"
              : previous === "history.runtime_dispatch_prepared"
                ? next === "history.runtime_dispatched"
                : previous === "plan.context_frozen" ||
                    previous === "plan.snapshot_persisted" ||
                    previous === "plan.session_mode_committed" ||
                    previous === "plan.bridge_resolved" ||
                    previous === "plan.bridge_continuation_resumed" ||
                    previous === "plan.runtime_dispatch_prepared" ||
                    previous === "plan.runtime_dispatched"
                  ? next === "plan.snapshot_persisted" ||
                    next === "plan.session_mode_committed" ||
                    next === "plan.bridge_resolved" ||
                    next === "plan.bridge_continuation_resumed" ||
                    next === "plan.runtime_dispatch_prepared" ||
                    next === "plan.runtime_dispatched" ||
                    next === "plan.pending_cleared" ||
                    next === "plan.dismissal_committed"
                  : false;
  if (!allowed) {
    const message = `Invalid command checkpoint transition: ${previous ?? "start"} -> ${next}.`;
    if (stored) throw integrity(message);
    throw new ConversationV2Error(CONVERSATION_V2_ERROR.idempotencyConflict, message);
  }
}

function isNonRewindRetryCommand(job: ConversationCommandJob): boolean {
  return job.commandType === "history.retry" && job.request.rewind === false;
}

function isPlanCommandCheckpoint(name: ConversationCommandCheckpointName): boolean {
  return name.startsWith("plan.");
}

function durableJson(value: unknown, field: string): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("value is not JSON serializable");
    JSON.parse(json);
    return json;
  } catch {
    throw v2Invalid(`${field} must be JSON serializable`);
  }
}

function durableJsonRecord(value: unknown, field: string): Record<string, unknown> {
  const parsed = JSON.parse(durableJson(value, field)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw v2Invalid(`${field} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function parseDurableJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") throw integrity(`Stored ${field} is invalid.`);
  try {
    return JSON.parse(value);
  } catch {
    throw integrity(`Stored ${field} is not valid JSON.`);
  }
}

function parseDurableJsonRecord(value: unknown, field: string): Record<string, unknown> {
  const parsed = parseDurableJson(value, field);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw integrity(`Stored ${field} is not an object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseOptionalDurableJson(value: unknown, field: string): unknown {
  return value === null ? undefined : parseDurableJson(value, field);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInputText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw v2Invalid(`${field} must be a string`);
  return value.trim() || undefined;
}

function requireEventId(value: unknown, field: string): string {
  return requireText(value, field);
}

function optionalPayloadText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw v2Invalid(`${field} must be a string`);
  return value.trim() || undefined;
}

function parseMessageOrigin(value: unknown, field: string, stored = false): ConversationMessageOrigin | undefined {
  if (value === undefined) return undefined;
  if (!isConversationMessageOrigin(value)) {
    throw stored ? integrity(`Stored ${field} is invalid.`) : v2Invalid(`${field} must be a valid scheduled-message origin`);
  }
  return { kind: value.kind, scheduleId: value.scheduleId, name: value.name };
}

function optionalPayloadHistoryTarget(
  value: unknown,
  field: string,
): ConversationMessageHistoryTarget | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw v2Invalid(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const activityLineId = optionalPayloadText(record.activityLineId, `${field}.activityLineId`);
  if (!activityLineId) throw v2Invalid(`${field}.activityLineId is required`);
  const userMessageId = optionalPayloadText(record.userMessageId, `${field}.userMessageId`);
  return {
    activityLineId,
    ...(userMessageId ? { userMessageId } : {}),
  };
}

function providerHistoryTargetPatch(
  patch: Record<string, unknown>,
): ConversationMessageHistoryTarget | undefined {
  const metadataMerge = patch.metadataMerge;
  if (!metadataMerge || typeof metadataMerge !== "object" || Array.isArray(metadataMerge)) {
    return undefined;
  }
  return optionalPayloadHistoryTarget(
    (metadataMerge as Record<string, unknown>).rewindTarget,
    "metadataMerge.rewindTarget",
  );
}

function optionalPayloadArray(value: unknown, field: string): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw v2Invalid(`${field} must be an array`);
  return value;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw integrity(`Stored ${field} is invalid.`);
  return value;
}

function optionalStoredArray(value: unknown, field: string): unknown[] | undefined {
  if (value === undefined) return undefined;
  return requiredArray(value, field);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return stableJson(left ?? null) === stableJson(right ?? null);
}

function rowRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw integrity(`Stored ${field} is invalid.`);
  }
  return value;
}

function rowRequiredTextAllowEmpty(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw integrity(`Stored ${field} is invalid.`);
  }
  return value;
}

function rowOptionalText(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw integrity(`Stored ${field} is invalid.`);
  }
  return value;
}

function rowOptionalTextAllowEmpty(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw integrity(`Stored ${field} is invalid.`);
  }
  return value;
}

function storedObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw integrity(`Stored ${field} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function storedEffectOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return rowRequiredText(value, field);
}

function storedHistoryTarget(value: unknown, field: string): ConversationMessageHistoryTarget | undefined {
  if (value === undefined) return undefined;
  const object = storedObject(value, field);
  const activityLineId = rowRequiredText(object.activityLineId, `${field}.activityLineId`);
  const userMessageId = storedEffectOptionalText(object.userMessageId, `${field}.userMessageId`);
  return {
    activityLineId,
    ...(userMessageId ? { userMessageId } : {}),
  };
}

/** Copies present optional text fields of a stored wire object. */
function optionalStoredTextFields(
  object: Record<string, unknown>,
  field: string,
  keys: readonly string[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = storedEffectOptionalText(object[key], `${field}.${key}`);
    if (value !== undefined) values[key] = value;
  }
  return values;
}

function storedEffectOptionalTextAllowEmpty(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return rowRequiredTextAllowEmpty(value, field);
}

function storedWireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw integrity(`Stored ${field} is invalid.`);
  return value;
}

function rowNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw integrity(`Stored ${field} is invalid.`);
  }
  return value;
}

function rowPositiveInteger(value: unknown, field: string): number {
  const integerValue = rowNonNegativeInteger(value, field);
  if (integerValue < 1) throw integrity(`Stored ${field} is invalid.`);
  return integerValue;
}

function rowBoolean(value: unknown, field: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw integrity(`Stored ${field} is invalid.`);
}

function storedEventType(value: unknown): ConversationEventInput["type"] {
  if (typeof value === "string" && CONVERSATION_V2_EVENT_TYPES.has(value as ConversationEventInput["type"])) {
    return value as ConversationEventInput["type"];
  }
  throw new ConversationV2Error(
    CONVERSATION_V2_ERROR.unsupportedVersion,
    `Unsupported Conversation V2 event type: ${String(value)}`,
  );
}

function isKnownEffectType(value: string): value is ConversationEffect["type"] {
  return CONVERSATION_V2_EFFECT_TYPES.has(value as ConversationEffect["type"]);
}

function storedMessageRole(value: unknown): ConversationMessage["role"] {
  if (value === "user" || value === "assistant" || value === "system" || value === "tool") {
    return value;
  }
  throw integrity(`Stored message role is invalid: ${String(value)}`);
}

function storedMessageChannel(value: unknown): ConversationMessage["channel"] {
  if (
    value === "answer" ||
    value === "commentary" ||
    value === "thinking" ||
    value === "system" ||
    value === "tool"
  ) {
    return value;
  }
  throw integrity(`Stored message channel is invalid: ${String(value)}`);
}

function storedMessageStatus(value: unknown): ConversationMessage["status"] {
  if (
    value === "queued" ||
    value === "streaming" ||
    value === "final" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "deleted"
  ) {
    return value;
  }
  throw integrity(`Stored message status is invalid: ${String(value)}`);
}

function storedRunStatus(value: unknown): ConversationRun["status"] {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted" ||
    value === "unknown"
  ) {
    return value;
  }
  throw integrity(`Stored run status is invalid: ${String(value)}`);
}

function storedTimingQuality(value: unknown): ConversationRun["timingQuality"] {
  if (value === "recorded" || value === "unknown" || value === "estimated") return value;
  throw integrity(`Stored run timing quality is invalid: ${String(value)}`);
}

function storedToolStatus(value: unknown): ConversationToolCall["status"] {
  if (
    value === "started" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw integrity(`Stored tool status is invalid: ${String(value)}`);
}

function storedTodoStatus(value: unknown): ConversationTodo["status"] {
  if (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "blocked" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw integrity(`Stored todo status is invalid: ${String(value)}`);
}

function todoStatusFromEventPayload(value: unknown, field: string): ConversationTodo["status"] {
  if (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "blocked" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw v2Invalid(`${field} is unsupported`);
}

function payloadString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw v2Invalid(`${field} must be a string`);
  return value;
}

function payloadObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw v2Invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw v2Invalid(`${field} must be a safe integer`);
  }
  return value;
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw integrity("Stored JSON is invalid.");
  try {
    return JSON.parse(value);
  } catch {
    throw integrity("Stored JSON is invalid.");
  }
}

function messageRole(value: unknown): ConversationMessage["role"] {
  if (value === undefined) return "assistant";
  if (value === "user" || value === "assistant" || value === "system" || value === "tool") return value;
  throw v2Invalid(`message role is invalid: ${String(value)}`);
}

function messageChannel(value: unknown): ConversationMessage["channel"] {
  if (value === undefined) return "answer";
  if (
    value === "answer" ||
    value === "commentary" ||
    value === "thinking" ||
    value === "system" ||
    value === "tool"
  )
    return value;
  throw v2Invalid(`message channel is invalid: ${String(value)}`);
}

function messageStatus(
  value: unknown,
  fallback: ConversationMessage["status"],
): ConversationMessage["status"] {
  if (value === undefined) return fallback;
  if (
    value === "queued" ||
    value === "streaming" ||
    value === "final" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "deleted"
  )
    return value;
  throw v2Invalid(`message status is invalid: ${String(value)}`);
}

function runStatusForEvent(type: ConversationEventInput["type"], value: unknown): ConversationRun["status"] {
  if (type === "run.corrected") {
    return validateRunStatusValue(value, "status");
  }
  const expected =
    type === "run.started"
      ? "running"
      : type === "run.completed"
        ? "completed"
        : type === "run.failed"
          ? "failed"
          : type === "run.cancelled"
            ? "cancelled"
            : "interrupted";
  if (value !== undefined && value !== expected) {
    throw v2Invalid(`${type} cannot carry status ${String(value)}.`);
  }
  return expected;
}

function validateRunStatusValue(value: unknown, field: string): ConversationRun["status"] {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted" ||
    value === "unknown"
  ) {
    return value;
  }
  throw v2Invalid(`${field} is an invalid run status: ${String(value)}`);
}

function validateNullableTimestamp(value: unknown, field: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw v2Invalid(`${field} must be a string or null.`);
  }
}

function correctionTimestamp(
  payload: Record<string, unknown>,
  field: "startedAt" | "endedAt",
  fallback: string | undefined,
): string | undefined {
  if (!Object.hasOwn(payload, field)) return fallback;
  const value = payload[field];
  if (value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw v2Invalid(`run.corrected ${field} must be a non-empty string or null.`);
  }
  return value;
}

function validateRunCorrectionPayload(payload: Record<string, unknown>, existingStatus: unknown): void {
  if (payload.authority !== "admin") {
    throw v2Invalid("run.corrected requires admin authority.");
  }
  if (typeof payload.actorPrincipalId !== "string" || !payload.actorPrincipalId.trim()) {
    throw v2Invalid("run.corrected actorPrincipalId is required.");
  }
  if (typeof payload.reason !== "string" || !payload.reason.trim()) {
    throw v2Invalid("run.corrected reason is required.");
  }
  const expectedPreviousStatus = validateRunStatusValue(
    payload.expectedPreviousStatus,
    "expectedPreviousStatus",
  );
  if (existingStatus !== undefined && expectedPreviousStatus !== existingStatus) {
    throw integrity(
      `run.corrected expected ${expectedPreviousStatus}, but the stored run is ${String(existingStatus)}.`,
    );
  }
  validateRunStatusValue(payload.status, "status");
  validateNullableTimestamp(payload.startedAt, "startedAt");
  validateNullableTimestamp(payload.endedAt, "endedAt");
}

function agentStatusForEvent(type: ConversationEventInput["type"]): string {
  switch (type) {
    case "agent.created":
    case "agent.started":
      return "running";
    case "agent.completed":
      return "completed";
    case "agent.failed":
      return "failed";
    case "agent.cancelled":
      return "cancelled";
    default:
      return "interrupted";
  }
}

function toolStatusForEvent(
  type: ConversationEventInput["type"],
  value: unknown,
): ConversationToolCall["status"] {
  if (type === "tool.started" || type === "tool.updated") {
    if (value === undefined || value === "started" || value === "running") {
      return value === "started" ? "started" : "running";
    }
  } else if (type === "tool.completed") {
    if (value === undefined || value === "completed") return "completed";
  } else if (type === "tool.failed") {
    if (value === undefined || value === "failed") return "failed";
  }
  throw v2Invalid(`${type} cannot carry status ${String(value)}.`);
}

function timingQualityValue(value: unknown): ConversationRun["timingQuality"] {
  if (value === "recorded" || value === "unknown" || value === "estimated") return value;
  throw v2Invalid(`timingQuality is invalid: ${String(value)}`);
}

/**
 * Keep local filesystem paths out of the durable V2 event when an attachment
 * already has a content-addressed identity. The preview stays bounded and is
 * useful to render immediately; the desktop object store remains the source
 * for runtime reads and remote chunk retrieval.
 */
function sanitizeConversationV2Attachments(value: unknown[] | undefined): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = { ...(entry as Record<string, unknown>) };
    const contentRef = typeof record.contentRef === "string" ? record.contentRef.trim() : "";
    if (/^sha256:[0-9a-f]{64}$/.test(contentRef)) {
      delete record.path;
      record.contentRef = contentRef;
    }
    return record;
  });
}

function v2Invalid(message: string): ConversationV2Error {
  return new ConversationV2Error(CONVERSATION_V2_ERROR.invalidParams, message);
}

function integrity(message: string): ConversationV2Error {
  return new ConversationV2Error(CONVERSATION_V2_ERROR.integrityFailure, message);
}

// Keep these imports referenced in generated bundles where tree-shaking would otherwise
// remove the protocol's canonical JSON helper from the replay path.
void stableJson;
