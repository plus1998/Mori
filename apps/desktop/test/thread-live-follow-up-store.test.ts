import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discardAbandonedAcceptedPrompts } from "../src/main/conversation-follow-up-accepted-prompt";
import { createConversationStore } from "../src/main/conversation-store";
import { PromptImageFileStore } from "../src/main/prompt-image-file-store";
import type { ThreadSummary } from "../src/shared/ipc";
import { abandonedFollowUpsForConversationMessage } from "../src/shared/thread-follow-up-drain";

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

function thread(id = "thr_followup"): ThreadSummary {
  return {
    id,
    title: "Follow-up",
    prompt: "start",
    workspacePath: "/tmp/project",
    status: "running",
    message: "working",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

async function createStore(coreKind?: ThreadSummary["coreKind"]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-follow-up-store-"));
  const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
  store.saveThread({ ...thread(), ...(coreKind ? { coreKind } : {}) });
  return store;
}

async function createLegacyStore(dbPath: string) {
  return createConversationStore(dbPath, {
    freshStorageMode: "legacy_compat",
    requiredStorageMode: "legacy_compat",
  });
}

test.skipIf(!sqliteAvailable)(
  "cutover materializes legacy follow-up attachments into V2 objects",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-follow-up-cutover-"));
    const dbPath = path.join(dir, "eco-coding.sqlite");
    const attachmentsRoot = path.join(dir, "prompt-images");
    const sourcePath = path.join(attachmentsRoot, "legacy", "prompt.png");
    const bytes = Buffer.from("legacy follow-up image");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, bytes);

    const store = await createLegacyStore(dbPath);
    store.saveThread(thread("thr_followup_cutover"));
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO thread_pending_followups (
       id, thread_id, prompt, attachments_json, priority, status, delivery_mode,
       source_run_attempt_id, target_run_attempt_id, queued_during_phase,
       delivery_boundary, error, queue_position, created_at, updated_at,
       delivered_at, applied_at, conversation_message_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
    ).run(
      "tfu_legacy_attachment",
      "thr_followup_cutover",
      "migrate this",
      JSON.stringify([{ mediaType: "image/png", path: sourcePath }]),
      "normal",
      "queued",
      "queued",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.close();

    store.setPromptImageFileStore(new PromptImageFileStore(dir, { rootDir: attachmentsRoot }));
    store.switchToV2OnlyStorage();

    const attachment = store.listThreadFollowUps("thr_followup_cutover")[0]?.attachments?.[0];
    expect(attachment).toEqual({
      mediaType: "image/png",
      contentRef: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.length,
    });
    expect(attachment).not.toHaveProperty("path");
    expect(attachment).not.toHaveProperty("data");
    expect(store.getConversationStorageMode()).toBe("v2_only");

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      (
        verify
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_pending_followups'`,
          )
          .get() as { name?: string } | undefined
      )?.name,
    ).toBeUndefined();
    verify.close();
  },
);

test.skipIf(!sqliteAvailable)(
  "cutover rejects legacy follow-up attachments without a durable store",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-follow-up-cutover-blocked-"));
    const dbPath = path.join(dir, "eco-coding.sqlite");
    const store = await createLegacyStore(dbPath);
    store.saveThread(thread("thr_followup_cutover_blocked"));
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO thread_pending_followups (
       id, thread_id, prompt, attachments_json, priority, status, delivery_mode,
       source_run_attempt_id, target_run_attempt_id, queued_during_phase,
       delivery_boundary, error, queue_position, created_at, updated_at,
       delivered_at, applied_at, conversation_message_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
    ).run(
      "tfu_legacy_attachment_blocked",
      "thr_followup_cutover_blocked",
      "do not lose this",
      JSON.stringify([{ mediaType: "image/png", data: "aGVsbG8=" }]),
      "normal",
      "queued",
      "queued",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.close();

    expect(() => store.switchToV2OnlyStorage()).toThrow("Durable prompt image store is required");
    expect(store.getConversationStorageMode()).toBe("legacy_compat");
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      (verify.prepare(`SELECT COUNT(*) AS count FROM thread_pending_followups`).get() as { count: number })
        .count,
    ).toBe(1);
    verify.close();
  },
);

