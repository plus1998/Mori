import type { GatewayAgentCore } from "../types.js";

/** Matches desktop `DEFAULT_UPSTREAM_USER_AGENT` when no client UA / override is set. */
export const DEFAULT_UPSTREAM_USER_AGENT = "Eco-Coding/0.0.0";

/**
 * Agent core that issued the request, stamped by the desktop bridge
 * (`x-eco-agent-core`). PI stamps itself; the bridge fills the default per face.
 */
export const GATEWAY_AGENT_CORE_HEADER = "x-eco-agent-core";

export const GATEWAY_AGENT_CORES: readonly GatewayAgentCore[] = ["codex", "claude", "pi"];

export function isGatewayAgentCore(value: string | undefined): value is GatewayAgentCore {
  return value !== undefined && (GATEWAY_AGENT_CORES as readonly string[]).includes(value);
}

/** Read the stamped agent core; unknown or missing values return undefined. */
export function readGatewayAgentCore(clientHeaders: Headers): GatewayAgentCore | undefined {
  const raw = clientHeaders.get(GATEWAY_AGENT_CORE_HEADER)?.trim().toLowerCase();
  return isGatewayAgentCore(raw) ? raw : undefined;
}

export interface UpstreamUserAgentPolicy {
  /** Global override from Proxy Bridge settings. */
  override?: string | undefined;
  /** Per agent core overrides (Codex / Claude Code / PI). */
  byCore?: Partial<Record<GatewayAgentCore, string>> | undefined;
  /** Last resort when neither override applies and the client sent no UA. */
  fallback?: string | undefined;
}

/**
 * Resolve the upstream User-Agent for one request.
 *
 * The per-core fields are authoritative for their own core: when such a field is
 * cleared (or was never set) that core goes straight back to the SDK's own UA —
 * the global override only covers requests whose core cannot be identified.
 *
 * Priority: per-core override → (identified core: SDK UA → fallback)
 *           → (unidentified: global override → SDK UA → fallback)
 */
export function resolveUpstreamUserAgent(clientHeaders: Headers, policy: UpstreamUserAgentPolicy): string {
  const core = readGatewayAgentCore(clientHeaders);
  if (core) {
    const perCore = policy.byCore?.[core]?.trim();
    if (perCore) {
      return perCore;
    }
    return sdkUserAgentOrFallback(clientHeaders, policy);
  }
  const override = policy.override?.trim();
  if (override) {
    return override;
  }
  return sdkUserAgentOrFallback(clientHeaders, policy);
}

function sdkUserAgentOrFallback(clientHeaders: Headers, policy: UpstreamUserAgentPolicy): string {
  const clientUa = clientHeaders.get("user-agent")?.trim();
  if (clientUa) {
    return clientUa;
  }
  return policy.fallback?.trim() || DEFAULT_UPSTREAM_USER_AGENT;
}

/**
 * Apply a resolved upstream User-Agent: override → client passthrough → Eco default.
 * Matches desktop `applyUserAgent` in upstream-request-headers.ts.
 */
export function applyUpstreamUserAgent(
  headers: Record<string, string>,
  clientHeaders: Headers,
  upstreamUserAgent?: string,
): void {
  const override = upstreamUserAgent?.trim();
  if (override) {
    headers["user-agent"] = override;
    return;
  }
  const clientUa = clientHeaders.get("user-agent")?.trim();
  if (clientUa) {
    headers["user-agent"] = clientUa;
    return;
  }
  headers["user-agent"] = DEFAULT_UPSTREAM_USER_AGENT;
}
