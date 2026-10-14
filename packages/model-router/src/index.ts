import {
  type AgentRole,
  type AgentRoleRoute,
  type CodexGatewayApiCompat,
  hasCapabilities,
  type ModelCapability,
  type ModelProfile,
  type RuntimeAgentRole,
} from "../../shared/src";

export type RouteThinkingEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ResolvedModelRoute {
  role: RuntimeAgentRole;
  /** Upstream provider model id; SDK must use primary.modelId (eco alias) instead. */
  upstreamModelId?: string;
  /** Eco ProviderStore id, used as the Codex model_provider identity. */
  providerId?: string;
  /** Explicit route-level wire override; absent uses the provider default. */
  apiCompat?: CodexGatewayApiCompat;
  primary: ModelProfile;
  fallbacks: ModelProfile[];
  thinkingEffort?: RouteThinkingEffort;
  /** Product-resolved model output ceiling, before per-request input subtraction. */
  maxOutputTokens?: number;
}

export interface RouterConfig {
  profiles: ModelProfile[];
  routes: AgentRoleRoute[];
}

export interface ConfigValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateRouterConfig(config: RouterConfig): ConfigValidationResult {
  const errors: string[] = [];
  const profileIds = new Set<string>();

  for (const profile of config.profiles) {
    if (profileIds.has(profile.id)) {
      errors.push(`Duplicate model profile id: ${profile.id}`);
    }
    profileIds.add(profile.id);

    if (!profile.baseUrl.startsWith("http://") && !profile.baseUrl.startsWith("https://")) {
      errors.push(`Model profile ${profile.id} must use an HTTP(S) baseUrl`);
    }
    if (!profile.capabilities.includes("messages_api")) {
      errors.push(`Model profile ${profile.id} must declare messages_api capability`);
    }
  }

  for (const route of config.routes) {
    if (!profileIds.has(route.primaryModelId)) {
      errors.push(`Route ${route.role} references missing primary model ${route.primaryModelId}`);
    }
    for (const fallbackModelId of route.fallbackModelIds) {
      if (!profileIds.has(fallbackModelId)) {
        errors.push(`Route ${route.role} references missing fallback model ${fallbackModelId}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export interface RouteFailure {
  role: AgentRole;
  reason: string;
}

export type RouteResolution = { ok: true; route: ResolvedModelRoute } | { ok: false; failure: RouteFailure };

export function resolveModelRoute(
  role: AgentRole,
  routes: readonly AgentRoleRoute[],
  profiles: readonly ModelProfile[],
): RouteResolution {
  const route = routes.find((candidate) => candidate.role === role);
  if (!route) {
    return { ok: false, failure: { role, reason: `No route configured for role ${role}` } };
  }

  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const primary = profilesById.get(route.primaryModelId);
  if (!primary) {
    return { ok: false, failure: { role, reason: `Primary model ${route.primaryModelId} is missing` } };
  }

  if (!isUsableForRoute(primary, route.requiredCapabilities)) {
    return {
      ok: false,
      failure: {
        role,
        reason: `Primary model ${primary.id} is disabled or missing required capabilities`,
      },
    };
  }

  const fallbacks = route.fallbackModelIds
    .map((modelId) => profilesById.get(modelId))
    .filter((profile): profile is ModelProfile => Boolean(profile))
    .filter((profile) => isUsableForRoute(profile, route.requiredCapabilities));

  return {
    ok: true,
    route: {
      role,
      primary,
      fallbacks,
    },
  };
}

export function isUsableForRoute(
  profile: ModelProfile,
  requiredCapabilities: readonly ModelCapability[],
): boolean {
  return profile.enabled && hasCapabilities(profile, requiredCapabilities);
}

export interface AnthropicEndpointConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  timeoutMs?: number;
}

export interface ConformanceCheckResult {
  profileId: string;
  checkedAt: string;
  passed: boolean;
  capabilities: Record<ModelCapability, boolean>;
  failures: string[];
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ANTHROPIC_VERSION = "2023-06-01";

export async function runAnthropicConformanceCheck(
  profile: ModelProfile,
  config: AnthropicEndpointConfig,
  fetcher: FetchLike = fetch,
): Promise<ConformanceCheckResult> {
  const capabilities: Record<ModelCapability, boolean> = {
    messages_api: false,
    streaming: false,
    tool_use: false,
    subagent_compatible: false,
    count_tokens: false,
    cost_usage: false,
    long_context: Boolean(profile.contextWindow && profile.contextWindow >= 100_000),
  };
  const failures: string[] = [];

  const messagesResult = await postJson(fetcher, config, "/v1/messages", {
    model: config.modelId,
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with only: ok" }],
  });
  capabilities.messages_api = messagesResult.ok;
  capabilities.cost_usage = messagesResult.ok && Boolean(messagesResult.body?.usage);
  if (!messagesResult.ok) {
    failures.push(`messages_api: ${messagesResult.error}`);
  }

  const streamResult = await postJson(fetcher, config, "/v1/messages", {
    model: config.modelId,
    max_tokens: 32,
    stream: true,
    messages: [{ role: "user", content: "Reply with only: ok" }],
  });
  capabilities.streaming = streamResult.ok;
  if (!streamResult.ok) {
    failures.push(`streaming: ${streamResult.error}`);
  }

  const toolResult = await postJson(fetcher, config, "/v1/messages", {
    model: config.modelId,
    max_tokens: 64,
    tools: [
      {
        name: "echo",
        description: "Echo a string",
        input_schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "echo" },
    messages: [{ role: "user", content: "Call the echo tool with text ok" }],
  });
  capabilities.tool_use = toolResult.ok;
  capabilities.subagent_compatible = toolResult.ok;
  if (!toolResult.ok) {
    failures.push(`tool_use: ${toolResult.error}`);
  }

  const countResult = await postJson(fetcher, config, "/v1/messages/count_tokens", {
    model: config.modelId,
    messages: [{ role: "user", content: "Count this request." }],
  });
  capabilities.count_tokens = countResult.ok;
  if (!countResult.ok) {
    failures.push(`count_tokens: ${countResult.error}`);
  }

  return {
    profileId: profile.id,
    checkedAt: new Date().toISOString(),
    passed: capabilities.messages_api && capabilities.streaming && capabilities.tool_use,
    capabilities,
    failures,
  };
}

async function postJson(
  fetcher: FetchLike,
  config: AnthropicEndpointConfig,
  path: string,
  body: unknown,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);

  try {
    const response = await fetcher(`${trimTrailingSlash(config.baseUrl)}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    const responseBody = await readJson(response);
    if (!response.ok) {
      return { ok: false, error: extractErrorMessage(responseBody, response.status) };
    }

    return { ok: true, body: responseBody };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

function extractErrorMessage(body: Record<string, unknown>, status: number): string {
  if (isRecord(body.error) && typeof body.error.message === "string") {
    return `${status} ${body.error.message}`;
  }
  return `${status} ${JSON.stringify(body)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
