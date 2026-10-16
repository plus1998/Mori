import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/main/conversation-store";
import { createThreadDeleteCommandCoordinator } from "../src/main/conversation-thread-delete-command";

test("deletion uses indexed lookups across conversations, including after upgrading an existing database", async () => {
  const db = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const trackedDb = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const initial = new ConversationStore(db, { freshStorageMode: "v2_only" });
    initial.initialize();
    // Simulate the schema shipped before the deletion indexes existed.
    db.exec(`
      DROP INDEX idx_conversation_events_v2_fork_source;
      DROP INDEX idx_conversation_command_receipts_v2_conversation;
      DROP INDEX idx_conversation_command_jobs_v2_conversation;
      DROP INDEX idx_conversation_command_checkpoints_v2_conversation;
    `);
    const store = new ConversationStore(trackedDb, { freshStorageMode: "v2_only" });
    store.initialize();
    for (const id of ["source", "child", "unrelated"]) {
      store.saveThread({
        id,
        title: id,
        prompt: "hello",
        workspacePath: "/tmp",
        status: "completed",
        message: "",
        createdAt: "2026-10-17T00:00:00Z",
        updatedAt: "2026-10-17T00:00:00Z",
      });
      store.conversationV2().ensureConversation(id);
    }
    store.conversationV2().appendRuntime({
      conversationId: "child",
      eventId: "fork-lineage",
      type: "noop",
      occurredAt: "2026-10-17T00:00:00Z",
      payload: { reason: "history.fork_created", sourceThreadId: "source" },
    });
    store.conversationV2().appendRuntime({
      conversationId: "unrelated",
      eventId: "not-a-fork",
      type: "noop",
      occurredAt: "2026-10-17T00:00:00Z",
      payload: { reason: "other", sourceThreadId: "unrelated" },
    });

    statements.length = 0;
    expect(store.hasForkImageDependents("source")).toBe(true);
    const dependencySql = statements.find((sql) => sql.includes("'$.sourceThreadId'"));
    if (!dependencySql) throw new Error("Fork dependency query was not executed.");
    const dependencyPlan = db.prepare(`EXPLAIN QUERY PLAN ${dependencySql}`).all("source") as Array<{
      detail: string;
    }>;
    expect(dependencyPlan.some((row) => row.detail.startsWith("SEARCH "))).toBe(true);
    expect(dependencyPlan.some((row) => row.detail.startsWith("SCAN "))).toBe(false);
    expect(store.hasForkImageDependents("unrelated")).toBe(false);

    statements.length = 0;
    const execute = createThreadDeleteCommandCoordinator({
      conversationStore: store,
      cleanupExternalState: async () => {},
    });
    await execute({
      principalId: "desktop-local",
      threadId: "child",
      clientCommandId: "delete-child",
      expectedHistoryRevision: store.conversationV2().head("child").historyRevision,
    });
    const deletionSql = [...new Set(statements.filter((sql) => /^DELETE FROM /i.test(sql)))];
    expect(deletionSql.length).toBeGreaterThan(10);
    for (const sql of deletionSql) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("child") as Array<{ detail: string }>;
      expect({ sql, scans: plan.filter((row) => row.detail.startsWith("SCAN ")) }).toEqual({
        sql,
        scans: [],
      });
    }
    expect(store.getThread("child")).toBeUndefined();
    expect(store.getThread("source")).toBeDefined();
    expect(store.getThread("unrelated")).toBeDefined();
    expect(store.hasForkImageDependents("source")).toBe(false);
    expect(store.conversationV2().head("unrelated").lastSeq).toBe(1);
  } finally {
    db.close();
  }
});
