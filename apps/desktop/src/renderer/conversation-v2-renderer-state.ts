import type {
  ConversationAgent,
  ConversationBootstrap,
  ConversationDetailItem,
  ConversationEffect,
  ConversationMessage,
  ConversationMessageHistoryTarget,
  ConversationMessagesPage,
  ConversationRun,
  ConversationSyncEffect,
  ConversationSyncPage,
  ConversationTodo,
  ConversationToolCall,
  ConversationToolsPage,
} from "@eco/shared";
import { isConversationMessageOrigin, limitConversationToolSummaryPayload, stableHash, stableJson } from "@eco/shared";
import type { ConversationV2ProjectionExtras } from "../shared/ipc";

function isGenericToolLabel(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "mcp: tool" || normalized === "mcp tool" || normalized === "tool";
}

function chooseToolName(existingName: string, incomingName: string): string {
  if (isGenericToolLabel(existingName) && !isGenericToolLabel(incomingName)) return incomingName;
  return existingName;
}

export interface ConversationV2RendererState {
  conversationId: string;
  storeEpoch: string;
  appliedSeq: number;
  historyRevision: number;
  messages: ReadonlyMap<string, ConversationMessage>;
  runs: ReadonlyMap<string, ConversationRun>;
  agents: ReadonlyMap<string, ConversationAgent>;
  todos: ReadonlyMap<string, ConversationTodo>;
  tools: ReadonlyMap<string, ConversationToolCall>;
  /** Total tool rows per run, including runs whose summaries were trimmed from bootstrap. */
  toolSummaryCounts?: ReadonlyMap<string, number>;
  details: ReadonlyMap<string, ConversationDetailItem>;
  projectionExtras?: ConversationV2ProjectionExtras;
  effectHashes: ReadonlyMap<number, string>;
  /**
   * The cursor of the oldest message the client holds, and whether the store still has
   * older ones. `bootstrap()` reads a window (the newest page), so a conversation whose
   * history is longer than one page is only complete after the client has followed these
   * backwards. They are read state, not effect state: following them never moves
   * `appliedSeq`, which is what the effect log has been replayed through.
   */
  olderCursor?: string;
  hasOlder: boolean;
}

// Duplicate notifications are verified against the authoritative store when
// their hash is no longer in this bounded recent window. Keeping every hash
// made each streamed event copy an ever-growing Map, turning long histories
// into quadratic renderer work.
const MAX_EFFECT_HASHES = 2_048;

function rememberEffectHash(effectHashes: Map<number, string>, seq: number, hash: string): void {
  effectHashes.set(seq, hash);
  while (effectHashes.size > MAX_EFFECT_HASHES) {
    const oldest = effectHashes.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    effectHashes.delete(oldest);
  }
}

function normalizeToolSummaryCounts(
  value: Record<string, number> | undefined,
): ReadonlyMap<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Conversation V2 renderer tool summary counts are invalid.");
  }
  const counts = new Map<string, number>();
  for (const [runId, total] of Object.entries(value)) {
    if (!runId.trim() || !Number.isSafeInteger(total) || total < 0) {
      throw new Error("Conversation V2 renderer tool summary counts are invalid.");
    }
    counts.set(runId, total);
  }
  return counts;
}

/** Run ids that may still have tool pages after bootstrap/page byte trimming. */
export function conversationV2ToolRunIdsForHydration(state: ConversationV2RendererState): Set<string> {
  return new Set<string>([
    ...(state.toolSummaryCounts?.keys() ?? []),
    ...state.runs.keys(),
    ...[...state.tools.values()].map((tool) => tool.runId),
  ]);
}

export function installConversationV2ProjectionExtras(
  state: ConversationV2RendererState,
  extras: ConversationV2ProjectionExtras,
): ConversationV2RendererState {
  if (!extras || !Array.isArray(extras.requestSpans)) {
    throw new Error("Conversation V2 renderer projection extras are invalid.");
  }
  if (extras.ledgerEvents !== undefined && !Array.isArray(extras.ledgerEvents)) {
    throw new Error("Conversation V2 renderer ledger events are invalid.");
  }
  return {
    ...state,
    projectionExtras: {
      requestSpans: [...extras.requestSpans],
      ...(extras.billing ? { billing: extras.billing } : {}),
      ...(extras.ledgerEvents ? { ledgerEvents: [...extras.ledgerEvents] } : {}),
      ...(extras.context ? { context: extras.context } : {}),
      ...(extras.subagentTimings ? { subagentTimings: [...extras.subagentTimings] } : {}),
      ...(extras.subagentMetrics ? { subagentMetrics: [...extras.subagentMetrics] } : {}),
    },
  };
}

export class ConversationV2RendererGapError extends Error {
  readonly expectedSeq: number;
  readonly actualSeq: number;

  constructor(expectedSeq: number, actualSeq: number) {
    super(`Conversation V2 renderer effect gap: expected ${expectedSeq}, got ${actualSeq}.`);
    this.name = "ConversationV2RendererGapError";
    this.expectedSeq = expectedSeq;
    this.actualSeq = actualSeq;
  }
}

export class ConversationV2RendererConflictError extends Error {
  constructor(seq: number) {
    super(`Conversation V2 renderer received a conflicting effect at sequence ${seq}.`);
    this.name = "ConversationV2RendererConflictError";
  }
}

/**
 * Advances a renderer snapshot through a bounded V2 effect range.
 *
 * Read pages (history/tool summaries) carry the stream sequence they observed. A live
 * runtime event may commit after bootstrap but before one of those page reads, so the
 * page can legitimately be newer than the renderer state. Replay that committed range
 * before merging the read-only page instead of treating the race as a permanent gap.
 */
export async function catchUpConversationV2RendererState(
  initial: ConversationV2RendererState,
  targetSeq: number,
  readPage: (afterSeq: number, throughSeq: number) => Promise<ConversationSyncPage>,
  maxEvents: number,
): Promise<ConversationV2RendererState> {
  if (
    !Number.isSafeInteger(targetSeq) ||
    targetSeq < 0 ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1
  ) {
    throw new Error("Conversation V2 renderer catch-up target is invalid.");
  }
  let state = initial;
  while (state.appliedSeq < targetSeq) {
    const afterSeq = state.appliedSeq;
    const page = await readPage(afterSeq, targetSeq);
    if (
      page.protocolVersion !== 2 ||
      page.conversationId !== state.conversationId ||
      page.storeEpoch !== state.storeEpoch ||
      !Number.isSafeInteger(page.fromSeq) ||
      !Number.isSafeInteger(page.throughSeq) ||
      !Number.isSafeInteger(page.headSeq) ||
      page.fromSeq !== afterSeq + 1 ||
      page.throughSeq <= afterSeq ||
      page.throughSeq > targetSeq ||
      page.headSeq < targetSeq ||
      page.throughSeq > page.headSeq ||
      (!page.hasMore && page.throughSeq < page.headSeq) ||
      (page.hasMore && page.throughSeq >= page.headSeq) ||
      !Array.isArray(page.effects) ||
      page.effects.length === 0 ||
      page.effects.length > maxEvents
    ) {
      throw new Error("Conversation V2 renderer received an invalid catch-up page.");
    }
    state = applyConversationV2Effects(state, page.effects);
    if (state.appliedSeq !== page.throughSeq) {
      throw new Error("Conversation V2 renderer did not close the sync range.");
    }
  }
  return state;
}

