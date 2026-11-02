import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorktreeSettingsStore } from "../src/main/worktree-settings-store";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-worktree-settings-"));
  roots.push(root);
  const db = new DatabaseSync(path.join(root, "settings.sqlite"));
  databases.push(db);
  const defaultRootPath = path.join(root, "userData", "worktrees");
  const store = new WorktreeSettingsStore(db, defaultRootPath);
  store.initialize();
  return { root, db, store, defaultRootPath };
}

test("defaults to Mori data directory, persists a custom root, and supports clearing it", async () => {
  const f = await fixture();
  expect(f.store.get()).toEqual({ rootPath: "", defaultRootPath: f.defaultRootPath });
  const custom = path.join(f.root, "custom-worktrees");
  await f.store.save({ rootPath: ` ${custom} ` });
  expect(f.store.resolvedRootPath()).toBe(custom);
  const reopened = new WorktreeSettingsStore(f.db, f.defaultRootPath);
  expect(reopened.resolvedRootPath()).toBe(custom);
  await reopened.save({ rootPath: "" });
  expect(reopened.resolvedRootPath()).toBe(f.defaultRootPath);
});

test("invalid or inaccessible roots are reported without replacing the saved root", async () => {
  const f = await fixture();
  await expect(f.store.save({ rootPath: "relative/path" })).rejects.toThrow("绝对路径");
  await expect(f.store.save({ rootPath: 10 })).rejects.toThrow("无效");
  const filePath = path.join(f.root, "file");
  await fs.writeFile(filePath, "file");
  await expect(f.store.save({ rootPath: filePath })).rejects.toThrow();
  expect(f.store.resolvedRootPath()).toBe(f.defaultRootPath);
  f.db
    .prepare("INSERT INTO worktree_settings (key, value_json) VALUES ('snapshot', ?)")
    .run('{"rootPath":"relative"}');
  expect(() => f.store.get()).toThrow("设置无效");
  await f.store.save({ rootPath: "" });
  expect(f.store.resolvedRootPath()).toBe(f.defaultRootPath);
});
