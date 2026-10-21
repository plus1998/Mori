/**
 * Maps Codex app-server JSON-RPC notifications (`item/*`, `turn/*`) to Eco
 * `ThreadRunEvent` inputs.
 *
 * Notification shapes follow `codex-app-server-protocol` v2 (camelCase):
 * - `turn/started|completed`: `{ threadId, turn: { id, status, error?, ... } }`
 * - `item/started|completed`: `{ threadId, turnId, item: { id, type, ... } }`
 * - `item/agentMessage/delta`: `{ threadId, turnId, itemId, delta }`
 * - `item/reasoning/summaryPartAdded`: `{ threadId, turnId, itemId, summaryIndex }`
 * - `item/reasoning/summaryTextDelta`: `{ threadId, turnId, itemId, delta, summaryIndex? }`
 *
 * **itemId → logicalEntityId**: every item-scoped event uses `streamKey = itemId`
 * so projection can merge `message.delta` chunks and the final `message.final`
 * for the same assistant message.
 *
 * @see docs/codex-integration-plan.md §4.5
 */

import { summarizeAgentObjective } from "./agent-mission.js";
import {
  type CodexContextSnapshotResolution,
  parseCodexThreadTokenUsage,
  resolveCodexContextFromNotification,
} from "./codex-context-snapshot.js";
import type { CodexSpawnPayload, CodexSpawnPayloadMatchInput } from "./codex-spawn-role-queue.js";
import type { CodexThreadAttribution } from "./codex-thread-attribution.js";
import type { CodexTurnRouteRecord, CodexTurnRouteRegistry } from "./codex-turn-route-registry.js";
import { resolveEcoMcpHubSearchCall, resolveEcoMcpHubToolCall } from "./eco-mcp-hub-tool.js";
import { resolveEcoImageViewToolCall } from "./eco-image-view-tool.js";
import { readMcpToolOutputText } from "./mcp-tool-output-text.js";
import {
  isAgentBrowserScreenshotToolName,
  isEcoImageDisplayToolName,
  readAbsolutePathFromMcpToolOutput,
  readImageDisplayMetadataFromToolOutput,
} from "./eco-image-display-tool.js";
import {
  isEcoHtmlHostToolName,
  readHtmlHostMetadataFromToolOutput,
} from "./eco-html-host-tool.js";
import {
  isEcoWebSearchToolName,
  parseEcoWebSearchToolOutput,
  readEcoWebSearchQuery,
} from "./eco-web-search-tool.js";
import { CODEX_GENERAL_SPAWN_ROLE } from "./subagent-availability.js";
import {
  appendToolOutputPreviewCapture,
  createToolOutputPreview,
  materializeToolOutputPreviewCapture,
  type ToolOutputPreviewCapture,
} from "./tool-output-preview.js";

/** Subset of `ThreadRunEventType` emitted by this adapter. */
export type CodexThreadRunEventType =
  | "run.attempt.started"
  | "run.attempt.completed"
  | "run.attempt.failed"
  | "run.attempt.cancelled"
  | "message.delta"
  | "message.final"
  | "thinking.delta"
  | "thinking.final"
  | "thread.status"
  | "api.error"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "agent.started"
  | "agent.stopped"
  | "agent.abandoned"
  | "context.compaction.started"
  | "context.compaction.completed";

type CodexCommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined";

interface CodexCommandExecutionFields {
  command: string;
  description?: string;
  status?: CodexCommandExecutionStatus;
  aggregatedOutput?: string;
  exitCode?: number;
  durationMs?: number;
}

export type CodexThreadAttributionRecord = {
  parentThreadId: string;
  /** Orchestration role id when known; parent link alone is enough for Eco thread resolution. */
  agentRole?: string | undefined;
  agentNickname?: string | undefined;
  spawnCallId?: string | undefined;
  /** spawn_agent `message` when known (card mission text). */
  spawnMessage?: string | undefined;
};

export type CodexThreadRunEventScope = "main" | "agent" | "both";

export type CodexThreadRunEventStreamState = "none" | "placeholder" | "streaming" | "finalized";

export type CodexTurnPlanStepStatus = "pending" | "inProgress" | "completed";

export interface CodexTurnPlanStep {
  step: string;
  status: CodexTurnPlanStepStatus;
}

export interface CodexTurnPlanUpdatedInput {
  ecoThreadId: string;
  codexThreadId: string;
  turnId: string;
  explanation?: string;
  plan: CodexTurnPlanStep[];
}

/** Compatible with `apps/desktop/src/shared/thread-run-events.ts` `ThreadRunEventInput`. */
export interface CodexThreadRunEventInput {
  id: string;
  threadId: string;
  sequence?: number;
  eventType: CodexThreadRunEventType;
  scope: CodexThreadRunEventScope;
  streamState: CodexThreadRunEventStreamState;
  message: string;
  observedAt: string;
  role?: string;
  agentId?: string;
  parentAgentId?: string;
  parentToolUseId?: string;
  runAttemptId?: string;
  requestId?: string;
  streamKey?: string;
  metadata?: Record<string, unknown>;
}

/**
 * One `request_user_input_async` question as app-server serializes it onto the
 * `agentMessage` item (`AsyncUserInputQuestion`). `options: null` = free text only.
 */
export interface CodexAsyncUserInputQuestion {
  title: string;
  options: string[] | null;
}

/**
 * A Codex 0.160 async question message.
 *
 * Async questions are *not* a server request: `request_user_input_async` emits an
 * `agentMessage` item whose `id` is the tool call id, carrying `delivery: "async"`
 * and the questions. The turn keeps running, and the reply arrives later as an
 * ordinary user message. `itemId` is therefore the question identity used to build
 * the `questionItemId` the upstream reply envelope expects.
 */
export interface CodexAsyncQuestionsInput {
  ecoThreadId: string;
  codexThreadId: string;
  turnId?: string | undefined;
  /** agentMessage item id == `request_user_input_async` call id. */
  itemId: string;
  /** Item text: the joined question titles (what the feed shows as the message). */
  message: string;
  questions: CodexAsyncUserInputQuestion[];
}

export interface CodexEventAdapterOptions {
  /** Map Codex `threadId` from notifications to Eco thread id. */
  resolveEcoThreadId: (codexThreadId: string) => string;
  recordThreadRunEvent: (event: CodexThreadRunEventInput) => void;
  /** Optional richer attribution for billing (sub-thread roles, agentId). */
  resolveThreadAttribution?: (codexThreadId: string) => CodexThreadAttribution | undefined;
  /** Shared with CodexAppServerDriver; official completion notifications omit route and usage. */
  turnRouteRegistry?: CodexTurnRouteRegistry;
  /** Persist `parentThreadId` + `agentRole` when spawn / `thread/started` arrives (§6.4). */
  recordThreadAttribution?: (codexThreadId: string, record: CodexThreadAttributionRecord) => void;
  /** Read persisted attribution (parent codex id + agentRole) for lifecycle close events. */
  getThreadAttributionRecord?: (codexThreadId: string) => CodexThreadAttributionRecord | undefined;
  /** Consume a queued spawn payload only by the official spawn call id. */
  dequeueSpawnPayloadMatching?: (input: CodexSpawnPayloadMatchInput) => CodexSpawnPayload | undefined;
  /** Orchestration custom-agent role ids synced into `$CODEX_HOME/agents`. */
  orchestrationRoleIds?: readonly string[];
  /** Runtime getter for role ids when the adapter is configured before role sync finishes. */
  resolveOrchestrationRoleIds?: () => readonly string[] | undefined;
  /** Called when `turn/started` is observed (main or child). */
  onTurnStarted?: (input: { codexThreadId: string; turnId: string }) => void;
  /** Called when `thread/tokenUsage/updated` yields context occupancy (§4.4). */
  onTokenUsageUpdated?: (resolution: CodexContextSnapshotResolution) => void;
  /** Called with the authoritative main-thread task snapshot from `turn/plan/updated`. */
  onTurnPlanUpdated?: (input: CodexTurnPlanUpdatedInput) => void;
  /**
   * Called for `agentMessage` items carrying `delivery: "async"` + questions.
   * Fired for both `item/started` and `item/completed` (upstream emits the same
   * item twice); consumers must dedupe by thread + turn + message id.
   */
  onAsyncQuestions?: (input: CodexAsyncQuestionsInput) => void;
  /** Called when app-server completes a native Plan item. */
  onPlanReady?: (input: {
    ecoThreadId: string;
    codexThreadId: string;
    turnId?: string;
    itemId: string;
    plan: string;
    planFilePath?: string;
  }) => void;
  now?: () => string;
}

type EmitInput = {
  eventType: CodexThreadRunEventType;
  codexThreadId: string;
  turnId?: string | undefined;
  itemId?: string | undefined;
  role?: string | undefined;
  message: string;
  streamState: CodexThreadRunEventStreamState;
  scope?: CodexThreadRunEventScope | undefined;
  agentId?: string | undefined;
  parentToolUseId?: string | undefined;
  /** Stable id so streaming updates merge (tool output / lifecycle). */
  stableEventId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

type AdapterContext = CodexEventAdapterOptions & {
  observedAt: string;
  eventCounter: number;
  commandOutputPreviewByItemId: Map<string, ToolOutputPreviewCapture>;
  reasoningTextByItemId: Map<string, string>;
  /** summary vs raw CoT for Feed stage lines; last write wins per item. */
  reasoningDisplayByItemId: Map<string, "summary" | "raw">;
  /** Last summaryIndex seen per reasoning item (Codex / Responses multi-part). */
  reasoningSummaryIndexByItemId: Map<string, number>;
  /** Insert `\n` before the next summary delta after summaryPartAdded. */
  reasoningSummaryNeedsSeparatorByItemId: Set<string>;
  /** Per-reasoning-item wall-clock start; request TTFT is not a reasoning duration. */
  reasoningStartedAtByItemId: Map<string, string>;
  agentMessageTextByItemId: Map<string, string>;
  pendingEventsByCodexThreadId: Map<string, EmitInput[]>;
  /** Async question messages that arrived before their Codex thread was attributed. */
  pendingAsyncQuestionsByCodexThreadId: Map<string, Omit<CodexAsyncQuestionsInput, "ecoThreadId">[]>;
  /** Dedupe agent.started from spawn item + thread/started for the same child. */
  emittedAgentStartedIds: Set<string>;
  /** Same absolute path from native imageView + eco_image_view MCP → one Feed card. */
  emittedImageViewPaths: Set<string>;
  /** display_image artifact ids emitted once per tool item. */
  emittedImageDisplayArtifacts: Set<string>;
};

type NotificationHandler = (ctx: AdapterContext, params: Record<string, unknown>) => void;

/** Item types the adapter projects into Feed / lifecycle events. */
const HANDLED_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "imageView",
  "reasoning",
  "plan",
  "contextCompaction",
  "subAgentActivity",
  "collabAgentToolCall",
]);

const POC_HANDLERS: Record<string, NotificationHandler> = {
  "turn/started": handleTurnStarted,
  "turn/completed": handleTurnCompleted,
  "turn/plan/updated": handleTurnPlanUpdated,
  "thread/started": handleThreadStarted,
  "thread/closed": handleThreadRouteCleanup,
  "thread/deleted": handleThreadRouteCleanup,
  "thread/tokenUsage/updated": handleTokenUsageUpdated,
  "item/started": handleItemStarted,
  "item/agentMessage/delta": handleAgentMessageDelta,
  "item/reasoning/summaryPartAdded": handleReasoningSummaryPartAdded,
  "item/reasoning/summaryTextDelta": handleReasoningSummaryTextDelta,
  "item/reasoning/textDelta": handleReasoningTextDelta,
  "item/commandExecution/outputDelta": handleCommandExecutionOutputDelta,
  "item/completed": handleItemCompleted,
  deprecationNotice: handleDeprecationNotice,
  "model/safetyBuffering/updated": handleModelSafetyBufferingUpdated,
  "modelProvider/authRecoveryStarted": handleModelProviderAuthRecoveryStarted,
  "modelProvider/authRecoveryCompleted": handleModelProviderAuthRecoveryCompleted,
};

