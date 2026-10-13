import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

/** Opens an existing database read-only and holds one consistent read transaction. */
export function exportFeedReplay(databasePath: string, conversationId: string): FeedReplayFixture {
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    db.exec("BEGIN");
    const thread = readThread(db, conversationId);
    // LEFT JOIN makes missing sync effects an error instead of silently losing events.
    const rows = db
      .query<EventRow, [string]>(`
      SELECT e.seq,e.store_epoch,e.occurred_at,e.type,e.payload_json,
             s.effect_version,s.effect_hash,s.effect_json
      FROM conversation_events_v2 AS e LEFT JOIN conversation_sync_effects_v2 AS s
      ON s.conversation_id=e.conversation_id AND s.seq=e.seq
      WHERE e.conversation_id=? ORDER BY e.seq
    `)
      .all(conversationId);
    if (!rows.length) throw new Error(`No V2 events for ${conversationId}; legacy sessions are unsupported.`);
    const epoch = rows[0]!.store_epoch;
    const sources = new Map<string, ThreadRunEvent>();
    const agents = new Map<string, AgentInstanceRecord>();
    const seenStreams = new Set<string>();
    let status: ThreadSummary["status"] = "idle";
    const events: FeedReplayEvent[] = rows.map((row, index) => {
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
      const streamKey = source && `${source.requestId}:${source.eventType}:${source.streamKey}`;
      const firstStream = source && streamTypes.has(source.eventType) && !seenStreams.has(streamKey!);
      if (firstStream) seenStreams.add(streamKey!);
      const relevantSource =
        source &&
        (firstStream ||
          source.eventType.startsWith("request.") ||
          ["tool.writing", "tool.started", "tool.completed", "tool.failed"].includes(source.eventType));
      if (relevantSource)
        sources.set(source.id, { ...source, sequence: row.seq, message: payload.message ?? source.message });
      if (relevantSource || effect.type === "run.upsert" || effect.type === "agent.upsert") {
        event.requestSpans = buildThreadRunProjectionRequestSpans({
          events: [...sources.values()].sort((a, b) => a.sequence - b.sequence),
          threadStatus: status,
          agents: [...agents.values()],
          historyComplete: true,
        });
      }
      return event;
    });
    const detailRows = db
      .query<Record<string, string | number | null>, [string]>(
        "SELECT * FROM conversation_detail_items_v2 WHERE conversation_id=? ORDER BY created_seq,item_id",
      )
      .all(conversationId);
    const detailItems: ConversationDetailItem[] = detailRows.map((row) => {
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
      return item;
    });
    return {
      formatVersion: 1,
      protocolVersion: 2,
      exportedAt: new Date().toISOString(),
      conversationId,
      storeEpoch: epoch,
      thread,
      events,
      detailItems,
      coverage: [
        "V2 effects are exact; request spans are rebuilt with the current production projector.",
        "Persisted detail bodies are available only at or after their recorded versionSeq.",
        "UI settings/workspace metadata use the current dev environment, not historical snapshots.",
        "Approval dialogs, follow-up queue operations, billing/context snapshots and media bodies are not fully recorded.",
      ],
    };
  } finally {
    db.close();
  }
}

export function writeReplayFixture(outputPath: string, fixture: FeedReplayFixture): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(fixture), { mode: 0o600 });
  chmodSync(outputPath, 0o600);
}
