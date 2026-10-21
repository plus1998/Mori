import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  defaultImageGenerationEndpoint,
  defaultImageGenerationModel,
  defaultSupportsImageToImage,
  type GeneratedImageFile,
  type ImageGenerationArtifact,
  type ImageGenerationArtifactStatus,
  type ImageGenerationProfileSaveInput,
  type ImageGenerationProfileSnapshot,
  type ImageGenerationProvider,
  type ImageGenerationSettingsSnapshot,
  type ImageGenerationToolInput,
  isImageGenerationProvider,
} from "../shared/image-generation";

export const DEFAULT_IMAGE_PROFILE_ID = "00000000-0000-4000-8000-000000000002";

export interface ImageGenerationSecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface ProfileRow {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  model: string;
  supports_image_to_image: number;
  encrypted_api_key: string;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  id: string;
  thread_id: string;
  tool_use_id: string | null;
  status: string;
  prompt: string;
  parameters_json: string;
  provider: string;
  profile_name: string;
  model: string;
  workspace_path: string;
  generation_root: string;
  images_json: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImageGenerationClientConfig {
  profileId: string;
  profileName: string;
  provider: ImageGenerationProvider;
  endpoint: string;
  model: string;
  supportsImageToImage: boolean;
  apiKey: string;
}

export interface ImageGenerationProfileSecret {
  profileId: string;
  apiKey: string;
}

export async function createImageGenerationStore(
  dbPath: string,
  secretCodec?: ImageGenerationSecretCodec,
): Promise<ImageGenerationStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new ImageGenerationStore(new sqlite.DatabaseSync(dbPath), secretCodec);
  store.initialize();
  return store;
}

export class ImageGenerationStore {
  constructor(
    private readonly db: DatabaseSyncType,
    private readonly secretCodec?: ImageGenerationSecretCodec,
  ) {}

