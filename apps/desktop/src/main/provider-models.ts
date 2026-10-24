import fs from "node:fs/promises";
import { createUpstreamFetchController } from "@eco/gateway";
import {
  assertApiCompatCompatibleWithProviderPath,
  IncompatibleApiCompatError,
  isMessagesOnlyRequestPath,
  normalizeUpstreamApiCompat,
  resolveUpstreamApiCompat,
  type UpstreamApiCompat,
} from "../shared/api-compat";

/**
 * Codex Auth (auth.json) has no upstream model endpoint. Its list is fetched from
 * the codex-rs models-manager catalog by CodexRemoteModelCatalogService; this layer
 * must not invent one, otherwise a stale constant silently replaces a failed refresh.
 */
export const CODEX_AUTH_MODELS_UNAVAILABLE_ERROR =
  "ChatGPT Login（auth.json）没有上游 /v1/models 接口，模型列表来自 codex-rs models.json，请在「模型设置 → ChatGPT Login」中刷新。";

import type { ThinkingEffort } from "../shared/ipc";
import type {
  ListUpstreamModelsRequest,
  ListUpstreamModelsResult,
  ProviderRequestError,
  RoleRouteTestResult,
  TestProviderConnectionRequest,
  TestProviderConnectionResult,
  TestRoleRouteItem,
  TestRoleRoutesRequest,
  TestRoleRoutesResult,
  UpstreamModelOption,
} from "../shared/models";
import { ROUTE_TEST_THINKING_EFFORT } from "../shared/models";
import {
  buildBridgeProviderTestAnthropicRequest,
  buildBridgeProviderTestUpstreamBody,
  parseBridgeProviderTestReply,
} from "./bridge-provider-test";
import { postJsonWithOpenAIResponsesUnsupportedParameterRetry } from "./openai-responses-compat";
import { parseSystemOneChoiceAnswer, postSystemOneRequest } from "./system-one-request";
import type { ProviderStore } from "./provider-store";
import {
  headersToLoggable,
  logUpstream,
  logUpstreamError,
  parseJsonForLog,
  redactSecret,
  truncateForLog,
} from "./upstream-log";
import { buildProviderDirectUpstreamHeaders } from "./upstream-request-headers";

const ANTHROPIC_VERSION = "2023-06-01";
const PROVIDER_TEST_TIMEOUT_MS = 15_000;
const PROVIDER_TEST_MAX_TOKENS = 256;

export interface ProviderCompatRoutingInfo {
  apiCompat: UpstreamApiCompat;
  /** This code path always uses OpenAI-style model discovery. */
  modelsDiscoveryApi: "openai-get-v1-models";
  /** How agent/provider tests call the upstream. */
  chatApi: "anthropic-v1-messages" | "openai-v1-responses" | "openai-v1-chat-completions" | "system-one";
  requestPath: string;
  chatUrl: string;
  modelsListUrl: string;
  /** Human-readable notes for logs (OpenAI vs Anthropic surfaces). */
  compatNotes: string[];
}

export async function listProviderUpstreamModels(
  store: ProviderStore,
  request: ListUpstreamModelsRequest,
  upstreamUserAgent?: string,
  globalProxyUrl?: string,
): Promise<ListUpstreamModelsResult> {
  logUpstream("models-list-request", {
    providerId: request.providerId,
    baseUrl: request.baseUrl,
    requestPath: request.requestPath,
    version: request.version,
    apiCompat: request.apiCompat,
    hasInlineApiKey: Boolean(request.apiKey?.trim()),
  });

  const resolved = resolveProviderCredentials(store, request);
  if (!resolved.ok) {
    logUpstreamError("models-list-error", {
      phase: "resolve-credentials",
      providerId: request.providerId,
      error: resolved.error,
    });
    return resolved;
  }

  // ChatGPT subscription and Codex Auth providers are resolved in the desktop IPC
  // layer (account pool / codex-rs catalog) before reaching this path. Any other
  // provider still attempts the upstream GET /v1/models (local servers often allow
  // an unauthenticated list) and reports whatever the upstream answers.
  if (!resolved.apiKey.trim() && resolved.authMethod === "auth_json") {
    return {
      ok: false,
      error: CODEX_AUTH_MODELS_UNAVAILABLE_ERROR,
      ...(request.providerId ? { providerId: request.providerId } : {}),
    };
  }

  const routing = describeProviderCompatRouting(
    resolved.baseUrl,
    resolved.requestPath,
    resolved.apiCompat,
    resolved.version,
  );
  logUpstream("models-list-compat-routing", {
    providerId: request.providerId,
    ...routing,
    hasApiKey: Boolean(resolved.apiKey.trim()),
  });

  // Per-provider proxy wins; falls back to the global outbound proxy.
  const proxyUrl = resolved.upstreamProxyUrl || globalProxyUrl;
  return withUpstreamProxyFetch(proxyUrl, fetch, (fetcher) =>
    fetchUpstreamModelsFromCredentials(
      resolved.baseUrl,
      resolved.apiKey,
      resolved.requestPath,
      { ...(request.providerId && { providerId: request.providerId }), routing },
      resolved.apiCompat,
      upstreamUserAgent,
      resolved.version,
      fetcher,
    ),
  );
}

