import { computeWindowOccupancy, type ParsedUsage, parsePiUsage } from "@eco/runtime";
import type { RuntimeAgentRole } from "../shared/ipc";
import type { RuntimeRoute } from "./billing-resolver";
import type { SingleUsageBillingArtifacts, UsageBillingPricingLookup } from "./usage-billing-artifacts";
import { resolveSingleUsageBillingArtifacts } from "./usage-billing-artifacts";

export interface ResolvePiUsageBillingInput {
  threadId: string;
  eventId: string;
  payload: unknown;
  runtimeRoutes: readonly RuntimeRoute[];
  lookupPricing: UsageBillingPricingLookup;
  runAttemptId?: string;
  plannerAgentId?: string;
}

export type PiUsageBillingResult =
  | {
      status: "resolved";
      usage: ParsedUsage;
      contextOccupied: number;
      artifacts: SingleUsageBillingArtifacts;
    }
  | { status: "rejected"; reason: "not_pi_usage" | "empty_usage" | "unresolved_artifacts" };

/**
 * Resolve Eco billing artifacts for PI `usage.recorded` events.
 * Ledger source is always `pi` — never silently re-label as sdk/proxy.
 */
export async function resolvePiUsageBilling(
  input: ResolvePiUsageBillingInput,
): Promise<PiUsageBillingResult> {
  if (!isRecord(input.payload) || input.payload.source !== "pi") {
    return { status: "rejected", reason: "not_pi_usage" };
  }

  const modelId =
    (typeof input.payload.model === "string" && input.payload.model.trim()) ||
    (typeof input.payload.modelId === "string" && input.payload.modelId.trim()) ||
    undefined;
  const usage = parsePiUsage(
    isRecord(input.payload.usage)
      ? {
          input: readToken(input.payload.usage, ["input", "input_tokens", "inputTokens"]),
          output: readToken(input.payload.usage, ["output", "output_tokens", "outputTokens"]),
          cacheRead: readToken(input.payload.usage, ["cacheRead", "cache_read", "cache_read_input_tokens"]),
          cacheWrite: readToken(input.payload.usage, [
            "cacheWrite",
            "cache_write",
            "cache_creation_input_tokens",
          ]),
          cost: {
            total:
              typeof input.payload.total_cost_usd === "number"
                ? input.payload.total_cost_usd
                : typeof input.payload.totalCostUsd === "number"
                  ? input.payload.totalCostUsd
                  : undefined,
          },
        }
      : null,
    modelId,
  );
  if (!usage) {
    return { status: "rejected", reason: "empty_usage" };
  }

  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId: input.threadId,
    role: "main" satisfies RuntimeAgentRole,
    usage,
    runtimeRoutes: input.runtimeRoutes,
    lookupPricing: input.lookupPricing,
    source: "pi",
    sourceEventId: input.eventId,
    ...(usage.modelId && { modelId: usage.modelId }),
    ...(usage.totalCostUsd !== undefined && { sourceReportedCostUsd: usage.totalCostUsd }),
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.plannerAgentId && { plannerAgentId: input.plannerAgentId, agentId: input.plannerAgentId }),
  });

  return {
    status: "resolved",
    usage,
    contextOccupied: computeWindowOccupancy(usage),
    artifacts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readToken(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return 0;
}
