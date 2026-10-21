export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfigInput {
  id?: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  /** JSON array of argument strings */
  argsJson?: string;
  /** JSON object of environment variables */
  envJson?: string;
  url?: string;
  /** JSON object of HTTP headers */
  headersJson?: string;
  /**
   * Tool allowlist entries, e.g. `mcp__github__*` or `mcp__github__list_issues`.
   * Leave empty to auto-approve all tools from this server.
   */
  allowedTools?: string;
  /** Revoke saved tool approvals when saving this server. Does not grant access. */
  resetToolApprovals?: boolean;
}

export interface McpServerConfigView {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  argsJson: string;
  envJson: string;
  url?: string;
  headersJson: string;
  allowedTools: string;
  rememberedTools?: string[];
  createdAt: string;
  updatedAt: string;
}

/** Host-bound identity for remembering one tool on one server configuration. */
export interface McpToolApprovalTarget {
  serverId: string;
  serverName: string;
  toolName: string;
  configurationRevision: string;
}

export interface McpSettingsSnapshot {
  servers: McpServerConfigView[];
}

export interface McpServerCheckResult {
  ok: boolean;
  serverName: string;
  transport: McpTransport;
  checkedAt: string;
  durationMs: number;
  message: string;
  details?: string;
  protocolVersion?: string;
  capabilities: string[];
  toolsCount?: number;
  toolNames?: string[];
  serverInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
}

export interface McpSdkConfig {
  mcpServers: Record<string, unknown>;
  allowedTools: string[];
}

export function filterMcpSdkConfigByAssignedServers(
  config: McpSdkConfig,
  assignedServerNames: readonly string[],
): McpSdkConfig {
  if (assignedServerNames.length === 0) {
    return { mcpServers: {}, allowedTools: [] };
  }
  const assigned = new Set(assignedServerNames.map((server) => sanitizeMcpServerName(server)));
  const mcpServers: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(config.mcpServers)) {
    if (assigned.has(key)) {
      mcpServers[key] = entry;
    }
  }
  const allowedTools: string[] = [];
  for (const serverKey of assigned) {
    if (!mcpServers[serverKey]) {
      continue;
    }
    const fromConfig = config.allowedTools.filter((pattern) => mcpPatternMatchesServer(pattern, serverKey));
    if (fromConfig.length > 0) {
      allowedTools.push(...fromConfig);
    } else {
      allowedTools.push(`mcp__${serverKey}__*`);
    }
  }
  return { mcpServers, allowedTools: [...new Set(allowedTools)] };
}

export function buildCodexMcpServersForConfigSync(
  servers: readonly McpServerConfigView[],
  assignedServerKeys: readonly string[],
): CodexMcpServerForConfigSync[] {
  const assigned = new Set(assignedServerKeys.map(sanitizeMcpServerName));
  const result: CodexMcpServerForConfigSync[] = [];
  for (const server of servers) {
    const key = sanitizeMcpServerName(server.name);
    if (!server.enabled || !server.name.trim() || !assigned.has(key)) continue;
    if (server.transport === "sse") {
      throw new Error(
        `MCP server "${server.name}" uses SSE, which Codex does not support. Use HTTP or stdio.`,
      );
    }
    const entry = buildMcpServerEntry(server);
    if (!entry) throw new Error(`MCP server "${server.name}" is incomplete.`);
    const enabledTools = resolveCodexEnabledToolsFromPatterns(
      key,
      parseAllowedToolPatterns(server.allowedTools, key),
    );
    if (server.transport === "stdio") {
      result.push({
        name: key,
        transport: "stdio",
        command: typeof entry.command === "string" ? entry.command : "",
        args: Array.isArray(entry.args) ? entry.args.filter((v): v is string => typeof v === "string") : [],
        env:
          entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)
            ? Object.fromEntries(
                Object.entries(entry.env).filter(([, v]) => typeof v === "string") as Array<[string, string]>,
              )
            : {},
        ...(enabledTools ? { enabledTools } : {}),
      });
    } else {
      const headers =
        entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)
          ? Object.fromEntries(
              Object.entries(entry.headers).filter(([, v]) => typeof v === "string") as Array<
                [string, string]
              >,
            )
          : {};
      result.push({
        name: key,
        transport: "http",
        url: typeof entry.url === "string" ? entry.url : "",
        ...(Object.keys(headers).length ? { httpHeaders: headers } : {}),
        ...(enabledTools ? { enabledTools } : {}),
      });
    }
  }
  return result;
}

