/**
 * Codex `thread/tokenUsage/updated` → Eco context meter shapes.
 *
 * Phase 1: occupancy percentage from `tokenUsage.last.totalTokens`; when Codex does
 * not expose SDK-style breakdown categories, segments stay empty and callers should
 * show an estimate label — never fabricate planner breakdown rows.
 *
 * @see docs/codex-integration-plan.md §4.4
 */

import type { RuntimeAgentRole } from "../../shared/src";
import { parseCodexGatewayModelAlias } from "./codex-config-sync.js";
import {
  type CodexThreadAttribution,
  resolveDefaultCodexThreadAttribution,
} from "./codex-thread-attribution.js";
import type { ContextBreakdownSegment } from "./context-breakdown.js";
import { DEFAULT_CONTEXT_LIMIT, occupancyPercent } from "./models-dev-limits.js";

/** Raw `thread/tokenUsage/updated` notification params from Codex app-server. */
export interface CodexTokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  tokenUsage: unknown;
}

export interface CodexTokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexThreadTokenUsage {
  last: CodexTokenUsageBreakdown;
  total: CodexTokenUsageBreakdown;
  modelContextWindow?: number;
}

export interface CodexRoleContextSnapshot {
  role: RuntimeAgentRole;
  occupied: number;
  limit: number;
  occupancyPct: number;
  limitsResolved: boolean;
  modelId?: string;
  segments: ContextBreakdownSegment[];
}

export interface CodexContextSnapshot {
  occupied: number;
  limit: number;
  occupancyPct: number;
  limitsResolved: boolean;
  displayRole?: RuntimeAgentRole;
  modelId?: string;
  segments: ContextBreakdownSegment[];
  roles?: CodexRoleContextSnapshot[];
  updatedAt: number;
  /** True when occupancy comes from Codex tokenUsage without SDK-style breakdown. */
  isEstimate: boolean;
}

export interface CodexThreadUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextTokens: number;
  contextLimit?: number;
  occupancyPct?: number;
  modelId?: string;
}

export interface CodexThreadUsageSummary {
  context?: CodexContextSnapshot;
  contextTokens?: number;
  usageByRole?: Partial<Record<RuntimeAgentRole, CodexThreadUsageSnapshot>>;
}

export interface ResolveCodexContextSnapshotInput {
  params: CodexTokenUsageUpdatedParams | Record<string, unknown>;
  attribution: CodexThreadAttribution;
  modelId?: string;
  now?: () => number;
}

export interface CodexContextSnapshotResolution {
  providerId?: string;
  ecoThreadId: string;
  billingRole: RuntimeAgentRole;
  codexThreadId: string;
  turnId: string;
  context: CodexContextSnapshot;
  usageSummary: CodexThreadUsageSummary;
  contextOccupied: number;
  /** Set when `context.isEstimate` — UI should show alongside occupancy percentage. */
  estimateLabel?: string;
}

export const CODEX_CONTEXT_ESTIMATE_LABEL = "估算";

