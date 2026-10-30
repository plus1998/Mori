import type { GatewayProvider, ResolvedProviderRoute, UpstreamKind } from "./types.js";
import { parseCodexTurnMetadataHeader } from "./codex-turn-metadata.js";

/** Client / Bridge must set this so gateway never guesses provider from model aliases. */
export const GATEWAY_PROVIDER_ID_HEADER = "x-gateway-provider-id";

/**
 * Optional per-request upstream kind override (Bridge may set after resolving apiCompat).
 * Values: anthropic-messages | responses | openai-chat | gateway-delegated
 */
export const GATEWAY_UPSTREAM_KIND_HEADER = "x-gateway-upstream-kind";

/**
 * Optional original client model string (before Bridge rewrites body.model to upstream id).
 * Used only for usage / observability attribution.
 */
export const GATEWAY_REQUESTED_MODEL_HEADER = "x-gateway-requested-model";

/**
 * Optional Eco thread id for prompt-cache routing on Messages→Responses / Chat conversions.
 * Bridge sets this when the active Claude/PI session is thread-bound.
 */
export const GATEWAY_THREAD_ID_HEADER = "x-gateway-thread-id";

/** Claude Bridge binding id — request-scoped attribution for concurrent runs. */
export const GATEWAY_BRIDGE_BINDING_ID_HEADER = "x-eco-bridge-binding-id";

/** Optional Eco run-attempt id carried with Claude Bridge requests. */
export const GATEWAY_RUN_ATTEMPT_ID_HEADER = "x-eco-run-attempt-id";

/** ECO logical request id — Bridge assigns per Messages request for lifecycle tracking. */
export const GATEWAY_LOGICAL_REQUEST_ID_HEADER = "x-eco-logical-request-id";

export class ProviderNotFoundError extends Error {
  readonly status = 404;

  constructor(detail: string) {
    super(`No gateway provider for ${detail}`);
    this.name = "ProviderNotFoundError";
  }
}

export class MissingProviderIdError extends Error {
  readonly status = 400;

  constructor() {
    super(`Missing ${GATEWAY_PROVIDER_ID_HEADER}. Bridge must resolve provider before calling gateway.`);
    this.name = "MissingProviderIdError";
  }
}

export class UnsupportedUpstreamKindError extends Error {
  readonly status = 501;

  constructor(kind: string) {
    super(`Upstream kind not supported: ${kind}`);
    this.name = "UnsupportedUpstreamKindError";
  }
}

/** Route requested OpenAI wire on a Messages-only host (e.g. DeepSeek `/anthropic`). */
export class IncompatibleUpstreamKindError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "IncompatibleUpstreamKindError";
  }
}

export interface ResolveProviderRouteOptions {
  providerId?: string;
  upstreamKindOverride?: string;
  /** Client/SDK model label retained for usage attribution after body.model rewrite. */
  requestedModel?: string;
  bridgeBindingId?: string;
  threadId?: string;
  runAttemptId?: string;
  logicalRequestId?: string;
}

/**
 * Resolve route from explicit provider id + concrete model.
 * Eco model aliases (eco_route_v1 / eco_*__*) are intentionally not parsed here.
 */
export function resolveProviderRoute(
  model: string | undefined,
  providers: readonly GatewayProvider[],
  options?: ResolveProviderRouteOptions,
): ResolvedProviderRoute {
  const providerId = options?.providerId?.trim();
  if (!providerId) {
    throw new MissingProviderIdError();
  }

  const upstreamModelId = model?.trim();
  if (!upstreamModelId) {
    throw new ProviderNotFoundError("model (missing model)");
  }

  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new ProviderNotFoundError(`provider id '${providerId}'`);
  }

  const override = options?.upstreamKindOverride?.trim();
  let upstreamKind = provider.upstreamKind;
  if (override) {
    if (!isUpstreamKind(override)) {
      throw new UnsupportedUpstreamKindError(override);
    }
    upstreamKind = override;
  }

  assertUpstreamKindCompatibleWithProviderPath(provider, upstreamKind);

  const clientRequested = options?.requestedModel?.trim() || upstreamModelId;

  return {
    provider,
    upstreamKind,
    requestedModel: clientRequested,
    // Concrete model ids are forwarded as-is (product layer pre-resolved).
    upstreamModelId,
    ...(options?.bridgeBindingId?.trim() ? { bridgeBindingId: options.bridgeBindingId.trim() } : {}),
    ...(options?.threadId?.trim() ? { threadId: options.threadId.trim() } : {}),
    ...(options?.runAttemptId?.trim() ? { runAttemptId: options.runAttemptId.trim() } : {}),
    ...(options?.logicalRequestId?.trim() ? { logicalRequestId: options.logicalRequestId.trim() } : {}),
  };
}

