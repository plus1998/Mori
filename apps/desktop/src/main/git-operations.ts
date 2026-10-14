import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseUnifiedDiffStats } from "../shared/worktree-merge";
import { getWorkspaceDiffSummary, type WorkspaceDiffContext } from "./workspace-diff-summary";
import { resolveGitExecutable } from "./workspace-inspect";

const execFileAsync = promisify(execFile);

export const COMMIT_DIFF_MAX_CHARS = 100_000;

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (
  args: string[],
  cwd: string,
  options?: { stdin?: string; signal?: AbortSignal },
) => Promise<GitCommandResult>;

export interface GhAvailability {
  available: boolean;
  authenticated: boolean;
  reason?: string;
}

export interface GitWorkingTreeStatus {
  workspacePath: string;
  isGitRepository: boolean;
  hasGitCommits: boolean;
  branch?: string;
  branches: string[];
  dirtyFileCount: number;
  insertions: number;
  deletions: number;
  canCommit: boolean;
  aheadCount: number;
  behindCount: number;
  hasUpstream: boolean;
  remoteOriginUrl?: string;
  gh: GhAvailability;
}

export const DEFAULT_GIT_AUTOFETCH_PERIOD_SECONDS = 180;

const lastFetchAtByWorkspace = new Map<string, number>();

export function markWorkspaceFetched(workspacePath: string, at = Date.now()): void {
  lastFetchAtByWorkspace.set(path.resolve(workspacePath), at);
}

export function isWorkspaceFetchStale(
  workspacePath: string,
  maxAgeMs = DEFAULT_GIT_AUTOFETCH_PERIOD_SECONDS * 1000,
): boolean {
  const last = lastFetchAtByWorkspace.get(path.resolve(workspacePath));
  return last === undefined || Date.now() - last >= maxAgeMs;
}

export async function fetchFromOrigin(
  workspacePath: string,
  run: GitRunner = defaultGitRunner,
  options: { remote?: string; prune?: boolean } = {},
): Promise<{ ok: boolean; output: string }> {
  const cwd = path.resolve(workspacePath);
  const remote = options.remote?.trim() || "origin";
  const remoteUrl = await run(["git", "remote", "get-url", remote], cwd);
  if (remoteUrl.exitCode !== 0 || !remoteUrl.stdout.trim()) {
    return { ok: false, output: "" };
  }

  const args = ["git", "fetch", remote];
  if (options.prune) {
    args.push("--prune");
  }
  const result = await run(args, cwd);
  if (result.exitCode === 0) {
    markWorkspaceFetched(cwd);
  }
  return {
    ok: result.exitCode === 0,
    output: (result.stdout.trim() || result.stderr.trim()).trim(),
  };
}

async function resolveSyncRevRange(
  cwd: string,
  branch: string | undefined,
  run: GitRunner,
): Promise<{ revRange?: string; hasUpstream: boolean }> {
  const upstream = await run(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  if (upstream.exitCode === 0 && upstream.stdout.trim()) {
    return { revRange: "@{upstream}...HEAD", hasUpstream: true };
  }

  if (branch && branch !== "detached") {
    const originBranch = await run(["git", "rev-parse", "--verify", `refs/remotes/origin/${branch}`], cwd);
    if (originBranch.exitCode === 0) {
      return { revRange: `origin/${branch}...HEAD`, hasUpstream: true };
    }
  }

  const originUrl = await run(["git", "remote", "get-url", "origin"], cwd);
  return { hasUpstream: originUrl.exitCode === 0 && Boolean(originUrl.stdout.trim()) };
}

export const GIT_COMMITS_PAGE_SIZE = 5;

export interface GitCommitRecord {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  relativeDate: string;
  decorations: string[];
  tags: string[];
}

export interface WorkspaceDiffResult {
  workspacePath: string;
  revision?: number;
  watchError?: string;
  patch: string;
  patchTruncated: boolean;
  fileCount: number;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: "modified" | "untracked" | "added" | "deleted";
    revision?: number;
    previousPath?: string;
    binary?: boolean;
    originalContent: string;
    currentContent: string;
  }>;
  totalAdditions: number;
  totalDeletions: number;
}

export type WorkspaceDiffFileStatus = "modified" | "untracked" | "added" | "deleted";

