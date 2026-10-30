import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ThreadSummary } from "../src/shared/ipc";
import { ConversationStore } from "../src/main/conversation-store";
import { executeFollowUpMutationCommand } from "../src/main/conversation-follow-up-command";
import { ProjectTodoStore } from "../src/main/project-todo-store";
import { moveQueuedFollowUpToTodo } from "../src/main/thread-follow-up-todo";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function harness(withImage = false, text = "保留完整正文\n以及 @引用") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-follow-up-todo-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "eco.sqlite");
  const conversationDb = new DatabaseSync(filename);
  const conversations = new ConversationStore(conversationDb, { freshStorageMode: "v2_only", requiredStorageMode: "v2_only" });
  conversations.initialize();
  cleanup.push(() => conversationDb.close());
  const db = new DatabaseSync(filename);
  const thumbnail = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
  const todos = new ProjectTodoStore(db, thumbnail);
  cleanup.push(() => todos.close());
  conversations.saveThread({
    id: "thread-1", title: "Queue", prompt: "start", workspacePath: "/project/source",
    status: "running", message: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } satisfies ThreadSummary);
  const v2 = conversations.conversationV2();
  const message = v2.sendMessage({ principalId: "test", conversationId: "thread-1", clientCommandId: "enqueue", text: text || "image" });
  const followUp = conversations.enqueueThreadFollowUp({ threadId: "thread-1", prompt: text || "image", conversationMessageId: message.messageId });
  const bytes = Buffer.from("original image bytes");
  if (withImage) conversations.updateThreadFollowUp("thread-1", followUp.id, {
    prompt: text,
    attachments: [{ mediaType: "image/png", contentRef: `sha256:${"a".repeat(64)}`, byteLength: bytes.length }],
  });
  const input = { threadId: "thread-1", followUpId: followUp.id };
  const deps = { conversations, todos, thumbnail, readAttachment: async () => bytes.toString("base64") };
  return { filename, db, input, deps, bytes, message, v2, conversations, todos };
}

function expectStillQueued(state: Awaited<ReturnType<typeof harness>>) {
  expect(state.conversations.getThreadFollowUp(state.input.threadId, state.input.followUpId)?.status).toBe("queued");
  expect(state.v2.getMessage(state.input.threadId, state.message.messageId)).toMatchObject({ status: "queued", isDeleted: false });
  expect(state.todos.list()).toHaveLength(0);
  expect(() => state.v2.validateIntegrity(state.input.threadId)).not.toThrow();
}

test("moving a queued message preserves its project, text and original image across reopening", async () => {
  const state = await harness(true);
  const result = await moveQueuedFollowUpToTodo(state.input, state.deps);
  expect(result.todo).toMatchObject({ projectPath: "/project/source", text: "保留完整正文\n以及 @引用", status: "pending", completed: false });
  expect(state.todos.get(result.todo.id).images[0]?.data).toBe(state.bytes.toString("base64"));
  expect(result.todo.images[0]?.data).toBeUndefined();
  expect(result.followUp.status).toBe("cancelled");
  expect(state.v2.getMessage("thread-1", state.message.messageId)?.isDeleted).toBe(true);
  expect(state.v2.listQueuedUserMessages()).toHaveLength(0);
  expect(state.conversations.claimQueuedThreadFollowUps("thread-1")).toHaveLength(0);
  const reopenedDb = new DatabaseSync(state.filename);
  const reopened = new ConversationStore(reopenedDb, { requiredStorageMode: "v2_only" });
  reopened.initialize();
  cleanup.push(() => reopenedDb.close());
  expect(reopened.listThreadFollowUps("thread-1", { statuses: ["queued"] })).toHaveLength(0);
  expect(reopened.conversationV2().listQueuedUserMessages()).toHaveLength(0);
  expect(() => reopened.conversationV2().validateIntegrity("thread-1")).not.toThrow();
});

test("image-only queued messages become image-only todos", async () => {
  const state = await harness(true, "");
  const result = await moveQueuedFollowUpToTodo(state.input, state.deps);
  expect(result.todo.text).toBe("");
  expect(state.todos.get(result.todo.id).images[0]?.data).toBe(state.bytes.toString("base64"));
});

for (const destinationFails of [false, true]) {
  test(`a failed ${destinationFails ? "todo insert" : "queue cancellation"} rolls back the whole transfer`, async () => {
    const state = await harness(true);
    state.db.exec(destinationFails
      ? `CREATE TRIGGER reject_transfer BEFORE INSERT ON project_todos BEGIN SELECT RAISE(ABORT, 'destination failed'); END`
      : `CREATE TRIGGER reject_transfer BEFORE UPDATE OF status ON conversation_followups_v2 BEGIN SELECT RAISE(ABORT, 'queue failed'); END`);
    let commits = 0;
    state.v2.onCommitted(() => { commits++; });
    await expect(moveQueuedFollowUpToTodo(state.input, state.deps)).rejects.toThrow(destinationFails ? "destination failed" : "queue failed");
    expectStillQueued(state);
    expect(commits).toBe(0);
  });
}

test("unreadable image originals leave the queue untouched", async () => {
  const state = await harness(true);
  await expect(moveQueuedFollowUpToTodo(state.input, { ...state.deps, readAttachment: async () => { throw new Error("original missing"); } })).rejects.toThrow("original missing");
  expectStillQueued(state);
});

test("a concurrent edit during image loading cannot move an old version", async () => {
  const state = await harness(true);
  const result = moveQueuedFollowUpToTodo(state.input, {
    ...state.deps,
    readAttachment: async () => {
      state.conversations.updateThreadFollowUp("thread-1", state.input.followUpId, { prompt: "newer edit" });
      return state.bytes.toString("base64");
    },
  });
  await expect(result).rejects.toThrow("Queued message changed");
  expectStillQueued(state);
  expect(state.conversations.getThreadFollowUp("thread-1", state.input.followUpId)?.prompt).toBe("newer edit");
});

test("a message claimed before or during image loading cannot also become a todo", async () => {
  for (const duringRead of [false, true]) {
    const state = await harness(true);
    if (!duringRead) state.conversations.claimQueuedThreadFollowUps("thread-1");
    await expect(moveQueuedFollowUpToTodo(state.input, {
      ...state.deps,
      readAttachment: async () => {
        state.conversations.claimQueuedThreadFollowUps("thread-1");
        return state.bytes.toString("base64");
      },
    })).rejects.toThrow("no longer queued");
    expect(state.todos.list()).toHaveLength(0);
    expect(state.conversations.getThreadFollowUp("thread-1", state.input.followUpId)?.status).toBe("delivered");
    expect(state.v2.getMessage("thread-1", state.message.messageId)?.isDeleted).toBe(false);
  }
});

test("transport retries reuse the committed migration receipt and create only one todo", async () => {
  const state = await harness();
  const command = {
    principalId: "test", clientCommandId: "move-1", conversationId: "thread-1",
    expectedHistoryRevision: state.v2.head("thread-1").historyRevision,
    operation: "move-to-todo", request: { followUpId: state.input.followUpId },
  };
  const deps = { v2: state.v2, execute: () => moveQueuedFollowUpToTodo(state.input, state.deps), errorMessage: (error: unknown) => String(error) };
  const first = await executeFollowUpMutationCommand(command, deps);
  const retry = await executeFollowUpMutationCommand(command, deps);
  expect(retry.todo.id).toBe(first.todo.id);
  expect(state.todos.list()).toHaveLength(1);
});
