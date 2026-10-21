export type BashApprovalChoice =
  | "approve"
  | "approve_remember_prefix"
  | "approve_remember_mcp_tool"
  | "deny"
  | "deny_custom";

/**
 * @deprecated Prefer i18n key `approval.bash.otherPlaceholder` in UI.
 * Free-form deny row label (locale-agnostic fallback only).
 */
export const BASH_APPROVAL_DENY_CUSTOM_OPTION_LABEL = "Other";

/** @deprecated Use BASH_APPROVAL_DENY_CUSTOM_OPTION_LABEL */
export const BASH_APPROVAL_DENY_OPTION_LABEL = BASH_APPROVAL_DENY_CUSTOM_OPTION_LABEL;

export function buildBashApprovalChoices(options?: {
  includeRememberPrefix?: boolean;
  includeRememberMcpTool?: boolean;
  suppressAlwaysAllowRule?: boolean;
}): BashApprovalChoice[] {
  const includeRemember = options?.includeRememberPrefix !== false && !options?.suppressAlwaysAllowRule;
  const rows: BashApprovalChoice[] = ["approve"];
  if (options?.includeRememberMcpTool && !options.suppressAlwaysAllowRule) {
    rows.push("approve_remember_mcp_tool");
  } else if (includeRemember) {
    rows.push("approve_remember_prefix");
  }
  rows.push("deny", "deny_custom");
  return rows;
}

export function formatBashApprovalRememberPrefix(command: string, maxLength = 48): string {
  const trimmed = command.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

/** Join a localized remember-prefix intro with a truncated command preview. */
export function buildBashApprovalRememberPrefixLabel(command: string, rememberPrefixIntro: string): string {
  return `${rememberPrefixIntro}${formatBashApprovalRememberPrefix(command)}`;
}

export function deriveBashApprovalRememberPrefix(command: string): string {
  return command.trim();
}

export function commandMatchesRememberedBashPrefix(command: string, prefix: string): boolean {
  const trimmedPrefix = prefix.trim();
  if (!trimmedPrefix) {
    return false;
  }
  const trimmedCommand = command.trim();
  return trimmedCommand === trimmedPrefix || trimmedCommand.startsWith(trimmedPrefix);
}

export function commandMatchesAnyRememberedBashPrefix(command: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => commandMatchesRememberedBashPrefix(command, prefix));
}

export function formatBashApprovalDenyMessage(feedback?: string): string {
  const trimmed = feedback?.trim();
  if (!trimmed) {
    return "User denied this Bash command.";
  }
  return `User denied this Bash command. User feedback: ${trimmed}`;
}

export function formatFilesystemApprovalDenyMessage(toolName: string, feedback?: string): string {
  const trimmed = feedback?.trim();
  if (!trimmed) {
    return `User denied this ${toolName} call.`;
  }
  return `User denied this ${toolName} call. User feedback: ${trimmed}`;
}

export function bashApprovalInitialChoiceIndex(
  choices: readonly BashApprovalChoice[],
  defaultToNo?: boolean,
): number {
  return defaultToNo ? Math.max(0, choices.indexOf("deny")) : 0;
}
export function canSubmitBashApprovalWithEnter(choice: BashApprovalChoice, defaultToNo?: boolean): boolean {
  return !defaultToNo || !choice.startsWith("approve");
}