/** 图片类二进制文件的预览数据（惰性加载，随单文件 diff 返回）。 */
export interface WorkspaceFileDiffImagePreview {
  mimeType: string;
  base64: string;
  /** workingTree：当前工作区版本；head：文件已删除，回退为 HEAD 版本。 */
  source: "workingTree" | "head";
}

/** Single-file unified patch for lazy review/diff views. */
export interface WorkspaceFileDiffResult {
  path: string;
  patch: string;
  patchTruncated: boolean;
  additions: number;
  deletions: number;
  status: WorkspaceDiffFileStatus;
  /** git 判定为二进制内容，patch 中不含文本行，review 视图需特殊渲染。 */
  binary: boolean;
  /** 仅当 binary 为 true 且文件为受支持的图片类型时返回。 */
  imagePreview?: WorkspaceFileDiffImagePreview;
}

export interface CommitDiffContext {
  stagedNameStatus: string;
  stagedStat: string;
  stagedPatch: string;
  stagedPatchTruncated: boolean;
  unstagedNameStatus?: string;
  unstagedPatch?: string;
  unstagedPatchTruncated?: boolean;
  recentCommits: string;
}

function stripGitPrefix(args: string[]): string[] {
  return args[0] === "git" ? args.slice(1) : args;
}

export function createGitRunner(runCommand: GitRunner): GitRunner {
  return async (args, cwd, options) => runCommand(stripGitPrefix(args), cwd, options);
}

export async function defaultGitRunner(
  args: string[],
  cwd: string,
  options?: { stdin?: string; signal?: AbortSignal },
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      resolveGitExecutable(),
      stripGitPrefix(args),
      {
        cwd,
        maxBuffer: 12 * 1024 * 1024,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        const failed = error as (NodeJS.ErrnoException & { code?: number }) | null;
        resolve({
          exitCode: failed ? (typeof failed.code === "number" ? failed.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr || failed?.message || ""),
        });
      },
    );
    child.stdin?.end(options?.stdin);
  });
}

async function runGitOk(run: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await run(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function parseNumstat(stdout: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length < 3) {
      continue;
    }
    const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0] ?? "0", 10);
    const removed = parts[1] === "-" ? 0 : Number.parseInt(parts[1] ?? "0", 10);
    if (!Number.isNaN(added)) {
      insertions += added;
    }
    if (!Number.isNaN(removed)) {
      deletions += removed;
    }
  }
  return { insertions, deletions };
}

function truncatePatch(patch: string, maxChars: number): { text: string; truncated: boolean } {
  if (patch.length <= maxChars) {
    return { text: patch, truncated: false };
  }
  return {
    text: `${patch.slice(0, maxChars)}\n\n…（diff 已截断，共 ${patch.length} 字符）`,
    truncated: true,
  };
}

const WORKSPACE_DIFF_FILE_MAX_CHARS = 2 * 1024 * 1024;

function isWorkspaceRelativePath(cwd: string, filePath: string): boolean {
  const absolutePath = path.resolve(cwd, filePath);
  const relativePath = path.relative(cwd, absolutePath);
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function limitDiffFileContent(content: string): string {
  if (content.length <= WORKSPACE_DIFF_FILE_MAX_CHARS) return content;
  return `${content.slice(0, WORKSPACE_DIFF_FILE_MAX_CHARS)}\n`;
}

async function readWorkspaceDiffContents(
  cwd: string,
  filePath: string,
  run: GitRunner,
): Promise<{ originalContent: string; currentContent: string }> {
  if (!isWorkspaceRelativePath(cwd, filePath)) {
    return { originalContent: "", currentContent: "" };
  }

  const original = await run(["git", "show", `HEAD:${filePath}`], cwd);
  let currentContent = "";
  try {
    currentContent = await readFile(path.resolve(cwd, filePath), "utf8");
  } catch {
    currentContent = "";
  }

  return {
    originalContent: original.exitCode === 0 ? limitDiffFileContent(original.stdout) : "",
    currentContent: limitDiffFileContent(currentContent),
  };
}

let cachedGhExecutable: string | undefined;

function resolveGhExecutable(): string | undefined {
  if (cachedGhExecutable !== undefined) {
    return cachedGhExecutable || undefined;
  }
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "gh"]) {
    if (candidate === "gh" || existsSync(candidate)) {
      cachedGhExecutable = candidate;
      return candidate;
    }
  }
  cachedGhExecutable = "";
  return undefined;
}

