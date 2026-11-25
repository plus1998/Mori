import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { OrchestrationSelection } from "../shared/agent-orchestration";
import {
  isOrchestrationHarness,
  normalizeProjectOrchestrationSelection,
  type OrchestrationHarness,
  type ProjectOrchestrationSettingsSnapshot,
  type ProjectOrchestrationSettingsUpdate,
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
      CREATE TABLE IF NOT EXISTS project_harness_settings (
        workspace_path TEXT NOT NULL,
        core_kind TEXT NOT NULL,
        selection_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_path, core_kind)
      );
    `);
  }

  get(workspacePath: string): ProjectOrchestrationSettingsSnapshot {
    const normalizedPath = path.resolve(workspacePath);
    const row = this.db
      .prepare(`SELECT selection_json FROM project_orchestration_settings WHERE workspace_path = ?`)
      .get(normalizedPath) as { selection_json: string } | undefined;
    const snapshot: ProjectOrchestrationSettingsSnapshot = { workspacePath: normalizedPath };
    if (row) snapshot.orchestrationSelection = this.parseSelection(row.selection_json, normalizedPath);
    const harnessRows = this.db
      .prepare(`SELECT core_kind, selection_json FROM project_harness_settings WHERE workspace_path = ?`)
      .all(normalizedPath) as Array<{ core_kind: string; selection_json: string }>;
    for (const { core_kind, selection_json } of harnessRows) {
      if (core_kind === "acp") {
        const model: unknown = JSON.parse(selection_json);
        if (model !== null && (typeof model !== "string" || !model.trim())) {
          throw new Error(`项目 Cursor 模型配置无效：${normalizedPath}`);
        }
        snapshot.cursorModelId = model;
      } else if (isOrchestrationHarness(core_kind)) {
        (snapshot.harnessSelections ??= {})[core_kind] = this.parseSelection(selection_json, normalizedPath);
      }
    }
    return snapshot;
  }

  save(snapshot: ProjectOrchestrationSettingsUpdate): ProjectOrchestrationSettingsSnapshot {
    this.write(snapshot);
    return this.get(snapshot.workspacePath);
  }

  private write(snapshot: ProjectOrchestrationSettingsUpdate): void {
    const workspacePath = path.resolve(snapshot.workspacePath);
    const selection = snapshot.coreKind === "acp"
      ? snapshot.cursorModelId
      : normalizeProjectOrchestrationSelection(snapshot.orchestrationSelection);
    if (selection === undefined) {
      throw new Error("项目编排配置必须是完整有效的编排组合。");
    }
    const json = JSON.stringify(selection);
    const now = new Date().toISOString();
    if (snapshot.coreKind) {
      this.db.prepare(
        `INSERT INTO project_harness_settings (workspace_path, core_kind, selection_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_path, core_kind) DO UPDATE SET
           selection_json = excluded.selection_json, updated_at = excluded.updated_at`,
      ).run(workspacePath, snapshot.coreKind, json, now);
    } else {
      this.db.prepare(
        `INSERT INTO project_orchestration_settings (workspace_path, selection_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_path) DO UPDATE SET
           selection_json = excluded.selection_json, updated_at = excluded.updated_at`,
      ).run(workspacePath, json, now);
    }
  }

  listSelections(): OrchestrationSelection[] {
    return this.listSelectionEntries().map((entry) => entry.selection);
  }

  listSelectionEntries(): Array<{ workspacePath: string; selection: OrchestrationSelection }> {
    return this.readSelectionEntries().map(({ workspacePath, selection }) => ({ workspacePath, selection }));
  }

  clearSubagentOrchestrationReference(orchestrationId: string): number {
    const id = orchestrationId.trim();
    if (!id) return 0;
    return this.updateSelections((selection) =>
      selection.subagents.mode === "orchestration" && selection.subagents.orchestrationId === id
        ? { ...selection, subagents: { mode: "none" } }
        : selection);
  }

  clearMainModelProviderReference(providerId: string): number {
    const id = providerId.trim();
    if (!id) return 0;
    return this.updateSelections((selection) => selection.mainModel?.providerId === id ? undefined : selection);
  }

  clearMainAgentPromptReference(promptId: string): number {
    const id = promptId.trim();
    if (!id) return 0;
    return this.updateSelections((selection) =>
      selection.mainPrompt.mode === "custom_append" && selection.mainPrompt.promptId === id
        ? { ...selection, mainPrompt: { mode: "builtin" } }
        : selection);
  }

  private parseSelection(json: string, workspacePath: string): OrchestrationSelection {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(`项目编排配置损坏：${workspacePath}`);
    }
    const selection = normalizeProjectOrchestrationSelection(parsed);
    if (!selection) throw new Error(`项目编排配置无效：${workspacePath}`);
    return selection;
  }

  private readSelectionEntries(): Array<{
    workspacePath: string;
    coreKind?: OrchestrationHarness;
    selection: OrchestrationSelection;
  }> {
    const rows = this.db.prepare(
      `SELECT workspace_path, NULL AS core_kind, selection_json FROM project_orchestration_settings
       UNION ALL
       SELECT workspace_path, core_kind, selection_json FROM project_harness_settings WHERE core_kind <> 'acp'`,
    ).all() as Array<{ workspace_path: string; core_kind: string | null; selection_json: string }>;
    return rows.flatMap((row) => {
      try {
        return [{
          workspacePath: row.workspace_path,
          ...(isOrchestrationHarness(row.core_kind) ? { coreKind: row.core_kind } : {}),
          selection: this.parseSelection(row.selection_json, row.workspace_path),
        }];
      } catch {
        // Keep corrupt rows available for get() to report.
        return [];
      }
    });
  }

  private updateSelections(update: (selection: OrchestrationSelection) => OrchestrationSelection | undefined): number {
    let count = 0;
    for (const { workspacePath, coreKind, selection } of this.readSelectionEntries()) {
      const next = update(selection);
      if (next === selection) continue;
      if (next) {
        this.write({ workspacePath, ...(coreKind ? { coreKind } : {}), orchestrationSelection: next });
      } else if (coreKind) {
        this.db.prepare(`DELETE FROM project_harness_settings WHERE workspace_path = ? AND core_kind = ?`)
          .run(workspacePath, coreKind);
      } else {
        this.db.prepare(`DELETE FROM project_orchestration_settings WHERE workspace_path = ?`).run(workspacePath);
      }
      count += 1;
    }
    return count;
  }
}
