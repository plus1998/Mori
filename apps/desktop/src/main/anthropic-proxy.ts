import { createHash, randomUUID } from "node:crypto";
import { mapApiCompatToUpstreamKind, type ResolvedProviderRoute, type UpstreamKind } from "@eco/gateway";
import {
  applyThinkingToMessagesBody,
  type GlobalMaxOutputTokens,
  type ParsedUsage,
  resolveAppliedMaxOutputTokens,
} from "@eco/runtime";
import { containsImageInput } from "@eco/shared";
import {
  assertApiCompatCompatibleWithProviderPath,
  IncompatibleApiCompatError,
  resolveUpstreamApiCompat,
  type UpstreamApiCompat,
} from "../shared/api-compat";
import type {
  AgentRole,
  PromptImageAttachment,
  RouteManualSpec,
  RuntimeAgentRole,
  ThinkingEffort,
} from "../shared/ipc";
import type { UpstreamModelOption } from "../shared/models";
import { normalizeProviderTokenCountMode } from "../shared/provider-token-count";
import {
  type ClaudeBridgeBinding,
  type ClaudeBridgeBindingRoute,
  type ClaudeBridgeMessagesRequestResult,
  extractClaudeBridgeCredential,
  globalClaudeBridgeBindingRegistry,
  readClaudeBridgeMessagesRequestLogicalId,
  unauthorizedClaudeBridgeResponse,
} from "./claude-bridge-binding";
import { ensureGlobalEcoGateway, getGlobalEcoBridgeBaseUrl } from "./eco-gateway-lifecycle";
import type { BridgeRouteResolution } from "./eco-sdk-bridge";
import { dedupeUpstreamModels, fetchUpstreamModelsFromCredentials } from "./provider-models";
import type { ProviderConfigSecret } from "./provider-store";
import { countProviderInputTokens } from "./provider-token-counter";
import { applyProxyCchToAnthropicMessagesBody, isProxyCchAuditEnabled } from "./proxy-cch-audit";
import {
  buildModelsListResponse as buildModelsListResponseImpl,
  estimateInputTokensFromAnthropicBody as estimateInputTokensFromAnthropicBodyImpl,
  injectImagesIntoMessagesBody as injectImagesIntoMessagesBodyImpl,
} from "./runtime-route";

export {
  createStreamingUsageTracker,
  extractUsageFromResponseBody,
} from "./anthropic-usage";

export {
  ECO_BRIDGE_BINDING_ID_HEADER,
  ECO_BRIDGE_RUN_ATTEMPT_ID_HEADER,
  LOCAL_PROXY_API_KEY,
  redactClaudeBridgeSecret,
} from "./claude-bridge-binding";

/** Resolved Claude messages route metadata returned with Bridge prepare/forward. */
export interface ClaudeMessagesRouteEntry {
  role: RuntimeAgentRole;
  providerId: string;
  providerApiKey: string;
  providerBaseUrl: string;
  providerName: string;
  modelId: string;
  aliasModelId: string;
  apiCompat: UpstreamApiCompat;
  thinkingEffort?: ThinkingEffort;
  maxOutputTokens?: number;
  bindingId: string;
}
export interface AnthropicProxyRoute {
  role: RuntimeAgentRole;
  provider: ProviderConfigSecret;
  modelId: string;
  apiCompat?: UpstreamApiCompat;
  thinkingEffort?: ThinkingEffort;
  /** From RouteManualSpec; injected as Anthropic max_tokens on forwarded messages requests. */
  maxOutputTokens?: number;
  /** Resolved catalog/manual context window; drives SDK `[1m]` alias suffix when >= 1M. */
  contextTokens?: number;
  contextTokensResolved?: boolean;
  compactionContextTokens?: number;
  supportsImageInput?: boolean;
}

export interface RuntimeRouteProxySource {
  role: RuntimeAgentRole;
  provider: ProviderConfigSecret;
  modelId: string;
  apiCompat?: UpstreamApiCompat;
  thinkingEffort?: ThinkingEffort;
  manualSpec?: RouteManualSpec;
}

function rejectDisabledImageInput(
  route: AnthropicProxyRoute,
  body: Record<string, unknown>,
  hasPendingImages = false,
): Response | undefined {
  if (route.supportsImageInput !== false || (!hasPendingImages && !containsImageInput(body))) {
    return undefined;
  }
  return Response.json(
    {
      error: {
        type: "invalid_request_error",
        code: "image_input_disabled",
        message: `模型 ${route.modelId} 已关闭视觉，禁止直接读取图片。请在提供商的模型设置中启用视觉，或选择支持图片的视觉模型。`,
      },
    },
    { status: 400 },
  );
}

export function resolveRouteMaxOutputTokens(manualSpec?: RouteManualSpec): number | undefined {
  const tokens = manualSpec?.maxOutputTokens;
  return tokens !== undefined && tokens > 0 ? tokens : undefined;
}

