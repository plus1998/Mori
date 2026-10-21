/** `planner` was the original name of the main agent, never a separate agent. */
export function normalizeAgentRole(role: string): string;
export function normalizeAgentRole(role: string | undefined): string | undefined;
export function normalizeAgentRole(role: string | undefined): string | undefined {
  return role === "planner" ? "main" : role;
}

export function isMainAgentRole(role: string | undefined): boolean {
  return role === "main" || role === "planner";
}

/** Persisted agent identities are immutable, including the old main-agent prefix. */
export function isMainAgentId(agentId: string): boolean {
  return agentId.startsWith("main:") || agentId.startsWith("planner:");
}