export class CodexEventAdapter {
  private eventCounter = 0;
  /** Keep only a bounded in-memory preview; output deltas are not projection events. */
  private readonly commandOutputPreviewByItemId = new Map<string, ToolOutputPreviewCapture>();
  /** Accumulate reasoning/thinking text for thinking cards. */
  private readonly reasoningTextByItemId = new Map<string, string>();
  /** summary vs raw CoT for Feed stage lines; last write wins per item. */
  private readonly reasoningDisplayByItemId = new Map<string, "summary" | "raw">();
  /** Last summaryIndex seen per reasoning item (Codex / Responses multi-part). */
  private readonly reasoningSummaryIndexByItemId = new Map<string, number>();
  /** Insert `\n` before the next summary delta after summaryPartAdded. */
  private readonly reasoningSummaryNeedsSeparatorByItemId = new Set<string>();
  /** Per-reasoning-item wall-clock start; request TTFT is not a reasoning duration. */
  private readonly reasoningStartedAtByItemId = new Map<string, string>();
  /**
   * Accumulate agentMessage delta chunks.
   * Projection/view merge keeps the latest stream item's text (not chunk-append),
   * so each `message.delta` must carry the full prefix so far.
   */
  private readonly agentMessageTextByItemId = new Map<string, string>();
  /**
   * Child-thread events may arrive before spawn / thread/started attribution.
   * Buffer until parent eco thread id is known — never write an unmapped Codex id.
   */
  private readonly pendingEventsByCodexThreadId = new Map<string, EmitInput[]>();
  private readonly pendingAsyncQuestionsByCodexThreadId = new Map<
    string,
    Omit<CodexAsyncQuestionsInput, "ecoThreadId">[]
  >();
  private readonly emittedAgentStartedIds = new Set<string>();
  private readonly emittedImageViewPaths = new Set<string>();
  private readonly emittedImageDisplayArtifacts = new Set<string>();

  constructor(private readonly options: CodexEventAdapterOptions) {}

  private buildContext(): AdapterContext {
    return {
      ...this.options,
      observedAt: this.options.now?.() ?? new Date().toISOString(),
      eventCounter: this.eventCounter,
      commandOutputPreviewByItemId: this.commandOutputPreviewByItemId,
      reasoningTextByItemId: this.reasoningTextByItemId,
      reasoningDisplayByItemId: this.reasoningDisplayByItemId,
      reasoningSummaryIndexByItemId: this.reasoningSummaryIndexByItemId,
      reasoningSummaryNeedsSeparatorByItemId: this.reasoningSummaryNeedsSeparatorByItemId,
      reasoningStartedAtByItemId: this.reasoningStartedAtByItemId,
      agentMessageTextByItemId: this.agentMessageTextByItemId,
      pendingEventsByCodexThreadId: this.pendingEventsByCodexThreadId,
      pendingAsyncQuestionsByCodexThreadId: this.pendingAsyncQuestionsByCodexThreadId,
      emittedAgentStartedIds: this.emittedAgentStartedIds,
      emittedImageViewPaths: this.emittedImageViewPaths,
      emittedImageDisplayArtifacts: this.emittedImageDisplayArtifacts,
    };
  }

  dispatch(method: string, params: unknown): void {
    const handler = POC_HANDLERS[method];
    if (!handler || !isRecord(params)) {
      return;
    }
    const ctx = this.buildContext();
    handler(ctx, params);
    this.eventCounter = ctx.eventCounter;
  }

  /** Replay events buffered while a child Codex thread lacked parent attribution. */
  flushPendingEventsForThread(codexThreadId: string): void {
    const id = codexThreadId.trim();
    const pending = this.pendingEventsByCodexThreadId.get(id);
    const pendingQuestions = this.pendingAsyncQuestionsByCodexThreadId.get(id);
    if (!pending?.length && !pendingQuestions?.length) {
      return;
    }
    this.pendingEventsByCodexThreadId.delete(id);
    this.pendingAsyncQuestionsByCodexThreadId.delete(id);
    const ctx = this.buildContext();
    for (const input of pending ?? []) {
      emit(ctx, input);
    }
    for (const input of pendingQuestions ?? []) {
      dispatchAsyncQuestions(ctx, input);
    }
    this.eventCounter = ctx.eventCounter;
  }

  /**
   * Retry every buffered Codex thread. Call when a parent eco↔codex mapping is
   * established so children that only had a parent link can resolve.
   */
  flushAllPendingEvents(): void {
    const pendingThreadIds = new Set([
      ...this.pendingEventsByCodexThreadId.keys(),
      ...this.pendingAsyncQuestionsByCodexThreadId.keys(),
    ]);
    for (const codexThreadId of pendingThreadIds) {
      this.flushPendingEventsForThread(codexThreadId);
    }
  }
}

/** Replay newline-delimited JSON-RPC notifications (fixture / test helper). */
export function replayCodexNotificationFixture(
  fixture: string,
  options: CodexEventAdapterOptions,
): CodexThreadRunEventInput[] {
  const events: CodexThreadRunEventInput[] = [];
  const adapter = new CodexEventAdapter({
    ...options,
    recordThreadRunEvent: (event) => {
      events.push(event);
    },
  });

  for (const line of fixture.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const record = JSON.parse(trimmed) as { method?: string; params?: unknown };
    if (typeof record.method === "string") {
      adapter.dispatch(record.method, record.params ?? {});
    }
  }

  return events;
}

function handleTurnStarted(ctx: AdapterContext, params: Record<string, unknown>): void {
  const codexThreadId = readCodexThreadId(params);
  const turnId = readCodexTurnRecordId(params);
  if (!codexThreadId || !turnId) {
    return;
  }

  ctx.onTurnStarted?.({ codexThreadId, turnId });

  emit(ctx, {
    eventType: "run.attempt.started",
    codexThreadId,
    turnId,
    message: "Turn started",
    streamState: "none",
    metadata: {
      codexMethod: "turn/started",
      codexThreadId,
      turnId,
    },
  });
}

function handleTurnCompleted(ctx: AdapterContext, params: Record<string, unknown>): void {
  const codexThreadId = readCodexThreadId(params);
  const turnId = readCodexTurnRecordId(params);
  const status = readCodexTurnStatus(params);
  if (!codexThreadId || !turnId || !status) {
    return;
  }

  // Consume before emitting/callbacks so every terminal status and thrown callback
  // clears the route exactly once.
  const turnRoute = ctx.turnRouteRegistry?.consume(codexThreadId, turnId);
  const appServerTokenUsage = turnRoute?.appServerTokenUsage;
  const errorMessage = readCodexTurnErrorMessage(params);
  const interrupted = status === "interrupted";
  const failed = status === "failed";
  const attribution = ctx.resolveThreadAttribution?.(codexThreadId);

  // V2: child subagent completion is `turn/completed` on the child thread — not
  // `collabAgentToolCall` / `subAgentActivity`. Close the agent card on the parent
  // thread only; never treat child turn terminal as parent session end.
  if (attribution?.isSubagentThread && attribution.agentId === codexThreadId) {
    const record = ctx.getThreadAttributionRecord?.(codexThreadId);
    const parentCodexThreadId = record?.parentThreadId?.trim();
    const lifecycleRole = resolveSubagentDisplayRole(
      ctx,
      resolveChosenOrchestrationRole(ctx, record?.agentRole),
    );
    if (parentCodexThreadId && parentCodexThreadId !== codexThreadId) {
      const abandoned = interrupted || failed;
      emitAgentLifecycle(ctx, {
        eventType: abandoned ? "agent.abandoned" : "agent.stopped",
        codexThreadId: parentCodexThreadId,
        turnId,
        agentId: codexThreadId,
        ...(record?.spawnCallId && { parentToolUseId: record.spawnCallId }),
        role: lifecycleRole,
        message: abandoned
          ? `Subagent ${lifecycleRole} interrupted`
          : `Subagent ${lifecycleRole} completed`,
        metadata: {
          codexMethod: "turn/completed",
          liveType: abandoned ? "agent.abandoned" : "agent.stopped",
          codexThreadId,
          turnId,
          status,
          subagentChildTurn: true,
        },
      });
    }
    // Gateway request usage is the only Codex ledger source. This terminal event
    // closes lifecycle state and consumes the registry; it must never bill again.
    return;
  }

  // User interrupt is cancel, not an upstream connection failure — the turn
  // heading already says "you stopped"; do not emit a red api.error banner.
  const eventType = interrupted
    ? "run.attempt.cancelled"
    : failed
      ? "run.attempt.failed"
      : "run.attempt.completed";
  emit(ctx, {
    eventType,
    codexThreadId,
    turnId,
    message: failed || interrupted ? (errorMessage ?? `Turn ${status}`) : `Turn ${status}`,
    streamState: "finalized",
    metadata: {
      codexMethod: "turn/completed",
      codexThreadId,
      turnId,
      status,
      ...(appServerTokenUsage ? { appServerTokenUsage } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    },
  });

  if (failed) {
    emit(ctx, {
      eventType: "api.error",
      codexThreadId,
      turnId,
      message: errorMessage ?? `Codex turn ${status}`,
      streamState: "finalized",
      metadata: {
        codexMethod: "turn/completed",
        liveType: "thread.api_error",
        codexThreadId,
        turnId,
        status,
        apiError: {
          message: errorMessage ?? `Codex turn ${status}`,
        },
      },
    });
  }
}

function handleTurnPlanUpdated(ctx: AdapterContext, params: Record<string, unknown>): void {
  const codexThreadId = readCodexThreadId(params);
  const turnId = readString(params, "turnId");
  if (!codexThreadId || !turnId) {
    emitTurnPlanProtocolGap(ctx, params, "missing threadId or turnId");
    return;
  }

  const attribution = ctx.resolveThreadAttribution?.(codexThreadId);
  const attributionRecord = ctx.getThreadAttributionRecord?.(codexThreadId);
  const parentCodexThreadId = attributionRecord?.parentThreadId?.trim();
  if (attribution?.isSubagentThread || (parentCodexThreadId && parentCodexThreadId !== codexThreadId)) {
    return;
  }

  const explanation = readTurnPlanExplanation(params);
  if (!explanation.ok) {
    emitTurnPlanProtocolGap(ctx, params, explanation.reason);
    return;
  }
  const parsedPlan = parseTurnPlanSteps(params.plan);
  if (!parsedPlan.ok) {
    emitTurnPlanProtocolGap(ctx, params, parsedPlan.reason);
    return;
  }

  ctx.onTurnPlanUpdated?.({
    ecoThreadId: ctx.resolveEcoThreadId(codexThreadId),
    codexThreadId,
    turnId,
    ...(explanation.value ? { explanation: explanation.value } : {}),
    plan: parsedPlan.value,
  });
}

function readTurnPlanExplanation(
  params: Record<string, unknown>,
): { ok: true; value?: string } | { ok: false; reason: string } {
  const explanation = params.explanation;
  if (explanation === undefined || explanation === null) {
    return { ok: true };
  }
  if (typeof explanation !== "string") {
    return { ok: false, reason: "explanation must be a string or null" };
  }
  const trimmed = explanation.trim();
  return { ok: true, ...(trimmed ? { value: trimmed } : {}) };
}

function parseTurnPlanSteps(
  value: unknown,
): { ok: true; value: CodexTurnPlanStep[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "plan must be an array" };
  }

  const steps: CodexTurnPlanStep[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      return { ok: false, reason: `plan[${index}] must be an object` };
    }
    const step = readString(entry, "step")?.trim();
    if (!step) {
      return { ok: false, reason: `plan[${index}].step must be a non-empty string` };
    }
    const status = entry.status;
    if (status !== "pending" && status !== "inProgress" && status !== "completed") {
      return {
        ok: false,
        reason: `plan[${index}].status must be pending, inProgress, or completed`,
      };
    }
    steps.push({ step, status });
  }
  return { ok: true, value: steps };
}

