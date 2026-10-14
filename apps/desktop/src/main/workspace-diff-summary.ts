import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceDiffResult } from "../shared/ipc";
import type { GitRunner } from "./git-operations";

type DiffFile = WorkspaceDiffResult["files"][number];
function tokenAt(parts: string[], index: number): string {
  const token = parts[index];
  if (token === undefined) throw new Error("Incomplete Git metadata entry");
  return token;
}
export interface UntrackedFileStats {
  additions: number;
  binary: boolean;
}
export interface WorkspaceDiffContext {
  root: string;
  hasHead: boolean;
  prefix: string;
}

/** Git's -z formats preserve spaces, tabs, newlines and non-ASCII filenames. */
export function parseRawNumstat(raw: string): DiffFile[] {
  const parts = raw.split("\0");
  const files = new Map<string, DiffFile>();
  for (let i = 0; i < parts.length; i++) {
    const part = tokenAt(parts, i);
    if (part.startsWith(":")) {
      const kind = part.slice(part.lastIndexOf(" ") + 1);
      let filePath = tokenAt(parts, ++i);
      let previousPath: string | undefined;
      if (kind.startsWith("R") || kind.startsWith("C")) {
        previousPath = filePath;
        filePath = tokenAt(parts, ++i);
      }
      if (!filePath) throw new Error("Invalid Git raw diff path");
      files.set(filePath, {
        path: filePath,
        additions: 0,
        deletions: 0,
        status: kind === "A" ? "added" : kind === "D" ? "deleted" : "modified",
        originalContent: "",
        currentContent: "",
        ...(previousPath !== undefined ? { previousPath } : {}),
      });
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(part);
    if (!match) continue;
    let filePath = tokenAt(match, 3);
    if (!filePath) {
      i += 1; // old path for a rename/copy
      filePath = tokenAt(parts, ++i);
    }
    const file = files.get(filePath);
    if (!file) throw new Error("Git numstat has no matching raw entry");
    file.additions = match[1] === "-" ? 0 : Number(match[1]);
    file.deletions = match[2] === "-" ? 0 : Number(match[2]);
    file.binary = match[1] === "-";
  }
  return [...files.values()];
}

export function parsePorcelainPaths(
  raw: string,
): Array<{ path: string; untracked: boolean; deleted: boolean }> {
  const parts = raw.split("\0");
  const result: Array<{ path: string; untracked: boolean; deleted: boolean }> = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = tokenAt(parts, i);
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Invalid Git status entry");
    result.push({
      path: entry.slice(3),
      untracked: entry.startsWith("?? "),
      deleted: entry[0] === "D" || entry[1] === "D",
    });
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") i++;
  }
  return result;
}

/** Read additions without spawning Git, hashing assets or invoking clean/LFS filters. */
export async function readUntrackedFileStats(
  filePath: string,
  forceText = false,
  signal?: AbortSignal,
): Promise<UntrackedFileStats> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    const target = await readlink(filePath);
    return { additions: target.split("\n").length - (target.endsWith("\n") ? 1 : 0), binary: false };
  }
  if (!info.isFile()) return { additions: 0, binary: false };
  let additions = 0;
  let bytes = 0;
  let lastByte = -1;
  for await (const chunk of createReadStream(filePath, {
    highWaterMark: 64 * 1024,
    ...(signal ? { signal } : {}),
  })) {
    const buffer = chunk as Buffer;
    if (!forceText && bytes < 8_000 && buffer.subarray(0, 8_000 - bytes).includes(0)) {
      return { additions: 0, binary: true };
    }
    for (let i = 0; i < buffer.length; i++) if (buffer[i] === 10) additions++;
    bytes += buffer.length;
    lastByte = buffer[buffer.length - 1] ?? lastByte;
  }
  return { additions: additions + (bytes > 0 && lastByte !== 10 ? 1 : 0), binary: false };
}

export async function mapWithConcurrency<T, R>(
  entries: T[],
  limit: number,
  work: (entry: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(entries.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, entries.length) }, async () => {
      while (cursor < entries.length) {
        const index = cursor++;
        result[index] = await work(entries[index] as T);
      }
    }),
  );
  return result;
}

