import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  defaultTtsEndpoint,
  defaultTtsModel,
  type GeneratedAudioFile,
  isTtsProvider,
  type TtsArtifact,
  type TtsArtifactStatus,
  type TtsProfileSaveInput,
  type TtsProfileSnapshot,
  type TtsProvider,
  type TtsSettingsSnapshot,
  type TtsToolInput,
} from "../shared/tts";

export const DEFAULT_TTS_PROFILE_ID = "00000000-0000-4000-8000-000000000003";

export interface TtsSecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface ProfileRow {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  encrypted_api_key: string;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  id: string;
  thread_id: string;
  tool_use_id: string | null;
  status: string;
  text: string;
  parameters_json: string;
  provider: string;
  profile_name: string;
  model: string;
  workspace_path: string;
  generation_root: string;
  audio_json: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface TtsClientConfig {
  profileId: string;
  profileName: string;
  provider: TtsProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface TtsProfileSecret {
  profileId: string;
  apiKey: string;
}

export async function createTtsStore(dbPath: string, secretCodec?: TtsSecretCodec): Promise<TtsStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new TtsStore(new sqlite.DatabaseSync(dbPath), secretCodec);
  store.initialize();
  return store;
}

export class TtsStore {
  constructor(
    private readonly db: DatabaseSyncType,
    private readonly secretCodec?: TtsSecretCodec,
  ) {}