function emitTurnPlanProtocolGap(ctx: AdapterContext, params: Record<string, unknown>, reason: string): void {
  const codexThreadId = readCodexThreadId(params);
  const turnId = readString(params, "turnId");
  if (!codexThreadId) {
    process.stderr.write(
      `[eco-codex] protocol gap ${JSON.stringify({
        codexMethod: "turn/plan/updated",
        liveType: "codex.turn_plan.invalid",
        gap: true,
        gapReason: reason,
      })}\n`,
    );
    return;
  }
  const payloadJson = buildUnprojectedItemPayload(params);

  emit(ctx, {
    eventType: "thread.status",
    codexThreadId,
    ...(turnId ? { turnId } : {}),
    message: "Codex 任务步骤协议异常",
    streamState: "finalized",
    stableEventId: `tre:codex:turn-plan-gap:${turnId ?? "unknown"}`,
    metadata: {
      codexMethod: "turn/plan/updated",
      liveType: "codex.turn_plan.invalid",
      gap: true,
      gapReason: reason,
      ...(payloadJson ? { payloadJson } : {}),
    },
  });
}

function handleTokenUsageUpdated(ctx: AdapterContext, params: Record<string, unknown>): void {
  const codexThreadId = readCodexThreadId(params);
  const turnId = readCodexTurnId(params);
  let turnRoute: CodexTurnRouteRecord | undefined;
  const parsedTokenUsage = parseCodexThreadTokenUsage(params.tokenUsage);
  if (codexThreadId && turnId) {
    turnRoute = parsedTokenUsage
      ? ctx.turnRouteRegistry?.observeTokenUsage(codexThreadId, turnId, parsedTokenUsage)
      : ctx.turnRouteRegistry?.peek(codexThreadId, turnId);
  }
  if (!ctx.onTokenUsageUpdated) {
    return;
  }
  const resolution = resolveCodexContextFromNotification(params, {
    resolveEcoThreadId: ctx.resolveEcoThreadId,
    ...(ctx.resolveThreadAttribution && { resolveThreadAttribution: ctx.resolveThreadAttribution }),
    ...(turnRoute && { modelId: turnRoute.aliasModelId }),
  });
  if (resolution) {
    ctx.onTokenUsageUpdated(resolution);
  }
}

function handleThreadRouteCleanup(ctx: AdapterContext, params: Record<string, unknown>): void {
  const codexThreadId = readCodexThreadId(params);
  if (codexThreadId) {
    ctx.turnRouteRegistry?.clearThread(codexThreadId);
  }
}

function handleThreadStarted(ctx: AdapterContext, params: Record<string, unknown>): void {
  const thread = isRecord(params.thread) ? params.thread : undefined;
  if (!thread) {
    return;
  }
  const codexThreadId = readString(thread, "id");
  const parentThreadId = readString(thread, "parentThreadId") ?? readString(thread, "parent_thread_id");
  const agentNickname = readAgentNickname(thread);
  const existingRecord = codexThreadId ? ctx.getThreadAttributionRecord?.(codexThreadId) : undefined;
  const explicitOrchestrationRole = resolveChosenOrchestrationRole(
    ctx,
    readString(thread, "agentRole") ?? readString(thread, "agent_role"),
  );
  const existingOrchestrationRole = resolveChosenOrchestrationRole(ctx, existingRecord?.agentRole);
  const preview = readString(thread, "preview")?.trim();
  // agentRole is the spawn agent_type (orchestration role). Do not fall back to nickname:
  // nickname/preview/task labels are not roles and must not open a subagent card.
  const chosenOrchestrationRole = resolveChosenOrchestrationRole(
    ctx,
    explicitOrchestrationRole,
    existingOrchestrationRole,
  );
  const displayRole = resolveSubagentDisplayRole(ctx, chosenOrchestrationRole);
  // Parent link is required for Feed FK resolution.
  if (!codexThreadId || !parentThreadId || codexThreadId === parentThreadId) {
    return;
  }
  const spawnPrompt = resolveSpawnTaskPrompt({
    ...(preview && { preview }),
    ...(existingRecord?.spawnMessage && { persisted: existingRecord.spawnMessage }),
  });
  const delegation = spawnPrompt ? buildSpawnDelegationMetadata(displayRole, spawnPrompt) : undefined;

  ctx.recordThreadAttribution?.(codexThreadId, {
    parentThreadId,
    agentRole: displayRole,
    ...(agentNickname && { agentNickname }),
    ...(spawnPrompt && { spawnMessage: spawnPrompt }),
  });

  // A parent link is useful immediately, but emitting a `general` lifecycle
  // here would prevent the later spawn call_id event from correcting the role.
  if (!chosenOrchestrationRole) {
    return;
  }

  emitAgentLifecycle(ctx, {
    eventType: "agent.started",
    codexThreadId: parentThreadId,
    agentId: codexThreadId,
    role: displayRole,
    message: `Subagent ${displayRole} started`,
    metadata: {
      codexMethod: "thread/started",
      liveType: "agent.started",
      agentRole: displayRole,
      agentThreadId: codexThreadId,
      ...(chosenOrchestrationRole && { orchestrationRole: chosenOrchestrationRole }),
      ...(agentNickname ? { agentNickname } : {}),
      ...(delegation ?? {}),
    },
  });
}

function handleItemStarted(ctx: AdapterContext, params: Record<string, unknown>): void {
  const item = readItemPayload(params);
  if (!item) {
    return;
  }
  const itemType = readItemType(item);
  if (itemType === "commandExecution") {
    const status = readCommandExecutionStatus(item);
    if (status && status !== "inProgress") {
      return;
    }
    emitCommandExecutionToolEvent(ctx, params, item, "tool.started");
    return;
  }
  if (itemType === "fileChange") {
    emitFileChangeToolEvent(ctx, params, item, "tool.started");
    return;
  }
  if (itemType === "mcpToolCall") {
    emitMcpToolEvent(ctx, params, item, "tool.started");
    return;
  }
  if (itemType === "webSearch") {
    emitWebSearchToolEvent(ctx, params, item, "tool.started");
    return;
  }
  if (itemType === "imageView") {
    emitImageViewToolEvent(ctx, params, item, "tool.started");
    return;
  }
  if (itemType === "reasoning") {
    const codexThreadId = readCodexThreadId(params);
    const itemId = readCodexItemId(params, item);
    if (!codexThreadId || !itemId || ctx.reasoningStartedAtByItemId.has(itemId)) return;
    ctx.reasoningStartedAtByItemId.set(itemId, ctx.observedAt);
    emit(ctx, {
      eventType: "thinking.delta",
      codexThreadId,
      turnId: readCodexTurnId(params),
      itemId,
      role: "thinking",
      message: "",
      streamState: "placeholder",
      metadata: {
        codexMethod: "item/started",
        itemId,
        itemType: "reasoning",
        logicalEntityId: itemId,
        thinkingStartedAt: ctx.observedAt,
      },
    });
    return;
  }
  if (itemType === "agentMessage") {
    handleItemAsyncQuestions(ctx, params, item);
    return;
  }
  if (itemType === "contextCompaction") {
    emitContextCompactionLifecycle(ctx, params, item, "started");
    return;
  }
  if (itemType === "subAgentActivity") {
    handleSubAgentActivityLifecycle(ctx, params, item, "started");
    return;
  }
  if (itemType === "collabAgentToolCall") {
    handleCollabToolCallLifecycle(ctx, params, item, "started");
    return;
  }
  emitUnhandledItemGap(ctx, params, item, itemType, "item/started");
}

function handleAgentMessageDelta(ctx: AdapterContext, params: Record<string, unknown>): void {
  const codexThreadId = readCodexThreadId(params);
  const itemId = readCodexItemId(params);
  const delta = readDeltaText(params);
  if (!codexThreadId || !itemId || !delta) {
    return;
  }

  const turnId = readCodexTurnId(params);
  const previous = ctx.agentMessageTextByItemId.get(itemId) ?? "";
  // Codex/gateway must emit true incremental deltas. Do not normalize cumulative
  // snapshots here — that would hide gateway stream bugs.
  const next = `${previous}${delta}`;
  ctx.agentMessageTextByItemId.set(itemId, next);

  emit(ctx, {
    eventType: "message.delta",
    codexThreadId,
    turnId,
    itemId,
    role: "assistant",
    // Projection keeps the latest stream item text for a streamKey (not chunk-append).
    message: next,
    streamState: "streaming",
    metadata: {
      codexMethod: "item/agentMessage/delta",
      logicalEntityId: itemId,
      itemId,
      itemType: "agentMessage",
    },
  });
}

function handleReasoningSummaryPartAdded(ctx: AdapterContext, params: Record<string, unknown>): void {
  const itemId = readCodexItemId(params);
  if (!itemId) {
    return;
  }
  const previous = ctx.reasoningTextByItemId.get(itemId) ?? "";
  if (previous.length > 0 && !previous.endsWith("\n")) {
    // OpenAI/Codex do not emit a newline between summary parts; mark the next delta.
    ctx.reasoningSummaryNeedsSeparatorByItemId.add(itemId);
  }
  const summaryIndex = readSummaryIndex(params);
  if (summaryIndex !== undefined) {
    ctx.reasoningSummaryIndexByItemId.set(itemId, summaryIndex);
  }
}

function handleReasoningSummaryTextDelta(ctx: AdapterContext, params: Record<string, unknown>): void {
  emitReasoningDelta(ctx, params, "item/reasoning/summaryTextDelta", "summary");
}

function handleReasoningTextDelta(ctx: AdapterContext, params: Record<string, unknown>): void {
  emitReasoningDelta(ctx, params, "item/reasoning/textDelta", "raw");
}

function emitReasoningDelta(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  codexMethod: string,
  reasoningDisplay: "summary" | "raw",
): void {
  const codexThreadId = readCodexThreadId(params);
  const itemId = readCodexItemId(params);
  const delta = readDeltaText(params);
  if (!codexThreadId || !itemId || !delta) {
    return;
  }
  const turnId = readCodexTurnId(params);
  if (!ctx.reasoningStartedAtByItemId.has(itemId)) {
    ctx.reasoningStartedAtByItemId.set(itemId, ctx.observedAt);
  }
  const thinkingStartedAt = ctx.reasoningStartedAtByItemId.get(itemId) ?? ctx.observedAt;
  const previous = ctx.reasoningTextByItemId.get(itemId) ?? "";
  let separator = "";
  if (reasoningDisplay === "summary" && previous.length > 0 && !previous.endsWith("\n")) {
    if (ctx.reasoningSummaryNeedsSeparatorByItemId.has(itemId)) {
      separator = "\n";
      ctx.reasoningSummaryNeedsSeparatorByItemId.delete(itemId);
    } else {
      const summaryIndex = readSummaryIndex(params);
      const previousIndex = ctx.reasoningSummaryIndexByItemId.get(itemId);
      if (
        summaryIndex !== undefined &&
        previousIndex !== undefined &&
        summaryIndex !== previousIndex
      ) {
        // Fallback when summaryPartAdded is missing but summaryIndex advances.
        separator = "\n";
      }
    }
  }
  const summaryIndex = readSummaryIndex(params);
  if (reasoningDisplay === "summary" && summaryIndex !== undefined) {
    ctx.reasoningSummaryIndexByItemId.set(itemId, summaryIndex);
  }
  const next = `${previous}${separator}${delta}`;
  ctx.reasoningTextByItemId.set(itemId, next);
  ctx.reasoningDisplayByItemId.set(itemId, reasoningDisplay);

  emit(ctx, {
    eventType: "thinking.delta",
    codexThreadId,
    turnId,
    itemId,
    role: "thinking",
    // Projection keeps the longest thinking text for a streamKey.
    message: next,
    streamState: "streaming",
    metadata: {
      codexMethod,
      logicalEntityId: itemId,
      itemId,
      itemType: "reasoning",
      reasoningDisplay,
      thinkingStartedAt,
    },
  });
}

