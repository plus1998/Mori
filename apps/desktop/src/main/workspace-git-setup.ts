import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceInfo } from "../shared/ipc";
import { inspectWorkspace } from "./workspace-inspect";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (command: string[], cwd: string) => Promise<GitCommandResult>;

export const DEFAULT_ECO_GITIGNORE_LINES = [
  "node_modules/",
  "dist/",
  "build/",
  ".env",
  ".env.*",
  ".DS_Store",
  ".eco/",
];

const INITIAL_COMMIT_MESSAGE = "initial commit";
const FALLBACK_COMMIT_IDENTITY_ARGS = [
  "-c",
  "user.name=Mori",
  "-c",
  "user.email=mori@localhost",
] as const;

export async function ensureEcoGitignore(workspacePath: string): Promise<boolean> {
  const gitignorePath = path.join(workspacePath, ".gitignore");
  try {
    const existing = await fs.readFile(gitignorePath, "utf8");
    const lines = existing.split("\n");
    const missing = DEFAULT_ECO_GITIGNORE_LINES.filter(
      (entry) => !lines.some((line) => line.trim() === entry || line.trim() === entry.replace(/\/$/, "")),
    );
    if (missing.length === 0) {
      return false;
    }
    const suffix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
    await fs.writeFile(gitignorePath, `${existing}${suffix}${missing.join("\n")}\n`, "utf8");
    return true;
  } catch {
    await fs.writeFile(gitignorePath, `${DEFAULT_ECO_GITIGNORE_LINES.join("\n")}\n`, "utf8");
    return true;
  }
}

async function createInitialCommit(workspacePath: string, run: GitCommandRunner): Promise<void> {
  await ensureEcoGitignore(workspacePath);

  const add = await run(["git", "add", "-A"], workspacePath);
  if (add.exitCode !== 0) {
    throw new Error(`git add 失败：${add.stderr || add.stdout}`.trim());
  }

  const hasConfiguredIdentity = await hasGitCommitIdentity(workspacePath, run);
  const commitCommand = hasConfiguredIdentity
    ? ["git", "commit", "-m", INITIAL_COMMIT_MESSAGE]
    : ["git", ...FALLBACK_COMMIT_IDENTITY_ARGS, "commit", "-m", INITIAL_COMMIT_MESSAGE];
  const commit = await run(commitCommand, workspacePath);
  if (commit.exitCode === 0) {
    return;
  }

  // A workspace may intentionally have `user.useConfigOnly=true` without a
  // configured identity. The first commit is Eco's bootstrap commit, so it can
  // use a local fallback identity while leaving the user's Git configuration
  // untouched for later commits.
  const fallbackCommit = hasConfiguredIdentity
    ? await run(
        ["git", ...FALLBACK_COMMIT_IDENTITY_ARGS, "commit", "-m", INITIAL_COMMIT_MESSAGE],
        workspacePath,
      )
    : commit;
  if (fallbackCommit.exitCode === 0) {
    return;
  }

  const emptyCommit = await run(
    ["git", ...FALLBACK_COMMIT_IDENTITY_ARGS, "commit", "--allow-empty", "-m", INITIAL_COMMIT_MESSAGE],
    workspacePath,
  );
  if (emptyCommit.exitCode !== 0) {
    throw new Error(
      `无法创建初始提交：${
        emptyCommit.stderr ||
        emptyCommit.stdout ||
        fallbackCommit.stderr ||
        fallbackCommit.stdout ||
        commit.stderr ||
        commit.stdout
      }`.trim(),
    );
  }
}

async function hasGitCommitIdentity(workspacePath: string, run: GitCommandRunner): Promise<boolean> {
  const [name, email] = await Promise.all([
    run(["git", "config", "--get", "user.name"], workspacePath),
    run(["git", "config", "--get", "user.email"], workspacePath),
  ]);
  return (
    name.exitCode === 0 && Boolean(name.stdout.trim()) && email.exitCode === 0 && Boolean(email.stdout.trim())
  );
}

export async function prepareWorkspaceGit(
  workspacePath: string,
  run: GitCommandRunner,
): Promise<WorkspaceInfo> {
  const resolvedPath = path.resolve(workspacePath.trim());
  let info = await inspectWorkspace(resolvedPath);

  if (info.isGitRepository && info.hasGitCommits) {
    return info;
  }

  if (!info.isGitRepository) {
    const init = await run(["git", "init", "-b", "main"], resolvedPath);
    if (init.exitCode !== 0) {
      throw new Error(`git init 失败：${init.stderr || init.stdout}`.trim());
    }
    info = await inspectWorkspace(resolvedPath);
    if (!info.isGitRepository) {
      throw new Error("Git 初始化后仍无法识别仓库，请检查目录权限。");
    }
  }

  if (!info.hasGitCommits) {
    await createInitialCommit(resolvedPath, run);
    info = await inspectWorkspace(resolvedPath);
    if (!info.hasGitCommits) {
      throw new Error("已尝试创建初始提交，但 HEAD 仍无效。请手动执行 git commit --allow-empty。");
    }
  }

  return info;
}