/** Fail closed: never quietly strip `/anthropic` to send OpenAI payloads at the service root. */
export function assertUpstreamKindCompatibleWithProviderPath(
  provider: Pick<GatewayProvider, "id" | "name" | "requestPath" | "upstreamKind">,
  upstreamKind: UpstreamKind,
): void {
  const path = normalizeRequestPath(provider.requestPath);
  if (!path || !MESSAGES_ONLY_REQUEST_PATHS.has(path)) {
    return;
  }
  if (
    upstreamKind !== "responses" &&
    upstreamKind !== "openai-chat" &&
    upstreamKind !== "gateway-delegated"
  ) {
    return;
  }
  throw new IncompatibleUpstreamKindError(
    `API protocol incompatible with provider path: provider ${provider.name} (${provider.id}) ` +
      `has requestPath ${path} (Anthropic Messages only), but the route requested upstream kind ` +
      `"${upstreamKind}". Switch the route/agent API compat to Anthropic Messages, or use a provider ` +
      `that exposes OpenAI endpoints without the ${path} path. Mori will not silently strip ${path}.`,
  );
}

export function readProviderIdFromHeaders(headers: Pick<Headers, "get">): string | undefined {
  return headers.get(GATEWAY_PROVIDER_ID_HEADER)?.trim() || undefined;
}

export function readUpstreamKindFromHeaders(headers: Pick<Headers, "get">): string | undefined {
  return headers.get(GATEWAY_UPSTREAM_KIND_HEADER)?.trim() || undefined;
}

export function readRequestedModelFromHeaders(headers: Pick<Headers, "get">): string | undefined {
  return headers.get(GATEWAY_REQUESTED_MODEL_HEADER)?.trim() || undefined;
}

export function readThreadIdFromHeaders(headers: Pick<Headers, "get">): string | undefined {
  return headers.get(GATEWAY_THREAD_ID_HEADER)?.trim() || undefined;
}

export function readBridgeBindingIdFromHeaders(headers: Pick<Headers, "get">): string | undefined {
  return headers.get(GATEWAY_BRIDGE_BINDING_ID_HEADER)?.trim() || undefined;
}

export function readRunAttemptIdFromHeaders(headers: Pick<Headers, "get">): string | undefined {
  return headers.get(GATEWAY_RUN_ATTEMPT_ID_HEADER)?.trim() || undefined;
}

export function readLogicalRequestIdFromHeaders(headers: Pick<Headers, "get">): string | undefined {
  return headers.get(GATEWAY_LOGICAL_REQUEST_ID_HEADER)?.trim() || undefined;
}

/** Build route options without writing `undefined` into exact-optional fields. */
export function buildResolveProviderRouteOptions(headers: Pick<Headers, "get">): ResolveProviderRouteOptions {
  const providerId = readProviderIdFromHeaders(headers);
  const upstreamKindOverride = readUpstreamKindFromHeaders(headers);
  const requestedModel = readRequestedModelFromHeaders(headers);
  const bridgeBindingId = readBridgeBindingIdFromHeaders(headers);
  const threadId = readThreadIdFromHeaders(headers);
  const runAttemptId = readRunAttemptIdFromHeaders(headers);
  const logicalRequestId =
    readLogicalRequestIdFromHeaders(headers) ?? parseCodexTurnMetadataHeader(headers)?.turnId?.trim();
  return {
    ...(providerId ? { providerId } : {}),
    ...(upstreamKindOverride ? { upstreamKindOverride } : {}),
    ...(requestedModel ? { requestedModel } : {}),
    ...(bridgeBindingId ? { bridgeBindingId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(runAttemptId ? { runAttemptId } : {}),
    ...(logicalRequestId ? { logicalRequestId } : {}),
  };
}

/** Stable OpenAI/OpenRouter-compatible cache key from Eco thread id. */
export function buildGatewayPromptCacheKey(threadId?: string): string | undefined {
  const trimmed = threadId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9._:-]/g, "_");
  if (!sanitized) {
    return undefined;
  }
  return `eco_thread_${sanitized}`.slice(0, 64);
}

/**
 * Attach Responses/Chat prompt-cache routing when converting Anthropic Messages.
 * Matches desktop bridge `applyResponsesRoutingHints` so PI/Claude Messages face
 * can stabilize prefix cache the same way as Codex Responses traffic.
 */
