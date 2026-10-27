import os from "node:os";

export const READ_FILESYSTEM_TOOL_NAMES = ["Read", "Glob", "Grep", "LS", "NotebookRead"] as const;

export const WRITE_FILESYSTEM_TOOL_NAMES = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const;

export const WRITE_FILESYSTEM_TOOLS = new Set<string>(WRITE_FILESYSTEM_TOOL_NAMES);

export function isReadFilesystemTool(toolName: string): boolean {
  return (READ_FILESYSTEM_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function isWriteFilesystemTool(toolName: string): boolean {
  return WRITE_FILESYSTEM_TOOLS.has(toolName);
}

export function isDiscoveryFilesystemTool(toolName: string): boolean {
  return toolName === "Glob" || toolName === "Grep";
}

export function pathContainsGlobMeta(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

export function readFilesystemPath(input: unknown, toolName?: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "notebook_path", "notebookPath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  if (toolName === "Glob") {
    const pattern = record.pattern;
    if (typeof pattern === "string" && pattern.trim()) {
      return pattern.trim();
    }
  }
  return undefined;
}

/** When cwd is a parent of workspace (e.g. Explore subagent), scope reads to cwd. */
export function resolveFilesystemScopeRoot(workspacePath: string, cwd: string): string {
  const normalizedWorkspace = normalizePolicyPath(workspacePath);
  const normalizedCwd = resolvePolicyPath(".", cwd);
  if (isPathInsidePolicyScope(normalizedCwd, normalizedWorkspace)) {
    return normalizedWorkspace;
  }
  if (isPathInsidePolicyScope(normalizedWorkspace, normalizedCwd)) {
    return normalizedCwd;
  }
  return normalizedWorkspace;
}

export function resolvePolicyPath(filePath: string, cwd: string): string {
  const expanded = expandHomeInPolicyPath(filePath);
  const normalizedPath = normalizePolicyPathSeparators(expanded);
  if (isAbsolutePolicyPath(normalizedPath)) {
    return normalizePolicyPath(normalizedPath);
  }
  return normalizePolicyPath(`${cwd}/${normalizedPath}`);
}

export function resolvePolicySearchBase(filePathPattern: string, cwd: string): string {
  const expanded = expandHomeInPolicyPath(filePathPattern);
  const normalizedPath = normalizePolicyPathSeparators(expanded);
  const firstGlobIndex = normalizedPath.search(/[*?[\]{}]/);
  if (firstGlobIndex < 0) {
    return resolvePolicyPath(normalizedPath, cwd);
  }

  const staticPrefix = normalizedPath.slice(0, firstGlobIndex);
  const slashIndex = staticPrefix.lastIndexOf("/");
  if (slashIndex < 0) {
    return resolvePolicyPath(".", cwd);
  }

  const base = staticPrefix.slice(0, slashIndex) || "/";
  return resolvePolicyPath(base, cwd);
}

/** Expand `~` / `$HOME` prefixes so skill paths like `~/.claude/skills/foo` match allow roots. */
export function expandHomeInPolicyPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return trimmed;
  }
  const homedir = normalizePolicyPathSeparators(os.homedir());
  if (trimmed === "~" || trimmed === "$HOME") {
    return homedir;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return `${homedir}/${trimmed.slice(2)}`;
  }
  const homePrefix = "$HOME/";
  if (trimmed.startsWith(homePrefix)) {
    return `${homedir}/${trimmed.slice(homePrefix.length)}`;
  }
  return trimmed;
}

export function isPathInsidePolicyScope(candidatePath: string, parentPath: string): boolean {
  const candidate = normalizePolicyPath(candidatePath);
  const parent = normalizePolicyPath(parentPath);
  if (candidate === parent) {
    return true;
  }
  const parentPrefix = parent.endsWith("/") ? parent : `${parent}/`;
  return candidate.startsWith(parentPrefix);
}

export function isPathInsideAnyPolicyScope(candidatePath: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathInsidePolicyScope(candidatePath, root));
}

/** System temp is shared scratch space and does not require an external-path approval. */
export function isSystemTemporaryPolicyPath(candidatePath: string): boolean {
  const roots = [os.tmpdir()];
  if (process.platform !== "win32") {
    roots.push("/tmp");
  }
  if (process.platform === "darwin") {
    roots.push("/private/tmp");
  }
  return isPathInsideAnyPolicyScope(candidatePath, roots);
}

export function filesystemReadScopeAskReason(toolName: string, filePath: string, scopeRoot: string): string {
  return `Filesystem read path "${filePath}" is outside Mori workspace "${scopeRoot}". Approve to allow this ${toolName} call.`;
}

function normalizePolicyPath(value: string): string {
  const normalized = normalizePolicyPathSeparators(value.trim());
  const driveMatch = /^([A-Za-z]:)(?:\/(.*))?$/.exec(normalized);
  const prefix = driveMatch ? driveMatch[1] : normalized.startsWith("/") ? "/" : "";
  const body = driveMatch ? (driveMatch[2] ?? "") : normalized.replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (prefix === "/") {
    return `/${parts.join("/")}`.replace(/\/+$/u, "") || "/";
  }
  if (driveMatch) {
    return parts.length > 0 ? `${prefix}/${parts.join("/")}` : `${prefix}/`;
  }
  return parts.join("/");
}

function normalizePolicyPathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function isAbsolutePolicyPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:/.test(value);
}

export function isReviewableExternalReadPath(absolutePath: string): boolean {
  return (
    absolutePath.includes("/.claude/skills/") ||
    absolutePath.includes("/.codex/skills/") ||
    absolutePath.includes("/.agents/skills/") ||
    absolutePath.includes("/.cc-switch/skills/")
  );
}
