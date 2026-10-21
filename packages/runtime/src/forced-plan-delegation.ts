/**
 * "指定子代理执行已批准计划" — shared contract.
 *
 * A user may approve a pending plan and choose to have it executed by one specific
 * subagent instead of the main agent. The host (desktop main) is responsible for
 * enforcing the choice; these helpers produce the exact, canonical task text and
 * validate the requested target. Nothing here may summarise, trim, or truncate the
 * plan body — the approved plan must reach the subagent verbatim.
 */

/** Where an approved plan should run. Legacy approvals omit this and mean the main agent. */
export type PlanExecutionTarget =
  | { kind: "main" }
  | {
      kind: "subagent";
      agentKey: string;
      /** Optional user note, appended verbatim after trimming. */
      additionalMessage?: string;
    };

export const FORCED_PLAN_DELEGATION_CORES = ["claude", "codex", "pi"] as const;

export function supportsForcedPlanDelegation(coreKind: string | null | undefined): boolean {
  const core = coreKind?.trim() ?? "";
  return (FORCED_PLAN_DELEGATION_CORES as readonly string[]).includes(core);
}

export interface PlanDelegationAgentOption {
  agentKey: string;
  displayName: string;
  /**
   * Whether this agent can actually execute a plan. Read-only agents (explore/architect)
   * never can: delegating a plan to them always fails, so they must not be selectable.
   */
  canExecutePlan: boolean;
}

/** Tool policy subset needed to decide whether a role may modify the workspace. */
export interface PlanDelegationAgentTools {
  filesystem?: { write?: string };
  bash?: { enabled?: boolean };
  disallowed?: readonly string[];
  coreOverrides?: {
    claude?: { disallowedTools?: readonly string[] };
    codex?: { sandboxMode?: string };
  };
}

const WORKSPACE_WRITE_TOOL_NAMES = ["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"] as const;

/**
 * A role may execute an approved plan only when its tool policy allows workspace writes
 * (and it is not sandboxed read-only). Explore/Architect are read-only by design.
 */
export function planDelegationAgentCanExecutePlan(tools: PlanDelegationAgentTools | undefined): boolean {
  if (!tools) {
    return false;
  }
  if (tools.coreOverrides?.codex?.sandboxMode === "read-only") {
    return false;
  }
  if (tools.filesystem?.write !== "workspace") {
    return false;
  }
  const denied = new Set<string>([
    ...(tools.disallowed ?? []),
    ...(tools.coreOverrides?.claude?.disallowedTools ?? []),
  ]);
  return !WORKSPACE_WRITE_TOOL_NAMES.some((name) => denied.has(name));
}

/**
 * Enabled subagents from the thread's locked orchestration snapshot.
 * The list never follows live global settings — only the snapshot captured at thread start.
 */
export function listPlanDelegationAgents(
  snapshot:
    | {
        agents?: ReadonlyArray<{
          agentKey?: string;
          displayName?: string;
          enabled?: boolean;
          tools?: PlanDelegationAgentTools;
        }>;
      }
    | undefined,
): PlanDelegationAgentOption[] {
  if (!snapshot?.agents) {
    return [];
  }
  const seen = new Set<string>();
  const options: PlanDelegationAgentOption[] = [];
  for (const agent of snapshot.agents) {
    const agentKey = typeof agent.agentKey === "string" ? agent.agentKey.trim() : "";
    if (!agentKey || agent.enabled !== true || seen.has(agentKey)) {
      continue;
    }
    seen.add(agentKey);
    const displayName = typeof agent.displayName === "string" ? agent.displayName.trim() : "";
    options.push({
      agentKey,
      displayName: displayName || agentKey,
      canExecutePlan: planDelegationAgentCanExecutePlan(agent.tools),
    });
  }
  return options;
}

/**
 * Build the canonical task handed to the chosen subagent.
 *
 * The approved plan is embedded verbatim (no trim beyond the outer boundary, no
 * truncation, no re-wording). The optional user note is trimmed and, when empty,
 * the whole `<additional_user_message>` block is omitted.
 */
