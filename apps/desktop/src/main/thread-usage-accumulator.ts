import {
  computeRequestBilling,
  computeThreadBillingTotals,
  emptyCostBreakdown,
  type ModelCostRates,
  mergeCostBreakdowns,
  mergeUsageTotals,
  type ParsedUsage,
  type RequestBillingDelta,
  type TokenCostBreakdown,
  tokenTotalsFromUsage,
} from "@eco/runtime";
import { normalizeAgentRole } from "@eco/shared";
import { normalizeAgentRoleMap } from "../shared/agent-role-snapshots";
import type {
  BillingUsageSource,
  RuntimeAgentRole,
  ThreadBillingModelSnapshot,
  ThreadBillingSnapshot,
  ThreadBillingSourceSnapshot,
} from "../shared/ipc";
import { createEmptyUsage, type UsageRequestRecord } from "./usage-request-types";

export type { ThreadBillingSnapshot };

import {
  DEFAULT_BILLING_SOURCE_PRIORITY,
  resolveBillingSourcePriority,
  selectPrimaryBillingSource,
} from "./billing-source-priority";

export interface RecordUsageInput {
  threadId: string;
  role: RuntimeAgentRole;
  delta: ParsedUsage;
  /** Cost reported by the source itself, when available (SDK estimate). */
  sourceReportedCostUsd?: number;
  actualRates: ModelCostRates | null;
  plannerRates: ModelCostRates | null;
  modelId?: string;
  requestKey?: string;
  plannerModelLabel?: string;
  source?: BillingUsageSource;
  /** When true, only updates sourceBreakdown slot; headline totals use SDK primary. */
  reconciliationOnly?: boolean;
}

export interface RecordRunUsageModel {
  role?: RuntimeAgentRole;
  modelId: string;
  usage: ParsedUsage;
  actualRates: ModelCostRates | null;
  plannerRates: ModelCostRates | null;
  /** Per-model cost reported by the SDK, used only for comparison. */
  sdkCostUsd?: number;
}

export interface RecordRunUsageInput {
  threadId: string;
  role: RuntimeAgentRole;
  requestKey: string;
  models: RecordRunUsageModel[];
  /** Total cost reported by the SDK, used only for comparison. */
  sourceReportedCostUsd?: number;
  plannerModelLabel?: string;
  source?: BillingUsageSource;
}

interface SourceModelUsageState {
  modelId: string;
  roles: RuntimeAgentRole[];
  usage: ParsedUsage;
  ecoCostUsd: number;
  reportedCostUsd: number;
}

export interface SerializedBillingSourceState {
  byRole: Partial<Record<RuntimeAgentRole, ParsedUsage>>;
  total: ParsedUsage;
  plannerTokenCostUsd: number;
  ecoCostUsd: number;
  ecoCostBreakdown: TokenCostBreakdown;
  plannerCostBreakdown: TokenCostBreakdown;
  roleEcoCostUsd: Partial<Record<RuntimeAgentRole, number>>;
  roleModelIds: Partial<Record<RuntimeAgentRole, string>>;
  byModel: Record<string, SourceModelUsageState>;
  reportedCostUsd: number;
  pricingResolved: boolean;
  unresolvedCount: number;
}

type SourceUsageState = SerializedBillingSourceState;

type ThreadUsageAccumulatorState = {
  /** Legacy aggregate retained for old persisted snapshots. New billing reads from sources. */
  byRole: Partial<Record<RuntimeAgentRole, ParsedUsage>>;
  total: ParsedUsage;
  sourceReportedCostUsd: number;
  plannerTokenCostUsd: number;
  ecoCostUsd: number;
  ecoCostBreakdown: TokenCostBreakdown;
  plannerCostBreakdown: TokenCostBreakdown;
  roleEcoCostUsd: Partial<Record<RuntimeAgentRole, number>>;
  roleModelIds: Partial<Record<RuntimeAgentRole, string>>;
  sources: Partial<Record<BillingUsageSource, SourceUsageState>>;
  seenRequestKeys: Set<string>;
  pricingResolved: boolean;
  unresolvedCount: number;
  plannerModelLabel?: string;
};