export function installConversationV2Bootstrap(
  bootstrap: ConversationBootstrap,
): ConversationV2RendererState {
  if (
    bootstrap.protocolVersion !== 2 ||
    !bootstrap.conversationId.trim() ||
    !bootstrap.storeEpoch.trim() ||
    !Number.isSafeInteger(bootstrap.snapshotSeq) ||
    bootstrap.snapshotSeq < 0 ||
    !Number.isSafeInteger(bootstrap.historyRevision) ||
    bootstrap.historyRevision < 0 ||
    bootstrap.historyRevision > bootstrap.snapshotSeq ||
    !Array.isArray(bootstrap.messages) ||
    !Array.isArray(bootstrap.turns) ||
    !Array.isArray(bootstrap.runs) ||
    !Array.isArray(bootstrap.tools) ||
    (bootstrap.details !== undefined && !Array.isArray(bootstrap.details)) ||
    typeof bootstrap.hasOlder !== "boolean" ||
    (bootstrap.hasOlder && typeof bootstrap.olderCursor !== "string") ||
    (!bootstrap.hasOlder && bootstrap.olderCursor !== undefined)
  ) {
    throw new Error("Conversation V2 renderer bootstrap metadata is invalid.");
  }
  for (const message of bootstrap.messages) {
    validateMessage(message, bootstrap.conversationId, bootstrap.snapshotSeq, "bootstrap message");
  }
  const turnIds = new Set<string>();
  for (const turn of bootstrap.turns) {
    if (
      !turn.turnId.trim() ||
      turn.conversationId !== bootstrap.conversationId ||
      !Number.isSafeInteger(turn.createdSeq) ||
      turn.createdSeq < 1 ||
      turn.createdSeq > bootstrap.snapshotSeq ||
      !Number.isSafeInteger(turn.versionSeq) ||
      turn.versionSeq < turn.createdSeq ||
      turn.versionSeq > bootstrap.snapshotSeq ||
      !turnIds.add(turn.turnId)
    ) {
      throw new Error("Conversation V2 renderer bootstrap turn is invalid.");
    }
  }
  for (const run of bootstrap.runs) {
    validateRun(run, bootstrap.conversationId, bootstrap.snapshotSeq, "bootstrap run");
  }
  const messageIds = new Set<string>();
  for (const message of bootstrap.messages) {
    if (messageIds.has(message.messageId)) {
      throw new Error(`Conversation V2 renderer bootstrap message ${message.messageId} is duplicated.`);
    }
    messageIds.add(message.messageId);
  }
  const runIds = new Set<string>();
  for (const run of bootstrap.runs) {
    if (runIds.has(run.runId)) {
      throw new Error(`Conversation V2 renderer bootstrap run ${run.runId} is duplicated.`);
    }
    runIds.add(run.runId);
  }
  const agents = bootstrap.agents ?? [];
  const agentIds = new Set<string>();
  for (const agent of agents) {
    validateAgent(agent, bootstrap.conversationId, bootstrap.snapshotSeq);
    if (!agentIds.add(agent.agentId)) {
      throw new Error(`Conversation V2 renderer bootstrap agent ${agent.agentId} is duplicated.`);
    }
  }
  const todos = bootstrap.todos ?? [];
  const toolSummaryCounts = normalizeToolSummaryCounts(bootstrap.toolSummaryCounts);
  const todoIds = new Set<string>();
  const todoPositions = new Set<number>();
  for (const todo of todos) {
    validateTodo(todo, bootstrap.conversationId, bootstrap.snapshotSeq, "bootstrap todo");
    if (!todoIds.add(todo.todoId) || !todoPositions.add(todo.position)) {
      throw new Error(`Conversation V2 renderer bootstrap todo ${todo.todoId} is duplicated.`);
    }
  }
  const toolIds = new Set<string>();
  const details = bootstrap.details ?? [];
  const detailIds = new Set<string>();
  for (const detail of details) {
    validateDetail(detail, bootstrap.conversationId, bootstrap.snapshotSeq, "bootstrap detail");
    if (detailIds.has(detail.itemId)) {
      throw new Error(`Conversation V2 renderer bootstrap detail ${detail.itemId} is duplicated.`);
    }
    detailIds.add(detail.itemId);
  }
  for (const tool of bootstrap.tools) {
    validateTool(tool, bootstrap.conversationId, bootstrap.snapshotSeq, "bootstrap tool");
    if (!toolIds.add(tool.toolCallId)) {
      throw new Error(`Conversation V2 renderer bootstrap tool ${tool.toolCallId} is duplicated.`);
    }
  }
  return {
    conversationId: bootstrap.conversationId,
    storeEpoch: bootstrap.storeEpoch,
    appliedSeq: bootstrap.snapshotSeq,
    historyRevision: bootstrap.historyRevision,
    messages: new Map(bootstrap.messages.map((message) => [message.messageId, message])),
    runs: new Map(bootstrap.runs.map((run) => [run.runId, run])),
    agents: new Map(agents.map((agent) => [agent.agentId, agent])),
    todos: new Map(todos.map((todo) => [todo.todoId, todo])),
    tools: new Map(bootstrap.tools.map((tool) => [tool.toolCallId, tool])),
    ...(toolSummaryCounts ? { toolSummaryCounts } : {}),
    details: new Map(details.map((detail) => [detail.itemId, detail])),
    effectHashes: new Map(),
    hasOlder: bootstrap.hasOlder,
    ...(bootstrap.olderCursor ? { olderCursor: bootstrap.olderCursor } : {}),
  };
}

/**
 * Folds one older-history page into the state.
 *
 * `bootstrap()` returns the newest window plus a cursor; the rest of a long conversation
 * arrives through `messagesPage()`, which is why a client that stops after bootstrap holds
 * only part of the record — the Feed would draw the newest page and report the rest of the
 * conversation as if it never happened. Pages are read from the store, not replayed from the
 * effect log, so this changes what history the client holds and leaves `appliedSeq` alone.
 *
 * Rows a page repeats are not allowed to move the state backwards: the client already holds
 * the version it replayed from the effect log, and a page is a read of the same log.
 */
