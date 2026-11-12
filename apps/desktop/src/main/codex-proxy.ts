import type { OpenAIAccountProxyConfig } from "../shared/openai-account";

export type CodexProxyEnvironment = { mode: "inherit" } | { mode: "direct" } | { mode: "proxy"; url: string };

export type SystemProxyResolver = () => string | undefined | Promise<string | undefined>;

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "WS_PROXY",
  "WSS_PROXY",
  "ws_proxy",
  "wss_proxy",
] as const;

const CODEX_LOOPBACK_PROXY_BYPASS = ["127.0.0.1", "localhost", "::1"] as const;

/** Convert Chromium's resolveProxy() result into a URL Codex can consume. */
export function parseElectronProxyResolution(resolution: string): string | undefined {
  for (const entry of resolution.split(";")) {
    const [kind = "", ...addressParts] = entry.trim().split(/\s+/u);
    const address = addressParts.join(" ").trim();
    if (kind === "DIRECT") return undefined;
    if (!address) continue;
    const protocol =
      kind === "SOCKS" || kind === "SOCKS5"
        ? "socks5:"
        : kind === "PROXY" || kind === "HTTP" || kind === "HTTPS"
          ? "http:"
          : undefined;
    if (!protocol) continue;
    try {
      const parsed = new URL(`${protocol}//${address}`);
      if (!parsed.hostname) continue;
      return parsed.toString().replace(/\/$/u, "");
    } catch {}
  }
  return undefined;
}

/** Manual proxies take precedence; system mode resolves through Chromium/OS settings. */
export async function resolveCodexProxyUrl(
  config: OpenAIAccountProxyConfig,
  resolveSystemProxy?: SystemProxyResolver,
): Promise<string | undefined> {
  if (config.mode === "direct") return undefined;
  if (config.mode === "manual") {
    const proxyUrl = config.proxyUrl?.trim();
    if (!proxyUrl) throw new Error("Manual proxy mode requires a proxy URL.");
    return proxyUrl;
  }
  if (!resolveSystemProxy) return undefined;
  const resolution = await resolveSystemProxy();
  return resolution === undefined ? undefined : parseElectronProxyResolution(resolution);
}

/** Keep Codex's own OS proxy selection/fallback from overriding Mori's resolved route. */
export function buildCodexProxyArgs(proxy: CodexProxyEnvironment): string[] {
  return proxy.mode === "inherit"
    ? []
    : ["-c", "features.respect_system_proxy=false", "-c", "features.system_proxy_fallback=false"];
}

/** Explicit routes must not inherit shell proxy endpoints or NO_PROXY bypasses. */
export function buildCodexProxyEnv(
  source: NodeJS.ProcessEnv,
  proxy: CodexProxyEnvironment = { mode: "inherit" },
): NodeJS.ProcessEnv {
  const env = { ...source };
  if (proxy.mode !== "inherit") {
    for (const key of PROXY_ENV_KEYS) delete env[key];
  }
  const noProxy =
    proxy.mode === "inherit"
      ? mergeNoProxyEntries(source.NO_PROXY, source.no_proxy, CODEX_LOOPBACK_PROXY_BYPASS)
      : proxy.mode === "direct"
        ? "*"
        : CODEX_LOOPBACK_PROXY_BYPASS.join(",");
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  if (proxy.mode === "proxy") {
    for (const key of PROXY_ENV_KEYS) env[key] = proxy.url;
  }
  return env;
}

function mergeNoProxyEntries(...sources: readonly (string | readonly string[] | undefined)[]): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const values = Array.isArray(source) ? source : typeof source === "string" ? source.split(",") : [];
    for (const value of values) {
      const trimmed = value.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      entries.push(trimmed);
    }
  }
  return entries.join(",");
}
