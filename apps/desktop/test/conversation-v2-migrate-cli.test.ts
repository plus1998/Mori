import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { stableHash } from "@eco/shared";
import { removeTempDirectory } from "./helpers/temp-directory";
import { ConversationStore } from "../src/main/conversation-store";
import { conversationV2RunEventForAttempt } from "../src/main/conversation-v2-run-events";

function openInspectionDatabase(filename: string): DatabaseSync {
  let lastError: unknown;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(filename, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;");
      db.prepare("SELECT 1 AS ok FROM sqlite_master LIMIT 1").get();
      return db;
    } catch (error) {
      lastError = error;
      try {
        db?.close();
      } catch {
        // Retry with a fresh handle below.
      }
      // SQLite on macOS may need a write-capable handle to create or repair
      // the WAL shared-memory reader slot. query_only keeps this inspection
      // handle from mutating the database after it opens.
      if (attempt >= 7) {
        try {
          db = new DatabaseSync(filename);
          db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;");
          db.prepare("SELECT 1 AS ok FROM sqlite_master LIMIT 1").get();
          return db;
        } catch (fallbackError) {
          lastError = fallbackError;
          try {
            db?.close();
          } catch {
            // Preserve the original open failure.
          }
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

test("migration inspect is read-only even on an old database without V2 tables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-inspect-"));
  const filename = join(dir, "source.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec(`
      CREATE TABLE thread_user_messages (thread_id TEXT, activity_line_id TEXT,
        text TEXT, attachments_json TEXT, created_at TEXT);
      CREATE TABLE thread_run_events (id TEXT, thread_id TEXT, sequence INTEGER,
        event_type TEXT, scope TEXT, role TEXT, agent_id TEXT, parent_agent_id TEXT,
        parent_tool_use_id TEXT, run_attempt_id TEXT, request_id TEXT, stream_key TEXT,
        stream_state TEXT, message TEXT, metadata_json TEXT, observed_at TEXT);
      INSERT INTO thread_user_messages VALUES ('thread', 'prompt', 'hello', NULL, '2026-09-17T00:00:00Z');
    `);
    db.close();
    const before = await readFile(filename);
    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--conversation",
        "thread",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      phase: "dry_run",
      userMessageCount: 1,
      canMigrate: true,
    });
    expect(await readFile(filename)).toEqual(before);
    const after = openInspectionDatabase(filename);
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'conversation_%'").all()).toEqual(
      [],
    );
    expect(after.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    after.close();
  } finally {
    await removeTempDirectory(dir);
  }
});

test("V2-only maintenance verification reads the native-facts ledger after V1 tables are retired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-verify-v2-only-"));
  const filename = join(dir, "source.sqlite");
  const backup = join(dir, "backup.sqlite");
  const manifest = join(dir, "native-manifest.json");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_v2_only_verify', 'V2 verify', 'hello', '/tmp/v2-verify', 'completed', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO thread_user_messages
       (thread_id, activity_line_id, upstream_message_id, provider, text, attachments_json, created_at, updated_at)
       VALUES ('thread_v2_only_verify', 'user:v2-verify', NULL, 'claude', 'hello', NULL, ?, ?)`,
    ).run("2026-09-17T00:00:01.000Z", "2026-09-17T00:00:01.000Z");
    db.close();

    const exportCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exportStdout, exportStderr, exportCode] = await Promise.all([
      new Response(exportCommand.stdout).text(),
      new Response(exportCommand.stderr).text(),
      exportCommand.exited,
    ]);
    expect({ code: exportCode, stderr: exportStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(exportStdout)).toMatchObject({ phase: "dry_run", nativeManifestEventCount: 0 });

    const cutoverCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backup,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [cutoverStderr, cutoverCode] = await Promise.all([
      new Response(cutoverCommand.stderr).text(),
      cutoverCommand.exited,
    ]);
    expect({ code: cutoverCode, stderr: cutoverStderr }).toEqual({ code: 0, stderr: "" });

    const verifyCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--verify-native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [verifyStdout, verifyStderr, verifyCode] = await Promise.all([
      new Response(verifyCommand.stdout).text(),
      new Response(verifyCommand.stderr).text(),
      verifyCommand.exited,
    ]);
    expect({ code: verifyCode, stderr: verifyStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(verifyStdout)).toMatchObject({
      phase: "v2_only",
      storageMode: "v2_only",
      integrity: "ok",
      nativeManifestVerification: { status: "passed", nativeEventCount: 0 },
    });
  } finally {
    await removeTempDirectory(dir);
  }
});

test("V2-only audit inventories an orphan durable stream instead of hiding it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-verify-orphan-stream-"));
  const filename = join(dir, "source.sqlite");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    store.conversationV2().append({
      conversationId: "orphan_v2_stream",
      eventId: "orphan_event",
      sourceEventKey: "desktop:orphan:event",
      type: "message.created",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: "orphan_turn",
      messageId: "orphan_message",
      payload: { role: "assistant", channel: "answer", body: "orphan", status: "final" },
    });
    store.switchToV2OnlyStorage();
    db.close();

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      phase: "v2_only",
      conversationCount: 1,
      existingV2: [expect.objectContaining({ conversationId: "orphan_v2_stream", streams: 1 })],
    });
  } finally {
    await removeTempDirectory(dir);
  }
});

test("V2-only audit fails closed for extra native rows even when the stream has ledger facts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-verify-missing-native-ledger-"));
  const filename = join(dir, "source.sqlite");
  const manifest = join(dir, "native-manifest.json");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_v2_only_missing_ledger', 'V2 missing ledger', 'hello', '/tmp/v2-missing-ledger', 'completed', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    const v2 = store.conversationV2();
    const ledgered = v2.append({
      conversationId: "thread_v2_only_missing_ledger",
      eventId: "native_with_ledger",
      sourceEventKey: "desktop:native-with-ledger",
      type: "message.created",
      occurredAt: "2026-09-17T00:00:00.500Z",
      turnId: "native_turn",
      messageId: "native_message_with_ledger",
      payload: { role: "assistant", channel: "answer", body: "ledgered body", status: "final" },
    }).event;
    db.exec("BEGIN IMMEDIATE");
    v2.persistNativeFactInCurrentTransaction({
      conversationId: ledgered.conversationId,
      nativeSeq: ledgered.seq,
      eventId: ledgered.eventId,
      type: ledgered.type,
      turnId: ledgered.turnId,
      occurredAt: ledgered.occurredAt,
      recordedAt: ledgered.recordedAt,
      schemaVersion: ledgered.schemaVersion,
      sourceEventKey: ledgered.sourceEventKey,
      payloadJson: JSON.stringify(ledgered.payload),
      payloadHash: stableHash(ledgered.payload),
      eventHash: ledgered.eventHash,
      disposition: "equivalent",
      attachmentSummaryJson: "{}",
    });
    db.exec("COMMIT");
    v2.append({
      conversationId: "thread_v2_only_missing_ledger",
      eventId: "native_without_ledger",
      sourceEventKey: "desktop:native-without-ledger",
      type: "message.created",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: "native_turn",
      messageId: "native_message",
      payload: { role: "assistant", channel: "answer", body: "native body", status: "final" },
    });
    store.switchToV2OnlyStorage();
    db.close();

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      phase: "v2_only",
      storageMode: "v2_only",
      cutoverReady: false,
      existingV2: [
        expect.objectContaining({
          nativeUnmatchedEvents: 1,
          nativeReconciliationIssues: expect.arrayContaining(["native_fact_ledger_missing"]),
        }),
      ],
    });
  } finally {
    await removeTempDirectory(dir);
  }
});

