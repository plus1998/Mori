import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  type CenterServerConnectionStatus,
  type CenterServerSettingsInput,
  type CenterServerSettingsSnapshot,
  type CenterServerSettingsView,
  type CenterServerSyncDomain,
  normalizeSupabaseProjectUrl,
  previewCenterServerSecret,
  resolveSupabaseProjectUrl,
  validateCenterServerSettingsInput,
} from "../shared/center-server";

interface CenterServerConfigRow {
  enabled: number;
  server_url: string;
  supabase_url: string;
  anon_key: string;
  device_id: string;
  device_name: string;
  device_secret: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  vault_key: string;
  pending_vault_claim_id: string;
  pending_vault_claim_private_key: string;
  last_connected_at: string;
  last_error: string;
  last_settings_synced_at: string;
  domain_sync_times_json: string;
  updated_at: string;
}

export interface CenterServerSettingsSecret extends CenterServerSettingsView {
  anonKey: string;
  deviceSecret: string;
  accessToken: string;
  refreshToken: string;
  vaultKey: string;
}

export interface CenterServerSecretCodec {
  encode(value: string): string;
  decode(value: string): string;
}

export interface ElectronSafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface CenterServerStoreOptions {
  secretCodec?: CenterServerSecretCodec;
}

const DEFAULT_DEVICE_NAME = "Mori Desktop";
const SAFE_STORAGE_SECRET_PREFIX = "safe:v1:";

export async function createCenterServerStore(
  dbPath: string,
  options: CenterServerStoreOptions = {},
): Promise<CenterServerStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new CenterServerStore(new sqlite.DatabaseSync(dbPath), options);
  store.initialize();
  return store;
}

export class CenterServerStore {
  private readonly secretCodec: CenterServerSecretCodec | undefined;

