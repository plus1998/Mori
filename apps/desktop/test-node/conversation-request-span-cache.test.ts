import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ConversationStore } from "../src/main/conversation-store";

test("native SQLite invalidates cached request sources after a second connection repairs materialized data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mori-span-cache-"));
  const filename = path.join(directory, "test.sqlite");
  const db = new DatabaseSync(filename);
  let other: DatabaseSync | undefined;
  try {
    const store = new ConversationStore(db, { freshStorageMode: "v2_only" });
    store.initialize();
    store.saveThread({
      id: "thread",
      title: "cache",
      prompt: "hi",
      workspacePath: "/tmp/project",
      status: "running",
      message: "",
      coreKind: "codex",
      createdAt: "2026-11-08T00:00:00Z",
      updatedAt: "2026-11-08T00:00:00Z",
    });
    store.appendConversationRuntimeEvent({
      id: "start",
      threadId: "thread",
      requestId: "r",
      eventType: "request.started",
      scope: "main",
      streamState: "none",
      message: "",
      observedAt: "2026-11-08T00:00:00Z",
    });
    const read = () => store.getConversationV2ProjectionExtras("thread")!.requestSpans;
    assert.equal(read()[0]?.providerRequestId, undefined);
    other = new DatabaseSync(filename);
    other
      .prepare(`UPDATE conversation_provider_inputs_v2
      SET source_json = json_set(source_json, '$.metadata.providerRequestId', 'repaired-id')
      WHERE conversation_id = 'thread' AND input_id = 'start'`)
      .run();
    assert.equal(read()[0]?.providerRequestId, "repaired-id");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE threads SET status = 'idle' WHERE id = 'thread'").run();
    assert.equal(read()[0]?.status, "completed");
    db.exec("ROLLBACK");
    assert.equal(read()[0]?.status, "waiting_first_token");
  } finally {
    other?.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
