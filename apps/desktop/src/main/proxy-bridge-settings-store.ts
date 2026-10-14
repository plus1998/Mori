import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  type ProxyBridgeSettingsSnapshot,
  UPSTREAM_AGENT_CORES,
  type UpstreamAgentCore,
} from "../shared/ipc";

const PROXY_BRIDGE_SETTINGS_KEY = "proxy_bridge";
const MAX_UPSTREAM_USER_AGENT_LENGTH = 512;

export function defaultProxyBridgeSettings(): ProxyBridgeSettingsSnapshot {
  return {};
}

export async function createProxyBridgeSettingsStore(dbPath: string): Promise<ProxyBridgeSettingsStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new ProxyBridgeSettingsStore(new sqlite.DatabaseSync(dbPath));
  store.initialize();
  return store;
}

export class ProxyBridgeSettingsStore {
  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(): ProxyBridgeSettingsSnapshot {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get(PROXY_BRIDGE_SETTINGS_KEY) as { value_json: string } | undefined;
    if (!row) {
      return defaultProxyBridgeSettings();
    }
    try {
      return normalizeProxyBridgeSettingsSnapshot(JSON.parse(row.value_json) as unknown);
    } catch {
      return defaultProxyBridgeSettings();
    }
  }

  save(snapshot: ProxyBridgeSettingsSnapshot): ProxyBridgeSettingsSnapshot {
    const normalized = normalizeProxyBridgeSettingsSnapshot(snapshot);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workflow_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(PROXY_BRIDGE_SETTINGS_KEY, JSON.stringify(normalized), now);
    return this.get();
  }
}

/** Trim + validate one upstream User-Agent override. Empty means "not configured". */
function normalizeUpstreamUserAgentValue(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("\r") || trimmed.includes("\n")) {
    throw new Error("上游 User-Agent 不能包含换行符。");
  }
  if (trimmed.length > MAX_UPSTREAM_USER_AGENT_LENGTH) {
    throw new Error(`上游 User-Agent 不能超过 ${MAX_UPSTREAM_USER_AGENT_LENGTH} 个字符。`);
  }
  return trimmed;
}

export function normalizeProxyBridgeSettingsSnapshot(value: unknown): ProxyBridgeSettingsSnapshot {
  if (!value || typeof value !== "object") {
    return defaultProxyBridgeSettings();
  }
  const record = value as Record<string, unknown>;
  const result: ProxyBridgeSettingsSnapshot = {};

  if (typeof record.enabled === "boolean") {
    result.enabled = record.enabled;
  }

  const rawUa = normalizeUpstreamUserAgentValue(record.upstreamUserAgent);
  if (rawUa) {
    result.upstreamUserAgent = rawUa;
  }

  const rawUserAgents = record.upstreamUserAgents;
  if (rawUserAgents && typeof rawUserAgents === "object") {
    const perCore: Partial<Record<UpstreamAgentCore, string>> = {};
    for (const core of UPSTREAM_AGENT_CORES) {
      const normalized = normalizeUpstreamUserAgentValue((rawUserAgents as Record<string, unknown>)[core]);
      if (normalized) {
        perCore[core] = normalized;
      }
    }
    if (Object.keys(perCore).length > 0) {
      result.upstreamUserAgents = perCore;
    }
  }

  const rawProxy = typeof record.upstreamProxyUrl === "string" ? record.upstreamProxyUrl.trim() : "";
  if (rawProxy) {
    if (rawProxy.includes("\r") || rawProxy.includes("\n")) {
      throw new Error("上游代理 URL 不能包含换行符。");
    }
    let url: URL;
    try {
      url = new URL(rawProxy);
    } catch {
      throw new Error(`无效的上游代理 URL: ${rawProxy}`);
    }
    const protocol = url.protocol.toLowerCase();
    if (!["http:", "https:", "socks5:", "socks:"].includes(protocol)) {
      throw new Error("代理仅支持 http://、https://、socks5:// 或 socks://");
    }
    if (!url.hostname) {
      throw new Error("上游代理 URL 缺少主机名。");
    }
    result.upstreamProxyUrl = rawProxy;
  }

  return result;
}

export function isProxyBridgeSettingsSnapshot(value: unknown): value is ProxyBridgeSettingsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    return false;
  }
  if (record.upstreamUserAgent !== undefined && typeof record.upstreamUserAgent !== "string") {
    return false;
  }
  if (record.upstreamUserAgents !== undefined) {
    if (!record.upstreamUserAgents || typeof record.upstreamUserAgents !== "object") {
      return false;
    }
    for (const value of Object.values(record.upstreamUserAgents as Record<string, unknown>)) {
      if (value !== undefined && typeof value !== "string") {
        return false;
      }
    }
  }
  if (record.upstreamProxyUrl !== undefined && typeof record.upstreamProxyUrl !== "string") {
    return false;
  }
  return true;
}

/** Resolved override for upstream requests; undefined means passthrough SDK UA. */
export function resolveUpstreamUserAgentOverride(settings: ProxyBridgeSettingsSnapshot): string | undefined {
  const trimmed = settings.upstreamUserAgent?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 按 Agent Core 解析出的 UA 覆盖表；空表返回 undefined。
 * 单个 core 缺省（或清空）= 该项目使用 SDK 自己的 UA。
 */
export function resolveUpstreamUserAgentOverrides(
  settings: ProxyBridgeSettingsSnapshot,
): Partial<Record<UpstreamAgentCore, string>> | undefined {
  const resolved: Partial<Record<UpstreamAgentCore, string>> = {};
  for (const core of UPSTREAM_AGENT_CORES) {
    const trimmed = settings.upstreamUserAgents?.[core]?.trim();
    if (trimmed) {
      resolved[core] = trimmed;
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * 生效的出站代理 URL。开关默认视为开启（enabled !== false）；关闭时返回 undefined。
 * 关闭不会清除已保存的 URL，方便重新开启。
 */
export function resolveOutboundProxyUrl(settings: ProxyBridgeSettingsSnapshot): string | undefined {
  if (settings.enabled === false) {
    return undefined;
  }
  const raw = settings.upstreamProxyUrl?.trim();
  return raw ? raw : undefined;
}
