import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  buildMcpSdkConfig,
  buildMcpServerEntry,
  type McpSdkConfig,
  type McpServerConfigInput,
  type McpServerConfigView,
  type McpSettingsSnapshot,
  type McpToolApprovalTarget,
  parseAllowedToolPatterns,
  sanitizeMcpServerName,
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
      CREATE TABLE IF NOT EXISTS mcp_tool_approvals (
        server_id TEXT NOT NULL,
        configuration_revision TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        PRIMARY KEY (server_id, configuration_revision, tool_name)
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

    return rows.map((row) => ({
      ...rowToView(row),
      rememberedTools: this.db
        .prepare(
          `SELECT tool_name FROM mcp_tool_approvals WHERE server_id = ? AND configuration_revision = ? ORDER BY tool_name`,
        )
        .all(row.id, configurationRevision(row))
        .map((entry) => String(entry.tool_name)),
    }));
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

    const saved = this.getRow(id)!;
    if (
      input.resetToolApprovals ||
      (existing && configurationRevision(existing) !== configurationRevision(saved))
    ) {
      this.db.prepare(`DELETE FROM mcp_tool_approvals WHERE server_id = ?`).run(id);
    }
    return this.listServers().find((server) => server.id === id)!;
  }

  deleteServer(serverId: string): void {
    this.db.prepare(`DELETE FROM mcp_tool_approvals WHERE server_id = ?`).run(serverId);
    this.db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(serverId);
  }

  getToolApprovalTarget(serverName: string, toolName: string): McpToolApprovalTarget | undefined {
    const servers = this.listServers().filter((server) => sanitizeMcpServerName(server.name) === serverName);
    // Never bind an approval to an ambiguous normalized server name.
    const server = servers.length === 1 ? servers[0] : undefined;
    if (!server?.enabled) return undefined;
    const prefix = `mcp__${serverName}__`;
    const leaf = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
    if (!leaf || leaf.includes("*") || (leaf.startsWith("mcp__") && !toolName.startsWith(prefix)))
      return undefined;
    const fullName = `${prefix}${leaf}`;
    if (
      !parseAllowedToolPatterns(server.allowedTools, serverName).some(
        (pattern) =>
          pattern === fullName || (pattern.endsWith("*") && fullName.startsWith(pattern.slice(0, -1))),
      )
    )
      return undefined;
    const row = this.getRow(server.id)!;
    return {
      serverId: server.id,
      serverName,
      toolName: leaf,
      configurationRevision: configurationRevision(row),
    };
  }

  resolveToolApprovalTarget(fullToolName: string): McpToolApprovalTarget | undefined {
    const matches = this.listServers()
      .flatMap((server) => {
        const name = sanitizeMcpServerName(server.name);
        return fullToolName.startsWith(`mcp__${name}__`) ? [name] : [];
      })
      .sort((a, b) => b.length - a.length);
    return matches[0] ? this.getToolApprovalTarget(matches[0], fullToolName) : undefined;
  }

  isToolApproved(target: McpToolApprovalTarget): boolean {
    const current = this.getToolApprovalTarget(
      target.serverName,
      `mcp__${target.serverName}__${target.toolName}`,
    );
    if (
      !current ||
      current.serverId !== target.serverId ||
      current.configurationRevision !== target.configurationRevision
    )
      return false;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM mcp_tool_approvals WHERE server_id = ? AND configuration_revision = ? AND tool_name = ?`,
        )
        .get(target.serverId, target.configurationRevision, target.toolName),
    );
  }

  rememberToolApproval(target: McpToolApprovalTarget): void {
    const current = this.getToolApprovalTarget(
      target.serverName,
      `mcp__${target.serverName}__${target.toolName}`,
    );
    if (
      !current ||
      current.serverId !== target.serverId ||
      current.configurationRevision !== target.configurationRevision
    ) {
      throw new Error("MCP 服务器配置或工具权限已变化，请重新确认工具调用。");
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO mcp_tool_approvals (server_id, configuration_revision, tool_name) VALUES (?, ?, ?)`,
      )
      .run(target.serverId, target.configurationRevision, target.toolName);
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

function configurationRevision(row: McpServerRow): string {
  const server = rowToView(row);
  return createHash("sha256")
    .update(
      JSON.stringify([
        sanitizeMcpServerName(server.name),
        server.transport,
        buildMcpServerEntry(server),
        server.allowedTools,
      ]),
    )
    .digest("hex");
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