export function buildForcedPlanDelegationTask(input: { plan: string; additionalMessage?: string }): string {
  const sections: string[] = [
    "执行以下已经由用户批准的完整计划。",
    "",
    "<approved_plan>",
    input.plan,
    "</approved_plan>",
  ];

  const additionalMessage = input.additionalMessage?.trim() ?? "";
  if (additionalMessage) {
    sections.push("", "<additional_user_message>", additionalMessage, "</additional_user_message>");
  }

  sections.push(
    "",
    "严格按获批计划列出的步骤和约束执行；计划是唯一任务范围。计划给出精确命令或唯一工具动作时，直接按原文执行，不要先做无关的环境检查、目录/文件浏览或额外验证。计划没有要求额外验证时，不要自行追加检查。",
    "完成计划明确要求的步骤后，立即将实际结果返回给主代理。不要再委派其他代理。",
  );
  return sections.join("\n");
}

/**
 * User instruction for the parent, using the chosen subagent's callable runtime
 * name. The approved plan body is supplied separately by the host hooks.
 */
export function buildForcedPlanDelegationContract(input: { agentKey: string }): string {
  return `用户要求使用子代理「${input.agentKey}」执行已批准的计划。`;
}

export type ForcedPlanDelegationErrorCode =
  | "unsupported_core"
  | "empty_agent_key"
  | "unknown_agent"
  | "disabled_agent"
  | "read_only_agent";

export type PlanExecutionTargetValidation =
  | { ok: true; target: PlanExecutionTarget }
  | { ok: false; code: ForcedPlanDelegationErrorCode; reason: string };

/**
 * Validate a renderer-supplied target against the trusted core + snapshot.
 * `main` (and an omitted target) always pass; subagent targets must name an enabled
 * agent from the locked snapshot and a core that supports delegation.
 */
export function validatePlanExecutionTarget(input: {
  target?: PlanExecutionTarget;
  coreKind: string | null | undefined;
  agents: readonly PlanDelegationAgentOption[];
  agentEnabled?: (agentKey: string) => boolean;
}): PlanExecutionTargetValidation {
  const target = input.target ?? { kind: "main" };
  if (target.kind === "main") {
    return { ok: true, target };
  }

  if (!supportsForcedPlanDelegation(input.coreKind)) {
    return {
      ok: false,
      code: "unsupported_core",
      reason: `当前 Harness（${input.coreKind ?? "unknown"}）不支持指定子代理执行计划。`,
    };
  }

  const agentKey = target.agentKey.trim();
  if (!agentKey) {
    return { ok: false, code: "empty_agent_key", reason: "必须选择一个子代理。" };
  }

  const known = input.agents.find((agent) => agent.agentKey === agentKey);
  if (!known) {
    return {
      ok: false,
      code: "unknown_agent",
      reason: `子代理「${agentKey}」不在该线程锁定的编排快照中。`,
    };
  }

  if (input.agentEnabled && !input.agentEnabled(agentKey)) {
    return {
      ok: false,
      code: "disabled_agent",
      reason: `子代理「${agentKey}」已被禁用，无法执行计划。`,
    };
  }

  if (!known.canExecutePlan) {
    return {
      ok: false,
      code: "read_only_agent",
      reason: `子代理「${known.displayName}」是只读代理，无法执行计划。请选择一个可以修改工作区的子代理。`,
    };
  }

  const additionalMessage = target.additionalMessage?.trim() ?? "";
  return {
    ok: true,
    target: {
      kind: "subagent",
      agentKey,
      ...(additionalMessage ? { additionalMessage } : {}),
    },
  };
}

/** Runtime status of a single forced-delegation attempt. */
export type ForcedPlanDelegationAttemptStatus =
  | "armed"
  | "claimed"
  | "spawned"
  | "completed"
  | "failed"
  | "violated";

export interface ForcedPlanDelegationAttempt {
  runAttemptId: string;
  threadId: string;
  coreKind: string;
  agentKey: string;
  canonicalTask: string;
  status: ForcedPlanDelegationAttemptStatus;
  createdAt: string;
  spawnToolUseId?: string;
  failureReason?: string;
}
