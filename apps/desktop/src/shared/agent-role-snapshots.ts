import { normalizeAgentRole } from "@eco/shared";
import type { ThreadBillingSnapshot, ThreadBillingSourceSnapshot, ThreadContextSnapshot } from "./ipc";

/** Merge old/new keys explicitly: both may carry usage after an upgrade. */
export function normalizeAgentRoleMap<T>(
  source: Readonly<Partial<Record<string, T>>>,
  merge: (previous: T, current: T) => T,
): Partial<Record<string, T>> {
  const result: Partial<Record<string, T>> = {};
  // Canonical metadata wins when both names exist, independent of JSON key order.
  const entries = Object.entries(source).sort(([left], [right]) =>
    left === "planner" ? -1 : right === "planner" ? 1 : 0,
  );
  for (const [role, value] of entries) {
    if (value === undefined) continue;
    const key = normalizeAgentRole(role);
    const previous = result[key];
    result[key] = previous === undefined ? value : merge(previous, value);
  }
  return result;
}

function normalizeBillingRoleFields<T extends Pick<ThreadBillingSourceSnapshot, "byRole" | "byModel">>(
  snapshot: T,
): T {
  return {
    ...snapshot,
    ...(snapshot.byRole && {
      byRole: normalizeAgentRoleMap(snapshot.byRole, (previous, current) => ({
        ...previous,
        ...current,
        inputTokens: previous.inputTokens + current.inputTokens,
        outputTokens: previous.outputTokens + current.outputTokens,
        cacheReadTokens: previous.cacheReadTokens + current.cacheReadTokens,
        cacheCreationTokens: previous.cacheCreationTokens + current.cacheCreationTokens,
        ecoCostUsd: previous.ecoCostUsd + current.ecoCostUsd,
      })),
    }),
    ...(snapshot.byModel && {
      byModel: snapshot.byModel.map((model) => ({
        ...model,
        roles: [...new Set(model.roles.map((role) => normalizeAgentRole(role)))],
      })),
    }),
  };
}

export function normalizeBillingSnapshotRoles(snapshot: ThreadBillingSnapshot): ThreadBillingSnapshot {
  return {
    ...normalizeBillingRoleFields(snapshot),
    ...(snapshot.sourceBreakdown && {
      sourceBreakdown: Object.fromEntries(
        Object.entries(snapshot.sourceBreakdown).map(([source, value]) => [
          source,
          normalizeBillingRoleFields(value),
        ]),
      ),
    }),
    ...(snapshot.subagents && {
      subagents: snapshot.subagents.map((agent) => ({ ...agent, role: normalizeAgentRole(agent.role) })),
    }),
  };
}

export function normalizeContextSnapshotRoles(snapshot: ThreadContextSnapshot): ThreadContextSnapshot {
  return {
    ...snapshot,
    ...(snapshot.displayRole !== undefined && { displayRole: normalizeAgentRole(snapshot.displayRole) }),
    ...(snapshot.roles && {
      // Context is a session gauge, not additive usage. Keep the canonical gauge
      // if an old role gauge is still present alongside it.
      roles: Object.values(
        normalizeAgentRoleMap(
          Object.fromEntries(snapshot.roles.map((item) => [item.role, item])),
          (_previous, current) => current,
        ),
      ).flatMap((item) => (item ? [{ ...item, role: normalizeAgentRole(item.role) }] : [])),
    }),
    ...(snapshot.instances && {
      instances: snapshot.instances.map((item) => ({ ...item, role: normalizeAgentRole(item.role) })),
    }),
  };
}
