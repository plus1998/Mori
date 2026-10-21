import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CodexEventAdapter,
  type CodexEventAdapterOptions,
  type CodexSpawnPayload,
  type CodexSpawnPayloadMatchInput,
  type CodexThreadAttribution,
  type CodexThreadAttributionRecord,
  type CodexThreadRunEventInput,
  type CodexTurnPlanUpdatedInput,
  resolveDefaultCodexThreadAttribution,
} from "@eco/runtime";
import {
  applyCodexSubagentLifecycleEvent,
  type CodexSubagentLifecycleServices,
} from "../main/codex-subagent-lifecycle";
import { normalizeCodexThreadRunEventForProjection } from "../main/codex-thread-run-event-normalizer";
import { createConversationStore } from "../main/conversation-store";
import {
  createThreadFeedSkeletonRecord,
  FEED_SKELETON_TERMINAL_EVENT_TYPES,
  feedSkeletonTimelineIds,
  patchThreadFeedSkeletonFromEvent,
  shouldPatchAgentTimelineForFeedSkeleton,
} from "../main/legacy-feed-skeleton-patch";
import {
  mapRunAttemptsForFeedSkeleton,
  type ThreadFeedSkeletonRecord,
} from "../main/legacy-feed-skeleton-store";
import { isFeedMainTimelineEvent } from "../main/legacy-feed-skeleton-timeline-items";
import { isMetricsOnlyThreadRunEvent } from "../main/thread-run-event-normalizer";
import { buildThreadRunProjection } from "../main/conversation-v2-runtime-projection";
import { trimProjectionForFeed } from "../main/legacy-feed-replay-projection";
import type { AgentInstanceRecord } from "../main/usage-ledger";
import type { RuntimeAgentRole, ThreadRunEvent, ThreadRunEventInput, ThreadSummary } from "../shared/ipc";
import type { ThreadRunProjectionAgent, ThreadRunProjectionAttempt } from "../shared/conversation-v2-projection";
import type { ConversationRoundFixture, RpcLogEntry } from "./conversation-round-fixture";
import { evaluateFixtureScenarioChecklist, loadConversationRoundFixture } from "./conversation-round-fixture";

export const CONVERSATION_ROUND_ECO_THREAD_ID = "thr_conversation_round";

const RUN_ATTEMPT_TERMINAL_EVENT_TYPES = FEED_SKELETON_TERMINAL_EVENT_TYPES;

export interface ConversationRoundReplayResult {
  fixture: ConversationRoundFixture;
  scenarioChecklist: ReturnType<typeof evaluateFixtureScenarioChecklist>;
  codexThreadId: string;
  replayedEvents: CodexThreadRunEventInput[];
  persistedEvents: ThreadRunEvent[];
  attempts: ThreadRunProjectionAttempt[];
  agents: AgentInstanceRecord[];
  feedTimelineIds: string[];
  referenceFeedTimelineIds: string[];
  tokenUsageUpdates: number;
  turnPlanUpdates: number;
  scenarioSignals: ScenarioEventSignals;
}

export interface ScenarioEventSignals {
  userPrompts: number;
  assistantFinals: number;
  mcpTools: number;
  fileCommands: number;
  subagentStarts: number;
  subagentStops: number;
  markerInFinal: boolean;
  skillMentioned: boolean;
}

export interface ReplayConversationRoundOptions {
  fixtureDir?: string;
  fixture?: ConversationRoundFixture;
  ecoThreadId?: string;
}

