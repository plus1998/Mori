/**
 * Conversation storage/synchronisation V2 wire contract.
 *
 * This module intentionally contains no transport or database code.  Desktop,
 * mobile and replay tests use the same names, version fields and cursor rules.
 */

export const CONVERSATION_V2_PROTOCOL_VERSION = 2 as const;
export const CONVERSATION_V2_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_V2_EFFECT_VERSION = 1 as const;

export const CONVERSATION_V2_MAX_PAGE_SIZE = 100;
export const CONVERSATION_V2_MAX_SYNC_EVENTS = 500;
export const CONVERSATION_V2_DEFAULT_MAX_BYTES = 512 * 1024;

export type ConversationEventType =
  | "agent.created"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "agent.cancelled"
  | "agent.interrupted"
  | "message.accepted"
  | "message.created"
  | "message.delta"
  | "message.replaced"
  | "message.finalized"
  | "message.history_targeted"
  | "message.tombstoned"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.interrupted"
  /** Explicit, audited administrator correction of an already-recorded run. */
  | "run.corrected"
  | "tool.started"
  | "tool.updated"
  | "tool.completed"
  | "tool.failed"
  | "detail.upserted"
  | "approval.requested"
  | "approval.resolved"
  | "clarification.requested"
  | "clarification.resolved"
  | "todo.updated"
  | "history.edited"
  | "history.deleted"
  | "history.branch_created"
  | "history.regenerated"
  | "run.input_appended"
  | "noop";

export type ConversationMessageRole = "user" | "assistant" | "system" | "tool";
export type ConversationMessageChannel = "answer" | "commentary" | "thinking" | "system" | "tool";
export type ConversationMessageStatus =
  | "queued"
  | "streaming"
  | "final"
  | "failed"
  | "cancelled"
  | "deleted";

/**
 * Stable provider/history identity for a user prompt.
 *
 * `activityLineId` is the Eco-side prompt identity. `userMessageId` is the
 * provider-side message identity used by destructive Claude rewind. Both are
 * immutable facts once recorded; a missing provider id means the prompt may be
 * displayed but cannot be used for a destructive rewind.
 */
export interface ConversationMessageHistoryTarget {
  activityLineId: string;
  userMessageId?: string;
}
export type ConversationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";
export type ConversationToolStatus = "started" | "running" | "completed" | "failed" | "cancelled";

export interface ConversationEventInput {
  conversationId: string;
  eventId: string;
  type: ConversationEventType;
  occurredAt: string;
  sourceEventKey?: string;
  turnId?: string;
  runId?: string;
  messageId?: string;
  toolCallId?: string;
  agentId?: string;
  agentInstanceId?: string;
  parentAgentInstanceId?: string;
  parentAgentId?: string;
  parentToolCallId?: string;
  payload?: Record<string, unknown>;
}

export interface ConversationEventRecord extends ConversationEventInput {
  storeEpoch: string;
  seq: number;
  recordedAt: string;
  schemaVersion: typeof CONVERSATION_V2_SCHEMA_VERSION;
  payload: Record<string, unknown>;
  eventHash: string;
}

export type ConversationEffect =
  | {
      type: "message.create";
      message: ConversationMessage;
    }
  | {
      type: "message.append";
      messageId: string;
      baseContentVersion: number;
      nextContentVersion: number;
      delta: string;
      versionSeq: number;
    }
  | {
      type: "message.replace";
      messageId: string;
      baseContentVersion: number;
      nextContentVersion: number;
      body: string;
      versionSeq: number;
      /** Queue edits replace images together with the text, including removal. */
      attachments?: unknown[];
    }
  | {
      type: "message.finalize";
      messageId: string;
      contentVersion: number;
      versionSeq: number;
      status: Exclude<ConversationMessageStatus, "queued" | "streaming" | "deleted">;
      /** Wall-clock time when the message became deliverable to the provider. */
      occurredAt?: string;
      /** Replaces transport-local attachment paths with mobile-readable previews or refs. */
      attachments?: unknown[];
    }
  | {
      type: "message.tombstone";
      messageId: string;
      versionSeq: number;
    }
  | {
      type: "message.history_target";
      messageId: string;
      historyTarget: ConversationMessageHistoryTarget;
      versionSeq: number;
    }
  | {
      type: "run.upsert";
      run: ConversationRun;
    }
  | {
      type: "agent.upsert";
      agent: ConversationAgent;
    }
  | {
      type: "todo.list.replace";
      todos: ConversationTodo[];
    }
  | {
      type: "tool.summary.upsert";
      toolCall: ConversationToolCall;
    }
  | {
      type: "detail.upsert";
      detail: ConversationDetailItem;
    }
  | {
      type: "detail.invalidation";
      runId?: string;
      toolCallId?: string;
    }
  | {
      type: "history.invalidation";
      historyRevision: number;
    }
  | {
      type: "noop";
      reason: string;
    };

