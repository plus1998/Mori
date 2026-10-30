import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  normalizeTerminalStartupCommand,
  type ProjectTerminalSettingsSnapshot,
} from "../shared/project-terminal-settings";

export async function createProjectTerminalSettingsStore(
  dbPath: string,
): Promise<ProjectTerminalSettingsStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const store = new ProjectTerminalSettingsStore(new DatabaseSync(dbPath));
  store.initialize();
  return store;
}

function resolveWorkspacePath(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Workspace path is required.");
  return path.resolve(value.trim());
}

export class ProjectTerminalSettingsStore {
  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_terminal_settings (
        workspace_path TEXT PRIMARY KEY,
        startup_command TEXT NOT NULL
      )
    `);
  }

  get(path: string): ProjectTerminalSettingsSnapshot {
    const workspacePath = resolveWorkspacePath(path);
    const row = this.db
      .prepare("SELECT startup_command FROM project_terminal_settings WHERE workspace_path = ?")
      .get(workspacePath) as { startup_command: string } | undefined;
    return { workspacePath, startupCommand: row ? normalizeTerminalStartupCommand(row.startup_command) : "" };
  }

  save(snapshot: ProjectTerminalSettingsSnapshot): ProjectTerminalSettingsSnapshot {
    const workspacePath = resolveWorkspacePath(snapshot.workspacePath);
    const startupCommand = normalizeTerminalStartupCommand(snapshot.startupCommand);
    if (startupCommand) {
      this.db
        .prepare(`INSERT INTO project_terminal_settings (workspace_path, startup_command)
          VALUES (?, ?) ON CONFLICT(workspace_path) DO UPDATE SET startup_command = excluded.startup_command`)
        .run(workspacePath, startupCommand);
    } else {
      this.db.prepare("DELETE FROM project_terminal_settings WHERE workspace_path = ?").run(workspacePath);
    }
    return { workspacePath, startupCommand };
  }
}
