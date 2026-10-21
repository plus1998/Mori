import type {
  GatewayRequestLifecycleEvent,
  GatewayUpstreamErrorInfo,
} from "@eco/gateway";
import type { RuntimeAgentRole } from "../shared/ipc";
import type { ClaudeBridgeBindingRoute } from "./claude-bridge-binding";
import { globalClaudeBridgeBindingRegistry } from "./claude-bridge-binding";

export function clearGatewayRequestLifecycleStateForTests(): void {
  for (const binding of globalClaudeBridgeBindingRegistry.listBindingsForTests()) {
    binding.adoptedUpstreamRequestIdsByLogical.clear();
  }
}

export function resolveBindingRoleForRoutes(
  routes: readonly ClaudeBridgeBindingRoute[],
  event: Pick<GatewayRequestLifecycleEvent, "providerId" | "requestedModel" | "upstreamModelId">,
): RuntimeAgentRole | undefined {
  const providerId = event.providerId.trim();
  const requested = event.requestedModel.trim();
  const upstream = event.upstreamModelId.trim();
  const providerRoutes = routes.filter((route) => route.provider.id === providerId);
  if (providerRoutes.length === 0) {
    return undefined;
  }

  if (requested) {
    const byAlias = providerRoutes.filter((route) => route.aliasModelId === requested);
    if (byAlias.length === 1) {
      return byAlias[0]!.role;
    }
    if (byAlias.length > 1) {
      return undefined;
    }
  }

  const concreteCandidates = new Set<string>();
  if (upstream) {
    concreteCandidates.add(upstream);
  }
  if (requested) {
    concreteCandidates.add(requested);
  }
  for (const concrete of concreteCandidates) {
    const byModel = providerRoutes.filter((route) => route.modelId === concrete);
    if (byModel.length === 1) {
      return byModel[0]!.role;
    }
    if (byModel.length > 1) {
      return undefined;
    }
  }

  return undefined;
}

function resolveBindingRole(
  binding: ReturnType<typeof globalClaudeBridgeBindingRegistry.getByBindingId>,
  event: GatewayRequestLifecycleEvent,
): RuntimeAgentRole | undefined {
  if (!binding) {
    return undefined;
  }
  return resolveBindingRoleForRoutes(binding.routes, event);
}

function hasAdoptedProviderRequestId(
  binding: NonNullable<ReturnType<typeof globalClaudeBridgeBindingRegistry.getByBindingId>>,
  logicalRequestId: string,
  providerRequestId: string,
): boolean {
  return binding.adoptedUpstreamRequestIdsByLogical.get(logicalRequestId)?.has(providerRequestId) ?? false;
}

function markAdoptedProviderRequestId(
  binding: NonNullable<ReturnType<typeof globalClaudeBridgeBindingRegistry.getByBindingId>>,
  logicalRequestId: string,
  providerRequestId: string,
): void {
  let adopted = binding.adoptedUpstreamRequestIdsByLogical.get(logicalRequestId);
  if (!adopted) {
    adopted = new Set();
    binding.adoptedUpstreamRequestIdsByLogical.set(logicalRequestId, adopted);
  }
  adopted.add(providerRequestId);
}

export interface GatewayRequestLifecycleHandlers {
  onUpstreamRequestId: (input: {
    threadId: string;
    role: RuntimeAgentRole;
    requestId: string;
    logicalRequestId: string;
  }) => void;
  onUpstreamConnectionError: (input: {
    threadId: string;
    role: RuntimeAgentRole;
    error: string;
    statusCode?: number;
    logicalRequestId: string;
    accountId?: string;
    providerRequestId?: string;
    responseId?: string;
    turnId?: string;
    runAttemptId?: string;
    errorInfo?: GatewayUpstreamErrorInfo;
  }) => void;
  onLogicalCompleted?: (input: {
    threadId: string;
    role: RuntimeAgentRole;
    logicalRequestId: string;
    providerRequestId?: string;
    runAttemptId?: string;
  }) => void;
  onLogicalFailed?: (input: {
    threadId: string;
    role: RuntimeAgentRole;
    logicalRequestId: string;
    error: string;
    statusCode?: number;
    providerRequestId?: string;
    responseId?: string;
    accountId?: string;
    turnId?: string;
    runAttemptId?: string;
    errorInfo?: GatewayUpstreamErrorInfo;
  }) => void;
  onLogicalCancelled?: (input: {
    threadId: string;
    role: RuntimeAgentRole;
    logicalRequestId: string;
    reason?: string;
    providerRequestId?: string;
    responseId?: string;
    accountId?: string;
    turnId?: string;
    runAttemptId?: string;
  }) => void;
}

