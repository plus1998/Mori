import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMIT_DIFF_MAX_CHARS,
  collectCommitDiffContext,
  createGitBranch,
  discardWorkspaceChanges,
  fetchFromOrigin,
  getGitWorkingTreeStatus,
  getWorkspaceDiff,
  getWorkspaceFileDiff,
  listGitCommits,
  listMergeConflictFiles,
  markWorkspaceFetched,
  pullChanges,
} from "../src/main/git-operations";

test("createGitBranch runs git checkout -b", async () => {
  const calls: string[][] = [];
  const run = async (args: string[], _cwd: string) => {
    calls.push(args);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await createGitBranch("/tmp/repo", "feature/new", run);
  expect(calls).toEqual([["git", "checkout", "-b", "feature/new"]]);
});

test("createGitBranch rejects empty branch name", async () => {
  const run = async (_args: string[], _cwd: string) => ({ exitCode: 0, stdout: "", stderr: "" });
  await expect(createGitBranch("/tmp/repo", "   ", run)).rejects.toThrow("分支名不能为空");
});

test("collectCommitDiffContext gathers staged diff via runner", async () => {
  const calls: string[][] = [];
  const run = async (args: string[], _cwd: string) => {
    calls.push(args);
    const key = args.join(" ");
    if (key.includes("diff --cached --name-status")) {
      return { exitCode: 0, stdout: "M\tfile.ts", stderr: "" };
    }
    if (key.includes("diff --cached --stat")) {
      return { exitCode: 0, stdout: " file.ts | 1 +\n", stderr: "" };
    }
    if (key === "git diff --cached") {
      return { exitCode: 0, stdout: "diff content", stderr: "" };
    }
    if (key.includes("log -8")) {
      return { exitCode: 0, stdout: "abc feat: init", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const context = await collectCommitDiffContext("/tmp/repo", false, run);
  expect(context.stagedNameStatus).toContain("file.ts");
  expect(context.recentCommits).toContain("feat: init");
  expect(calls.some((args) => args.includes("--cached"))).toBe(true);
});

test("COMMIT_DIFF_MAX_CHARS is large enough for real diffs", () => {
  expect(COMMIT_DIFF_MAX_CHARS).toBeGreaterThan(10_000);
});

test("Git status reuses the review summary for complete working-tree statistics", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return { exitCode: 0, stdout: args.includes("--show-toplevel") ? "/tmp/repo\n" : "", stderr: "" };
  };
  const status = await getGitWorkingTreeStatus("/tmp/repo", run, {
    fetchIfStale: false,
    readSummary: async () => ({
      workspacePath: "/tmp/repo",
      patch: "",
      patchTruncated: false,
      fileCount: 10,
      files: [],
      totalAdditions: 15,
      totalDeletions: 3,
    }),
  });
  expect(status).toMatchObject({ dirtyFileCount: 10, insertions: 15, deletions: 3 });
  expect(calls.some((args) => args.includes("status") || args.includes("--numstat"))).toBe(false);
});

test("getWorkspaceDiff combines HEAD diff and untracked files", async () => {
  const run = async (args: string[], _cwd: string) => {
    const key = args.join(" ");
    if (key === "git rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: "/tmp/repo\n", stderr: "" };
    }
    if (key === "git diff HEAD") {
      return {
        exitCode: 0,
        stdout: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        stderr: "",
      };
    }
    if (key === "git ls-files --others --exclude-standard") {
      return { exitCode: 0, stdout: "src/new.ts\n", stderr: "" };
    }
    if (key.includes("diff --no-index")) {
      return {
        exitCode: 1,
        stdout:
          "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+hello\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await getWorkspaceDiff("/tmp/repo", run);
  expect(result.fileCount).toBe(2);
  expect(result.files.map((file) => file.path)).toEqual(["src/a.ts", "src/new.ts"]);
  expect(result.files.find((file) => file.path === "src/a.ts")?.status).toBe("modified");
  expect(result.files.find((file) => file.path === "src/new.ts")?.status).toBe("untracked");
  expect(result.totalAdditions).toBeGreaterThan(0);
  expect(result.patch).toContain("src/a.ts");
  expect(result.patch).toContain("src/new.ts");
});

test("getWorkspaceDiff returns original and current file contents for merge views", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "eco-workspace-diff-"));
  await mkdir(join(workspacePath, "src"));
  await writeFile(join(workspacePath, "src", "a.ts"), "const value = 2;\n", "utf8");

  const run = async (args: string[], _cwd: string) => {
    const key = args.join(" ");
    if (key === "git rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: `${workspacePath}\n`, stderr: "" };
    }
    if (key === "git diff HEAD") {
      return {
        exitCode: 0,
        stdout:
          "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n",
        stderr: "",
      };
    }
    if (key === "git ls-files --others --exclude-standard") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (key === "git show HEAD:src/a.ts") {
      return { exitCode: 0, stdout: "const value = 1;\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  try {
    const result = await getWorkspaceDiff(workspacePath, run);
    expect(result.files[0]).toMatchObject({
      path: "src/a.ts",
      originalContent: "const value = 1;\n",
      currentContent: "const value = 2;\n",
    });
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("getWorkspaceDiff can omit file contents and patch for remote summaries", async () => {
  const run = async (args: string[]) => {
    const key = args.join(" ");
    if (key === "git rev-parse --show-toplevel --show-prefix") {
      return { exitCode: 0, stdout: "/tmp/repo\n", stderr: "" };
    }
    if (args.includes("--raw")) {
      return {
        exitCode: 0,
        stdout: ":100644 100644 1111111 2222222 M\0src/a.ts\0" + "1\t1\tsrc/a.ts\0",
        stderr: "",
      };
    }
    if (args.includes("--porcelain=v1")) {
      return { exitCode: 0, stdout: " M src/a.ts\0", stderr: "" };
    }
    if (key.startsWith("git show ")) {
      throw new Error("should not load file contents for summary mode");
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await getWorkspaceDiff("/tmp/repo", run, {
    includeContents: false,
    includePatch: false,
  });
  expect(result.patch).toBe("");
  expect(result.files).toHaveLength(1);
  expect(result.files[0]).toMatchObject({
    path: "src/a.ts",
    originalContent: "",
    currentContent: "",
  });
});

test("getWorkspaceFileDiff returns unified patch for a tracked file", async () => {
  const run = async (args: string[]) => {
    const key = args.join(" ");
    if (key === "git rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: "/tmp/repo\n", stderr: "" };
    }
    if (key === "git ls-files --others --exclude-standard -z -- src/a.ts") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (key === "git diff HEAD -- src/a.ts") {
      return {
        exitCode: 0,
        stdout: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await getWorkspaceFileDiff("/tmp/repo", "src/a.ts", run);
  expect(result.path).toBe("src/a.ts");
  expect(result.status).toBe("modified");
  expect(result.patch).toContain("+new");
  expect(result.additions).toBe(1);
  expect(result.deletions).toBe(1);
  expect(result.patchTruncated).toBe(false);
  expect(result.binary).toBe(false);
});

test("getWorkspaceFileDiff returns unified patch for an untracked file", async () => {
  const run = async (args: string[]) => {
    const key = args.join(" ");
    if (key === "git rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: "/tmp/repo\n", stderr: "" };
    }
    if (key === "git ls-files --others --exclude-standard -z -- src/new.ts") {
      return { exitCode: 0, stdout: "src/new.ts\0", stderr: "" };
    }
    if (key === "git diff --no-index -- /dev/null src/new.ts") {
      return {
        exitCode: 1,
        stdout:
          "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+hello\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await getWorkspaceFileDiff("/tmp/repo", "src/new.ts", run);
  expect(result.path).toBe("src/new.ts");
  expect(result.status).toBe("untracked");
  expect(result.patch).toContain("+hello");
  expect(result.additions).toBe(1);
});

test("getWorkspaceFileDiff marks binary patches and skips preview for missing image files", async () => {
  const run = async (args: string[]) => {
    const key = args.join(" ");
    if (key === "git rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: "/tmp/repo\n", stderr: "" };
    }
    if (key === "git ls-files --others --exclude-standard -z -- assets/logo.png") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (key === "git diff HEAD -- assets/logo.png") {
      return {
        exitCode: 0,
        stdout:
          "diff --git a/assets/logo.png b/assets/logo.png\nindex 1111111..2222222 100644\nBinary files a/assets/logo.png and b/assets/logo.png differ\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await getWorkspaceFileDiff("/tmp/repo", "assets/logo.png", run);
  expect(result.binary).toBe(true);
  expect(result.patch).toContain("Binary files");
  // 工作区文件不存在且 HEAD 回退失败时，不携带预览数据，由 UI 降级提示。
  expect(result.imagePreview).toBeUndefined();
});

test("getWorkspaceFileDiff rejects empty and unsafe paths", async () => {
  const run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  await expect(getWorkspaceFileDiff("/tmp/repo", "  ", run)).rejects.toThrow("File path is required.");
  await expect(getWorkspaceFileDiff("/tmp/repo", "../outside.ts", run)).rejects.toThrow("Invalid file path.");
});

test("discardWorkspaceChanges resets tracked files and cleans untracked files", async () => {
  const calls: string[][] = [];
  const run = async (args: string[], _cwd: string) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "git rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: "/tmp/repo\n", stderr: "" };
    }
    if (key === "git rev-parse --verify HEAD") {
      return { exitCode: 0, stdout: "abc\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await discardWorkspaceChanges("/tmp/repo", {}, run);
  expect(calls).toEqual([
    ["git", "rev-parse", "--show-toplevel"],
    ["git", "rev-parse", "--verify", "HEAD"],
    ["git", "reset", "--hard", "HEAD"],
    ["git", "clean", "-fd"],
  ]);
});

test("discardWorkspaceChanges restores a tracked file", async () => {
  const calls: string[][] = [];
  const run = async (args: string[], _cwd: string) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "git rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: "/tmp/repo\n", stderr: "" };
    }
    if (key === "git rev-parse --verify HEAD") {
      return { exitCode: 0, stdout: "abc\n", stderr: "" };
    }
    if (key.includes("ls-files --others --exclude-standard -- src/a.ts")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await discardWorkspaceChanges("/tmp/repo", { path: "src/a.ts" }, run);
  expect(result.discardedPaths).toEqual(["src/a.ts"]);
  expect(calls).toContainEqual([
    "git",
    "restore",
    "--source=HEAD",
    "--staged",
    "--worktree",
    "--",
    "src/a.ts",
  ]);
});

test("discardWorkspaceChanges removes an untracked file", async () => {
  const calls: string[][] = [];
  const run = async (args: string[], _cwd: string) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "git rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: "/tmp/repo\n", stderr: "" };
    }
    if (key.includes("ls-files --others --exclude-standard -- src/new.ts")) {
      return { exitCode: 0, stdout: "src/new.ts\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await discardWorkspaceChanges("/tmp/repo", { path: "src/new.ts" }, run);
  expect(result.discardedPaths).toEqual(["src/new.ts"]);
  expect(calls).toContainEqual(["git", "clean", "-f", "--", "src/new.ts"]);
});

test("getWorkspaceDiff returns empty result for non-git workspace", async () => {
  const run = async (args: string[], _cwd: string) => {
    if (args.join(" ") === "git rev-parse --show-toplevel") {
      return { exitCode: 128, stdout: "", stderr: "not a git repository" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await getWorkspaceDiff("/tmp/plain", run);
  expect(result.fileCount).toBe(0);
  expect(result.patch).toBe("");
});

test("listGitCommits paginates git log output", async () => {
  const run = async (args: string[], _cwd: string) => {
    const key = args.join(" ");
    if (key.includes("rev-parse --show-toplevel")) {
      return { exitCode: 0, stdout: "/tmp/repo", stderr: "" };
    }
    if (key.includes("rev-parse --verify HEAD")) {
      return { exitCode: 0, stdout: "abc123", stderr: "" };
    }
    if (key.includes("log --skip=0") && key.includes("-n 6")) {
      return {
        exitCode: 0,
        stdout: [
          "sha1\x1fsh1\x1ffeat: one\x1fAlice\x1f2 hours ago\x1f (HEAD -> main)",
          "sha2\x1fsh2\x1ffix: two\x1fBob\x1f3 hours ago\x1f",
          "sha3\x1fsh3\x1fchore: three\x1fCara\x1f4 hours ago\x1f",
          "sha4\x1fsh4\x1frefactor: four\x1fDan\x1f5 hours ago\x1f",
          "sha5\x1fsh5\x1fdocs: five\x1fEve\x1f6 hours ago\x1f",
          "sha6\x1fsh6\x1ftest: six\x1fFinn\x1f7 hours ago\x1f",
        ].join("\n"),
        stderr: "",
      };
    }
    if (key.includes("log --skip=5") && key.includes("-n 6")) {
      return {
        exitCode: 0,
        stdout: "sha6\x1fsh6\x1ftest: six\x1fFinn\x1f7 hours ago\x1f",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const firstPage = await listGitCommits("/tmp/repo", { skip: 0, limit: 5 }, run);
  expect(firstPage.commits).toHaveLength(5);
  expect(firstPage.commits[0]?.subject).toBe("feat: one");
  expect(firstPage.commits[0]?.decorations).toEqual(["main"]);
  expect(firstPage.hasMore).toBe(true);

  const secondPage = await listGitCommits("/tmp/repo", { skip: 5, limit: 5 }, run);
  expect(secondPage.commits).toHaveLength(1);
  expect(secondPage.hasMore).toBe(false);
});

test("pullChanges returns conflict files when merge fails", async () => {
  const calls: string[][] = [];
  const run = async (args: string[], _cwd: string) => {
    calls.push(args);
    const key = args.join(" ");
    if (key.includes("branch --show-current")) {
      return { exitCode: 0, stdout: "main\n", stderr: "" };
    }
    if (key.includes("git pull")) {
      return {
        exitCode: 1,
        stdout: "Auto-merging src/a.ts\nCONFLICT (content): Merge conflict in src/a.ts\n",
        stderr: "",
      };
    }
    if (key.includes("diff --name-only --diff-filter=U")) {
      return { exitCode: 0, stdout: "src/a.ts\n", stderr: "" };
    }
    if (key === "git status --porcelain") {
      return { exitCode: 0, stdout: "UU src/a.ts\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await pullChanges("/tmp/repo", {}, run);
  expect(result.conflicted).toBe(true);
  expect(result.conflictFiles).toEqual(["src/a.ts"]);
  expect(result.pulled).toBe(false);
  expect(calls.some((args) => args.join(" ").includes("git pull --no-rebase origin main"))).toBe(true);
});

test("pullChanges succeeds without conflicts", async () => {
  const run = async (args: string[], _cwd: string) => {
    const key = args.join(" ");
    if (key.includes("branch --show-current")) {
      return { exitCode: 0, stdout: "main\n", stderr: "" };
    }
    if (key.includes("git pull")) {
      return { exitCode: 0, stdout: "Already up to date.\n", stderr: "" };
    }
    if (key.includes("diff --name-only --diff-filter=U")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (key === "git status --porcelain") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await pullChanges("/tmp/repo", {}, run);
  expect(result.conflicted).toBe(false);
  expect(result.pulled).toBe(true);
  expect(result.conflictFiles).toEqual([]);
});

test("pullChanges throws with stderr when stdout only has updating range", async () => {
  let pullCount = 0;
  const run = async (args: string[], _cwd: string) => {
    const key = args.join(" ");
    if (key.includes("branch --show-current")) {
      return { exitCode: 0, stdout: "main\n", stderr: "" };
    }
    if (key.includes("git pull")) {
      pullCount += 1;
      return {
        exitCode: 1,
        stdout: "Updating c9acc8b5..d8a206d5\n",
        stderr:
          "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts\n",
      };
    }
    if (key.includes("diff --name-only --diff-filter=U")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (key === "git status --porcelain") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await expect(pullChanges("/tmp/repo", {}, run)).rejects.toThrow(/local changes|overwritten by merge/);
  expect(pullCount).toBe(2);
});

test("listMergeConflictFiles reads unmerged paths from porcelain status", async () => {
  const run = async (args: string[], _cwd: string) => {
    const key = args.join(" ");
    if (key.includes("diff --name-only --diff-filter=U")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (key === "git status --porcelain") {
      return { exitCode: 0, stdout: "UU src/conflict.ts\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const files = await listMergeConflictFiles("/tmp/repo", run);
  expect(files).toEqual(["src/conflict.ts"]);
});

test("fetchFromOrigin runs git fetch origin when remote exists", async () => {
  const calls: string[][] = [];
  const run = async (args: string[], _cwd: string) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "git remote get-url origin") {
      return { exitCode: 0, stdout: "git@github.com:eco/repo.git", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const result = await fetchFromOrigin("/tmp/repo", run);
  expect(result.ok).toBe(true);
  expect(calls).toContainEqual(["git", "fetch", "origin"]);
});

test("getGitWorkingTreeStatus uses upstream tracking branch for ahead/behind", async () => {
  markWorkspaceFetched("/tmp/repo");
  const calls: string[][] = [];
  const run = async (args: string[], _cwd: string) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "git rev-parse --show-toplevel") {
      return { exitCode: 0, stdout: "/tmp/repo", stderr: "" };
    }
    if (key === "git rev-parse --verify HEAD") {
      return { exitCode: 0, stdout: "abc123", stderr: "" };
    }
    if (key === "git branch --show-current") {
      return { exitCode: 0, stdout: "main", stderr: "" };
    }
    if (key === "git branch --format=%(refname:short)") {
      return { exitCode: 0, stdout: "main", stderr: "" };
    }
    if (key === "git status --short") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (key === "git diff --numstat HEAD") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (key === "git rev-parse --abbrev-ref @{upstream}") {
      return { exitCode: 0, stdout: "origin/main", stderr: "" };
    }
    if (key === "git rev-list --left-right --count @{upstream}...HEAD") {
      return { exitCode: 0, stdout: "2\t1", stderr: "" };
    }
    if (key === "git remote get-url origin") {
      return { exitCode: 0, stdout: "git@github.com:eco/repo.git", stderr: "" };
    }
    if (key.startsWith("git --version") || key.includes("gh ")) {
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const status = await getGitWorkingTreeStatus("/tmp/repo", run, { fetchIfStale: false });
  expect(status.behindCount).toBe(2);
  expect(status.aheadCount).toBe(1);
  expect(status.hasUpstream).toBe(true);
  expect(
    calls.some((args) => args.join(" ") === "git rev-list --left-right --count @{upstream}...HEAD"),
  ).toBe(true);
});
