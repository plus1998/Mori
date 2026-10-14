/**
 * Codex sends tool calls by *function* name (`apply_patch`, `shell`, an MCP tool). The Feed
 * labels the item type Codex turns them into, and the two must agree: a write announced as
 * "正在写入工具调用 · Edit" has to be followed by an "Edit · path" card, not "apply_patch".
 * `codex-event-adapter.ts` labels `fileChange` "Edit" and `commandExecution` "Bash".
 *
 * Unknown names keep the model's own name — MCP tools are already shown that way, and inventing
 * a label for a tool we have not seen would hide which tool is actually being written.
 */
const CODEX_TOOL_DISPLAY_NAMES: Record<string, string> = {
  apply_patch: "Edit",
  shell: "Bash",
  exec_command: "Bash",
  local_shell: "Bash",
  write_stdin: "Bash",
  update_plan: "Plan",
  web_search: "WebSearch",
};

export function codexToolDisplayName(toolName: string): string {
  const name = toolName.trim();
  return CODEX_TOOL_DISPLAY_NAMES[name] ?? name;
}