export async function testProviderConnection(
  store: ProviderStore,
  request: TestProviderConnectionRequest,
  fetcher: typeof fetch = fetch,
  upstreamUserAgent?: string,
  globalProxyUrl?: string,
): Promise<TestProviderConnectionResult> {
  const resolved = resolveProviderCredentials(store, request);
  if (!resolved.ok) {
    logUpstream("provider-test-error", {
      phase: "resolve-credentials",
      providerId: request.providerId,
      error: resolved.error,
    });
    return resolved;
  }

  const modelId = request.defaultModel?.trim();
  if (!modelId) {
    logUpstream("provider-test-error", {
      phase: "validate-model",
      providerId: request.providerId,
      baseUrl: resolved.baseUrl,
      error: "请先选择要测试的模型。",
    });
    return { ok: false, error: "请先选择要测试的模型。" };
  }

  const testResult = await withUpstreamProxyFetch(
    resolved.upstreamProxyUrl || globalProxyUrl,
    fetcher,
    (activeFetcher) =>
      postUpstreamCompatTest(
        {
          baseUrl: resolved.baseUrl,
          requestPath: resolved.requestPath,
          version: resolved.version,
          apiCompat: resolved.apiCompat,
          apiKey: resolved.apiKey,
          modelId,
          ...(request.providerId && { providerId: request.providerId }),
        },
        resolveRouteTestThinkingEffort(request.thinkingEffort),
        activeFetcher,
        upstreamUserAgent,
      ),
  );
  if (testResult.ok) {
    return { ok: true, reply: testResult.reply };
  }
  return { ok: false, error: testResult.error };
}

/** Dedupe key for route tests: same provider + model + API compat shares one upstream call. */
export function buildRouteTestDedupeKey(
  providerId: string,
  modelId: string,
  apiCompat: UpstreamApiCompat,
): string {
  return `${providerId.trim()}:${modelId.trim()}:${apiCompat}`;
}

interface RouteTestGroup {
  provider: NonNullable<ReturnType<ProviderStore["getProviderWithSecret"]>>;
  modelId: string;
  apiCompat: UpstreamApiCompat;
  thinkingEffort: ThinkingEffort;
  roles: string[];
}

export async function testRoleRoutes(
  store: ProviderStore,
  request: TestRoleRoutesRequest,
  fetcher: typeof fetch = fetch,
  upstreamUserAgent?: string,
  globalProxyUrl?: string,
): Promise<TestRoleRoutesResult> {
  const resultsByRole = new Map<string, RoleRouteTestResult>();
  const groups = new Map<string, RouteTestGroup>();

  for (const route of request.routes) {
    const modelId = route.modelId?.trim();
    if (!route.providerId?.trim() || !modelId) {
      resultsByRole.set(route.role, {
        role: route.role,
        modelId: modelId ?? "",
        ok: false,
        error: "请先选择 Provider 与模型。",
      });
      continue;
    }

    const provider = store.getProviderWithSecret(route.providerId.trim());
    if (!provider) {
      resultsByRole.set(route.role, {
        role: route.role,
        modelId,
        ok: false,
        error: `找不到 Provider：${route.providerId}`,
      });
      continue;
    }

    if (!provider.enabled) {
      resultsByRole.set(route.role, {
        role: route.role,
        modelId,
        ok: false,
        error: `Provider「${provider.name}」已禁用。`,
      });
      continue;
    }

    const apiCompat = resolveUpstreamApiCompat(
      route.apiCompat ? normalizeUpstreamApiCompat(route.apiCompat) : undefined,
      provider.apiCompat,
    );
    const dedupeKey = buildRouteTestDedupeKey(provider.id, modelId, apiCompat);
    const existing = groups.get(dedupeKey);
    if (existing) {
      existing.roles.push(route.role);
      continue;
    }

    groups.set(dedupeKey, {
      provider,
      modelId,
      apiCompat,
      thinkingEffort: resolveRouteTestThinkingEffort(route.thinkingEffort),
      roles: [route.role],
    });
  }

  for (const group of groups.values()) {
    const labelRole = group.roles[0];
    const testInput = {
      providerId: group.provider.id,
      baseUrl: group.provider.baseUrl,
      requestPath: group.provider.requestPath,
      version: group.provider.version,
      apiCompat: group.apiCompat,
      apiKey: group.provider.apiKey,
      modelId: group.modelId,
      ...(labelRole && { role: labelRole }),
    };
    const testResult = await withUpstreamProxyFetch(
      group.provider.upstreamProxyUrl || globalProxyUrl,
      fetcher,
      (activeFetcher) => postUpstreamCompatTest(testInput, group.thinkingEffort, activeFetcher, upstreamUserAgent),
    );

    const shared: RoleRouteTestResult = testResult.ok
      ? {
          role: labelRole ?? "",
          modelId: group.modelId,
          ok: testResult.ok,
          reply: testResult.reply,
          elapsedMs: testResult.elapsedMs,
        }
      : {
          role: labelRole ?? "",
          modelId: group.modelId,
          ok: testResult.ok,
          error: testResult.error,
          ...(testResult.elapsedMs !== undefined && { elapsedMs: testResult.elapsedMs }),
        };

    for (const role of group.roles) {
      resultsByRole.set(role, { ...shared, role });
    }
  }

  const results = request.routes.map(
    (route) =>
      resultsByRole.get(route.role) ?? {
        role: route.role,
        modelId: route.modelId?.trim() ?? "",
        ok: false,
        error: "未执行测试。",
      },
  );

  const passed = results.filter((result) => result.ok).length;
  return { results, passed, failed: results.length - passed };
}

