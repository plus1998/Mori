/**
 * Attempt-scoped Gateway route binding control plane.
 * Claude-compatible (same credential/registry) but not Anthropic-Messages-only.
 */
import { GATEWAY_AGENT_CORE_HEADER, mapApiCompatToUpstreamKind } from "@eco/gateway";
import type { UpstreamApiCompat } from "../shared/api-compat";
import { resolveUpstreamApiCompat } from "../shared/api-compat";
import {
  type AnthropicProxyResolvedRoute,
  type AnthropicProxyRoute,
  type AnthropicProxyStartOptions,
  type StartedAnthropicProxy,
  startAnthropicModelProxy,
} from "./anthropic-proxy";
import {
  ECO_BRIDGE_BINDING_ID_HEADER,
  ECO_BRIDGE_RUN_ATTEMPT_ID_HEADER,
  globalClaudeBridgeBindingRegistry,
  LOCAL_PROXY_API_KEY,
} from "./claude-bridge-binding";

export { ECO_BRIDGE_BINDING_ID_HEADER, ECO_BRIDGE_RUN_ATTEMPT_ID_HEADER, LOCAL_PROXY_API_KEY };

/** Claude-compatible shape; preferred name for PI / multi-face Gateway binding. */
export type StartedGatewayRouteBinding = StartedAnthropicProxy;
export type GatewayRouteBindingRoute = AnthropicProxyResolvedRoute;
export type GatewayRouteBindingInputRoute = AnthropicProxyRoute;
export type GatewayRouteBindingStartOptions = AnthropicProxyStartOptions;

/**
 * Start an attempt-scoped Gateway binding (explicit binding id + credential).
 * Reuses Claude Bridge registry so Messages/Responses/Chat share one control plane.
 */
export async function startGatewayRouteBinding(
  routes: readonly GatewayRouteBindingInputRoute[],
  options?: GatewayRouteBindingStartOptions,
): Promise<StartedGatewayRouteBinding> {
  return startAnthropicModelProxy(routes, options);
}

export function buildPiGatewayRequestHeaders(input: {
  bindingId: string;
  threadId?: string;
  runAttemptId?: string;
  providerId: string;
  requestedModel: string;
  apiCompat: UpstreamApiCompat;
}): Record<string, string> {
  const headers: Record<string, string> = {
    [ECO_BRIDGE_BINDING_ID_HEADER]: input.bindingId,
    [GATEWAY_AGENT_CORE_HEADER]: "pi",
    "x-gateway-provider-id": input.providerId,
    "x-gateway-requested-model": input.requestedModel,
    "x-gateway-upstream-kind": mapApiCompatToUpstreamKind(resolveUpstreamApiCompat(input.apiCompat)),
  };
  if (input.threadId?.trim()) {
    headers["x-gateway-thread-id"] = input.threadId.trim();
  }
  if (input.runAttemptId?.trim()) {
    headers[ECO_BRIDGE_RUN_ATTEMPT_ID_HEADER] = input.runAttemptId.trim();
  }
  return headers;
}

export function isGatewayBindingCredentialActive(credential: string | undefined): boolean {
  return Boolean(globalClaudeBridgeBindingRegistry.getByCredential(credential));
}
