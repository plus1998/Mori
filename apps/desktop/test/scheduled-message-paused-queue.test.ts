import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createConversationStore } from "../src/main/conversation-store";
import { PromptImageFileStore } from "../src/main/prompt-image-file-store";
import { canDispatchScheduledMessage } from "../src/main/scheduling-dispatch-policy";
import { inspectScheduledRun } from "../src/main/scheduling-inspection";
import { enqueueScheduledMessage, isScheduledMessageFollowUp } from "../src/main/scheduling-message-dispatch";
import { SchedulingService, type SchedulingDeps } from "../src/main/scheduling-service";
import { SchedulingStore } from "../src/main/scheduling-store";
import type { ThreadPendingFollowUp } from "../src/shared/ipc";
import {
  selectThreadFollowUpDrainTarget,
  shouldBlockThreadFollowUpDrain,
} from "../src/shared/thread-follow-up-drain";
import { removeTempDirectorySync } from "./helpers/temp-directory";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "eco-scheduled-paused-"));
  cleanups.push(() => removeTempDirectorySync(directory));
  const dbPath = join(directory, "test.sqlite");
  const store = await createConversationStore(dbPath);
  cleanups.push(() => (store as unknown as { db: DatabaseSync }).db.close());
  const threadId = "thread-paused-scheduled";
  store.saveThread({
    id: threadId,
    title: "paused schedule",
    prompt: "",
    workspacePath: directory,
    status: "completed",
    message: "",
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  });
  const v2 = store.conversationV2();
  const ordinary = ["first", "second"].map((id) => {
    const accepted = v2.sendMessage({
      principalId: "desktop",
      conversationId: threadId,
      clientCommandId: id,
      text: id,
    });
    return store.enqueueThreadFollowUp({ threadId, prompt: id, conversationMessageId: accepted.messageId });
  });
  store.setThreadFollowUpQueuePaused(threadId, true);
  const schedules = new SchedulingStore(dbPath);
  cleanups.push(() => schedules.close());
  const images = new PromptImageFileStore(directory);
  store.setPromptImageFileStore(images);
  let now = Date.parse("2026-10-26T00:00:00Z");
  let active = false;
  let approval = false;
  let dispatched = 0;
  const deps: SchedulingDeps = {
    inheritProfile: () => {
      throw new Error("Not an independent task");
    },
    validateProfile: () => {},
    assertThread: () => {},
    onChanged: () => {},
    onError: (error) => {
      throw error;
    },
    canDispatch: () =>
      canDispatchScheduledMessage({
        thread: store.getThread(threadId)!,
        hasActiveRun: active,
        hasPendingUserAction: approval,
        isCompacting: false,
        hasEditingFollowUp: false,
      }),
    dispatch: async (occurrence) => {
      dispatched++;
      const followUp = await enqueueScheduledMessage(occurrence, store, images);
      return { threadId, followUpId: followUp.id };
    },
    inspect: (occurrence) =>
      inspectScheduledRun({
        kind: occurrence.definition.kind,
        thread: store.getThread(threadId),
        followUp: store.listThreadFollowUps(threadId).find((row) => row.id === occurrence.followUpId),
        hasAcceptedMessage: true,
        hasActiveRun: active,
        hasPendingUserAction: approval,
        isDraining: false,
      }),
  };
  const service = new SchedulingService(schedules, deps, () => now);
  cleanups.push(() => service.stop());
  service.create({
    kind: "session_message",
    requestId: "scheduled",
    name: "timed send",
    threadId,
    prompt: "scheduled message",
    trigger: { type: "at", at: new Date(now + 60_000).toISOString() },
  });
  const target = () =>
    selectThreadFollowUpDrainTarget({
      followUps: store.listThreadFollowUps(threadId, { statuses: ["queued"] }),
      forceEscalatedDrain: false,
      hasFollowUpQueuePaused: Boolean(store.getThread(threadId)?.followUpQueuePaused),
      isAsyncClarificationAnswer: () => false,
      isScheduledMessage: (row) => isScheduledMessageFollowUp(row, store),
    });
  const blocked = () => {
    const selected = target();
    return shouldBlockThreadFollowUpDrain({
      hasPendingBridgeApproval: approval,
      hasPendingClarification: false,
      hasStoredPendingPlan: false,
      hasFollowUpQueuePaused: true,
      threadStatus: store.getThread(threadId)!.status,
      ...(selected.isScheduledMessage ? { isScheduledMessage: true } : {}),
    });
  };
  return {
    directory,
    dbPath,
    store,
    images,
    v2,
    schedules,
    service,
    threadId,
    ordinary,
    target,
    blocked,
    count: () => dispatched,
    due: () => {
      now += 60_000;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setApproval: (value: boolean) => {
      approval = value;
    },
  };
}