test("V2-only audit accepts a post-cutover runtime stream without a maintenance-ledger copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-verify-post-cutover-runtime-"));
  const filename = join(dir, "source.sqlite");
  const manifest = join(dir, "native-manifest.json");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_v2_only_post_cutover', 'V2 post cutover', 'hello', '/tmp/v2-post-cutover', 'completed', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO conversation_migrations_v2
       (migration_version, conversation_id, source_fingerprint, phase, checkpoint, validation_json, updated_at)
       VALUES (1, 'thread_v2_only_post_cutover', 'fixture', 'completed', NULL, NULL, ?)`,
    ).run("2026-09-17T00:00:00.000Z");
    const v2 = store.conversationV2();
    const userSourceKey = "desktop:user:thread_v2_only_post_cutover:user:one";
    v2.append({
      conversationId: "thread_v2_only_post_cutover",
      eventId: `desktop_v2_user_${stableHash(userSourceKey)}`,
      sourceEventKey: userSourceKey,
      type: "message.created",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: "turn_post_cutover",
      messageId: "message_post_cutover",
      payload: { role: "user", channel: "answer", body: "hello", status: "final" },
    });
    const inputSourceKey =
      "runtime-input:thread_v2_only_post_cutover:input_post_cutover:post-cutover-input-hash";
    v2.append({
      conversationId: "thread_v2_only_post_cutover",
      eventId: `runtime_input_${stableHash(inputSourceKey)}`,
      sourceEventKey: inputSourceKey,
      type: "noop",
      occurredAt: "2026-09-17T00:00:01.100Z",
      payload: {
        reason: "runtime.input",
        inputHash: "post-cutover-input-hash",
        source: {
          id: "input_post_cutover",
          threadId: "thread_v2_only_post_cutover",
          sequence: 1,
          eventType: "message.final",
          scope: "main",
          streamState: "finalized",
          message: "hello",
          observedAt: "2026-09-17T00:00:01.100Z",
          role: "user",
        },
      },
    });
    const runSourceKey =
      "desktop:run:thread_v2_only_post_cutover:attempt_post_cutover:running:2026-09-17T00:00:01.200Z:end:hash";
    v2.append({
      conversationId: "thread_v2_only_post_cutover",
      eventId: `desktop_v2_run_${stableHash(runSourceKey)}`,
      sourceEventKey: runSourceKey,
      type: "run.started",
      occurredAt: "2026-09-17T00:00:01.200Z",
      runId: "attempt_post_cutover",
      turnId: "attempt_post_cutover",
      payload: {
        authority: "lifecycle",
        status: "running",
        timingQuality: "recorded",
        startedAt: "2026-09-17T00:00:01.200Z",
      },
    });
    const patchReason = "bind-runtime-history-target";
    const patchInputIds = ["input_post_cutover"];
    const patchDigest = stableHash(
      `${"thread_v2_only_post_cutover"}:${patchReason}:${patchInputIds.join(",")}`,
    );
    const patchSourceKey = `provider:patch:${patchDigest}`;
    v2.append({
      conversationId: "thread_v2_only_post_cutover",
      eventId: `provider_patch_${patchDigest}`,
      sourceEventKey: patchSourceKey,
      type: "noop",
      occurredAt: "2026-09-17T00:00:01.300Z",
      payload: {
        reason: "provider.patch",
        patchReason,
        inputIds: patchInputIds,
        patch: { historyTarget: { activityLineId: "user:one" } },
      },
    });
    const targetEventKey = `${patchSourceKey}:history-target:message_post_cutover`;
    v2.append({
      conversationId: "thread_v2_only_post_cutover",
      eventId: `provider_history_target_${stableHash(`${patchSourceKey}:message_post_cutover`)}`,
      sourceEventKey: targetEventKey,
      type: "message.history_targeted",
      occurredAt: "2026-09-17T00:00:01.300Z",
      messageId: "message_post_cutover",
      payload: { historyTarget: { activityLineId: "user:one" } },
    });
    const codexRepairSource =
      "desktop:codex-user-duplicate-repair:thread_v2_only_post_cutover:duplicate_message:canonical_message";
    v2.append({
      conversationId: "thread_v2_only_post_cutover",
      eventId: `codex_user_duplicate_delete_${stableHash(codexRepairSource)}`,
      sourceEventKey: `${codexRepairSource}:delete`,
      type: "history.deleted",
      occurredAt: "2026-09-17T00:00:01.400Z",
      messageId: "duplicate_message",
      payload: {
        reason: "codex-user-item-echo",
        affectedMessageIds: ["duplicate_message"],
      },
    });
    const acceptedRepairSource =
      "desktop:accepted-prompt-duplicate-repair:thread_v2_only_post_cutover:accepted_message:runtime_message";
    v2.append({
      conversationId: "thread_v2_only_post_cutover",
      eventId: `accepted_prompt_duplicate_delete_${stableHash(acceptedRepairSource)}`,
      sourceEventKey: `${acceptedRepairSource}:delete`,
      type: "history.deleted",
      occurredAt: "2026-09-17T00:00:01.500Z",
      messageId: "accepted_message",
      payload: {
        reason: "accepted-prompt-duplicate",
        affectedMessageIds: ["accepted_message"],
      },
    });
    store.switchToV2OnlyStorage();
    db.close();

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      phase: "v2_only",
      storageMode: "v2_only",
      cutoverReady: true,
      existingV2: [
        expect.objectContaining({
          nativeUnmatchedEvents: 0,
          nativeReconciliationIssues: ["post_cutover_runtime_without_native_ledger"],
        }),
      ],
    });

    const markerDb = new DatabaseSync(filename);
    markerDb
      .prepare(`UPDATE conversation_migrations_v2 SET updated_at = ? WHERE conversation_id = ?`)
      .run("2099-01-01T00:00:00.000Z", "thread_v2_only_post_cutover");
    markerDb.close();
    const lateManifest = join(dir, "late-native-manifest.json");
    const lateCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--native-manifest",
        lateManifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [lateStdout, lateStderr, lateCode] = await Promise.all([
      new Response(lateCommand.stdout).text(),
      new Response(lateCommand.stderr).text(),
      lateCommand.exited,
    ]);
    expect({ code: lateCode, stderr: lateStderr }).toEqual({ code: 0, stderr: "" });
    const lateReport = JSON.parse(lateStdout);
    expect(lateReport.cutoverReady).toBe(false);
    expect(lateReport.existingV2[0].nativeUnmatchedEvents).toBeGreaterThan(0);
    expect(lateReport.existingV2[0].nativeReconciliationIssues).toContain("native_fact_ledger_missing");
  } finally {
    await removeTempDirectory(dir);
  }
});

test("V2-only audit accepts verified terminal-tool recovery events after a completed migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-verify-post-cutover-recovery-"));
  const filename = join(dir, "source.sqlite");
  const manifest = join(dir, "native-manifest.json");
  const conversationId = "thread_v2_only_post_cutover_recovery";
  const runId = "run_post_cutover_recovery";
  const toolCallId = "tool_post_cutover_recovery";
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES (?, 'V2 post-cutover recovery', 'hello', '/tmp/v2-post-cutover-recovery', 'completed', '', ?, ?)`,
    ).run(conversationId, "2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO conversation_migrations_v2
       (migration_version, conversation_id, source_fingerprint, phase, checkpoint, validation_json, updated_at)
       VALUES (1, ?, 'fixture', 'completed', NULL, NULL, ?)`,
    ).run(conversationId, "2026-09-17T00:00:00.000Z");
    const v2 = store.conversationV2();
    v2.append({
      conversationId,
      eventId: "migrated_run_started",
      sourceEventKey: "migration:v1:run-started",
      type: "run.started",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: runId,
      runId,
      payload: { status: "running", startedAt: "2026-09-17T00:00:01.000Z" },
    });
    v2.append({
      conversationId,
      eventId: "migrated_tool_started",
      sourceEventKey: "migration:v1:tool-started",
      type: "tool.started",
      occurredAt: "2026-09-17T00:00:02.000Z",
      runId,
      toolCallId,
      payload: { name: "Bash", status: "running", input: { command: "echo safe" } },
    });
    v2.append({
      conversationId,
      eventId: "migrated_run_failed",
      sourceEventKey: "migration:v1:run-failed",
      type: "run.failed",
      occurredAt: "2026-09-17T00:00:03.000Z",
      turnId: runId,
      runId,
      payload: {
        status: "failed",
        startedAt: "2026-09-17T00:00:01.000Z",
        endedAt: "2026-09-17T00:00:03.000Z",
      },
    });
    expect(v2.reconcileTerminalRunTools(conversationId)).toEqual({ scanned: 1, settled: 1 });
    store.switchToV2OnlyStorage();
    db.close();

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      phase: "v2_only",
      storageMode: "v2_only",
      cutoverReady: true,
      existingV2: [
        expect.objectContaining({
          nativeUnmatchedEvents: 0,
          nativeReconciliationIssues: ["post_cutover_recovery_without_native_ledger"],
        }),
      ],
    });
  } finally {
    await removeTempDirectory(dir);
  }
});

test("V2-only attachment repair rebuilds canonical events atomically and keeps the audit ledger untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-attachment-repair-"));
  const filename = join(dir, "source.sqlite");
  const backup = join(dir, "backup.sqlite");
  const attachmentsRoot = join(dir, "attachments");
  const attachmentPath = join(attachmentsRoot, "messages", "image.png");
  const conversationId = "thread_v2_only_attachment_repair";
  try {
    await mkdir(dirname(attachmentPath), { recursive: true });
    await writeFile(attachmentPath, Buffer.from("path image bytes"));
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES (?, 'Attachment repair', 'hello', '/tmp/attachment-repair', 'completed', '', ?, ?)`,
    ).run(conversationId, "2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    const attachments = [
      { mediaType: "image/png", path: attachmentPath },
      {
        id: "inline-image",
        mediaType: "image/jpeg",
        data: Buffer.from("inline image bytes").toString("base64"),
      },
    ];
    const v2 = store.conversationV2();
    const userSourceKey = `desktop:user:${conversationId}:user:one`;
    const repairUserEventId = `desktop_v2_user_${stableHash(userSourceKey)}`;
    v2.append({
      conversationId,
      eventId: repairUserEventId,
      sourceEventKey: userSourceKey,
      type: "message.created",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: "repair_turn",
      messageId: "repair_message",
      payload: { role: "user", channel: "answer", body: "hello", status: "final", attachments },
    });
    const runtimeInputSourceKey = `runtime-input:${conversationId}:repair_input:repair-input-hash`;
    v2.append({
      conversationId,
      eventId: `runtime_input_${stableHash(runtimeInputSourceKey)}`,
      sourceEventKey: runtimeInputSourceKey,
      type: "noop",
      occurredAt: "2026-09-17T00:00:01.100Z",
      payload: {
        reason: "runtime.input",
        inputHash: "repair-input-hash",
        source: {
          id: "repair_input",
          threadId: conversationId,
          sequence: 1,
          eventType: "message.final",
          scope: "main",
          streamState: "finalized",
          message: "hello",
          observedAt: "2026-09-17T00:00:01.100Z",
          role: "user",
        },
      },
    });
    v2.append(
      conversationV2RunEventForAttempt({
        conversationId,
        attemptId: "repair_run",
        status: "running",
        startedAt: "2026-09-17T00:00:01.200Z",
        sourcePrefix: "desktop:run",
      }),
    );
    store.switchToV2OnlyStorage();
    db.close();

    // Simulate a V2-only database written before follow-up attachment
    // normalization was enforced. The maintenance repair must inspect and
    // rewrite this mutable V2 container as well as the immutable event.
    const injected = new DatabaseSync(filename);
    injected
      .prepare(
        `INSERT INTO conversation_followups_v2 (
           id, thread_id, prompt, attachments_json, priority, status, delivery_mode,
           source_run_attempt_id, target_run_attempt_id, queued_during_phase,
           delivery_boundary, error, queue_position, created_at, updated_at,
           delivered_at, applied_at, conversation_message_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        "repair_followup_attachment",
        conversationId,
        "follow-up with an old attachment",
        JSON.stringify([{ mediaType: "image/png", path: attachmentPath }]),
        "normal",
        "queued",
        "queued",
        "2026-09-17T00:00:02.000Z",
        "2026-09-17T00:00:02.000Z",
      );
    injected.close();

    const dryRun = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--attachments-root",
        attachmentsRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [dryStdout, dryStderr, dryCode] = await Promise.all([
      new Response(dryRun.stdout).text(),
      new Response(dryRun.stderr).text(),
      dryRun.exited,
    ]);
    expect({ code: dryCode, stderr: dryStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(dryStdout)).toMatchObject({
      phase: "v2_only",
      cutoverReady: false,
      existingV2: [expect.objectContaining({ attachmentLegacyPayloads: 5 })],
    });

    const repair = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--repair-legacy-attachments",
        "--backup",
        backup,
        "--attachments-root",
        attachmentsRoot,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [repairStdout, repairStderr, repairCode] = await Promise.all([
      new Response(repair.stdout).text(),
      new Response(repair.stderr).text(),
      repair.exited,
    ]);
    expect({ code: repairCode, stderr: repairStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(repairStdout)).toMatchObject({
      phase: "v2_only",
      storageMode: "v2_only",
      integrity: "ok",
      cutoverReady: true,
      repairedConversations: 1,
      repairedEvents: 1,
      repairedFollowUps: 1,
      repairedAttachments: 3,
      before: { legacyPayloads: 5, pathRefs: 3, inlineBytes: 36 },
      after: { legacyPayloads: 0, pathRefs: 0, inlineBytes: 0 },
    });

    const repaired = openInspectionDatabase(filename);
    const event = repaired
      .prepare(`SELECT payload_json FROM conversation_events_v2 WHERE conversation_id = ? AND event_id = ?`)
      .get(conversationId, repairUserEventId) as { payload_json?: string };
    const payload = JSON.parse(event.payload_json ?? "{}");
    expect(payload.attachments).toEqual([
      expect.objectContaining({ mediaType: "image/png", byteLength: 16 }),
      expect.objectContaining({ mediaType: "image/jpeg", byteLength: 18 }),
    ]);
    expect(
      payload.attachments.every(
        (attachment: Record<string, unknown>) => !attachment.path && !attachment.data,
      ),
    ).toBe(true);
    const followUp = repaired
      .prepare(`SELECT attachments_json FROM conversation_followups_v2 WHERE id = ?`)
      .get("repair_followup_attachment") as { attachments_json?: string };
    const followUpAttachments = JSON.parse(followUp.attachments_json ?? "null");
    expect(followUpAttachments).toEqual([
      expect.objectContaining({ mediaType: "image/png", byteLength: 16 }),
    ]);
    expect(
      followUpAttachments.every(
        (attachment: Record<string, unknown>) => !attachment.path && !attachment.data,
      ),
    ).toBe(true);
    expect(repaired.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    repaired.close();

    const preserved = openInspectionDatabase(backup);
    expect(preserved.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(
      preserved
        .prepare("SELECT value FROM conversation_store_meta_v2 WHERE key = 'conversation_v2_storage_mode'")
        .get(),
    ).toEqual({ value: "v2_only" });
    preserved.close();
  } finally {
    await removeTempDirectory(dir);
  }
});

test("maintenance cutover backs up, migrates every thread, and retires V1 tables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-cutover-"));
  const filename = join(dir, "source.sqlite");
  const backup = join(dir, "backup.sqlite");
  const backupRerun = join(dir, "backup-rerun.sqlite");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "thread_cutover",
      "Cutover",
      "hello",
      "/tmp/cutover",
      "idle",
      "",
      "2026-09-17T00:00:00.000Z",
      "2026-09-17T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO thread_user_messages
       (thread_id, activity_line_id, upstream_message_id, provider, text, attachments_json, created_at, updated_at)
       VALUES (?, ?, NULL, 'claude', ?, NULL, ?, ?)`,
    ).run("thread_cutover", "user:cutover", "hello", "2026-09-17T00:00:01.000Z", "2026-09-17T00:00:01.000Z");
    db.prepare(
      `INSERT INTO thread_run_events
       (id, thread_id, sequence, event_type, scope, role, agent_id, parent_agent_id,
        parent_tool_use_id, run_attempt_id, request_id, stream_key, stream_state,
        message, metadata_json, observed_at)
       VALUES (?, ?, 1, 'message.final', 'main', 'user', NULL, NULL, NULL, NULL,
               NULL, 'user:cutover', 'finalized', ?, NULL, ?)`,
    ).run("legacy_cutover_event", "thread_cutover", "hello", "2026-09-17T00:00:01.000Z");
    db.close();

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backup,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      phase: "v2_only",
      conversationCount: 1,
      storageMode: "v2_only",
      integrity: "ok",
    });

    const migrated = openInspectionDatabase(filename);
    expect(
      migrated
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('thread_activity', 'thread_coder_todos',
             'thread_run_events', 'thread_user_messages', 'thread_feed_skeleton',
             'thread_subagent_sessions', 'thread_subagent_metrics')`,
        )
        .all(),
    ).toEqual([]);
    expect(
      (
        migrated
          .prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = 'conversation_v2_storage_mode'`)
          .get() as { value: string }
      ).value,
    ).toBe("v2_only");
    expect(migrated.prepare(`SELECT COUNT(*) AS count FROM conversation_events_v2`).get()).toMatchObject({
      count: 4,
    });
    migrated.close();

    const reopened = new DatabaseSync(filename);
    new ConversationStore(reopened).initialize();
    expect(
      reopened
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('thread_subagent_sessions', 'thread_subagent_metrics')`,
        )
        .all(),
    ).toEqual([]);
    reopened.close();

    const preserved = openInspectionDatabase(backup);
    expect(
      (
        preserved
          .prepare(`SELECT COUNT(*) AS count FROM thread_run_events WHERE id = 'legacy_cutover_event'`)
          .get() as { count: number }
      ).count,
    ).toBe(1);
    preserved.close();

    const rerun = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backupRerun,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [rerunStdout, rerunStderr, rerunCode] = await Promise.all([
      new Response(rerun.stdout).text(),
      new Response(rerun.stderr).text(),
      rerun.exited,
    ]);
    expect({ code: rerunCode, stderr: rerunStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(rerunStdout)).toMatchObject({ phase: "v2_only", idempotent: true });
  } finally {
    await removeTempDirectory(dir);
  }
});

test("maintenance cutover refuses active threads before creating a backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-cutover-active-"));
  const filename = join(dir, "source.sqlite");
  const backup = join(dir, "backup.sqlite");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_active', 'Active', 'hello', '/tmp/active', 'running', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    db.close();

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backup,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([new Response(command.stderr).text(), command.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("all active threads to be stopped");
    await expect(access(backup)).rejects.toThrow();
  } finally {
    await removeTempDirectory(dir);
  }
});

test("maintenance cutover leaves legacy storage untouched when the backup target is not writable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-cutover-backup-target-"));
  const filename = join(dir, "source.sqlite");
  const blockingFile = join(dir, "backup-parent");
  const backup = join(blockingFile, "backup.sqlite");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.close();
    await writeFile(blockingFile, "a file cannot be a backup directory");

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backup,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([new Response(command.stderr).text(), command.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/EEXIST|ENOTDIR|not a directory/i);

    // The source is a WAL database. A read-only handle cannot recreate a
    // missing WAL sidecar after SQLite checkpoints it between the child exit
    // and this assertion. A query-only writable handle keeps the assertion
    // write-protected while remaining valid for both WAL sidecar states.
    const reopened = new DatabaseSync(filename);
    reopened.exec("PRAGMA query_only = ON");
    expect(
      reopened
        .prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = 'conversation_v2_storage_mode'`)
        .get(),
    ).toEqual({
      value: "legacy_compat",
    });
    expect(
      reopened
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_run_events'`)
        .all(),
    ).toEqual([{ name: "thread_run_events" }]);
    reopened.close();
  } finally {
    await removeTempDirectory(dir);
  }
});

