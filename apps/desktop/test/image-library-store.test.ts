import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexImageBatchError } from "../src/main/codex-image-service";
import { generateImagesToWorkspace } from "../src/main/image-generation-client";
import { ImageGenerationMcpGateway } from "../src/main/image-generation-mcp-gateway";
import { ImageGenerationStore } from "../src/main/image-generation-store";
import { ImageLibraryStore } from "../src/main/image-library-store";
import { type ImageGenerationArtifact, ImageGenerationError } from "../src/shared/image-generation";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const artifact: ImageGenerationArtifact = {
  id: "artifact-1",
  threadId: "thread-1",
  prompt: "blue leaf",
  parameters: { count: 2 },
  provider: "codex",
  profileName: "test",
  model: "gpt-image-2",
  workspacePath: "/project",
  generationRoot: "/worktree",
  images: [],
  status: "running",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const openDatabases: Database[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of openDatabases.splice(0)) db.close();
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-library-test-"));
  directories.push(root);
  const db = new Database(path.join(root, "test.sqlite"));
  openDatabases.push(db);
  const libraryRoot = path.join(root, "library");
  const workRoot = path.join(root, "temporary");
  const store = new ImageLibraryStore(db as never, libraryRoot, () => ({ width: 1, height: 1 }), workRoot);
  store.initialize();
  const save = (index = 0, meta = artifact) =>
    store.saveGeneratedImage(meta, { bytes: png, mimeType: "image/png" }, index, `leaf-${index}.png`);
  return { root, db, store, save, libraryRoot, workRoot };
}

test("originals survive moving/modifying work copies, deleting source records and reopening", async () => {
  const { root, db, store, save, libraryRoot, workRoot } = await fixture();
  const image = await save();
  const id = image.libraryImageId!;
  expect(image.absolutePath.startsWith(workRoot)).toBe(true);
  expect(store.resolveOriginal(id).startsWith(libraryRoot)).toBe(true);
  await fs.writeFile(image.absolutePath, "modified");
  expect(await fs.readFile(store.resolveOriginal(id))).toEqual(png);
  await fs.rename(image.absolutePath, path.join(root, "moved.png"));
  db.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY); INSERT INTO threads VALUES ('thread-1'); DELETE FROM threads;",
  );
  await fs.rm(workRoot, { recursive: true });
  const reopened = new ImageLibraryStore(db as never, libraryRoot, () => ({ width: 1, height: 1 }), workRoot);
  reopened.initialize();
  expect((await reopened.read(id, false, () => png)).dataBase64).toBe(png.toString("base64"));
  expect(reopened.list().total).toBe(1);
});

test("saving the same artifact/index reuses its original even if the work copy changed", async () => {
  const { store, save } = await fixture();
  const first = await save();
  await fs.writeFile(first.absolutePath, "edited");
  const second = await save();
  expect(first.libraryImageId).toBe(second.libraryImageId);
  expect(store.list().total).toBe(1);
  expect(await fs.readFile(second.absolutePath)).toEqual(png);
});

test("trash does not free originals, restores previews and purge retains deletion tombstones", async () => {
  const { store, save } = await fixture();
  const image = await save();
  const id = image.libraryImageId!;
  await store.read(id, true, () => png);
  const trashed = await store.changeState([id, id], "trash");
  expect(trashed.succeededIds).toEqual([id]);
  expect(trashed.freedBytes).toBe(0);
  expect(store.list().total).toBe(0);
  expect(store.list({ trash: true }).total).toBe(1);
  expect(() => store.resolveOriginal(id)).toThrow("回收站");
  expect((await store.read(id, true, () => png)).dataBase64).toBe(png.toString("base64"));
  await store.changeState([id], "restore");
  expect(await fs.readFile(store.resolveOriginal(id))).toEqual(png);
  expect((await store.changeState([id], "purge")).errors).toHaveLength(1);
  await store.changeState([id], "trash");
  const purged = await store.changeState([id], "purge");
  expect(purged.freedBytes).toBe(png.length * 2);
  expect(store.list({ trash: true }).total).toBe(0);
  expect(store.get(id).purgedAt).toBeTruthy();
  expect(() => store.resolveOriginal(id)).toThrow("图片已删除");
  expect((await store.changeState([id], "restore")).errors).toHaveLength(1);
  expect(await fs.readFile(image.absolutePath)).toEqual(png);
});

test("missing originals are reported even with cached thumbnails or intact work copies", async () => {
  const { store, save } = await fixture();
  const image = await save();
  const id = image.libraryImageId!;
  await store.read(id, true, () => png);
  await fs.unlink(store.resolveOriginal(id));
  expect(store.list().items[0]?.missing).toBe(true);
  await expect(store.read(id, true, () => png)).rejects.toThrow("原图缺失");
  expect(await fs.readFile(image.absolutePath)).toEqual(png);
  await store.changeState([id], "trash");
  expect((await store.changeState([id], "purge")).errors).toHaveLength(0);
});

