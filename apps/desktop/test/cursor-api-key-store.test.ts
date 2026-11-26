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

test.skipIf(!sqliteAvailable)("rotates OAuth accounts with API keys and preserves OAuth assignments across key sync and reauthorization", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-cursor-oauth-"));
  try {
    const store = await createCursorApiKeyStore(path.join(dir, "eco.sqlite"));
    const expiry = Date.now() + 60_000;
    store.saveOAuth("oauth", "Browser login", "encrypted-token", expiry);
    const key = store.save({ name: "API key", apiKey: "api-secret" });

    expect(store.credentialForThread("oauth-thread")).toEqual({
      kind: "oauth", accountId: "oauth", value: "encrypted-token", expiresAt: expiry,
    });
    expect(store.credentialForThread("api-thread")).toEqual({ kind: "apiKey", value: "api-secret" });
    expect(store.listWithSecrets().map((account) => account.id)).toEqual([key.id]);
    expect(JSON.stringify(store.list())).not.toContain("encrypted-token");

    store.applySyncedKeys("[]");
    expect(store.list().map((account) => account.id)).toEqual(["oauth"]);
    expect(store.credentialForThread("oauth-thread", false)?.kind).toBe("oauth");

    const expiredAt = Date.now() - 60_000;
    store.saveOAuth("oauth", "Browser login", "expired-token", expiredAt);
    const replacement = store.save({ name: "New API key", apiKey: "new-api-secret" });
    expect(store.firstCredential()).toEqual({ kind: "apiKey", value: "new-api-secret" });
    expect(store.credentialForThread("new-thread")).toEqual({ kind: "apiKey", value: "new-api-secret" });
    expect(store.credentialForThread("oauth-thread")).toEqual({
      kind: "oauth", accountId: "oauth", value: "expired-token", expiresAt: expiredAt,
    });

    store.saveOAuth("oauth", "Browser login", "new-encrypted-token", expiry);
    expect(store.credentialForThread("oauth-thread")).toEqual({
      kind: "oauth", accountId: "oauth", value: "new-encrypted-token", expiresAt: expiry,
    });
    expect(store.listWithSecrets().map((account) => account.id)).toEqual([replacement.id]);
  } finally {
    await removeTempDirectory(dir);
  }
});

test.skipIf(!sqliteAvailable)("keeps a Cursor browser account before CLI authorization and activates its existing ID after authorization", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-cursor-browser-account-"));
  try {
    const dbPath = path.join(dir, "eco.sqlite");
    const store = await createCursorApiKeyStore(dbPath);
    const profile = store.save({ name: "Browser account", authKind: "oauth" });
    const reopened = await createCursorApiKeyStore(dbPath);
    expect(reopened.list()).toEqual([profile]);
    expect(profile.oauthExpiresAt).toBe(0);
    expect(reopened.firstCredential()).toBeUndefined();
    expect(reopened.credentialForThread("before")).toBeUndefined();
    expect(reopened.listWithSecrets()).toEqual([]);

    reopened.save({ id: profile.id, name: "Renamed", authKind: "oauth" });
    const expiresAt = Date.now() + 60_000;
    const authorized = reopened.saveOAuth(profile.id, profile.name, "encrypted-token", expiresAt);
    expect(authorized).toMatchObject({ id: profile.id, name: "Renamed", oauthExpiresAt: expiresAt });
    expect(reopened.credentialForThread("after")).toEqual({ kind: "oauth", accountId: profile.id, value: "encrypted-token", expiresAt });
  } finally {
    await removeTempDirectory(dir);
  }
});

test.skipIf(!sqliteAvailable)("preserves each account's local proxy through updates, authorization and key sync", async () => {
  const sqlite = await import("node:sqlite");
  const { CursorApiKeyStore } = await import("../src/main/cursor-api-key-store");
  const db = new sqlite.DatabaseSync(":memory:");
  try {
    const store = new CursorApiKeyStore(db);
    store.initialize();
    const proxyUrl = "socks5://user:password@127.0.0.1:1080";
    expect(() => store.save({ name: "Bad proxy", authKind: "oauth", proxyMode: "manual" })).toThrow();
    const profile = store.save({ name: "Browser", authKind: "oauth", proxyMode: "manual", proxyUrl });
    const key = store.save({ name: "Key", apiKey: "key", proxyMode: "direct" });
    const expiresAt = Date.now() + 60_000;
    store.saveOAuth(profile.id, profile.name, "encrypted-token", expiresAt);
    const synced = store.listWithSecrets();
    expect(synced).toHaveLength(1);
    expect(synced[0]?.proxyMode).toBeUndefined();
    store.applySyncedKeys(JSON.stringify(synced));
    expect(store.list().find((item) => item.id === profile.id)).toMatchObject({ proxyMode: "manual", proxyUrl });
    expect(store.credentialForThread("oauth")).toMatchObject({ kind: "oauth", proxy: { mode: "manual", proxyUrl } });
    expect(store.credentialForThread("key")).toMatchObject({ kind: "apiKey", proxy: { mode: "direct" } });
    const updated = store.save({ id: key.id, name: key.name, proxyMode: "system" });
    expect(updated.proxyMode).toBeUndefined();
    expect(store.credentialForThread("key")).toEqual({ kind: "apiKey", value: "key" });
  } finally {
    db.close();
  }
});