  initialize(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS image_generation_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        provider TEXT NOT NULL CHECK(provider IN ('openai', 'gemini', 'openai_compatible', 'codex', 'chatgpt_web')),
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        supports_image_to_image INTEGER NOT NULL DEFAULT 0 CHECK(supports_image_to_image IN (0, 1)),
        encrypted_api_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS image_generation_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        active_profile_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(active_profile_id) REFERENCES image_generation_profiles(id)
      );
      CREATE TABLE IF NOT EXISTS image_generation_artifacts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        tool_use_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        prompt TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        model TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        generation_root TEXT NOT NULL,
        images_json TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS image_generation_artifacts_thread_idx
        ON image_generation_artifacts(thread_id, created_at DESC);
    `);
    this.ensureProfileColumns();
    this.ensureCodexProvider();
    const count = Number(
      (
        this.db.prepare("SELECT COUNT(*) AS count FROM image_generation_profiles").get() as
          | { count: number | bigint }
          | undefined
      )?.count ?? 0,
    );
    if (count === 0) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO image_generation_profiles
           (id, name, provider, endpoint, model, supports_image_to_image, encrypted_api_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`,
        )
        .run(
          DEFAULT_IMAGE_PROFILE_ID,
          "Default OpenAI",
          "openai",
          defaultImageGenerationEndpoint("openai"),
          defaultImageGenerationModel("openai"),
          defaultSupportsImageToImage("openai") ? 1 : 0,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT OR REPLACE INTO image_generation_settings
           (singleton, enabled, active_profile_id, updated_at) VALUES (1, 0, ?, ?)`,
        )
        .run(DEFAULT_IMAGE_PROFILE_ID, now);
    }
    const defaultProfile = this.readProfileOptional(DEFAULT_IMAGE_PROFILE_ID);
    if (defaultProfile?.provider === "openai" && defaultProfile.model === "gpt-image-1") {
      this.db
        .prepare("UPDATE image_generation_profiles SET model = ?, updated_at = ? WHERE id = ?")
        .run(defaultImageGenerationModel("openai"), new Date().toISOString(), DEFAULT_IMAGE_PROFILE_ID);
    }
    const settings = this.readSettingsRow();
    if (!settings) {
      const first = this.db
        .prepare("SELECT id FROM image_generation_profiles ORDER BY created_at, id LIMIT 1")
        .get() as { id: string } | undefined;
      if (!first) throw new Error("创意绘画配置初始化失败：没有可用 Profile。");
      this.db
        .prepare(
          `INSERT INTO image_generation_settings
           (singleton, enabled, active_profile_id, updated_at) VALUES (1, 0, ?, ?)`,
        )
        .run(first.id, new Date().toISOString());
    }
  }

  getSettings(): ImageGenerationSettingsSnapshot {
    const settings = this.requireSettingsRow();
    const profiles = this.db
      .prepare(
        `SELECT id, name, provider, endpoint, model, supports_image_to_image, encrypted_api_key, created_at, updated_at
         FROM image_generation_profiles ORDER BY name COLLATE NOCASE, created_at, id`,
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
  ): ImageGenerationSettingsSnapshot {
    if (enabled && !options?.skipApiKeyCheck) this.getActiveClientConfig();
    this.db
      .prepare("UPDATE image_generation_settings SET enabled = ?, updated_at = ? WHERE singleton = 1")
      .run(enabled ? 1 : 0, new Date().toISOString());
    return this.getSettings();
  }

  saveProfile(input: ImageGenerationProfileSaveInput): ImageGenerationProfileSnapshot {
    const id = input.id ? normalizeUuid(input.id) : randomUUID();
    const name = normalizeName(input.name);
    const provider = normalizeProvider(input.provider);
    const endpoint = normalizeEndpoint(input.endpoint, provider);
    const model = normalizeModel(input.model);
    if ((provider === "codex" || provider === "chatgpt_web") && model !== "gpt-image-2")
      throw new Error("Codex 登录生图目前只支持 gpt-image-2。");
    const existing = this.readProfileOptional(id);
    const supportsImageToImage =
      typeof input.supportsImageToImage === "boolean"
        ? input.supportsImageToImage
        : existing
          ? existing.supports_image_to_image === 1
          : defaultSupportsImageToImage(provider);
    const duplicate = this.db
      .prepare("SELECT id FROM image_generation_profiles WHERE name = ? COLLATE NOCASE AND id <> ?")
      .get(name, id) as { id: string } | undefined;
    if (duplicate) throw new Error(`创意绘画 Profile 名称已存在：${name}`);
    let encryptedApiKey = existing?.encrypted_api_key ?? "";
    const apiKey = input.apiKey?.trim();
    if (provider === "codex" || provider === "chatgpt_web") encryptedApiKey = "";
    else if (apiKey) {
      if (!this.secretCodec?.isAvailable()) {
        throw new Error("系统加密不可用，无法保存创意绘画 API Key。");
      }
      encryptedApiKey = this.secretCodec.encrypt(apiKey);
    }
    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE image_generation_profiles SET name = ?, provider = ?, endpoint = ?, model = ?,
           supports_image_to_image = ?, encrypted_api_key = ?, updated_at = ? WHERE id = ?`,
        )
        .run(name, provider, endpoint, model, supportsImageToImage ? 1 : 0, encryptedApiKey, now, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO image_generation_profiles
           (id, name, provider, endpoint, model, supports_image_to_image, encrypted_api_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, provider, endpoint, model, supportsImageToImage ? 1 : 0, encryptedApiKey, now, now);
    }
    return this.toProfileSnapshot(this.readProfile(id));
  }

  activateProfile(
    id: string,
    options?: {
      /** Cloud sync may activate a profile before its API key is pulled. */ skipApiKeyCheck?: boolean;
    },
  ): ImageGenerationSettingsSnapshot {
    const profile = this.readProfile(normalizeUuid(id));
    if (!options?.skipApiKeyCheck) {
      this.requireClientConfig(profile);
    }
    this.db
      .prepare(
        "UPDATE image_generation_settings SET active_profile_id = ?, updated_at = ? WHERE singleton = 1",
      )
      .run(profile.id, new Date().toISOString());
    return this.getSettings();
  }

  deleteProfile(id: string): ImageGenerationSettingsSnapshot {
    const normalized = normalizeUuid(id);
    const settings = this.requireSettingsRow();
    if (settings.active_profile_id === normalized) throw new Error("不能删除当前激活的创意绘画 Profile。");
    const count = Number(
      (
        this.db.prepare("SELECT COUNT(*) AS count FROM image_generation_profiles").get() as {
          count: number | bigint;
        }
      ).count,
    );
    if (count <= 1) throw new Error("至少必须保留一个创意绘画 Profile。");
    this.db.prepare("DELETE FROM image_generation_profiles WHERE id = ?").run(normalized);
    return this.getSettings();
  }

  getActiveClientConfig(): ImageGenerationClientConfig {
    const settings = this.requireSettingsRow();
    return this.requireClientConfig(this.readProfile(settings.active_profile_id));
  }

  /** Decrypt every configured profile key for account snapshot sync. */
  listProfileSecrets(): ImageGenerationProfileSecret[] {
    const rows = this.db
      .prepare(
        `SELECT id, encrypted_api_key FROM image_generation_profiles
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
      .prepare("UPDATE image_generation_profiles SET encrypted_api_key = '', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (result.changes === 0) {
      throw new Error(`创意绘画 Profile 不存在：${id}`);
    }
  }

  createArtifact(input: {
    threadId: string;
    toolUseId?: string;
    prompt: string;
    parameters: Omit<ImageGenerationToolInput, "prompt">;
    config: ImageGenerationClientConfig;
    workspacePath: string;
    generationRoot: string;
  }): ImageGenerationArtifact {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO image_generation_artifacts
         (id, thread_id, tool_use_id, status, prompt, parameters_json, provider, profile_name,
          model, workspace_path, generation_root, images_json, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.toolUseId ?? null,
        input.prompt,
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

  completeArtifact(id: string, images: GeneratedImageFile[]): ImageGenerationArtifact {
    this.updateArtifact(id, "completed", images);
    return this.getArtifact(id);
  }

  failArtifact(
    id: string,
    code: string,
    message: string,
    partialImages: GeneratedImageFile[] = [],
  ): ImageGenerationArtifact {
    this.updateArtifact(id, "failed", partialImages, code, message);
    return this.getArtifact(id);
  }

  getArtifact(id: string): ImageGenerationArtifact {
    const row = this.db.prepare("SELECT * FROM image_generation_artifacts WHERE id = ?").get(id) as unknown as
      | ArtifactRow
      | undefined;
    if (!row) throw new Error(`创意绘画产物不存在：${id}`);
    return toArtifact(row);
  }

  listArtifacts(threadId: string): ImageGenerationArtifact[] {
    const id = threadId.trim();
    if (!id) throw new Error("threadId 不能为空。");
    const rows = this.db
      .prepare(
        "SELECT * FROM image_generation_artifacts WHERE thread_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(id) as unknown as ArtifactRow[];
    return rows.map(toArtifact);
  }

  private updateArtifact(
    id: string,
    status: ImageGenerationArtifactStatus,
    images: GeneratedImageFile[],
    errorCode?: string,
    errorMessage?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE image_generation_artifacts SET status = ?, images_json = ?, error_code = ?,
         error_message = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        status,
        JSON.stringify(images),
        errorCode ?? null,
        errorMessage ?? null,
        new Date().toISOString(),
        id,
      );
  }

  private ensureProfileColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(image_generation_profiles)").all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("supports_image_to_image")) {
      this.db.exec(
        `ALTER TABLE image_generation_profiles
         ADD COLUMN supports_image_to_image INTEGER NOT NULL DEFAULT 0
         CHECK(supports_image_to_image IN (0, 1))`,
      );
    }
  }

  private requireClientConfig(row: ProfileRow): ImageGenerationClientConfig {
    if (row.provider !== "codex" && row.provider !== "chatgpt_web" && !row.encrypted_api_key)
      throw new Error(`创意绘画 Profile “${row.name}” 尚未配置 API Key。`);
    const apiKey =
      row.provider === "codex" || row.provider === "chatgpt_web"
        ? ""
        : this.decryptStoredApiKey(row.encrypted_api_key);
    return {
      profileId: row.id,
      profileName: row.name,
      provider: normalizeProvider(row.provider),
      endpoint: row.endpoint,
      model: row.model,
      supportsImageToImage: row.supports_image_to_image === 1,
      apiKey,
    };
  }

  private decryptStoredApiKey(stored: string): string {
    if (!this.secretCodec?.isAvailable()) {
      throw new Error("系统加密不可用，无法读取创意绘画 API Key。");
    }
    try {
      return this.secretCodec.decrypt(stored);
    } catch (error) {
      throw new Error(`创意绘画 API Key 解密失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private ensureCodexProvider(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'image_generation_profiles'")
      .get() as { sql: string };
    if (row.sql.includes("'chatgpt_web'") || !row.sql.includes("'openai_compatible'")) return;
    // SQLite cannot alter CHECK constraints. Rebuild atomically, keeping the active profile FK.
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        row.sql
          .replace(
            /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?image_generation_profiles["`]?/i,
            "CREATE TABLE image_generation_profiles_next",
          )
          .replace(/'openai_compatible'(?:,\s*'codex')?/, "'openai_compatible', 'codex', 'chatgpt_web'"),
      );
      this.db.exec(`INSERT INTO image_generation_profiles_next SELECT * FROM image_generation_profiles;
        DROP TABLE image_generation_profiles;
        ALTER TABLE image_generation_profiles_next RENAME TO image_generation_profiles;`);
      if (this.db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("创意绘画配置迁移外键校验失败。");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  private readSettingsRow(): { enabled: number; active_profile_id: string } | undefined {
    return this.db
      .prepare("SELECT enabled, active_profile_id FROM image_generation_settings WHERE singleton = 1")
      .get() as { enabled: number; active_profile_id: string } | undefined;
  }

  private requireSettingsRow(): { enabled: number; active_profile_id: string } {
    const row = this.readSettingsRow();
    if (!row) throw new Error("创意绘画全局设置缺失。");
    return row;
  }

  private readProfileOptional(id: string): ProfileRow | undefined {
    return this.db
      .prepare(
        `SELECT id, name, provider, endpoint, model, supports_image_to_image, encrypted_api_key, created_at, updated_at
         FROM image_generation_profiles WHERE id = ?`,
      )
      .get(id) as unknown as ProfileRow | undefined;
  }

  private readProfile(id: string): ProfileRow {
    const row = this.readProfileOptional(id);
    if (!row) throw new Error(`创意绘画 Profile 不存在：${id}`);
    return row;
  }

  private toProfileSnapshot(row: ProfileRow): ImageGenerationProfileSnapshot {
    return {
      id: row.id,
      name: row.name,
      provider: normalizeProvider(row.provider),
      endpoint: row.endpoint,
      model: row.model,
      supportsImageToImage: row.supports_image_to_image === 1,
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
    throw new Error("创意绘画 Profile ID 无效。");
  }
  return value.toLowerCase();
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("创意绘画 Profile 名称不能为空。");
  const name = value.trim();
  if (name.length > 80) throw new Error("创意绘画 Profile 名称不能超过 80 个字符。");
  return name;
}

function normalizeProvider(value: unknown): ImageGenerationProvider {
  if (!isImageGenerationProvider(value)) throw new Error("创意绘画供应商渠道无效。");
  return value;
}

function normalizeEndpoint(value: unknown, provider: ImageGenerationProvider): string {
  if (provider === "codex" || provider === "chatgpt_web") {
    const fixed = defaultImageGenerationEndpoint(provider);
    if (value && value !== fixed)
      throw new Error("Codex 登录生图使用固定地址，不能向自定义地址发送登录凭证。");
    return fixed;
  }
  const raw = typeof value === "string" ? value.trim() : "";
  const endpoint = raw || defaultImageGenerationEndpoint(provider);
  if (!endpoint) throw new Error("创意绘画 Base URL 不能为空。");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("创意绘画 Base URL 无效。");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("创意绘画 Base URL 必须使用 HTTP 或 HTTPS。");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeModel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("创意绘画模型不能为空。");
  const model = value.trim();
  if (model.length > 256) throw new Error("创意绘画模型不能超过 256 个字符。");
  return model;
}

function parseJsonObject<T extends object>(raw: string, fallback: T): T {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function toArtifact(row: ArtifactRow): ImageGenerationArtifact {
  const provider = normalizeProvider(row.provider);
  const status: ImageGenerationArtifactStatus =
    row.status === "completed" || row.status === "failed" ? row.status : "running";
  return {
    id: row.id,
    threadId: row.thread_id,
    ...(row.tool_use_id ? { toolUseId: row.tool_use_id } : {}),
    status,
    prompt: row.prompt,
    parameters: parseJsonObject(row.parameters_json, {}),
    provider,
    profileName: row.profile_name,
    model: row.model,
    workspacePath: row.workspace_path,
    generationRoot: row.generation_root,
    images: parseJsonArray<GeneratedImageFile>(row.images_json),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