test("maintenance cutover fails closed on corrupt V1 attempt metadata and keeps the source mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-cutover-corrupt-source-"));
  const filename = join(dir, "source.sqlite");
  const backup = join(dir, "backup.sqlite");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_corrupt_source', 'Corrupt source', 'hello', '/tmp/corrupt-source', 'completed', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO thread_run_attempts
       (thread_id, attempt_id, phase, retry_index, status, started_at, ended_at, metadata_json)
       VALUES ('thread_corrupt_source', 'attempt_corrupt', 'execution', 0, 'completed', ?, ?, 'not-json')`,
    ).run("2026-09-17T00:00:01.000Z", "2026-09-17T00:00:02.000Z");
    db.close();

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backup,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([new Response(command.stderr).text(), command.exited]);
    expect(code).not.toBe(0);
    const failure = JSON.parse(stderr);
    expect(failure.code).toBe("migration_incomplete");
    expect(failure.data.conflicts).toContain("invalid_attempt_metadata:attempt_corrupt");
    await access(backup);

    // A failed migration may leave a WAL sidecar that a read-only SQLite
    // handle cannot open until it is checkpointed. Opening read-write here is
    // still read-only at the SQL level and lets SQLite finish that recovery.
    const reopened = new DatabaseSync(filename);
    expect(
      reopened
        .prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = 'conversation_v2_storage_mode'`)
        .get(),
    ).toEqual({
      value: "legacy_compat",
    });
    expect(
      reopened
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_run_events'`)
        .all(),
    ).toEqual([{ name: "thread_run_events" }]);
    reopened.close();
  } finally {
    await removeTempDirectory(dir);
  }
});

