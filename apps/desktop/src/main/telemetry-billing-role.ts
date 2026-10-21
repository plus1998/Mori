import { AGENT_ROLES, type AgentRole, type RuntimeAgentRole } from "../shared/ipc";

const NON_AGENT_TELEMETRY_ROLES = new Set(["assistant", "main", "system", "thinking", "tool", "user"]);

export function normalizeTelemetryBillingRole(role: string): RuntimeAgentRole {
  const trimmed = role.trim();
  if (!trimmed) {
    return "main";
  }
  const normalized = trimmed.startsWith("eco_") ? trimmed.slice(4) : trimmed;
  if (NON_AGENT_TELEMETRY_ROLES.has(normalized)) {
    return "main";
  }
  if (AGENT_ROLES.includes(normalized as AgentRole)) {
    return normalized as AgentRole;
  }
  return normalized;
}