export function mergeConversationV2OlderPage(
  state: ConversationV2RendererState,
  page: ConversationMessagesPage,
): ConversationV2RendererState {
  if (
    page.protocolVersion !== 2 ||
    page.conversationId !== state.conversationId ||
    page.storeEpoch !== state.storeEpoch ||
    !Number.isSafeInteger(page.readSeq) ||
    page.readSeq < 0 ||
    !Number.isSafeInteger(page.historyRevision) ||
    page.historyRevision < 0 ||
    page.historyRevision > page.readSeq ||
    !Array.isArray(page.messages) ||
    typeof page.hasMore !== "boolean" ||
    (page.hasMore && typeof page.nextCursor !== "string")
  ) {
    throw new Error("Conversation V2 renderer history page metadata is invalid.");
  }
  // A page read at a sequence the client has not replayed yet would hand the Feed content
  // from effects it has not applied: the effect log stays the authority for anything the
  // client already saw, so the read must not run ahead of `appliedSeq`.
  if (page.readSeq > state.appliedSeq) {
    throw new ConversationV2RendererGapError(state.appliedSeq + 1, page.readSeq);
  }
  const messages = new Map(state.messages);
  for (const message of page.messages) {
    validateMessage(message, state.conversationId, page.readSeq, "history message");
    const existing = messages.get(message.messageId);
    // `versionSeq`, not `contentVersion`: finalizing a message keeps its content version and
    // still moves the row forward (streaming -> final), and a page is a read of the row as it
    // stands now. An equal version is the same row, so the client keeps what it replayed.
    if (!existing || message.versionSeq > existing.versionSeq) {
      messages.set(message.messageId, message);
    }
  }
  const runs = new Map(state.runs);
  for (const run of page.runs ?? []) {
    validateRun(run, state.conversationId, page.readSeq, "history run");
    const existing = runs.get(run.runId);
    if (!existing || run.versionSeq > existing.versionSeq) {
      runs.set(run.runId, run);
    }
  }
  const tools = new Map(state.tools);
  for (const tool of page.tools ?? []) {
    validateTool(tool, state.conversationId, page.readSeq, "history tool");
    const existing = tools.get(tool.toolCallId);
    if (!existing || tool.versionSeq > existing.versionSeq) {
      tools.set(tool.toolCallId, tool);
    }
  }
  const agents = new Map(state.agents);
  for (const agent of page.agents ?? []) {
    validateAgent(agent, state.conversationId, page.readSeq);
    if (!agents.has(agent.agentId)) {
      agents.set(agent.agentId, agent);
    }
  }
  const pageToolSummaryCounts = normalizeToolSummaryCounts(page.toolSummaryCounts);
  const toolSummaryCounts = new Map(state.toolSummaryCounts ?? []);
  for (const [runId, total] of pageToolSummaryCounts ?? []) {
    const previous = toolSummaryCounts.get(runId);
    if (previous === undefined || total > previous) toolSummaryCounts.set(runId, total);
  }
  const merged: ConversationV2RendererState = {
    ...state,
    messages,
    runs,
    tools,
    agents,
    ...(toolSummaryCounts.size > 0 ? { toolSummaryCounts } : {}),
    hasOlder: page.hasMore,
    ...(page.nextCursor ? { olderCursor: page.nextCursor } : {}),
  };
  // The cursor describes the page that was just read: keeping the previous one would ask the
  // store for a page the client already holds.
  if (!page.nextCursor) {
    delete merged.olderCursor;
  }
  return merged;
}

/**
 * Folds one bounded tool-summary page into the renderer state.
 *
 * Tool summaries have their own cursor because a single run can contain far more
 * calls than fits in bootstrap or a message page. The page is read-only state:
 * it must be at or behind the applied effect cursor and it never advances it.
 */
export function mergeConversationV2ToolPage(
  state: ConversationV2RendererState,
  page: ConversationToolsPage,
): ConversationV2RendererState {
  if (
    page.protocolVersion !== 2 ||
    page.conversationId !== state.conversationId ||
    page.storeEpoch !== state.storeEpoch ||
    !page.runId.trim() ||
    !Number.isSafeInteger(page.readSeq) ||
    page.readSeq < 0 ||
    !Number.isSafeInteger(page.historyRevision) ||
    page.historyRevision < 0 ||
    page.historyRevision !== state.historyRevision ||
    !Number.isSafeInteger(page.totalCount) ||
    page.totalCount < 0 ||
    page.totalCount < page.tools.length ||
    !Array.isArray(page.tools) ||
    typeof page.hasMore !== "boolean" ||
    (page.hasMore && typeof page.nextCursor !== "string") ||
    (!page.hasMore && page.nextCursor !== undefined)
  ) {
    throw new Error("Conversation V2 renderer tool page metadata is invalid.");
  }
  if (page.readSeq > state.appliedSeq) {
    throw new ConversationV2RendererGapError(state.appliedSeq + 1, page.readSeq);
  }
  const tools = new Map(state.tools);
  for (const tool of page.tools) {
    validateTool(tool, state.conversationId, page.readSeq, "tool page");
    if (tool.runId !== page.runId) {
      throw new Error(`Conversation V2 renderer tool ${tool.toolCallId} belongs to another run.`);
    }
    const existing = tools.get(tool.toolCallId);
    if (!existing) {
      tools.set(tool.toolCallId, tool);
      continue;
    }
    if (existing.runId !== tool.runId || existing.createdSeq !== tool.createdSeq) {
      throw new Error(`Conversation V2 renderer tool ${tool.toolCallId} changed identity.`);
    }
    const toolName = chooseToolName(existing.name, tool.name);
    if (toolName !== tool.name) {
      throw new Error(`Conversation V2 renderer tool ${tool.toolCallId} changed names.`);
    }
    assertStableOptional(`tool ${tool.toolCallId} agent ownership`, existing.agentId, tool.agentId);
    assertStableOptional(
      `tool ${tool.toolCallId} agent instance ownership`,
      existing.agentInstanceId,
      tool.agentInstanceId,
    );
    assertStableOptional(
      `tool ${tool.toolCallId} parent agent ownership`,
      existing.parentAgentInstanceId,
      tool.parentAgentInstanceId,
    );
    assertStableOptional(
      `tool ${tool.toolCallId} parent tool ownership`,
      existing.parentToolCallId,
      tool.parentToolCallId,
    );
    if (tool.versionSeq < existing.versionSeq) continue;
    if (tool.versionSeq === existing.versionSeq) {
      if (sameTool(existing, tool)) continue;
      throw new Error(`Conversation V2 renderer tool ${tool.toolCallId} has a conflicting version.`);
    }
    if (isTerminalTool(existing.status)) {
      if (isTerminalTool(tool.status) && existing.status !== tool.status) {
        throw new Error(
          `Conversation V2 renderer tool ${tool.toolCallId} has conflicting terminal statuses.`,
        );
      }
      if (!isTerminalTool(tool.status)) continue;
      tools.set(tool.toolCallId, { ...tool, status: existing.status });
      continue;
    }
    tools.set(tool.toolCallId, tool);
  }
  const toolSummaryCounts = new Map(state.toolSummaryCounts ?? []);
  const previousCount = toolSummaryCounts.get(page.runId);
  if (previousCount === undefined || page.totalCount > previousCount) {
    toolSummaryCounts.set(page.runId, page.totalCount);
  }
  return { ...state, tools, toolSummaryCounts };
}

