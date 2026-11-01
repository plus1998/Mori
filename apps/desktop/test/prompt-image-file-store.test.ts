import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectPromptImageContentRefs,
  isPromptImageAttachmentRecord,
  PromptImageFileStore,
} from "../src/main/prompt-image-file-store";
import { buildPromptWithImageReferences } from "../src/shared/prompt-image-reference";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

async function createStore(): Promise<PromptImageFileStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-prompt-image-store-"));
  tempDirs.push(directory);
  return new PromptImageFileStore(directory);
}

test("stages composer images under the context spool and deletes them on release", async () => {
  const store = await createStore();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  const staged = await store.stageComposerImage({
    contextKey: "thread:thr_1",
    imageId: "img_1",
    mediaType: "image/png",
    dataBase64: png,
  });

  expect(store.isManagedPath(staged.path)).toBe(true);
  await expect(fs.stat(staged.path)).resolves.toBeDefined();

  await store.releasePaths([staged.path]);
  await expect(fs.stat(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("deleteSpoolContext removes the entire composer spool directory", async () => {
  const store = await createStore();
  const staged = await store.stageComposerImage({
    contextKey: "landing:/tmp/project",
    imageId: "img_2",
    mediaType: "image/jpeg",
    dataBase64: Buffer.from("jpeg").toString("base64"),
  });
  expect(staged.path).toContain(`${path.sep}spool${path.sep}`);

  await store.deleteSpoolContext("landing:/tmp/project");
  await expect(fs.stat(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("persistMessageAttachments moves spool files into message storage", async () => {
  const store = await createStore();
  const staged = await store.stageComposerImage({
    contextKey: "thread:thr_move",
    imageId: "img_move",
    mediaType: "image/png",
    dataBase64: Buffer.from("png").toString("base64"),
  });

  const persisted = await store.persistMessageAttachments("thr_move", "user:abc", [
    { mediaType: "image/png", path: staged.path },
  ]);
  const persistedPath = persisted[0]!.path!;

  expect(persisted).toHaveLength(1);
  expect(persisted[0]).toMatchObject({
    mediaType: "image/png",
    path: expect.stringContaining(`${path.sep}messages${path.sep}thr_move${path.sep}user_abc${path.sep}`),
    byteLength: 3,
    contentRef: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
  });
  await expect(fs.stat(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(persistedPath)).resolves.toBeDefined();
});

test("resolveAttachmentsForRuntime reads managed files back as base64", async () => {
  const store = await createStore();
  const payload = Buffer.from("runtime").toString("base64");
  const persisted = await store.persistMessageAttachments("thr_runtime", "codex-pending:1", [
    { mediaType: "image/webp", data: payload },
  ]);

  const resolved = await store.resolveAttachmentsForRuntime(persisted);
  expect(resolved).toEqual([
    {
      mediaType: "image/webp",
      data: payload,
      path: expect.stringContaining(`${path.sep}objects${path.sep}`),
      contentRef: persisted[0]?.contentRef,
      byteLength: 7,
    },
  ]);
});

test("retry restores a readable original-image path from a durable reference after message cleanup", async () => {
  const store = await createStore();
  const original = Buffer.from("original-image-for-codex");
  const [persisted] = await store.persistMessageAttachments("thr_retry", "codex-pending:1", [
    { mediaType: "image/png", data: original.toString("base64") },
  ]);
  const initial = await store.resolveAttachmentsForRuntime([persisted!]);
  // V2 retains a durable original reference and a bounded preview, never a local path.
  const durable = {
    mediaType: persisted!.mediaType,
    contentRef: persisted!.contentRef!,
    byteLength: persisted!.byteLength!,
    data: Buffer.from("thumbnail-only").toString("base64"),
  };
  await store.deleteThreadMessages("thr_retry");
  const restarted = new PromptImageFileStore(path.dirname(store.getRootDir()));
  for (let retry = 0; retry < 2; retry += 1) {
    const restored = await restarted.resolveAttachmentsForRuntime([durable]);
    const image = restored[0]!;
    expect(image.path).toBeDefined();
    expect(image.path).toBe(initial[0]!.path);
    expect(store.isManagedPath(image.path!)).toBe(true);
    await expect(fs.readFile(image.path!)).resolves.toEqual(original);
    expect(image.data).toBe(original.toString("base64"));
    const prompt = buildPromptWithImageReferences({ prompt: "检查图片", attachments: restored });
    expect(prompt).toContain(`path=${JSON.stringify(image.path)}`);
    expect(prompt).not.toContain('ref="sha256:');
    expect(prompt).not.toContain(durable.data);
  }
});

test("persisting a resolved runtime attachment preserves its shared content object", async () => {
  const store = await createStore();
  const [persisted] = await store.persistMessageAttachments("thr_first", "user:1", [
    { mediaType: "image/png", data: Buffer.from("shared-original").toString("base64") },
  ]);
  const runtime = await store.resolveAttachmentsForRuntime([persisted!]);
  const originalPath = runtime[0]!.path!;
  const originalStat = await fs.stat(originalPath);
  const [copied] = await store.persistMessageAttachments("thr_second", "user:1", runtime);
  const retainedStat = await fs.stat(originalPath);
  expect(retainedStat.ino).toBe(originalStat.ino);
  expect(copied!.contentRef).toBe(persisted!.contentRef);
  await expect(fs.readFile(copied!.path!)).resolves.toEqual(Buffer.from("shared-original"));
});

test("chunked composer upload supports resume after partial write", async () => {
  const store = await createStore();
  const bytes = Buffer.from("abcdefghijklmnopqrstuvwxyz");
  const begin = await store.beginComposerImageUpload({
    contextKey: "thread:thr_chunk",
    imageId: "img_chunk",
    mediaType: "image/png",
    totalBytes: bytes.length,
  });
  expect(begin).toMatchObject({ receivedBytes: 0, complete: false });

  const first = await store.writeComposerImageChunk({
    contextKey: "thread:thr_chunk",
    imageId: "img_chunk",
    mediaType: "image/png",
    offset: 0,
    dataBase64: bytes.subarray(0, 10).toString("base64"),
  });
  expect(first.receivedBytes).toBe(10);

  const resume = await store.beginComposerImageUpload({
    contextKey: "thread:thr_chunk",
    imageId: "img_chunk",
    mediaType: "image/png",
    totalBytes: bytes.length,
  });
  expect(resume.receivedBytes).toBe(10);

  await store.writeComposerImageChunk({
    contextKey: "thread:thr_chunk",
    imageId: "img_chunk",
    mediaType: "image/png",
    offset: 10,
    dataBase64: bytes.subarray(10).toString("base64"),
  });
  const finished = await store.finishComposerImageUpload({
    contextKey: "thread:thr_chunk",
    imageId: "img_chunk",
    mediaType: "image/png",
    totalBytes: bytes.length,
  });
  expect(store.isManagedPath(finished.path)).toBe(true);
  await expect(fs.readFile(finished.path)).resolves.toEqual(bytes);
});

test("deleteThreadMessages removes all message-owned prompt images", async () => {
  const store = await createStore();
  const persisted = await store.persistMessageAttachments("thr_delete", "user:1", [
    { mediaType: "image/png", data: Buffer.from("delete").toString("base64") },
  ]);
  await store.deleteThreadMessages("thr_delete");
  await expect(fs.stat(persisted[0]!.path!)).rejects.toMatchObject({ code: "ENOENT" });
});

test("persistMessageAttachments falls back to inline data when spool path is gone", async () => {
  const store = await createStore();
  const payload = Buffer.from("fallback-png").toString("base64");
  const staged = await store.stageComposerImage({
    contextKey: "landing:/tmp/project",
    imageId: "img_gone",
    mediaType: "image/png",
    dataBase64: payload,
  });
  await store.releasePaths([staged.path]);

  const persisted = await store.persistMessageAttachments("thr_fallback", "user:1", [
    { mediaType: "image/png", path: staged.path, data: payload },
  ]);
  const persistedAttachment = { ...persisted[0]! };
  const persistedPath = persistedAttachment.path!;
  const persistedContentRef = persistedAttachment.contentRef!;

  expect(persisted).toHaveLength(1);
  expect(persistedAttachment.mediaType).toBe("image/png");
  expect(persistedPath).toContain(`${path.sep}messages${path.sep}thr_fallback${path.sep}`);
  expect(persistedContentRef).toMatch(/^sha256:[0-9a-f]{64}$/);
  await expect(fs.stat(persistedPath)).resolves.toBeDefined();
  const resolved = await store.resolveAttachmentsForRuntime([persistedAttachment]);
  expect(resolved[0]?.data).toBe(payload);
});

test("isManagedPath accepts paths under the store root regardless of separator style", async () => {
  const store = await createStore();
  const root = store.getRootDir();
  const forwardSlashPath = `${root.replaceAll("\\", "/")}/spool/thread_thr/img_1.png`;
  expect(store.isManagedPath(forwardSlashPath)).toBe(true);
});

test("migration and runtime reads reject traversal and symlink escapes", async () => {
  const store = await createStore();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "eco-prompt-image-outside-"));
  tempDirs.push(outside);
  const outsidePath = path.join(outside, "outside.png");
  const linkPath = path.join(store.getRootDir(), "link.png");
  await fs.writeFile(outsidePath, Buffer.from("outside"));
  await fs.mkdir(store.getRootDir(), { recursive: true });
  await fs.symlink(outsidePath, linkPath);

  const attachment = { mediaType: "image/png" as const, path: "link.png" };
  expect(() => store.validateAttachmentForMigration(attachment)).toThrow(/outside|unreadable/);
  expect(() =>
    store.validateAttachmentForMigration({ mediaType: "image/png", path: "../outside.png" }),
  ).toThrow(/outside|unreadable/);
  await expect(store.readAttachmentData(attachment)).rejects.toThrow(/missing readable data/);
  expect(store.resolveManagedPath("../outside.png")).toBeUndefined();
});

test("migration rejects malformed inline base64 instead of silently decoding it", async () => {
  const store = await createStore();
  expect(() => store.validateAttachmentForMigration({ mediaType: "image/png", data: "not-base64!" })).toThrow(
    "valid base64",
  );
});

test("isPromptImageAttachmentRecord accepts path-only attachments", () => {
  expect(
    isPromptImageAttachmentRecord({
      mediaType: "image/png",
      path: "/tmp/prompt-images/messages/thr/user/img.png",
    }),
  ).toBe(true);
  expect(isPromptImageAttachmentRecord({ mediaType: "image/png" })).toBe(false);
  expect(
    isPromptImageAttachmentRecord({
      mediaType: "image/png",
      contentRef: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
  ).toBe(true);
});

test("content-addressed objects survive message-path cleanup and can be read in chunks", async () => {
  const store = await createStore();
  const bytes = Buffer.from("content-addressed image bytes");
  const persisted = await store.persistMessageAttachments("thr_ref", "user:1", [
    { mediaType: "image/png", data: bytes.toString("base64") },
  ]);
  const attachment = persisted[0]!;
  const contentRef = attachment.contentRef!;
  await store.deleteThreadMessages("thr_ref");

  await expect(store.hasReadableContentRef(attachment)).resolves.toBe(true);
  const first = await store.readAttachmentChunk({
    contentRef,
    mediaType: "image/png",
    offset: 0,
    maxBytes: 8,
  });
  const second = await store.readAttachmentChunk({
    contentRef,
    mediaType: "image/png",
    offset: first.nextOffset,
    maxBytes: 8,
  });
  const chunks = [Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")];
  let offset = second.nextOffset;
  while (offset < second.totalBytes) {
    const next = await store.readAttachmentChunk({
      contentRef,
      mediaType: "image/png",
      offset,
      maxBytes: 8,
    });
    chunks.push(Buffer.from(next.data, "base64"));
    offset = next.nextOffset;
  }
  expect(Buffer.concat(chunks)).toEqual(bytes);
});

test("content-addressed reads fail closed when the stored object is tampered", async () => {
  const store = await createStore();
  const persisted = await store.persistMessageAttachments("thr_tamper", "user:1", [
    { mediaType: "image/png", data: Buffer.from("tamper").toString("base64") },
  ]);
  const objectPath = path.join(
    store.getRootDir(),
    "objects",
    `${persisted[0]!.contentRef!.slice("sha256:".length)}.png`,
  );
  await fs.writeFile(objectPath, "changed");
  await expect(store.hasReadableContentRef(persisted[0]!)).resolves.toBe(false);
  await expect(
    store.readAttachmentChunk({
      contentRef: persisted[0]!.contentRef!,
      mediaType: "image/png",
      offset: 0,
    }),
  ).rejects.toThrow("hash mismatch");
});

test("content-addressed GC removes only old unreferenced objects", async () => {
  const store = await createStore();
  const retained = await store.persistMessageAttachments("thr_gc", "user:retained", [
    { mediaType: "image/png", data: Buffer.from("retained").toString("base64") },
  ]);
  const orphan = await store.persistMessageAttachments("thr_gc", "user:orphan", [
    { mediaType: "image/png", data: Buffer.from("orphan").toString("base64") },
  ]);
  const orphanRef = orphan[0]!.contentRef!;
  const orphanPath = path.join(store.getRootDir(), "objects", `${orphanRef.slice("sha256:".length)}.png`);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(orphanPath, old, old);

  const preview = await store.sweepUnreferencedContentObjects({
    resolveReferencedContentRefs: () => [retained[0]!.contentRef!],
    minAgeMs: 0,
    dryRun: true,
  });
  expect(preview).toMatchObject({ scanned: 2, retainedReferenced: 1, removed: 1, dryRun: true });
  await expect(fs.stat(orphanPath)).resolves.toBeDefined();

  const result = await store.sweepUnreferencedContentObjects({
    resolveReferencedContentRefs: () => [retained[0]!.contentRef!],
    minAgeMs: 0,
  });
  expect(result).toMatchObject({ scanned: 2, retainedReferenced: 1, removed: 1, dryRun: false });
  await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(store.hasReadableContentRef(retained[0]!)).resolves.toBe(true);
});

test("content-addressed GC skips the durable reference walk when nothing is collectable", async () => {
  const store = await createStore();
  const retained = await store.persistMessageAttachments("thr_gc_fresh", "user:fresh", [
    { mediaType: "image/png", data: Buffer.from("fresh").toString("base64") },
  ]);
  let resolved = 0;
  const result = await store.sweepUnreferencedContentObjects({
    resolveReferencedContentRefs: () => {
      resolved += 1;
      throw new Error("reference walk must not run");
    },
  });
  expect(resolved).toBe(0);
  expect(result).toMatchObject({ scanned: 1, retainedReferenced: 0, retainedRecent: 1, removed: 0 });
  await expect(store.hasReadableContentRef(retained[0]!)).resolves.toBe(true);
});

test("content reference collection walks V2-compatible JSON without trusting paths", () => {
  const refs = collectPromptImageContentRefs({
    attachments: [
      { contentRef: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { path: "/private/path/that/must/not/become/an/object/ref" },
    ],
    nested: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  expect([...refs].sort()).toEqual([
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ]);
});