/** JSON-serializable accumulator state for SQLite persistence. */
export interface SerializedThreadUsageState {
  byRole: Partial<Record<RuntimeAgentRole, ParsedUsage>>;
  total: ParsedUsage;
  sourceReportedCostUsd: number;
  plannerTokenCostUsd: number;
  ecoCostUsd: number;
  ecoCostBreakdown: TokenCostBreakdown;
  plannerCostBreakdown: TokenCostBreakdown;
  roleEcoCostUsd: Partial<Record<RuntimeAgentRole, number>>;
  roleModelIds: Partial<Record<RuntimeAgentRole, string>>;
  sources?: Partial<Record<BillingUsageSource, SerializedBillingSourceState>>;
  seenRequestKeys: string[];
  pricingResolved: boolean;
  unresolvedCount: number;
  plannerModelLabel?: string;
}

export class ThreadUsageAccumulator {
  private readonly states = new Map<string, ThreadUsageAccumulatorState>();

  hasSeenRequestKey(threadId: string, requestKey: string): boolean {
    return this.states.get(threadId)?.seenRequestKeys.has(requestKey) ?? false;
  }

  recordUsage(input: RecordUsageInput): ThreadBillingSnapshot {
    const state = this.getOrCreateState(input.threadId);

    if (input.requestKey && state.seenRequestKeys.has(input.requestKey)) {
      return this.toSnapshot(state, input.plannerModelLabel);
    }
    if (input.requestKey && !input.reconciliationOnly) {
      state.seenRequestKeys.add(input.requestKey);
    } else if (input.requestKey && input.reconciliationOnly) {
      const sdkKey = input.requestKey.replace(/^proxy:/, "sdk:");
      if (state.seenRequestKeys.has(input.requestKey) || state.seenRequestKeys.has(sdkKey)) {
        return this.toSnapshot(state, input.plannerModelLabel);
      }
    }

    const source = input.source ?? "sdk";
    const sourceState = getOrCreateSourceState(state, source);
    const billing = computeRequestBilling(input.delta, input.actualRates, input.plannerRates);
    applyUsageContribution(sourceState, {
      role: input.role,
      usage: input.delta,
      billing,
      ...(input.modelId && { modelId: input.modelId }),
      ...(input.sourceReportedCostUsd !== undefined && {
        sourceReportedCostUsd: input.sourceReportedCostUsd,
        modelReportedCostUsd: input.sourceReportedCostUsd,
      }),
    });

    if (input.plannerModelLabel) {
      state.plannerModelLabel = input.plannerModelLabel;
    }

    return this.toSnapshot(state, input.plannerModelLabel);
  }

  /** SDK result billing (modelUsage); stored as its own comparison source. */
  recordRunUsage(input: RecordRunUsageInput): ThreadBillingSnapshot {
    const state = this.getOrCreateState(input.threadId);

    if (state.seenRequestKeys.has(input.requestKey)) {
      return this.toSnapshot(state, input.plannerModelLabel);
    }
    state.seenRequestKeys.add(input.requestKey);

    const source = input.source ?? "sdk";
    const sourceState = getOrCreateSourceState(state, source);
    const reportedTotal = resolveReportedRunCost(input);
    if (reportedTotal !== undefined) {
      sourceState.reportedCostUsd += reportedTotal;
    }

    for (const model of input.models) {
      const role = model.role ?? input.role;
      const billing = computeRequestBilling(model.usage, model.actualRates, model.plannerRates);
      applyUsageContribution(sourceState, {
        role,
        modelId: model.modelId,
        usage: model.usage,
        billing,
        ...(model.sdkCostUsd !== undefined && { modelReportedCostUsd: model.sdkCostUsd }),
      });
    }

    if (input.plannerModelLabel) {
      state.plannerModelLabel = input.plannerModelLabel;
    }

    return this.toSnapshot(state, input.plannerModelLabel);
  }

