import type { IncomingHttpHeaders } from "node:http";
import { isOpenAICompat, type UpstreamApiCompat } from "../shared/api-compat";
import { buildAnthropicHeaders, buildOpenAIHeaders } from "./provider-models";

const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_UPSTREAM_USER_AGENT = "Eco-Coding/0.0.0";

/**
 * Eco fallback User-Agent: used only when neither an override nor an SDK UA exists.
 * Carries the app version plus the OS so upstream can attribute the request.
 */
export function buildDefaultUpstreamUserAgent(input: {
  version: string;
  platform: string;
  release: string;
  arch: string;
}): string {
  const version = input.version.trim() || "0.0.0";
  const platform = input.platform.trim() || "unknown";
  const release = input.release.trim();
  const arch = input.arch.trim();
  const os = release ? `${platform} ${release}` : platform;
  return `Eco-Coding/${version} (${arch ? `${os}; ${arch}` : os})`;
}

let injectedDefaultUpstreamUserAgent: string | undefined;

/** Let the host replace the bare fallback constant with a versioned UA. */
export function setDefaultUpstreamUserAgent(value: string | undefined): void {
  const trimmed = value?.trim();
  injectedDefaultUpstreamUserAgent = trimmed ? trimmed : undefined;
}

function fallbackUpstreamUserAgent(): string {
  return injectedDefaultUpstreamUserAgent ?? DEFAULT_UPSTREAM_USER_AGENT;
}

const PASSTHROUGH_HEADER_NAMES = ["accept", "anthropic-beta", "anthropic-version", "user-agent"] as const;

function readHeaderString(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function applyUserAgent(
  headers: Record<string, string>,
  clientHeaders: IncomingHttpHeaders,
  upstreamUserAgent?: string,
): void {
  const override = upstreamUserAgent?.trim();
  if (override) {
    headers["user-agent"] = override;
    return;
  }
  const clientUa = readHeaderString(clientHeaders, "user-agent");
  if (clientUa) {
    headers["user-agent"] = clientUa;
    return;
  }
  headers["user-agent"] = fallbackUpstreamUserAgent();
}

/** Headers for proxy bridge → upstream (SDK client headers + optional global UA override). */
export function buildProxyUpstreamHeaders(input: {
  clientHeaders: IncomingHttpHeaders;
  apiKey: string;
  apiCompat: UpstreamApiCompat;
  upstreamUserAgent?: string;
}): Record<string, string> {
  const { clientHeaders, apiKey, apiCompat, upstreamUserAgent } = input;
  const isOpenAI = isOpenAICompat(apiCompat) || apiCompat === "system_one";
  const headers: Record<string, string> = {
    ...(isOpenAI ? buildOpenAIHeaders(apiKey) : buildAnthropicHeaders(apiKey)),
  };

  if (!isOpenAI) {
    for (const name of PASSTHROUGH_HEADER_NAMES) {
      const value = readHeaderString(clientHeaders, name);
      if (value) {
        headers[name] = value;
      }
    }
    if (!headers["anthropic-version"]) {
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    }
  }

  const contentType = readHeaderString(clientHeaders, "content-type");
  if (contentType) {
    headers["content-type"] = contentType;
  } else if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  applyUserAgent(headers, clientHeaders, upstreamUserAgent);
  return headers;
}

/** Headers for provider test / model list (no SDK client); identifies as Eco unless overridden. */
export function buildProviderDirectUpstreamHeaders(input: {
  apiKey: string;
  apiCompat: UpstreamApiCompat;
  upstreamUserAgent?: string;
}): Record<string, string> {
  const headers = buildProxyUpstreamHeaders({
    clientHeaders: {},
    apiKey: input.apiKey,
    apiCompat: input.apiCompat,
    ...(input.upstreamUserAgent && { upstreamUserAgent: input.upstreamUserAgent }),
  });
  headers["content-type"] = "application/json";
  return headers;
}

/** Convert plain header map to fetch `Headers` (anthropic-proxy). */
export function proxyUpstreamHeadersToFetch(headers: Record<string, string>): Headers {
  const fetchHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    fetchHeaders.set(name, value);
  }
  return fetchHeaders;
}
