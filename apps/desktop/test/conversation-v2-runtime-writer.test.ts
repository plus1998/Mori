import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/main/conversation-store";
import { ConversationV2RuntimeWriter } from "../src/main/conversation-v2-runtime-writer";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import type { ThreadRunEventInput } from "../src/shared/thread-run-events";
import { removeTempDirectory } from "./helpers/temp-directory";

function setup() {
  const db = new DatabaseSync(":memory:");
  const v2 = new ConversationV2Store(db);
  v2.initialize();
  v2.ensureConversation("thread");
  v2.append({
    conversationId: "thread",
    eventId: "run-start",
    runId: "run",
    turnId: "run",
    type: "run.started",
    occurredAt: "2026-09-18T00:00:00Z",
    payload: { status: "running" },
  });
  return { db, v2, writer: new ConversationV2RuntimeWriter(db, v2) };
}
function snapshot(body: string, final = false): ThreadRunEventInput {
  return {
    threadId: "thread",
    id: "provider-stream",
    runAttemptId: "run",
    streamKey: "stream",
    eventType: final ? "message.final" : "message.delta",
    role: "planner",
    scope: "main",
    streamState: final ? "final" : "delta",
    message: body,
    observedAt: "2026-09-18T00:00:00Z",
  };
}

test("native provider snapshots append only new text and old replays cannot overwrite newer content", () => {
  const { db, v2, writer } = setup();
  try {
    const first = writer.append(snapshot("hello"));
    writer.append(snapshot("hello 🌏"));
    const seq = v2.head("thread").lastSeq;
    const restarted = new ConversationV2RuntimeWriter(db, v2);
    expect(restarted.append(snapshot("hello"))).toMatchObject({
      duplicate: true,
      event: { sequence: first.event.sequence },
    });
    expect(v2.head("thread").lastSeq).toBe(seq);
    expect(v2.bootstrap("thread").messages[0]?.body).toBe("hello 🌏");
    expect(
      db.prepare("SELECT type, payload_json FROM conversation_events_v2 WHERE type = 'message.delta'").all(),
    ).toEqual([
      {
        type: "message.delta",
        payload_json: JSON.stringify({ baseContentVersion: 0, nextContentVersion: 1, delta: " 🌏" }),
      },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'thread_%'").all()).toEqual([]);
    v2.rebuildReadModels("thread");
    expect(v2.bootstrap("thread").messages[0]?.body).toBe("hello 🌏");
  } finally {
    db.close();
  }
});

test("SDK informational notices without a tag remain valid after runtime ingestion and restart", () => {
  const { db, v2, writer } = setup();
  try {
    const notice: ThreadRunEventInput = {
      threadId: "thread",
      id: "sdk-warning",
      runAttemptId: "run",
      eventType: "diagnostic",
      scope: "main",
      role: "system",
      streamState: "none",
      message: "Provider warning",
      observedAt: "2026-10-12T06:10:12.033Z",
      metadata: {
        activityOrigin: "sdk.informational",
        level: "warning",
        tag: undefined,
        liveType: "sdk.notice",
      },
    };
    const first = writer.append(notice);
    const headSeq = v2.head("thread").lastSeq;
    expect(v2.validateIntegrity("thread").headSeq).toBe(headSeq);
    const restarted = new ConversationV2Store(db);
    restarted.initialize();
    expect(new ConversationV2RuntimeWriter(db, restarted).append(notice)).toMatchObject({
      duplicate: true,
      event: { sequence: first.event.sequence },
    });
    restarted.rebuildReadModels("thread");
    expect(restarted.bootstrap("thread").messages[0]?.body).toBe("Provider warning");
    expect(restarted.validateIntegrity("thread").headSeq).toBe(headSeq);
  } finally {
    db.close();
  }
});

test("runtime prompts keep provisional rewind ids out of the immutable message target", () => {
  const { db, v2, writer } = setup();
  try {
    v2.append({
      conversationId: "thread",
      eventId: "codex-pending-message",
      sourceEventKey: "desktop:user:codex:pending-message",
      type: "message.created",
      occurredAt: "2026-09-18T00:00:00Z",
      turnId: "turn",
      messageId: "message_user_pending",
      payload: { role: "user", body: "bind after the SDK item arrives", status: "final" },
    });
    writer.append({
      threadId: "thread",
      id: "codex-prompt-source",
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "bind after the SDK item arrives",
      observedAt: "2026-09-18T00:00:01Z",
      metadata: {
        liveType: "thread.user_prompt",
        conversationV2MessageId: "message_user_pending",
        rewindTarget: { activityLineId: "codex-pending:one" },
      },
    });

    expect(v2.getMessage("thread", "message_user_pending")?.historyTarget).toBeUndefined();
  } finally {
    db.close();
  }
});

test("runtime final empty text replaces the draft instead of silently keeping it", () => {
  const { db, v2, writer } = setup();
  try {
    writer.append(snapshot("discarded draft"));
    writer.append(snapshot("", true));
    expect(v2.bootstrap("thread").messages[0]).toMatchObject({ body: "", status: "final" });
    v2.rebuildReadModels("thread");
    expect(v2.bootstrap("thread").messages[0]).toMatchObject({ body: "", status: "final" });
  } finally {
    db.close();
  }
});

test("receipt and normalized facts roll back together when receipt storage fails", () => {
  const { db, v2, writer } = setup();
  try {
    db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON conversation_events_v2
      WHEN json_extract(NEW.payload_json, '$.reason') = 'runtime.input'
      BEGIN SELECT RAISE(ABORT, 'disk-write-failure'); END`);
    expect(() => writer.append(snapshot("hello"))).toThrow(/disk-write-failure/);
    expect(v2.head("thread").lastSeq).toBe(1);
    expect(v2.bootstrap("thread").messages).toEqual([]);
    db.exec("DROP TRIGGER fail_receipt");
    expect(writer.append(snapshot("hello")).duplicate).toBe(false);
    expect(v2.validateIntegrity("thread").headSeq).toBe(3);
  } finally {
    db.close();
  }
});

test("runtime append preserves SQLITE_FULL and leaves the V2 cursor unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-runtime-sqlite-full-"));
  const filename = join(dir, "store.sqlite");
  const db = new DatabaseSync(filename);
  try {
    const v2 = new ConversationV2Store(db);
    v2.initialize();
    v2.ensureConversation("thread");
    v2.append({
      conversationId: "thread",
      eventId: "run-start",
      runId: "run",
      turnId: "run",
      type: "run.started",
      occurredAt: "2026-09-18T00:00:00Z",
      payload: { status: "running" },
    });
    const writer = new ConversationV2RuntimeWriter(db, v2);

    db.exec("VACUUM");
    const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
    const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
    expect(
      Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count),
    ).toBe(0);
    db.exec(`PRAGMA max_page_count = ${pageCount}`);

    expect(() => writer.append(snapshot("x".repeat(pageSize * 4)))).toThrow(/full|disk/i);
    expect(v2.head("thread").lastSeq).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_events_v2").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_sync_effects_v2").get()).toEqual({
      count: 1,
    });
  } finally {
    db.close();
    await removeTempDirectory(dir);
  }
});

test("native tools require explicit run ownership and never invent synthetic runs", () => {
  const { db, v2, writer } = setup();
  try {
    const tool: ThreadRunEventInput = {
      threadId: "thread",
      id: "tool",
      eventType: "tool.started",
      role: "tool",
      scope: "main",
      streamState: "final",
      message: "Read",
      observedAt: "2026-09-18T00:00:00Z",
      metadata: { tool: { toolUseId: "call", name: "Read", input: { path: "/file" } } },
    };
    expect(() => writer.append(tool)).toThrow(/explicit runAttemptId/);
    expect(v2.head("thread").lastSeq).toBe(1);
    writer.append({ ...tool, runAttemptId: "run" });
    expect(v2.bootstrap("thread").runs).toEqual([
      expect.objectContaining({ runId: "run", status: "running" }),
    ]);
    expect(
      db.prepare("SELECT run_id, name FROM conversation_tool_calls_v2 WHERE tool_call_id = ?").get("call"),
    ).toEqual({ run_id: "run", name: "Read" });
  } finally {
    db.close();
  }
});

test("a codemode script's own calls keep the script as their parent tool", () => {
  const { db, v2, writer } = setup();
  try {
    writer.append({
      threadId: "thread",
      id: "script-start",
      runAttemptId: "run",
      eventType: "tool.started",
      role: "tool",
      scope: "main",
      streamState: "final",
      message: "Tool: codemode",
      observedAt: "2026-09-18T00:00:01Z",
      metadata: { tool: { toolUseId: "code_1", name: "codemode", input: { code: "tools.bash({});" } } },
    });
    // PI issues the nested call itself and names the script as its parent. The link must reach the
    // tool row, or the Feed counts the script's own calls as commands the model issued.
    writer.append({
      threadId: "thread",
      id: "nested-start",
      runAttemptId: "run",
      eventType: "tool.started",
      role: "tool",
      scope: "main",
      streamState: "final",
      message: "Tool: Bash",
      observedAt: "2026-09-18T00:00:02Z",
      metadata: {
        tool: {
          toolUseId: "code_1/1",
          name: "Bash",
          input: { command: "echo one" },
          parentToolCallId: "code_1",
        },
      },
    });
    writer.append({
      threadId: "thread",
      id: "nested-end",
      runAttemptId: "run",
      eventType: "tool.completed",
      role: "tool",
      scope: "main",
      streamState: "final",
      message: "Tool: Bash",
      observedAt: "2026-09-18T00:00:03Z",
      metadata: { tool: { toolUseId: "code_1/1", name: "Bash", outputPreview: "one", parentToolCallId: "code_1" } },
    });
    expect(
      db
        .prepare(
          "SELECT tool_call_id, parent_tool_call_id, status FROM conversation_tool_calls_v2 ORDER BY tool_call_id",
        )
        .all(),
    ).toEqual([
      { tool_call_id: "code_1", parent_tool_call_id: null, status: "running" },
      { tool_call_id: "code_1/1", parent_tool_call_id: "code_1", status: "completed" },
    ]);
  } finally {
    db.close();
  }
});

test("the store's own append keeps a codemode call's link to the script that made it", () => {
  // The live chain appends through ConversationStore, which sanitizes tool metadata field by field
  // before the writer sees it. A link that survives the writer but not the sanitizer never reaches
  // the row, and the Feed reads the script's own calls as commands the model issued.
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationStore(db, { freshStorageMode: "v2_only" });
    store.initialize();
    store.conversationV2().ensureConversation("thread");
    store.upsertRunAttempt({
      threadId: "thread",
      attemptId: "run",
      phase: "execution",
      retryIndex: 0,
      status: "running",
      startedAt: "2026-09-18T00:00:00Z",
    });
    store.appendConversationRuntimeEvent({
      threadId: "thread",
      id: "script-end",
      runAttemptId: "run",
      eventType: "tool.completed",
      role: "tool",
      scope: "main",
      streamState: "final",
      message: "Tool: codemode",
      observedAt: "2026-09-18T00:00:02Z",
      metadata: { tool: { toolUseId: "code_1", name: "codemode", outputPreview: "one" } },
    });
    store.appendConversationRuntimeEvent({
      threadId: "thread",
      id: "nested-end",
      runAttemptId: "run",
      eventType: "tool.completed",
      role: "tool",
      scope: "main",
      streamState: "final",
      message: "Tool: Bash",
      observedAt: "2026-09-18T00:00:03Z",
      metadata: { tool: { toolUseId: "code_1/1", name: "Bash", outputPreview: "one", parentToolCallId: "code_1" } },
    });
    expect(
      db
        .prepare(
          "SELECT tool_call_id, parent_tool_call_id FROM conversation_tool_calls_v2 ORDER BY tool_call_id",
        )
        .all(),
    ).toEqual([
      { tool_call_id: "code_1", parent_tool_call_id: null },
      { tool_call_id: "code_1/1", parent_tool_call_id: "code_1" },
    ]);
  } finally {
    db.close();
  }
});

test("a child lifecycle terminal event keeps its original run and role after the parent starts another run", () => {
  const { db, v2, writer } = setup();
  try {
    v2.append({
      conversationId: "thread",
      eventId: "agent-start",
      type: "agent.started",
      occurredAt: "2026-09-18T00:00:01Z",
      runId: "run",
      agentId: "child",
      agentInstanceId: "child",
      parentToolCallId: "spawn-call",
      payload: { role: "explore", kind: "subagent", status: "running" },
    });
    v2.append({
      conversationId: "thread",
      eventId: "next-run-start",
      type: "run.started",
      occurredAt: "2026-09-18T00:01:00Z",
      runId: "next-run",
      turnId: "next-run",
      payload: { status: "running" },
    });
    const stopped: ThreadRunEventInput = {
      threadId: "thread",
      id: "child-stopped",
      eventType: "agent.stopped",
      role: "general",
      agentId: "child",
      parentToolUseId: "spawn-call",
      runAttemptId: "next-run",
      scope: "agent",
      streamState: "finalized",
      message: "",
      observedAt: "2026-09-18T00:01:01Z",
    };

    expect(writer.append(stopped).event).toMatchObject({
      runAttemptId: "run",
      role: "explore",
      metadata: { reportedRunAttemptId: "next-run", reportedRole: "general" },
    });
    expect(v2.agentsOf("thread")[0]).toMatchObject({
      agentId: "child",
      runId: "run",
      role: "explore",
      status: "completed",
    });
    const head = v2.head("thread").lastSeq;
    expect(writer.append(stopped).duplicate).toBe(true);
    expect(v2.head("thread").lastSeq).toBe(head);
    v2.rebuildReadModels("thread");
    expect(v2.agentsOf("thread")[0]).toMatchObject({ runId: "run", role: "explore", status: "completed" });

    expect(() => writer.append({ ...stopped, id: "wrong-parent", parentToolUseId: "another-call" })).toThrow(
      /changed identity or ownership/,
    );
    expect(v2.head("thread").lastSeq).toBe(head);
  } finally {
    db.close();
  }
});

test("a runless agent terminal event does not acquire the parent's current run", () => {
  const { db, v2, writer } = setup();
  try {
    v2.append({
      conversationId: "thread",
      eventId: "runless-agent-start",
      type: "agent.started",
      occurredAt: "2026-09-18T00:00:01Z",
      agentId: "runless-child",
      agentInstanceId: "runless-child",
      payload: { role: "explore", kind: "subagent", status: "running" },
    });
    const stopped = writer.append({
      threadId: "thread",
      id: "runless-child-stopped",
      eventType: "agent.stopped",
      agentId: "runless-child",
      role: "explore",
      runAttemptId: "run",
      scope: "agent",
      streamState: "finalized",
      message: "",
      observedAt: "2026-09-18T00:00:02Z",
    });
    expect(stopped.event.runAttemptId).toBeUndefined();
    expect(stopped.event.metadata).toMatchObject({ reportedRunAttemptId: "run" });
    expect(v2.agentsOf("thread")[0]).toMatchObject({ agentId: "runless-child", status: "completed" });
    expect(v2.agentsOf("thread")[0]?.runId).toBeUndefined();
  } finally {
    db.close();
  }
});

test("late Codex tool terminal events recover their run from the persisted turn correlation", () => {
  const { db, v2, writer } = setup();
  try {
    const started: ThreadRunEventInput = {
      threadId: "thread",
      id: "codex-tool-started",
      eventType: "tool.started",
      role: "tool",
      scope: "main",
      streamState: "streaming",
      message: "Read",
      observedAt: "2026-09-18T00:00:00Z",
      runAttemptId: "run",
      requestId: "codex-turn",
      streamKey: "call_1",
      metadata: { tool: { toolUseId: "call_1", name: "Read", input: { path: "/file" } } },
    };
    writer.append(started);
    writer.append({
      ...started,
      id: "codex-tool-completed",
      eventType: "tool.completed",
      streamState: "finalized",
      runAttemptId: undefined,
      metadata: {
        ...started.metadata,
        tool: { toolUseId: "call_1", name: "Read", output: "done" },
      },
    });

    expect(
      db
        .prepare(
          `SELECT run_attempt_id FROM conversation_provider_events_v2
           WHERE id = 'codex-tool-completed'`,
        )
        .get(),
    ).toEqual({ run_attempt_id: "run" });
    expect(v2.bootstrap("thread").tools).toEqual([
      expect.objectContaining({ toolCallId: "call_1", runId: "run", status: "completed" }),
    ]);
  } finally {
    db.close();
  }
});

test("the store native API reopens and rebuilds source identities without any V1 schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-native-writer-"));
  const filename = join(dir, "store.sqlite");
  let db = new DatabaseSync(filename);
  try {
    let store = new ConversationStore(db);
    store.conversationV2().ensureConversation("thread");
    store.upsertRunAttempt({
      threadId: "thread",
      attemptId: "run",
      phase: "execution",
      retryIndex: 0,
      status: "running",
      startedAt: "2026-09-18T00:00:00Z",
    });
    store.appendConversationRuntimeEvent(snapshot("hello"));
    const accepted = store.appendConversationRuntimeEvent(snapshot("hello 🌏", true));
    db.close();
    db = new DatabaseSync(filename);
    store = new ConversationStore(db);
    store.conversationV2().rebuildReadModels("thread");
    expect(store.listConversationRuntimeSources("thread")).toEqual([
      expect.objectContaining({
        id: "provider-stream",
        message: "hello 🌏",
        sequence: accepted.sequence,
        eventType: "message.final",
        runAttemptId: "run",
      }),
    ]);
    expect(store.appendConversationRuntimeEvent(snapshot("hello 🌏", true)).sequence).toBe(accepted.sequence);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'thread_%'").all()).toEqual([]);
  } finally {
    db.close();
    await removeTempDirectory(dir);
  }
});

test("the production ConversationStore runtime boundary leaves the V1 event table untouched", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationStore(db);
    store.initialize();
    store.conversationV2().ensureConversation("thread");
    store.upsertRunAttempt({
      threadId: "thread",
      attemptId: "run",
      phase: "execution",
      retryIndex: 0,
      status: "running",
      startedAt: "2026-09-18T00:00:00Z",
    });
    store.appendConversationRuntimeEvent(snapshot("live"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM thread_run_events").get()).toEqual({ count: 0 });
    expect(store.listConversationRuntimeSources("thread")[0]).toMatchObject({
      id: "provider-stream",
      message: "live",
    });
  } finally {
    db.close();
  }
});

test("startup reconciliation closes active tools on terminal runs in a V2-only database", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationStore(db, {
      freshStorageMode: "v2_only",
      requiredStorageMode: "v2_only",
    });
    store.initialize();
    const v2 = store.conversationV2();
    v2.append({
      conversationId: "thread_recovered_tool",
      eventId: "run_started",
      type: "run.started",
      occurredAt: "2026-09-18T00:00:00Z",
      turnId: "run_recovered",
      runId: "run_recovered",
      payload: { status: "running" },
    });
    v2.append({
      conversationId: "thread_recovered_tool",
      eventId: "tool_started",
      type: "tool.started",
      occurredAt: "2026-09-18T00:00:01Z",
      runId: "run_recovered",
      toolCallId: "call_recovered",
      payload: { name: "Bash", status: "running", input: { command: "echo safe" } },
    });
    v2.append({
      conversationId: "thread_recovered_tool",
      eventId: "run_failed",
      type: "run.failed",
      occurredAt: "2026-09-18T00:00:02Z",
      turnId: "run_recovered",
      runId: "run_recovered",
      payload: { status: "failed" },
    });

    expect(store.reconcileAllConversationV2TerminalRunTools()).toEqual({
      conversations: 1,
      scanned: 1,
      settled: 1,
    });
    expect(v2.getTool("thread_recovered_tool", "call_recovered")).toMatchObject({
      status: "failed",
      input: { command: "echo safe" },
    });
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'thread_run_events'`).get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});

test("doubling cumulative output grows event and effect storage linearly", () => {
  function bytes(count: number): number {
    const { db, writer } = setup();
    try {
      let body = "";
      for (let i = 0; i < count; i += 1) {
        body += "x".repeat(1000);
        writer.append(snapshot(body));
      }
      return Number(
        (
          db
            .prepare(`SELECT
        (SELECT SUM(LENGTH(payload_json)) FROM conversation_events_v2) +
        (SELECT SUM(LENGTH(effect_json)) FROM conversation_sync_effects_v2) AS bytes`)
            .get() as { bytes: number }
        ).bytes,
      );
    } finally {
      db.close();
    }
  }
  const small = bytes(100);
  const large = bytes(200);
  expect(large / small).toBeLessThan(2.2);
});

test("a damaged input receipt is an integrity error, never a successful duplicate", () => {
  const { db, writer } = setup();
  try {
    const accepted = writer.append(snapshot("hello"));
    db.prepare("DELETE FROM conversation_sync_effects_v2 WHERE conversation_id = ? AND seq = ?").run(
      "thread",
      accepted.event.sequence,
    );
    expect(() => writer.append(snapshot("hello"))).toThrow(/event\/effect counts do not match/);
  } finally {
    db.close();
  }
});

test("history invalidation hides provider identities and rejects late resurrection after rebuild", () => {
  const { db, v2, writer } = setup();
  try {
    writer.append(snapshot("before rewind"));
    const messageId = v2.bootstrap("thread").messages[0]!.messageId;
    db.exec("BEGIN IMMEDIATE");
    const results = v2.appendHistoryRewriteInCurrentTransaction({
      conversationId: "thread",
      eventId: "rewind",
      sourceEventKey: "rewind",
      occurredAt: "2026-09-18T00:00:01Z",
      type: "history.deleted",
      affectedMessageIds: [messageId],
      affectedProviderInputIds: ["provider-stream"],
      reason: "rewind",
    });
    db.exec("COMMIT");
    v2.publishCommitted(results);
    for (const rebuild of [false, true]) {
      if (rebuild) v2.rebuildReadModels("thread");
      expect(db.prepare("SELECT * FROM conversation_provider_events_v2").all()).toHaveLength(0);
      const head = v2.head("thread").lastSeq;
      expect(writer.append(snapshot("before rewind")).duplicate).toBe(true);
      expect(() => writer.append(snapshot("late result", true))).toThrow(/late updates are rejected/);
      expect(v2.head("thread").lastSeq).toBe(head);
    }
  } finally {
    db.close();
  }
});

/**
 * `tool.writing` is a real runtime fact ("the model is writing this call") that must be
 * durable enough for the projection to read, but it is not a tool. If it ever landed as a
 * tool row the Feed would show an empty card for a call that has not been made yet.
 */
test("a tool-writing fact persists for the projection without inventing a tool row", () => {
  const { db, v2, writer } = setup();
  try {
    writer.append({
      threadId: "thread",
      id: "writing-fact",
      runAttemptId: "run",
      requestId: "req_1",
      eventType: "tool.writing",
      scope: "main",
      role: "tool",
      streamState: "none",
      message: "create_file",
      observedAt: "2026-09-18T00:00:01Z",
      metadata: { liveType: "tool.writing" },
    });

    // Readable back as a runtime source, which is what the projection consumes.
    const sources = db
      .prepare("SELECT event_type, message FROM conversation_provider_events_v2 ORDER BY sequence ASC")
      .all() as unknown as Array<{ event_type: string; message: string }>;
    expect(sources).toEqual([{ event_type: "tool.writing", message: "create_file" }]);

    // No tool summary, no message body, nothing the Feed can render as a card.
    expect(db.prepare("SELECT tool_call_id FROM conversation_tool_calls_v2").all()).toEqual([]);
    expect(v2.bootstrap("thread").messages).toHaveLength(0);
    expect(
      db
        .prepare("SELECT type FROM conversation_events_v2 WHERE type IN ('tool.started','tool.updated')")
        .all(),
    ).toEqual([]);

    // Replaying the same fact is a duplicate, not a second row.
    expect(
      writer.append({
        threadId: "thread",
        id: "writing-fact",
        runAttemptId: "run",
        requestId: "req_1",
        eventType: "tool.writing",
        scope: "main",
        role: "tool",
        streamState: "none",
        message: "create_file",
        observedAt: "2026-09-18T00:00:01Z",
        metadata: { liveType: "tool.writing" },
      }).duplicate,
    ).toBe(true);
    expect(db.prepare("SELECT * FROM conversation_provider_events_v2").all()).toHaveLength(1);
  } finally {
    db.close();
  }
});