  constructor(
    private readonly db: DatabaseSyncType,
    options: CenterServerStoreOptions = {},
  ) {
    this.secretCodec = options.secretCodec;
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS center_server_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        server_url TEXT NOT NULL DEFAULT '',
        supabase_url TEXT NOT NULL DEFAULT '',
        anon_key TEXT NOT NULL DEFAULT '',
        device_id TEXT NOT NULL DEFAULT '',
        device_name TEXT NOT NULL DEFAULT '${DEFAULT_DEVICE_NAME}',
        device_secret TEXT NOT NULL DEFAULT '',
        access_token TEXT NOT NULL DEFAULT '',
        refresh_token TEXT NOT NULL DEFAULT '',
        access_token_expires_at TEXT NOT NULL DEFAULT '',
        last_connected_at TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureColumn("supabase_url", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("anon_key", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("vault_key", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("pending_vault_claim_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("pending_vault_claim_private_key", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("last_settings_synced_at", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("domain_sync_times_json", "TEXT NOT NULL DEFAULT '{}'");

    const existing = this.getRow();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO center_server_config (
            id, enabled, server_url, supabase_url, anon_key, device_id, device_name, device_secret,
            access_token, refresh_token, access_token_expires_at, vault_key, last_connected_at,
            last_error, last_settings_synced_at, updated_at
          ) VALUES (1, 0, '', '', '', '', ?, '', '', '', '', '', '', '', '', ?)`,
        )
        .run(DEFAULT_DEVICE_NAME, new Date().toISOString());
      return;
    }

    // Migrate serverUrl-only rows into supabaseUrl.
    if (!existing.supabase_url.trim() && existing.server_url.trim()) {
      this.db
        .prepare(
          `UPDATE center_server_config
           SET supabase_url = server_url, updated_at = ?
           WHERE id = 1`,
        )
        .run(new Date().toISOString());
    }
  }

  getSettings(
    status: CenterServerConnectionStatus = { state: "disconnected" },
  ): CenterServerSettingsSnapshot {
    return {
      settings: rowToView(
        this.getRow() ?? fail("Center server config was not initialized."),
        this.secretCodec,
      ),
      status,
    };
  }

  getSettingsWithSecrets(): CenterServerSettingsSecret {
    const row = this.getRow() ?? fail("Center server config was not initialized.");
    return {
      ...rowToView(row, this.secretCodec),
      anonKey: decodeSecret(row.anon_key, this.secretCodec),
      deviceSecret: decodeSecret(row.device_secret, this.secretCodec),
      accessToken: decodeSecret(row.access_token, this.secretCodec),
      refreshToken: decodeSecret(row.refresh_token, this.secretCodec),
      vaultKey: decodeSecret(row.vault_key, this.secretCodec),
    };
  }

  getVaultKey(): string {
    const row = this.getRow() ?? fail("Center server config was not initialized.");
    return decodeSecret(row.vault_key, this.secretCodec);
  }

  saveVaultKey(vaultKey: string): void {
    const trimmed = vaultKey.trim();
    if (!trimmed) {
      throw new Error("vault_key is required.");
    }
    this.db
      .prepare(
        `UPDATE center_server_config
         SET vault_key = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(encodeSecret(trimmed, this.secretCodec), new Date().toISOString());
  }

  clearVaultKey(): void {
    this.db
      .prepare(
        `UPDATE center_server_config
         SET vault_key = '', updated_at = ?
         WHERE id = 1`,
      )
      .run(new Date().toISOString());
  }

  getPendingVaultClaim(): { claimId: string; requesterPrivateKey: string } | undefined {
    const row = this.getRow() ?? fail("Center server config was not initialized.");
    if (!row.pending_vault_claim_id || !row.pending_vault_claim_private_key) {
      return undefined;
    }
    return {
      claimId: row.pending_vault_claim_id,
      requesterPrivateKey: decodeSecret(row.pending_vault_claim_private_key, this.secretCodec),
    };
  }

  savePendingVaultClaim(claimId: string, requesterPrivateKey: string): void {
    const id = claimId.trim();
    const privateKey = requesterPrivateKey.trim();
    if (!id || !privateKey) {
      throw new Error("Vault claim id and requester private key are required.");
    }
    this.db
      .prepare(
        `UPDATE center_server_config
         SET pending_vault_claim_id = ?, pending_vault_claim_private_key = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(id, encodeSecret(privateKey, this.secretCodec), new Date().toISOString());
  }

  clearPendingVaultClaim(): void {
    this.db
      .prepare(
        `UPDATE center_server_config
         SET pending_vault_claim_id = '', pending_vault_claim_private_key = '', updated_at = ?
         WHERE id = 1`,
      )
      .run(new Date().toISOString());
  }

  markSettingsSynced(syncedAt: string): void {
    this.db
      .prepare(
        `UPDATE center_server_config
         SET last_settings_synced_at = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(syncedAt, new Date().toISOString());
  }

  markDomainSynced(domain: CenterServerSyncDomain, syncedAt: string): void {
    const times = this.getDomainSyncTimes();
    times[domain] = syncedAt;
    this.db
      .prepare(
        `UPDATE center_server_config
         SET domain_sync_times_json = ?, last_settings_synced_at = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(JSON.stringify(times), syncedAt, new Date().toISOString());
  }

  getDomainSyncTimes(): Partial<Record<CenterServerSyncDomain, string>> {
    const row = this.getRow() ?? fail("Center server config was not initialized.");
    if (!row.domain_sync_times_json.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(row.domain_sync_times_json) as Partial<
        Record<CenterServerSyncDomain, string>
      >;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  saveSettings(input: CenterServerSettingsInput): CenterServerSettingsView {
    validateCenterServerSettingsInput(input);
    const existing = this.getRow() ?? fail("Center server config was not initialized.");
    const projectUrl = resolveSupabaseProjectUrl(input);
    const supabaseUrl = projectUrl ? normalizeSupabaseProjectUrl(projectUrl) : "";
    const anonKey =
      input.anonKey && input.anonKey.length > 0
        ? encodeSecret(input.anonKey, this.secretCodec)
        : existing.anon_key;
    const deviceSecret =
      input.deviceSecret && input.deviceSecret.length > 0
        ? encodeSecret(input.deviceSecret, this.secretCodec)
        : existing.device_secret;
    const refreshToken =
      input.refreshToken && input.refreshToken.length > 0
        ? encodeSecret(input.refreshToken, this.secretCodec)
        : existing.refresh_token;
    const accessToken =
      input.accessToken !== undefined
        ? encodeSecret(input.accessToken, this.secretCodec)
        : existing.access_token;
    const accessTokenExpiresAt = input.accessTokenExpiresAt ?? existing.access_token_expires_at;

    this.db
      .prepare(
        `UPDATE center_server_config
         SET enabled = ?, server_url = ?, supabase_url = ?, anon_key = ?, device_id = ?, device_name = ?,
             device_secret = ?, access_token = ?, refresh_token = ?, access_token_expires_at = ?,
             updated_at = ?
         WHERE id = 1`,
      )
      .run(
        input.enabled ? 1 : 0,
        // Keep server_url mirrored for any leftover readers during migration.
        supabaseUrl,
        supabaseUrl,
        anonKey,
        input.deviceId?.trim() ?? existing.device_id,
        input.deviceName?.trim() || existing.device_name || DEFAULT_DEVICE_NAME,
        deviceSecret,
        accessToken,
        refreshToken,
        accessTokenExpiresAt,
        new Date().toISOString(),
      );

    return rowToView(this.getRow() ?? fail("Center server config was not saved."), this.secretCodec);
  }

  saveTokens(input: {
    accessToken: string;
    refreshToken?: string;
    accessTokenExpiresAt: string;
  }): CenterServerSettingsView {
    const existing = this.getRow() ?? fail("Center server config was not initialized.");
    this.db
      .prepare(
        `UPDATE center_server_config
         SET access_token = ?, refresh_token = ?, access_token_expires_at = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(
        encodeSecret(input.accessToken, this.secretCodec),
        input.refreshToken ? encodeSecret(input.refreshToken, this.secretCodec) : existing.refresh_token,
        input.accessTokenExpiresAt,
        new Date().toISOString(),
      );
    return rowToView(this.getRow() ?? fail("Center server tokens were not saved."), this.secretCodec);
  }

  markConnected(connectedAt: string): void {
    this.db
      .prepare(
        `UPDATE center_server_config
         SET last_connected_at = ?, last_error = '', updated_at = ?
         WHERE id = 1`,
      )
      .run(connectedAt, new Date().toISOString());
  }

  markError(message: string): void {
    this.db
      .prepare(
        `UPDATE center_server_config
         SET last_error = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(message, new Date().toISOString());
  }

  clearRefreshToken(): void {
    this.db
      .prepare(
        `UPDATE center_server_config
         SET refresh_token = '', access_token = '', access_token_expires_at = '', updated_at = ?
         WHERE id = 1`,
      )
      .run(new Date().toISOString());
  }

  clearDeviceCredentials(): void {
    this.db
      .prepare(
        `UPDATE center_server_config
         SET device_id = '', device_secret = '', refresh_token = '', access_token = '',
             access_token_expires_at = '', vault_key = '', pending_vault_claim_id = '',
             pending_vault_claim_private_key = '', last_error = '',
             last_settings_synced_at = '', domain_sync_times_json = '{}', updated_at = ?
         WHERE id = 1`,
      )
      .run(new Date().toISOString());
  }

  clearConnection(): void {
    this.db
      .prepare(
        `UPDATE center_server_config
         SET enabled = 0, server_url = '', supabase_url = '', anon_key = '', device_id = '',
             device_name = ?, device_secret = '', access_token = '', refresh_token = '',
             access_token_expires_at = '', vault_key = '', pending_vault_claim_id = '',
             pending_vault_claim_private_key = '', last_connected_at = '',
             last_error = '', last_settings_synced_at = '', domain_sync_times_json = '{}', updated_at = ?
         WHERE id = 1`,
      )
      .run(DEFAULT_DEVICE_NAME, new Date().toISOString());
  }

  private ensureColumn(name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(center_server_config)`).all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === name)) {
      return;
    }
    this.db.exec(`ALTER TABLE center_server_config ADD COLUMN ${name} ${definition}`);
  }

  private getRow(): CenterServerConfigRow | undefined {
    const row = this.db
      .prepare(
        `SELECT enabled, server_url, supabase_url, anon_key, device_id, device_name, device_secret,
                access_token, refresh_token, access_token_expires_at, vault_key,
                pending_vault_claim_id, pending_vault_claim_private_key, last_connected_at,
                last_error, last_settings_synced_at, domain_sync_times_json, updated_at
         FROM center_server_config
         WHERE id = 1`,
      )
      .get() as Partial<CenterServerConfigRow> | undefined;
    if (!row) {
      return undefined;
    }
    return {
      enabled: row.enabled ?? 0,
      server_url: row.server_url ?? "",
      supabase_url: row.supabase_url ?? "",
      anon_key: row.anon_key ?? "",
      device_id: row.device_id ?? "",
      device_name: row.device_name ?? DEFAULT_DEVICE_NAME,
      device_secret: row.device_secret ?? "",
      access_token: row.access_token ?? "",
      refresh_token: row.refresh_token ?? "",
      access_token_expires_at: row.access_token_expires_at ?? "",
      vault_key: row.vault_key ?? "",
      pending_vault_claim_id: row.pending_vault_claim_id ?? "",
      pending_vault_claim_private_key: row.pending_vault_claim_private_key ?? "",
      last_connected_at: row.last_connected_at ?? "",
      last_error: row.last_error ?? "",
      last_settings_synced_at: row.last_settings_synced_at ?? "",
      domain_sync_times_json: row.domain_sync_times_json ?? "{}",
      updated_at: row.updated_at ?? "",
    };
  }
}

export function createElectronSafeStorageCenterServerSecretCodec(
  safeStorage: ElectronSafeStorageLike,
): CenterServerSecretCodec | undefined {
  if (!safeStorage.isEncryptionAvailable()) {
    return undefined;
  }
  return {
    encode(value) {
      if (!value) {
        return "";
      }
      return `${SAFE_STORAGE_SECRET_PREFIX}${safeStorage.encryptString(value).toString("base64")}`;
    },
    decode(value) {
      if (!value?.startsWith(SAFE_STORAGE_SECRET_PREFIX)) {
        throw new Error("Refusing to read an unencrypted Center secret. Reconnect the Supabase account.");
      }
      try {
        return safeStorage.decryptString(
          Buffer.from(value.slice(SAFE_STORAGE_SECRET_PREFIX.length), "base64"),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[center-server] failed to decrypt Center secret from safeStorage (${message}); treating as empty.\n`,
        );
        return "";
      }
    },
  };
}

function rowToView(
  row: CenterServerConfigRow,
  secretCodec: CenterServerSecretCodec | undefined,
): CenterServerSettingsView {
  const supabaseUrl = (row.supabase_url || row.server_url || "").trim();
  const anonKey = decodeSecret(row.anon_key, secretCodec);
  const deviceSecret = decodeSecret(row.device_secret, secretCodec);
  const vaultKey = decodeSecret(row.vault_key, secretCodec);
  const view: CenterServerSettingsView = {
    enabled: row.enabled === 1,
    supabaseUrl,
    serverUrl: supabaseUrl,
    hasAnonKey: anonKey.length > 0,
    deviceName: row.device_name || DEFAULT_DEVICE_NAME,
    hasDeviceSecret: deviceSecret.length > 0,
    hasRefreshToken: decodeSecret(row.refresh_token, secretCodec).length > 0,
    hasVaultKey: vaultKey.length > 0,
  };
  if (row.device_id) {
    view.deviceId = row.device_id;
  }
  const anonPreview = previewCenterServerSecret(anonKey);
  if (anonPreview) {
    view.anonKeyPreview = anonPreview;
  }
  const secretPreview = previewCenterServerSecret(deviceSecret);
  if (secretPreview) {
    view.deviceSecretPreview = secretPreview;
  }
  if (row.access_token_expires_at) {
    view.accessTokenExpiresAt = row.access_token_expires_at;
  }
  if (row.last_connected_at) {
    view.lastConnectedAt = row.last_connected_at;
  }
  if (row.last_settings_synced_at) {
    view.lastSettingsSyncedAt = row.last_settings_synced_at;
  }
  if (row.last_error) {
    view.lastError = row.last_error;
  }
  return view;
}

function encodeSecret(value: string, secretCodec: CenterServerSecretCodec | undefined): string {
  if (!value) {
    return "";
  }
  if (!secretCodec) {
    throw new Error(
      "System secure storage is unavailable; refusing to store Center credentials in plaintext.",
    );
  }
  return secretCodec.encode(value);
}

function decodeSecret(value: string, secretCodec: CenterServerSecretCodec | undefined): string {
  if (!value) {
    return "";
  }
  if (!secretCodec) {
    throw new Error(
      "System secure storage is unavailable; refusing to read Center credentials from plaintext storage.",
    );
  }
  return secretCodec.decode(value);
}

function fail(message: string): never {
  throw new Error(message);
}