  initialize(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tts_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        provider TEXT NOT NULL CHECK(provider IN ('gemini', 'openai_compatible', 'doubao')),
        baseUrl TEXT NOT NULL,
        model TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tts_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        active_profile_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(active_profile_id) REFERENCES tts_profiles(id)
      );
      CREATE TABLE IF NOT EXISTS tts_artifacts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        tool_use_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        text TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        model TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        generation_root TEXT NOT NULL,
        audio_json TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tts_artifacts_thread_idx
        ON tts_artifacts(thread_id, created_at DESC);
    `);
    this.db
      .prepare(
        "UPDATE tts_artifacts SET status = 'failed', error_code = 'interrupted', error_message = ?, updated_at = ? WHERE status = 'running'",
      )
      .run("应用退出时语音生成尚未完成，请重新生成。", new Date().toISOString());
    this.ensureDoubaoProvider();
    const count = Number(
      (
        this.db.prepare("SELECT COUNT(*) AS count FROM tts_profiles").get() as
          | { count: number | bigint }
          | undefined
      )?.count ?? 0,
    );
    if (count === 0) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO tts_profiles
           (id, name, provider, baseUrl, model, encrypted_api_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
        )
        .run(
          DEFAULT_TTS_PROFILE_ID,
          "Gemini 3.8 Flash TTS",
          "gemini",
          defaultTtsEndpoint("gemini"),
          defaultTtsModel("gemini"),
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT OR REPLACE INTO tts_settings
           (singleton, enabled, active_profile_id, updated_at) VALUES (1, 0, ?, ?)`,
        )
        .run(DEFAULT_TTS_PROFILE_ID, now);
    }
    const settings = this.readSettingsRow();
    if (!settings) {
      const first = this.db.prepare("SELECT id FROM tts_profiles ORDER BY created_at, id LIMIT 1").get() as
        | { id: string }
        | undefined;
      if (!first) throw new Error("语音生成配置初始化失败：没有可用 Profile。");
      this.db
        .prepare(
          `INSERT INTO tts_settings
           (singleton, enabled, active_profile_id, updated_at) VALUES (1, 0, ?, ?)`,
        )
        .run(first.id, new Date().toISOString());
    }
  }

  /** SQLite cannot alter CHECK constraints: rebuild tts_profiles to accept the doubao provider. */
  private ensureDoubaoProvider(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tts_profiles'")
      .get() as { sql: string } | undefined;
    if (!row?.sql || row.sql.includes("'doubao'") || !row.sql.includes("'openai_compatible'")) return;
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        row.sql
          .replace(
            /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?tts_profiles["`]?/i,
            "CREATE TABLE tts_profiles_next",
          )
          .replace(/'openai_compatible'(?:,\s*'doubao')?/, "'openai_compatible', 'doubao'"),
      );
      this.db.exec(`INSERT INTO tts_profiles_next SELECT * FROM tts_profiles;
        DROP TABLE tts_profiles;
        ALTER TABLE tts_profiles_next RENAME TO tts_profiles;`);
      if (this.db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("语音生成配置迁移外键校验失败。");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  getSettings(): TtsSettingsSnapshot {
    const settings = this.requireSettingsRow();
    const profiles = this.db
      .prepare(
        `SELECT id, name, provider, baseUrl, model, encrypted_api_key, created_at, updated_at
         FROM tts_profiles ORDER BY name COLLATE NOCASE, created_at, id`,
      )
      .all() as unknown as ProfileRow[];
    return {
      enabled: settings.enabled === 1,
      activeProfileId: settings.active_profile_id,
      profiles: profiles.map((row) => this.toProfileSnapshot(row)),
      apiKeyEncryptionAvailable: this.secretCodec?.isAvailable() ?? false,
    };
  }

  setEnabled(
    enabled: boolean,
    options?: { /** Cloud sync may flip enabled before secrets are applied. */ skipApiKeyCheck?: boolean },
  ): TtsSettingsSnapshot {
    if (enabled && !options?.skipApiKeyCheck) this.getActiveClientConfig();
    this.db
      .prepare("UPDATE tts_settings SET enabled = ?, updated_at = ? WHERE singleton = 1")
      .run(enabled ? 1 : 0, new Date().toISOString());
    return this.getSettings();
  }

  saveProfile(input: TtsProfileSaveInput): TtsProfileSnapshot {
    const id = input.id ? normalizeUuid(input.id) : randomUUID();
    const name = normalizeName(input.name);
    const provider = normalizeProvider(input.provider);
    const baseUrl = normalizeEndpoint(input.baseUrl);
    const model = normalizeModel(input.model);
    const existing = this.readProfileOptional(id);
    const duplicate = this.db
      .prepare("SELECT id FROM tts_profiles WHERE name = ? COLLATE NOCASE AND id <> ?")
      .get(name, id) as { id: string } | undefined;
    if (duplicate) throw new Error(`语音生成 Profile 名称已存在：${name}`);
    let encryptedApiKey = existing?.encrypted_api_key ?? "";
    const apiKey = input.apiKey?.trim();
    if (apiKey) {
      if (!this.secretCodec?.isAvailable()) {
        throw new Error("系统加密不可用，无法保存语音生成 API Key。");
      }
      encryptedApiKey = this.secretCodec.encrypt(apiKey);
    }
    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE tts_profiles SET name = ?, provider = ?, baseUrl = ?, model = ?,
           encrypted_api_key = ?, updated_at = ? WHERE id = ?`,
        )
        .run(name, provider, baseUrl, model, encryptedApiKey, now, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO tts_profiles
           (id, name, provider, baseUrl, model, encrypted_api_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, provider, baseUrl, model, encryptedApiKey, now, now);
    }
    return this.toProfileSnapshot(this.readProfile(id));
  }

  activateProfile(
    id: string,
    options?: {
      /** Cloud sync may activate a profile before its API key is pulled. */ skipApiKeyCheck?: boolean;
    },
  ): TtsSettingsSnapshot {
    const profile = this.readProfile(normalizeUuid(id));
    if (!options?.skipApiKeyCheck) {
      this.requireClientConfig(profile);
    }
    this.db
      .prepare("UPDATE tts_settings SET active_profile_id = ?, updated_at = ? WHERE singleton = 1")
      .run(profile.id, new Date().toISOString());
    return this.getSettings();
  }

  deleteProfile(id: string): TtsSettingsSnapshot {
    const normalized = normalizeUuid(id);
    const settings = this.requireSettingsRow();
    if (settings.active_profile_id === normalized) throw new Error("不能删除当前激活的语音生成 Profile。");
    const count = Number(
      (
        this.db.prepare("SELECT COUNT(*) AS count FROM tts_profiles").get() as {
          count: number | bigint;
        }
      ).count,
    );
    if (count <= 1) throw new Error("至少必须保留一个语音生成 Profile。");
    this.db.prepare("DELETE FROM tts_profiles WHERE id = ?").run(normalized);
    return this.getSettings();
  }

  getActiveClientConfig(): TtsClientConfig {
    const settings = this.requireSettingsRow();
    return this.requireClientConfig(this.readProfile(settings.active_profile_id));
  }

  /** Decrypt every configured profile key for account snapshot sync. */
  listProfileSecrets(): TtsProfileSecret[] {
    const rows = this.db
      .prepare(
        `SELECT id, encrypted_api_key FROM tts_profiles
         WHERE encrypted_api_key <> '' ORDER BY id`,
      )
      .all() as unknown as Array<Pick<ProfileRow, "id" | "encrypted_api_key">>;
    return rows.map((row) => ({
      profileId: row.id,
      apiKey: this.decryptStoredApiKey(row.encrypted_api_key),
    }));
  }

  clearProfileApiKey(profileId: string): void {
    const id = normalizeUuid(profileId);
    const result = this.db
      .prepare("UPDATE tts_profiles SET encrypted_api_key = '', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (result.changes === 0) {
      throw new Error(`语音生成 Profile 不存在：${id}`);
    }
  }

  createArtifact(input: {
    threadId: string;
    toolUseId?: string;
    text: string;
    parameters: Omit<TtsToolInput, "text">;
    config: TtsClientConfig;
    workspacePath: string;
    generationRoot: string;
  }): TtsArtifact {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tts_artifacts
         (id, thread_id, tool_use_id, status, text, parameters_json, provider, profile_name,
          model, workspace_path, generation_root, audio_json, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.toolUseId ?? null,
        input.text,
        JSON.stringify(input.parameters),
        input.config.provider,
        input.config.profileName,
        input.config.model,
        input.workspacePath,
        input.generationRoot,
        now,
        now,
      );
    return this.getArtifact(id);
  }

  completeArtifact(id: string, audio: GeneratedAudioFile[]): TtsArtifact {
    this.updateArtifact(id, "completed", audio);
    return this.getArtifact(id);
  }

  failArtifact(
    id: string,
    code: string,
    message: string,
    partialAudio: GeneratedAudioFile[] = [],
  ): TtsArtifact {
    this.updateArtifact(id, "failed", partialAudio, code, message);
    return this.getArtifact(id);
  }

  getArtifact(id: string): TtsArtifact {
    const row = this.db.prepare("SELECT * FROM tts_artifacts WHERE id = ?").get(id) as unknown as
      | ArtifactRow
      | undefined;
    if (!row) throw new Error(`语音生成产物不存在：${id}`);
    return toArtifact(row);
  }

  listArtifacts(threadId: string): TtsArtifact[] {
    const id = threadId.trim();
    if (!id) throw new Error("threadId 不能为空。");
    const rows = this.db
      .prepare("SELECT * FROM tts_artifacts WHERE thread_id = ? ORDER BY created_at DESC, id DESC")
      .all(id) as unknown as ArtifactRow[];
    return rows.map(toArtifact);
  }

  private updateArtifact(
    id: string,
    status: TtsArtifactStatus,
    audio: GeneratedAudioFile[],
    errorCode?: string,
    errorMessage?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE tts_artifacts SET status = ?, audio_json = ?, error_code = ?,
         error_message = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        status,
        JSON.stringify(audio),
        errorCode ?? null,
        errorMessage ?? null,
        new Date().toISOString(),
        id,
      );
  }

  private requireClientConfig(row: ProfileRow): TtsClientConfig {
    if (!row.encrypted_api_key) throw new Error(`语音生成 Profile “${row.name}” 尚未配置 API Key。`);
    const apiKey = this.decryptStoredApiKey(row.encrypted_api_key);
    return {
      profileId: row.id,
      profileName: row.name,
      provider: normalizeProvider(row.provider),
      baseUrl: row.baseUrl,
      model: row.model,
      apiKey,
    };
  }

  private decryptStoredApiKey(stored: string): string {
    if (!this.secretCodec?.isAvailable()) {
      throw new Error("系统加密不可用，无法读取语音生成 API Key。");
    }
    try {
      return this.secretCodec.decrypt(stored);
    } catch (error) {
      throw new Error(`语音生成 API Key 解密失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private readSettingsRow(): { enabled: number; active_profile_id: string } | undefined {
    return this.db.prepare("SELECT enabled, active_profile_id FROM tts_settings WHERE singleton = 1").get() as
      | { enabled: number; active_profile_id: string }
      | undefined;
  }

  private requireSettingsRow(): { enabled: number; active_profile_id: string } {
    const row = this.readSettingsRow();
    if (!row) throw new Error("语音生成全局设置缺失。");
    return row;
  }

  private readProfileOptional(id: string): ProfileRow | undefined {
    return this.db
      .prepare(
        `SELECT id, name, provider, baseUrl, model, encrypted_api_key, created_at, updated_at
         FROM tts_profiles WHERE id = ?`,
      )
      .get(id) as unknown as ProfileRow | undefined;
  }

  private readProfile(id: string): ProfileRow {
    const row = this.readProfileOptional(id);
    if (!row) throw new Error(`语音生成 Profile 不存在：${id}`);
    return row;
  }

  private toProfileSnapshot(row: ProfileRow): TtsProfileSnapshot {
    return {
      id: row.id,
      name: row.name,
      provider: normalizeProvider(row.provider),
      baseUrl: row.baseUrl,
      model: row.model,
      hasApiKey: Boolean(row.encrypted_api_key),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function normalizeUuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error("语音生成 Profile ID 无效。");
  }
  return value.toLowerCase();
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("语音生成 Profile 名称不能为空。");
  const name = value.trim();
  if (name.length > 80) throw new Error("语音生成 Profile 名称不能超过 80 个字符。");
  return name;
}

function normalizeProvider(value: unknown): TtsProvider {
  if (!isTtsProvider(value)) throw new Error("语音生成供应商渠道无效。");
  return value;
}

function normalizeEndpoint(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const baseUrl = raw;
  if (!baseUrl) throw new Error("语音生成 Base URL 不能为空。");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("语音生成 Base URL 无效。");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("语音生成 Base URL 必须使用 HTTP 或 HTTPS。");
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error("语音生成 Base URL 不能包含查询参数、片段或账号密码。");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeModel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("语音生成模型不能为空。");
  const model = value.trim();
  if (model.length > 256) throw new Error("语音生成模型不能超过 256 个字符。");
  return model;
}

function toArtifact(row: ArtifactRow): TtsArtifact {
  const provider = normalizeProvider(row.provider);
  const status: TtsArtifactStatus =
    row.status === "completed" || row.status === "failed" || row.status === "running"
      ? row.status
      : (() => {
          throw new Error("语音产物状态无效。");
        })();
  return {
    id: row.id,
    threadId: row.thread_id,
    ...(row.tool_use_id ? { toolUseId: row.tool_use_id } : {}),
    status,
    text: row.text,
    parameters: JSON.parse(row.parameters_json),
    provider,
    profileName: row.profile_name,
    model: row.model,
    workspacePath: row.workspace_path,
    generationRoot: row.generation_root,
    audio: JSON.parse(row.audio_json),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
