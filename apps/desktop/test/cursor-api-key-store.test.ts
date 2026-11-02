import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCursorApiKeyStore } from "../src/main/cursor-api-key-store";
import { removeTempDirectory } from "./helpers/temp-directory";

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!sqliteAvailable)("stores, imports, and rotates Cursor API keys", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-cursor-keys-"));
  try {
    const store = await createCursorApiKeyStore(path.join(dir, "eco.sqlite"));
    expect(store.migrateLegacy("legacy-key")).toBe(true);
    const imported = store.importText("Work|work-key\nPersonal,personal-key\nwork-key");
    expect(imported.added).toBe(2);
    expect(imported.skipped).toBe(1);
    expect(store.list().map((key) => key.name)).toEqual(["默认密钥", "Work", "Personal"]);
    expect(store.nextApiKey()).toBe("legacy-key");
    expect(store.nextApiKey()).toBe("work-key");
    expect(store.nextApiKey()).toBe("personal-key");
    const personal = store.list().find((key) => key.name === "Personal");
    expect(personal).toBeDefined();
    store.setEnabled(personal!.id, false);
    expect(store.nextApiKey()).toBe("legacy-key");
    expect(store.nextApiKey()).toBe("work-key");
  } finally {
    await removeTempDirectory(dir);
  }
});

test.skipIf(!sqliteAvailable)("keeps each conversation's key across turns and restarts; disabled keys are excluded", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-cursor-keys-"));
  try {
    const dbPath = path.join(dir, "eco.sqlite");
    const store = await createCursorApiKeyStore(dbPath);
    const work = store.save({ name: "Work", apiKey: "work-secret-1234" });
    const personal = store.save({ name: "Personal", apiKey: "personal-secret-5678" });
    expect(store.firstApiKey()).toBe("work-secret-1234");
    expect(store.apiKeyForThread("t1")).toBe("work-secret-1234");
    expect(store.apiKeyForThread("t2")).toBe("personal-secret-5678");
    expect(store.apiKeyForThread("t1")).toBe("work-secret-1234");
    const reopened = await createCursorApiKeyStore(dbPath);
    expect(reopened.apiKeyForThread("t2")).toBe("personal-secret-5678");
    store.setEnabled(work.id, false);
    expect(store.apiKeyForThread("t1")).toBe("personal-secret-5678");
    store.setEnabled(personal.id, false);
    expect(store.apiKeyForThread("t3")).toBeUndefined();
    expect(store.firstApiKey()).toBeUndefined();
    expect(JSON.stringify(store.list())).not.toContain("work-secret-1234");
    expect(JSON.stringify(store.list())).not.toContain("personal-secret-5678");
  } finally {
    await removeTempDirectory(dir);
  }
});

test.skipIf(!sqliteAvailable)("edits preserve secrets and enabled state; malformed imports do not partially write", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-cursor-keys-"));
  try {
    const store = await createCursorApiKeyStore(path.join(dir, "eco.sqlite"));
    const key = store.save({ name: "Disabled", apiKey: "existing-key", enabled: false });
    store.save({ id: key.id, name: "Renamed", apiKey: "" });
    expect(store.listWithSecrets()[0]).toMatchObject({ name: "Renamed", apiKey: "existing-key", enabled: false });
    expect(store.importText("Imported|existing-key").updated).toBe(1);
    expect(store.list()[0]?.enabled).toBe(false);
    expect(() => store.importText("valid-new-key\nInvalid|")).toThrow("第 2 行");
    expect(store.list()).toHaveLength(1);
    expect(() => store.importText("# comments only")).toThrow();
    expect(() => store.save({ id: "missing", name: "Missing", apiKey: "secret" })).toThrow();
    expect(store.migrateLegacy("existing-key")).toBe(false);
    store.remove(key.id);
    expect(store.list()).toHaveLength(0);
  } finally {
    await removeTempDirectory(dir);
  }
});

test.skipIf(!sqliteAvailable)("migrates mistaken provider key rows once without restoring deleted keys", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-cursor-migration-"));
  try {
    const dbPath = path.join(dir, "eco.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE provider_api_keys (
      id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, api_key TEXT, enabled INTEGER,
      sort_order INTEGER, created_at TEXT, updated_at TEXT
    );
    INSERT INTO provider_api_keys VALUES ('old-cursor', 'cursor', 'Imported', 'cursor-secret', 0, 0, '2026-01-01', '2026-01-01');
    INSERT INTO provider_api_keys VALUES ('other-key', 'other', 'Other', 'other-secret', 1, 0, '2026-01-01', '2026-01-01');`);
    const store = await createCursorApiKeyStore(dbPath);
    expect(store.listWithSecrets()[0]).toMatchObject({ id: "old-cursor", apiKey: "cursor-secret", enabled: false });
    store.remove("old-cursor");
    const reopened = await createCursorApiKeyStore(dbPath);
    expect(reopened.list()).toEqual([]);
    expect(db.prepare("SELECT id FROM provider_api_keys").all()).toEqual([{ id: "other-key" }]);
    db.close();
  } finally {
    await removeTempDirectory(dir);
  }
});

test.skipIf(!sqliteAvailable)("sync replaces all key metadata and secrets atomically, including empty lists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-cursor-sync-"));
  try {
    const store = await createCursorApiKeyStore(path.join(dir, "eco.sqlite"));
    const key = store.save({ name: "Local", apiKey: "local-secret" });
    store.apiKeyForThread("t1");
    const snapshot = [{ id: key.id, name: "Synced", apiKey: "synced-secret", enabled: false }];
    store.applySyncedKeys(JSON.stringify(snapshot));
    expect(store.listWithSecrets()[0]).toMatchObject(snapshot[0]!);
    expect(store.apiKeyForThread("t1")).toBeUndefined();
    expect(() => store.applySyncedKeys('[{"id":"invalid"}]')).toThrow();
    expect(store.list()).toHaveLength(1);
    store.applySyncedKeys("[]");
    expect(store.list()).toEqual([]);
  } finally {
    await removeTempDirectory(dir);
  }
});
