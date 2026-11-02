import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WorktreeSettings, WorktreeSettingsSnapshot } from "../shared/thread-worktree";

export async function createWorktreeSettingsStore(dbPath: string, defaultRootPath: string) {
  const sqlite = await import("node:sqlite");
  const store = new WorktreeSettingsStore(new sqlite.DatabaseSync(dbPath), defaultRootPath);
  store.initialize();
  return store;
}

export class WorktreeSettingsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly defaultRootPath: string,
  ) {}

  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS worktree_settings (
      key TEXT PRIMARY KEY, value_json TEXT NOT NULL
    )`);
  }

  get(): WorktreeSettingsSnapshot {
    const row = this.db.prepare("SELECT value_json FROM worktree_settings WHERE key = 'snapshot'").get() as
      | { value_json: string }
      | undefined;
    const settings: WorktreeSettings = row ? JSON.parse(row.value_json) : { rootPath: "" };
    if (typeof settings.rootPath !== "string" || (settings.rootPath && !path.isAbsolute(settings.rootPath)))
      throw new Error("工作树根目录设置无效，请重新保存。");
    return { ...settings, defaultRootPath: this.defaultRootPath };
  }

  resolvedRootPath(): string {
    const settings = this.get();
    return settings.rootPath || settings.defaultRootPath;
  }

  async save(value: unknown): Promise<WorktreeSettingsSnapshot> {
    if (!value || typeof value !== "object" || !("rootPath" in value) || typeof value.rootPath !== "string")
      throw new Error("无效的工作树设置。");
    const rootPath = value.rootPath.trim();
    if (rootPath && !path.isAbsolute(rootPath)) throw new Error("工作树根目录必须是绝对路径。");
    const normalized = rootPath ? path.resolve(rootPath) : "";
    // Verify the directory before saving. Errors remain visible; never switch roots silently.
    await fs.mkdir(normalized || this.defaultRootPath, { recursive: true });
    await fs.access(normalized || this.defaultRootPath, fs.constants.W_OK);
    this.db
      .prepare(`INSERT INTO worktree_settings (key, value_json) VALUES ('snapshot', ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`)
      .run(JSON.stringify({ rootPath: normalized }));
    return this.get();
  }
}