function handleCommandExecutionOutputDelta(ctx: AdapterContext, params: Record<string, unknown>): void {
  const itemId = readCodexItemId(params);
  const delta = readDeltaText(params);
  if (!itemId || !delta) {
    return;
  }
  ctx.commandOutputPreviewByItemId.set(
    itemId,
    appendToolOutputPreviewCapture(ctx.commandOutputPreviewByItemId.get(itemId), delta),
  );
}

function handleItemCompleted(ctx: AdapterContext, params: Record<string, unknown>): void {
  const codexThreadId = readCodexThreadId(params);
  const item = readItemPayload(params);
  const itemId = readCodexItemId(params, item);
  const itemType = item ? readItemType(item) : undefined;
  if (!codexThreadId || !itemId || !itemType || !item) {
    return;
  }

  const turnId = readCodexTurnId(params);

  if (itemType === "userMessage") {
    const clientUserMessageId = readString(item, "clientId") ?? readString(item, "clientUserMessageId");
    emit(ctx, {
      eventType: "message.final",
      codexThreadId,
      turnId,
      itemId,
      role: "user",
      message: readUserMessageText(item),
      streamState: "finalized",
      metadata: {
        codexMethod: "item/completed",
        liveType: "message.user",
        logicalEntityId: itemId,
        itemId,
        itemType,
        // activityLineId mirrors itemId for projection-only rewind (no ThreadActivityLine write).
        rewindTarget: { activityLineId: itemId, userMessageId: itemId },
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      },
    });
    return;
  }

  if (itemType === "agentMessage") {
    handleItemAsyncQuestions(ctx, params, item);
    const text = readString(item, "text") ?? ctx.agentMessageTextByItemId.get(itemId) ?? "";
    ctx.agentMessageTextByItemId.delete(itemId);
    emit(ctx, {
      eventType: "message.final",
      codexThreadId,
      turnId,
      itemId,
      role: "assistant",
      message: text,
      streamState: "finalized",
      metadata: {
        codexMethod: "item/completed",
        logicalEntityId: itemId,
        itemId,
        itemType: "agentMessage",
      },
    });
    return;
  }

  if (itemType === "commandExecution") {
    const status = readCommandExecutionStatus(item);
    const eventType =
      status === "failed" || status === "declined"
        ? "tool.failed"
        : status === "completed"
          ? "tool.completed"
          : undefined;
    if (!eventType) {
      return;
    }
    emitCommandExecutionToolEvent(ctx, params, item, eventType);
    ctx.commandOutputPreviewByItemId.delete(itemId);
    return;
  }

  if (itemType === "fileChange") {
    const status = readPatchApplyStatus(item);
    const eventType =
      status === "failed" || status === "declined"
        ? "tool.failed"
        : status === "completed"
          ? "tool.completed"
          : undefined;
    if (!eventType) {
      return;
    }
    emitFileChangeToolEvent(ctx, params, item, eventType);
    return;
  }

  if (itemType === "mcpToolCall") {
    const status = readMcpToolCallStatus(item);
    const eventType =
      status === "failed" || status === "declined"
        ? "tool.failed"
        : status === "completed"
          ? "tool.completed"
          : undefined;
    if (!eventType) {
      return;
    }
    emitMcpToolEvent(ctx, params, item, eventType);
    return;
  }

  if (itemType === "webSearch") {
    // Protocol item has no status field; item/completed is success terminal for Feed.
    emitWebSearchToolEvent(ctx, params, item, "tool.completed");
    return;
  }

  if (itemType === "imageView") {
    emitImageViewToolEvent(ctx, params, item, "tool.completed");
    return;
  }

  if (itemType === "reasoning") {
    const text = readReasoningItemText(item) || ctx.reasoningTextByItemId.get(itemId) || "";
    const reasoningDisplay = readReasoningDisplay(item) ?? ctx.reasoningDisplayByItemId.get(itemId);
    ctx.reasoningTextByItemId.delete(itemId);
    ctx.reasoningDisplayByItemId.delete(itemId);
    ctx.reasoningSummaryIndexByItemId.delete(itemId);
    ctx.reasoningSummaryNeedsSeparatorByItemId.delete(itemId);
    if (!ctx.reasoningStartedAtByItemId.has(itemId)) {
      ctx.reasoningStartedAtByItemId.set(itemId, ctx.observedAt);
    }
    const thinkingStartedAt = ctx.reasoningStartedAtByItemId.get(itemId) ?? ctx.observedAt;
    ctx.reasoningStartedAtByItemId.delete(itemId);
    const thinkingDurationMs = resolveObservedDurationMs(thinkingStartedAt, ctx.observedAt);
    emit(ctx, {
      eventType: "thinking.final",
      codexThreadId,
      turnId,
      itemId,
      role: "thinking",
      message: text,
      streamState: "finalized",
      metadata: {
        codexMethod: "item/completed",
        logicalEntityId: itemId,
        itemId,
        itemType: "reasoning",
        ...(reasoningDisplay && { reasoningDisplay }),
        thinkingStartedAt,
        ...(thinkingDurationMs !== undefined && { thinkingDurationMs }),
      },
    });
    return;
  }

  if (itemType === "plan") {
    const planFilePath = readString(item, "planFilePath") ?? readString(item, "path");
    const text = readString(item, "text") ?? "";
    emit(ctx, {
      eventType: "thread.status",
      codexThreadId,
      turnId,
      itemId,
      role: "main",
      message: "计划已生成，等待确认。",
      streamState: "finalized",
      metadata: {
        codexMethod: "item/completed",
        liveType: "plan.ready",
        logicalEntityId: itemId,
        itemId,
        itemType: "plan",
        plan: {
          plan: text,
          ...(planFilePath ? { planFilePath } : {}),
        },
      },
    });
    ctx.onPlanReady?.({
      ecoThreadId: ctx.resolveEcoThreadId(codexThreadId),
      codexThreadId,
      ...(turnId ? { turnId } : {}),
      itemId,
      plan: text,
      ...(planFilePath ? { planFilePath } : {}),
    });
    return;
  }

  if (itemType === "contextCompaction") {
    emitContextCompactionLifecycle(ctx, params, item, "completed");
    return;
  }

  if (itemType === "subAgentActivity") {
    handleSubAgentActivityLifecycle(ctx, params, item, "completed");
    return;
  }
  if (itemType === "collabAgentToolCall") {
    handleCollabToolCallLifecycle(ctx, params, item, "completed");
    return;
  }
  emitUnhandledItemGap(ctx, params, item, itemType, "item/completed");
}

/**
 * Surface unprojected Codex item types explicitly — never silent-drop into Feed.
 * Codex 0.144+ emits additional canonical/extension items (web search, review, hooks, …).
 * UI renders these as a default-collapsed "未知类型" card; styles can be specialized later.
 */
function emitUnhandledItemGap(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  itemType: string | undefined,
  codexMethod: "item/started" | "item/completed",
): void {
  if (!itemType || HANDLED_ITEM_TYPES.has(itemType)) {
    return;
  }
  const codexThreadId = readCodexThreadId(params);
  const itemId = readCodexItemId(params, item);
  if (!codexThreadId || !itemId) {
    return;
  }
  const turnId = readCodexTurnId(params);
  const phase = codexMethod === "item/started" ? "started" : "completed";
  emit(ctx, {
    eventType: "thread.status",
    codexThreadId,
    turnId,
    itemId,
    message: `未知类型 · ${itemType}`,
    streamState: phase === "started" ? "streaming" : "finalized",
    // One row per Codex item so started→completed updates the same card.
    stableEventId: `tre:codex:unprojected:${itemId}`,
    metadata: {
      codexMethod,
      liveType: "codex.item.unprojected",
      logicalEntityId: itemId,
      itemId,
      itemType,
      gap: true,
      unprojectedPhase: phase,
      ...(buildUnprojectedItemPayload(item) ? { payloadJson: buildUnprojectedItemPayload(item) } : {}),
    },
  });
}

const UNPROJECTED_PAYLOAD_MAX_CHARS = 8_000;

function buildUnprojectedItemPayload(item: Record<string, unknown>): string | undefined {
  try {
    const serialized = JSON.stringify(item, null, 2);
    if (!serialized || serialized === "{}") {
      return undefined;
    }
    if (serialized.length <= UNPROJECTED_PAYLOAD_MAX_CHARS) {
      return serialized;
    }
    return `${serialized.slice(0, UNPROJECTED_PAYLOAD_MAX_CHARS)}\n…(truncated)`;
  } catch {
    return undefined;
  }
}

function handleDeprecationNotice(ctx: AdapterContext, params: Record<string, unknown>): void {
  const method =
    readString(params, "method") ??
    readString(params, "rpcMethod") ??
    readString(params, "name") ??
    "unknown";
  const message =
    readString(params, "message") ??
    readString(params, "notice") ??
    `Codex app-server deprecation notice for ${method}`;
  const codexThreadId =
    readCodexThreadId(params) ??
    (typeof params.threadId === "string" ? params.threadId.trim() : undefined) ??
    // Thread-less deprecations (e.g. thread/rollback) still need a sink; attach to no thread is
    // useless for Eco — skip until we have an eco thread id map for process-global notices.
    undefined;
  if (!codexThreadId) {
    // Process-global deprecations: keep machine-readable side channel via metadata-only callback
    // is unavailable; write to stderr so diagnostics do not invent a false thread attribution.
    process.stderr.write(
      `[eco-codex] deprecationNotice method=${method} message=${message.replace(/\s+/g, " ").trim()}\n`,
    );
    return;
  }
  emit(ctx, {
    eventType: "thread.status",
    codexThreadId,
    message: message,
    streamState: "finalized",
    metadata: {
      codexMethod: "deprecationNotice",
      liveType: "codex.deprecation",
      deprecatedMethod: method,
      gap: method === "thread/rollback",
    },
  });
}

function handleModelSafetyBufferingUpdated(ctx: AdapterContext, params: Record<string, unknown>): void {
  const codexThreadId = readCodexThreadId(params);
  if (!codexThreadId) {
    process.stderr.write(
      `[eco-codex] model/safetyBuffering/updated without threadId params=${JSON.stringify(params).slice(0, 400)}\n`,
    );
    return;
  }
  const useCases = Array.isArray(params.useCases)
    ? params.useCases.filter((value): value is string => typeof value === "string")
    : [];
  const reasons = Array.isArray(params.reasons)
    ? params.reasons.filter((value): value is string => typeof value === "string")
    : [];
  const message =
    readString(params, "message") ??
    (useCases.length > 0
      ? `Codex safety buffering (${useCases.join(", ")}${reasons.length ? `: ${reasons.join(", ")}` : ""})`
      : "Codex safety buffering in progress");
  emit(ctx, {
    eventType: "thread.status",
    codexThreadId,
    message,
    streamState: "streaming",
    metadata: {
      codexMethod: "model/safetyBuffering/updated",
      liveType: "codex.safety_buffering",
      ...(useCases.length ? { useCases } : {}),
      ...(reasons.length ? { reasons } : {}),
    },
  });
}

function handleModelProviderAuthRecoveryStarted(
  ctx: AdapterContext,
  params: Record<string, unknown>,
): void {
  emitAuthRecoveryStatus(ctx, params, "started");
}

function handleModelProviderAuthRecoveryCompleted(
  ctx: AdapterContext,
  params: Record<string, unknown>,
): void {
  emitAuthRecoveryStatus(ctx, params, "completed");
}

function emitAuthRecoveryStatus(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  phase: "started" | "completed",
): void {
  const codexThreadId = readCodexThreadId(params);
  const provider =
    readString(params, "provider") ??
    readString(params, "modelProvider") ??
    readString(params, "name") ??
    "provider";
  const message =
    readString(params, "message") ??
    (phase === "started"
      ? `Refreshing credentials for ${provider}…`
      : `Credential refresh finished for ${provider}`);
  if (!codexThreadId) {
    process.stderr.write(`[eco-codex] modelProvider/authRecovery/${phase} ${message}\n`);
    return;
  }
  emit(ctx, {
    eventType: "thread.status",
    codexThreadId,
    message,
    streamState: phase === "started" ? "streaming" : "finalized",
    metadata: {
      codexMethod:
        phase === "started"
          ? "modelProvider/authRecoveryStarted"
          : "modelProvider/authRecoveryCompleted",
      liveType: "codex.auth_recovery",
      phase,
      provider,
    },
  });
}

