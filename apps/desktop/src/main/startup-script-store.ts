import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { StartupScript, StartupScriptSaveInput } from "../shared/ipc";

interface StartupScriptRow {
  id: string;
  name: string;
  workspace_path: string;
  command: string;
  creation_order: number;
}

export async function createStartupScriptStore(dbPath: string): Promise<StartupScriptStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new StartupScriptStore(new sqlite.DatabaseSync(dbPath));
  store.initialize();
  return store;
}

export class StartupScriptStore {
  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS startup_scripts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        command TEXT NOT NULL,
        creation_order INTEGER NOT NULL UNIQUE
      );
    `);
  }

  list(): StartupScript[] {
    const rows = this.db
      .prepare(`SELECT id, name, workspace_path, command, creation_order
                FROM startup_scripts ORDER BY creation_order ASC`)
      .all() as unknown as StartupScriptRow[];
    return rows.map(toStartupScript);
  }

  get(id: string): StartupScript | undefined {
    const row = this.db
      .prepare(`SELECT id, name, workspace_path, command, creation_order
                FROM startup_scripts WHERE id = ?`)
      .get(id) as StartupScriptRow | undefined;
    return row ? toStartupScript(row) : undefined;
  }

  save(input: StartupScriptSaveInput): StartupScript {
    const name = input.name.trim();
    const rawWorkspacePath = input.workspacePath.trim();
    const command = input.command.trim();
    if (rawWorkspacePath.length > 4096) throw new Error("Working directory path is too long.");
    if (!name) throw new Error("Script name is required.");
    if (!rawWorkspacePath) throw new Error("Working directory is required.");
    const home = os.homedir();
    const expandedWorkspacePath = rawWorkspacePath === "~"
      ? home
      : rawWorkspacePath.startsWith(`~${path.sep}`)
        ? path.join(home, rawWorkspacePath.slice(2))
        : rawWorkspacePath;
    const workspacePath = path.resolve(expandedWorkspacePath);
    if (!command) throw new Error("Startup command is required.");
    if (name.length > 120) throw new Error("Script name must be 120 characters or fewer.");
    if (command.length > 64_000) throw new Error("Startup command must be 64,000 characters or fewer.");

    if (input.id !== undefined) {
      const id = input.id.trim();
      if (!id || !this.get(id)) throw new Error("Startup script not found.");
      this.db
        .prepare(`UPDATE startup_scripts
                  SET name = ?, workspace_path = ?, command = ?
                  WHERE id = ?`)
        .run(name, workspacePath, command, id);
      return this.get(id)!;
    }

    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO startup_scripts (id, name, workspace_path, command, creation_order)
                VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(creation_order), 0) + 1 FROM startup_scripts))`)
      .run(id, name, workspacePath, command);
    return this.get(id)!;
  }

  delete(id: string): void {
    const result = this.db.prepare(`DELETE FROM startup_scripts WHERE id = ?`).run(id);
    if (result.changes === 0) throw new Error("Startup script not found.");
  }

  close(): void {
    this.db.close();
  }
}

function toStartupScript(row: StartupScriptRow): StartupScript {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    command: row.command,
    creationOrder: row.creation_order,
  };
}