  getSnapshot(threadId: string, plannerModelLabel?: string): ThreadBillingSnapshot | undefined {
    const state = this.states.get(threadId);
    if (!state) {
      return undefined;
    }
    return this.toSnapshot(state, plannerModelLabel);
  }

  clear(threadId: string): void {
    this.states.delete(threadId);
  }

  serializeState(threadId: string): SerializedThreadUsageState | undefined {
    const state = this.states.get(threadId);
    if (!state) {
      return undefined;
    }
    return {
      byRole: state.byRole,
      total: state.total,
      sourceReportedCostUsd: state.sourceReportedCostUsd,
      plannerTokenCostUsd: state.plannerTokenCostUsd,
      ecoCostUsd: state.ecoCostUsd,
      ecoCostBreakdown: state.ecoCostBreakdown,
      plannerCostBreakdown: state.plannerCostBreakdown,
      roleEcoCostUsd: state.roleEcoCostUsd,
      roleModelIds: state.roleModelIds,
      sources: state.sources,
      seenRequestKeys: [...state.seenRequestKeys],
      pricingResolved: state.pricingResolved,
      unresolvedCount: state.unresolvedCount,
      ...(state.plannerModelLabel && { plannerModelLabel: state.plannerModelLabel }),
    };
  }

  restoreState(threadId: string, data: SerializedThreadUsageState): void {
    const legacy = data as SerializedThreadUsageState & { otelCostUsd?: number };
    this.states.set(threadId, {
      byRole: normalizeAgentRoleMap(data.byRole, mergeUsageTotals),
      total: data.total,
      sourceReportedCostUsd: data.sourceReportedCostUsd ?? legacy.otelCostUsd ?? 0,
      plannerTokenCostUsd: data.plannerTokenCostUsd,
      ecoCostUsd: data.ecoCostUsd,
      ecoCostBreakdown: data.ecoCostBreakdown,
      plannerCostBreakdown: data.plannerCostBreakdown,
      roleEcoCostUsd: normalizeAgentRoleMap(data.roleEcoCostUsd, (previous, current) => previous + current),
      roleModelIds: normalizeAgentRoleMap(data.roleModelIds, (_previous, current) => current),
      sources: restoreSourceStates(data.sources),
      seenRequestKeys: new Set(data.seenRequestKeys),
      pricingResolved: data.pricingResolved,
      unresolvedCount: data.unresolvedCount,
      ...(data.plannerModelLabel && { plannerModelLabel: data.plannerModelLabel }),
    });
  }

  private getOrCreateState(threadId: string) {
    let state = this.states.get(threadId);
    if (!state) {
      state = {
        byRole: {},
        total: createEmptyUsage(),
        sourceReportedCostUsd: 0,
        plannerTokenCostUsd: 0,
        ecoCostUsd: 0,
        ecoCostBreakdown: emptyCostBreakdown(),
        plannerCostBreakdown: emptyCostBreakdown(),
        roleEcoCostUsd: {},
        roleModelIds: {},
        sources: {},
        seenRequestKeys: new Set(),
        pricingResolved: true,
        unresolvedCount: 0,
      };
      this.states.set(threadId, state);
    }
    return state;
  }