test.skipIf(!sqliteAvailable)(
  "V2-only reopen migrates a leftover legacy follow-up before retiring its table",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-follow-up-reopen-cutover-"));
    const dbPath = path.join(dir, "eco-coding.sqlite");
    const attachmentsRoot = path.join(dir, "prompt-images");
    const sourcePath = path.join(attachmentsRoot, "legacy", "reopen.png");
    const bytes = Buffer.from("reopen follow-up image");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, bytes);

    const initial = await createConversationStore(dbPath, { freshStorageMode: "v2_only" });
    initial.saveThread(thread("thr_followup_reopen_cutover"));
    (initial as unknown as { db: DatabaseSync }).db.close();

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE thread_pending_followups (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        attachments_json TEXT,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_mode TEXT NOT NULL,
        source_run_attempt_id TEXT,
        target_run_attempt_id TEXT,
        queued_during_phase TEXT,
        delivery_boundary TEXT,
        error TEXT,
        queue_position INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        applied_at TEXT,
        conversation_message_id TEXT
      )
    `);
    seed
      .prepare(
        `INSERT INTO thread_pending_followups (
           id, thread_id, prompt, attachments_json, priority, status, delivery_mode,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "tfu_reopen_legacy_attachment",
        "thr_followup_reopen_cutover",
        "reopen this",
        JSON.stringify([{ mediaType: "image/png", path: sourcePath }]),
        "normal",
        "queued",
        "queued",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    seed.close();

    const reopened = await createConversationStore(dbPath, {
      requiredStorageMode: "v2_only",
      promptImageFileStore: new PromptImageFileStore(dir, { rootDir: attachmentsRoot }),
    });
    const attachment = reopened.listThreadFollowUps("thr_followup_reopen_cutover")[0]?.attachments?.[0];
    expect(attachment).toEqual({
      mediaType: "image/png",
      contentRef: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.length,
    });
    expect(attachment).not.toHaveProperty("path");

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      (
        verify
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_pending_followups'`,
          )
          .get() as { name?: string } | undefined
      )?.name,
    ).toBeUndefined();
    verify.close();
    (reopened as unknown as { db: DatabaseSync }).db.close();
  },
);

test.skipIf(!sqliteAvailable)("persists and orders queued follow-ups by priority", async () => {
  const store = await createStore();

  const normal = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "普通后续",
    attachments: [{ mediaType: "image/png", data: "abc" }],
    sourceRunAttemptId: "attempt_1",
    queuedDuringPhase: "execution",
    conversationMessageId: "message_v2_1",
  });
  const escalated = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "立即处理",
    priority: "escalated",
    deliveryMode: "interrupt_resume",
  });

  const listed = store.listThreadFollowUps("thr_followup");
  expect(listed.map((item) => item.id)).toEqual([escalated.id, normal.id]);
  expect(listed[0]).toMatchObject({
    prompt: "立即处理",
    priority: "escalated",
    deliveryMode: "interrupt_resume",
    status: "queued",
  });
  expect(listed[1]?.attachments?.[0]?.mediaType).toBe("image/png");
  expect(listed[1]).toMatchObject({
    sourceRunAttemptId: "attempt_1",
    queuedDuringPhase: "execution",
    conversationMessageId: "message_v2_1",
  });
});

test.skipIf(!sqliteAvailable)("loads pending follow-ups from an existing database", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-follow-up-reopen-"));
  const dbPath = path.join(dir, "eco-coding.sqlite");
  const store = await createConversationStore(dbPath);
  store.saveThread(thread("thr_reopen"));
  const saved = store.enqueueThreadFollowUp({
    threadId: "thr_reopen",
    prompt: "重启后继续",
  });

  const reopened = await createConversationStore(dbPath);
  expect(reopened.listThreadFollowUps("thr_reopen")).toMatchObject([
    {
      id: saved.id,
      prompt: "重启后继续",
      status: "queued",
    },
  ]);
});