export async function checkGhAvailability(): Promise<GhAvailability> {
  const gh = resolveGhExecutable();
  if (!gh) {
    return { available: false, authenticated: false, reason: "未找到 gh 命令" };
  }
  try {
    const version = await execFileAsync(gh, ["--version"], { maxBuffer: 1024 * 1024 });
    if (!String(version.stdout).trim()) {
      return { available: false, authenticated: false, reason: "gh 不可用" };
    }
  } catch {
    return { available: false, authenticated: false, reason: "gh 不可用" };
  }
  try {
    await execFileAsync(gh, ["auth", "status"], { maxBuffer: 1024 * 1024 });
    return { available: true, authenticated: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: true, authenticated: false, reason: message.trim() || "未登录 GitHub CLI" };
  }
}

export async function getGitWorkingTreeStatus(
  workspacePath: string,
  run: GitRunner = defaultGitRunner,
  options: { fetchIfStale?: boolean; readSummary?: () => Promise<WorkspaceDiffResult> } = {},
): Promise<GitWorkingTreeStatus> {
  const resolvedPath = path.resolve(workspacePath);
  const gh = await checkGhAvailability();
  const revParse = await run(["git", "rev-parse", "--show-toplevel"], resolvedPath);
  if (revParse.exitCode !== 0) {
    return {
      workspacePath: resolvedPath,
      isGitRepository: false,
      hasGitCommits: false,
      branches: [],
      dirtyFileCount: 0,
      insertions: 0,
      deletions: 0,
      canCommit: false,
      aheadCount: 0,
      behindCount: 0,
      hasUpstream: false,
      gh,
    };
  }

  if (options.fetchIfStale !== false && isWorkspaceFetchStale(resolvedPath)) {
    await fetchFromOrigin(resolvedPath, run);
  }

  const hasGitCommits = (await run(["git", "rev-parse", "--verify", "HEAD"], resolvedPath)).exitCode === 0;
  const branchResult = await run(["git", "branch", "--show-current"], resolvedPath);
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() || "detached" : undefined;

  const branchesRaw = await run(["git", "branch", "--format=%(refname:short)"], resolvedPath);
  const branches =
    branchesRaw.exitCode === 0
      ? branchesRaw.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : branch
        ? [branch]
        : [];

  let dirtyFileCount: number;
  let insertions: number;
  let deletions: number;
  if (options.readSummary) {
    const summary = await options.readSummary();
    dirtyFileCount = summary.fileCount;
    insertions = summary.totalAdditions;
    deletions = summary.totalDeletions;
  } else {
    const status = await run(["git", "status", "--short"], resolvedPath);
    dirtyFileCount =
      status.exitCode === 0 ? status.stdout.split("\n").filter((line) => line.trim()).length : 0;
    const numstat = await run(["git", "diff", "--numstat", "HEAD"], resolvedPath);
    ({ insertions, deletions } =
      numstat.exitCode === 0 ? parseNumstat(numstat.stdout) : { insertions: 0, deletions: 0 });
  }

  let aheadCount = 0;
  let behindCount = 0;
  const { revRange, hasUpstream } = await resolveSyncRevRange(resolvedPath, branch, run);
  if (revRange) {
    const counts = await run(["git", "rev-list", "--left-right", "--count", revRange], resolvedPath);
    if (counts.exitCode === 0) {
      const parts = counts.stdout.trim().split(/\s+/);
      behindCount = Number.parseInt(parts[0] ?? "0", 10) || 0;
      aheadCount = Number.parseInt(parts[1] ?? "0", 10) || 0;
    }
  }

  const remote = await run(["git", "remote", "get-url", "origin"], resolvedPath);
  const remoteOriginUrl = remote.exitCode === 0 ? remote.stdout.trim() : undefined;

  return {
    workspacePath: resolvedPath,
    isGitRepository: true,
    hasGitCommits,
    ...(branch && { branch }),
    branches,
    dirtyFileCount,
    insertions,
    deletions,
    canCommit: dirtyFileCount > 0,
    aheadCount,
    behindCount,
    hasUpstream,
    ...(remoteOriginUrl && { remoteOriginUrl }),
    gh,
  };
}