  private toSnapshot(state: ThreadUsageAccumulatorState, plannerModelLabel?: string): ThreadBillingSnapshot {
    const label = plannerModelLabel ?? state.plannerModelLabel;
    const sourceBreakdown = buildSourceBreakdown(state.sources);
    const primarySource = selectPrimarySource(sourceBreakdown, state.sources);
    if (primarySource) {
      const primary = sourceBreakdown[primarySource];
      const primaryState = state.sources[primarySource];
      if (!primary || !primaryState) {
        return this.toLegacySnapshot(state, label);
      }
      const sdkReported = sourceBreakdown.sdk?.reportedCostUsd ?? 0;
      const totals = computeThreadBillingTotals(sdkReported, primary.plannerTokenCostUsd, primary.ecoCostUsd);

      return {
        totalTokens: primary.totalTokens,
        ...totals,
        ecoCostBreakdown: primaryState.ecoCostBreakdown,
        plannerCostBreakdown: primaryState.plannerCostBreakdown,
        ...(label && { plannerModelLabel: label }),
        pricingResolved: primary.pricingResolved,
        primarySource,
        sourceBreakdown,
        ...(primary.byModel && { byModel: primary.byModel }),
        ...(primary.byRole && { byRole: primary.byRole }),
      };
    }

    return this.toLegacySnapshot(state, label);
  }

  private toLegacySnapshot(
    state: ThreadUsageAccumulatorState,
    label: string | undefined,
  ): ThreadBillingSnapshot {
    const byRole = buildRoleSnapshot(state.byRole, state.roleEcoCostUsd, state.roleModelIds);
    const totals = computeThreadBillingTotals(
      state.sourceReportedCostUsd,
      state.plannerTokenCostUsd,
      state.ecoCostUsd,
    );

    return {
      totalTokens: tokenTotalsFromUsage(state.total),
      ...totals,
      ecoCostBreakdown: state.ecoCostBreakdown,
      plannerCostBreakdown: state.plannerCostBreakdown,
      ...(label && { plannerModelLabel: label }),
      pricingResolved: state.pricingResolved && state.unresolvedCount === 0,
      ...(Object.keys(byRole).length > 0 && { byRole }),
    };
  }
}

function getOrCreateSourceState(
  state: ThreadUsageAccumulatorState,
  source: BillingUsageSource,
): SourceUsageState {
  const existing = state.sources[source];
  if (existing) {
    return existing;
  }
  const created = createEmptySourceState();
  state.sources[source] = created;
  return created;
}

function createEmptySourceState(): SourceUsageState {
  return {
    byRole: {},
    total: createEmptyUsage(),
    plannerTokenCostUsd: 0,
    ecoCostUsd: 0,
    ecoCostBreakdown: emptyCostBreakdown(),
    plannerCostBreakdown: emptyCostBreakdown(),
    roleEcoCostUsd: {},
    roleModelIds: {},
    byModel: {},
    reportedCostUsd: 0,
    pricingResolved: true,
    unresolvedCount: 0,
  };
}

function applyUsageContribution(
  source: SourceUsageState,
  input: {
    role: RuntimeAgentRole;
    modelId?: string;
    usage: ParsedUsage;
    billing: RequestBillingDelta;
    sourceReportedCostUsd?: number;
    modelReportedCostUsd?: number;
  },
): void {
  const role = input.role;
  const modelKey = input.modelId?.trim() || role;
  const prevRole = source.byRole[role] ?? createEmptyUsage();
  source.byRole[role] = mergeUsageTotals(prevRole, input.usage);
  source.total = mergeUsageTotals(source.total, input.usage);
  source.plannerTokenCostUsd += input.billing.plannerTokenCostUsd;
  source.ecoCostUsd += input.billing.ecoCostUsd;
  if (input.billing.ecoBreakdown) {
    source.ecoCostBreakdown = mergeCostBreakdowns(source.ecoCostBreakdown, input.billing.ecoBreakdown);
  }
  if (input.billing.plannerBreakdown) {
    source.plannerCostBreakdown = mergeCostBreakdowns(
      source.plannerCostBreakdown,
      input.billing.plannerBreakdown,
    );
  }
  source.roleEcoCostUsd[role] = (source.roleEcoCostUsd[role] ?? 0) + input.billing.ecoCostUsd;
  if (input.modelId) {
    source.roleModelIds[role] = input.modelId;
  }
  if (input.sourceReportedCostUsd !== undefined && Number.isFinite(input.sourceReportedCostUsd)) {
    source.reportedCostUsd += input.sourceReportedCostUsd;
  }

  const modelState = source.byModel[modelKey] ?? {
    modelId: modelKey,
    roles: [],
    usage: createEmptyUsage(),
    ecoCostUsd: 0,
    reportedCostUsd: 0,
  };
  addRole(modelState.roles, role);
  modelState.usage = mergeUsageTotals(modelState.usage, input.usage);
  modelState.ecoCostUsd += input.billing.ecoCostUsd;
  if (input.modelReportedCostUsd !== undefined && Number.isFinite(input.modelReportedCostUsd)) {
    modelState.reportedCostUsd += input.modelReportedCostUsd;
  }
  source.byModel[modelKey] = modelState;

  if (!input.billing.pricingResolved) {
    source.unresolvedCount += 1;
    source.pricingResolved = false;
  }
}