test.skipIf(!sqliteAvailable)("escalates latest follow-up and supersedes older escalated items", async () => {
  const store = await createStore();
  const olderEscalated = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "旧的立即处理",
    priority: "escalated",
    deliveryMode: "interrupt_resume",
  });
  const normal = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "新的立即处理",
  });

  const escalated = store.escalateThreadFollowUp("thr_followup", normal.id);
  expect(escalated).toMatchObject({
    id: normal.id,
    priority: "escalated",
    deliveryMode: "queued",
    status: "queued",
  });
  expect(store.getThreadFollowUp("thr_followup", olderEscalated.id)?.status).toBe("superseded");
});

for (const coreKind of ["claude", "codex", "pi", "acp"] as const) {
  test.skipIf(!sqliteAvailable)(`${coreKind} Guide records its actual delivery strategy after rejection`, async () => {
    const store = await createStore(coreKind);
    expect(store.getThread("thr_followup")?.coreKind).toBe(coreKind);
    const normal = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "其他消息继续暂停" });
    const guide = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "引导当前回合" });
    store.setThreadFollowUpQueuePaused("thr_followup", true);
    const deliveryMode = coreKind === "acp" ? "interrupt_resume" : "queued";
    expect(store.escalateThreadFollowUp("thr_followup", guide.id)?.deliveryMode).toBe(deliveryMode);
    store.claimThreadFollowUpStreamingPush("thr_followup", guide.id);
    expect(store.requeueThreadFollowUpStreamingPush("thr_followup", guide.id, {
      error: "Ingress not accepting yet",
    })).toMatchObject({ status: "queued", deliveryMode, error: "Ingress not accepting yet" });
    // A natural boundary may deliver exactly the selected Guide without unpausing its siblings.
    const claimed = store.claimQueuedThreadFollowUps("thr_followup", {
      followUpId: guide.id, deliveryMode: "resume", deliveryBoundary: "safe_boundary",
    });
    expect(claimed.map((row) => row.id)).toEqual([guide.id]);
    expect(store.getThreadFollowUp("thr_followup", normal.id)?.status).toBe("queued");
    expect(store.getThread("thr_followup")?.followUpQueuePaused).toBe(true);
  });
}

test.skipIf(!sqliteAvailable)("cancels only queued follow-ups", async () => {
  const store = await createStore();
  const queued = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "稍后处理" });
  const cancelled = store.cancelThreadFollowUp("thr_followup", queued.id);
  expect(cancelled?.status).toBe("cancelled");

  const delivered = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "已交付" });
  store.updateThreadFollowUpStatus("thr_followup", delivered.id, { status: "delivered" });
  expect(store.cancelThreadFollowUp("thr_followup", delivered.id)).toBeUndefined();
});

test.skipIf(!sqliteAvailable)("a cancelled follow-up leaves no queued acceptance for recovery", async () => {
  const store = await createStore();
  const v2 = store.conversationV2();
  const accepted = v2.sendMessage({
    principalId: "desktop-local",
    conversationId: "thr_followup",
    clientCommandId: "cmd_follow_up_ghost",
    text: "auth.json 有 2 个路径",
  });
  const queued = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "auth.json 有 2 个路径",
    conversationMessageId: accepted.messageId,
  });
  expect(store.cancelThreadFollowUp("thr_followup", queued.id)?.status).toBe("cancelled");
  // Queue cancellation and the acceptance tombstone share one commit.
  expect(v2.getMessage("thr_followup", accepted.messageId)?.status).toBe("deleted");

  const abandoned = abandonedFollowUpsForConversationMessage(
    store.listThreadFollowUps("thr_followup"),
    accepted.messageId,
  );
  expect(abandoned.map((row) => row.id)).toEqual([queued.id]);

  discardAbandonedAcceptedPrompts(v2, {
    conversationId: "thr_followup",
    messageIds: abandoned.map((row) => row.conversationMessageId ?? ""),
    reason: "follow-up-cancelled",
  });
  expect(v2.listQueuedUserMessages()).toEqual([]);
});