function parseGitLogDecorations(raw: string): { decorations: string[]; tags: string[] } {
  const trimmed = raw
    .trim()
    .replace(/^\(|\)$/g, "")
    .trim();
  if (!trimmed) {
    return { decorations: [], tags: [] };
  }
  const labels = new Set<string>();
  const tags = new Set<string>();
  for (const part of trimmed.split(",")) {
    const item = part.trim();
    if (!item) {
      continue;
    }
    const tagMatch = item.match(/^tag:\s*(.+)$/);
    if (tagMatch?.[1]) {
      tags.add(tagMatch[1].trim());
      continue;
    }
    const headMatch = item.match(/^HEAD\s*->\s*(.+)$/);
    if (headMatch?.[1]) {
      labels.add(headMatch[1].trim());
      continue;
    }
    const originMatch = item.match(/^origin\/(.+)$/);
    if (originMatch?.[1]) {
      labels.add(originMatch[1].trim());
      continue;
    }
    labels.add(item);
  }
  return { decorations: [...labels], tags: [...tags] };
}

function parseGitLogLine(line: string): GitCommitRecord {
  const [sha = "", shortSha = "", subject = "", author = "", relativeDate = "", decorationsRaw = ""] =
    line.split("\x1f");
  const { decorations, tags } = parseGitLogDecorations(decorationsRaw);
  return {
    sha,
    shortSha,
    subject,
    author,
    relativeDate,
    decorations,
    tags,
  };
}

