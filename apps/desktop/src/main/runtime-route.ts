import { createHash } from "node:crypto";
import type { ParsedUsage } from "@eco/runtime";
import { resolveUpstreamApiCompat, type UpstreamApiCompat } from "../shared/api-compat";
import type {
  AgentRole,
  PromptImageAttachment,
  RouteManualSpec,
  RuntimeAgentRole,
  ThinkingEffort,
} from "../shared/ipc";
import type { ProviderConfigSecret } from "./provider-store";

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
}

export interface RuntimeRouteProxySource {
  role: RuntimeAgentRole;
  provider: ProviderConfigSecret;
  modelId: string;
  apiCompat?: UpstreamApiCompat;
  thinkingEffort?: ThinkingEffort;
  manualSpec?: RouteManualSpec;
}

export function resolveRouteMaxOutputTokens(manualSpec?: RouteManualSpec): number | undefined {
  const tokens = manualSpec?.maxOutputTokens;
  return tokens !== undefined && tokens > 0 ? tokens : undefined;
}

export function runtimeRouteToProxyRoute(route: RuntimeRouteProxySource): AnthropicProxyRoute {
  const maxOutputTokens = resolveRouteMaxOutputTokens(route.manualSpec);
  return {
    role: route.role,
    provider: route.provider,
    modelId: route.modelId,
    ...(route.apiCompat && { apiCompat: route.apiCompat }),
    ...(route.thinkingEffort && { thinkingEffort: route.thinkingEffort }),
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
  };
}

/** Apply configured per-role output cap before bridge/upstream conversion. */
export function applyRouteMaxOutputTokens(body: Record<string, unknown>, maxOutputTokens?: number): void {
  if (maxOutputTokens === undefined || maxOutputTokens <= 0) {
    return;
  }
  body.max_tokens = maxOutputTokens;
}

export interface AnthropicProxyMessagesRequestInfo {
  role: RuntimeAgentRole;
  modelId: string;
}

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
  usage: ParsedUsage;
  stampedAgentId?: string;
  stampedBillingRole?: RuntimeAgentRole;
  stampedParentToolUseId?: string;
  stampedRunAttemptId?: string;
}

export interface AnthropicProxyResolvedRoute extends AnthropicProxyRoute {
  aliasModelId: string;
  apiCompat: UpstreamApiCompat;
}
export const EXTENDED_CONTEXT_MODEL_SUFFIX = "[1m]";

const EXTENDED_CONTEXT_THRESHOLD_TOKENS = 1_000_000;

export function createModelAlias(role: RuntimeAgentRole, providerId: string, modelId: string): string {
  const digest = createHash("sha256").update(`${role}:${providerId}:${modelId}`).digest("hex").slice(0, 12);
  return `eco-${role}-${digest}`;
}

/** Claude Code extended-context suffix; stripped before upstream routing. */
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

/** SDK-visible alias: append `[1m]` when the configured model supports >= 1M context. */
export function toSdkModelAlias(baseAlias: string, contextTokens?: number): string {
  if (!supportsExtendedContextModelSuffix(contextTokens)) {
    return baseAlias;
  }
  if (baseAlias.endsWith(EXTENDED_CONTEXT_MODEL_SUFFIX)) {
    return baseAlias;
  }
  return `${baseAlias}${EXTENDED_CONTEXT_MODEL_SUFFIX}`;
}

/** Family ids for configured model variants (e.g. gpt-5.4-mini → gpt-5.4). */
export function canonicalModelFamilyIds(modelId: string): readonly string[] {
  const match = modelId.match(/^(?<family>.+)-(?:mini|nano|turbo|fast|lite|small|large|medium|preview)$/i);
  const family = match?.groups?.family?.trim();
  return family ? [family] : [];
}

/** When several roles share one upstream model id, keep attribution deterministic. */
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
  if (byAlias) {
    return byAlias;
  }

  const byExactModelId = routes.filter((route) => route.modelId === requestedModel);
  if (byExactModelId.length === 1) {
    return byExactModelId[0];
  }
  if (byExactModelId.length > 1) {
    return pickSharedUpstreamModelRoute(byExactModelId);
  }

  const familyPrefix = `${requestedModel}-`;
  const byFamilyVariant = routes.filter((route) => route.modelId.startsWith(familyPrefix));
  if (byFamilyVariant.length === 1) {
    return byFamilyVariant[0];
  }
  if (byFamilyVariant.length > 1) {
    return pickSharedUpstreamModelRoute(byFamilyVariant);
  }

  return undefined;
}

/** SDK-visible model list: eco aliases only (no bare upstream ids). */
export function buildModelsListResponse(routes: readonly AnthropicProxyResolvedRoute[]): {
  data: Array<{ id: string; display_name: string; type: string }>;
  has_more: boolean;
  first_id: string;
  last_id: string;
} {
  const seen = new Set<string>();
  const data: Array<{ id: string; display_name: string; type: string }> = [];

  for (const route of routes) {
    if (seen.has(route.aliasModelId)) {
      continue;
    }
    seen.add(route.aliasModelId);
    data.push({
      id: route.aliasModelId,
      display_name: `${route.role} · ${route.provider.name}`,
      type: "model",
    });
  }

  const firstId = data[0]?.id ?? "";
  const lastId = data[data.length - 1]?.id ?? firstId;
  return { data, has_more: false, first_id: firstId, last_id: lastId };
}
/** Rough token estimate from count_tokens / messages request JSON (chars / 4). */
export function estimateInputTokensFromAnthropicBody(body: Record<string, unknown>): number {
  const parts: string[] = [];
  if (typeof body.system === "string") {
    parts.push(body.system);
  } else if (Array.isArray(body.system)) {
    parts.push(JSON.stringify(body.system));
  }
  if (Array.isArray(body.tools)) {
    parts.push(JSON.stringify(body.tools));
  }
  if (Array.isArray(body.messages)) {
    parts.push(JSON.stringify(body.messages));
  }
  const text = parts.join("\n");
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function injectImagesIntoMessagesBody(
  body: Record<string, unknown>,
  images: readonly PromptImageAttachment[],
): void {
  const messages = body.messages;
  if (!Array.isArray(messages) || images.length === 0) {
    return;
  }

  let targetIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user") {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) {
    return;
  }

  const message = messages[targetIndex];
  if (!isRecord(message)) {
    return;
  }

  const imageBlocks = images.map((image) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: image.mediaType,
      data: image.data,
    },
  }));

  const existing = message.content;
  if (typeof existing === "string") {
    message.content = [...imageBlocks, { type: "text", text: existing }];
    return;
  }

  if (Array.isArray(existing)) {
    message.content = [...imageBlocks, ...existing];
    return;
  }

  message.content = imageBlocks;
}
