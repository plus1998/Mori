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

/**
 * Codex is a child process and does not read macOS SystemConfiguration.
 * Direct mode must also remove inherited proxy variables so it cannot fall
 * back to a proxy from the parent shell.
 */
export function buildCodexProxyEnv(
  source: NodeJS.ProcessEnv,
  proxy: CodexProxyEnvironment = { mode: "inherit" },
): NodeJS.ProcessEnv {
  const env = { ...source };
  if (proxy.mode !== "inherit") {
    for (const key of PROXY_ENV_KEYS) delete env[key];
  }
  const noProxy = mergeNoProxyEntries(source.NO_PROXY, source.no_proxy, CODEX_LOOPBACK_PROXY_BYPASS);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  if (proxy.mode === "proxy") {
    env.HTTPS_PROXY = proxy.url;
    env.HTTP_PROXY = proxy.url;
    env.https_proxy = proxy.url;
    env.http_proxy = proxy.url;
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