type MessagesTestSuccess = { ok: true; reply: string; elapsedMs: number };
type MessagesTestFailure = { ok: false; error: string; elapsedMs?: number };
type MessagesTestResult = MessagesTestSuccess | MessagesTestFailure;

async function postUpstreamCompatTest(
  input: {
    providerId?: string;
    baseUrl: string;
    requestPath: string;
    version?: string;
    apiCompat: UpstreamApiCompat;
    apiKey: string;
    modelId: string;
    role?: string;
  },
  thinkingEffort: ThinkingEffort,
  fetcher: typeof fetch,
  upstreamUserAgent?: string,
): Promise<MessagesTestResult> {
  let effectivePath: string;
  try {
    effectivePath = resolveRequestPathForApiCompat(input.requestPath, input.apiCompat);
  } catch (error) {
    if (error instanceof IncompatibleApiCompatError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  if (input.apiCompat === "system_one") {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);
    try {
      const answers = await postSystemOneRequest({
        provider: {
          baseUrl: input.baseUrl,
          requestPath: input.requestPath ?? "",
          version: input.version ?? "v1",
          apiKey: input.apiKey,
        },
        modelId: input.modelId,
        state: "Connection test: choose connected.",
        questions: {
          connection: {
            type: "choice",
            instructions: "Choose connected.",
            criteria: { connected: "The API is reachable.", unavailable: "The API is unavailable." },
          },
        },
        signal: controller.signal,
        fetcher,
      });
      const answer = parseSystemOneChoiceAnswer(answers.connection, ["connected", "unavailable"]);
      return { ok: true, reply: `SystemOne: ${answer.choice} (${answer.confidence})`, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }
  const routing = describeProviderCompatRouting(input.baseUrl, effectivePath, input.apiCompat, input.version);
  const anthropicRequest = buildBridgeProviderTestAnthropicRequest(input.modelId, thinkingEffort);
  let { body: requestBody, preferStream } = buildBridgeProviderTestUpstreamBody(
    input.apiCompat,
    anthropicRequest,
    input.modelId,
  );
  const upstreamUrl =
    input.apiCompat === "openai_chat_completions"
      ? buildChatCompletionsUrl(input.baseUrl, input.requestPath, input.version)
      : input.apiCompat === "openai_responses"
        ? buildOpenAICompatUpstreamUrl(input.baseUrl, input.requestPath, input.version)
        : buildMessagesUrl(input.baseUrl, effectivePath, input.version);
  const requestHeaders = buildProviderDirectUpstreamHeaders({
    apiKey: input.apiKey,
    apiCompat: input.apiCompat,
    ...(upstreamUserAgent ? { upstreamUserAgent } : {}),
  });

  logUpstream("provider-test-start", {
    providerId: input.providerId,
    role: input.role,
    apiCompat: input.apiCompat,
    routing,
    baseUrl: input.baseUrl,
    url: upstreamUrl,
    model: input.modelId,
    hasApiKey: Boolean(input.apiKey.trim()),
    apiKeyPreview: input.apiKey.trim() ? redactSecret(input.apiKey) : undefined,
    requestBody,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    logUpstream("provider-test-request", {
      providerId: input.providerId,
      role: input.role,
      apiCompat: input.apiCompat,
      method: "POST",
      url: upstreamUrl,
      headers: redactRequestHeaders(requestHeaders),
      body: requestBody,
    });

    let response: Response;
    let responseText: string | undefined;
    if (input.apiCompat === "openai_responses") {
      const retryResult = await postJsonWithOpenAIResponsesUnsupportedParameterRetry({
        fetcher,
        url: upstreamUrl,
        headers: requestHeaders,
        body: requestBody,
        signal: controller.signal,
        logContext: {
          providerId: input.providerId,
          role: input.role,
          apiCompat: input.apiCompat,
          phase: "provider-test",
          model: input.modelId,
        },
      });
      response = retryResult.response;
      requestBody = retryResult.requestBody;
      responseText = retryResult.responseText;
    } else {
      response = await fetcher(upstreamUrl, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    }

    const elapsedMs = Date.now() - startedAt;
    logUpstream("provider-test-response", {
      providerId: input.providerId,
      role: input.role,
      status: response.status,
      ok: response.ok,
      elapsedMs,
      headers: headersToLoggable(response.headers),
      preferStream,
    });

    if (!response.ok) {
      const raw = responseText ?? (await response.text());
      const error = formatUpstreamError(response.status, raw);
      logUpstream("provider-test-error", {
        providerId: input.providerId,
        role: input.role,
        phase: "upstream-http",
        status: response.status,
        elapsedMs,
        error,
        bodyRaw: truncateForLog(raw),
      });
      return { ok: false, error, elapsedMs };
    }

    const parsed = await parseBridgeProviderTestReply({
      apiCompat: input.apiCompat,
      modelId: input.modelId,
      anthropicRequest,
      response,
      preferStream,
    });

    if (parsed.upstreamError) {
      const error = `上游错误：${parsed.upstreamError}`;
      logUpstream("provider-test-error", {
        providerId: input.providerId,
        role: input.role,
        phase: "upstream-stream",
        elapsedMs,
        error,
        apiCompat: input.apiCompat,
        preferStream,
      });
      return { ok: false, error, elapsedMs };
    }

    const reply = parsed.reply;
    if (!reply) {
      const error = "上游未返回可识别的 assistant 文本。";
      logUpstream("provider-test-error", {
        providerId: input.providerId,
        role: input.role,
        phase: "parse-assistant-reply",
        elapsedMs,
        error,
        apiCompat: input.apiCompat,
        preferStream,
      });
      return { ok: false, error, elapsedMs };
    }

    logUpstream("provider-test-success", {
      providerId: input.providerId,
      role: input.role,
      elapsedMs,
      model: input.modelId,
      replyPreview: truncateForLog(reply),
      replyLength: reply.length,
      apiCompat: input.apiCompat,
      preferStream,
    });
    return { ok: true, reply, elapsedMs };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (error instanceof Error && error.name === "AbortError") {
      logUpstream("provider-test-error", {
        providerId: input.providerId,
        role: input.role,
        phase: "timeout",
        elapsedMs,
        timeoutMs: PROVIDER_TEST_TIMEOUT_MS,
        error: "请求超时，请检查 baseURL 与网络。",
      });
      return { ok: false, error: "请求超时，请检查 baseURL 与网络。", elapsedMs };
    }
    const message = error instanceof Error ? error.message : String(error);
    logUpstream("provider-test-error", {
      providerId: input.providerId,
      role: input.role,
      phase: "fetch",
      elapsedMs,
      error: message,
      errorName: error instanceof Error ? error.name : undefined,
    });
    return { ok: false, error: message, elapsedMs };
  } finally {
    clearTimeout(timeout);
  }
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

/** Default OpenAI/Anthropic-style URL version segment. */
export const DEFAULT_API_VERSION = "v1";

/**
 * Normalize API version path segment. Empty/missing → `v1` (including historical rows).
 */
export function normalizeApiVersion(version?: string | null): string {
  const trimmed = version?.trim() ?? "";
  if (!trimmed) {
    return DEFAULT_API_VERSION;
  }
  const withoutSlashes = trimmed.replace(/^\/+|\/+$/g, "");
  return withoutSlashes || DEFAULT_API_VERSION;
}

/** Base URL for upstream Anthropic-compatible requests (`baseUrl` + optional `requestPath`). */
export function buildProviderRequestBaseUrl(baseUrl: string, requestPath?: string): string {
  const path = normalizeRequestPath(requestPath);
  if (path) {
    return `${trimTrailingSlash(baseUrl.trim())}${path}`;
  }
  const split = splitBaseUrlAndRequestPath(baseUrl);
  if (split.requestPath) {
    return `${split.baseUrl}${split.requestPath}`;
  }
  return trimTrailingSlash(baseUrl.trim());
}

/** Anthropic Messages API: POST `{requestBase}/{version}/messages`. */
export function buildMessagesUrl(baseUrl: string, requestPath?: string, version?: string): string {
  return `${buildProviderRequestBaseUrl(baseUrl, requestPath)}/${normalizeApiVersion(version)}/messages`;
}

/** OpenAI Responses API: POST `{requestBase}/{version}/responses`. */
export function buildResponsesUrl(baseUrl: string, requestPath?: string, version?: string): string {
  return `${buildProviderRequestBaseUrl(baseUrl, requestPath)}/${normalizeApiVersion(version)}/responses`;
}

/** OpenAI Responses token counting: POST `{requestBase}/{version}/responses/input_tokens`. */
export function buildResponsesInputTokensUrl(
  baseUrl: string,
  requestPath?: string,
  version?: string,
): string {
  return `${buildProviderRequestBaseUrl(
    baseUrl,
    resolveRequestPathForApiCompat(requestPath, "openai_responses"),
  )}/${normalizeApiVersion(version)}/responses/input_tokens`;
}

/** OpenAI Responses runtime/test URL. */
export function buildOpenAICompatUpstreamUrl(
  baseUrl: string,
  requestPath?: string,
  version?: string,
): string {
  return buildResponsesUrl(baseUrl, resolveRequestPathForApiCompat(requestPath, "openai_responses"), version);
}

/** OpenAI Chat Completions runtime/test URL. */
export function buildChatCompletionsUrl(baseUrl: string, requestPath?: string, version?: string): string {
  return `${buildProviderRequestBaseUrl(
    baseUrl,
    resolveRequestPathForApiCompat(requestPath, "openai_chat_completions"),
  )}/${normalizeApiVersion(version)}/chat/completions`;
}

/** `/anthropic` is messages-only; OpenAI surfaces must not silently strip it. */
export function resolveRequestPathForApiCompat(
  requestPath: string | undefined,
  apiCompat: UpstreamApiCompat,
): string {
  const path = normalizeRequestPath(requestPath);
  assertApiCompatCompatibleWithProviderPath({
    apiCompat,
    providerRequestPath: path,
  });
  return path;
}

/** Split legacy baseURL that embedded a path suffix into origin + request path. */
export function splitBaseUrlAndRequestPath(fullUrl: string): { baseUrl: string; requestPath: string } {
  const trimmed = fullUrl.trim();
  if (!trimmed) {
    return { baseUrl: "", requestPath: "" };
  }
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const pathname = parsed.pathname.replace(/\/+$/, "") || "";
    if (!pathname || pathname === "/") {
      return { baseUrl: parsed.origin, requestPath: "" };
    }
    return { baseUrl: parsed.origin, requestPath: pathname };
  } catch {
    return { baseUrl: trimmed, requestPath: "" };
  }
}

/** Trailing path segments that are API endpoints, not service roots (OpenAI-compat gateways). */
const API_ENDPOINT_PATH_SUFFIX_RE = /\/v[\w.-]+\/(?:chat\/completions|responses|messages)$/i;

/** Strip mistaken endpoint suffixes so models discovery hits `{origin}/{version}/models`, not `.../chat/completions/{version}/models`. */
export function stripApiEndpointPathSuffix(pathname: string): string {
  let normalized = pathname.replace(/\/+$/, "") || "";
  if (!normalized || normalized === "/") {
    return "";
  }
  let changed = true;
  while (changed) {
    changed = false;
    if (API_ENDPOINT_PATH_SUFFIX_RE.test(normalized)) {
      normalized = normalized.replace(API_ENDPOINT_PATH_SUFFIX_RE, "").replace(/\/+$/, "") || "";
      changed = true;
    }
  }
  return normalized;
}

/** Normalize a URL or origin+path string to the service root used for GET /v1/models. */
export function serviceRootForModelsDiscovery(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const path = stripApiEndpointPathSuffix(parsed.pathname);
    if (!path) {
      return parsed.origin;
    }
    return `${parsed.origin}${path}`;
  } catch {
    return trimTrailingSlash(trimmed);
  }
}

/**
 * OpenAI-style model discovery: GET `{serviceRoot}/{version}/models`.
 * Includes `requestPath` when it is part of the API root (e.g. OpenCode `/zen`),
 * but not when it is messages-only (e.g. DeepSeek `/anthropic`).
 */
export function buildModelsListUrl(
  baseUrl: string,
  requestPath?: string,
  version?: string,
): string | undefined {
  const resolved = resolveModelsListUrl(baseUrl, requestPath, version);
  return resolved.ok ? resolved.url : undefined;
}

export function resolveModelsListUrl(
  baseUrl: string,
  requestPath?: string,
  version?: string,
): { ok: true; url: string; serviceRoot: string } | { ok: false; error: string } {
  const trimmedBase = baseUrl.trim();
  if (!trimmedBase) {
    return {
      ok: false,
      error: "baseURL 为空，无法拉取模型列表。请填写完整服务地址（例如 https://api.example.com）。",
    };
  }

  const path = normalizeRequestPath(requestPath);
  let root: string;

  if (path) {
    if (!trimmedBase && !isMessagesOnlyRequestPath(path)) {
      return {
        ok: false,
        error: "baseURL 为空，无法与请求路径拼接。请先填写服务根地址。",
      };
    }
    root = isMessagesOnlyRequestPath(path)
      ? trimTrailingSlash(trimmedBase)
      : buildProviderRequestBaseUrl(trimmedBase, path);
  } else {
    const split = splitBaseUrlAndRequestPath(trimmedBase);
    if (split.requestPath && isMessagesOnlyRequestPath(split.requestPath)) {
      root = split.baseUrl;
    } else {
      root = buildProviderRequestBaseUrl(trimmedBase);
    }
  }

  const serviceRoot = serviceRootForModelsDiscovery(root);
  if (!serviceRoot) {
    return {
      ok: false,
      error: "无法从 baseURL 解析服务根地址，请检查是否包含 https:// 与主机名。",
    };
  }

  const url = `${serviceRoot}/${normalizeApiVersion(version)}/models`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: `模型列表 URL 协议无效：${parsed.protocol}` };
    }
  } catch {
    return {
      ok: false,
      error: `无法解析模型列表 URL：${url}。请填写完整的 baseURL（含 https://）。`,
    };
  }

  return { ok: true, url, serviceRoot };
}

/** Log context: OpenAI-style /{version}/models vs chat API (Anthropic Messages or OpenAI Chat). */
export function describeProviderCompatRouting(
  baseUrl: string,
  requestPath?: string,
  apiCompat: UpstreamApiCompat = "anthropic",
  version?: string,
): ProviderCompatRoutingInfo {
  const path = normalizeRequestPath(requestPath);
  const ver = normalizeApiVersion(version);
  const listResolved = resolveModelsListUrl(baseUrl, requestPath, ver);
  const modelsListUrl = listResolved.ok ? listResolved.url : "(invalid)";

  try {
    assertApiCompatCompatibleWithProviderPath({ apiCompat, providerRequestPath: path });
  } catch (error) {
    if (error instanceof IncompatibleApiCompatError) {
      return {
        apiCompat,
        modelsDiscoveryApi: "openai-get-v1-models",
        chatApi:
          apiCompat === "openai_responses"
            ? "openai-v1-responses"
            : apiCompat === "openai_chat_completions"
              ? "openai-v1-chat-completions"
              : "anthropic-v1-messages",
        requestPath: path,
        chatUrl: "(incompatible-config)",
        modelsListUrl,
        compatNotes: [error.message],
      };
    }
    throw error;
  }

  if (apiCompat === "system_one") {
    return {
      apiCompat,
      modelsDiscoveryApi: "openai-get-v1-models",
      chatApi: "system-one",
      requestPath: path,
      chatUrl: buildMessagesUrl(baseUrl.trim(), path, ver).replace(/\/messages$/, "/systemone"),
      modelsListUrl,
      compatNotes: ["SystemOne 决策协议，仅用于审批；模型列表返回 models。"],
    };
  }
  const chatUrl =
    apiCompat === "openai_chat_completions"
      ? buildChatCompletionsUrl(baseUrl.trim(), path, ver)
      : apiCompat === "openai_responses"
        ? buildResponsesUrl(baseUrl.trim(), path, ver)
        : buildMessagesUrl(baseUrl.trim(), path, ver);
  const compatNotes: string[] = [
    `模型列表：OpenAI 兼容 GET /${ver}/models。`,
    apiCompat === "openai_responses"
      ? `对话/测试：OpenAI Responses → POST ${chatUrl}（Anthropic↔Responses 枢纽）`
      : apiCompat === "openai_chat_completions"
        ? `对话/测试：OpenAI Chat Completions → POST ${chatUrl}（经 Responses 桥接 Anthropic 体）`
        : `对话/测试：Anthropic Messages API → POST ${chatUrl}`,
  ];

  if (path && isMessagesOnlyRequestPath(path)) {
    compatNotes.push(
      `OpenAI↔Anthropic 网关：requestPath=${path} 仅用于 Anthropic Messages；模型发现走 /v1/models（不含 ${path}）。` +
        ` 若主代理选了 OpenAI Responses/Chat，会直接拦截并提示错误，不会静默去掉 ${path}。`,
    );
  } else if (path) {
    compatNotes.push(`服务路径前缀 ${path} 将拼接到上述端点之前。`);
  } else {
    compatNotes.push("未配置 requestPath：使用 baseURL 根路径。");
  }

  return {
    apiCompat,
    modelsDiscoveryApi: "openai-get-v1-models",
    chatApi:
      apiCompat === "openai_responses"
        ? "openai-v1-responses"
        : apiCompat === "openai_chat_completions"
          ? "openai-v1-chat-completions"
          : "anthropic-v1-messages",
    requestPath: path,
    chatUrl,
    modelsListUrl,
    compatNotes,
  };
}

export async function fetchUpstreamModelsFromCredentials(
  baseUrl: string,
  apiKey: string,
  requestPath?: string,
  logContext?: { providerId?: string; routing?: ProviderCompatRoutingInfo },
  apiCompat: UpstreamApiCompat = "anthropic",
  upstreamUserAgent?: string,
  version?: string,
  fetcher: typeof fetch = fetch,
): Promise<ListUpstreamModelsResult> {
  const listResolved = resolveModelsListUrl(baseUrl, requestPath, version);
  if (!listResolved.ok) {
    logUpstreamError("models-list-error", {
      phase: "resolve-url",
      providerId: logContext?.providerId,
      baseUrl,
      requestPath: requestPath ?? "",
      error: listResolved.error,
      routing: logContext?.routing,
    });
    return { ok: false, error: listResolved.error };
  }

  const modelsUrl = listResolved.url;

  logUpstream("models-list-fetch", {
    providerId: logContext?.providerId,
    method: "GET",
    url: modelsUrl,
    serviceRoot: listResolved.serviceRoot,
    requestPath: requestPath ?? "",
    apiSurface: "openai-v1-models",
    compatNotes: logContext?.routing?.compatNotes,
    headers: redactRequestHeaders(
      buildProviderDirectUpstreamHeaders({
        apiKey,
        apiCompat,
        ...(upstreamUserAgent ? { upstreamUserAgent } : {}),
      }),
    ),
  });

  try {
    const response = await fetcher(modelsUrl, {
      method: "GET",
      headers: buildProviderDirectUpstreamHeaders({
        apiKey,
        apiCompat,
        ...(upstreamUserAgent ? { upstreamUserAgent } : {}),
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      const error = formatUpstreamError(response.status, raw);
      logUpstreamError("models-list-error", {
        phase: "upstream-http",
        providerId: logContext?.providerId,
        url: modelsUrl,
        status: response.status,
        apiSurface: "openai-v1-models",
        compatNotes: logContext?.routing?.compatNotes,
        bodyPreview: truncateForLog(raw),
        error,
      });
      return { ok: false, error };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      const error = "上游返回了非 JSON 响应。";
      logUpstreamError("models-list-error", {
        phase: "parse-json",
        providerId: logContext?.providerId,
        url: modelsUrl,
        error,
        bodyPreview: truncateForLog(raw),
      });
      return { ok: false, error };
    }

    const models =
      apiCompat === "system_one" ? parseSystemOneModelsPayload(parsed) : parseUpstreamModelsPayload(parsed);
    if (models.length === 0) {
      const error = "上游未返回可用模型列表（data 为空或格式不兼容）。";
      logUpstreamError("models-list-error", {
        phase: "empty-payload",
        providerId: logContext?.providerId,
        url: modelsUrl,
        apiSurface: "openai-v1-models",
        error,
        bodyPreview: truncateForLog(raw),
      });
      return { ok: false, error };
    }

    logUpstream("models-list-success", {
      providerId: logContext?.providerId,
      url: modelsUrl,
      count: models.length,
      modelIds: models.slice(0, 20).map((m) => m.id),
      apiSurface: "openai-v1-models",
    });

    return { ok: true, models: dedupeModels(models) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logUpstreamError("models-list-error", {
      phase: "fetch",
      providerId: logContext?.providerId,
      url: modelsUrl,
      apiSurface: "openai-v1-models",
      compatNotes: logContext?.routing?.compatNotes,
      error: message,
      errorName: error instanceof Error ? error.name : undefined,
    });
    return { ok: false, error: message };
  }
}

export function dedupeUpstreamModels(models: readonly UpstreamModelOption[]): UpstreamModelOption[] {
  return dedupeModels([...models]);
}

export function parseSystemOneModelsPayload(payload: unknown): UpstreamModelOption[] {
  if (!payload || typeof payload !== "object") return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry) => {
    if (!entry || typeof entry.name !== "string" || !entry.name.trim()) return [];
    return [
      {
        id: entry.name.trim(),
        ...(typeof entry.displayName === "string" ? { displayName: entry.displayName } : {}),
      },
    ];
  });
}

export function parseUpstreamModelsPayload(payload: unknown): UpstreamModelOption[] {
  if (!isRecord(payload)) {
    return [];
  }

  const list = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];
  const models: UpstreamModelOption[] = [];

  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }
    const id =
      typeof item.id === "string" ? item.id : typeof item.model === "string" ? item.model : undefined;
    if (!id?.trim()) {
      continue;
    }
    const displayName =
      typeof item.display_name === "string"
        ? item.display_name
        : typeof item.name === "string"
          ? item.name
          : undefined;
    const option: UpstreamModelOption = { id: id.trim() };
    const trimmedDisplayName = displayName?.trim();
    if (trimmedDisplayName) {
      option.displayName = trimmedDisplayName;
    }
    models.push(option);
  }

  return models;
}

