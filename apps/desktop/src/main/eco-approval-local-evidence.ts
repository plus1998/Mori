import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type ApprovalActionTarget,
  type ApprovalActionTargets,
  extractApprovalActionTargets,
} from "./approval-action-targets";

const runFile = promisify(execFile);
const GENERATED_DIRECTORIES = new Set([
  "dist",
  "build",
  "coverage",
  "node_modules",
  ".next",
  ".cache",
  ".turbo",
  ".venv",
]);

export interface ApprovalGitEvidence {
  root: string;
  head?: string;
  branch?: string;
  trackedFiles: number;
  changedEntries: number;
  untrackedEntries: number;
  ignoredEntries: number;
  indexFlagsHideChanges: boolean;
  recovery: "clean_in_head" | "dirty_or_untracked" | "not_tracked" | "unknown";
}

export interface ApprovalPathEvidence {
  path: string;
  canonicalPath?: string;
  operation: ApprovalActionTarget["operation"];
  scope: "workspace" | "temporary" | "project_memory" | "external" | "unknown";
  exists?: boolean;
  kind?: "file" | "directory" | "symlink" | "other";
  currentUserOwned?: boolean;
  identity?: { device: number; inode: number; size: number; mtimeMs: number; ctimeMs: number; mode: number };
  characterDeviceId?: number;
  protectedRoot?: boolean;
  generatedDirectoryCandidate?: boolean;
  directory?: { inspectedEntries: number; complete: boolean; containsGitMetadata: boolean };
  git?: ApprovalGitEvidence;
  limitations: string[];
}

export interface ApprovalHostEvidence {
  version: 1;
  collectedAt: string;
  targetExtractionComplete: boolean;
  paths: ApprovalPathEvidence[];
  limitations: string[];
  repositories?: Array<{ root: string; head?: string; branch?: string }>;
  worktreePath?: string;
  sdkHints?: {
    defaultToNo?: boolean;
    suppressAlwaysAllowRule?: boolean;
    decisionReason?: string;
    mcpServer?: { name: string; source: string };
  };
  shell?: ApprovalActionTargets["shell"];
}