test.skipIf(!sqliteAvailable)("updates queued follow-up prompt and attachments", async () => {
  const store = await createStore();
  const queued = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "原始引导",
    attachments: [{ mediaType: "image/png", data: "abc" }],
  });

  const updated = store.updateThreadFollowUp("thr_followup", queued.id, {
    prompt: "修改后的引导",
    attachments: [{ mediaType: "image/jpeg", data: "def" }],
  });

  expect(updated).toMatchObject({
    id: queued.id,
    prompt: "修改后的引导",
    status: "queued",
  });
  expect(updated?.attachments?.[0]?.mediaType).toBe("image/jpeg");
  expect(store.updateThreadFollowUp("thr_followup", queued.id, { prompt: "" })).toBeUndefined();
});

test("queue edits atomically replace the accepted body/images and survive reopen", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-follow-up-edit-"));
  const dbPath = path.join(dir, "eco-coding.sqlite");
  const store = await createConversationStore(dbPath);
  store.saveThread(thread());
  const v2 = store.conversationV2();
  const accepted = v2.sendMessage({
    principalId: "test", clientCommandId: "enqueue", conversationId: "thr_followup", text: "旧内容",
  });
  const queued = store.enqueueThreadFollowUp({
    threadId: "thr_followup", prompt: "旧内容", conversationMessageId: accepted.messageId,
  });
  const image = { mediaType: "image/png", contentRef: `sha256:${"a".repeat(64)}`, byteLength: 3 };
  store.updateThreadFollowUp("thr_followup", queued.id, { prompt: "新内容", attachments: [image] });
  expect(v2.getMessage("thr_followup", accepted.messageId)).toMatchObject({
    body: "新内容", status: "queued", contentVersion: 1, attachments: [image],
  });
  expect(() => v2.validateIntegrity("thr_followup")).not.toThrow();
  const reopened = await createConversationStore(dbPath);
  expect(reopened.getThreadFollowUp("thr_followup", queued.id)?.prompt).toBe("新内容");
  expect(reopened.conversationV2().listQueuedUserMessages()[0]?.body).toBe("新内容");
  reopened.updateThreadFollowUp("thr_followup", queued.id, { prompt: "", attachments: [image] });
  expect(reopened.getThreadFollowUp("thr_followup", queued.id)).toMatchObject({ prompt: "", attachments: [image] });
  expect(reopened.conversationV2().getMessage("thr_followup", accepted.messageId)).toMatchObject({
    body: "", attachments: [image],
  });
  expect(() => reopened.conversationV2().validateIntegrity("thr_followup")).not.toThrow();
  reopened.updateThreadFollowUp("thr_followup", queued.id, { prompt: "删除图片后的内容" });
  expect(reopened.conversationV2().getMessage("thr_followup", accepted.messageId)?.attachments).toEqual([]);
  expect(reopened.getThreadFollowUp("thr_followup", queued.id)?.attachments).toBeUndefined();
  expect(() => reopened.conversationV2().validateIntegrity("thr_followup")).not.toThrow();
  expect(reopened.conversationV2().sync("thr_followup", reopened.conversationV2().head("thr_followup").storeEpoch, 0).effects.some(
    ({ effect }) => effect.type === "message.replace" && effect.attachments?.length === 0,
  )).toBe(true);
  expect(reopened.claimQueuedThreadFollowUps("thr_followup")[0]?.prompt).toBe("删除图片后的内容");
});