function emitContextCompactionLifecycle(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  phase: "started" | "completed",
): void {
  const codexThreadId = readCodexThreadId(params);
  const turnId = readCodexTurnId(params);
  const itemId = readCodexItemId(params, item);
  if (!codexThreadId || !turnId || !itemId) {
    return;
  }

  const codexMethod = phase === "started" ? "item/started" : "item/completed";
  emit(ctx, {
    eventType: phase === "started" ? "context.compaction.started" : "context.compaction.completed",
    codexThreadId,
    turnId,
    itemId,
    message: phase === "started" ? "正在压缩上下文" : "上下文已压缩",
    streamState: phase === "started" ? "none" : "finalized",
    metadata: {
      codexMethod,
      codexThreadId,
      logicalEntityId: itemId,
      itemId,
      itemType: "contextCompaction",
      turnId,
    },
  });
}

function emitImageViewToolEvent(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  eventType: "tool.started" | "tool.completed",
): void {
  const codexThreadId = readCodexThreadId(params);
  const turnId = readCodexTurnId(params);
  const itemId = readCodexItemId(params, item);
  const imagePath = readString(item, "path")?.trim();
  if (!codexThreadId || !itemId || !imagePath) {
    return;
  }
  if (eventType === "tool.started") {
    if (ctx.emittedImageViewPaths.has(imagePath)) {
      return;
    }
    ctx.emittedImageViewPaths.add(imagePath);
  }
  const toolStatus = eventType === "tool.started" ? "started" : "completed";
  emit(ctx, {
    eventType,
    codexThreadId,
    turnId,
    itemId,
    role: "tool",
    message: `Tool: ViewImage · ${imagePath}`,
    streamState: eventType === "tool.started" ? "streaming" : "finalized",
    stableEventId: `tre:codex:tool:${itemId}:${eventType === "tool.started" ? "started" : "done"}`,
    metadata: {
      codexMethod: eventType === "tool.started" ? "item/started" : "item/completed",
      liveType: eventType,
      logicalEntityId: itemId,
      itemId,
      itemType: "imageView",
      tool: {
        name: "ViewImage",
        detail: imagePath,
        toolUseId: itemId,
        status: toolStatus,
        imageView: { path: imagePath },
      },
    },
  });
}

function emitCommandExecutionToolEvent(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  eventType: "tool.started" | "tool.completed" | "tool.failed",
): void {
  const codexThreadId = readCodexThreadId(params);
  const itemId = readCodexItemId(params, item);
  const fields = readCommandExecutionFields(item);
  if (!codexThreadId || !itemId || !fields.command) {
    return;
  }

  const turnId = readCodexTurnId(params);
  const toolStatus =
    eventType === "tool.started" ? "started" : eventType === "tool.completed" ? "completed" : "failed";
  const commandProjection = resolveCodexCommandProjection(item.commandActions);
  const outputPreview =
    eventType !== "tool.started" && !commandProjection.readOnly
      ? fields.aggregatedOutput
        ? createToolOutputPreview(fields.aggregatedOutput)
        : materializeToolOutputPreviewCapture(ctx.commandOutputPreviewByItemId.get(itemId))
      : undefined;

  emit(ctx, {
    eventType,
    codexThreadId,
    turnId,
    itemId,
    role: "tool",
    message: formatCodexBashToolMessage(fields.command),
    streamState: eventType === "tool.started" ? "streaming" : "finalized",
    stableEventId: `tre:codex:tool:${itemId}:${eventType === "tool.started" ? "started" : "done"}`,
    metadata: {
      codexMethod: eventType === "tool.started" ? "item/started" : "item/completed",
      liveType: eventType,
      logicalEntityId: itemId,
      itemId,
      itemType: "commandExecution",
      tool: {
        name: "Bash",
        detail: fields.command,
        ...(fields.description ? { description: fields.description } : {}),
        toolUseId: itemId,
        status: toolStatus,
        ...(outputPreview?.text ? { outputPreview: outputPreview.text } : {}),
        ...(outputPreview?.truncated ? { outputPreviewTruncated: true } : {}),
        ...(commandProjection.readTarget ? { readTarget: commandProjection.readTarget } : {}),
        ...(commandProjection.grepTarget ? { grepTarget: commandProjection.grepTarget } : {}),
        ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
        ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
      },
    },
  });
}

function emitFileChangeToolEvent(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  eventType: "tool.started" | "tool.completed" | "tool.failed",
): void {
  const codexThreadId = readCodexThreadId(params);
  const itemId = readCodexItemId(params, item);
  if (!codexThreadId || !itemId) {
    return;
  }
  const turnId = readCodexTurnId(params);
  const fileChange = readFileChangeMetadata(item);
  const pathLabel = fileChange?.path ?? "file";
  const toolStatus =
    eventType === "tool.started" ? "started" : eventType === "tool.completed" ? "completed" : "failed";

  emit(ctx, {
    eventType,
    codexThreadId,
    turnId,
    itemId,
    role: "tool",
    message: `Tool: Edit · ${pathLabel}`,
    streamState: eventType === "tool.started" ? "streaming" : "finalized",
    stableEventId: `tre:codex:tool:${itemId}:${eventType === "tool.started" ? "started" : "done"}`,
    metadata: {
      codexMethod: eventType === "tool.started" ? "item/started" : "item/completed",
      liveType: eventType,
      logicalEntityId: itemId,
      itemId,
      itemType: "fileChange",
      tool: {
        name: "Edit",
        detail: pathLabel,
        toolUseId: itemId,
        status: toolStatus,
        ...(fileChange ? { fileChange } : {}),
      },
    },
  });
}

function emitMcpToolEvent(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  eventType: "tool.started" | "tool.completed" | "tool.failed",
): void {
  const codexThreadId = readCodexThreadId(params);
  const itemId = readCodexItemId(params, item);
  const server = readString(item, "server") ?? "mcp";
  const tool = readString(item, "tool") ?? "tool";
  if (!codexThreadId || !itemId) {
    return;
  }
  const turnId = readCodexTurnId(params);
  const toolStatus =
    eventType === "tool.started" ? "started" : eventType === "tool.completed" ? "completed" : "failed";
  const toolName = `mcp__${server}__${tool}`;
  const durationMs = readNumber(item, "durationMs");
  const mcpInput = readMcpToolInput(item);
  const hubCall = resolveEcoMcpHubToolCall(toolName, mcpInput);
  const hubSearch = resolveEcoMcpHubSearchCall(toolName, mcpInput);
  const displayToolName = hubCall?.name ?? toolName;
  const displayInput = hubCall?.args ?? mcpInput;
  const imageViewCall = resolveEcoImageViewToolCall(displayToolName, displayInput);
  let imageViewPath = imageViewCall?.path;
  const imageViewReference = imageViewCall?.ref;
  if (
    !imageViewPath &&
    eventType === "tool.completed" &&
    isAgentBrowserScreenshotToolName(displayToolName)
  ) {
    imageViewPath = readAbsolutePathFromMcpToolOutput(item);
  }
  // The vision answer is the only place the caller's prompt is answered; without it the
  // Feed card can show the image but never what was asked or answered. Read it off the
  // completed item and let it ride the same output channel bash already uses.
  const imageViewResult =
    imageViewPath && eventType === "tool.completed" ? readMcpToolOutputText(item) : undefined;
  const imageViewOutputPreview = imageViewResult ? createToolOutputPreview(imageViewResult) : undefined;
  const imageViewPrompt = imageViewPath ? imageViewCall?.prompt : undefined;
  if (imageViewPath) {
    if (eventType === "tool.started") {
      if (ctx.emittedImageViewPaths.has(imageViewPath)) {
        return;
      }
      ctx.emittedImageViewPaths.add(imageViewPath);
    }
  }
  let imageDisplayMeta =
    isEcoImageDisplayToolName(displayToolName) && eventType === "tool.completed"
      ? readImageDisplayMetadataFromToolOutput(item)
      : undefined;
  if (imageDisplayMeta && eventType === "tool.completed") {
    if (ctx.emittedImageDisplayArtifacts.has(imageDisplayMeta.artifactId)) {
      return;
    }
    ctx.emittedImageDisplayArtifacts.add(imageDisplayMeta.artifactId);
  }
  const imageDisplayArtifactId = imageDisplayMeta?.artifactId;
  const htmlHostMeta =
    isEcoHtmlHostToolName(displayToolName) && eventType === "tool.completed"
      ? readHtmlHostMetadataFromToolOutput(item)
      : undefined;
  const urlHint = readMcpToolUrlHint(item, displayInput);
  const ecoWebSearchQuery = isEcoWebSearchToolName(displayToolName)
    ? readEcoWebSearchQuery(displayInput)
    : undefined;
  const ecoWebSearchParsed =
    isEcoWebSearchToolName(displayToolName) && eventType !== "tool.started"
      ? parseEcoWebSearchToolOutput(item)
      : undefined;
  const ecoWebSearch =
    isEcoWebSearchToolName(displayToolName)
      ? {
          mode: "search" as const,
          actionType: "search" as const,
          ...(ecoWebSearchQuery || ecoWebSearchParsed?.query
            ? { query: ecoWebSearchQuery ?? ecoWebSearchParsed?.query }
            : {}),
          ...(ecoWebSearchParsed?.provider ? { provider: ecoWebSearchParsed.provider } : {}),
          ...(ecoWebSearchParsed?.results?.length
            ? {
                results: ecoWebSearchParsed.results.map((entry) => ({
                  title: entry.title,
                  url: entry.url,
                  ...(entry.description ? { description: entry.description } : {}),
                })),
              }
            : {}),
        }
      : undefined;
  const detailParts = imageViewPath
    ? [imageViewPath]
    : imageViewReference
      ? [imageViewReference]
      : imageDisplayArtifactId
        ? [imageDisplayArtifactId]
        : htmlHostMeta?.publicUrl
          ? [htmlHostMeta.publicUrl]
          : ecoWebSearchQuery
            ? [ecoWebSearchQuery]
            : [formatMcpToolTarget(displayToolName, `${server}/${tool}`), ...(urlHint ? [urlHint] : [])];
  const messageHint =
    imageViewPath ??
    imageViewReference ??
    imageDisplayArtifactId ??
    htmlHostMeta?.publicUrl ??
    ecoWebSearchQuery ??
    urlHint;

  emit(ctx, {
    eventType,
    codexThreadId,
    turnId,
    itemId,
    role: "tool",
    message: messageHint ? `Tool: ${displayToolName} · ${messageHint}` : `Tool: ${displayToolName}`,
    streamState: eventType === "tool.started" ? "streaming" : "finalized",
    stableEventId: `tre:codex:tool:${itemId}:${eventType === "tool.started" ? "started" : "done"}`,
    metadata: {
      codexMethod: eventType === "tool.started" ? "item/started" : "item/completed",
      liveType: eventType,
      logicalEntityId: itemId,
      itemId,
      itemType: "mcpToolCall",
      ...(displayInput ? { mcpInput: displayInput } : {}),
      ...(urlHint ? { url: urlHint } : {}),
      tool: {
        name: displayToolName,
        detail: detailParts.join(" · "),
        toolUseId: itemId,
        status: toolStatus,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(imageViewPath
          ? { imageView: { path: imageViewPath, ...(imageViewPrompt ? { prompt: imageViewPrompt } : {}) } }
          : {}),
        ...(imageViewOutputPreview?.text ? { outputPreview: imageViewOutputPreview.text } : {}),
        ...(imageViewOutputPreview?.truncated ? { outputPreviewTruncated: true } : {}),
        ...(imageDisplayMeta
          ? {
              imageDisplay: {
                artifactId: imageDisplayMeta.artifactId,
                ...(imageDisplayMeta.title ? { title: imageDisplayMeta.title } : {}),
              },
            }
          : {}),
        ...(htmlHostMeta
          ? {
              htmlHost: {
                pageId: htmlHostMeta.pageId,
                publicUrl: htmlHostMeta.publicUrl,
                ...(htmlHostMeta.title ? { title: htmlHostMeta.title } : {}),
                ...(htmlHostMeta.expiresAt ? { expiresAt: htmlHostMeta.expiresAt } : {}),
                ...(typeof htmlHostMeta.canExtend === "boolean"
                  ? { canExtend: htmlHostMeta.canExtend }
                  : {}),
              },
            }
          : {}),
        ...(ecoWebSearch ? { webSearch: ecoWebSearch } : {}),
        ...(hubSearch ? { mcpDiscovery: { kind: "search" as const } } : {}),
      },
    },
  });
}