export async function getWorkspaceDiffSummary(
  workspacePath: string,
  run: GitRunner,
  options: {
    context?: WorkspaceDiffContext;
    readUntracked?: (filePath: string, forceText: boolean) => Promise<UntrackedFileStats>;
  } = {},
): Promise<WorkspaceDiffResult> {
  const cwd = path.resolve(workspacePath);
  const empty: WorkspaceDiffResult = {
    workspacePath: cwd,
    patch: "",
    patchTruncated: false,
    fileCount: 0,
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  };
  let context = options.context;
  if (!context) {
    const root = await run(["git", "rev-parse", "--show-toplevel", "--show-prefix"], cwd);
    if (root.exitCode !== 0) {
      if (/not a git repository/i.test(root.stderr)) return empty;
      throw new Error(root.stderr || "Could not locate Git repository");
    }
    const head = await run(["git", "rev-parse", "--verify", "--quiet", "HEAD"], cwd);
    const [rootPath, prefix = ""] = root.stdout.trimEnd().split("\n");
    if (!rootPath) throw new Error("Git returned no repository root");
    context = { root: rootPath, prefix, hasHead: head.exitCode === 0 };
  }
  const [status, metadata] = await Promise.all([
    run(
      ["git", "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
      cwd,
    ),
    run(
      [
        "git",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--relative",
        "--raw",
        "--no-abbrev",
        "--numstat",
        "-z",
        ...(context.hasHead ? ["HEAD"] : ["--cached"]),
        "--",
        ".",
      ],
      cwd,
    ),
  ]);
  if (status.exitCode !== 0) throw new Error(status.stderr || "Could not read Git status");
  if (metadata.exitCode !== 0) throw new Error(metadata.stderr || "Could not read Git diff metadata");
  const files = parseRawNumstat(metadata.stdout);
  const paths = parsePorcelainPaths(status.stdout);
  const relativePaths = paths
    .map((entry) => ({
      ...entry,
      path: path.posix.relative(context.prefix || ".", entry.path),
    }))
    .filter((entry) => entry.path !== ".." && !entry.path.startsWith("../"));
  const byPath = new Map(files.map((file) => [file.path, file]));
  // Unborn repositories compare current files with the empty tree, including unstaged edits.
  const newPaths = relativePaths.filter((entry) => entry.untracked || !context.hasHead);
  const attributes = new Map<string, string>();
  if (newPaths.length > 0) {
    const result = await run(["git", "check-attr", "-z", "--stdin", "diff"], cwd, {
      stdin: `${newPaths.map((entry) => entry.path).join("\0")}\0`,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Could not read Git diff attributes");
    const values = result.stdout.split("\0");
    for (let index = 0; index + 2 < values.length; index += 3)
      attributes.set(tokenAt(values, index), tokenAt(values, index + 2));
  }
  const readStats = options.readUntracked ?? readUntrackedFileStats;
  const newFiles = await mapWithConcurrency(newPaths, 4, async (entry): Promise<DiffFile> => {
    const attribute = attributes.get(entry.path);
    const stats = entry.deleted
      ? { additions: 0, binary: false }
      : attribute === "unset"
        ? { additions: 0, binary: true }
        : await readStats(path.join(cwd, entry.path), attribute === "set");
    return {
      path: entry.path,
      ...stats,
      deletions: 0,
      status: entry.untracked ? "untracked" : "added",
      originalContent: "",
      currentContent: "",
    };
  });
  for (const file of newFiles) byPath.set(file.path, file);
  // Unmerged/intent-to-add entries can have no HEAD patch but must remain visible.
  for (const entry of relativePaths)
    if (!byPath.has(entry.path)) {
      byPath.set(entry.path, {
        path: entry.path,
        additions: 0,
        deletions: 0,
        status: "modified",
        originalContent: "",
        currentContent: "",
      });
    }
  const complete = [...byPath.values()];
  return {
    ...empty,
    files: complete,
    fileCount: complete.length,
    totalAdditions: complete.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: complete.reduce((sum, file) => sum + file.deletions, 0),
  };
}
