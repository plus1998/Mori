import type { EcoAgentRuntimeConfig, ForcedPlanDelegationHookConfig } from "@eco/runtime";
import { clearCodexForcedPlanDelegationsSync, writeCodexForcedPlanDelegationSync } from "@eco/runtime";
import type { ForcedPlanDelegationAttempt, PlanExecutionTarget } from "@eco/runtime/forced-plan-delegation";
import { buildForcedPlanDelegationTask } from "@eco/runtime/forced-plan-delegation";
import { ForcedPlanDelegationStore } from "./forced-plan-delegation-store.js";

/** Process-wide ledger for forced plan delegations, keyed by thread id. */
export const forcedPlanDelegationStore = new ForcedPlanDelegationStore();

let resolveCodexHomeDir: (() => string | undefined) | undefined;

/** Host wiring: how to locate CODEX_HOME for the Codex forced-delegation hook file. */
export function configureForcedPlanDelegationCodexHome(resolver: () => string | undefined): void {
  resolveCodexHomeDir = resolver;
}

function codexHomeDirOrUndefined(): string | undefined {
  return resolveCodexHomeDir?.();
}

/** Mirrors codex-role-sync `sanitizeCodexRoleId` (not re-exported by the package). */
function sanitizeCodexRoleId(agentKey: string): string {
  const sanitized = agentKey
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return sanitized || agentKey.trim().toLowerCase();
}

function clearCodexForcedDelegationSideEffects(): void {
  const codexHome = codexHomeDirOrUndefined();
  if (codexHome) {
    clearCodexForcedPlanDelegationsSync(codexHome);
  }
}

/** Arm a one-shot delegation for an approved plan and return the canonical task. */
export function armForcedPlanDelegation(input: {
  threadId: string;
  coreKind: string;
  target: Extract<PlanExecutionTarget, { kind: "subagent" }>;
  plan: string;
}): ForcedPlanDelegationAttempt {
  const canonicalTask = buildForcedPlanDelegationTask({
    plan: input.plan,
    ...(input.target.additionalMessage !== undefined
      ? { additionalMessage: input.target.additionalMessage }
      : {}),
  });
  const attempt = forcedPlanDelegationStore.arm({
    threadId: input.threadId,
    coreKind: input.coreKind,
    agentKey: input.target.agentKey,
    canonicalTask,
  });
  const codexHome = codexHomeDirOrUndefined();
  if (input.coreKind === "codex" && codexHome) {
    // Clear stale arms first, then write exactly one one-shot file for this role.
    clearCodexForcedPlanDelegationsSync(codexHome);
    writeCodexForcedPlanDelegationSync(codexHome, {
      agentRole: sanitizeCodexRoleId(input.target.agentKey),
      canonicalTask,
    });
  }
  return attempt;
}

/**
 * Restrict the orchestration roster to the chosen subagent for the duration of the
 * forced-delegation run. Claude, Codex, and PI all derive their exposed subagents from
 * this registry, so a single restriction point covers every core.
 */
export function restrictAgentRuntimeConfigToForcedDelegation(
  config: EcoAgentRuntimeConfig | undefined,
  threadId: string,
): EcoAgentRuntimeConfig | undefined {
  const attempt = forcedPlanDelegationStore.get(threadId);
  if (!config || !attempt || attempt.status !== "armed") {
    return config;
  }
  const agent = config.orchestration.agents.find((candidate) => candidate.agentKey === attempt.agentKey);
  if (!agent) {
    // Do not silently run with the full roster; the approval handler validated the key,
    // so a missing agent here is a real gap and must surface as a failed delegation.
    return config;
  }
  return {
    ...config,
    orchestration: { ...config.orchestration, agents: [agent] },
  };
}