test("a due scheduled message passes the pause and claims only its own row exactly once", async () => {
  const f = await fixture();
  f.due();
  await f.service.tick();
  expect(f.count()).toBe(1);
  const occurrence = f.schedules.occurrences()[0]!;
  const selected = f.target();
  expect(selected).toMatchObject({ followUpId: occurrence.followUpId, isScheduledMessage: true });
  expect(f.blocked()).toBe(false);
  await f.service.tick();
  expect(f.schedules.occurrences()[0]?.status).toBe("running");
  const claimed = f.store.claimQueuedThreadFollowUps(f.threadId, { followUpId: selected.followUpId });
  expect(claimed.map((row) => row.prompt)).toEqual(["scheduled message"]);
  f.store.updateThreadFollowUpStatus(f.threadId, claimed[0]!.id, { status: "applied" });
  await f.service.tick();
  expect(f.schedules.occurrences()[0]?.status).toBe("completed");
  expect(f.count()).toBe(1);
  expect(f.store.getThread(f.threadId)?.followUpQueuePaused).toBe(true);
  expect(f.store.listThreadFollowUps(f.threadId, { statuses: ["queued"] }).map((row) => row.id)).toEqual(
    f.ordinary.map((row) => row.id),
  );
  expect(f.blocked()).toBe(true);
});

test("an image-only scheduled message keeps its image while ordinary messages remain paused", async () => {
  const f = await fixture();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGkAAAAASUVORK5CYII=";
  const image = await f.images.stageComposerImage({
    contextKey: `thread:${f.threadId}`,
    imageId: "scheduled",
    mediaType: "image/png",
    dataBase64: png,
  });
  const definition = f.schedules.list()[0]!;
  f.service.update({
    id: definition.id,
    expectedRevision: definition.revision,
    prompt: "",
    attachments: [{ mediaType: "image/png", contentRef: image.contentRef, byteLength: image.byteLength }],
  });
  f.due();
  await f.service.tick();
  const claimed = f.store.claimQueuedThreadFollowUps(f.threadId, { followUpId: f.target().followUpId });
  expect(claimed).toHaveLength(1);
  expect(claimed[0]?.prompt).toBe("");
  expect(await f.images.readAttachmentData(claimed[0]!.attachments![0]!)).toBe(png);
  expect(f.store.getThread(f.threadId)?.followUpQueuePaused).toBe(true);
  expect(f.store.getThreadFollowUp(f.threadId, f.ordinary[0]!.id)?.status).toBe("queued");
});

test("active work and approvals still wait; an ordinary pause alone does not", async () => {
  const f = await fixture();
  f.setActive(true);
  f.due();
  await f.service.tick();
  expect(f.schedules.occurrences()[0]?.status).toBe("pending");
  expect(f.count()).toBe(0);
  f.setActive(false);
  f.setApproval(true);
  await f.service.tick();
  expect(f.count()).toBe(0);
  f.setApproval(false);
  await f.service.tick();
  expect(f.count()).toBe(1);
  expect(f.store.getThread(f.threadId)?.followUpQueuePaused).toBe(true);
});

test("ordinary pause does not disable recurring scheduled messages after delivery", async () => {
  const f = await fixture();
  const definition = f.schedules.list()[0]!;
  f.service.update({
    id: definition.id,
    expectedRevision: definition.revision,
    trigger: { type: "interval", everySeconds: 60, anchorAt: "2026-10-26T00:01:00.000Z" },
  });
  f.due();
  await f.service.tick();
  await f.service.tick();
  expect(f.schedules.get(definition.id)?.enabled).toBe(true);
  const first = f.store.claimQueuedThreadFollowUps(f.threadId, { followUpId: f.target().followUpId })[0]!;
  f.store.updateThreadFollowUpStatus(f.threadId, first.id, { status: "applied" });
  await f.service.tick();
  f.due();
  await f.service.tick();
  expect(f.count()).toBe(2);
  expect(f.schedules.get(definition.id)?.enabled).toBe(true);
  expect(f.target().isScheduledMessage).toBe(true);
  expect(f.store.getThread(f.threadId)?.followUpQueuePaused).toBe(true);
  expect(f.store.getThreadFollowUp(f.threadId, f.ordinary[0]!.id)?.status).toBe("queued");
});

