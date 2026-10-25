import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectTodoStore } from "../src/main/project-todo-store";
import { TODO_MAX_IMAGE_BYTES } from "../src/shared/project-todos";

const stores: ProjectTodoStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
function open(filename = ":memory:") {
  const store = new ProjectTodoStore(
    new DatabaseSync(filename),
    (bytes) => `data:image/png;base64,${bytes.toString("base64")}`,
  );
  stores.push(store);
  return store;
}
const note = { projectPath: "/project/a", text: "First idea", images: [], completed: false };
const image = {
  thumbnail: "data:image/png;base64,cHJldmlldw==",
  id: "image-1",
  mediaType: "image/png" as const,
  data: Buffer.from("original image bytes").toString("base64"),
};

test("project notes and original images survive reopening; list only returns thumbnails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-project-todos-"));
  directories.push(directory);
  const filename = path.join(directory, "notes.sqlite");
  const first = open(filename);
  const saved = first.save({ ...note, images: [image] });
  first.save({ ...note, projectPath: "/project/b", text: "Other project" });
  expect(saved.images[0]?.data).toBeUndefined();
  first.close();
  stores.splice(stores.indexOf(first), 1);
  const reopened = open(filename);
  expect(reopened.list()).toHaveLength(2);
  expect(reopened.get(saved.id).images[0]?.data).toBe(image.data);
  const savedSummary = reopened.list().find((row) => row.id === saved.id);
  if (!savedSummary) throw new Error("Missing saved note");
  const completed = reopened.save({
    ...savedSummary,
    completed: true,
  });
  expect(completed.completed).toBe(true);
  expect(completed.status).toBe("completed");
  expect(reopened.get(saved.id).images[0]?.data).toBe(image.data);
  expect(reopened.get(saved.id).projectPath).toBe("/project/a");
});

test("handoff markers survive reopening and completion changes without invalidating content revisions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-todo-composed-"));
  directories.push(directory);
  const filename = path.join(directory, "notes.sqlite");
  const first = open(filename);
  const saved = first.save({ ...note, images: [image] });
  expect(saved.composedAt).toBeUndefined();
  const marked = first.markComposed({ id: saved.id, revision: saved.revision });
  expect(Number.isFinite(Date.parse(marked.composedAt ?? ""))).toBe(true);
  expect(marked.revision).toBe(saved.revision);
  expect(marked.completed).toBe(false);
  expect(marked.images[0]?.data).toBeUndefined();
  expect(first.get(saved.id).images[0]?.data).toBe(image.data);
  const completed = first.save({ ...saved, completed: true });
  expect(completed.composedAt).toBe(marked.composedAt);
  first.close();
  stores.splice(stores.indexOf(first), 1);
  const reopened = open(filename);
  expect(reopened.list()[0]?.composedAt).toBe(marked.composedAt);
  expect(reopened.get(saved.id).images[0]?.data).toBe(image.data);
});

test("stale, deleted and invalid todos cannot be marked as transferred", () => {
  const store = open();
  const saved = store.save(note);
  const edited = store.save({ ...saved, text: "Changed before handoff" });
  expect(() => store.markComposed(saved)).toThrow("changed");
  expect(store.get(saved.id).composedAt).toBeUndefined();
  expect(() => store.markComposed({ id: "", revision: 1 })).toThrow("Invalid");
  expect(() => store.markComposed({ id: saved.id, revision: 1.5 })).toThrow("Invalid");
  store.trash({ id: edited.id, revision: edited.revision, deleted: true });
  expect(() => store.markComposed(edited)).toThrow("changed");
});

