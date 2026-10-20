import { type AcpHostUiFeatures, isAcpHostUiFeatureVisible } from "@eco/runtime/acp-host-ui-features";
import { DEFAULT_CONTEXT_LIMIT, occupancyPercent } from "@eco/runtime/models-dev-limits";
import type {
  RuntimeAgentRole,
  ThreadBillingSnapshot,
  ThreadContextSnapshot,
  ThreadRoleContextSnapshot,
  ThreadStatus,
  ThreadUsageSnapshot,
  ThreadUsageLedgerEventView,
} from "./ipc";
import { AGENT_ROLES } from "./ipc";
import { pickDisplayContextTokens } from "./thread-continuation";

const ROLE_ORDER = new Map<string, number>(AGENT_ROLES.map((role, index) => [role, index]));

export interface ThreadUsageSummaryInput {
  billing?: ThreadBillingSnapshot;
  ledgerEvents?: ThreadUsageLedgerEventView[];
  context?: ThreadContextSnapshot;
  hostUiFeatures?: AcpHostUiFeatures;
  usageByRole?: Record<string, ThreadUsageSnapshot>;
}

export interface ThreadUsageSummaryOutput {
  billing?: ThreadBillingSnapshot;
  ledgerEvents?: ThreadUsageLedgerEventView[];
  context?: ThreadContextSnapshot;
  contextTokens?: number;
}

/** Build a minimal context card from planner usage when getContextUsage breakdown is not cached yet. */
export function buildFallbackContextSnapshot(options: {
  context?: ThreadContextSnapshot;
  contextTokens?: number;
  plannerUsage?: ThreadUsageSnapshot;
  usageByRole?: Record<string, ThreadUsageSnapshot>;
}): ThreadContextSnapshot | undefined {
  if (options.context) {
    return options.context;
  }

  const roles = buildFallbackRoleSnapshots(options.usageByRole, options.plannerUsage);
  const displayRole = roles.find((role) => role.role === "planner")?.role ?? roles[0]?.role;
  const active = roles.find((role) => role.role === displayRole);
  const occupied = active?.occupied ?? options.contextTokens ?? options.plannerUsage?.contextTokens ?? 0;
  if (occupied <= 0) {
    return undefined;
  }

  const limit = active?.limit ?? options.plannerUsage?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const occupancyPct =
    active?.occupancyPct ?? options.plannerUsage?.occupancyPct ?? occupancyPercent(occupied, limit);
  const limitsResolved = active?.limitsResolved ?? options.plannerUsage?.contextLimit !== undefined;
  const segments = active?.segments ?? fallbackSegments(occupied);

  return {
    occupied,
    limit,
    occupancyPct,
    limitsResolved,
    ...(displayRole && { displayRole }),
    segments,
    ...(roles.length > 0 && { roles }),
    updatedAt: Date.now(),
  };
}

export function buildThreadUsageSummary(input: ThreadUsageSummaryInput): ThreadUsageSummaryOutput {
  const showContext = isAcpHostUiFeatureVisible(input.hostUiFeatures, "contextUsage");
  const showBilling = isAcpHostUiFeatureVisible(input.hostUiFeatures, "billing");
  const contextTokens = input.usageByRole ? pickDisplayContextTokens(input.usageByRole) : 0;
  const plannerUsage = input.usageByRole?.planner;
  const context = showContext
    ? buildFallbackContextSnapshot({
        ...(input.context && { context: input.context }),
        ...(contextTokens > 0 && { contextTokens }),
        ...(plannerUsage && { plannerUsage }),
        ...(input.usageByRole && { usageByRole: input.usageByRole }),
      })
    : undefined;

  return {
    ...(showBilling && input.billing ? { billing: input.billing } : {}),
    ...(showBilling && input.ledgerEvents ? { ledgerEvents: input.ledgerEvents } : {}),
    ...(context && { context }),
    ...(showContext && contextTokens > 0 && { contextTokens }),
  };
}

function buildFallbackRoleSnapshots(
  usageByRole: Record<string, ThreadUsageSnapshot> | undefined,
  plannerUsage: ThreadUsageSnapshot | undefined,
): ThreadRoleContextSnapshot[] {
  const snapshots: ThreadRoleContextSnapshot[] = [];
  const source = usageByRole ?? (plannerUsage ? { planner: plannerUsage } : undefined);
  if (!source) {
    return snapshots;
  }

  for (const role of sortRuntimeRoles(Object.keys(source))) {
    const usage = source[role];
    if (!usage || usage.contextTokens <= 0) {
      continue;
    }
    const limit = usage.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    snapshots.push({
      role,
      occupied: usage.contextTokens,
      limit,
      occupancyPct: usage.occupancyPct ?? occupancyPercent(usage.contextTokens, limit),
      limitsResolved: usage.contextLimit !== undefined,
      ...(usage.modelId && { modelId: usage.modelId }),
      segments: fallbackSegments(usage.contextTokens),
    });
  }
  return snapshots;
}

function sortRuntimeRoles(roles: Iterable<RuntimeAgentRole>): RuntimeAgentRole[] {
  return [...roles].sort((left, right) => {
    const leftOrder = ROLE_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = ROLE_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.localeCompare(right);
  });
}

function fallbackSegments(tokens: number): ThreadRoleContextSnapshot["segments"] {
  return [
    {
      key: "conversation",
      label: "会话",
      tokens,
      color: "#ea580c",
    },
  ];
}

const USAGE_PANEL_STATUSES = new Set<ThreadStatus>([
  "running",
  "queued",
  "awaiting_plan",
  "completed",
  "idle",
  "failed",
  "blocked",
]);

export function shouldShowThreadUsagePanels(status?: ThreadStatus): boolean {
  return status !== undefined && USAGE_PANEL_STATUSES.has(status);
}

export function shouldShowContextUsagePanel(
  status: ThreadStatus | undefined,
  features?: AcpHostUiFeatures,
): boolean {
  return shouldShowThreadUsagePanels(status) && isAcpHostUiFeatureVisible(features, "contextUsage");
}

export function shouldShowBillingUsagePanel(
  status: ThreadStatus | undefined,
  features?: AcpHostUiFeatures,
): boolean {
  return shouldShowThreadUsagePanels(status) && isAcpHostUiFeatureVisible(features, "billing");
}

export type ContextCardPlaceholderKey =
  | "context.emptyHint.accumulating"
  | "context.emptyHint.planning"
  | "context.emptyHint.noData"
  | "context.empty";

export function contextCardPlaceholderKey(status?: ThreadStatus): ContextCardPlaceholderKey {
  if (status === "running" || status === "queued") {
    return "context.emptyHint.accumulating";
  }
  if (status === "awaiting_plan") {
    return "context.emptyHint.planning";
  }
  if (status === "completed" || status === "idle" || status === "failed" || status === "blocked") {
    return "context.emptyHint.noData";
  }
  return "context.empty";
}

export type BillingEmptyHintKey =
  | "billing.emptyHint.accumulating"
  | "billing.emptyHint.planning"
  | "billing.emptyHint.noRecords"
  | "billing.emptyHint.notStarted";

export function billingEmptyHintKey(status?: ThreadStatus): BillingEmptyHintKey {
  if (status === "running" || status === "queued") {
    return "billing.emptyHint.accumulating";
  }
  if (status === "awaiting_plan") {
    return "billing.emptyHint.planning";
  }
  if (shouldShowThreadUsagePanels(status)) {
    return "billing.emptyHint.noRecords";
  }
  return "billing.emptyHint.notStarted";
}
