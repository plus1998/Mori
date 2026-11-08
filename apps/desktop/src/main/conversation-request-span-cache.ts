import type { DatabaseSync } from "node:sqlite";
import type { ConversationHead } from "@eco/shared";
import { repairActivityText } from "../shared/activity-text";
import type { ThreadRunEvent, ThreadRunEventInput, ThreadRunProjectionRequestSpan } from "../shared/ipc";
import { withLegacyConversationV2MessageIdentity } from "./conversation-v2-legacy-adapter";
import { buildThreadRunProjectionRequestSpans } from "./conversation-v2-runtime-projection";
import type { AgentInstanceRecord } from "./usage-ledger";

interface Entry {
  head: ConversationHead;
  events: Map<string, { event: ThreadRunEvent; bytes: number }>;
  bytes: number;
  state: string;
  spans: ThreadRunProjectionRequestSpan[];
}

/** Bounded read cache. Durable V2 versions, never a timeout, define freshness. */
export class ConversationRequestSpanCache {
  private readonly entries = new Map<string, Entry>();
  private dataVersion: number | undefined;

  constructor(private readonly db: DatabaseSync) {}

  read(
    head: ConversationHead,
    threadStatus: string,
    agents: readonly AgentInstanceRecord[],
  ): ThreadRunProjectionRequestSpan[] {
    const version = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
    // Another connection may rebuild materialized tables or replace history.
    if (this.dataVersion !== version.data_version) this.entries.clear();
    this.dataVersion = version.data_version;
    const id = head.conversationId;
    let previous = this.entries.get(id);
    if (
      this.db.isTransaction ||
      previous?.head.storeEpoch !== head.storeEpoch ||
      previous?.head.historyRevision !== head.historyRevision ||
      (previous && head.lastSeq < previous.head.lastSeq)
    ) {
      this.entries.delete(id);
      previous = undefined;
    }
    const state = JSON.stringify([threadStatus, agents]);
    if (previous?.head.lastSeq === head.lastSeq && previous.state === state) {
      return structuredClone(previous.spans);
    }
    let events = previous?.events ?? new Map<string, { event: ThreadRunEvent; bytes: number }>();
    let bytes = previous?.bytes ?? 0;
    if (!previous || previous.head.lastSeq !== head.lastSeq) {
      const after = previous?.head.lastSeq;
      const changed =
        after === undefined
          ? ""
          : `AND p.input_id IN (
        SELECT input_id FROM conversation_provider_inputs_v2
          WHERE conversation_id = ? AND version_seq > ?
        UNION
        SELECT p2.input_id FROM conversation_events_v2 e
          JOIN conversation_provider_inputs_v2 p2
            ON p2.conversation_id = e.conversation_id AND p2.message_id = e.message_id
          WHERE e.conversation_id = ? AND e.seq > ? AND e.type LIKE 'message.%'
      )`;
      const query = this.db.prepare(`
        SELECT p.input_id, p.version_seq, p.source_json,
          CASE WHEN json_extract(p.source_json, '$.eventType') IN
            ('thinking.delta', 'tool.writing', 'request.failed', 'api.error')
            THEN CASE WHEN p.message_id IS NULL THEN p.message ELSE COALESCE(m.body, '') END
            ELSE '' END AS message
        FROM conversation_provider_inputs_v2 p
        LEFT JOIN conversation_messages_v2 m
          ON m.message_id = p.message_id AND m.conversation_id = p.conversation_id
          AND json_extract(p.source_json, '$.eventType') IN
            ('thinking.delta', 'tool.writing', 'request.failed', 'api.error')
        WHERE p.conversation_id = ? AND p.visible = 1 ${changed}
        ORDER BY p.version_seq, p.input_id
      `);
      const rows = (after === undefined ? query.all(id) : query.all(id, id, after, id, after)) as Array<{
        input_id: string;
        version_seq: number;
        source_json: string;
        message: string;
      }>;
      // Publish only after all decoding and derivation succeeds.
      events = new Map(events);
      for (const row of rows) {
        const source = JSON.parse(row.source_json) as ThreadRunEventInput;
        const event = withLegacyConversationV2MessageIdentity({
          ...source,
          id: row.input_id,
          threadId: id,
          sequence: row.version_seq,
          message: repairActivityText(row.message).text,
        });
        const size = Buffer.byteLength(row.source_json) + Buffer.byteLength(row.message);
        bytes += size - (events.get(row.input_id)?.bytes ?? 0);
        events.set(row.input_id, { event, bytes: size });
      }
    }
    const ordered = [...events.values()]
      .map((row) => row.event)
      .sort((a, b) => a.sequence - b.sequence || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
    const spans = buildThreadRunProjectionRequestSpans({
      events: ordered,
      threadStatus,
      agents,
      historyComplete: true,
    });
    this.entries.delete(id);
    // Transaction reads must not survive rollback. Large conversations remain
    // correct without retaining their source envelopes in the process heap.
    if (!this.db.isTransaction && bytes <= 4 * 1024 * 1024 && events.size <= 10_000) {
      this.entries.set(id, { head, events, bytes, state, spans });
      if (this.entries.size > 4) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    return structuredClone(spans);
  }
}