export async function replayConversationRound(
  options: ReplayConversationRoundOptions = {},
): Promise<ConversationRoundReplayResult> {
  const loaded = options.fixture ?? loadConversationRoundFixture(options.fixtureDir);
  const ecoThreadId = options.ecoThreadId ?? CONVERSATION_ROUND_ECO_THREAD_ID;
  const scenarioChecklist = evaluateFixtureScenarioChecklist(loaded);

  const codexContext = buildCodexThreadContext(loaded.rpcLog);
  if (!codexContext.mainCodexThreadId) {
    throw new Error("Fixture rpc-log is missing thread/start main codex thread id");
  }

  const spawnPayloads = buildSpawnPayloadQueue(loaded.rpcLog);
  let tokenUsageUpdates = 0;
  let turnPlanUpdates = 0;

  const replayedEvents = replayCodexNotificationsFromRpcLog(loaded.rpcLog, {
    ...buildCodexReplayAdapterOptions(codexContext, ecoThreadId, spawnPayloads),
    onTokenUsageUpdated: () => {
      tokenUsageUpdates += 1;
    },
    onTurnPlanUpdated: (_input: CodexTurnPlanUpdatedInput) => {
      turnPlanUpdates += 1;
    },
  });

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "eco-conversation-round-"));
  const dbPath = path.join(tempDir, "eco-coding.sqlite");
  // Feed replay is a V2 writer fixture. Its local skeleton is an in-memory
  // comparison artifact and must not cause the temporary database to create or
  // use the retired V1 conversation tables.
  const store = await createConversationStore(dbPath, {
    freshStorageMode: "v2_only",
    requiredStorageMode: "v2_only",
  });

  const thread: ThreadSummary = {
    id: ecoThreadId,
    title: "Conversation round replay",
    prompt: loaded.prompt.split("\n")[0] ?? loaded.marker,
    workspacePath: "/tmp/conversation-round",
    status: "idle",
    message: "ok",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  store.saveThread(thread);

  const persistedEvents: ThreadRunEvent[] = [];
  const replayRunIds = new Set<string>();
  let skeletonRecord: ThreadFeedSkeletonRecord | undefined;
  let lifecycleObservedAt = replayedEvents[0]?.observedAt ?? "1970-01-01T00:00:00.000Z";
  const subagentLifecycle = createReplayCodexSubagentLifecycle(store, () => lifecycleObservedAt);

  for (const rawEvent of replayedEvents) {
    lifecycleObservedAt = rawEvent.observedAt;
    const normalized = normalizeCodexThreadRunEventForProjection(rawEvent);
    const threadId = normalized.threadId?.trim() || ecoThreadId;
    // Replays exercise the same native V2 provider boundary as live SDK events.
    // The legacy appendThreadRunEvent bridge is intentionally reserved for
    // migration/compatibility tests and must not be used by production helpers.
    const runtimeRunAttemptId = normalized.runAttemptId?.trim() || replayRunAttemptId(normalized, threadId);
    const runtimeEvent = runtimeRunAttemptId
      ? { ...normalized, threadId, runAttemptId: runtimeRunAttemptId }
      : { ...normalized, threadId };
    if (runtimeRunAttemptId && !replayRunIds.has(runtimeRunAttemptId)) {
      replayRunIds.add(runtimeRunAttemptId);
      store.upsertRunAttempt({
        threadId,
        attemptId: runtimeRunAttemptId,
        phase: "execution",
        retryIndex: 0,
        status: "running",
        startedAt: normalized.observedAt,
      });
    }
    store.appendConversationRuntimeEvent(runtimeEvent);
    // The writer returns the provider envelope with the receipt sequence. Feed
    // projection/replay must consume the canonical V2 source-index row instead,
    // because that is the sequence and body that a restarted reader will see.
    const persisted: ThreadRunEvent =
      store.listConversationRuntimeSources(threadId).find((candidate) => candidate.id === runtimeEvent.id) ??
      ({ ...runtimeEvent, sequence: runtimeEvent.sequence ?? persistedEvents.length + 1 } as ThreadRunEvent);
    if (runtimeRunAttemptId && isTerminalReplayRunEvent(normalized.eventType)) {
      store.upsertRunAttempt({
        threadId,
        attemptId: runtimeRunAttemptId,
        phase: "execution",
        retryIndex: 0,
        status: replayRunStatus(normalized.eventType),
        startedAt: normalized.observedAt,
        endedAt: normalized.observedAt,
      });
    }
    applyCodexSubagentLifecycleEvent(persisted, subagentLifecycle);
    persistedEvents.push(persisted);
    skeletonRecord = maintainSkeletonRecord(store, skeletonRecord, persisted, ecoThreadId);
  }

  const runAttempts = store.listRunAttempts(ecoThreadId);
  const attempts = mapRunAttemptsForFeedSkeleton(runAttempts);
  const agents = store.listAgentInstances(ecoThreadId);

  const referenceProjection = trimProjectionForFeed(
    buildThreadRunProjection({
      threadId: ecoThreadId,
      status: "idle",
      attempts: runAttempts,
      agents,
      events: persistedEvents,
      historyComplete: true,
    }),
  );
  const referenceFeedTimelineIds = referenceProjection.timeline.map((item) => item.id);
  const feedTimelineIds = skeletonRecord ? feedSkeletonTimelineIds(skeletonRecord.snapshot) : [];

  const scenarioSignals = collectScenarioEventSignals(persistedEvents, loaded.marker);

  try {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }

  return {
    fixture: loaded,
    scenarioChecklist,
    codexThreadId: codexContext.mainCodexThreadId,
    replayedEvents,
    persistedEvents,
    attempts,
    agents,
    feedTimelineIds,
    referenceFeedTimelineIds,
    tokenUsageUpdates,
    turnPlanUpdates,
    scenarioSignals,
  };
}

