import { estimateContextTokens, type ParsedUsage } from "@eco/runtime";
import type { BillingUsageSource, RuntimeAgentRole, ThreadUsageSnapshot } from "../shared/ipc";
import type { ContextMonitorSnapshot } from "./context-window-monitor";

const NON_SUBAGENT_BILLING_ROLES = new Set([
  "assistant",
  "main",
  "main",
  "system",
  "thinking",
  "tool",
  "user",
]);

export type SubagentBillingRole = RuntimeAgentRole;

export function isSubagentBillingRole(role: string): role is SubagentBillingRole {
  const normalized = role.trim().toLowerCase();
  if (!normalized || NON_SUBAGENT_BILLING_ROLES.has(normalized)) {
    return false;
  }
  return /^[a-z][a-z0-9_-]*$/.test(normalized);
}

export function sdkPayloadHasModelUsage(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const modelUsage = (payload as Record<string, unknown>).modelUsage;
  return typeof modelUsage === "object" && modelUsage !== null && !Array.isArray(modelUsage);
}

/** Authoritative SDK usage without session modelUsage (e.g. message_delta stream). */
export function isSdkIncrementalStreamUsage(authoritative: boolean, payload: unknown): boolean {
  return authoritative && !sdkPayloadHasModelUsage(payload);
}

export function buildAssistantUsageRequestKey(messageId: string): string {
  return `sdk-assistant:${messageId}`;
}

export interface UsageBillingObservation {
  source: BillingUsageSource;
  role: RuntimeAgentRole;
  usage: ParsedUsage;
  agentId?: string;
  requestKey?: string;
  modelId?: string;
}

export function shouldBillAssistantSubagentUsage(input: {
  role: RuntimeAgentRole;
  messageId: string | undefined;
  agentId?: string;
  usage?: ParsedUsage;
  modelId?: string;
  observedAuthoritativeUsage?: readonly UsageBillingObservation[];
}): input is { role: SubagentBillingRole; messageId: string } {
  if (!input.messageId || !isSubagentBillingRole(input.role)) {
    return false;
  }
  return !hasMatchingAuthoritativeUsage(input);
}

export function hasMatchingAuthoritativeUsage(input: {
  role: RuntimeAgentRole;
  agentId?: string;
  usage?: ParsedUsage;
  modelId?: string;
  observedAuthoritativeUsage?: readonly UsageBillingObservation[];
}): boolean {
  return (input.observedAuthoritativeUsage ?? []).some((observation) =>
    matchesUsageObservation(observation, input),
  );
}

function matchesUsageObservation(
  observation: UsageBillingObservation,
  input: {
    role: RuntimeAgentRole;
    agentId?: string;
    usage?: ParsedUsage;
    modelId?: string;
  },
): boolean {
  if (observation.role !== input.role) {
    return false;
  }
  if (input.agentId && observation.agentId !== input.agentId) {
    return false;
  }
  if (input.modelId && observation.modelId && observation.modelId !== input.modelId) {
    return false;
  }
  if (input.usage && !sameUsageTotals(observation.usage, input.usage)) {
    return false;
  }
  return true;
}

function sameUsageTotals(left: ParsedUsage, right: ParsedUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheCreationTokens === right.cacheCreationTokens
  );
}

export function shouldUpdateContextFromUsageSource(
  source: BillingUsageSource | undefined,
  role?: RuntimeAgentRole,
): boolean {
  if (source === "sdk" || source === "codex" || source === "pi") {
    return true;
  }
  if (source === "proxy" && role && isSubagentBillingRole(role)) {
    return true;
  }
  // Proxy is the only context meter for planner when SDK getContextUsage() is unavailable
  // (OpenAI-compat / llama.cpp upstream). Anthropic-native runs still calibrate via sdk_context_usage.
  if (source === "proxy" && role === "main") {
    return true;
  }
  return false;
}

export function buildUsageSnapshotForRole(input: {
  usage: ParsedUsage;
  role: RuntimeAgentRole;
  monitorSnap?: ContextMonitorSnapshot;
  modelId?: string;
  fallbackContext: "estimate" | "none";
}): ThreadUsageSnapshot {
  const roleContext = input.monitorSnap?.roles.find((role) => role.role === input.role);
  const contextTokens =
    roleContext?.occupied ?? (input.fallbackContext === "estimate" ? estimateContextTokens(input.usage) : 0);

  return {
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheCreationTokens: input.usage.cacheCreationTokens,
    contextTokens,
    ...(roleContext && {
      contextLimit: roleContext.limit,
      occupancyPct: roleContext.occupancyPct,
    }),
    ...(input.modelId && { modelId: input.modelId }),
  };
}
