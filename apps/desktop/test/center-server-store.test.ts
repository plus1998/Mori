import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCenterServerStore } from "../src/main/center-server-store";

const testSecretCodec = {
  encode: (value: string) => `test:${Buffer.from(value).toString("base64")}`,
  decode: (value: string) => Buffer.from(value.slice(5), "base64").toString("utf8"),
};

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!sqliteAvailable)("center server store saves settings and preserves secrets", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-center-server-"));
  const store = await createCenterServerStore(path.join(dir, "eco-coding.sqlite"), {
    secretCodec: testSecretCodec,
  });

  const saved = store.saveSettings({
    enabled: true,
    supabaseUrl: "https://center.example.com/",
    anonKey: "anon_public_key",
    deviceId: "dev_1",
    deviceName: "My Desktop",
    deviceSecret: "secret_abc",
    accessToken: "access_1",
    refreshToken: "refresh_1",
    accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  });
  expect(saved.enabled).toBe(true);
  expect(saved.supabaseUrl).toBe("https://center.example.com");
  expect(saved.serverUrl).toBe("https://center.example.com");
  expect(saved.deviceId).toBe("dev_1");
  expect(saved.hasAnonKey).toBe(true);
  expect(saved.hasDeviceSecret).toBe(true);
  expect(saved.hasRefreshToken).toBe(true);

  const updated = store.saveSettings({
    enabled: true,
    supabaseUrl: "https://center.example.com",
    anonKey: "",
    deviceSecret: "",
    refreshToken: "",
  });
  expect(updated.deviceName).toBe("My Desktop");
  const secrets = store.getSettingsWithSecrets();
  expect(secrets.anonKey).toBe("anon_public_key");
  expect(secrets.deviceSecret).toBe("secret_abc");
  expect(secrets.refreshToken).toBe("refresh_1");
});

test.skipIf(!sqliteAvailable)("center server store clearRefreshToken clears auth tokens only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-center-server-clear-"));
  const store = await createCenterServerStore(path.join(dir, "eco-coding.sqlite"), {
    secretCodec: testSecretCodec,
  });
  store.saveSettings({
    enabled: true,
    supabaseUrl: "https://center.example.com/",
    anonKey: "anon_public_key",
    deviceId: "dev_1",
    deviceName: "My Desktop",
    deviceSecret: "secret_abc",
    accessToken: "access_1",
    refreshToken: "refresh_1",
    accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  });

  store.clearRefreshToken();
  const secrets = store.getSettingsWithSecrets();
  expect(secrets.deviceSecret).toBe("secret_abc");
  expect(secrets.anonKey).toBe("anon_public_key");
  expect(secrets.refreshToken).toBe("");
  expect(secrets.accessToken).toBe("");
  expect(secrets.accessTokenExpiresAt ?? "").toBe("");
  expect(store.getSettings().settings.hasRefreshToken).toBe(false);
});

test.skipIf(!sqliteAvailable)(
  "center server store clearConnection resets all connection fields",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-center-server-reset-"));
    const store = await createCenterServerStore(path.join(dir, "eco-coding.sqlite"), {
      secretCodec: testSecretCodec,
    });
    store.saveSettings({
      enabled: true,
      supabaseUrl: "https://center.example.com/",
      anonKey: "anon_public_key",
      deviceId: "dev_1",
      deviceName: "My Desktop",
      deviceSecret: "secret_abc",
      accessToken: "access_1",
      refreshToken: "refresh_1",
      accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
    });

    store.clearConnection();
    const snapshot = store.getSettings();
    expect(snapshot.settings.enabled).toBe(false);
    expect(snapshot.settings.supabaseUrl).toBe("");
    expect(snapshot.settings.serverUrl).toBe("");
    expect(snapshot.settings.hasAnonKey).toBe(false);
    expect(snapshot.settings.deviceId ?? "").toBe("");
    expect(snapshot.settings.deviceName).toBe("Mori Desktop");
    expect(snapshot.settings.hasDeviceSecret).toBe(false);
    expect(snapshot.settings.hasRefreshToken).toBe(false);
    const secrets = store.getSettingsWithSecrets();
    expect(secrets.anonKey).toBe("");
    expect(secrets.deviceSecret).toBe("");
    expect(secrets.refreshToken).toBe("");
  },
);