export interface RuntimeRouteToProxyOptions {
  globalMaxOutputTokens?: GlobalMaxOutputTokens;
  contextTokens?: number;
  contextTokensResolved?: boolean;
  compactionContextTokens?: number;
  catalogMaxOutputTokens?: number;
}

export function runtimeRouteToProxyRoute(
  route: RuntimeRouteProxySource,
  options?: RuntimeRouteToProxyOptions,
): AnthropicProxyRoute {
  resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat);
  const modelMax =
    resolveRouteMaxOutputTokens(route.manualSpec) ??
    (options?.catalogMaxOutputTokens !== undefined && options.catalogMaxOutputTokens > 0
      ? Math.floor(options.catalogMaxOutputTokens)
      : undefined);
  const maxOutputTokens = resolveAppliedMaxOutputTokens({
    ...(modelMax !== undefined && { modelMaxOutputTokens: modelMax }),
    ...(options?.globalMaxOutputTokens !== undefined && {
      globalMaxOutputTokens: options.globalMaxOutputTokens,
    }),
    ...(options?.contextTokens !== undefined && { contextTokens: options.contextTokens }),
    ...(options?.contextTokensResolved !== undefined && {
      contextTokensResolved: options.contextTokensResolved,
    }),
  });
  return {
    role: route.role,
    provider: route.provider,
    modelId: route.modelId,
    ...(route.apiCompat && { apiCompat: route.apiCompat }),
    ...(route.thinkingEffort && { thinkingEffort: route.thinkingEffort }),
    maxOutputTokens,
    ...(route.manualSpec?.supportsImageInput !== undefined && {
      supportsImageInput: route.manualSpec.supportsImageInput,
    }),
    ...(options?.contextTokens !== undefined && { contextTokens: options.contextTokens }),
    ...(options?.compactionContextTokens !== undefined && {
      compactionContextTokens: options.compactionContextTokens,
    }),
  };
}

/** Apply configured per-role output cap before bridge/upstream conversion. */
export function applyRouteMaxOutputTokens(body: Record<string, unknown>, maxOutputTokens?: number): void {
  if (maxOutputTokens === undefined || maxOutputTokens <= 0) {
    return;
  }
  const requested = body.max_tokens;
  body.max_tokens =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.min(requested, maxOutputTokens)
      : maxOutputTokens;
}

/** Preserve product-declared role limits without treating the SDK's default as a model limit. */
export function resolveGatewayBindingModelLimits(route: ResolvedProviderRoute):
  | {
      contextTokens?: number;
      maxOutputTokens?: number;
      compactionContextTokens?: number;
    }
  | undefined {
  if (!route.bridgeBindingId) return undefined;
  const binding = globalClaudeBridgeBindingRegistry.getByBindingId(route.bridgeBindingId);
  if (!binding) throw new Error(`Missing model-limit binding for ${route.requestedModel}.`);
  const boundRoute = resolveProxyRoute(binding.routes, route.requestedModel);
  if (
    !boundRoute ||
    boundRoute.provider.id !== route.provider.id ||
    boundRoute.modelId !== route.upstreamModelId
  ) {
    throw new Error(`Model-limit binding does not match ${route.requestedModel}.`);
  }
  const compact = Boolean(
    route.logicalRequestId && binding.compactionLogicalRequestIds.has(route.logicalRequestId),
  );
  if (
    compact &&
    (!Number.isSafeInteger(boundRoute.compactionContextTokens) ||
      (boundRoute.compactionContextTokens ?? 0) < 2)
  ) {
    throw new Error(`Compaction requires a resolved model context capacity for ${route.upstreamModelId}.`);
  }
  return {
    ...(boundRoute.contextTokens !== undefined && { contextTokens: boundRoute.contextTokens }),
    ...(boundRoute.maxOutputTokens !== undefined && { maxOutputTokens: boundRoute.maxOutputTokens }),
    ...(compact && { compactionContextTokens: boundRoute.compactionContextTokens }),
  };
}

export interface AnthropicProxyMessagesRequestInfo {
  role: RuntimeAgentRole;
  modelId: string;
  requestHeaders?: Headers;
}

export type AnthropicProxyMessagesRequestResult = ClaudeBridgeMessagesRequestResult;

export interface AnthropicProxyUsageInfo {
  role: RuntimeAgentRole;
  providerId: string;
  providerName: string;
  providerBaseUrl: string;
  modelId: string;
  apiCompat: UpstreamApiCompat;
  requestedModel?: string;
  aliasModelId?: string;
  requestId?: string;
  /** Bridge logical request id — joins feed spans to the ledger rows of the same turn. */
  logicalRequestId?: string;
  /** Gateway-measured time to first upstream response chunk (ms), new-api TTFT. */
  ttftMs?: number;
  /** Gateway-measured first-chunk → stream-end window (ms), new-api generationMs. */
  generationMs?: number;
  /** Gateway-measured network RTT estimate (ms): upstream start → first headers. */
  firstHeadersMs?: number;
  /** Gateway-measured time to first text token delta (ms): upstream start → first token. */
  firstTokenMs?: number;
  downstreamMessageId?: string;
  usage: ParsedUsage;
  stampedAgentId?: string;
  stampedBillingRole?: RuntimeAgentRole;
  stampedParentToolUseId?: string;
  stampedRunAttemptId?: string;
}