export interface ConversationSyncEffect {
  seq: number;
  effectVersion: typeof CONVERSATION_V2_EFFECT_VERSION;
  effectHash: string;
  effect: ConversationEffect;
}

export interface ConversationMessageOrigin {
  kind: "scheduled_message";
  scheduleId: string;
  name: string;
}

export function isConversationMessageOrigin(value: unknown): value is ConversationMessageOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const origin = value as Record<string, unknown>;
  return origin.kind === "scheduled_message" &&
    typeof origin.scheduleId === "string" && origin.scheduleId.trim().length > 0 && origin.scheduleId.length <= 200 &&
    typeof origin.name === "string" && origin.name.trim().length > 0 && origin.name.length <= 200 &&
    Object.keys(origin).every(key => key === "kind" || key === "scheduleId" || key === "name");
}

export interface ConversationMessage {
  messageId: string;
  conversationId: string;
  turnId: string;
  runId?: string;
  role: ConversationMessageRole;
  channel: ConversationMessageChannel;
  createdSeq: number;
  versionSeq: number;
  contentVersion: number;
  body: string;
  /** UI provenance, kept separate from the text delivered to the provider. */
  origin?: ConversationMessageOrigin;
  /** Small user-prompt image previews or durable attachment references. */
  attachments?: unknown[];
  /**
   * Owning agent instance, absent for the main agent's messages. A subagent's
   * narration carries the same identity its tools do, which is what lets clients
   * keep subagent output out of the main Feed instead of merging it in.
   */
  agentId?: string;
  agentInstanceId?: string;
  /**
   * When the row happened, from the event that produced it. Sequence numbers say when
   * a reader learned about a row, so a client that only has them cannot place a message
   * between two tools of the same turn.
   */
  occurredAt?: string;
  /** First observed thinking start, retained when finalization updates occurredAt. */
  startedAt?: string;
  /**
   * The provider's own label for the row (`main`, `coder`, `explore`, ...), kept
   * separate from `role`. `role` is the normalized channel role a client switches on;
   * this is the fact a Feed uses to pick a turn's final output and to attribute a row to
   * the role that wrote it. Normalizing it away makes those questions unanswerable.
   */
  providerRole?: string;
  /** Stable identity needed to perform a safe history rewrite/retry. */
  historyTarget?: ConversationMessageHistoryTarget;
  status: ConversationMessageStatus;
  isDeleted: boolean;
}

export interface ConversationRun {
  runId: string;
  conversationId: string;
  turnId: string;
  status: ConversationRunStatus;
  startedAt?: string;
  endedAt?: string;
  versionSeq: number;
  timingQuality: "recorded" | "unknown" | "estimated";
  retryOfRunId?: string;
  regenerationOfRunId?: string;
}

export interface ConversationTurnSummary {
  turnId: string;
  conversationId: string;
  createdSeq: number;
  activeRunId?: string;
  versionSeq: number;
}

export interface ConversationToolCall {
  toolCallId: string;
  conversationId: string;
  runId: string;
  agentId?: string;
  agentInstanceId?: string;
  parentAgentInstanceId?: string;
  parentToolCallId?: string;
  name: string;
  status: ConversationToolStatus;
  createdSeq: number;
  versionSeq: number;
  /** When the call happened; see `ConversationMessage.occurredAt`. */
  occurredAt?: string;
  /** See `ConversationMessage.providerRole`. */
  providerRole?: string;
  input?: unknown;
  output?: unknown;
}

