import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const COMMIT_MESSAGE_INSTRUCTIONS_MAX_CHARS = 2_000;

export interface GitSettingsSnapshot {
  commitMessageInstructions?: string;
  /** 窗口聚焦且仓库空闲时周期性 git fetch，对齐 VS Code git.autofetch */
  autofetch?: boolean;
  /** 自动 fetch 间隔（秒），默认 180 */
  autofetchPeriod?: number;
}

export function defaultGitSettings(): GitSettingsSnapshot {
  return {
    autofetch: true,
    autofetchPeriod: 180,
  };
}

export async function createGitSettingsStore(dbPath: string): Promise<GitSettingsStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new GitSettingsStore(new sqlite.DatabaseSync(dbPath));
  store.initialize();
  return store;
}

export class GitSettingsStore {
  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS git_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(): GitSettingsSnapshot {
    const row = this.db.prepare(`SELECT value_json FROM git_settings WHERE key = ?`).get("snapshot") as
      | { value_json: string }
      | undefined;
    if (!row) {
      return defaultGitSettings();
    }
    try {
      return normalizeGitSettingsSnapshot(JSON.parse(row.value_json));
    } catch {
      return defaultGitSettings();
    }
  }

  save(snapshot: GitSettingsSnapshot): GitSettingsSnapshot {
    const normalized = normalizeGitSettingsSnapshot(snapshot);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO git_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run("snapshot", JSON.stringify(normalized), now);
    return this.get();
  }

}

export function normalizeGitSettingsSnapshot(value: unknown): GitSettingsSnapshot {
  if (!value || typeof value !== "object") {
    return defaultGitSettings();
  }
  const record = value as Record<string, unknown>;
  const instructions = normalizeCommitMessageInstructions(record.commitMessageInstructions);
  const autofetch = normalizeAutofetch(record.autofetch);
  const autofetchPeriod = normalizeAutofetchPeriod(record.autofetchPeriod);
  return {
    ...(instructions && { commitMessageInstructions: instructions }),
    autofetch,
    autofetchPeriod,
  };
}

function normalizeAutofetch(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return true;
}

function normalizeAutofetchPeriod(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 30) {
    return Math.floor(value);
  }
  return 180;
}

function normalizeCommitMessageInstructions(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > COMMIT_MESSAGE_INSTRUCTIONS_MAX_CHARS) {
    return trimmed.slice(0, COMMIT_MESSAGE_INSTRUCTIONS_MAX_CHARS);
  }
  return trimmed;
}

export function isGitSettingsSnapshot(value: unknown): value is GitSettingsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if ("commitMessageRoleByMainAgentConfigId" in record ||
    "commitMessageCandidateModelIdByMainAgentConfigId" in record) return false;
  return record.commitMessageInstructions === undefined ||
    typeof record.commitMessageInstructions === "string";
}
