import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveAcpHostUiFeatures } from "@eco/runtime/acp-host-ui-features";
import {
  CONVERSATION_V2_EFFECT_VERSION,
  type ConversationDetailItem,
  type ConversationSyncEffect,
  stableHash,
} from "@eco/shared";
import { buildThreadRunProjectionRequestSpans } from "../../src/main/conversation-v2-runtime-projection";
import type { AgentInstanceRecord } from "../../src/main/usage-ledger";
import type { ThreadRunEvent, ThreadSummary } from "../../src/shared/ipc";
import { parseThreadRuntimeConfigJson } from "../../src/shared/thread-runtime-config";
import { upgradeLegacyCursorCore } from "../../src/shared/upgrade-legacy-cursor-core";
import { type FeedReplayEvent, type FeedReplayFixture, replayThreadStatus } from "./types";

interface EventRow {
  seq: number;
  store_epoch: string;
  occurred_at: string;
  type: string;
  message_id: string | null;
  payload_json: string;
  effect_version: number | null;
  effect_hash: string | null;
  effect_json: string | null;
}

function readThread(db: Database, id: string): ThreadSummary {
  const row = db
    .query<Record<string, string | number | null>, [string]>(`
    SELECT threads.*, sessions.external_session_id FROM threads
    LEFT JOIN thread_core_sessions AS sessions ON sessions.thread_id=threads.id WHERE threads.id=?
  `)
    .get(id);
  if (!row) throw new Error(`Thread not found: ${id}`);
  const string = (name: string) => (typeof row[name] === "string" ? (row[name] as string) : undefined);
  const core = upgradeLegacyCursorCore({ coreKind: string("core_kind"), acpAgentId: string("acp_agent_id") });
  const runtimeConfig = parseThreadRuntimeConfigJson(string("runtime_config_json") ?? null);
  return {
    id,
    title: String(row.title),
    prompt: String(row.prompt),
    workspacePath: String(row.workspace_path),
    status: row.status as ThreadSummary["status"],
    message: String(row.message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...core,
    hostUiFeatures: resolveAcpHostUiFeatures(core),
    ...(runtimeConfig ? { runtimeConfig } : {}),
    ...(string("sdk_session_id") ? { sdkSessionId: string("sdk_session_id")! } : {}),
    ...(string("sdk_cwd") ? { sdkCwd: string("sdk_cwd")! } : {}),
    ...(string("external_session_id") ? { externalSessionId: string("external_session_id")! } : {}),
    ...(row.follow_up_queue_paused ? { followUpQueuePaused: true } : {}),
  };
}

const streamTypes = new Set(["message.delta", "thinking.delta", "message.final", "thinking.final"]);

const REPLAY_COVERAGE = [
  "V2 effects are exact; request span changes are rebuilt with the current production projector.",
  "Persisted detail bodies are available only at or after their recorded versionSeq.",
  "UI settings/workspace metadata use the current dev environment, not historical snapshots.",
  "Approval dialogs, follow-up queue operations, billing/context snapshots and media bodies are not fully recorded.",
];
type ReplayMetadata = Omit<FeedReplayFixture, "events" | "detailItems">;
type ReplayRecord =
  | { kind: "header"; value: ReplayMetadata }
  | { kind: "event"; value: FeedReplayEvent }
  | { kind: "detail"; value: ConversationDetailItem };

/** Opens an existing database read-only and holds one consistent read transaction. */
function* readReplayRecords(databasePath: string, conversationId: string): Generator<ReplayRecord> {
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    db.exec("BEGIN");
    const thread = readThread(db, conversationId);
    // LEFT JOIN makes missing sync effects an error instead of silently losing events.
    const rows = db
      .query<EventRow, [string]>(`
      SELECT e.seq,e.store_epoch,e.occurred_at,e.type,e.message_id,e.payload_json,
             s.effect_version,s.effect_hash,s.effect_json
      FROM conversation_events_v2 AS e LEFT JOIN conversation_sync_effects_v2 AS s
      ON s.conversation_id=e.conversation_id AND s.seq=e.seq
      WHERE e.conversation_id=? ORDER BY e.seq
    `)
      .iterate(conversationId);
    let epoch: string | undefined;
    let count = 0;
    let previousSpans = new Map<string, string>();
    const sources = new Map<string, ThreadRunEvent>();
    const messageBodies = new Map<string, string>();
    const agents = new Map<string, AgentInstanceRecord>();
    let status: ThreadSummary["status"] = "idle";
    for (const row of rows) {
      const index = count++;
      if (index === 0) {
        epoch = row.store_epoch;
        yield {
          kind: "header",
          value: {
            formatVersion: 2,
            protocolVersion: 2,
            exportedAt: new Date().toISOString(),
            conversationId,
            storeEpoch: epoch,
            thread,
            coverage: REPLAY_COVERAGE,
          },
        };
      }
      if (
        row.seq !== index + 1 ||
        row.store_epoch !== epoch ||
        !row.effect_json ||
        !row.effect_hash ||
        row.effect_version !== CONVERSATION_V2_EFFECT_VERSION
      ) {
        throw new Error(`Missing/inconsistent V2 event or effect at sequence ${row.seq}.`);
      }
      const at = Date.parse(row.occurred_at);
      if (!Number.isFinite(at)) throw new Error(`Invalid timestamp at sequence ${row.seq}.`);
      const effect = JSON.parse(row.effect_json) as ConversationSyncEffect["effect"];
      if (stableHash(effect) !== row.effect_hash)
        throw new Error(`Effect hash mismatch at sequence ${row.seq}.`);
      if (effect.type === "message.create") {
        messageBodies.set(effect.message.messageId, effect.message.body);
      } else if (effect.type === "message.append") {
        const body = messageBodies.get(effect.messageId);
        if (body === undefined)
          throw new Error(`Missing message ${effect.messageId} at sequence ${row.seq}.`);
        messageBodies.set(effect.messageId, body + effect.delta);
      } else if (effect.type === "message.replace") {
        messageBodies.set(effect.messageId, effect.body);
      }
      const payload = JSON.parse(row.payload_json) as { source?: ThreadRunEvent; message?: string };
      const source = payload.source;
      const liveType = source?.metadata?.liveType;
      const event: FeedReplayEvent = {
        seq: row.seq,
        at,
        eventType: row.type,
        effectVersion: CONVERSATION_V2_EFFECT_VERSION,
        effectHash: row.effect_hash,
        effect,
        ...(typeof liveType === "string" && !streamTypes.has(liveType)
          ? {
              live: {
                type: liveType,
                threadId: conversationId,
                message: payload.message ?? "",
                ...(source?.role ? { role: source.role } : {}),
                ...(source?.agentId ? { agentId: source.agentId } : {}),
                ...(source?.runAttemptId ? { runAttemptId: source.runAttemptId } : {}),
                ...(source?.metadata ? { metadata: source.metadata } : {}),
              },
            }
          : {}),
      };
      if (effect.type === "run.upsert") {
        status = replayThreadStatus(effect.run.status);
      }
      if (effect.type === "agent.upsert") {
        const agent = effect.agent;
        agents.set(effect.agent.agentId, {
          threadId: conversationId,
          agentId: agent.agentId,
          role: agent.role as AgentInstanceRecord["role"],
          kind: agent.kind === "planner" ? "planner" : "subagent",
          status: ["active", "running"].includes(agent.status)
            ? "active"
            : ["queued", "launching"].includes(agent.status)
              ? "launching"
              : ["failed", "cancelled", "abandoned"].includes(agent.status)
                ? "abandoned"
                : "stopped",
          startedAt: agent.startedAt ?? row.occurred_at,
          updatedAt: row.occurred_at,
          ...(agent.endedAt ? { endedAt: agent.endedAt } : {}),
          ...(agent.runId ? { runAttemptId: agent.runId } : {}),
          ...(agent.parentAgentInstanceId ? { parentAgentId: agent.parentAgentInstanceId } : {}),
          ...(agent.parentToolCallId ? { parentToolUseId: agent.parentToolCallId } : {}),
        });
      }
      let relevantSource = false;
      if (source) {
        // New V2 receipts reference the message already materialized by preceding effects.
        // Read its body at this sequence, never the final body from the current messages table.
        const message =
          payload.message ??
          source.message ??
          (row.message_id ? messageBodies.get(row.message_id) : undefined);
        if (typeof message !== "string")
          throw new Error(`Missing source message for ${source.id} at sequence ${row.seq}.`);
        const previous = sources.get(source.id);
        relevantSource =
          !previous ||
          !streamTypes.has(source.eventType) ||
          previous.streamState !== source.streamState ||
          Boolean(previous.message.trim()) !== Boolean(message.trim());
        sources.set(source.id, { ...source, sequence: row.seq, message });
      }
      if (relevantSource || effect.type === "run.upsert" || effect.type === "agent.upsert") {
        const spans = buildThreadRunProjectionRequestSpans({
          events: [...sources.values()].sort((a, b) => a.sequence - b.sequence),
          threadStatus: status,
          agents: [...agents.values()],
          historyComplete: true,
        });
        const current = new Map<string, string>();
        const upserts: typeof spans = [];
        for (const span of spans) {
          const encoded = JSON.stringify(span);
          current.set(span.requestId, encoded);
          if (previousSpans.get(span.requestId) !== encoded) upserts.push(span);
        }
        const removed = [...previousSpans.keys()].filter((id) => !current.has(id));
        if (upserts.length || removed.length) event.requestSpanChanges = { upserts, removed };
        previousSpans = current;
      }
      yield { kind: "event", value: event };
    }
    if (!count) throw new Error(`No V2 events for ${conversationId}; legacy sessions are unsupported.`);
    const detailRows = db
      .query<Record<string, string | number | null>, [string]>(
        "SELECT * FROM conversation_detail_items_v2 WHERE conversation_id=? ORDER BY created_seq,item_id",
      )
      .iterate(conversationId);
    for (const row of detailRows) {
      const item: ConversationDetailItem = {
        itemId: String(row.item_id),
        conversationId,
        runId: String(row.run_id),
        type: String(row.type),
        createdSeq: Number(row.created_seq),
        versionSeq: Number(row.version_seq),
      };
      const fields = {
        agent_id: "agentId",
        agent_instance_id: "agentInstanceId",
        parent_agent_instance_id: "parentAgentInstanceId",
        parent_agent_id: "parentAgentId",
        parent_tool_call_id: "parentToolCallId",
        tool_call_id: "toolCallId",
        content: "content",
        ref: "ref",
      } as const;
      for (const [column, field] of Object.entries(fields)) {
        if (typeof row[column] === "string") item[field] = row[column];
      }
      yield { kind: "detail", value: item };
    }
  } finally {
    db.close();
  }
}