export type AnthropicProxyUsageHandler = (info: AnthropicProxyUsageInfo) => void | Promise<unknown>;

export interface AnthropicProxyStartOptions {
  threadId?: string;
  runAttemptId?: string;
  pendingImages?: readonly PromptImageAttachment[];
  resolveCountTokensInput?: (input: {
    role: RuntimeAgentRole;
    body: Record<string, unknown>;
  }) => number | undefined;
  upstreamUserAgent?: string;
  onMessagesRequest?: (info: AnthropicProxyMessagesRequestInfo) => AnthropicProxyMessagesRequestResult | void;
  onUsage?: AnthropicProxyUsageHandler;
}

export interface AnthropicProxyResolvedRoute extends AnthropicProxyRoute {
  aliasModelId: string;
  apiCompat: UpstreamApiCompat;
}

export interface StartedAnthropicProxy {
  apiKey: string;
  baseUrl: string;
  routes: AnthropicProxyResolvedRoute[];
  bindingId: string;
  close(): Promise<void>;
}

/**
 * Register Claude routes as an isolated bridge binding (no shared active session).
 * ANTHROPIC_BASE_URL points at Bridge; each run gets a unique 256-bit credential.
 */
export async function startAnthropicModelProxy(
  routes: readonly AnthropicProxyRoute[],
  options?: AnthropicProxyStartOptions,
): Promise<StartedAnthropicProxy> {
  await ensureGlobalEcoGateway();
  const baseUrl = getGlobalEcoBridgeBaseUrl();

  const resolvedRoutes: AnthropicProxyResolvedRoute[] = routes.map((route) => ({
    role: route.role,
    provider: route.provider,
    modelId: route.modelId,
    apiCompat: resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat),
    aliasModelId: toSdkModelAlias(
      createModelAlias(route.role, route.provider.id, route.modelId),
      route.contextTokens,
    ),
    ...(route.thinkingEffort && { thinkingEffort: route.thinkingEffort }),
    ...(route.maxOutputTokens !== undefined && { maxOutputTokens: route.maxOutputTokens }),
    ...(route.contextTokens !== undefined && { contextTokens: route.contextTokens }),
    ...(route.contextTokensResolved !== undefined && { contextTokensResolved: route.contextTokensResolved }),
    ...(route.compactionContextTokens !== undefined && {
      compactionContextTokens: route.compactionContextTokens,
    }),
    ...(route.supportsImageInput !== undefined && { supportsImageInput: route.supportsImageInput }),
  }));

  const bindingRoutes: ClaudeBridgeBindingRoute[] = resolvedRoutes.map((route) => ({
    role: route.role,
    provider: route.provider,
    modelId: route.modelId,
    aliasModelId: route.aliasModelId,
    apiCompat: route.apiCompat,
    ...(route.thinkingEffort ? { thinkingEffort: route.thinkingEffort } : {}),
    ...(route.maxOutputTokens !== undefined ? { maxOutputTokens: route.maxOutputTokens } : {}),
    ...(route.contextTokens !== undefined ? { contextTokens: route.contextTokens } : {}),
    ...(route.compactionContextTokens !== undefined
      ? { compactionContextTokens: route.compactionContextTokens }
      : {}),
    ...(route.supportsImageInput !== undefined ? { supportsImageInput: route.supportsImageInput } : {}),
  }));

  const binding = globalClaudeBridgeBindingRegistry.create({
    routes: bindingRoutes,
    pendingImages: normalizePendingImages(options?.pendingImages),
    ...(options?.threadId?.trim() ? { threadId: options.threadId.trim() } : {}),
    ...(options?.runAttemptId?.trim() ? { runAttemptId: options.runAttemptId.trim() } : {}),
    callbacks: {
      ...(options?.resolveCountTokensInput
        ? { resolveCountTokensInput: options.resolveCountTokensInput }
        : {}),
      ...(options?.onMessagesRequest ? { onMessagesRequest: options.onMessagesRequest } : {}),
      ...(options?.onUsage ? { onUsage: options.onUsage } : {}),
    },
  });

  let closed = false;
  return {
    apiKey: binding.credential,
    baseUrl,
    routes: resolvedRoutes,
    bindingId: binding.bindingId,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await globalClaudeBridgeBindingRegistry.close(binding.bindingId);
    },
  };
}

