import fs from "node:fs/promises";
import path from "node:path";
import type {
  PackageManagerKind,
  PackageScriptInfo,
  PackageScriptOverrides,
  PackageScriptsListResult,
  RunPackageScriptRequest,
} from "../shared/ipc";
import { buildRunCommand, joinPrefixedCommand, normalizeCommandPrefix } from "../shared/package-script-run";
import type { BackgroundTerminalTaskRegistry } from "./background-terminal-tasks";
import { buildBackgroundScriptCommandInvocation, type InteractiveTerminalManager } from "./interactive-terminal-manager";
import { buildShellCommandLine, resolveCommandExecutable } from "./resolve-command-executable";
import { detectPackageManager } from "./workspace-inspect";

export { buildRunCommand, joinPrefixedCommand } from "../shared/package-script-run";

const PACKAGE_MANAGER_FIELD_RE = /^(npm|pnpm|yarn|bun)(?:(?:@|:)[\w.+-]*)?$/;

export function parsePackageManagerField(value: unknown): PackageManagerKind | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const match = PACKAGE_MANAGER_FIELD_RE.exec(normalized);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1] as PackageManagerKind;
}

export async function resolvePackageManager(
  workspacePath: string,
  packageJson?: Record<string, unknown>,
): Promise<PackageManagerKind> {
  const fromLockfile = await detectPackageManager(workspacePath);
  if (fromLockfile) {
    return fromLockfile;
  }
  const fromField = parsePackageManagerField(packageJson?.packageManager);
  if (fromField) {
    return fromField;
  }
  return "npm";
}

function parseScriptsField(scripts: unknown): PackageScriptInfo[] {
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return [];
  }
  const entries: PackageScriptInfo[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command === "string" && command.trim()) {
      entries.push({ name, command });
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readPackageJson(workspacePath: string): Promise<Record<string, unknown> | undefined> {
  const packageJsonPath = path.join(path.resolve(workspacePath), "package.json");
  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function listPackageScripts(workspacePath: string): Promise<PackageScriptsListResult> {
  const resolvedPath = path.resolve(workspacePath);
  const packageJson = await readPackageJson(resolvedPath);
  const packageManager = await resolvePackageManager(resolvedPath, packageJson);
  const scripts = parseScriptsField(packageJson?.scripts);
  const packageName = typeof packageJson?.name === "string" ? packageJson.name : undefined;

  return {
    workspacePath: resolvedPath,
    hasPackageJson: Boolean(packageJson),
    ...(packageName && { packageName }),
    packageManager,
    scripts,
    scriptArgs: {},
    scriptPrefixes: {},
  };
}

/**
 * Prefix + package-manager argv as one shell line. The prefix runs in the same
 * shell, so `nvm use 20` / `export NODE_ENV=production` affect the script.
 */
export function buildPrefixedShellLine(prefix: string, command: readonly string[]): string {
  return `${normalizeCommandPrefix(prefix)} && ${buildShellCommandLine([...command])}`;
}

export interface PreparedPackageScriptRun {
  workspacePath: string;
  script: string;
  /** argv to spawn; wrapped in a login shell when a prefix is set. */
  command: string[];
  /** Human-readable run line (prefix && pm run script -- args). */
  commandLabel: string;
  prefix?: string;
}

export async function preparePackageScriptRun(
  request: RunPackageScriptRequest,
  saved?: PackageScriptOverrides,
): Promise<PreparedPackageScriptRun> {
  const resolvedPath = path.resolve(request.workspacePath);
  const listing = await listPackageScripts(resolvedPath);
  const scriptName = request.script.trim();
  const knownScript = listing.scripts.find((entry) => entry.name === scriptName);
  if (!knownScript) {
    throw new Error(`Unknown script: ${scriptName}`);
  }

  const args = request.args?.trim() || saved?.args?.[scriptName] || undefined;
  const prefix = request.prefix?.trim() || saved?.prefixes?.[scriptName] || undefined;
  const argv = buildRunCommand(listing.packageManager, scriptName, args);
  const command = prefix ? buildBackgroundScriptCommandInvocation(buildPrefixedShellLine(prefix, argv)) : argv;

  return {
    workspacePath: resolvedPath,
    script: scriptName,
    command,
    commandLabel: joinPrefixedCommand(prefix, argv),
    ...(prefix && { prefix }),
  };
}

export function runPreparedPackageScriptInTerminal(
  manager: InteractiveTerminalManager,
  prepared: PreparedPackageScriptRun,
): { sessionId: string; script: string; command: string[]; commandLabel: string } {
  const executableName = prepared.command[0];
  if (!executableName) {
    throw new Error("Missing executable.");
  }
  const resolvedCommand =
    process.platform === "win32"
      ? prepared.command
      : [resolveCommandExecutable(executableName), ...prepared.command.slice(1)];
  const { sessionId } = manager.spawn(prepared.workspacePath);
  manager.write(sessionId, `${buildShellCommandLine(resolvedCommand)}\r`);
  return {
    sessionId,
    script: prepared.script,
    command: resolvedCommand,
    commandLabel: prepared.commandLabel,
  };
}

export function runPreparedPackageScriptAsBackgroundTask(
  registry: BackgroundTerminalTaskRegistry,
  prepared: PreparedPackageScriptRun,
  options: { threadId?: string } = {},
): { taskId: string; sessionId: string; script: string; command: string[]; commandLabel: string } {
  const executableName = prepared.command[0];
  if (!executableName) {
    throw new Error("Missing executable.");
  }
  const resolvedCommand =
    process.platform === "win32"
      ? prepared.command
      : [resolveCommandExecutable(executableName), ...prepared.command.slice(1)];
  const task = registry.start({
    workspacePath: prepared.workspacePath,
    command: resolvedCommand,
    label: prepared.commandLabel,
    ...(options.threadId?.trim() && { threadId: options.threadId.trim() }),
  });
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    script: prepared.script,
    command: resolvedCommand,
    commandLabel: prepared.commandLabel,
  };
}