function formatMcpToolTarget(toolName: string, fallback: string): string {
  const match = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : fallback;
}

/** Best-effort MCP tool arguments blob (Codex field names vary). */
function readMcpToolInput(item: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of [
    "arguments",
    "args",
    "input",
    "params",
    "toolInput",
    "tool_input",
    "invocation",
    "request",
  ] as const) {
    const raw = item[key];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

function readMcpToolUrlHint(
  item: Record<string, unknown>,
  mcpInput: Record<string, unknown> | undefined,
): string | undefined {
  const bags: Array<Record<string, unknown> | undefined> = [mcpInput, item];
  for (const bag of bags) {
    if (!bag) continue;
    for (const key of ["url", "href", "uri", "target"] as const) {
      const value = bag[key];
      if (typeof value === "string" && /\S/.test(value)) {
        const trimmed = value.trim();
        if (/^https?:\/\//i.test(trimmed) || /^[\w.-]+\.[a-z]{2,}/i.test(trimmed)) {
          return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
        }
      }
    }
    if (typeof bag.command === "string") {
      const match = bag.command.match(/https?:\/\/[^\s"']+/i);
      if (match?.[0]) {
        return match[0];
      }
    }
  }
  // Nested command shape: { command: "open https://..." } or positional
  if (mcpInput && typeof mcpInput.command === "string") {
    const parts = mcpInput.command.trim().split(/\s+/);
    const maybeUrl = parts.find((p) => /^https?:\/\//i.test(p) || /^[\w.-]+\.[a-z]{2,}/i.test(p));
    if (maybeUrl) {
      return maybeUrl.startsWith("http") ? maybeUrl : `https://${maybeUrl}`;
    }
  }
  return undefined;
}

/**
 * Codex Protocol `webSearch` item → Eco tool lifecycle used by Feed / i18n labels
 * (`WebSearch` / 网络搜索).
 */
function emitWebSearchToolEvent(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  eventType: "tool.started" | "tool.completed" | "tool.failed",
): void {
  const codexThreadId = readCodexThreadId(params);
  const itemId = readCodexItemId(params, item);
  if (!codexThreadId || !itemId) {
    return;
  }
  const turnId = readCodexTurnId(params);
  const detail = readWebSearchDetail(item);
  const toolStatus =
    eventType === "tool.started" ? "started" : eventType === "tool.completed" ? "completed" : "failed";
  const message = detail ? `Tool: WebSearch · ${detail}` : "Tool: WebSearch";
  const webSearch = buildWebSearchToolMetadata(item, detail);

  emit(ctx, {
    eventType,
    codexThreadId,
    turnId,
    itemId,
    role: "tool",
    message,
    streamState: eventType === "tool.started" ? "streaming" : "finalized",
    stableEventId: `tre:codex:tool:${itemId}:${eventType === "tool.started" ? "started" : "done"}`,
    metadata: {
      codexMethod: eventType === "tool.started" ? "item/started" : "item/completed",
      liveType: eventType,
      logicalEntityId: itemId,
      itemId,
      itemType: "webSearch",
      tool: {
        name: "WebSearch",
        ...(detail ? { detail } : {}),
        toolUseId: itemId,
        status: toolStatus,
        ...(webSearch ? { webSearch } : {}),
      },
    },
  });
}

/** Prefer top-level query; fall back to action (search / openPage / findInPage). */
function readWebSearchDetail(item: Record<string, unknown>): string {
  const fields = readWebSearchStructuredFields(item);
  return fields.query || fields.url || fields.queries?.[0] || "";
}

function buildWebSearchToolMetadata(
  item: Record<string, unknown>,
  detail: string,
):
  | {
      query?: string;
      actionType?: "search" | "openPage" | "findInPage" | "other";
      url?: string;
      pattern?: string;
      queries?: string[];
      mode: "search";
    }
  | undefined {
  const fields = readWebSearchStructuredFields(item);
  const query = fields.query || detail || undefined;
  if (!query && !fields.url && !fields.pattern && !(fields.queries && fields.queries.length > 0)) {
    return { mode: "search" };
  }
  return {
    mode: "search",
    ...(query ? { query } : {}),
    ...(fields.actionType ? { actionType: fields.actionType } : {}),
    ...(fields.url ? { url: fields.url } : {}),
    ...(fields.pattern ? { pattern: fields.pattern } : {}),
    ...(fields.queries && fields.queries.length > 0 ? { queries: fields.queries } : {}),
  };
}

function readWebSearchStructuredFields(item: Record<string, unknown>): {
  query: string;
  actionType?: "search" | "openPage" | "findInPage" | "other";
  url?: string;
  pattern?: string;
  queries?: string[];
} {
  const topQuery = readString(item, "query") ?? "";
  const action = item.action;
  if (!isRecord(action)) {
    return { query: topQuery };
  }
  const actionTypeRaw = readString(action, "type");
  const actionType =
    actionTypeRaw === "search" ||
    actionTypeRaw === "openPage" ||
    actionTypeRaw === "findInPage" ||
    actionTypeRaw === "other"
      ? actionTypeRaw
      : undefined;
  const actionQuery = readString(action, "query") ?? "";
  const queries = Array.isArray(action.queries)
    ? action.queries
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : undefined;
  const pattern = readString(action, "pattern");
  const url = readString(action, "url");
  const query = topQuery || actionQuery || queries?.[0] || "";
  return {
    query,
    ...(actionType ? { actionType } : {}),
    ...(url ? { url } : {}),
    ...(pattern ? { pattern } : {}),
    ...(queries && queries.length > 0 ? { queries } : {}),
  };
}

function formatCodexBashToolMessage(command: string): string {
  return `Tool: Bash · ${command}`;
}

function readCommandExecutionFields(item: Record<string, unknown>): CodexCommandExecutionFields {
  const command = readString(item, "command") ?? "";
  const description = formatCodexCommandActions(item.commandActions);
  const status = readCommandExecutionStatus(item);
  const aggregatedOutput = readOptionalString(item, "aggregatedOutput");
  const exitCode = readNumber(item, "exitCode");
  const durationMs = readNumber(item, "durationMs");
  return {
    command,
    ...(description && { description }),
    ...(status && { status }),
    ...(aggregatedOutput && { aggregatedOutput }),
    ...(exitCode !== undefined && { exitCode }),
    ...(durationMs !== undefined && { durationMs }),
  };
}

function formatCodexCommandActions(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const labels = value
    .map((entry) => {
      if (!isRecord(entry)) {
        return undefined;
      }
      const type = readString(entry, "type");
      if (type === "read") {
        const name = readString(entry, "name");
        const path = readString(entry, "path");
        return name || path ? `读取 ${name ?? path}` : "读取文件";
      }
      if (type === "listFiles") {
        const path = readString(entry, "path");
        return path ? `列出文件 · ${path}` : "列出文件";
      }
      if (type === "search") {
        const query = readString(entry, "query");
        const path = readString(entry, "path");
        if (query && path) {
          return `搜索 ${query} · ${path}`;
        }
        return query ? `搜索 ${query}` : path ? `搜索文件 · ${path}` : "搜索文件";
      }
      return undefined;
    })
    .filter((label): label is string => Boolean(label));
  if (labels.length === 0) {
    return undefined;
  }
  return labels.length === 1 ? labels[0] : `${labels[0]} 等 ${labels.length} 项`;
}

function resolveCodexCommandProjection(value: unknown): {
  readOnly: boolean;
  readTarget?: { filePath: string };
  grepTarget?: { pattern: string; path?: string };
} {
  if (!Array.isArray(value) || value.length === 0) {
    return { readOnly: false };
  }
  let readOnly = true;
  let readTarget: { filePath: string } | undefined;
  let grepTarget: { pattern: string; path?: string } | undefined;
  for (const entry of value) {
    if (!isRecord(entry)) {
      readOnly = false;
      continue;
    }
    const type = readString(entry, "type");
    if (type === "read") {
      const filePath = readString(entry, "path") ?? readString(entry, "name");
      if (filePath && !readTarget) {
        readTarget = { filePath };
      }
      continue;
    }
    if (type === "search") {
      const pattern = readString(entry, "query");
      const path = readString(entry, "path");
      if (pattern && !grepTarget) {
        grepTarget = { pattern, ...(path ? { path } : {}) };
      }
      continue;
    }
    if (type !== "listFiles") {
      readOnly = false;
    }
  }
  return {
    readOnly,
    ...(readTarget ? { readTarget } : {}),
    ...(grepTarget ? { grepTarget } : {}),
  };
}

function readCommandExecutionStatus(item: Record<string, unknown>): CodexCommandExecutionStatus | undefined {
  return readLifecycleStatus(item);
}

function readPatchApplyStatus(item: Record<string, unknown>): CodexCommandExecutionStatus | undefined {
  return readLifecycleStatus(item);
}

function readMcpToolCallStatus(item: Record<string, unknown>): CodexCommandExecutionStatus | undefined {
  return readLifecycleStatus(item);
}

function readLifecycleStatus(item: Record<string, unknown>): CodexCommandExecutionStatus | undefined {
  const status = readString(item, "status");
  if (status === "inProgress" || status === "completed" || status === "failed" || status === "declined") {
    return status;
  }
  return undefined;
}

function readReasoningItemText(item: Record<string, unknown>): string {
  const summary = readTextArray(item, "summary");
  if (summary.length > 0) {
    return summary.join("\n");
  }
  const content = readTextArray(item, "content");
  return content.join("\n");
}

/** Prefer summary (user-visible reasoning summary) over raw reasoning content. */
function readReasoningDisplay(item: Record<string, unknown>): "summary" | "raw" | undefined {
  if (readTextArray(item, "summary").length > 0) {
    return "summary";
  }
  if (readTextArray(item, "content").length > 0) {
    return "raw";
  }
  return undefined;
}

function readTextArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (isRecord(entry) && typeof entry.text === "string") {
        return entry.text.trim();
      }
      return "";
    })
    .filter((entry) => entry.length > 0);
}

function readFileChangeMetadata(item: Record<string, unknown>):
  | {
      path: string;
      additions: number;
      deletions: number;
      previewLines: Array<{ kind: "add" | "remove" | "context"; text: string }>;
    }
  | undefined {
  const changes = item.changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return undefined;
  }
  const first = changes.find((entry) => isRecord(entry));
  if (!first || !isRecord(first)) {
    return undefined;
  }
  const path = readString(first, "path");
  const diff = readString(first, "diff") ?? "";
  if (!path) {
    return undefined;
  }
  const previewLines = previewLinesFromDiff(diff);
  const additions = previewLines.filter((line) => line.kind === "add").length;
  const deletions = previewLines.filter((line) => line.kind === "remove").length;
  return { path, additions, deletions, previewLines };
}

function previewLinesFromDiff(diff: string): Array<{ kind: "add" | "remove" | "context"; text: string }> {
  const lines = diff.split("\n").slice(0, 40);
  const out: Array<{ kind: "add" | "remove" | "context"; text: string }> = [];
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      out.push({ kind: "remove", text: line.slice(1) });
    } else {
      out.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  return out;
}

/**
 * Live Codex multi-agent v2 emits `subAgentActivity` on the **parent** thread
 * (`agentThreadId` + `agentPath`), not `collabAgentToolCall` / `spawn_agent`.
 * @see codex-rs/app-server-protocol ThreadItem::SubAgentActivity
 */