export function buildProviderTestRequestBody(modelId: string): Record<string, unknown> {
  return buildMessagesTestRequestBody(modelId, ROUTE_TEST_THINKING_EFFORT);
}

export function buildMessagesTestRequestBody(
  modelId: string,
  thinkingEffort?: ThinkingEffort,
): Record<string, unknown> {
  return buildBridgeProviderTestAnthropicRequest(modelId, thinkingEffort ?? "off") as unknown as Record<
    string,
    unknown
  >;
}

export function buildResponsesTestRequestBody(modelId: string): Record<string, unknown> {
  const anthropicRequest = buildBridgeProviderTestAnthropicRequest(modelId, ROUTE_TEST_THINKING_EFFORT);
  return buildBridgeProviderTestUpstreamBody("openai_responses", anthropicRequest, modelId).body;
}

export function buildChatCompletionsTestRequestBody(modelId: string): Record<string, unknown> {
  const anthropicRequest = buildBridgeProviderTestAnthropicRequest(modelId, ROUTE_TEST_THINKING_EFFORT);
  return buildBridgeProviderTestUpstreamBody("openai_chat_completions", anthropicRequest, modelId).body;
}

const ROUTE_THINKING_EFFORTS = new Set<ThinkingEffort>(["off", "low", "medium", "high", "xhigh", "max"]);

