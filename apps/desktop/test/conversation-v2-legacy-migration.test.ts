import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationEventInput } from "@eco/shared";
import { removeTempDirectory } from "./helpers/temp-directory";
import { ConversationV2LegacyMigrator } from "../src/main/conversation-v2-legacy-migration";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { PromptImageFileStore } from "../src/main/prompt-image-file-store";
import {
  applyConversationV2Effects,
  installConversationV2Bootstrap,
} from "../src/renderer/conversation-v2-renderer-state";

function createLegacyDatabase(filename = ":memory:"): {
  db: DatabaseSync;
  store: ConversationV2Store;
} {
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE thread_user_messages (
      thread_id TEXT NOT NULL,
      activity_line_id TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE thread_run_events (
      id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      role TEXT,
      agent_id TEXT,
      run_attempt_id TEXT,
      request_id TEXT,
      stream_key TEXT,
      stream_state TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE thread_coder_todos (
      id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL,
      position INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const store = new ConversationV2Store(db, {
    idFactory: (() => {
      let n = 0;
      return () => `id_${++n}`;
    })(),
    now: () => "2026-09-14T00:00:00.000Z",
  });
  store.initialize();
  return { db, store };
}

class FailOnceConversationV2Store extends ConversationV2Store {
  failLegacyEventId = "legacy_2";

  override appendInCurrentTransaction(input: ConversationEventInput) {
    if (this.failLegacyEventId && input.sourceEventKey?.includes(`:${this.failLegacyEventId}:`)) {
      this.failLegacyEventId = "";
      throw new Error("injected migration interruption");
    }
    return super.appendInCurrentTransaction(input);
  }
}

test("dry-runs, migrates, resumes and deduplicates legacy rows", () => {
  const { db, store } = createLegacyDatabase();
  db.prepare(
    `INSERT INTO thread_user_messages
      (thread_id, activity_line_id, text, attachments_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("thread_migrate", "line_1", "Please migrate me", "[]", "2026-09-14T00:00:00.000Z");

  const insertEvent = db.prepare(
    `INSERT INTO thread_run_events
      (id, thread_id, sequence, event_type, scope, role, agent_id, run_attempt_id,
       request_id, stream_key, stream_state, message, metadata_json, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run(
    "legacy_1",
    "thread_migrate",
    1,
    "message.delta",
    "main",
    "assistant",
    null,
    "run_1",
    "request_1",
    "answer_1",
    "streaming",
    "Hello",
    null,
    "2026-09-14T00:00:01.000Z",
  );
  insertEvent.run(
    "legacy_2",
    "thread_migrate",
    2,
    "message.final",
    "main",
    "assistant",
    null,
    "run_1",
    "request_1",
    "answer_1",
    "finalized",
    "Hello world",
    null,
    "2026-09-14T00:00:02.000Z",
  );
  insertEvent.run(
    "legacy_3",
    "thread_migrate",
    3,
    "diagnostic",
    "main",
    null,
    null,
    null,
    null,
    null,
    "none",
    "legacy-only diagnostic",
    null,
    "2026-09-14T00:00:03.000Z",
  );
  db.prepare(
    `INSERT INTO thread_coder_todos
      (id, thread_id, title, detail, status, position, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("todo_legacy", "thread_migrate", "Migrate todos", "Use V2", "running", 0, "2026-09-14T00:00:04.000Z");

  const migrator = new ConversationV2LegacyMigrator(db, store, () => "2026-09-14T00:01:00.000Z");
  const dryRun = migrator.inspect("thread_migrate");
  expect(dryRun).toMatchObject({
    canMigrate: true,
    userMessageCount: 1,
    legacyEventCount: 3,
    unmappedEventTypes: ["diagnostic"],
  });

  const completed = migrator.migrate("thread_migrate");
  expect(completed).toMatchObject({
    phase: "completed",
    emittedEventCount: 9,
    noopEventCount: 4,
  });
  expect(store.head("thread_migrate").lastSeq).toBe(9);
  expect(store.bootstrap("thread_migrate").messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        body: "Please migrate me",
        status: "final",
      }),
      expect.objectContaining({
        role: "assistant",
        body: "Hello world",
        status: "final",
      }),
    ]),
  );
  expect(store.bootstrap("thread_migrate").todos).toEqual([
    expect.objectContaining({
      todoId: "todo_legacy",
      title: "Migrate todos",
      status: "running",
      versionSeq: 9,
    }),
  ]);
  expect(store.validateIntegrity("thread_migrate")).toEqual({
    headSeq: 9,
    eventCount: 9,
    effectCount: 9,
  });

  const rerun = migrator.migrate("thread_migrate");
  expect(rerun).toEqual(completed);
  expect(store.head("thread_migrate").lastSeq).toBe(9);
  const sources = () =>
    db
      .prepare(`SELECT id, event_type, message, metadata_json
    FROM conversation_provider_events_v2 WHERE thread_id = ? ORDER BY sequence`)
      .all("thread_migrate");
  const before = sources();
  expect(before).toHaveLength(3);
  expect(before[2]).toMatchObject({ id: "legacy_3", message: "legacy-only diagnostic" });
  expect(before[1]).toMatchObject({ id: "legacy_2", message: "Hello world" });
  db.exec("DROP TABLE thread_run_events; DROP TABLE thread_user_messages");
  store.rebuildReadModels("thread_migrate");
  expect(sources()).toEqual(before);
  db.close();
});

test("rejects malformed legacy payloads during dry-run", () => {
  const { db, store } = createLegacyDatabase();
  db.prepare(
    `INSERT INTO thread_user_messages
      (thread_id, activity_line_id, text, attachments_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("thread_bad", "line_bad", "bad", "{bad", "2026-09-14T00:00:00.000Z");
  const migrator = new ConversationV2LegacyMigrator(db, store);
  const report = migrator.inspect("thread_bad");
  expect(report.canMigrate).toBe(false);
  expect(report.missingFields).toContain("user_message:line_bad:attachments_json");
  db.close();
});

test("requires and materializes a durable object for legacy image migration", async () => {
  const { db, store } = createLegacyDatabase();
  const directory = await mkdtemp(join(tmpdir(), "eco-v2-legacy-image-"));
  try {
    db.prepare(
      `INSERT INTO thread_user_messages
        (thread_id, activity_line_id, text, attachments_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "thread_image_migrate",
      "line_image",
      "migrate image",
      JSON.stringify([{ mediaType: "image/png", data: Buffer.from("legacy").toString("base64") }]),
      "2026-09-14T00:00:00.000Z",
    );
    const migrator = new ConversationV2LegacyMigrator(
      db,
      store,
      () => "2026-09-14T00:01:00.000Z",
      new PromptImageFileStore(directory),
    );
    expect(migrator.inspect("thread_image_migrate").canMigrate).toBe(true);
    migrator.migrate("thread_image_migrate");

    const message = store
      .bootstrap("thread_image_migrate")
      .messages.find((candidate) => candidate.body === "migrate image");
    expect(message?.attachments).toEqual([
      {
        mediaType: "image/png",
        contentRef: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        byteLength: 6,
      },
    ]);
    expect(message?.attachments?.[0]).not.toHaveProperty("path");
    expect(message?.attachments?.[0]).not.toHaveProperty("data");
  } finally {
    db.close();
    await removeTempDirectory(directory);
  }
});

test("blocks legacy image migration when no durable object store is configured", () => {
  const { db, store } = createLegacyDatabase();
  db.prepare(
    `INSERT INTO thread_user_messages
      (thread_id, activity_line_id, text, attachments_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "thread_image_without_store",
    "line_image",
    "must block",
    JSON.stringify([{ mediaType: "image/png", data: Buffer.from("legacy").toString("base64") }]),
    "2026-09-14T00:00:00.000Z",
  );
  const report = new ConversationV2LegacyMigrator(db, store).inspect("thread_image_without_store");
  expect(report.canMigrate).toBe(false);
  expect(report.missingFields).toContain("user_message:line_image:durable_attachments");
  db.close();
});

test("sanitizes legacy non-image attachments without retaining path or inline bytes", async () => {
  const { db, store } = createLegacyDatabase();
  const directory = await mkdtemp(join(tmpdir(), "eco-v2-legacy-opaque-"));
  try {
    await mkdir(join(directory, "messages"), { recursive: true });
    await writeFile(join(directory, "messages", "attachment.bin"), Buffer.from("opaque legacy"));
    db.prepare(
      `INSERT INTO thread_user_messages
        (thread_id, activity_line_id, text, attachments_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "thread_opaque_migrate",
      "line_opaque",
      "migrate opaque attachment",
      JSON.stringify([
        { id: "legacy_1", mediaType: "application/octet-stream", path: "messages/attachment.bin" },
      ]),
      "2026-09-14T00:00:00.000Z",
    );
    const migrator = new ConversationV2LegacyMigrator(
      db,
      store,
      () => "2026-09-14T00:01:00.000Z",
      new PromptImageFileStore(directory, { rootDir: directory }),
    );
    const inspection = migrator.inspect("thread_opaque_migrate");
    expect(inspection.canMigrate).toBe(true);
    migrator.migrate("thread_opaque_migrate");

    const message = store
      .bootstrap("thread_opaque_migrate")
      .messages.find((candidate) => candidate.body === "migrate opaque attachment");
    expect(message?.attachments).toEqual([
      {
        id: "legacy_1",
        mediaType: "application/octet-stream",
        byteLength: 13,
        legacyOpaque: true,
      },
    ]);
    expect(message?.attachments?.[0]).not.toHaveProperty("path");
    expect(message?.attachments?.[0]).not.toHaveProperty("data");
  } finally {
    db.close();
    await removeTempDirectory(directory);
  }
});

test("resumes from the durable migration checkpoint after an interruption", () => {
  const { db } = createLegacyDatabase();
  const store = new FailOnceConversationV2Store(db, {
    idFactory: (() => {
      let n = 0;
      return () => `id_${++n}`;
    })(),
    now: () => "2026-09-14T00:00:00.000Z",
  });
  store.initialize();
  const insertEvent = db.prepare(
    `INSERT INTO thread_run_events
      (id, thread_id, sequence, event_type, scope, role, agent_id, run_attempt_id,
       request_id, stream_key, stream_state, message, metadata_json, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [id, sequence] of [
    ["legacy_1", 1],
    ["legacy_2", 2],
  ] as const) {
    insertEvent.run(
      id,
      "thread_resume",
      sequence,
      "diagnostic",
      "main",
      null,
      null,
      null,
      null,
      null,
      "none",
      id,
      null,
      `2026-09-14T00:00:0${sequence}.000Z`,
    );
  }

  const migrator = new ConversationV2LegacyMigrator(db, store);
  expect(() => migrator.migrate("thread_resume")).toThrow("injected migration interruption");
  expect(
    db
      .prepare(`SELECT phase, checkpoint FROM conversation_migrations_v2 WHERE conversation_id = ?`)
      .get("thread_resume"),
  ).toMatchObject({ phase: "failed", checkpoint: "1" });

  const completed = migrator.migrate("thread_resume");
  expect(completed).toMatchObject({
    phase: "completed",
    emittedEventCount: 4,
    noopEventCount: 4,
  });
  expect(store.head("thread_resume").lastSeq).toBe(4);
  db.close();
});

test("reports ambiguous legacy ordering instead of choosing a row", () => {
  const { db, store } = createLegacyDatabase();
  const insertEvent = db.prepare(
    `INSERT INTO thread_run_events
      (id, thread_id, sequence, event_type, scope, role, agent_id, run_attempt_id,
       request_id, stream_key, stream_state, message, metadata_json, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const args = [
    "thread_conflict",
    1,
    "diagnostic",
    "main",
    null,
    null,
    null,
    null,
    null,
    "none",
    "diagnostic",
    null,
    "2026-09-14T00:00:00.000Z",
  ];
  insertEvent.run("legacy_a", ...args);
  insertEvent.run("legacy_b", ...args);
  const report = new ConversationV2LegacyMigrator(db, store).inspect("thread_conflict");
  expect(report.canMigrate).toBe(false);
  expect(report.conflicts).toContain("duplicate_sequence:1");
  db.close();
});

test("seeds one V2 run per legacy attempt and keeps the seed idempotent", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE thread_user_messages (
      thread_id TEXT NOT NULL,
      activity_line_id TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE thread_run_events (
      id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      role TEXT,
      agent_id TEXT,
      run_attempt_id TEXT,
      request_id TEXT,
      stream_key TEXT,
      stream_state TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE thread_run_attempts (
      thread_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      retry_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      metadata_json TEXT,
      PRIMARY KEY (thread_id, attempt_id)
    );
  `);
  const insertAttempt = db.prepare(
    `INSERT INTO thread_run_attempts
       (thread_id, attempt_id, phase, retry_index, status, started_at, ended_at, metadata_json)
     VALUES (?, ?, 'execution', 0, ?, ?, ?, NULL)`,
  );
  insertAttempt.run(
    "thread_attempts",
    "attempt_1",
    "completed",
    "2026-09-14T00:00:00.000Z",
    "2026-09-14T00:05:00.000Z",
  );
  insertAttempt.run(
    "thread_attempts",
    "attempt_2",
    "failed",
    "2026-09-14T00:10:00.000Z",
    "2026-09-14T00:12:00.000Z",
  );
  const store = new ConversationV2Store(db, {
    idFactory: (() => {
      let n = 0;
      return () => `id_${++n}`;
    })(),
    now: () => "2026-09-14T00:00:00.000Z",
  });
  store.initialize();
  const migrator = new ConversationV2LegacyMigrator(db, store, () => "2026-09-14T00:20:00.000Z");

  expect(migrator.inspect("thread_attempts")).toMatchObject({
    canMigrate: true,
    runAttemptCount: 2,
    legacyEventCount: 0,
    userMessageCount: 0,
  });
  expect(migrator.migrate("thread_attempts")).toMatchObject({
    phase: "completed",
    runAttemptCount: 2,
    emittedEventCount: 2,
  });
  // One run per attempt and nothing else: the main agent is *not* a card (the Feed
  // renders `kind === "subagent"` only), so seeding a planner agent here would add
  // registry rows that no view ever shows.
  expect(store.bootstrap("thread_attempts").agents).toEqual([]);
  // The runs carry the attempt's own boundaries: this is the only place a run's
  // status and duration come from, and V2-only clients read runs and nothing else.
  expect(
    store
      .bootstrap("thread_attempts")
      .runs.map((run) => `${run.runId}:${run.status}:${run.endedAt}`)
      .sort(),
  ).toEqual(["attempt_1:completed:2026-09-14T00:05:00.000Z", "attempt_2:failed:2026-09-14T00:12:00.000Z"]);
  expect(store.bootstrap("thread_attempts").runs[0]?.timingQuality).toBe("recorded");

  // A resumed migration re-seeds and must not append a second run per attempt.
  const lastSeq = store.head("thread_attempts").lastSeq;
  db.prepare(`UPDATE conversation_migrations_v2 SET phase = 'failed' WHERE conversation_id = ?`).run(
    "thread_attempts",
  );
  expect(migrator.migrate("thread_attempts")).toMatchObject({
    phase: "completed",
    emittedEventCount: 2,
  });
  expect(store.head("thread_attempts").lastSeq).toBe(lastSeq);
  expect(store.validateIntegrity("thread_attempts")).toEqual({
    headSeq: lastSeq,
    eventCount: lastSeq,
    effectCount: lastSeq,
  });
  db.close();
});

test("migrates legacy agent instances into replayable agent effects", () => {
  const { db, store } = createLegacyDatabase();
  db.exec(`
    CREATE TABLE thread_agent_instances (
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      run_attempt_id TEXT,
      parent_agent_id TEXT,
      parent_tool_use_id TEXT,
      mission_key TEXT,
      todo_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      updated_at TEXT NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY (thread_id, agent_id)
    );
  `);
  db.prepare(
    `INSERT INTO thread_agent_instances
      (thread_id, agent_id, role, kind, status, run_attempt_id,
       parent_agent_id, parent_tool_use_id, mission_key, todo_id,
       started_at, ended_at, updated_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "thread_agents",
    "agent_1",
    "coder",
    "subagent",
    "completed",
    "run_1",
    "parent_agent_1",
    "parent_tool_1",
    "",
    "todo_1",
    "2026-09-14T00:00:01.000Z",
    "2026-09-14T00:00:05.000Z",
    "2026-09-14T00:00:05.000Z",
    JSON.stringify({
      taskName: "migration task",
      delegationSummary: "migration summary",
      delegationPrompt: "migration prompt",
    }),
  );

  const migrator = new ConversationV2LegacyMigrator(db, store);
  expect(migrator.inspect("thread_agents")).toMatchObject({
    canMigrate: true,
    agentInstanceCount: 1,
  });
  expect(migrator.migrate("thread_agents")).toMatchObject({
    phase: "completed",
    emittedEventCount: 1,
    agentInstanceCount: 1,
  });

  const bootstrap = store.bootstrap("thread_agents");
  expect(bootstrap.agents).toEqual([
    {
      agentId: "agent_1",
      conversationId: "thread_agents",
      role: "coder",
      kind: "subagent",
      status: "completed",
      runId: "run_1",
      parentAgentInstanceId: "parent_agent_1",
      parentToolCallId: "parent_tool_1",
      startedAt: "2026-09-14T00:00:01.000Z",
      endedAt: "2026-09-14T00:00:05.000Z",
      mission: "",
      taskName: "migration task",
      delegationSummary: "migration summary",
      delegationPrompt: "migration prompt",
      todoId: "todo_1",
      versionSeq: 1,
    },
  ]);
  const effects = store.sync("thread_agents", bootstrap.storeEpoch, 0).effects;
  expect(effects.map((effect) => effect.effect.type)).toEqual(["agent.upsert"]);
  const replay = applyConversationV2Effects(
    installConversationV2Bootstrap({
      ...bootstrap,
      snapshotSeq: 0,
      agents: [],
    }),
    effects,
  );
  expect([...replay.agents.values()]).toEqual(bootstrap.agents);

  const rerun = migrator.migrate("thread_agents");
  expect(rerun.emittedEventCount).toBe(1);
  expect(store.head("thread_agents").lastSeq).toBe(1);
  db.close();
});

test("resolves agent-scoped legacy rows from the registry seeded before provider events", () => {
  const { db, store } = createLegacyDatabase();
  db.exec(`
    CREATE TABLE thread_agent_instances (
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      run_attempt_id TEXT,
      parent_agent_id TEXT,
      parent_tool_use_id TEXT,
      mission_key TEXT,
      todo_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      updated_at TEXT NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY (thread_id, agent_id)
    );
  `);
  db.prepare(
    `INSERT INTO thread_agent_instances
      (thread_id, agent_id, role, kind, status, run_attempt_id,
       parent_agent_id, parent_tool_use_id, mission_key, todo_id,
       started_at, ended_at, updated_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "thread_agent_owner",
    "agent_coder",
    "coder",
    "subagent",
    "running",
    "run_agent",
    null,
    "call_agent",
    null,
    null,
    "2026-09-14T00:00:01.000Z",
    null,
    "2026-09-14T00:00:01.000Z",
    null,
  );
  db.prepare(
    `INSERT INTO thread_run_events
      (id, thread_id, sequence, event_type, scope, role, agent_id, run_attempt_id,
       request_id, stream_key, stream_state, message, metadata_json, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "legacy_agent_message",
    "thread_agent_owner",
    1,
    "message.final",
    "agent",
    "coder",
    null,
    "run_agent",
    "request_agent",
    "answer_agent",
    "finalized",
    "Subagent result",
    null,
    "2026-09-14T00:00:02.000Z",
  );

  const migrator = new ConversationV2LegacyMigrator(db, store);
  expect(migrator.migrate("thread_agent_owner")).toMatchObject({
    phase: "completed",
    emittedEventCount: 4,
  });
  expect(store.bootstrap("thread_agent_owner").messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        body: "Subagent result",
        agentId: "agent_coder",
        agentInstanceId: "agent_coder",
      }),
    ]),
  );
  db.close();
});

test("replays a legacy tool descriptor as tool.updated when an older V2 row is sparse", () => {
  const { db, store } = createLegacyDatabase();
  db.prepare(
    `INSERT INTO thread_run_events
      (id, thread_id, sequence, event_type, scope, role, agent_id, run_attempt_id,
       request_id, stream_key, stream_state, message, metadata_json, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "legacy_tool_sparse",
    "thread_tool_repair",
    1,
    "tool.completed",
    "main",
    "main",
    null,
    "run_tool_repair",
    "request_tool_repair",
    "tool_repair",
    "finalized",
    "Tool: Read · src/app.ts",
    JSON.stringify({
      liveType: "tool.completed",
      tool: {
        name: "Read",
        detail: "src/app.ts",
        toolUseId: "call_tool_repair",
        status: "completed",
      },
    }),
    "2026-09-14T00:00:01.000Z",
  );

  const migrator = new ConversationV2LegacyMigrator(db, store, () => "2026-09-14T00:01:00.000Z");
  const first = migrator.migrate("thread_tool_repair");
  const toolBefore = db
    .prepare(`SELECT tool_call_id, input_json FROM conversation_tool_calls_v2 WHERE conversation_id = ?`)
    .get("thread_tool_repair") as { tool_call_id: string; input_json: string | null };
  expect(toolBefore).toMatchObject({ tool_call_id: "call_tool_repair" });
  expect(toolBefore.input_json).not.toBeNull();

  // Simulate a V2 row produced by the older migration adapter: the immutable source
  // event still exists, but the read model lost its structured input during that run.
  db.prepare(`UPDATE conversation_tool_calls_v2 SET input_json = NULL WHERE tool_call_id = ?`).run(
    toolBefore.tool_call_id,
  );
  const second = migrator.migrate("thread_tool_repair");
  expect(second.emittedEventCount).toBe(first.emittedEventCount + 1);
  expect(
    db
      .prepare(
        `SELECT type, payload_json FROM conversation_events_v2
         WHERE conversation_id = ? AND type = 'tool.updated'`,
      )
      .get("thread_tool_repair"),
  ).toMatchObject({
    type: "tool.updated",
    payload_json: expect.stringContaining('"file_path":"src/app.ts"'),
  });
  expect(store.getTool("thread_tool_repair", "call_tool_repair").input).toMatchObject({
    file_path: "src/app.ts",
  });
  db.close();
});

test("creates a readable empty stream when a legacy conversation has no rows", () => {
  const { db, store } = createLegacyDatabase();
  const migrator = new ConversationV2LegacyMigrator(db, store);

  const completed = migrator.migrate("thread_empty");

  expect(completed).toMatchObject({
    phase: "completed",
    userMessageCount: 0,
    legacyEventCount: 0,
    emittedEventCount: 0,
  });
  expect(store.head("thread_empty").lastSeq).toBe(0);
  expect(store.bootstrap("thread_empty").messages).toEqual([]);
  expect(store.validateIntegrity("thread_empty")).toEqual({
    headSeq: 0,
    eventCount: 0,
    effectCount: 0,
  });
  db.close();
});

test("source fact, identity receipt and migration checkpoint commit atomically", () => {
  const { db, store } = createLegacyDatabase();
  try {
    db.exec(`INSERT INTO thread_run_events
      (id, thread_id, sequence, event_type, scope, stream_state, message, observed_at)
      VALUES ('source', 'atomic', 1, 'diagnostic', 'main', 'none', 'diagnostic text', '2026-09-18T00:00:00Z');
      CREATE TRIGGER reject_receipt BEFORE INSERT ON conversation_provider_inputs_v2
      BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;`);
    const migrator = new ConversationV2LegacyMigrator(db, store);
    expect(() => migrator.migrate("atomic")).toThrow(/injected receipt failure/);
    expect(store.head("atomic").lastSeq).toBe(0);
    expect(
      db
        .prepare(`SELECT phase, checkpoint FROM conversation_migrations_v2
      WHERE conversation_id = 'atomic'`)
        .get(),
    ).toMatchObject({ phase: "failed", checkpoint: "0" });
    db.exec("DROP TRIGGER reject_receipt");
    const completed = migrator.migrate("atomic");
    expect(completed).toMatchObject({ phase: "completed", emittedEventCount: 2, noopEventCount: 2 });
    const head = store.head("atomic").lastSeq;
    expect(migrator.migrate("atomic")).toEqual(completed);
    expect(store.head("atomic").lastSeq).toBe(head);
    db.exec("DELETE FROM conversation_provider_inputs_v2");
    expect(() => migrator.migrate("atomic")).toThrow(/missing V2 provider identities/);
    store.rebuildReadModels("atomic");
    expect(migrator.migrate("atomic")).toEqual(completed);
  } finally {
    db.close();
  }
});

test("migration preserves SQLITE_FULL and leaves the V2 cursor unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-migration-sqlite-full-"));
  const filename = join(dir, "store.sqlite");
  const { db, store } = createLegacyDatabase(filename);
  try {
    db.prepare(
      `INSERT INTO thread_run_events
        (id, thread_id, sequence, event_type, scope, stream_state, message, observed_at)
       VALUES (?, ?, 1, 'diagnostic', 'main', 'none', ?, '2026-09-18T00:00:00Z')`,
    ).run("legacy_full", "thread_full", "x".repeat(16 * 1024));
    store.ensureConversation("thread_full");
    const migrator = new ConversationV2LegacyMigrator(db, store);
    const report = migrator.inspect("thread_full");
    db.prepare(
      `INSERT INTO conversation_migrations_v2
        (migration_version, conversation_id, source_fingerprint, phase, checkpoint, validation_json, updated_at)
       VALUES (1, ?, ?, 'running', '0', '{}', '2026-09-18T00:00:00Z')`,
    ).run("thread_full", report.sourceFingerprint);
    db.exec("VACUUM");
    const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
    expect(
      Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count),
    ).toBe(0);
    db.exec(`PRAGMA max_page_count = ${pageCount}`);

    expect(() => migrator.migrate("thread_full")).toThrow(/full|disk/i);
    expect(store.head("thread_full").lastSeq).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_events_v2").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_sync_effects_v2").get()).toEqual({
      count: 0,
    });
  } finally {
    db.close();
    await removeTempDirectory(dir);
  }
});