export function parseCodexTokenUsageBreakdown(raw: unknown): CodexTokenUsageBreakdown | null {
  if (!isRecord(raw)) {
    return null;
  }
  const inputTokens = readNonNegativeSafeInteger(raw, "inputTokens");
  const cachedInputTokens = readNonNegativeSafeInteger(raw, "cachedInputTokens");
  const outputTokens = readNonNegativeSafeInteger(raw, "outputTokens");
  const reasoningOutputTokens = readNonNegativeSafeInteger(raw, "reasoningOutputTokens");
  const totalTokens = readNonNegativeSafeInteger(raw, "totalTokens");
  if (
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined ||
    totalTokens === undefined
  ) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

export function parseCodexThreadTokenUsage(raw: unknown): CodexThreadTokenUsage | null {
  if (!isRecord(raw)) {
    return null;
  }
  const last = parseCodexTokenUsageBreakdown(raw.last);
  const total = parseCodexTokenUsageBreakdown(raw.total);
  if (!last || !total) {
    return null;
  }
  const rawModelContextWindow = raw.modelContextWindow;
  if (
    rawModelContextWindow !== undefined &&
    rawModelContextWindow !== null &&
    (typeof rawModelContextWindow !== "number" ||
      !Number.isSafeInteger(rawModelContextWindow) ||
      rawModelContextWindow < 0)
  ) {
    return null;
  }
  const modelContextWindow =
    typeof rawModelContextWindow === "number" && rawModelContextWindow > 0
      ? rawModelContextWindow
      : undefined;
  return {
    last,
    total,
    ...(modelContextWindow !== undefined && { modelContextWindow }),
  };
}

export function buildCodexThreadUsageSnapshot(input: {
  last: CodexTokenUsageBreakdown;
  limit: number;
  limitsResolved: boolean;
  modelId?: string;
}): CodexThreadUsageSnapshot {
  const contextTokens = input.last.totalTokens;
  return {
    inputTokens: input.last.inputTokens,
    outputTokens: input.last.outputTokens,
    cacheReadTokens: input.last.cachedInputTokens,
    cacheCreationTokens: 0,
    contextTokens,
    contextLimit: input.limit,
    occupancyPct: occupancyPercent(contextTokens, input.limit),
    ...(input.modelId && { modelId: input.modelId }),
  };
}

export function buildCodexThreadUsageSummary(input: {
  context: CodexContextSnapshot;
  billingRole: RuntimeAgentRole;
  last: CodexTokenUsageBreakdown;
}): CodexThreadUsageSummary {
  const usage = buildCodexThreadUsageSnapshot({
    last: input.last,
    limit: input.context.limit,
    limitsResolved: input.context.limitsResolved,
    ...(input.context.modelId && { modelId: input.context.modelId }),
  });
  return {
    context: input.context,
    contextTokens: usage.contextTokens,
    usageByRole: {
      [input.billingRole]: usage,
    },
  };
}

export function resolveCodexContextSnapshot(
  input: ResolveCodexContextSnapshotInput,
): CodexContextSnapshotResolution | null {
  const params = input.params as Record<string, unknown>;
  const codexThreadId = readString(params, "threadId");
  const turnId = readString(params, "turnId");
  const rawTokenUsage = isRecord(params) ? params.tokenUsage : undefined;
  const tokenUsage = parseCodexThreadTokenUsage(rawTokenUsage);
  if (!codexThreadId || !turnId || !tokenUsage) {
    return null;
  }

  const occupied = tokenUsage.last.totalTokens;
  if (occupied <= 0) {
    return null;
  }

  const rawModelId = input.modelId?.trim() || undefined;
  const gatewayAlias = rawModelId ? parseCodexGatewayModelAlias(rawModelId) : undefined;
  const modelId = gatewayAlias?.upstreamModelId ?? rawModelId;
  const limit = tokenUsage.modelContextWindow ?? DEFAULT_CONTEXT_LIMIT;
  const limitsResolved = tokenUsage.modelContextWindow !== undefined && tokenUsage.modelContextWindow > 0;
  // Codex 0.142.5 exposes aggregate token counts only, not SDK-style context categories.
  const resolvedSegments: ContextBreakdownSegment[] = [];
  const isEstimate = true;
  const updatedAt = input.now?.() ?? Date.now();
  const billingRole = input.attribution.billingRole;

  const roleSnapshot: CodexRoleContextSnapshot = {
    role: billingRole,
    occupied,
    limit,
    occupancyPct: occupancyPercent(occupied, limit),
    limitsResolved,
    segments: resolvedSegments,
    ...(modelId && { modelId }),
  };

  const context: CodexContextSnapshot = {
    occupied,
    limit,
    occupancyPct: roleSnapshot.occupancyPct,
    limitsResolved,
    displayRole: billingRole,
    segments: resolvedSegments,
    roles: [roleSnapshot],
    updatedAt,
    isEstimate,
    ...(modelId && { modelId }),
  };

  const usageSummary = buildCodexThreadUsageSummary({
    context,
    billingRole,
    last: tokenUsage.last,
  });

  return {
    ...(rawModelId && { providerId: gatewayAlias?.providerId ?? "openai" }),
    ecoThreadId: input.attribution.ecoThreadId,
    billingRole,
    codexThreadId,
    turnId,
    context,
    usageSummary,
    contextOccupied: occupied,
    ...(isEstimate && { estimateLabel: CODEX_CONTEXT_ESTIMATE_LABEL }),
  };
}

export function resolveCodexContextFromNotification(
  params: Record<string, unknown>,
  options: {
    resolveEcoThreadId: (codexThreadId: string) => string;
    resolveThreadAttribution?: (codexThreadId: string) => CodexThreadAttribution | undefined;
    modelId?: string;
    now?: () => number;
  },
): CodexContextSnapshotResolution | null {
  const codexThreadId = readString(params, "threadId");
  if (!codexThreadId) {
    return null;
  }
  const attribution = options.resolveThreadAttribution?.(codexThreadId);
  const ecoThreadId = attribution?.ecoThreadId?.trim() || options.resolveEcoThreadId(codexThreadId);
  // Child Codex threads are not Eco threads; never persist metrics under an unmapped id.
  if (!attribution?.ecoThreadId && ecoThreadId === codexThreadId) {
    return null;
  }
  const resolvedAttribution =
    attribution ??
    resolveDefaultCodexThreadAttribution({
      codexThreadId,
      ecoThreadId,
    });

  return resolveCodexContextSnapshot({
    params,
    attribution: resolvedAttribution,
    ...(options.modelId && { modelId: options.modelId }),
    ...(options.now && { now: options.now }),
  });
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNonNegativeSafeInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