export function applyConversationV2Effects(
  state: ConversationV2RendererState,
  effects: readonly ConversationSyncEffect[],
): ConversationV2RendererState {
  if (effects.length === 0) {
    return state;
  }

  // A sync page can contain hundreds of effects. Clone the renderer maps once
  // for the page instead of once per effect; the previous implementation made
  // a 157k-event history repeatedly copy its accumulated hash map.
  const messages = new Map(state.messages);
  const runs = new Map(state.runs);
  const agents = new Map(state.agents);
  const todos = new Map(state.todos);
  const tools = new Map(state.tools);
  const details = new Map(state.details);
  const effectHashes = new Map(state.effectHashes);
  let appliedSeq = state.appliedSeq;
  let historyRevision = state.historyRevision;

  for (const envelope of effects) {
    validateConversationV2EffectEnvelope(envelope);
    if (envelope.effectHash !== stableHash(envelope.effect)) {
      throw new Error(`Conversation V2 renderer effect hash mismatch at sequence ${envelope.seq}.`);
    }
    if (envelope.seq <= appliedSeq) {
      const knownHash = effectHashes.get(envelope.seq);
      if (knownHash && knownHash !== envelope.effectHash) {
        throw new ConversationV2RendererConflictError(envelope.seq);
      }
      continue;
    }
    if (envelope.seq !== appliedSeq + 1) {
      throw new ConversationV2RendererGapError(appliedSeq + 1, envelope.seq);
    }
    applyEffect(
      envelope.effect,
      envelope.seq,
      state.conversationId,
      messages,
      runs,
      agents,
      todos,
      tools,
      details,
      (revision) => {
        if (revision < historyRevision) {
          throw new Error("Conversation V2 renderer history revision regressed.");
        }
        historyRevision = revision;
      },
    );
    appliedSeq = envelope.seq;
    rememberEffectHash(effectHashes, envelope.seq, envelope.effectHash);
  }

  return {
    ...state,
    appliedSeq,
    historyRevision,
    messages,
    runs,
    agents,
    todos,
    tools,
    details,
    effectHashes,
  };
}

export function applyConversationV2Effect(
  state: ConversationV2RendererState,
  envelope: ConversationSyncEffect,
): ConversationV2RendererState {
  validateConversationV2EffectEnvelope(envelope);
  if (envelope.effectHash !== stableHash(envelope.effect)) {
    throw new Error(`Conversation V2 renderer effect hash mismatch at sequence ${envelope.seq}.`);
  }
  if (envelope.seq <= state.appliedSeq) {
    const knownHash = state.effectHashes.get(envelope.seq);
    if (knownHash && knownHash !== envelope.effectHash) {
      throw new ConversationV2RendererConflictError(envelope.seq);
    }
    return state;
  }
  if (envelope.seq !== state.appliedSeq + 1) {
    throw new ConversationV2RendererGapError(state.appliedSeq + 1, envelope.seq);
  }

  const messages = new Map(state.messages);
  const runs = new Map(state.runs);
  const agents = new Map(state.agents);
  const todos = new Map(state.todos);
  const tools = new Map(state.tools);
  const details = new Map(state.details);
  let historyRevision = state.historyRevision;
  applyEffect(
    envelope.effect,
    envelope.seq,
    state.conversationId,
    messages,
    runs,
    agents,
    todos,
    tools,
    details,
    (revision) => {
      if (revision < historyRevision) {
        throw new Error("Conversation V2 renderer history revision regressed.");
      }
      historyRevision = revision;
    },
  );
  const effectHashes = new Map(state.effectHashes);
  rememberEffectHash(effectHashes, envelope.seq, envelope.effectHash);
  return {
    ...state,
    appliedSeq: envelope.seq,
    historyRevision,
    messages,
    runs,
    agents,
    todos,
    tools,
    details,
    effectHashes,
  };
}

function validateConversationV2EffectEnvelope(envelope: ConversationSyncEffect): void {
  if (
    envelope.effectVersion !== 1 ||
    !Number.isSafeInteger(envelope.seq) ||
    envelope.seq < 1 ||
    typeof envelope.effectHash !== "string" ||
    !envelope.effectHash.trim() ||
    !envelope.effect ||
    typeof envelope.effect !== "object" ||
    Array.isArray(envelope.effect) ||
    typeof envelope.effect.type !== "string" ||
    !envelope.effect.type.trim()
  ) {
    throw new Error("Conversation V2 renderer effect metadata is invalid.");
  }
}

export function orderedConversationV2Messages(state: ConversationV2RendererState): ConversationMessage[] {
  return [...state.messages.values()]
    .filter((message) => !message.isDeleted && message.status !== "deleted")
    .sort(
      (left, right) => left.createdSeq - right.createdSeq || left.messageId.localeCompare(right.messageId),
    );
}

