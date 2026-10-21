import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { type CodexThreadAttribution, resolveDefaultCodexThreadAttribution } from "@eco/runtime";

/**
 * Multi-agent spawn policy (§6.4.1): only the **main** Eco thread may invoke
 * `spawn_agent`. Sub-agent Codex threads must not nest spawn — Eco enforces this
 * product rule even though Codex supports `next_thread_spawn_depth` > 1.
 */

/** Per Codex child thread: parent link + orchestration role id (from `thread/started` or spawn item). */
export interface CodexThreadAttributionRecord {
  parentThreadId: string;
  /** Orchestration role id when known; parent link alone is enough for Eco thread resolution. */
  agentRole?: string | undefined;
  agentNickname?: string | undefined;
  spawnCallId?: string | undefined;
}

export interface CodexThreadMap {
  getCodexThreadId(ecoThreadId: string): string | undefined;
  getEcoThreadId(codexThreadId: string): string | undefined;
  setMapping(ecoThreadId: string, codexThreadId: string): void;
  deleteMapping(ecoThreadId: string): void;
  getThreadAttribution(codexThreadId: string): CodexThreadAttributionRecord | undefined;
  setThreadAttribution(codexThreadId: string, record: CodexThreadAttributionRecord): void;
}

/** Resolve billing + Feed attribution for a Codex thread (main or sub-agent child). */
export function resolveCodexThreadAttribution(
  threadMap: CodexThreadMap,
  codexThreadId: string,
): CodexThreadAttribution | undefined {
  const trimmed = codexThreadId.trim();
  if (!trimmed) {
    return undefined;
  }

  // Only the main Codex session is eco-mapped. Check that first so a corrupted
  // parent link on the root (or a cycle through a child) cannot re-label the
  // main session as a subagent — that would attach agentId=main, scope=agent,
  // role=general to every planner message and hide them from the main feed.
  const ecoAsRoot = threadMap.getEcoThreadId(trimmed);
  if (ecoAsRoot) {
    return { ecoThreadId: ecoAsRoot, billingRole: "main" };
  }

  // Walk parent links to the eco-mapped root. Nested Codex subagents parent to another
  // child thread (not in eco_thread_codex_map); only the main Codex id is mapped.
  let current = trimmed;
  let leafAgentRole: string | undefined;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const record = threadMap.getThreadAttribution(current);
    const parentCodexThreadId = record?.parentThreadId?.trim();
    // Self-parent must not mark the main thread as a subagent.
    if (!parentCodexThreadId || parentCodexThreadId === current) {
      break;
    }
    if (!leafAgentRole && record?.agentRole?.trim()) {
      leafAgentRole = record.agentRole.trim();
    }
    const parentEcoThreadId = threadMap.getEcoThreadId(parentCodexThreadId);
    if (parentEcoThreadId) {
      return {
        ...resolveDefaultCodexThreadAttribution({
          codexThreadId: trimmed,
          ecoThreadId: parentEcoThreadId,
          parentThreadId: parentCodexThreadId,
          parentEcoThreadId,
          agentRole: leafAgentRole,
        }),
        agentId: trimmed,
      };
    }
    current = parentCodexThreadId;
  }

  return undefined;
}

export async function createCodexThreadMap(dbPath: string): Promise<CodexThreadMap> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  return new SqliteCodexThreadMap(new sqlite.DatabaseSync(dbPath));
}