export function resolveCodexEnabledToolsFromPatterns(
  serverKey: string,
  patterns: readonly string[],
): string[] | undefined {
  const key = sanitizeMcpServerName(serverKey);
  const tools: string[] = [];
  for (const pattern of patterns.filter((value) => mcpPatternMatchesServer(value, key))) {
    const tool = pattern.slice(pattern.indexOf("__", 5) + 2);
    if (!tool || tool === "*") return undefined;
    tools.push(tool);
  }
  return tools.length ? [...new Set(tools)] : undefined;
}

function mcpPatternMatchesServer(pattern: string, serverKey: string): boolean {
  if (!pattern.startsWith("mcp__")) {
    return false;
  }
  const rest = pattern.slice(5);
  const separatorIndex = rest.indexOf("__");
  if (separatorIndex <= 0) {
    return false;
  }
  return rest.slice(0, separatorIndex) === serverKey;
}

export function buildMcpSdkConfig(servers: readonly McpServerConfigView[]): McpSdkConfig {
  const mcpServers: Record<string, unknown> = {};
  const allowedTools: string[] = [];

  for (const server of servers) {
    if (!server.enabled || !server.name.trim()) {
      continue;
    }

    const key = sanitizeMcpServerName(server.name);
    const built = buildMcpServerEntry(server);
    if (!built) {
      continue;
    }
    mcpServers[key] = built;

    const patterns = parseAllowedToolPatterns(server.allowedTools, key);
    allowedTools.push(...patterns);
  }

  return { mcpServers, allowedTools };
}

export function buildMcpServerEntry(server: McpServerConfigView): Record<string, unknown> | undefined {
  if (server.transport === "stdio") {
    const command = server.command?.trim();
    if (!command) {
      return undefined;
    }
    return {
      command,
      args: parseJsonStringArray(server.argsJson),
      env: parseJsonObject(server.envJson),
    };
  }

  const url = server.url?.trim();
  if (!url) {
    return undefined;
  }

  const headers = parseJsonObject(server.headersJson);
  if (server.transport === "http") {
    return {
      type: "http",
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  return {
    type: "sse",
    url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export function parseAllowedToolPatterns(allowedTools: string, serverName: string): string[] {
  const key = sanitizeMcpServerName(serverName);
  const trimmed = allowedTools.trim();
  if (!trimmed) {
    return [`mcp__${key}__*`];
  }
  return trimmed
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function sanitizeMcpServerName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "mcp-server";
}

export function parseMcpArgsList(raw: string): string[] {
  return parseJsonStringArray(raw);
}

export function serializeMcpArgsList(args: string[]): string {
  return JSON.stringify(args.map((entry) => entry.trim()).filter(Boolean));
}

export function parseMcpEnvEntries(raw: string): Array<{ key: string; value: string }> {
  const object = parseJsonObject(raw);
  return Object.entries(object).map(([key, value]) => ({ key, value }));
}

export function serializeMcpEnvEntries(entries: Array<{ key: string; value: string }>): string {
  const object: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) {
      continue;
    }
    object[key] = entry.value;
  }
  return JSON.stringify(object);
}

export function mcpServerToInput(server: McpServerConfigView): McpServerConfigInput {
  const input: McpServerConfigInput = {
    id: server.id,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    argsJson: server.argsJson,
    envJson: server.envJson,
    headersJson: server.headersJson,
    allowedTools: server.allowedTools,
  };
  if (server.command) input.command = server.command;
  if (server.url) input.url = server.url;
  return input;
}

function parseJsonStringArray(raw: string): string[] {
  if (!raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
}

function parseJsonObject(raw: string): Record<string, string> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return result;
  } catch {
    const result: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const index = line.indexOf("=");
      if (index <= 0) {
        continue;
      }
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (key) {
        result[key] = value;
      }
    }
    return result;
  }
}

export function validateMcpServerInput(input: McpServerConfigInput): void {
  const name = input.name.trim();
  if (!name) {
    throw new Error("MCP server name is required.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("MCP server name may only contain letters, numbers, underscores, and hyphens.");
  }

  if (input.transport === "stdio") {
    if (!input.command?.trim()) {
      throw new Error("stdio transport requires a command.");
    }
    return;
  }

  if (!input.url?.trim()) {
    throw new Error(`${input.transport} transport requires a URL.`);
  }
}

import type { CodexMcpServerForConfigSync } from "@eco/runtime";
