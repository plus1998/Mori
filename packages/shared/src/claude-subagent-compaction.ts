export const CLAUDE_SUBAGENT_COMPACT_WINDOW_MIN = 100_000;
export const CLAUDE_SUBAGENT_COMPACT_WINDOW_MAX = 1_000_000;

export function validateClaudeSubagentCompactWindow(
  value: unknown,
  label = "子代理",
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < CLAUDE_SUBAGENT_COMPACT_WINDOW_MIN ||
    (value as number) > CLAUDE_SUBAGENT_COMPACT_WINDOW_MAX
  ) {
    throw new Error(`${label}的 Claude 压缩窗口必须是 100000～1000000 之间的整数。`);
  }
}