function replayRunAttemptId(event: ThreadRunEventInput, threadId: string): string | undefined {
  const needsRun =
    event.eventType.startsWith("message.") ||
    event.eventType.startsWith("thinking.") ||
    event.eventType.startsWith("tool.") ||
    event.eventType.startsWith("run.");
  if (!needsRun || event.role === "user") return undefined;
  const request = event.requestId?.trim() || event.streamKey?.trim() || "main";
  return `replay_run_${threadId}_${request}`;
}

function isTerminalReplayRunEvent(eventType: string): boolean {
  return eventType === "run.completed" || eventType === "run.failed" || eventType === "run.cancelled";
}

function replayRunStatus(eventType: string): "completed" | "failed" | "cancelled" {
  if (eventType === "run.failed") return "failed";
  if (eventType === "run.cancelled") return "cancelled";
  return "completed";
}

export function writeConversationRoundExpected(
  fixtureDir: string,
  result: ConversationRoundReplayResult,
): void {
  const expectedDir = path.join(fixtureDir, "expected");
  fs.mkdirSync(expectedDir, { recursive: true });

  fs.writeFileSync(
    path.join(expectedDir, "thread-run-events.json"),
    JSON.stringify(
      result.persistedEvents.map((event) => ({
        id: event.id,
        sequence: event.sequence,
        eventType: event.eventType,
        role: event.role,
        message: event.message,
        streamKey: event.streamKey,
        metadata: event.metadata,
      })),
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(expectedDir, "feed-timeline-ids.json"),
    JSON.stringify(result.feedTimelineIds, null, 2),
  );
  fs.writeFileSync(
    path.join(expectedDir, "scenario-signals.json"),
    JSON.stringify(result.scenarioSignals, null, 2),
  );
  fs.writeFileSync(
    path.join(expectedDir, "scenario-checklist.json"),
    JSON.stringify(result.scenarioChecklist.checklist, null, 2),
  );
}

function buildCodexThreadContext(rpcLog: RpcLogEntry[]) {
  const mainStart = rpcLog.find((entry) => entry.kind === "client_result" && entry.method === "thread/start");
  const mainParams = mainStart?.params as { thread?: { id?: string } } | undefined;
  const mainCodexThreadId = mainParams?.thread?.id?.trim() || "";

  const attribution = new Map<string, CodexThreadAttributionRecord>();
  for (const entry of rpcLog) {
    if (entry.kind !== "notification" || entry.method !== "thread/started") {
      continue;
    }
    const params = entry.params as { thread?: Record<string, unknown> } | undefined;
    const thread = params?.thread;
    if (!thread || typeof thread.id !== "string") {
      continue;
    }
    const parentThreadId = typeof thread.parentThreadId === "string" ? thread.parentThreadId.trim() : "";
    if (!parentThreadId) {
      continue;
    }
    attribution.set(thread.id, {
      parentThreadId,
      agentRole: typeof thread.agentRole === "string" ? thread.agentRole : "smoke_worker",
      ...(typeof thread.agentNickname === "string" ? { agentNickname: thread.agentNickname } : {}),
    });
  }

  return { mainCodexThreadId, attribution };
}

function resolveEcoThreadId(
  codexThreadId: string,
  context: ReturnType<typeof buildCodexThreadContext>,
  ecoThreadId: string,
): string {
  if (codexThreadId === context.mainCodexThreadId) {
    return ecoThreadId;
  }
  const record = context.attribution.get(codexThreadId);
  if (record?.parentThreadId === context.mainCodexThreadId) {
    return `${ecoThreadId}:${codexThreadId}`;
  }
  return codexThreadId;
}

function buildSpawnPayloadQueue(rpcLog: RpcLogEntry[]): Map<string, CodexSpawnPayload> {
  const payloads = new Map<string, CodexSpawnPayload>();
  for (const entry of rpcLog) {
    if (entry.kind !== "notification") {
      continue;
    }
    if (entry.method !== "item/started" && entry.method !== "item/completed") {
      continue;
    }
    const params = entry.params as { item?: Record<string, unknown> } | undefined;
    const item = params?.item;
    if (!item || item.type !== "collabAgentToolCall") {
      continue;
    }
    const tool = typeof item.tool === "string" ? item.tool : "";
    if (tool !== "spawnAgent" || typeof item.id !== "string") {
      continue;
    }
    const agentRole =
      (typeof item.agentType === "string" && item.agentType) ||
      (typeof item.agentRole === "string" && item.agentRole) ||
      "smoke_worker";
    payloads.set(item.id, { agentRole, toolUseId: item.id });
  }
  return payloads;
}

function dequeueSpawnPayload(
  payloads: Map<string, CodexSpawnPayload>,
  input: CodexSpawnPayloadMatchInput,
): CodexSpawnPayload | undefined {
  const toolUseId = input.toolUseId?.trim();
  if (!toolUseId) {
    return undefined;
  }
  const payload = payloads.get(toolUseId);
  if (payload) {
    payloads.delete(toolUseId);
  }
  return payload;
}

function maintainSkeletonRecord(
  store: Awaited<ReturnType<typeof createConversationStore>>,
  existing: ThreadFeedSkeletonRecord | undefined,
  event: ThreadRunEvent,
  threadId: string,
): ThreadFeedSkeletonRecord | undefined {
  if (event.eventType.startsWith("agent.")) {
    // Agent lifecycle is already represented by the V2 agent registry. Keep the
    // current V2 skeleton while the registry changes; the next structural event
    // will patch/rebuild it from the canonical V2 source index. Deleting here
    // would make a replay depend on the tail after the last agent event.
    return existing;
  }

  const runAttempts = store.listRunAttempts(threadId);
  const attempts = mapRunAttemptsForFeedSkeleton(runAttempts);
  const agentRecords = store.listAgentInstances(threadId);
  const maxEventSequence = event.sequence;
  const context: {
    attempts: ThreadRunProjectionAttempt[];
    agents: ThreadRunProjectionAgent[];
    historyRevision: number;
    maxEventSequence: number;
  } = {
    attempts,
    agents: [],
    historyRevision: 0,
    maxEventSequence,
  };

  if (isMetricsOnlyThreadRunEvent(event)) {
    store.touchThreadFeedSkeletonSequence(threadId, maxEventSequence);
    return existing;
  }

  const structureChanging =
    isFeedMainTimelineEvent(event) ||
    shouldPatchAgentTimelineForFeedSkeleton(event) ||
    RUN_ATTEMPT_TERMINAL_EVENT_TYPES.has(event.eventType);

  if (!structureChanging) {
    store.touchThreadFeedSkeletonSequence(threadId, maxEventSequence);
    return existing;
  }

  if (!existing?.patchState) {
    const projection = trimProjectionForFeed(
      buildThreadRunProjection({
        threadId,
        status: "idle",
        attempts: runAttempts,
        agents: agentRecords,
        events: store.listThreadRunEventsForProjection(threadId),
        historyComplete: true,
      }),
    );
    context.agents = projection.agents;
    const record = createThreadFeedSkeletonRecord(projection, context);
    store.saveThreadFeedSkeleton(threadId, {
      historyRevision: record.historyRevision,
      maxEventSequence: record.maxEventSequence,
      snapshot: record.snapshot,
      patchState: record.patchState,
    });
    return record;
  }

  const patched = patchThreadFeedSkeletonFromEvent(existing, event, {
    ...context,
    agents: existing.snapshot.agents,
  });
  if (!patched) {
    store.deleteThreadFeedSkeleton(threadId);
    return undefined;
  }
  store.saveThreadFeedSkeleton(threadId, {
    historyRevision: patched.historyRevision,
    maxEventSequence: patched.maxEventSequence,
    snapshot: patched.snapshot,
    patchState: patched.patchState,
  });
  return patched;
}

function collectScenarioEventSignals(events: ThreadRunEvent[], marker: string): ScenarioEventSignals {
  const joined = events.map((event) => event.message).join("\n");
  return {
    userPrompts: events.filter(
      (event) =>
        event.metadata?.liveType === "thread.user_prompt" || event.metadata?.liveType === "message.user",
    ).length,
    assistantFinals: events.filter((event) => event.eventType === "message.final" && event.role !== "user")
      .length,
    mcpTools: events.filter((event) => {
      const toolName = String((event.metadata?.tool as { name?: string } | undefined)?.name ?? "");
      return (
        /smoke_ping|smoke_echo|mcp__/i.test(toolName) ||
        /mcpToolCall/i.test(String(event.metadata?.codexItemType ?? event.metadata?.itemType ?? ""))
      );
    }).length,
    fileCommands: events.filter((event) => {
      const toolName = String((event.metadata?.tool as { name?: string } | undefined)?.name ?? "");
      const command = String(event.metadata?.command ?? "");
      return toolName === "Bash" || /smoke-note|cat|read|write|echo/i.test(command);
    }).length,
    subagentStarts: events.filter((event) => event.eventType === "agent.started").length,
    subagentStops: events.filter((event) => ["agent.stopped", "agent.abandoned"].includes(event.eventType))
      .length,
    markerInFinal: joined.includes(`SMOKE_DONE:${marker}`) || joined.includes(marker),
    skillMentioned: /SMOKE_SKILL_OK|smoke-skill/i.test(joined),
  };
}

export function replayNotificationsOnly(
  fixture: ConversationRoundFixture,
  ecoThreadId: string,
): CodexThreadRunEventInput[] {
  const codexContext = buildCodexThreadContext(fixture.rpcLog);
  const spawnPayloads = buildSpawnPayloadQueue(fixture.rpcLog);
  return replayCodexNotificationsFromRpcLog(
    fixture.rpcLog,
    buildCodexReplayAdapterOptions(codexContext, ecoThreadId, spawnPayloads),
  );
}

function buildCodexReplayAdapterOptions(
  codexContext: ReturnType<typeof buildCodexThreadContext>,
  ecoThreadId: string,
  spawnPayloads: Map<string, CodexSpawnPayload>,
): Omit<CodexEventAdapterOptions, "now"> {
  return {
    resolveEcoThreadId: (codexThreadId) => resolveEcoThreadId(codexThreadId, codexContext, ecoThreadId),
    resolveThreadAttribution: (codexThreadId) =>
      resolveReplayCodexThreadAttribution(codexThreadId, codexContext, ecoThreadId),
    recordThreadRunEvent: () => {},
    recordThreadAttribution: (codexThreadId, record) => {
      codexContext.attribution.set(codexThreadId, record);
    },
    getThreadAttributionRecord: (codexThreadId) => codexContext.attribution.get(codexThreadId),
    dequeueSpawnPayloadMatching: (input: CodexSpawnPayloadMatchInput) =>
      dequeueSpawnPayload(spawnPayloads, input),
    orchestrationRoleIds: ["smoke_worker"],
  };
}

/** Mirror live `resolveCodexThreadAttribution` using replay attribution map + main thread id. */
function resolveReplayCodexThreadAttribution(
  codexThreadId: string,
  context: ReturnType<typeof buildCodexThreadContext>,
  ecoThreadId: string,
): CodexThreadAttribution | undefined {
  const trimmed = codexThreadId.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === context.mainCodexThreadId) {
    return { ecoThreadId, billingRole: "main" };
  }

  let current = trimmed;
  let leafAgentRole: string | undefined;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const record = context.attribution.get(current);
    const parentCodexThreadId = record?.parentThreadId?.trim();
    if (!parentCodexThreadId || parentCodexThreadId === current) {
      break;
    }
    if (!leafAgentRole && record?.agentRole?.trim()) {
      leafAgentRole = record.agentRole.trim();
    }
    if (parentCodexThreadId === context.mainCodexThreadId) {
      return {
        ...resolveDefaultCodexThreadAttribution({
          codexThreadId: trimmed,
          ecoThreadId,
          parentThreadId: parentCodexThreadId,
          parentEcoThreadId: ecoThreadId,
          agentRole: leafAgentRole,
        }),
        agentId: trimmed,
      };
    }
    current = parentCodexThreadId;
  }
  return undefined;
}

