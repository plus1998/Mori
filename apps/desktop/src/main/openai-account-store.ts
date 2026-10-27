import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type {
  OpenAIAccountCreateInput,
  OpenAIAccountDetails,
  OpenAIAccountImageQuota,
  OpenAIAccountImportResult,
  OpenAIAccountProfile,
  OpenAIAccountProxyMode,
  OpenAIAccountQuota,
  OpenAIAccountUpdateInput,
} from "../shared/openai-account";
import { type ParsedOpenAIAccountImportRow, parseOpenAIAccountImport } from "./openai-account-import";

const ACCOUNT_ID_PATTERN = /^oa_[A-Za-z0-9_-]+$/u;
const MIGRATION_KEY = "legacy_migration_v1";
const ACTIVE_KEY = "active_account_id";
const PENDING_KEY = "pending_account_id";
const PENDING_DELETES_KEY = "pending_delete_ids";
const PENDING_AUTH_ACCOUNT_KEY = "pending_auth_account_id";
const PENDING_AUTH_JSON_KEY = "pending_auth_json";
const LAST_PUBLISHED_FINGERPRINT_KEY = "last_published_fingerprint";

export interface StoredOpenAIAccount extends OpenAIAccountDetails {
  name: string;
}

export interface PendingAccountTransition {
  /** null means clear the selected account; undefined means no pending transition. */
  targetAccountId: string | null;
  deleteAccountIds: string[];
  stagedAuth?: { accountId: string; authJson: string };
}

interface AccountRow {
  image_generation_enabled: number;
  image_quota_json: string | null;
  image_quota_account_id: string | null;
  id: string;
  name: string;
  proxy_mode: string | null;
  proxy_url: string | null;
  created_at: string;
  updated_at: string;
  email: string | null;
  password: string | null;
  pickup_url: string | null;
  two_factor_secret: string | null;
  auth_json: string | null;
  quota_json: string | null;
  quota_chatgpt_account_id: string | null;
}

