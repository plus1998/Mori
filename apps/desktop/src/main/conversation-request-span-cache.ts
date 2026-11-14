import type { DatabaseSync } from "node:sqlite";
import type { ConversationHead } from "@eco/shared";
import { repairActivityText } from "../shared/activity-text";
import type {
  ThreadRunEvent,
  ThreadRunEventInput,
  ThreadRunProjectionRequestSpan,
} from "../shared/ipc";
import { withLegacyConversationV2MessageIdentity } from "./conversation-v2-legacy-adapter";
import { buildThreadRunProjectionRequestSpans } from "./conversation-v2-runtime-projection";
import type { AgentInstanceRecord } from "./usage-ledger";

interface Entry {
  head: ConversationHead;
  state: string;
  spans: ThreadRunProjectionRequestSpan[];
  /**
   * A compact replay window for conversations whose complete event history is
   * too large to retain. It contains the last two request windows only; older
   * spans are frozen in `spans`.
   */
  tailEvents: ThreadRunEvent[];
  tailRequestIds: Set<string>;
  tailBytes: number;
}

const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const TAIL_REQUEST_WINDOWS = 2;

function compactProjectionEvent(event: ThreadRunEvent): ThreadRunEvent {
  // Request timing does not need streamed text. Keep only messages that are
  // consumed as an error/tool-writing fallback, with a hard bound for safety.
  const keepMessage =
    event.eventType === "tool.writing" ||
    event.eventType === "request.failed" ||
    event.eventType === "api.error";
  return {
    ...event,
    message: keepMessage ? event.message.slice(0, 8 * 1024) : "",
  };
}