export async function listGitCommits(
  workspacePath: string,
  options: { skip: number; limit: number },
  run: GitRunner = defaultGitRunner,
): Promise<{ commits: GitCommitRecord[]; hasMore: boolean }> {
  const cwd = path.resolve(workspacePath);
  const revParse = await run(["git", "rev-parse", "--show-toplevel"], cwd);
  if (revParse.exitCode !== 0) {
    return { commits: [], hasMore: false };
  }

  const hasGitCommits = (await run(["git", "rev-parse", "--verify", "HEAD"], cwd)).exitCode === 0;
  if (!hasGitCommits) {
    return { commits: [], hasMore: false };
  }

  const skip = Math.max(0, options.skip);
  const limit = Math.max(1, options.limit);
  const fetchCount = limit + 1;
  const result = await run(
    [
      "git",
      "log",
      `--skip=${skip}`,
      "-n",
      String(fetchCount),
      "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%cr%x1f%d",
    ],
    cwd,
  );
  if (result.exitCode !== 0) {
    return { commits: [], hasMore: false };
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  const hasMore = lines.length > limit;
  return {
    commits: lines.slice(0, limit).map(parseGitLogLine),
    hasMore,
  };
}

export async function checkoutGitBranch(
  workspacePath: string,
  branch: string,
  run: GitRunner = defaultGitRunner,
): Promise<void> {
  const trimmed = branch.trim();
  if (!trimmed) {
    throw new Error("分支名不能为空");
  }
  await runGitOk(run, path.resolve(workspacePath), ["git", "checkout", trimmed]);
}

export async function createGitBranch(
  workspacePath: string,
  branch: string,
  run: GitRunner = defaultGitRunner,
): Promise<void> {
  const trimmed = branch.trim();
  if (!trimmed) {
    throw new Error("分支名不能为空");
  }
  await runGitOk(run, path.resolve(workspacePath), ["git", "checkout", "-b", trimmed]);
}

async function workspaceHasGitCommits(cwd: string, run: GitRunner): Promise<boolean> {
  return (await run(["git", "rev-parse", "--verify", "HEAD"], cwd)).exitCode === 0;
}

async function isUntrackedWorkspaceFile(cwd: string, filePath: string, run: GitRunner): Promise<boolean> {
  const result = await run(["git", "ls-files", "--others", "--exclude-standard", "--", filePath], cwd);
  if (result.exitCode !== 0) {
    return false;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .includes(filePath);
}

export interface DiscardWorkspaceChangesResult {
  discardedPaths: string[];
}

export async function discardWorkspaceChanges(
  workspacePath: string,
  options: { path?: string } = {},
  run: GitRunner = defaultGitRunner,
): Promise<DiscardWorkspaceChangesResult> {
  const cwd = path.resolve(workspacePath);
  const revParse = await run(["git", "rev-parse", "--show-toplevel"], cwd);
  if (revParse.exitCode !== 0) {
    throw new Error("不是 Git 仓库，无法撤掉变更。");
  }

  const hasHead = await workspaceHasGitCommits(cwd, run);
  const targetPath = options.path?.trim();

  if (!targetPath) {
    if (hasHead) {
      await runGitOk(run, cwd, ["git", "reset", "--hard", "HEAD"]);
    }
    await runGitOk(run, cwd, ["git", "clean", "-fd"]);
    return { discardedPaths: [] };
  }

  if (await isUntrackedWorkspaceFile(cwd, targetPath, run)) {
    await runGitOk(run, cwd, ["git", "clean", "-f", "--", targetPath]);
    return { discardedPaths: [targetPath] };
  }

  if (!hasHead) {
    throw new Error(`文件 ${targetPath} 没有可撤掉的变更。`);
  }

  await runGitOk(run, cwd, ["git", "restore", "--source=HEAD", "--staged", "--worktree", "--", targetPath]);
  return { discardedPaths: [targetPath] };
}

export async function getWorkspaceDiff(
  workspacePath: string,
  run: GitRunner = defaultGitRunner,
  options: { includeContents?: boolean; includePatch?: boolean } = {},
): Promise<WorkspaceDiffResult> {
  if (options.includeContents === false && options.includePatch === false) {
    return getWorkspaceDiffSummary(workspacePath, run);
  }
  const includeContents = options.includeContents !== false;
  const includePatch = options.includePatch !== false;
  const cwd = path.resolve(workspacePath);
  const revParse = await run(["git", "rev-parse", "--show-toplevel"], cwd);
  if (revParse.exitCode !== 0) {
    return {
      workspacePath: cwd,
      patch: "",
      patchTruncated: false,
      fileCount: 0,
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };
  }

  const patchParts: string[] = [];
  const headDiff = await run(["git", "diff", "HEAD"], cwd);
  if (headDiff.exitCode === 0 && headDiff.stdout.trim()) {
    patchParts.push(headDiff.stdout);
  }

  const untrackedPaths = new Set<string>();
  const untracked = await run(["git", "ls-files", "--others", "--exclude-standard"], cwd);
  if (untracked.exitCode === 0 && untracked.stdout.trim()) {
    for (const file of untracked.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      untrackedPaths.add(file);
      const fileDiff = await run(["git", "diff", "--no-index", "--", "/dev/null", file], cwd);
      if (fileDiff.stdout.trim()) {
        patchParts.push(fileDiff.stdout);
      }
    }
  }

  const fullPatch = patchParts.join("\n");
  const truncated = truncatePatch(fullPatch, COMMIT_DIFF_MAX_CHARS);
  const summary = parseUnifiedDiffStats(fullPatch);
  const files = await Promise.all(
    summary.files.map(async (file) => {
      const contents = includeContents
        ? await readWorkspaceDiffContents(cwd, file.path, run)
        : { originalContent: "", currentContent: "" };
      let status: "modified" | "untracked" | "added" | "deleted" = "modified";
      if (untrackedPaths.has(file.path)) {
        status = "untracked";
      } else if (includeContents && !contents.originalContent && contents.currentContent) {
        status = "added";
      } else if (includeContents && contents.originalContent && !contents.currentContent) {
        status = "deleted";
      } else if (!includeContents) {
        // Status when contents are omitted: untracked set still known; otherwise modified.
        status = untrackedPaths.has(file.path) ? "untracked" : "modified";
      }
      return {
        ...file,
        status,
        ...contents,
      };
    }),
  );

  return {
    workspacePath: cwd,
    patch: includePatch ? truncated.text : "",
    patchTruncated: includePatch ? truncated.truncated : false,
    fileCount: files.length,
    files,
    totalAdditions: summary.totalAdditions,
    totalDeletions: summary.totalDeletions,
  };
}

function normalizeWorkspaceDiffPath(filePath: string): string {
  return path.sep === "\\" ? filePath.replace(/\\/g, "/") : filePath;
}

function inferDiffStatusFromPatch(patch: string, isUntracked: boolean): WorkspaceDiffFileStatus {
  if (isUntracked) {
    return "untracked";
  }
  if (/(^|\n)deleted file mode /m.test(patch) || /(^|\n)--- a\/.+\n\+\+\+ \/dev\/null/m.test(patch)) {
    return "deleted";
  }
  if (/(^|\n)new file mode /m.test(patch) || /(^|\n)--- \/dev\/null\n\+\+\+ b\//m.test(patch)) {
    return "added";
  }
  return "modified";
}

/** 可在 review 视图中直接预览的图片类型。 */
const IMAGE_PREVIEW_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;

function isBinaryPatch(patch: string): boolean {
  return /(^|\n)Binary files [^\n]+ differ\n/.test(patch) || /(^|\n)GIT binary patch\n/.test(patch);
}

/**
 * 二进制图片文件的预览字节：优先工作区版本；文件已删除时回退 HEAD 版本。
 * 读取失败或超限时返回 undefined，由 UI 降级为「二进制文件」提示。
 */
async function readImagePreview(
  cwd: string,
  repoRoot: string,
  target: string,
): Promise<WorkspaceFileDiffImagePreview | undefined> {
  const mimeType = IMAGE_PREVIEW_EXTENSIONS.get(path.extname(target).toLowerCase());
  if (!mimeType) return undefined;
  const worktreePath = path.join(cwd, target);
  try {
    const fileStat = await stat(worktreePath);
    if (fileStat.isFile() && fileStat.size > 0 && fileStat.size <= MAX_IMAGE_PREVIEW_BYTES) {
      const bytes = await readFile(worktreePath);
      if (bytes.length > 0 && bytes.length <= MAX_IMAGE_PREVIEW_BYTES) {
        return { mimeType, base64: bytes.toString("base64"), source: "workingTree" };
      }
    }
  } catch {
    // 文件已删除或不可读 → 回退 HEAD 版本。
  }
  const repoRelative = path.relative(repoRoot, worktreePath);
  if (repoRelative === "" || repoRelative.startsWith("..") || path.isAbsolute(repoRelative)) {
    return undefined;
  }
  try {
    const result = await execFileAsync("git", ["show", `HEAD:${repoRelative.split(path.sep).join("/")}`], {
      cwd,
      encoding: "buffer",
      maxBuffer: MAX_IMAGE_PREVIEW_BYTES,
    });
    const stdout = result.stdout;
    if (!Buffer.isBuffer(stdout) || stdout.length === 0) return undefined;
    return { mimeType, base64: stdout.toString("base64"), source: "head" };
  } catch {
    return undefined;
  }
}

/** Single-file unified patch for lazy review/diff views. */
export async function getWorkspaceFileDiff(
  workspacePath: string,
  filePath: string,
  run: GitRunner = defaultGitRunner,
  options: {
    context?: WorkspaceDiffContext;
    file?: import("../shared/ipc").WorkspaceDiffResult["files"][number];
  } = {},
): Promise<WorkspaceFileDiffResult> {
  const cwd = path.resolve(workspacePath);
  const target = normalizeWorkspaceDiffPath(filePath);
  if (!target.trim()) {
    throw new Error("File path is required.");
  }
  if (!isWorkspaceRelativePath(cwd, target)) {
    throw new Error("Invalid file path.");
  }

  const empty: WorkspaceFileDiffResult = {
    path: target,
    patch: "",
    patchTruncated: false,
    additions: 0,
    deletions: 0,
    status: "modified",
    binary: false,
  };

  const revParse = options.context
    ? { exitCode: 0, stdout: options.context.root, stderr: "" }
    : await run(["git", "rev-parse", "--show-toplevel"], cwd);
  if (revParse.exitCode !== 0) {
    return empty;
  }
  const repoRoot = revParse.stdout.trim() || cwd;

  const untracked = options.file
    ? { exitCode: 0, stdout: options.file.status === "untracked" ? target : "", stderr: "" }
    : await run(["git", "ls-files", "--others", "--exclude-standard", "-z", "--", target], cwd);
  if (untracked.exitCode !== 0) throw new Error(untracked.stderr || "Could not inspect Git file status");
  const isUntracked =
    untracked.exitCode === 0 &&
    untracked.stdout
      .split("\0")
      .map((line) => normalizeWorkspaceDiffPath(line))
      .filter(Boolean)
      .includes(target);

  let rawPatch = "";
  if (isUntracked || options.context?.hasHead === false) {
    const fileDiff = await run(["git", "diff", "--no-index", "--", "/dev/null", target], cwd);
    if (fileDiff.exitCode !== 0 && !(fileDiff.exitCode === 1 && fileDiff.stdout.trim())) {
      throw new Error(fileDiff.stderr || "Could not read untracked file diff");
    }
    rawPatch = fileDiff.stdout.trim() ? fileDiff.stdout : "";
  } else {
    const fileDiff = await run(
      options.context
        ? [
            "git",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--relative",
            "HEAD",
            "--",
            ...[options.file?.previousPath, target]
              .filter((entry): entry is string => entry !== undefined)
              .map((entry) => `:(literal)${entry}`),
          ]
        : ["git", "diff", "HEAD", "--", target],
      cwd,
    );
    if (fileDiff.exitCode !== 0) throw new Error(fileDiff.stderr || "Could not read file diff");
    if (fileDiff.exitCode === 0 && fileDiff.stdout.trim()) {
      rawPatch = fileDiff.stdout;
    }
  }

  const truncated = truncatePatch(rawPatch, 2_000_000);
  const summary = parseUnifiedDiffStats(rawPatch);
  const fileStats =
    summary.files.find((file) => normalizeWorkspaceDiffPath(file.path) === target) ?? summary.files[0];
  const binary = isBinaryPatch(rawPatch);
  const imagePreview = binary ? await readImagePreview(cwd, repoRoot, target) : undefined;

  return {
    path: target,
    patch: truncated.text,
    patchTruncated: truncated.truncated,
    additions: fileStats?.additions ?? 0,
    deletions: fileStats?.deletions ?? 0,
    status: inferDiffStatusFromPatch(rawPatch, isUntracked),
    binary,
    ...(imagePreview ? { imagePreview } : {}),
  };
}

export async function collectCommitDiffContext(
  workspacePath: string,
  includeUnstaged: boolean,
  run: GitRunner = defaultGitRunner,
): Promise<CommitDiffContext> {
  const cwd = path.resolve(workspacePath);

  const stagedNameStatus = await runGitOk(run, cwd, ["git", "diff", "--cached", "--name-status"]);
  const stagedStat = await runGitOk(run, cwd, ["git", "diff", "--cached", "--stat"]);
  const stagedPatchRaw = await runGitOk(run, cwd, ["git", "diff", "--cached"]);
  const stagedPatch = truncatePatch(stagedPatchRaw, COMMIT_DIFF_MAX_CHARS);

  let unstagedNameStatus: string | undefined;
  let unstagedPatch: { text: string; truncated: boolean } | undefined;
  if (includeUnstaged) {
    const unstagedName = await run(["git", "diff", "--name-status"], cwd);
    if (unstagedName.exitCode === 0 && unstagedName.stdout.trim()) {
      unstagedNameStatus = unstagedName.stdout.trim();
      const unstagedPatchRaw = unstagedName.stdout.trim() ? await runGitOk(run, cwd, ["git", "diff"]) : "";
      unstagedPatch = truncatePatch(unstagedPatchRaw, COMMIT_DIFF_MAX_CHARS);
    }
  }

  const recent = await run(["git", "log", "-8", "--oneline"], cwd);
  const recentCommits = recent.exitCode === 0 ? recent.stdout.trim() : "";

  return {
    stagedNameStatus,
    stagedStat,
    stagedPatch: stagedPatch.text,
    stagedPatchTruncated: stagedPatch.truncated,
    ...(unstagedNameStatus && { unstagedNameStatus }),
    ...(unstagedPatch && {
      unstagedPatch: unstagedPatch.text,
      unstagedPatchTruncated: unstagedPatch.truncated,
    }),
    recentCommits,
  };
}

export async function stageChanges(
  workspacePath: string,
  options: { includeUnstaged: boolean },
  run: GitRunner = defaultGitRunner,
): Promise<void> {
  if (!options.includeUnstaged) {
    return;
  }
  const cwd = path.resolve(workspacePath);
  await runGitOk(run, cwd, ["git", "add", "-A"]);
}

export async function createCommit(
  workspacePath: string,
  message: string,
  run: GitRunner = defaultGitRunner,
): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error("提交信息不能为空");
  }
  const cwd = path.resolve(workspacePath);
  await runGitOk(run, cwd, ["git", "commit", "-m", trimmed]);
  const sha = await runGitOk(run, cwd, ["git", "rev-parse", "--short", "HEAD"]);
  return sha;
}