/** Facts read by the host; no shell execution, file contents, inferred ownership, or backups. */
export async function collectApprovalHostEvidence(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  workspacePath: string;
  worktreePath?: string;
  sdkHints?: ApprovalHostEvidence["sdkHints"];
  signal?: AbortSignal;
}): Promise<ApprovalHostEvidence> {
  const extracted = extractApprovalActionTargets(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    const roots = await Promise.all(
      [input.workspacePath, input.worktreePath]
        .filter((root): root is string => Boolean(root))
        .map(canonicalPath),
    );
    const tempRoots = await Promise.all(
      [os.tmpdir(), "/tmp", ...(process.platform === "darwin" ? ["/private/tmp"] : [])].map(canonicalPath),
    );
    const memoryRoots = projectMemoryRoots(input.workspacePath, input.worktreePath);
    const canonicalMemoryRoots = await Promise.all(
      memoryRoots.map(async (root) => {
        const canonical = await canonicalPath(root);
        const parent = await canonicalPath(path.dirname(root));
        // A conventional memory directory replaced with a symlink is not a registered scope.
        return parent && canonical === path.join(parent, path.basename(root)) ? canonical : undefined;
      }),
    );
    const home = await canonicalPath(os.homedir());
    const gitCache = new Map<string, Promise<{ root: string; head?: string; branch?: string } | undefined>>();
    const repositoryResults =
      input.toolName === "Bash"
        ? await Promise.allSettled(
            [
              ...new Set(
                [input.cwd, input.workspacePath, input.worktreePath].filter((root): root is string =>
                  Boolean(root),
                ),
              ),
            ].map(async (root) => {
              const directory = await existingDirectory(root);
              const pending = readRepository(directory, signal);
              gitCache.set(directory, pending);
              return pending;
            }),
          )
        : [];
    const repositories = repositoryResults
      .flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []))
      .filter((repo, index, all) => all.findIndex((other) => other.root === repo.root) === index);
    for (const result of repositoryResults) {
      if (result.status === "rejected")
        extracted.limitations.push(`repository_evidence_failed:${errorCode(result.reason)}`);
    }
    const paths = await Promise.all(
      extracted.targets.map(async (target): Promise<ApprovalPathEvidence> => {
        const fact: ApprovalPathEvidence = { ...target, scope: "unknown", limitations: [] };
        const canonical = await canonicalPath(target.path);
        if (!canonical) {
          fact.limitations.push("canonical_path_unavailable");
          return fact;
        }
        fact.canonicalPath = canonical;
        const memoryIndex = memoryRoots.findIndex((root) => inside(target.path, root));
        const validMemory = memoryIndex >= 0 && inside(canonical, canonicalMemoryRoots[memoryIndex]);
        fact.scope = validMemory
          ? "project_memory"
          : roots.some((root) => inside(canonical, root))
            ? "workspace"
            : tempRoots.some((root) => inside(canonical, root))
              ? "temporary"
              : "external";
        fact.protectedRoot =
          canonical === path.parse(canonical).root ||
          canonical === home ||
          [...roots, ...tempRoots].some((root) => root === canonical) ||
          canonical.split(path.sep).includes(".git");
        fact.generatedDirectoryCandidate = roots.some((root) => {
          if (!root || !inside(canonical, root)) return false;
          return GENERATED_DIRECTORIES.has(path.relative(root, canonical).split(path.sep)[0] ?? "");
        });
        try {
          const stat = await lstat(target.path);
          fact.exists = true;
          fact.kind = stat.isSymbolicLink()
            ? "symlink"
            : stat.isDirectory()
              ? "directory"
              : stat.isFile()
                ? "file"
                : "other";
          if (process.getuid) fact.currentUserOwned = stat.uid === process.getuid();
          fact.identity = {
            device: stat.dev,
            inode: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            mode: stat.mode,
          };
          if (stat.isCharacterDevice()) fact.characterDeviceId = stat.rdev;
          if (stat.isDirectory() && ["delete", "move", "rollback"].includes(target.operation)) {
            fact.directory = await inspectDirectory(target.path, signal);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") fact.exists = false;
          else fact.limitations.push(`stat_failed:${errorCode(error)}`);
        }
        if (["workspace", "project_memory"].includes(fact.scope) && target.operation !== "read") {
          try {
            const directory = await existingDirectory(
              fact.kind === "directory" ? target.path : path.dirname(target.path),
            );
            let repository = gitCache.get(directory);
            if (!repository) {
              repository = readRepository(directory, signal);
              gitCache.set(directory, repository);
            }
            const repo = await repository;
            const canonicalParent = await canonicalPath(path.dirname(target.path));
            const gitTarget = canonicalParent
              ? path.join(canonicalParent, path.basename(target.path))
              : undefined;
            if (repo && gitTarget && inside(gitTarget, repo.root))
              fact.git = await readGitPath(repo, gitTarget, signal);
            else fact.limitations.push("git_repository_unavailable");
          } catch (error) {
            fact.limitations.push(`git_evidence_failed:${errorCode(error)}`);
          }
        }
        return fact;
      }),
    );
    return {
      version: 1,
      collectedAt: new Date().toISOString(),
      targetExtractionComplete: extracted.complete,
      paths,
      limitations: [...new Set(extracted.limitations)],
      ...(extracted.shell ? { shell: extracted.shell } : {}),
      ...(repositories.length ? { repositories } : {}),
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
      ...(input.sdkHints ? { sdkHints: input.sdkHints } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Compare facts, excluding timestamps and dialog text. A review cannot reuse stale recovery proof. */
export function approvalHostEvidenceState(evidence: ApprovalHostEvidence): string {
  return JSON.stringify({
    paths: evidence.paths.map((fact) => {
      // macOS updates /dev/null timestamps on writes by unrelated processes. Its device
      // identity, canonical path, ownership and mode still require exact revalidation.
      if (
        fact.path !== "/dev/null" ||
        fact.canonicalPath !== "/dev/null" ||
        fact.kind !== "other" ||
        fact.characterDeviceId === undefined ||
        !fact.identity
      )
        return fact;
      return {
        ...fact,
        identity: {
          device: fact.identity.device,
          inode: fact.identity.inode,
          size: fact.identity.size,
          mode: fact.identity.mode,
        },
      };
    }),
    repositories: evidence.repositories,
    targetExtractionComplete: evidence.targetExtractionComplete,
    limitations: evidence.limitations,
    shell: evidence.shell,
  });
}

function projectMemoryRoots(workspace: string, worktree?: string): string[] {
  return [
    ...new Set(
      [workspace, worktree]
        .filter((root): root is string => Boolean(root))
        .flatMap((root) => [
          path.join(root, "MEMORY.md"),
          path.join(root, "memory"),
          path.join(root, ".agents", "memory"),
          path.join(
            os.homedir(),
            ".claude",
            "projects",
            path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-"),
            "memory",
          ),
        ]),
    ),
  ];
}

function inside(candidate: string, root: string | undefined): boolean {
  if (!root) return false;
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function canonicalPath(value: string): Promise<string | undefined> {
  let current = path.resolve(value);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.resolve(await realpath(current), ...suffix);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function existingDirectory(value: string): Promise<string> {
  let current = value;
  while (true) {
    try {
      if ((await lstat(current)).isDirectory()) return current;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("No existing parent directory");
    current = parent;
  }
}

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  const result = await runFile(
    "git",
    ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
    {
      cwd,
      signal,
      timeout: 2_000,
      maxBuffer: 256_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return result.stdout;
}

async function readRepository(directory: string, signal: AbortSignal) {
  try {
    const root = (await git(directory, ["rev-parse", "--show-toplevel"], signal)).trim();
    const [head, branch] = await Promise.allSettled([
      git(root, ["rev-parse", "--verify", "HEAD"], signal),
      git(root, ["symbolic-ref", "--short", "HEAD"], signal),
    ]);
    return {
      root,
      ...(head.status === "fulfilled" ? { head: head.value.trim() } : {}),
      ...(branch.status === "fulfilled" ? { branch: branch.value.trim() } : {}),
    };
  } catch (error) {
    // A normal non-repository is a fact, not evidence of recoverability.
    const failure = error as { code?: unknown; stderr?: string };
    if (failure.code === 128 && /not a git repository/i.test(failure.stderr ?? "")) return undefined;
    throw error;
  }
}

async function readGitPath(
  repo: { root: string; head?: string; branch?: string },
  target: string,
  signal: AbortSignal,
): Promise<ApprovalGitEvidence> {
  const relative = path.relative(repo.root, target).split(path.sep).join("/") || ".";
  const [tracked, status] = await Promise.all([
    git(repo.root, ["ls-files", "-v", "-z", "--", relative], signal),
    git(
      repo.root,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--", relative],
      signal,
    ),
  ]);
  let changedEntries = 0,
    untrackedEntries = 0,
    ignoredEntries = 0;
  const entries = status.split("\0").filter(Boolean);
  let skipRenameSource = false;
  for (const entry of entries) {
    if (skipRenameSource) {
      skipRenameSource = false;
      continue;
    }
    const code = entry.slice(0, 2);
    if (code === "??") untrackedEntries += 1;
    else if (code === "!!") ignoredEntries += 1;
    else changedEntries += 1;
    if (/[RC]/.test(code)) skipRenameSource = true;
  }
  const trackedEntries = tracked.split("\0").filter(Boolean);
  const trackedFiles = trackedEntries.length;
  const indexFlagsHideChanges = trackedEntries.some((entry) => /^[a-zS]/.test(entry));
  return {
    ...repo,
    trackedFiles,
    changedEntries,
    untrackedEntries,
    ignoredEntries,
    indexFlagsHideChanges,
    recovery: !repo.head
      ? "unknown"
      : changedEntries || untrackedEntries || ignoredEntries
        ? "dirty_or_untracked"
        : indexFlagsHideChanges
          ? "unknown"
          : trackedFiles
            ? "clean_in_head"
            : "not_tracked",
  };
}

async function inspectDirectory(
  root: string,
  signal: AbortSignal,
): Promise<NonNullable<ApprovalPathEvidence["directory"]>> {
  const pending = [root];
  let inspectedEntries = 0,
    containsGitMetadata = false,
    complete = true;
  while (pending.length) {
    if (signal.aborted || inspectedEntries >= 256) {
      complete = false;
      break;
    }
    const directory = pending.pop();
    if (directory === undefined) break;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    for (const entry of entries) {
      inspectedEntries += 1;
      if (entry.name === ".git") containsGitMetadata = true;
      if (inspectedEntries >= 256) {
        complete = false;
        break;
      }
      if (entry.isDirectory() && entry.name !== ".git") pending.push(path.join(directory, entry.name));
    }
  }
  return { inspectedEntries, complete, containsGitMetadata };
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : "unknown";
}