function applyEffect(
  effect: ConversationEffect,
  seq: number,
  conversationId: string,
  messages: Map<string, ConversationMessage>,
  runs: Map<string, ConversationRun>,
  agents: Map<string, ConversationAgent>,
  todos: Map<string, ConversationTodo>,
  tools: Map<string, ConversationToolCall>,
  details: Map<string, ConversationDetailItem>,
  onHistoryInvalidation: (revision: number) => void,
): void {
  switch (effect.type) {
    case "message.create": {
      validateMessage(effect.message, conversationId, seq, "message effect");
      const existing = messages.get(effect.message.messageId);
      if (existing) {
        if (existing.conversationId !== conversationId) {
          throw new Error(
            `Conversation V2 renderer message ${effect.message.messageId} changed conversations.`,
          );
        }
        assertMessageIdentity(existing, effect.message);
        if (existing.versionSeq > effect.message.versionSeq) return;
        if (existing.versionSeq === effect.message.versionSeq && sameMessage(existing, effect.message))
          return;
        throw new Error(
          `Conversation V2 renderer message ${effect.message.messageId} has conflicting identity.`,
        );
      }
      messages.set(effect.message.messageId, effect.message);
      return;
    }
    case "message.append": {
      validateMessageAppend(effect, seq);
      const message = requireMessage(messages, effect.messageId, conversationId);
      if (effect.versionSeq > seq || message.versionSeq >= effect.versionSeq) return;
      if (isTerminalMessage(message)) return;
      if (message.contentVersion !== effect.baseContentVersion) {
        throw new Error(`Conversation V2 renderer message ${effect.messageId} content version mismatch.`);
      }
      if (effect.nextContentVersion !== effect.baseContentVersion + 1) {
        throw new Error(`Conversation V2 renderer message ${effect.messageId} content version is invalid.`);
      }
      messages.set(effect.messageId, {
        ...message,
        body: message.body + effect.delta,
        contentVersion: effect.nextContentVersion,
        versionSeq: effect.versionSeq,
        status:
          message.status === "final" || message.status === "failed" || message.status === "cancelled"
            ? message.status
            : "streaming",
      });
      return;
    }
    case "message.replace": {
      validateMessageReplace(effect, seq);
      const message = requireMessage(messages, effect.messageId, conversationId);
      if (effect.versionSeq > seq || message.versionSeq >= effect.versionSeq) return;
      if (isTerminalMessage(message)) return;
      if (message.contentVersion !== effect.baseContentVersion) {
        throw new Error(`Conversation V2 renderer message ${effect.messageId} content version mismatch.`);
      }
      if (effect.nextContentVersion <= effect.baseContentVersion) {
        throw new Error(`Conversation V2 renderer message ${effect.messageId} content version is invalid.`);
      }
      messages.set(effect.messageId, {
        ...message,
        body: effect.body,
        contentVersion: effect.nextContentVersion,
        versionSeq: effect.versionSeq,
        ...(effect.attachments === undefined ? {} : { attachments: effect.attachments }),
      });
      return;
    }
    case "message.finalize": {
      validateMessageFinalize(effect, seq);
      const message = requireMessage(messages, effect.messageId, conversationId);
      if (effect.versionSeq > seq || message.versionSeq >= effect.versionSeq) return;
      if (isTerminalMessage(message)) return;
      if (effect.contentVersion < message.contentVersion) {
        throw new Error(`Conversation V2 renderer message ${effect.messageId} content version regressed.`);
      }
      messages.set(effect.messageId, {
        ...message,
        contentVersion: effect.contentVersion,
        versionSeq: effect.versionSeq,
        status: effect.status,
        ...(effect.occurredAt !== undefined ? { occurredAt: effect.occurredAt } : {}),
        ...(effect.attachments === undefined ? {} : { attachments: effect.attachments }),
      });
      return;
    }
    case "message.tombstone": {
      if (!Number.isSafeInteger(effect.versionSeq) || effect.versionSeq < 1 || effect.versionSeq > seq) {
        throw new Error("Conversation V2 renderer tombstone metadata is invalid.");
      }
      const message = requireMessage(messages, effect.messageId, conversationId);
      if (effect.versionSeq > seq || message.versionSeq >= effect.versionSeq) return;
      messages.set(effect.messageId, {
        ...message,
        versionSeq: effect.versionSeq,
        status: "deleted",
        isDeleted: true,
      });
      return;
    }
    case "message.history_target": {
      validateMessageHistoryTarget(effect, seq);
      const message = requireMessage(messages, effect.messageId, conversationId);
      if (message.role !== "user") {
        throw new Error("Conversation V2 message history target must belong to a user message.");
      }
      if (
        message.historyTarget !== undefined &&
        historyTargetChanged(message.historyTarget, effect.historyTarget)
      ) {
        throw new Error(`Conversation V2 message ${effect.messageId} history identity changed.`);
      }
      if (effect.versionSeq > seq || message.versionSeq >= effect.versionSeq) return;
      messages.set(effect.messageId, {
        ...message,
        historyTarget: effect.historyTarget,
        versionSeq: effect.versionSeq,
      });
      return;
    }
    case "run.upsert": {
      validateRun(effect.run, conversationId, seq, "run effect");
      const existing = runs.get(effect.run.runId);
      if (existing && existing.conversationId !== conversationId) {
        throw new Error(`Conversation V2 renderer run ${effect.run.runId} changed conversations.`);
      }
      if (existing && existing.turnId !== effect.run.turnId) {
        throw new Error(`Conversation V2 renderer run ${effect.run.runId} changed turns.`);
      }
      assertStableOptional(
        `run ${effect.run.runId} retry lineage`,
        existing?.retryOfRunId,
        effect.run.retryOfRunId,
      );
      assertStableOptional(
        `run ${effect.run.runId} regeneration lineage`,
        existing?.regenerationOfRunId,
        effect.run.regenerationOfRunId,
      );
      if (existing && existing.versionSeq > effect.run.versionSeq) return;
      if (existing && existing.versionSeq === effect.run.versionSeq) {
        if (sameRun(existing, effect.run)) return;
        throw new Error(`Conversation V2 renderer run ${effect.run.runId} has a conflicting version.`);
      }
      if (existing && isTerminalRun(existing.status)) {
        if (isTerminalRun(effect.run.status) && existing.status !== effect.run.status) {
          throw new Error(
            `Conversation V2 renderer run ${effect.run.runId} has conflicting terminal statuses.`,
          );
        }
        if (!isTerminalRun(effect.run.status)) return;
        runs.set(effect.run.runId, { ...effect.run, status: existing.status });
        return;
      }
      runs.set(effect.run.runId, effect.run);
      return;
    }
    case "agent.upsert": {
      const agent = effect.agent;
      validateAgent(agent, conversationId, seq);
      const existing = agents.get(agent.agentId);
      if (existing) {
        if (existing.role !== agent.role || existing.kind !== agent.kind) {
          throw new Error(`Conversation V2 renderer agent ${agent.agentId} changed role or kind.`);
        }
        assertStableOptional(`agent ${agent.agentId} run`, existing.runId, agent.runId);
        assertStableOptional(
          `agent ${agent.agentId} parent`,
          existing.parentAgentInstanceId,
          agent.parentAgentInstanceId,
        );
        assertStableOptional(
          `agent ${agent.agentId} parent tool`,
          existing.parentToolCallId,
          agent.parentToolCallId,
        );
        if (agent.versionSeq < existing.versionSeq)
          throw new Error("Conversation V2 renderer agent version regressed.");
        if (agent.versionSeq === existing.versionSeq && stableJson(agent) !== stableJson(existing)) {
          throw new Error("Conversation V2 renderer agent conflicts at the same version.");
        }
      }
      agents.set(agent.agentId, agent);
      return;
    }
    case "todo.list.replace": {
      const todoIds = new Set<string>();
      const todoPositions = new Set<number>();
      for (const todo of effect.todos) {
        validateTodo(todo, conversationId, seq, "todo effect");
        if (!todoIds.add(todo.todoId) || !todoPositions.add(todo.position)) {
          throw new Error(`Conversation V2 renderer todo ${todo.todoId} is duplicated.`);
        }
      }
      todos.clear();
      for (const todo of effect.todos) {
        todos.set(todo.todoId, todo);
      }
      return;
    }
    case "tool.summary.upsert": {
      validateTool(effect.toolCall, conversationId, seq, "tool effect");
      const existing = tools.get(effect.toolCall.toolCallId);
      if (existing && existing.conversationId !== conversationId) {
        throw new Error(`Conversation V2 renderer tool ${effect.toolCall.toolCallId} changed conversations.`);
      }
      if (existing && existing.runId !== effect.toolCall.runId) {
        throw new Error(`Conversation V2 renderer tool ${effect.toolCall.toolCallId} changed runs.`);
      }
      if (existing && existing.createdSeq !== effect.toolCall.createdSeq) {
        throw new Error(`Conversation V2 renderer tool ${effect.toolCall.toolCallId} changed position.`);
      }
      const toolName = existing ? chooseToolName(existing.name, effect.toolCall.name) : effect.toolCall.name;
      if (existing && toolName !== effect.toolCall.name) {
        throw new Error(`Conversation V2 renderer tool ${effect.toolCall.toolCallId} changed names.`);
      }
      assertStableOptional(
        `tool ${effect.toolCall.toolCallId} agent ownership`,
        existing?.agentId,
        effect.toolCall.agentId,
      );
      assertStableOptional(
        `tool ${effect.toolCall.toolCallId} agent instance ownership`,
        existing?.agentInstanceId,
        effect.toolCall.agentInstanceId,
      );
      assertStableOptional(
        `tool ${effect.toolCall.toolCallId} parent agent ownership`,
        existing?.parentAgentInstanceId,
        effect.toolCall.parentAgentInstanceId,
      );
      assertStableOptional(
        `tool ${effect.toolCall.toolCallId} parent tool ownership`,
        existing?.parentToolCallId,
        effect.toolCall.parentToolCallId,
      );
      if (existing && existing.versionSeq > effect.toolCall.versionSeq) return;
      if (existing && existing.versionSeq === effect.toolCall.versionSeq) {
        if (sameTool(existing, effect.toolCall)) return;
        throw new Error(
          `Conversation V2 renderer tool ${effect.toolCall.toolCallId} has a conflicting version.`,
        );
      }
      if (existing && isTerminalTool(existing.status)) {
        if (isTerminalTool(effect.toolCall.status) && existing.status !== effect.toolCall.status) {
          throw new Error(
            `Conversation V2 renderer tool ${effect.toolCall.toolCallId} has conflicting terminal statuses.`,
          );
        }
        if (!isTerminalTool(effect.toolCall.status)) return;
        tools.set(effect.toolCall.toolCallId, {
          ...effect.toolCall,
          ...(toolName !== effect.toolCall.name ? { name: toolName } : {}),
          status: existing.status,
        });
        return;
      }
      tools.set(
        effect.toolCall.toolCallId,
        toolName === effect.toolCall.name ? effect.toolCall : { ...effect.toolCall, name: toolName },
      );
      return;
    }
    case "detail.upsert": {
      validateDetail(effect.detail, conversationId, seq, "detail effect");
      const existing = details.get(effect.detail.itemId);
      if (existing && existing.conversationId !== conversationId) {
        throw new Error(`Conversation V2 renderer detail ${effect.detail.itemId} changed conversations.`);
      }
      if (existing && existing.runId !== effect.detail.runId) {
        throw new Error(`Conversation V2 renderer detail ${effect.detail.itemId} changed runs.`);
      }
      if (existing && existing.createdSeq !== effect.detail.createdSeq) {
        throw new Error(`Conversation V2 renderer detail ${effect.detail.itemId} changed position.`);
      }
      assertStableOptional(
        `detail ${effect.detail.itemId} agent ownership`,
        existing?.agentId,
        effect.detail.agentId,
      );
      assertStableOptional(
        `detail ${effect.detail.itemId} agent instance ownership`,
        existing?.agentInstanceId,
        effect.detail.agentInstanceId,
      );
      assertStableOptional(
        `detail ${effect.detail.itemId} parent agent instance ownership`,
        existing?.parentAgentInstanceId,
        effect.detail.parentAgentInstanceId,
      );
      assertStableOptional(
        `detail ${effect.detail.itemId} parent agent ownership`,
        existing?.parentAgentId,
        effect.detail.parentAgentId,
      );
      assertStableOptional(
        `detail ${effect.detail.itemId} parent tool ownership`,
        existing?.parentToolCallId,
        effect.detail.parentToolCallId,
      );
      assertStableOptional(
        `detail ${effect.detail.itemId} tool ownership`,
        existing?.toolCallId,
        effect.detail.toolCallId,
      );
      if (existing && existing.type !== effect.detail.type) {
        throw new Error(`Conversation V2 renderer detail ${effect.detail.itemId} changed type.`);
      }
      if (existing && existing.versionSeq > effect.detail.versionSeq) return;
      if (existing && existing.versionSeq === effect.detail.versionSeq) {
        if (sameDetail(existing, effect.detail)) return;
        throw new Error(`Conversation V2 renderer detail ${effect.detail.itemId} has a conflicting version.`);
      }
      details.set(effect.detail.itemId, effect.detail);
      return;
    }
    case "detail.invalidation":
      return;
    case "history.invalidation":
      onHistoryInvalidation(effect.historyRevision);
      return;
    case "noop":
      return;
    default:
      throw new Error(
        `Unsupported Conversation V2 renderer effect: ${String((effect as unknown as { type?: unknown }).type)}.`,
      );
  }
}

