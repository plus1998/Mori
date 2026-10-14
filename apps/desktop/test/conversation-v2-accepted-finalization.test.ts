import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { finalizeAcceptedConversationV2Messages } from "../src/main/conversation-v2-accepted-finalization";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { PromptImageFileStore } from "../src/main/prompt-image-file-store";
import { buildConversationV2OnlyProjection } from "../src/renderer/ActivityLogView";
import {
  applyConversationV2Effect,
  installConversationV2Bootstrap,
} from "../src/renderer/conversation-v2-renderer-state";
import type { PromptImageAttachment } from "../src/shared/ipc";
import { readPromptImagePreviews } from "../src/shared/prompt-image-metadata";
import { removeTempDirectorySync } from "./helpers/temp-directory";

const fixtures: Array<{ db: DatabaseSync; directory: string }> = [];
function requireImageData(attachment: PromptImageAttachment): string {
  if (!attachment.data) throw new Error("Test image data is missing.");
  return attachment.data;
}
afterEach(() => {
  for (const { db, directory } of fixtures.splice(0)) {
    db.close();
    removeTempDirectorySync(directory);
  }
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "eco-accepted-images-"));
  const db = new DatabaseSync(":memory:");
  fixtures.push({ db, directory });
  const store = new ConversationV2Store(db);
  store.initialize();
  const files = new PromptImageFileStore(directory);
  let command = 0;
  const conversationId = "queued-images";
  const accept = async (text: string, data?: string) => {
    const attachments = data
      ? await files.persistMessageAttachments(conversationId, text, [{ mediaType: "image/png", data }])
      : [];
    return store.sendMessage({
      principalId: "desktop",
      conversationId,
      clientCommandId: `command_${++command}`,
      text,
      attachments,
    });
  };
  const input = {
    store,
    conversationId,
    resolveAttachments: (attachments: readonly PromptImageAttachment[]) =>
      files.resolveAttachmentsForRuntime(attachments),
    // The native Electron thumbnail encoder is exercised in the UI smoke test.
    // Keep this storage/Feed regression independent of Electron's native module.
    createPreviews: (attachments: readonly PromptImageAttachment[]) =>
      attachments.map((attachment, index) => ({
        ...attachment,
        id: `preview_${index}`,
        data: requireImageData(attachment),
      })),
  };
  return { db, store, files, conversationId, accept, input };
}

function visiblePreviews(state: ReturnType<typeof installConversationV2Bootstrap>) {
  return buildConversationV2OnlyProjection(state).timeline.flatMap((item) =>
    readPromptImagePreviews(item.metadata),
  );
}

test("queued images survive delivery effects, Feed projection, and read model rebuild", async () => {
  const { db, store, conversationId, accept, input } = createFixture();
  const imageData = Buffer.from("original queued image bytes").toString("base64");
  const accepted = await accept("look at this", imageData);
  let state = installConversationV2Bootstrap(store.bootstrap(conversationId, 100));
  expect(visiblePreviews(state)).toEqual([]);
  expect(store.getMessage(conversationId, accepted.messageId)?.attachments?.[0]).not.toHaveProperty("data");
  const effects: unknown[] = [];
  store.onCommitted((result) => {
    effects.push(result.effect.effect);
    state = applyConversationV2Effect(state, result.effect);
  });

  await finalizeAcceptedConversationV2Messages({ ...input, messageIds: [accepted.messageId] });
  const previews = visiblePreviews(state);
  expect(previews).toHaveLength(1);
  expect(previews[0]).toMatchObject({
    mediaType: "image/png",
    data: imageData,
    contentRef: expect.stringMatching(/^sha256:/),
  });
  expect(previews[0]).not.toHaveProperty("path");
  expect(effects).toEqual([
    expect.objectContaining({ type: "message.finalize", attachments: expect.any(Array) }),
  ]);
  expect(store.getMessage(conversationId, accepted.messageId)?.status).toBe("final");
  store.rebuildReadModels(conversationId);
  store.validateIntegrity(conversationId);
  const restarted = new ConversationV2Store(db);
  restarted.initialize();
  expect(visiblePreviews(installConversationV2Bootstrap(restarted.bootstrap(conversationId, 100)))).toEqual(
    previews,
  );
});

