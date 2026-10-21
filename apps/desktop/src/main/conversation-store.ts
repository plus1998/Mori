import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  type CoreKind,
  createToolOutputPreview,
  isCoreKind,
  isFreshSubagentRequest,
  mergeStreamText,
  resolveAcpHostUiFeatures,
} from "@eco/runtime";
import { CONVERSATION_V2_ERROR, ConversationV2Error, normalizeAgentRole, stableHash } from "@eco/shared";
import { logSuspiciousActivityLine, repairActivityText } from "../shared/activity-text";
import { normalizeBillingSnapshotRoles, normalizeContextSnapshotRoles } from "../shared/agent-role-snapshots";
import type { ThreadRunProjectionSnapshot } from "../shared/conversation-v2-projection";
import { parseThreadRunFileChangeMetadata } from "../shared/file-change.js";
import type {
  CoderTodoItem,
  ComposerDraftRecord,
  ConversationV2ProjectionExtras,
  PromptImageAttachment,
  RuntimeAgentRole,
  ThreadActivityLine,
  ThreadApiErrorInfo,
  ThreadContextSnapshot,
  ThreadFollowUpBoundary,
  ThreadFollowUpDeliveryMode,
  ThreadFollowUpPriority,
  ThreadFollowUpRunPhase,
  ThreadFollowUpStatus,
  ThreadForkFromMessageResult,
  ThreadPendingFollowUp,
  ThreadPendingPlan,
  ThreadRunEvent,
  ThreadRunEventInput,
  ThreadRunProjectionRequestSpan,
  ThreadRunToolMetadata,
  ThreadRuntimeConfig,
  ThreadStatus,
  ThreadSubagentMetricsSummary,
  ThreadSubagentSessionTiming,
  ThreadSummary,
  ThreadUsageLedgerEventView,
  TokenCostBreakdown,
} from "../shared/ipc";
import {
  attachPeerGatewayTimingToLedgerEventViews,
  attachSpanTimingToLedgerEventViews,
} from "../shared/ledger-event-timing";
import { readPromptImagePreviews } from "../shared/prompt-image-metadata";
import {
  mergeThreadRunImageViewMetadata,
  parseThreadRunCodemodeMetadata,
  parseThreadRunImageViewMetadata,
} from "../shared/thread-run-events";
import { keepsOutputPreview, projectThreadRunToolMetadata } from "../shared/thread-run-tool-projection.js";
import { parseThreadRuntimeConfigJson, serializeThreadRuntimeConfig } from "../shared/thread-runtime-config";
import { parseThreadRunGrepToolTarget, parseThreadRunReadToolTarget } from "../shared/tool-target.js";
import { upgradeLegacyCursorCore } from "../shared/upgrade-legacy-cursor-core";
import {
  classifyHistoryCommandRecovery,
  type HistoryCommandRecoveryDecision,
} from "./conversation-command-recovery";
import { buildForkHistoryEvents, type ConversationForkHistory } from "./conversation-fork-history";
import type { NativeConversationFork } from "./conversation-native-fork";
import { conversationV2AgentEvent } from "./conversation-v2-agent-events";
import { migrateCodexCompactionDetails } from "./conversation-v2-compaction-migration";
import {
  appendLegacyThreadRunEventToConversationV2,
  conversationV2MessageIdForLegacyEvent,
  withLegacyConversationV2MessageIdentity,
} from "./conversation-v2-legacy-adapter";
import { ConversationV2LegacyMigrator } from "./conversation-v2-legacy-migration";
import { conversationV2RunEventForAttempt } from "./conversation-v2-run-events";
import { buildThreadRunProjectionRequestSpans } from "./conversation-v2-runtime-projection";
import { ConversationV2RuntimeWriter } from "./conversation-v2-runtime-writer";
import {
  type ConversationAppendResult,
  type ConversationPendingPlanV2,
  type ConversationV2StorageMode,
  ConversationV2Store,
  type ConversationV2UsageLedgerRow,
} from "./conversation-v2-store";
import {
  FEED_SKELETON_RULES_VERSION,
  type FeedSkeletonPatchState,
  type ThreadFeedSkeletonRecord,
} from "./legacy-feed-skeleton-store";
import {
  collectPromptImageContentRefs,
  isPromptImageAttachmentRecord,
  isPromptImageContentRef,
  type PromptImageFileStore,
} from "./prompt-image-file-store";
import { resolveAcpThreadAgentId } from "./resolve-acp-thread-agent-id";
import { sdkActivityLineId, sdkMessageUuidFromActivityLineId } from "./sdk-session-activity.js";
import { resolveResumeAgentIdFromRecords } from "./subagent-session-resolve.js";
import type {
  SubagentRunPhase,
  SubagentSessionStatus,
  ThreadSubagentSessionRecord,
} from "./subagent-session-types.js";
import { shouldAdvanceThreadRunEventSequence } from "./thread-run-event-sequence";
import { isCollapsibleStreamEvent, sameStreamIdentity } from "./thread-run-message-blocks";
import type { SerializedThreadUsageState } from "./thread-usage-accumulator";
import {
  type AgentInstanceKind,
  type AgentInstanceRecord,
  type AgentInstanceStatus,
  normalizeRunAttemptPhase,
  type RunAttemptCommandDispatch,
  type RunAttemptRecord,
  type RunAttemptStatus,
  type UsageAttribution,
  type UsageLedgerAttributionUpdate,
  type UsageLedgerEvent,
  type UsageLedgerKind,
  type UsageLedgerSource,
} from "./usage-ledger";
import { buildThreadUsageLedgerEventView } from "./usage-ledger-view";

function rollbackConversationTransaction(db: DatabaseSyncType): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // SQLite may already have rolled back after SQLITE_FULL or another fatal
    // storage error. Keep the original transaction failure visible.
  }
}

interface ThreadRow {
  id: string;
  title: string;
  prompt: string;
  workspace_path: string;
  status: string;
  message: string;
  created_at: string;
  updated_at: string;
  core_kind: string | null;
  core_locked_at: string | null;
  acp_agent_id: string | null;
  sdk_session_id: string | null;
  sdk_cwd: string | null;
  routes_fingerprint: string | null;
  runtime_config_json: string | null;
  external_session_id: string | null;
  follow_up_queue_paused: number | null;
}

export interface ThreadListCursor {
  updatedAt: string;
  createdAt: string;
  id: string;
}

export interface ThreadListPageMetadata {
  hasMore: boolean;
  totalCount: number;
  nextCursor?: ThreadListCursor;
}

export interface ThreadListPage extends ThreadListPageMetadata {
  threads: ThreadSummary[];
}

export interface ThreadListInitialResult {
  threads: ThreadSummary[];
  pages: Record<string, ThreadListPageMetadata>;
}

export interface ThreadSdkSession {
  sessionId: string;
  cwd: string;
  resetPending?: boolean;
}

export interface ThreadCoreSession {
  threadId: string;
  coreKind: CoreKind;
  externalSessionId: string;
  cwd: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadUserMessageRecord {
  threadId: string;
  activityLineId: string;
  upstreamMessageId?: string;
  provider?: CoreKind;
  text: string;
  attachments: PromptImageAttachment[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreadActivityRewindSummary {
  activityLineId: string;
  userMessageId: string;
  cutoffCreatedAt: string;
  cutoffRunSequence: number;
  removedActivityCount: number;
  removedRunEventCount: number;
}

export interface ThreadHistoryCommandContext {
  principalId: string;
  clientCommandId: string;
}

export interface ThreadDeleteCommandInput {
  principalId: string;
  threadId: string;
  clientCommandId: string;
  expectedHistoryRevision: number;
}

export interface ThreadDeleteCommandReceipt {
  principalId: string;
  threadId: string;
  clientCommandId: string;
  requestHash: string;
  expectedHistoryRevision: number;
  status: "accepted" | "completed";
  result?: { ok: true; deleted: true; threadId: string };
  acceptedAt: string;
  updatedAt: string;
}

interface ActivityRow {
  id: string;
  thread_id: string;
  role: string;
  message: string;
  stream: number;
  agent_id: string | null;
  api_error_json: string | null;
  sdk_user_message_id: string | null;
  created_at: string;
}

export interface AppliedDiffRecord {
  threadId: string;
  workspacePath: string;
  diff: string;
  files: string[];
  appliedAt: string;
  rolledBackAt?: string;
}

export interface ThreadMetricsRecord {
  threadId: string;
  accumulator?: SerializedThreadUsageState;
  context?: ThreadContextSnapshot;
  updatedAt: string;
}

export type SubagentMetricsStatus = "active" | "stopped";

export interface ThreadSubagentMetricsRecord {
  threadId: string;
  agentId: string;
  role: RuntimeAgentRole;
  status: SubagentMetricsStatus;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextOccupied: number;
  contextLimit?: number;
  ecoCostUsd: number;
  ecoCostBreakdown: TokenCostBreakdown;
  modelId?: string;
  lastRequestKey?: string;
  updatedAt: string;
}

export interface ThreadCompactionArchiveRecord {
  id: string;
  threadId: string;
  trigger: "auto" | "manual";
  sessionId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type CompactTokenCountSource =
  | "provider_exact"
  | "tokenizer_exact"
  | "sdk_context_usage"
  | "local_heuristic";

/** Stored compact-handoff rows (legacy Eco compact; Cores now compact in-process). */
export interface CompactConversationMessage {
  id?: string;
  role: string;
  message: string;
}

export interface ThreadCompactHandoffRecord {
  threadId: string;
  summaryId: string;
  schemaVersion: number;
  generation: number;
  summary: string;
  recentMessages: CompactConversationMessage[];
  preTokensEstimate: number;
  preTokensSource: CompactTokenCountSource;
  postTokensEstimate: number;
  postTokensSource: CompactTokenCountSource;
  compressionRatio: number;
  sourceSessionId?: string;
  sourceStartMessageId?: string;
  sourceEndMessageId?: string;
  targetSessionId?: string;
  consumedAt?: string;
  createdAt: string;
}

export interface CommitCompactHandoffInput {
  sourceSessionId: string;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
  summary: string;
  recentMessages: CompactConversationMessage[];
  preTokensEstimate: number;
  preTokensSource: CompactTokenCountSource;
  postTokensEstimate: number;
  postTokensSource: CompactTokenCountSource;
  compressionRatio: number;
  schemaVersion?: number;
}

interface CompactHandoffRow {
  thread_id: string;
  summary_id: string;
  schema_version: number;
  generation: number;
  summary: string;
  recent_user_messages_json: string;
  pre_tokens_estimate: number;
  pre_tokens_source: string;
  post_tokens_estimate: number;
  post_tokens_source: string;
  compression_ratio: number;
  source_session_id: string | null;
  source_start_message_id: string | null;
  source_end_message_id: string | null;
  target_session_id: string | null;
  consumed_at: string | null;
  created_at: string;
}

export function parseCompactHandoffRecentMessages(
  serialized: string,
  threadId: string,
): CompactConversationMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`压缩交接近期对话 JSON 损坏（${threadId}）：${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`压缩交接近期对话不是数组（${threadId}）。`);
  }
  return parsed.map((entry, index) => {
    if (typeof entry === "string") {
      const message = entry.trim();
      if (!message) {
        throw new Error(`压缩交接近期对话包含空的 legacy 消息（${threadId}，index=${index}）。`);
      }
      return { role: "user", message };
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { role?: unknown }).role !== "string" ||
      typeof (entry as { message?: unknown }).message !== "string"
    ) {
      throw new Error(`压缩交接近期对话条目结构无效（${threadId}，index=${index}）。`);
    }
    const role = (entry as { role: string }).role.trim();
    const message = (entry as { message: string }).message.trim();
    const rawId = (entry as { id?: unknown }).id;
    if (rawId !== undefined && typeof rawId !== "string") {
      throw new Error(`压缩交接近期对话 id 无效（${threadId}，index=${index}）。`);
    }
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!role || !message) {
      throw new Error(`压缩交接近期对话条目为空（${threadId}，index=${index}）。`);
    }
    return { ...(id && { id }), role, message };
  });
}

function compactHandoffRowToRecord(
  row: CompactHandoffRow,
  requestedThreadId: string,
): ThreadCompactHandoffRecord {
  const summary = row.summary.trim();
  if (!summary) {
    throw new Error(`压缩交接摘要为空（${requestedThreadId}）。`);
  }
  const summaryId = row.summary_id?.trim();
  if (!summaryId) {
    throw new Error(`压缩交接 summary id 无效（${requestedThreadId}）。`);
  }
  const record: ThreadCompactHandoffRecord = {
    threadId: row.thread_id,
    summaryId,
    schemaVersion: Math.trunc(row.schema_version),
    generation: Math.trunc(row.generation),
    summary,
    recentMessages: parseCompactHandoffRecentMessages(row.recent_user_messages_json, requestedThreadId),
    preTokensEstimate: row.pre_tokens_estimate,
    preTokensSource: parseCompactTokenCountSource(row.pre_tokens_source, requestedThreadId),
    postTokensEstimate: row.post_tokens_estimate,
    postTokensSource: parseCompactTokenCountSource(row.post_tokens_source, requestedThreadId),
    compressionRatio: row.compression_ratio,
    ...(row.source_session_id && { sourceSessionId: row.source_session_id }),
    ...(row.source_start_message_id && { sourceStartMessageId: row.source_start_message_id }),
    ...(row.source_end_message_id && { sourceEndMessageId: row.source_end_message_id }),
    ...(row.target_session_id && { targetSessionId: row.target_session_id }),
    ...(row.consumed_at && { consumedAt: row.consumed_at }),
    createdAt: row.created_at,
  };
  validateCompactMetrics(requestedThreadId, record);
  if (record.schemaVersion < 1 || record.generation < 1) {
    throw new Error(`压缩交接版本信息无效（${requestedThreadId}）。`);
  }
  return record;
}

function parseCompactTokenCountSource(value: string, threadId: string): CompactTokenCountSource {
  if (
    value === "provider_exact" ||
    value === "tokenizer_exact" ||
    value === "sdk_context_usage" ||
    value === "local_heuristic"
  ) {
    return value;
  }
  throw new Error(`压缩交接 token 来源无效（${threadId}）：${value}`);
}

function validateCompactMetrics(
  threadId: string,
  input: {
    preTokensEstimate: number;
    postTokensEstimate: number;
    compressionRatio: number;
  },
): void {
  if (
    !Number.isFinite(input.preTokensEstimate) ||
    input.preTokensEstimate <= 0 ||
    !Number.isInteger(input.preTokensEstimate)
  ) {
    throw new Error(`压缩交接压缩前 token 估算无效（${threadId}）。`);
  }
  if (
    !Number.isFinite(input.postTokensEstimate) ||
    input.postTokensEstimate < 0 ||
    !Number.isInteger(input.postTokensEstimate)
  ) {
    throw new Error(`压缩交接压缩后 token 估算无效（${threadId}）。`);
  }
  if (!Number.isFinite(input.compressionRatio) || input.compressionRatio < 0) {
    throw new Error(`压缩交接压缩比例无效（${threadId}）。`);
  }
  const expectedRatio = input.postTokensEstimate / input.preTokensEstimate;
  const ratioTolerance = Math.max(1e-9, Math.abs(expectedRatio) * 1e-9);
  if (Math.abs(input.compressionRatio - expectedRatio) > ratioTolerance) {
    throw new Error(`压缩交接压缩比例与 token 估算不一致（${threadId}）。`);
  }
}

interface AppliedDiffRow {
  thread_id: string;
  workspace_path: string;
  diff: string;
  files_json: string;
  applied_at: string;
  rolled_back_at: string | null;
}

interface UsageLedgerEventRow {
  id: string;
  idempotency_key: string;
  thread_id: string;
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

interface ThreadRunEventRow {
  id: string;
  thread_id: string;
  sequence: number;
  event_type: string;
  scope: string;
  role: string | null;
  agent_id: string | null;
  parent_agent_id: string | null;
  parent_tool_use_id: string | null;
  run_attempt_id: string | null;
  request_id: string | null;
  stream_key: string | null;
  stream_state: string;
  message: string;
  metadata_json: string | null;
  observed_at: string;
}

interface ThreadPendingFollowUpRow {
  id: string;
  thread_id: string;
  prompt: string;
  attachments_json: string | null;
  priority: string;
  status: string;
  delivery_mode: string;
  source_run_attempt_id: string | null;
  target_run_attempt_id: string | null;
  queued_during_phase: string | null;
  delivery_boundary: string | null;
  error: string | null;
  queue_position: number | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  applied_at: string | null;
  conversation_message_id: string | null;
}

const threadOwnedTables = [
  "thread_core_sessions",
  "thread_activity",
  "thread_pending_followups",
  "conversation_followups_v2",
  "thread_pending_plans",
  "thread_coder_todos",
  "thread_applied_diffs",
  "thread_metrics_snapshots",
  "thread_compaction_archives",
  "thread_compact_handoff",
  "thread_subagent_sessions",
  "thread_subagent_metrics",
  "thread_run_attempts",
  "thread_agent_instances",
  "thread_usage_ledger_events",
  "thread_run_events",
  "thread_user_messages",
  "thread_feed_skeleton",
] as const;

/**
 * Tables that prove a database still contains an unmigrated V1 conversation
 * source. Common thread metadata tables are intentionally excluded: a fresh
 * database may already have those tables before its first V2 conversation is
 * written.
 */
const legacyConversationSourceTables = [
  "thread_activity",
  "thread_pending_followups",
  "thread_pending_plans",
  "thread_coder_todos",
  "thread_subagent_sessions",
  "thread_subagent_metrics",
  "thread_run_attempts",
  "thread_agent_instances",
  "thread_usage_ledger_events",
  "thread_run_events",
  "thread_user_messages",
  "thread_feed_skeleton",
  "thread_metrics_snapshots",
] as const;
const legacyConversationSourceTableSet = new Set<string>(legacyConversationSourceTables);

const MAX_PROJECTION_EVENT_CACHE_ENTRIES = 16;
const MAX_HOT_THREAD_RUN_EVENT_CACHE_ENTRIES = 256;
/** Sentinel maxEvents value meaning the cache holds the unbounded projection event list. */
const FULL_PROJECTION_EVENT_CACHE_MAX = 0;

const CONVERSATION_V2_RUN_LIVE_SOURCE_PREFIX = "desktop:run";
const CONVERSATION_V2_RUN_RECONCILE_SOURCE_PREFIX = "desktop:run-reconciled";

/**
 * One-time conversation repairs. Each key records, per conversation, that the
 * repair has already run, so startup and conversation loads stop rescanning a
 * conversation that has nothing left to fix.
 */
const CONVERSATION_V2_REPAIR_CODEX_USER_DUPLICATES = "codex-user-echo-duplicate";
const CONVERSATION_V2_REPAIR_ACCEPTED_PROMPT_DUPLICATES = "accepted-prompt-duplicate";

function normalizeLegacyRunAttemptStatus(value: string): RunAttemptStatus | undefined {
  const status = value.trim().toLowerCase();
  if (status === "running" || status === "completed" || status === "failed") return status;
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return undefined;
}

/** Normalize statuses written by older agent-lifecycle snapshots for read-only parity. */
function normalizeLegacyAgentInstanceStatus(value: string): AgentInstanceStatus | undefined {
  const status = value.trim().toLowerCase();
  if (status === "launching" || status === "active") return status;
  if (status === "running") return "active";
  if (status === "stopped" || status === "completed") return "stopped";
  if (status === "abandoned" || status === "failed" || status === "killed") return "abandoned";
  return undefined;
}

function sameRunAttemptRecord(left: RunAttemptRecord, right: RunAttemptRecord): boolean {
  return (
    left.threadId === right.threadId &&
    left.attemptId === right.attemptId &&
    left.phase === right.phase &&
    left.retryIndex === right.retryIndex &&
    left.status === right.status &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    stableHash(left.metadata ?? null) === stableHash(right.metadata ?? null)
  );
}

interface ProjectionEventCacheEntry {
  maxEvents: number;
  events: ThreadRunEvent[];
}

export interface ConversationStoreOptions {
  /**
   * Storage mode for an empty database. Existing V1 source tables always win
   * and remain in legacy_compat until an explicit maintenance cutover.
   */
  freshStorageMode?: ConversationV2StorageMode;
  /**
   * Runtime callers may require an already-cut-over store. Pass null to allow
   * an existing legacy_compat database and migrate individual conversations on
   * demand. When omitted, callers retain the strict V2-only default.
   */
  requiredStorageMode?: ConversationV2StorageMode | null;
  /**
   * Must be provided before initialization when a V2-only reopen may need to
   * materialize legacy follow-up image payloads before retiring the old table.
   */
  promptImageFileStore?: PromptImageFileStore;
}

export async function createConversationStore(
  dbPath: string,
  options: ConversationStoreOptions = {},
): Promise<ConversationStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  // Keep the strict V2-only default for tools and tests. The desktop runtime
  // explicitly opts into legacy_compat while it lazily migrates V1 threads.
  const { requiredStorageMode, ...otherOptions } = options;
  const resolvedOptions: ConversationStoreOptions = {
    ...otherOptions,
    freshStorageMode: otherOptions.freshStorageMode ?? "v2_only",
    ...(requiredStorageMode === null ? {} : { requiredStorageMode: requiredStorageMode ?? "v2_only" }),
  };
  const store = new ConversationStore(new sqlite.DatabaseSync(dbPath), resolvedOptions);
  store.initialize();
  return store;
}

export class ConversationStore {
  private readonly projectionEventCache = new Map<string, ProjectionEventCacheEntry>();
  private readonly hotThreadRunEventCache = new Map<string, ThreadRunEvent>();
  private readonly nextThreadRunEventSequences = new Map<string, number>();
  private readonly threadRunEventAppendedListeners = new Set<(event: ThreadRunEvent) => void>();
  private readonly v2: ConversationV2Store;
  private readonly runtimeWriter: ConversationV2RuntimeWriter;
  private storageMode: ConversationV2StorageMode = "legacy_compat";
  private promptImageFileStore: PromptImageFileStore | undefined;

  constructor(
    private readonly db: DatabaseSyncType,
    private readonly options: ConversationStoreOptions = {},
  ) {
    this.v2 = new ConversationV2Store(db);
    this.runtimeWriter = new ConversationV2RuntimeWriter(db, this.v2);
    this.promptImageFileStore = options.promptImageFileStore;
  }

  onThreadRunEventAppended(listener: (event: ThreadRunEvent) => void): () => void {
    this.threadRunEventAppendedListeners.add(listener);
    return () => {
      this.threadRunEventAppendedListeners.delete(listener);
    };
  }

  private notifyThreadRunEventAppended(event: ThreadRunEvent): void {
    for (const listener of this.threadRunEventAppendedListeners) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(
          `[eco] thread run event listener failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  setPromptImageFileStore(store: PromptImageFileStore): void {
    this.promptImageFileStore = store;
  }

  /** V2 is the durable event/effect API used by the new sync protocol. */
  conversationV2(): ConversationV2Store {
    this.v2.initialize();
    this.storageMode = this.v2.getStorageMode();
    return this.v2;
  }

  getConversationStorageMode(): ConversationV2StorageMode {
    return this.storageMode;
  }

  /**
   * Mark content-addressed image objects referenced by both V2 storage and
   * durable composer drafts. The GC caller uses this set before deleting any
   * object, so a pending resend cannot lose its source bytes. The V2 event log
   * dominates the cost, so that part of the walk yields to the event loop
   * instead of holding the main process for the whole scan.
   */
  async listReferencedPromptImageContentRefs(): Promise<Set<string>> {
    const refs = await this.v2.collectReferencedPromptImageContentRefs();
    if (this.tableExists("composer_drafts")) {
      const rows = this.db.prepare(`SELECT attachments_json FROM composer_drafts`).all() as Array<{
        attachments_json: string | null;
      }>;
      for (const row of rows) {
        if (row.attachments_json) collectPromptImageContentRefs(row.attachments_json, refs);
      }
    }
    // A legacy-compatible process may still have a queued follow-up before
    // its next atomic cutover. Keep those objects marked as well; V2-only
    // databases retire this table and never recreate it.
    if (!this.isV2OnlyStorage() && this.tableExists("thread_pending_followups")) {
      const rows = this.db.prepare(`SELECT attachments_json FROM thread_pending_followups`).all() as Array<{
        attachments_json: string | null;
      }>;
      for (const row of rows) {
        if (row.attachments_json) collectPromptImageContentRefs(row.attachments_json, refs);
      }
    }
    return new Set([...refs].filter((ref) => isPromptImageContentRef(ref)));
  }

  /**
   * Keep the desktop CAS reader scoped to the composer draft, conversation, or
   * landing draft that supplied the reference. V2-only never falls back to
   * retired V1 rows.
   */
  isPromptImageContentRefAuthorized(contextKey: string, contentRef: string): boolean {
    const key = contextKey.trim();
    const ref = contentRef.trim();
    if (!key || !isPromptImageContentRef(ref)) return false;

    // An unsent composer draft owns every image staged for its own context key, whether
    // that is a landing surface or a thread the user has not sent the image in yet.
    const draft = this.getComposerDraft(key);
    if (draft?.attachments?.some((attachment) => attachment.contentRef?.trim() === ref) === true) {
      return true;
    }

    if (key.startsWith("landing:")) return false;

    if (!key.startsWith("thread:")) return false;
    const threadId = key.slice("thread:".length).trim();
    if (!threadId) return false;
    if (this.v2.hasPromptImageContentRef(threadId, ref)) return true;
    if (this.isV2OnlyStorage()) return false;

    for (const [table, column] of [
      ["thread_user_messages", "attachments_json"],
      ["thread_pending_followups", "attachments_json"],
    ] as const) {
      if (!this.tableExists(table)) continue;
      const rows = this.db
        .prepare(`SELECT ${column} AS value FROM ${table} WHERE thread_id = ?`)
        .all(threadId) as Array<{ value: string | null }>;
      for (const row of rows) {
        if (!row.value) continue;
        const refs = collectPromptImageContentRefs(row.value);
        if (refs.has(ref)) return true;
      }
    }
    return false;
  }

  /**
   * Read the desktop Feed's mutable V2 panel facts. The content projection is
   * folded from V2 messages/runs/tools; these extras keep request timing and
   * usage/context panels on the same durable boundary without hydrating the
   * old projection snapshot.
   */
  getConversationV2ProjectionExtras(threadId: string): ConversationV2ProjectionExtras | undefined {
    const id = threadId.trim();
    if (!id || !this.v2.hasConversation(id)) {
      if (this.isV2OnlyStorage() && id) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 projection stream is missing: ${id}`,
        );
      }
      return undefined;
    }
    const stored = this.v2.getProjectionSnapshot(id);
    const requestSpans = stored?.requestSpans;
    if (requestSpans !== undefined && !Array.isArray(requestSpans)) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Conversation V2 projection request spans are invalid: ${id}`,
      );
    }
    const readSnapshotValue = (
      key: "billing" | "context" | "subagentTimings" | "subagentMetrics",
      allowArray = false,
    ) => {
      const value = stored?.[key];
      if (value === undefined) return undefined;
      if (!value || typeof value !== "object" || (!allowArray && Array.isArray(value))) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 projection ${key} is invalid: ${id}`,
        );
      }
      return value;
    };
    const billing = readSnapshotValue("billing");
    const context = readSnapshotValue("context");
    const subagentTimings = readSnapshotValue("subagentTimings", true);
    const subagentMetrics = readSnapshotValue("subagentMetrics", true);
    const thread = this.getThread(id);
    if (!thread) return undefined;
    // Request spans are derived from the V2 provider event index at read time.
    // This keeps streaming state current without a second write for every token
    // delta, and never consults the legacy event/projection tables.
    const derivedRequestSpans = buildThreadRunProjectionRequestSpans({
      events: this.listConversationRequestSpanSources(id),
      threadStatus: thread.status,
      agents: this.listAgentInstances(id),
      historyComplete: true,
    });
    return {
      requestSpans: derivedRequestSpans,
      ledgerEvents: this.listConversationV2UsageLedgerEventViews(id, derivedRequestSpans),
      ...(billing !== undefined
        ? {
            billing: normalizeBillingSnapshotRoles(
              billing as NonNullable<ConversationV2ProjectionExtras["billing"]>,
            ),
          }
        : {}),
      ...(context !== undefined
        ? {
            context: normalizeContextSnapshotRoles(
              context as NonNullable<ConversationV2ProjectionExtras["context"]>,
            ),
          }
        : {}),
      ...(subagentTimings !== undefined
        ? {
            subagentTimings: subagentTimings as NonNullable<
              ConversationV2ProjectionExtras["subagentTimings"]
            >,
          }
        : {}),
      ...(subagentMetrics !== undefined
        ? {
            subagentMetrics: subagentMetrics as NonNullable<
              ConversationV2ProjectionExtras["subagentMetrics"]
            >,
          }
        : {}),
    };
  }

  private listConversationV2UsageLedgerEventViews(
    threadId: string,
    spans: readonly ThreadRunProjectionRequestSpan[],
  ): ThreadUsageLedgerEventView[] {
    const views = attachPeerGatewayTimingToLedgerEventViews(
      this.listUsageLedgerEvents(threadId).map(buildThreadUsageLedgerEventView),
    );
    if (views.length === 0) {
      return views;
    }
    return spans.length > 0 ? attachSpanTimingToLedgerEventViews(views, spans) : views;
  }

  /**
   * Timing needs event envelopes and ownership metadata, not every historical
   * message body. Keep the full source reader for history operations; this
   * projection reads text only where the span reducer actually consumes it.
   * All rows remain present so terminal timestamps and ordering are unchanged.
   */
  private listConversationRequestSpanSources(threadId: string): ThreadRunEvent[] {
    const rows = this.db
      .prepare(`
      SELECT p.input_id, p.conversation_id, p.version_seq, p.source_json,
        CASE WHEN json_extract(p.source_json, '$.eventType') IN
          ('thinking.delta', 'tool.writing', 'request.failed', 'api.error')
          THEN CASE WHEN p.message_id IS NULL THEN p.message ELSE COALESCE(m.body, '') END
          ELSE '' END AS message
      FROM conversation_provider_inputs_v2 p
      LEFT JOIN conversation_messages_v2 m
        ON m.message_id = p.message_id AND m.conversation_id = p.conversation_id
        AND json_extract(p.source_json, '$.eventType') IN
          ('thinking.delta', 'tool.writing', 'request.failed', 'api.error')
      WHERE p.conversation_id = ? AND p.visible = 1
      ORDER BY p.version_seq ASC, p.input_id ASC
    `)
      .all(threadId) as Array<{
      input_id: string;
      conversation_id: string;
      version_seq: number;
      source_json: string;
      message: string;
    }>;
    return rows.map((row) => {
      // Decode the source once rather than repeatedly extracting every field
      // through the full-text provider view. Preserve all ownership metadata.
      const source = JSON.parse(row.source_json) as ThreadRunEventInput;
      return withLegacyConversationV2MessageIdentity({
        ...source,
        id: row.input_id,
        threadId: row.conversation_id,
        sequence: row.version_seq,
        message: repairActivityText(row.message).text,
      });
    });
  }

  /** Persist only the mutable panel facts owned by V2. */
  updateConversationV2ProjectionExtras(
    threadId: string,
    patch: Partial<ConversationV2ProjectionExtras>,
  ): void {
    const id = threadId.trim();
    if (!id) return;
    if (!this.v2.hasConversation(id)) {
      if (this.isV2OnlyStorage()) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 projection stream is missing: ${id}`,
        );
      }
      return;
    }
    const current = this.v2.getProjectionSnapshot(id) ?? { requestSpans: [] };
    const next: Record<string, unknown> = {
      ...current,
      ...(patch.requestSpans !== undefined ? { requestSpans: patch.requestSpans } : {}),
      ...(patch.billing !== undefined ? { billing: patch.billing } : {}),
      ...(patch.context !== undefined ? { context: patch.context } : {}),
      ...(patch.subagentTimings !== undefined ? { subagentTimings: patch.subagentTimings } : {}),
      ...(patch.subagentMetrics !== undefined ? { subagentMetrics: patch.subagentMetrics } : {}),
    };
    this.v2.saveProjectionSnapshot(id, next);
  }

  /** Clear mutable panel facts when a history rewrite invalidates the tail. */
  private clearConversationV2ProjectionExtrasInCurrentTransaction(threadId: string): void {
    const id = threadId.trim();
    if (!id || !this.v2.hasConversation(id)) return;
    this.v2.saveProjectionSnapshot(id, { requestSpans: [] }, { inCurrentTransaction: true });
  }

  /**
   * Atomically install the V2-only storage boundary after an external maintenance
   * validator has completed the full reimport and backup checks.
   */
  switchToV2OnlyStorage(): void {
    if (this.isV2OnlyStorage()) return;
    this.v2.initialize();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.migrateLegacyThreadMetricsToV2InCurrentTransaction();
      this.migrateLegacyUsageLedgerToV2InCurrentTransaction();
      this.migrateLegacyFollowUpsToV2InCurrentTransaction();
      this.migrateLegacyPendingPlansToV2InCurrentTransaction();
      this.removeLegacyUsageStateFromV2InCurrentTransaction();
      this.v2.setStorageModeInCurrentTransaction("v2_only");
      this.v2.retireTransitionalFeedSkeletonsInCurrentTransaction();
      this.v2.retireLegacyStorageTablesInCurrentTransaction();
      this.db.exec("COMMIT");
      this.storageMode = "v2_only";
      this.projectionEventCache.clear();
      this.hotThreadRunEventCache.clear();
      this.nextThreadRunEventSequences.clear();
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  /** Returns the explicit dry-run/migrate boundary for legacy conversation rows. */
  conversationV2LegacyMigrator(): ConversationV2LegacyMigrator {
    this.v2.initialize();
    this.storageMode = this.v2.getStorageMode();
    return new ConversationV2LegacyMigrator(this.db, this.v2, undefined, this.promptImageFileStore);
  }

  private isV2OnlyStorage(): boolean {
    return this.storageMode === "v2_only";
  }

  /** Runtime follow-ups use the V2 table after the atomic storage cutover. */
  private pendingFollowupsTable(): "thread_pending_followups" | "conversation_followups_v2" {
    return this.isV2OnlyStorage() ? "conversation_followups_v2" : "thread_pending_followups";
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) as { present?: number } | undefined;
    return row?.present === 1;
  }

  /** Move the operational follow-up queue before the old table is retired. */
  private migrateLegacyFollowUpsToV2InCurrentTransaction(): void {
    if (!this.tableExists("thread_pending_followups")) return;
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, prompt, attachments_json, priority, status, delivery_mode,
                source_run_attempt_id, target_run_attempt_id, queued_during_phase,
                delivery_boundary, error, queue_position, created_at, updated_at,
                delivered_at, applied_at, conversation_message_id
           FROM thread_pending_followups
          ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      thread_id: string;
      prompt: string;
      attachments_json: string | null;
      priority: string;
      status: string;
      delivery_mode: string;
      source_run_attempt_id: string | null;
      target_run_attempt_id: string | null;
      queued_during_phase: string | null;
      delivery_boundary: string | null;
      error: string | null;
      queue_position: number | null;
      created_at: string;
      updated_at: string;
      delivered_at: string | null;
      applied_at: string | null;
      conversation_message_id: string | null;
    }>;
    const normalizedRows = rows.map((row) => ({
      ...row,
      attachments_json: this.normalizeLegacyFollowUpAttachmentsForV2(row.attachments_json, row.id),
    }));
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO conversation_followups_v2 (
        id, thread_id, prompt, attachments_json, priority, status, delivery_mode,
        source_run_attempt_id, target_run_attempt_id, queued_during_phase,
        delivery_boundary, error, queue_position, created_at, updated_at,
        delivered_at, applied_at, conversation_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of normalizedRows) {
      insert.run(
        row.id,
        row.thread_id,
        row.prompt,
        row.attachments_json,
        row.priority,
        row.status,
        row.delivery_mode,
        row.source_run_attempt_id,
        row.target_run_attempt_id,
        row.queued_during_phase,
        row.delivery_boundary,
        row.error,
        row.queue_position,
        row.created_at,
        row.updated_at,
        row.delivered_at,
        row.applied_at,
        row.conversation_message_id,
      );
    }
    const source = this.db.prepare(`SELECT COUNT(*) AS count FROM thread_pending_followups`).get() as {
      count: number;
    };
    const target = this.db.prepare(`SELECT COUNT(*) AS count FROM conversation_followups_v2`).get() as {
      count: number;
    };
    const mismatch = this.db
      .prepare(`
        SELECT s.id
        FROM thread_pending_followups s
        LEFT JOIN conversation_followups_v2 v ON v.id = s.id
        WHERE v.id IS NULL
           OR NOT (
             v.thread_id IS s.thread_id
             AND v.prompt IS s.prompt
             AND v.priority IS s.priority
             AND v.status IS s.status
             AND v.delivery_mode IS s.delivery_mode
             AND v.source_run_attempt_id IS s.source_run_attempt_id
             AND v.target_run_attempt_id IS s.target_run_attempt_id
             AND v.queued_during_phase IS s.queued_during_phase
             AND v.delivery_boundary IS s.delivery_boundary
             AND v.error IS s.error
             AND v.queue_position IS s.queue_position
             AND v.created_at IS s.created_at
             AND v.updated_at IS s.updated_at
             AND v.delivered_at IS s.delivered_at
             AND v.applied_at IS s.applied_at
             AND v.conversation_message_id IS s.conversation_message_id
           )
        LIMIT 1
      `)
      .get() as { id?: string } | undefined;
    const attachmentMismatch = normalizedRows.find((row) => {
      const targetRow = this.db
        .prepare(`SELECT attachments_json FROM conversation_followups_v2 WHERE id = ?`)
        .get(row.id) as { attachments_json: string | null } | undefined;
      return !targetRow || targetRow.attachments_json !== row.attachments_json;
    });
    if (Number(target.count) < Number(source.count) || mismatch || attachmentMismatch) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `V2 follow-up queue migration did not preserve canonical row${
          (mismatch?.id ?? attachmentMismatch?.id) ? `: ${mismatch?.id ?? attachmentMismatch?.id}` : "."
        }`,
      );
    }
  }

  /**
   * Legacy follow-up rows may still contain a local path or inline bytes. V2
   * must never copy either shape into its canonical queue: materialize through
   * the managed object store while the cutover transaction is open, or abort
   * the cutover before the legacy table is retired.
   */
  private normalizeLegacyFollowUpAttachmentsForV2(raw: string | null, rowId: string): string | null {
    if (!raw?.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.migrationIncomplete,
        `Legacy follow-up attachments are not valid JSON: ${rowId}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.migrationIncomplete,
        `Legacy follow-up attachments are not an array: ${rowId}`,
      );
    }
    if (parsed.length === 0) return "[]";
    const promptImageFileStore = this.promptImageFileStore;
    if (!promptImageFileStore) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.migrationIncomplete,
        `Durable prompt image store is required for legacy follow-up ${rowId}.`,
      );
    }
    const normalized = parsed.map((value, index) => {
      if (!isPromptImageAttachmentRecord(value)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.migrationIncomplete,
          `Legacy follow-up attachment ${rowId}:${index} is invalid.`,
        );
      }
      try {
        return promptImageFileStore.persistAttachmentForMigration(value);
      } catch (error) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.migrationIncomplete,
          `Legacy follow-up attachment ${rowId}:${index} could not be made durable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    return JSON.stringify(normalized);
  }

  /** Move the pending plan snapshot before the legacy table is retired. */
  private migrateLegacyPendingPlansToV2InCurrentTransaction(): void {
    if (!this.tableExists("thread_pending_plans")) return;
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(thread_pending_plans)`).all() as Array<{ name?: string }>).map(
        (column) => column.name,
      ),
    );
    const planFilePathColumn = columns.has("plan_file_path") ? "plan_file_path" : "NULL AS plan_file_path";
    const deferredExitPlanToolUseIdColumn = columns.has("deferred_exit_plan_tool_use_id")
      ? "deferred_exit_plan_tool_use_id"
      : "NULL AS deferred_exit_plan_tool_use_id";
    const rows = this.db
      .prepare(
        `SELECT thread_id, user_prompt, analysis, plan, workspace_path, worktree_path,
                routes_json, ${planFilePathColumn}, ${deferredExitPlanToolUseIdColumn}, created_at
           FROM thread_pending_plans
          ORDER BY thread_id`,
      )
      .all() as Array<{
      thread_id: string;
      user_prompt: string;
      analysis: string;
      plan: string;
      workspace_path: string;
      worktree_path: string;
      routes_json: string;
      plan_file_path: string | null;
      deferred_exit_plan_tool_use_id: string | null;
      created_at: string;
    }>;
    for (const row of rows) {
      if (!this.v2.hasConversation(row.thread_id)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Pending plan has no V2 conversation stream: ${row.thread_id}`,
        );
      }
      this.v2.savePendingPlan(
        {
          conversationId: row.thread_id,
          userPrompt: row.user_prompt,
          analysis: row.analysis,
          plan: row.plan,
          workspacePath: row.workspace_path,
          worktreePath: row.worktree_path,
          routesJson: row.routes_json,
          planFilePath: row.plan_file_path,
          deferredExitPlanToolUseId: row.deferred_exit_plan_tool_use_id,
          createdAt: row.created_at,
        },
        { inCurrentTransaction: true },
      );
      const target = this.v2.getPendingPlan(row.thread_id);
      if (
        !target ||
        target.userPrompt !== row.user_prompt ||
        target.analysis !== row.analysis ||
        target.plan !== row.plan ||
        target.workspacePath !== row.workspace_path ||
        target.worktreePath !== row.worktree_path ||
        target.routesJson !== row.routes_json ||
        (target.planFilePath ?? null) !== (row.plan_file_path ?? null) ||
        (target.deferredExitPlanToolUseId ?? null) !== (row.deferred_exit_plan_tool_use_id ?? null) ||
        target.createdAt !== row.created_at
      ) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Pending plan migration did not preserve legacy row: ${row.thread_id}`,
        );
      }
    }
  }

  /**
   * A compatibility fallback is valid only for a conversation that is actually
   * present in the legacy store. An unknown id is an unmigrated/corrupt input;
   * let the recovery gate reject it instead of treating an empty fallback as
   * a healthy conversation.
   */
  private requireKnownLegacyConversation(conversationId: string): void {
    if (this.tableExists("threads")) {
      const row = this.db.prepare(`SELECT 1 AS present FROM threads WHERE id = ?`).get(conversationId) as
        | { present?: number }
        | undefined;
      if (row?.present === 1) return;
    } else {
      const legacyRun = this.tableExists("thread_run_attempts")
        ? this.db
            .prepare(`SELECT 1 AS present FROM thread_run_attempts WHERE thread_id = ? LIMIT 1`)
            .get(conversationId)
        : undefined;
      const legacyAgent = this.tableExists("thread_agent_instances")
        ? this.db
            .prepare(`SELECT 1 AS present FROM thread_agent_instances WHERE thread_id = ? LIMIT 1`)
            .get(conversationId)
        : undefined;
      if (legacyRun || legacyAgent) return;
    }
    this.requireV2RunStream(conversationId);
  }

  /**
   * V2-only reads must never turn a missing stream into an empty conversation.
   * The stream is created together with the thread, so a missing row is a
   * storage-integrity failure rather than a valid empty result.
   */
  private assertV2OnlyReadStream(conversationId: string): void {
    const id = conversationId.trim();
    if (!id || !this.isV2OnlyStorage() || this.v2.hasConversation(id)) {
      return;
    }
    throw new ConversationV2Error(
      CONVERSATION_V2_ERROR.integrityFailure,
      `Conversation V2 stream is missing: ${id}`,
    );
  }

  initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
      PRAGMA foreign_keys = ON;
    `);
    this.storageMode = this.readStorageModeBeforeSchemaUpgrade();
    if (this.options.requiredStorageMode && this.storageMode !== this.options.requiredStorageMode) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.migrationIncomplete,
        `Conversation storage is ${this.storageMode}; ${this.options.requiredStorageMode} is required before the runtime can start.`,
        {
          actualStorageMode: this.storageMode,
          requiredStorageMode: this.options.requiredStorageMode,
        },
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sdk_session_id TEXT,
        sdk_cwd TEXT,
        routes_fingerprint TEXT,
        runtime_config_json TEXT,
        core_kind TEXT NOT NULL DEFAULT 'claude',
        core_locked_at TEXT,
        acp_agent_id TEXT,
        claude_plan_file_path TEXT,
        follow_up_queue_paused INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated
        ON threads(workspace_path, updated_at DESC);

      CREATE TABLE IF NOT EXISTS thread_delete_receipts_v2 (
        principal_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        client_command_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        expected_history_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (principal_id, thread_id, client_command_id)
      );
      CREATE INDEX IF NOT EXISTS idx_thread_delete_receipts_v2_status
        ON thread_delete_receipts_v2(status, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_delete_receipts_v2_one_accepted_per_thread
        ON thread_delete_receipts_v2(thread_id)
        WHERE status = 'accepted';

      CREATE TABLE IF NOT EXISTS composer_drafts (
        context_key TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        attachments_json TEXT,
        recovery_reason TEXT,
        revision TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_core_sessions (
        thread_id TEXT PRIMARY KEY,
        core_kind TEXT NOT NULL,
        external_session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_core_sessions_external
        ON thread_core_sessions(core_kind, external_session_id);

      CREATE TABLE IF NOT EXISTS thread_applied_diffs (
        thread_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        diff TEXT NOT NULL,
        files_json TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        rolled_back_at TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_applied_diffs_workspace_applied
        ON thread_applied_diffs(workspace_path, applied_at);

      CREATE TABLE IF NOT EXISTS thread_compaction_archives (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        session_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_compaction_archives_thread_created
        ON thread_compaction_archives(thread_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS thread_compact_handoff (
        thread_id TEXT PRIMARY KEY,
        summary_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 2,
        generation INTEGER NOT NULL DEFAULT 1,
        summary TEXT NOT NULL,
        recent_user_messages_json TEXT NOT NULL,
        pre_tokens_estimate INTEGER NOT NULL DEFAULT 0,
        pre_tokens_source TEXT NOT NULL DEFAULT 'local_heuristic',
        post_tokens_estimate INTEGER NOT NULL,
        post_tokens_source TEXT NOT NULL DEFAULT 'local_heuristic',
        compression_ratio REAL NOT NULL DEFAULT 0,
        source_session_id TEXT,
        source_start_message_id TEXT,
        source_end_message_id TEXT,
        target_session_id TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

    `);
    this.ensureCommonSchemaColumns();
    if (this.storageMode === "legacy_compat") {
      this.initializeLegacyStorageTables();
      this.migrateSchema();
    } else {
      // A V2-only database must never recreate the retired V1 tables during
      // startup. The common tables above and the V2 schema are already present
      // because the storage-mode flip is committed atomically with the cleanup.
      this.v2.initialize();
      // Older cutovers could leave a retired table behind after recording the
      // mode flip. Re-run the idempotent ledger migration and retirement on
      // every V2-only open so reopening repairs that boundary before reads.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // A fresh production database is V2-only from its first open. Persist
        // the mode before any caller can reopen it through a different store
        // instance and accidentally interpret the missing key as legacy.
        this.v2.setStorageModeInCurrentTransaction("v2_only");
        this.migrateLegacyThreadMetricsToV2InCurrentTransaction();
        this.migrateLegacyUsageLedgerToV2InCurrentTransaction();
        this.migrateLegacyFollowUpsToV2InCurrentTransaction();
        this.migrateLegacyPendingPlansToV2InCurrentTransaction();
        this.removeLegacyUsageStateFromV2InCurrentTransaction();
        this.v2.retireTransitionalFeedSkeletonsInCurrentTransaction();
        this.v2.retireLegacyStorageTablesInCurrentTransaction();
        this.db.exec("COMMIT");
      } catch (error) {
        rollbackConversationTransaction(this.db);
        throw error;
      }
    }
    migrateCodexCompactionDetails(this.db, this.v2);
  }

  /**
   * Upgrade only tables that are shared by both storage modes.
   *
   * The legacy migration routine also upgrades these columns, but it creates
   * and inspects retired V1 tables along the way. V2-only databases must be
   * able to reopen an older V2 schema without recreating that input surface.
   */
  private ensureCommonSchemaColumns(): void {
    const threadColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(threads)`).all() as Array<{ name?: string }>).map(
        (column) => column.name,
      ),
    );
    const threadMigrations = [
      ["sdk_session_id", "TEXT"],
      ["sdk_cwd", "TEXT"],
      ["routes_fingerprint", "TEXT"],
      ["runtime_config_json", "TEXT"],
      ["core_kind", "TEXT"],
      ["core_locked_at", "TEXT"],
      ["acp_agent_id", "TEXT"],
      ["claude_plan_file_path", "TEXT"],
      ["follow_up_queue_paused", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, definition] of threadMigrations) {
      if (!threadColumns.has(name)) {
        this.db.exec(`ALTER TABLE threads ADD COLUMN ${name} ${definition}`);
      }
    }

    const composerDraftColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(composer_drafts)`).all() as Array<{ name?: string }>).map(
        (column) => column.name,
      ),
    );
    const composerDraftMigrations = [
      ["attachments_json", "TEXT"],
      ["recovery_reason", "TEXT"],
      ["revision", "TEXT"],
    ] as const;
    for (const [name, definition] of composerDraftMigrations) {
      if (!composerDraftColumns.has(name)) {
        this.db.exec(`ALTER TABLE composer_drafts ADD COLUMN ${name} ${definition}`);
      }
    }
    this.db.exec(`
      UPDATE composer_drafts
         SET revision = lower(hex(randomblob(16)))
       WHERE revision IS NULL OR TRIM(revision) = ''
    `);

    const compactHandoffColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(thread_compact_handoff)`).all() as Array<{ name?: string }>).map(
        (column) => column.name,
      ),
    );
    const compactHandoffMigrations = [
      ["summary_id", "TEXT"],
      ["schema_version", "INTEGER NOT NULL DEFAULT 1"],
      ["generation", "INTEGER NOT NULL DEFAULT 1"],
      ["pre_tokens_estimate", "INTEGER NOT NULL DEFAULT 0"],
      ["pre_tokens_source", "TEXT NOT NULL DEFAULT 'local_heuristic'"],
      ["post_tokens_source", "TEXT NOT NULL DEFAULT 'local_heuristic'"],
      ["compression_ratio", "REAL NOT NULL DEFAULT 0"],
      ["source_session_id", "TEXT"],
      ["source_start_message_id", "TEXT"],
      ["source_end_message_id", "TEXT"],
      ["target_session_id", "TEXT"],
      ["consumed_at", "TEXT"],
    ] as const;
    for (const [name, definition] of compactHandoffMigrations) {
      if (!compactHandoffColumns.has(name)) {
        this.db.exec(`ALTER TABLE thread_compact_handoff ADD COLUMN ${name} ${definition}`);
      }
    }
    this.db.exec(`
      UPDATE thread_compact_handoff
         SET summary_id = COALESCE(NULLIF(summary_id, ''), 'legacy-' || thread_id),
             schema_version = COALESCE(schema_version, 1),
             generation = COALESCE(generation, 1),
             pre_tokens_estimate = CASE
               WHEN pre_tokens_estimate IS NULL OR pre_tokens_estimate <= 0
               THEN post_tokens_estimate
               ELSE pre_tokens_estimate
             END,
             pre_tokens_source = COALESCE(NULLIF(pre_tokens_source, ''), 'local_heuristic'),
             post_tokens_source = COALESCE(NULLIF(post_tokens_source, ''), 'local_heuristic')
    `);
    this.db.exec(`
      UPDATE thread_compact_handoff
         SET compression_ratio = CASE
               WHEN compression_ratio IS NULL OR compression_ratio < 0
                 OR (compression_ratio = 0 AND post_tokens_estimate > 0)
               THEN CAST(post_tokens_estimate AS REAL) / pre_tokens_estimate
               ELSE compression_ratio
             END
    `);
  }

  private initializeLegacyStorageTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_metrics_snapshots (
        thread_id TEXT PRIMARY KEY,
        accumulator_json TEXT,
        context_json TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS thread_activity (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        message TEXT NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0,
        sdk_user_message_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_activity_thread_created
        ON thread_activity(thread_id, created_at);

      CREATE TABLE IF NOT EXISTS thread_coder_todos (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        status TEXT NOT NULL,
        position INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_coder_todos_thread_position
        ON thread_coder_todos(thread_id, position);

      CREATE TABLE IF NOT EXISTS thread_pending_plans (
        thread_id TEXT PRIMARY KEY,
        user_prompt TEXT NOT NULL,
        analysis TEXT NOT NULL,
        plan TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        routes_json TEXT NOT NULL,
        deferred_exit_plan_tool_use_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS thread_agent_instances (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        run_attempt_id TEXT,
        parent_agent_id TEXT,
        parent_tool_use_id TEXT,
        mission_key TEXT,
        todo_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL,
        metadata_json TEXT,
        PRIMARY KEY (thread_id, agent_id),
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_agent_instances_thread_parent
        ON thread_agent_instances(thread_id, parent_agent_id, parent_tool_use_id);

      CREATE TABLE IF NOT EXISTS thread_subagent_sessions (
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        todo_id TEXT,
        mission_key TEXT,
        started_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        ended_at TEXT,
        accumulated_ms INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, agent_id),
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_subagent_sessions_thread_role_phase
        ON thread_subagent_sessions(thread_id, role, phase, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS thread_subagent_metrics (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        context_occupied INTEGER NOT NULL DEFAULT 0,
        context_limit INTEGER,
        eco_cost_usd REAL NOT NULL DEFAULT 0,
        eco_cost_breakdown_json TEXT,
        model_id TEXT,
        last_request_key TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, agent_id),
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS thread_run_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        role TEXT,
        agent_id TEXT,
        parent_agent_id TEXT,
        parent_tool_use_id TEXT,
        run_attempt_id TEXT,
        request_id TEXT,
        stream_key TEXT,
        stream_state TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        observed_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_run_events_thread_sequence
        ON thread_run_events(thread_id, sequence, id);

      CREATE INDEX IF NOT EXISTS idx_thread_run_events_thread_agent
        ON thread_run_events(thread_id, agent_id, sequence);

      CREATE INDEX IF NOT EXISTS idx_thread_run_events_thread_stream_latest_v2
        ON thread_run_events(
          thread_id, event_type, stream_key, request_id, run_attempt_id, sequence DESC
        );
    `);
  }

  private migrateSchema(): void {
    const columns = this.db.prepare(`PRAGMA table_info(threads)`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const composerDraftColumns = this.db.prepare(`PRAGMA table_info(composer_drafts)`).all() as Array<{
      name: string;
    }>;
    const composerDraftNames = new Set(composerDraftColumns.map((column) => column.name));
    if (!composerDraftNames.has("attachments_json")) {
      this.db.exec(`ALTER TABLE composer_drafts ADD COLUMN attachments_json TEXT`);
    }
    if (!composerDraftNames.has("recovery_reason")) {
      this.db.exec(`ALTER TABLE composer_drafts ADD COLUMN recovery_reason TEXT`);
    }
    if (!composerDraftNames.has("revision")) {
      this.db.exec(`ALTER TABLE composer_drafts ADD COLUMN revision TEXT`);
    }
    this.db.exec(`
      UPDATE composer_drafts
      SET revision = lower(hex(randomblob(16)))
      WHERE revision IS NULL OR TRIM(revision) = ''
    `);
    if (!names.has("sdk_session_id")) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN sdk_session_id TEXT`);
    }
    if (!names.has("sdk_cwd")) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN sdk_cwd TEXT`);
    }
    if (!names.has("routes_fingerprint")) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN routes_fingerprint TEXT`);
    }
    if (!names.has("runtime_config_json")) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN runtime_config_json TEXT`);
    }
    if (!names.has("core_kind")) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN core_kind TEXT`);
    }
    if (!names.has("core_locked_at")) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN core_locked_at TEXT`);
    }
    if (!names.has("acp_agent_id")) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN acp_agent_id TEXT`);
    }
    const hasCodexThreadMap = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM sqlite_master
           WHERE type = 'table' AND name = 'eco_thread_codex_map'`,
        )
        .get(),
    );
    if (hasCodexThreadMap) {
      this.db.exec(`
        UPDATE threads
        SET core_kind = 'codex'
        WHERE (core_kind IS NULL OR TRIM(core_kind) = '')
          AND (sdk_session_id IS NULL OR sdk_cwd IS NULL)
          AND EXISTS (
            SELECT 1
            FROM eco_thread_codex_map
            WHERE eco_thread_id = threads.id
          )
      `);
      this.db.exec(`
        UPDATE threads
        SET core_kind = 'claude'
        WHERE (core_kind IS NULL OR TRIM(core_kind) = '')
          AND sdk_session_id IS NOT NULL
          AND sdk_cwd IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM eco_thread_codex_map
            WHERE eco_thread_id = threads.id
          )
      `);
    } else {
      this.db.exec(`
        UPDATE threads
        SET core_kind = 'claude'
        WHERE core_kind IS NULL OR TRIM(core_kind) = ''
      `);
    }
    this.db.exec(`
      UPDATE threads
      SET core_locked_at = created_at
      WHERE core_kind IN ('claude', 'codex') AND core_locked_at IS NULL
    `);
    this.db.exec(`
      INSERT INTO thread_core_sessions (
        thread_id,
        core_kind,
        external_session_id,
        cwd,
        metadata_json,
        created_at,
        updated_at
      )
      SELECT id, 'claude', sdk_session_id, sdk_cwd, NULL, created_at, updated_at
      FROM threads
      WHERE core_kind = 'claude'
        AND sdk_session_id IS NOT NULL
        AND sdk_cwd IS NOT NULL
      ON CONFLICT(thread_id) DO UPDATE SET
        core_kind = excluded.core_kind,
        external_session_id = excluded.external_session_id,
        cwd = excluded.cwd,
        updated_at = excluded.updated_at
      WHERE thread_core_sessions.core_kind = excluded.core_kind
    `);

    const compactHandoffColumns = this.db
      .prepare(`PRAGMA table_info(thread_compact_handoff)`)
      .all() as Array<{ name: string }>;
    const compactHandoffNames = new Set(compactHandoffColumns.map((column) => column.name));
    const compactHandoffMigrations = [
      ["summary_id", "TEXT"],
      ["schema_version", "INTEGER NOT NULL DEFAULT 1"],
      ["generation", "INTEGER NOT NULL DEFAULT 1"],
      ["pre_tokens_estimate", "INTEGER NOT NULL DEFAULT 0"],
      ["pre_tokens_source", "TEXT NOT NULL DEFAULT 'local_heuristic'"],
      ["post_tokens_source", "TEXT NOT NULL DEFAULT 'local_heuristic'"],
      ["compression_ratio", "REAL NOT NULL DEFAULT 0"],
      ["source_session_id", "TEXT"],
      ["source_start_message_id", "TEXT"],
      ["source_end_message_id", "TEXT"],
      ["target_session_id", "TEXT"],
      ["consumed_at", "TEXT"],
    ] as const;
    for (const [name, definition] of compactHandoffMigrations) {
      if (!compactHandoffNames.has(name)) {
        this.db.exec(`ALTER TABLE thread_compact_handoff ADD COLUMN ${name} ${definition}`);
      }
    }
    this.db.exec(`
      UPDATE thread_compact_handoff
      SET summary_id = COALESCE(NULLIF(summary_id, ''), 'legacy-' || thread_id),
          schema_version = COALESCE(schema_version, 1),
          generation = COALESCE(generation, 1),
          pre_tokens_estimate = CASE
            WHEN pre_tokens_estimate IS NULL OR pre_tokens_estimate <= 0
            THEN post_tokens_estimate
            ELSE pre_tokens_estimate
          END,
          pre_tokens_source = COALESCE(NULLIF(pre_tokens_source, ''), 'local_heuristic'),
          post_tokens_source = COALESCE(NULLIF(post_tokens_source, ''), 'local_heuristic')
    `);
    this.db.exec(`
      UPDATE thread_compact_handoff
      SET compression_ratio = CASE
        WHEN compression_ratio IS NULL OR compression_ratio < 0
          OR (compression_ratio = 0 AND post_tokens_estimate > 0)
        THEN CAST(post_tokens_estimate AS REAL) / pre_tokens_estimate
        ELSE compression_ratio
      END
    `);

    const activityColumns = this.db.prepare(`PRAGMA table_info(thread_activity)`).all() as Array<{
      name: string;
    }>;
    const activityNames = new Set(activityColumns.map((column) => column.name));
    if (!activityNames.has("agent_id")) {
      this.db.exec(`ALTER TABLE thread_activity ADD COLUMN agent_id TEXT`);
    }
    if (!activityNames.has("api_error_json")) {
      this.db.exec(`ALTER TABLE thread_activity ADD COLUMN api_error_json TEXT`);
    }
    if (!activityNames.has("sdk_user_message_id")) {
      this.db.exec(`ALTER TABLE thread_activity ADD COLUMN sdk_user_message_id TEXT`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_thread_activity_thread_sdk_user_message
        ON thread_activity(thread_id, sdk_user_message_id);
    `);

    const sessionColumns = this.db.prepare(`PRAGMA table_info(thread_subagent_sessions)`).all() as Array<{
      name: string;
    }>;
    const sessionNames = new Set(sessionColumns.map((column) => column.name));
    if (!sessionNames.has("started_at")) {
      this.db.exec(`ALTER TABLE thread_subagent_sessions ADD COLUMN started_at TEXT`);
    }
    if (!sessionNames.has("last_active_at")) {
      this.db.exec(`ALTER TABLE thread_subagent_sessions ADD COLUMN last_active_at TEXT`);
    }
    if (!sessionNames.has("ended_at")) {
      this.db.exec(`ALTER TABLE thread_subagent_sessions ADD COLUMN ended_at TEXT`);
    }
    if (!sessionNames.has("accumulated_ms")) {
      this.db.exec(
        `ALTER TABLE thread_subagent_sessions ADD COLUMN accumulated_ms INTEGER NOT NULL DEFAULT 0`,
      );
    }
    this.db.exec(`
      UPDATE thread_subagent_sessions
      SET started_at = COALESCE(started_at, updated_at),
          last_active_at = COALESCE(last_active_at, updated_at),
          accumulated_ms = COALESCE(accumulated_ms, 0)
      WHERE started_at IS NULL OR last_active_at IS NULL
    `);
    this.db.exec(`
      UPDATE thread_subagent_sessions
      SET ended_at = updated_at
      WHERE status = 'stopped' AND ended_at IS NULL
    `);

    this.db.exec(`DROP TABLE IF EXISTS thread_file_checkpoints`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_user_messages (
        thread_id TEXT NOT NULL,
        activity_line_id TEXT NOT NULL,
        upstream_message_id TEXT,
        provider TEXT,
        text TEXT NOT NULL,
        attachments_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, activity_line_id),
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_thread_user_messages_thread_created
        ON thread_user_messages(thread_id, created_at, activity_line_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_run_attempts (
        thread_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        retry_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        metadata_json TEXT,
        PRIMARY KEY (thread_id, attempt_id),
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS thread_agent_instances (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        run_attempt_id TEXT,
        parent_agent_id TEXT,
        parent_tool_use_id TEXT,
        mission_key TEXT,
        todo_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL,
        metadata_json TEXT,
        PRIMARY KEY (thread_id, agent_id),
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_agent_instances_thread_parent
        ON thread_agent_instances(thread_id, parent_agent_id, parent_tool_use_id);

      CREATE TABLE IF NOT EXISTS thread_usage_ledger_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
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
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_usage_ledger_thread_observed
        ON thread_usage_ledger_events(thread_id, observed_at, id);

      CREATE TABLE IF NOT EXISTS thread_run_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        role TEXT,
        agent_id TEXT,
        parent_agent_id TEXT,
        parent_tool_use_id TEXT,
        run_attempt_id TEXT,
        request_id TEXT,
        stream_key TEXT,
        stream_state TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        observed_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_run_events_thread_sequence
        ON thread_run_events(thread_id, sequence, id);

      CREATE INDEX IF NOT EXISTS idx_thread_run_events_thread_agent
        ON thread_run_events(thread_id, agent_id, sequence);

      CREATE INDEX IF NOT EXISTS idx_thread_run_events_thread_stream_latest_v2
        ON thread_run_events(
          thread_id, event_type, stream_key, request_id, run_attempt_id, sequence DESC
        );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_pending_followups (
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
        conversation_message_id TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_pending_followups_thread_status
        ON thread_pending_followups(thread_id, status, priority, created_at);
    `);
    const followUpColumns = this.db.prepare(`PRAGMA table_info(thread_pending_followups)`).all() as Array<{
      name: string;
    }>;
    const followUpNames = new Set(followUpColumns.map((column) => column.name));
    if (!followUpNames.has("queued_during_phase")) {
      this.db.exec(`ALTER TABLE thread_pending_followups ADD COLUMN queued_during_phase TEXT`);
    }
    if (!followUpNames.has("delivery_boundary")) {
      this.db.exec(`ALTER TABLE thread_pending_followups ADD COLUMN delivery_boundary TEXT`);
    }
    if (!followUpNames.has("queue_position")) {
      this.db.exec(`ALTER TABLE thread_pending_followups ADD COLUMN queue_position INTEGER`);
    }
    if (!followUpNames.has("conversation_message_id")) {
      this.db.exec(`ALTER TABLE thread_pending_followups ADD COLUMN conversation_message_id TEXT`);
    }

    if (!names.has("claude_plan_file_path")) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN claude_plan_file_path TEXT`);
    }
    if (!names.has("follow_up_queue_paused")) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN follow_up_queue_paused INTEGER NOT NULL DEFAULT 0`);
    }

    const pendingPlanColumns = this.db.prepare(`PRAGMA table_info(thread_pending_plans)`).all() as Array<{
      name: string;
    }>;
    const pendingPlanNames = new Set(pendingPlanColumns.map((column) => column.name));
    if (!pendingPlanNames.has("plan_file_path")) {
      this.db.exec(`ALTER TABLE thread_pending_plans ADD COLUMN plan_file_path TEXT`);
    }
    if (!pendingPlanNames.has("deferred_exit_plan_tool_use_id")) {
      this.db.exec(`ALTER TABLE thread_pending_plans ADD COLUMN deferred_exit_plan_tool_use_id TEXT`);
    }

    if (this.tableExists("thread_usage_ledger_events")) {
      const usageLedgerColumns = this.db
        .prepare(`PRAGMA table_info(thread_usage_ledger_events)`)
        .all() as Array<{ name: string }>;
      const usageLedgerNames = new Set(usageLedgerColumns.map((column) => column.name));
      if (!usageLedgerNames.has("reasoning_tokens")) {
        this.db.exec(
          `ALTER TABLE thread_usage_ledger_events ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0`,
        );
      }
    }

    this.migrateFeedSkeletonTable();
    this.v2.initialize();
    if (this.storageMode === "v2_only") {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.migrateLegacyThreadMetricsToV2InCurrentTransaction();
        this.migrateLegacyUsageLedgerToV2InCurrentTransaction();
        this.migrateLegacyFollowUpsToV2InCurrentTransaction();
        this.migrateLegacyPendingPlansToV2InCurrentTransaction();
        this.removeLegacyUsageStateFromV2InCurrentTransaction();
        this.v2.retireTransitionalFeedSkeletonsInCurrentTransaction();
        this.v2.retireLegacyStorageTablesInCurrentTransaction();
        this.db.exec("COMMIT");
      } catch (error) {
        rollbackConversationTransaction(this.db);
        throw error;
      }
    } else {
      this.migrateLegacyFeedSkeletonRowsToV2();
      this.migrateToolOutputProjection();
    }
  }

  /** Move any pre-cutover usage rows before the V1 table is physically retired. */
  private migrateLegacyThreadMetricsToV2InCurrentTransaction(): void {
    if (!this.tableExists("thread_metrics_snapshots")) {
      return;
    }
    const rows = this.db
      .prepare(
        `SELECT thread_id, accumulator_json, context_json, updated_at
           FROM thread_metrics_snapshots
          ORDER BY thread_id ASC`,
      )
      .all() as Array<{
      thread_id: string;
      accumulator_json: string | null;
      context_json: string | null;
      updated_at: string;
    }>;
    const parseLegacyObject = (value: string | null, field: string, threadId: string) => {
      if (value === null) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch (error) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Legacy thread metrics ${field} JSON is invalid: ${threadId}`,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Legacy thread metrics ${field} must be an object: ${threadId}`,
        );
      }
      return parsed as Record<string, unknown>;
    };

    for (const row of rows) {
      if (!this.v2.hasConversation(row.thread_id)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Legacy thread metrics row has no V2 conversation stream: ${row.thread_id}`,
        );
      }
      const accumulator = parseLegacyObject(row.accumulator_json, "accumulator", row.thread_id);
      const context = parseLegacyObject(row.context_json, "context", row.thread_id);
      if (accumulator === undefined && context === undefined) {
        continue;
      }
      const existing = this.v2.getProjectionSnapshot(row.thread_id) ?? { requestSpans: [] };
      for (const [field, value] of [
        ["usageState", existing.usageState],
        ["context", existing.context],
      ] as const) {
        if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
          throw new ConversationV2Error(
            CONVERSATION_V2_ERROR.integrityFailure,
            `Conversation V2 projection ${field} is invalid: ${row.thread_id}`,
          );
        }
      }
      const next = { ...existing };
      let changed = false;
      if (accumulator !== undefined && existing.usageState === undefined) {
        next.usageState = accumulator;
        changed = true;
      }
      if (context !== undefined && existing.context === undefined) {
        next.context = context;
        changed = true;
      }
      if (changed) {
        this.v2.saveProjectionSnapshot(row.thread_id, next, { inCurrentTransaction: true });
      }
    }
  }

  /** Move any pre-cutover usage rows before the V1 table is physically retired. */
  private migrateLegacyUsageLedgerToV2InCurrentTransaction(): void {
    if (!this.tableExists("thread_usage_ledger_events")) {
      return;
    }
    const rows = this.db
      .prepare(
        `SELECT id, idempotency_key, thread_id, run_attempt_id, agent_id, parent_tool_use_id,
                source, source_event_id, request_key, provider_request_id, sdk_message_id,
                usage_kind, role, model_id,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                reported_cost_usd, attribution_json, metadata_json, observed_at
           FROM thread_usage_ledger_events
          ORDER BY thread_id ASC, observed_at ASC, id ASC`,
      )
      .all() as unknown as UsageLedgerEventRow[];
    for (const row of rows) {
      if (!this.v2.hasConversation(row.thread_id)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Usage ledger row ${row.id} has no V2 conversation stream: ${row.thread_id}`,
        );
      }
      this.v2.appendUsageLedgerEventInCurrentTransaction(usageLedgerRowToV2(row));
    }
  }

  /**
   * Remove the migrated V1 aggregate after its one-time validation. V2 billing
   * is reconstructed from the usage ledger; retaining this field in the V2
   * snapshot would leave a second, stale source of truth on disk.
   */
  private removeLegacyUsageStateFromV2InCurrentTransaction(): void {
    const rows = this.db
      .prepare(
        `SELECT conversation_id
           FROM conversation_projection_snapshots_v2
          WHERE snapshot_json LIKE '%"usageState"%'`,
      )
      .all() as Array<{ conversation_id: string }>;
    for (const row of rows) {
      const snapshot = this.v2.getProjectionSnapshot(row.conversation_id);
      if (!snapshot || !Object.hasOwn(snapshot, "usageState")) {
        continue;
      }
      const usageState = snapshot.usageState;
      if (!usageState || typeof usageState !== "object" || Array.isArray(usageState)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 usage state is invalid: ${row.conversation_id}`,
        );
      }
      const next = { ...snapshot };
      delete next.usageState;
      this.v2.saveProjectionSnapshot(row.conversation_id, next, { inCurrentTransaction: true });
    }
  }

  private readStorageModeBeforeSchemaUpgrade(): ConversationV2StorageMode {
    const metaTable = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_store_meta_v2'`)
      .get() as { name?: string } | undefined;
    if (!metaTable?.name) {
      return this.hasLegacyConversationSourceTables()
        ? "legacy_compat"
        : (this.options.freshStorageMode ?? "legacy_compat");
    }
    const row = this.db
      .prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = ?`)
      .get("conversation_v2_storage_mode") as { value?: unknown } | undefined;
    return row?.value === "v2_only" ? "v2_only" : "legacy_compat";
  }

  private hasLegacyConversationSourceTables(): boolean {
    const names = legacyConversationSourceTables.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT 1 AS present
           FROM sqlite_master
          WHERE type = 'table'
            AND name IN (${names})
          LIMIT 1`,
      )
      .get(...legacyConversationSourceTables) as { present?: number } | undefined;
    return row?.present === 1;
  }

  private migrateFeedSkeletonTable(): void {
    // A V2-only reopen must not recreate a retired V1 table even briefly. The
    // legacy schema is created only while the store is explicitly in
    // legacy_compat; V2-only startup can still drop a leftover table through
    // ConversationV2Store.retireLegacyStorageTablesInCurrentTransaction().
    if (this.storageMode !== "legacy_compat") return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_feed_skeleton (
        thread_id TEXT PRIMARY KEY,
        history_revision INTEGER NOT NULL DEFAULT 0,
        max_event_sequence INTEGER NOT NULL DEFAULT 0,
        snapshot_json TEXT NOT NULL,
        auxiliary_json TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
    `);
    const columns = this.db.prepare(`PRAGMA table_info(thread_feed_skeleton)`).all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("auxiliary_json")) {
      this.db.exec(`ALTER TABLE thread_feed_skeleton ADD COLUMN auxiliary_json TEXT`);
    }
  }

  /**
   * Copy the old projection cache once. After this initialization pass, all production
   * skeleton reads and writes use the V2 cache table; the V1 table remains only as a
   * migration/compatibility input until the maintenance cleanup removes it.
   */
  private migrateLegacyFeedSkeletonRowsToV2(): void {
    const rows = this.db
      .prepare(
        `SELECT thread_id, history_revision, max_event_sequence,
                snapshot_json, auxiliary_json, updated_at
         FROM thread_feed_skeleton`,
      )
      .all() as Array<{
      thread_id: string;
      history_revision: number;
      max_event_sequence: number;
      snapshot_json: string;
      auxiliary_json: string | null;
      updated_at: string;
    }>;
    for (const row of rows) {
      if (this.v2.getFeedSkeletonRow(row.thread_id)) {
        continue;
      }
      this.v2.saveFeedSkeletonRow({
        conversationId: row.thread_id,
        historyRevision: row.history_revision,
        maxEventSequence: row.max_event_sequence,
        snapshotJson: row.snapshot_json,
        auxiliaryJson: row.auxiliary_json,
        updatedAt: row.updated_at,
      });
    }
  }

  /** One-time V1 metadata cleanup retained as an explicit compatibility migration. */
  private migrateToolOutputProjection(): void {
    const migrationId = "thread-run-tool-output-projection-v1";
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_store_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    if (this.db.prepare(`SELECT 1 FROM conversation_store_migrations WHERE id = ?`).get(migrationId)) {
      return;
    }

    const update = this.db.prepare(`UPDATE thread_run_events SET metadata_json = ? WHERE id = ?`);
    const invalidEventIds: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(`SELECT id, metadata_json FROM thread_run_events WHERE metadata_json IS NOT NULL`)
        .all() as Array<{ id: string; metadata_json: string }>;
      this.db
        .prepare(`DELETE FROM thread_run_events WHERE event_type = 'context.tool_output_truncated'`)
        .run();
      for (const row of rows) {
        let metadata: Record<string, unknown>;
        try {
          const parsed = JSON.parse(row.metadata_json) as unknown;
          if (!isJsonRecord(parsed)) {
            invalidEventIds.push(row.id);
            continue;
          }
          metadata = parsed;
        } catch {
          invalidEventIds.push(row.id);
          continue;
        }
        const migrated = migratePersistedToolMetadata(metadata);
        if (migrated !== metadata) {
          update.run(Object.keys(migrated).length > 0 ? JSON.stringify(migrated) : null, row.id);
        }
      }
      this.db
        .prepare(`INSERT INTO conversation_store_migrations (id, applied_at) VALUES (?, ?)`)
        .run(migrationId, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    if (invalidEventIds.length > 0) {
      process.stderr.write(
        `[eco] tool output projection migration skipped invalid metadata count=${invalidEventIds.length} eventIds=${invalidEventIds.join(",")}\n`,
      );
    }
  }

  saveThreadRuntimeConfig(threadId: string, config: ThreadRuntimeConfig): void {
    this.db
      .prepare(
        `UPDATE threads
         SET runtime_config_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(serializeThreadRuntimeConfig(config), new Date().toISOString(), threadId);
  }

  saveThreadRuntimeConfigForPlanCommand(
    threadId: string,
    config: ThreadRuntimeConfig,
    command: { principalId: string; clientCommandId: string },
    payload: Record<string, unknown>,
  ): void {
    this.v2.initialize();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE threads
           SET runtime_config_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(serializeThreadRuntimeConfig(config), new Date().toISOString(), threadId);
      this.v2.recordCommandCheckpointInCurrentTransaction({
        principalId: command.principalId,
        conversationId: threadId,
        clientCommandId: command.clientCommandId,
        name: "plan.session_mode_committed",
        payload,
      });
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

  getThreadRuntimeConfig(threadId: string): ThreadRuntimeConfig | undefined {
    const row = this.db.prepare(`SELECT runtime_config_json FROM threads WHERE id = ?`).get(threadId) as
      | { runtime_config_json: string | null }
      | undefined;
    return parseThreadRuntimeConfigJson(row?.runtime_config_json);
  }

  saveThreadMetrics(
    threadId: string,
    input: {
      accumulator?: SerializedThreadUsageState;
      context?: ThreadContextSnapshot;
    },
  ): void {
    const hasAccumulator = input.accumulator !== undefined;
    const hasContext = input.context !== undefined;
    if (!hasAccumulator && !hasContext) {
      return;
    }

    // A migrated conversation has a single V2-owned metrics snapshot. Keep
    // the legacy table available only as a one-time migration input; writing
    // it here would recreate a second source of truth after cutover.
    this.v2.initialize();
    const v2HasConversation = this.v2.hasConversation(threadId);
    if (v2HasConversation || this.isV2OnlyStorage()) {
      if (!v2HasConversation) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 metrics stream is missing: ${threadId}`,
        );
      }
      // The accumulator is a V1 migration input. Once a V2 stream exists,
      // billing is rebuilt from conversation_usage_ledger_events_v2 and this
      // method must never recreate a second aggregate source of truth.
      if (input.context === undefined) {
        return;
      }
      this.updateConversationV2ProjectionExtras(threadId, {
        context: input.context,
      });
      return;
    }

    const existing = this.getThreadMetrics(threadId);
    const accumulatorJson = hasAccumulator
      ? JSON.stringify(input.accumulator)
      : existing?.accumulator
        ? JSON.stringify(existing.accumulator)
        : null;
    const contextJson = hasContext
      ? JSON.stringify(input.context)
      : existing?.context
        ? JSON.stringify(existing.context)
        : null;

    if (!accumulatorJson && !contextJson) {
      return;
    }

    this.db
      .prepare(
        `INSERT INTO thread_metrics_snapshots (thread_id, accumulator_json, context_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           accumulator_json = COALESCE(excluded.accumulator_json, thread_metrics_snapshots.accumulator_json),
           context_json = COALESCE(excluded.context_json, thread_metrics_snapshots.context_json),
           updated_at = excluded.updated_at`,
      )
      .run(threadId, accumulatorJson, contextJson, new Date().toISOString());
  }

  getThreadMetrics(threadId: string): ThreadMetricsRecord | undefined {
    this.v2.initialize();
    this.storageMode = this.v2.getStorageMode();
    if (this.v2.hasConversation(threadId)) {
      const snapshot = this.v2.getProjectionSnapshot(threadId);
      const usageState = snapshot?.usageState;
      const context = snapshot?.context;
      if (usageState === undefined && context === undefined) return undefined;
      if (
        (usageState !== undefined &&
          (!usageState || typeof usageState !== "object" || Array.isArray(usageState))) ||
        (context !== undefined && (!context || typeof context !== "object" || Array.isArray(context)))
      ) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 metrics snapshot is invalid: ${threadId}`,
        );
      }
      return {
        threadId,
        ...(usageState !== undefined ? { accumulator: usageState as SerializedThreadUsageState } : {}),
        ...(context !== undefined
          ? { context: normalizeContextSnapshotRoles(context as ThreadContextSnapshot) }
          : {}),
        updatedAt: new Date().toISOString(),
      };
    }
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Conversation V2 metrics stream is missing: ${threadId}`,
      );
    }
    const row = this.db
      .prepare(
        `SELECT thread_id, accumulator_json, context_json, updated_at
         FROM thread_metrics_snapshots
         WHERE thread_id = ?`,
      )
      .get(threadId) as
      | {
          thread_id: string;
          accumulator_json: string | null;
          context_json: string | null;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return rowToThreadMetrics(row);
  }

  saveCompactionArchive(
    threadId: string,
    input: {
      trigger: "auto" | "manual";
      sessionId?: string;
      payload: Record<string, unknown>;
    },
  ): ThreadCompactionArchiveRecord {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO thread_compaction_archives (id, thread_id, trigger, session_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, threadId, input.trigger, input.sessionId ?? null, JSON.stringify(input.payload), createdAt);
    return {
      id,
      threadId,
      trigger: input.trigger,
      ...(input.sessionId && { sessionId: input.sessionId }),
      payload: input.payload,
      createdAt,
    };
  }

  listCompactionArchives(threadId: string, limit = 20): ThreadCompactionArchiveRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, trigger, session_id, payload_json, created_at
         FROM thread_compaction_archives
         WHERE thread_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(threadId, limit) as Array<{
      id: string;
      thread_id: string;
      trigger: string;
      session_id: string | null;
      payload_json: string;
      created_at: string;
    }>;

    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.payload_json) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        payload = { raw: row.payload_json };
      }
      return {
        id: row.id,
        threadId: row.thread_id,
        trigger: row.trigger === "manual" ? "manual" : "auto",
        ...(row.session_id && { sessionId: row.session_id }),
        payload,
        createdAt: row.created_at,
      };
    });
  }

  getCompactHandoff(threadId: string): ThreadCompactHandoffRecord | undefined {
    const row = this.selectCompactHandoffRow(threadId, true);
    return row ? compactHandoffRowToRecord(row, threadId) : undefined;
  }

  /** Latest committed summary, including a handoff already consumed by a replacement SDK session. */
  getLatestCompactSummary(threadId: string): ThreadCompactHandoffRecord | undefined {
    const row = this.selectCompactHandoffRow(threadId, false);
    return row ? compactHandoffRowToRecord(row, threadId) : undefined;
  }

  /**
   * Atomic compaction commit: install the handoff only if the source SDK session is still current,
   * then clear main/subagent resume state in the same SQLite transaction.
   */
  commitCompactHandoffAndClearSession(
    threadId: string,
    input: CommitCompactHandoffInput,
  ): ThreadCompactHandoffRecord {
    const sourceSessionId = input.sourceSessionId.trim();
    if (!sourceSessionId) {
      throw new Error(`压缩提交缺少源 SDK session（${threadId}）。`);
    }
    const sourceStartMessageId = input.sourceStartMessageId.trim();
    const sourceEndMessageId = input.sourceEndMessageId.trim();
    if (!sourceStartMessageId || !sourceEndMessageId) {
      throw new Error(`压缩提交缺少源消息范围（${threadId}）。`);
    }
    const summary = input.summary.trim();
    if (!summary) {
      throw new Error(`压缩提交摘要为空（${threadId}）。`);
    }
    validateCompactMetrics(threadId, input);

    const createdAt = new Date().toISOString();
    const summaryId = `csm_${crypto.randomUUID()}`;
    const schemaVersion = Math.max(1, Math.trunc(input.schemaVersion ?? 2));
    let generation = 1;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare(`SELECT generation FROM thread_compact_handoff WHERE thread_id = ?`)
        .get(threadId) as { generation: number } | undefined;
      generation = Math.max(1, Math.trunc(previous?.generation ?? 0) + 1);

      const sessionUpdate = this.db
        .prepare(
          `UPDATE threads
           SET sdk_session_id = NULL, sdk_cwd = NULL, updated_at = ?
           WHERE id = ? AND sdk_session_id = ?`,
        )
        .run(createdAt, threadId, sourceSessionId);
      if (Number(sessionUpdate.changes ?? 0) !== 1) {
        throw new Error(`源 SDK session 已变化，拒绝提交旧压缩摘要（${threadId}）。`);
      }
      this.db
        .prepare(
          `DELETE FROM thread_core_sessions
           WHERE thread_id = ? AND core_kind = 'claude' AND external_session_id = ?`,
        )
        .run(threadId, sourceSessionId);

      this.writeCompactHandoffRow(threadId, {
        summaryId,
        schemaVersion,
        generation,
        summary,
        recentMessages: input.recentMessages,
        preTokensEstimate: input.preTokensEstimate,
        preTokensSource: input.preTokensSource,
        postTokensEstimate: input.postTokensEstimate,
        postTokensSource: input.postTokensSource,
        compressionRatio: input.compressionRatio,
        sourceSessionId,
        sourceStartMessageId,
        sourceEndMessageId,
        createdAt,
      });
      if (!this.isV2OnlyStorage() && this.tableExists("thread_subagent_sessions")) {
        this.db.prepare(`DELETE FROM thread_subagent_sessions WHERE thread_id = ?`).run(threadId);
      }
      // Compaction invalidates the active subagent/metrics panel state as well as
      // the legacy resume rows. Keep the V2 projection snapshot in the same
      // transaction so V2 reads cannot resurrect the cleared session.
      this.clearConversationV2ProjectionExtrasInCurrentTransaction(threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }

    return {
      threadId,
      summaryId,
      schemaVersion,
      generation,
      summary,
      recentMessages: input.recentMessages.map((message) => ({ ...message })),
      preTokensEstimate: input.preTokensEstimate,
      preTokensSource: input.preTokensSource,
      postTokensEstimate: input.postTokensEstimate,
      postTokensSource: input.postTokensSource,
      compressionRatio: input.compressionRatio,
      sourceSessionId,
      sourceStartMessageId,
      sourceEndMessageId,
      createdAt,
    };
  }

  /** Non-atomic fixture/import helper. Production compaction uses commitCompactHandoffAndClearSession. */
  saveCompactHandoff(
    threadId: string,
    input: {
      summary: string;
      recentMessages: CompactConversationMessage[];
      postTokensEstimate: number;
      preTokensEstimate?: number;
      preTokensSource?: CompactTokenCountSource;
      postTokensSource?: CompactTokenCountSource;
      compressionRatio?: number;
    },
  ): ThreadCompactHandoffRecord {
    const createdAt = new Date().toISOString();
    const previous = this.selectCompactHandoffRow(threadId, false);
    const generation = Math.max(1, Math.trunc(previous?.generation ?? 0) + 1);
    const summaryId = `csm_${crypto.randomUUID()}`;
    const preTokensEstimate = input.preTokensEstimate ?? input.postTokensEstimate;
    const compressionRatio =
      input.compressionRatio ?? (preTokensEstimate > 0 ? input.postTokensEstimate / preTokensEstimate : 1);
    const record: ThreadCompactHandoffRecord = {
      threadId,
      summaryId,
      schemaVersion: 2,
      generation,
      summary: input.summary.trim(),
      recentMessages: input.recentMessages.map((message) => ({ ...message })),
      preTokensEstimate,
      preTokensSource: input.preTokensSource ?? "local_heuristic",
      postTokensEstimate: input.postTokensEstimate,
      postTokensSource: input.postTokensSource ?? "local_heuristic",
      compressionRatio,
      createdAt,
    };
    validateCompactMetrics(threadId, record);
    this.writeCompactHandoffRow(threadId, record);
    return record;
  }

  /** Non-atomic fixture/import helper. Production session capture uses captureSdkSessionAndConsumeCompactHandoff. */
  markCompactHandoffConsumed(threadId: string, targetSessionId: string): boolean {
    const sessionId = targetSessionId.trim();
    if (!sessionId) {
      throw new Error(`压缩交接消费缺少目标 SDK session（${threadId}）。`);
    }
    const consumedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE thread_compact_handoff
         SET target_session_id = ?, consumed_at = ?
         WHERE thread_id = ? AND consumed_at IS NULL`,
      )
      .run(sessionId, consumedAt, threadId);
    return Number(result.changes ?? 0) === 1;
  }

  clearCompactHandoff(threadId: string): void {
    this.db.prepare(`DELETE FROM thread_compact_handoff WHERE thread_id = ?`).run(threadId);
  }

  private selectCompactHandoffRow(threadId: string, onlyPending: boolean): CompactHandoffRow | undefined {
    return this.db
      .prepare(
        `SELECT thread_id, summary_id, schema_version, generation, summary,
                recent_user_messages_json, pre_tokens_estimate, pre_tokens_source,
                post_tokens_estimate, post_tokens_source, compression_ratio,
                source_session_id, source_start_message_id, source_end_message_id,
                target_session_id, consumed_at, created_at
         FROM thread_compact_handoff
         WHERE thread_id = ?${onlyPending ? " AND consumed_at IS NULL" : ""}`,
      )
      .get(threadId) as CompactHandoffRow | undefined;
  }

  private writeCompactHandoffRow(
    threadId: string,
    input: {
      summaryId: string;
      schemaVersion: number;
      generation: number;
      summary: string;
      recentMessages: CompactConversationMessage[];
      preTokensEstimate: number;
      preTokensSource: CompactTokenCountSource;
      postTokensEstimate: number;
      postTokensSource: CompactTokenCountSource;
      compressionRatio: number;
      sourceSessionId?: string;
      sourceStartMessageId?: string;
      sourceEndMessageId?: string;
      createdAt: string;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO thread_compact_handoff (
           thread_id, summary_id, schema_version, generation, summary,
           recent_user_messages_json, pre_tokens_estimate, pre_tokens_source,
           post_tokens_estimate, post_tokens_source, compression_ratio,
           source_session_id, source_start_message_id, source_end_message_id,
           target_session_id, consumed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           summary_id = excluded.summary_id,
           schema_version = excluded.schema_version,
           generation = excluded.generation,
           summary = excluded.summary,
           recent_user_messages_json = excluded.recent_user_messages_json,
           pre_tokens_estimate = excluded.pre_tokens_estimate,
           pre_tokens_source = excluded.pre_tokens_source,
           post_tokens_estimate = excluded.post_tokens_estimate,
           post_tokens_source = excluded.post_tokens_source,
           compression_ratio = excluded.compression_ratio,
           source_session_id = excluded.source_session_id,
           source_start_message_id = excluded.source_start_message_id,
           source_end_message_id = excluded.source_end_message_id,
           target_session_id = NULL,
           consumed_at = NULL,
           created_at = excluded.created_at`,
      )
      .run(
        threadId,
        input.summaryId,
        input.schemaVersion,
        input.generation,
        input.summary,
        JSON.stringify(input.recentMessages),
        input.preTokensEstimate,
        input.preTokensSource,
        input.postTokensEstimate,
        input.postTokensSource,
        input.compressionRatio,
        input.sourceSessionId ?? null,
        input.sourceStartMessageId ?? null,
        input.sourceEndMessageId ?? null,
        input.createdAt,
      );
  }

  listThreadMetrics(): ThreadMetricsRecord[] {
    this.v2.initialize();
    this.storageMode = this.v2.getStorageMode();
    if (this.isV2OnlyStorage()) {
      return this.listThreads()
        .map((thread) => this.getThreadMetrics(thread.id))
        .filter((entry): entry is ThreadMetricsRecord => entry !== undefined);
    }
    const rows = this.db
      .prepare(
        `SELECT thread_id, accumulator_json, context_json, updated_at
         FROM thread_metrics_snapshots`,
      )
      .all() as Array<{
      thread_id: string;
      accumulator_json: string | null;
      context_json: string | null;
      updated_at: string;
    }>;

    return rows
      .map((row) => rowToThreadMetrics(row))
      .filter((entry): entry is ThreadMetricsRecord => entry !== undefined);
  }

  saveThread(thread: ThreadSummary): void {
    const now = new Date().toISOString();
    const coreKind = thread.coreKind ?? "claude";
    if (!isCoreKind(coreKind)) {
      throw new Error(`Unsupported thread Core: ${String(coreKind)}`);
    }
    const coreLockedAt = thread.coreLockedAt ?? now;
    const acpAgentId = coreKind === "acp" ? resolveAcpThreadAgentId(thread) : null;
    const runtimeConfigJson = thread.runtimeConfig
      ? serializeThreadRuntimeConfig(thread.runtimeConfig)
      : null;
    this.v2.initialize();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingThread = this.db.prepare(`SELECT id FROM threads WHERE id = ?`).get(thread.id) as
        | { id: string }
        | undefined;
      this.db
        .prepare(
          `INSERT INTO threads (
           id,
           title,
           prompt,
           workspace_path,
           status,
           message,
           created_at,
           updated_at,
           core_kind,
           core_locked_at,
           acp_agent_id,
           runtime_config_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           prompt = excluded.prompt,
           workspace_path = excluded.workspace_path,
           status = excluded.status,
           message = excluded.message,
           updated_at = excluded.updated_at,
           acp_agent_id = COALESCE(excluded.acp_agent_id, threads.acp_agent_id),
           runtime_config_json = COALESCE(excluded.runtime_config_json, threads.runtime_config_json)`,
        )
        .run(
          thread.id,
          thread.title,
          thread.prompt,
          thread.workspacePath,
          thread.status,
          thread.message,
          thread.createdAt,
          now,
          coreKind,
          coreLockedAt,
          acpAgentId,
          runtimeConfigJson,
        );
      if (!existingThread) {
        this.v2.ensureConversationInCurrentTransaction(thread.id);
      }
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

  /** Commit the independent child, its references, draft and command receipt together. */
  commitForkConversation(input: {
    source: ThreadSummary;
    history: ConversationForkHistory;
    childThreadId: string;
    native: NativeConversationFork;
    principalId: string;
    clientCommandId: string;
  }): ThreadForkFromMessageResult {
    const { source, history, childThreadId, native } = input;
    const now = new Date().toISOString();
    const draft = {
      prompt: history.target.role === "user" ? history.target.body : "",
      attachments: (history.target.role === "user"
        ? (history.target.attachments ?? [])
        : []) as PromptImageAttachment[],
    };
    const results: ConversationAppendResult[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.v2.head(source.id).lastSeq !== history.sourceHeadSeq)
        throw new Error("源会话在分叉期间已变化，请刷新后重试。");
      const current = this.getThread(source.id);
      if (!current || current.status === "running" || current.status === "queued")
        throw new Error("源会话正在执行，无法提交分支。");
      this.db
        .prepare(`INSERT INTO threads (id, title, prompt, workspace_path, status, message, created_at, updated_at, core_kind, core_locked_at, runtime_config_json, sdk_session_id, sdk_cwd)
        VALUES (?, ?, ?, ?, 'idle', '', ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          childThreadId,
          `${source.title} · 分支`,
          history.messages.find((message) => message.role === "user")?.body ?? "",
          source.workspacePath,
          now,
          now,
          native.coreKind,
          now,
          source.runtimeConfig ? serializeThreadRuntimeConfig(source.runtimeConfig) : null,
          native.coreKind === "claude" ? native.externalSessionId : null,
          native.coreKind === "claude" ? native.cwd : null,
        );
      this.v2.ensureConversationInCurrentTransaction(childThreadId);
      this.writeThreadCoreSessionRow(
        {
          threadId: childThreadId,
          coreKind: native.coreKind,
          externalSessionId: native.externalSessionId,
          cwd: native.cwd,
          metadata: {
            ...native.metadata,
            ...(native.coreKind === "claude" && native.empty ? { resetPending: true } : {}),
            forkedFromThreadId: source.id,
            sourceSessionId: this.getThreadCoreSession(source.id)?.externalSessionId,
            sourceActivityLineId: history.target.historyTarget?.activityLineId ?? history.target.messageId,
          },
        },
        now,
      );
      for (const event of buildForkHistoryEvents(history, childThreadId, native.userIds))
        results.push(this.v2.appendInCurrentTransaction(event));
      results.push(
        this.v2.appendInCurrentTransaction({
          conversationId: childThreadId,
          eventId: `fork_lineage_${childThreadId}`,
          sourceEventKey: `fork:lineage:${childThreadId}`,
          type: "noop",
          occurredAt: now,
          payload: {
            reason: "history.fork_created",
            sourceThreadId: source.id,
            sourceSessionId: this.getThreadCoreSession(source.id)?.externalSessionId,
            sourceActivityLineId: history.target.historyTarget?.activityLineId ?? history.target.messageId,
            sourceHistoryRevision: this.v2.head(source.id).historyRevision,
            draftAttachments: draft.attachments,
          },
        }),
      );
      this.saveComposerDraft(`thread:${childThreadId}`, draft.prompt, draft.attachments);
      const thread = this.getThread(childThreadId);
      if (!thread) throw new Error("分支会话创建后不可读取。");
      const result: ThreadForkFromMessageResult = { thread, sourceThreadId: source.id, draft };
      this.v2.recordCommandCheckpointInCurrentTransaction({
        principalId: input.principalId,
        conversationId: source.id,
        clientCommandId: input.clientCommandId,
        name: "fork.committed",
        payload: { childThreadId },
      });
      this.v2.finishCommandInCurrentTransaction({
        principalId: input.principalId,
        conversationId: source.id,
        clientCommandId: input.clientCommandId,
        status: "completed",
        value: result,
      });
      this.db.exec("COMMIT");
      this.v2.publishCommitted(results);
      return result;
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  hasForkImageDependents(threadId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM conversation_events_v2 WHERE type = 'noop' AND json_extract(payload_json, '$.reason') = 'history.fork_created' AND json_extract(payload_json, '$.sourceThreadId') = ? LIMIT 1`,
        )
        .get(threadId),
    );
  }

  getForkVerification(threadId: string, childThreadId: string): NativeConversationFork | undefined {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM conversation_events_v2 WHERE conversation_id = ? AND source_event_key = ?`,
      )
      .get(threadId, `fork:verified:${childThreadId}`) as { payload_json: string } | undefined;
    if (!row) return undefined;
    return (JSON.parse(row.payload_json) as { native: NativeConversationFork }).native;
  }

  bindPiPromptEntry(threadId: string, activityLineId: string, entryId: string): void {
    const message = this.v2
      .listUserMessages(threadId)
      .find((item) => item.historyTarget?.activityLineId === activityLineId);
    if (!message || !entryId.trim()) throw new Error("Pi 原生用户节点没有对应的已发送消息。");
    this.v2.appendRuntime({
      conversationId: threadId,
      eventId: `pi_prompt_${crypto.createHash("sha256").update(`${threadId}:${message.messageId}:${entryId}`).digest("hex")}`,
      sourceEventKey: `pi:prompt:${message.messageId}:${entryId}`,
      type: "message.history_targeted",
      messageId: message.messageId,
      occurredAt: new Date().toISOString(),
      payload: { historyTarget: { activityLineId, userMessageId: entryId } },
    });
  }

  bindCodexForkTurn(threadId: string, userMessageId: string, turnId: string): void {
    const source = this.listConversationRuntimeSources(threadId).find(
      (source) =>
        source.role === "user" &&
        (source.metadata?.rewindTarget as { userMessageId?: string } | undefined)?.userMessageId ===
          userMessageId,
    );
    if (!source) throw new Error("Codex 用户消息没有对应的已发送事件。");
    this.appendV2ProviderPatch(
      threadId,
      [source.id],
      { metadataMerge: { codexForkTurnId: turnId } },
      `codex-fork-turn:${source.id}:${turnId}`,
    );
  }

  setThreadCoreForDraft(threadId: string, coreKind: CoreKind): void {
    const existing = this.db
      .prepare(`SELECT core_kind, core_locked_at FROM threads WHERE id = ?`)
      .get(threadId) as { core_kind: string | null; core_locked_at: string | null } | undefined;
    if (!existing) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    if (existing.core_locked_at) {
      throw new Error(`Thread Core is locked: ${threadId}`);
    }
    const session = this.getThreadCoreSession(threadId);
    if (session) {
      throw new Error(`Unlocked thread has an existing Core session: ${threadId}`);
    }
    const update = this.db
      .prepare(`UPDATE threads SET core_kind = ?, updated_at = ? WHERE id = ? AND core_locked_at IS NULL`)
      .run(coreKind, new Date().toISOString(), threadId);
    if (Number(update.changes ?? 0) !== 1) {
      throw new Error(`Thread Core lock changed while updating: ${threadId}`);
    }
  }

  lockThreadCore(threadId: string, coreKind: CoreKind, lockedAt = new Date().toISOString()): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(`SELECT core_kind, core_locked_at, acp_agent_id FROM threads WHERE id = ?`)
        .get(threadId) as
        | { core_kind: string | null; core_locked_at: string | null; acp_agent_id: string | null }
        | undefined;
      if (!existing) {
        throw new Error(`Thread not found: ${threadId}`);
      }
      const upgraded = upgradeLegacyCursorCore({
        coreKind: existing.core_kind,
        acpAgentId: existing.acp_agent_id,
      });
      if (upgraded.coreKind !== coreKind) {
        throw new Error(
          `Thread Core mismatch: ${threadId} is ${existing.core_kind ?? "unknown"}, requested ${coreKind}`,
        );
      }
      if (existing.core_kind === "cursor" && coreKind === "acp") {
        this.db
          .prepare(
            `UPDATE threads
             SET core_kind = ?, acp_agent_id = ?, updated_at = ?
             WHERE id = ? AND core_kind = 'cursor'`,
          )
          .run("acp", upgraded.acpAgentId ?? "cursor", lockedAt, threadId);
      }
      if (!existing.core_locked_at) {
        this.db
          .prepare(
            `UPDATE threads
             SET core_locked_at = ?, updated_at = ?
             WHERE id = ? AND core_kind = ? AND core_locked_at IS NULL`,
          )
          .run(lockedAt, lockedAt, threadId, coreKind);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  saveThreadCoreSession(input: {
    threadId: string;
    coreKind: CoreKind;
    externalSessionId: string;
    cwd: string;
    metadata?: Record<string, unknown>;
  }): void {
    const externalSessionId = input.externalSessionId.trim();
    const cwd = input.cwd.trim();
    if (!externalSessionId || !cwd) {
      throw new Error(`Core session requires a session id and cwd: ${input.threadId}`);
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertThreadCore(input.threadId, input.coreKind);
      this.writeThreadCoreSessionRow({ ...input, externalSessionId, cwd }, now);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  getThreadCoreSession(threadId: string): ThreadCoreSession | undefined {
    const row = this.db
      .prepare(
        `SELECT sessions.thread_id,
                sessions.core_kind,
                sessions.external_session_id,
                sessions.cwd,
                sessions.metadata_json,
                sessions.created_at,
                sessions.updated_at,
                threads.core_kind AS thread_core_kind
         FROM thread_core_sessions AS sessions
         INNER JOIN threads ON threads.id = sessions.thread_id
         WHERE sessions.thread_id = ?`,
      )
      .get(threadId) as
      | {
          thread_id: string;
          core_kind: string;
          external_session_id: string;
          cwd: string;
          metadata_json: string | null;
          created_at: string;
          updated_at: string;
          thread_core_kind: string | null;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    const sessionUpgraded = upgradeLegacyCursorCore({ coreKind: row.core_kind });
    const threadUpgraded = upgradeLegacyCursorCore({ coreKind: row.thread_core_kind });
    const sessionCoreKind = sessionUpgraded.coreKind;
    const threadCoreKind = threadUpgraded.coreKind;
    if (!sessionCoreKind) {
      throw new Error(`Unsupported persisted Core: ${row.core_kind}`);
    }
    if (threadCoreKind !== sessionCoreKind) {
      throw new Error(
        `Core session mismatch: ${row.thread_id} is ${row.thread_core_kind ?? "unknown"}, binding is ${row.core_kind}`,
      );
    }
    if (row.core_kind === "cursor" || row.thread_core_kind === "cursor") {
      const now = new Date().toISOString();
      if (row.thread_core_kind === "cursor") {
        this.db
          .prepare(
            `UPDATE threads SET core_kind = ?, acp_agent_id = COALESCE(acp_agent_id, ?), updated_at = ? WHERE id = ? AND core_kind = 'cursor'`,
          )
          .run("acp", "cursor", now, row.thread_id);
      }
      if (row.core_kind === "cursor") {
        this.db
          .prepare(
            `UPDATE thread_core_sessions SET core_kind = ?, updated_at = ? WHERE thread_id = ? AND core_kind = 'cursor'`,
          )
          .run("acp", now, row.thread_id);
      }
    }
    const metadata = parseCoreSessionMetadata(row.metadata_json, row.thread_id);
    return {
      threadId: row.thread_id,
      coreKind: sessionCoreKind,
      externalSessionId: row.external_session_id,
      cwd: row.cwd,
      ...(metadata ? { metadata } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getThreadIdByCoreSession(coreKind: CoreKind, externalSessionId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT thread_id
         FROM thread_core_sessions
         WHERE core_kind = ? AND external_session_id = ?`,
      )
      .get(coreKind, externalSessionId.trim()) as { thread_id: string } | undefined;
    return row?.thread_id;
  }

  deleteThreadCoreSession(threadId: string, coreKind: CoreKind): void {
    this.db
      .prepare(`DELETE FROM thread_core_sessions WHERE thread_id = ? AND core_kind = ?`)
      .run(threadId.trim(), coreKind);
  }

  deleteThread(threadId: string): boolean {
    const id = threadId.trim();
    if (!id || !this.getThread(id)) {
      return false;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteComposerDraft(`thread:${id}`);
      const ownedTables = this.isV2OnlyStorage()
        ? threadOwnedTables.filter((table) => !legacyConversationSourceTableSet.has(table))
        : threadOwnedTables;
      for (const table of ownedTables) {
        if (this.tableExists(table)) {
          this.db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(id);
        }
      }
      this.v2.deleteConversationInCurrentTransaction(id);
      this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
      this.db.exec("COMMIT");
      this.invalidateThreadRunEventCaches(id);
      return true;
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  acceptThreadDeleteCommand(input: ThreadDeleteCommandInput): ThreadDeleteCommandReceipt {
    const principalId = input.principalId.trim();
    const threadId = input.threadId.trim();
    const clientCommandId = input.clientCommandId.trim();
    if (
      !principalId ||
      !threadId ||
      !clientCommandId ||
      !Number.isInteger(input.expectedHistoryRevision) ||
      input.expectedHistoryRevision < 0
    ) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        "Invalid thread delete command envelope.",
      );
    }
    const requestHash = stableHash({ threadId, expectedHistoryRevision: input.expectedHistoryRevision });
    const existing = this.getThreadDeleteCommand(principalId, threadId, clientCommandId);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.idempotencyConflict,
          "Thread delete command id was reused with a different request.",
        );
      }
      return existing;
    }
    const competingAccepted = this.db
      .prepare(
        `SELECT principal_id, client_command_id
         FROM thread_delete_receipts_v2
         WHERE thread_id = ? AND status = 'accepted'
         LIMIT 1`,
      )
      .get(threadId) as { principal_id: string; client_command_id: string } | undefined;
    if (competingAccepted) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.idempotencyConflict,
        "Thread already has a different accepted delete command.",
        {
          acceptedPrincipalId: competingAccepted.principal_id,
          acceptedClientCommandId: competingAccepted.client_command_id,
        },
      );
    }
    if (!this.getThread(threadId) || !this.v2.hasConversation(threadId)) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        "Thread delete requires an existing V2 conversation or a matching completed receipt.",
      );
    }
    const head = this.v2.head(threadId);
    if (head.historyRevision !== input.expectedHistoryRevision) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.cursorStale,
        "Conversation history changed before thread deletion was accepted.",
        {
          expectedHistoryRevision: input.expectedHistoryRevision,
          actualHistoryRevision: head.historyRevision,
        },
      );
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO thread_delete_receipts_v2 (
           principal_id, thread_id, client_command_id, request_hash,
           expected_history_revision, status, result_json, accepted_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'accepted', NULL, ?, ?)`,
      )
      .run(principalId, threadId, clientCommandId, requestHash, input.expectedHistoryRevision, now, now);
    const accepted = this.getThreadDeleteCommand(principalId, threadId, clientCommandId);
    if (!accepted) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        "Accepted thread delete receipt disappeared.",
      );
    }
    return accepted;
  }

  getThreadDeleteCommand(
    principalId: string,
    threadId: string,
    clientCommandId: string,
  ): ThreadDeleteCommandReceipt | undefined {
    const row = this.db
      .prepare(
        `SELECT principal_id, thread_id, client_command_id, request_hash,
                expected_history_revision, status, result_json, accepted_at, updated_at
         FROM thread_delete_receipts_v2
         WHERE principal_id = ? AND thread_id = ? AND client_command_id = ?`,
      )
      .get(principalId.trim(), threadId.trim(), clientCommandId.trim()) as
      | {
          principal_id: string;
          thread_id: string;
          client_command_id: string;
          request_hash: string;
          expected_history_revision: number;
          status: string;
          result_json: string | null;
          accepted_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    if (row.status !== "accepted" && row.status !== "completed") {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        "Stored thread delete receipt has an invalid status.",
      );
    }
    const result = row.result_json ? (JSON.parse(row.result_json) as unknown) : undefined;
    if (
      (row.status === "accepted" && result !== undefined) ||
      (row.status === "completed" &&
        (!result ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          (result as Record<string, unknown>).ok !== true ||
          (result as Record<string, unknown>).deleted !== true ||
          (result as Record<string, unknown>).threadId !== row.thread_id))
    ) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        "Stored thread delete receipt result is malformed.",
      );
    }
    return {
      principalId: row.principal_id,
      threadId: row.thread_id,
      clientCommandId: row.client_command_id,
      requestHash: row.request_hash,
      expectedHistoryRevision: row.expected_history_revision,
      status: row.status,
      ...(result ? { result: result as NonNullable<ThreadDeleteCommandReceipt["result"]> } : {}),
      acceptedAt: row.accepted_at,
      updatedAt: row.updated_at,
    };
  }

  completeThreadDeleteCommand(input: ThreadDeleteCommandInput): ThreadDeleteCommandReceipt {
    const receipt = this.acceptThreadDeleteCommand(input);
    if (receipt.status === "completed") return receipt;
    const result = { ok: true as const, deleted: true as const, threadId: receipt.threadId };
    const updatedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getThread(receipt.threadId)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          "Accepted thread delete lost its thread before the terminal transaction.",
        );
      }
      this.deleteComposerDraft(`thread:${receipt.threadId}`);
      const ownedTables = this.isV2OnlyStorage()
        ? threadOwnedTables.filter((table) => !legacyConversationSourceTableSet.has(table))
        : threadOwnedTables;
      for (const table of ownedTables) {
        if (this.tableExists(table)) {
          this.db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(receipt.threadId);
        }
      }
      this.v2.deleteConversationInCurrentTransaction(receipt.threadId);
      this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(receipt.threadId);
      const changed = this.db
        .prepare(
          `UPDATE thread_delete_receipts_v2
           SET status = 'completed', result_json = ?, updated_at = ?
           WHERE principal_id = ? AND thread_id = ? AND client_command_id = ?
             AND status = 'accepted' AND request_hash = ?`,
        )
        .run(
          JSON.stringify(result),
          updatedAt,
          receipt.principalId,
          receipt.threadId,
          receipt.clientCommandId,
          receipt.requestHash,
        );
      if (changed.changes !== 1) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          "Thread delete receipt terminal transition was not atomic.",
        );
      }
      this.db.exec("COMMIT");
      this.invalidateThreadRunEventCaches(receipt.threadId);
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    const completed = this.getThreadDeleteCommand(
      receipt.principalId,
      receipt.threadId,
      receipt.clientCommandId,
    );
    if (!completed || completed.status !== "completed") {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        "Completed thread delete receipt disappeared.",
      );
    }
    return completed;
  }

  enqueueThreadFollowUp(input: {
    threadId: string;
    prompt: string;
    attachments?: readonly PromptImageAttachment[];
    priority?: ThreadFollowUpPriority;
    deliveryMode?: ThreadFollowUpDeliveryMode;
    sourceRunAttemptId?: string;
    queuedDuringPhase?: ThreadFollowUpRunPhase;
    conversationMessageId?: string;
  }): ThreadPendingFollowUp {
    const now = new Date().toISOString();
    const attachments = normalizeFollowUpAttachmentsForStorage(input.attachments, this.isV2OnlyStorage());
    const record: ThreadPendingFollowUp = {
      id: `tfu_${crypto.randomUUID()}`,
      threadId: input.threadId,
      prompt: input.prompt,
      priority: input.priority ?? "normal",
      status: "queued",
      deliveryMode: input.deliveryMode ?? "queued",
      createdAt: now,
      updatedAt: now,
      ...(attachments?.length ? { attachments } : {}),
      ...(input.sourceRunAttemptId?.trim() ? { sourceRunAttemptId: input.sourceRunAttemptId.trim() } : {}),
      ...(input.queuedDuringPhase ? { queuedDuringPhase: input.queuedDuringPhase } : {}),
      ...(input.conversationMessageId?.trim()
        ? { conversationMessageId: input.conversationMessageId.trim() }
        : {}),
    };
    this.db
      .prepare(
        `INSERT INTO ${this.pendingFollowupsTable()} (
           id, thread_id, prompt, attachments_json, priority, status, delivery_mode,
           source_run_attempt_id, target_run_attempt_id, queued_during_phase, delivery_boundary, error,
           created_at, updated_at, delivered_at, applied_at, conversation_message_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        record.id,
        record.threadId,
        record.prompt,
        record.attachments ? JSON.stringify(record.attachments) : null,
        record.priority,
        record.status,
        record.deliveryMode,
        record.sourceRunAttemptId ?? null,
        record.queuedDuringPhase ?? null,
        record.createdAt,
        record.updatedAt,
        record.conversationMessageId ?? null,
      );
    this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, input.threadId);
    return record;
  }

  getThreadFollowUp(threadId: string, followUpId: string): ThreadPendingFollowUp | undefined {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, prompt, attachments_json, priority, status, delivery_mode,
                source_run_attempt_id, target_run_attempt_id, queued_during_phase, delivery_boundary, error,
                queue_position, created_at, updated_at, delivered_at, applied_at, conversation_message_id
         FROM ${this.pendingFollowupsTable()}
         WHERE thread_id = ? AND id = ?`,
      )
      .get(threadId, followUpId) as ThreadPendingFollowUpRow | undefined;
    return row ? rowToThreadPendingFollowUp(row) : undefined;
  }

  listThreadFollowUps(
    threadId: string,
    options?: { statuses?: readonly ThreadFollowUpStatus[] },
  ): ThreadPendingFollowUp[] {
    const statuses = options?.statuses?.filter(isThreadFollowUpStatus) ?? [];
    const base = `SELECT id, thread_id, prompt, attachments_json, priority, status, delivery_mode,
                         source_run_attempt_id, target_run_attempt_id, queued_during_phase, delivery_boundary, error,
                         queue_position, created_at, updated_at, delivered_at, applied_at, conversation_message_id
                  FROM ${this.pendingFollowupsTable()}
                  WHERE thread_id = ?`;
    const where = statuses.length > 0 ? ` AND status IN (${statuses.map(() => "?").join(", ")})` : "";
    const rows = this.db
      .prepare(
        `${base}${where}
         ORDER BY COALESCE(queue_position, 2147483647) ASC,
                  CASE priority WHEN 'escalated' THEN 0 ELSE 1 END,
                  created_at ASC,
                  rowid ASC`,
      )
      .all(threadId, ...statuses) as unknown as ThreadPendingFollowUpRow[];
    return rows.map(rowToThreadPendingFollowUp);
  }

  updateThreadFollowUpStatus(
    threadId: string,
    followUpId: string,
    input: {
      status: ThreadFollowUpStatus;
      deliveryMode?: ThreadFollowUpDeliveryMode;
      targetRunAttemptId?: string;
      deliveryBoundary?: ThreadFollowUpBoundary;
      error?: string;
    },
  ): ThreadPendingFollowUp | undefined {
    const existing = this.getThreadFollowUp(threadId, followUpId);
    if (!existing) {
      return undefined;
    }
    const now = new Date().toISOString();
    const deliveredAt = input.status === "delivered" ? now : existing.deliveredAt;
    const appliedAt = input.status === "applied" ? now : existing.appliedAt;
    this.db
      .prepare(
        `UPDATE ${this.pendingFollowupsTable()}
         SET status = ?,
             delivery_mode = COALESCE(?, delivery_mode),
             target_run_attempt_id = COALESCE(?, target_run_attempt_id),
             delivery_boundary = COALESCE(?, delivery_boundary),
             error = ?,
             updated_at = ?,
             delivered_at = ?,
             applied_at = ?
         WHERE thread_id = ? AND id = ?`,
      )
      .run(
        input.status,
        input.deliveryMode ?? null,
        input.targetRunAttemptId ?? null,
        input.deliveryBoundary ?? null,
        input.error ?? null,
        now,
        deliveredAt ?? null,
        appliedAt ?? null,
        threadId,
        followUpId,
      );
    return this.getThreadFollowUp(threadId, followUpId);
  }

  reorderQueuedThreadFollowUps(threadId: string, followUpIds: readonly string[]): ThreadPendingFollowUp[] {
    const queued = this.listThreadFollowUps(threadId, { statuses: ["queued"] });
    const queuedIds = new Set(queued.map((followUp) => followUp.id));
    if (
      followUpIds.length !== queuedIds.size ||
      new Set(followUpIds).size !== followUpIds.length ||
      followUpIds.some((id) => !queuedIds.has(id))
    ) {
      throw new Error("Follow-up order does not match the queued messages.");
    }
    const statement = this.db.prepare(
      `UPDATE ${this.pendingFollowupsTable()}
       SET queue_position = ?, updated_at = ?
       WHERE thread_id = ? AND id = ? AND status = 'queued'`,
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      followUpIds.forEach((followUpId, index) => {
        statement.run(index, now, threadId, followUpId);
      });
      this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    return this.listThreadFollowUps(threadId, { statuses: ["queued"] });
  }

  cancelThreadFollowUp(threadId: string, followUpId: string): ThreadPendingFollowUp | undefined {
    const existing = this.getThreadFollowUp(threadId, followUpId);
    if (!existing || existing.status !== "queued") {
      return undefined;
    }
    const message = existing.conversationMessageId
      ? this.v2.getMessage(threadId, existing.conversationMessageId)
      : undefined;
    if (existing.conversationMessageId && !message) {
      throw new Error("Queued follow-up has no accepted conversation message to cancel.");
    }
    if (message) this.v2.validateIntegrity(threadId);
    const results: ConversationAppendResult[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (message && !message.isDeleted && message.status === "queued") {
        const sourceEventKey = `desktop:user:follow-up-abandoned:${threadId}:${message.messageId}:follow-up-cancelled`;
        results.push(
          this.v2.appendInCurrentTransaction({
            conversationId: threadId,
            eventId: `desktop_v2_follow_up_abandoned_${stableHash(sourceEventKey)}`,
            sourceEventKey,
            type: "history.deleted",
            occurredAt: new Date().toISOString(),
            messageId: message.messageId,
            payload: { reason: "follow-up-cancelled", affectedMessageIds: [message.messageId] },
          }),
        );
      }
      const cancelled = this.updateThreadFollowUpStatus(threadId, followUpId, { status: "cancelled" });
      this.db.exec("COMMIT");
      this.v2.publishCommitted(results);
      return cancelled;
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  updateThreadFollowUp(
    threadId: string,
    followUpId: string,
    input: {
      prompt: string;
      attachments?: readonly PromptImageAttachment[];
    },
  ): ThreadPendingFollowUp | undefined {
    const existing = this.getThreadFollowUp(threadId, followUpId);
    if (!existing || existing.status !== "queued") {
      return undefined;
    }
    const attachments = normalizeFollowUpAttachmentsForStorage(input.attachments, this.isV2OnlyStorage());
    const prompt = input.prompt.trim() || (attachments?.length ? "请查看并分析我附上的图片。" : "");
    if (!prompt && !attachments?.length) {
      return undefined;
    }
    const now = new Date().toISOString();
    // The queue and accepted user message must commit together. A half edit leaves
    // history/startup recovery showing or resending the original text/images.
    const message = existing.conversationMessageId
      ? this.v2.getMessage(threadId, existing.conversationMessageId)
      : undefined;
    if (existing.conversationMessageId && (!message || message.status !== "queued" || message.isDeleted)) {
      throw new Error("Queued follow-up has no editable accepted conversation message.");
    }
    const results: ConversationAppendResult[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (message) {
        const sourceEventKey = `desktop:user:follow-up-edit:${threadId}:${followUpId}:${message.contentVersion + 1}`;
        results.push(
          this.v2.appendInCurrentTransaction({
            conversationId: threadId,
            eventId: `desktop_v2_follow_up_edit_${stableHash(sourceEventKey)}`,
            sourceEventKey,
            type: "message.replaced",
            occurredAt: now,
            messageId: message.messageId,
            payload: {
              body: prompt,
              baseContentVersion: message.contentVersion,
              nextContentVersion: message.contentVersion + 1,
              attachments: (attachments ?? []).map(({ mediaType, contentRef, byteLength, data }) => ({
                mediaType,
                ...(contentRef ? { contentRef } : {}),
                ...(!contentRef && data ? { data } : {}),
                ...(byteLength !== undefined ? { byteLength } : {}),
              })),
            },
          }),
        );
      }
      this.db
        .prepare(
        `UPDATE ${this.pendingFollowupsTable()}
         SET prompt = ?,
             attachments_json = ?,
             updated_at = ?
         WHERE thread_id = ? AND id = ?`,
      )
        .run(prompt, attachments ? JSON.stringify(attachments) : null, now, threadId, followUpId);
      this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    this.v2.publishCommitted(results);
    return this.getThreadFollowUp(threadId, followUpId);
  }

  escalateThreadFollowUp(threadId: string, followUpId: string): ThreadPendingFollowUp | undefined {
    const existing = this.getThreadFollowUp(threadId, followUpId);
    if (!existing || existing.status !== "queued") {
      return undefined;
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE ${this.pendingFollowupsTable()}
           SET status = 'superseded', updated_at = ?
           WHERE thread_id = ?
             AND id <> ?
             AND status = 'queued'
             AND priority = 'escalated'`,
        )
        .run(now, threadId, followUpId);
      this.db
        .prepare(
          `UPDATE ${this.pendingFollowupsTable()}
           SET priority = 'escalated',
               delivery_mode = 'interrupt_resume',
               updated_at = ?
           WHERE thread_id = ? AND id = ?`,
        )
        .run(now, threadId, followUpId);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    return this.getThreadFollowUp(threadId, followUpId);
  }

  /** Reserve a queued row before starting an irreversible mid-turn push. */
  claimThreadFollowUpStreamingPush(
    threadId: string,
    followUpId: string,
    input?: { targetRunAttemptId?: string; excludeFollowUpId?: string },
  ): ThreadPendingFollowUp | undefined {
    if (input?.excludeFollowUpId && followUpId === input.excludeFollowUpId) {
      return undefined;
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE ${this.pendingFollowupsTable()}
           SET status = 'delivered',
               delivery_mode = 'streaming_push',
               target_run_attempt_id = COALESCE(?, target_run_attempt_id),
               error = NULL,
               delivered_at = ?,
               applied_at = NULL,
               updated_at = ?
           WHERE thread_id = ? AND id = ? AND status = 'queued'`,
        )
        .run(input?.targetRunAttemptId ?? null, now, now, threadId, followUpId);
      if (result.changes === 0) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    return this.getThreadFollowUp(threadId, followUpId);
  }

  /** Commit a reserved streaming push after the SDK acknowledges acceptance. */
  markThreadFollowUpStreamingPushApplied(
    threadId: string,
    followUpId: string,
  ): ThreadPendingFollowUp | undefined {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ${this.pendingFollowupsTable()}
         SET status = 'applied',
             error = NULL,
             applied_at = ?,
             updated_at = ?
         WHERE thread_id = ?
           AND id = ?
           AND status = 'delivered'
           AND delivery_mode = 'streaming_push'`,
      )
      .run(now, now, threadId, followUpId);
    if (result.changes === 0) {
      return undefined;
    }
    this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, threadId);
    return this.getThreadFollowUp(threadId, followUpId);
  }

  /** Return a definitely rejected streaming push to the durable queue. */
  requeueThreadFollowUpStreamingPush(
    threadId: string,
    followUpId: string,
    input?: { error?: string },
  ): ThreadPendingFollowUp | undefined {
    const existing = this.getThreadFollowUp(threadId, followUpId);
    if (!existing) {
      return undefined;
    }
    if (existing.deliveryMode !== "streaming_push") {
      return undefined;
    }
    if (existing.status !== "applied" && existing.status !== "delivered") {
      return undefined;
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ${this.pendingFollowupsTable()}
         SET status = 'queued',
             delivery_mode = CASE
               WHEN priority = 'escalated' THEN 'interrupt_resume'
               ELSE 'queued'
             END,
             error = ?,
             delivered_at = NULL,
             applied_at = NULL,
             updated_at = ?
         WHERE thread_id = ?
           AND id = ?
           AND delivery_mode = 'streaming_push'
           AND status IN ('delivered', 'applied')`,
      )
      .run(input?.error ?? null, now, threadId, followUpId);
    if (result.changes === 0) {
      return undefined;
    }
    this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, threadId);
    return this.getThreadFollowUp(threadId, followUpId);
  }

  /**
   * Mark a reserved/applied streaming push as cancelled by interrupt(cancelQueued).
   * Unlike delivery-unknown, these will not run — safe to treat as terminal cancel.
   */
  markThreadFollowUpInterruptCancelled(
    threadId: string,
    followUpId: string,
    error: string,
  ): ThreadPendingFollowUp | undefined {
    const existing = this.getThreadFollowUp(threadId, followUpId);
    if (!existing || existing.deliveryMode !== "streaming_push") {
      return undefined;
    }
    if (existing.status !== "applied" && existing.status !== "delivered" && existing.status !== "queued") {
      return undefined;
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ${this.pendingFollowupsTable()}
         SET status = 'cancelled',
             error = ?,
             updated_at = ?
         WHERE thread_id = ?
           AND id = ?
           AND delivery_mode = 'streaming_push'
           AND status IN ('queued', 'delivered', 'applied')`,
      )
      .run(error, now, threadId, followUpId);
    if (result.changes === 0) {
      return undefined;
    }
    this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, threadId);
    return this.getThreadFollowUp(threadId, followUpId);
  }

  /**
   * Mark a reserved/applied streaming push as delivery unknown. Unknown delivery
   * must never silently return to the queue because the remote may have accepted it.
   */
  markThreadFollowUpDeliveryUnknown(
    threadId: string,
    followUpId: string,
    error: string,
  ): ThreadPendingFollowUp | undefined {
    const existing = this.getThreadFollowUp(threadId, followUpId);
    if (!existing || existing.deliveryMode !== "streaming_push") {
      return undefined;
    }
    if (existing.status !== "applied" && existing.status !== "delivered") {
      return undefined;
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ${this.pendingFollowupsTable()}
         SET status = 'failed',
             error = ?,
             updated_at = ?
         WHERE thread_id = ?
           AND id = ?
           AND delivery_mode = 'streaming_push'
           AND status IN ('delivered', 'applied')`,
      )
      .run(error, now, threadId, followUpId);
    if (result.changes === 0) {
      return undefined;
    }
    this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now, threadId);
    return this.getThreadFollowUp(threadId, followUpId);
  }

  claimQueuedThreadFollowUps(
    threadId: string,
    input?: {
      deliveryMode?: ThreadFollowUpDeliveryMode;
      targetRunAttemptId?: string;
      priority?: ThreadFollowUpPriority;
      /** Claim this one independently delivered answer without consuming ordinary rows. */
      followUpId?: string;
      deliveryBoundary?: ThreadFollowUpBoundary;
      excludeFollowUpId?: string;
    },
  ): ThreadPendingFollowUp[] {
    const queued = this.listThreadFollowUps(threadId, { statuses: ["queued"] })
      .filter((followUp) => !input?.followUpId || followUp.id === input.followUpId)
      .filter((followUp) => !input?.priority || followUp.priority === input.priority)
      .filter((followUp) => !input?.excludeFollowUpId || followUp.id !== input.excludeFollowUpId)
      .slice(0, 1);
    if (queued.length === 0) {
      return [];
    }
    const now = new Date().toISOString();
    const ids = queued.map((followUp) => followUp.id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE ${this.pendingFollowupsTable()}
           SET status = 'delivered',
             delivery_mode = ?,
             target_run_attempt_id = COALESCE(?, target_run_attempt_id),
             delivery_boundary = COALESCE(?, delivery_boundary),
             delivered_at = ?,
             updated_at = ?
           WHERE thread_id = ?
             AND status = 'queued'
             AND id IN (${ids.map(() => "?").join(", ")})`,
        )
        .run(
          input?.deliveryMode ?? "resume",
          input?.targetRunAttemptId ?? null,
          input?.deliveryBoundary ?? null,
          now,
          now,
          threadId,
          ...ids,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    return this.listThreadFollowUps(threadId).filter((followUp) => ids.includes(followUp.id));
  }

  updateThreadPrompt(threadId: string, prompt: string): void {
    this.db
      .prepare(`UPDATE threads SET prompt = ?, updated_at = ? WHERE id = ?`)
      .run(prompt, new Date().toISOString(), threadId);
  }

  updateThreadTitle(threadId: string, title: string): void {
    this.db
      .prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, new Date().toISOString(), threadId);
  }

  updateThread(threadId: string, patch: Pick<ThreadSummary, "status" | "message">): void {
    this.db
      .prepare(
        `UPDATE threads
         SET status = ?, message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(patch.status, patch.message, new Date().toISOString(), threadId);
  }

  setThreadFollowUpQueuePaused(threadId: string, paused: boolean): ThreadSummary | undefined {
    if (!this.getThread(threadId)) {
      return undefined;
    }
    this.db
      .prepare(
        `UPDATE threads
         SET follow_up_queue_paused = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(paused ? 1 : 0, new Date().toISOString(), threadId);
    return this.getThread(threadId);
  }

  private assertThreadCore(threadId: string, coreKind: CoreKind): void {
    const row = this.db
      .prepare(`SELECT core_kind, core_locked_at, acp_agent_id FROM threads WHERE id = ?`)
      .get(threadId) as
      | { core_kind: string | null; core_locked_at: string | null; acp_agent_id: string | null }
      | undefined;
    if (!row) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const upgraded = upgradeLegacyCursorCore({
      coreKind: row.core_kind,
      acpAgentId: row.acp_agent_id,
    });
    const effectiveCoreKind = upgraded.coreKind;
    if (effectiveCoreKind !== coreKind) {
      throw new Error(
        `Thread Core mismatch: ${threadId} is ${row.core_kind ?? "unknown"}, requested ${coreKind}`,
      );
    }
    if (row.core_kind === "cursor" && coreKind === "acp") {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE threads
           SET core_kind = ?, acp_agent_id = ?, updated_at = ?
           WHERE id = ? AND core_kind = 'cursor'`,
        )
        .run("acp", upgraded.acpAgentId ?? "cursor", now, threadId);
    }
    if (!row.core_locked_at) {
      const lockedAt = new Date().toISOString();
      this.db
        .prepare(`UPDATE threads SET core_locked_at = ?, updated_at = ? WHERE id = ?`)
        .run(lockedAt, lockedAt, threadId);
    }
  }

  private writeThreadCoreSessionRow(
    input: {
      threadId: string;
      coreKind: CoreKind;
      externalSessionId: string;
      cwd: string;
      metadata?: Record<string, unknown>;
    },
    updatedAt: string,
  ): void {
    const existing = this.db
      .prepare(`SELECT core_kind FROM thread_core_sessions WHERE thread_id = ?`)
      .get(input.threadId) as { core_kind: string } | undefined;
    if (existing && existing.core_kind !== input.coreKind) {
      throw new Error(
        `Core session mismatch: ${input.threadId} has ${existing.core_kind}, requested ${input.coreKind}`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO thread_core_sessions (
           thread_id,
           core_kind,
           external_session_id,
           cwd,
           metadata_json,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           core_kind = excluded.core_kind,
           external_session_id = excluded.external_session_id,
           cwd = excluded.cwd,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.threadId,
        input.coreKind,
        input.externalSessionId,
        input.cwd,
        input.metadata ? JSON.stringify(input.metadata) : null,
        updatedAt,
        updatedAt,
      );
  }

  saveSdkSession(threadId: string, sessionId: string, cwd: string): void {
    const normalizedSessionId = sessionId.trim();
    const normalizedCwd = cwd.trim();
    if (!normalizedSessionId || !normalizedCwd) {
      throw new Error(`Claude session requires a session id and cwd: ${threadId}`);
    }
    const updatedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertThreadCore(threadId, "claude");
      const update = this.db
        .prepare(
          `UPDATE threads
           SET sdk_session_id = ?, sdk_cwd = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(normalizedSessionId, normalizedCwd, updatedAt, threadId);
      if (Number(update.changes ?? 0) !== 1) {
        throw new Error(`Claude session thread not found: ${threadId}`);
      }
      this.writeThreadCoreSessionRow(
        {
          threadId,
          coreKind: "claude",
          externalSessionId: normalizedSessionId,
          cwd: normalizedCwd,
        },
        updatedAt,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  /**
   * Atomically captures the replacement SDK session and consumes any pending compact handoff.
   * A compacted source session must never be reinstalled as the target session.
   */
  captureSdkSessionAndConsumeCompactHandoff(
    threadId: string,
    sessionId: string,
    cwd: string,
    state?: { resetPending?: boolean },
  ): boolean {
    const targetSessionId = sessionId.trim();
    const targetCwd = cwd.trim();
    if (!targetSessionId) {
      throw new Error(`SDK session capture 缺少 session id（${threadId}）。`);
    }
    if (!targetCwd) {
      throw new Error(`SDK session capture 缺少 cwd（${threadId}）。`);
    }

    const capturedAt = new Date().toISOString();
    let consumedHandoff = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pendingRow = this.selectCompactHandoffRow(threadId, true);
      const pendingHandoff = pendingRow ? compactHandoffRowToRecord(pendingRow, threadId) : undefined;
      if (pendingHandoff?.sourceSessionId === targetSessionId) {
        throw new Error(`压缩后的新 SDK session 与源 session 相同，拒绝恢复旧上下文（${threadId}）。`);
      }

      const sessionUpdate = this.db
        .prepare(
          `UPDATE threads
           SET sdk_session_id = ?, sdk_cwd = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(targetSessionId, targetCwd, capturedAt, threadId);
      if (Number(sessionUpdate.changes ?? 0) !== 1) {
        throw new Error(`SDK session capture 找不到线程记录（${threadId}）。`);
      }
      this.assertThreadCore(threadId, "claude");
      this.writeThreadCoreSessionRow(
        {
          threadId,
          coreKind: "claude",
          externalSessionId: targetSessionId,
          cwd: targetCwd,
          ...(state?.resetPending && { metadata: { resetPending: true } }),
        },
        capturedAt,
      );

      if (pendingHandoff) {
        const consumed = this.db
          .prepare(
            `UPDATE thread_compact_handoff
             SET target_session_id = ?, consumed_at = ?
             WHERE thread_id = ? AND consumed_at IS NULL`,
          )
          .run(targetSessionId, capturedAt, threadId);
        if (Number(consumed.changes ?? 0) !== 1) {
          throw new Error(`压缩交接消费状态已变化，拒绝提交 SDK session（${threadId}）。`);
        }
        consumedHandoff = true;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    return consumedHandoff;
  }

  getSdkSession(threadId: string): ThreadSdkSession | undefined {
    const row = this.db.prepare(`SELECT sdk_session_id, sdk_cwd FROM threads WHERE id = ?`).get(threadId) as
      | { sdk_session_id: string | null; sdk_cwd: string | null }
      | undefined;
    if (!row?.sdk_session_id || !row.sdk_cwd) {
      return undefined;
    }
    const session = this.getThreadCoreSession(threadId);
    return {
      sessionId: row.sdk_session_id,
      cwd: row.sdk_cwd,
      ...(session?.metadata?.resetPending === true && { resetPending: true }),
    };
  }

  clearSdkSession(threadId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertThreadCore(threadId, "claude");
      this.db
        .prepare(
          `UPDATE threads
           SET sdk_session_id = NULL, sdk_cwd = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), threadId);
      this.db
        .prepare(`DELETE FROM thread_core_sessions WHERE thread_id = ? AND core_kind = 'claude'`)
        .run(threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    this.clearSubagentSessions(threadId);
  }

  /**
   * Zero-based ordinal of a Codex user-message id among persisted user turns.
   * Prefer run-event order (feed chronology) over user_messages created_at.
   */
  resolveCodexUserTurnIndex(threadId: string, itemId: string): number | undefined {
    const id = itemId.trim();
    if (!threadId.trim() || !id) {
      return undefined;
    }
    const activityLineId = sdkActivityLineId(id);
    const rows = this.listConversationRuntimeSources(threadId)
      .filter(
        (event) => event.role === "user" && ["thread.status", "message.final"].includes(event.eventType),
      )
      .map((event) => ({
        stream_key: event.streamKey ?? null,
        metadata_json: event.metadata ? JSON.stringify(event.metadata) : null,
        event_type: event.eventType,
      }));
    const orderedIds: string[] = [];
    for (const row of rows) {
      const metadata = parseJsonRecord(row.metadata_json);
      if (row.event_type === "thread.status") {
        const liveType = typeof metadata?.liveType === "string" ? metadata.liveType : "";
        if (liveType && liveType !== "thread.user_prompt" && liveType !== "message.user") {
          continue;
        }
      }
      const rewind = metadata?.rewindTarget;
      const rewindId =
        rewind &&
        typeof rewind === "object" &&
        typeof (rewind as { userMessageId?: unknown }).userMessageId === "string"
          ? (rewind as { userMessageId: string }).userMessageId.trim()
          : "";
      const streamId = sdkMessageUuidFromActivityLineId(row.stream_key ?? "") ?? "";
      const uid = rewindId || streamId;
      if (!uid || orderedIds.includes(uid)) {
        continue;
      }
      orderedIds.push(uid);
    }
    const fromEvents = orderedIds.indexOf(id);
    if (fromEvents >= 0) {
      return fromEvents;
    }

    // A native provider index is authoritative. A stream without sources is still a
    // pre-runtime compatibility setup and may legitimately use the legacy row.
    if (this.isV2OnlyStorage() || this.hasNativeProviderInputs(threadId)) {
      return undefined;
    }

    const records = this.db
      .prepare(
        `SELECT upstream_message_id, activity_line_id
         FROM thread_user_messages
         WHERE thread_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(threadId) as Array<{ upstream_message_id: string | null; activity_line_id: string }>;
    const fromRecords = records.findIndex(
      (row) =>
        row.upstream_message_id?.trim() === id ||
        row.activity_line_id === activityLineId ||
        row.activity_line_id === id,
    );
    return fromRecords >= 0 ? fromRecords : undefined;
  }

  saveUserMessageRecord(input: {
    threadId: string;
    activityLineId: string;
    text: string;
    attachments?: readonly PromptImageAttachment[];
    upstreamMessageId?: string;
    provider?: CoreKind;
    createdAt?: string;
  }): void {
    const threadId = input.threadId.trim();
    const activityLineId = input.activityLineId.trim();
    const text = input.text.trim();
    const attachments = (input.attachments ?? []).filter((attachment): attachment is PromptImageAttachment =>
      Boolean(attachment.data?.trim() && attachment.mediaType),
    );
    if (!threadId || !activityLineId || (!text && attachments.length === 0)) return;
    // Native runtime prompts are already durable in conversation_messages_v2. Keeping a
    // second mutable user-message row here would make the legacy table a live write path;
    // callers operating on a pre-V2 stream still use this method during compatibility reads.
    if (this.isV2OnlyStorage() || this.hasNativeProviderInputs(threadId)) return;
    const now = new Date().toISOString();
    const createdAt = input.createdAt?.trim() || now;
    const attachmentsJson = input.attachments === undefined ? null : JSON.stringify(attachments);
    this.db
      .prepare(
        `INSERT INTO thread_user_messages (
           thread_id, activity_line_id, upstream_message_id, provider, text,
           attachments_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, activity_line_id) DO UPDATE SET
           upstream_message_id = COALESCE(excluded.upstream_message_id, thread_user_messages.upstream_message_id),
           provider = COALESCE(excluded.provider, thread_user_messages.provider),
           text = excluded.text,
           attachments_json = COALESCE(excluded.attachments_json, thread_user_messages.attachments_json),
           updated_at = excluded.updated_at`,
      )
      .run(
        threadId,
        activityLineId,
        input.upstreamMessageId?.trim() || null,
        input.provider ?? null,
        text,
        attachmentsJson,
        createdAt,
        now,
      );
  }

  private getLatestCodexPendingUserMessageRow(threadId: string):
    | {
        activity_line_id: string;
        text: string;
        attachments_json: string | null;
        created_at: string;
      }
    | undefined {
    if (!threadId.trim()) {
      return undefined;
    }
    if (this.isV2OnlyStorage()) {
      return undefined;
    }
    return this.db
      .prepare(
        `SELECT activity_line_id, text, attachments_json, created_at
         FROM thread_user_messages
         WHERE thread_id = ? AND provider = 'codex' AND upstream_message_id IS NULL
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(threadId) as
      | {
          activity_line_id: string;
          text: string;
          attachments_json: string | null;
          created_at: string;
        }
      | undefined;
  }

  getUserMessageRecord(threadId: string, activityLineId: string): ThreadUserMessageRecord | undefined {
    const id = activityLineId.trim();
    if (!threadId.trim() || !id) return undefined;
    const native = this.listNativeUserMessageRecords(threadId);
    if (native) {
      return native.find(
        (record) =>
          record.activityLineId === id ||
          record.upstreamMessageId === id ||
          record.activityLineId === sdkActivityLineId(id),
      );
    }
    if (this.isV2OnlyStorage()) {
      this.assertV2OnlyReadStream(threadId);
      return undefined;
    }
    const row = this.db
      .prepare(
        `SELECT thread_id, activity_line_id, upstream_message_id, provider, text,
                attachments_json, created_at, updated_at
         FROM thread_user_messages
         WHERE thread_id = ? AND activity_line_id = ?
         LIMIT 1`,
      )
      .get(threadId, id) as
      | {
          thread_id: string;
          activity_line_id: string;
          upstream_message_id: string | null;
          provider: string | null;
          text: string;
          attachments_json: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      threadId: row.thread_id,
      activityLineId: row.activity_line_id,
      ...(row.upstream_message_id?.trim() && { upstreamMessageId: row.upstream_message_id.trim() }),
      ...(isCoreKind(row.provider) && { provider: row.provider }),
      text: row.text,
      attachments: parsePromptImageAttachments(row.attachments_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updateUserMessageUpstream(
    threadId: string,
    activityLineId: string,
    upstreamMessageId: string,
    provider?: CoreKind,
  ): void {
    if (this.isV2OnlyStorage()) return;
    const id = activityLineId.trim();
    const upstream = upstreamMessageId.trim();
    if (!threadId.trim() || !id || !upstream) return;
    this.db
      .prepare(
        `UPDATE thread_user_messages
         SET upstream_message_id = ?, provider = COALESCE(?, provider), updated_at = ?
         WHERE thread_id = ? AND activity_line_id = ?`,
      )
      .run(upstream, provider ?? null, new Date().toISOString(), threadId, id);
  }

  rebindClaudeUserMessageRecords(
    threadId: string,
    mappings: readonly { activityLineId: string; upstreamMessageId: string }[],
  ): void {
    const normalized = mappings
      .map((mapping) => ({
        activityLineId: mapping.activityLineId.trim(),
        upstreamMessageId: mapping.upstreamMessageId.trim(),
      }))
      .filter((mapping) => mapping.activityLineId && mapping.upstreamMessageId);
    if (!threadId.trim() || normalized.length === 0) {
      return;
    }

    const hasV2Conversation = this.v2.hasConversation(threadId);
    const sourceEvents = hasV2Conversation ? this.listConversationRuntimeSources(threadId) : [];
    const hasNativeProviderSources = sourceEvents.some((event) =>
      normalized.some((mapping) => {
        const rewindTarget = event.metadata?.rewindTarget;
        const target =
          rewindTarget && typeof rewindTarget === "object" && !Array.isArray(rewindTarget)
            ? (rewindTarget as Record<string, unknown>)
            : {};
        return (
          event.id === mapping.activityLineId ||
          event.streamKey?.trim() === mapping.activityLineId ||
          target.activityLineId === mapping.activityLineId
        );
      }),
    );
    if (hasNativeProviderSources) {
      // V2 message reads use a short read transaction. Resolve the previous
      // upstream identities before opening the patch transaction; doing this
      // inside BEGIN IMMEDIATE would attempt a nested SQLite transaction on
      // V2-only databases.
      const recordsByActivityLineId = new Map(
        normalized.map((mapping) => [
          mapping.activityLineId,
          this.getUserMessageRecord(threadId, mapping.activityLineId),
        ]),
      );
      const patchResults: ConversationAppendResult[] = [];
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Only the explicit appendThreadRunEvent compatibility bridge is mirrored into
        // V1. Native runtime sources stay V2-only even when this rebind runs in the same
        // process as an older conversation.
        // A V2-only database has physically retired the V1 tables. The marker can
        // still be present in a provider receipt produced by an older adapter, but
        // it must never reopen the retired mirror path after cutover.
        const mirrorLegacy =
          !this.isV2OnlyStorage() && sourceEvents.some((event) => event.metadata?.legacyCompat === true);
        const updateActivity = mirrorLegacy
          ? this.db.prepare(
              `UPDATE thread_activity
               SET sdk_user_message_id = ?
               WHERE thread_id = ? AND id = ?`,
            )
          : undefined;
        const updateRecord = mirrorLegacy
          ? this.db.prepare(
              `UPDATE thread_user_messages
               SET upstream_message_id = ?, provider = 'claude', updated_at = ?
               WHERE thread_id = ? AND activity_line_id = ?`,
            )
          : undefined;
        const readLegacyEvent = mirrorLegacy
          ? this.db.prepare(`SELECT metadata_json FROM thread_run_events WHERE thread_id = ? AND id = ?`)
          : undefined;
        const updateLegacyEvent = mirrorLegacy
          ? this.db.prepare(`UPDATE thread_run_events SET metadata_json = ? WHERE thread_id = ? AND id = ?`)
          : undefined;
        const now = new Date().toISOString();

        for (const mapping of normalized) {
          const record = recordsByActivityLineId.get(mapping.activityLineId);
          const previousUpstreamMessageId = record?.upstreamMessageId?.trim();
          updateRecord?.run(mapping.upstreamMessageId, now, threadId, mapping.activityLineId);
          updateActivity?.run(mapping.upstreamMessageId, threadId, mapping.activityLineId);

          const matching = sourceEvents.filter((event) => {
            const rewindTarget = event.metadata?.rewindTarget;
            const target =
              rewindTarget && typeof rewindTarget === "object" && !Array.isArray(rewindTarget)
                ? (rewindTarget as Record<string, unknown>)
                : {};
            const targetActivityLineId =
              typeof target.activityLineId === "string" ? target.activityLineId.trim() : "";
            const targetUserMessageId =
              typeof target.userMessageId === "string" ? target.userMessageId.trim() : "";
            return (
              event.id === mapping.activityLineId ||
              event.streamKey?.trim() === mapping.activityLineId ||
              targetActivityLineId === mapping.activityLineId ||
              targetUserMessageId === previousUpstreamMessageId
            );
          });
          if (matching.length === 0) continue;

          const rewindTarget = {
            activityLineId: mapping.activityLineId,
            userMessageId: mapping.upstreamMessageId,
          };
          this.appendV2ProviderPatch(
            threadId,
            matching.map((event) => event.id),
            { metadataMerge: { rewindTarget } },
            `claude-rebind:${mapping.activityLineId}:${mapping.upstreamMessageId}`,
            {
              inCurrentTransaction: true,
              onAppendResult: (result) => patchResults.push(result),
            },
          );

          for (const event of matching) {
            const legacy = readLegacyEvent?.get(threadId, event.id) as
              | { metadata_json: string | null }
              | undefined;
            if (!legacy || !updateLegacyEvent) continue;
            const metadata = parseJsonRecord(legacy.metadata_json) ?? {};
            updateLegacyEvent.run(JSON.stringify({ ...metadata, rewindTarget }), threadId, event.id);
          }
        }
        this.db.exec("COMMIT");
        this.v2.publishCommitted(patchResults);
        this.invalidateThreadRunEventCaches(threadId);
      } catch (error) {
        rollbackConversationTransaction(this.db);
        throw error;
      }
      return;
    }

    if (this.isV2OnlyStorage() || (hasV2Conversation && sourceEvents.length > 0)) {
      return;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updateActivity = this.db.prepare(
        `UPDATE thread_activity
         SET sdk_user_message_id = ?
         WHERE thread_id = ? AND id = ?`,
      );
      const updateRecord = this.db.prepare(
        `UPDATE thread_user_messages
         SET upstream_message_id = ?, provider = 'claude', updated_at = ?
         WHERE thread_id = ? AND activity_line_id = ?`,
      );
      const eventRows = this.db
        .prepare(
          `SELECT id, stream_key, metadata_json
           FROM thread_run_events
           WHERE thread_id = ? AND metadata_json IS NOT NULL`,
        )
        .all(threadId) as Array<{ id: string; stream_key: string | null; metadata_json: string | null }>;
      const updateEvent = this.db.prepare(
        `UPDATE thread_run_events SET metadata_json = ? WHERE thread_id = ? AND id = ?`,
      );
      const now = new Date().toISOString();

      for (const mapping of normalized) {
        const record = this.getUserMessageRecord(threadId, mapping.activityLineId);
        const previousUpstreamMessageId = record?.upstreamMessageId?.trim();
        updateRecord.run(mapping.upstreamMessageId, now, threadId, mapping.activityLineId);
        updateActivity.run(mapping.upstreamMessageId, threadId, mapping.activityLineId);

        for (const row of eventRows) {
          const metadata = parseJsonRecord(row.metadata_json);
          const rewindTarget = metadata?.rewindTarget;
          const target =
            rewindTarget && typeof rewindTarget === "object" && !Array.isArray(rewindTarget)
              ? (rewindTarget as Record<string, unknown>)
              : {};
          const targetActivityLineId =
            typeof target.activityLineId === "string" ? target.activityLineId.trim() : "";
          const targetUserMessageId =
            typeof target.userMessageId === "string" ? target.userMessageId.trim() : "";
          if (
            row.id !== mapping.activityLineId &&
            row.stream_key?.trim() !== mapping.activityLineId &&
            targetActivityLineId !== mapping.activityLineId &&
            targetUserMessageId !== previousUpstreamMessageId
          ) {
            continue;
          }
          updateEvent.run(
            JSON.stringify({
              ...metadata,
              rewindTarget: {
                ...target,
                activityLineId: mapping.activityLineId,
                userMessageId: mapping.upstreamMessageId,
              },
            }),
            threadId,
            row.id,
          );
        }
      }
      this.db.exec("COMMIT");
      this.invalidateThreadRunEventCaches(threadId);
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  ensureClaudeUserMessageRecordsFromRunEvents(threadId: string): ThreadUserMessageRecord[] {
    if (!threadId.trim()) {
      return [];
    }
    const v2Events = this.v2.hasConversation(threadId) ? this.listConversationRuntimeSources(threadId) : [];
    const sourceEvents = v2Events.length > 0 ? v2Events : this.listThreadRunEvents(threadId);
    for (const event of sourceEvents) {
      if (event.role !== "user" || event.metadata?.liveType !== "thread.user_prompt") {
        continue;
      }
      const rewindTarget = event.metadata.rewindTarget;
      const rewindActivityLineId =
        rewindTarget && typeof rewindTarget === "object" && !Array.isArray(rewindTarget)
          ? typeof (rewindTarget as { activityLineId?: unknown }).activityLineId === "string"
            ? (rewindTarget as { activityLineId: string }).activityLineId.trim()
            : ""
          : "";
      const activityLineId = rewindActivityLineId || event.streamKey?.trim() || event.id;
      if (!activityLineId) {
        continue;
      }
      const existing = this.getUserMessageRecord(threadId, activityLineId);
      const attachments = existing
        ? undefined
        : readPromptImagePreviews(event.metadata).flatMap(({ mediaType, data }) =>
            data?.trim() ? [{ mediaType, data }] : [],
          );
      this.saveUserMessageRecord({
        threadId,
        activityLineId,
        text: event.message,
        ...(attachments && { attachments }),
        provider: "claude",
        createdAt: event.observedAt,
      });
    }
    return this.listUserMessageRecords(threadId).filter((record) => record.provider !== "codex");
  }

  listUserMessageRecords(threadId: string): ThreadUserMessageRecord[] {
    const native = this.listNativeUserMessageRecords(threadId);
    if (native) return native;
    if (this.isV2OnlyStorage()) {
      this.assertV2OnlyReadStream(threadId);
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT thread_id, activity_line_id, upstream_message_id, provider, text,
                attachments_json, created_at, updated_at
         FROM thread_user_messages
         WHERE thread_id = ?
         ORDER BY created_at ASC, activity_line_id ASC`,
      )
      .all(threadId) as Array<{
      thread_id: string;
      activity_line_id: string;
      upstream_message_id: string | null;
      provider: string | null;
      text: string;
      attachments_json: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      activityLineId: row.activity_line_id,
      ...(row.upstream_message_id?.trim() && { upstreamMessageId: row.upstream_message_id.trim() }),
      ...(isCoreKind(row.provider) && { provider: row.provider }),
      text: row.text,
      attachments: parsePromptImageAttachments(row.attachments_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Read user messages for a production conversation through the V2 message/effect
   * projection only. A missing stream is an integrity failure; returning a legacy
   * table result here would silently reintroduce the V1 source of truth.
   */
  listConversationUserMessageRecords(threadId: string): ThreadUserMessageRecord[] {
    const records = this.listNativeUserMessageRecords(threadId);
    if (records === undefined) {
      if (this.isV2OnlyStorage()) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 user-message stream is unavailable for ${threadId}.`,
        );
      }
      throw new Error(`Conversation V2 user-message stream is unavailable for ${threadId}.`);
    }
    return records;
  }

  getConversationUserMessageRecord(
    threadId: string,
    activityLineId: string,
  ): ThreadUserMessageRecord | undefined {
    const id = activityLineId.trim();
    if (!threadId.trim() || !id) return undefined;
    return this.listConversationUserMessageRecords(threadId).find(
      (record) =>
        record.activityLineId === id ||
        record.upstreamMessageId === id ||
        record.activityLineId === sdkActivityLineId(id),
    );
  }

  /**
   * Resolve user-message editing state from V2's message projection and provider-input
   * identity index. `undefined` means this is a pre-migration stream and the legacy table
   * remains the compatibility source; an empty array is a valid native V2 result.
   */
  private listNativeUserMessageRecords(threadId: string): ThreadUserMessageRecord[] | undefined {
    const id = threadId.trim();
    if (!id || !this.v2.hasConversation(id)) return undefined;
    const sources = this.listConversationRuntimeSources(id);
    if (sources.length === 0 && !this.isV2OnlyStorage()) return undefined;
    const messages = this.v2.listUserMessages(id);
    const provider = this.getThread(id)?.coreKind;
    return messages.map((message) => {
      const source = sources
        .filter((event) => sourceMessageId(event.metadata) === message.messageId)
        .sort((left, right) => right.sequence - left.sequence)[0];
      const rewindTarget = readRewindTarget(source?.metadata);
      const activityLineId =
        message.historyTarget?.activityLineId?.trim() ||
        rewindTarget?.activityLineId?.trim() ||
        source?.streamKey?.trim() ||
        `message:${message.messageId}`;
      const upstreamMessageId =
        message.historyTarget?.userMessageId?.trim() || rewindTarget?.userMessageId?.trim();
      const occurredAt = message.occurredAt ?? source?.observedAt ?? new Date().toISOString();
      return {
        threadId: id,
        activityLineId,
        ...(upstreamMessageId ? { upstreamMessageId } : {}),
        ...(provider ? { provider } : {}),
        text: message.body,
        attachments: parsePromptImageAttachmentsValue(message.attachments),
        createdAt: occurredAt,
        updatedAt: occurredAt,
      } satisfies ThreadUserMessageRecord;
    });
  }

  private hasNativeProviderInputs(threadId: string): boolean {
    return this.v2.hasConversation(threadId) && this.listConversationRuntimeSources(threadId).length > 0;
  }

  bindLatestUserActivityToSdkMessage(
    threadId: string,
    userMessageId: string,
  ): ThreadActivityLine | undefined {
    const id = userMessageId.trim();
    if (!threadId.trim() || !id) {
      return undefined;
    }

    const hasV2Conversation = this.v2.hasConversation(threadId);
    const nativeSources = hasV2Conversation ? this.listConversationRuntimeSources(threadId) : [];
    if (nativeSources.length > 0) {
      const prompt = nativeSources
        .filter(
          (event) =>
            event.role === "user" &&
            event.metadata?.liveType === "thread.user_prompt" &&
            !readRewindTarget(event.metadata)?.userMessageId,
        )
        .sort((left, right) => right.sequence - left.sequence)[0];
      if (!prompt) return undefined;
      const rewindTarget = {
        activityLineId:
          readRewindTarget(prompt.metadata)?.activityLineId || prompt.streamKey?.trim() || prompt.id,
        userMessageId: id,
      };
      this.appendV2ProviderPatch(
        threadId,
        [prompt.id],
        { metadataMerge: { rewindTarget } },
        `claude-bind:${rewindTarget.activityLineId}:${id}`,
      );
      this.invalidateThreadRunEventCaches(threadId);
      const record = this.getUserMessageRecord(threadId, rewindTarget.activityLineId);
      return {
        id: rewindTarget.activityLineId,
        role: "user",
        message: record?.text ?? prompt.message,
        rewindTarget,
      };
    }

    if (this.isV2OnlyStorage()) {
      this.assertV2OnlyReadStream(threadId);
      return undefined;
    }
    if (hasV2Conversation && nativeSources.length > 0) {
      return undefined;
    }

    const existing = this.db
      .prepare(
        `SELECT id, thread_id, role, message, stream, agent_id, api_error_json, sdk_user_message_id, created_at
         FROM thread_activity
         WHERE thread_id = ? AND sdk_user_message_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(threadId, id) as ActivityRow | undefined;
    if (existing) {
      this.bindRunEventRewindTarget(threadId, existing.id, id);
      this.saveUserMessageRecord({
        threadId,
        activityLineId: existing.id,
        text: existing.message,
        upstreamMessageId: id,
        provider: "claude",
        createdAt: existing.created_at,
      });
      return activityRowToThreadActivityLine(existing);
    }

    const row = this.db
      .prepare(
        `SELECT id, thread_id, role, message, stream, agent_id, api_error_json, sdk_user_message_id, created_at
         FROM thread_activity
         WHERE thread_id = ? AND role = 'user' AND sdk_user_message_id IS NULL
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(threadId) as ActivityRow | undefined;
    if (!row) {
      const pending = this.db
        .prepare(
          `SELECT activity_line_id, text, created_at
           FROM thread_user_messages
           WHERE thread_id = ?
             AND upstream_message_id IS NULL
             AND (provider = 'claude' OR provider IS NULL)
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`,
        )
        .get(threadId) as { activity_line_id: string; text: string; created_at: string } | undefined;
      if (!pending) {
        return undefined;
      }
      this.updateUserMessageUpstream(threadId, pending.activity_line_id, id, "claude");
      this.bindRunEventRewindTarget(threadId, pending.activity_line_id, id);
      return {
        id: pending.activity_line_id,
        role: "user",
        message: pending.text,
        rewindTarget: { activityLineId: pending.activity_line_id, userMessageId: id },
      };
    }

    this.db
      .prepare(`UPDATE thread_activity SET sdk_user_message_id = ? WHERE thread_id = ? AND id = ?`)
      .run(id, threadId, row.id);
    this.bindRunEventRewindTarget(threadId, row.id, id);
    this.saveUserMessageRecord({
      threadId,
      activityLineId: row.id,
      text: row.message,
      upstreamMessageId: id,
      provider: "claude",
      createdAt: row.created_at,
    });
    return activityRowToThreadActivityLine({ ...row, sdk_user_message_id: id });
  }

  bindLatestUserRunEventToSdkMessage(
    threadId: string,
    userMessageId: string,
  ): ThreadActivityLine | undefined {
    const id = userMessageId.trim();
    if (!threadId.trim() || !id) {
      return undefined;
    }

    const activityLineId = sdkActivityLineId(id);
    const rewindTarget = { activityLineId, userMessageId: id };
    const hasV2Conversation = this.v2.hasConversation(threadId);
    if (this.isV2OnlyStorage() && !hasV2Conversation) {
      this.assertV2OnlyReadStream(threadId);
      return undefined;
    }
    const pendingLocal = hasV2Conversation
      ? undefined
      : (this.db
          .prepare(
            `SELECT activity_line_id, text, attachments_json, created_at
             FROM thread_user_messages
             WHERE thread_id = ? AND provider = 'codex' AND upstream_message_id IS NULL
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1`,
          )
          .get(threadId) as
          | { activity_line_id: string; text: string; attachments_json: string | null; created_at: string }
          | undefined);

    const sourceEvents = hasV2Conversation ? this.listConversationRuntimeSources(threadId) : [];
    const isUnboundCodexPrompt = (event: ThreadRunEvent): boolean => {
      if (event.role !== "user" || event.eventType !== "thread.status") return false;
      if (event.metadata?.liveType !== "thread.user_prompt") return false;
      const rewindTarget = readRewindTarget(event.metadata);
      const activityLineId = rewindTarget?.activityLineId?.trim() ?? "";
      return activityLineId.startsWith("codex-pending:") && !rewindTarget?.userMessageId;
    };
    const hasNativeProviderSource = sourceEvents.some(
      (event) =>
        event.streamKey === activityLineId ||
        (event.role === "user" && event.eventType === "thread.status" && !event.streamKey?.trim()) ||
        isUnboundCodexPrompt(event),
    );
    if (hasNativeProviderSource) {
      const existing = sourceEvents
        .filter((event) => event.streamKey === activityLineId)
        .sort((left, right) => right.sequence - left.sequence)[0];
      if (existing) {
        this.saveUserMessageRecord({
          threadId,
          activityLineId,
          text: pendingLocal?.text ?? existing.message,
          attachments: pendingLocal
            ? parsePromptImageAttachments(pendingLocal.attachments_json)
            : readPromptImagePreviews(existing.metadata).flatMap(({ mediaType, data }) =>
                data?.trim() ? [{ mediaType, data }] : [],
              ),
          upstreamMessageId: id,
          provider: "codex",
          ...(pendingLocal?.created_at ? { createdAt: pendingLocal.created_at } : {}),
        });
        if (pendingLocal && pendingLocal.activity_line_id !== activityLineId) {
          void this.promptImageFileStore?.deleteMessageActivity(threadId, pendingLocal.activity_line_id);
          this.db
            .prepare(
              `DELETE FROM thread_user_messages
               WHERE thread_id = ? AND activity_line_id = ?`,
            )
            .run(threadId, pendingLocal.activity_line_id);
        }
        return {
          id: activityLineId,
          role: "user",
          message: existing.message,
          rewindTarget,
        };
      }

      const row = [...sourceEvents]
        .reverse()
        .find(
          (event) =>
            (event.role === "user" && event.eventType === "thread.status" && !event.streamKey?.trim()) ||
            isUnboundCodexPrompt(event),
        );
      if (!row) {
        return undefined;
      }

      const patchResults: ConversationAppendResult[] = [];
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.appendV2ProviderPatch(
          threadId,
          [row.id],
          { streamKey: activityLineId, metadataMerge: { rewindTarget } },
          `codex-bind:${activityLineId}:${id}`,
          {
            inCurrentTransaction: true,
            onAppendResult: (result) => patchResults.push(result),
          },
        );
        // Keep a pre-existing legacy bridge row coherent for compatibility. Native
        // runtime sources have no V1 write here; the V2 patch above is authoritative.
        if (!this.isV2OnlyStorage() && row.metadata?.legacyCompat === true) {
          const legacy = this.db
            .prepare(`SELECT metadata_json FROM thread_run_events WHERE thread_id = ? AND id = ?`)
            .get(threadId, row.id) as { metadata_json: string | null } | undefined;
          if (legacy) {
            this.db
              .prepare(
                `UPDATE thread_run_events
                 SET stream_key = ?, metadata_json = ?
                 WHERE thread_id = ? AND id = ?`,
              )
              .run(
                activityLineId,
                JSON.stringify({ ...(parseJsonRecord(legacy.metadata_json) ?? {}), rewindTarget }),
                threadId,
                row.id,
              );
          }
        }
        this.db.exec("COMMIT");
        this.v2.publishCommitted(patchResults);
      } catch (error) {
        rollbackConversationTransaction(this.db);
        throw error;
      }
      this.invalidateThreadRunEventCaches(threadId);
      this.saveUserMessageRecord({
        threadId,
        activityLineId,
        text: pendingLocal?.text ?? row.message,
        attachments: pendingLocal
          ? parsePromptImageAttachments(pendingLocal.attachments_json)
          : readPromptImagePreviews(row.metadata).flatMap(({ mediaType, data }) =>
              data?.trim() ? [{ mediaType, data }] : [],
            ),
        upstreamMessageId: id,
        provider: "codex",
        ...(pendingLocal?.created_at ? { createdAt: pendingLocal.created_at } : {}),
      });
      if (pendingLocal && pendingLocal.activity_line_id !== activityLineId) {
        void this.promptImageFileStore?.deleteMessageActivity(threadId, pendingLocal.activity_line_id);
        this.db
          .prepare(
            `DELETE FROM thread_user_messages
             WHERE thread_id = ? AND activity_line_id = ?`,
          )
          .run(threadId, pendingLocal.activity_line_id);
      }
      return {
        id: activityLineId,
        role: "user",
        message: row.message,
        rewindTarget,
      };
    }

    if (this.isV2OnlyStorage()) {
      this.assertV2OnlyReadStream(threadId);
      return undefined;
    }
    if (hasV2Conversation && sourceEvents.length > 0) {
      return undefined;
    }

    const existing = this.db
      .prepare(
        `SELECT message, metadata_json
         FROM thread_run_events
         WHERE thread_id = ? AND stream_key = ?
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(threadId, activityLineId) as { message: string; metadata_json: string | null } | undefined;
    if (existing) {
      this.saveUserMessageRecord({
        threadId,
        activityLineId,
        text: pendingLocal?.text ?? existing.message,
        attachments: pendingLocal
          ? parsePromptImageAttachments(pendingLocal.attachments_json)
          : readPromptImagePreviews(parseJsonRecord(existing.metadata_json)).flatMap(({ mediaType, data }) =>
              data?.trim() ? [{ mediaType, data }] : [],
            ),
        upstreamMessageId: id,
        provider: "codex",
        ...(pendingLocal?.created_at ? { createdAt: pendingLocal.created_at } : {}),
      });
      if (pendingLocal && pendingLocal.activity_line_id !== activityLineId) {
        void this.promptImageFileStore?.deleteMessageActivity(threadId, pendingLocal.activity_line_id);
        this.db
          .prepare(
            `DELETE FROM thread_user_messages
             WHERE thread_id = ? AND activity_line_id = ?`,
          )
          .run(threadId, pendingLocal.activity_line_id);
      }
      return {
        id: activityLineId,
        role: "user",
        message: existing.message,
        rewindTarget,
      };
    }

    const row = this.db
      .prepare(
        `SELECT id, message, metadata_json
         FROM thread_run_events
         WHERE thread_id = ?
           AND role = 'user'
           AND event_type = 'thread.status'
           AND (stream_key IS NULL OR stream_key = '')
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(threadId) as { id: string; message: string; metadata_json: string | null } | undefined;

    if (!row) {
      return undefined;
    }

    this.db
      .prepare(
        `UPDATE thread_run_events
         SET stream_key = ?, metadata_json = ?
         WHERE thread_id = ? AND id = ?`,
      )
      .run(
        activityLineId,
        JSON.stringify({
          ...(parseJsonRecord(row.metadata_json) ?? {}),
          rewindTarget,
        }),
        threadId,
        row.id,
      );
    this.invalidateThreadRunEventCaches(threadId);
    this.saveUserMessageRecord({
      threadId,
      activityLineId,
      text: pendingLocal?.text ?? row.message,
      attachments: pendingLocal
        ? parsePromptImageAttachments(pendingLocal.attachments_json)
        : readPromptImagePreviews(parseJsonRecord(row.metadata_json)).flatMap(({ mediaType, data }) =>
            data?.trim() ? [{ mediaType, data }] : [],
          ),
      upstreamMessageId: id,
      provider: "codex",
      ...(pendingLocal?.created_at ? { createdAt: pendingLocal.created_at } : {}),
    });
    if (pendingLocal && pendingLocal.activity_line_id !== activityLineId) {
      void this.promptImageFileStore?.deleteMessageActivity(threadId, pendingLocal.activity_line_id);
      this.db
        .prepare(
          `DELETE FROM thread_user_messages
           WHERE thread_id = ? AND activity_line_id = ?`,
        )
        .run(threadId, pendingLocal.activity_line_id);
    }
    return {
      id: activityLineId,
      role: "user",
      message: row.message,
      rewindTarget,
    };
  }

  getActivityRewindTarget(
    threadId: string,
    activityLineId: string,
  ): ThreadActivityLine["rewindTarget"] | undefined {
    const rawActivityLineId = activityLineId.trim();
    this.assertV2OnlyReadStream(threadId);
    const stored =
      this.getUserMessageRecord(threadId, rawActivityLineId) ??
      (!rawActivityLineId.startsWith("sdk:")
        ? this.getUserMessageRecord(threadId, sdkActivityLineId(rawActivityLineId))
        : undefined);
    if (stored?.upstreamMessageId) {
      return {
        activityLineId: stored.activityLineId,
        userMessageId: stored.upstreamMessageId,
      };
    }
    if (this.v2.hasConversation(threadId)) {
      const native = this.getConversationUserMessageRecord(threadId, rawActivityLineId);
      if (native?.upstreamMessageId) {
        return {
          activityLineId: native.activityLineId,
          userMessageId: native.upstreamMessageId,
        };
      }
      if (this.isV2OnlyStorage() || this.hasNativeProviderInputs(threadId)) {
        return undefined;
      }
    }
    const sdkUserMessageId = sdkMessageUuidFromActivityLineId(activityLineId);
    if (sdkUserMessageId) {
      return { activityLineId: sdkActivityLineId(sdkUserMessageId), userMessageId: sdkUserMessageId };
    }
    const row = this.db
      .prepare(
        `SELECT id, role, sdk_user_message_id
         FROM thread_activity
         WHERE thread_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(threadId, activityLineId) as
      | { id: string; role: string; sdk_user_message_id: string | null }
      | undefined;
    const userMessageId = row?.sdk_user_message_id?.trim();
    if (!row || row.role !== "user" || !userMessageId) {
      return undefined;
    }
    return { activityLineId: row.id, userMessageId };
  }

  getUserMessageForEdit(threadId: string, activityLineId: string): ThreadUserMessageRecord | undefined {
    const id = activityLineId.trim();
    if (!threadId.trim() || !id) return undefined;
    this.assertV2OnlyReadStream(threadId);
    const stored =
      this.getUserMessageRecord(threadId, id) ??
      (!id.startsWith("sdk:") ? this.getUserMessageRecord(threadId, sdkActivityLineId(id)) : undefined);
    if (stored) return stored;
    if (this.isV2OnlyStorage() || this.hasNativeProviderInputs(threadId)) return undefined;

    const activity = this.db
      .prepare(
        `SELECT id, role, message, sdk_user_message_id, created_at
         FROM thread_activity
         WHERE thread_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(threadId, id) as
      | { id: string; role: string; message: string; sdk_user_message_id: string | null; created_at: string }
      | undefined;
    if (activity?.role === "user") {
      const record = {
        threadId,
        activityLineId: activity.id,
        ...(activity.sdk_user_message_id?.trim() && {
          upstreamMessageId: activity.sdk_user_message_id.trim(),
        }),
        text: activity.message,
        attachments: [],
        ...(activity.sdk_user_message_id ? { provider: "claude" as const } : {}),
        createdAt: activity.created_at,
        updatedAt: activity.created_at,
      } satisfies ThreadUserMessageRecord;
      this.saveUserMessageRecord(record);
      return record;
    }

    // Codex user prompts are stored as thread.status (liveType: thread.user_prompt), not message.final.
    const rows = this.db
      .prepare(
        `SELECT id, event_type, message, metadata_json, stream_key, observed_at
         FROM thread_run_events
         WHERE thread_id = ?
           AND role = 'user'
           AND event_type IN ('message.final', 'thread.status')
         ORDER BY sequence ASC`,
      )
      .all(threadId) as Array<{
      id: string;
      event_type: string;
      message: string;
      metadata_json: string | null;
      stream_key: string | null;
      observed_at: string;
    }>;
    for (const row of rows) {
      const metadata = parseJsonRecord(row.metadata_json);
      if (row.event_type === "thread.status") {
        const liveType = typeof metadata?.liveType === "string" ? metadata.liveType : "";
        if (liveType && liveType !== "thread.user_prompt" && liveType !== "message.user") {
          continue;
        }
      }
      const rewind = metadata?.rewindTarget;
      const targetId =
        (rewind &&
        typeof rewind === "object" &&
        typeof (rewind as { activityLineId?: unknown }).activityLineId === "string"
          ? (rewind as { activityLineId: string }).activityLineId.trim()
          : "") || row.stream_key?.trim();
      const canonicalTargetId =
        targetId && targetId.startsWith("sdk:") ? targetId : targetId ? sdkActivityLineId(targetId) : "";
      const matchesRunEventId = row.id === id;
      if (
        !matchesRunEventId &&
        (!canonicalTargetId || (canonicalTargetId !== id && canonicalTargetId !== sdkActivityLineId(id)))
      ) {
        continue;
      }
      const rewindUpstream =
        rewind &&
        typeof rewind === "object" &&
        typeof (rewind as { userMessageId?: unknown }).userMessageId === "string"
          ? (rewind as { userMessageId: string }).userMessageId.trim()
          : "";
      const streamUuid = sdkMessageUuidFromActivityLineId(targetId ?? "");
      const upstream =
        rewindUpstream || streamUuid || (targetId && !targetId.startsWith("sdk:") ? targetId : "");
      const pendingCodex = this.getLatestCodexPendingUserMessageRow(threadId);
      const pendingAttachments = pendingCodex
        ? parsePromptImageAttachments(pendingCodex.attachments_json)
        : [];
      const pendingMatchesPrompt =
        pendingCodex && pendingCodex.text.trim() === row.message.trim() && pendingAttachments.length > 0;
      const attachments = pendingMatchesPrompt
        ? pendingAttachments
        : readPromptImagePreviews(metadata).flatMap(({ mediaType, data }) =>
            data?.trim() ? [{ mediaType, data }] : [],
          );
      const resolvedActivityLineId =
        pendingMatchesPrompt && pendingCodex
          ? pendingCodex.activity_line_id
          : canonicalTargetId || targetId || row.id;
      const record: ThreadUserMessageRecord = {
        threadId,
        activityLineId: resolvedActivityLineId,
        ...(upstream && { upstreamMessageId: upstream }),
        provider: "codex",
        text: row.message,
        attachments,
        createdAt: row.observed_at,
        updatedAt: row.observed_at,
      };
      this.saveUserMessageRecord(record);
      return record;
    }
    return undefined;
  }

  private rewriteV2OnlyHistory(
    threadId: string,
    activityLineId: string,
    type: "history.edited" | "history.deleted",
    command?: ThreadHistoryCommandContext,
  ): ThreadActivityRewindSummary {
    const id = activityLineId.trim();
    const conversationId = threadId.trim();
    if (!conversationId || !id || !this.v2.hasConversation(conversationId)) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        "V2 history rewrite requires an existing conversation and activity identity.",
      );
    }
    const sources = this.listConversationRuntimeSources(conversationId, { historyOrder: true });
    const source = sources
      .filter((event) => {
        const rewindTarget = readRewindTarget(event.metadata);
        return (
          event.id === id ||
          event.streamKey?.trim() === id ||
          rewindTarget?.activityLineId === id ||
          rewindTarget?.userMessageId === id
        );
      })
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))[0];
    const message = this.v2
      .listUserMessages(conversationId)
      .find((candidate) => candidate.messageId === id || `message:${candidate.messageId}` === id);
    const record = this.getUserMessageForEdit(conversationId, id);
    const boundarySequence = source?.sequence ?? message?.createdSeq ?? 0;
    if (!source && !message) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        "V2 history rewrite target is not present in the conversation log.",
      );
    }
    const sourceRewindTarget = readRewindTarget(source?.metadata);
    const userMessageId =
      record?.upstreamMessageId?.trim() ||
      sourceRewindTarget?.userMessageId?.trim() ||
      sdkMessageUuidFromActivityLineId(id) ||
      message?.messageId ||
      "";
    const cutoffCreatedAt = source?.observedAt ?? message?.occurredAt ?? new Date().toISOString();
    const affectedMessageIds =
      message && boundarySequence === message.createdSeq && sources.length === 0
        ? [message.messageId]
        : this.listV2MessageIdsFromHistorySequence(conversationId, boundarySequence);
    const affectedProviderInputIds =
      boundarySequence > 0
        ? sources.filter((event) => event.sequence >= boundarySequence).map((event) => event.id)
        : [];
    const sourceKey = `v2-only-history:${type}:${stableHash(`${conversationId}:${id}:${boundarySequence}`)}`;
    const eventId = `history_v2_${type === "history.deleted" ? "delete" : "edit"}_${stableHash(sourceKey)}`;
    const summary: ThreadActivityRewindSummary = {
      activityLineId: id,
      userMessageId,
      cutoffCreatedAt,
      cutoffRunSequence: boundarySequence,
      removedActivityCount: 0,
      removedRunEventCount: 0,
    };

    this.db.exec("BEGIN IMMEDIATE");
    const results: ConversationAppendResult[] = [];
    try {
      this.deleteUsageLedgerEventsFromCurrentTransaction(conversationId, cutoffCreatedAt);
      if (this.isV2OnlyStorage()) {
        this.v2.clearPendingPlan(conversationId, { inCurrentTransaction: true });
      } else {
        this.db.prepare(`DELETE FROM thread_pending_plans WHERE thread_id = ?`).run(conversationId);
      }
      this.db
        .prepare(`DELETE FROM ${this.pendingFollowupsTable()} WHERE thread_id = ? AND created_at >= ?`)
        .run(conversationId, cutoffCreatedAt);
      this.clearConversationV2ProjectionExtrasInCurrentTransaction(conversationId);
      this.db
        .prepare(`DELETE FROM thread_compaction_archives WHERE thread_id = ? AND created_at >= ?`)
        .run(conversationId, cutoffCreatedAt);
      this.db
        .prepare(`DELETE FROM thread_applied_diffs WHERE thread_id = ? AND applied_at >= ?`)
        .run(conversationId, cutoffCreatedAt);
      results.push(
        this.v2.appendInCurrentTransaction({
          conversationId,
          eventId: `todo_v2_${stableHash(`${sourceKey}:todos`)}`,
          sourceEventKey: `${sourceKey}:todos`,
          type: "todo.updated",
          occurredAt: new Date().toISOString(),
          payload: { todos: [] },
        }),
      );
      results.push(
        ...this.v2.appendHistoryRewriteInCurrentTransaction({
          conversationId,
          eventId,
          sourceEventKey: sourceKey,
          occurredAt: new Date().toISOString(),
          type,
          affectedMessageIds,
          affectedProviderInputIds,
          reason: type === "history.deleted" ? "v2-only-discard" : "v2-only-rewind",
        }),
      );
      this.db
        .prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), conversationId);
      if (command) {
        this.v2.recordCommandCheckpointInCurrentTransaction({
          principalId: command.principalId,
          conversationId,
          clientCommandId: command.clientCommandId,
          name: "history.local_rewrite_committed",
          payload: {
            activityLineId: id,
            cutoffRunSequence: boundarySequence,
            removedActivityCount: 0,
            removedRunEventCount: 0,
            historyRevision: this.v2.head(conversationId).historyRevision,
          },
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    this.invalidateThreadRunEventCaches(conversationId);
    this.v2.publishCommitted(results);
    return summary;
  }

  rewindThreadToActivityLine(
    threadId: string,
    activityLineId: string,
    command?: ThreadHistoryCommandContext,
  ): ThreadActivityRewindSummary {
    if (this.isV2OnlyStorage()) {
      return this.rewriteV2OnlyHistory(threadId, activityLineId, "history.edited", command);
    }
    const sdkUserMessageId = sdkMessageUuidFromActivityLineId(activityLineId);
    if (sdkUserMessageId) {
      return this.rewindThreadToSdkActivityLine(threadId, activityLineId, sdkUserMessageId, command);
    }

    const target = this.db
      .prepare(
        `SELECT rowid AS row_id, id, thread_id, role, message, stream, agent_id, api_error_json,
                sdk_user_message_id, created_at
         FROM thread_activity
         WHERE thread_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(threadId, activityLineId) as (ActivityRow & { row_id: number }) | undefined;
    const userMessageId = target?.sdk_user_message_id?.trim();
    // Claude projection-only prompts use local `user:<uuid>` stream keys and live in
    // thread_user_messages / thread_run_events; they never row into thread_activity.
    if (!target || target.role !== "user" || !userMessageId) {
      const projectionTarget = this.getActivityRewindTarget(threadId, activityLineId);
      const projectionUserMessageId = projectionTarget?.userMessageId?.trim();
      if (projectionTarget && projectionUserMessageId) {
        return this.rewindThreadToSdkActivityLine(
          threadId,
          projectionTarget.activityLineId,
          projectionUserMessageId,
          command,
        );
      }
      throw new Error("该节点缺少 SDK 检查点，无法安全回滚。");
    }

    const indexedRuntimeSources = this.v2.hasConversation(threadId)
      ? this.listConversationRuntimeSources(threadId)
      : [];
    const hasNativeProviderSources = indexedRuntimeSources.length > 0;
    const runtimeSources = hasNativeProviderSources
      ? indexedRuntimeSources
      : this.listThreadRunEvents(threadId);
    const runBoundaryEvent = runtimeSources
      .filter((event) => event.streamKey === activityLineId)
      .sort((left, right) => left.sequence - right.sequence)[0];
    const runBoundary = runBoundaryEvent ? { sequence: runBoundaryEvent.sequence } : undefined;
    if (!runBoundary) {
      throw new Error("该节点缺少运行事件索引，无法安全回滚。");
    }

    const cutoffCreatedAt = target.created_at;
    const cutoffRunSequence = runBoundary.sequence;
    const deleteChanges = (sql: string, ...args: (string | number | null)[]): number =>
      (this.db.prepare(sql).run(...args) as { changes?: number }).changes ?? 0;

    this.db.exec("BEGIN IMMEDIATE");
    const v2Results: ConversationAppendResult[] = [];
    try {
      const affectedMessageIds = this.listLegacyV2MessageIdsFromRunEvents(threadId, cutoffRunSequence);
      deleteChanges(
        `DELETE FROM thread_user_messages
         WHERE thread_id = ? AND created_at >= ?`,
        threadId,
        cutoffCreatedAt,
      );
      const removedRunEventCount = hasNativeProviderSources
        ? 0
        : deleteChanges(
            `DELETE FROM thread_run_events WHERE thread_id = ? AND sequence >= ?`,
            threadId,
            cutoffRunSequence,
          );
      const removedActivityCount = deleteChanges(
        `DELETE FROM thread_activity WHERE thread_id = ? AND rowid >= ?`,
        threadId,
        target.row_id,
      );
      this.deleteUsageLedgerEventsFromCurrentTransaction(threadId, cutoffCreatedAt);
      if (this.tableExists("thread_subagent_sessions")) {
        deleteChanges(
          `DELETE FROM thread_subagent_sessions
           WHERE thread_id = ?
             AND (started_at >= ? OR last_active_at >= ? OR updated_at >= ? OR COALESCE(ended_at, updated_at) >= ?)`,
          threadId,
          cutoffCreatedAt,
          cutoffCreatedAt,
          cutoffCreatedAt,
          cutoffCreatedAt,
        );
      }
      if (this.tableExists("thread_subagent_metrics")) {
        deleteChanges(
          `DELETE FROM thread_subagent_metrics WHERE thread_id = ? AND updated_at >= ?`,
          threadId,
          cutoffCreatedAt,
        );
      }
      if (this.isV2OnlyStorage()) {
        this.v2.clearPendingPlan(threadId, { inCurrentTransaction: true });
      } else {
        deleteChanges(`DELETE FROM thread_pending_plans WHERE thread_id = ?`, threadId);
      }
      deleteChanges(
        `DELETE FROM ${this.pendingFollowupsTable()} WHERE thread_id = ? AND created_at >= ?`,
        threadId,
        cutoffCreatedAt,
      );
      const todoResetIdentity = crypto.randomUUID();
      v2Results.push(
        this.v2.appendInCurrentTransaction({
          conversationId: threadId,
          eventId: `todo_v2_${todoResetIdentity}`,
          sourceEventKey: `todo:rewind:${threadId}:${todoResetIdentity}`,
          type: "todo.updated",
          occurredAt: new Date().toISOString(),
          payload: { todos: [] },
        }),
      );
      if (this.tableExists("thread_metrics_snapshots")) {
        deleteChanges(`DELETE FROM thread_metrics_snapshots WHERE thread_id = ?`, threadId);
      }
      this.clearConversationV2ProjectionExtrasInCurrentTransaction(threadId);
      deleteChanges(
        `DELETE FROM thread_compaction_archives WHERE thread_id = ? AND created_at >= ?`,
        threadId,
        cutoffCreatedAt,
      );
      deleteChanges(
        `DELETE FROM thread_applied_diffs WHERE thread_id = ? AND applied_at >= ?`,
        threadId,
        cutoffCreatedAt,
      );
      this.db
        .prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), threadId);
      v2Results.push(
        ...this.v2.appendHistoryRewriteInCurrentTransaction({
          conversationId: threadId,
          eventId: `history_v2_edit_${stableHash(`${threadId}:${activityLineId}:${cutoffRunSequence}`)}`,
          sourceEventKey: `legacy-history:edited:${threadId}:${activityLineId}:${cutoffRunSequence}`,
          occurredAt: new Date().toISOString(),
          type: "history.edited",
          affectedMessageIds,
          affectedProviderInputIds: this.listRuntimeSourceIdsFromSequence(threadId, cutoffRunSequence),
          reason: "legacy-rewind",
        }),
      );
      if (command) {
        this.v2.recordCommandCheckpointInCurrentTransaction({
          principalId: command.principalId,
          conversationId: threadId,
          clientCommandId: command.clientCommandId,
          name: "history.local_rewrite_committed",
          payload: {
            activityLineId,
            cutoffRunSequence,
            removedActivityCount,
            removedRunEventCount,
            historyRevision: this.v2.head(threadId).historyRevision,
          },
        });
      }
      this.db.exec("COMMIT");
      this.invalidateThreadRunEventCaches(threadId);
      this.v2.publishCommitted(v2Results);
      return {
        activityLineId,
        userMessageId,
        cutoffCreatedAt,
        cutoffRunSequence,
        removedActivityCount,
        removedRunEventCount,
      };
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  private rewindThreadToSdkActivityLine(
    threadId: string,
    activityLineId: string,
    userMessageId: string,
    command?: ThreadHistoryCommandContext,
  ): ThreadActivityRewindSummary {
    const indexedRuntimeSources = this.v2.hasConversation(threadId)
      ? this.listConversationRuntimeSources(threadId)
      : [];
    const hasNativeProviderSources = indexedRuntimeSources.length > 0;
    const runtimeSources = hasNativeProviderSources
      ? indexedRuntimeSources
      : this.listThreadRunEvents(threadId);
    const runBoundaryEvent = runtimeSources
      .filter((event) => event.streamKey === activityLineId)
      .sort((left, right) => left.sequence - right.sequence)[0];
    const runBoundary = runBoundaryEvent
      ? { sequence: runBoundaryEvent.sequence, observed_at: runBoundaryEvent.observedAt }
      : undefined;
    if (!runBoundary) {
      throw new Error("该节点缺少运行事件索引，无法安全回滚。");
    }

    const cutoffCreatedAt = runBoundary.observed_at;
    const cutoffRunSequence = runBoundary.sequence;
    const deleteChanges = (sql: string, ...args: (string | number | null)[]): number =>
      (this.db.prepare(sql).run(...args) as { changes?: number }).changes ?? 0;

    this.db.exec("BEGIN IMMEDIATE");
    const v2Results: ConversationAppendResult[] = [];
    try {
      const affectedMessageIds = this.listLegacyV2MessageIdsFromRunEvents(threadId, cutoffRunSequence);
      deleteChanges(
        `DELETE FROM thread_user_messages
         WHERE thread_id = ?
           AND (activity_line_id = ? OR upstream_message_id = ? OR created_at >= ?)`,
        threadId,
        activityLineId,
        userMessageId,
        cutoffCreatedAt,
      );
      const removedRunEventCount = hasNativeProviderSources
        ? 0
        : deleteChanges(
            `DELETE FROM thread_run_events WHERE thread_id = ? AND sequence >= ?`,
            threadId,
            cutoffRunSequence,
          );
      this.deleteUsageLedgerEventsFromCurrentTransaction(threadId, cutoffCreatedAt);
      if (this.tableExists("thread_subagent_sessions")) {
        deleteChanges(
          `DELETE FROM thread_subagent_sessions
           WHERE thread_id = ?
             AND (started_at >= ? OR last_active_at >= ? OR updated_at >= ? OR COALESCE(ended_at, updated_at) >= ?)`,
          threadId,
          cutoffCreatedAt,
          cutoffCreatedAt,
          cutoffCreatedAt,
          cutoffCreatedAt,
        );
      }
      if (this.tableExists("thread_subagent_metrics")) {
        deleteChanges(
          `DELETE FROM thread_subagent_metrics WHERE thread_id = ? AND updated_at >= ?`,
          threadId,
          cutoffCreatedAt,
        );
      }
      if (this.isV2OnlyStorage()) {
        this.v2.clearPendingPlan(threadId, { inCurrentTransaction: true });
      } else {
        deleteChanges(`DELETE FROM thread_pending_plans WHERE thread_id = ?`, threadId);
      }
      deleteChanges(
        `DELETE FROM ${this.pendingFollowupsTable()} WHERE thread_id = ? AND created_at >= ?`,
        threadId,
        cutoffCreatedAt,
      );
      const todoResetIdentity = crypto.randomUUID();
      v2Results.push(
        this.v2.appendInCurrentTransaction({
          conversationId: threadId,
          eventId: `todo_v2_${todoResetIdentity}`,
          sourceEventKey: `todo:rewind:${threadId}:${todoResetIdentity}`,
          type: "todo.updated",
          occurredAt: new Date().toISOString(),
          payload: { todos: [] },
        }),
      );
      if (this.tableExists("thread_metrics_snapshots")) {
        deleteChanges(`DELETE FROM thread_metrics_snapshots WHERE thread_id = ?`, threadId);
      }
      this.clearConversationV2ProjectionExtrasInCurrentTransaction(threadId);
      deleteChanges(
        `DELETE FROM thread_compaction_archives WHERE thread_id = ? AND created_at >= ?`,
        threadId,
        cutoffCreatedAt,
      );
      deleteChanges(
        `DELETE FROM thread_applied_diffs WHERE thread_id = ? AND applied_at >= ?`,
        threadId,
        cutoffCreatedAt,
      );
      this.db
        .prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), threadId);
      v2Results.push(
        ...this.v2.appendHistoryRewriteInCurrentTransaction({
          conversationId: threadId,
          eventId: `history_v2_edit_${stableHash(`${threadId}:${activityLineId}:${cutoffRunSequence}`)}`,
          sourceEventKey: `legacy-history:edited:${threadId}:${activityLineId}:${cutoffRunSequence}`,
          occurredAt: new Date().toISOString(),
          type: "history.edited",
          affectedMessageIds,
          affectedProviderInputIds: this.listRuntimeSourceIdsFromSequence(threadId, cutoffRunSequence),
          reason: "legacy-rewind",
        }),
      );
      if (command) {
        this.v2.recordCommandCheckpointInCurrentTransaction({
          principalId: command.principalId,
          conversationId: threadId,
          clientCommandId: command.clientCommandId,
          name: "history.local_rewrite_committed",
          payload: {
            activityLineId,
            cutoffRunSequence,
            removedActivityCount: 0,
            removedRunEventCount,
            historyRevision: this.v2.head(threadId).historyRevision,
          },
        });
      }
      this.db.exec("COMMIT");
      this.invalidateThreadRunEventCaches(threadId);
      this.v2.publishCommitted(v2Results);
      return {
        activityLineId,
        userMessageId,
        cutoffCreatedAt,
        cutoffRunSequence,
        removedActivityCount: 0,
        removedRunEventCount,
      };
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  /**
   * Drop an ACP user turn that never produced tools/thinking/real output.
   * Does not require an SDK checkpoint — local `user:<uuid>` stream keys are enough.
   */
  discardThreadTurnFromActivityLine(
    threadId: string,
    activityLineId: string,
    command?: ThreadHistoryCommandContext,
  ): ThreadActivityRewindSummary {
    const id = activityLineId.trim();
    if (!threadId.trim() || !id) {
      throw new Error("缺少可丢弃的用户消息。");
    }
    if (this.isV2OnlyStorage()) {
      return this.rewriteV2OnlyHistory(threadId, id, "history.deleted", command);
    }
    const indexedRuntimeSources = this.v2.hasConversation(threadId)
      ? this.listConversationRuntimeSources(threadId)
      : [];
    const hasNativeProviderSources = indexedRuntimeSources.length > 0;
    const runtimeSources = hasNativeProviderSources
      ? indexedRuntimeSources
      : this.listThreadRunEvents(threadId);
    const runBoundaryEvent = runtimeSources
      .filter((event) => event.streamKey === id)
      .sort((left, right) => left.sequence - right.sequence)[0];
    const runBoundary = runBoundaryEvent
      ? { sequence: runBoundaryEvent.sequence, observed_at: runBoundaryEvent.observedAt }
      : undefined;
    if (!runBoundary) {
      const summary = {
        activityLineId: id,
        userMessageId: "",
        cutoffCreatedAt: new Date().toISOString(),
        cutoffRunSequence: 0,
        removedActivityCount: 0,
        removedRunEventCount: 0,
      } satisfies ThreadActivityRewindSummary;
      if (!command) {
        this.db
          .prepare(`DELETE FROM thread_user_messages WHERE thread_id = ? AND activity_line_id = ?`)
          .run(threadId, id);
        this.invalidateThreadRunEventCaches(threadId);
        return summary;
      }
      this.db.exec("BEGIN IMMEDIATE");
      const v2Results: ConversationAppendResult[] = [];
      try {
        this.db
          .prepare(`DELETE FROM thread_user_messages WHERE thread_id = ? AND activity_line_id = ?`)
          .run(threadId, id);
        v2Results.push(
          ...this.v2.appendHistoryRewriteInCurrentTransaction({
            conversationId: threadId,
            eventId: `history_v2_delete_${stableHash(`${threadId}:${id}:${command.clientCommandId}`)}`,
            sourceEventKey: `command-history:deleted:${command.principalId}:${command.clientCommandId}`,
            occurredAt: summary.cutoffCreatedAt,
            type: "history.deleted",
            affectedMessageIds: [],
            reason: "command-discard-without-run-boundary",
          }),
        );
        this.v2.recordCommandCheckpointInCurrentTransaction({
          principalId: command.principalId,
          conversationId: threadId,
          clientCommandId: command.clientCommandId,
          name: "history.local_rewrite_committed",
          payload: {
            activityLineId: id,
            cutoffRunSequence: 0,
            removedActivityCount: 0,
            removedRunEventCount: 0,
            historyRevision: this.v2.head(threadId).historyRevision,
          },
        });
        this.db.exec("COMMIT");
      } catch (error) {
        rollbackConversationTransaction(this.db);
        throw error;
      }
      this.invalidateThreadRunEventCaches(threadId);
      this.v2.publishCommitted(v2Results);
      return summary;
    }

    const cutoffCreatedAt = runBoundary.observed_at;
    const cutoffRunSequence = runBoundary.sequence;
    const deleteChanges = (sql: string, ...args: (string | number | null)[]): number =>
      (this.db.prepare(sql).run(...args) as { changes?: number }).changes ?? 0;

    this.db.exec("BEGIN IMMEDIATE");
    const v2Results: ConversationAppendResult[] = [];
    try {
      const affectedMessageIds = this.listLegacyV2MessageIdsFromRunEvents(threadId, cutoffRunSequence);
      deleteChanges(
        `DELETE FROM thread_user_messages WHERE thread_id = ? AND activity_line_id = ?`,
        threadId,
        id,
      );
      const removedRunEventCount = hasNativeProviderSources
        ? 0
        : deleteChanges(
            `DELETE FROM thread_run_events WHERE thread_id = ? AND sequence >= ?`,
            threadId,
            cutoffRunSequence,
          );
      const activityTarget = this.db
        .prepare(`SELECT rowid AS row_id FROM thread_activity WHERE thread_id = ? AND id = ? LIMIT 1`)
        .get(threadId, id) as { row_id: number } | undefined;
      const removedActivityCount = activityTarget
        ? deleteChanges(
            `DELETE FROM thread_activity WHERE thread_id = ? AND rowid >= ?`,
            threadId,
            activityTarget.row_id,
          )
        : 0;
      this.db
        .prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), threadId);
      v2Results.push(
        ...this.v2.appendHistoryRewriteInCurrentTransaction({
          conversationId: threadId,
          eventId: `history_v2_delete_${stableHash(`${threadId}:${id}:${cutoffRunSequence}`)}`,
          sourceEventKey: `legacy-history:deleted:${threadId}:${id}:${cutoffRunSequence}`,
          occurredAt: new Date().toISOString(),
          type: "history.deleted",
          affectedMessageIds,
          affectedProviderInputIds: this.listRuntimeSourceIdsFromSequence(threadId, cutoffRunSequence),
          reason: "legacy-discard",
        }),
      );
      if (command) {
        this.v2.recordCommandCheckpointInCurrentTransaction({
          principalId: command.principalId,
          conversationId: threadId,
          clientCommandId: command.clientCommandId,
          name: "history.local_rewrite_committed",
          payload: {
            activityLineId: id,
            cutoffRunSequence,
            removedActivityCount,
            removedRunEventCount,
            historyRevision: this.v2.head(threadId).historyRevision,
          },
        });
      }
      this.db.exec("COMMIT");
      this.invalidateThreadRunEventCaches(threadId);
      this.v2.publishCommitted(v2Results);
      return {
        activityLineId: id,
        userMessageId: "",
        cutoffCreatedAt,
        cutoffRunSequence,
        removedActivityCount,
        removedRunEventCount,
      };
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  upsertRunAttempt(record: RunAttemptRecord, commandDispatch?: RunAttemptCommandDispatch): void {
    if (commandDispatch) {
      this.upsertCommandDispatchRunAttempt(record, commandDispatch);
      return;
    }
    const persistedCommandDispatch = runAttemptCommandDispatch(record);
    if (record.status !== "running" && persistedCommandDispatch) {
      this.finishCommandDispatchRunAttempt(record, persistedCommandDispatch);
      return;
    }
    this.requireV2RunStream(record.threadId);
    this.v2.appendRuntime(this.runtimeRunEvent(record));
  }

  private requireV2RunStream(threadId: string): void {
    // Missing migration is a hard error; runtime writes cannot create an empty stream.
    this.v2.head(threadId);
  }

  private runtimeRunEvent(record: RunAttemptRecord) {
    return conversationV2RunEventForAttempt({
      conversationId: record.threadId,
      attemptId: record.attemptId,
      status: record.status,
      phase: record.phase,
      retryIndex: record.retryIndex,
      startedAt: record.startedAt,
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
      ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
      sourcePrefix: CONVERSATION_V2_RUN_LIVE_SOURCE_PREFIX,
    });
  }

  private upsertCommandDispatchRunAttempt(
    record: RunAttemptRecord,
    commandDispatch: RunAttemptCommandDispatch,
  ): void {
    if (record.status !== "running") {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        "A command dispatch can only claim a running attempt.",
      );
    }
    this.requireV2RunStream(record.threadId);
    if (this.v2.getRun(record.threadId, record.attemptId)) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.idempotencyConflict,
        "The prepared command run attempt already exists; it must be recovered, not dispatched again.",
      );
    }
    const commandMetadata = record.metadata?.commandDispatch;
    if (
      !commandMetadata ||
      typeof commandMetadata !== "object" ||
      Array.isArray(commandMetadata) ||
      (commandMetadata as Record<string, unknown>).principalId !== commandDispatch.principalId ||
      (commandMetadata as Record<string, unknown>).clientCommandId !== commandDispatch.clientCommandId ||
      (commandMetadata as Record<string, unknown>).dispatchId !== commandDispatch.dispatchId
    ) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.invalidParams,
        "Run attempt metadata does not match its command dispatch identity.",
      );
    }

    const v2Results: ConversationAppendResult[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.v2.getCommandJob(
        commandDispatch.principalId,
        record.threadId,
        commandDispatch.clientCommandId,
      );
      const prepared = job?.checkpoints.at(-1);
      const preparedCheckpointName =
        job?.commandType === "plan.resolve"
          ? "plan.runtime_dispatch_prepared"
          : "history.runtime_dispatch_prepared";
      if (
        job?.status !== "running" ||
        prepared?.name !== preparedCheckpointName ||
        prepared.payload.dispatchId !== commandDispatch.dispatchId ||
        prepared.payload.plannedAttemptId !== record.attemptId
      ) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.idempotencyConflict,
          "Run attempt does not match the prepared command dispatch checkpoint.",
        );
      }

      v2Results.push(this.v2.appendInCurrentTransaction(this.runtimeRunEvent(record)));
      this.v2.recordCommandCheckpointInCurrentTransaction({
        principalId: commandDispatch.principalId,
        conversationId: record.threadId,
        clientCommandId: commandDispatch.clientCommandId,
        name: job.commandType === "plan.resolve" ? "plan.runtime_dispatched" : "history.runtime_dispatched",
        payload: {
          dispatchId: commandDispatch.dispatchId,
          runAttemptId: record.attemptId,
          phase: record.phase,
          retryIndex: record.retryIndex,
          startedAt: record.startedAt,
        },
      });
      this.db.exec("COMMIT");
      this.v2.publishCommitted(v2Results);
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  private finishCommandDispatchRunAttempt(
    record: RunAttemptRecord,
    commandDispatch: RunAttemptCommandDispatch,
  ): void {
    const v2Results: ConversationAppendResult[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.v2.getCommandJob(
        commandDispatch.principalId,
        record.threadId,
        commandDispatch.clientCommandId,
      );
      const dispatchedCheckpointName =
        job?.commandType === "plan.resolve" ? "plan.runtime_dispatched" : "history.runtime_dispatched";
      const dispatched = job?.checkpoints
        .slice()
        .reverse()
        .find((checkpoint) => checkpoint.name === dispatchedCheckpointName);
      if (
        !job ||
        (job.commandType === "plan.resolve"
          ? job.status !== "running" && job.status !== "completed"
          : job.status !== "running") ||
        dispatched?.name !== dispatchedCheckpointName ||
        dispatched.payload.dispatchId !== commandDispatch.dispatchId ||
        dispatched.payload.runAttemptId !== record.attemptId
      ) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          "Terminal run attempt does not match its dispatched command checkpoint.",
        );
      }

      v2Results.push(this.v2.appendInCurrentTransaction(this.runtimeRunEvent(record)));
      const terminalValue = {
        dispatchId: commandDispatch.dispatchId,
        runAttemptId: record.attemptId,
        status: record.status,
        ...(record.endedAt ? { endedAt: record.endedAt } : {}),
      };
      if (job.commandType !== "plan.resolve") {
        this.v2.finishCommandInCurrentTransaction({
          principalId: commandDispatch.principalId,
          conversationId: record.threadId,
          clientCommandId: commandDispatch.clientCommandId,
          status: record.status === "completed" ? "completed" : "failed",
          value:
            record.status === "completed"
              ? terminalValue
              : {
                  code: record.status === "cancelled" ? "runtime_cancelled" : "runtime_failed",
                  ...terminalValue,
                },
        });
      }
      this.db.exec("COMMIT");
      this.v2.publishCommitted(v2Results);
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
  }

  /** Runtime recovery reads immutable V2 lifecycle events and their V2 run state. */
  listRunAttempts(threadId: string): RunAttemptRecord[] {
    const id = threadId.trim();
    if (!id) {
      this.requireV2RunStream(threadId);
      return [];
    }
    if (!this.v2.hasConversation(id)) {
      if (this.isV2OnlyStorage()) {
        // V2-only reads are fail-closed: a missing stream is an integrity error,
        // never an invitation to recreate or consult retired V1 state.
        this.requireV2RunStream(id);
      }
      // Compatibility-mode parity and migration audits still need to inspect a
      // legacy-only thread. This is a read-only bridge; runtime writes continue
      // to require an existing V2 stream.
      this.requireKnownLegacyConversation(id);
      if (!this.tableExists("thread_run_attempts")) return [];
      const legacyRows = this.db
        .prepare(
          `SELECT thread_id, attempt_id, phase, retry_index, status, started_at, ended_at, metadata_json
           FROM thread_run_attempts
           WHERE thread_id = ?
           ORDER BY started_at ASC, attempt_id ASC`,
        )
        .all(id) as Array<{
        thread_id: string;
        attempt_id: string;
        phase: string;
        retry_index: number;
        status: string;
        started_at: string;
        ended_at: string | null;
        metadata_json: string | null;
      }>;
      return legacyRows.map((row) => this.parseLegacyRunAttemptRow(row));
    }
    const rows = this.listV2RunAttemptRows(id);
    return rows.map((row) => this.parseV2RunAttemptRow(id, row));
  }

  private listV2RunAttemptRows(threadId: string): Array<{
    run_id: string;
    status: string;
    started_at: string | null;
    ended_at: string | null;
    payload_json: string;
  }> {
    // The lifecycle subquery selects a sequence for this exact run. Sequence
    // is unique within a conversation, so joining by sequence alone keeps the
    // outer lookup on the event primary key instead of scanning the full stream.
    return this.db
      .prepare(`
      SELECT r.run_id, r.status, r.started_at, r.ended_at, e.payload_json
      FROM conversation_runs_v2 r
      JOIN conversation_events_v2 e ON e.conversation_id = r.conversation_id
        AND e.seq = (
          SELECT MAX(l.seq) FROM conversation_events_v2 l
          WHERE l.conversation_id = r.conversation_id AND l.run_id = r.run_id
            AND l.type IN ('run.started', 'run.completed', 'run.failed', 'run.cancelled', 'run.interrupted')
            AND json_extract(l.payload_json, '$.authority') = 'lifecycle'
        )
      WHERE r.conversation_id = ?
      ORDER BY r.started_at ASC, r.run_id ASC
    `)
      .all(threadId) as Array<{
      run_id: string;
      status: string;
      started_at: string | null;
      ended_at: string | null;
      payload_json: string;
    }>;
  }

  /**
   * Reconcile the V2 run projection with the legacy attempt ledger while the
   * database is still in compatibility mode.
   *
   * `thread_run_attempts` remains a migration input and the lifecycle event is
   * the V2 authority. This method never creates a V2 stream: an unmigrated
   * conversation must go through the explicit migration command first.
   */
  reconcileConversationV2Runs(threadId: string): { scanned: number; repaired: number } {
    const id = threadId.trim();
    if (!id) {
      throw new ConversationV2Error(CONVERSATION_V2_ERROR.invalidParams, "threadId is required.");
    }
    if (this.isV2OnlyStorage() || !this.tableExists("thread_run_attempts") || !this.v2.hasConversation(id)) {
      return { scanned: 0, repaired: 0 };
    }

    const rows = this.db
      .prepare(
        `SELECT thread_id, attempt_id, phase, retry_index, status, started_at, ended_at, metadata_json
         FROM thread_run_attempts
         WHERE thread_id = ?
         ORDER BY started_at ASC, attempt_id ASC`,
      )
      .all(id) as Array<{
      thread_id: string;
      attempt_id: string;
      phase: string;
      retry_index: number;
      status: string;
      started_at: string;
      ended_at: string | null;
      metadata_json: string | null;
    }>;
    if (rows.length === 0) return { scanned: 0, repaired: 0 };

    const existingAttempts = new Map<string, RunAttemptRecord>();
    // A compatibility database can contain an older V2 lifecycle event that
    // predates required phase/retry metadata. Keep valid rows for idempotence,
    // while allowing the legacy ledger to repair only the malformed attempts.
    for (const row of this.listV2RunAttemptRows(id)) {
      try {
        const parsed = this.parseV2RunAttemptRow(id, row);
        existingAttempts.set(parsed.attemptId, parsed);
      } catch {
        // The legacy row below is the explicit recovery input in compat mode.
      }
    }
    // Validate the complete legacy input before appending anything. A malformed
    // row must not leave a partially reconciled stream behind.
    const records = rows.map((row) => this.parseLegacyRunAttemptRow(row));
    let repaired = 0;
    const results: ConversationAppendResult[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        const existing = existingAttempts.get(record.attemptId);
        const run = this.v2.getRun(id, record.attemptId);
        if (existing && run && run.timingQuality === "recorded" && sameRunAttemptRecord(existing, record)) {
          continue;
        }
        results.push(
          this.v2.appendInCurrentTransaction(
            conversationV2RunEventForAttempt({
              conversationId: record.threadId,
              attemptId: record.attemptId,
              status: record.status,
              phase: record.phase,
              retryIndex: record.retryIndex,
              startedAt: record.startedAt,
              ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
              ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
              sourcePrefix: CONVERSATION_V2_RUN_RECONCILE_SOURCE_PREFIX,
            }),
          ),
        );
        repaired += 1;
        existingAttempts.set(record.attemptId, record);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    this.v2.publishCommitted(results);
    return { scanned: rows.length, repaired };
  }

  /** Reconcile every already-migrated V2 stream during desktop startup. */
  reconcileAllConversationV2Runs(): {
    conversations: number;
    scanned: number;
    repaired: number;
  } {
    if (this.isV2OnlyStorage() || !this.tableExists("thread_run_attempts")) {
      return { conversations: 0, scanned: 0, repaired: 0 };
    }
    const threadIds = this.db
      .prepare(`SELECT DISTINCT thread_id FROM thread_run_attempts ORDER BY thread_id ASC`)
      .all() as Array<{ thread_id: string }>;
    let conversations = 0;
    let scanned = 0;
    let repaired = 0;
    for (const row of threadIds) {
      if (!this.v2.hasConversation(row.thread_id)) continue;
      const result = this.reconcileConversationV2Runs(row.thread_id);
      conversations += 1;
      scanned += result.scanned;
      repaired += result.repaired;
    }
    return { conversations, scanned, repaired };
  }

  /** Settle V2 tool calls left active by an already failed or cancelled run. */
  reconcileAllConversationV2TerminalRunTools(): {
    conversations: number;
    scanned: number;
    settled: number;
  } {
    this.v2.initialize();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT tools.conversation_id
           FROM conversation_tool_calls_v2 AS tools
           JOIN conversation_runs_v2 AS runs
             ON runs.conversation_id = tools.conversation_id
            AND runs.run_id = tools.run_id
          WHERE tools.status IN ('started', 'running')
            AND runs.status IN ('failed', 'cancelled')
            AND runs.ended_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM conversation_streams_v2 AS streams
               WHERE streams.conversation_id = tools.conversation_id
            )
          ORDER BY tools.conversation_id ASC`,
      )
      .all() as Array<{ conversation_id: string }>;
    let conversations = 0;
    let scanned = 0;
    let settled = 0;
    for (const row of rows) {
      const result = this.v2.reconcileTerminalRunTools(row.conversation_id);
      conversations += 1;
      scanned += result.scanned;
      settled += result.settled;
    }
    return { conversations, scanned, settled };
  }

  /**
   * Repair the Codex user-item echo that older V2 runtime builds could record
   * beside the already accepted local prompt. A repair is only safe when the
   * provider echo has a Codex user id and an earlier, same-text local prompt
   * source identifies exactly which V2 message it belongs to. Ambiguous text
   * matches are left visible and reported instead of being guessed.
   */
  reconcileConversationV2CodexUserMessageDuplicates(threadId: string): {
    scanned: number;
    repaired: number;
    ambiguous: number;
  } {
    const id = threadId.trim();
    if (!id || !this.v2.hasConversation(id)) {
      return { scanned: 0, repaired: 0, ambiguous: 0 };
    }
    if (this.v2.hasConversationRepair(CONVERSATION_V2_REPAIR_CODEX_USER_DUPLICATES, id)) {
      return { scanned: 0, repaired: 0, ambiguous: 0 };
    }
    const sources = this.listConversationRuntimeSources(id);
    const promptSources = sources.filter(
      (event) =>
        event.role === "user" &&
        event.eventType === "thread.status" &&
        event.metadata?.liveType === "thread.user_prompt",
    );
    const userMessages = this.v2.listUserMessages(id);
    const userMessagesById = new Map(userMessages.map((message) => [message.messageId, message]));
    const echoes = sources.filter(
      (event) =>
        event.role === "user" &&
        event.eventType === "message.final" &&
        event.metadata?.liveType === "message.user" &&
        Boolean(readRewindTarget(event.metadata)?.userMessageId),
    );
    let repaired = 0;
    let ambiguous = 0;
    const results: ConversationAppendResult[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const echo of echoes) {
        const duplicateMessageId = sourceMessageId(echo.metadata);
        const providerUserMessageId = readRewindTarget(echo.metadata)?.userMessageId?.trim();
        if (!duplicateMessageId || !providerUserMessageId) continue;
        const duplicate = userMessagesById.get(duplicateMessageId);
        if (!duplicate || duplicate.isDeleted || duplicate.role !== "user") continue;

        const candidates = promptSources
          .filter((prompt) => prompt.sequence < echo.sequence && prompt.message === echo.message)
          .map((prompt) => ({
            prompt,
            messageId: sourceMessageId(prompt.metadata),
          }))
          .filter((candidate): candidate is { prompt: ThreadRunEvent; messageId: string } =>
            Boolean(candidate.messageId && candidate.messageId !== duplicateMessageId),
          )
          .filter((candidate) => userMessagesById.has(candidate.messageId))
          .sort((left, right) => right.prompt.sequence - left.prompt.sequence);
        const canonical = candidates[0];
        if (!canonical) continue;
        const equallyRecent = candidates.filter(
          (candidate) => candidate.prompt.sequence === canonical.prompt.sequence,
        );
        if (equallyRecent.length > 1) {
          ambiguous += 1;
          continue;
        }

        const historyTarget = {
          activityLineId: sdkActivityLineId(providerUserMessageId),
          userMessageId: providerUserMessageId,
        };
        const sourceKey = `desktop:codex-user-duplicate-repair:${id}:${duplicateMessageId}:${canonical.messageId}`;
        results.push(
          this.v2.appendInCurrentTransaction({
            conversationId: id,
            eventId: `codex_user_duplicate_bind_${stableHash(sourceKey)}`,
            sourceEventKey: `${sourceKey}:bind`,
            type: "message.history_targeted",
            occurredAt: echo.observedAt,
            messageId: canonical.messageId,
            payload: { historyTarget },
          }),
        );
        results.push(
          this.v2.appendInCurrentTransaction({
            conversationId: id,
            eventId: `codex_user_duplicate_delete_${stableHash(sourceKey)}`,
            sourceEventKey: `${sourceKey}:delete`,
            type: "history.deleted",
            occurredAt: echo.observedAt,
            messageId: duplicateMessageId,
            payload: {
              reason: "codex-user-item-echo",
              affectedMessageIds: [duplicateMessageId],
              affectedProviderInputIds: [echo.id],
            },
          }),
        );
        repaired += 1;
        userMessagesById.delete(duplicateMessageId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    if (results.length > 0) this.v2.publishCommitted(results);
    this.v2.markConversationRepaired(CONVERSATION_V2_REPAIR_CODEX_USER_DUPLICATES, id);
    return { scanned: echoes.length, repaired, ambiguous };
  }

  /** Repair every V2 conversation that has not been through the echo repair yet. */
  reconcileAllConversationV2CodexUserMessageDuplicates(): {
    conversations: number;
    scanned: number;
    repaired: number;
    ambiguous: number;
  } {
    let conversations = 0;
    let scanned = 0;
    let repaired = 0;
    let ambiguous = 0;
    for (const conversationId of this.v2.listConversationsMissingRepair(
      CONVERSATION_V2_REPAIR_CODEX_USER_DUPLICATES,
    )) {
      const result = this.reconcileConversationV2CodexUserMessageDuplicates(conversationId);
      conversations += 1;
      scanned += result.scanned;
      repaired += result.repaired;
      ambiguous += result.ambiguous;
    }
    return { conversations, scanned, repaired, ambiguous };
  }

  /**
   * Repair the older accepted-message duplication path. Before every runtime
   * continuation forwarded the accepted V2 message id, the command wrote a
   * queued `message.accepted` row and the runtime then created a second
   * `desktop:user:*` row for the same prompt. Only repair the exact adjacent
   * event shape, with a matching user-prompt source, so two intentional sends
   * with identical text are never merged by text alone.
   */
  reconcileConversationV2AcceptedPromptDuplicates(threadId: string): {
    scanned: number;
    repaired: number;
    ambiguous: number;
  } {
    const id = threadId.trim();
    if (!id || !this.v2.hasConversation(id)) {
      return { scanned: 0, repaired: 0, ambiguous: 0 };
    }
    if (this.v2.hasConversationRepair(CONVERSATION_V2_REPAIR_ACCEPTED_PROMPT_DUPLICATES, id)) {
      return { scanned: 0, repaired: 0, ambiguous: 0 };
    }
    // The repair only ever deletes an accepted row whose user message is still
    // queued, so a conversation without one has nothing to repair. Recording
    // that here keeps the (potentially large) event log out of the check.
    if (!this.hasQueuedUserMessage(id)) {
      this.v2.markConversationRepaired(CONVERSATION_V2_REPAIR_ACCEPTED_PROMPT_DUPLICATES, id);
      return { scanned: 0, repaired: 0, ambiguous: 0 };
    }
    const rows = this.db
      .prepare(
        `SELECT seq, type, event_id, source_event_key, message_id, payload_json, occurred_at
           FROM conversation_events_v2
          WHERE conversation_id = ? AND type IN ('message.accepted', 'message.created')
          ORDER BY seq ASC`,
      )
      .all(id) as Array<{
      seq: number;
      type: string;
      event_id: string;
      source_event_key: string;
      message_id: string | null;
      payload_json: string;
      occurred_at: string;
    }>;
    const acceptedRows = rows.filter(
      (row) => row.type === "message.accepted" && typeof row.message_id === "string" && row.message_id.trim(),
    );
    if (acceptedRows.length === 0) {
      return { scanned: 0, repaired: 0, ambiguous: 0 };
    }
    const promptSourceMessageIds = new Set(
      this.listConversationRuntimeSources(id)
        .filter(
          (event) =>
            event.role === "user" &&
            event.eventType === "thread.status" &&
            event.metadata?.liveType === "thread.user_prompt",
        )
        .map((event) => sourceMessageId(event.metadata))
        .filter((messageId): messageId is string => Boolean(messageId)),
    );
    const parseBody = (payloadJson: string): string | undefined => {
      const payload = parseJsonRecord(payloadJson);
      return typeof payload?.body === "string" ? payload.body : undefined;
    };
    const userMessages = new Map(this.v2.listUserMessages(id).map((message) => [message.messageId, message]));
    const results: ConversationAppendResult[] = [];
    let repaired = 0;
    let ambiguous = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const accepted of acceptedRows) {
        const acceptedMessageId = accepted.message_id?.trim();
        if (!acceptedMessageId) continue;
        const acceptedMessage = userMessages.get(acceptedMessageId);
        if (!acceptedMessage || acceptedMessage.isDeleted || acceptedMessage.status !== "queued") continue;
        const body = parseBody(accepted.payload_json);
        if (body === undefined) continue;
        const candidates = rows
          .filter(
            (row) =>
              row.type === "message.created" &&
              row.message_id &&
              row.message_id !== acceptedMessageId &&
              row.seq > accepted.seq &&
              row.seq <= accepted.seq + 8 &&
              row.source_event_key.startsWith("desktop:user:") &&
              parseBody(row.payload_json) === body,
          )
          .filter((row) => {
            const candidateId = row.message_id?.trim();
            if (!candidateId) return false;
            const candidate = userMessages.get(candidateId);
            if (!candidate || candidate.isDeleted || candidate.role !== "user") return false;
            return promptSourceMessageIds.has(candidateId);
          });
        if (candidates.length === 0) continue;
        if (candidates.length > 1) {
          ambiguous += 1;
          continue;
        }
        const candidate = candidates[0];
        if (!candidate?.message_id) continue;
        const sourceKey = `desktop:accepted-prompt-duplicate-repair:${id}:${acceptedMessageId}:${candidate.message_id}`;
        results.push(
          this.v2.appendInCurrentTransaction({
            conversationId: id,
            eventId: `accepted_prompt_duplicate_delete_${stableHash(sourceKey)}`,
            sourceEventKey: `${sourceKey}:delete`,
            type: "history.deleted",
            occurredAt: accepted.occurred_at,
            messageId: acceptedMessageId,
            payload: {
              reason: "accepted-prompt-duplicate",
              affectedMessageIds: [acceptedMessageId],
            },
          }),
        );
        repaired += 1;
        userMessages.delete(acceptedMessageId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackConversationTransaction(this.db);
      throw error;
    }
    if (results.length > 0) this.v2.publishCommitted(results);
    this.v2.markConversationRepaired(CONVERSATION_V2_REPAIR_ACCEPTED_PROMPT_DUPLICATES, id);
    return { scanned: acceptedRows.length, repaired, ambiguous };
  }

  /**
   * Repair the accepted-prompt duplicate shape for every conversation that could
   * still produce one.
   *
   * This is the one repair that also belongs on the startup path: the startup
   * queue recovery delivers queued prompts without anyone opening the
   * conversation, so a stale accepted duplicate has to be tombstoned before that
   * runs. The repair itself only ever deletes an accepted row whose user message
   * is still `queued`, so the candidate set is exactly the conversations holding
   * a queued user message — normally none.
   */
  reconcileAllConversationV2AcceptedPromptDuplicates(): {
    conversations: number;
    scanned: number;
    repaired: number;
    ambiguous: number;
  } {
    this.v2.initialize();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT messages.conversation_id
           FROM conversation_messages_v2 AS messages
          WHERE messages.role = 'user'
            AND messages.status = 'queued'
            AND messages.is_deleted = 0
            AND EXISTS (
              SELECT 1 FROM conversation_streams_v2 AS streams
               WHERE streams.conversation_id = messages.conversation_id
            )
          ORDER BY messages.conversation_id ASC`,
      )
      .all() as Array<{ conversation_id: string }>;
    let conversations = 0;
    let scanned = 0;
    let repaired = 0;
    let ambiguous = 0;
    for (const row of rows) {
      const result = this.reconcileConversationV2AcceptedPromptDuplicates(row.conversation_id);
      conversations += 1;
      scanned += result.scanned;
      repaired += result.repaired;
      ambiguous += result.ambiguous;
    }
    return { conversations, scanned, repaired, ambiguous };
  }

  /**
   * Repair only ledger rows with a unique V2 agent owner; ambiguous rows remain
   * visible. The writer can still leave rows unattributed, so this stays a sweep
   * instead of a one-time repair — but it is driven by the rows that actually
   * need it rather than by every conversation in the store.
   */
  reconcileAllConversationV2UsageLedgerAttribution(): {
    conversations: number;
    scanned: number;
    attributed: number;
    ambiguous: number;
  } {
    this.v2.initialize();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT conversation_id FROM conversation_usage_ledger_events_v2
          WHERE agent_id IS NULL
          ORDER BY conversation_id ASC`,
      )
      .all() as Array<{ conversation_id: string }>;
    let conversations = 0;
    let scanned = 0;
    let attributed = 0;
    let ambiguous = 0;
    for (const row of rows) {
      const result = this.v2.reconcileUsageLedgerAgentAttribution(row.conversation_id);
      conversations += 1;
      scanned += result.scanned;
      attributed += result.attributed;
      ambiguous += result.ambiguous;
    }
    return { conversations, scanned, attributed, ambiguous };
  }

  /**
   * One-time repairs scoped to a single conversation, run when that conversation
   * is loaded or first migrated. Each repair records itself, so the cost is paid
   * once by the conversation that needs it instead of by every startup over the
   * whole store.
   */
  repairConversationV2OnLoad(threadId: string): void {
    const id = threadId.trim();
    if (!id || !this.v2.hasConversation(id)) {
      return;
    }
    this.reconcileConversationV2CodexUserMessageDuplicates(id);
    this.reconcileConversationV2AcceptedPromptDuplicates(id);
  }

  /** Whether the conversation still holds a queued user prompt. */
  private hasQueuedUserMessage(conversationId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM conversation_messages_v2
          WHERE conversation_id = ? AND role = 'user' AND status = 'queued' AND is_deleted = 0
          LIMIT 1`,
      )
      .get(conversationId) as { present?: number } | undefined;
    return row?.present === 1;
  }

  private parseV2RunAttemptRow(
    threadId: string,
    row: {
      run_id: string;
      status: string;
      started_at: string | null;
      ended_at: string | null;
      payload_json: string;
    },
  ): RunAttemptRecord {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const phase = normalizeRunAttemptPhase(payload.phase);
    if (
      !phase ||
      !Number.isSafeInteger(payload.retryIndex) ||
      Number(payload.retryIndex) < 0 ||
      !row.started_at ||
      !["running", "completed", "failed", "cancelled"].includes(row.status) ||
      (payload.metadata !== undefined &&
        (!payload.metadata || typeof payload.metadata !== "object" || Array.isArray(payload.metadata)))
    ) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Run ${row.run_id} lacks valid V2 lifecycle recovery metadata; explicit migration is required.`,
      );
    }
    return {
      threadId,
      attemptId: row.run_id,
      phase,
      retryIndex: Number(payload.retryIndex),
      status: row.status as RunAttemptStatus,
      startedAt: row.started_at,
      ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
      ...(payload.metadata !== undefined ? { metadata: payload.metadata as Record<string, unknown> } : {}),
    };
  }

  private parseLegacyRunAttemptRow(row: {
    thread_id: string;
    attempt_id: string;
    phase: string;
    retry_index: number;
    status: string;
    started_at: string;
    ended_at: string | null;
    metadata_json: string | null;
  }): RunAttemptRecord {
    const status = normalizeLegacyRunAttemptStatus(row.status);
    const phase = normalizeRunAttemptPhase(row.phase);
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata_json) {
      try {
        const parsed: unknown = JSON.parse(row.metadata_json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata shape");
        metadata = parsed as Record<string, unknown>;
      } catch {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Legacy run ${row.attempt_id} has invalid recovery metadata; explicit migration is required.`,
        );
      }
    }
    if (
      !row.thread_id.trim() ||
      !row.attempt_id.trim() ||
      !phase ||
      !status ||
      !Number.isSafeInteger(row.retry_index) ||
      row.retry_index < 0 ||
      !row.started_at.trim()
    ) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Legacy run ${row.attempt_id} lacks valid recovery metadata; explicit migration is required.`,
      );
    }
    return {
      threadId: row.thread_id,
      attemptId: row.attempt_id,
      phase,
      retryIndex: row.retry_index,
      status,
      startedAt: row.started_at,
      ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
  }

  reconcileRecoverableHistoryCommands(threadId: string): HistoryCommandRecoveryDecision[] {
    const attempts = this.listRunAttempts(threadId);
    const pending: HistoryCommandRecoveryDecision[] = [];
    const jobs = this.v2
      .listRecoverableCommandJobs()
      .filter(
        (job) =>
          job.conversationId === threadId &&
          (job.commandType === "history.rewrite" || job.commandType === "history.retry"),
      );
    for (const job of jobs) {
      const decision = classifyHistoryCommandRecovery({ job, attempts });
      if (decision.kind === "settle_orphaned_attempt") {
        this.upsertRunAttempt({
          ...decision.attempt,
          status: "failed",
          endedAt: decision.attempt.endedAt ?? new Date().toISOString(),
        });
        continue;
      }
      if (decision.kind === "settle_from_terminal_attempt") {
        this.upsertRunAttempt(decision.attempt);
        continue;
      }
      if (decision.kind === "integrity_failure") {
        this.v2.failCommand(job.principalId, job.conversationId, job.clientCommandId, {
          code: CONVERSATION_V2_ERROR.integrityFailure,
          reason: decision.reason,
        });
      }
      pending.push(decision);
    }
    return pending;
  }

  upsertAgentInstance(record: AgentInstanceRecord): void {
    this.v2.head(record.threadId);
    const prior = this.db
      .prepare(`SELECT payload_json FROM conversation_events_v2
      WHERE conversation_id = ? AND agent_instance_id = ? AND type LIKE 'agent.%'
        AND json_extract(payload_json, '$.authority') = 'lifecycle'
      ORDER BY seq DESC LIMIT 1`)
      .get(record.threadId, record.agentId) as { payload_json: string } | undefined;
    const existing = prior ? (JSON.parse(prior.payload_json) as Record<string, unknown>) : undefined;
    // A missing mission/todo in a later lifecycle update does not erase known facts.
    const event = conversationV2AgentEvent({
      ...record,
      ...(record.missionKey === undefined && typeof existing?.mission === "string"
        ? { missionKey: existing.mission }
        : {}),
      ...(record.todoId === undefined && typeof existing?.todoId === "string"
        ? { todoId: existing.todoId }
        : {}),
    });
    this.v2.appendRuntime(event);
  }

  listAgentInstances(threadId: string): AgentInstanceRecord[] {
    const id = threadId.trim();
    if (!id) {
      this.v2.head(threadId);
      return [];
    }
    if (!this.v2.hasConversation(id)) {
      if (this.isV2OnlyStorage()) {
        // Keep the V2-only boundary explicit even if a retired legacy table is
        // still present in a damaged or partially restored database.
        this.requireV2RunStream(id);
      }
      this.requireKnownLegacyConversation(id);
      if (!this.tableExists("thread_agent_instances")) return [];
      const legacyRows = this.db
        .prepare(
          `SELECT thread_id, agent_id, role, kind, status, run_attempt_id,
                  parent_agent_id, parent_tool_use_id, mission_key, todo_id,
                  started_at, ended_at, updated_at, metadata_json
           FROM thread_agent_instances
           WHERE thread_id = ?
           ORDER BY started_at ASC, agent_id ASC`,
        )
        .all(id) as Array<{
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
        started_at: string;
        ended_at: string | null;
        updated_at: string;
        metadata_json: string | null;
      }>;
      return legacyRows.map((row) => this.parseLegacyAgentInstanceRow(id, row));
    }
    // As with run events, the lifecycle subquery selects a unique conversation
    // sequence for this agent instance; use the event primary key for the row.
    const rows = this.db
      .prepare(`
      SELECT a.agent_instance_id, e.agent_id, e.run_id, e.parent_agent_instance_id,
        e.parent_tool_call_id, e.payload_json
      FROM conversation_agents_v2 a
      JOIN conversation_events_v2 e ON e.conversation_id = a.conversation_id
        AND e.seq = (
          SELECT MAX(l.seq) FROM conversation_events_v2 l
          WHERE l.conversation_id = a.conversation_id AND l.agent_instance_id = a.agent_instance_id
            AND l.type LIKE 'agent.%' AND json_extract(l.payload_json, '$.authority') = 'lifecycle'
        )
      WHERE a.conversation_id = ? ORDER BY a.started_at ASC, a.agent_instance_id ASC
    `)
      .all(id) as Array<{
      agent_instance_id: string;
      agent_id: string | null;
      run_id: string | null;
      parent_agent_instance_id: string | null;
      parent_tool_call_id: string | null;
      payload_json: string | null;
    }>;
    return rows.map((row) => {
      const payload = row.payload_json
        ? (JSON.parse(row.payload_json) as Record<string, unknown>)
        : undefined;
      if (
        !payload ||
        typeof payload.updatedAt !== "string" ||
        typeof payload.startedAt !== "string" ||
        typeof payload.role !== "string" ||
        !["launching", "active", "stopped", "abandoned"].includes(String(payload.status)) ||
        !["main", "subagent"].includes(normalizeAgentRole(String(payload.kind))) ||
        (payload.metadata !== undefined &&
          (!payload.metadata || typeof payload.metadata !== "object" || Array.isArray(payload.metadata)))
      ) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Agent ${row.agent_instance_id} lacks valid V2 lifecycle recovery metadata; explicit migration is required.`,
        );
      }
      return {
        threadId: id,
        agentId: row.agent_id ?? row.agent_instance_id,
        role: normalizeAgentRole(payload.role),
        kind: normalizeAgentRole(String(payload.kind)) as AgentInstanceKind,
        status: payload.status as AgentInstanceStatus,
        startedAt: payload.startedAt,
        updatedAt: payload.updatedAt,
        ...(typeof payload.endedAt === "string" ? { endedAt: payload.endedAt } : {}),
        ...(row.run_id !== null ? { runAttemptId: row.run_id } : {}),
        ...(row.parent_agent_instance_id !== null ? { parentAgentId: row.parent_agent_instance_id } : {}),
        ...(row.parent_tool_call_id !== null ? { parentToolUseId: row.parent_tool_call_id } : {}),
        ...(typeof payload.mission === "string" ? { missionKey: payload.mission } : {}),
        ...(typeof payload.todoId === "string" ? { todoId: payload.todoId } : {}),
        ...(payload.metadata !== undefined ? { metadata: payload.metadata as Record<string, unknown> } : {}),
      };
    });
  }

  private parseLegacyAgentInstanceRow(
    threadId: string,
    row: {
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
      started_at: string;
      ended_at: string | null;
      updated_at: string;
      metadata_json: string | null;
    },
  ): AgentInstanceRecord {
    const status = normalizeLegacyAgentInstanceStatus(row.status);
    const metadata = parseJsonRecord(row.metadata_json);
    if (
      row.thread_id !== threadId ||
      !row.agent_id.trim() ||
      !row.role.trim() ||
      !["main", "subagent"].includes(normalizeAgentRole(row.kind)) ||
      !status ||
      !row.started_at.trim() ||
      !row.updated_at.trim() ||
      (row.metadata_json !== null && row.metadata_json !== "" && metadata === undefined)
    ) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Legacy agent ${row.agent_id} lacks valid recovery metadata; explicit migration is required.`,
      );
    }
    return {
      threadId,
      agentId: row.agent_id,
      role: normalizeAgentRole(row.role),
      kind: normalizeAgentRole(row.kind) as AgentInstanceKind,
      status,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
      ...(row.run_attempt_id ? { runAttemptId: row.run_attempt_id } : {}),
      ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
      ...(row.parent_tool_use_id ? { parentToolUseId: row.parent_tool_use_id } : {}),
      ...(row.mission_key !== null ? { missionKey: row.mission_key } : {}),
      ...(row.todo_id ? { todoId: row.todo_id } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
  }

  appendUsageLedgerEvent(event: UsageLedgerEvent): boolean {
    this.v2.initialize();
    if (this.v2.hasConversation(event.threadId)) {
      return this.v2.appendUsageLedgerEvent(usageLedgerEventToV2(event));
    }
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Usage ledger event has no V2 conversation stream: ${event.threadId}`,
      );
    }
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_usage_ledger_events (
           id, idempotency_key, thread_id, run_attempt_id, agent_id, parent_tool_use_id,
           source, source_event_id, request_key, provider_request_id, sdk_message_id,
           usage_kind, role, model_id,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
           reported_cost_usd, attribution_json, metadata_json, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.idempotencyKey,
        event.threadId,
        event.runAttemptId ?? null,
        event.agentId ?? null,
        event.parentToolUseId ?? null,
        event.source,
        event.sourceEventId,
        event.requestKey ?? null,
        event.providerRequestId ?? null,
        event.sdkMessageId ?? null,
        event.usageKind,
        event.role,
        event.modelId ?? null,
        event.inputTokens,
        event.outputTokens,
        event.cacheReadTokens,
        event.cacheCreationTokens,
        event.reasoningTokens ?? 0,
        event.reportedCostUsd ?? null,
        JSON.stringify(event.attribution),
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.observedAt,
      ) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  updateUsageLedgerEventAttribution(eventId: string, update: UsageLedgerAttributionUpdate): boolean {
    this.v2.initialize();
    const threadId = this.findUsageLedgerEventThreadId(eventId);
    if (threadId && this.v2.hasConversation(threadId)) {
      const v2Updated = this.v2.updateUsageLedgerEventAttributionInCurrentTransaction(threadId, eventId, {
        agentId: update.agentId ?? null,
        ...(update.role && { role: update.role }),
        ...(update.parentToolUseId && { parentToolUseId: update.parentToolUseId }),
        attributionJson: JSON.stringify(update.attribution),
        ...(update.metadata && { metadataJson: JSON.stringify(update.metadata) }),
      });
      if (!this.isV2OnlyStorage() && this.tableExists("thread_usage_ledger_events")) {
        this.db
          .prepare(
            `UPDATE thread_usage_ledger_events
                SET agent_id = ?,
                    role = COALESCE(?, role),
                    parent_tool_use_id = COALESCE(?, parent_tool_use_id),
                    attribution_json = ?,
                    metadata_json = COALESCE(?, metadata_json)
              WHERE id = ?`,
          )
          .run(
            update.agentId ?? null,
            update.role ?? null,
            update.parentToolUseId ?? null,
            JSON.stringify(update.attribution),
            update.metadata ? JSON.stringify(update.metadata) : null,
            eventId,
          );
      }
      return v2Updated;
    }
    if (this.isV2OnlyStorage()) {
      return false;
    }
    const result = this.db
      .prepare(
        `UPDATE thread_usage_ledger_events
         SET agent_id = ?,
             role = COALESCE(?, role),
             parent_tool_use_id = COALESCE(?, parent_tool_use_id),
             attribution_json = ?,
             metadata_json = COALESCE(?, metadata_json)
         WHERE id = ?`,
      )
      .run(
        update.agentId ?? null,
        update.role ?? null,
        update.parentToolUseId ?? null,
        JSON.stringify(update.attribution),
        update.metadata ? JSON.stringify(update.metadata) : null,
        eventId,
      ) as {
      changes?: number;
    };
    return (result.changes ?? 0) > 0;
  }

  listUsageLedgerEvents(threadId: string): UsageLedgerEvent[] {
    const id = threadId.trim();
    this.v2.initialize();
    if (this.v2.hasConversation(id)) {
      const v2Events = this.v2.listUsageLedgerEventRows(id).map(v2UsageLedgerRowToEvent);
      // A V2-only stream has a single billing authority. Startup may import a
      // leftover legacy table once before retiring it, but a table that is
      // recreated after cutover must never be merged into a live read.
      if (this.isV2OnlyStorage() || !this.tableExists("thread_usage_ledger_events")) {
        return v2Events;
      }
      const byIdempotencyKey = new Map(v2Events.map((event) => [event.idempotencyKey, event]));
      for (const event of this.listLegacyUsageLedgerEvents(id)) {
        if (!byIdempotencyKey.has(event.idempotencyKey)) {
          byIdempotencyKey.set(event.idempotencyKey, event);
        }
      }
      return [...byIdempotencyKey.values()].sort(
        (left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id),
      );
    }
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Usage ledger conversation stream is missing: ${id}`,
      );
    }
    return this.listLegacyUsageLedgerEvents(id);
  }

  private listLegacyUsageLedgerEvents(threadId: string): UsageLedgerEvent[] {
    if (!this.tableExists("thread_usage_ledger_events")) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT id, idempotency_key, thread_id, run_attempt_id, agent_id, parent_tool_use_id,
                source, source_event_id, request_key, provider_request_id, sdk_message_id,
                usage_kind, role, model_id,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                reported_cost_usd, attribution_json, metadata_json, observed_at
         FROM thread_usage_ledger_events
         WHERE thread_id = ?
         ORDER BY observed_at ASC, id ASC`,
      )
      .all(threadId) as unknown as Array<UsageLedgerEventRow>;

    return rows.map(rowToUsageLedgerEvent);
  }

  clearUsageLedger(threadId: string): void {
    const id = threadId.trim();
    this.v2.initialize();
    if (this.v2.hasConversation(id)) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.v2.clearUsageLedgerInCurrentTransaction(id);
        if (!this.isV2OnlyStorage() && this.tableExists("thread_usage_ledger_events")) {
          this.db.prepare(`DELETE FROM thread_usage_ledger_events WHERE thread_id = ?`).run(id);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        rollbackConversationTransaction(this.db);
        throw error;
      }
      return;
    }
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Usage ledger conversation stream is missing: ${id}`,
      );
    }
    if (this.tableExists("thread_usage_ledger_events")) {
      this.db.prepare(`DELETE FROM thread_usage_ledger_events WHERE thread_id = ?`).run(id);
    }
  }

  private findUsageLedgerEventThreadId(eventId: string): string | undefined {
    const v2Row = this.db
      .prepare(`SELECT conversation_id FROM conversation_usage_ledger_events_v2 WHERE id = ? LIMIT 1`)
      .get(eventId) as { conversation_id?: string } | undefined;
    if (v2Row?.conversation_id) {
      return v2Row.conversation_id;
    }
    if (this.isV2OnlyStorage()) {
      return undefined;
    }
    if (!this.tableExists("thread_usage_ledger_events")) {
      return undefined;
    }
    const legacyRow = this.db
      .prepare(`SELECT thread_id FROM thread_usage_ledger_events WHERE id = ? LIMIT 1`)
      .get(eventId) as { thread_id?: string } | undefined;
    return legacyRow?.thread_id;
  }

  private deleteUsageLedgerEventsFromCurrentTransaction(threadId: string, observedAt: string): void {
    const id = threadId.trim();
    if (this.v2.hasConversation(id)) {
      this.v2.deleteUsageLedgerEventsFromInCurrentTransaction(id, observedAt);
      if (!this.isV2OnlyStorage() && this.tableExists("thread_usage_ledger_events")) {
        this.db
          .prepare(`DELETE FROM thread_usage_ledger_events WHERE thread_id = ? AND observed_at >= ?`)
          .run(id, observedAt);
      }
      return;
    }
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Usage ledger conversation stream is missing: ${id}`,
      );
    }
    if (this.tableExists("thread_usage_ledger_events")) {
      this.db
        .prepare(`DELETE FROM thread_usage_ledger_events WHERE thread_id = ? AND observed_at >= ?`)
        .run(id, observedAt);
    }
  }

  /**
   * Resolve only the V2 message identities represented by legacy rows that a
   * rewind is about to remove. Do not widen this to a timestamp query: an
   * observedAt value is not an ownership boundary.
   */
  private listV2MessageIdsFromHistorySequence(threadId: string, minimumSequence: number): string[] {
    // Native receipts already name the materialized message. Recomputing a
    // legacy identity loses accepted user rows and finalized stream bodies.
    const rows = this.db.prepare(`SELECT DISTINCT message_id FROM conversation_provider_inputs_v2
        WHERE conversation_id = ? AND visible = 1 AND first_seq >= ? AND message_id IS NOT NULL
        ORDER BY message_id`).all(threadId, minimumSequence) as Array<{ message_id: string }>;
    return rows.map((row) => row.message_id);
  }

  private listLegacyV2MessageIdsFromRunEvents(threadId: string, minimumSequence: number): string[] {
    const indexed = this.v2.hasConversation(threadId) ? this.listConversationRuntimeSources(threadId) : [];
    const rows = (indexed.length > 0 ? indexed : this.listThreadRunEvents(threadId)).filter(
      (event) => event.sequence >= minimumSequence,
    );
    return [
      ...new Set(
        rows
          .map(conversationV2MessageIdForLegacyEvent)
          .filter((messageId): messageId is string => Boolean(messageId)),
      ),
    ].sort();
  }

  private listRuntimeSourceIdsFromSequence(threadId: string, minimumSequence: number): string[] {
    return this.listConversationRuntimeSources(threadId)
      .filter((event) => event.sequence >= minimumSequence)
      .map((event) => event.id)
      .filter(Boolean);
  }

  /** Native provider boundary: no V1 row write, coalescing query or projection is involved. */
  appendConversationRuntimeEvent(input: ThreadRunEventInput): ThreadRunEvent {
    const result = this.runtimeWriter.append(sanitizeThreadRunEventForPersistence(input));
    if (!result.duplicate) this.notifyThreadRunEventAppended(result.event);
    return result.event;
  }

  private appendV2ProviderPatch(
    threadId: string,
    inputIds: readonly string[],
    patch: Record<string, unknown>,
    reason: string,
    options: {
      inCurrentTransaction?: boolean;
      onAppendResult?: (result: ConversationAppendResult) => void;
    } = {},
  ): ConversationAppendResult {
    const appendInput = {
      conversationId: threadId,
      eventId: `provider_patch_${stableHash(`${threadId}:${reason}:${inputIds.join(",")}`)}`,
      sourceEventKey: `provider:patch:${stableHash(`${threadId}:${reason}:${inputIds.join(",")}`)}`,
      occurredAt: new Date().toISOString(),
      inputIds,
      patch,
      reason,
    };
    const result = options.inCurrentTransaction
      ? this.v2.appendProviderInputPatchInCurrentTransaction(appendInput, options.onAppendResult)
      : this.v2.appendProviderInputPatch(appendInput);
    if (!options.inCurrentTransaction && !result.duplicate) this.v2.publishCommitted([result]);
    return result;
  }

  /** Host source identities reconstructed from the V2 log, with current normalized text. */
  listConversationRuntimeSources(
    threadId: string,
    options: { historyOrder?: boolean } = {},
  ): ThreadRunEvent[] {
    this.v2.head(threadId);
    const sources = (
      this.db
        .prepare(`SELECT * FROM conversation_provider_events_v2
      WHERE thread_id = ? ORDER BY sequence ASC, id ASC`)
        .all(threadId) as unknown as ThreadRunEventRow[]
    ).map(rowToThreadRunEvent);
    if (!options.historyOrder) return sources;
    // Identity/attribution patches advance version_seq, but must never move
    // an earlier prompt past later work in a destructive history boundary.
    const firstRows = this.db
      .prepare(`SELECT input_id, first_seq FROM conversation_provider_inputs_v2 WHERE conversation_id = ?`)
      .all(threadId) as Array<{ input_id: string; first_seq: number }>;
    const firstSequences = new Map(firstRows.map((row) => [row.input_id, row.first_seq]));
    return sources
      .map((source) => ({ ...source, sequence: firstSequences.get(source.id)! }))
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  }

  appendThreadRunEvent(event: ThreadRunEventInput): ThreadRunEvent {
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.storageFailure,
        "Legacy thread run event writes are disabled after the V2 storage cutover.",
      );
    }
    const sanitized = sanitizeThreadRunEventForPersistence(event);
    const normalized = withLegacyConversationV2MessageIdentity({
      ...sanitized,
      metadata: { ...(sanitized.metadata ?? {}), legacyCompat: true },
    });
    const v2Results: ConversationAppendResult[] = [];
    let result: { event: ThreadRunEvent; changed: boolean };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      result = this.appendThreadRunEventInCurrentTransaction(normalized, v2Results);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error; the database may already have rolled back.
      }
      throw error;
    }
    if (result!.changed) {
      this.rememberHotThreadRunEvent(result!.event);
      this.updateProjectionEventCache(result!.event);
      this.v2.publishCommitted(v2Results);
      this.notifyThreadRunEventAppended(result!.event);
    }
    return result!.event;
  }

  /**
   * Writes the legacy row and its V2 bridge events without opening a nested
   * transaction. All cache/listener work is deliberately deferred to the
   * caller after COMMIT.
   */
  private appendThreadRunEventInCurrentTransaction(
    event: ThreadRunEventInput,
    v2Results: ConversationAppendResult[],
  ): { event: ThreadRunEvent; changed: boolean } {
    const existing = this.getThreadRunEvent(event.threadId, event.id);
    if (existing) {
      const upgraded = mergeRicherThreadRunEvent(existing, event);
      if (!upgraded) return { event: existing, changed: false };
      const versioned = shouldAdvanceThreadRunEventSequence(existing)
        ? { ...upgraded, sequence: this.nextThreadRunEventSequence(event.threadId) }
        : upgraded;
      this.db
        .prepare(
          `UPDATE thread_run_events
              SET sequence = ?, scope = ?, role = ?, agent_id = ?, parent_agent_id = ?,
                  parent_tool_use_id = ?, run_attempt_id = ?, request_id = ?, stream_key = ?,
                  stream_state = ?, message = ?, metadata_json = ?, observed_at = ?
            WHERE thread_id = ? AND id = ?`,
        )
        .run(
          versioned.sequence,
          versioned.scope,
          versioned.role ?? null,
          versioned.agentId ?? null,
          versioned.parentAgentId ?? null,
          versioned.parentToolUseId ?? null,
          versioned.runAttemptId ?? null,
          versioned.requestId ?? null,
          versioned.streamKey ?? null,
          versioned.streamState,
          versioned.message,
          versioned.metadata ? JSON.stringify(versioned.metadata) : null,
          versioned.observedAt,
          versioned.threadId,
          versioned.id,
        );
      appendLegacyThreadRunEventToConversationV2(this.v2, versioned, {
        inCurrentTransaction: true,
        onAppendResult: (appendResult) => v2Results.push(appendResult),
      });
      return { event: versioned, changed: true };
    }

    const record: ThreadRunEvent = {
      id: event.id,
      threadId: event.threadId,
      sequence: event.sequence ?? this.nextThreadRunEventSequence(event.threadId),
      eventType: event.eventType,
      scope: event.scope,
      streamState: event.streamState,
      message: event.message,
      observedAt: event.observedAt,
      ...(event.role?.trim() && { role: event.role.trim() }),
      ...(event.agentId?.trim() && { agentId: event.agentId.trim() }),
      ...(event.parentAgentId?.trim() && { parentAgentId: event.parentAgentId.trim() }),
      ...(event.parentToolUseId?.trim() && { parentToolUseId: event.parentToolUseId.trim() }),
      ...(event.runAttemptId?.trim() && { runAttemptId: event.runAttemptId.trim() }),
      ...(event.requestId?.trim() && { requestId: event.requestId.trim() }),
      ...(event.streamKey?.trim() && { streamKey: event.streamKey.trim() }),
      ...(event.metadata && { metadata: event.metadata }),
    };

    this.db
      .prepare(
        `INSERT INTO thread_run_events (
           id, thread_id, sequence, event_type, scope, role, agent_id,
           parent_agent_id, parent_tool_use_id, run_attempt_id, request_id, stream_key,
           stream_state, message, metadata_json, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.threadId,
        record.sequence,
        record.eventType,
        record.scope,
        record.role ?? null,
        record.agentId ?? null,
        record.parentAgentId ?? null,
        record.parentToolUseId ?? null,
        record.runAttemptId ?? null,
        record.requestId ?? null,
        record.streamKey ?? null,
        record.streamState,
        record.message,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.observedAt,
      );
    const nextSequence = this.nextThreadRunEventSequences.get(record.threadId);
    if (nextSequence !== undefined && record.sequence >= nextSequence) {
      this.nextThreadRunEventSequences.set(record.threadId, record.sequence + 1);
    }
    appendLegacyThreadRunEventToConversationV2(this.v2, record, {
      inCurrentTransaction: true,
      onAppendResult: (appendResult) => v2Results.push(appendResult),
    });
    return { event: record, changed: true };
  }

  /** Rewrites persisted run events when a local placeholder request id is adopted upstream. */
  rekeyThreadRunRequestId(threadId: string, fromRequestId: string, toRequestId: string): number {
    const from = fromRequestId.trim();
    const to = toRequestId.trim();
    if (!from || !to || from === to) {
      return 0;
    }
    const hasV2Conversation = this.v2.hasConversation(threadId);
    const ids = (hasV2Conversation ? this.listConversationRuntimeSources(threadId) : [])
      .filter((event) => event.requestId === from)
      .map((event) => event.id);
    if (ids.length > 0) {
      this.appendV2ProviderPatch(threadId, ids, { requestId: to }, `request-rekey:${from}:${to}`);
      return ids.length;
    }
    if (
      this.isV2OnlyStorage() ||
      (hasV2Conversation && this.listConversationRuntimeSources(threadId).length > 0)
    ) {
      return 0;
    }
    const result = this.db
      .prepare(
        `UPDATE thread_run_events
            SET request_id = ?
          WHERE thread_id = ? AND request_id = ?`,
      )
      .run(to, threadId, from);
    const changes = Number(result.changes ?? 0);
    if (changes > 0) {
      this.invalidateThreadRunEventCaches(threadId);
    }
    return changes;
  }

  /**
   * Exact late-bind patch for request.started/terminal projection rows.
   * Updates only by threadId + logicalRequestId. Conflicting agentId/role fail closed.
   * All-or-nothing inside a single IMMEDIATE transaction — never partial row updates.
   */
  attributeThreadRunEventsByLogicalRequestId(
    threadId: string,
    logicalRequestId: string,
    input: { agentId: string; role?: string },
  ): { updated: number; conflict: boolean } {
    const trimmedLogical = logicalRequestId.trim();
    const trimmedAgentId = input.agentId.trim();
    const expectedRole = input.role?.trim();
    if (!trimmedLogical || !trimmedAgentId) {
      return { updated: 0, conflict: false };
    }
    const hasV2Conversation = this.v2.hasConversation(threadId);
    const sources = (hasV2Conversation ? this.listConversationRuntimeSources(threadId) : []).filter(
      (event) => event.requestId === trimmedLogical,
    );
    if (sources.length > 0) {
      for (const event of sources) {
        if (event.agentId && event.agentId !== trimmedAgentId) return { updated: 0, conflict: true };
        if (expectedRole && event.role && event.role !== "thinking" && event.role !== expectedRole) {
          return { updated: 0, conflict: true };
        }
      }
      const updated = sources.filter(
        (event) =>
          event.agentId !== trimmedAgentId ||
          event.scope !== "agent" ||
          (expectedRole && event.role !== expectedRole),
      );
      if (updated.length > 0) {
        this.appendV2ProviderPatch(
          threadId,
          sources.map((event) => event.id),
          {
            agentId: trimmedAgentId,
            scope: "agent",
            ...(expectedRole ? { role: expectedRole } : {}),
          },
          `logical-attribute:${trimmedLogical}:${trimmedAgentId}`,
        );
      }
      return { updated: updated.length, conflict: false };
    }
    if (
      this.isV2OnlyStorage() ||
      (hasV2Conversation && this.listConversationRuntimeSources(threadId).length > 0)
    ) {
      return { updated: 0, conflict: false };
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT id, event_type, role, agent_id, scope
           FROM thread_run_events
           WHERE thread_id = ? AND request_id = ?`,
        )
        .all(threadId, trimmedLogical) as Array<{
        id: string;
        event_type: string;
        role: string | null;
        agent_id: string | null;
        scope: string;
      }>;
      if (rows.length === 0) {
        this.db.exec("COMMIT");
        return { updated: 0, conflict: false };
      }

      for (const row of rows) {
        const existing = row.agent_id?.trim();
        if (existing && existing !== trimmedAgentId) {
          this.db.exec("ROLLBACK");
          return { updated: 0, conflict: true };
        }
        if (expectedRole && row.role?.trim() && row.role.trim() !== expectedRole && row.role !== "thinking") {
          this.db.exec("ROLLBACK");
          return { updated: 0, conflict: true };
        }
      }

      const update = this.db.prepare(
        `UPDATE thread_run_events
         SET agent_id = ?, role = COALESCE(?, role), scope = 'agent'
         WHERE thread_id = ? AND id = ?`,
      );
      let updated = 0;
      for (const row of rows) {
        const existingAgentId = row.agent_id?.trim() ?? "";
        const nextRole = expectedRole && row.role !== "thinking" ? expectedRole : null;
        const roleAlreadyOk =
          row.role === "thinking" || !expectedRole || (row.role?.trim() ?? "") === expectedRole;
        const alreadyNormalized =
          existingAgentId === trimmedAgentId && row.scope === "agent" && roleAlreadyOk;
        if (alreadyNormalized) {
          continue;
        }
        const result = update.run(trimmedAgentId, nextRole, threadId, row.id);
        updated += Number(result.changes ?? 0);
      }
      this.db.exec("COMMIT");
      if (updated > 0) {
        this.invalidateThreadRunEventCaches(threadId);
      }
      return { updated, conflict: false };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure after primary error
      }
      throw error;
    }
  }

  attributeThreadRunEventsBySdkMessageIds(
    threadId: string,
    messageIds: readonly string[],
    agentId: string,
    onConflict?: (input: {
      eventId: string;
      messageId: string;
      existingAgentId: string;
      incomingAgentId: string;
    }) => void,
  ): number {
    const normalizedAgentId = agentId.trim();
    const normalizedMessageIds = new Set(messageIds.map((messageId) => messageId.trim()).filter(Boolean));
    if (!normalizedAgentId || normalizedMessageIds.size === 0) {
      return 0;
    }
    const hasV2Conversation = this.v2.hasConversation(threadId);
    const sources = (hasV2Conversation ? this.listConversationRuntimeSources(threadId) : []).filter(
      (event) => {
        const sdkMessageId =
          typeof event.metadata?.sdkMessageId === "string" ? event.metadata.sdkMessageId.trim() : "";
        return sdkMessageId && normalizedMessageIds.has(sdkMessageId);
      },
    );
    if (sources.length > 0) {
      const exactAgent = this.listAgentInstances(threadId).find(
        (candidate) => candidate.agentId === normalizedAgentId,
      );
      const patch: Record<string, unknown> = {
        agentId: normalizedAgentId,
        scope: "agent",
        ...(exactAgent?.role ? { role: exactAgent.role } : {}),
        ...(exactAgent?.parentAgentId ? { parentAgentId: exactAgent.parentAgentId } : {}),
        ...(exactAgent?.parentToolUseId ? { parentToolUseId: exactAgent.parentToolUseId } : {}),
      };
      const patchedIds: string[] = [];
      for (const event of sources) {
        if (event.agentId && event.agentId !== normalizedAgentId) {
          const sdkMessageId =
            typeof event.metadata?.sdkMessageId === "string" ? event.metadata.sdkMessageId : "";
          onConflict?.({
            eventId: event.id,
            messageId: sdkMessageId,
            existingAgentId: event.agentId,
            incomingAgentId: normalizedAgentId,
          });
        }
        patchedIds.push(event.id);
      }
      this.appendV2ProviderPatch(
        threadId,
        patchedIds,
        patch,
        `sdk-message-attribute:${normalizedAgentId}:${[...normalizedMessageIds].sort().join(",")}`,
      );
      return sources.length;
    }
    if (
      this.isV2OnlyStorage() ||
      (hasV2Conversation && this.listConversationRuntimeSources(threadId).length > 0)
    ) {
      return 0;
    }
    const exactAgent = this.listAgentInstances(threadId).find(
      (candidate) => candidate.agentId === normalizedAgentId,
    );
    const exactRole = exactAgent?.role.trim();
    const exactParentAgentId = exactAgent?.parentAgentId?.trim();
    const exactParentToolUseId = exactAgent?.parentToolUseId?.trim();
    const rows = this.db
      .prepare(
        `SELECT id, event_type, role, agent_id, parent_agent_id, parent_tool_use_id, scope, metadata_json
         FROM thread_run_events
         WHERE thread_id = ? AND metadata_json IS NOT NULL`,
      )
      .all(threadId) as Array<{
      id: string;
      event_type: string;
      role: string | null;
      agent_id: string | null;
      parent_agent_id: string | null;
      parent_tool_use_id: string | null;
      scope: string;
      metadata_json: string | null;
    }>;
    const update = this.db.prepare(
      `UPDATE thread_run_events
       SET role = ?, agent_id = ?, parent_agent_id = ?, parent_tool_use_id = ?,
           scope = 'agent', metadata_json = ?
       WHERE thread_id = ? AND id = ?`,
    );
    const plannerSessionId = this.getSdkSession(threadId)?.sessionId?.trim();
    let updated = 0;
    for (const row of rows) {
      const metadata = parseJsonRecord(row.metadata_json);
      const sdkMessageId = typeof metadata?.sdkMessageId === "string" ? metadata.sdkMessageId.trim() : "";
      if (!sdkMessageId || !normalizedMessageIds.has(sdkMessageId)) {
        continue;
      }
      const existingAgentId = row.agent_id?.trim();
      if (existingAgentId && existingAgentId !== normalizedAgentId && existingAgentId !== plannerSessionId) {
        onConflict?.({
          eventId: row.id,
          messageId: sdkMessageId,
          existingAgentId,
          incomingAgentId: normalizedAgentId,
        });
      }

      const nextRole =
        exactRole && row.role !== "thinking" && !row.event_type.startsWith("thinking.")
          ? exactRole
          : row.role;
      const nextParentAgentId = exactParentAgentId ?? row.parent_agent_id;
      const nextParentToolUseId = exactParentToolUseId ?? row.parent_tool_use_id;
      let nextMetadataJson = row.metadata_json;
      const metadataParentToolUseId =
        typeof metadata?.parentToolUseId === "string" ? metadata.parentToolUseId.trim() : "";
      const metadataParentToolUseIdSnake =
        typeof metadata?.parent_tool_use_id === "string" ? metadata.parent_tool_use_id.trim() : "";
      if (
        exactParentToolUseId &&
        (metadataParentToolUseId !== exactParentToolUseId ||
          metadataParentToolUseIdSnake !== exactParentToolUseId)
      ) {
        nextMetadataJson = JSON.stringify({
          ...(metadata ?? {}),
          parentToolUseId: exactParentToolUseId,
          parent_tool_use_id: exactParentToolUseId,
        });
      }

      if (
        existingAgentId === normalizedAgentId &&
        row.scope === "agent" &&
        row.role === nextRole &&
        row.parent_agent_id === nextParentAgentId &&
        row.parent_tool_use_id === nextParentToolUseId &&
        row.metadata_json === nextMetadataJson
      ) {
        continue;
      }
      const result = update.run(
        nextRole,
        normalizedAgentId,
        nextParentAgentId,
        nextParentToolUseId,
        nextMetadataJson,
        threadId,
        row.id,
      );
      updated += Number(result.changes ?? 0);
    }
    if (updated > 0) {
      this.invalidateThreadRunEventCaches(threadId);
    }
    return updated;
  }

  listThreadRunEvents(threadId: string): ThreadRunEvent[] {
    if (this.isV2OnlyStorage()) {
      this.assertV2OnlyReadStream(threadId);
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, sequence, event_type, scope, role, agent_id,
                parent_agent_id, parent_tool_use_id, run_attempt_id, request_id, stream_key,
                stream_state, message, metadata_json, observed_at
         FROM thread_run_events
         WHERE thread_id = ?
         ORDER BY sequence ASC, observed_at ASC, id ASC`,
      )
      .all(threadId) as unknown as ThreadRunEventRow[];
    return rows.map(rowToThreadRunEvent);
  }

  /**
   * Projection reads collapse legacy cumulative stream rows. New streams are upserted in place,
   * while this query keeps existing large databases responsive without destructive migration.
   */
  getThreadRunEventMaxSequence(threadId: string): number {
    if (this.isV2OnlyStorage()) {
      return this.v2.head(threadId.trim()).lastSeq;
    }
    if (this.v2.hasConversation(threadId) && this.listConversationRuntimeSources(threadId).length === 0) {
      const legacy = this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM thread_run_events WHERE thread_id = ?`,
        )
        .get(threadId) as { max_sequence?: number } | undefined;
      return Number(legacy?.max_sequence ?? 0);
    }
    if (this.v2.hasConversation(threadId)) {
      return this.v2.head(threadId.trim()).lastSeq;
    }
    const legacy = this.db
      .prepare(`SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM thread_run_events WHERE thread_id = ?`)
      .get(threadId) as { max_sequence?: number } | undefined;
    return Number(legacy?.max_sequence ?? 0);
  }

  getThreadFeedSkeleton(threadId: string): ThreadFeedSkeletonRecord | undefined {
    // V2-only Feed is folded from the conversation event/effect stream. The
    // transitional skeleton is retained only for legacy migration/replay and
    // must never become a second production read model after cutover.
    if (this.isV2OnlyStorage()) {
      return undefined;
    }
    const id = threadId.trim();
    if (!id) {
      return undefined;
    }
    const row = this.v2.getFeedSkeletonRow(id);
    if (!row?.snapshot_json?.trim()) {
      return undefined;
    }
    try {
      const snapshot = JSON.parse(row.snapshot_json) as ThreadRunProjectionSnapshot;
      if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.timeline)) {
        return undefined;
      }
      const patchState = parseFeedSkeletonPatchState(row.auxiliary_json);
      return {
        historyRevision: row.history_revision,
        maxEventSequence: row.max_event_sequence,
        snapshot,
        ...(patchState && { patchState }),
      };
    } catch {
      return undefined;
    }
  }

  saveThreadFeedSkeleton(
    threadId: string,
    input: {
      historyRevision: number;
      maxEventSequence: number;
      snapshot: ThreadRunProjectionSnapshot;
      patchState?: ThreadFeedSkeletonRecord["patchState"];
    },
  ): void {
    if (this.isV2OnlyStorage()) {
      return;
    }
    const id = threadId.trim();
    if (!id) {
      return;
    }
    const now = new Date().toISOString();
    const auxiliaryJson = input.patchState ? JSON.stringify(input.patchState) : null;
    this.v2.saveFeedSkeletonRow({
      conversationId: id,
      historyRevision: input.historyRevision,
      maxEventSequence: input.maxEventSequence,
      snapshotJson: JSON.stringify(input.snapshot),
      auxiliaryJson,
      updatedAt: now,
    });
  }

  touchThreadFeedSkeletonSequence(threadId: string, maxEventSequence: number): void {
    if (this.isV2OnlyStorage()) {
      return;
    }
    const id = threadId.trim();
    if (!id || !Number.isFinite(maxEventSequence)) {
      return;
    }
    const now = new Date().toISOString();
    this.v2.touchFeedSkeletonSequence(id, Math.floor(maxEventSequence), now);
  }

  deleteThreadFeedSkeleton(threadId: string): void {
    if (this.isV2OnlyStorage()) {
      return;
    }
    const id = threadId.trim();
    if (!id) {
      return;
    }
    this.v2.deleteFeedSkeleton(id);
  }

  listThreadRunEventsForProjection(threadId: string, maxEvents?: number): ThreadRunEvent[] {
    const boundedMaxEvents =
      typeof maxEvents === "number" && Number.isFinite(maxEvents)
        ? Math.max(1, Math.floor(maxEvents))
        : undefined;
    const cacheMaxEvents = boundedMaxEvents ?? FULL_PROJECTION_EVENT_CACHE_MAX;
    const v2Only = this.isV2OnlyStorage();
    const hasV2Conversation = this.v2.hasConversation(threadId);
    if (v2Only && !hasV2Conversation) {
      // V2-only projection reads remain fail-closed; the compatibility branch
      // below is solely for pre-cutover audit and migration parity.
      this.requireV2RunStream(threadId);
    }
    // Never reuse a cache populated by the transitional projection after cutover.
    // V2-only callers read the V2 provider-event index directly and must not see
    // a stale legacy event even if the mode changed without a process restart.
    const cached = v2Only ? undefined : this.projectionEventCache.get(threadId);
    if (cached?.maxEvents === cacheMaxEvents) {
      this.touchProjectionEventCache(threadId, cached);
      return cached.events;
    }
    const v2Events = hasV2Conversation ? this.listConversationRuntimeSources(threadId) : [];
    // A pre-migration compatibility row can have a V2 message/detail but no
    // provider-input receipt. Keep that narrow legacy read until the one-time
    // migration has supplied the source index; native runtime streams always
    // have at least one V2 provider input.
    const all = v2Only
      ? v2Events
      : v2Events.length > 0
        ? v2Events
        : collapseLegacyProjectionEvents(this.listThreadRunEvents(threadId));
    const events = boundedMaxEvents ? all.slice(Math.max(0, all.length - boundedMaxEvents)) : all;
    if (!v2Only) {
      this.rememberProjectionEvents(threadId, cacheMaxEvents, events);
    }
    return events;
  }

  listProjectionEventCacheThreadIds(): string[] {
    return [...this.projectionEventCache.keys()];
  }

  /**
   * Drop in-memory projection working set for a thread.
   * Does not delete SQLite feed skeletons or run events.
   */
  releaseThreadProjectionWorkingMemory(threadId: string): void {
    const id = threadId.trim();
    if (!id) {
      return;
    }
    this.projectionEventCache.delete(id);
    this.nextThreadRunEventSequences.delete(id);
    const prefix = `${id}\0`;
    for (const cacheKey of this.hotThreadRunEventCache.keys()) {
      if (cacheKey.startsWith(prefix)) {
        this.hotThreadRunEventCache.delete(cacheKey);
      }
    }
  }

  /** Removes legacy cumulative stream prefixes now that stream rows are updated in place. */
  compactLegacyThreadRunStreamEvents(): number {
    if (this.isV2OnlyStorage()) return 0;
    const result = this.db
      .prepare(
        `DELETE FROM thread_run_events AS stale
         WHERE stale.event_type IN ('message.delta', 'thinking.delta')
           AND stale.stream_key IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM thread_run_events AS newer
             WHERE newer.thread_id = stale.thread_id
               AND newer.event_type = stale.event_type
               AND newer.stream_key = stale.stream_key
               AND newer.request_id IS stale.request_id
               AND newer.run_attempt_id IS stale.run_attempt_id
               AND newer.sequence > stale.sequence
           )`,
      )
      .run();
    const removed = Number(result.changes ?? 0);
    if (removed > 0) {
      this.hotThreadRunEventCache.clear();
      this.projectionEventCache.clear();
      this.nextThreadRunEventSequences.clear();
    }
    return removed;
  }

  clearThreadRunEvents(threadId: string): void {
    if (this.isV2OnlyStorage()) {
      this.assertV2OnlyReadStream(threadId);
      this.releaseThreadProjectionWorkingMemory(threadId);
      return;
    }
    this.db.prepare(`DELETE FROM thread_run_events WHERE thread_id = ?`).run(threadId);
    this.invalidateThreadRunEventCaches(threadId);
  }

  private getV2SubagentSessionTimings(threadId: string): ThreadSubagentSessionTiming[] {
    const snapshot = this.v2.getProjectionSnapshot(threadId);
    const raw = snapshot?.subagentTimings;
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Conversation V2 subagent timings are invalid: ${threadId}`,
      );
    }
    return raw as ThreadSubagentSessionTiming[];
  }

  private saveV2SubagentSessionTimings(threadId: string, timings: ThreadSubagentSessionTiming[]): void {
    this.updateConversationV2ProjectionExtras(threadId, {
      subagentTimings: timings,
    });
  }

  upsertSubagentSessionActive(input: {
    threadId: string;
    role: RuntimeAgentRole;
    agentId: string;
    phase: SubagentRunPhase;
    todoId?: string;
    missionKey?: string;
  }): void {
    const now = new Date().toISOString();
    this.v2.initialize();
    if (this.v2.hasConversation(input.threadId) || this.isV2OnlyStorage()) {
      if (!this.v2.hasConversation(input.threadId)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 subagent stream is missing: ${input.threadId}`,
        );
      }
      const current = this.getV2SubagentSessionTimings(input.threadId);
      const previous = current.find((entry) => entry.agentId === input.agentId);
      const next: ThreadSubagentSessionTiming = {
        agentId: input.agentId,
        role: input.role,
        phase: input.phase,
        status: "active",
        startedAt: previous?.startedAt ?? now,
        lastActiveAt: now,
        accumulatedMs: previous?.accumulatedMs ?? 0,
        durationMs: previous?.durationMs ?? 0,
      };
      this.saveV2SubagentSessionTimings(input.threadId, [
        ...current.filter((entry) => entry.agentId !== input.agentId),
        next,
      ]);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO thread_subagent_sessions (
           thread_id, role, agent_id, phase, status, todo_id, mission_key,
           started_at, last_active_at, ended_at, accumulated_ms, updated_at
         ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, 0, ?)
         ON CONFLICT(thread_id, agent_id) DO UPDATE SET
           role = excluded.role,
           phase = excluded.phase,
           status = 'active',
           todo_id = COALESCE(excluded.todo_id, todo_id),
           mission_key = COALESCE(excluded.mission_key, mission_key),
           last_active_at = excluded.last_active_at,
           ended_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.threadId,
        input.role,
        input.agentId,
        input.phase,
        input.todoId ?? null,
        input.missionKey ?? null,
        now,
        now,
        now,
      );
  }

  markSubagentSessionStopped(threadId: string, agentId: string): void {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    this.v2.initialize();
    if (this.v2.hasConversation(threadId) || this.isV2OnlyStorage()) {
      if (!this.v2.hasConversation(threadId)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 subagent stream is missing: ${threadId}`,
        );
      }
      const current = this.getV2SubagentSessionTimings(threadId);
      const previous = current.find((entry) => entry.agentId === agentId);
      if (!previous) return;
      const lastActiveMs = Date.parse(previous.lastActiveAt);
      const segmentMs =
        Number.isFinite(lastActiveMs) && lastActiveMs > 0 ? Math.max(0, nowMs - lastActiveMs) : 0;
      const accumulatedMs = previous.accumulatedMs + segmentMs;
      this.saveV2SubagentSessionTimings(
        threadId,
        current.map((entry) =>
          entry.agentId === agentId
            ? {
                ...entry,
                status: "stopped",
                endedAt: now,
                lastActiveAt: now,
                accumulatedMs,
                durationMs: accumulatedMs,
              }
            : entry,
        ),
      );
      return;
    }
    const row = this.db
      .prepare(
        `SELECT last_active_at, accumulated_ms
         FROM thread_subagent_sessions
         WHERE thread_id = ? AND agent_id = ?`,
      )
      .get(threadId, agentId) as { last_active_at: string | null; accumulated_ms: number | null } | undefined;
    const lastActiveMs = row?.last_active_at ? Date.parse(row.last_active_at) : nowMs;
    const segmentMs =
      Number.isFinite(lastActiveMs) && lastActiveMs > 0 ? Math.max(0, nowMs - lastActiveMs) : 0;
    const accumulatedMs = (row?.accumulated_ms ?? 0) + segmentMs;
    this.db
      .prepare(
        `UPDATE thread_subagent_sessions
         SET status = 'stopped',
             ended_at = ?,
             accumulated_ms = ?,
             updated_at = ?
         WHERE thread_id = ? AND agent_id = ?`,
      )
      .run(now, accumulatedMs, now, threadId, agentId);
  }

  markSubagentSessionHandedOff(threadId: string, agentId: string): void {
    const now = new Date().toISOString();
    this.v2.initialize();
    if (this.v2.hasConversation(threadId) || this.isV2OnlyStorage()) {
      if (!this.v2.hasConversation(threadId)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 subagent stream is missing: ${threadId}`,
        );
      }
      const current = this.getV2SubagentSessionTimings(threadId);
      this.saveV2SubagentSessionTimings(
        threadId,
        current.map((entry) =>
          entry.agentId === agentId
            ? { ...entry, status: "handed_off", endedAt: entry.endedAt ?? now, lastActiveAt: now }
            : entry,
        ),
      );
      return;
    }
    this.db
      .prepare(
        `UPDATE thread_subagent_sessions
         SET status = 'handed_off',
             ended_at = COALESCE(ended_at, ?),
             updated_at = ?
         WHERE thread_id = ? AND agent_id = ?`,
      )
      .run(now, now, threadId, agentId);
  }

  upsertSubagentMetrics(
    threadId: string,
    input: {
      agentId: string;
      role: RuntimeAgentRole;
      status: SubagentMetricsStatus;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      contextOccupied: number;
      contextLimit?: number;
      ecoCostUsd: number;
      ecoCostBreakdown: TokenCostBreakdown;
      modelId?: string;
      lastRequestKey?: string;
    },
  ): void {
    const now = new Date().toISOString();
    this.v2.initialize();
    if (this.v2.hasConversation(threadId) || this.isV2OnlyStorage()) {
      if (!this.v2.hasConversation(threadId)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 subagent metrics stream is missing: ${threadId}`,
        );
      }
      const snapshot = this.v2.getProjectionSnapshot(threadId);
      const raw = snapshot?.subagentMetrics;
      if (raw !== undefined && !Array.isArray(raw)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 subagent metrics are invalid: ${threadId}`,
        );
      }
      const current = (raw as ThreadSubagentMetricsSummary[] | undefined) ?? [];
      const next: ThreadSubagentMetricsSummary = {
        agentId: input.agentId,
        role: input.role,
        status: input.status,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheCreationTokens: input.cacheCreationTokens,
        contextOccupied: input.contextOccupied,
        ...(input.contextLimit !== undefined ? { contextLimit: input.contextLimit } : {}),
        ecoCostUsd: input.ecoCostUsd,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.lastRequestKey ? { lastRequestKey: input.lastRequestKey } : {}),
        ecoCostBreakdown: input.ecoCostBreakdown,
      };
      this.updateConversationV2ProjectionExtras(threadId, {
        subagentMetrics: [...current.filter((entry) => entry.agentId !== input.agentId), next],
      });
      return;
    }
    this.db
      .prepare(
        `INSERT INTO thread_subagent_metrics (
           thread_id, agent_id, role, status,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           context_occupied, context_limit, eco_cost_usd, eco_cost_breakdown_json,
           model_id, last_request_key, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, agent_id) DO UPDATE SET
           role = excluded.role,
           status = excluded.status,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_creation_tokens = excluded.cache_creation_tokens,
           context_occupied = excluded.context_occupied,
           context_limit = excluded.context_limit,
           eco_cost_usd = excluded.eco_cost_usd,
           eco_cost_breakdown_json = excluded.eco_cost_breakdown_json,
           model_id = excluded.model_id,
           last_request_key = excluded.last_request_key,
           updated_at = excluded.updated_at`,
      )
      .run(
        threadId,
        input.agentId,
        input.role,
        input.status,
        input.inputTokens,
        input.outputTokens,
        input.cacheReadTokens,
        input.cacheCreationTokens,
        input.contextOccupied,
        input.contextLimit ?? null,
        input.ecoCostUsd,
        JSON.stringify(input.ecoCostBreakdown),
        input.modelId ?? null,
        input.lastRequestKey ?? null,
        now,
      );
  }

  listSubagentMetrics(threadId: string): ThreadSubagentMetricsRecord[] {
    this.v2.initialize();
    if (this.v2.hasConversation(threadId)) {
      const snapshot = this.v2.getProjectionSnapshot(threadId);
      const raw = snapshot?.subagentMetrics;
      if (raw !== undefined && !Array.isArray(raw)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 subagent metrics are invalid: ${threadId}`,
        );
      }
      return ((raw as ThreadSubagentMetricsSummary[] | undefined) ?? []).map((entry) => ({
        threadId,
        agentId: entry.agentId,
        role: entry.role,
        status: entry.status,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheCreationTokens: entry.cacheCreationTokens,
        contextOccupied: entry.contextOccupied,
        ...(entry.contextLimit !== undefined ? { contextLimit: entry.contextLimit } : {}),
        ecoCostUsd: entry.ecoCostUsd,
        ecoCostBreakdown: entry.ecoCostBreakdown ?? {
          inputUsd: 0,
          outputUsd: 0,
          cacheReadUsd: 0,
          cacheCreationUsd: 0,
          totalUsd: entry.ecoCostUsd,
        },
        ...(entry.modelId ? { modelId: entry.modelId } : {}),
        ...(entry.lastRequestKey ? { lastRequestKey: entry.lastRequestKey } : {}),
        updatedAt: new Date().toISOString(),
      }));
    }
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Conversation V2 subagent metrics stream is missing: ${threadId}`,
      );
    }
    const rows = this.db
      .prepare(
        `SELECT thread_id, agent_id, role, status,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                context_occupied, context_limit, eco_cost_usd, eco_cost_breakdown_json,
                model_id, last_request_key, updated_at
         FROM thread_subagent_metrics
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as Array<{
      thread_id: string;
      agent_id: string;
      role: string;
      status: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      context_occupied: number;
      context_limit: number | null;
      eco_cost_usd: number;
      eco_cost_breakdown_json: string | null;
      model_id: string | null;
      last_request_key: string | null;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      threadId: row.thread_id,
      agentId: row.agent_id,
      role: row.role as RuntimeAgentRole,
      status: row.status as SubagentMetricsStatus,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      contextOccupied: row.context_occupied,
      ...(row.context_limit !== null && { contextLimit: row.context_limit }),
      ecoCostUsd: row.eco_cost_usd,
      ecoCostBreakdown: parseEcoCostBreakdownJson(row.eco_cost_breakdown_json),
      ...(row.model_id && { modelId: row.model_id }),
      ...(row.last_request_key && { lastRequestKey: row.last_request_key }),
      updatedAt: row.updated_at,
    }));
  }

  clearSubagentMetrics(threadId: string): void {
    this.v2.initialize();
    if (this.v2.hasConversation(threadId)) {
      const snapshot = this.v2.getProjectionSnapshot(threadId);
      const raw = snapshot?.subagentMetrics;
      if (raw !== undefined && !Array.isArray(raw)) {
        throw new ConversationV2Error(
          CONVERSATION_V2_ERROR.integrityFailure,
          `Conversation V2 subagent metrics are invalid: ${threadId}`,
        );
      }
      this.updateConversationV2ProjectionExtras(threadId, { subagentMetrics: [] });
      return;
    }
    if (this.isV2OnlyStorage()) {
      // Deletion clears in-memory metrics after the conversation stream has
      // been removed. Missing storage is already the desired state here.
      return;
    }
    this.db.prepare(`DELETE FROM thread_subagent_metrics WHERE thread_id = ?`).run(threadId);
  }

  listSubagentSessions(threadId: string): ThreadSubagentSessionRecord[] {
    this.v2.initialize();
    if (this.v2.hasConversation(threadId)) {
      return this.getV2SubagentSessionTimings(threadId).map((timing) => ({
        threadId,
        role: timing.role,
        agentId: timing.agentId,
        phase: timing.phase ?? "execution",
        status: timing.status,
        startedAt: timing.startedAt,
        lastActiveAt: timing.lastActiveAt,
        ...(timing.endedAt ? { endedAt: timing.endedAt } : {}),
        accumulatedMs: timing.accumulatedMs,
        updatedAt: timing.lastActiveAt,
      }));
    }
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Conversation V2 subagent stream is missing: ${threadId}`,
      );
    }
    const rows = this.db
      .prepare(
        `SELECT thread_id, role, agent_id, phase, status, todo_id, mission_key,
                started_at, last_active_at, ended_at, accumulated_ms, updated_at
         FROM thread_subagent_sessions
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as Array<{
      thread_id: string;
      role: string;
      agent_id: string;
      phase: string;
      status: string;
      todo_id: string | null;
      mission_key: string | null;
      started_at: string | null;
      last_active_at: string | null;
      ended_at: string | null;
      accumulated_ms: number | null;
      updated_at: string;
    }>;

    return rows.map((row) => {
      const fallbackAt = row.updated_at;
      const startedAt = row.started_at ?? fallbackAt;
      const lastActiveAt = row.last_active_at ?? fallbackAt;
      return {
        threadId: row.thread_id,
        role: row.role as RuntimeAgentRole,
        agentId: row.agent_id,
        phase: row.phase as SubagentRunPhase,
        status: row.status as SubagentSessionStatus,
        ...(row.todo_id ? { todoId: row.todo_id } : {}),
        ...(row.mission_key ? { missionKey: row.mission_key } : {}),
        startedAt,
        lastActiveAt,
        ...(row.ended_at ? { endedAt: row.ended_at } : {}),
        accumulatedMs: row.accumulated_ms ?? 0,
        updatedAt: row.updated_at,
      };
    });
  }

  listResumableSubagentSessions(threadId: string, phase?: SubagentRunPhase): ThreadSubagentSessionRecord[] {
    return this.listSubagentSessions(threadId).filter(
      (row) => row.status === "stopped" && (!phase || row.phase === phase),
    );
  }

  resolveResumeAgentId(input: {
    threadId: string;
    role: RuntimeAgentRole;
    phase: SubagentRunPhase;
    prompt: string;
    todoIdHint?: string;
  }): string | undefined {
    const records = this.listSubagentSessions(input.threadId);
    return resolveResumeAgentIdFromRecords(records, {
      role: input.role,
      phase: input.phase,
      prompt: input.prompt,
      ...(input.todoIdHint && { todoIdHint: input.todoIdHint }),
      freshRequest: isFreshSubagentRequest(input.prompt),
    });
  }

  clearSubagentSessions(threadId: string): void {
    this.v2.initialize();
    if (this.v2.hasConversation(threadId)) {
      this.saveV2SubagentSessionTimings(threadId, []);
      return;
    }
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Conversation V2 subagent stream is missing: ${threadId}`,
      );
    }
    this.db.prepare(`DELETE FROM thread_subagent_sessions WHERE thread_id = ?`).run(threadId);
  }

  clearSubagentSessionsForPhase(threadId: string, phase: SubagentRunPhase): void {
    this.v2.initialize();
    if (this.v2.hasConversation(threadId)) {
      const timings = this.getV2SubagentSessionTimings(threadId);
      this.saveV2SubagentSessionTimings(
        threadId,
        timings.filter((timing) => (timing.phase ?? "execution") !== phase),
      );
      return;
    }
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.integrityFailure,
        `Conversation V2 subagent stream is missing: ${threadId}`,
      );
    }
    this.db
      .prepare(`DELETE FROM thread_subagent_sessions WHERE thread_id = ? AND phase = ?`)
      .run(threadId, phase);
  }

  saveRouteFingerprint(threadId: string, fingerprint: string): void {
    const previous = this.getRouteFingerprint(threadId);
    if (previous && previous !== fingerprint) {
      this.clearSubagentSessions(threadId);
    }
    this.db
      .prepare(
        `UPDATE threads
         SET routes_fingerprint = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(fingerprint, new Date().toISOString(), threadId);
  }

  getRouteFingerprint(threadId: string): string | undefined {
    const row = this.db.prepare(`SELECT routes_fingerprint FROM threads WHERE id = ?`).get(threadId) as
      | { routes_fingerprint: string | null }
      | undefined;
    const value = row?.routes_fingerprint?.trim();
    return value || undefined;
  }

  /** Lightweight cross-project @ picker rows; never loads prompts or runtime config. */
  searchThreadReferences(
    query: string,
    limit: number,
  ): Array<Pick<ThreadSummary, "id" | "title" | "workspacePath" | "updatedAt">> {
    return this.db
      .prepare(`SELECT id, title, workspace_path AS workspacePath, updated_at AS updatedAt
      FROM threads WHERE instr(lower(title || ' ' || workspace_path), lower(?)) > 0
      ORDER BY updated_at DESC, id DESC LIMIT ?`).all(query, limit) as Array<Pick<ThreadSummary, "id" | "title" | "workspacePath" | "updatedAt">>;
  }

  listThreads(): ThreadSummary[] {
    const rows = this.db
      .prepare(
        `${THREAD_SUMMARY_SELECT}
         ORDER BY threads.created_at DESC`,
      )
      .all() as unknown as ThreadRow[];

    return rows.map(rowToThread);
  }

  /** Thread ids that must keep projection working memory warm while active. */
  listHotProjectionThreadIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM threads
         WHERE status IN ('queued', 'running', 'awaiting_plan')
         ORDER BY updated_at DESC`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  listInitialThreads(limitPerWorkspace = 5): ThreadListInitialResult {
    const workspaces = this.db
      .prepare(
        `SELECT workspace_path
         FROM threads
         WHERE TRIM(workspace_path) <> ''
         GROUP BY workspace_path
         ORDER BY workspace_path ASC`,
      )
      .all() as unknown as Array<{ workspace_path: string }>;
    const threads: ThreadSummary[] = [];
    const pages: Record<string, ThreadListPageMetadata> = {};
    for (const { workspace_path: workspacePath } of workspaces) {
      const page = this.listThreadPage(workspacePath, undefined, limitPerWorkspace);
      const initialIds = new Set(page.threads.map((thread) => thread.id));
      const priorityThreads = this.db
        .prepare(
          `${THREAD_SUMMARY_SELECT}
           WHERE threads.workspace_path = ?
             AND threads.status IN ('queued', 'running', 'awaiting_plan', 'blocked')
           ORDER BY threads.updated_at DESC, threads.created_at DESC, threads.id DESC`,
        )
        .all(workspacePath) as unknown as ThreadRow[];
      threads.push(
        ...page.threads,
        ...priorityThreads.filter((thread) => !initialIds.has(thread.id)).map(rowToThread),
      );
      const hasMore =
        threads.filter((thread) => thread.workspacePath === workspacePath).length < page.totalCount;
      pages[workspacePath] = {
        hasMore,
        totalCount: page.totalCount,
        ...(hasMore && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
    return { threads, pages };
  }

  listThreadPage(workspacePath: string, cursor?: ThreadListCursor, limit = 20): ThreadListPage {
    const normalizedWorkspacePath = workspacePath.trim();
    if (!normalizedWorkspacePath) {
      return { threads: [], hasMore: false, totalCount: 0 };
    }
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const select = `${THREAD_SUMMARY_SELECT}`;
    const rows = cursor
      ? (this.db
          .prepare(
            `${select}
             WHERE threads.workspace_path = ?
               AND (
                 threads.updated_at < ?
                 OR (threads.updated_at = ? AND threads.created_at < ?)
                 OR (
                   threads.updated_at = ?
                   AND threads.created_at = ?
                   AND threads.id < ?
                 )
               )
             ORDER BY threads.updated_at DESC, threads.created_at DESC, threads.id DESC
             LIMIT ?`,
          )
          .all(
            normalizedWorkspacePath,
            cursor.updatedAt,
            cursor.updatedAt,
            cursor.createdAt,
            cursor.updatedAt,
            cursor.createdAt,
            cursor.id,
            boundedLimit + 1,
          ) as unknown as ThreadRow[])
      : (this.db
          .prepare(
            `${select}
             WHERE threads.workspace_path = ?
             ORDER BY threads.updated_at DESC, threads.created_at DESC, threads.id DESC
             LIMIT ?`,
          )
          .all(normalizedWorkspacePath, boundedLimit + 1) as unknown as ThreadRow[]);
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM threads
         WHERE workspace_path = ?`,
      )
      .get(normalizedWorkspacePath) as { count: number };
    const hasMore = rows.length > boundedLimit;
    const pageRows = rows.slice(0, boundedLimit);
    const last = pageRows.at(-1);
    return {
      threads: pageRows.map(rowToThread),
      hasMore,
      totalCount: countRow.count,
      ...(hasMore && last
        ? {
            nextCursor: {
              updatedAt: last.updated_at,
              createdAt: last.created_at,
              id: last.id,
            },
          }
        : {}),
    };
  }

  /** Compact free pages after bulk deletes. No-op gate is caller's responsibility. */
  vacuum(): void {
    this.db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`);
    this.db.exec(`VACUUM;`);
  }

  getThread(threadId: string): ThreadSummary | undefined {
    const row = this.db
      .prepare(
        `${THREAD_SUMMARY_SELECT}
         WHERE threads.id = ?`,
      )
      .get(threadId) as ThreadRow | undefined;

    return row ? rowToThread(row) : undefined;
  }

  getComposerDraft(contextKey: string): ComposerDraftRecord | undefined {
    const key = contextKey.trim();
    if (!key) {
      return undefined;
    }
    const row = this.db
      .prepare(
        `SELECT context_key, prompt, attachments_json, recovery_reason, revision, updated_at
         FROM composer_drafts
         WHERE context_key = ?`,
      )
      .get(key) as
      | {
          context_key: string;
          prompt: string;
          attachments_json: string | null;
          recovery_reason: string | null;
          revision: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    const attachments = parsePromptImageAttachments(row.attachments_json);
    return {
      contextKey: row.context_key,
      prompt: row.prompt,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(row.recovery_reason?.trim() ? { recoveryReason: row.recovery_reason.trim() } : {}),
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  }

  saveComposerDraft(
    contextKey: string,
    prompt: string,
    attachments?: PromptImageAttachment[],
    recoveryReason?: string,
  ): ComposerDraftRecord | undefined {
    const key = contextKey.trim();
    if (!key) {
      throw new Error("Composer draft context key is required.");
    }
    const storedAttachments = attachments?.filter(isPromptImageAttachment) ?? [];
    if (prompt.length === 0 && storedAttachments.length === 0) {
      this.deleteComposerDraft(key);
      return undefined;
    }
    const existing = this.getComposerDraft(key);
    const storedRecoveryReason =
      recoveryReason === undefined ? existing?.recoveryReason : recoveryReason.trim() || undefined;
    if (
      existing?.prompt === prompt &&
      JSON.stringify(existing.attachments ?? []) === JSON.stringify(storedAttachments) &&
      existing.recoveryReason === storedRecoveryReason
    ) {
      return existing;
    }
    const revision = crypto.randomUUID();
    const updatedAt = new Date().toISOString();
    const attachmentsJson = storedAttachments.length > 0 ? JSON.stringify(storedAttachments) : null;
    this.db
      .prepare(
        `INSERT INTO composer_drafts (
           context_key,
           prompt,
           attachments_json,
           recovery_reason,
           revision,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(context_key) DO UPDATE SET
           prompt = excluded.prompt,
           attachments_json = excluded.attachments_json,
           recovery_reason = excluded.recovery_reason,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      )
      .run(key, prompt, attachmentsJson, storedRecoveryReason ?? null, revision, updatedAt);
    return {
      contextKey: key,
      prompt,
      ...(storedAttachments.length > 0 ? { attachments: storedAttachments } : {}),
      ...(storedRecoveryReason ? { recoveryReason: storedRecoveryReason } : {}),
      revision,
      updatedAt,
    };
  }

  deleteComposerDraft(
    contextKey: string,
    expectedRevision?: string,
    options?: { releaseAttachments?: boolean },
  ): boolean {
    const key = contextKey.trim();
    if (!key) {
      return false;
    }
    const existing = this.getComposerDraft(key);
    const expected = expectedRevision?.trim();
    const result = expected
      ? this.db
          .prepare(`DELETE FROM composer_drafts WHERE context_key = ? AND revision = ?`)
          .run(key, expected)
      : this.db.prepare(`DELETE FROM composer_drafts WHERE context_key = ?`).run(key);
    const deleted = Number(result.changes) > 0;
    // Send handoff sets releaseAttachments:false so spool files stay until persistMessageAttachments moves them.
    if (deleted && options?.releaseAttachments !== false) {
      void this.promptImageFileStore?.deleteSpoolContext(key);
      void this.promptImageFileStore?.releasePaths(
        this.promptImageFileStore.collectAttachmentPaths(existing?.attachments),
      );
    }
    return deleted;
  }

  private activityLineMatchesForMerge(
    last: ThreadActivityLine & { id: string },
    line: Omit<ThreadActivityLine, "id"> & { id?: string },
  ): boolean {
    if (last.role !== line.role) {
      return false;
    }
    const lastAgentId = last.agentId?.trim() ?? "";
    const nextAgentId = line.agentId?.trim() ?? "";
    return lastAgentId === nextAgentId;
  }

  appendActivityLine(
    threadId: string,
    line: Omit<ThreadActivityLine, "id"> & { id?: string },
  ): ThreadActivityLine {
    if (this.isV2OnlyStorage()) {
      throw new ConversationV2Error(
        CONVERSATION_V2_ERROR.storageFailure,
        "Legacy activity-line writes are disabled after the V2 storage cutover.",
      );
    }
    const { text: normalizedMessage } = repairActivityText(line.message);
    if (normalizedMessage !== line.message) {
      line = { ...line, message: normalizedMessage };
    }
    const last = this.getLastActivityLine(threadId);
    if (!line.stream && last?.stream && this.activityLineMatchesForMerge(last, line)) {
      const merged = line.message.trim() ? mergeStreamText(last.message, line.message) : last.message;
      this.db.prepare(`UPDATE thread_activity SET message = ?, stream = 0 WHERE id = ?`).run(merged, last.id);
      const finalized = { ...last, message: merged, stream: false };
      logSuspiciousActivityLine(threadId, finalized);
      return finalized;
    }
    if (line.stream && last?.stream && this.activityLineMatchesForMerge(last, line)) {
      const merged = mergeStreamText(last.message, line.message);
      this.db.prepare(`UPDATE thread_activity SET message = ? WHERE id = ?`).run(merged, last.id);
      return { ...last, message: merged };
    }

    const record: ThreadActivityLine = {
      id: line.id ?? `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: line.role,
      message: line.message,
      ...(line.stream !== undefined && { stream: line.stream }),
      ...(line.agentId?.trim() && { agentId: line.agentId.trim() }),
      ...(line.apiError && { apiError: line.apiError }),
    };
    const sdkUserMessageId = line.rewindTarget?.userMessageId?.trim();
    if (sdkUserMessageId) {
      record.rewindTarget = { activityLineId: record.id, userMessageId: sdkUserMessageId };
    }
    this.db
      .prepare(
        `INSERT INTO thread_activity (
           id, thread_id, role, message, stream, agent_id, api_error_json, sdk_user_message_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        threadId,
        record.role,
        record.message,
        line.stream ? 1 : 0,
        record.agentId ?? null,
        record.apiError ? JSON.stringify(record.apiError) : null,
        sdkUserMessageId || null,
        new Date().toISOString(),
      );

    this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), threadId);

    logSuspiciousActivityLine(threadId, record);
    return record;
  }

  listActivityLines(threadId: string): ThreadActivityLine[] {
    const hasV2Conversation = this.v2.hasConversation(threadId);
    const nativeSources = hasV2Conversation ? this.listConversationRuntimeSources(threadId) : [];
    if (nativeSources.length > 0 || (this.isV2OnlyStorage() && hasV2Conversation)) {
      return activityLinesFromNativeSources(nativeSources);
    }
    if (this.isV2OnlyStorage()) {
      this.assertV2OnlyReadStream(threadId);
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, role, message, stream, agent_id, api_error_json, sdk_user_message_id, created_at
         FROM thread_activity
         WHERE thread_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(threadId) as unknown as ActivityRow[];

    const lines = rows.map((row) => {
      const { text, repaired } = repairActivityText(row.message);
      const apiError = parseStoredApiError(row.api_error_json);
      const userMessageId = row.sdk_user_message_id?.trim();
      return {
        id: row.id,
        role: row.role,
        message: repaired ? text : row.message,
        stream: row.stream === 1,
        ...(userMessageId && {
          rewindTarget: { activityLineId: row.id, userMessageId },
        }),
        ...(row.agent_id?.trim() && { agentId: row.agent_id.trim() }),
        ...(apiError && { apiError }),
      };
    });

    return lines;
  }

  savePendingPlan(plan: ThreadPendingPlan & { routesJson: string }): void {
    this.v2.initialize();
    if (this.isV2OnlyStorage()) {
      this.v2.savePendingPlan({
        conversationId: plan.threadId,
        userPrompt: plan.userPrompt,
        analysis: plan.analysis,
        plan: plan.plan,
        workspacePath: plan.workspacePath,
        worktreePath: plan.worktreePath,
        routesJson: plan.routesJson,
        planFilePath: plan.planFilePath ?? null,
        deferredExitPlanToolUseId: plan.deferredExitPlanToolUseId ?? null,
        createdAt: new Date().toISOString(),
      });
      return;
    }
    this.db
      .prepare(
        `INSERT INTO thread_pending_plans (
           thread_id, user_prompt, analysis, plan, workspace_path, worktree_path, routes_json,
           plan_file_path, deferred_exit_plan_tool_use_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
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
        plan.threadId,
        plan.userPrompt,
        plan.analysis,
        plan.plan,
        plan.workspacePath,
        plan.worktreePath,
        plan.routesJson,
        plan.planFilePath?.trim() || null,
        plan.deferredExitPlanToolUseId?.trim() || null,
        new Date().toISOString(),
      );
  }

  getPendingPlan(threadId: string): (ThreadPendingPlan & { routesJson: string }) | undefined {
    this.v2.initialize();
    if (this.isV2OnlyStorage()) {
      const plan = this.v2.getPendingPlan(threadId);
      if (!plan) return undefined;
      return {
        threadId: plan.conversationId,
        userPrompt: plan.userPrompt,
        analysis: plan.analysis,
        plan: plan.plan,
        workspacePath: plan.workspacePath,
        worktreePath: plan.worktreePath,
        routesJson: plan.routesJson,
        ...(plan.planFilePath?.trim() ? { planFilePath: plan.planFilePath.trim() } : {}),
        ...(plan.deferredExitPlanToolUseId?.trim()
          ? { deferredExitPlanToolUseId: plan.deferredExitPlanToolUseId.trim() }
          : {}),
      };
    }
    const row = this.db
      .prepare(
        `SELECT thread_id, user_prompt, analysis, plan, workspace_path, worktree_path, routes_json,
                plan_file_path, deferred_exit_plan_tool_use_id
         FROM thread_pending_plans
         WHERE thread_id = ?`,
      )
      .get(threadId) as
      | {
          thread_id: string;
          user_prompt: string;
          analysis: string;
          plan: string;
          workspace_path: string;
          worktree_path: string;
          routes_json: string;
          plan_file_path: string | null;
          deferred_exit_plan_tool_use_id: string | null;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      threadId: row.thread_id,
      userPrompt: row.user_prompt,
      analysis: row.analysis,
      plan: row.plan,
      workspacePath: row.workspace_path,
      worktreePath: row.worktree_path,
      routesJson: row.routes_json,
      ...(row.plan_file_path?.trim() ? { planFilePath: row.plan_file_path.trim() } : {}),
      ...(row.deferred_exit_plan_tool_use_id?.trim()
        ? { deferredExitPlanToolUseId: row.deferred_exit_plan_tool_use_id.trim() }
        : {}),
    };
  }

  getThreadClaudePlanFilePath(threadId: string): string | undefined {
    const row = this.db.prepare(`SELECT claude_plan_file_path FROM threads WHERE id = ?`).get(threadId) as
      | { claude_plan_file_path: string | null }
      | undefined;
    const path = row?.claude_plan_file_path?.trim();
    return path || undefined;
  }

  setThreadClaudePlanFilePath(threadId: string, planFilePath: string | undefined): void {
    this.db
      .prepare(
        `UPDATE threads
         SET claude_plan_file_path = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(planFilePath?.trim() || null, new Date().toISOString(), threadId);
  }

  clearThreadClaudePlanFilePath(threadId: string): void {
    this.setThreadClaudePlanFilePath(threadId, undefined);
  }

  clearPendingPlan(threadId: string): void {
    this.v2.initialize();
    if (this.isV2OnlyStorage()) {
      this.v2.clearPendingPlan(threadId);
      return;
    }
    this.db.prepare(`DELETE FROM thread_pending_plans WHERE thread_id = ?`).run(threadId);
  }

  clearPendingPlanForCommand(
    threadId: string,
    command: { principalId: string; clientCommandId: string },
    checkpointName: "plan.pending_cleared" | "plan.dismissal_committed" = "plan.pending_cleared",
  ): void {
    this.v2.initialize();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.isV2OnlyStorage()) {
        this.v2.clearPendingPlan(threadId, { inCurrentTransaction: true });
      } else {
        this.db.prepare(`DELETE FROM thread_pending_plans WHERE thread_id = ?`).run(threadId);
      }
      this.v2.recordCommandCheckpointInCurrentTransaction({
        principalId: command.principalId,
        conversationId: threadId,
        clientCommandId: command.clientCommandId,
        name: checkpointName,
        payload: {},
      });
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

  replaceCoderTodos(threadId: string, todos: CoderTodoItem[]): void {
    const conversationId = threadId.trim();
    if (!conversationId) throw new Error("threadId is required");
    const normalizedTodos = todos.map((todo) => ({
      todoId: todo.id,
      conversationId,
      title: todo.title,
      detail: todo.detail,
      status: todo.status,
      position: todo.position,
      updatedAt: todo.updatedAt,
    }));
    const occurredAt =
      normalizedTodos
        .map((todo) => todo.updatedAt)
        .sort()
        .at(-1) ?? new Date().toISOString();
    const eventIdentity = crypto.randomUUID();
    let v2Result: ConversationAppendResult;
    this.v2.initialize();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      v2Result = this.v2.appendInCurrentTransaction({
        conversationId,
        eventId: `todo_v2_${eventIdentity}`,
        sourceEventKey: `todo:update:${conversationId}:${eventIdentity}`,
        type: "todo.updated",
        occurredAt,
        payload: { todos: normalizedTodos },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original storage error.
      }
      throw error;
    }
    this.v2.publishCommitted([v2Result!]);
  }

  listCoderTodos(threadId: string): CoderTodoItem[] {
    return this.v2.todosOf(threadId).map((todo) => ({
      id: todo.todoId,
      threadId: todo.conversationId,
      title: todo.title,
      detail: todo.detail,
      status: todo.status,
      position: todo.position,
      updatedAt: todo.updatedAt,
    }));
  }

  clearCoderTodos(threadId: string): void {
    this.replaceCoderTodos(threadId, []);
  }

  saveAppliedDiff(threadId: string, workspacePath: string, diff: string, files: string[]): AppliedDiffRecord {
    const appliedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO thread_applied_diffs (thread_id, workspace_path, diff, files_json, applied_at, rolled_back_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(thread_id) DO UPDATE SET
           workspace_path = excluded.workspace_path,
           diff = excluded.diff,
           files_json = excluded.files_json,
           applied_at = excluded.applied_at,
           rolled_back_at = NULL`,
      )
      .run(threadId, workspacePath, diff, JSON.stringify(files), appliedAt);
    return { threadId, workspacePath, diff, files, appliedAt };
  }

  getAppliedDiff(threadId: string): AppliedDiffRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT thread_id, workspace_path, diff, files_json, applied_at, rolled_back_at
         FROM thread_applied_diffs
         WHERE thread_id = ?`,
      )
      .get(threadId) as AppliedDiffRow | undefined;
    return row ? rowToAppliedDiff(row) : undefined;
  }

  listAppliedDiffsAfter(workspacePath: string, appliedAt: string): AppliedDiffRecord[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id, workspace_path, diff, files_json, applied_at, rolled_back_at
         FROM thread_applied_diffs
         WHERE workspace_path = ?
           AND applied_at > ?
           AND rolled_back_at IS NULL
         ORDER BY applied_at DESC`,
      )
      .all(workspacePath, appliedAt) as unknown as AppliedDiffRow[];
    return rows.map(rowToAppliedDiff);
  }

  markAppliedDiffRolledBack(threadId: string): void {
    this.db
      .prepare(`UPDATE thread_applied_diffs SET rolled_back_at = ? WHERE thread_id = ?`)
      .run(new Date().toISOString(), threadId);
  }

  private bindRunEventRewindTarget(threadId: string, activityLineId: string, userMessageId: string): void {
    if (this.isV2OnlyStorage() && !this.v2.hasConversation(threadId)) return;
    const sources = this.listConversationRuntimeSources(threadId).filter(
      (event) => event.streamKey === activityLineId,
    );
    if (sources.length > 0) {
      this.appendV2ProviderPatch(
        threadId,
        sources.map((event) => event.id),
        { metadataMerge: { rewindTarget: { activityLineId, userMessageId } } },
        `rewind-target:${activityLineId}:${userMessageId}`,
      );
      return;
    }

    if (this.isV2OnlyStorage()) return;

    // Compatibility-only repair for rows written before provider-input receipts
    // existed. A native runtime event always takes the V2 branch above.
    this.db
      .prepare(
        `UPDATE thread_run_events
         SET metadata_json = json_set(
           COALESCE(metadata_json, '{}'),
           '$.rewindTarget',
           json(?)
         )
         WHERE thread_id = ? AND (id = ? OR stream_key = ?)`,
      )
      .run(JSON.stringify({ activityLineId, userMessageId }), threadId, activityLineId, activityLineId);
    this.invalidateThreadRunEventCaches(threadId);
  }

  private getLastActivityLine(threadId: string): (ThreadActivityLine & { id: string }) | undefined {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, role, message, stream, agent_id, api_error_json, sdk_user_message_id, created_at
         FROM thread_activity
         WHERE thread_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(threadId) as ActivityRow | undefined;

    if (!row) {
      return undefined;
    }

    return activityRowToThreadActivityLine(row);
  }

  private getThreadRunEvent(threadId: string, eventId: string): ThreadRunEvent | undefined {
    const cacheKey = threadRunEventCacheKey(threadId, eventId);
    const cached = this.hotThreadRunEventCache.get(cacheKey);
    if (cached) {
      this.hotThreadRunEventCache.delete(cacheKey);
      this.hotThreadRunEventCache.set(cacheKey, cached);
      return cached;
    }
    const row = this.db
      .prepare(
        `SELECT id, thread_id, sequence, event_type, scope, role, agent_id,
                parent_agent_id, parent_tool_use_id, run_attempt_id, request_id, stream_key,
                stream_state, message, metadata_json, observed_at
         FROM thread_run_events
         WHERE thread_id = ? AND id = ?`,
      )
      .get(threadId, eventId) as ThreadRunEventRow | undefined;
    if (!row) {
      return undefined;
    }
    const event = rowToThreadRunEvent(row);
    this.rememberHotThreadRunEvent(event);
    return event;
  }

  private nextThreadRunEventSequence(threadId: string): number {
    const cached = this.nextThreadRunEventSequences.get(threadId);
    if (cached !== undefined) {
      this.nextThreadRunEventSequences.set(threadId, cached + 1);
      return cached;
    }
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM thread_run_events
         WHERE thread_id = ?`,
      )
      .get(threadId) as { next_sequence: number } | undefined;
    const next = row?.next_sequence ?? 1;
    this.nextThreadRunEventSequences.set(threadId, next + 1);
    return next;
  }

  private rememberHotThreadRunEvent(event: ThreadRunEvent): void {
    if (!isCollapsibleStreamEvent(event)) {
      return;
    }
    const cacheKey = threadRunEventCacheKey(event.threadId, event.id);
    this.hotThreadRunEventCache.delete(cacheKey);
    this.hotThreadRunEventCache.set(cacheKey, event);
    while (this.hotThreadRunEventCache.size > MAX_HOT_THREAD_RUN_EVENT_CACHE_ENTRIES) {
      const oldestKey = this.hotThreadRunEventCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.hotThreadRunEventCache.delete(oldestKey);
    }
  }

  private rememberProjectionEvents(threadId: string, maxEvents: number, events: ThreadRunEvent[]): void {
    const entry = { maxEvents, events };
    this.touchProjectionEventCache(threadId, entry);
    while (this.projectionEventCache.size > MAX_PROJECTION_EVENT_CACHE_ENTRIES) {
      const oldestThreadId = this.projectionEventCache.keys().next().value;
      if (oldestThreadId === undefined) {
        break;
      }
      this.projectionEventCache.delete(oldestThreadId);
    }
  }

  private touchProjectionEventCache(threadId: string, entry: ProjectionEventCacheEntry): void {
    this.projectionEventCache.delete(threadId);
    this.projectionEventCache.set(threadId, entry);
  }

  private updateProjectionEventCache(event: ThreadRunEvent): void {
    const cached = this.projectionEventCache.get(event.threadId);
    if (!cached) {
      return;
    }
    const events = cached.events.filter((candidate) => {
      if (candidate.id === event.id) {
        return false;
      }
      return !(
        isCollapsibleStreamEvent(event) &&
        isCollapsibleStreamEvent(candidate) &&
        sameStreamIdentity(candidate, event)
      );
    });
    events.push(event);
    events.sort(compareThreadRunEvents);
    // maxEvents === 0 is the unbounded full-projection sentinel (FULL_PROJECTION_EVENT_CACHE_MAX).
    // `slice(length - 0)` would empty the cache and poison later skeleton rebuilds.
    const boundedEvents =
      cached.maxEvents > 0 && events.length > cached.maxEvents
        ? events.slice(events.length - cached.maxEvents)
        : events;
    this.touchProjectionEventCache(event.threadId, {
      maxEvents: cached.maxEvents,
      events: boundedEvents,
    });
  }

  private invalidateThreadRunEventCaches(threadId: string): void {
    this.deleteThreadFeedSkeleton(threadId);
    this.projectionEventCache.delete(threadId);
    this.nextThreadRunEventSequences.delete(threadId);
    const prefix = `${threadId}\0`;
    for (const cacheKey of this.hotThreadRunEventCache.keys()) {
      if (cacheKey.startsWith(prefix)) {
        this.hotThreadRunEventCache.delete(cacheKey);
      }
    }
  }
}

function parseFeedSkeletonPatchState(raw: string | null | undefined): FeedSkeletonPatchState | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as {
      trackedItems?: unknown;
      finalizedSdkBlocks?: unknown;
      rulesVersion?: unknown;
      retainCandidateFinals?: unknown;
    };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.trackedItems) ||
      parsed.rulesVersion !== FEED_SKELETON_RULES_VERSION
    ) {
      // Unknown/older rules: drop the patch state so the caller rebuilds from events
      // instead of patching a tracked set produced by different semantics.
      return undefined;
    }
    return {
      trackedItems: parsed.trackedItems as FeedSkeletonPatchState["trackedItems"],
      finalizedSdkBlocks: Array.isArray(parsed.finalizedSdkBlocks)
        ? (parsed.finalizedSdkBlocks as FeedSkeletonPatchState["finalizedSdkBlocks"])
        : [],
      rulesVersion: FEED_SKELETON_RULES_VERSION,
      ...(typeof parsed.retainCandidateFinals === "boolean"
        ? { retainCandidateFinals: parsed.retainCandidateFinals }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function threadRunEventCacheKey(threadId: string, eventId: string): string {
  return `${threadId}\0${eventId}`;
}

function compareThreadRunEvents(left: ThreadRunEvent, right: ThreadRunEvent): number {
  const sequenceDiff = left.sequence - right.sequence;
  if (sequenceDiff !== 0) {
    return sequenceDiff;
  }
  const observedAtDiff = left.observedAt.localeCompare(right.observedAt);
  return observedAtDiff !== 0 ? observedAtDiff : left.id.localeCompare(right.id);
}

function activityRowToThreadActivityLine(row: ActivityRow): ThreadActivityLine {
  const apiError = parseStoredApiError(row.api_error_json);
  const userMessageId = row.sdk_user_message_id?.trim();
  return {
    id: row.id,
    role: row.role,
    message: row.message,
    stream: row.stream === 1,
    ...(userMessageId && {
      rewindTarget: { activityLineId: row.id, userMessageId },
    }),
    ...(row.agent_id?.trim() && { agentId: row.agent_id.trim() }),
    ...(apiError && { apiError }),
  };
}

function parseStoredApiError(raw: string | null | undefined): ThreadApiErrorInfo | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as ThreadApiErrorInfo;
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return {
        message: parsed.message.trim(),
        ...(typeof parsed.statusCode === "number" && { statusCode: parsed.statusCode }),
        ...(typeof parsed.code === "string" && parsed.code.trim() && { code: parsed.code.trim() }),
        ...(typeof parsed.model === "string" && parsed.model.trim() && { model: parsed.model.trim() }),
        ...(parsed.codexErrorInfo !== undefined && { codexErrorInfo: parsed.codexErrorInfo }),
        ...(typeof parsed.additionalDetails === "string" &&
          parsed.additionalDetails.trim() && { additionalDetails: parsed.additionalDetails }),
        ...(parsed.rawTurnError !== undefined && { rawTurnError: parsed.rawTurnError }),
        ...(typeof parsed.param === "string" && parsed.param.trim() && { param: parsed.param.trim() }),
        ...(typeof parsed.logicalRequestId === "string" &&
          parsed.logicalRequestId.trim() && { logicalRequestId: parsed.logicalRequestId.trim() }),
        ...(typeof parsed.providerRequestId === "string" &&
          parsed.providerRequestId.trim() && { providerRequestId: parsed.providerRequestId.trim() }),
        ...(typeof parsed.responseId === "string" &&
          parsed.responseId.trim() && { responseId: parsed.responseId.trim() }),
        ...(typeof parsed.accountId === "string" &&
          parsed.accountId.trim() && { accountId: parsed.accountId.trim() }),
        ...(typeof parsed.threadId === "string" &&
          parsed.threadId.trim() && { threadId: parsed.threadId.trim() }),
        ...(typeof parsed.turnId === "string" &&
          parsed.turnId.trim() && { turnId: parsed.turnId.trim() }),
        ...(typeof parsed.runAttemptId === "string" &&
          parsed.runAttemptId.trim() && { runAttemptId: parsed.runAttemptId.trim() }),
      };
    }
  } catch {
    // ignore malformed persisted JSON
  }
  return undefined;
}

function parsePromptImageAttachments(raw: string | null | undefined): PromptImageAttachment[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsePromptImageAttachmentsValue(parsed);
  } catch {
    return [];
  }
}

function parsePromptImageAttachmentsValue(value: unknown): PromptImageAttachment[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is PromptImageAttachment => isPromptImageAttachment(entry))
    : [];
}

function sourceMessageId(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.conversationV2MessageId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRewindTarget(
  metadata: Record<string, unknown> | undefined,
): { activityLineId?: string; userMessageId?: string } | undefined {
  const value = metadata?.rewindTarget;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const activityLineId = typeof record.activityLineId === "string" ? record.activityLineId.trim() : "";
  const userMessageId = typeof record.userMessageId === "string" ? record.userMessageId.trim() : "";
  if (!activityLineId && !userMessageId) return undefined;
  return {
    ...(activityLineId ? { activityLineId } : {}),
    ...(userMessageId ? { userMessageId } : {}),
  };
}

function activityLinesFromNativeSources(events: readonly ThreadRunEvent[]): ThreadActivityLine[] {
  const latestStreamEvent = new Map<string, ThreadRunEvent>();
  const finalizedStreams = new Set<string>();
  for (const event of events) {
    const key = event.streamKey?.trim() || event.id;
    if (event.eventType === "message.final" || event.eventType === "thinking.final") {
      finalizedStreams.add(key);
    }
    if (event.eventType === "message.delta" || event.eventType === "thinking.delta") {
      latestStreamEvent.set(key, event);
    }
  }
  const lines: ThreadActivityLine[] = [];
  for (const event of events) {
    const liveType = typeof event.metadata?.liveType === "string" ? event.metadata.liveType : "";
    const prompt =
      event.role === "user" &&
      event.message.trim() &&
      (liveType === "thread.user_prompt" ||
        liveType === "message.user" ||
        event.eventType === "thread.status");
    const final = event.eventType === "message.final" || event.eventType === "thinking.final";
    const delta = event.eventType === "message.delta" || event.eventType === "thinking.delta";
    if (!prompt && !final && !(delta && !finalizedStreams.has(event.streamKey?.trim() || event.id))) continue;
    if (delta && latestStreamEvent.get(event.streamKey?.trim() || event.id)?.id !== event.id) continue;
    const rewindTarget = readRewindTarget(event.metadata);
    lines.push({
      id: rewindTarget?.activityLineId || event.streamKey?.trim() || event.id,
      role: event.role ?? (prompt ? "user" : "assistant"),
      message: event.message,
      stream: delta,
      ...(rewindTarget?.activityLineId || rewindTarget?.userMessageId
        ? {
            rewindTarget: {
              activityLineId: rewindTarget.activityLineId || rewindTarget.userMessageId || event.id,
              ...(rewindTarget.userMessageId ? { userMessageId: rewindTarget.userMessageId } : {}),
            },
          }
        : {}),
      ...(event.agentId?.trim() ? { agentId: event.agentId.trim() } : {}),
    });
  }
  return lines;
}

function rowToAppliedDiff(row: AppliedDiffRow): AppliedDiffRecord {
  return {
    threadId: row.thread_id,
    workspacePath: row.workspace_path,
    diff: row.diff,
    files: parseFilesJson(row.files_json),
    appliedAt: row.applied_at,
    ...(row.rolled_back_at && { rolledBackAt: row.rolled_back_at }),
  };
}

function parseFilesJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    return [];
  }
  return [];
}

function rowToThreadMetrics(row: {
  thread_id: string;
  accumulator_json: string | null;
  context_json: string | null;
  updated_at: string;
}): ThreadMetricsRecord | undefined {
  let accumulator: SerializedThreadUsageState | undefined;
  let context: ThreadContextSnapshot | undefined;

  if (row.accumulator_json) {
    try {
      accumulator = JSON.parse(row.accumulator_json) as SerializedThreadUsageState;
    } catch {
      accumulator = undefined;
    }
  }

  if (row.context_json) {
    try {
      context = JSON.parse(row.context_json) as ThreadContextSnapshot;
    } catch {
      context = undefined;
    }
  }

  if (!accumulator && !context) {
    return undefined;
  }

  return {
    threadId: row.thread_id,
    updatedAt: row.updated_at,
    ...(accumulator && { accumulator }),
    ...(context && { context: normalizeContextSnapshotRoles(context) }),
  };
}

function runAttemptCommandDispatch(record: RunAttemptRecord): RunAttemptCommandDispatch | undefined {
  const metadata = record.metadata;
  if (!metadata || !("commandDispatch" in metadata)) {
    return undefined;
  }
  const value = metadata.commandDispatch;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationV2Error(
      CONVERSATION_V2_ERROR.integrityFailure,
      "Run attempt command dispatch metadata is malformed.",
    );
  }
  const fields = value as Record<string, unknown>;
  const principalId = typeof fields.principalId === "string" ? fields.principalId.trim() : "";
  const clientCommandId = typeof fields.clientCommandId === "string" ? fields.clientCommandId.trim() : "";
  const dispatchId = typeof fields.dispatchId === "string" ? fields.dispatchId.trim() : "";
  if (!principalId || !clientCommandId || !dispatchId) {
    throw new ConversationV2Error(
      CONVERSATION_V2_ERROR.integrityFailure,
      "Run attempt command dispatch metadata is incomplete.",
    );
  }
  return { principalId, clientCommandId, dispatchId };
}

function rowToUsageLedgerEvent(row: UsageLedgerEventRow): UsageLedgerEvent {
  const metadata = parseJsonRecord(row.metadata_json);
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    threadId: row.thread_id,
    source: row.source as UsageLedgerSource,
    sourceEventId: row.source_event_id,
    usageKind: row.usage_kind as UsageLedgerKind,
    role: normalizeAgentRole(row.role),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    ...(row.reasoning_tokens > 0 && { reasoningTokens: row.reasoning_tokens }),
    observedAt: row.observed_at,
    attribution: parseUsageAttributionJson(row.attribution_json),
    ...(row.run_attempt_id && { runAttemptId: row.run_attempt_id }),
    ...(row.agent_id && { agentId: row.agent_id }),
    ...(row.parent_tool_use_id && { parentToolUseId: row.parent_tool_use_id }),
    ...(row.request_key && { requestKey: row.request_key }),
    ...(row.provider_request_id && { providerRequestId: row.provider_request_id }),
    ...(row.sdk_message_id && { sdkMessageId: row.sdk_message_id }),
    ...(row.model_id && { modelId: row.model_id }),
    ...(row.reported_cost_usd !== null && { reportedCostUsd: row.reported_cost_usd }),
    ...(metadata && { metadata }),
  };
}

function usageLedgerRowToV2(row: UsageLedgerEventRow): ConversationV2UsageLedgerRow {
  return {
    conversation_id: row.thread_id,
    id: row.id,
    idempotency_key: row.idempotency_key,
    run_attempt_id: row.run_attempt_id,
    agent_id: row.agent_id,
    parent_tool_use_id: row.parent_tool_use_id,
    source: row.source,
    source_event_id: row.source_event_id,
    request_key: row.request_key,
    provider_request_id: row.provider_request_id,
    sdk_message_id: row.sdk_message_id,
    usage_kind: row.usage_kind,
    role: row.role,
    model_id: row.model_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    reasoning_tokens: row.reasoning_tokens,
    reported_cost_usd: row.reported_cost_usd,
    attribution_json: row.attribution_json,
    metadata_json: row.metadata_json,
    observed_at: row.observed_at,
  };
}

function usageLedgerEventToV2(event: UsageLedgerEvent): ConversationV2UsageLedgerRow {
  return {
    conversation_id: event.threadId,
    id: event.id,
    idempotency_key: event.idempotencyKey,
    run_attempt_id: event.runAttemptId ?? null,
    agent_id: event.agentId ?? null,
    parent_tool_use_id: event.parentToolUseId ?? null,
    source: event.source,
    source_event_id: event.sourceEventId,
    request_key: event.requestKey ?? null,
    provider_request_id: event.providerRequestId ?? null,
    sdk_message_id: event.sdkMessageId ?? null,
    usage_kind: event.usageKind,
    role: event.role,
    model_id: event.modelId ?? null,
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_read_tokens: event.cacheReadTokens,
    cache_creation_tokens: event.cacheCreationTokens,
    reasoning_tokens: event.reasoningTokens ?? 0,
    reported_cost_usd: event.reportedCostUsd ?? null,
    attribution_json: JSON.stringify(event.attribution),
    metadata_json: event.metadata ? JSON.stringify(event.metadata) : null,
    observed_at: event.observedAt,
  };
}

function v2UsageLedgerRowToEvent(row: ConversationV2UsageLedgerRow): UsageLedgerEvent {
  return rowToUsageLedgerEvent({
    id: row.id,
    idempotency_key: row.idempotency_key,
    thread_id: row.conversation_id,
    run_attempt_id: row.run_attempt_id,
    agent_id: row.agent_id,
    parent_tool_use_id: row.parent_tool_use_id,
    source: row.source,
    source_event_id: row.source_event_id,
    request_key: row.request_key,
    provider_request_id: row.provider_request_id,
    sdk_message_id: row.sdk_message_id,
    usage_kind: row.usage_kind,
    role: row.role,
    model_id: row.model_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    reasoning_tokens: row.reasoning_tokens,
    reported_cost_usd: row.reported_cost_usd,
    attribution_json: row.attribution_json,
    metadata_json: row.metadata_json,
    observed_at: row.observed_at,
  });
}

function rowToThreadRunEvent(row: ThreadRunEventRow): ThreadRunEvent {
  const metadata = parseJsonRecord(row.metadata_json);
  const { text: message } = repairActivityText(row.message);
  return withLegacyConversationV2MessageIdentity({
    id: row.id,
    threadId: row.thread_id,
    sequence: row.sequence,
    eventType: row.event_type as ThreadRunEvent["eventType"],
    scope: row.scope as ThreadRunEvent["scope"],
    streamState: row.stream_state as ThreadRunEvent["streamState"],
    message,
    observedAt: row.observed_at,
    ...(row.role && { role: row.role }),
    ...(row.agent_id && { agentId: row.agent_id }),
    ...(row.parent_agent_id && { parentAgentId: row.parent_agent_id }),
    ...(row.parent_tool_use_id && { parentToolUseId: row.parent_tool_use_id }),
    ...(row.run_attempt_id && { runAttemptId: row.run_attempt_id }),
    ...(row.request_id && { requestId: row.request_id }),
    ...(row.stream_key && { streamKey: row.stream_key }),
    ...(metadata && { metadata }),
  });
}

function collapseLegacyProjectionEvents(events: readonly ThreadRunEvent[]): ThreadRunEvent[] {
  const latestByStream = new Map<string, string>();
  for (const event of events) {
    if ((event.eventType !== "message.delta" && event.eventType !== "thinking.delta") || !event.streamKey) {
      continue;
    }
    latestByStream.set(
      `${event.eventType}\0${event.streamKey}\0${event.requestId ?? ""}\0${event.runAttemptId ?? ""}`,
      event.id,
    );
  }
  return events.filter((event) => {
    if ((event.eventType !== "message.delta" && event.eventType !== "thinking.delta") || !event.streamKey) {
      return true;
    }
    return (
      latestByStream.get(
        `${event.eventType}\0${event.streamKey}\0${event.requestId ?? ""}\0${event.runAttemptId ?? ""}`,
      ) === event.id
    );
  });
}

function sanitizeThreadRunEventForPersistence(event: ThreadRunEventInput): ThreadRunEventInput {
  const { text: message } = repairActivityText(event.message);
  const sanitized: ThreadRunEventInput = message === event.message ? event : { ...event, message };
  if (!sanitized.metadata || !("tool" in sanitized.metadata)) {
    return sanitized;
  }
  const metadata = sanitizeThreadRunEventMetadata(sanitized.metadata);
  const withSanitizedMetadata: ThreadRunEventInput = { ...sanitized };
  if (metadata) {
    withSanitizedMetadata.metadata = metadata;
  } else {
    delete withSanitizedMetadata.metadata;
  }
  return withSanitizedMetadata;
}

function sanitizeThreadRunEventMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const next = { ...metadata };
  const tool = projectThreadRunToolMetadata(readThreadRunToolMetadata(metadata));
  if (tool) {
    next.tool = tool;
  } else {
    delete next.tool;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function migratePersistedToolMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const rawTool = metadata.tool;
  if (!isJsonRecord(rawTool)) {
    return metadata;
  }
  const name = typeof rawTool.name === "string" ? rawTool.name.trim() : "";
  const legacyOutput =
    typeof rawTool.output === "string" && rawTool.output.trim() ? rawTool.output : undefined;
  const existingPreview =
    typeof rawTool.outputPreview === "string" && rawTool.outputPreview.trim()
      ? rawTool.outputPreview
      : undefined;
  const preview =
    keepsOutputPreview(name) && (existingPreview || legacyOutput)
      ? createToolOutputPreview(existingPreview ?? legacyOutput ?? "")
      : undefined;
  const migratedRawTool: Record<string, unknown> = {
    ...rawTool,
    ...(preview?.text ? { outputPreview: preview.text } : {}),
    ...((preview?.truncated ||
      rawTool.outputTruncated === true ||
      rawTool.outputPreviewTruncated === true) && { outputPreviewTruncated: true }),
  };
  const tool = projectThreadRunToolMetadata(readThreadRunToolMetadata({ tool: migratedRawTool }));
  const next = { ...metadata };
  if (tool) {
    next.tool = tool;
  } else {
    delete next.tool;
  }
  return JSON.stringify(next) === JSON.stringify(metadata) ? metadata : next;
}

function mergeRicherThreadRunEvent(
  existing: ThreadRunEvent,
  incoming: ThreadRunEventInput,
): ThreadRunEvent | null {
  if (!shouldUpgradeThreadRunEvent(existing, incoming)) {
    return null;
  }
  const updated: ThreadRunEvent = {
    ...existing,
    scope: incoming.scope,
    streamState: incoming.streamState,
    message: incoming.message,
    observedAt: incoming.observedAt,
    ...(incoming.role?.trim() && { role: incoming.role.trim() }),
    ...(incoming.agentId?.trim() && { agentId: incoming.agentId.trim() }),
    ...(incoming.parentAgentId?.trim() && { parentAgentId: incoming.parentAgentId.trim() }),
    ...(incoming.parentToolUseId?.trim() && { parentToolUseId: incoming.parentToolUseId.trim() }),
    ...(incoming.runAttemptId?.trim() && { runAttemptId: incoming.runAttemptId.trim() }),
    ...(incoming.requestId?.trim() && { requestId: incoming.requestId.trim() }),
    ...(incoming.streamKey?.trim() && { streamKey: incoming.streamKey.trim() }),
  };
  const metadata = mergeThreadRunEventMetadata(existing.metadata, incoming.metadata);
  if (metadata) {
    updated.metadata = metadata;
  } else {
    delete updated.metadata;
  }
  return updated;
}

function shouldUpgradeThreadRunEvent(existing: ThreadRunEvent, incoming: ThreadRunEventInput): boolean {
  if (existing.eventType !== incoming.eventType) {
    return false;
  }

  const existingTool = readThreadRunToolMetadata(existing.metadata);
  const incomingTool = readThreadRunToolMetadata(incoming.metadata);
  if (isRicherThreadRunToolMetadata(existingTool, incomingTool)) {
    return true;
  }

  if (
    (existing.eventType === "message.delta" || existing.eventType === "thinking.delta") &&
    existing.streamKey &&
    existing.streamKey === incoming.streamKey &&
    incoming.observedAt >= existing.observedAt &&
    (incoming.message !== existing.message || incoming.streamState !== existing.streamState)
  ) {
    return true;
  }

  if (
    existing.eventType === "agent.started" &&
    agentStartedIdentityEnrichment(existing.metadata, incoming.metadata)
  ) {
    return true;
  }

  return streamStateRank(incoming.streamState) > streamStateRank(existing.streamState);
}

function agentStartedIdentityEnrichment(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): boolean {
  if (!incoming) {
    return false;
  }
  const incomingNickname =
    readMetadataString(incoming, "agentNickname") ?? readMetadataString(incoming, "nickname");
  const existingNickname =
    readMetadataString(existing, "agentNickname") ?? readMetadataString(existing, "nickname");
  if (incomingNickname && incomingNickname !== existingNickname) {
    return true;
  }
  const incomingTaskName = readMetadataString(incoming, "taskName");
  const existingTaskName = readMetadataString(existing, "taskName");
  if (incomingTaskName && incomingTaskName !== existingTaskName) {
    return true;
  }
  return false;
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mergeThreadRunEventMetadata(
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
  const thinkingStartedAt =
    readMetadataString(existing, "thinkingStartedAt") ?? readMetadataString(incoming, "thinkingStartedAt");
  if (thinkingStartedAt) {
    merged.thinkingStartedAt = thinkingStartedAt;
  }
  const tool = mergeThreadRunToolMetadata(
    readThreadRunToolMetadata(existing),
    readThreadRunToolMetadata(incoming),
  );
  if (tool) {
    merged.tool = tool;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeThreadRunToolMetadata(
  existing: ThreadRunToolMetadata | undefined,
  incoming: ThreadRunToolMetadata | undefined,
): ThreadRunToolMetadata | undefined {
  if (!existing) {
    return incoming;
  }
  if (!incoming || existing.name !== incoming.name) {
    return existing;
  }
  const description = incoming.description ?? existing.description;
  const imageView = mergeThreadRunImageViewMetadata(existing.imageView, incoming.imageView);
  return {
    ...existing,
    ...incoming,
    ...(description !== undefined ? { description } : {}),
    ...(imageView && { imageView }),
    ...(incoming.readTarget
      ? { readTarget: incoming.readTarget }
      : existing.readTarget
        ? { readTarget: existing.readTarget }
        : {}),
    ...(incoming.grepTarget
      ? { grepTarget: incoming.grepTarget }
      : existing.grepTarget
        ? { grepTarget: existing.grepTarget }
        : {}),
    ...(incoming.imageDisplay
      ? { imageDisplay: incoming.imageDisplay }
      : existing.imageDisplay
        ? { imageDisplay: existing.imageDisplay }
        : {}),
    ...(incoming.htmlHost
      ? { htmlHost: incoming.htmlHost }
      : existing.htmlHost
        ? { htmlHost: existing.htmlHost }
        : {}),
    ...(incoming.mcpDiscovery
      ? { mcpDiscovery: incoming.mcpDiscovery }
      : existing.mcpDiscovery
        ? { mcpDiscovery: existing.mcpDiscovery }
        : {}),
  };
}

function isRicherThreadRunToolMetadata(
  existing: ThreadRunToolMetadata | undefined,
  incoming: ThreadRunToolMetadata | undefined,
): boolean {
  if (!incoming) {
    return false;
  }
  if (!existing) {
    return Boolean(
      incoming.detail ||
        incoming.toolUseId ||
        incoming.durationMs !== undefined ||
        incoming.exitCode !== undefined ||
        incoming.status ||
        incoming.description ||
        incoming.outputPreview ||
        incoming.outputPreviewTruncated ||
        incoming.fileChange ||
        incoming.readTarget ||
        incoming.grepTarget ||
        incoming.imageView ||
        incoming.imageDisplay ||
        incoming.htmlHost ||
        incoming.mcpDiscovery ||
        incoming.codemode ||
        incoming.parentToolCallId,
    );
  }
  if (existing.name !== incoming.name) {
    return false;
  }
  return Boolean(
    (incoming.detail && incoming.detail !== existing.detail) ||
      (incoming.outputPreview && incoming.outputPreview !== existing.outputPreview) ||
      (incoming.outputPreviewTruncated && !existing.outputPreviewTruncated) ||
      (incoming.toolUseId && incoming.toolUseId !== existing.toolUseId) ||
      (incoming.durationMs !== undefined && incoming.durationMs !== existing.durationMs) ||
      (incoming.exitCode !== undefined && incoming.exitCode !== existing.exitCode) ||
      (incoming.status && incoming.status !== existing.status) ||
      (incoming.description && incoming.description !== existing.description) ||
      (incoming.fileChange && !isSameJsonValue(incoming.fileChange, existing.fileChange)) ||
      (incoming.readTarget && !isSameJsonValue(incoming.readTarget, existing.readTarget)) ||
      (incoming.grepTarget && !isSameJsonValue(incoming.grepTarget, existing.grepTarget)) ||
      (incoming.imageView && !isSameJsonValue(incoming.imageView, existing.imageView)) ||
      (incoming.imageDisplay && !isSameJsonValue(incoming.imageDisplay, existing.imageDisplay)) ||
      (incoming.htmlHost && !isSameJsonValue(incoming.htmlHost, existing.htmlHost)) ||
      (incoming.mcpDiscovery && !isSameJsonValue(incoming.mcpDiscovery, existing.mcpDiscovery)) ||
      (incoming.codemode && !isSameJsonValue(incoming.codemode, existing.codemode)) ||
      (incoming.parentToolCallId && incoming.parentToolCallId !== existing.parentToolCallId),
  );
}

function isSameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readThreadRunToolMetadata(
  metadata: Record<string, unknown> | undefined,
): ThreadRunToolMetadata | undefined {
  const raw = metadata?.tool;
  if (!isJsonRecord(raw)) {
    return undefined;
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    return undefined;
  }
  const fileChange = parseThreadRunFileChangeMetadata(raw.fileChange);
  const readTarget = parseThreadRunReadToolTarget(raw.readTarget);
  const grepTarget = parseThreadRunGrepToolTarget(raw.grepTarget);
  const sendMessage = parseThreadRunSendMessageMetadata(raw.sendMessage);
  const imageView = parseThreadRunImageViewMetadata(raw.imageView);
  const imageDisplay = parseThreadRunImageDisplayMetadata(raw.imageDisplay);
  const htmlHost = parseThreadRunHtmlHostMetadata(raw.htmlHost);
  const mcpDiscovery = parseThreadRunMcpDiscoveryMetadata(raw.mcpDiscovery);
  const webSearch = parseThreadRunWebSearchMetadata(raw.webSearch);
  const codemode = parseThreadRunCodemodeMetadata(raw.codemode);
  return {
    name,
    ...(typeof raw.detail === "string" && raw.detail.trim() && { detail: raw.detail.trim() }),
    ...(typeof raw.outputPreview === "string" &&
      raw.outputPreview.trim() && { outputPreview: raw.outputPreview.trim() }),
    ...(raw.outputPreviewTruncated === true && { outputPreviewTruncated: true }),
    ...(typeof raw.toolUseId === "string" && raw.toolUseId.trim() && { toolUseId: raw.toolUseId.trim() }),
    ...(typeof raw.durationMs === "number" &&
      Number.isFinite(raw.durationMs) && { durationMs: raw.durationMs }),
    ...(typeof raw.exitCode === "number" && Number.isFinite(raw.exitCode) && { exitCode: raw.exitCode }),
    ...(isThreadRunToolStatus(raw.status) && { status: raw.status }),
    ...(raw.nonExecutionKind === "denied" ||
    raw.nonExecutionKind === "interrupted" ||
    raw.nonExecutionKind === "cancelled"
      ? { nonExecutionKind: raw.nonExecutionKind }
      : {}),
    ...(typeof raw.description === "string" &&
      raw.description.trim() && { description: raw.description.trim() }),
    ...(fileChange && { fileChange }),
    ...(readTarget && { readTarget }),
    ...(grepTarget && { grepTarget }),
    ...(imageView && { imageView }),
    ...(imageDisplay && { imageDisplay }),
    ...(htmlHost && { htmlHost }),
    ...(mcpDiscovery && { mcpDiscovery }),
    ...(sendMessage && { sendMessage }),
    ...(webSearch && { webSearch }),
    ...(typeof raw.parentToolCallId === "string" &&
      raw.parentToolCallId.trim() && { parentToolCallId: raw.parentToolCallId.trim() }),
    ...(codemode && { codemode }),
  };
}

function parseThreadRunHtmlHostMetadata(value: unknown): ThreadRunToolMetadata["htmlHost"] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }
  const pageId = typeof value.pageId === "string" ? value.pageId.trim() : "";
  const publicUrl = typeof value.publicUrl === "string" ? value.publicUrl.trim() : "";
  if (!pageId || !publicUrl) {
    return undefined;
  }
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt.trim() : "";
  return {
    pageId,
    publicUrl,
    ...(title ? { title } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof value.canExtend === "boolean" ? { canExtend: value.canExtend } : {}),
  };
}

function parseThreadRunImageDisplayMetadata(
  value: unknown,
): ThreadRunToolMetadata["imageDisplay"] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }
  const artifactId = typeof value.artifactId === "string" ? value.artifactId.trim() : "";
  if (!artifactId) {
    return undefined;
  }
  const title = typeof value.title === "string" ? value.title.trim() : "";
  return {
    artifactId,
    ...(title ? { title } : {}),
  };
}

function parseThreadRunWebSearchMetadata(value: unknown): ThreadRunToolMetadata["webSearch"] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }
  const query = typeof value.query === "string" ? value.query.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const pattern = typeof value.pattern === "string" ? value.pattern.trim() : "";
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const queries = Array.isArray(value.queries)
    ? value.queries
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
        .slice(0, 12)
    : undefined;
  const results = Array.isArray(value.results)
    ? value.results
        .map((entry) => {
          if (!isJsonRecord(entry)) return undefined;
          const title = typeof entry.title === "string" ? entry.title.trim() : "";
          const hitUrl = typeof entry.url === "string" ? entry.url.trim() : "";
          const description = typeof entry.description === "string" ? entry.description.trim() : undefined;
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
    value.actionType === "search" ||
    value.actionType === "openPage" ||
    value.actionType === "findInPage" ||
    value.actionType === "other"
      ? value.actionType
      : undefined;
  const mode = value.mode === "fetch" || value.mode === "search" ? value.mode : undefined;
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

function parseThreadRunMcpDiscoveryMetadata(
  value: unknown,
): ThreadRunToolMetadata["mcpDiscovery"] | undefined {
  if (!isJsonRecord(value) || value.kind !== "search") {
    return undefined;
  }
  return { kind: "search" };
}

function parseThreadRunSendMessageMetadata(value: unknown): ThreadRunToolMetadata["sendMessage"] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }
  const recipient =
    typeof value.recipient === "string" && value.recipient.trim() ? value.recipient.trim() : undefined;
  const summary =
    typeof value.summary === "string" && value.summary.trim() ? value.summary.trim() : undefined;
  const message =
    typeof value.message === "string" && value.message.trim() ? value.message.trim() : undefined;
  const resultMessage =
    typeof value.resultMessage === "string" && value.resultMessage.trim()
      ? value.resultMessage.trim()
      : undefined;
  const resumedAgentId =
    typeof value.resumedAgentId === "string" && value.resumedAgentId.trim()
      ? value.resumedAgentId.trim()
      : undefined;
  const success = typeof value.success === "boolean" ? value.success : undefined;
  if (!recipient && !summary && !message && !resultMessage && !resumedAgentId && success === undefined) {
    return undefined;
  }
  return {
    ...(recipient && { recipient }),
    ...(summary && { summary }),
    ...(message && { message }),
    ...(success !== undefined && { success }),
    ...(resultMessage && { resultMessage }),
    ...(resumedAgentId && { resumedAgentId }),
  };
}

function isSameToolReference(
  existing: ThreadRunToolMetadata | undefined,
  incoming: ThreadRunToolMetadata | undefined,
): boolean {
  if (!existing || !incoming || existing.name !== incoming.name) {
    return false;
  }
  return !existing.toolUseId || !incoming.toolUseId || existing.toolUseId === incoming.toolUseId;
}

function streamStateRank(state: ThreadRunEvent["streamState"]): number {
  switch (state) {
    case "placeholder":
      return 1;
    case "streaming":
      return 2;
    case "finalized":
      return 3;
    default:
      return 0;
  }
}

function isThreadRunToolStatus(value: unknown): value is NonNullable<ThreadRunToolMetadata["status"]> {
  return value === "started" || value === "completed" || value === "failed";
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsageAttributionJson(raw: string): UsageAttribution {
  try {
    const parsed = JSON.parse(raw) as Partial<UsageAttribution>;
    if (parsed.status === "attributed" && typeof parsed.agentId === "string" && parsed.agentId.trim()) {
      return { status: "attributed", agentId: parsed.agentId.trim() };
    }
    if (parsed.status === "pending") {
      return {
        status: "pending",
        ...(typeof parsed.reason === "string" && parsed.reason.trim()
          ? { reason: parsed.reason.trim() }
          : {}),
      };
    }
    if (parsed.status === "unattributed") {
      return {
        status: "unattributed",
        ...(typeof parsed.reason === "string" && parsed.reason.trim()
          ? { reason: parsed.reason.trim() }
          : {}),
      };
    }
  } catch {
    // malformed attribution is still auditable as unattributed.
  }
  return { status: "unattributed", reason: "invalid_attribution_json" };
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseEcoCostBreakdownJson(raw: string | null): TokenCostBreakdown {
  const empty = { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheCreationUsd: 0, totalUsd: 0 };
  if (!raw) {
    return empty;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TokenCostBreakdown>;
    return {
      inputUsd: parsed.inputUsd ?? 0,
      outputUsd: parsed.outputUsd ?? 0,
      cacheReadUsd: parsed.cacheReadUsd ?? 0,
      cacheCreationUsd: parsed.cacheCreationUsd ?? 0,
      totalUsd: parsed.totalUsd ?? 0,
    };
  } catch {
    return empty;
  }
}

function rowToThreadPendingFollowUp(row: ThreadPendingFollowUpRow): ThreadPendingFollowUp {
  const attachments = parsePromptImageAttachmentsJson(row.attachments_json);
  const queuedDuringPhase = normalizeThreadFollowUpRunPhase(row.queued_during_phase);
  return {
    id: row.id,
    threadId: row.thread_id,
    prompt: row.prompt,
    priority: isThreadFollowUpPriority(row.priority) ? row.priority : "normal",
    status: isThreadFollowUpStatus(row.status) ? row.status : "failed",
    deliveryMode: isThreadFollowUpDeliveryMode(row.delivery_mode) ? row.delivery_mode : "queued",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    ...(row.applied_at ? { appliedAt: row.applied_at } : {}),
    ...(row.source_run_attempt_id ? { sourceRunAttemptId: row.source_run_attempt_id } : {}),
    ...(row.target_run_attempt_id ? { targetRunAttemptId: row.target_run_attempt_id } : {}),
    ...(queuedDuringPhase ? { queuedDuringPhase } : {}),
    ...(isThreadFollowUpBoundary(row.delivery_boundary) ? { deliveryBoundary: row.delivery_boundary } : {}),
    ...(row.queue_position !== null ? { queuePosition: row.queue_position } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.conversation_message_id ? { conversationMessageId: row.conversation_message_id } : {}),
  };
}

function parsePromptImageAttachmentsJson(raw: string | null): PromptImageAttachment[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isPromptImageAttachment);
  } catch {
    return [];
  }
}

function isPromptImageAttachment(value: unknown): value is PromptImageAttachment {
  if (!isJsonRecord(value)) {
    return false;
  }
  if (!isPromptImageMediaType(value.mediaType)) {
    return false;
  }
  const data = typeof value.data === "string" ? value.data.trim() : "";
  const filePath = typeof value.path === "string" ? value.path.trim() : "";
  const contentRef = typeof value.contentRef === "string" ? value.contentRef.trim() : "";
  return data.length > 0 || filePath.length > 0 || /^sha256:[0-9a-f]{64}$/.test(contentRef);
}

/**
 * Follow-up rows are part of the V2 durable boundary after cutover. Preserve
 * only a content reference (or an explicit inline payload when no reference
 * exists); never persist an absolute local path in the V2 queue. A path-only
 * attachment is rejected instead of being silently dropped.
 */
function normalizeFollowUpAttachmentsForStorage(
  attachments: readonly PromptImageAttachment[] | undefined,
  v2Only: boolean,
): PromptImageAttachment[] | undefined {
  if (!attachments?.length) return undefined;
  if (!v2Only) return [...attachments];
  return attachments.map((attachment) => {
    const contentRef = attachment.contentRef?.trim() ?? "";
    const byteLength =
      typeof attachment.byteLength === "number" &&
      Number.isSafeInteger(attachment.byteLength) &&
      attachment.byteLength >= 0
        ? attachment.byteLength
        : undefined;
    if (/^sha256:[0-9a-f]{64}$/.test(contentRef)) {
      return {
        mediaType: attachment.mediaType,
        contentRef,
        ...(byteLength !== undefined ? { byteLength } : {}),
      };
    }
    const data = attachment.data?.trim() ?? "";
    if (data) {
      return {
        mediaType: attachment.mediaType,
        data,
        ...(byteLength !== undefined ? { byteLength } : {}),
      };
    }
    throw new ConversationV2Error(
      CONVERSATION_V2_ERROR.invalidParams,
      "V2 follow-up attachments require a contentRef or inline data.",
    );
  });
}

function isPromptImageMediaType(value: unknown): value is PromptImageAttachment["mediaType"] {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp";
}

function isThreadFollowUpStatus(value: unknown): value is ThreadFollowUpStatus {
  return (
    value === "queued" ||
    value === "delivered" ||
    value === "applied" ||
    value === "superseded" ||
    value === "cancelled" ||
    value === "failed"
  );
}

function isThreadFollowUpPriority(value: unknown): value is ThreadFollowUpPriority {
  return value === "normal" || value === "escalated";
}

function isThreadFollowUpDeliveryMode(value: unknown): value is ThreadFollowUpDeliveryMode {
  return (
    value === "queued" || value === "resume" || value === "interrupt_resume" || value === "streaming_push"
  );
}

function normalizeThreadFollowUpRunPhase(value: unknown): ThreadFollowUpRunPhase | undefined {
  if (value === "question") {
    return "ask";
  }
  if (value === "planning" || value === "execution" || value === "ask" || value === "continuation") {
    return value;
  }
  return undefined;
}

function isThreadFollowUpRunPhase(value: unknown): value is ThreadFollowUpRunPhase {
  return normalizeThreadFollowUpRunPhase(value) !== undefined;
}

const THREAD_SUMMARY_SELECT = `SELECT threads.id AS id,
                threads.title AS title,
                threads.prompt AS prompt,
                threads.workspace_path AS workspace_path,
                threads.status AS status,
                threads.message AS message,
                threads.created_at AS created_at,
                threads.updated_at AS updated_at,
                threads.core_kind AS core_kind,
                threads.core_locked_at AS core_locked_at,
                threads.acp_agent_id AS acp_agent_id,
                threads.sdk_session_id AS sdk_session_id,
                threads.sdk_cwd AS sdk_cwd,
                threads.runtime_config_json AS runtime_config_json,
                threads.follow_up_queue_paused AS follow_up_queue_paused,
                sessions.external_session_id AS external_session_id
         FROM threads
         LEFT JOIN thread_core_sessions AS sessions ON sessions.thread_id = threads.id`;

function isThreadFollowUpBoundary(value: unknown): value is ThreadFollowUpBoundary {
  return value === "safe_boundary" || value === "forced_interrupt";
}

function rowToThread(row: ThreadRow): ThreadSummary {
  const runtimeConfig = parseThreadRuntimeConfigJson(row.runtime_config_json);
  const upgraded = upgradeLegacyCursorCore({
    coreKind: row.core_kind,
    acpAgentId: row.acp_agent_id,
  });
  const coreKind = upgraded.coreKind;
  const acpAgentId =
    coreKind === "acp"
      ? (upgraded.acpAgentId ?? resolveAcpThreadAgentId({ acpAgentId: row.acp_agent_id ?? undefined }))
      : undefined;
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    workspacePath: row.workspace_path,
    status: row.status as ThreadStatus,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(coreKind ? { coreKind } : {}),
    ...(acpAgentId ? { acpAgentId } : {}),
    hostUiFeatures: resolveAcpHostUiFeatures({
      ...(coreKind ? { coreKind } : {}),
      ...(acpAgentId ? { acpAgentId } : {}),
    }),
    ...(row.core_locked_at ? { coreLockedAt: row.core_locked_at } : {}),
    ...(row.sdk_session_id && row.sdk_cwd ? { sdkSessionId: row.sdk_session_id, sdkCwd: row.sdk_cwd } : {}),
    ...(row.external_session_id?.trim() ? { externalSessionId: row.external_session_id.trim() } : {}),
    ...(runtimeConfig ? { runtimeConfig } : {}),
    ...(row.follow_up_queue_paused ? { followUpQueuePaused: true } : {}),
  };
}

function parseCoreSessionMetadata(
  value: string | null,
  threadId: string,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Core session metadata JSON is invalid: ${threadId}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Core session metadata must be an object: ${threadId}`);
  }
  return parsed as Record<string, unknown>;
}
