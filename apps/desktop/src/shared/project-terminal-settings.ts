export interface ProjectTerminalSettingsSnapshot {
  workspacePath: string;
  startupCommand: string;
}

export const MAX_TERMINAL_STARTUP_COMMAND_LENGTH = 16000;

export function normalizeTerminalStartupCommand(value: string): string {
  if (typeof value !== "string") throw new Error("Terminal startup command must be a string.");
  if (value.length > MAX_TERMINAL_STARTUP_COMMAND_LENGTH) {
    throw new Error(`Terminal startup command exceeds ${MAX_TERMINAL_STARTUP_COMMAND_LENGTH} characters.`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject terminal controls while allowing tabs and line breaks in scripts.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error("Terminal startup command contains unsupported control characters.");
  }
  return value.replace(/\r\n?/g, "\n").trim();
}
