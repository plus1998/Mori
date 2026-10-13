import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  buildMcpSdkConfig,
  type McpSdkConfig,
  type McpServerConfigInput,
  type McpServerConfigView,
  type McpSettingsSnapshot,
  validateMcpServerInput,
} from "../shared/mcp";

interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  enabled: number;
  command: string | null;
  args_json: string;
  env_json: string;
  url: string | null;
  headers_json: string;
  allowed_tools: string;
  created_at: string;
  updated_at: string;
}

export async function createMcpStore(dbPath: string): Promise<McpStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new McpStore(new sqlite.DatabaseSync(dbPath));
  store.initialize();
  return store;
}

export class McpStore {
  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        command TEXT,
        args_json TEXT NOT NULL,
        env_json TEXT NOT NULL,
        url TEXT,
        headers_json TEXT NOT NULL,
        allowed_tools TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  getSettings(): McpSettingsSnapshot {
    return { servers: this.listServers() };
  }

  listServers(): McpServerConfigView[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, transport, enabled, command, args_json, env_json, url, headers_json, allowed_tools, created_at, updated_at
         FROM mcp_servers
         ORDER BY name ASC`,
      )
      .all() as unknown as McpServerRow[];

    return rows.map(rowToView);
  }

  saveServer(input: McpServerConfigInput): McpServerConfigView {
    validateMcpServerInput(input);
    const now = new Date().toISOString();
    const existing = input.id ? this.getRow(input.id) : undefined;
    const id = input.id ?? createServerId(input.name);
    const createdAt = existing?.created_at ?? now;
    const name = input.name.trim();
    const clash = this.getRowByName(name);
    if (clash && clash.id !== id) {
      throw new Error(`MCP server name "${name}" already exists.`);
    }

    this.db
      .prepare(
        `INSERT INTO mcp_servers (
           id, name, transport, enabled, command, args_json, env_json, url, headers_json, allowed_tools, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           transport = excluded.transport,
           enabled = excluded.enabled,
           command = excluded.command,
           args_json = excluded.args_json,
           env_json = excluded.env_json,
           url = excluded.url,
           headers_json = excluded.headers_json,
           allowed_tools = excluded.allowed_tools,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.name.trim(),
        input.transport,
        input.enabled ? 1 : 0,
        input.command?.trim() ?? null,
        input.argsJson?.trim() ?? "[]",
        input.envJson?.trim() ?? "{}",
        input.url?.trim() ?? null,
        input.headersJson?.trim() ?? "{}",
        input.allowedTools?.trim() ?? "",
        createdAt,
        now,
      );

    return rowToView(this.getRow(id)!);
  }

  deleteServer(serverId: string): void {
    this.db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(serverId);
  }

  buildSdkConfig(): McpSdkConfig {
    return buildMcpSdkConfig(this.listServers());
  }

  private getRow(id: string): McpServerRow | undefined {
    return this.db
      .prepare(
        `SELECT id, name, transport, enabled, command, args_json, env_json, url, headers_json, allowed_tools, created_at, updated_at
         FROM mcp_servers WHERE id = ?`,
      )
      .get(id) as McpServerRow | undefined;
  }

  private getRowByName(name: string): McpServerRow | undefined {
    return this.db
      .prepare(
        `SELECT id, name, transport, enabled, command, args_json, env_json, url, headers_json, allowed_tools, created_at, updated_at
         FROM mcp_servers WHERE name = ?`,
      )
      .get(name) as McpServerRow | undefined;
  }
}

function rowToView(row: McpServerRow): McpServerConfigView {
  const view: McpServerConfigView = {
    id: row.id,
    name: row.name,
    transport: row.transport as McpServerConfigView["transport"],
    enabled: row.enabled === 1,
    argsJson: row.args_json,
    envJson: row.env_json,
    headersJson: row.headers_json,
    allowedTools: row.allowed_tools,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.command) view.command = row.command;
  if (row.url) view.url = row.url;
  return view;
}

function createServerId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `mcp_${slug || "server"}_${Date.now()}`;
}