test("search, source, local date filters and pagination apply to both images and total bytes", async () => {
  const { store, save, db } = await fixture();
  await save(0);
  await save(1);
  await save(0, {
    ...artifact,
    id: "other",
    workspacePath: "/other",
    threadId: "other-thread",
    prompt: "red 100%",
  });
  db.exec(
    "UPDATE image_library SET created_at = '2026-11-01T12:00:00.000Z' WHERE artifact_id = 'artifact-1'",
  );
  expect(store.list({ search: "BLUE", limit: 1 }).items).toHaveLength(1);
  expect(store.list({ search: "BLUE", offset: 1, limit: 1 }).items).toHaveLength(1);
  expect(
    store.list({
      workspacePath: "/project",
      threadId: "thread-1",
      fromDate: "2026-11-01",
      toDate: "2026-11-01",
    }).total,
  ).toBe(2);
  expect(store.list({ workspacePath: "/project" }).bytes).toBe(png.length * 2);
  expect(store.list({ search: "%" }).total).toBe(1);
  expect(store.list().projects).toEqual(["/other", "/project"]);
  expect(() => store.list({ fromDate: "yesterday" })).toThrow("日期");
});

test("legacy generation records are never imported or rewritten", async () => {
  const { db, store } = await fixture();
  db.exec(
    "CREATE TABLE image_generation_artifacts(id TEXT, images_json TEXT); INSERT INTO image_generation_artifacts VALUES ('legacy', '[{\"absolutePath\":\"/old.png\"}]');",
  );
  store.initialize();
  expect(store.list().total).toBe(0);
  expect(db.query("SELECT images_json FROM image_generation_artifacts").get()).toEqual({
    images_json: '[{"absolutePath":"/old.png"}]',
  });
});

test("database insert failure removes newly written original and retry is possible", async () => {
  const { db, store, save, libraryRoot } = await fixture();
  db.exec(
    "CREATE TRIGGER reject_library BEFORE INSERT ON image_library BEGIN SELECT RAISE(FAIL, 'database unavailable'); END;",
  );
  await expect(save()).rejects.toThrow("database unavailable");
  expect(store.list().total).toBe(0);
  expect(await fs.readdir(path.join(libraryRoot, "originals"))).toEqual([]);
  db.exec("DROP TRIGGER reject_library");
  await save();
  expect(store.list().total).toBe(1);
});

test("original write failure never publishes a saved image", async () => {
  const { store, save, libraryRoot } = await fixture();
  await fs.writeFile(libraryRoot, "blocks directory");
  await expect(save()).rejects.toThrow();
  expect(store.list().total).toBe(0);
});

test("working-copy failures preserve archived images in partial results", async () => {
  const { store, save, workRoot } = await fixture();
  await fs.writeFile(workRoot, "blocks directory");
  let failure: ImageGenerationError | undefined;
  try {
    await save();
  } catch (error) {
    failure = error as ImageGenerationError;
  }
  expect(failure?.code).toBe("work_copy_failed");
  expect(failure?.partialImages).toHaveLength(1);
  expect(store.list().total).toBe(1);
  expect((await store.read(failure!.partialImages[0]!.libraryImageId!, false, () => png)).dataBase64).toBe(
    png.toString("base64"),
  );
});

test("export copies originals, protects existing targets and never modifies the library via symlinks", async () => {
  const { root, store, save, libraryRoot } = await fixture();
  const image = await save();
  const id = image.libraryImageId!;
  const target = path.join(root, "export.png");
  await store.exportImage(id, target);
  await fs.writeFile(target, "edited export");
  await expect(store.exportImage(id, target)).rejects.toThrow();
  expect(await fs.readFile(store.resolveOriginal(id))).toEqual(png);
  await store.exportImage(id, target, true);
  expect(await fs.readFile(target)).toEqual(png);
  await expect(store.exportImage(id, path.join(libraryRoot, "bad.png"))).rejects.toThrow("图片库内部");
  const link = path.join(root, "original-link.png");
  await fs.symlink(store.resolveOriginal(id), link);
  await expect(store.exportImage(id, link, true)).rejects.toThrow("图片库内部");
  await expect(store.exportImage(id, path.join(root, "nonexistent", "target.png"))).rejects.toThrow();
});

