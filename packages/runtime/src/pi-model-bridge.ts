import type { ResolvedModelRoute } from "../../model-router/src";
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT,
  DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS,
  type GlobalMaxOutputTokens,
  resolveAppliedMaxOutputTokens,
  resolveEffectiveContextLimit,
} from "./models-dev-limits.js";
import { isThinkingEffort } from "./thinking-options.js";

/** Eco apiCompat → Pi KnownApi. */
export type EcoPiApi = "anthropic-messages" | "openai-responses" | "openai-completions";

export type EcoApiCompat = "anthropic" | "openai_responses" | "openai_chat_completions";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * PI treats `xhigh` / `max` as opt-in. Missing map entries make
 * `clampThinkingLevel("max")` fall back to `high`.
 */
export type EcoPiThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

/**
 * Subset of PI `Model.compat` Eco may set. Prefer omitting unknown flags —
 * especially Anthropic `supportsMidConvoEffort` (Gateway is not a faithful
 * first-party Claude transport; enabling it risks signed-thinking / effort
 * system-message 400s). See pi coding-agent docs/models.md.
 */
export type EcoPiModelCompat = {
  supportsMaxOutputTokens?: boolean;
};

export const ECO_PI_EXTENDED_THINKING_LEVEL_MAP = {
  xhigh: "xhigh",
  max: "max",
} as const satisfies EcoPiThinkingLevelMap;

/** Eco thinkingEffort → PI thinkingLevel. Unknown / unset fail closed to off. */
export function mapEcoThinkingEffortToPiThinkingLevel(effort: string | undefined): PiThinkingLevel {
  if (!effort || !isThinkingEffort(effort) || effort === "off") {
    return "off";
  }
  return effort;
}

/**
 * Pi `Model` shape without importing `@earendil-works/pi-ai` at module top-level
 * (keeps availability probe free of heavy optional deps during tests).
 */
export interface EcoPiModelSpec {
  id: string;
  name: string;
  api: EcoPiApi;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  /** Required for PI to keep Eco `xhigh` / `max`; omitted when reasoning is off. */
  thinkingLevelMap?: EcoPiThinkingLevelMap;
  /**
   * PI model `compat` overrides. Eco does **not** set `supportsMidConvoEffort`:
   * pi docs require the exact Claude model on a faithful Anthropic Messages
   * transport; Eco Bridge/Gateway is not that surface and must not imitate it.
   */
  compat?: EcoPiModelCompat;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
}

export interface BuildEcoPiModelInput {
  /** Eco bridge / gateway face base URL (e.g. http://127.0.0.1:18765). */
  bridgeBaseUrl: string;
  /**
   * Model id as seen by the Eco Bridge face (route alias).
   */
  bridgeModelId: string;
  /**
   * Eco provider id used only for diagnostics; Pi auth uses apiCompat-mapped provider
   * against the local bridge with the attempt-scoped binding credential.
   */
  route?: ResolvedModelRoute;
  /** Explicit apiCompat; falls back to route.apiCompat then anthropic. */
  apiCompat?: EcoApiCompat;
  contextWindow?: number;
  maxOutputTokens?: number;
  globalMaxOutputTokens?: GlobalMaxOutputTokens;
  /** Eco global context cap; PI compaction uses min(model, this). */
  globalContextWindowLimit?: number;
  /** Request headers for binding id / provider / attempt attribution. */
  headers?: Record<string, string>;
}

export function mapApiCompatToPiApi(apiCompat: EcoApiCompat): EcoPiApi {
  switch (apiCompat) {
    case "anthropic":
      return "anthropic-messages";
    case "openai_responses":
      return "openai-responses";
    case "openai_chat_completions":
      return "openai-completions";
    default: {
      const _exhaustive: never = apiCompat;
      return _exhaustive;
    }
  }
}

export function mapApiCompatToPiAuthProvider(apiCompat: EcoApiCompat): string {
  switch (apiCompat) {
    case "anthropic":
      return "anthropic";
    case "openai_responses":
    case "openai_chat_completions":
      return "openai";
    default: {
      const _exhaustive: never = apiCompat;
      return _exhaustive;
    }
  }
}

export function mapApiCompatToGatewayFacePath(apiCompat: EcoApiCompat): string {
  switch (apiCompat) {
    case "anthropic":
      return "/v1/messages";
    case "openai_responses":
      return "/v1/responses";
    case "openai_chat_completions":
      return "/v1/chat/completions";
    default: {
      const _exhaustive: never = apiCompat;
      return _exhaustive;
    }
  }
}

/**
 * Map an Eco planner route onto a Pi model that talks the apiCompat-native wire
 * format to Eco Bridge / Gateway. Upstream secrets and conversion stay on Gateway.
 */