test("maintenance cutover exports, rebuilds, and restores V2 command state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-cutover-command-state-"));
  const filename = join(dir, "source.sqlite");
  const backup = join(dir, "backup.sqlite");
  const manifest = join(dir, "native-manifest.json");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_command_state', 'Command state', 'hello', '/tmp/command-state', 'completed', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO thread_user_messages
       (thread_id, activity_line_id, upstream_message_id, provider, text, attachments_json, created_at, updated_at)
       VALUES ('thread_command_state', 'user:command-state', NULL, 'claude', 'hello', NULL, ?, ?)`,
    ).run("2026-09-17T00:00:01.000Z", "2026-09-17T00:00:01.000Z");
    const v2 = store.conversationV2();
    v2.ensureConversation("thread_command_state");
    const accepted = v2.sendMessage({
      principalId: "principal",
      conversationId: "thread_command_state",
      clientCommandId: "command_1",
      text: "hello",
      turnId: "turn_command",
      messageId: "message_command",
    });
    const commandJob = v2.acceptCommand({
      principalId: "principal",
      conversationId: "thread_command_state",
      clientCommandId: "job_1",
      commandType: "history.retry",
      request: { rewind: false, prompt: "retry", attachments: [] },
      expectedHistoryRevision: v2.head("thread_command_state").historyRevision,
    });
    const claimed = v2.beginCommandExecution("principal", "thread_command_state", "job_1");
    expect(commandJob.status).toBe("accepted");
    expect(claimed.acquired).toBe(true);
    db.close();

    const manifestCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [manifestStdout, manifestStderr, manifestCode] = await Promise.all([
      new Response(manifestCommand.stdout).text(),
      new Response(manifestCommand.stderr).text(),
      manifestCommand.exited,
    ]);
    expect({ code: manifestCode, stderr: manifestStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(manifestStdout)).toMatchObject({
      phase: "dry_run",
      cutoverReady: false,
      existingV2: [
        expect.objectContaining({
          conversationId: "thread_command_state",
          commandReceipts: 1,
          commandJobs: 1,
          commandCheckpoints: 1,
          hasExternalData: true,
        }),
      ],
    });
    const commandManifest = JSON.parse(await readFile(manifest, "utf8")) as {
      conversations: Array<{ nativeEvents: Array<Record<string, unknown>> }>;
    };
    const interrupted = new DatabaseSync(filename);
    try {
      const interruptedStore = new ConversationStore(interrupted);
      interruptedStore.initialize();
      const commandFacts = (commandManifest.conversations[0]?.nativeEvents ?? []).filter((fact) => {
        const source = fact.sourceEventKey;
        return (
          (fact.type === "message.accepted" && typeof source === "string" && source.startsWith("command:")) ||
          (fact.type === "noop" && typeof source === "string" && source.startsWith("command-job:"))
        );
      });
      interrupted.exec("BEGIN IMMEDIATE");
      try {
        for (const fact of commandFacts) {
          interruptedStore.conversationV2().persistNativeFactInCurrentTransaction({
            conversationId: "thread_command_state",
            nativeSeq: Number(fact.seq),
            eventId: String(fact.eventId),
            type: String(fact.type),
            turnId: fact.turnId as string | null,
            runId: fact.runId as string | null,
            messageId: fact.messageId as string | null,
            toolCallId: fact.toolCallId as string | null,
            agentId: fact.agentId as string | null,
            agentInstanceId: fact.agentInstanceId as string | null,
            parentAgentInstanceId: fact.parentAgentInstanceId as string | null,
            parentAgentId: fact.parentAgentId as string | null,
            parentToolCallId: fact.parentToolCallId as string | null,
            occurredAt: String(fact.occurredAt),
            recordedAt: String(fact.recordedAt),
            schemaVersion: Number(fact.schemaVersion),
            sourceEventKey: fact.sourceEventKey as string | null,
            payloadJson: String(fact.payloadJson),
            payloadHash: String(fact.payloadHash),
            eventHash: String(fact.eventHash),
            disposition: fact.disposition as "equivalent",
            matchedSourceId: fact.matchedSourceId as string | null,
            reconciliationReason: fact.reconciliationReason as string | null,
            attachmentSummaryJson: JSON.stringify(fact.attachmentSummary),
          });
        }
        interruptedStore
          .conversationV2()
          .resetConversationForMaintenanceInCurrentTransaction("thread_command_state");
        interrupted.exec("COMMIT");
      } catch (error) {
        interrupted.exec("ROLLBACK");
        throw error;
      }
    } finally {
      interrupted.close();
    }

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backup,
        "--reconcile-native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      phase: "v2_only",
      storageMode: "v2_only",
      commandReceiptsRestored: 1,
      commandJobsRestored: 1,
      commandCheckpointsRestored: 1,
    });

    const preserved = new DatabaseSync(filename);
    expect(
      preserved
        .prepare(
          `SELECT value FROM conversation_store_meta_v2
           WHERE key = 'conversation_v2_storage_mode'`,
        )
        .get(),
    ).toMatchObject({ value: "v2_only" });
    expect(preserved.prepare(`SELECT COUNT(*) AS count FROM conversation_command_receipts_v2`).get()).toEqual(
      {
        count: 1,
      },
    );
    expect(
      preserved.prepare(`SELECT COUNT(*) AS count FROM conversation_command_jobs_v2`).get(),
    ).toMatchObject({
      count: 1,
    });
    expect(
      preserved.prepare(`SELECT COUNT(*) AS count FROM conversation_command_checkpoints_v2`).get(),
    ).toMatchObject({ count: 1 });
    const reopenedStore = new ConversationStore(preserved);
    reopenedStore.initialize();
    const restoredJob = reopenedStore
      .conversationV2()
      .getCommandJob("principal", "thread_command_state", "job_1");
    expect(restoredJob).toMatchObject({
      status: "running",
      checkpoints: [expect.objectContaining({ name: "execution.claimed" })],
    });
    const retried = reopenedStore.conversationV2().sendMessage({
      principalId: "principal",
      conversationId: "thread_command_state",
      clientCommandId: "command_1",
      text: "hello",
    });
    expect(retried).toEqual({ ...accepted, acceptedSeq: expect.any(Number) });
    expect(preserved.prepare(`SELECT COUNT(*) AS count FROM conversation_events_v2`).get()).toMatchObject({
      count: 3,
    });
    preserved.close();
  } finally {
    await removeTempDirectory(dir);
  }
});

test("maintenance cutover refuses mixed V1 and existing V2 data with an inventory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-cutover-mixed-"));
  const filename = join(dir, "source.sqlite");
  const backup = join(dir, "backup.sqlite");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_mixed', 'Mixed', 'hello', '/tmp/mixed', 'completed', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    store.conversationV2().append({
      conversationId: "thread_mixed",
      eventId: "existing_v2_event",
      sourceEventKey: "desktop:existing-v2",
      type: "message.created",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: "existing_v2_turn",
      messageId: "existing_v2_message",
      payload: {
        role: "assistant",
        body: "already in V2",
        attachments: [
          { id: "image_1", mediaType: "image/png", data: "aGVsbG8=" },
          { id: "image_2", mediaType: "image/png", path: "/missing/image.png" },
        ],
      },
    });
    store.conversationV2().append({
      conversationId: "thread_mixed",
      eventId: "legacy_v2_event",
      sourceEventKey: "legacy:mirror",
      type: "message.created",
      occurredAt: "2026-09-17T00:00:02.000Z",
      turnId: "legacy_v2_turn",
      messageId: "legacy_v2_message",
      payload: { role: "assistant", body: "rebuildable mirror" },
    });
    db.close();

    const dryRun = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--attachments-root",
        join(dir, "attachments"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [dryRunStdout, dryRunStderr, dryRunCode] = await Promise.all([
      new Response(dryRun.stdout).text(),
      new Response(dryRun.stderr).text(),
      dryRun.exited,
    ]);
    expect({ code: dryRunCode, stderr: dryRunStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(dryRunStdout)).toMatchObject({
      phase: "dry_run",
      conversationCount: 1,
      cutoverReady: false,
      existingV2: [
        expect.objectContaining({
          conversationId: "thread_mixed",
          events: 2,
          externalEvents: 2,
          legacyCompatEvents: 1,
          nativeEvents: 1,
          nativeEquivalentEvents: 0,
          nativeCollapsedEvents: 0,
          nativeModifiedEvents: 0,
          nativeUnmatchedEvents: 1,
          attachmentRefs: 4,
          attachmentInlineBytes: 10,
          attachmentPathRefs: 2,
          attachmentMissingFiles: 2,
          hasExternalData: true,
        }),
      ],
    });

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backup,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([new Response(command.stderr).text(), command.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("existing V2 data");
    expect(stderr).toContain("thread_mixed");
    expect(stderr).toContain('"externalEvents":2');
    await access(backup);

    const preserved = openInspectionDatabase(filename);
    expect(preserved.prepare(`SELECT COUNT(*) AS count FROM conversation_events_v2`).get()).toMatchObject({
      count: 2,
    });
    expect(
      (
        preserved
          .prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = 'conversation_v2_storage_mode'`)
          .get() as { value: string }
      ).value,
    ).toBe("legacy_compat");
    preserved.close();
  } finally {
    await removeTempDirectory(dir);
  }
});