function buildTail(events: readonly ThreadRunEvent[]): {
  events: ThreadRunEvent[];
  requestIds: Set<string>;
  bytes: number;
} {
  const starts: number[] = [];
  for (let index = 0; index < events.length; index += 1) {
    if (
      events[index]?.eventType === "request.started" &&
      events[index]?.requestId
    )
      starts.push(index);
  }
  const start =
    starts[Math.max(0, starts.length - TAIL_REQUEST_WINDOWS)] ?? events.length;
  const tail = events.slice(start).map(compactProjectionEvent);
  const bytes = tail.reduce(
    (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
    0,
  );
  return {
    events: tail,
    requestIds: new Set(
      tail.flatMap((event) => (event.requestId ? [event.requestId] : [])),
    ),
    bytes,
  };
}

function mergeTailSpans(
  frozen: readonly ThreadRunProjectionRequestSpan[],
  previousTailIds: ReadonlySet<string>,
  tailSpans: readonly ThreadRunProjectionRequestSpan[],
): ThreadRunProjectionRequestSpan[] {
  const merged = new Map(
    frozen
      .filter((span) => !previousTailIds.has(span.requestId))
      .map((span) => [span.requestId, span]),
  );
  for (const span of tailSpans) merged.set(span.requestId, span);
  return [...merged.values()].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
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
    const version = this.db.prepare("PRAGMA data_version").get() as {
      data_version: number;
    };
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
    const canIncrement = Boolean(
      previous &&
      previous.state === state &&
      previous.head.lastSeq < head.lastSeq &&
      previous.tailEvents.length > 0 &&
      previous.tailBytes <= MAX_TAIL_BYTES,
    );
    const queryRows = (after: number | undefined) => {
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
      return (
        after === undefined
          ? query.all(id)
          : query.all(id, id, after, id, after)
      ) as Array<{
        input_id: string;
        version_seq: number;
        source_json: string;
        message: string;
      }>;
    };
    let after = canIncrement ? previous!.head.lastSeq : undefined;
    let rows = queryRows(after);
    let decoded = rows.map((row) => {
      const source = JSON.parse(row.source_json) as ThreadRunEventInput;
      return {
        input_id: row.input_id,
        version_seq: row.version_seq,
        source_json: row.source_json,
        message: row.message,
        messageChanged: after !== undefined && row.version_seq <= after,
        event: withLegacyConversationV2MessageIdentity({
          ...source,
          id: row.input_id,
          threadId: id,
          sequence: row.version_seq,
          message: repairActivityText(row.message).text,
        }),
      };
    });
    // A row at or before the checkpoint means an old fact was revised. Rebuild
    // from the complete history; only append-only changes use the tail path.
    const appendOnly =
      canIncrement &&
      decoded.every((row) => row.version_seq > after! || row.messageChanged);
    const previousTailRequestIds =
      previous?.tailRequestIds ?? new Set<string>();
    const touchesFrozenRequest =
      canIncrement &&
      decoded.some(
        (row) =>
          row.event.requestId &&
          !previousTailRequestIds.has(row.event.requestId) &&
          row.event.eventType !== "request.started",
      );
    if (canIncrement && (!appendOnly || touchesFrozenRequest)) {
      after = undefined;
      rows = queryRows(undefined);
      decoded = rows.map((row) => {
        const source = JSON.parse(row.source_json) as ThreadRunEventInput;
        return {
          input_id: row.input_id,
          version_seq: row.version_seq,
          source_json: row.source_json,
          message: row.message,
          messageChanged: false,
          event: withLegacyConversationV2MessageIdentity({
            ...source,
            id: row.input_id,
            threadId: id,
            sequence: row.version_seq,
            message: repairActivityText(row.message).text,
          }),
        };
      });
    }
    const fullEvents = decoded.map((row) => row.event);
    const ordered =
      after === undefined
        ? fullEvents
        : [...(previous?.tailEvents ?? []), ...fullEvents].sort(
            (a, b) =>
              a.sequence - b.sequence ||
              Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
          );
    let spans: ThreadRunProjectionRequestSpan[];
    let tailEvents: ThreadRunEvent[];
    let tailRequestIds: Set<string>;
    let tailBytes: number;
    if (after !== undefined) {
      const accumulatedTail = ordered;
      const accumulatedTailSpans = buildThreadRunProjectionRequestSpans({
        events: accumulatedTail,
        threadStatus,
        agents,
        historyComplete: true,
      });
      const tail = buildTail(accumulatedTail);
      if (tail.bytes > MAX_TAIL_BYTES) {
        const fullRows = queryRows(undefined);
        const fullEvents = fullRows.map((row) => {
          const source = JSON.parse(row.source_json) as ThreadRunEventInput;
          return withLegacyConversationV2MessageIdentity({
            ...source,
            id: row.input_id,
            threadId: id,
            sequence: row.version_seq,
            message: repairActivityText(row.message).text,
          });
        });
        spans = buildThreadRunProjectionRequestSpans({
          events: fullEvents,
          threadStatus,
          agents,
          historyComplete: true,
        });
        const rebuiltTail = buildTail(fullEvents);
        tailEvents = rebuiltTail.events;
        tailRequestIds = rebuiltTail.requestIds;
        tailBytes = rebuiltTail.bytes;
      } else {
        spans = mergeTailSpans(
          previous!.spans,
          previous!.tailRequestIds,
          accumulatedTailSpans,
        );
        tailEvents = tail.events;
        tailRequestIds = tail.requestIds;
        tailBytes = tail.bytes;
      }
    } else {
      spans = buildThreadRunProjectionRequestSpans({
        events: ordered,
        threadStatus,
        agents,
        historyComplete: true,
      });
      const tail = buildTail(ordered);
      tailEvents = tail.events;
      tailRequestIds = tail.requestIds;
      tailBytes = tail.bytes;
    }
    this.entries.delete(id);
    // Transaction reads must not survive rollback. Keep only request projection
    // state and a bounded tail; never retain the complete source history.
    if (!this.db.isTransaction) {
      this.entries.set(id, {
        head,
        state,
        spans,
        tailEvents,
        tailRequestIds,
        tailBytes,
      });
      if (this.entries.size > 4) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    return structuredClone(spans);
  }
}