function createReplayCodexSubagentLifecycle(
  store: Awaited<ReturnType<typeof createConversationStore>>,
  observedAt: () => string,
): CodexSubagentLifecycleServices {
  return {
    getAgentState: (threadId, agentId) => {
      const agent = store.listAgentInstances(threadId).find((candidate) => candidate.agentId === agentId);
      return agent
        ? {
            status: agent.status,
            ...(agent.parentToolUseId && { parentToolUseId: agent.parentToolUseId }),
          }
        : undefined;
    },
    resolvePhase: () => "execution",
    startSession: () => {},
    stopSession: () => {},
    startMetrics: () => {},
    stopMetrics: () => {},
    startAgent: (input) => {
      const at = observedAt();
      store.upsertAgentInstance({
        threadId: input.threadId,
        agentId: input.agentId,
        role: input.role,
        kind: "subagent",
        status: "active",
        startedAt: at,
        updatedAt: at,
        ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
      });
    },
    stopAgent: (input) => {
      finishReplaySubagent(store, input, "stopped", observedAt());
    },
    abandonAgent: (input) => {
      finishReplaySubagent(store, input, "abandoned", observedAt());
    },
  };
}

function finishReplaySubagent(
  store: Awaited<ReturnType<typeof createConversationStore>>,
  input: { threadId: string; agentId: string; role: RuntimeAgentRole },
  status: "stopped" | "abandoned",
  endedAt: string,
): void {
  const existing = store.listAgentInstances(input.threadId).find((agent) => agent.agentId === input.agentId);
  if (!existing) {
    return;
  }
  store.upsertAgentInstance({
    ...existing,
    status,
    endedAt,
    updatedAt: endedAt,
  });
}