/** Product-layer: list SDK-visible Claude model aliases. */
export function buildModelsListResponse(routes: readonly AnthropicProxyResolvedRoute[]): {
  data: Array<{ id: string; display_name: string; type: string }>;
  has_more: boolean;
  first_id: string;
  last_id: string;
} {
  return buildModelsListResponseImpl(routes);
}

export function estimateInputTokensFromAnthropicBody(body: Record<string, unknown>): number {
  return estimateInputTokensFromAnthropicBodyImpl(body);
}

export function injectImagesIntoMessagesBody(
  body: Record<string, unknown>,
  images: readonly PromptImageAttachment[],
): void {
  injectImagesIntoMessagesBodyImpl(body, images);
}

export function normalizeThinkingEffortFields(body: Record<string, unknown>): void {
  const thinking = body.thinking;
  if (!isRecord(thinking) || thinking.type !== "disabled") {
    return;
  }

  delete body.reasoning_effort;
  delete body.effort;
  const outputConfig = body.output_config;
  if (isRecord(outputConfig)) {
    delete outputConfig.effort;
  }
}

/**
 * Product prepare for Claude Messages face on Bridge.
 * Credential → unique binding; unknown/missing/revoked credentials return 401.
 */
export async function prepareClaudeBridgeMessagesRequest(input: {
  path: string;
  body: Record<string, unknown>;
  requestedModel: string | undefined;
  headers?: Headers;
}): Promise<
  | { kind: "response"; response: Response }
  | {
      kind: "forward";
      resolution: BridgeRouteResolution;
      clientModel: string;
      role: RuntimeAgentRole;
      entry: ClaudeMessagesRouteEntry;
      /** Eco thread for gateway prompt_cache_key (PI / Claude multi-tool turns). */
      threadId?: string;
      bridgeBindingId: string;
      runAttemptId?: string;
      releaseLease: () => void;
    }
  | { kind: "miss" }
> {
  const credential = extractClaudeBridgeCredential(input.headers ?? new Headers());
  const binding = globalClaudeBridgeBindingRegistry.getByCredential(credential);
  if (!binding) {
    return {
      kind: "response",
      response: unauthorizedClaudeBridgeResponse(
        credential
          ? "Unknown or revoked Claude bridge credential."
          : "Missing Claude bridge credential (x-api-key / Authorization).",
      ),
    };
  }

  if (!globalClaudeBridgeBindingRegistry.acquire(binding)) {
    return {
      kind: "response",
      response: unauthorizedClaudeBridgeResponse("Claude bridge binding is closing."),
    };
  }

  const releaseLease = (() => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      globalClaudeBridgeBindingRegistry.release(binding);
    };
  })();

  try {
    return await prepareAgainstBinding(
      binding,
      {
        path: input.path,
        body: input.body,
        requestedModel: input.requestedModel,
        ...(input.headers ? { headers: input.headers } : {}),
      },
      releaseLease,
    );
  } catch (error) {
    releaseLease();
    throw error;
  }
}

/**
 * Binding-credential forward for Responses / Chat Completions faces.
 * Resolves provider via explicit binding routes (never guesses from model alone).
 * Messages face continues to use prepareClaudeBridgeMessagesRequest (images/thinking).
 */
export async function prepareGatewayBindingForwardRequest(input: {
  face: "responses" | "chat_completions";
  body: Record<string, unknown>;
  requestedModel: string | undefined;
  headers?: Headers;
}): Promise<
  | { kind: "response"; response: Response }
  | {
      kind: "forward";
      resolution: BridgeRouteResolution;
      clientModel: string;
      threadId?: string;
      bridgeBindingId: string;
      runAttemptId?: string;
      logicalRequestId?: string;
      releaseLease: () => void;
    }
  | { kind: "miss" }
