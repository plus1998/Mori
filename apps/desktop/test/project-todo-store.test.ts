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
  expect(reopened.get(saved.id).images[0]?.data).toBe(image.data);
  expect(reopened.get(saved.id).projectPath).toBe("/project/a");
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