/** Replay rpc-log notifications with recorded wall-clock timestamps (monotonic fallback). */
export function replayCodexNotificationsFromRpcLog(
  rpcLog: RpcLogEntry[],
  options: Omit<CodexEventAdapterOptions, "now">,
): CodexThreadRunEventInput[] {
  const events: CodexThreadRunEventInput[] = [];
  let observedAt = "1970-01-01T00:00:00.000Z";
  const adapter = new CodexEventAdapter({
    ...options,
    now: () => observedAt,
    recordThreadRunEvent: (event) => {
      events.push(event);
      options.recordThreadRunEvent?.(event);
    },
  });

  for (const entry of normalizeRpcLogEmptyItemIds(rpcLog)) {
    if (entry.kind !== "notification" || typeof entry.method !== "string") {
      continue;
    }
    observedAt = readRpcLogObservedAt(entry.ts, observedAt);
    adapter.dispatch(entry.method, entry.params ?? {});
  }

  adapter.flushAllPendingEvents();
  return events;
}

/**
 * Some longcat / early client-round captures leave tool item ids empty; the adapter
 * requires ids to emit tool.started/completed. Synthesize stable ids for replay only.
 */
export function normalizeRpcLogEmptyItemIds(rpcLog: RpcLogEntry[]): RpcLogEntry[] {
  return rpcLog.map((entry) => {
    if (entry.kind !== "notification") {
      return entry;
    }
    const params = entry.params;
    if (!params || typeof params !== "object" || !("item" in params)) {
      return entry;
    }
    const item = (params as { item?: unknown }).item;
    if (!item || typeof item !== "object") {
      return entry;
    }
    const record = item as Record<string, unknown>;
    const existingId = record.id;
    if (typeof existingId === "string" && existingId.trim()) {
      return entry;
    }
    return {
      ...entry,
      params: {
        ...(params as Record<string, unknown>),
        item: {
          ...record,
          id: synthesizeCodexReplayItemId(entry),
        },
      },
    };
  });
}