function validateMessage(
  message: ConversationMessage,
  conversationId: string,
  maxSeq: number,
  label: string,
): void {
  if (
    !message.messageId.trim() ||
    !message.turnId.trim() ||
    message.conversationId !== conversationId ||
    !Number.isSafeInteger(message.createdSeq) ||
    message.createdSeq < 1 ||
    message.createdSeq > maxSeq ||
    !Number.isSafeInteger(message.versionSeq) ||
    message.versionSeq < message.createdSeq ||
    message.versionSeq > maxSeq ||
    !Number.isSafeInteger(message.contentVersion) ||
    message.contentVersion < 0 ||
    !MESSAGE_ROLES.has(message.role) ||
    !MESSAGE_CHANNELS.has(message.channel) ||
    !MESSAGE_STATUSES.has(message.status) ||
    typeof message.body !== "string" ||
    (message.origin !== undefined && (message.role !== "user" || !isConversationMessageOrigin(message.origin))) ||
    (message.attachments !== undefined && !Array.isArray(message.attachments)) ||
    typeof message.isDeleted !== "boolean" ||
    message.isDeleted !== (message.status === "deleted") ||
    !validOptionalId(message.runId) ||
    (message.historyTarget !== undefined && !validHistoryTarget(message.historyTarget))
  ) {
    throw new Error(`Conversation V2 renderer ${label} is invalid.`);
  }
}