function handleSubAgentActivityLifecycle(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  _phase: "started" | "completed",
): void {
  const parentThreadId = readCodexThreadId(params);
  const agentThreadId = readString(item, "agentThreadId");
  const agentPath = readString(item, "agentPath");
  const kind = (readString(item, "kind") ?? "").toLowerCase();
  const itemId = readCodexItemId(params, item);
  const turnId = readCodexTurnId(params);
  if (!parentThreadId || !agentThreadId) {
    return;
  }

  // Never attribute the parent thread as its own subagent (would scope planner
  // thinking/messages onto an agent card).
  if (agentThreadId === parentThreadId) {
    return;
  }

  // agentPath is /root/{task_name}, not agent_type. Role comes from PreToolUse queue,
  // persisted attribution, or thread/started — never from task_name alone.
  const existingRole = ctx.getThreadAttributionRecord?.(agentThreadId)?.agentRole;
  const existingOrchestrationRole = resolveChosenOrchestrationRole(ctx, existingRole);
  const taskName = taskNameFromAgentPath(agentPath);
  const queuedPayload =
    kind === "started" && itemId ? ctx.dequeueSpawnPayloadMatching?.({ toolUseId: itemId }) : undefined;
  const queuedRole = queuedPayload?.agentRole;
  const pathRoleHint = agentRoleFromAgentPath(ctx, agentPath);
  const chosenOrchestrationRole = resolveChosenOrchestrationRole(
    ctx,
    queuedRole,
    existingOrchestrationRole,
    pathRoleHint,
  );
  const displayRole = resolveSubagentDisplayRole(ctx, chosenOrchestrationRole);
  const queuedTaskName = queuedPayload?.taskName ?? taskName;
  const persistedSpawnMessage = ctx.getThreadAttributionRecord?.(agentThreadId)?.spawnMessage;
  const spawnPrompt =
    kind === "started"
      ? resolveSpawnTaskPrompt({
          ...(queuedPayload?.message && { message: queuedPayload.message }),
          ...(queuedTaskName && { taskName: queuedTaskName }),
          ...(persistedSpawnMessage && { persisted: persistedSpawnMessage }),
        })
      : undefined;
  const delegation =
    spawnPrompt && kind === "started" ? buildSpawnDelegationMetadata(displayRole, spawnPrompt) : undefined;

  ctx.recordThreadAttribution?.(agentThreadId, {
    parentThreadId,
    agentRole: displayRole,
    ...(itemId && { spawnCallId: itemId }),
    ...(spawnPrompt && { spawnMessage: spawnPrompt }),
  });

  if (kind === "started") {
    emitAgentLifecycle(ctx, {
      eventType: "agent.started",
      codexThreadId: parentThreadId,
      turnId,
      itemId,
      agentId: agentThreadId,
      ...(itemId && { parentToolUseId: itemId }),
      role: displayRole,
      message: `Subagent ${displayRole} started`,
      metadata: {
        codexMethod: "item/completed",
        liveType: "agent.started",
        logicalEntityId: itemId,
        itemId,
        itemType: "subAgentActivity",
        agentPath,
        agentThreadId,
        subAgentActivityKind: kind,
        ...(queuedTaskName && { taskName: queuedTaskName }),
        ...(chosenOrchestrationRole && { orchestrationRole: chosenOrchestrationRole }),
        ...(delegation ?? {}),
      },
    });
    return;
  }

  if (kind === "interrupted") {
    emitAgentLifecycle(ctx, {
      eventType: "agent.abandoned",
      codexThreadId: parentThreadId,
      turnId,
      itemId,
      agentId: agentThreadId,
      ...(itemId && { parentToolUseId: itemId }),
      role: displayRole,
      message: `Subagent ${displayRole} interrupted`,
      metadata: {
        codexMethod: "item/completed",
        liveType: "agent.abandoned",
        logicalEntityId: itemId,
        itemId,
        itemType: "subAgentActivity",
        agentPath,
        agentThreadId,
        subAgentActivityKind: kind,
      },
    });
  }
}

const DEFAULT_ECO_PROFILE_ROLE_IDS = ["explore", "architect", "coder", "reviewer", "tester"] as const;

/** Orchestration role id when spawn explicitly chose agent_type; otherwise undefined. */
function resolveChosenOrchestrationRole(
  ctx: Pick<AdapterContext, "orchestrationRoleIds" | "resolveOrchestrationRoleIds">,
  ...candidates: Array<string | undefined>
): string | undefined {
  const roleLookup = buildOrchestrationRoleLookup(ctx);
  for (const candidate of candidates) {
    const normalized = candidate?.trim().toLowerCase();
    const orchestrationRole = normalized ? roleLookup.get(normalized) : undefined;
    if (orchestrationRole) {
      return orchestrationRole;
    }
  }
  return undefined;
}

/** UI/billing display role: explicit orchestration pick, or general when spawn omitted agent_type. */
function resolveSubagentDisplayRole(
  ctx: Pick<AdapterContext, "orchestrationRoleIds" | "resolveOrchestrationRoleIds">,
  chosenOrchestrationRole?: string,
): string {
  return resolveChosenOrchestrationRole(ctx, chosenOrchestrationRole) ?? CODEX_GENERAL_SPAWN_ROLE;
}

function buildOrchestrationRoleLookup(
  ctx: Pick<AdapterContext, "orchestrationRoleIds" | "resolveOrchestrationRoleIds">,
): Map<string, string> {
  const lookup = new Map<string, string>();
  const roleIds = [
    ...DEFAULT_ECO_PROFILE_ROLE_IDS,
    ...(ctx.orchestrationRoleIds ?? []),
    ...(ctx.resolveOrchestrationRoleIds?.() ?? []),
  ];
  for (const role of roleIds) {
    const trimmed = role.trim();
    if (trimmed) {
      lookup.set(trimmed.toLowerCase(), trimmed);
    }
  }
  return lookup;
}

function isCollabSpawnTool(tool: string | undefined): boolean {
  return tool === "spawnAgent";
}

/**
 * Codex `agentPath` is `/root/{task_name}` (task label), not `agent_type`.
 * Only treat the last segment as a role when it matches a known Eco orchestration role id.
 */
function agentRoleFromAgentPath(
  ctx: Pick<AdapterContext, "orchestrationRoleIds" | "resolveOrchestrationRoleIds">,
  agentPath: string | undefined,
): string | undefined {
  if (!agentPath?.trim()) {
    return undefined;
  }
  const segments = agentPath
    .trim()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const last = segments[segments.length - 1]?.toLowerCase();
  if (!last) {
    return undefined;
  }
  return buildOrchestrationRoleLookup(ctx).get(last);
}

function readCollabSpawnPrompt(item: Record<string, unknown>): string | undefined {
  return readString(item, "prompt");
}

/** `/root/{task_name}` — task label only, not the full spawn message. */
function taskNameFromAgentPath(agentPath: string | undefined): string | undefined {
  if (!agentPath?.trim()) {
    return undefined;
  }
  const segments = agentPath
    .trim()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const last = segments[segments.length - 1];
  return last || undefined;
}

function resolveSpawnTaskPrompt(input: {
  message?: string;
  taskName?: string;
  preview?: string;
  persisted?: string;
}): string | undefined {
  const message = input.message?.trim();
  if (message) {
    return message.slice(0, 12_000);
  }
  const persisted = input.persisted?.trim();
  if (persisted) {
    return persisted.slice(0, 12_000);
  }
  const preview = input.preview?.trim();
  if (preview) {
    return preview.slice(0, 12_000);
  }
  const taskName = input.taskName?.trim();
  if (taskName) {
    return taskName.slice(0, 12_000);
  }
  return undefined;
}

function buildSpawnDelegationMetadata(
  role: string,
  prompt: string,
): { delegationPrompt: string; delegationSummary: string } {
  const delegationPrompt = prompt.trim().slice(0, 12_000);
  return {
    delegationPrompt,
    delegationSummary: summarizeAgentObjective(role, delegationPrompt),
  };
}

function handleCollabToolCallLifecycle(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
  phase: "started" | "completed",
): void {
  const tool = readString(item, "tool");
  if (!isCollabSpawnTool(tool)) {
    return;
  }

  const codexThreadId = readCodexThreadId(params);
  const itemId = readCodexItemId(params, item);
  const newThreadId = readCollabNewThreadId(item);
  const turnId = readCodexTurnId(params);
  if (!codexThreadId || !itemId) {
    return;
  }

  const parentThreadId = readString(item, "senderThreadId");
  const existingRecord = newThreadId ? ctx.getThreadAttributionRecord?.(newThreadId) : undefined;
  const collabSpawnMessage = readCollabSpawnPrompt(item);
  const persistedSpawnMessage = existingRecord?.spawnMessage;
  const matchingQueuedPayload =
    newThreadId && parentThreadId && newThreadId !== parentThreadId
      ? ctx.dequeueSpawnPayloadMatching?.({
          toolUseId: itemId,
        })
      : undefined;
  const existingOrchestrationRole = resolveChosenOrchestrationRole(ctx, existingRecord?.agentRole);
  const queuedPayload = matchingQueuedPayload;
  // An exact current spawn payload supersedes persisted attribution from an
  // older event for the same child thread.
  const queuedRole = queuedPayload?.agentRole;
  const chosenOrchestrationRole = resolveChosenOrchestrationRole(ctx, queuedRole, existingOrchestrationRole);
  const displayRole = resolveSubagentDisplayRole(ctx, chosenOrchestrationRole);
  const queuedTaskName = queuedPayload?.taskName;
  const agentNickname =
    readCollabReceiverAgentNickname(item, newThreadId) ??
    readAgentNickname(item) ??
    existingRecord?.agentNickname?.trim();
  const spawnPrompt = resolveSpawnTaskPrompt({
    ...(queuedPayload?.message && { message: queuedPayload.message }),
    ...(collabSpawnMessage && { message: collabSpawnMessage }),
    ...(queuedTaskName && { taskName: queuedTaskName }),
    ...(persistedSpawnMessage && { persisted: persistedSpawnMessage }),
  });
  const delegation = spawnPrompt ? buildSpawnDelegationMetadata(displayRole, spawnPrompt) : undefined;
  // Parent link alone is enough for Eco thread FK resolution.
  if (newThreadId && parentThreadId && newThreadId !== parentThreadId) {
    ctx.recordThreadAttribution?.(newThreadId, {
      parentThreadId,
      agentRole: displayRole,
      spawnCallId: itemId,
      ...(agentNickname && { agentNickname }),
      ...(spawnPrompt && { spawnMessage: spawnPrompt }),
    });
  }

  if (phase === "started") {
    if (!newThreadId) {
      return;
    }
    emitAgentLifecycle(ctx, {
      eventType: "agent.started",
      codexThreadId,
      turnId,
      itemId,
      agentId: newThreadId,
      parentToolUseId: itemId,
      role: displayRole,
      message: `Subagent ${displayRole} started`,
      metadata: {
        codexMethod: "item/started",
        liveType: "agent.started",
        logicalEntityId: itemId,
        itemId,
        itemType: "collabAgentToolCall",
        collabTool: tool,
        codexNewThreadId: newThreadId,
        agentRole: displayRole,
        ...(queuedTaskName && { taskName: queuedTaskName }),
        ...(agentNickname && { agentNickname }),
        ...(chosenOrchestrationRole && { orchestrationRole: chosenOrchestrationRole }),
        ...(delegation ?? {}),
      },
    });
    return;
  }

  const status = readString(item, "status")?.toLowerCase();
  const eventType = status === "failed" ? "agent.abandoned" : "agent.started";
  emitAgentLifecycle(ctx, {
    eventType,
    codexThreadId,
    turnId,
    itemId,
    agentId: newThreadId,
    parentToolUseId: itemId,
    role: displayRole,
    message: status === "failed" ? `Subagent ${displayRole} failed` : `Subagent ${displayRole} started`,
    metadata: {
      codexMethod: "item/completed",
      liveType: eventType,
      logicalEntityId: itemId,
      itemId,
      itemType: "collabAgentToolCall",
      collabTool: tool,
      agentRole: displayRole,
      ...(queuedTaskName && { taskName: queuedTaskName }),
      ...(agentNickname && { agentNickname }),
      ...(chosenOrchestrationRole && { orchestrationRole: chosenOrchestrationRole }),
      ...(newThreadId ? { codexNewThreadId: newThreadId } : {}),
      ...(status ? { collabStatus: status } : {}),
      ...(delegation ?? {}),
    },
  });
}