test.skipIf(!sqliteAvailable)(
  "center server store encrypts local secrets when a codec is configured",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-center-server-encrypted-"));
    const dbPath = path.join(dir, "eco-coding.sqlite");
    const store = await createCenterServerStore(dbPath, {
      secretCodec: {
        encode(value) {
          return `enc:${Buffer.from(value).toString("base64")}`;
        },
        decode(value) {
          return value.startsWith("enc:") ? Buffer.from(value.slice(4), "base64").toString("utf8") : value;
        },
      },
    });

    const saved = store.saveSettings({
      enabled: true,
      supabaseUrl: "https://center.example.com/",
      anonKey: "anon_public_key",
      deviceId: "dev_1",
      deviceName: "My Desktop",
      deviceSecret: "secret_abc",
      accessToken: "access_1",
      refreshToken: "refresh_1",
      accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(saved.hasAnonKey).toBe(true);
    expect(saved.hasDeviceSecret).toBe(true);
    expect(saved.deviceSecretPreview?.startsWith("se")).toBe(true);
    expect(saved.deviceSecretPreview?.endsWith("bc")).toBe(true);
    expect(store.getSettingsWithSecrets()).toMatchObject({
      deviceSecret: "secret_abc",
      accessToken: "access_1",
      refreshToken: "refresh_1",
    });

    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT device_secret, access_token, refresh_token FROM center_server_config WHERE id = 1")
        .get() as {
        device_secret: string;
        access_token: string;
        refresh_token: string;
      };
      expect(row.device_secret).not.toBe("secret_abc");
      expect(row.access_token).not.toBe("access_1");
      expect(row.refresh_token).not.toBe("refresh_1");
    } finally {
      db.close();
    }
  },
);

test.skipIf(!sqliteAvailable)("center server store persists vault_key securely", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-center-server-vault-"));
  const store = await createCenterServerStore(path.join(dir, "eco-coding.sqlite"), {
    secretCodec: testSecretCodec,
  });
  expect(store.getVaultKey()).toBe("");
  expect(store.getSettings().settings.hasVaultKey).toBe(false);

  store.saveVaultKey("vault_key_material_base64url");
  expect(store.getVaultKey()).toBe("vault_key_material_base64url");
  expect(store.getSettingsWithSecrets().vaultKey).toBe("vault_key_material_base64url");
  expect(store.getSettings().settings.hasVaultKey).toBe(true);

  store.markSettingsSynced("2030-01-01T00:00:00.000Z");
  expect(store.getSettings().settings.lastSettingsSyncedAt).toBe("2030-01-01T00:00:00.000Z");

  store.clearConnection();
  expect(store.getVaultKey()).toBe("");
  expect(store.getSettings().settings.hasVaultKey).toBe(false);
});

test.skipIf(!sqliteAvailable)("center server store tracks per-domain sync times", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-center-server-domain-sync-"));
  const store = await createCenterServerStore(path.join(dir, "eco-coding.sqlite"), {
    secretCodec: testSecretCodec,
  });
  store.markDomainSynced("providers", "2030-01-01T00:00:00.000Z");
  expect(store.getDomainSyncTimes().providers).toBe("2030-01-01T00:00:00.000Z");
});

test.skipIf(!sqliteAvailable)("center server store refuses plaintext secret writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-center-server-no-codec-"));
  const store = await createCenterServerStore(path.join(dir, "eco-coding.sqlite"));
  expect(() =>
    store.saveSettings({
      enabled: true,
      supabaseUrl: "https://center.example.com",
      anonKey: "anon_public_key",
    }),
  ).toThrow("refusing to store Center credentials in plaintext");
  expect(() => store.saveVaultKey("vault-key")).toThrow("refusing to store Center credentials in plaintext");
});
