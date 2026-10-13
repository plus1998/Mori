import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitRunner, type GitRunner, getWorkspaceDiff } from "../src/main/git-operations";
import { getWorkspaceDiffSummary, parseRawNumstat } from "../src/main/workspace-diff-summary";
import { WorkspaceReviewService } from "../src/main/workspace-review-service";
import { diffFilePath, parseDiff } from "../src/renderer/prosemirror/diff-from-patch";
import type { WorkspaceDiffChangedEvent } from "../src/shared/ipc";

async function fixture(committed = true) {
  const cwd = await mkdtemp(path.join(tmpdir(), "eco-review-"));
  const git = async (...args: string[]) => {
    const result = await defaultGitRunner(["git", ...args], cwd);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  await git("init", "-b", "main");
  await git("config", "user.name", "Review test");
  await git("config", "user.email", "review@example.test");
  await writeFile(path.join(cwd, ".gitignore"), "ignored/\n");
  await writeFile(path.join(cwd, "tracked.ts"), "const value = 0;\n");
  await writeFile(path.join(cwd, "untouched.ts"), "const untouched = 0;\n");
  if (committed) {
    await git("add", ".");
    await git("commit", "-m", "fixture");
  }
  return { cwd, git, dispose: () => rm(cwd, { recursive: true, force: true }) };
}

async function until(condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 5_000) throw new Error("Timed out waiting for native Git file watcher");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("summary stays complete beyond patch limits and never generates untracked patches", async () => {
  const repo = await fixture();
  try {
    await writeFile(path.join(repo.cwd, "a-huge.txt"), "new line\n".repeat(50_000));
    await writeFile(path.join(repo.cwd, "z-late.txt"), "last file\n");
    await writeFile(path.join(repo.cwd, "tracked.ts"), "const value = 1;\n");
    const calls: string[][] = [];
    const run: GitRunner = (args, cwd, options) => {
      calls.push(args);
      return defaultGitRunner(args, cwd, options);
    };
    const diff = await getWorkspaceDiff(repo.cwd, run, { includeContents: false, includePatch: false });
    expect(diff.fileCount).toBe(3);
    expect(diff.files.find((file) => file.path === "a-huge.txt")?.additions).toBe(50_000);
    expect(diff.files.find((file) => file.path === "z-late.txt")?.additions).toBe(1);
    expect(diff.totalAdditions).toBe(50_002);
    expect(calls.some((args) => args.includes("--no-index"))).toBe(false);
    expect(diff.patch).toBe("");
  } finally {
    await repo.dispose();
  }
});

test("summary handles filenames, renames, deletions, binary attributes and symlinks", async () => {
  const repo = await fixture();
  try {
    await repo.git("mv", "tracked.ts", " renamed\t文件.ts");
    await rm(path.join(repo.cwd, "untouched.ts"));
    await writeFile(path.join(repo.cwd, "new\nfile.txt"), "one\ntwo");
    await writeFile(path.join(repo.cwd, ".gitattributes"), "*.asset -diff\n*.text diff\n");
    await writeFile(path.join(repo.cwd, "binary.asset"), "not binary bytes\n");
    await writeFile(path.join(repo.cwd, "forced.text"), Buffer.from("a\0b\nc\n"));
    await symlink("tracked.ts", path.join(repo.cwd, "link"));
    const diff = await getWorkspaceDiffSummary(repo.cwd, defaultGitRunner);
    expect(diff.files.find((file) => file.path === " renamed\t文件.ts")?.previousPath).toBe("tracked.ts");
    expect(diff.files.find((file) => file.path === "untouched.ts")?.status).toBe("deleted");
    expect(diff.files.find((file) => file.path === "new\nfile.txt")?.additions).toBe(2);
    expect(diff.files.find((file) => file.path === "binary.asset")).toMatchObject({
      binary: true,
      additions: 0,
    });
    expect(diff.files.find((file) => file.path === "forced.text")?.additions).toBe(2);
    expect(diff.files.find((file) => file.path === "link")?.additions).toBe(1);
  } finally {
    await repo.dispose();
  }
});

test("unborn repositories show staged and current untracked contents", async () => {
  const repo = await fixture(false);
  try {
    await repo.git("add", "tracked.ts");
    await writeFile(path.join(repo.cwd, "tracked.ts"), "one\ntwo\n");
    const diff = await getWorkspaceDiffSummary(repo.cwd, defaultGitRunner);
    expect(diff.files.find((file) => file.path === "tracked.ts")).toMatchObject({
      status: "added",
      additions: 2,
    });
    expect(diff.files.find((file) => file.path === "untouched.ts")?.status).toBe("untracked");
  } finally {
    await repo.dispose();
  }
});

test("subdirectory summaries stay scoped and return workspace-relative paths", async () => {
  const repo = await fixture();
  try {
    await mkdir(path.join(repo.cwd, "nested"));
    await writeFile(path.join(repo.cwd, "nested", "inside.txt"), "inside\n");
    await writeFile(path.join(repo.cwd, "outside.txt"), "outside\n");
    const diff = await getWorkspaceDiffSummary(path.join(repo.cwd, "nested"), defaultGitRunner);
    expect(diff.files.map((file) => file.path)).toEqual(["inside.txt"]);
  } finally {
    await repo.dispose();
  }
});

test("shared summaries and single-file bodies execute once for concurrent consumers", async () => {
  const repo = await fixture();
  const calls: string[][] = [];
  const run: GitRunner = (args, cwd, options) => {
    calls.push(args);
    return defaultGitRunner(args, cwd, options);
  };
  const service = new WorkspaceReviewService(run, () => {});
  try {
    await writeFile(path.join(repo.cwd, "tracked.ts"), "const value = 1;\n");
    const summaries = await Promise.all(Array.from({ length: 4 }, () => service.getSummary(repo.cwd)));
    expect(summaries.every((summary) => summary === summaries[0])).toBe(true);
    expect(calls.filter((args) => args.includes("--porcelain=v1"))).toHaveLength(1);
    const before = calls.length;
    const files = await Promise.all(Array.from({ length: 4 }, () => service.getFile(repo.cwd, "tracked.ts")));
    expect(files.every((file) => file === files[0])).toBe(true);
    expect(calls.length - before).toBe(1);
    expect(files[0]!.patch).toContain("+const value = 1;");
    await service.getSummary(repo.cwd);
    await service.getFile(repo.cwd, "tracked.ts");
    expect(calls.length - before).toBe(1);
  } finally {
    service.dispose();
    await repo.dispose();
  }
});

test("native watcher refreshes equal-count edits and retains unaffected file revisions", async () => {
  const repo = await fixture();
  const events: WorkspaceDiffChangedEvent[] = [];
  const service = new WorkspaceReviewService(defaultGitRunner, (event) => events.push(event));
  try {
    await writeFile(path.join(repo.cwd, "tracked.ts"), "const value = 1;\n");
    await writeFile(path.join(repo.cwd, "untouched.ts"), "const untouched = 1;\n");
    const first = await service.getSummary(repo.cwd);
    await service.getFile(repo.cwd, "tracked.ts");
    await writeFile(path.join(repo.cwd, "tracked.ts"), "const value = 2;\n");
    await until(() => events.some((event) => event.changedPaths?.includes("tracked.ts")));
    const second = await service.getSummary(repo.cwd);
    expect(second.totalAdditions).toBe(first.totalAdditions);
    expect(second.totalDeletions).toBe(first.totalDeletions);
    expect(second.files.find((file) => file.path === "tracked.ts")?.revision).not.toBe(
      first.files.find((file) => file.path === "tracked.ts")?.revision,
    );
    expect(second.files.find((file) => file.path === "untouched.ts")?.revision).toBe(
      first.files.find((file) => file.path === "untouched.ts")?.revision,
    );
    expect((await service.getFile(repo.cwd, "tracked.ts")).patch).toContain("+const value = 2;");
  } finally {
    service.dispose();
    await repo.dispose();
  }
});

test("ignored writes and Git object/LFS churn do not invalidate review", async () => {
  const repo = await fixture();
  const events: WorkspaceDiffChangedEvent[] = [];
  const service = new WorkspaceReviewService(defaultGitRunner, (event) => events.push(event));
  try {
    await service.getSummary(repo.cwd);
    await mkdir(path.join(repo.cwd, "ignored"));
    await writeFile(path.join(repo.cwd, "ignored", "output.txt"), "generated\n");
    await mkdir(path.join(repo.cwd, ".git", "lfs", "tmp"), { recursive: true });
    await writeFile(path.join(repo.cwd, ".git", "lfs", "tmp", "temp"), "large asset bytes");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(events).toEqual([]);
  } finally {
    service.dispose();
    await repo.dispose();
  }
});

test("linked worktrees observe external Git metadata and their own file changes", async () => {
  const repo = await fixture();
  const worktree = `${repo.cwd}-worktree`;
  const events: WorkspaceDiffChangedEvent[] = [];
  const service = new WorkspaceReviewService(defaultGitRunner, (event) => events.push(event));
  try {
    await repo.git("worktree", "add", "--detach", worktree);
    await service.getSummary(worktree);
    await writeFile(path.join(worktree, "tracked.ts"), "const value = 9;\n");
    await until(() => events.length > 0);
    expect((await service.getFile(worktree, "tracked.ts")).patch).toContain("+const value = 9;");
    events.length = 0;
    const stage = await defaultGitRunner(["git", "add", "tracked.ts"], worktree);
    expect(stage.exitCode).toBe(0);
    await until(() => events.some((event) => event.changedPaths === undefined));
  } finally {
    service.dispose();
    await rm(worktree, { recursive: true, force: true });
    await repo.dispose();
  }
});

test("metadata errors are reported instead of returning a clean workspace", async () => {
  const repo = await fixture();
  try {
    const run: GitRunner = (args, cwd, options) =>
      args.includes("--raw")
        ? Promise.resolve({ exitCode: 128, stdout: "", stderr: "metadata failed" })
        : defaultGitRunner(args, cwd, options);
    await expect(getWorkspaceDiffSummary(repo.cwd, run)).rejects.toThrow("metadata failed");
    expect(() => parseRawNumstat(":100644 100644 a b M\0")).toThrow();
  } finally {
    await repo.dispose();
  }
});

test("single-file previews preserve quoted, spaced and literal pathspec filenames", async () => {
  const repo = await fixture();
  const service = new WorkspaceReviewService(defaultGitRunner, () => {});
  try {
    for (const name of ["文件.ts", "space file.ts", "tab\tfile.ts", "line\nfile.ts", "literal[1].ts"]) {
      await writeFile(path.join(repo.cwd, name), "export const added = 1;\n");
      const result = await service.getFile(repo.cwd, name);
      const parsed = parseDiff(result.patch)[0];
      expect(parsed && diffFilePath(parsed)).toBe(name);
    }
  } finally {
    service.dispose();
    await repo.dispose();
  }
});

test("different file consumers queue Git reads instead of spawning concurrent processes", async () => {
  const repo = await fixture();
  let active = 0;
  let peak = 0;
  const run: GitRunner = async (args, cwd, options) => {
    const fileRead = args.some((arg) => arg.startsWith(":(literal)"));
    if (fileRead) {
      active++;
      peak = Math.max(peak, active);
    }
    try {
      if (fileRead) await new Promise((resolve) => setTimeout(resolve, 20));
      return await defaultGitRunner(args, cwd, options);
    } finally {
      if (fileRead) active--;
    }
  };
  const service = new WorkspaceReviewService(run, () => {});
  try {
    await writeFile(path.join(repo.cwd, "tracked.ts"), "export const value = 1;\n");
    await writeFile(path.join(repo.cwd, "untouched.ts"), "export const value = 2;\n");
    await service.getSummary(repo.cwd);
    const results = await Promise.all([
      service.getFile(repo.cwd, "tracked.ts"),
      service.getFile(repo.cwd, "untouched.ts"),
    ]);
    expect(results[0]?.patch).toContain("+export const value = 1;");
    expect(results[1]?.patch).toContain("+export const value = 2;");
    expect(peak).toBe(1);
  } finally {
    service.dispose();
    await repo.dispose();
  }
});

test("a file mutation cancels an obsolete body read and returns the current snapshot", async () => {
  const repo = await fixture();
  const events: WorkspaceDiffChangedEvent[] = [];
  let blocked = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run: GitRunner = async (args, cwd, options) => {
    if (args.includes(":(literal)tracked.ts") && !blocked) {
      blocked = true;
      await gate;
    }
    return defaultGitRunner(args, cwd, options);
  };
  const service = new WorkspaceReviewService(run, (event) => events.push(event));
  try {
    await writeFile(path.join(repo.cwd, "tracked.ts"), "export const value = 1;\n");
    await service.getSummary(repo.cwd);
    const pending = service.getFile(repo.cwd, "tracked.ts");
    await until(() => blocked);
    await writeFile(path.join(repo.cwd, "tracked.ts"), "export const value = 2;\n");
    await until(() => events.some((event) => event.changedPaths?.includes("tracked.ts")));
    release();
    expect((await pending).patch).toContain("+export const value = 2;");
  } finally {
    release();
    service.dispose();
    await repo.dispose();
  }
});

test("reopening an evicted workspace uses a fresh file revision", async () => {
  const repos: Awaited<ReturnType<typeof fixture>>[] = [];
  const service = new WorkspaceReviewService(defaultGitRunner, () => {});
  try {
    const firstRepo = await fixture(false);
    repos.push(firstRepo);
    const first = await service.getSummary(firstRepo.cwd);
    await service.getFile(firstRepo.cwd, "tracked.ts");
    for (let index = 0; index < 8; index++) {
      const repo = await fixture(false);
      repos.push(repo);
      await service.getSummary(repo.cwd);
    }
    await writeFile(path.join(firstRepo.cwd, "tracked.ts"), "export const value = 9;\n");
    const reopened = await service.getSummary(firstRepo.cwd);
    expect(reopened.files.find((file) => file.path === "tracked.ts")?.revision).not.toBe(
      first.files.find((file) => file.path === "tracked.ts")?.revision,
    );
    expect((await service.getFile(firstRepo.cwd, "tracked.ts")).patch).toContain("+export const value = 9;");
  } finally {
    service.dispose();
    await Promise.all(repos.map((repo) => repo.dispose()));
  }
});

test("a workspace inspected before git init acquires automatic refresh after initialization", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "eco-review-init-"));
  const events: WorkspaceDiffChangedEvent[] = [];
  const service = new WorkspaceReviewService(defaultGitRunner, (event) => events.push(event));
  try {
    expect((await service.getSummary(cwd)).fileCount).toBe(0);
    const init = await defaultGitRunner(["git", "init", "-b", "main"], cwd);
    expect(init.exitCode).toBe(0);
    await writeFile(path.join(cwd, "new.ts"), "one\n");
    const summaries = await Promise.all([service.getSummary(cwd), service.getSummary(cwd)]);
    expect(summaries[0]?.fileCount).toBe(1);
    await writeFile(path.join(cwd, "new.ts"), "one\ntwo\n");
    await until(() => events.some((event) => event.changedPaths?.includes("new.ts")));
    expect((await service.getSummary(cwd)).totalAdditions).toBe(2);
  } finally {
    service.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
