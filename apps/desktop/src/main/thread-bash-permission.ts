import type { EcoAgentRuntimeConfig } from "@eco/runtime";
import {
  type ExecutionConfirmationMode,
  evaluateBashConfirmation,
  evaluateBashHookGate,
  resolveAgentBashPolicyForConfirmation,
  type ToolConfirmationDecision,
} from "@eco/runtime";
import { commandMatchesAnyRememberedBashPrefix } from "../shared/bash-approval-ui";

export type { ExecutionConfirmationMode, ToolConfirmationDecision };

export interface ThreadToolConfirmationInput {
  command: string;
  cwd: string;
  workspacePath: string;
  confirmationMode: ExecutionConfirmationMode;
  agentRegistry?: EcoAgentRuntimeConfig | undefined;
  agentId?: string;
  agentType?: string;
  phaseAllowsExecution?: boolean;
  sessionBashRememberPrefixes?: readonly string[];
}

/** Desktop canUseTool：Bash 的单一确认决策入口。 */
export function evaluateThreadToolConfirmation(input: ThreadToolConfirmationInput): ToolConfirmationDecision {
  const agentBash = resolveAgentBashPolicyForConfirmation({
    ...(input.agentRegistry ? { registry: input.agentRegistry } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.agentType ? { agentType: input.agentType } : {}),
  });
  const hardDeny = evaluateBashHookGate({
    command: input.command,
    cwd: input.cwd,
    workspacePath: input.workspacePath,
    confirmationMode: input.confirmationMode,
    ...(input.phaseAllowsExecution !== undefined ? { phaseAllowsExecution: input.phaseAllowsExecution } : {}),
    ...(agentBash ? { agentBash } : {}),
  });
  if (hardDeny) return hardDeny;
  if (
    input.sessionBashRememberPrefixes?.length &&
    commandMatchesAnyRememberedBashPrefix(input.command, input.sessionBashRememberPrefixes)
  ) {
    return {
      action: "allow",
      reason: "Previously approved for commands with this prefix in the current session.",
      userMessage: "bash.session.rememberedPrefix",
      matchedRule: "session_bash_prefix",
    };
  }

  return evaluateBashConfirmation({
    command: input.command,
    cwd: input.cwd,
    workspacePath: input.workspacePath,
    confirmationMode: input.confirmationMode,
    ...(input.phaseAllowsExecution !== undefined ? { phaseAllowsExecution: input.phaseAllowsExecution } : {}),
    ...(agentBash ? { agentBash } : {}),
  });
}

/** @deprecated 使用 evaluateThreadToolConfirmation */
export const evaluateThreadBashPermission = evaluateThreadToolConfirmation;
