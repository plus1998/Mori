import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { ECO_AGENT_BROWSER_MCP_SERVER } from "../shared/browser";
import { normalizeMcpServersEnabled } from "../shared/composer-mcp";
import {
  normalizeIntegrationsEnabled,
  type ProjectIntegrationsSettingsSnapshot,
} from "../shared/integrations";

export async function createProjectIntegrationsSettingsStore(
  dbPath: string,
): Promise<ProjectIntegrationsSettingsStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new ProjectIntegrationsSettingsStore(new sqlite.DatabaseSync(dbPath));
  store.initialize();
  return store;
}

export class ProjectIntegrationsSettingsStore {
  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_integrations_settings (
        workspace_path TEXT PRIMARY KEY,
        enabled_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(workspacePath: string): ProjectIntegrationsSettingsSnapshot {
    const normalizedPath = path.resolve(workspacePath);
    const row = this.db
      .prepare("SELECT enabled_json FROM project_integrations_settings WHERE workspace_path = ?")
      .get(normalizedPath) as { enabled_json: string } | undefined;
    if (row) {
      return { workspacePath: normalizedPath, enabled: parseEnabled(row.enabled_json) };
    }

    const legacy = this.db
      .prepare("SELECT enabled_json FROM project_mcp_settings WHERE workspace_path = ?")
      .get(normalizedPath) as { enabled_json: string } | undefined;
    if (!legacy) return { workspacePath: normalizedPath, enabled: {} };
    let browser = false;
    try {
      const parsed = JSON.parse(legacy.enabled_json) as unknown;
      browser = normalizeMcpServersEnabled(parsed)?.[ECO_AGENT_BROWSER_MCP_SERVER] === true;
    } catch {
      throw new Error(`项目 MCP 配置损坏，无法迁移浏览器集成：${normalizedPath}`);
    }
    return { workspacePath: normalizedPath, enabled: browser ? { browser: true } : {} };
  }

  save(snapshot: ProjectIntegrationsSettingsSnapshot): ProjectIntegrationsSettingsSnapshot {
    const workspacePath = path.resolve(snapshot.workspacePath);
    const enabled = normalizeIntegrationsEnabled(snapshot.enabled) ?? {};
    this.db
      .prepare(
        `INSERT INTO project_integrations_settings (workspace_path, enabled_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_path) DO UPDATE SET
           enabled_json = excluded.enabled_json,
           updated_at = excluded.updated_at`,
      )
      .run(workspacePath, JSON.stringify(enabled), new Date().toISOString());
    return { workspacePath, enabled };
  }
}

function parseEnabled(raw: string): ProjectIntegrationsSettingsSnapshot["enabled"] {
  try {
    return normalizeIntegrationsEnabled(JSON.parse(raw) as unknown) ?? {};
  } catch {
    throw new Error("项目集成配置损坏。");
  }
}
