import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createConversationStore } from "../src/main/conversation-store";
import { PromptImageFileStore } from "../src/main/prompt-image-file-store";
import { normalizeSchedulingAttachments, verifySchedulingAttachments } from "../src/main/scheduling-attachments";
import { enqueueScheduledMessage } from "../src/main/scheduling-message-dispatch";
import { SchedulingService } from "../src/main/scheduling-service";
import { SchedulingStore } from "../src/main/scheduling-store";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGkAAAAASUVORK5CYII=";

test("scheduled images survive clearing drafts, GC and restart, then reach V2 and the queue once", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-scheduled-images-"));
  const dbPath = path.join(directory, "test.sqlite");
  let conversations = await createConversationStore(dbPath);
  const images = new PromptImageFileStore(directory);
  conversations.setPromptImageFileStore(images);
  let schedules = new SchedulingStore(dbPath);
  t.after(async () => {
    schedules.close();
    (conversations as unknown as { db: DatabaseSync }).db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const threadId = "thr_scheduled_images";
  conversations.saveThread({ id: threadId, title: "Image schedule", prompt: "", workspacePath: directory,
    status: "failed", message: "Previous run ended", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const staged = await images.stageComposerImage({ contextKey: `thread:${threadId}`, imageId: "todo-image", mediaType: "image/png", dataBase64: png });
  const attachments = await verifySchedulingAttachments([{ ...staged, mediaType: "image/png" }], ref => images.readContentRefAttachment(ref));
  assert.equal(attachments[0]?.path, undefined);
  assert.equal(attachments[0]?.data, undefined);
  let now = Date.parse("2026-10-24T00:00:00Z");
  const deps = {
    inheritProfile: () => { throw new Error("Not a task"); }, validateProfile: () => {}, assertThread: () => {},
    canDispatch: () => true,
    dispatch: async (occurrence: Parameters<typeof enqueueScheduledMessage>[0]) => {
      const item = await enqueueScheduledMessage(occurrence, conversations, images);
      return { threadId, followUpId: item.id };
    },
    inspect: () => ({ status: "running" as const }), onChanged: () => {}, onError: (e: unknown) => { throw e; },
  };
  let service = new SchedulingService(schedules, deps, () => now);
  const input = { kind: "session_message" as const, requestId: "todo-with-image", name: "image only", prompt: "", threadId, attachments,
    trigger: { type: "at" as const, at: new Date(now + 60_000).toISOString() } };
  const definition = service.create(input);
  assert.equal(service.create(input).id, definition.id);
  const unownedRef = `sha256:${"f".repeat(64)}`;
  service.update({ id: definition.id, expectedRevision: definition.revision, prompt: `A literal reference in the text: ${unownedRef}` });
  assert.equal(conversations.isPromptImageContentRefAuthorized(`thread:${threadId}`, unownedRef), false);
  assert.equal((await conversations.listReferencedPromptImageContentRefs()).has(unownedRef), false);
  assert.throws(() => service.create({ ...input, attachments: [] }), /不能为空|另一份/);
  await images.releasePaths([staged.path]);
  assert.equal(conversations.isPromptImageContentRefAuthorized(`thread:${threadId}`, staged.contentRef), true);
  assert.equal(conversations.isPromptImageContentRefAuthorized("thread:another-thread", staged.contentRef), false);
  assert.equal((await conversations.listReferencedPromptImageContentRefs()).has(staged.contentRef), true);
  const gc = await images.sweepUnreferencedContentObjects({ minAgeMs: 0, resolveReferencedContentRefs: () => conversations.listReferencedPromptImageContentRefs() });
  assert.equal(gc.removed, 0);
  assert.equal(gc.retainedReferenced, 1);

  schedules.close();
  (conversations as unknown as { db: DatabaseSync }).db.close();
  conversations = await createConversationStore(dbPath);
  conversations.setPromptImageFileStore(images);
  schedules = new SchedulingStore(dbPath);
  service = new SchedulingService(schedules, deps, () => now);
  now += 60_000;
  await service.tick();
  assert.equal(schedules.get(definition.id), undefined, "a handed-off one-shot leaves the pending list");
  const occurrence = schedules.occurrences()[0]!;
  assert.equal(occurrence.status, "running");
  const message = conversations.conversationV2().getMessage(threadId, `message_${occurrence.id}`)!;
  assert.equal(message.attachments?.[0]?.contentRef, staged.contentRef);
  const queued = conversations.listThreadFollowUps(threadId);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.attachments?.[0]?.contentRef, staged.contentRef);
  assert.equal(await images.readAttachmentData(queued[0]!.attachments![0]!), png);
  await enqueueScheduledMessage(occurrence, conversations, images);
  assert.equal(conversations.listThreadFollowUps(threadId).length, 1);
  assert.equal(conversations.isPromptImageContentRefAuthorized(`thread:${threadId}`, staged.contentRef), true);
});

test("scheduled image validation rejects missing, mismatched and temporary-only content", async () => {
  assert.throws(() => normalizeSchedulingAttachments([{ mediaType: "image/png", path: "/tmp/disposable.png" }]), /持久引用/);
  const a = { mediaType: "image/png", contentRef: `sha256:${"a".repeat(64)}`, byteLength: 10 };
  await assert.rejects(verifySchedulingAttachments([a], async () => ({ mediaType: "image/jpeg", byteLength: 10 })), /不一致/);
  await assert.rejects(verifySchedulingAttachments([a], async () => { throw new Error("Missing image object"); }), /Missing image/);
});
