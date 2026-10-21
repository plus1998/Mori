import type { RuntimeAgentRole } from "../shared/ipc";

export type SubagentAgentResolveMissReason =
  | "no_thread_state"
  | "parent_tool_use_unmapped"
  | "missing_structured_agent_id";

export interface SubagentAgentResolveInput {
  role: RuntimeAgentRole;
  explicitAgentId?: string;
  parentToolUseId?: string;
  linkedParentAgentId?: string;
  hasThreadState: boolean;
  activeAgentIds?: readonly string[];
}

export interface SubagentAgentResolveResult {
  agentId?: string;
  missReason?: SubagentAgentResolveMissReason;
  activeAgentIds?: readonly string[];
}

export function resolveSubagentAgentId(input: SubagentAgentResolveInput): SubagentAgentResolveResult {
  const explicit = input.explicitAgentId?.trim();
  if (explicit) {
    return { agentId: explicit };
  }
  if (input.linkedParentAgentId) {
    return { agentId: input.linkedParentAgentId };
  }
  if (!isResolvableAgentRole(input.role)) {
    return {};
  }
  if (!input.hasThreadState) {
    return { missReason: "no_thread_state", activeAgentIds: [] };
  }

  const activeAgentIds = input.activeAgentIds ?? [];
  if (input.parentToolUseId) {
    return {
      missReason: "parent_tool_use_unmapped",
      activeAgentIds,
    };
  }

  return {
    missReason: "missing_structured_agent_id",
    activeAgentIds,
  };
}

function isResolvableAgentRole(role: RuntimeAgentRole): boolean {
  return !["assistant", "main", "main", "system", "thinking", "tool", "user"].includes(role);
}