test("partial provider batches and later persistence failures retain every saved image", async () => {
  const { root, store } = await fixture();
  const base = {
    config: {
      profileId: "test",
      profileName: "test",
      provider: "codex" as const,
      model: "gpt-image-2",
      endpoint: "",
      apiKey: "",
      supportsImageToImage: true,
    },
    toolInput: { prompt: "leaf", count: 2 },
    workspacePath: root,
    generationRoot: root,
    threadDirectory: "thread",
  };
  const persistImage = (payload: { bytes: Buffer; mimeType: string }, index: number, name: string) =>
    store.saveGeneratedImage(artifact, payload, index, name);
  try {
    await generateImagesToWorkspace({
      ...base,
      persistImage,
      generateCodex: async () => {
        throw new CodexImageBatchError(new ImageGenerationError("limited", "quota limited"), [
          { bytes: png, mimeType: "image/png" },
        ]);
      },
    });
    throw new Error("expected failure");
  } catch (error) {
    const failure = error as ImageGenerationError;
    expect(failure.code).toBe("limited");
    expect(failure.partialImages).toHaveLength(1);
    expect(failure.partialImages[0]?.libraryImageId).toBeTruthy();
  }
  expect(store.list().total).toBe(1);
  expect(await fs.readdir(root)).not.toContain(".eco");
  try {
    await generateImagesToWorkspace({
      ...base,
      persistImage: async (payload, index, name) => {
        if (index === 1) throw new Error("disk full");
        return persistImage(payload, index, name);
      },
      generateCodex: async () => [
        { bytes: png, mimeType: "image/png" },
        { bytes: png, mimeType: "image/png" },
      ],
    });
    throw new Error("expected failure");
  } catch (error) {
    expect((error as ImageGenerationError).partialImages).toHaveLength(1);
    expect((error as ImageGenerationError).message).toContain("disk full");
  }
  expect(store.list().total).toBe(1);
});

test("gateway persists each image and records archived partial results when the provider fails", async () => {
  const { db, store: library, root } = await fixture();
  const generation = new ImageGenerationStore(db as never);
  generation.initialize();
  const profile = generation.saveProfile({
    name: "Codex",
    provider: "codex",
    endpoint: "",
    model: "gpt-image-2",
  });
  generation.activateProfile(profile.id);
  generation.setEnabled(true);
  const gateway = new ImageGenerationMcpGateway({
    store: generation,
    library,
    resolveWorkspacePath: () => root,
    resolveGenerationRoot: () => root,
    onArtifactChanged: () => undefined,
    generateCodex: async () => {
      throw new CodexImageBatchError(new ImageGenerationError("limited", "quota"), [
        { bytes: png, mimeType: "image/png" },
      ]);
    },
  });
  const result = await gateway.generate(
    { threadId: "thread-1", workspacePath: root, generationRoot: root },
    { prompt: "leaf", count: 2 },
  );
  expect(result.artifact.status).toBe("failed");
  expect(result.artifact.images[0]?.libraryImageId).toBe(library.list().items[0]?.id);
  expect(generation.listArtifacts("thread-1")[0]?.images).toEqual(result.artifact.images);
});

test("failed purge reports the file error and can be retried without losing the original", async () => {
  const { store, save, libraryRoot } = await fixture();
  const image = await save();
  const id = image.libraryImageId!;
  await store.changeState([id], "trash");
  const badThumbnail = path.join(libraryRoot, "thumbnails", `${id}.png`);
  await fs.mkdir(badThumbnail, { recursive: true });
  const failed = await store.changeState([id], "purge");
  expect(failed.errors).toHaveLength(1);
  expect(failed.succeededIds).toHaveLength(0);
  expect(store.get(id).purgedAt).toBeNull();
  expect(await fs.readFile(store.resolveOriginal(id, true))).toEqual(png);
  await fs.rmdir(badThumbnail);
  expect((await store.changeState([id], "purge")).succeededIds).toEqual([id]);
});

test("concurrent thumbnail creation and purge never resurrect a deleted thumbnail", async () => {
  const { store, save, libraryRoot } = await fixture();
  const image = await save();
  const id = image.libraryImageId!;
  await store.changeState([id], "trash");
  const [read, purged] = await Promise.all([
    store.read(id, true, () => png),
    store.changeState([id], "purge"),
  ]);
  expect(read.dataBase64).toBe(png.toString("base64"));
  expect(purged.succeededIds).toEqual([id]);
  expect(await fs.readdir(path.join(libraryRoot, "thumbnails"))).toEqual([]);
});

test("standalone project generations do not masquerade as deleted conversations", async () => {
  const { store, save } = await fixture();
  await save(0, { ...artifact, threadId: `generation-workspace:${artifact.workspacePath}` });
  expect(store.list().items[0]?.sourceKind).toBe("project");
  expect(store.list().threads).toEqual([]);
});
