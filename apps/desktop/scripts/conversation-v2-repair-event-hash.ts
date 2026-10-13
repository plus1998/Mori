import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { type ConversationEventRecord, stableHash } from "@eco/shared";
import {
  conversationV2EventHash,
  inspectSdkInformationalEventHashRepair,
} from "../src/main/conversation-v2-event-integrity";

const args = parseArguments(process.argv.slice(2));
if (!existsSync(args.dbPath)) throw new Error(`Database does not exist: ${args.dbPath}`);
const db = new DatabaseSync(args.dbPath, { readOnly: !args.apply });
try {
  if (args.apply) {
    const backupPath = args.backupPath;
    if (!backupPath) throw new Error("--backup is required when applying.");
    if (existsSync(backupPath)) throw new Error("Backup path already exists; refusing to overwrite it.");
    // SQLite's online backup includes committed WAL pages without rebuilding
    // every index as VACUUM INTO would. Copying only the main file is unsafe.
    let reportedPercent = -10;
    await backup(db, backupPath, {
      rate: 4_096,
      progress: ({ remainingPages, totalPages }) => {
        const percent = Math.floor((1 - remainingPages / totalPages) * 100);
        if (percent >= reportedPercent + 10) {
          process.stderr.write(`SQLite backup: ${percent}%\n`);
          reportedPercent = percent;
        }
      },
    });
  }
  db.exec(args.apply ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const row = db
      .prepare(`SELECT * FROM conversation_events_v2 WHERE conversation_id = ? AND seq = ?`)
      .get(args.conversationId, args.seq) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Target event does not exist.");
    const event = eventFromRow(row);
    const repair = inspectSdkInformationalEventHashRepair(event);
    if (!repair && conversationV2EventHash(event) !== event.eventHash) {
      throw new Error(
        "Hash mismatch is not the proven SDK informational serialization defect; refusing repair.",
      );
    }
    // Verify the whole conversation, including effects and contiguous sequence
    // numbers, using only the proposed hash for the one explicit target row.
    const head = db
      .prepare(`SELECT last_seq, store_epoch FROM conversation_streams_v2 WHERE conversation_id = ?`)
      .get(args.conversationId) as { last_seq: number; store_epoch: string } | undefined;
    if (!head) throw new Error("Conversation stream is missing.");
    let verifiedEvents = 0;
    for (const candidate of db
      .prepare(`SELECT * FROM conversation_events_v2 WHERE conversation_id = ? ORDER BY seq`)
      .iterate(args.conversationId)) {
      const current = eventFromRow(candidate);
      verifiedEvents += 1;
      if (
        current.seq !== verifiedEvents ||
        current.storeEpoch !== head.store_epoch ||
        current.schemaVersion !== 1
      ) {
        throw new Error(`Event range or schema is invalid at sequence ${current.seq}.`);
      }
      const expectedHash = current.seq === args.seq && repair ? repair.correctedHash : current.eventHash;
      if (conversationV2EventHash(current) !== expectedHash) {
        throw new Error(`Another event hash mismatch at sequence ${current.seq}; refusing repair.`);
      }
    }
    let verifiedEffects = 0;
    for (const effect of db
      .prepare(`SELECT seq, effect_version, effect_hash, effect_json
      FROM conversation_sync_effects_v2 WHERE conversation_id = ? ORDER BY seq`)
      .iterate(args.conversationId)) {
      verifiedEffects += 1;
      if (
        effect.seq !== verifiedEffects ||
        effect.effect_version !== 1 ||
        stableHash(JSON.parse(effect.effect_json as string)) !== effect.effect_hash
      ) {
        throw new Error(`Effect integrity failure at sequence ${effect.seq}; refusing repair.`);
      }
    }
    if (verifiedEvents !== head.last_seq || verifiedEffects !== head.last_seq) {
      throw new Error("Event/effect counts do not match the stream head; refusing repair.");
    }
    const payloadSha256 = createHash("sha256")
      .update(row.payload_json as string)
      .digest("hex");
    if (args.apply && repair) {
      db.exec(`CREATE TABLE IF NOT EXISTS conversation_event_hash_repairs_v2 (
        conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL,
        previous_hash TEXT NOT NULL, corrected_hash TEXT NOT NULL,
        omitted_metadata_keys_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL, repaired_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      )`);
      const updated = db
        .prepare(`UPDATE conversation_events_v2 SET event_hash = ?
        WHERE conversation_id = ? AND seq = ? AND event_hash = ? AND payload_json = ?`)
        .run(
          repair.correctedHash,
          args.conversationId,
          args.seq,
          repair.previousHash,
          row.payload_json as string,
        );
      if (updated.changes !== 1) throw new Error("Target changed while repairing; refusing repair.");
      db.prepare(`INSERT INTO conversation_event_hash_repairs_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        args.conversationId,
        args.seq,
        event.eventId,
        repair.previousHash,
        repair.correctedHash,
        JSON.stringify(repair.omittedMetadataKeys),
        payloadSha256,
        new Date().toISOString(),
      );
    }
    db.exec("COMMIT");
    process.stdout.write(
      `${JSON.stringify(
        {
          phase: args.apply ? "applied" : "inspection",
          conversationId: args.conversationId,
          seq: args.seq,
          repair: repair ?? null,
          payloadSha256,
          verifiedEvents,
          verifiedEffects,
          ...(args.apply ? { backupPath: args.backupPath } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} finally {
  db.close();
}

function eventFromRow(row: Record<string, unknown>): ConversationEventRecord {
  const event: Record<string, unknown> = {};
  for (const [field, column] of Object.entries({
    conversationId: "conversation_id",
    eventId: "event_id",
    type: "type",
    occurredAt: "occurred_at",
    sourceEventKey: "source_event_key",
    turnId: "turn_id",
    runId: "run_id",
    messageId: "message_id",
    toolCallId: "tool_call_id",
    agentId: "agent_id",
    agentInstanceId: "agent_instance_id",
    parentAgentInstanceId: "parent_agent_instance_id",
    parentAgentId: "parent_agent_id",
    parentToolCallId: "parent_tool_call_id",
  }))
    if (row[column] !== null) event[field] = row[column];
  return {
    ...event,
    payload: JSON.parse(row.payload_json as string),
    eventHash: row.event_hash,
    seq: row.seq,
    storeEpoch: row.store_epoch,
    recordedAt: row.recorded_at,
    schemaVersion: row.schema_version,
  } as ConversationEventRecord;
}

function parseArguments(values: string[]) {
  let dbPath = "",
    conversationId = "",
    backupPath: string | undefined,
    seq = 0,
    apply = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--db") dbPath = values[++index] ?? "";
    else if (value === "--conversation") conversationId = values[++index] ?? "";
    else if (value === "--seq") seq = Number(values[++index]);
    else if (value === "--backup") backupPath = values[++index];
    else if (value === "--apply") apply = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (
    !dbPath.trim() ||
    !conversationId.trim() ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    (apply && !backupPath?.trim())
  ) {
    throw new Error(
      "Usage: bun run conversation:v2-repair-event-hash --db FILE --conversation ID --seq N [--apply --backup NEW_FILE]. Stop the app before applying.",
    );
  }
  return { dbPath, conversationId, seq, backupPath, apply };
}