test("dry-run classifies native V2 facts against V1 without authorizing cutover", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-native-reconciliation-"));
  const filename = join(dir, "source.sqlite");
  const manifest = join(dir, "native-manifest.json");
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_native', 'Native', 'hello', '/tmp/native', 'completed', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO thread_user_messages
       (thread_id, activity_line_id, upstream_message_id, provider, text, attachments_json, created_at, updated_at)
       VALUES (?, ?, NULL, 'claude', ?, NULL, ?, ?)`,
    ).run("thread_native", "user:exact", "hello", "2026-09-17T00:00:01.000Z", "2026-09-17T00:00:01.000Z");
    db.prepare(
      `INSERT INTO thread_user_messages
       (thread_id, activity_line_id, upstream_message_id, provider, text, attachments_json, created_at, updated_at)
       VALUES (?, ?, NULL, 'claude', ?, NULL, ?, ?)`,
    ).run(
      "thread_native",
      "user:modified",
      "line1\nline2",
      "2026-09-17T00:00:02.000Z",
      "2026-09-17T00:00:02.000Z",
    );
    db.prepare(
      `INSERT INTO thread_run_attempts
       (thread_id, attempt_id, phase, retry_index, status, started_at, ended_at, metadata_json)
       VALUES (?, ?, 'execution', 0, 'completed', ?, ?, NULL)`,
    ).run("thread_native", "attempt_native", "2026-09-17T00:00:03.000Z", "2026-09-17T00:00:04.000Z");
    store.conversationV2().append({
      conversationId: "thread_native",
      eventId: "native_exact",
      sourceEventKey: "desktop:user:thread_native:user:exact",
      type: "message.created",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: "turn_exact",
      messageId: "message_exact",
      payload: { role: "user", channel: "answer", body: "hello", status: "final" },
    });
    store.conversationV2().append({
      conversationId: "thread_native",
      eventId: "native_modified",
      sourceEventKey: "desktop:user:thread_native:user:modified",
      type: "message.created",
      occurredAt: "2026-09-17T00:00:02.000Z",
      turnId: "turn_modified",
      messageId: "message_modified",
      payload: { role: "user", channel: "answer", body: "line1 line2", status: "final" },
    });
    store.conversationV2().append({
      conversationId: "thread_native",
      eventId: "native_started",
      sourceEventKey: "desktop:run:thread_native:attempt_native:running",
      type: "run.started",
      occurredAt: "2026-09-17T00:00:03.000Z",
      turnId: "attempt_native",
      runId: "attempt_native",
      payload: { status: "running", timingQuality: "recorded", startedAt: "2026-09-17T00:00:03.000Z" },
    });
    store.conversationV2().append({
      conversationId: "thread_native",
      eventId: "native_completed",
      sourceEventKey: "desktop:run-reconciled:thread_native:attempt_native:completed",
      type: "run.completed",
      occurredAt: "2026-09-17T00:00:04.000Z",
      turnId: "attempt_native",
      runId: "attempt_native",
      payload: {
        status: "completed",
        timingQuality: "recorded",
        startedAt: "2026-09-17T00:00:03.000Z",
        endedAt: "2026-09-17T00:00:04.000Z",
      },
    });
    db.close();

    const command = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      phase: "dry_run",
      cutoverReady: false,
      existingV2: [
        expect.objectContaining({
          conversationId: "thread_native",
          nativeEvents: 4,
          nativeEquivalentEvents: 2,
          nativeCollapsedEvents: 1,
          nativeModifiedEvents: 1,
          nativeUnmatchedEvents: 0,
        }),
      ],
    });
    const report = JSON.parse(stdout).existingV2[0];
    expect(report.nativeReconciliationIssues).toEqual(
      expect.arrayContaining([
        "native_modified:message_body_diff",
        "native_started:run_started_collapses_into_attempt",
      ]),
    );
    const nativeManifest = JSON.parse(await readFile(manifest, "utf8"));
    const { contentHash, ...manifestBody } = nativeManifest;
    expect({
      schemaVersion: nativeManifest.schemaVersion,
      databasePath: nativeManifest.databasePath,
      integrity: nativeManifest.integrity,
      storageMode: nativeManifest.storageMode,
      conversationCount: nativeManifest.conversationCount,
      nativeEventCount: nativeManifest.nativeEventCount,
    }).toEqual({
      schemaVersion: 1,
      databasePath: filename,
      integrity: "ok",
      storageMode: "legacy_compat",
      conversationCount: 1,
      nativeEventCount: 4,
    });
    expect(nativeManifest.conversations).toHaveLength(1);
    const nativeConversation = nativeManifest.conversations[0];
    expect(nativeConversation.conversationId).toBe("thread_native");
    expect(nativeConversation.nativeEvents).toHaveLength(4);
    const exactEvent = nativeConversation.nativeEvents.find(
      (event: { eventId: string }) => event.eventId === "native_exact",
    );
    expect({
      eventId: exactEvent.eventId,
      type: exactEvent.type,
      payloadJson: exactEvent.payloadJson,
      disposition: exactEvent.disposition,
      matchedSourceId: exactEvent.matchedSourceId,
      attachmentSummary: exactEvent.attachmentSummary,
    }).toEqual({
      eventId: "native_exact",
      type: "message.created",
      payloadJson: '{"role":"user","channel":"answer","body":"hello","status":"final"}',
      disposition: "equivalent",
      matchedSourceId: "user:exact",
      attachmentSummary: {
        refs: 0,
        inlineBytes: 0,
        pathRefs: 0,
        missingFiles: 0,
        parseErrors: 0,
        pathContentHashes: [],
      },
    });
    expect(typeof contentHash).toBe("string");
    expect(typeof exactEvent.payloadHash).toBe("string");
    expect(typeof exactEvent.eventHash).toBe("string");
    expect(String(contentHash)).toEqual(String(stableHash(manifestBody)));
    const verify = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--verify-native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [verifyStdout, verifyStderr, verifyCode] = await Promise.all([
      new Response(verify.stdout).text(),
      new Response(verify.stderr).text(),
      verify.exited,
    ]);
    expect({ code: verifyCode, stderr: verifyStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(verifyStdout).nativeManifestVerification).toMatchObject({
      status: "passed",
      path: manifest,
      conversationCount: 1,
      nativeEventCount: 4,
      factsHash: expect.any(String),
    });
    const changedDb = new DatabaseSync(filename);
    try {
      const changedStore = new ConversationStore(changedDb);
      changedStore.initialize();
      changedStore.conversationV2().append({
        conversationId: "thread_native",
        eventId: "native_extra",
        sourceEventKey: "desktop:extra:native",
        type: "noop",
        occurredAt: "2026-09-17T00:00:05.000Z",
        turnId: "turn_extra",
        payload: { reason: "manifest mismatch test" },
      });
    } finally {
      changedDb.close();
    }
    const mismatch = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--verify-native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [mismatchStderr, mismatchCode] = await Promise.all([
      new Response(mismatch.stderr).text(),
      mismatch.exited,
    ]);
    expect(mismatchCode).not.toBe(0);
    expect(mismatchStderr).toContain("facts mismatch");
    const duplicate = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [duplicateStderr, duplicateCode] = await Promise.all([
      new Response(duplicate.stderr).text(),
      duplicate.exited,
    ]);
    expect(duplicateCode).not.toBe(0);
    expect(duplicateStderr).toContain("already exists");
  } finally {
    await removeTempDirectory(dir);
  }
});

test("native manifest detects attachment file content changes and requires a hash root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-attachment-hash-"));
  const filename = join(dir, "source.sqlite");
  const backup = join(dir, "backup.sqlite");
  const manifest = join(dir, "native-manifest.json");
  const attachmentsRoot = join(dir, "attachments");
  const attachmentPath = "messages/image.bin";
  const absoluteAttachmentPath = join(attachmentsRoot, attachmentPath);
  try {
    await mkdir(dirname(absoluteAttachmentPath), { recursive: true });
    await writeFile(absoluteAttachmentPath, Buffer.from("original attachment"));
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_attachment_hash', 'Attachment hash', 'hello', '/tmp/attachment-hash', 'completed', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    const attachments = [{ id: "image_1", mediaType: "application/octet-stream", path: attachmentPath }];
    db.prepare(
      `INSERT INTO thread_user_messages
       (thread_id, activity_line_id, upstream_message_id, provider, text, attachments_json, created_at, updated_at)
       VALUES (?, ?, NULL, 'claude', ?, ?, ?, ?)`,
    ).run(
      "thread_attachment_hash",
      "user:attachment",
      "hello",
      JSON.stringify(attachments),
      "2026-09-17T00:00:01.000Z",
      "2026-09-17T00:00:01.000Z",
    );
    store.conversationV2().append({
      conversationId: "thread_attachment_hash",
      eventId: "native_attachment",
      sourceEventKey: "desktop:user:thread_attachment_hash:user:attachment",
      type: "message.created",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: "turn_attachment",
      messageId: "message_attachment",
      payload: { role: "user", channel: "answer", body: "hello", status: "final", attachments },
    });
    db.close();

    const exportCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--attachments-root",
        attachmentsRoot,
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exportStdout, exportStderr, exportCode] = await Promise.all([
      new Response(exportCommand.stdout).text(),
      new Response(exportCommand.stderr).text(),
      exportCommand.exited,
    ]);
    expect({ code: exportCode, stderr: exportStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(exportStdout)).toMatchObject({
      phase: "dry_run",
      cutoverReady: false,
      existingV2: [expect.objectContaining({ nativeEquivalentEvents: 1 })],
    });
    const exported = JSON.parse(await readFile(manifest, "utf8")) as {
      conversations: Array<{ nativeEvents: Array<{ attachmentSummary: { pathContentHashes: unknown[] } }> }>;
    };
    expect(exported.conversations[0]?.nativeEvents[0]?.attachmentSummary.pathContentHashes).toHaveLength(1);

    await writeFile(absoluteAttachmentPath, Buffer.from("replacement attachment"));
    const verifyCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--attachments-root",
        attachmentsRoot,
        "--verify-native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [verifyStderr, verifyCode] = await Promise.all([
      new Response(verifyCommand.stderr).text(),
      verifyCommand.exited,
    ]);
    expect(verifyCode).not.toBe(0);
    expect(verifyStderr).toContain("facts mismatch");

    const noRootVerifyCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--verify-native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [noRootVerifyStderr, noRootVerifyCode] = await Promise.all([
      new Response(noRootVerifyCommand.stderr).text(),
      noRootVerifyCommand.exited,
    ]);
    expect(noRootVerifyCode).not.toBe(0);
    expect(noRootVerifyStderr).toContain("--attachments-root");

    await writeFile(absoluteAttachmentPath, Buffer.from("original attachment"));
    const cutoverCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backup,
        "--attachments-root",
        attachmentsRoot,
        "--reconcile-native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [cutoverStdout, cutoverStderr, cutoverCode] = await Promise.all([
      new Response(cutoverCommand.stdout).text(),
      new Response(cutoverCommand.stderr).text(),
      cutoverCommand.exited,
    ]);
    expect({ code: cutoverCode, stderr: cutoverStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(cutoverStdout)).toMatchObject({ phase: "v2_only", storageMode: "v2_only" });

    await writeFile(absoluteAttachmentPath, Buffer.from("replacement after cutover"));
    const postCutoverVerifyCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--attachments-root",
        attachmentsRoot,
        "--verify-native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [postCutoverVerifyStderr, postCutoverVerifyCode] = await Promise.all([
      new Response(postCutoverVerifyCommand.stderr).text(),
      postCutoverVerifyCommand.exited,
    ]);
    expect(postCutoverVerifyCode).not.toBe(0);
    expect(postCutoverVerifyStderr).toContain("facts mismatch");
  } finally {
    await removeTempDirectory(dir);
  }
});

test("native manifest does not hash attachment paths outside the configured root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-attachment-root-boundary-"));
  const filename = join(dir, "source.sqlite");
  const manifest = join(dir, "native-manifest.json");
  const attachmentsRoot = join(dir, "attachments");
  try {
    await mkdir(attachmentsRoot, { recursive: true });
    await writeFile(join(dir, "outside.bin"), Buffer.from("outside attachment"));
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_attachment_root_boundary', 'Attachment root boundary', 'hello', '/tmp/attachment-root-boundary', 'completed', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    store.conversationV2().append({
      conversationId: "thread_attachment_root_boundary",
      eventId: "native_attachment_root_escape",
      sourceEventKey: "desktop:attachment:root-escape",
      type: "message.created",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: "turn_attachment_root_escape",
      messageId: "message_attachment_root_escape",
      payload: {
        role: "user",
        channel: "answer",
        body: "hello",
        status: "final",
        attachments: [{ id: "outside", mediaType: "application/octet-stream", path: "../outside.bin" }],
      },
    });
    db.close();

    const exportCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--attachments-root",
        attachmentsRoot,
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(exportCommand.stdout).text(),
      new Response(exportCommand.stderr).text(),
      exportCommand.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout) as {
      existingV2: Array<{ attachmentMissingFiles: number; attachmentPathContentHashes: unknown[] }>;
    };
    expect(result.existingV2[0]).toMatchObject({
      attachmentRefs: 2,
      attachmentPathRefs: 2,
      attachmentMissingFiles: 2,
      attachmentPathContentHashes: [],
    });
    const exported = JSON.parse(await readFile(manifest, "utf8")) as {
      conversations: Array<{
        nativeEvents: Array<{ attachmentSummary: { missingFiles: number; pathContentHashes: unknown[] } }>;
      }>;
    };
    expect(exported.conversations[0]?.nativeEvents[0]?.attachmentSummary).toEqual({
      refs: 1,
      inlineBytes: 0,
      pathRefs: 1,
      missingFiles: 1,
      parseErrors: 0,
      pathContentHashes: [],
    });
  } finally {
    await removeTempDirectory(dir);
  }
});

test("maintenance cutover preserves native facts and reapplies a modified message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-native-cutover-"));
  const filename = join(dir, "source.sqlite");
  const backup = join(dir, "backup.sqlite");
  const manifest = join(dir, "native-manifest.json");
  const postCutoverManifest = join(dir, "post-cutover-native-manifest.json");
  const attachmentsRoot = join(dir, "attachments");
  const nativeAttachments = [
    { mediaType: "image/png", data: "aW1hZ2U=" },
    { id: "opaque_1", mediaType: "application/octet-stream", data: "b3BhcXVl" },
  ];
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES ('thread_native_cutover', 'Native cutover', 'legacy', '/tmp/native-cutover', 'completed', '', ?, ?)`,
    ).run("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO thread_user_messages
       (thread_id, activity_line_id, upstream_message_id, provider, text, attachments_json, created_at, updated_at)
       VALUES ('thread_native_cutover', 'user:one', NULL, 'claude', 'legacy body', NULL, ?, ?)`,
    ).run("2026-09-17T00:00:01.000Z", "2026-09-17T00:00:01.000Z");
    store.conversationV2().append({
      conversationId: "thread_native_cutover",
      eventId: "native_modified_cutover",
      sourceEventKey: "desktop:user:thread_native_cutover:user:one",
      type: "message.created",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: "native_turn",
      messageId: "native_message",
      payload: {
        role: "user",
        channel: "answer",
        body: "native body",
        status: "final",
        attachments: nativeAttachments,
      },
    });
    db.close();

    const manifestCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--attachments-root",
        attachmentsRoot,
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [manifestStdout, manifestStderr, manifestCode] = await Promise.all([
      new Response(manifestCommand.stdout).text(),
      new Response(manifestCommand.stderr).text(),
      manifestCommand.exited,
    ]);
    expect({ code: manifestCode, stderr: manifestStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(manifestStdout).existingV2[0]).toMatchObject({
      nativeModifiedEvents: 1,
      nativeUnmatchedEvents: 0,
    });
    const manifestBody = JSON.parse(await readFile(manifest, "utf8")) as {
      conversations: Array<{ conversationId: string; nativeEvents: Array<Record<string, unknown>> }>;
    };
    const nativeFact = manifestBody.conversations[0]?.nativeEvents[0];
    if (!nativeFact) throw new Error("native manifest did not contain the expected fact");
    // Simulate a process dying after the immutable native ledger and rebuild reset
    // committed, but before the first migration checkpoint was written. The next
    // cutover must recover from conversation_native_facts_v2 rather than requiring
    // the deleted live native event rows.
    const interrupted = new DatabaseSync(filename);
    const interruptedStore = new ConversationStore(interrupted);
    interruptedStore.initialize();
    interrupted.exec("BEGIN IMMEDIATE");
    try {
      interruptedStore.conversationV2().persistNativeFactInCurrentTransaction({
        conversationId: "thread_native_cutover",
        nativeSeq: Number(nativeFact.seq),
        eventId: String(nativeFact.eventId),
        type: String(nativeFact.type),
        turnId: nativeFact.turnId as string | null,
        runId: nativeFact.runId as string | null,
        messageId: nativeFact.messageId as string | null,
        toolCallId: nativeFact.toolCallId as string | null,
        agentId: nativeFact.agentId as string | null,
        agentInstanceId: nativeFact.agentInstanceId as string | null,
        parentAgentInstanceId: nativeFact.parentAgentInstanceId as string | null,
        parentAgentId: nativeFact.parentAgentId as string | null,
        parentToolCallId: nativeFact.parentToolCallId as string | null,
        occurredAt: String(nativeFact.occurredAt),
        recordedAt: String(nativeFact.recordedAt),
        schemaVersion: Number(nativeFact.schemaVersion),
        sourceEventKey: nativeFact.sourceEventKey as string | null,
        payloadJson: String(nativeFact.payloadJson),
        payloadHash: String(nativeFact.payloadHash),
        eventHash: String(nativeFact.eventHash),
        disposition: nativeFact.disposition as "modified",
        matchedSourceId: nativeFact.matchedSourceId as string | null,
        reconciliationReason: nativeFact.reconciliationReason as string | null,
        attachmentSummaryJson: JSON.stringify(nativeFact.attachmentSummary),
      });
      interruptedStore
        .conversationV2()
        .resetConversationForMaintenanceInCurrentTransaction("thread_native_cutover");
      interrupted.exec("COMMIT");
    } catch (error) {
      interrupted.exec("ROLLBACK");
      throw error;
    } finally {
      interrupted.close();
    }

    const cutoverCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backup,
        "--attachments-root",
        attachmentsRoot,
        "--reconcile-native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [cutoverStdout, cutoverStderr, cutoverCode] = await Promise.all([
      new Response(cutoverCommand.stdout).text(),
      new Response(cutoverCommand.stderr).text(),
      cutoverCommand.exited,
    ]);
    expect({ code: cutoverCode, stderr: cutoverStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(cutoverStdout)).toMatchObject({
      phase: "v2_only",
      storageMode: "v2_only",
      nativeFactsPreserved: 1,
      nativeFactsReconciled: 1,
    });

    const migrated = openInspectionDatabase(filename);
    expect(
      migrated
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('thread_run_events', 'thread_user_messages', 'thread_activity',
             'thread_subagent_sessions', 'thread_subagent_metrics')`,
        )
        .all(),
    ).toEqual([]);
    const nativeFactRow = migrated
      .prepare(`SELECT disposition, payload_json FROM conversation_native_facts_v2`)
      .get() as { disposition: string; payload_json: string };
    expect(nativeFactRow.disposition).toBe("modified");
    expect(JSON.parse(nativeFactRow.payload_json)).toMatchObject({
      role: "user",
      channel: "answer",
      body: "native body",
      status: "final",
      attachments: nativeAttachments,
    });
    const maintenanceEvent = migrated
      .prepare(
        `SELECT payload_json FROM conversation_events_v2
         WHERE source_event_key = 'maintenance:native:native_modified_cutover'`,
      )
      .get() as { payload_json?: string } | undefined;
    if (!maintenanceEvent?.payload_json) throw new Error("maintenance native message event is missing");
    const maintenancePayload = JSON.parse(maintenanceEvent.payload_json) as {
      attachments?: Array<Record<string, unknown>>;
    };
    expect(maintenancePayload.attachments).toHaveLength(2);
    expect(maintenancePayload.attachments?.[0]).toMatchObject({
      mediaType: "image/png",
      byteLength: 5,
    });
    expect(maintenancePayload.attachments?.[0]?.contentRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(maintenancePayload.attachments?.[0]).not.toHaveProperty("path");
    expect(maintenancePayload.attachments?.[0]).not.toHaveProperty("data");
    expect(maintenancePayload.attachments?.[1]).toMatchObject({
      id: "opaque_1",
      mediaType: "application/octet-stream",
      byteLength: 6,
      legacyOpaque: true,
    });
    expect(maintenancePayload.attachments?.[1]).not.toHaveProperty("path");
    expect(maintenancePayload.attachments?.[1]).not.toHaveProperty("data");
    expect(
      migrated
        .prepare(
          `SELECT body, status FROM conversation_messages_v2
           WHERE conversation_id = 'thread_native_cutover' ORDER BY created_seq ASC LIMIT 1`,
        )
        .get(),
    ).toEqual({ body: "native body", status: "final" });
    migrated.close();

    const postCutoverAudit = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--native-manifest",
        postCutoverManifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [postCutoverAuditStdout, postCutoverAuditStderr, postCutoverAuditCode] = await Promise.all([
      new Response(postCutoverAudit.stdout).text(),
      new Response(postCutoverAudit.stderr).text(),
      postCutoverAudit.exited,
    ]);
    expect({ code: postCutoverAuditCode, stderr: postCutoverAuditStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(postCutoverAuditStdout)).toMatchObject({
      phase: "v2_only",
      storageMode: "v2_only",
      cutoverReady: true,
      nativeManifestEventCount: 1,
      existingV2: [
        expect.objectContaining({
          nativeModifiedEvents: 1,
          nativeUnmatchedEvents: 0,
          nativeReconciliationIssues: [
            "maintenance_native_fact_replay",
            "native_modified_cutover:message_body_diff,message_attachments_diff",
          ],
        }),
      ],
    });

    const preserved = openInspectionDatabase(backup);
    expect(preserved.prepare(`SELECT COUNT(*) AS count FROM thread_user_messages`).get()).toMatchObject({
      count: 1,
    });
    expect(preserved.prepare(`SELECT COUNT(*) AS count FROM thread_run_events`).get()).toMatchObject({
      count: 0,
    });
    preserved.close();
  } finally {
    await removeTempDirectory(dir);
  }
});