interface LegacyAccount {
  id: string;
  name: string;
  proxyMode?: OpenAIAccountProxyMode;
  proxyUrl?: string;
  createdAt: string;
  updatedAt?: string;
  email?: string;
  password?: string;
  pickupUrl?: string;
  twoFactorSecret?: string;
  authJson?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeOptional(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

function proxyModeFor(mode: string | null | undefined, proxyUrl: string | null | undefined): OpenAIAccountProxyMode {
  if (mode === "system" || mode === "direct" || mode === "manual") return mode;
  return proxyUrl?.trim() ? "manual" : "system";
}

function mapAccount(row: AccountRow): StoredOpenAIAccount {
  const proxyMode = proxyModeFor(row.proxy_mode, row.proxy_url);
  let quota: OpenAIAccountQuota | undefined;
  if (row.quota_json !== null && row.auth_json !== null && readChatGptAccountId(row.auth_json) === row.quota_chatgpt_account_id) {
    try {
      quota = JSON.parse(row.quota_json) as OpenAIAccountQuota;
      if (!quota || !Number.isFinite(quota.fetchedAt) || !quota.rateLimit) throw new Error("额度字段或刷新时间无效");
    } catch (error) {
      throw new Error(`账号 ${row.name} 的额度缓存损坏：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    id: row.id,
    name: row.name,
    proxyMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    authJson: row.auth_json,
    ...(row.image_generation_enabled === 1 ? { imageGenerationEnabled: true } : {}),
    ...(row.image_quota_json && row.auth_json && readChatGptAccountId(row.auth_json) === row.image_quota_account_id
      ? { imageQuota: JSON.parse(row.image_quota_json) as OpenAIAccountImageQuota } : {}),
    ...(quota ? { quota } : {}),
    ...(proxyMode === "manual" && row.proxy_url !== null ? { proxyUrl: row.proxy_url } : {}),
    ...(normalizeOptional(row.email) !== undefined ? { email: row.email as string } : {}),
    ...(normalizeOptional(row.password) !== undefined ? { password: row.password as string } : {}),
    ...(normalizeOptional(row.pickup_url) !== undefined ? { pickupUrl: row.pickup_url as string } : {}),
    ...(normalizeOptional(row.two_factor_secret) !== undefined
      ? { twoFactorSecret: row.two_factor_secret as string }
      : {}),
  };
}

function asLegacyAccount(value: unknown, index: number): LegacyAccount {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`旧账号文件第 ${index + 1} 项格式无效`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !ACCOUNT_ID_PATTERN.test(candidate.id) ||
    typeof candidate.name !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    throw new Error(`旧账号文件第 ${index + 1} 项缺少有效的 id、名称或创建时间`);
  }
  for (const key of ["proxyUrl", "email", "password", "pickupUrl", "twoFactorSecret", "authJson"]) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
      throw new Error(`旧账号文件第 ${index + 1} 项的 ${key} 字段格式无效`);
    }
  }
  if (
    candidate.proxyMode !== undefined &&
    candidate.proxyMode !== "system" &&
    candidate.proxyMode !== "direct" &&
    candidate.proxyMode !== "manual"
  ) {
    throw new Error(`旧账号文件第 ${index + 1} 项的 proxyMode 字段格式无效`);
  }
  return {
    id: candidate.id,
    name: candidate.name,
    ...(candidate.proxyMode === "system" || candidate.proxyMode === "direct" || candidate.proxyMode === "manual"
      ? { proxyMode: candidate.proxyMode }
      : {}),
    createdAt: candidate.createdAt,
    ...(typeof candidate.updatedAt === "string" ? { updatedAt: candidate.updatedAt } : {}),
    ...(typeof candidate.proxyUrl === "string" ? { proxyUrl: candidate.proxyUrl } : {}),
    ...(typeof candidate.email === "string" ? { email: candidate.email } : {}),
    ...(typeof candidate.password === "string" ? { password: candidate.password } : {}),
    ...(typeof candidate.pickupUrl === "string" ? { pickupUrl: candidate.pickupUrl } : {}),
    ...(typeof candidate.twoFactorSecret === "string" ? { twoFactorSecret: candidate.twoFactorSecret } : {}),
    ...(typeof candidate.authJson === "string" ? { authJson: candidate.authJson } : {}),
  };
}

async function readMaybe(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateLegacyAuthJson(content: string, accountId: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`旧账号 ${accountId} 的 auth.json 损坏，原文件已保留`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`旧账号 ${accountId} 的 auth.json 格式无效，原文件已保留`);
  }
  const auth = parsed as { access_token?: unknown; account_id?: unknown; tokens?: { access_token?: unknown; account_id?: unknown } };
  const accessToken = auth.tokens?.access_token ?? auth.access_token;
  const chatGptAccountId = auth.tokens?.account_id ?? auth.account_id;
  if (
    typeof accessToken !== "string" ||
    !accessToken.trim() ||
    typeof chatGptAccountId !== "string" ||
    !chatGptAccountId.trim()
  ) {
    throw new Error(`旧账号 ${accountId} 的 auth.json 缺少 access_token 或 account_id，原文件已保留`);
  }
}

function readChatGptAccountId(content: string): string | undefined {
  try {
    const auth = JSON.parse(content) as {
      account_id?: unknown;
      tokens?: { account_id?: unknown };
    };
    const id = auth.tokens?.account_id ?? auth.account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function nullable(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function profileValue(profile: OpenAIAccountProfile, key: keyof OpenAIAccountProfile): string | undefined {
  const value = profile[key];
  return value === undefined ? undefined : value;
}

export class OpenAIAccountStore {
  constructor(private readonly db: DatabaseSyncType) {}

  static async open(dbPath: string): Promise<OpenAIAccountStore> {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const sqlite = await import("node:sqlite");
    const store = new OpenAIAccountStore(new sqlite.DatabaseSync(dbPath));
    store.initialize();
    return store;
  }

  initialize(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS openai_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        proxy_mode TEXT NOT NULL DEFAULT 'system' CHECK(proxy_mode IN ('system', 'direct', 'manual')),
        proxy_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        email TEXT,
        password TEXT,
        pickup_url TEXT,
        two_factor_secret TEXT,
        auth_json TEXT
      );
      CREATE TABLE IF NOT EXISTS openai_account_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS openai_account_sync_conflicts (
        conflict_key TEXT PRIMARY KEY,
        account_id TEXT,
        main_auth_json TEXT NOT NULL,
        account_auth_json TEXT,
        message TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS openai_account_quotas (
        account_id TEXT PRIMARY KEY REFERENCES openai_accounts(id) ON DELETE CASCADE,
        chatgpt_account_id TEXT NOT NULL,
        quota_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `);
    // Existing installations can already contain the first account table from an
    // interrupted/preview build. Keep the schema forward-compatible in that case.
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(openai_accounts)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    for (const [column, declaration] of [
      ["updated_at", "TEXT NOT NULL DEFAULT ''"],
      ["proxy_mode", "TEXT NOT NULL DEFAULT 'system' CHECK(proxy_mode IN ('system', 'direct', 'manual'))"],
      ["email", "TEXT"],
      ["password", "TEXT"],
      ["pickup_url", "TEXT"],
      ["two_factor_secret", "TEXT"],
      ["auth_json", "TEXT"],
      ["image_generation_enabled", "INTEGER NOT NULL DEFAULT 0 CHECK(image_generation_enabled IN (0, 1))"],
      ["image_quota_json", "TEXT"],
      ["image_quota_account_id", "TEXT"],
    ] as const) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE openai_accounts ADD COLUMN ${column} ${declaration}`);
    }
    // The old UI represented a non-empty proxy URL as a manual proxy and an
    // empty URL as "system network". New writes always clear proxy_url for
    // system/direct accounts, so this safely repairs interrupted upgrades too.
    this.db.exec(`
      UPDATE openai_accounts
      SET proxy_mode = 'manual'
      WHERE proxy_mode = 'system' AND proxy_url IS NOT NULL AND trim(proxy_url) <> ''
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS openai_accounts_email_ci ON openai_accounts(email COLLATE NOCASE);`);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the triggering error if rollback itself fails.
      }
      throw error;
    }
  }

  private setting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM openai_account_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  private setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO openai_account_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, nowIso());
  }

  hasMigratedLegacyFiles(): boolean {
    return this.setting(MIGRATION_KEY) === "complete";
  }

  getActiveAccountId(): string | null {
    return this.setting(ACTIVE_KEY) || null;
  }

  getWakeModel(): string | null {
    return this.setting("wake_model_id") || null;
  }

  setWakeModel(modelId: string | null): void {
    if (modelId !== null && !modelId.trim()) throw new Error("唤醒模型不能为空。");
    this.setSetting("wake_model_id", modelId?.trim() ?? "");
  }

  getRejectedCredentialFingerprint(accountId: string): string | undefined {
    return this.setting(`auth_rejected:${accountId}`);
  }

  rejectCredentials(accountId: string, fingerprint: string): void {
    if (!this.get(accountId)) throw new Error(`OpenAI account not found: ${accountId}`);
    this.setSetting(`auth_rejected:${accountId}`, fingerprint);
  }

  getPendingTransition(): PendingAccountTransition | undefined {
    const target = this.setting(PENDING_KEY);
    if (target === undefined) return undefined;
    const rawDeletes = this.setting(PENDING_DELETES_KEY);
    let deleteAccountIds: string[] = [];
    try {
      const value = rawDeletes ? JSON.parse(rawDeletes) as unknown : [];
      if (Array.isArray(value)) deleteAccountIds = value.filter((id): id is string => typeof id === "string");
    } catch {
      throw new Error("账号待切换设置损坏，请检查本地数据库");
    }
    const stagedAccountId = this.setting(PENDING_AUTH_ACCOUNT_KEY);
    const stagedAuthJson = this.setting(PENDING_AUTH_JSON_KEY);
    if ((stagedAccountId === undefined) !== (stagedAuthJson === undefined)) {
      throw new Error("账号待保存凭据设置不完整，请检查本地数据库");
    }
    return {
      targetAccountId: target || null,
      deleteAccountIds,
      ...(stagedAccountId !== undefined && stagedAuthJson !== undefined
        ? { stagedAuth: { accountId: stagedAccountId, authJson: stagedAuthJson } }
        : {}),
    };
  }

  queueTransition(targetAccountId: string | null, options?: { deleteAccountId?: string; stagedAuth?: { accountId: string; authJson: string } }): void {
    if (targetAccountId && !this.get(targetAccountId)) {
      throw new Error(`OpenAI account not found: ${targetAccountId}`);
    }
    this.transaction(() => {
      const deletes = new Set(this.getPendingTransition()?.deleteAccountIds ?? []);
      if (options?.deleteAccountId) deletes.add(options.deleteAccountId);
      this.setSetting(PENDING_KEY, targetAccountId ?? "");
      this.setSetting(PENDING_DELETES_KEY, JSON.stringify([...deletes]));
      const stagedAuth = options?.stagedAuth ?? this.getPendingTransition()?.stagedAuth;
      if (stagedAuth) {
        this.setSetting(PENDING_AUTH_ACCOUNT_KEY, stagedAuth.accountId);
        this.setSetting(PENDING_AUTH_JSON_KEY, stagedAuth.authJson);
      }
    });
  }

  cancelPendingTransition(): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM openai_account_settings WHERE key IN (?, ?, ?, ?)")
        .run(PENDING_KEY, PENDING_DELETES_KEY, PENDING_AUTH_ACCOUNT_KEY, PENDING_AUTH_JSON_KEY);
    });
  }

  getLastPublishedFingerprint(): string | undefined {
    return this.setting(LAST_PUBLISHED_FINGERPRINT_KEY);
  }

  setLastPublishedFingerprint(fingerprint: string | undefined): void {
    this.transaction(() => {
      if (fingerprint === undefined) {
        this.db.prepare("DELETE FROM openai_account_settings WHERE key = ?").run(LAST_PUBLISHED_FINGERPRINT_KEY);
      } else {
        this.setSetting(LAST_PUBLISHED_FINGERPRINT_KEY, fingerprint);
      }
    });
  }

  recordSyncConflict(accountId: string | null, mainAuthJson: string, accountAuthJson: string | null, message: string): void {
    const conflictKey = `${accountId ?? "<unassigned>"}:${message}`;
    this.db.prepare(`
      INSERT INTO openai_account_sync_conflicts
        (conflict_key, account_id, main_auth_json, account_auth_json, message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conflict_key) DO UPDATE SET
        main_auth_json = excluded.main_auth_json,
        account_auth_json = excluded.account_auth_json,
        updated_at = excluded.updated_at
    `).run(conflictKey, accountId, mainAuthJson, accountAuthJson, message, nowIso());
  }

  clearSyncConflict(accountId: string): void {
    this.db.prepare("DELETE FROM openai_account_sync_conflicts WHERE account_id = ?").run(accountId);
  }

  clearUnassignedSyncConflict(): void {
    this.db.prepare("DELETE FROM openai_account_sync_conflicts WHERE account_id IS NULL").run();
  }

  getLatestSyncConflict(): { accountId: string | null; message: string; updatedAt: string } | undefined {
    const row = this.db.prepare(`
      SELECT account_id, message, updated_at
      FROM openai_account_sync_conflicts
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as { account_id: string | null; message: string; updated_at: string } | undefined;
    return row
      ? { accountId: row.account_id, message: row.message, updatedAt: row.updated_at }
      : undefined;
  }

  commitPendingTransition(fingerprint: string | undefined): PendingAccountTransition | undefined {
    return this.transaction(() => {
      const pending = this.getPendingTransition();
      if (!pending) return undefined;
      const now = nowIso();
      if (pending.stagedAuth) {
        const stagedResult = this.db.prepare("UPDATE openai_accounts SET auth_json = ?, updated_at = ? WHERE id = ?")
          .run(pending.stagedAuth.authJson, now, pending.stagedAuth.accountId);
        if (Number(stagedResult.changes) === 0) {
          throw new Error(`待保存凭据对应的账号不存在：${pending.stagedAuth.accountId}`);
        }
      }
      if (pending.targetAccountId && !this.get(pending.targetAccountId)) {
        throw new Error(`待切换的 OpenAI 账号不存在：${pending.targetAccountId}`);
      }
      if (pending.targetAccountId) this.setSetting(ACTIVE_KEY, pending.targetAccountId);
      else this.db.prepare("DELETE FROM openai_account_settings WHERE key = ?").run(ACTIVE_KEY);
      if (fingerprint === undefined) {
        this.db.prepare("DELETE FROM openai_account_settings WHERE key = ?").run(LAST_PUBLISHED_FINGERPRINT_KEY);
      } else {
        this.setSetting(LAST_PUBLISHED_FINGERPRINT_KEY, fingerprint);
      }
      for (const accountId of pending.deleteAccountIds) {
        if (accountId !== pending.targetAccountId) {
          this.clearSyncConflict(accountId);
          this.db.prepare("DELETE FROM openai_accounts WHERE id = ?").run(accountId);
        }
      }
      this.db
        .prepare("DELETE FROM openai_account_settings WHERE key IN (?, ?, ?, ?)")
        .run(PENDING_KEY, PENDING_DELETES_KEY, PENDING_AUTH_ACCOUNT_KEY, PENDING_AUTH_JSON_KEY);
      return pending;
    });
  }

  async migrateLegacyFiles(legacyDir: string): Promise<void> {
    if (!this.hasMigratedLegacyFiles()) {
      const accountsPath = path.join(legacyDir, "accounts.json");
      const accountsText = await readMaybe(accountsPath);
      let legacyAccounts: LegacyAccount[] = [];
      if (accountsText !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(accountsText);
        } catch {
          throw new Error("旧账号文件 accounts.json 损坏，原文件已保留");
        }
        if (!Array.isArray(parsed)) throw new Error("旧账号文件 accounts.json 不是数组，原文件已保留");
        legacyAccounts = parsed.map(asLegacyAccount);
        const ids = new Set<string>();
        for (const account of legacyAccounts) {
          if (ids.has(account.id)) throw new Error(`旧账号文件包含重复 ID：${account.id}，原文件已保留`);
          ids.add(account.id);
        }
      }
      const knownLegacyIds = new Set(legacyAccounts.map((account) => account.id));
      const legacyEntries = await fs.readdir(legacyDir, { withFileTypes: true });
      for (const entry of legacyEntries) {
        if (!entry.isDirectory() || !ACCOUNT_ID_PATTERN.test(entry.name) || knownLegacyIds.has(entry.name)) continue;
        if (await readMaybe(path.join(legacyDir, entry.name, "auth.json")) !== undefined) {
          throw new Error(`旧账号目录 ${entry.name} 存在 auth.json，但 accounts.json 没有对应账号；原文件已保留`);
        }
      }

      const activeText = await readMaybe(path.join(legacyDir, "active_account.txt"));
      const legacyActiveId = activeText?.trim() || null;
      if (legacyActiveId && !ACCOUNT_ID_PATTERN.test(legacyActiveId)) {
        throw new Error("旧 active_account.txt 中的账号 ID 无效，原文件已保留");
      }
      if (legacyActiveId && !legacyAccounts.some((account) => account.id === legacyActiveId)) {
        throw new Error(`旧启用账号 ${legacyActiveId} 不在 accounts.json 中，原文件已保留`);
      }

      for (const account of legacyAccounts) {
        const authPath = path.join(legacyDir, account.id, "auth.json");
        const fileAuth = await readMaybe(authPath);
        const authJson = fileAuth ?? account.authJson ?? null;
        if (authJson !== null) validateLegacyAuthJson(authJson, account.id);
        if (authJson === null) delete account.authJson;
        else account.authJson = authJson;
      }

      this.transaction(() => {
        const insert = this.db.prepare(`
          INSERT INTO openai_accounts
            (id, name, proxy_mode, proxy_url, created_at, updated_at, email, password, pickup_url, two_factor_secret, auth_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `);
        for (const account of legacyAccounts) {
          const proxyMode = account.proxyMode ?? (account.proxyUrl?.trim() ? "manual" : "system");
          const inserted = insert.run(
            account.id,
            account.name,
            proxyMode,
            nullable(account.proxyUrl),
            account.createdAt,
            account.updatedAt ?? account.createdAt,
            nullable(account.email),
            nullable(account.password),
            nullable(account.pickupUrl),
            nullable(account.twoFactorSecret),
            account.authJson ?? null,
          );
          if (Number(inserted.changes) === 0) {
            const existing = this.get(account.id);
            if (
              !existing ||
              existing.name !== account.name ||
              existing.proxyMode !== proxyMode ||
              existing.createdAt !== account.createdAt ||
              (existing.proxyUrl ?? undefined) !== (account.proxyUrl ?? undefined) ||
              (existing.email ?? undefined) !== (account.email ?? undefined) ||
              (existing.password ?? undefined) !== (account.password ?? undefined) ||
              (existing.pickupUrl ?? undefined) !== (account.pickupUrl ?? undefined) ||
              (existing.twoFactorSecret ?? undefined) !== (account.twoFactorSecret ?? undefined) ||
              existing.authJson !== (account.authJson ?? null)
            ) {
              throw new Error(`旧账号 ${account.id} 与 SQLite 中现有记录冲突，原文件已保留`);
            }
          }
        }
        if (legacyActiveId) {
          const currentActive = this.getActiveAccountId();
          if (currentActive && currentActive !== legacyActiveId) {
            throw new Error(`旧启用账号 ${legacyActiveId} 与 SQLite 当前账号 ${currentActive} 冲突，原文件已保留`);
          }
          if (!currentActive) this.setSetting(ACTIVE_KEY, legacyActiveId);
        }
        this.setSetting(MIGRATION_KEY, "complete");
      });
    }

    // Verify persisted values before moving any source file. If archiving is
    // interrupted, the completed marker makes the next startup safely retry it.
    const accountsPath = path.join(legacyDir, "accounts.json");
    const accountsText = await readMaybe(accountsPath);
    if (accountsText !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(accountsText);
      } catch {
        throw new Error("旧账号文件 accounts.json 损坏，原文件已保留");
      }
      if (!Array.isArray(parsed)) throw new Error("旧账号文件 accounts.json 不是数组，原文件已保留");
      const legacyAccounts = parsed.map(asLegacyAccount);
      for (const account of legacyAccounts) {
        const dbAccount = this.get(account.id);
        if (!dbAccount || dbAccount.name !== account.name || dbAccount.createdAt !== account.createdAt) {
          throw new Error(`SQLite 核对失败：账号 ${account.id}，旧文件已保留`);
        }
        const expectedProxyMode = account.proxyMode ?? (account.proxyUrl?.trim() ? "manual" : "system");
        if (
          dbAccount.proxyMode !== expectedProxyMode ||
          (dbAccount.proxyUrl ?? undefined) !== (account.proxyUrl ?? undefined) ||
          (dbAccount.email ?? undefined) !== (account.email ?? undefined) ||
          (dbAccount.password ?? undefined) !== (account.password ?? undefined) ||
          (dbAccount.pickupUrl ?? undefined) !== (account.pickupUrl ?? undefined) ||
          (dbAccount.twoFactorSecret ?? undefined) !== (account.twoFactorSecret ?? undefined)
        ) {
          throw new Error(`SQLite 资料核对失败：账号 ${account.id}，旧文件已保留`);
        }
        const auth = await readMaybe(path.join(legacyDir, account.id, "auth.json"));
        const expectedAuth = auth ?? account.authJson ?? null;
        if (dbAccount.authJson !== expectedAuth) {
          throw new Error(`SQLite 凭据核对失败：账号 ${account.id}，旧文件已保留`);
        }
      }
    }
    const activeText = await readMaybe(path.join(legacyDir, "active_account.txt"));
    if (activeText !== undefined && (activeText.trim() || null) !== this.getActiveAccountId()) {
      throw new Error("SQLite 启用账号核对失败，旧文件已保留");
    }
    await this.archiveLegacyFiles(legacyDir);
  }

  private async archiveLegacyFiles(legacyDir: string): Promise<void> {
    const archiveRoot = path.join(path.dirname(legacyDir), "codex-accounts-archive");
    const archiveRun = path.join(archiveRoot, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const paths = ["accounts.json", "active_account.txt"];
    for (const account of this.list()) paths.push(path.join(account.id, "auth.json"));
    let moved = false;
    for (const relativePath of paths) {
      const source = path.join(legacyDir, relativePath);
      const content = await readMaybe(source);
      if (content === undefined) continue;
      if (!moved) await fs.mkdir(archiveRun, { recursive: true });
      const target = path.join(archiveRun, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(source, target);
      moved = true;
    }
    if (moved) {
      await fs.writeFile(path.join(archiveRun, "ARCHIVE.txt"), "Legacy Codex account files. SQLite migration was verified before archiving.\n", "utf8");
    }
  }

  list(): StoredOpenAIAccount[] {
    return (this.db.prepare(`
      SELECT a.*, q.quota_json, q.chatgpt_account_id AS quota_chatgpt_account_id
      FROM openai_accounts a LEFT JOIN openai_account_quotas q ON q.account_id = a.id
      ORDER BY a.created_at, a.rowid
    `).all() as unknown as AccountRow[]).map(mapAccount);
  }

  get(accountId: string): StoredOpenAIAccount | undefined {
    const row = this.db.prepare(`
      SELECT a.*, q.quota_json, q.chatgpt_account_id AS quota_chatgpt_account_id
      FROM openai_accounts a LEFT JOIN openai_account_quotas q ON q.account_id = a.id
      WHERE a.id = ?
    `).get(accountId) as AccountRow | undefined;
    return row ? mapAccount(row) : undefined;
  }

  getAuthJson(accountId: string): string | null {
    return this.get(accountId)?.authJson ?? null;
  }

  setImageGenerationEnabled(accountId: string, enabled: boolean): void {
    const result = this.db.prepare("UPDATE openai_accounts SET image_generation_enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, nowIso(), accountId);
    if (!result.changes) throw new Error(`OpenAI account not found: ${accountId}`);
  }

  saveImageQuota(accountId: string, authJson: string, quota: OpenAIAccountImageQuota): void {
    const identity = readChatGptAccountId(authJson);
    if (!identity) throw new Error("账号凭据缺少 account_id");
    const result = this.db.prepare(`UPDATE openai_accounts SET image_quota_json = ?, image_quota_account_id = ?
      WHERE id = ? AND auth_json = ?`).run(JSON.stringify(quota), identity, accountId, authJson);
    if (!result.changes) throw new Error("账号凭据已变更，请重新刷新图片额度");
  }

  saveQuota(accountId: string, chatGptAccountId: string, quota: OpenAIAccountQuota): void {
    this.transaction(() => {
      const account = this.get(accountId);
      if (!account) throw new Error(`OpenAI account not found: ${accountId}`);
      if (!account.authJson || readChatGptAccountId(account.authJson) !== chatGptAccountId) {
        throw new Error("账号凭据已变更，请重新刷新额度");
      }
      this.db.prepare(`
        INSERT INTO openai_account_quotas (account_id, chatgpt_account_id, quota_json, fetched_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          chatgpt_account_id = excluded.chatgpt_account_id,
          quota_json = excluded.quota_json,
          fetched_at = excluded.fetched_at
      `).run(accountId, chatGptAccountId, JSON.stringify(quota), quota.fetchedAt);
    });
  }

  create(input: OpenAIAccountCreateInput): StoredOpenAIAccount {
    const accountId = `oa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = nowIso();
    const proxyMode = input.proxyMode ?? (input.proxyUrl?.trim() ? "manual" : "system");
    const proxyUrl = proxyMode === "manual" ? nullable(input.proxyUrl?.trim()) : null;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO openai_accounts
          (id, name, proxy_mode, proxy_url, created_at, updated_at, email, password, pickup_url, two_factor_secret, auth_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        accountId,
        input.name.trim(),
        proxyMode,
        proxyUrl,
        now,
        now,
        nullable(input.email),
        nullable(input.password),
        nullable(input.pickupUrl),
        nullable(input.twoFactorSecret),
      );
    });
    const account = this.get(accountId);
    if (!account) throw new Error("账号写入 SQLite 后无法读取");
    return account;
  }

  update(input: OpenAIAccountUpdateInput): StoredOpenAIAccount {
    const existing = this.get(input.accountId);
    if (!existing) throw new Error(`OpenAI account not found: ${input.accountId}`);
    const proxyMode = input.proxyMode ?? (input.proxyUrl !== undefined
      ? input.proxyUrl.trim() ? "manual" : "system"
      : existing.proxyMode);
    const proxyUrl = proxyMode === "manual"
      ? nullable(input.proxyUrl === undefined ? existing.proxyUrl : input.proxyUrl.trim())
      : null;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE openai_accounts
        SET name = ?, proxy_mode = ?, proxy_url = ?, email = ?, password = ?, pickup_url = ?, two_factor_secret = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.name.trim(),
        proxyMode,
        proxyUrl,
        input.email === undefined ? existing.email ?? null : nullable(profileValue(input, "email")),
        input.password === undefined ? existing.password ?? null : nullable(profileValue(input, "password")),
        input.pickupUrl === undefined ? existing.pickupUrl ?? null : nullable(profileValue(input, "pickupUrl")),
        input.twoFactorSecret === undefined
          ? existing.twoFactorSecret ?? null
          : nullable(profileValue(input, "twoFactorSecret")),
        nowIso(),
        input.accountId,
      );
    });
    const account = this.get(input.accountId);
    if (!account) throw new Error(`OpenAI account not found: ${input.accountId}`);
    return account;
  }

  saveAuthJson(accountId: string, authJson: string): void {
    this.transaction(() => {
      if (this.get(accountId)?.authJson !== authJson) {
        this.db.prepare("DELETE FROM openai_account_settings WHERE key = ?").run(`auth_rejected:${accountId}`);
      }
      const result = this.db.prepare("UPDATE openai_accounts SET auth_json = ?, updated_at = ? WHERE id = ?").run(
        authJson,
        nowIso(),
        accountId,
      );
      if (Number(result.changes) === 0) throw new Error(`OpenAI account not found: ${accountId}`);
    });
  }

  delete(accountId: string): void {
    this.transaction(() => {
      this.clearSyncConflict(accountId);
      this.db.prepare("DELETE FROM openai_accounts WHERE id = ?").run(accountId);
      this.db.prepare("DELETE FROM openai_account_settings WHERE key = ?").run(`auth_rejected:${accountId}`);
    });
  }

  importProfiles(input: string): OpenAIAccountImportResult {
    const parsed = parseOpenAIAccountImport(input);
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.map(({ lineNumber, message }) => `第 ${lineNumber} 行：${message}`).join("\n"));
    }
    if (parsed.rows.length === 0) throw new Error("没有可导入的账号记录");

    const foldedByEmail = new Map<string, ParsedOpenAIAccountImportRow>();
    const ordered: ParsedOpenAIAccountImportRow[] = [];
    for (const row of parsed.rows) {
      if (!row.email) {
        ordered.push(row);
        continue;
      }
      const key = row.email.toLocaleLowerCase("en-US");
      const prior = foldedByEmail.get(key);
      if (!prior) {
        const merged = { ...row };
        foldedByEmail.set(key, merged);
        ordered.push(merged);
        continue;
      }
      for (const field of ["email", "password", "pickupUrl", "twoFactorSecret"] as const) {
        const value = row[field];
        if (value) prior[field] = value;
      }
    }

    const existingAccounts = this.list();
    const planned = ordered.map((row) => {
      if (!row.email) return { row, match: undefined };
      const matches = existingAccounts.filter((account) => account.email?.toLocaleLowerCase("en-US") === row.email?.toLocaleLowerCase("en-US"));
      if (matches.length > 1) {
        throw new Error(`第 ${row.lineNumber} 行：邮箱 ${row.email} 在现有账号中匹配到多个记录`);
      }
      return { row, match: matches[0] };
    });

    let added = 0;
    let updated = 0;
    this.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO openai_accounts
          (id, name, proxy_mode, proxy_url, created_at, updated_at, email, password, pickup_url, two_factor_secret, auth_json)
        VALUES (?, ?, 'system', NULL, ?, ?, ?, ?, ?, ?, NULL)
      `);
      const update = this.db.prepare(`
        UPDATE openai_accounts SET email = ?, password = ?, pickup_url = ?, two_factor_secret = ?, updated_at = ? WHERE id = ?
      `);
      for (let index = 0; index < planned.length; index += 1) {
        const item = planned[index];
        if (!item) continue;
        const { row, match } = item;
        if (match) {
          update.run(
            row.email || match.email || null,
            row.password || match.password || null,
            row.pickupUrl || match.pickupUrl || null,
            row.twoFactorSecret || match.twoFactorSecret || null,
            nowIso(),
            match.id,
          );
          updated += 1;
        } else {
          const now = nowIso();
          insert.run(
            `oa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            `导入账号 ${index + 1}`,
            now,
            now,
            row.email ?? null,
            row.password ?? null,
            row.pickupUrl ?? null,
            row.twoFactorSecret ?? null,
          );
          added += 1;
        }
      }
    });
    return { added, updated };
  }

  close(): void {
    this.db.close();
  }
}

export const OPENAI_ACCOUNT_SETTINGS_KEYS = {
  activeAccountId: ACTIVE_KEY,
  pendingAccountId: PENDING_KEY,
  lastPublishedFingerprint: LAST_PUBLISHED_FINGERPRINT_KEY,
} as const;