> {
  const credential = extractClaudeBridgeCredential(input.headers ?? new Headers());
  if (!credential) {
    return { kind: "miss" };
  }
  const binding = globalClaudeBridgeBindingRegistry.getByCredential(credential);
  if (!binding) {
    return {
      kind: "response",
      response: unauthorizedClaudeBridgeResponse("Unknown or revoked Gateway bridge credential."),
    };
  }
  if (!globalClaudeBridgeBindingRegistry.acquire(binding)) {
    return {
      kind: "response",
      response: unauthorizedClaudeBridgeResponse("Gateway bridge binding is closing."),
    };
  }
  const releaseLease = (() => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      globalClaudeBridgeBindingRegistry.release(binding);
    };
  })();

  try {
    const sessionRoutes = binding.routes as AnthropicProxyResolvedRoute[];
    const route = resolveProxyRoute(sessionRoutes, input.requestedModel);
    if (!route) {
      releaseLease();
      return {
        kind: "response",
        response: Response.json(
          {
            error: `No provider route configured for model ${input.requestedModel ?? "<missing>"}.`,
            available_models: [...new Set(sessionRoutes.map((entry) => entry.aliasModelId))],
          },
          { status: 400 },
        ),
      };
    }

    const imageRejection = rejectDisabledImageInput(route, input.body);
    if (imageRejection) {
      releaseLease();
      return { kind: "response", response: imageRejection };
    }

    // Responses is the conversion hub: the gateway can convert Responses IR to
    // openai_responses, openai_chat_completions, or anthropic upstream wire formats.
    // Chat Completions is passthrough-only and must match openai_chat_completions.
    if (input.face === "chat_completions" && route.apiCompat !== "openai_chat_completions") {
      releaseLease();
      return {
        kind: "response",
        response: Response.json(
          {
            error: {
              message:
                `Binding route apiCompat=${route.apiCompat} is incompatible with face=${input.face}. ` +
                `Expected openai_chat_completions.`,
            },
          },
          { status: 400 },
        ),
      };
    }

    const clientModel =
      (typeof input.requestedModel === "string" && input.requestedModel.trim()) || route.aliasModelId;
    const onMessagesRequest = binding.callbacks.onMessagesRequest;
    let logicalRequestId: string | undefined;
    if (onMessagesRequest) {
      const result = onMessagesRequest({
        role: route.role,
        modelId: route.modelId,
        ...(input.headers ? { requestHeaders: input.headers } : {}),
      });
      logicalRequestId = readClaudeBridgeMessagesRequestLogicalId(result);
    }

    return {
      kind: "forward",
      resolution: {
        providerId: route.provider.id,
        upstreamModelId: route.modelId,
        upstreamKind: mapApiCompatToUpstreamKind(
          resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat),
        ),
      },
      clientModel,
      bridgeBindingId: binding.bindingId,
      ...(binding.threadId.trim() ? { threadId: binding.threadId } : {}),
      ...(binding.runAttemptId ? { runAttemptId: binding.runAttemptId } : {}),
      ...(logicalRequestId ? { logicalRequestId } : {}),
      releaseLease,
    };
  } catch (error) {
    releaseLease();
    throw error;
  }
}

async function prepareAgainstBinding(
  binding: ClaudeBridgeBinding,
  input: {
    path: string;
    body: Record<string, unknown>;
    requestedModel: string | undefined;
    headers?: Headers;
  },
  releaseLease: () => void,
): Promise<
  | { kind: "response"; response: Response }
  | {
      kind: "forward";
      resolution: BridgeRouteResolution;
      clientModel: string;
      role: RuntimeAgentRole;
      entry: ClaudeMessagesRouteEntry;
      threadId?: string;
      bridgeBindingId: string;
      runAttemptId?: string;
      releaseLease: () => void;
    }