export interface GitPullResult {
  output: string;
  pulled: boolean;
  conflicted: boolean;
  conflictFiles: string[];
}

export async function listMergeConflictFiles(
  workspacePath: string,
  run: GitRunner = defaultGitRunner,
): Promise<string[]> {
  const cwd = path.resolve(workspacePath);
  const diff = await run(["git", "diff", "--name-only", "--diff-filter=U"], cwd);
  if (diff.exitCode === 0 && diff.stdout.trim()) {
    return diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  const status = await run(["git", "status", "--porcelain"], cwd);
  if (status.exitCode !== 0) {
    return [];
  }
  return status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:U.|.U|AA|DD)/.test(line))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function pullOutputIndicatesConflict(output: string): boolean {
  const text = output.toLowerCase();
  return text.includes("conflict") || text.includes("冲突");
}

/** Prefer stderr on failure so progress lines on stdout (e.g. "Updating a..b") are not the sole message. */
export function composeGitCommandOutput(stdout: string, stderr: string, preferStderr = false): string {
  const out = stdout.trim();
  const err = stderr.trim();
  if (preferStderr) {
    if (err && out) {
      return err.includes(out) ? err : out.includes(err) ? out : `${out}\n${err}`;
    }
    return err || out;
  }
  if (out && err) {
    return out.includes(err) ? out : err.includes(out) ? err : `${out}\n${err}`;
  }
  return out || err;
}

