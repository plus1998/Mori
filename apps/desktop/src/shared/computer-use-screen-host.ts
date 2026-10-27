/**
 * Pure helpers for Screen Recording TCC host labels.
 * No Node built-ins — safe for renderer / sandboxed preload imports.
 *
 * Live process-tree detection lives in main (`computer-use-screen-host-native.ts`).
 */
export const PACKAGED_SCREEN_RECORDING_APP_LABEL = "Mori";

/** Process / app names that are runners, not the TCC host the user must toggle. */
const SKIP_APP_NAMES = new Set(
  [
    "electron",
    "electron helper",
    "electron helper (renderer)",
    "electron helper (gpu)",
    "electron helper (plugin)",
    "node",
    "bun",
    "npm",
    "pnpm",
    "yarn",
    "tsx",
    "vite",
    "zsh",
    "bash",
    "sh",
    "fish",
    "dash",
    "login",
    "tmux",
    "screen",
    "ssh",
    "sudo",
    "env",
    "nohup",
    "script",
    "caffeinate",
    "launchd",
    "init",
  ].map((name) => name.toLowerCase()),
);

export function mapTermProgramToScreenHost(termProgram: string | undefined): string | undefined {
  const value = termProgram?.trim();
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "Apple_Terminal":
      return "Terminal";
    case "iTerm.app":
      return "iTerm";
    case "WarpTerminal":
      return "Warp";
    case "ghostty":
      return "Ghostty";
    case "kitty":
      return "kitty";
    case "alacritty":
      return "Alacritty";
    case "vscode":
      return "Code";
    case "cursor":
      return "Cursor";
    default:
      return undefined;
  }
}

/** Extract a System Settings–friendly label from a `ps` command line / path. */
export function screenHostLabelFromCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  const appMatch = trimmed.match(/\/([^/]+)\.app\//i);
  if (appMatch?.[1]) {
    return normalizeScreenHostAppName(appMatch[1]);
  }
  // Bare `ps` ucomm / short name only — never guess from long CLI argv strings.
  if (/^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/.test(trimmed)) {
    return normalizeScreenHostAppName(trimmed);
  }
  return undefined;
}

export function normalizeScreenHostAppName(raw: string): string | undefined {
  const name = raw.trim();
  if (!name) {
    return undefined;
  }
  const lower = name.toLowerCase();
  if (SKIP_APP_NAMES.has(lower) || lower.startsWith("electron helper")) {
    return undefined;
  }
  if (lower === "iterm2" || lower === "iterm") {
    return "iTerm";
  }
  if (lower === "terminal") {
    return "Terminal";
  }
  if (lower === "warp") {
    return "Warp";
  }
  if (lower === "code" || lower === "code helper" || lower === "code - oss") {
    return "Code";
  }
  if (lower === "cursor" || lower.startsWith("cursor helper")) {
    return "Cursor";
  }
  return name;
}

/**
 * Prefer the first non-runner ancestor app (Terminal / iTerm / Cursor…),
 * then TERM_PROGRAM, then Electron.
 */
export function resolveDevScreenRecordingHostLabel(input: {
  ancestorCommands: string[];
  termProgram?: string;
  fallback?: string;
}): string {
  for (const command of input.ancestorCommands) {
    const label = screenHostLabelFromCommand(command);
    if (label) {
      return label;
    }
  }
  return (
    mapTermProgramToScreenHost(input.termProgram) ??
    input.fallback?.trim() ??
    "Electron"
  );
}

export function readProcessAncestorCommands(
  startPid: number,
  options: {
    maxDepth?: number;
    readEntry: (pid: number) => { ppid: number; command: string } | undefined;
  },
): string[] {
  const maxDepth = options.maxDepth ?? 16;
  const commands: string[] = [];
  let pid = startPid;
  const seen = new Set<number>();
  for (let depth = 0; depth < maxDepth && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const entry = options.readEntry(pid);
    if (!entry) {
      break;
    }
    if (entry.command.trim()) {
      commands.push(entry.command.trim());
    }
    pid = entry.ppid;
  }
  return commands;
}

/**
 * Resolve from already-known inputs (no process inspection).
 * Packaged → Mori. Dev → caller-supplied ancestors / TERM_PROGRAM.
 */
export function resolveScreenRecordingAppLabel(input?: {
  packaged?: boolean;
  ancestorCommands?: string[];
  termProgram?: string;
  fallback?: string;
}): string {
  if (input?.packaged === true) {
    return PACKAGED_SCREEN_RECORDING_APP_LABEL;
  }
  return resolveDevScreenRecordingHostLabel({
    ancestorCommands: input?.ancestorCommands ?? [],
    ...(input?.termProgram === undefined ? {} : { termProgram: input.termProgram }),
    ...(input?.fallback === undefined ? {} : { fallback: input.fallback }),
  });
}
