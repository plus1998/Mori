import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createConversationStore } from "../src/main/conversation-store";

test("resource lookup reads thread IDs without decoding runtime configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mori-thread-ids-"));
  const filename = path.join(directory, "test.sqlite");
  const store = await createConversationStore(filename);
  try {
    assert.deepEqual(store.listThreadIds(), []);
    assert.equal(store.hasThread("older"), false);
    for (const [id, createdAt] of [
      ["older", "2026-01-01T00:00:00Z"],
      ["newer", "2026-01-02T00:00:00Z"],
    ] as const) {
      store.saveThread({
        id: id,
        title: id,
        prompt: "",
        workspacePath: directory,
        status: "idle",
        message: "",
        createdAt: createdAt,
        updatedAt: createdAt,
      });
    }
    const expected = store.listThreads().map((thread) => thread.id);
    const db = new DatabaseSync(filename);
    db.prepare("UPDATE threads SET runtime_config_json = ?").run("invalid-json");
    db.close();
    const parse = JSON.parse;
    let parses = 0;
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
      parses++;
      return parse(...args);
    };
    try {
      assert.deepEqual(store.listThreadIds(), expected);
      assert.equal(store.hasThread("older"), true);
      assert.equal(store.hasThread("missing"), false);
      assert.equal(parses, 0);
      store.listThreads();
      assert.ok(parses > 0);
    } finally {
      JSON.parse = parse;
    }
    store.deleteThread("older");
    assert.equal(store.hasThread("older"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