/** Hook context wiring for the Claude core. */
export function buildForcedPlanDelegationHookConfig(
  threadId: string,
): ForcedPlanDelegationHookConfig | undefined {
  const attempt = forcedPlanDelegationStore.get(threadId);
  if (!attempt || (attempt.status !== "armed" && attempt.status !== "claimed")) {
    return undefined;
  }
  return {
    agentKey: attempt.agentKey,
    canonicalTask: attempt.canonicalTask,
    claimSpawn: ({ toolUseId, agentKey }) => {
      const result = forcedPlanDelegationStore.claimSpawn({
        threadId,
        agentKey,
        ...(toolUseId ? { toolUseId } : {}),
      });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    confirmSpawn: ({ agentKey, toolUseIds }) => {
      forcedPlanDelegationStore.confirmSpawn({ threadId, agentKey, toolUseIds });
    },
  };
}

/** Confirm a host-observed subagent start (used by cores without SDK SubagentStart hooks). */
export function confirmForcedPlanDelegationSpawn(
  threadId: string,
  input: { agentKey: string; toolUseIds?: readonly string[] },
): void {
  const attempt = forcedPlanDelegationStore.get(threadId);
  if (!attempt || (attempt.status !== "armed" && attempt.status !== "claimed")) {
    return;
  }
  if (attempt.status === "armed") {
    const claim = forcedPlanDelegationStore.claimSpawn({
      threadId,
      agentKey: input.agentKey,
      ...(input.toolUseIds?.[0] ? { toolUseId: input.toolUseIds[0] } : {}),
    });
    if (!claim.ok) {
      return;
    }
  }
  forcedPlanDelegationStore.confirmSpawn({
    threadId,
    agentKey: input.agentKey,
    ...(input.toolUseIds ? { toolUseIds: input.toolUseIds } : {}),
  });
}

/** Confirm Codex delegations only from persisted lifecycle events with a parent tool call. */
export function confirmForcedPlanDelegationFromRuntimeEvent(input: {
  eventType: string;
  threadId: string;
  role?: string | null;
  parentToolUseId?: string | null;
}): void {
  if (input.eventType !== "agent.started") {
    return;
  }
  const agentKey = input.role?.trim();
  const parentToolUseId = input.parentToolUseId?.trim();
  if (!agentKey || !parentToolUseId) {
    return;
  }
  confirmForcedPlanDelegationSpawn(input.threadId, {
    agentKey,
    toolUseIds: [parentToolUseId],
  });
}

export function releaseForcedPlanDelegation(threadId: string): void {
  forcedPlanDelegationStore.release(threadId);
  clearCodexForcedDelegationSideEffects();
}

/**
 * Startup hygiene: an interrupted process may leave an in-memory attempt or an on-disk
 * Codex hook file behind. Drop both so a stale arm never affects later normal turns.
 */
export function clearStaleForcedPlanDelegationState(): void {
  forcedPlanDelegationStore.clearAll();
  clearCodexForcedDelegationSideEffects();
}

export interface ForcedPlanDelegationSettlement {
  outcome: "completed" | "failed";
  reason?: string;
}

/**
 * Settle an armed attempt when the delegation run finishes. Only a successful run
 * whose subagent actually spawned may report completion; everything else fails loudly
 * so the pending plan can be restored and retried.
 */
export function settleForcedPlanDelegation(
  threadId: string,
  input: { ok: boolean; reason?: string },
): ForcedPlanDelegationSettlement | undefined {
  const attempt = forcedPlanDelegationStore.get(threadId);
  if (!attempt) {
    return undefined;
  }
  if (attempt.status === "failed" || attempt.status === "violated") {
    const reason = attempt.failureReason ?? input.reason ?? "计划委派失败。";
    forcedPlanDelegationStore.release(threadId);
    clearCodexForcedDelegationSideEffects();
    return { outcome: "failed", reason };
  }
  if (attempt.status === "claimed") {
    forcedPlanDelegationStore.resetUnstartedClaim(threadId);
    return {
      outcome: "failed",
      reason: input.reason ?? `指定的子代理「${attempt.agentKey}」未能启动；已保留批准计划，可直接重试。`,
    };
  }
  if (input.ok) {
    if (attempt.status !== "spawned" && attempt.status !== "completed") {
      const reason = `指定的子代理「${attempt.agentKey}」没有实际执行计划（终态：${attempt.status}）。`;
      forcedPlanDelegationStore.fail(threadId, reason);
      forcedPlanDelegationStore.release(threadId);
      clearCodexForcedDelegationSideEffects();
      return { outcome: "failed", reason };
    }
    forcedPlanDelegationStore.complete(threadId);
    forcedPlanDelegationStore.release(threadId);
    clearCodexForcedDelegationSideEffects();
    return { outcome: "completed" };
  }
  const reason = input.reason ?? "计划委派失败。";
  forcedPlanDelegationStore.fail(threadId, reason);
  forcedPlanDelegationStore.release(threadId);
  clearCodexForcedDelegationSideEffects();
  return { outcome: "failed", reason };
}
