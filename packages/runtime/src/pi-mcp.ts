/**
 * Map Eco / Claude-SDK shaped MCP server entries into the official PI MCP
 * extension config (`LoadedMcpConfig`).
 *
 * Isolated snapshots only — never merge ambient `mcp.json` / `~/.pi` files.
 * `loadConfig` in pi-mcp-extension-factory.ts returns exactly this snapshot.
 *
 * Only stdio and streamable HTTP are supported, like the official extension.
 * SSE servers stay in the Eco MCP Hub and are never handed to PI.
 */

import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { ECO_MCP_HUB_CALL_FULL_TOOL, ECO_MCP_HUB_SEARCH_FULL_TOOL } from "./eco-mcp-hub-tool.js";

type PiMcpStdioServerConfig = Extract<McpServerConfig, { command: string }>;
type PiMcpHttpServerConfig = Extract<McpServerConfig, { url: string }>;

/**
 * Server name the Hub injection uses. PI namespaces its tools as
 * `mcp__<server>__<tool>`, so both names below are the exact wire names.
 */
export const PI_MCP_HUB_SERVER_NAME = "eco_mcp";

/** The only Hub tools declared to the model, identical to the Claude/Codex runtime. */
export const PI_MCP_HUB_TOOL_NAMES = [ECO_MCP_HUB_SEARCH_FULL_TOOL, ECO_MCP_HUB_CALL_FULL_TOOL] as const;

/**
 * The official extension declares these tools to the model right away. Without
 * it every server defaults to `codemode` exposure, which would hide the Hub
 * behind a script sandbox instead of keeping direct tool calls.
 */
const PI_MCP_HUB_EXPOSURE = "direct" as const;

/** Where the entry came from, for `/mcp` diagnostics. Never a file we could write back to. */
const PI_MCP_SESSION_SOURCE = "<eco:session>";

export type PiMcpServerMapResult = { ok: true; config: McpServerConfig } | { ok: false; error: string };

/**
 * Convert one Claude/Eco SDK MCP entry into an official `McpServerConfig`.
 *
 * Returns an explicit error instead of dropping the server: a silently missing
 * server would leave the model without tools it was told about.
 */
export function toPiMcpServerConfig(entry: unknown): PiMcpServerMapResult {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, error: "entry is not an object" };
  }
  const record = entry as Record<string, unknown>;
  const timeoutSeconds = resolveTimeoutSeconds(record);
  const description = readNonEmptyString(record.description);

  if (typeof record.command === "string" && record.command.trim()) {
    const args = stringArray(record.args);
    const env = stringRecord(record.env);
    const cwd = readNonEmptyString(record.cwd);
    const config: PiMcpStdioServerConfig = {
      type: "stdio",
      command: record.command.trim(),
      exposure: PI_MCP_HUB_EXPOSURE,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      ...(description ? { description } : {}),
      ...(timeoutSeconds !== undefined ? { timeout: timeoutSeconds } : {}),
    };
    return { ok: true, config };
  }

  if (typeof record.url === "string" && record.url.trim()) {
    const transport = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (transport === "sse" || record.httpTransport === "sse") {
      return {
        ok: false,
        error: "SSE transport is not supported by the PI MCP extension; keep this server in the Mori MCP Hub",
      };
    }
    const headers = stringRecord(record.headers);
    const config: PiMcpHttpServerConfig = {
      type: "http",
      url: record.url.trim(),
      exposure: PI_MCP_HUB_EXPOSURE,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(description ? { description } : {}),
      ...(timeoutSeconds !== undefined ? { timeout: timeoutSeconds } : {}),
    };
    return { ok: true, config };
  }

  return { ok: false, error: "neither command nor url is set" };
}

/**
 * Build the in-memory config the official MCP extension loads.
 *
 * `autoEnableCodemode` is off on purpose: Eco activates `codemode` per session
 * mode instead, so Ask/Plan can never pick it up from a server's exposure.
 */
export function toPiMcpLoadedConfig(mcpServers: Record<string, unknown> | undefined): LoadedMcpConfig {
  const servers: McpServerEntry[] = [];
  const errors: string[] = [];
  if (mcpServers) {
    for (const [name, entry] of Object.entries(mcpServers)) {
      const key = name.trim();
      if (!key) {
        continue;
      }
      const mapped = toPiMcpServerConfig(entry);
      if (!mapped.ok) {
        errors.push(`MCP server "${key}": ${mapped.error}`);
        continue;
      }
      servers.push({
        name: key,
        config: mapped.config,
        source: PI_MCP_SESSION_SOURCE,
        // Eco owns this config for the session; it has no file to save changes to.
        scope: "extension",
      });
    }
  }
  return { servers, autoEnableCodemode: false, errors };
}

/**
 * Session identity for MCP: which servers exist (name, command/args/url).
 * Spawn `env` and HTTP `headers` are excluded — both carry per-thread
 * credentials (`toSpawnEnv()` copies process.env, the Hub injects a fresh
 * bearer token), which are not conversation identity.
 */
function identityPiMcpServerEntry(config: McpServerConfig): Record<string, unknown> {
  const {
    env: _env,
    headers: _headers,
    ...rest
  } = config as McpServerConfig & {
    env?: unknown;
    headers?: unknown;
  };
  return rest;
}

/** Stable fingerprint for which MCP servers are loaded (order-independent; env ignored). */
export function fingerprintPiMcpServers(mcpServers: Record<string, unknown> | undefined): string {
  const config = toPiMcpLoadedConfig(mcpServers);
  return serializeFingerprint(
    config.servers.map((server) => [server.name, identityPiMcpServerEntry(server.config)]),
  );
}

function serializeFingerprint(entries: Array<[string, Record<string, unknown>]>): string {
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    return "";
  }
  return JSON.stringify(entries);
}

/**
 * Re-fingerprint a stored payload so upgrades can resume sessions whose
 * metadata still embedded spawn env or auth tokens.
 */
export function canonicalizePiMcpFingerprint(stored: string): string {
  const raw = stored.trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return raw;
    }
    const entries: Array<[string, Record<string, unknown>]> = [];
    for (const item of parsed) {
      if (!Array.isArray(item) || item.length < 2) {
        return raw;
      }
      const name = item[0];
      if (typeof name !== "string" || !name.trim()) {
        return raw;
      }
      const entry = item[1];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return raw;
      }
      const record = entry as Record<string, unknown>;
      // Current fingerprints already contain the official seconds-based config.
      // Only adapter / Claude-shaped payloads need the milliseconds conversion.
      const official = record.exposure !== undefined && record.requestTimeoutMs === undefined;
      const mapped = toPiMcpServerConfig(official ? { ...record, timeout: undefined } : record);
      if (!mapped.ok) return raw;
      if (
        official &&
        typeof record.timeout === "number" &&
        Number.isFinite(record.timeout) &&
        record.timeout > 0
      ) {
        mapped.config.timeout = record.timeout;
      }
      entries.push([name.trim(), identityPiMcpServerEntry(mapped.config)]);
    }
    return serializeFingerprint(entries);
  } catch {
    return raw;
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return out;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Prefer the adapter-era `requestTimeoutMs`; fall back to the Claude Agent SDK
 * `timeout`, so an Eco sdkEntry can keep setting one field for every runtime.
 * Both are milliseconds; the official extension wants seconds.
 */
function resolveTimeoutSeconds(record: Record<string, unknown>): number | undefined {
  for (const key of ["requestTimeoutMs", "timeout"] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.max(1, Math.ceil(value / 1000));
    }
  }
  return undefined;
}
