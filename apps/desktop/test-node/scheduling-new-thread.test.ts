import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createConversationStore } from "../src/main/conversation-store";
import { SchedulingStore } from "../src/main/scheduling-store";
import { SchedulingService, type SchedulingDeps } from "../src/main/scheduling-service";
import { saveNewScheduledMessageThread } from "../src/main/scheduling-new-thread";
import { enqueueScheduledMessage } from "../src/main/scheduling-message-dispatch";
import { PromptImageFileStore } from "../src/main/prompt-image-file-store";
import { buildAcpThreadRuntimeConfig } from "../src/shared/thread-runtime-config";
import type { ScheduleCreateInput } from "../src/shared/scheduling";

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-new-thread-schedule-"));
  const dbPath = path.join(directory, "test.sqlite");
  const conversations = await createConversationStore(dbPath);
  const schedules = new SchedulingStore(dbPath);
  const images = new PromptImageFileStore(directory);
  conversations.setPromptImageFileStore(images);
  const db = (conversations as unknown as { db: DatabaseSync }).db;
  let now = Date.parse("2026-10-24T00:00:00Z");
  const deps: SchedulingDeps = {
    inheritProfile: () => { throw new Error("Not an agent wakeup"); },
    assertThread: id => { assert.ok(conversations.getThread(id)); },
    validateProfile: profile => { if (!profile.runtimeConfig.cursorModelId) throw new Error("Missing model"); },
    createThreadWithSchedule: (d, key, input) => { saveNewScheduledMessageThread(d, key, input, conversations, schedules); },
    canDispatch: () => true,
    dispatch: async occurrence => {
      const followUp = await enqueueScheduledMessage(occurrence, conversations, images);
      return { threadId: occurrence.definition.threadId!, followUpId: followUp.id };
    },
    inspect: () => ({ status: "running" }),
    onChanged: () => {}, onError: error => { throw error; },
  };
  const service = new SchedulingService(schedules, deps, () => now);
  const input: ScheduleCreateInput = {
    kind: "session_message", requestId: "new-thread-request", threadId: "thr_reserved",
    name: "First message", prompt: "Run only after the chosen time",
    trigger: { type: "at", at: new Date(now + 60_000).toISOString() },
    newThread: { workspacePath: directory, executionProfile: {
      coreKind: "acp", runtimeConfig: buildAcpThreadRuntimeConfig({ cursorModelId: "fixed-model" }),
    } },
  };
  t.after(async () => { service.stop(); schedules.close(); db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { conversations, schedules, images, db, service, input, deps, directory, advance: () => { now += 60_000; } };
}

test("a new conversation and first image schedule commit together without starting or sending", async t => {
  const f = await fixture(t);
  const staged = await f.images.stageComposerImage({ contextKey: `landing:${f.directory}`, imageId: "first-image",
    mediaType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGkAAAAASUVORK5CYII=" });
  f.input.attachments = [{ mediaType: "image/png", contentRef: staged.contentRef, byteLength: staged.byteLength }];
  const created = f.service.create(f.input);
  const thread = f.conversations.getThread("thr_reserved")!;
  assert.equal(thread.status, "idle");
  assert.equal(thread.prompt, "");
  assert.equal(thread.runtimeConfig?.cursorModelId, "fixed-model");
  assert.equal(f.conversations.getThreadCoreSession(thread.id), undefined);
  for (const table of ["conversation_messages_v2", "conversation_runs_v2", "conversation_followups_v2"])
    assert.equal((f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  assert.deepEqual(f.service.create(f.input), created, "lost-response retry reuses both records");
  assert.equal(f.conversations.listThreads().length, 1);
  assert.equal(f.schedules.list().length, 1);
  const reopened = new SchedulingStore(path.join(f.directory, "test.sqlite"));
  try {
    const restarted = new SchedulingService(reopened, f.deps);
    assert.deepEqual(restarted.create(f.input), created, "retry identity survives service restart");
  } finally { reopened.close(); }
  await f.images.releasePaths([staged.path]);
  assert.equal(f.conversations.isPromptImageContentRefAuthorized(`thread:${thread.id}`, staged.contentRef), true);
  const gc = await f.images.sweepUnreferencedContentObjects({ minAgeMs: 0, resolveReferencedContentRefs: () => f.conversations.listReferencedPromptImageContentRefs() });
  assert.equal(gc.removed, 0);
  f.advance();
  await f.service.tick();
  const occurrence = f.schedules.occurrences()[0]!;
  const message = f.conversations.conversationV2().getMessage(thread.id, `message_${occurrence.id}`)!;
  assert.equal(message.body, f.input.prompt);
  assert.equal(message.attachments?.[0]?.contentRef, staged.contentRef);
  assert.equal(f.conversations.listThreadFollowUps(thread.id).length, 1);
  await f.service.tick();
  assert.equal(f.conversations.listThreadFollowUps(thread.id).length, 1);
});

test("failed schedule insert rolls back the conversation, stream and creation receipt", async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER reject_test_schedule BEFORE INSERT ON schedule_definitions BEGIN SELECT RAISE(ABORT, 'disk write rejected'); END");
  assert.throws(() => f.service.create(f.input), /disk write rejected/);
  assert.equal(f.conversations.getThread("thr_reserved"), undefined);
  for (const table of ["conversation_streams_v2", "schedule_definitions", "schedule_creation_receipts"])
    assert.equal((f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  f.db.exec("DROP TRIGGER reject_test_schedule");
  f.service.create(f.input);
  assert.equal(f.conversations.listThreads().length, 1);
  assert.equal(f.schedules.list().length, 1);
});

test("new-thread schedules reject overwriting, changed retries, agents and invalid configuration", async t => {
  const f = await fixture(t);
  assert.throws(() => f.service.create(f.input, { source: "agent", threadId: "thr_reserved" }), /Agent/);
  assert.throws(() => f.service.create({ ...f.input, trigger: { type: "at", at: "2020-01-01T00:00:00Z" } }), /未来/);
  const validate = f.deps.validateProfile;
  f.deps.validateProfile = () => { throw new Error("Invalid account"); };
  assert.throws(() => f.service.create(f.input), /Invalid account/);
  assert.equal(f.conversations.listThreads().length, 0);
  f.deps.validateProfile = validate;
  f.service.create(f.input);
  assert.throws(() => f.service.create({ ...f.input, prompt: "Changed" }), /另一份/);
  assert.throws(() => f.service.create({ ...f.input, requestId: "different-request" }), /不能覆盖/);
  assert.equal(f.conversations.listThreads().length, 1);
  assert.equal(f.schedules.list().length, 1);
});