/** The read-side tool summary budget, shared by paged reads and renderer comparisons. */
export function limitConversationToolSummaryPayload(tool: ConversationToolCall): ConversationToolCall {
  const input = boundedToolPayload(tool.input);
  const output = boundedToolPayload(tool.output);
  return {
    ...tool,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function boundedToolPayload(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return value.length <= 4000 ? value : `${value.slice(0, 4000)}…`;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return String(value).slice(0, 1000);
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => boundedToolPayload(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 48);
    return Object.fromEntries(entries.map(([key, item]) => [key, boundedToolPayload(item, depth + 1)]));
  }
  return String(value).slice(0, 1000);
}

export interface ConversationDetailItem {
  itemId: string;
  conversationId: string;
  runId: string;
  agentId?: string;
  agentInstanceId?: string;
  parentAgentInstanceId?: string;
  parentAgentId?: string;
  parentToolCallId?: string;
  toolCallId?: string;
  type: string;
  createdSeq: number;
  versionSeq: number;
  content?: string;
  ref?: string;
}

export type ConversationTodoStatus = "pending" | "running" | "completed" | "blocked" | "cancelled";

export interface ConversationTodo {
  todoId: string;
  conversationId: string;
  title: string;
  detail: string;
  status: ConversationTodoStatus;
  position: number;
  updatedAt: string;
  versionSeq: number;
}

export interface ConversationCursor {
  kind: "messages" | "details" | "tools";
  storeEpoch: string;
  historyRevision: number;
  createdSeq: number;
  id: string;
  /** Message timeline boundary; absent on legacy sequence-ordered cursors. */
  occurredAt?: string;
}

export interface ConversationCapabilities {
  protocolVersion: typeof CONVERSATION_V2_PROTOCOL_VERSION;
  eventSchemaVersion: typeof CONVERSATION_V2_SCHEMA_VERSION;
  effectVersion: typeof CONVERSATION_V2_EFFECT_VERSION;
  maxEvents: number;
  maxBytes: number;
  storeEpoch: string;
}

export interface ConversationAgent {
  /**
   * The agent instance id that messages, tools and detail items reference as
   * `agentInstanceId`. It is the conversation-level identity of an agent, which
   * is what lets a client keep one agent's narration on its own card.
   */
  agentId: string;
  conversationId: string;
  role: string;
  kind: string;
  status: string;
  runId?: string;
  parentAgentInstanceId?: string;
  parentToolCallId?: string;
  startedAt?: string;
  endedAt?: string;
  /** Mission/delegation text that opened the agent, when it has one. */
  mission?: string;
  /** The label the provider gave this agent's task, shown as the card's own title. */
  taskName?: string;
  /** What the agent was asked to do, in the words the delegating model used. */
  delegationSummary?: string;
  delegationPrompt?: string;
  todoId?: string;
  versionSeq: number;
}

export interface ConversationBootstrap {
  protocolVersion: typeof CONVERSATION_V2_PROTOCOL_VERSION;
  storeEpoch: string;
  conversationId: string;
  snapshotSeq: number;
  historyRevision: number;
  messages: ConversationMessage[];
  turns: ConversationTurnSummary[];
  runs: ConversationRun[];
  tools: ConversationToolCall[];
  /** Total tool summaries per run; tools themselves may be capped to the bootstrap window. */
  toolSummaryCounts?: Record<string, number>;
  /**
   * Agents of the visible window. Without them a client can only infer agent
   * identity from tool rows, which loses role, mission and parent links.
   */
  agents?: ConversationAgent[];
  todos?: ConversationTodo[];
  /** Recent context lifecycle notices plus each owner's latest state, independent of message paging. */
  details?: ConversationDetailItem[];
  olderCursor?: string;
  hasOlder: boolean;
}

export interface ConversationMessagesPage {
  protocolVersion: typeof CONVERSATION_V2_PROTOCOL_VERSION;
  storeEpoch: string;
  conversationId: string;
  readSeq: number;
  historyRevision: number;
  messages: ConversationMessage[];
  /** Run/tool summaries needed to render the page without a second legacy source. */
  runs?: ConversationRun[];
  tools?: ConversationToolCall[];
  /** Total tool summaries per run; fetch the remainder through tools.page. */
  toolSummaryCounts?: Record<string, number>;
  agents?: ConversationAgent[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface ConversationDetailsPage {
  protocolVersion: typeof CONVERSATION_V2_PROTOCOL_VERSION;
  storeEpoch: string;
  conversationId: string;
  readSeq: number;
  historyRevision: number;
  items: ConversationDetailItem[];
  nextCursor?: string;
  hasMore: boolean;
}

/** Bounded tool-summary window; full input/output remains on details.page. */
export interface ConversationToolsPage {
  protocolVersion: typeof CONVERSATION_V2_PROTOCOL_VERSION;
  storeEpoch: string;
  conversationId: string;
  runId: string;
  readSeq: number;
  historyRevision: number;
  tools: ConversationToolCall[];
  totalCount: number;
  nextCursor?: string;
  hasMore: boolean;
}

export interface ConversationSyncPage {
  protocolVersion: typeof CONVERSATION_V2_PROTOCOL_VERSION;
  storeEpoch: string;
  conversationId: string;
  fromSeq: number;
  throughSeq: number;
  headSeq: number;
  hasMore: boolean;
  effects: ConversationSyncEffect[];
}

export interface ConversationHead {
  protocolVersion: typeof CONVERSATION_V2_PROTOCOL_VERSION;
  storeEpoch: string;
  conversationId: string;
  lastSeq: number;
  historyRevision: number;
}

export interface ConversationSendMessageResult {
  protocolVersion: typeof CONVERSATION_V2_PROTOCOL_VERSION;
  conversationId: string;
  clientCommandId: string;
  messageId: string;
  turnId: string;
  acceptedSeq: number;
  status: "queued";
}

export const CONVERSATION_V2_ERROR = {
  unauthorized: "unauthorized",
  conversationNotFound: "conversation_not_found",
  unsupportedVersion: "unsupported_version",
  epochMismatch: "epoch_mismatch",
  invalidCursor: "invalid_cursor",
  cursorStale: "cursor_stale",
  rangeUnavailable: "range_unavailable",
  idempotencyConflict: "idempotency_conflict",
  storageFailure: "storage_failure",
  migrationIncomplete: "migration_incomplete",
  integrityFailure: "integrity_failure",
  payloadTooLarge: "payload_too_large",
  invalidParams: "invalid_params",
} as const;

export type ConversationV2ErrorCode = (typeof CONVERSATION_V2_ERROR)[keyof typeof CONVERSATION_V2_ERROR];

export class ConversationV2Error extends Error {
  readonly code: ConversationV2ErrorCode;
  readonly data?: Record<string, unknown>;

  constructor(code: ConversationV2ErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "ConversationV2Error";
    this.code = code;
    if (data) this.data = data;
  }
}

export function encodeConversationCursor(cursor: ConversationCursor): string {
  const json = JSON.stringify(cursor);
  return toBase64Url(json);
}

export function decodeConversationCursor(value: string, expectedKind?: ConversationCursor["kind"]): ConversationCursor {
  if (typeof value !== "string" || value.length < 8 || value.length > 4096) {
    throw new ConversationV2Error(CONVERSATION_V2_ERROR.invalidCursor, "Conversation cursor is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(value));
  } catch {
    throw new ConversationV2Error(CONVERSATION_V2_ERROR.invalidCursor, "Conversation cursor is invalid.");
  }
  if (!isConversationCursor(parsed) || (expectedKind && parsed.kind !== expectedKind)) {
    throw new ConversationV2Error(CONVERSATION_V2_ERROR.invalidCursor, "Conversation cursor is invalid.");
  }
  return parsed;
}

export function compareConversationMessagePosition(
  left: Pick<ConversationMessage, "createdSeq" | "messageId">,
  right: Pick<ConversationMessage, "createdSeq" | "messageId">,
): number {
  return left.createdSeq - right.createdSeq || left.messageId.localeCompare(right.messageId);
}

export function estimateConversationBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function stableHash(value: unknown): string {
  const input = stableJson(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isConversationCursor(value: unknown): value is ConversationCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<ConversationCursor>;
  const historyRevision = cursor.historyRevision;
  const createdSeq = cursor.createdSeq;
  return (
    (cursor.kind === "messages" || cursor.kind === "details" || cursor.kind === "tools") &&
    typeof cursor.storeEpoch === "string" &&
    cursor.storeEpoch.length > 0 &&
    typeof historyRevision === "number" &&
    Number.isInteger(historyRevision) &&
    historyRevision >= 0 &&
    typeof createdSeq === "number" &&
    Number.isInteger(createdSeq) &&
    createdSeq > 0 &&
    (cursor.occurredAt === undefined || typeof cursor.occurredAt === "string") &&
    typeof cursor.id === "string" &&
    cursor.id.length > 0
  );
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