function parseRouteThinkingEffort(value: string | undefined): ThinkingEffort | undefined {
  if (!value) {
    return undefined;
  }
  return ROUTE_THINKING_EFFORTS.has(value as ThinkingEffort) ? (value as ThinkingEffort) : undefined;
}

/** Connectivity tests disable thinking; callers should pass `ROUTE_TEST_THINKING_EFFORT` explicitly. */
function resolveRouteTestThinkingEffort(value: string | undefined): ThinkingEffort {
  if (parseRouteThinkingEffort(value) === ROUTE_TEST_THINKING_EFFORT) {
    return ROUTE_TEST_THINKING_EFFORT;
  }
  return ROUTE_TEST_THINKING_EFFORT;
}

function redactRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "x-api-key" || lower === "authorization") {
      result[key] = redactSecret(value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function resolveProviderCredentials(
  store: ProviderStore,
  request: ListUpstreamModelsRequest | TestProviderConnectionRequest,
):
  | {
      ok: true;
      baseUrl: string;
      requestPath: string;
      version: string;
      apiCompat: UpstreamApiCompat;
      apiKey: string;
      upstreamProxyUrl: string;
      authMethod: "api_key" | "oauth" | "auth_json" | "chatgpt_subscription";
    }
  | ProviderRequestError {
  const baseUrl = request.baseUrl?.trim();
  const inlineApiKey = request.apiKey?.trim();
  const inlineRequestPath = "requestPath" in request ? normalizeRequestPath(request.requestPath) : "";
  const inlineVersion =
    "version" in request && request.version !== undefined ? normalizeApiVersion(request.version) : undefined;

  if (request.providerId) {
    const provider = store.getProviderWithSecret(request.providerId);
    if (!provider) {
      return {
        ok: false,
        error: `找不到 Provider：${request.providerId}`,
        errorCode: "provider_not_found",
        providerId: request.providerId,
      };
    }
    const resolvedBaseUrl = (baseUrl || provider.baseUrl).trim();
    if (!resolvedBaseUrl) {
      return {
        ok: false,
        error: `Provider「${provider.name}」的 baseURL 为空，请在设置中填写服务地址。`,
        errorCode: "provider_base_url_missing",
        providerId: provider.id,
        providerName: provider.name,
      };
    }
    const resolvedRequestPath =
      "requestPath" in request && request.requestPath !== undefined
        ? inlineRequestPath
        : normalizeRequestPath(provider.requestPath);
    const resolvedVersion = inlineVersion ?? normalizeApiVersion(provider.version);
    const resolvedApiKey = inlineApiKey ?? provider.apiKey ?? "";
    const resolvedUpstreamProxyUrl =
      ("upstreamProxyUrl" in request && request.upstreamProxyUrl !== undefined
        ? request.upstreamProxyUrl
        : provider.upstreamProxyUrl) ?? "";
    const resolvedApiCompat = normalizeUpstreamApiCompat(request.apiCompat ?? provider.apiCompat);
    return {
      ok: true,
      baseUrl: resolvedBaseUrl,
      requestPath: resolvedRequestPath,
      version: resolvedVersion,
      apiCompat: resolvedApiCompat,
      apiKey: resolvedApiKey,
      upstreamProxyUrl: resolvedUpstreamProxyUrl,
      authMethod: provider.authMethod ?? "api_key",
    };
  }

  if (!baseUrl) {
    return { ok: false, error: "请先填写 baseURL。", errorCode: "base_url_missing" };
  }

  const inlineApiCompat =
    "apiCompat" in request && request.apiCompat !== undefined
      ? normalizeUpstreamApiCompat(request.apiCompat)
      : "anthropic";
  const inlineUpstreamProxyUrl = request.upstreamProxyUrl?.trim() ?? "";
  return {
    ok: true,
    baseUrl,
    requestPath: inlineRequestPath,
    version: inlineVersion ?? DEFAULT_API_VERSION,
    apiCompat: inlineApiCompat,
    apiKey: inlineApiKey ?? "",
    upstreamProxyUrl: inlineUpstreamProxyUrl,
    authMethod:
      "authMethod" in request && request.authMethod !== undefined ? request.authMethod : "api_key",
  };
}

/**
 * Run `run` with a fetcher that routes through `proxyUrl` (per-provider proxy
 * or the global outbound proxy). Without a proxy, `fallbackFetcher` is used as-is.
 */
export async function withUpstreamProxyFetch<T>(
  proxyUrl: string | undefined,
  fallbackFetcher: typeof fetch,
  run: (fetcher: typeof fetch) => Promise<T>,
): Promise<T> {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return run(fallbackFetcher);
  }
  const controller = createUpstreamFetchController(trimmed);
  try {
    return await run(controller.fetch);
  } finally {
    controller.close();
  }
}

function formatUpstreamError(status: number, raw: string): string {
  const parsed = parseJsonForLog(raw);
  if (isRecord(parsed)) {
    const message =
      (typeof parsed.error === "object" &&
        isRecord(parsed.error) &&
        typeof parsed.error.message === "string" &&
        parsed.error.message) ||
      (typeof parsed.message === "string" && parsed.message) ||
      (typeof parsed.error === "string" && parsed.error);
    if (message) {
      return `上游 ${status}：${message}`;
    }
  }
  const snippet = raw.trim().slice(0, 240);
  return snippet ? `上游 ${status}：${snippet}` : `上游请求失败（HTTP ${status}）。`;
}

export function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  const trimmedKey = apiKey.trim();
  if (trimmedKey) {
    headers["x-api-key"] = trimmedKey;
    headers.authorization = `Bearer ${trimmedKey}`;
  }
  return headers;
}

export function buildOpenAIHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const trimmedKey = apiKey.trim();
  if (trimmedKey) {
    headers.authorization = `Bearer ${trimmedKey}`;
  }
  return headers;
}

function dedupeModels(models: UpstreamModelOption[]): UpstreamModelOption[] {
  const seen = new Set<string>();
  const result: UpstreamModelOption[] = [];
  for (const model of models) {
    if (seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    result.push(model);
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