function addRole(roles: RuntimeAgentRole[], role: RuntimeAgentRole): void {
  if (!roles.includes(role)) {
    roles.push(role);
  }
}

function resolveReportedRunCost(input: RecordRunUsageInput): number | undefined {
  if (input.sourceReportedCostUsd !== undefined && Number.isFinite(input.sourceReportedCostUsd)) {
    return input.sourceReportedCostUsd;
  }
  const total = input.models.reduce(
    (sum, model) =>
      sum + (model.sdkCostUsd !== undefined && Number.isFinite(model.sdkCostUsd) ? model.sdkCostUsd : 0),
    0,
  );
  return total > 0 ? total : undefined;
}

function restoreSourceStates(
  sources: Partial<Record<BillingUsageSource, SerializedBillingSourceState>> | undefined,
): Partial<Record<BillingUsageSource, SourceUsageState>> {
  if (!sources) {
    return {};
  }
  const restored: Partial<Record<BillingUsageSource, SourceUsageState>> = {};
  for (const source of DEFAULT_BILLING_SOURCE_PRIORITY) {
    const state = sources[source];
    if (!state) {
      continue;
    }
    restored[source] = {
      ...createEmptySourceState(),
      ...state,
      byRole: normalizeAgentRoleMap(state.byRole, mergeUsageTotals),
      roleEcoCostUsd: normalizeAgentRoleMap(state.roleEcoCostUsd, (previous, current) => previous + current),
      roleModelIds: normalizeAgentRoleMap(state.roleModelIds, (_previous, current) => current),
      byModel: Object.fromEntries(
        Object.entries(state.byModel ?? {}).map(([key, model]) => [
          key,
          {
            ...model,
            roles: [...new Set(model.roles.map((role) => normalizeAgentRole(role)))],
          },
        ]),
      ),
    };
  }
  return restored;
}

function buildSourceBreakdown(
  sources: Partial<Record<BillingUsageSource, SourceUsageState>>,
): Partial<Record<BillingUsageSource, ThreadBillingSourceSnapshot>> {
  const snapshots: Partial<Record<BillingUsageSource, ThreadBillingSourceSnapshot>> = {};
  const billingPriority = resolveBillingSourcePriority(sources);
  for (const source of billingPriority) {
    const state = sources[source];
    if (!state || !hasSourceData(state)) {
      continue;
    }
    snapshots[source] = sourceToSnapshot(source, state);
  }
  return snapshots;
}

function sourceToSnapshot(source: BillingUsageSource, state: SourceUsageState): ThreadBillingSourceSnapshot {
  const byRole = buildRoleSnapshot(state.byRole, state.roleEcoCostUsd, state.roleModelIds);
  const byModel = buildModelSnapshot(state.byModel);
  return {
    source,
    totalTokens: tokenTotalsFromUsage(state.total),
    plannerTokenCostUsd: state.plannerTokenCostUsd,
    ecoCostUsd: state.ecoCostUsd,
    ...(state.reportedCostUsd > 0 && { reportedCostUsd: state.reportedCostUsd }),
    pricingResolved: state.pricingResolved && state.unresolvedCount === 0,
    ...(byModel.length > 0 && { byModel }),
    ...(Object.keys(byRole).length > 0 && { byRole }),
  };
}