export async function pullChanges(
  workspacePath: string,
  options: { branch?: string } = {},
  run: GitRunner = defaultGitRunner,
): Promise<GitPullResult> {
  const cwd = path.resolve(workspacePath);
  const branch =
    options.branch?.trim() || (await runGitOk(run, cwd, ["git", "branch", "--show-current"])).trim();
  if (!branch || branch === "detached") {
    throw new Error("无法确定当前分支，无法拉取");
  }

  const pull = await run(["git", "pull", "--no-rebase", "origin", branch], cwd);
  const combinedPull = `${pull.stdout}\n${pull.stderr}`;
  const output = composeGitCommandOutput(pull.stdout, pull.stderr, pull.exitCode !== 0);
  let conflictFiles = await listMergeConflictFiles(cwd, run);
  const conflicted =
    conflictFiles.length > 0 || (pull.exitCode !== 0 && pullOutputIndicatesConflict(combinedPull));

  if (pull.exitCode !== 0 && !conflicted) {
    const fallback = await run(["git", "pull", "--no-rebase"], cwd);
    const combinedFallback = `${fallback.stdout}\n${fallback.stderr}`;
    const fallbackOutput = composeGitCommandOutput(fallback.stdout, fallback.stderr, fallback.exitCode !== 0);
    conflictFiles = await listMergeConflictFiles(cwd, run);
    const fallbackConflicted =
      conflictFiles.length > 0 || (fallback.exitCode !== 0 && pullOutputIndicatesConflict(combinedFallback));
    if (fallback.exitCode !== 0 && !fallbackConflicted) {
      throw new Error(fallbackOutput || output || "git pull 失败");
    }
    return {
      output: fallbackOutput || output,
      pulled: fallback.exitCode === 0 && conflictFiles.length === 0,
      conflicted: fallbackConflicted,
      conflictFiles,
    };
  }

  return {
    output,
    pulled: pull.exitCode === 0 && conflictFiles.length === 0,
    conflicted,
    conflictFiles,
  };
}