function synthesizeCodexReplayItemId(entry: RpcLogEntry): string {
  const params = entry.params as Record<string, unknown> | undefined;
  const item = params?.item as Record<string, unknown> | undefined;
  if (!item) {
    return `replay:seq:${entry.seq ?? 0}`;
  }
  const turnId = String(params?.turnId ?? params?.threadId ?? "");
  const itemType = String(item.type ?? "item");
  const processId = String(item.processId ?? item.process_id ?? "");
  const tool = String(item.tool ?? "");
  const server = String(item.server ?? "");
  const command = String(item.command ?? "").slice(0, 120);
  const fingerprint = [entry.seq ?? 0, turnId, itemType, processId, tool, server, command].join("|");
  let hash = 0;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash = (hash * 31 + fingerprint.charCodeAt(index)) >>> 0;
  }
  return `replay:${itemType}:${hash.toString(16)}`;
}

function readRpcLogObservedAt(ts: string | undefined, previous: string): string {
  if (typeof ts === "string" && ts.trim()) {
    const trimmed = ts.trim();
    if (trimmed.localeCompare(previous) > 0) {
      return trimmed;
    }
  }
  const nextMs = Date.parse(previous) + 1;
  return Number.isFinite(nextMs) ? new Date(nextMs).toISOString() : previous;
}