/** In-memory helper for tests and small recordings. The CLI writes the iterator directly. */
export function exportFeedReplay(databasePath: string, conversationId: string): FeedReplayFixture {
  let header: ReplayMetadata | undefined;
  const events: FeedReplayEvent[] = [];
  const detailItems: ConversationDetailItem[] = [];
  for (const record of readReplayRecords(databasePath, conversationId)) {
    if (record.kind === "header") header = record.value;
    else if (record.kind === "event") events.push(record.value);
    else detailItems.push(record.value);
  }
  if (!header) throw new Error("Replay export did not produce a header.");
  return { ...header, events, detailItems };
}

function writeReplayRecords(outputPath: string, records: Iterable<ReplayRecord>) {
  const output = resolve(outputPath);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  let closed = false;
  let header: ReplayMetadata | undefined;
  let events = 0;
  let details = 0;
  let spanPatches = 0;
  let detailSection = false;
  try {
    for (const record of records) {
      if (record.kind === "header") {
        if (header) throw new Error("Replay export repeated its header.");
        header = record.value;
        writeFileSync(fd, `${JSON.stringify(header).slice(0, -1)},"events":[`);
      } else if (record.kind === "event") {
        if (!header || detailSection) throw new Error("Replay event is outside the event section.");
        writeFileSync(fd, `${events++ ? "," : ""}${JSON.stringify(record.value)}`);
        if (record.value.requestSpanChanges) spanPatches++;
      } else {
        if (!header) throw new Error("Replay detail precedes its header.");
        if (!detailSection) {
          writeFileSync(fd, '],"detailItems":[');
          detailSection = true;
        }
        writeFileSync(fd, `${details++ ? "," : ""}${JSON.stringify(record.value)}`);
      }
    }
    if (!header || !events) throw new Error("Replay export has no events.");
    if (!detailSection) writeFileSync(fd, '],"detailItems":[');
    writeFileSync(fd, "]}");
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
    renameSync(temporary, output);
    chmodSync(output, 0o600);
    return {
      fixture: output,
      formatVersion: header.formatVersion,
      events,
      details,
      spanPatches,
      bytes: statSync(output).size,
      coverage: header.coverage,
    };
  } finally {
    if (!closed) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function exportFeedReplayToFile(databasePath: string, conversationId: string, outputPath: string) {
  if (
    resolve(databasePath) === resolve(outputPath) ||
    (() => {
      try {
        return realpathSync(databasePath) === realpathSync(outputPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    })()
  )
    throw new Error("Replay output must not overwrite the source database.");
  return writeReplayRecords(outputPath, readReplayRecords(databasePath, conversationId));
}

export function writeReplayFixture(outputPath: string, fixture: FeedReplayFixture): void {
  function* records(): Generator<ReplayRecord> {
    const { events, detailItems, ...header } = fixture;
    yield { kind: "header", value: header };
    for (const value of events) yield { kind: "event", value };
    for (const value of detailItems) yield { kind: "detail", value };
  }
  writeReplayRecords(outputPath, records());
}
