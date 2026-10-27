/**
 * Shared multi-step scenario prompt for Codex / PI / Claude SDK recording.
 */
export function buildScenarioPrompt(marker) {
  return [
    `You are running an Mori conversation-round scenario smoke. Marker=${marker}.`,
    "Complete EVERY step below in order. Be concise.",
    "",
    "1) SKILL: Load/use the skill named smoke-skill (or read its SKILL.md). Include the exact tokens SMOKE_SKILL_OK and the marker in a short reply line.",
    "2) FILE WRITE: Create a file named smoke-note.txt in the workspace containing exactly:",
    `SMOKE_FILE:${marker}`,
    "3) FILE READ: Read smoke-note.txt back and confirm its contents.",
    "4) MCP: Call the eco_smoke MCP tool smoke_ping with argument marker set to the session marker. Expect SMOKE_MCP_PONG in the tool result.",
    "5) SUBAGENT: Spawn exactly one subagent with agent_type/role smoke_worker. Tell it to reply with exactly:",
    `SMOKE_CHILD:${marker}`,
    "Wait for the child to finish.",
    "6) FINAL: After all steps, reply with a single line exactly:",
    `SMOKE_DONE:${marker}`,
    "",
    "Do not skip steps. Prefer tools over guessing.",
  ].join("\n");
}