function readCollabNewThreadId(item: Record<string, unknown>): string | undefined {
  const receiverAgents = item.receiverAgents ?? item.receiver_agents;
  if (Array.isArray(receiverAgents)) {
    for (const entry of receiverAgents) {
      if (!isRecord(entry)) {
        continue;
      }
      const threadId = readString(entry, "threadId") ?? readString(entry, "thread_id");
      if (threadId) {
        return threadId;
      }
    }
  }
  const receiverThreadIds = item.receiverThreadIds ?? item.receiver_thread_ids;
  if (Array.isArray(receiverThreadIds)) {
    for (const entry of receiverThreadIds) {
      if (typeof entry === "string" && entry.trim()) {
        return entry.trim();
      }
    }
  }
  return undefined;
}

function readCollabReceiverAgentNickname(
  item: Record<string, unknown>,
  threadId: string | undefined,
): string | undefined {
  const receiverAgents = item.receiverAgents ?? item.receiver_agents;
  if (!Array.isArray(receiverAgents)) {
    return undefined;
  }
  for (const entry of receiverAgents) {
    if (!isRecord(entry)) {
      continue;
    }
    const entryThreadId = readString(entry, "threadId") ?? readString(entry, "thread_id");
    if (threadId && entryThreadId && entryThreadId !== threadId) {
      continue;
    }
    const nickname = readAgentNickname(entry);
    if (nickname) {
      return nickname;
    }
  }
  return undefined;
}

function readAgentNickname(record: Record<string, unknown>): string | undefined {
  return (
    readString(record, "agentNickname") ??
    readString(record, "agent_nickname") ??
    readString(record, "nickname")
  );
}

function readItemPayload(params: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(params.item)) {
    return params.item;
  }
  return undefined;
}

function readItemType(item: Record<string, unknown>): string | undefined {
  return readString(item, "type");
}

/** Same thread resolution as `emit`; buffers until the Codex thread maps to an Eco thread. */
function dispatchAsyncQuestions(
  ctx: AdapterContext,
  input: Omit<CodexAsyncQuestionsInput, "ecoThreadId">,
): void {
  const attribution = ctx.resolveThreadAttribution?.(input.codexThreadId);
  const mappedThreadId = ctx.resolveEcoThreadId(input.codexThreadId);
  const ecoThreadId = attribution?.ecoThreadId?.trim() || mappedThreadId;
  if (!attribution?.ecoThreadId && ecoThreadId === input.codexThreadId) {
    const pending = ctx.pendingAsyncQuestionsByCodexThreadId.get(input.codexThreadId) ?? [];
    pending.push(input);
    ctx.pendingAsyncQuestionsByCodexThreadId.set(input.codexThreadId, pending);
    return;
  }
  ctx.onAsyncQuestions?.({ ...input, ecoThreadId });
}

const ASYNC_AGENT_MESSAGE_DELIVERY = "async";

/**
 * Read `delivery` + `questions` off an `agentMessage` item.
 * Returns undefined for ordinary messages and for malformed question payloads.
 */
function readAsyncQuestionsFromItem(
  item: Record<string, unknown>,
): { message: string; questions: CodexAsyncUserInputQuestion[] } | undefined {
  if (readString(item, "delivery") !== ASYNC_AGENT_MESSAGE_DELIVERY) {
    return undefined;
  }
  const rawQuestions = item.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return undefined;
  }
  const questions: CodexAsyncUserInputQuestion[] = [];
  for (const entry of rawQuestions) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const title = readString(entry, "title")?.trim();
    if (!title) {
      return undefined;
    }
    const rawOptions = entry.options;
    if (rawOptions !== undefined && rawOptions !== null && !Array.isArray(rawOptions)) {
      return undefined;
    }
    const options = Array.isArray(rawOptions)
      ? rawOptions.filter((option): option is string => typeof option === "string")
      : null;
    questions.push({ title, options });
  }
  return { message: readString(item, "text") ?? "", questions };
}

/**
 * Surface async questions from both `item/started` and `item/completed`: upstream
 * emits the same item for both, and only `item/completed` is delivery-guaranteed,
 * so a consumer that sees just one of them must still show the question.
 */
function handleItemAsyncQuestions(
  ctx: AdapterContext,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
): void {
  const parsed = readAsyncQuestionsFromItem(item);
  if (!parsed) {
    return;
  }
  const codexThreadId = readCodexThreadId(params);
  const itemId = readCodexItemId(params, item);
  if (!codexThreadId || !itemId) {
    return;
  }
  dispatchAsyncQuestions(ctx, {
    codexThreadId,
    turnId: readCodexTurnId(params),
    itemId,
    message: parsed.message,
    questions: parsed.questions,
  });
}

function emit(ctx: AdapterContext, input: EmitInput): void {
  const attribution = ctx.resolveThreadAttribution?.(input.codexThreadId);
  const mappedThreadId = ctx.resolveEcoThreadId(input.codexThreadId);
  // Sub-agent Codex threads are not in eco_thread_codex_map; parent eco id comes from attribution.
  const threadId = attribution?.ecoThreadId?.trim() || mappedThreadId;
  // Only take agentId from attribution when this Codex thread is a real subagent.
  // Root threads with a corrupted isSubagent label must not stamp agentId=self.
  const agentId =
    input.agentId?.trim() || (attribution?.isSubagentThread ? attribution.agentId?.trim() : undefined);
  const persistedRole = ctx.getThreadAttributionRecord?.(input.codexThreadId)?.agentRole?.trim();
  const role = attribution?.isSubagentThread
    ? resolveSubagentDisplayRole(ctx, resolveChosenOrchestrationRole(ctx, input.role?.trim(), persistedRole))
    : input.role?.trim() || undefined;
  const scope = input.scope ?? (agentId ? "agent" : "main");
  // Unmapped Codex id must not be written to thread_run_events (FK → threads.id).
  const unresolved = !attribution?.ecoThreadId && threadId === input.codexThreadId;
  if (unresolved) {
    const pending = ctx.pendingEventsByCodexThreadId.get(input.codexThreadId) ?? [];
    pending.push(input);
    ctx.pendingEventsByCodexThreadId.set(input.codexThreadId, pending);
    return;
  }
  const turnId = input.turnId?.trim();
  const itemId = input.itemId?.trim();
  const stableStreamEventId =
    (input.eventType === "message.delta" || input.eventType === "thinking.delta") && itemId
      ? ["tre:codex", input.eventType, input.codexThreadId, turnId ?? "turn", itemId].join(":")
      : undefined;
  const eventId =
    input.stableEventId?.trim() ||
    stableStreamEventId ||
    [
      "tre:codex",
      input.eventType,
      turnId ?? "turn",
      itemId ?? String(ctx.eventCounter),
      String(ctx.eventCounter),
    ].join(":");

  ctx.eventCounter += 1;

  ctx.recordThreadRunEvent({
    id: eventId.startsWith("tre:") ? eventId : `tre:${eventId}`,
    threadId,
    eventType: input.eventType,
    scope,
    streamState: input.streamState,
    message: input.message,
    observedAt: ctx.observedAt,
    ...(role && { role }),
    ...(agentId && { agentId }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
    ...(itemId && { streamKey: itemId }),
    metadata: {
      ...(input.metadata ?? {}),
      codexThreadId: input.codexThreadId,
      ...(turnId && { turnId }),
    },
  });
}

function emitAgentLifecycle(
  ctx: AdapterContext,
  input: {
    eventType: "agent.started" | "agent.stopped" | "agent.abandoned";
    codexThreadId: string;
    turnId?: string | undefined;
    itemId?: string | undefined;
    agentId?: string | undefined;
    parentToolUseId?: string | undefined;
    role: string;
    message: string;
    metadata?: Record<string, unknown> | undefined;
  },
): void {
  const agentId = input.agentId?.trim();
  if (input.eventType === "agent.started" && agentId) {
    if (ctx.emittedAgentStartedIds.has(agentId)) {
      // Collab completed often lands before thread/started. Allow a second emit with the
      // same stable id so nickname/taskName can enrich the persisted agent.started row.
      if (!agentStartedMetadataNeedsEnrichment(input.metadata)) {
        return;
      }
    } else {
      ctx.emittedAgentStartedIds.add(agentId);
    }
  }
  emit(ctx, {
    ...input,
    streamState: "finalized",
    scope: "agent",
    ...(agentId ? { stableEventId: `tre:codex:${input.eventType}:${agentId}` } : {}),
  });
}

function agentStartedMetadataNeedsEnrichment(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) {
    return false;
  }
  const nickname =
    typeof metadata.agentNickname === "string"
      ? metadata.agentNickname.trim()
      : typeof metadata.nickname === "string"
        ? metadata.nickname.trim()
        : "";
  const taskName = typeof metadata.taskName === "string" ? metadata.taskName.trim() : "";
  return Boolean(nickname || taskName);
}

/** `turn/started|completed` carry `turn.id`; item notifications carry top-level `turnId`. */
function readCodexThreadId(params: Record<string, unknown>): string | undefined {
  return readString(params, "threadId");
}

function readCodexTurnId(params: Record<string, unknown>): string | undefined {
  const topLevel = readString(params, "turnId");
  if (topLevel) {
    return topLevel;
  }
  const turn = readTurnRecord(params);
  return turn ? readString(turn, "id") : undefined;
}

function readCodexTurnRecordId(params: Record<string, unknown>): string | undefined {
  const turn = readTurnRecord(params);
  return turn ? readString(turn, "id") : undefined;
}

function readCodexItemId(
  params: Record<string, unknown>,
  item?: Record<string, unknown>,
): string | undefined {
  const topLevel = readString(params, "itemId");
  if (topLevel) {
    return topLevel;
  }
  const resolvedItem = item ?? readItemPayload(params);
  return resolvedItem ? readString(resolvedItem, "id") : undefined;
}

function resolveObservedDurationMs(startedAt: string | undefined, endedAt: string): number | undefined {
  if (!startedAt) {
    return undefined;
  }
  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs < startedMs) {
    return undefined;
  }
  return endedMs - startedMs;
}

function readTurnRecord(params: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(params.turn) ? params.turn : undefined;
}

function readCodexTurnStatus(
  params: Record<string, unknown>,
): "completed" | "failed" | "interrupted" | undefined {
  const turn = readTurnRecord(params);
  const status = turn ? readString(turn, "status") : undefined;
  return status === "completed" || status === "failed" || status === "interrupted" ? status : undefined;
}

function readCodexTurnErrorMessage(params: Record<string, unknown>): string | undefined {
  const turn = readTurnRecord(params);
  const error = turn && isRecord(turn.error) ? turn.error : undefined;
  if (!error) {
    return undefined;
  }
  const message = readString(error, "message");
  const details = readString(error, "additionalDetails");
  if (message && details) {
    return `${message}: ${details}`;
  }
  return message;
}

function readUserMessageText(item: Record<string, unknown>): string {
  const direct = readString(item, "text");
  if (direct) {
    return direct;
  }
  const content = item.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("");
}

function readDeltaText(params: Record<string, unknown>): string | undefined {
  if (typeof params.delta === "string") {
    return params.delta;
  }
  if (isRecord(params.delta) && typeof params.delta.content === "string") {
    return params.delta.content;
  }
  if (typeof params.text === "string") {
    return params.text;
  }
  return undefined;
}

function readSummaryIndex(params: Record<string, unknown>): number | undefined {
  const value = params.summaryIndex ?? params.summary_index;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