export function applyGatewayResponsesPromptCacheHints(
  body: Record<string, unknown>,
  input: { providerBaseUrl: string; threadId?: string },
): string | undefined {
  const promptCacheKey = buildGatewayPromptCacheKey(input.threadId);
  if (promptCacheKey === undefined) {
    return undefined;
  }
  if (body.prompt_cache_key === undefined) {
    body.prompt_cache_key = promptCacheKey;
  }
  if (isOpenRouterProviderBaseUrl(input.providerBaseUrl) && body.session_id === undefined) {
    body.session_id = promptCacheKey;
  }
  return typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : promptCacheKey;
}

function isOpenRouterProviderBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return baseUrl.toLowerCase().includes("openrouter.ai");
  }
}

function isUpstreamKind(value: string): value is UpstreamKind {
  return (
    value === "anthropic-messages" ||
    value === "responses" ||
    value === "openai-chat" ||
    value === "gateway-delegated"
  );
}

/** Default OpenAI/Anthropic-style URL version segment. */
export const DEFAULT_API_VERSION = "v1";

/**
 * Normalize API version path segment. Empty/missing → `v1` (including historical rows).
 * Strips surrounding slashes so stored values like `v1` or `/v2/` both work.
 */
export function normalizeApiVersion(version?: string | null): string {
  const trimmed = version?.trim() ?? "";
  if (!trimmed) {
    return DEFAULT_API_VERSION;
  }
  const withoutSlashes = trimmed.replace(/^\/+|\/+$/g, "");
  return withoutSlashes || DEFAULT_API_VERSION;
}

/** Normalize request path prefix (e.g. `/anthropic`). Empty string means API root. */
export function normalizeRequestPath(path?: string): string {
  const trimmed = path?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

/** Path prefixes used only for Anthropic Messages, not OpenAI chat/responses. */
const MESSAGES_ONLY_REQUEST_PATHS = new Set(["/anthropic"]);

/**
 * `/anthropic` is messages-only. Callers must not silently strip it for OpenAI surfaces —
 * validate with `assertUpstreamKindCompatibleWithProviderPath` first.
 */
export function resolveRequestPathForUpstreamKind(
  requestPath: string | undefined,
  upstreamKind: UpstreamKind,
): string {
  const path = normalizeRequestPath(requestPath);
  if (
    path &&
    MESSAGES_ONLY_REQUEST_PATHS.has(path) &&
    (upstreamKind === "openai-chat" || upstreamKind === "responses" || upstreamKind === "gateway-delegated")
  ) {
    throw new IncompatibleUpstreamKindError(
      `Cannot use upstream kind "${upstreamKind}" with requestPath ${path}: ` +
        `this path is Anthropic Messages only. Mori will not silently strip ${path}.`,
    );
  }
  return path;
}

function buildUpstreamRoot(provider: GatewayProvider, upstreamKind: UpstreamKind): string {
  const path = resolveRequestPathForUpstreamKind(provider.requestPath, upstreamKind);
  return `${provider.baseUrl.replace(/\/+$/, "")}${path}`;
}

export function buildUpstreamUrl(provider: GatewayProvider, upstreamKind: UpstreamKind): string {
  const root = buildUpstreamRoot(provider, upstreamKind);
  const version = normalizeApiVersion(provider.version);
  switch (upstreamKind) {
    case "anthropic-messages":
      return `${root}/${version}/messages`;
    case "responses":
    case "gateway-delegated":
      return `${root}/${version}/responses`;
    case "openai-chat":
      return `${root}/${version}/chat/completions`;
    default: {
      const _exhaustive: never = upstreamKind;
      return _exhaustive;
    }
  }
}

/** Native Responses compact endpoint path (product Eco compact intercepts at Desktop Bridge). */
export function buildUpstreamCompactUrl(provider: GatewayProvider): string {
  const version = normalizeApiVersion(provider.version);
  return `${buildUpstreamRoot(provider, "responses")}/${version}/responses/compact`;
}

/** Anthropic count_tokens endpoint sharing the same version segment as messages. */
export function buildUpstreamCountTokensUrl(provider: GatewayProvider): string {
  const version = normalizeApiVersion(provider.version);
  return `${buildUpstreamRoot(provider, "anthropic-messages")}/${version}/messages/count_tokens`;
}

export function mapApiCompatToUpstreamKind(
  apiCompat: "anthropic" | "openai_responses" | "openai_chat_completions",
): UpstreamKind {
  switch (apiCompat) {
    case "anthropic":
      return "anthropic-messages";
    case "openai_responses":
      return "responses";
    case "openai_chat_completions":
      return "openai-chat";
    default: {
      const _exhaustive: never = apiCompat;
      return _exhaustive;
    }
  }
}
