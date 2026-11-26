import { randomUUID } from "node:crypto";
import type { OpenAIAccountProxyConfig, OpenAIAccountProxyMode } from "../shared/openai-account";
import { webChatProxyConfig } from "../shared/web-chat-list";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type {
  CursorApiKeyImportResult,
  CursorApiKeyInput,
  CursorApiKeyView,
} from "../shared/ipc";

export type CursorOAuthCredential = {
  kind: "oauth";
  accountId: string;
  value: string;
  expiresAt: number;
  proxy?: OpenAIAccountProxyConfig;
};

export type CursorCredential = CursorOAuthCredential
  | { kind: "apiKey"; value: string; proxy?: OpenAIAccountProxyConfig };

interface CursorApiKeyRow {
  id: string;
  name: string;
  api_key: string;
  oauth_expires_at: number | null;
  proxy_mode: OpenAIAccountProxyMode;
  proxy_url: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export async function createCursorApiKeyStore(dbPath: string): Promise<CursorApiKeyStore> {
  const sqlite = await import("node:sqlite");
  const store = new CursorApiKeyStore(new sqlite.DatabaseSync(dbPath));
  store.initialize();
  return store;
}

export class CursorApiKeyStore {
  private rotationIndex = 0;

  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursor_api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cursor_api_keys_order
        ON cursor_api_keys(sort_order, created_at);
      CREATE TABLE IF NOT EXISTS cursor_api_key_assignments (
        thread_id TEXT PRIMARY KEY,
        api_key_id TEXT NOT NULL
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(cursor_api_keys)").all();
    if (!columns.some((column) => column.name === "oauth_expires_at")) {
      this.db.exec("ALTER TABLE cursor_api_keys ADD COLUMN oauth_expires_at INTEGER");
    }
    if (!columns.some((column) => column.name === "proxy_mode")) {
      this.db.exec("ALTER TABLE cursor_api_keys ADD COLUMN proxy_mode TEXT NOT NULL DEFAULT 'system'");
    }
    if (!columns.some((column) => column.name === "proxy_url")) {
      this.db.exec("ALTER TABLE cursor_api_keys ADD COLUMN proxy_url TEXT");
    }
    this.migrateProviderApiKeys();
  }

  list(): CursorApiKeyView[] {
    return this.rows().map((row) => this.toView(row));
  }

  listWithSecrets(): Array<CursorApiKeyView & { apiKey: string }> {
    return this.rows().filter((row) => row.oauth_expires_at === null).map((row) => ({ ...this.toView(row, false), apiKey: row.api_key }));
  }

  nextApiKey(): string | undefined {
    return this.nextEnabledAccount(this.rows().filter((row) => row.oauth_expires_at === null))?.api_key;
  }

  firstCredential(): CursorCredential | undefined {
    const enabled = this.rows().filter((row) => row.enabled === 1 && row.api_key !== "");
    const now = Date.now();
    const row = enabled.find((account) => account.oauth_expires_at === null || account.oauth_expires_at > now) ?? enabled[0];
    return row && this.toCredential(row);
  }

  credentialForAccount(id: string): CursorCredential {
    const row = this.getRow(id);
    if (!row || row.enabled !== 1) throw new Error("指定的 Cursor 账号不存在或已停用。");
    if (!row.api_key) throw new Error("指定的 Cursor 账号尚未完成 CLI 授权。");
    return this.toCredential(row);
  }

  credentialForThread(threadId: string, assign = true): CursorCredential | undefined {
    const assignment = this.db.prepare(
      `SELECT k.* FROM cursor_api_key_assignments a
       JOIN cursor_api_keys k ON k.id = a.api_key_id
       WHERE a.thread_id = ? AND k.enabled = 1 AND k.api_key <> ''`,
    ).get(threadId) as unknown as CursorApiKeyRow | undefined;
    if (assignment) return this.toCredential(assignment);
    if (!assign) return undefined;
    const enabled = this.rows().filter((row) => row.enabled === 1 && row.api_key !== "");
    const now = Date.now();
    const active = enabled.filter((row) => row.oauth_expires_at === null || row.oauth_expires_at > now);
    const account = this.nextEnabledAccount(active);
    if (!account) return enabled[0] && this.toCredential(enabled[0]);
    this.db.prepare(
      `INSERT INTO cursor_api_key_assignments (thread_id, api_key_id) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET api_key_id = excluded.api_key_id`,
    ).run(threadId, account.id);
    return this.toCredential(account);
  }