class SqliteCodexThreadMap implements CodexThreadMap {
  constructor(private readonly db: DatabaseSyncType) {
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS eco_thread_codex_map (
        eco_thread_id TEXT PRIMARY KEY,
        codex_thread_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_eco_thread_codex_map_codex
        ON eco_thread_codex_map (codex_thread_id);
      CREATE TABLE IF NOT EXISTS codex_thread_attribution (
        codex_thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        agent_role TEXT,
        agent_nickname TEXT,
        spawn_call_id TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureNullableAgentRole();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_codex_thread_attribution_parent
        ON codex_thread_attribution (parent_thread_id);
    `);
  }

  private ensureNullableAgentRole(): void {
    const columns = this.db.prepare(`PRAGMA table_info(codex_thread_attribution)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const agentRole = columns.find((column) => column.name === "agent_role");
    if (!agentRole || Number(agentRole.notnull) === 0) {
      return;
    }
    this.db.exec(`
      DROP TABLE IF EXISTS codex_thread_attribution_nullable_migration;
      CREATE TABLE codex_thread_attribution_nullable_migration (
        codex_thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        agent_role TEXT,
        agent_nickname TEXT,
        spawn_call_id TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO codex_thread_attribution_nullable_migration (
        codex_thread_id, parent_thread_id, agent_role, agent_nickname, spawn_call_id, updated_at
      )
      SELECT
        codex_thread_id,
        parent_thread_id,
        NULLIF(agent_role, ''),
        agent_nickname,
        spawn_call_id,
        updated_at
      FROM codex_thread_attribution;
      DROP TABLE codex_thread_attribution;
      ALTER TABLE codex_thread_attribution_nullable_migration RENAME TO codex_thread_attribution;
    `);
  }

  getCodexThreadId(ecoThreadId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT codex_thread_id FROM eco_thread_codex_map WHERE eco_thread_id = ?`)
      .get(ecoThreadId.trim()) as { codex_thread_id: string } | undefined;
    return row?.codex_thread_id?.trim() || undefined;
  }

  getEcoThreadId(codexThreadId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT eco_thread_id FROM eco_thread_codex_map WHERE codex_thread_id = ?`)
      .get(codexThreadId.trim()) as { eco_thread_id: string } | undefined;
    return row?.eco_thread_id?.trim() || undefined;
  }

  setMapping(ecoThreadId: string, codexThreadId: string): void {
    const eco = ecoThreadId.trim();
    const codex = codexThreadId.trim();
    if (!eco || !codex) {
      throw new Error("ecoThreadId and codexThreadId are required for Codex thread mapping");
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO eco_thread_codex_map (eco_thread_id, codex_thread_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(eco_thread_id) DO UPDATE SET
           codex_thread_id = excluded.codex_thread_id,
           updated_at = excluded.updated_at`,
      )
      .run(eco, codex, now, now);
  }

  deleteMapping(ecoThreadId: string): void {
    this.db.prepare(`DELETE FROM eco_thread_codex_map WHERE eco_thread_id = ?`).run(ecoThreadId.trim());
  }

  getThreadAttribution(codexThreadId: string): CodexThreadAttributionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT parent_thread_id, agent_role, agent_nickname, spawn_call_id
         FROM codex_thread_attribution WHERE codex_thread_id = ?`,
      )
      .get(codexThreadId.trim()) as
      | {
          parent_thread_id: string;
          agent_role: string | null;
          agent_nickname: string | null;
          spawn_call_id: string | null;
        }
      | undefined;
    if (!row?.parent_thread_id?.trim()) {
      return undefined;
    }
    return {
      parentThreadId: row.parent_thread_id.trim(),
      ...(row.agent_role?.trim() && { agentRole: row.agent_role.trim() }),
      ...(row.agent_nickname?.trim() && { agentNickname: row.agent_nickname.trim() }),
      ...(row.spawn_call_id?.trim() && { spawnCallId: row.spawn_call_id.trim() }),
    };
  }

  setThreadAttribution(codexThreadId: string, record: CodexThreadAttributionRecord): void {
    const codex = codexThreadId.trim();
    const parent = record.parentThreadId.trim();
    const role = record.agentRole?.trim() || null;
    if (!codex || !parent) {
      throw new Error("codexThreadId and parentThreadId are required for Codex thread attribution");
    }
    if (this.getEcoThreadId(codex) || codex === parent) {
      return;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO codex_thread_attribution (
           codex_thread_id, parent_thread_id, agent_role, agent_nickname, spawn_call_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(codex_thread_id) DO UPDATE SET
           parent_thread_id = excluded.parent_thread_id,
           agent_role = CASE
             WHEN excluded.agent_role IS NOT NULL AND excluded.agent_role != '' THEN excluded.agent_role
             ELSE codex_thread_attribution.agent_role
           END,
           agent_nickname = COALESCE(excluded.agent_nickname, codex_thread_attribution.agent_nickname),
           spawn_call_id = COALESCE(excluded.spawn_call_id, codex_thread_attribution.spawn_call_id),
           updated_at = excluded.updated_at`,
      )
      .run(
        codex,
        parent,
        role,
        record.agentNickname?.trim() || null,
        record.spawnCallId?.trim() || null,
        now,
      );
  }
}

/** In-memory map for tests when SQLite is unavailable. */
export class InMemoryCodexThreadMap implements CodexThreadMap {
  private readonly ecoToCodex = new Map<string, string>();
  private readonly codexToEco = new Map<string, string>();
  private readonly attributionByCodexThreadId = new Map<string, CodexThreadAttributionRecord>();

  getCodexThreadId(ecoThreadId: string): string | undefined {
    return this.ecoToCodex.get(ecoThreadId.trim());
  }

  getEcoThreadId(codexThreadId: string): string | undefined {
    return this.codexToEco.get(codexThreadId.trim());
  }

  setMapping(ecoThreadId: string, codexThreadId: string): void {
    const eco = ecoThreadId.trim();
    const codex = codexThreadId.trim();
    if (!eco || !codex) {
      throw new Error("ecoThreadId and codexThreadId are required for Codex thread mapping");
    }
    const previousCodex = this.ecoToCodex.get(eco);
    if (previousCodex) {
      this.codexToEco.delete(previousCodex);
    }
    const previousEco = this.codexToEco.get(codex);
    if (previousEco && previousEco !== eco) {
      this.ecoToCodex.delete(previousEco);
    }
    this.ecoToCodex.set(eco, codex);
    this.codexToEco.set(codex, eco);
  }

  deleteMapping(ecoThreadId: string): void {
    const codex = this.ecoToCodex.get(ecoThreadId.trim());
    if (codex) {
      this.codexToEco.delete(codex);
    }
    this.ecoToCodex.delete(ecoThreadId.trim());
  }

  getThreadAttribution(codexThreadId: string): CodexThreadAttributionRecord | undefined {
    return this.attributionByCodexThreadId.get(codexThreadId.trim());
  }

  setThreadAttribution(codexThreadId: string, record: CodexThreadAttributionRecord): void {
    const codex = codexThreadId.trim();
    const parent = record.parentThreadId.trim();
    const role = record.agentRole?.trim();
    if (!codex || !parent) {
      throw new Error("codexThreadId and parentThreadId are required for Codex thread attribution");
    }
    if (this.getEcoThreadId(codex) || codex === parent) {
      return;
    }
    const previous = this.attributionByCodexThreadId.get(codex);
    const agentNickname = record.agentNickname?.trim() || previous?.agentNickname;
    const spawnCallId = record.spawnCallId?.trim() || previous?.spawnCallId;
    this.attributionByCodexThreadId.set(codex, {
      parentThreadId: parent,
      ...(role ? { agentRole: role } : previous?.agentRole ? { agentRole: previous.agentRole } : {}),
      ...(agentNickname && { agentNickname }),
      ...(spawnCallId && { spawnCallId }),
    });
  }
}
