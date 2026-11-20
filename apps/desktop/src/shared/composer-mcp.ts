import { normalizeStoredMoriMcpServer } from "@eco/shared";
import type { McpServerConfigView } from "./ipc";
import { sanitizeMcpServerName } from "./mcp";

export type McpServersEnabledSettings = Record<string, boolean>;

export interface ProjectMcpSettingsSnapshot {
  workspacePath: string;
  enabledByServer: McpServersEnabledSettings;
}

export function listEnabledGlobalMcpServerKeys(servers: readonly McpServerConfigView[]): string[] {
  return servers
    .filter((server) => server.enabled && server.name.trim())
    .map((server) => sanitizeMcpServerName(server.name));
}

export function deriveMcpServersEnabled(
  availableServerKeys: readonly string[],
  options: {
    existing?: Partial<McpServersEnabledSettings>;
    remembered?: Partial<McpServersEnabledSettings>;
  } = {},
): McpServersEnabledSettings {
  const result: McpServersEnabledSettings = {};
  for (const key of availableServerKeys) {
    const sanitized = sanitizeMcpServerName(key);
    if (typeof options.existing?.[sanitized] === "boolean") {
      result[sanitized] = options.existing[sanitized];
      continue;
    }
    if (typeof options.remembered?.[sanitized] === "boolean") {
      result[sanitized] = options.remembered[sanitized];
      continue;
    }
    // Composer/workpanel is the source of truth; default new servers off until toggled.
    result[sanitized] = false;
  }
  return result;
}

export function resolveEnabledMcpServerKeys(settings: McpServersEnabledSettings): string[] {
  return Object.entries(settings)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
}

export function countEnabledMcpServers(settings: McpServersEnabledSettings): number {
  return Object.values(settings).filter(Boolean).length;
}

export function normalizeMcpServersEnabled(value: unknown): McpServersEnabledSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: McpServersEnabledSettings = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean" && key.trim()) {
      const sanitized = sanitizeMcpServerName(key);
      const canonical = normalizeStoredMoriMcpServer(sanitized);
      if (sanitized === canonical || !Object.hasOwn(result, canonical)) {
        result[canonical] = enabled;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