test("error pauses still block dispatch and a claimed schedule cannot bypass later errors", async () => {
  const f = await fixture();
  f.store.updateThread(f.threadId, { status: "blocked", message: "Authentication required" });
  f.due();
  await f.service.tick();
  expect(f.count()).toBe(0);
  f.store.updateThread(f.threadId, { status: "completed", message: "" });
  await f.service.tick();
  expect(f.count()).toBe(1);
  f.store.updateThread(f.threadId, { status: "failed", message: "Connection failed" });
  expect(f.blocked()).toBe(true);
  await f.service.tick();
  expect(f.schedules.occurrences()[0]).toMatchObject({ status: "waiting_user", error: "Connection failed" });
});

test("scheduled provenance survives restart; copying scheduled text or ids does not bypass pause", async () => {
  const f = await fixture();
  const forged = f.v2.sendMessage({
    principalId: "eco-scheduler",
    conversationId: f.threadId,
    clientCommandId: "occ_fake",
    messageId: "message_occ_fake",
    text: "scheduled message",
  });
  const fake = f.store.enqueueThreadFollowUp({
    threadId: f.threadId,
    prompt: "scheduled message",
    conversationMessageId: forged.messageId,
  });
  expect(isScheduledMessageFollowUp(fake, f.store)).toBe(false);
  f.due();
  await f.service.tick();
  const reopened = await createConversationStore(f.dbPath);
  cleanups.push(() => (reopened as unknown as { db: DatabaseSync }).db.close());
  const queued = reopened.listThreadFollowUps(f.threadId, { statuses: ["queued"] });
  const selected = selectThreadFollowUpDrainTarget({
    followUps: queued,
    forceEscalatedDrain: false,
    hasFollowUpQueuePaused: true,
    isAsyncClarificationAnswer: () => false,
    isScheduledMessage: (row) => isScheduledMessageFollowUp(row, reopened),
  });
  expect(selected.followUpId).toBe(f.schedules.occurrences()[0]?.followUpId);
  expect(selected.followUpId).not.toBe(fake.id);
  expect(reopened.getThread(f.threadId)?.followUpQueuePaused).toBe(true);
  expect(reopened.claimQueuedThreadFollowUps(f.threadId, { followUpId: selected.followUpId })).toHaveLength(
    1,
  );
  expect(reopened.getThreadFollowUp(f.threadId, f.ordinary[0]!.id)?.status).toBe("queued");
});

test("scheduled pause bypass still obeys bash, question, plan and editing gates", () => {
  const base = {
    isScheduledMessage: true,
    hasFollowUpQueuePaused: true,
    threadStatus: "idle" as const,
    hasPendingBridgeApproval: false,
    hasPendingClarification: false,
    hasStoredPendingPlan: false,
  };
  expect(shouldBlockThreadFollowUpDrain(base)).toBe(false);
  for (const gate of [
    "hasPendingBashApproval",
    "hasPendingBridgeApproval",
    "hasPendingClarification",
    "hasEditingFollowUp",
  ] as const) {
    expect(shouldBlockThreadFollowUpDrain({ ...base, [gate]: true })).toBe(true);
  }
  expect(
    shouldBlockThreadFollowUpDrain({ ...base, threadStatus: "awaiting_plan", hasStoredPendingPlan: true }),
  ).toBe(true);
  const rows = [
    { id: "schedule", status: "queued" },
    { id: "answer", status: "queued" },
  ] as ThreadPendingFollowUp[];
  expect(
    selectThreadFollowUpDrainTarget({
      followUps: rows,
      forceEscalatedDrain: false,
      hasFollowUpQueuePaused: true,
      isScheduledMessage: (row) => row.id === "schedule",
      isAsyncClarificationAnswer: (row) => row.id === "answer",
    }).followUpId,
  ).toBe("answer");
});

test("scheduled dispatch waits for safe runtime, compaction and editing boundaries", () => {
  const base = {
    thread: { status: "idle" as const, followUpQueuePaused: true },
    hasActiveRun: false,
    hasPendingUserAction: false,
    isCompacting: false,
    hasEditingFollowUp: false,
  };
  expect(canDispatchScheduledMessage(base)).toBe(true);
  for (const gate of [
    "hasActiveRun",
    "hasPendingUserAction",
    "isCompacting",
    "hasEditingFollowUp",
  ] as const) {
    expect(canDispatchScheduledMessage({ ...base, [gate]: true })).toBe(false);
  }
  for (const status of ["running", "queued", "awaiting_plan", "failed", "blocked"] as const) {
    expect(canDispatchScheduledMessage({ ...base, thread: { status, followUpQueuePaused: true } })).toBe(
      false,
    );
  }
});
