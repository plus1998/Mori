import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "bun:test";
import { ConversationRequestSpanCache } from "../src/main/conversation-request-span-cache";
import { buildThreadRunProjectionRequestSpans } from "../src/main/conversation-v2-runtime-projection";
import type { ThreadRunEvent, ThreadRunEventInput } from "../src/shared/ipc";

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE conversation_provider_inputs_v2 (
      conversation_id TEXT, input_id TEXT, first_seq INTEGER, version_seq INTEGER,
      source_json TEXT, message_id TEXT, message TEXT, visible INTEGER DEFAULT 1,
      PRIMARY KEY (conversation_id, input_id)
    );
    CREATE TABLE conversation_messages_v2 (message_id TEXT, conversation_id TEXT, body TEXT);
    CREATE TABLE conversation_events_v2 (conversation_id TEXT, seq INTEGER, type TEXT, message_id TEXT);
    CREATE INDEX provider_version ON conversation_provider_inputs_v2(conversation_id, version_seq);
    CREATE INDEX provider_message ON conversation_provider_inputs_v2(conversation_id, message_id);
    CREATE INDEX events_sequence ON conversation_events_v2(conversation_id, seq);
  `);
  return db;
}

function eventInput(
  requestId: string,
  eventType: ThreadRunEventInput["eventType"],
  streamState?: ThreadRunEventInput["streamState"],
): ThreadRunEventInput {
  return {
    eventType,
    requestId,
    observedAt: "2026-01-01T00:00:00.000Z",
    role: "assistant",
    scope: "main",
    ...(streamState ? { streamState } : {}),
  };
}

describe("ConversationRequestSpanCache", () => {
  test("replays only the bounded tail for a large append-only conversation", () => {
    const db = createDatabase();
    const conversationId = "thr_cache_test";
    const events: ThreadRunEvent[] = [];
    let seq = 0;
    const append = (input: ThreadRunEventInput, message = "") => {
      seq += 1;
      const id = `input-${seq}`;
      db.prepare(
        "INSERT INTO conversation_provider_inputs_v2 VALUES (?, ?, ?, ?, ?, NULL, ?, 1)",
      ).run(conversationId, id, seq, seq, JSON.stringify(input), message);
      db.prepare(
        "INSERT INTO conversation_events_v2 VALUES (?, ?, ?, NULL)",
      ).run(conversationId, seq, input.eventType);
      events.push({
        ...input,
        id,
        threadId: conversationId,
        sequence: seq,
        message,
      });
    };
    const head = () => ({
      conversationId,
      storeEpoch: "epoch",
      historyRevision: 0,
      lastSeq: seq,
    });

    append(eventInput("request-0", "request.started", "placeholder"));
    for (let index = 0; index < 6_000; index += 1) {
      append(
        eventInput("request-0", "thinking.delta", "streaming"),
        "x".repeat(800),
      );
    }
    append(eventInput("request-0", "request.completed"));
    append(eventInput("request-1", "request.started", "placeholder"));
    append(eventInput("request-1", "message.delta", "streaming"));
    append(eventInput("request-1", "request.completed"));
    append(eventInput("request-2", "request.started", "placeholder"));
    append(eventInput("request-2", "message.delta", "streaming"));

    const cache = new ConversationRequestSpanCache(db);
    const first = cache.read(head(), "running", []);
    expect(first).toHaveLength(3);
    expect(
      (
        cache as unknown as {
          entries: Map<string, { tailEvents: ThreadRunEvent[] }>;
        }
      ).entries.get(conversationId)?.tailEvents.length,
    ).toBeLessThan(20);

    append(eventInput("request-2", "message.final", "finalized"));
    const incremental = cache.read(head(), "running", []);
    expect(incremental).toEqual(
      buildThreadRunProjectionRequestSpans({
        events,
        threadStatus: "running",
        agents: [],
      }),
    );

    append(eventInput("request-0", "request.failed"), "history correction");
    const rebuilt = cache.read(head(), "running", []);
    expect(rebuilt).toEqual(
      buildThreadRunProjectionRequestSpans({
        events,
        threadStatus: "running",
        agents: [],
      }),
    );
  });
});
