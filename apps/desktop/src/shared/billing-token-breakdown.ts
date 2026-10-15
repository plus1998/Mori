import { formatRoleModelLabel, formatUsageBadge } from "@eco/runtime/usage";
import {
  AGENT_ROLES,
  type RuntimeAgentRole,
  type ThreadBillingModelSnapshot,
  type ThreadBillingSnapshot,
} from "./ipc";
import { formatModelDisplayName } from "./model-id";

type RoleUsageEntry = NonNullable<ThreadBillingSnapshot["byRole"]>[string];

const ROLE_ORDER = new Map<string, number>(AGENT_ROLES.map((role, index) => [role, index]));

export interface BillingAgentRow {
  role: RuntimeAgentRole;
  label: string;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  ecoCostUsd: number;
  tokenBadge: string;
}

export interface BillingModelRow {
  modelId: string;
  label: string;
  roles: RuntimeAgentRole[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  ecoCostUsd: number;
  reportedCostUsd?: number;
  tokenBadge: string;
}

export interface BillingTokenBreakdown {
  byAgent: BillingAgentRow[];
  byModel: BillingModelRow[];
}

export interface BillingAgentViewRow extends BillingAgentRow {
  kind: "primary" | "unattributed" | "pending";
}

interface SubagentUsageLike {
  role: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  ecoCostUsd: number;
}

const UNATTRIBUTED_COST_EPSILON_USD = 0.000001;

/**
 * Splits role-level usage into per-role rows for the agent view: roles without subagent rows
 * stay as-is; for roles with subagent rows, only the remainder that individual subagents did
 * not account for is kept (as an "unattributed" row), so attribution gaps stay visible
 * instead of being hidden whenever subagent rows merely exist.
 */
export function buildAgentViewRows(
  byAgent: readonly BillingAgentRow[],
  subagents: readonly SubagentUsageLike[],
): BillingAgentViewRow[] {
  const attributedByRole = new Map<string, SubagentUsageLike>();
  for (const row of subagents) {
    const existing = attributedByRole.get(row.role);
    if (existing) {
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.cacheReadTokens += row.cacheReadTokens;
      existing.cacheCreationTokens += row.cacheCreationTokens;
      existing.ecoCostUsd += row.ecoCostUsd;
      continue;
    }
    attributedByRole.set(row.role, { ...row });
  }

  const rows: BillingAgentViewRow[] = [];
  for (const row of byAgent) {
    const attributed = attributedByRole.get(row.role);
    if (!attributed) {
      rows.push({ ...row, kind: "primary" });
      continue;
    }
    const remainder = {
      inputTokens: Math.max(0, row.inputTokens - attributed.inputTokens),
      outputTokens: Math.max(0, row.outputTokens - attributed.outputTokens),
      cacheReadTokens: Math.max(0, row.cacheReadTokens - attributed.cacheReadTokens),
      cacheCreationTokens: Math.max(0, row.cacheCreationTokens - attributed.cacheCreationTokens),
      ecoCostUsd: Math.max(0, row.ecoCostUsd - attributed.ecoCostUsd),
    };
    const hasTokens = roleUsageTotal(remainder) > 0;
    if (!hasTokens && remainder.ecoCostUsd < UNATTRIBUTED_COST_EPSILON_USD) {
      continue;
    }
    rows.push({
      ...row,
      ...remainder,
      tokenBadge: toTokenBadge(remainder),
      kind: "unattributed",
    });
  }
  return rows;
}

function roleUsageTotal(entry: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheCreationTokens;
}

/** Primary (non-subagent) agent rows use role · 主 to mirror subagent role · agentId labels. */
function formatPrimaryAgentLabel(role: RuntimeAgentRole): string {
  return `${formatRoleModelLabel(role)} · 主`;
}

function toTokenBadge(entry: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): string {
  return formatUsageBadge({
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
  });
}

function hasRoleUsage(entry: RoleUsageEntry | undefined): entry is NonNullable<RoleUsageEntry> {
  return Boolean(entry && (roleUsageTotal(entry) > 0 || entry.ecoCostUsd > 0));
}

/** Primary snapshot only — no cross-source supplementation (Phase 3.1). */
function collectDisplayByRole(
  billing: ThreadBillingSnapshot,
): Partial<Record<RuntimeAgentRole, NonNullable<RoleUsageEntry>>> {
  const merged: Partial<Record<RuntimeAgentRole, NonNullable<RoleUsageEntry>>> = {};
  for (const [role, entry] of Object.entries(billing.byRole ?? {})) {
    if (hasRoleUsage(entry)) {
      merged[role] = entry;
    }
  }
  return merged;
}

function sortRoleKeys(roles: Iterable<string>): string[] {
  return [...roles].sort((left, right) => {
    const leftOrder = ROLE_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = ROLE_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.localeCompare(right);
  });
}

function collectDisplayByModel(billing: ThreadBillingSnapshot): ThreadBillingModelSnapshot[] {
  return [...(billing.byModel ?? [])]
    .filter((entry) => roleUsageTotal(entry) > 0 || entry.ecoCostUsd > 0)
    .sort((left, right) => {
      const tokenDiff = roleUsageTotal(right) - roleUsageTotal(left);
      return tokenDiff !== 0 ? tokenDiff : left.modelId.localeCompare(right.modelId);
    });
}

function toModelRows(entries: ThreadBillingModelSnapshot[]): BillingModelRow[] {
  return entries.map((entry) => ({
    modelId: entry.modelId,
    label: formatModelDisplayName(entry.modelId),
    roles: sortRoleKeys(entry.roles),
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
    ecoCostUsd: entry.ecoCostUsd,
    ...(entry.reportedCostUsd !== undefined &&
      entry.reportedCostUsd > 0 && { reportedCostUsd: entry.reportedCostUsd }),
    tokenBadge: toTokenBadge(entry),
  }));
}

export function buildBillingTokenBreakdown(
  billing: ThreadBillingSnapshot | undefined,
): BillingTokenBreakdown | null {
  if (!billing) {
    return null;
  }

  const displayByRole = collectDisplayByRole(billing);
  const displayByModelEntries = collectDisplayByModel(billing);

  const byAgent: BillingAgentRow[] = [];
  for (const role of sortRoleKeys(Object.keys(displayByRole))) {
    const entry = displayByRole[role];
    if (!entry) {
      continue;
    }
    byAgent.push({
      role,
      label: formatPrimaryAgentLabel(role),
      ...(entry.modelId && { modelId: entry.modelId }),
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      ecoCostUsd: entry.ecoCostUsd,
      tokenBadge: toTokenBadge(entry),
    });
  }

  if (byAgent.length === 0 && displayByModelEntries.length === 0) {
    return null;
  }

  if (displayByModelEntries.length > 0) {
    return { byAgent, byModel: toModelRows(displayByModelEntries) };
  }

  const modelMap = new Map<
    string,
    {
      modelId: string;
      roles: RuntimeAgentRole[];
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      ecoCostUsd: number;
    }
  >();

  for (const row of byAgent) {
    const key = row.modelId?.trim() || row.role;
    const existing = modelMap.get(key);
    if (existing) {
      existing.roles.push(row.role);
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.cacheReadTokens += row.cacheReadTokens;
      existing.cacheCreationTokens += row.cacheCreationTokens;
      existing.ecoCostUsd += row.ecoCostUsd;
      continue;
    }
    modelMap.set(key, {
      modelId: key,
      roles: [row.role],
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      ecoCostUsd: row.ecoCostUsd,
    });
  }

  const byModel: BillingModelRow[] = [...modelMap.values()]
    .map((entry) => ({
      modelId: entry.modelId,
      label: formatModelDisplayName(entry.modelId),
      roles: sortRoleKeys(entry.roles),
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      ecoCostUsd: entry.ecoCostUsd,
      tokenBadge: toTokenBadge(entry),
    }))
    .sort((left, right) => roleUsageTotal(right) - roleUsageTotal(left));

  return { byAgent, byModel };
}