function validateAgent(agent: ConversationAgent, conversationId: string, maxSeq: number): void {
  if (
    !agent.agentId.trim() ||
    agent.conversationId !== conversationId ||
    !agent.role.trim() ||
    !agent.kind.trim() ||
    !agent.status.trim() ||
    !Number.isSafeInteger(agent.versionSeq) ||
    agent.versionSeq < 1 ||
    agent.versionSeq > maxSeq ||
    !validOptionalId(agent.runId) ||
    !validOptionalId(agent.parentAgentInstanceId) ||
    !validOptionalId(agent.parentToolCallId) ||
    agent.agentId === agent.parentAgentInstanceId
  ) {
    throw new Error("Conversation V2 renderer agent is invalid.");
  }
}

function validateTodo(todo: ConversationTodo, conversationId: string, maxSeq: number, label: string): void {
  if (
    !todo.todoId.trim() ||
    todo.conversationId !== conversationId ||
    typeof todo.title !== "string" ||
    typeof todo.detail !== "string" ||
    !TODO_STATUSES.has(todo.status) ||
    !Number.isSafeInteger(todo.position) ||
    todo.position < 0 ||
    typeof todo.updatedAt !== "string" ||
    !todo.updatedAt.trim() ||
    !Number.isSafeInteger(todo.versionSeq) ||
    todo.versionSeq < 1 ||
    todo.versionSeq > maxSeq
  ) {
    throw new Error(`Conversation V2 renderer ${label} is invalid.`);
  }
}

function validateRun(run: ConversationRun, conversationId: string, maxSeq: number, label: string): void {
  if (
    !run.runId.trim() ||
    !run.turnId.trim() ||
    run.conversationId !== conversationId ||
    !Number.isSafeInteger(run.versionSeq) ||
    run.versionSeq < 1 ||
    run.versionSeq > maxSeq ||
    !RUN_STATUSES.has(run.status) ||
    !TIMING_QUALITIES.has(run.timingQuality) ||
    !validOptionalId(run.retryOfRunId) ||
    !validOptionalId(run.regenerationOfRunId) ||
    run.retryOfRunId === run.runId ||
    run.regenerationOfRunId === run.runId
  ) {
    throw new Error(`Conversation V2 renderer ${label} is invalid.`);
  }
}

function validateTool(
  tool: ConversationToolCall,
  conversationId: string,
  maxSeq: number,
  label: string,
): void {
  if (
    !tool.toolCallId.trim() ||
    !tool.runId.trim() ||
    !tool.name.trim() ||
    tool.conversationId !== conversationId ||
    !Number.isSafeInteger(tool.createdSeq) ||
    tool.createdSeq < 1 ||
    tool.createdSeq > maxSeq ||
    !Number.isSafeInteger(tool.versionSeq) ||
    tool.versionSeq < tool.createdSeq ||
    tool.versionSeq > maxSeq ||
    !TOOL_STATUSES.has(tool.status) ||
    !validOptionalId(tool.agentId) ||
    !validOptionalId(tool.agentInstanceId) ||
    !validOptionalId(tool.parentAgentInstanceId) ||
    !validOptionalId(tool.parentToolCallId)
  ) {
    throw new Error(`Conversation V2 renderer ${label} is invalid.`);
  }
}

function validateDetail(
  detail: ConversationDetailItem,
  conversationId: string,
  maxSeq: number,
  label: string,
): void {
  if (
    !detail.itemId.trim() ||
    !detail.runId.trim() ||
    !detail.type.trim() ||
    detail.conversationId !== conversationId ||
    !Number.isSafeInteger(detail.createdSeq) ||
    detail.createdSeq < 1 ||
    detail.createdSeq > maxSeq ||
    !Number.isSafeInteger(detail.versionSeq) ||
    detail.versionSeq < detail.createdSeq ||
    detail.versionSeq > maxSeq ||
    !validOptionalId(detail.agentId) ||
    !validOptionalId(detail.agentInstanceId) ||
    !validOptionalId(detail.parentAgentInstanceId) ||
    !validOptionalId(detail.parentAgentId) ||
    !validOptionalId(detail.parentToolCallId) ||
    !validOptionalId(detail.toolCallId) ||
    (detail.content !== undefined && typeof detail.content !== "string") ||
    (detail.ref !== undefined && typeof detail.ref !== "string")
  ) {
    throw new Error(`Conversation V2 renderer ${label} is invalid.`);
  }
}

function validateMessageAppend(
  effect: Extract<ConversationEffect, { type: "message.append" }>,
  seq: number,
): void {
  if (
    !effect.messageId.trim() ||
    !Number.isSafeInteger(effect.baseContentVersion) ||
    effect.baseContentVersion < 0 ||
    !Number.isSafeInteger(effect.nextContentVersion) ||
    effect.nextContentVersion !== effect.baseContentVersion + 1 ||
    typeof effect.delta !== "string" ||
    !Number.isSafeInteger(effect.versionSeq) ||
    effect.versionSeq < 1 ||
    effect.versionSeq > seq
  ) {
    throw new Error("Conversation V2 renderer message append metadata is invalid.");
  }
}

function validateMessageReplace(
  effect: Extract<ConversationEffect, { type: "message.replace" }>,
  seq: number,
): void {
  if (
    !effect.messageId.trim() ||
    !Number.isSafeInteger(effect.baseContentVersion) ||
    effect.baseContentVersion < 0 ||
    !Number.isSafeInteger(effect.nextContentVersion) ||
    effect.nextContentVersion <= effect.baseContentVersion ||
    typeof effect.body !== "string" ||
    (effect.attachments !== undefined && !Array.isArray(effect.attachments)) ||
    !Number.isSafeInteger(effect.versionSeq) ||
    effect.versionSeq < 1 ||
    effect.versionSeq > seq
  ) {
    throw new Error("Conversation V2 renderer message replace metadata is invalid.");
  }
}

function validateMessageFinalize(
  effect: Extract<ConversationEffect, { type: "message.finalize" }>,
  seq: number,
): void {
  if (
    !effect.messageId.trim() ||
    !Number.isSafeInteger(effect.contentVersion) ||
    effect.contentVersion < 0 ||
    !MESSAGE_FINAL_STATUSES.has(effect.status) ||
    (effect.attachments !== undefined && !Array.isArray(effect.attachments)) ||
    (effect.occurredAt !== undefined && typeof effect.occurredAt !== "string") ||
    !Number.isSafeInteger(effect.versionSeq) ||
    effect.versionSeq < 1 ||
    effect.versionSeq > seq
  ) {
    throw new Error("Conversation V2 renderer message finalize metadata is invalid.");
  }
}