> {
  const sessionRoutes = binding.routes as AnthropicProxyResolvedRoute[];

  if (input.path === "/v1/models") {
    const response = Response.json(buildModelsListResponse(sessionRoutes));
    releaseLease();
    return { kind: "response", response };
  }

  const route = resolveProxyRoute(sessionRoutes, input.requestedModel);
  if (!route) {
    releaseLease();
    return {
      kind: "response",
      response: Response.json(
        {
          error: `No provider route configured for model ${input.requestedModel ?? "<missing>"}.`,
          available_models: [...new Set(sessionRoutes.map((entry) => entry.aliasModelId))],
        },
        { status: 400 },
      ),
    };
  }

  const body = input.body;
  const countTokens = input.path.includes("count_tokens");
  // Native gateway hint, authenticated by this binding; never infer from prompt text
  // or a session-wide "compacting" flag (background requests can overlap turns).
  const compact = input.headers?.get("x-claude-code-request-class") === "compaction";

  const imageRejection = rejectDisabledImageInput(
    route,
    body,
    binding.pendingImages.length > 0 && !binding.imagesInjected,
  );
  if (imageRejection) {
    releaseLease();
    return { kind: "response", response: imageRejection };
  }

  if (binding.pendingImages.length > 0 && !binding.imagesInjected) {
    // count_tokens may run before the real messages call — inject a view of the
    // pending images into this request body only; do not consume pending state.
    injectImagesIntoMessagesBody(body, binding.pendingImages);
    if (!countTokens) {
      binding.imagesInjected = true;
      binding.pendingImages = [];
    }
  }

  if (!countTokens) {
    applyThinkingToMessagesBody(body, route.thinkingEffort);
    normalizeThinkingEffortFields(body);
    applyRouteMaxOutputTokens(body, route.maxOutputTokens);
  }

  const afterCch = applyProxyCchToAnthropicMessagesBody(body, {
    ...(isProxyCchAuditEnabled()
      ? {
          onAudit: (phase, audit) => {
            if (audit.hitCount > 0 || phase === "sdk") {
              process.stderr.write(
                `[eco-bridge] proxy-cch-audit phase=${phase} role=${route.role} hits=${audit.hitCount} uniqueCch=${audit.uniqueCchValues.join(",") || "(none)"}\n`,
              );
            }
          },
        }
      : {}),
  });
  if (afterCch !== body) {
    for (const key of Object.keys(body)) {
      delete body[key];
    }
    Object.assign(body, afterCch);
  }

  if (countTokens) {
    const override = resolveCountTokensOverride(body, route.role, binding.callbacks.resolveCountTokensInput);
    const tokenCount =
      override !== undefined
        ? {
            tokens: override,
            precision: "heuristic" as const,
            source: "eco:resolveCountTokensInput_override",
          }
        : await countProviderInputTokens({
            mode: normalizeProviderTokenCountMode(route.provider.tokenCountMode),
            provider: route.provider,
            apiCompat: resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat),
            modelId: route.modelId,
            anthropicBody: body,
          });
    releaseLease();
    return {
      kind: "response",
      response: Response.json({ input_tokens: tokenCount.tokens }),
    };
  }

  let logicalRequestId: string | undefined;
  if (binding.callbacks.onMessagesRequest) {
    const result = binding.callbacks.onMessagesRequest({
      role: route.role,
      modelId: route.modelId,
      ...(input.headers ? { requestHeaders: input.headers } : {}),
    });
    logicalRequestId = readClaudeBridgeMessagesRequestLogicalId(result);
  }

  try {
    assertApiCompatCompatibleWithProviderPath({
      apiCompat: resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat),
      providerRequestPath: route.provider.requestPath,
      providerId: route.provider.id,
      providerName: route.provider.name,
    });
  } catch (error) {
    if (error instanceof IncompatibleApiCompatError) {
      releaseLease();
      return {
        kind: "response",
        response: Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: error.message,
            },
          },
          { status: error.status },
        ),
      };
    }
    throw error;
  }

  const upstreamKind = mapApiCompatToUpstreamKind(
    resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat) as
      | "anthropic"
      | "openai_responses"
      | "openai_chat_completions",
  ) as UpstreamKind;

  body.model = route.modelId;
  if (compact) {
    logicalRequestId ??= `compact_${randomUUID()}`;
    binding.compactionLogicalRequestIds.add(logicalRequestId);
  }
  const compactRequestId = compact ? logicalRequestId : undefined;
  return {
    kind: "forward",
    resolution: {
      providerId: route.provider.id,
      upstreamModelId: route.modelId,
      upstreamKind,
    },
    clientModel: input.requestedModel?.trim() || route.aliasModelId,
    role: route.role,
    bridgeBindingId: binding.bindingId,
    ...(binding.threadId ? { threadId: binding.threadId } : {}),
    ...(binding.runAttemptId ? { runAttemptId: binding.runAttemptId } : {}),
    ...(logicalRequestId ? { logicalRequestId } : {}),
    releaseLease: () => {
      if (compactRequestId) binding.compactionLogicalRequestIds.delete(compactRequestId);
      releaseLease();
    },
    entry: {
      role: route.role,
      providerId: route.provider.id,
      providerApiKey: route.provider.apiKey,
      providerBaseUrl: route.provider.baseUrl,
      providerName: route.provider.name,
      modelId: route.modelId,
      aliasModelId: route.aliasModelId,
      apiCompat: route.apiCompat,
      bindingId: binding.bindingId,
      ...(route.thinkingEffort ? { thinkingEffort: route.thinkingEffort } : {}),
      ...(route.maxOutputTokens !== undefined ? { maxOutputTokens: route.maxOutputTokens } : {}),
    },
  };
}

/**
 * Map gateway messages usage back to the owning Claude binding.
 * Prefer explicit bridgeBindingId; never guess via a global active session.
 * When logicalRequestId is provided with a stamp resolver, request-time agentId
 * is preferred over role-only billing stamp registry inference.
 */
export async function emitClaudeGatewayUsageIfSession(input: {
  providerId: string;
  requestedModel: string;
  upstreamModelId: string;
  usage: ParsedUsage;
  requestId?: string;
  bridgeBindingId?: string;
  logicalRequestId?: string;
  ttftMs?: number;
  generationMs?: number;
  firstHeadersMs?: number;
  firstTokenMs?: number;
  stampedAgentId?: string;
  stampedBillingRole?: RuntimeAgentRole;
  stampedParentToolUseId?: string;
}): Promise<boolean> {
  const binding = input.bridgeBindingId
    ? globalClaudeBridgeBindingRegistry.getByBindingId(input.bridgeBindingId)
    : undefined;
  if (!binding?.callbacks.onUsage) {
    return false;
  }
  // Closing bindings still accept late usage until removed from the registry.
  const routes = binding.routes as AnthropicProxyResolvedRoute[];
  const route = resolveClaudeSessionUsageRoute(routes, input);
  if (!route) {
    return false;
  }
  const work = Promise.resolve(
    binding.callbacks.onUsage({
      role: route.role,
      providerId: route.provider.id,
      providerName: route.provider.name,
      providerBaseUrl: route.provider.baseUrl,
      modelId: route.modelId,
      apiCompat: route.apiCompat,
      aliasModelId: route.aliasModelId,
      requestedModel: input.requestedModel,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.logicalRequestId?.trim() ? { logicalRequestId: input.logicalRequestId.trim() } : {}),
      ...(input.ttftMs !== undefined && { ttftMs: input.ttftMs }),
      ...(input.generationMs !== undefined && { generationMs: input.generationMs }),
      ...(input.firstHeadersMs !== undefined && { firstHeadersMs: input.firstHeadersMs }),
      ...(input.firstTokenMs !== undefined && { firstTokenMs: input.firstTokenMs }),
      ...(binding.runAttemptId ? { stampedRunAttemptId: binding.runAttemptId } : {}),
      ...(input.stampedAgentId?.trim() ? { stampedAgentId: input.stampedAgentId.trim() } : {}),
      ...(input.stampedBillingRole ? { stampedBillingRole: input.stampedBillingRole } : {}),
      ...(input.stampedParentToolUseId?.trim()
        ? { stampedParentToolUseId: input.stampedParentToolUseId.trim() }
        : {}),
      usage: input.usage,
    }),
  );
  globalClaudeBridgeBindingRegistry.trackSettle(binding, work);
  await work;
  return true;
}