test("a failed queue edit rolls back the accepted message and emits no commit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-follow-up-atomic-edit-"));
  const dbPath = path.join(dir, "eco-coding.sqlite");
  const store = await createConversationStore(dbPath);
  store.saveThread(thread());
  const v2 = store.conversationV2();
  const accepted = v2.sendMessage({
    principalId: "test", clientCommandId: "enqueue", conversationId: "thr_followup", text: "旧内容",
  });
  const queued = store.enqueueThreadFollowUp({
    threadId: "thr_followup", prompt: "旧内容", conversationMessageId: accepted.messageId,
  });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TRIGGER reject_queue_edit BEFORE UPDATE OF prompt ON conversation_followups_v2
    BEGIN SELECT RAISE(ABORT, 'edit write rejected'); END`);
  let commits = 0;
  v2.onCommitted(() => { commits += 1; });
  expect(() => store.updateThreadFollowUp("thr_followup", queued.id, { prompt: "新内容" }))
    .toThrow("edit write rejected");
  expect(store.getThreadFollowUp("thr_followup", queued.id)?.prompt).toBe("旧内容");
  expect(v2.getMessage("thr_followup", accepted.messageId)?.body).toBe("旧内容");
  expect(commits).toBe(0);
  db.close();
});

test("a failed queue cancellation rolls back its V2 tombstone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-follow-up-atomic-cancel-"));
  const dbPath = path.join(dir, "eco-coding.sqlite");
  const store = await createConversationStore(dbPath);
  store.saveThread(thread());
  const v2 = store.conversationV2();
  const accepted = v2.sendMessage({
    principalId: "test", clientCommandId: "enqueue", conversationId: "thr_followup", text: "待取消",
  });
  const queued = store.enqueueThreadFollowUp({
    threadId: "thr_followup", prompt: "待取消", conversationMessageId: accepted.messageId,
  });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TRIGGER reject_queue_cancel BEFORE UPDATE OF status ON conversation_followups_v2
    BEGIN SELECT RAISE(ABORT, 'cancel write rejected'); END`);
  let commits = 0;
  v2.onCommitted(() => { commits += 1; });
  expect(() => store.cancelThreadFollowUp("thr_followup", queued.id)).toThrow("cancel write rejected");
  expect(store.getThreadFollowUp("thr_followup", queued.id)?.status).toBe("queued");
  expect(v2.getMessage("thr_followup", accepted.messageId)).toMatchObject({ status: "queued", isDeleted: false });
  expect(commits).toBe(0);
  db.close();
});

test.skipIf(!sqliteAvailable)("claims queued follow-ups for later delivery", async () => {
  const store = await createStore();
  const first = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "第一条" });
  const second = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "第二条" });

  const claimed = store.claimQueuedThreadFollowUps("thr_followup", {
    deliveryMode: "resume",
    targetRunAttemptId: "attempt_1",
    deliveryBoundary: "safe_boundary",
  });

  expect(claimed).toHaveLength(1);
  expect(claimed[0]).toMatchObject({
    id: first.id,
    status: "delivered",
    deliveryMode: "resume",
    targetRunAttemptId: "attempt_1",
    deliveryBoundary: "safe_boundary",
  });
  expect(claimed[0]?.deliveredAt).toBeTruthy();
  expect(store.getThreadFollowUp("thr_followup", second.id)?.status).toBe("queued");
});

test.skipIf(!sqliteAvailable)("claims one queued follow-up by default", async () => {
  const store = await createStore();
  const first = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "第一条" });
  const second = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "第二条" });

  const claimed = store.claimQueuedThreadFollowUps("thr_followup", {
    deliveryMode: "resume",
    deliveryBoundary: "safe_boundary",
  });

  expect(claimed.map((item) => item.id)).toEqual([first.id]);
  expect(store.getThreadFollowUp("thr_followup", second.id)?.status).toBe("queued");
});

test.skipIf(!sqliteAvailable)("claims only escalated follow-ups when priority is requested", async () => {
  const store = await createStore();
  const normal = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "普通排队" });
  const escalated = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "立即处理",
    priority: "escalated",
    deliveryMode: "interrupt_resume",
  });

  const claimed = store.claimQueuedThreadFollowUps("thr_followup", {
    priority: "escalated",
    deliveryMode: "resume",
  });

  expect(claimed.map((item) => item.id)).toEqual([escalated.id]);
  expect(store.getThreadFollowUp("thr_followup", normal.id)?.status).toBe("queued");
});

test.skipIf(!sqliteAvailable)("a cancelled Guide cannot force-send an unrelated normal row", async () => {
  const store = await createStore();
  const normal = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "remain paused" });
  const guide = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "handle now",
    priority: "escalated",
  });
  store.setThreadFollowUpQueuePaused("thr_followup", true);
  store.cancelThreadFollowUp("thr_followup", guide.id);
  const claimed = store.claimQueuedThreadFollowUps("thr_followup", {
    priority: "escalated",
    deliveryMode: "resume",
    deliveryBoundary: "forced_interrupt",
  });
  expect(claimed).toEqual([]);
  expect(store.getThreadFollowUp("thr_followup", normal.id)?.status).toBe("queued");
  expect(store.getThread("thr_followup")?.followUpQueuePaused).toBe(true);
});