test("maintenance cutover preserves and reapplies an audited run.corrected fact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eco-v2-run-correction-cutover-"));
  const filename = join(dir, "source.sqlite");
  const backup = join(dir, "backup.sqlite");
  const manifest = join(dir, "native-manifest.json");
  const conversationId = "thread_run_correction_cutover";
  const runId = "attempt_run_correction_cutover";
  try {
    const db = new DatabaseSync(filename);
    const store = new ConversationStore(db);
    store.initialize();
    db.prepare(
      `INSERT INTO threads
       (id, title, prompt, workspace_path, status, message, created_at, updated_at)
       VALUES (?, 'Run correction cutover', 'hello', '/tmp/run-correction-cutover', 'completed', '', ?, ?)`,
    ).run(conversationId, "2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO thread_run_attempts
       (thread_id, attempt_id, phase, retry_index, status, started_at, ended_at, metadata_json)
       VALUES (?, ?, 'execution', 0, 'completed', ?, ?, NULL)`,
    ).run(conversationId, runId, "2026-09-17T00:00:01.000Z", "2026-09-17T00:00:03.000Z");
    const v2 = store.conversationV2();
    v2.append({
      conversationId,
      eventId: "native_run_correction_started",
      sourceEventKey: `desktop:run:${conversationId}:${runId}:running`,
      type: "run.started",
      occurredAt: "2026-09-17T00:00:01.000Z",
      turnId: runId,
      runId,
      payload: { status: "running", startedAt: "2026-09-17T00:00:01.000Z", timingQuality: "recorded" },
    });
    v2.append({
      conversationId,
      eventId: "native_run_correction_completed",
      sourceEventKey: `desktop:run-reconciled:${conversationId}:${runId}:completed`,
      type: "run.completed",
      occurredAt: "2026-09-17T00:00:03.000Z",
      turnId: runId,
      runId,
      payload: {
        status: "completed",
        startedAt: "2026-09-17T00:00:01.000Z",
        endedAt: "2026-09-17T00:00:03.000Z",
        timingQuality: "recorded",
      },
    });
    const corrected = v2.correctRun({
      conversationId,
      runId,
      actorPrincipalId: "admin:cutover",
      reason: "provider reconciliation found a terminal failure after the completed attempt row",
      expectedPreviousStatus: "completed",
      status: "failed",
      endedAt: "2026-09-17T00:00:04.000Z",
      timingQuality: "recorded",
    });
    db.close();

    const exportCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exportStdout, exportStderr, exportCode] = await Promise.all([
      new Response(exportCommand.stdout).text(),
      new Response(exportCommand.stderr).text(),
      exportCommand.exited,
    ]);
    expect({ code: exportCode, stderr: exportStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(exportStdout)).toMatchObject({
      phase: "dry_run",
      cutoverReady: false,
      existingV2: [
        expect.objectContaining({
          conversationId,
          nativeModifiedEvents: 1,
          nativeUnmatchedEvents: 0,
        }),
      ],
    });
    const manifestBody = JSON.parse(await readFile(manifest, "utf8")) as {
      conversations: Array<{ nativeEvents: Array<Record<string, unknown>> }>;
    };
    const correctionFact = manifestBody.conversations[0]?.nativeEvents.find(
      (event) => event.eventId === corrected.event.eventId,
    );
    expect(correctionFact).toMatchObject({
      type: "run.corrected",
      disposition: "modified",
      reconciliationReason: "admin_run_correction_requires_native_replay",
      eventHash: corrected.event.eventHash,
    });

    const cutoverCommand = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../scripts/conversation-v2-migrate.ts", import.meta.url)),
        "--db",
        filename,
        "--all",
        "--apply",
        "--cutover",
        "--backup",
        backup,
        "--reconcile-native-manifest",
        manifest,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [cutoverStdout, cutoverStderr, cutoverCode] = await Promise.all([
      new Response(cutoverCommand.stdout).text(),
      new Response(cutoverCommand.stderr).text(),
      cutoverCommand.exited,
    ]);
    expect({ code: cutoverCode, stderr: cutoverStderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(cutoverStdout)).toMatchObject({
      phase: "v2_only",
      storageMode: "v2_only",
      nativeFactsPreserved: 3,
      nativeFactsReconciled: 1,
    });

    const migrated = new DatabaseSync(filename);
    expect(
      migrated
        .prepare(
          `SELECT event_id, type, event_hash, json_extract(payload_json, '$.actorPrincipalId') AS actor,
                  json_extract(payload_json, '$.reason') AS reason
             FROM conversation_events_v2
            WHERE event_id = ?`,
        )
        .get(corrected.event.eventId),
    ).toEqual({
      event_id: corrected.event.eventId,
      type: "run.corrected",
      event_hash: corrected.event.eventHash,
      actor: "admin:cutover",
      reason: "provider reconciliation found a terminal failure after the completed attempt row",
    });
    expect(
      migrated
        .prepare(
          `SELECT status, ended_at FROM conversation_runs_v2
            WHERE conversation_id = ? AND run_id = ?`,
        )
        .get(conversationId, runId),
    ).toEqual({ status: "failed", ended_at: "2026-09-17T00:00:04.000Z" });
    expect(
      migrated
        .prepare(`SELECT event_id, event_hash FROM conversation_native_facts_v2 WHERE event_id = ?`)
        .get(corrected.event.eventId),
    ).toEqual({ event_id: corrected.event.eventId, event_hash: corrected.event.eventHash });
    migrated.close();
  } finally {
    await removeTempDirectory(dir);
  }
});

test("migration preserves V1 attempt recovery metadata in V2 and detects corrupt metadata", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationStore(db);
    store.initialize();
    db.exec(`INSERT INTO threads (id, title, prompt, workspace_path, status, message, created_at, updated_at)
      VALUES ('thread', 'old', 'old', '/tmp', 'completed', '', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z')`);
    const metadata = {
      commandDispatch: { principalId: "user", clientCommandId: "command", dispatchId: "dispatch" },
      empty: "",
    };
    db.prepare(`INSERT INTO thread_run_attempts
      (thread_id, attempt_id, phase, retry_index, status, started_at, ended_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "thread",
      "attempt",
      "continuation",
      3,
      "completed",
      "2026-09-17T00:00:00Z",
      "2026-09-17T00:01:00Z",
      JSON.stringify(metadata),
    );
    store.conversationV2LegacyMigrator().migrate("thread");
    expect(store.listRunAttempts("thread")).toEqual([
      {
        threadId: "thread",
        attemptId: "attempt",
        phase: "continuation",
        retryIndex: 3,
        status: "completed",
        startedAt: "2026-09-17T00:00:00Z",
        endedAt: "2026-09-17T00:01:00Z",
        metadata,
      },
    ]);
    db.exec("UPDATE thread_run_attempts SET metadata_json = 'invalid json'");
    expect(store.conversationV2LegacyMigrator().inspect("thread")).toMatchObject({
      canMigrate: false,
      conflicts: ["invalid_attempt_metadata:attempt"],
    });
  } finally {
    db.close();
  }
});