test("delivery keeps each message's latest edited images and respects image removal", async () => {
  const { store, files, conversationId, accept, input } = createFixture();
  const first = await accept("replace image", Buffer.from("old").toString("base64"));
  const second = await accept("remove image", Buffer.from("removed").toString("base64"));
  const third = await accept("keep image", Buffer.from("kept").toString("base64"));
  const replacement = await files.persistMessageAttachments(conversationId, "replacement", [
    { mediaType: "image/png", data: Buffer.from("new").toString("base64") },
  ]);
  for (const [messageId, attachments] of [
    [first.messageId, replacement],
    [second.messageId, []],
  ] as const) {
    store.appendRuntime({
      conversationId,
      eventId: `edit:${messageId}`,
      sourceEventKey: `edit:${messageId}`,
      type: "message.replaced",
      messageId,
      occurredAt: new Date().toISOString(),
      payload: {
        baseContentVersion: 0,
        nextContentVersion: 1,
        body: "edited",
        attachments: [...attachments],
      },
    });
  }
  await finalizeAcceptedConversationV2Messages({
    ...input,
    messageIds: [first.messageId, second.messageId, third.messageId, first.messageId],
  });
  const previews = visiblePreviews(installConversationV2Bootstrap(store.bootstrap(conversationId, 100)));
  expect(previews.map((preview) => Buffer.from(requireImageData(preview), "base64").toString())).toEqual([
    "new",
    "kept",
  ]);
  expect(store.getMessage(conversationId, second.messageId)?.attachments).toEqual([]);
  expect(previews.every((preview) => !("path" in preview))).toBe(true);
});

test("Pause/Stop while reading images leaves the accepted message queued", async () => {
  const { store, conversationId, accept, input } = createFixture();
  const accepted = await accept("cancel while preparing", Buffer.from("image").toString("base64"));
  const controller = new AbortController();
  let release!: () => void;
  let enter!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = finalizeAcceptedConversationV2Messages({
    ...input,
    messageIds: [accepted.messageId],
    signal: controller.signal,
    resolveAttachments: async (attachments) => {
      enter();
      await waiting;
      return input.resolveAttachments(attachments);
    },
  });
  await entered;
  controller.abort(new Error("paused by user"));
  release();
  await expect(pending).rejects.toThrow("paused by user");
  expect(store.getMessage(conversationId, accepted.messageId)?.status).toBe("queued");
  expect(visiblePreviews(installConversationV2Bootstrap(store.bootstrap(conversationId, 100)))).toEqual([]);
});

test("missing image objects and failed preview generation do not silently confirm delivery", async () => {
  const { store, conversationId, accept, input } = createFixture();
  const accepted = await accept("broken preview", Buffer.from("image").toString("base64"));
  await expect(
    finalizeAcceptedConversationV2Messages({
      ...input,
      messageIds: [accepted.messageId],
      resolveAttachments: async () => {
        throw new Error("image object missing");
      },
    }),
  ).rejects.toThrow("image object missing");
  await expect(
    finalizeAcceptedConversationV2Messages({
      ...input,
      messageIds: [accepted.messageId],
      createPreviews: () => [undefined],
    }),
  ).rejects.toThrow("无法生成排队消息的图片预览");
  expect(store.getMessage(conversationId, accepted.messageId)?.status).toBe("queued");
});

test("text-only delivery and repeated confirmations keep the original message identity", async () => {
  const { store, conversationId, accept, input } = createFixture();
  const accepted = await accept("text only");
  const messageIds = [accepted.messageId, accepted.messageId, "missing"];
  await finalizeAcceptedConversationV2Messages({ ...input, messageIds });
  const first = store.getMessage(conversationId, accepted.messageId);
  await finalizeAcceptedConversationV2Messages({ ...input, messageIds });
  expect(store.getMessage(conversationId, accepted.messageId)).toEqual(first);
  expect(first).toMatchObject({ status: "final", body: "text only" });
  expect(visiblePreviews(installConversationV2Bootstrap(store.bootstrap(conversationId, 100)))).toEqual([]);
});