test.skipIf(!sqliteAvailable)("claimQueuedThreadFollowUps skips an excluded follow-up id", async () => {
  const store = await createStore();
  const editing = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "正在编辑" });
  const next = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "下一条" });

  const claimed = store.claimQueuedThreadFollowUps("thr_followup", {
    deliveryMode: "resume",
    excludeFollowUpId: editing.id,
  });

  expect(claimed.map((item) => item.id)).toEqual([next.id]);
  expect(store.getThreadFollowUp("thr_followup", editing.id)?.status).toBe("queued");
});

test.skipIf(!sqliteAvailable)("claimThreadFollowUpStreamingPush rejects excluded follow-up id", async () => {
  const store = await createStore();
  const queued = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "mid-turn text",
  });

  expect(
    store.claimThreadFollowUpStreamingPush("thr_followup", queued.id, {
      excludeFollowUpId: queued.id,
    }),
  ).toBeUndefined();
  expect(store.getThreadFollowUp("thr_followup", queued.id)?.status).toBe("queued");
});

test.skipIf(!sqliteAvailable)("deleteThread removes pending follow-ups", async () => {
  const store = await createStore();
  store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "待清理" });

  expect(store.deleteThread("thr_followup")).toBe(true);
  expect(store.listThreadFollowUps("thr_followup")).toEqual([]);
});

test.skipIf(!sqliteAvailable)("claims then applies a streaming push", async () => {
  const store = await createStore();
  const queued = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "mid-turn text",
  });
  const claimed = store.claimThreadFollowUpStreamingPush("thr_followup", queued.id, {
    targetRunAttemptId: "attempt_push",
  });
  expect(claimed).toMatchObject({
    id: queued.id,
    status: "delivered",
    deliveryMode: "streaming_push",
    targetRunAttemptId: "attempt_push",
  });
  expect(claimed?.deliveredAt).toBeTruthy();
  expect(claimed?.appliedAt).toBeUndefined();
  expect(store.cancelThreadFollowUp("thr_followup", queued.id)).toBeUndefined();
  expect(store.updateThreadFollowUp("thr_followup", queued.id, { prompt: "changed" })).toBeUndefined();

  const applied = store.markThreadFollowUpStreamingPushApplied("thr_followup", queued.id);
  expect(applied?.status).toBe("applied");
  expect(applied?.appliedAt).toBeTruthy();
  expect(store.claimThreadFollowUpStreamingPush("thr_followup", queued.id)).toBeUndefined();
});

test.skipIf(!sqliteAvailable)("definitely rejected streaming push returns to the queue", async () => {
  const store = await createStore();
  const queued = store.enqueueThreadFollowUp({
    threadId: "thr_followup",
    prompt: "was injected",
  });
  store.claimThreadFollowUpStreamingPush("thr_followup", queued.id);
  const requeued = store.requeueThreadFollowUpStreamingPush("thr_followup", queued.id, {
    error: "explicit rejection",
  });
  expect(requeued).toMatchObject({
    id: queued.id,
    status: "queued",
    deliveryMode: "queued",
    error: "explicit rejection",
  });
  expect(requeued?.deliveredAt).toBeUndefined();
  expect(requeued?.appliedAt).toBeUndefined();
  // claim can pick it up again
  const claimed = store.claimQueuedThreadFollowUps("thr_followup", { deliveryMode: "resume" });
  expect(claimed.map((item) => item.id)).toEqual([queued.id]);
});

test.skipIf(!sqliteAvailable)("streaming_push applied is not claimed by queued drain", async () => {
  const store = await createStore();
  const pushed = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "pushed" });
  const waiting = store.enqueueThreadFollowUp({ threadId: "thr_followup", prompt: "waiting" });
  store.claimThreadFollowUpStreamingPush("thr_followup", pushed.id);
  store.markThreadFollowUpStreamingPushApplied("thr_followup", pushed.id);
  const claimed = store.claimQueuedThreadFollowUps("thr_followup", { deliveryMode: "resume" });
  expect(claimed.map((item) => item.id)).toEqual([waiting.id]);
});