export function handleGatewayRequestLifecycleEvent(
  event: GatewayRequestLifecycleEvent,
  handlers: GatewayRequestLifecycleHandlers,
): void {
  const bindingId = event.bridgeBindingId?.trim();
  const binding = bindingId
    ? globalClaudeBridgeBindingRegistry.getByBindingId(bindingId)
    : undefined;
  // A bind-marked event with no live binding is stale or forged. Treating it
  // as a direct Codex request would guess a role and could interrupt the wrong run.
  if (bindingId && !binding) {
    return;
  }
  const threadId = event.threadId?.trim() || binding?.threadId;
  if (!threadId) {
    return;
  }
  // Direct Codex lifecycle events have no binding and target the main role.
  // Bridge requests must resolve exactly one configured route; a mismatch is
  // not permission to fall back to routes[0] or main.
  const role = binding ? resolveBindingRole(binding, event) : "main";
  if (!role) {
    return;
  }
  const logicalRequestId = event.logicalRequestId;
  const runAttemptId = event.runAttemptId?.trim() || binding?.runAttemptId?.trim();

  if (event.type === "upstream.headers" && event.providerRequestId) {
    if (binding && hasAdoptedProviderRequestId(binding, logicalRequestId, event.providerRequestId)) {
      return;
    }
    if (binding) {
      markAdoptedProviderRequestId(binding, logicalRequestId, event.providerRequestId);
    }
    handlers.onUpstreamRequestId({ threadId, role, requestId: event.providerRequestId, logicalRequestId });
    return;
  }

  if (event.type === "upstream.failed") {
    handlers.onUpstreamConnectionError({
      threadId,
      role,
      error: event.error,
      logicalRequestId,
      ...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
      ...(event.accountId ? { accountId: event.accountId } : {}),
      ...(event.providerRequestId ? { providerRequestId: event.providerRequestId } : {}),
      ...(event.responseId ? { responseId: event.responseId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(runAttemptId ? { runAttemptId } : {}),
      ...(event.errorInfo ? { errorInfo: event.errorInfo } : {}),
    });
    return;
  }

  const providerRequestId =
    "providerRequestId" in event && event.providerRequestId ? event.providerRequestId : undefined;

  if (event.type === "logical.completed") {
    handlers.onLogicalCompleted?.({
      threadId,
      role,
      logicalRequestId,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(runAttemptId ? { runAttemptId } : {}),
    });
    return;
  }

  if (event.type === "logical.failed") {
    handlers.onLogicalFailed?.({
      threadId,
      role,
      logicalRequestId,
      error: event.error,
      ...(event.responseId ? { responseId: event.responseId } : {}),
      ...(event.accountId ? { accountId: event.accountId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(runAttemptId ? { runAttemptId } : {}),
      ...(event.errorInfo ? { errorInfo: event.errorInfo } : {}),
      ...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
    });
    return;
  }

  if (event.type === "logical.cancelled") {
    handlers.onLogicalCancelled?.({
      threadId,
      role,
      logicalRequestId,
      ...(event.reason ? { reason: event.reason } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
      ...("responseId" in event && event.responseId ? { responseId: event.responseId } : {}),
      ...("accountId" in event && event.accountId ? { accountId: event.accountId } : {}),
      ...("turnId" in event && event.turnId ? { turnId: event.turnId } : {}),
      ...(runAttemptId ? { runAttemptId } : {}),
    });
  }
}