function buildRoleSnapshot(
  byRoleState: Partial<Record<RuntimeAgentRole, ParsedUsage>>,
  roleEcoCostUsd: Partial<Record<RuntimeAgentRole, number>>,
  roleModelIds: Partial<Record<RuntimeAgentRole, string>>,
): NonNullable<ThreadBillingSnapshot["byRole"]> {
  const byRole: NonNullable<ThreadBillingSnapshot["byRole"]> = {};
  for (const [role, usage] of Object.entries(byRoleState) as [RuntimeAgentRole, ParsedUsage][]) {
    byRole[role] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      ecoCostUsd: roleEcoCostUsd[role] ?? 0,
      ...(roleModelIds[role] && { modelId: roleModelIds[role] }),
    };
  }
  return byRole;
}

function buildModelSnapshot(byModel: Record<string, SourceModelUsageState>): ThreadBillingModelSnapshot[] {
  return Object.values(byModel)
    .filter((entry) => usageTotal(entry.usage) > 0 || entry.ecoCostUsd > 0 || entry.reportedCostUsd > 0)
    .map((entry) => ({
      modelId: entry.modelId,
      roles: entry.roles,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadTokens: entry.usage.cacheReadTokens,
      cacheCreationTokens: entry.usage.cacheCreationTokens,
      ecoCostUsd: entry.ecoCostUsd,
      ...(entry.reportedCostUsd > 0 && { reportedCostUsd: entry.reportedCostUsd }),
    }))
    .sort((left, right) => {
      const tokenDiff = modelSnapshotTotal(right) - modelSnapshotTotal(left);
      return tokenDiff !== 0 ? tokenDiff : left.modelId.localeCompare(right.modelId);
    });
}

function selectPrimarySource(
  sources: Partial<Record<BillingUsageSource, ThreadBillingSourceSnapshot>>,
  sourceStates: Partial<Record<BillingUsageSource, SourceUsageState>>,
): BillingUsageSource | undefined {
  const primary = selectPrimaryBillingSource(sources);
  if (primary !== "proxy") {
    return primary;
  }
  const proxyState = sourceStates.proxy;
  const hasNonVisionUsage = proxyState
    ? Object.entries(proxyState.byRole).some(
        ([role, usage]) => role !== "vision" && usage !== undefined && usageTotal(usage) > 0,
      )
    : true;
  if (hasNonVisionUsage) {
    return primary;
  }
  const nonVisionSources = Object.fromEntries(
    Object.entries(sourceStates)
      .filter(
        ([source, state]) =>
          source !== "proxy" &&
          state &&
          Object.entries(state.byRole).some(
            ([role, usage]) => role !== "vision" && usage !== undefined && usageTotal(usage) > 0,
          ),
      )
      .map(([source]) => [source, sources[source as BillingUsageSource]]),
  ) as Partial<Record<BillingUsageSource, ThreadBillingSourceSnapshot>>;
  return selectPrimaryBillingSource(nonVisionSources) ?? primary;
}

function hasSourceData(state: SourceUsageState): boolean {
  return (
    usageTotal(state.total) > 0 ||
    state.ecoCostUsd > 0 ||
    state.plannerTokenCostUsd > 0 ||
    state.reportedCostUsd > 0
  );
}

function usageTotal(usage: ParsedUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

function modelSnapshotTotal(entry: ThreadBillingModelSnapshot): number {
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheCreationTokens;
}

export function buildUsageRequestKey(record: UsageRequestRecord): string {
  return [
    "usage",
    record.role,
    record.inputTokens,
    record.outputTokens,
    record.cacheReadTokens ?? 0,
    record.cacheCreationTokens ?? 0,
    record.modelId ?? "",
    record.dedupId ?? "",
  ].join(":");
}