function validateMessageHistoryTarget(
  effect: Extract<ConversationEffect, { type: "message.history_target" }>,
  seq: number,
): void {
  if (
    !effect.messageId.trim() ||
    !validHistoryTarget(effect.historyTarget) ||
    !Number.isSafeInteger(effect.versionSeq) ||
    effect.versionSeq < 1 ||
    effect.versionSeq > seq
  ) {
    throw new Error("Conversation V2 renderer message history target metadata is invalid.");
  }
}

function validHistoryTarget(target: ConversationMessageHistoryTarget): boolean {
  return (
    Boolean(target) &&
    typeof target.activityLineId === "string" &&
    target.activityLineId.trim().length > 0 &&
    (target.userMessageId === undefined ||
      (typeof target.userMessageId === "string" && target.userMessageId.trim().length > 0))
  );
}

function historyTargetChanged(
  existing: ConversationMessageHistoryTarget,
  incoming: ConversationMessageHistoryTarget,
): boolean {
  return (
    existing.activityLineId !== incoming.activityLineId ||
    (existing.userMessageId !== undefined &&
      incoming.userMessageId !== undefined &&
      existing.userMessageId !== incoming.userMessageId)
  );
}

function assertMessageIdentity(left: ConversationMessage, right: ConversationMessage): void {
  if (
    left.messageId !== right.messageId ||
    left.conversationId !== right.conversationId ||
    left.turnId !== right.turnId ||
    left.runId !== right.runId ||
    left.role !== right.role ||
    left.channel !== right.channel ||
    left.createdSeq !== right.createdSeq ||
    stableJson(left.origin) !== stableJson(right.origin)
  ) {
    throw new Error(`Conversation V2 renderer message ${right.messageId} changed immutable identity.`);
  }
}

function assertStableOptional(
  label: string,
  existing: string | undefined,
  incoming: string | undefined,
): void {
  if (existing !== undefined && incoming !== undefined && existing !== incoming) {
    throw new Error(`Conversation V2 renderer ${label} changed.`);
  }
}

function validOptionalId(value: string | undefined): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length > 0);
}

const MESSAGE_ROLES = new Set<ConversationMessage["role"]>(["user", "assistant", "system", "tool"]);
const MESSAGE_CHANNELS = new Set<ConversationMessage["channel"]>([
  "answer",
  "commentary",
  "thinking",
  "system",
  "tool",
]);
const MESSAGE_STATUSES = new Set<ConversationMessage["status"]>([
  "queued",
  "streaming",
  "final",
  "failed",
  "cancelled",
  "deleted",
]);
const MESSAGE_FINAL_STATUSES = new Set<
  Extract<ConversationMessage["status"], "final" | "failed" | "cancelled">
>(["final", "failed", "cancelled"]);
const RUN_STATUSES = new Set<ConversationRun["status"]>([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);
const TIMING_QUALITIES = new Set<ConversationRun["timingQuality"]>(["recorded", "unknown", "estimated"]);
const TODO_STATUSES = new Set<ConversationTodo["status"]>([
  "pending",
  "running",
  "completed",
  "blocked",
  "cancelled",
]);
const TOOL_STATUSES = new Set<ConversationToolCall["status"]>([
  "started",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

function isTerminalMessage(message: ConversationMessage): boolean {
  return (
    message.isDeleted ||
    message.status === "final" ||
    message.status === "failed" ||
    message.status === "cancelled" ||
    message.status === "deleted"
  );
}

function isTerminalRun(status: ConversationRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function isTerminalTool(status: ConversationToolCall["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function sameMessage(left: ConversationMessage, right: ConversationMessage): boolean {
  return (
    left.messageId === right.messageId &&
    left.conversationId === right.conversationId &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.role === right.role &&
    left.channel === right.channel &&
    left.createdSeq === right.createdSeq &&
    left.versionSeq === right.versionSeq &&
    left.contentVersion === right.contentVersion &&
    left.body === right.body &&
    stableJson(left.origin) === stableJson(right.origin) &&
    stableJson(left.attachments) === stableJson(right.attachments) &&
    left.status === right.status &&
    left.isDeleted === right.isDeleted
  );
}

function sameRun(left: ConversationRun, right: ConversationRun): boolean {
  return (
    left.runId === right.runId &&
    left.conversationId === right.conversationId &&
    left.turnId === right.turnId &&
    left.status === right.status &&
    left.versionSeq === right.versionSeq &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.timingQuality === right.timingQuality &&
    left.retryOfRunId === right.retryOfRunId &&
    left.regenerationOfRunId === right.regenerationOfRunId
  );
}

function sameTool(left: ConversationToolCall, right: ConversationToolCall): boolean {
  // Bootstrap and tool pages carry bounded summaries, while sync effects carry the
  // full payload. Compare the same read-side projection at an equal version.
  const leftSummary = limitConversationToolSummaryPayload(left);
  const rightSummary = limitConversationToolSummaryPayload(right);
  return (
    left.toolCallId === right.toolCallId &&
    left.conversationId === right.conversationId &&
    left.runId === right.runId &&
    left.agentId === right.agentId &&
    left.agentInstanceId === right.agentInstanceId &&
    left.parentAgentInstanceId === right.parentAgentInstanceId &&
    left.parentToolCallId === right.parentToolCallId &&
    left.name === right.name &&
    left.status === right.status &&
    left.createdSeq === right.createdSeq &&
    left.versionSeq === right.versionSeq &&
    stableJson(leftSummary.input) === stableJson(rightSummary.input) &&
    stableJson(leftSummary.output) === stableJson(rightSummary.output)
  );
}

function sameDetail(left: ConversationDetailItem, right: ConversationDetailItem): boolean {
  return (
    left.itemId === right.itemId &&
    left.conversationId === right.conversationId &&
    left.runId === right.runId &&
    left.agentId === right.agentId &&
    left.agentInstanceId === right.agentInstanceId &&
    left.parentAgentInstanceId === right.parentAgentInstanceId &&
    left.parentAgentId === right.parentAgentId &&
    left.parentToolCallId === right.parentToolCallId &&
    left.toolCallId === right.toolCallId &&
    left.type === right.type &&
    left.createdSeq === right.createdSeq &&
    left.versionSeq === right.versionSeq &&
    left.content === right.content &&
    left.ref === right.ref
  );
}

function requireMessage(
  messages: ReadonlyMap<string, ConversationMessage>,
  messageId: string,
  conversationId: string,
): ConversationMessage {
  const message = messages.get(messageId);
  if (!message) {
    throw new Error(`Conversation V2 renderer message ${messageId} is missing.`);
  }
  if (message.conversationId !== conversationId) {
    throw new Error(`Conversation V2 renderer message ${messageId} changed conversations.`);
  }
  return message;
}
