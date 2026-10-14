import type { DatabaseSync } from "node:sqlite";
import { isContextCompactionEventType, type ThreadRunEvent } from "../shared/thread-run-events";
import { appendProviderEventToConversationV2 } from "./conversation-v2-provider-events";
import type { ConversationV2Store } from "./conversation-v2-store";

const MIGRATION_KEY = "codex_context_compaction_details_v1";

/** Upgrade Codex native lifecycle receipts that predate their V2 detail conversion. */
export function migrateCodexCompactionDetails(db: DatabaseSync, store: ConversationV2Store): number {
  if (db.prepare("SELECT 1 FROM conversation_store_meta_v2 WHERE key = ?").get(MIGRATION_KEY)) {
    return 0;
  }
  let emitted = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare(
        `SELECT source_json, message FROM conversation_provider_inputs_v2
       WHERE visible = 1
         AND json_extract(source_json, '$.metadata.itemType') = 'contextCompaction'
         AND json_extract(source_json, '$.eventType') IN (
           'context.compaction.started', 'context.compaction.completed',
           'context.compaction.failed', 'context.compaction.suspended'
         )
       ORDER BY conversation_id ASC, first_seq ASC, input_id ASC`,
      )
      .all() as Array<{ source_json: string; message: string | null }>;
    for (const row of rows) {
      const source = JSON.parse(row.source_json) as ThreadRunEvent;
      if (!isContextCompactionEventType(source.eventType) || typeof row.message !== "string") {
        throw new Error(`Codex compaction receipt ${source.id} is invalid.`);
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
    db.prepare("INSERT INTO conversation_store_meta_v2(key, value) VALUES (?, ?)").run(MIGRATION_KEY, "1");
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