export async function pushChanges(
  workspacePath: string,
  options: { branch?: string } = {},
  run: GitRunner = defaultGitRunner,
): Promise<{ method: "git" | "gh"; output: string }> {
  const cwd = path.resolve(workspacePath);
  const branch =
    options.branch?.trim() || (await runGitOk(run, cwd, ["git", "branch", "--show-current"])).trim();
  if (!branch || branch === "detached") {
    throw new Error("无法确定当前分支，无法推送");
  }

  const gh = await checkGhAvailability();
  if (gh.available && gh.authenticated) {
    const ghExe = resolveGhExecutable();
    if (ghExe) {
      try {
        const { stdout, stderr } = await execFileAsync(ghExe, ["repo", "sync", "--source", branch], {
          cwd,
          maxBuffer: 4 * 1024 * 1024,
        });
        return { method: "gh", output: String(stdout || stderr).trim() };
      } catch {
        // fall through to git push
      }
    }
  }

  const push = await run(["git", "push", "-u", "origin", branch], cwd);
  if (push.exitCode !== 0) {
    const fallback = await run(["git", "push"], cwd);
    if (fallback.exitCode !== 0) {
      throw new Error(fallback.stderr.trim() || fallback.stdout.trim() || "git push 失败");
    }
    return { method: "git", output: fallback.stdout.trim() || fallback.stderr.trim() };
  }
  return { method: "git", output: push.stdout.trim() || push.stderr.trim() };
}