  firstApiKey(): string | undefined {
    return this.rows().find((row) => row.enabled === 1 && row.oauth_expires_at === null)?.api_key;
  }

  apiKeyForThread(threadId: string): string | undefined {
    const credential = this.credentialForThread(threadId);
    return credential?.kind === "apiKey" ? credential.value : undefined;
  }

  private nextEnabledAccount(rows: CursorApiKeyRow[]): CursorApiKeyRow | undefined {
    const enabled = rows.filter((row) => row.enabled === 1);
    if (enabled.length === 0) return undefined;
    const account = enabled[this.rotationIndex % enabled.length];
    this.rotationIndex = (this.rotationIndex + 1) % enabled.length;
    return account;
  }

  private toCredential(row: CursorApiKeyRow): CursorCredential {
    const proxy: OpenAIAccountProxyConfig | undefined = row.proxy_mode === "system" ? undefined : {
      mode: row.proxy_mode,
      ...(row.proxy_url ? { proxyUrl: row.proxy_url } : {}),
    };
    return row.oauth_expires_at === null
      ? { kind: "apiKey", value: row.api_key, ...(proxy ? { proxy } : {}) }
      : { kind: "oauth", accountId: row.id, value: row.api_key, expiresAt: row.oauth_expires_at, ...(proxy ? { proxy } : {}) };
  }

  saveOAuth(id: string, name: string, encryptedToken: string, expiresAt: number, proxy?: OpenAIAccountProxyConfig): CursorApiKeyView {
    const prior = this.getRow(id);
    if (prior?.oauth_expires_at === null) throw new Error("该 Cursor 账号使用 API Key。");
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO cursor_api_keys
        (id, name, api_key, oauth_expires_at, enabled, sort_order, created_at, updated_at, proxy_mode, proxy_url)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key,
         oauth_expires_at = excluded.oauth_expires_at, updated_at = excluded.updated_at`,
    ).run(id, name, encryptedToken, expiresAt, this.sortOrder(id), now, now, proxy?.mode ?? "system", proxy?.proxyUrl ?? null);
    return this.get(id);
  }

  replaceOAuthCredential(current: CursorOAuthCredential, encrypted: string, expiresAt: number): boolean {
    const result = this.db.prepare(
      `UPDATE cursor_api_keys SET api_key = ?, oauth_expires_at = ?, updated_at = ?
       WHERE id = ? AND api_key = ? AND oauth_expires_at = ? AND enabled = 1`,
    ).run(encrypted, expiresAt, new Date().toISOString(), current.accountId, current.value, current.expiresAt);
    return result.changes === 1;
  }

  save(input: CursorApiKeyInput): CursorApiKeyView {
    const name = input.name.trim();
    if (!name) throw new Error("Cursor API Key 名称不能为空。");
    const prior = input.id ? this.getRow(input.id) : undefined;
    if (input.id !== undefined && !prior) throw new Error("找不到 Cursor API Key。");
    const proxyMode = input.proxyMode ?? prior?.proxy_mode ?? "system";
    const proxyUrl = proxyMode === "manual"
      ? (input.proxyUrl ?? prior?.proxy_url ?? "").trim().replace(/^socks:/u, "socks5:")
      : null;
    if (proxyMode === "manual") {
      if (!proxyUrl || proxyUrl === "direct") throw new Error("手动代理模式需要填写代理地址。");
      webChatProxyConfig(proxyUrl);
    }
    if (input.authKind === "oauth") {
      if (prior?.oauth_expires_at === null) throw new Error("该 Cursor 账号使用 API Key。");
      if (prior) {
        this.db.prepare("UPDATE cursor_api_keys SET name = ?, updated_at = ?, proxy_mode = ?, proxy_url = ? WHERE id = ?")
          .run(name, new Date().toISOString(), proxyMode, proxyUrl, prior.id);
        return this.get(prior.id);
      }
      return this.saveOAuth(`cursor-oauth-${randomUUID()}`, name, "", 0, { mode: proxyMode, ...(proxyUrl ? { proxyUrl } : {}) });
    }
    if (prior && prior.oauth_expires_at !== null) throw new Error("该 Cursor 账号使用 CLI 授权。");
    const apiKey = input.apiKey?.trim() || prior?.api_key || "";
    if (!apiKey) throw new Error("Cursor API Key 不能为空。");
    const id = input.id?.trim() || `cursor-key-${randomUUID()}`;
    const now = new Date().toISOString();
    const sortOrder = prior ? this.sortOrder(input.id as string) : this.nextSortOrder();
    this.db
      .prepare(
        `INSERT INTO cursor_api_keys
          (id, name, api_key, enabled, sort_order, created_at, updated_at, proxy_mode, proxy_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           api_key = excluded.api_key,
           enabled = excluded.enabled,
           proxy_mode = excluded.proxy_mode,
           proxy_url = excluded.proxy_url,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
      )
      .run(id, name, apiKey, input.enabled === undefined ? (prior?.enabled ?? 1) : Number(input.enabled), sortOrder, prior?.created_at ?? now, now, proxyMode, proxyUrl);
    return this.get(id);
  }