/** Prefer exact alias / model match within the event provider; never cross-providers. */
export function resolveClaudeSessionUsageRoute(
  routes: readonly AnthropicProxyResolvedRoute[],
  input: {
    providerId: string;
    requestedModel: string;
    upstreamModelId: string;
  },
): AnthropicProxyResolvedRoute | undefined {
  const requested = input.requestedModel.trim();
  const upstream = input.upstreamModelId.trim();
  const providerId = input.providerId.trim();
  if (!providerId) {
    return undefined;
  }

  const providerMatches = routes.filter((entry) => entry.provider.id === providerId);
  if (providerMatches.length === 0) {
    return undefined;
  }

  if (requested) {
    const byAlias = resolveProxyRoute(providerMatches, requested);
    if (byAlias) {
      return byAlias;
    }
  }

  const exactModel = providerMatches.find(
    (entry) =>
      entry.modelId === upstream ||
      entry.modelId === requested ||
      entry.aliasModelId === requested ||
      stripExtendedContextModelSuffix(entry.modelId) === stripExtendedContextModelSuffix(upstream) ||
      stripExtendedContextModelSuffix(entry.modelId) === stripExtendedContextModelSuffix(requested),
  );
  if (exactModel) {
    return exactModel;
  }

  // Single registered route for this provider → bind usage (multi-model session must exact-match).
  if (providerMatches.length === 1) {
    return providerMatches[0];
  }
  return undefined;
}

export function createModelAlias(role: RuntimeAgentRole, providerId: string, modelId: string): string {
  const digest = createHash("sha256").update(`${role}:${providerId}:${modelId}`).digest("hex").slice(0, 12);
  return `eco-${role}-${digest}`;
}

export const EXTENDED_CONTEXT_MODEL_SUFFIX = "[1m]";
const EXTENDED_CONTEXT_THRESHOLD_TOKENS = 1_000_000;
const MAX_PENDING_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function stripExtendedContextModelSuffix(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.endsWith(EXTENDED_CONTEXT_MODEL_SUFFIX)) {
    return trimmed.slice(0, -EXTENDED_CONTEXT_MODEL_SUFFIX.length);
  }
  return trimmed;
}

export function supportsExtendedContextModelSuffix(contextTokens?: number): boolean {
  return contextTokens !== undefined && contextTokens >= EXTENDED_CONTEXT_THRESHOLD_TOKENS;
}

export function toSdkModelAlias(baseAlias: string, contextTokens?: number): string {
  if (!supportsExtendedContextModelSuffix(contextTokens)) {
    return baseAlias;
  }
  if (baseAlias.endsWith(EXTENDED_CONTEXT_MODEL_SUFFIX)) {
    return baseAlias;
  }
  return `${baseAlias}${EXTENDED_CONTEXT_MODEL_SUFFIX}`;
}

export function canonicalModelFamilyIds(modelId: string): readonly string[] {
  const match = modelId.match(/^(?<family>.+)-(?:mini|nano|turbo|fast|lite|small|large|medium|preview)$/i);
  const family = match?.groups?.family?.trim();
  return family ? [family] : [];
}

const SHARED_UPSTREAM_MODEL_ROLE_PRIORITY: readonly AgentRole[] = [
  "explore",
  "coder",
  "tester",
  "architect",
  "reviewer",
  "main",
];

function pickSharedUpstreamModelRoute(
  routes: readonly AnthropicProxyResolvedRoute[],
): AnthropicProxyResolvedRoute | undefined {
  if (routes.length === 0) {
    return undefined;
  }
  const uniqueModelIds = new Set(routes.map((route) => route.modelId));
  if (uniqueModelIds.size !== 1) {
    return undefined;
  }
  for (const role of SHARED_UPSTREAM_MODEL_ROLE_PRIORITY) {
    const match = routes.find((route) => route.role === role);
    if (match) {
      return match;
    }
  }
  return routes[0];
}

