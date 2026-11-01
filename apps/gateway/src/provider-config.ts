import { normalizeApiVersion, normalizeRequestPath } from "./provider-router.js";
import { parseUpstreamProxyUrl, type UpstreamProxyRoute } from "./upstream-proxy.js";
import type { GatewayConfig, GatewayProvider } from "./types.js";

const DEFAULT_PORT = 18_765;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseProvidersFromEnv(): GatewayProvider[] | null {
  const raw = process.env.ECO_GATEWAY_PROVIDERS?.trim();
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as GatewayProvider[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("ECO_GATEWAY_PROVIDERS must be a non-empty JSON array");
  }
  return parsed.map(normalizeProvider);
}

export function normalizeProvider(provider: GatewayProvider): GatewayProvider {
  if (!provider.id?.trim()) {
    throw new Error("Gateway provider id is required");
  }
  if (!provider.baseUrl?.trim()) {
    throw new Error(`Gateway provider ${provider.id}: baseUrl is required`);
  }
  if (!provider.upstreamModelId?.trim()) {
    throw new Error(`Gateway provider ${provider.id}: upstreamModelId is required`);
  }
  const models = provider.models?.length ? provider.models : [provider.upstreamModelId];
  const modelMaxOutputTokens = normalizeModelMaxOutputTokens(provider.modelMaxOutputTokens);
  const requestPath = normalizeRequestPath(provider.requestPath);
  const version = normalizeApiVersion(provider.version);
  const upstreamProxyUrl = parseUpstreamProxyUrl(provider.upstreamProxyUrl);
  const modelUpstreams = provider.modelUpstreams
    ? Object.fromEntries(Object.entries(provider.modelUpstreams).map(([modelId, upstream]) => {
        if (!models.includes(modelId) || !modelId.trim()) {
          throw new Error(`Gateway provider ${provider.id}: unknown model upstream ${modelId}`);
        }
        const baseUrl = upstream.baseUrl?.trim();
        if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
          throw new Error(`Gateway provider ${provider.id}: invalid endpoint for ${modelId}`);
        }
        return [modelId, {
          ...upstream,
          baseUrl: trimTrailingSlash(baseUrl),
          requestPath: normalizeRequestPath(upstream.requestPath),
          version: normalizeApiVersion(upstream.version),
        }];
      }))
    : undefined;
  const { requestPath: _ignoredRequestPath, modelMaxOutputTokens: _ignoredMax, upstreamProxyUrl: _ignoredProxy, ...rest } = provider;
  return {
    ...rest,
    baseUrl: trimTrailingSlash(provider.baseUrl),
    version,
    models,
    ...(modelUpstreams ? { modelUpstreams } : {}),
    ...(provider.authMethod ? { authMethod: provider.authMethod } : {}),
    ...(provider.credentialPoolId?.trim() ? { credentialPoolId: provider.credentialPoolId.trim() } : {}),
    ...(requestPath ? { requestPath } : {}),
    ...(upstreamProxyUrl ? { upstreamProxyUrl } : {}),
    ...(modelMaxOutputTokens ? { modelMaxOutputTokens } : {}),
  };
}

/**
 * Per-provider proxy routes for the outbound fetch controller.
 * Providers without a proxy contribute no entry (global proxy fallback applies).
 * When two providers share an origin, the last provider wins.
 */
export function buildProviderProxyRoutes(
  providers: readonly GatewayProvider[],
): UpstreamProxyRoute[] {
  const byOrigin = new Map<string, string>();
  for (const provider of providers) {
    const proxyUrl = parseUpstreamProxyUrl(provider.upstreamProxyUrl);
    if (!proxyUrl) {
      continue;
    }
    for (const baseUrl of [
      provider.baseUrl,
      ...Object.values(provider.modelUpstreams ?? {}).map((model) => model.baseUrl),
    ]) {
      try {
        byOrigin.set(new URL(baseUrl).origin, proxyUrl);
      } catch {
        // The normalizer reports invalid configured endpoints before routing.
      }
    }
  }
  return [...byOrigin.entries()].map(([origin, proxyUrl]) => ({ origin, proxyUrl }));
}

function normalizeModelMaxOutputTokens(
  value: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!value) {
    return undefined;
  }
  const normalized: Record<string, number> = {};
  for (const [modelId, tokens] of Object.entries(value)) {
    const trimmedModelId = modelId.trim();
    if (!trimmedModelId || !Number.isFinite(tokens) || tokens <= 0) {
      continue;
    }
    normalized[trimmedModelId] = Math.floor(tokens);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Phase 0 static table used when ECO_GATEWAY_PROVIDERS is unset (tests / local dev). */
export function defaultProviders(): GatewayProvider[] {
  return [
    {
      id: "anthropic",
      name: "Anthropic (fixture)",
      upstreamKind: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "fixture-key",
      upstreamModelId: "claude-sonnet-4-20250514",
      models: ["claude-sonnet-4-20250514"],
    },
    {
      id: "openai",
      name: "OpenAI Responses (fixture)",
      upstreamKind: "responses",
      baseUrl: "https://api.openai.com",
      apiKey: "fixture-key",
      upstreamModelId: "gpt-4.1",
      models: ["gpt-4.1"],
    },
  ];
}

export function loadGatewayConfig(): GatewayConfig {
  const host = process.env.ECO_GATEWAY_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(process.env.ECO_GATEWAY_PORT ?? String(DEFAULT_PORT), 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid ECO_GATEWAY_PORT: ${process.env.ECO_GATEWAY_PORT}`);
  }

  const providers = parseProvidersFromEnv() ?? defaultProviders();
  const proxyRaw = process.env.ECO_GATEWAY_PROXY_URL?.trim();
  return {
    host,
    port,
    providers,
    ...(proxyRaw ? { upstreamProxyUrl: proxyRaw } : {}),
  };
}