test("existing databases gain handoff metadata without marking old notes or losing data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-todo-upgrade-"));
  directories.push(directory);
  const filename = path.join(directory, "notes.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE project_todos (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, project_path TEXT NOT NULL,
    text TEXT NOT NULL, completed INTEGER NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT
  )`);
  legacy.prepare("INSERT INTO project_todos VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("legacy", 1, note.projectPath, note.text, 0, "2026-01-01", "2026-01-01", null);
  legacy.prepare("INSERT INTO project_todos VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("done", 1, note.projectPath, "Already done", 1, "2026-01-01", "2026-01-01", null);
  legacy.close();
  const store = open(filename);
  const old = store.get("legacy");
  expect(old.text).toBe(note.text);
  expect(old.status).toBe("pending");
  expect(store.get("done").status).toBe("completed");
  expect(old.composedAt).toBeUndefined();
  expect(store.markComposed(old).composedAt).toBeDefined();
});

test("in-progress status survives old-client edits, completion toggles, and database reopening", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-todo-status-"));
  directories.push(directory);
  const filename = path.join(directory, "notes.sqlite");
  const store = open(filename);
  const created = store.save({ ...note, images: [image] });
  const started = store.updateStatus({ id: created.id, revision: created.revision, status: "in_progress" });
  const marked = store.markComposed(started);
  // The mobile client sends only completed, so an ordinary edit retains progress.
  const { status: _status, ...legacy } = started;
  const edited = store.save({ ...legacy, text: "User edit" });
  expect(edited.status).toBe("in_progress");
  expect(edited.composedAt).toBe(marked.composedAt);
  expect(store.get(edited.id).images[0]?.data).toBe(image.data);
  expect(() => store.updateStatus({ id: started.id, revision: started.revision, status: "completed" })).toThrow("changed");
  expect(() => store.save({ ...edited, status: "bogus" as never })).toThrow("status");
  const completed = store.save({ ...edited, completed: true });
  expect(completed.status).toBe("completed");
  const reopened = store.save({ ...completed, completed: false });
  expect(reopened.status).toBe("pending");
  store.updateStatus({ id: reopened.id, revision: reopened.revision, status: "in_progress" });
  store.close();
  stores.splice(stores.indexOf(store), 1);
  expect(open(filename).get(created.id).status).toBe("in_progress");
});

test("stale edits and deletes cannot overwrite newer changes; deletion can be undone", () => {
  const store = open();
  const saved = store.save(note);
  const updated = store.save({ ...saved, text: "Updated idea" });
  expect(() => store.save({ ...saved, text: "Stale edit" })).toThrow("changed");
  expect(() => store.trash({ id: saved.id, revision: saved.revision, deleted: true })).toThrow("changed");
  const revision = store.trash({ id: updated.id, revision: updated.revision, deleted: true });
  expect(store.list()).toHaveLength(0);
  expect(() => store.get(updated.id)).toThrow("no longer exists");
  store.trash({ id: updated.id, revision, deleted: false });
  expect(store.get(updated.id).text).toBe("Updated idea");
});

test("invalid image updates preserve the existing note and image", () => {
  const store = open();
  const saved = store.save({ ...note, images: [image] });
  expect(() => store.save({ ...saved, images: [{ ...image, data: "invalid image!" }] })).toThrow();
  expect(() =>
    store.save({
      ...saved,
      images: [{ ...image, data: Buffer.alloc(TODO_MAX_IMAGE_BYTES + 1).toString("base64") }],
    }),
  ).toThrow();
  expect(() => store.save({ ...saved, images: [image, image] })).toThrow();
  expect(store.get(saved.id).revision).toBe(saved.revision);
  expect(store.get(saved.id).images[0]?.data).toBe(image.data);
});

test("image-only notes work; empty notes, invalid projects, excess images and unknown image references fail", () => {
  const store = open();
  expect(store.save({ ...note, text: "", images: [image] }).text).toBe("");
  expect(() => store.save({ ...note, text: "  " })).toThrow();
  expect(() => store.save({ ...note, projectPath: "relative/path" })).toThrow();
  expect(() =>
    store.save({
      ...note,
      images: Array.from({ length: 6 }, (_, index) => ({ ...image, id: String(index) })),
    }),
  ).toThrow();
  expect(() => store.save({ ...note, images: [{ id: "missing", mediaType: "image/png" }] })).toThrow();
});

test("remote image chunks preserve original bytes and reject mixed revisions or deleted todos", () => {
  const store = open();
  const original = Buffer.alloc(150_000, 137);
  const saved = store.save({ ...note, images: [{ ...image, data: original.toString("base64") }] });
  expect(store.get(saved.id, false).images[0]?.data).toBeUndefined();
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < original.length) {
    const chunk = store.readImageChunk({ id: saved.id, revision: saved.revision, imageId: image.id, offset });
    expect(chunk.totalBytes).toBe(original.length);
    expect(chunk.nextOffset).toBeGreaterThan(offset);
    chunks.push(Buffer.from(chunk.data, "base64"));
    offset = chunk.nextOffset;
  }
  expect(Buffer.concat(chunks)).toEqual(original);
  expect(() => store.readImageChunk({ id: saved.id, revision: saved.revision, imageId: image.id, offset: -1 })).toThrow();
  expect(() => store.readImageChunk({ id: saved.id, revision: saved.revision, imageId: image.id, offset: 0.5 })).toThrow();
  expect(() => store.readImageChunk({ id: saved.id, revision: saved.revision, imageId: image.id, offset: original.length + 1 })).toThrow();
  const updated = store.save({ ...saved, text: "Edited on desktop" });
  expect(() => store.readImageChunk({ id: saved.id, revision: saved.revision, imageId: image.id, offset: 0 })).toThrow("changed");
  store.trash({ id: updated.id, revision: updated.revision, deleted: true });
  expect(() => store.readImageChunk({ id: updated.id, revision: updated.revision, imageId: image.id, offset: 0 })).toThrow("no longer exists");
});

test("mobile uploads resolve to durable todo bytes and keep optimistic conflict checks", async () => {
  const { resolveProjectTodoUploads } = await import("../src/main/project-todo-uploads");
  const store = open();
  const saved = store.save(note);
  const resolver = async (ref: string) => {
    expect(ref).toBe("sha256:uploaded");
    return { mediaType: image.mediaType, byteLength: Buffer.from(image.data, "base64").length, dataBase64: image.data };
  };
  const input = { ...saved, images: [{ id: image.id, mediaType: image.mediaType, thumbnail: image.thumbnail, contentRef: "sha256:uploaded" }] };
  const resolved = await resolveProjectTodoUploads(input, resolver);
  const updated = store.save(resolved);
  expect(store.get(updated.id).images[0]?.data).toBe(image.data);
  expect(() => store.save(resolved)).toThrow("changed");
  await expect(resolveProjectTodoUploads(input, async () => ({ mediaType: "image/jpeg", byteLength: 1, dataBase64: image.data }))).rejects.toThrow("Invalid todo image");
  await expect(resolveProjectTodoUploads(input, async () => ({ mediaType: image.mediaType, byteLength: TODO_MAX_IMAGE_BYTES + 1, dataBase64: image.data }))).rejects.toThrow("Invalid todo image");
  expect(store.get(updated.id).revision).toBe(updated.revision);
});
