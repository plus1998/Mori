import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { OrchestrationSelection } from "../shared/agent-orchestration";
import {
  normalizeProjectOrchestrationSelection,
  type ProjectOrchestrationSettingsSnapshot,
} from "../shared/project-orchestration-settings";

export async function createProjectOrchestrationSettingsStore(
  dbPath: string,
): Promise<ProjectOrchestrationSettingsStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new ProjectOrchestrationSettingsStore(new sqlite.DatabaseSync(dbPath));
  store.initialize();
  return store;
}

export class ProjectOrchestrationSettingsStore {
  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_orchestration_settings (
        workspace_path TEXT PRIMARY KEY,
        selection_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(workspacePath: string): ProjectOrchestrationSettingsSnapshot {
    const normalizedPath = path.resolve(workspacePath);
    const row = this.db
      .prepare(`SELECT selection_json FROM project_orchestration_settings WHERE workspace_path = ?`)
      .get(normalizedPath) as { selection_json: string } | undefined;
    if (!row) {
      return { workspacePath: normalizedPath };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.selection_json) as unknown;
    } catch {
      throw new Error(`项目编排配置损坏：${normalizedPath}`);
    }
    const orchestrationSelection = normalizeProjectOrchestrationSelection(parsed);
    if (!orchestrationSelection) {
      throw new Error(`项目编排配置无效：${normalizedPath}`);
    }
    return { workspacePath: normalizedPath, orchestrationSelection };
  }

  save(snapshot: {
    workspacePath: string;
    orchestrationSelection: OrchestrationSelection;
  }): ProjectOrchestrationSettingsSnapshot {
    const workspacePath = path.resolve(snapshot.workspacePath);
    const orchestrationSelection = normalizeProjectOrchestrationSelection(snapshot.orchestrationSelection);
    if (!orchestrationSelection) {
      throw new Error("项目编排配置必须是完整有效的编排组合。");
    }
    this.db
      .prepare(
        `INSERT INTO project_orchestration_settings (workspace_path, selection_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_path) DO UPDATE SET
           selection_json = excluded.selection_json,
           updated_at = excluded.updated_at`,
      )
      .run(workspacePath, JSON.stringify(orchestrationSelection), new Date().toISOString());
    return { workspacePath, orchestrationSelection };
  }

  listSelections(): OrchestrationSelection[] {
    return this.listSelectionEntries().map((entry) => entry.selection);
  }

  /** Selections with workspace paths — used for actionable delete-guard errors. */
  listSelectionEntries(): Array<{ workspacePath: string; selection: OrchestrationSelection }> {
    const rows = this.db
      .prepare(`SELECT workspace_path, selection_json FROM project_orchestration_settings`)
      .all() as Array<{ workspace_path: string; selection_json: string }>;
    const entries: Array<{ workspacePath: string; selection: OrchestrationSelection }> = [];
    for (const row of rows) {
      try {
        const selection = normalizeProjectOrchestrationSelection(JSON.parse(row.selection_json) as unknown);
        if (selection) {
          entries.push({ workspacePath: row.workspace_path, selection });
        }
      } catch {
        // Skip corrupt rows; get() will still surface them for that workspace.
      }
    }
    return entries;
  }

  clearSubagentOrchestrationReference(orchestrationId: string): number {
    const trimmedId = orchestrationId.trim();
    if (!trimmedId) {
      return 0;
    }

    const rows = this.db
      .prepare(`SELECT workspace_path, selection_json FROM project_orchestration_settings`)
      .all() as Array<{ workspace_path: string; selection_json: string }>;
    let cleared = 0;
    const update = this.db.prepare(
      `UPDATE project_orchestration_settings
       SET selection_json = ?, updated_at = ?
       WHERE workspace_path = ?`,
    );

    for (const row of rows) {
      let selection: OrchestrationSelection | undefined;
      try {
        selection = normalizeProjectOrchestrationSelection(JSON.parse(row.selection_json) as unknown);
      } catch {
        continue;
      }
      if (
        selection?.subagents.mode !== "orchestration" ||
        selection.subagents.orchestrationId !== trimmedId
      ) {
        continue;
      }
      update.run(
        JSON.stringify({ ...selection, subagents: { mode: "none" } }),
        new Date().toISOString(),
        row.workspace_path,
      );
      cleared += 1;
    }
    return cleared;
  }

  /**
   * Drop project orchestration rows that point at a deleted main-agent config so
   * those workspaces fall back to the global default.
   */
  clearMainModelProviderReference(providerId: string): number {
    const trimmedId = providerId.trim();
    if (!trimmedId) {
      return 0;
    }

    const rows = this.db
      .prepare(`SELECT workspace_path, selection_json FROM project_orchestration_settings`)
      .all() as Array<{ workspace_path: string; selection_json: string }>;
    let cleared = 0;
    const remove = this.db.prepare(`DELETE FROM project_orchestration_settings WHERE workspace_path = ?`);

    for (const row of rows) {
      let selection: OrchestrationSelection | undefined;
      try {
        selection = normalizeProjectOrchestrationSelection(JSON.parse(row.selection_json) as unknown);
      } catch {
        continue;
      }
      if (selection?.mainModel?.providerId !== trimmedId) {
        continue;
      }
      remove.run(row.workspace_path);
      cleared += 1;
    }
    return cleared;
  }

  /** Reset custom main prompts that point at a deleted prompt resource to builtin. */
  clearMainAgentPromptReference(promptId: string): number {
    const trimmedId = promptId.trim();
    if (!trimmedId) {
      return 0;
    }

    const rows = this.db
      .prepare(`SELECT workspace_path, selection_json FROM project_orchestration_settings`)
      .all() as Array<{ workspace_path: string; selection_json: string }>;
    let cleared = 0;
    const update = this.db.prepare(
      `UPDATE project_orchestration_settings
       SET selection_json = ?, updated_at = ?
       WHERE workspace_path = ?`,
    );

    for (const row of rows) {
      let selection: OrchestrationSelection | undefined;
      try {
        selection = normalizeProjectOrchestrationSelection(JSON.parse(row.selection_json) as unknown);
      } catch {
        continue;
      }
      if (selection?.mainPrompt.mode !== "custom_append" || selection.mainPrompt.promptId !== trimmedId) {
        continue;
      }
      update.run(
        JSON.stringify({ ...selection, mainPrompt: { mode: "builtin" } }),
        new Date().toISOString(),
        row.workspace_path,
      );
      cleared += 1;
    }
    return cleared;
  }
}
