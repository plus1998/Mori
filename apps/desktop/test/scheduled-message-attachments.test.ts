import { expect, test } from "bun:test";
import { stageScheduledMessageImages } from "../src/renderer/scheduled-message-attachments";
import type { ComposerImageAttachment } from "../src/renderer/composer-attachments";
import type { PromptImageAttachment } from "../src/shared/ipc";

const ref = `sha256:${"a".repeat(64)}`;
const local = (id: string): ComposerImageAttachment => ({ id, mediaType: "image/png", data: "original-bytes", previewUrl: "blob:preview" });

test("scheduled images stage once across retries and retain only immutable references", async () => {
  const calls: unknown[] = [];
  const stage = async (request: unknown) => { calls.push(request); return { path: "/tmp/spool.png", contentRef: ref, byteLength: 68 }; };
  const uploaded = new Map<string, PromptImageAttachment>();
  const input = [local("todo-image")];
  const attachments = await stageScheduledMessageImages(input, "landing:/project", stage, uploaded);
  expect(attachments).toEqual([{ mediaType: "image/png", contentRef: ref, byteLength: 68 }]);
  expect(await stageScheduledMessageImages(input, "landing:/project", stage, uploaded)).toEqual(attachments);
  expect(calls).toEqual([{ contextKey: "landing:/project", imageId: "schedule_todo-image", mediaType: "image/png", data: "original-bytes" }]);
});

test("partial upload failures reuse finished images and retry the missing one", async () => {
  const calls: string[] = [];
  let fail = true;
  const stage = async ({ imageId }: { imageId: string }) => {
    calls.push(imageId);
    if (imageId === "schedule_second" && fail) throw new Error("Disconnected");
    return { path: "/tmp/spool.png", contentRef: ref, byteLength: 68 };
  };
  const uploaded = new Map<string, PromptImageAttachment>();
  const input = [local("first"), local("second")];
  await expect(stageScheduledMessageImages(input, "thread:one", stage, uploaded)).rejects.toThrow("Disconnected");
  fail = false;
  expect(await stageScheduledMessageImages(input, "thread:one", stage, uploaded)).toHaveLength(2);
  expect(calls).toEqual(["schedule_first", "schedule_second", "schedule_second"]);
});

test("saved references do not depend on disposable spool paths or another upload", async () => {
  const result = await stageScheduledMessageImages([{ ...local("saved"), data: undefined, path: "/tmp/deleted.png", contentRef: ref, byteLength: 68 }], "thread:one",
    async () => { throw new Error("Must not upload"); }, new Map());
  expect(result).toEqual([{ mediaType: "image/png", contentRef: ref, byteLength: 68 }]);
});

test("missing originals are reported rather than dropping scheduled images", async () => {
  await expect(stageScheduledMessageImages([{ id: "missing", mediaType: "image/png", path: "/tmp/lost.png", previewUrl: "" }], "thread:one",
    async () => { throw new Error("Must not upload"); }, new Map())).rejects.toThrow("图片缺少原始内容");
});
