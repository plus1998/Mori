/**
 * What a tool call is doing, read from the arguments that have streamed so far.
 *
 * The Feed can say more than "the model is writing a tool call": the arguments arrive while the
 * call is being written, and for file writes and commands they name their target within the
 * first fragments. Nothing here inspects a *complete* input object — the whole point is that the
 * JSON is still truncated when we read it — so both readers work on raw text.
 */
export type ToolWriteKind = "file" | "read" | "command" | "tool";

/** Tools whose call writes a file. `apply_patch` is what Codex sends; the rest are the SDK's. */
const FILE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
]);

/** Tools whose call reads a file. */
const FILE_READ_TOOL_NAMES: ReadonlySet<string> = new Set(["Read", "NotebookRead"]);

/** Tools whose call runs a command. */
const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Bash",
  "BashOutput",
  "KillBash",
  "shell",
  "exec_command",
  "local_shell",
  "write_stdin",
]);

export function classifyToolWriteKind(toolName: string): ToolWriteKind {
  const name = toolName.trim();
  if (FILE_WRITE_TOOL_NAMES.has(name)) {
    return "file";
  }
  if (FILE_READ_TOOL_NAMES.has(name)) {
    return "read";
  }
  if (COMMAND_TOOL_NAMES.has(name)) {
    return "command";
  }
  return "tool";
}

/** Longest target kept; the Feed truncates further for display. */
const MAX_TARGET_LENGTH = 120;

/**
 * The path, pattern or command line the call names, or undefined while the arguments have not
 * reached it yet. `argumentsText` may be truncated mid-string at any point.
 */
export function readToolWriteTarget(input: { toolName: string; argumentsText: string }): string | undefined {
  return readToolWriteTargetDetail(input).target;
}

/**
 * `final` is true when the text that named the target is closed — a JSON string's closing quote, a
 * V4A marker's newline — so further fragments cannot change the answer. An argv array is only
 * closed by its `]`, because another element would extend the command line. Callers that would
 * otherwise re-read a growing argument stream use this to stop looking.
 */
export interface ToolWriteTargetRead {
  target?: string | undefined;
  final: boolean;
}

export function readToolWriteTargetDetail(input: {
  toolName: string;
  argumentsText: string;
}): ToolWriteTargetRead {
  const text = input.argumentsText;
  if (!text.trim()) {
    return { final: false };
  }
  // Codex patches name their file in a V4A marker; the JSON readers below never see it because
  // a custom tool's input is the patch text itself, not JSON.
  const patchTarget = readPatchTarget(text);
  if (patchTarget) {
    return { target: truncateTarget(patchTarget), final: true };
  }
  if (classifyToolWriteKind(input.toolName) === "file" || classifyToolWriteKind(input.toolName) === "read") {
    return jsonStringRead(text, FILE_PATH_KEYS);
  }
  const command = readJsonCommand(text);
  if (command.value) {
    return { target: truncateTarget(stripShellInvocation(command.value)), final: command.closed };
  }
  return jsonStringRead(text, FILE_PATH_KEYS);
}

function jsonStringRead(text: string, keys: readonly string[]): ToolWriteTargetRead {
  const value = readJsonString(text, keys);
  return value ? { target: truncateTarget(value), final: true } : { final: false };
}

/** `file_path` first: it is the SDK's canonical key and never a URL or a search pattern. */
const FILE_PATH_KEYS = ["file_path", "filePath", "notebook_path", "notebookPath", "path"];

/**
 * V4A markers, in the order Codex writes them. `*** Update File:` precedes a move.
 *
 * The line must be *finished* — the newline, or the escape that holds it, has to have arrived —
 * so a path that is still streaming reads as not-yet-known instead of being shown, corrected.
 */
const PATCH_TARGET_PATTERN = /^\*\*\* (?:Add|Update|Delete) File: *([^\n\\]+)(?:\n|\\n)/m;

function readPatchTarget(text: string): string | undefined {
  const match = PATCH_TARGET_PATTERN.exec(text);
  const raw = match?.[1]?.trim();
  return raw ? raw : undefined;
}

/**
 * Read one JSON string value straight out of truncated text. The regex requires the closing
 * quote, so a value that is still streaming simply reads as "not known yet" instead of as a
 * half path.
 */
function readJsonString(text: string, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const match = pattern.exec(text);
    const raw = match?.[1];
    if (raw === undefined) {
      continue;
    }
    const value = unescapeJsonString(raw).trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * `command` is a string for most providers and an argv array (`["bash","-lc","wc -l x"]`) for
 * Codex's shell tool; an array that is still streaming contributes only its complete elements.
 */
function readJsonCommand(text: string): { value?: string | undefined; closed: boolean } {
  const single = readJsonString(text, ["command", "cmd"]);
  if (single) {
    return { value: single, closed: true };
  }
  const arrayStart = /"(?:command|cmd)"\s*:\s*\[/.exec(text);
  if (!arrayStart) {
    return { closed: false };
  }
  const tail = text.slice(arrayStart.index + arrayStart[0].length);
  const elements: string[] = [];
  let closed = false;
  const elementPattern = /"((?:[^"\\]|\\.)*)"|]/g;
  for (const match of tail.matchAll(elementPattern)) {
    if (match[0] === "]") {
      closed = true;
      break;
    }
    elements.push(unescapeJsonString(match[1] ?? ""));
  }
  // `["bash","-lc","wc -l x"]` is an interpreter plus the command. While the array is still
  // streaming only the interpreter has arrived, and "bash -lc" names nothing to run.
  const withoutInterpreter = dropInterpreterInvocation(elements);
  const joined = withoutInterpreter
    .map((element) => element.trim())
    .filter(Boolean)
    .join(" ");
  return { value: joined || undefined, closed };
}

const COMMAND_INTERPRETERS = /^(?:\S*\/)?(?:bash|zsh|sh|fish|cmd|powershell)$/;

function dropInterpreterInvocation(elements: readonly string[]): string[] {
  let index = 0;
  if (elements[0] !== undefined && COMMAND_INTERPRETERS.test(elements[0].trim())) {
    index = 1;
    if (elements[1] !== undefined && /^-{1,2}[a-z]*c$/i.test(elements[1].trim())) {
      index = 2;
    }
  }
  return elements.slice(index);
}

/** `["bash","-lc","wc -l x"]` joins to `bash -lc wc -l x`; the Feed wants just the command. */
const SHELL_INVOCATION_PREFIX = /^(?:\S*\/(?:bash|zsh|sh|fish)|bash|zsh|sh|fish)\s+-l?c\s+/;

function stripShellInvocation(command: string): string {
  return command.replace(SHELL_INVOCATION_PREFIX, "").trim();
}

function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/** One line, no runs of blank space: this goes into a single-line Feed label. */
function truncateTarget(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  return collapsed.length > MAX_TARGET_LENGTH ? `${collapsed.slice(0, MAX_TARGET_LENGTH - 1)}…` : collapsed;
}
