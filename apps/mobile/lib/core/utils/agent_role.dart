/// `planner` is the historical name of the main agent, not a subagent role.
String normalizeAgentRole(String role) => role == 'planner' ? 'main' : role;
