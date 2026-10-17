import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { isWebSearchApprovalMode, type WebSearchApprovalMode } from "../shared/integrated-web-search";
import type {
  IntegratedWebSearchProvider,
  IntegratedWebSearchSettingsSaveInput,
  IntegratedWebSearchSettingsSnapshot,
} from "../shared/ipc";

const INTEGRATED_WEB_SEARCH_SETTINGS_KEY = "integrated_web_search";

export interface IntegratedWebSearchSecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export function defaultIntegratedWebSearchSettings(): IntegratedWebSearchSettingsSnapshot {
  return {
    enabled: false,
    provider: "tavily",
    hasApiKey: false,
    approvalMode: "always_allow",
  };
}

export async function createIntegratedWebSearchSettingsStore(
  dbPath: string,
  secretCodec: IntegratedWebSearchSecretCodec,
): Promise<IntegratedWebSearchSettingsStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new IntegratedWebSearchSettingsStore(new sqlite.DatabaseSync(dbPath), secretCodec);
  store.initialize();
  return store;
}

interface StoredIntegratedWebSearchSettings {
  enabled: boolean;
  provider: IntegratedWebSearchProvider;
  encryptedApiKey: string;
  approvalMode: WebSearchApprovalMode;
}

export class IntegratedWebSearchSettingsStore {
  constructor(
    private readonly db: DatabaseSyncType,
    private readonly secretCodec: IntegratedWebSearchSecretCodec,
  ) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(): IntegratedWebSearchSettingsSnapshot {
    const stored = this.readStored();
    return {
      enabled: stored.enabled,
      provider: stored.provider,
      hasApiKey: stored.encryptedApiKey.length > 0,
      approvalMode: stored.approvalMode,
    };
  }

  getApiKey(): string | undefined {
    const stored = this.readStored();
    if (!stored.encryptedApiKey) {
      return undefined;
    }
    if (!this.secretCodec.isAvailable()) {
      throw new Error("Integrated Web Search API key is stored but local secret storage is unavailable.");
    }
    let decrypted: string;
    try {
      decrypted = this.secretCodec.decrypt(stored.encryptedApiKey).trim();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Integrated Web Search API Key 解密失败，请在设置中重新输入并保存。原始错误：${reason}`,
      );
    }
    return decrypted || undefined;
  }

  save(input: IntegratedWebSearchSettingsSaveInput): IntegratedWebSearchSettingsSnapshot {
    const current = this.readStored();
    const enabled = input.enabled ?? current.enabled;
    const provider = input.provider ?? current.provider;
    const approvalMode = isWebSearchApprovalMode(input.approvalMode)
      ? input.approvalMode
      : current.approvalMode;
    let encryptedApiKey = current.encryptedApiKey;
    if (input.apiKey !== undefined) {
      const trimmed = input.apiKey.trim();
      if (!trimmed) {
        encryptedApiKey = "";
      } else {
        if (!this.secretCodec.isAvailable()) {
          throw new Error("本地密钥存储不可用，无法保存 Integrated Web Search API Key。");
        }
        encryptedApiKey = this.secretCodec.encrypt(trimmed);
      }
    }
    const next: StoredIntegratedWebSearchSettings = {
      enabled,
      provider: normalizeIntegratedWebSearchProvider(provider),
      encryptedApiKey,
      approvalMode,
    };
    this.writeStored(next);
    return this.get();
  }

  private readStored(): StoredIntegratedWebSearchSettings {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get(INTEGRATED_WEB_SEARCH_SETTINGS_KEY) as { value_json: string } | undefined;
    if (!row) {
      return { enabled: false, provider: "tavily", encryptedApiKey: "", approvalMode: "always_allow" };
    }
    try {
      return normalizeStoredIntegratedWebSearchSettings(JSON.parse(row.value_json));
    } catch {
      return { enabled: false, provider: "tavily", encryptedApiKey: "", approvalMode: "always_allow" };
    }
  }

  private writeStored(snapshot: StoredIntegratedWebSearchSettings): void {
    const normalized = normalizeStoredIntegratedWebSearchSettings(snapshot);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workflow_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(INTEGRATED_WEB_SEARCH_SETTINGS_KEY, JSON.stringify(normalized), now);
  }
}

export function normalizeIntegratedWebSearchProvider(value: unknown): IntegratedWebSearchProvider {
  if (value === "brave" || value === "tavily" || value === "doubao" || value === "deepseek") {
    return value;
  }
  return "tavily";
}

function normalizeStoredIntegratedWebSearchSettings(value: unknown): StoredIntegratedWebSearchSettings {
  if (!value || typeof value !== "object") {
    return { enabled: false, provider: "tavily", encryptedApiKey: "", approvalMode: "always_allow" };
  }
  const record = value as Record<string, unknown>;
  const enabled = record.enabled === true;
  const provider = normalizeIntegratedWebSearchProvider(record.provider);
  const encryptedApiKey = typeof record.encryptedApiKey === "string" ? record.encryptedApiKey : "";
  const approvalMode = isWebSearchApprovalMode(record.approvalMode) ? record.approvalMode : "always_allow";
  return { enabled, provider, encryptedApiKey, approvalMode };
}

export function isIntegratedWebSearchSettingsSaveInput(
  value: unknown,
): value is IntegratedWebSearchSettingsSaveInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    return false;
  }
  if (
    record.provider !== undefined &&
    record.provider !== "brave" &&
    record.provider !== "tavily" &&
    record.provider !== "doubao" &&
    record.provider !== "deepseek"
  ) {
    return false;
  }
  if (record.approvalMode !== undefined && !isWebSearchApprovalMode(record.approvalMode)) {
    return false;
  }
  if (record.apiKey !== undefined && typeof record.apiKey !== "string") {
    return false;
  }
  return true;
}

export function isIntegratedWebSearchSettingsSnapshot(
  value: unknown,
): value is IntegratedWebSearchSettingsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    return false;
  }
  if (
    record.provider !== "brave" &&
    record.provider !== "tavily" &&
    record.provider !== "doubao" &&
    record.provider !== "deepseek"
  ) {
    return false;
  }
  if (typeof record.hasApiKey !== "boolean") {
    return false;
  }
  if (!isWebSearchApprovalMode(record.approvalMode)) {
    return false;
  }
  return true;
}
