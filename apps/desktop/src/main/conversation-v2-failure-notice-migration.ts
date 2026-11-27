import type { DatabaseSync } from "node:sqlite";
import { isThreadFailureNoticeType } from "../shared/thread-failure-message";
import type { ThreadRunEvent } from "../shared/thread-run-events";
import { appendProviderEventToConversationV2 } from "./conversation-v2-provider-events";
import type { ConversationV2Store } from "./conversation-v2-store";

/** Restore failure reasons previously retained only as internal provider receipts. */
export function migrateThreadFailureNotices(db: DatabaseSync, store: ConversationV2Store): number {
  const blockers = migrateFailureNoticeTypes(db, store, "thread_failure_notices_v1", [
    "thread.blocked", "thread.execution_failed",
  ]);
  return blockers + migrateFailureNoticeTypes(db, store, "thread_failed_notices_v2", ["thread.failed"]);
}

function migrateFailureNoticeTypes(
  db: DatabaseSync,
  store: ConversationV2Store,
  migrationKey: string,
  liveTypes: readonly string[],
): number {
  if (db.prepare("SELECT 1 FROM conversation_store_meta_v2 WHERE key = ?").get(migrationKey)) return 0;
  let emitted = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare(
        `SELECT source_json, message FROM conversation_provider_inputs_v2
       WHERE visible = 1
         AND json_extract(source_json, '$.eventType') = 'thread.status'
         AND json_extract(source_json, '$.metadata.liveType') IN (${liveTypes.map(() => "?").join(", ")})
       ORDER BY conversation_id ASC, first_seq ASC, input_id ASC`,
      )
      .all(...liveTypes) as Array<{ source_json: string; message: string | null }>;
    for (const row of rows) {
      const source = JSON.parse(row.source_json) as ThreadRunEvent;
      // New receipts reference their already-normalized notice instead of duplicating its body.
      if (typeof source.metadata?.conversationV2MessageId === "string") continue;
      if (!isThreadFailureNoticeType(source.metadata?.liveType) || typeof row.message !== "string") {
        throw new Error(`Thread failure receipt ${source.id} is invalid.`);
      }
      emitted += appendProviderEventToConversationV2(
        store,
        { ...source, message: row.message },
        {
          mode: "runtime",
          sourcePrefix: "provider",
          inCurrentTransaction: true,
        },
      );
    }
    db.prepare("INSERT INTO conversation_store_meta_v2(key, value) VALUES (?, ?)").run(migrationKey, "1");
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error if SQLite already rolled back.
    }
    throw error;
  }
  return emitted;
}