export function resolveProxyRoute(
  routes: readonly AnthropicProxyResolvedRoute[],
  requestedModel: string | undefined,
): AnthropicProxyResolvedRoute | undefined {
  if (!requestedModel) return undefined;

  const normalizedRequest = stripExtendedContextModelSuffix(requestedModel);
  const byAlias = routes.find(
    (route) =>
      route.aliasModelId === requestedModel ||
      stripExtendedContextModelSuffix(route.aliasModelId) === normalizedRequest,
  );
  if (byAlias) return byAlias;

  const byModelId = routes.filter(
    (route) => route.modelId === requestedModel || route.modelId === normalizedRequest,
  );
  if (byModelId.length === 1) return byModelId[0];
  if (byModelId.length > 1) {
    return pickSharedUpstreamModelRoute(byModelId);
  }

  const familyMatches = routes.filter((route) =>
    canonicalModelFamilyIds(route.modelId).some(
      (family) => family === requestedModel || family === normalizedRequest,
    ),
  );
  if (familyMatches.length === 1) return familyMatches[0];
  if (familyMatches.length > 1) {
    return pickSharedUpstreamModelRoute(familyMatches);
  }
  return undefined;
}

export async function listProviderModelsForProxy(
  provider: ProviderConfigSecret,
): Promise<UpstreamModelOption[]> {
  const result = await fetchUpstreamModelsFromCredentials(
    provider.baseUrl,
    provider.apiKey,
    provider.requestPath,
    { providerId: provider.id },
    provider.apiCompat,
  );
  if (!result.ok) {
    return [];
  }
  return dedupeUpstreamModels(result.models);
}

/**
 * Bridge resolve helper — credential-scoped; never falls back to a global active session.
 */
export function resolveClaudeBridgeRoute(
  model: string | undefined,
  headers: Headers,
):
  | {
      providerId: string;
      upstreamModelId: string;
      upstreamKind: UpstreamKind;
      entry: ClaudeMessagesRouteEntry;
    }
  | undefined {
  const credential = extractClaudeBridgeCredential(headers);
  const binding = globalClaudeBridgeBindingRegistry.getByCredential(credential);
  if (binding?.state !== "active") {
    return undefined;
  }
  const route = resolveProxyRoute(binding.routes as AnthropicProxyResolvedRoute[], model);
  if (!route) {
    return undefined;
  }
  const resolvedApiCompat = resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat);
  assertApiCompatCompatibleWithProviderPath({
    apiCompat: resolvedApiCompat,
    providerRequestPath: route.provider.requestPath,
    providerId: route.provider.id,
    providerName: route.provider.name,
  });
  const upstreamKind = mapApiCompatToUpstreamKind(
    resolvedApiCompat as "anthropic" | "openai_responses" | "openai_chat_completions",
  ) as UpstreamKind;
  return {
    providerId: route.provider.id,
    upstreamModelId: route.modelId,
    upstreamKind,
    entry: {
      role: route.role,
      providerId: route.provider.id,
      providerApiKey: route.provider.apiKey,
      providerBaseUrl: route.provider.baseUrl,
      providerName: route.provider.name,
      modelId: route.modelId,
      aliasModelId: route.aliasModelId,
      apiCompat: route.apiCompat,
      bindingId: binding.bindingId,
      ...(route.thinkingEffort ? { thinkingEffort: route.thinkingEffort } : {}),
      ...(route.maxOutputTokens !== undefined ? { maxOutputTokens: route.maxOutputTokens } : {}),
    },
  };
}

function resolveCountTokensOverride(
  body: Record<string, unknown>,
  role: RuntimeAgentRole,
  resolve?: ClaudeBridgeBinding["callbacks"]["resolveCountTokensInput"],
): number | undefined {
  const fromHook = resolve?.({ role, body });
  if (fromHook === undefined) {
    return undefined;
  }
  if (typeof fromHook !== "number" || !Number.isFinite(fromHook) || fromHook < 0) {
    throw new Error("resolveCountTokensInput 返回了无效 token 数。");
  }
  return Math.trunc(fromHook);
}

function normalizePendingImages(
  images: readonly PromptImageAttachment[] | undefined,
): PromptImageAttachment[] {
  if (!images?.length) {
    return [];
  }
  const normalized: PromptImageAttachment[] = [];
  for (const image of images.slice(0, MAX_PENDING_IMAGES)) {
    const data = image.data?.trim();
    if (!data || !image.mediaType) {
      continue;
    }
    const byteLength = Buffer.byteLength(data, "base64");
    if (byteLength > MAX_IMAGE_BYTES) {
      continue;
    }
    normalized.push({ mediaType: image.mediaType, data });
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