  remove(id: string): void {
    const result = this.db.prepare("DELETE FROM cursor_api_keys WHERE id = ?").run(id);
    if (result.changes === 0) throw new Error("找不到 Cursor API Key。");
    this.db.prepare("DELETE FROM cursor_api_key_assignments WHERE api_key_id = ?").run(id);
    this.rotationIndex = 0;
  }

  setEnabled(id: string, enabled: boolean): CursorApiKeyView {
    const result = this.db
      .prepare("UPDATE cursor_api_keys SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    if (result.changes === 0) throw new Error("找不到 Cursor API Key。");
    return this.get(id);
  }

  importText(text: string): CursorApiKeyImportResult {
    const rows = text.split(/\r?\n/u).flatMap((line, index) => {
      const value = line.trim();
      return value && !value.startsWith("#") ? [parseImportLine(value, index + 1)] : [];
    });
    if (rows.length === 0) throw new Error("请输入要导入的 Cursor API Key。");
    const existingKeys = new Map(this.listWithSecrets().map((key) => [key.apiKey, key]));
    const seen = new Set<string>();
    let added = 0;
    let updated = 0;
    let skipped = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const parsed of rows) {
        if (seen.has(parsed.apiKey)) {
          skipped += 1;
          continue;
        }
        seen.add(parsed.apiKey);
        const existing = existingKeys.get(parsed.apiKey);
        this.save({
          ...(existing?.id ? { id: existing.id } : {}),
          name: parsed.name,
          apiKey: parsed.apiKey,
          enabled: existing?.enabled ?? true,
        });
        if (existing) updated += 1;
        else added += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { added, updated, skipped, accounts: this.list() };
  }

  applySyncedKeys(value: string): void {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("云端 Cursor 密钥列表格式无效。");
    const ids = new Set<string>();
    const keys = parsed.map((entry: unknown) => {
      if (!entry || typeof entry !== "object"
        || !("id" in entry) || typeof entry.id !== "string" || !entry.id.trim()
        || !("name" in entry) || typeof entry.name !== "string" || !entry.name.trim()
        || !("apiKey" in entry) || typeof entry.apiKey !== "string" || !entry.apiKey.trim()
        || !("enabled" in entry) || typeof entry.enabled !== "boolean"
        || ids.has(entry.id)) throw new Error("云端 Cursor 密钥列表格式无效。");
      if (this.getRow(entry.id)?.oauth_expires_at != null) throw new Error("云端 Cursor 密钥与本地 OAuth 账号冲突。");
      ids.add(entry.id);
      return { id: entry.id, name: entry.name.trim(), apiKey: entry.apiKey.trim(), enabled: entry.enabled };
    });
    const upsert = this.db.prepare(
      `INSERT INTO cursor_api_keys (id, name, api_key, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, api_key = excluded.api_key,
         enabled = excluded.enabled, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      keys.forEach((key, index) => upsert.run(key.id, key.name, key.apiKey, Number(key.enabled), index, now, now));
      if (keys.length) {
        this.db.prepare(`DELETE FROM cursor_api_keys WHERE oauth_expires_at IS NULL AND id NOT IN (${keys.map(() => "?").join(",")})`).run(...ids);
      } else {
        this.db.exec("DELETE FROM cursor_api_keys WHERE oauth_expires_at IS NULL");
      }
      this.db.exec("DELETE FROM cursor_api_key_assignments WHERE api_key_id NOT IN (SELECT id FROM cursor_api_keys)");
      this.db.exec("COMMIT");
      this.rotationIndex = 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateLegacy(apiKey: string | undefined): boolean {
    const normalized = apiKey?.trim();
    if (!normalized) return false;
    if (this.listWithSecrets().some((key) => key.apiKey === normalized)) return false;
    this.save({ name: "默认密钥", apiKey: normalized, enabled: true });
    return true;
  }

  private rows(): CursorApiKeyRow[] {
    return this.db
      .prepare(
        `SELECT id, name, api_key, oauth_expires_at, proxy_mode, proxy_url, enabled, created_at, updated_at
         FROM cursor_api_keys ORDER BY sort_order ASC, created_at ASC`,
      )
      .all() as unknown as CursorApiKeyRow[];
  }

  private migrateProviderApiKeys(): void {
    const table = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_api_keys'")
      .get() as { name?: string } | undefined;
    if (!table?.name) return;
    const rows = this.db
      .prepare(
        `SELECT id, name, api_key, enabled, sort_order, created_at, updated_at
         FROM provider_api_keys WHERE provider_id = 'cursor'
         ORDER BY sort_order ASC, created_at ASC`,
      )
      .all() as unknown as Array<{
      id: string;
      name: string;
      api_key: string;
      enabled: number;
      sort_order: number;
      created_at: string;
      updated_at: string;
    }>;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO cursor_api_keys
        (id, name, api_key, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        insert.run(row.id, row.name, row.api_key, row.enabled, row.sort_order, row.created_at, row.updated_at);
      }
      this.db.prepare("DELETE FROM provider_api_keys WHERE provider_id = 'cursor'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getRow(id: string): CursorApiKeyRow | undefined {
    return this.db
      .prepare(
        `SELECT id, name, api_key, oauth_expires_at, proxy_mode, proxy_url, enabled, created_at, updated_at
         FROM cursor_api_keys WHERE id = ?`,
      )
      .get(id) as unknown as CursorApiKeyRow | undefined;
  }

  private get(id: string): CursorApiKeyView {
    const row = this.getRow(id);
    if (!row) throw new Error("找不到 Cursor API Key。");
    return this.toView(row);
  }

  private toView(row: CursorApiKeyRow, includeProxy = true): CursorApiKeyView {
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      ...(includeProxy && row.proxy_mode !== "system" ? { proxyMode: row.proxy_mode } : {}),
      ...(includeProxy && row.proxy_url ? { proxyUrl: row.proxy_url } : {}),
      apiKeyPreview: row.oauth_expires_at === null ? previewSecret(row.api_key) : "",
      ...(row.oauth_expires_at === null ? {} : { oauthExpiresAt: row.oauth_expires_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private sortOrder(id: string): number {
    const row = this.db.prepare("SELECT sort_order FROM cursor_api_keys WHERE id = ?").get(id) as
      | { sort_order: number }
      | undefined;
    return row?.sort_order ?? this.nextSortOrder();
  }

  private nextSortOrder(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM cursor_api_keys").get() as
      | { max_order: number }
      | undefined;
    return (row?.max_order ?? -1) + 1;
  }
}

function parseImportLine(line: string, index: number): { name: string; apiKey: string } {
  const separator = ["\t", "|", ","].map((value) => line.indexOf(value)).filter((value) => value >= 0).sort((a, b) => a - b)[0];
  if (separator !== undefined) {
    const name = line.slice(0, separator).trim();
    const apiKey = line.slice(separator + 1).trim();
    if (!apiKey) throw new Error(`第 ${index} 行缺少 Cursor API Key。`);
    return { name: name || `Cursor API Key ${index}`, apiKey };
  }
  return { name: `Cursor API Key ${index}`, apiKey: line };
}

function previewSecret(secret: string): string {
  const value = secret.trim();
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}••••`;
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
