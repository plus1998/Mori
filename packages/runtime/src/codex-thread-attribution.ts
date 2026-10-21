import type { RuntimeAgentRole } from "../../shared/src";

/** Eco-side thread attribution resolved from the persisted Codex thread map. */
export interface CodexThreadAttribution {
  ecoThreadId: string;
  billingRole: RuntimeAgentRole;
  agentId?: string;
  parentEcoThreadId?: string;
  isSubagentThread?: boolean;
}

export function resolveDefaultCodexThreadAttribution(input: {
  codexThreadId: string;
  ecoThreadId: string;
  /** Codex parent thread id, used only to identify a child thread. */
  parentThreadId?: string | undefined;
  /** Parent Eco thread id when known. */
  parentEcoThreadId?: string | undefined;
  agentRole?: string | undefined;
}): CodexThreadAttribution {
  const isSubagentThread = Boolean(input.parentThreadId?.trim() || input.parentEcoThreadId?.trim());
  const billingRole = resolveCodexBillingRole(input.agentRole, isSubagentThread);
  const parentEcoThreadId = isSubagentThread
    ? input.parentEcoThreadId?.trim() || input.ecoThreadId.trim()
    : undefined;
  return {
    ecoThreadId: input.ecoThreadId,
    billingRole,
    ...(parentEcoThreadId && { parentEcoThreadId }),
    ...(isSubagentThread && { isSubagentThread: true }),
  };
}

function resolveCodexBillingRole(agentRole: string | undefined, isSubagentThread: boolean): RuntimeAgentRole {
  const normalized = agentRole?.trim().toLowerCase();
  if (normalized) {
    return normalized as RuntimeAgentRole;
  }
  return isSubagentThread ? "subagent" : "main";
}