export function buildEcoPiModel(input: BuildEcoPiModelInput): EcoPiModelSpec {
  const baseUrl = input.bridgeBaseUrl.replace(/\/+$/, "");
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    throw new Error(`PI bridge baseUrl must be HTTP(S): ${input.bridgeBaseUrl}`);
  }
  const bridgeModelId = input.bridgeModelId.trim();
  if (!bridgeModelId) {
    throw new Error("PI bridge model id is required.");
  }

  const apiCompat = resolveEcoApiCompat(input.apiCompat, input.route);
  const api = mapApiCompatToPiApi(apiCompat);
  const provider = mapApiCompatToPiAuthProvider(apiCompat);
  const thinkingLevel = mapEcoThinkingEffortToPiThinkingLevel(input.route?.thinkingEffort);

  const declaredContextWindow =
    input.contextWindow ?? input.route?.primary.contextWindow ?? DEFAULT_CONTEXT_LIMIT;
  const contextWindow = resolveEffectiveContextLimit(
    declaredContextWindow,
    input.globalContextWindowLimit ?? DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT,
  );
  const maxTokens = resolveAppliedMaxOutputTokens({
    ...(input.maxOutputTokens !== undefined && { modelMaxOutputTokens: input.maxOutputTokens }),
    globalMaxOutputTokens: input.globalMaxOutputTokens ?? DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS,
    contextTokens: contextWindow,
  });

  return {
    id: bridgeModelId,
    name: bridgeModelId,
    api,
    provider,
    baseUrl,
    reasoning: thinkingLevel !== "off",
    ...(thinkingLevel !== "off" ? { thinkingLevelMap: { ...ECO_PI_EXTENDED_THINKING_LEVEL_MAP } } : {}),
    input: ["text", "image"],
    cost: {
      input: input.route?.primary.inputCostPerMillion ?? 0,
      output: input.route?.primary.outputCostPerMillion ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens,
    ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
  };
}

export function resolvePiPlannerRoute(routes: readonly ResolvedModelRoute[]): ResolvedModelRoute | undefined {
  return (
    routes.find((route) => route.role === "planner") ??
    routes.find((route) => route.role === "main") ??
    routes[0]
  );
}

/** Resolve a route by orchestration agent key / role. Never falls back to planner. */
export function resolvePiRouteByRole(
  routes: readonly ResolvedModelRoute[],
  role: string,
): ResolvedModelRoute | undefined {
  const trimmed = role.trim();
  if (!trimmed) {
    return undefined;
  }
  return routes.find((route) => route.role === trimmed);
}

/**
 * Route fingerprint for PI session reuse / rebind.
 * Includes cwd + provider/model/apiCompat/baseUrl/bindingId + full route set.
 */
export function computePiRouteFingerprint(input: {
  cwd: string;
  providerId: string;
  modelId: string;
  apiCompat: EcoApiCompat;
  baseUrl: string;
  bindingId: string;
  routes: readonly ResolvedModelRoute[];
}): string {
  const routeSet = [...input.routes]
    .map((route) => {
      const compat = resolveRouteApiCompat(route);
      const providerId = route.providerId?.trim() || "";
      const modelId = route.upstreamModelId?.trim() || route.primary.modelId.trim();
      const thinkingLevel = mapEcoThinkingEffortToPiThinkingLevel(route.thinkingEffort);
      const thinkingPart =
        thinkingLevel === "off"
          ? ""
          : `:te=${thinkingLevel}:tlmap=${Object.keys(ECO_PI_EXTENDED_THINKING_LEVEL_MAP).join(",")}`;
      return `${route.role}:${providerId}:${modelId}:${compat}:cw=${route.primary.contextWindow ?? ""}${thinkingPart}`;
    })
    .sort()
    .join("|");
  return [
    `cwd=${input.cwd}`,
    `provider=${input.providerId}`,
    `model=${input.modelId}`,
    `apiCompat=${input.apiCompat}`,
    `baseUrl=${input.baseUrl.replace(/\/+$/, "")}`,
    `binding=${input.bindingId}`,
    `routes=${routeSet}`,
  ].join(";");
}

function resolveEcoApiCompat(
  explicit: EcoApiCompat | undefined,
  route: ResolvedModelRoute | undefined,
): EcoApiCompat {
  if (explicit) {
    return explicit;
  }
  return resolveRouteApiCompat(route);
}

function resolveRouteApiCompat(route: ResolvedModelRoute | undefined): EcoApiCompat {
  const raw = route?.apiCompat?.trim();
  if (raw === "openai_responses" || raw === "openai_chat_completions" || raw === "anthropic") {
    return raw;
  }
  return "anthropic";
}
