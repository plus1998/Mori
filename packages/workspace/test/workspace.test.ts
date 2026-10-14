import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type CommandRunner,
  createSessionPlan,
  createWorktreePlan,
  evaluateCommand,
  evaluateFileWrite,
  evaluateShellCommandText,
  GitWorktreeService,
  isInsidePath,
} from "../src";

/** 跨平台的工作区 fixture：POSIX 上是 `/repo`，Windows 上是 `<当前盘>:/repo`。 */
const REPO = path.resolve(path.parse(process.cwd()).root, "repo");

const TEST_GIT_IDENTITY_ARGS = [
  "-c",
  "user.name=Eco Coding Test",
  "-c",
  "user.email=eco-coding-test@localhost",
];

function createGitRunner(gitExecutable = "git"): CommandRunner {
  return {
    async run(command, cwd, options) {
      const executable = command[0] === "git" ? gitExecutable : command[0]!;
      try {
        const stdout = execFileSync(executable, command.slice(1), {
          cwd,
          encoding: "utf8",
          input: options?.stdin,
        });
        return { exitCode: 0, stdout, stderr: "" };
      } catch (error) {
        const failed = error as NodeJS.ErrnoException & {
          status?: number;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
        };
        return {
          exitCode: typeof failed.status === "number" ? failed.status : 1,
          stdout: String(failed.stdout ?? ""),
          stderr: String(failed.stderr ?? failed.message ?? ""),
        };
      }
    },
  };
}

test("requires approval for dangerous commands", () => {
  expect(
    evaluateCommand({
      command: ["rm", "-rf", "src"],
      cwd: REPO,
      workspacePath: REPO,
    }).action,
  ).toBe("ask");

  expect(
    evaluateCommand({
      command: ["git", "reset", "--hard"],
      cwd: REPO,
      workspacePath: REPO,
    }).riskLevel,
  ).toBe("high");

  expect(
    evaluateCommand({
      command: ["pnpm", "add", "react"],
      cwd: REPO,
      workspacePath: REPO,
    }).action,
  ).toBe("allow");
});

test("reviews external commands while writes keep their workspace policy", () => {
  expect(
    evaluateCommand({
      command: ["ls"],
      cwd: "/tmp",
      workspacePath: REPO,
    }).action,
  ).toBe("ask");

  expect(
    evaluateFileWrite({
      filePath: path.join(REPO, "src/index.ts"),
      workspacePath: REPO,
    }).action,
  ).toBe("allow");

  expect(
    evaluateFileWrite({
      filePath: "/etc/passwd",
      workspacePath: REPO,
    }).action,
  ).toBe("deny");
});

test("evaluates compound shell commands conservatively", () => {
  expect(
    evaluateShellCommandText({
      command: "echo ok && rm -rf src",
      cwd: REPO,
      workspacePath: REPO,
    }).action,
  ).toBe("ask");

  expect(
    evaluateShellCommandText({
      command: "NODE_ENV=test bun test | tee out.log",
      cwd: REPO,
      workspacePath: REPO,
    }).action,
  ).toBe("allow");
});

test("builds stable worktree plans", () => {
  const plan = createWorktreePlan(REPO, "thread:123");
  expect(plan.worktreePath).toBe(path.join(REPO, ".eco/worktrees/thread-123"));
  expect(plan.branchName).toBe("eco/thread-123");
});

test("createSessionPlan uses workspace path for direct editing", () => {
  const plan = createSessionPlan(REPO, "thread:123");
  expect(plan.worktreePath).toBe(REPO);
  expect(plan.workspacePath).toBe(REPO);
});

test("checks path containment safely", () => {
  expect(isInsidePath(path.join(REPO, "src/file.ts"), REPO)).toBe(true);
  expect(isInsidePath("/repo-other/file.ts", REPO)).toBe(false);
});

test("creates a git worktree through an injectable runner", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command) {
      calls.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const service = new GitWorktreeService(runner);
  await service.createWorktree(createWorktreePlan(REPO, "thr_1"));

  expect(calls).toEqual([
    ["git", "rev-parse", "--show-toplevel"],
    ["git", "rev-parse", "--verify", "HEAD"],
    ["git", "worktree", "add", "-B", "eco/thr_1", path.join(REPO, ".eco/worktrees/thr_1"), "HEAD"],
  ]);
});

test("createWorktree rejects repositories without commits", async () => {
  const runner: CommandRunner = {
    async run(command) {
      if (command[0] === "git" && command[1] === "rev-parse" && command[2] === "--verify") {
        return { exitCode: 1, stdout: "", stderr: "fatal: Needed a single revision" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const service = new GitWorktreeService(runner);
  await expect(service.createWorktree(createWorktreePlan(REPO, "thr_1"))).rejects.toThrow(
    "Git 仓库还没有任何提交",
  );
});

test("discards uncommitted worktree changes", async () => {
  const calls: Array<{ command: string[]; cwd: string }> = [];
  const runner: CommandRunner = {
    async run(command, cwd) {
      calls.push({ command, cwd });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const service = new GitWorktreeService(runner);
  const plan = createWorktreePlan(REPO, "thread:discard");

  await service.discardWorktreeChanges(plan);

  expect(calls).toEqual([
    { command: ["git", "reset", "--hard", "HEAD"], cwd: plan.worktreePath },
    { command: ["git", "clean", "-fd"], cwd: plan.worktreePath },
  ]);
});

test("removes a git worktree and its branch", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command) {
      calls.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const service = new GitWorktreeService(runner);
  await service.removeWorktree(createWorktreePlan(REPO, "thr_1"));

  expect(calls).toEqual([
    ["git", "rev-parse", "--show-toplevel"],
    ["git", "worktree", "remove", "--force", path.join(REPO, ".eco/worktrees/thr_1")],
    ["git", "branch", "-D", "eco/thr_1"],
  ]);
});

test("changedFiles falls back when merge-base diff fails", async () => {
  const plan = createWorktreePlan(REPO, "thr_diff_fallback");
  const runner: CommandRunner = {
    async run(command, cwd) {
      if (command[1] === "merge-base") {
        return { exitCode: 0, stdout: "deadbeef\n", stderr: "" };
      }
      if (command[1] === "diff" && command.includes("--name-only") && command.includes("deadbeef")) {
        return { exitCode: 1, stdout: "", stderr: "fatal: bad object deadbeef" };
      }
      if (command[1] === "diff" && command.includes("--name-only") && command.includes("HEAD")) {
        return { exitCode: 0, stdout: "src/fixed.ts\n", stderr: "" };
      }
      if (command[1] === "ls-files") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const service = new GitWorktreeService(runner);
  const files = await service.changedFiles(plan);
  expect(files).toEqual(["src/fixed.ts"]);
});

test("applies approved worktree diffs back to the target workspace", async () => {
  const plan = createWorktreePlan(REPO, "thr_1");
  const calls: Array<{ command: string[]; cwd: string; stdin?: string }> = [];
  const runner: CommandRunner = {
    async run(command, cwd, options) {
      calls.push({ command, cwd, stdin: options?.stdin });
      if (command[1] === "merge-base") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      if (command[1] === "diff" && command.includes("--binary")) {
        return { exitCode: 0, stdout: "diff --git a/a.ts b/a.ts\n", stderr: "" };
      }
      if (command[1] === "diff" && command.includes("--name-only")) {
        return { exitCode: 0, stdout: "a.ts\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const service = new GitWorktreeService(runner);
  await service.applyApprovedDiff(plan);

  expect(calls).toEqual([
    {
      command: ["git", "add", "-A"],
      cwd: path.join(REPO, ".eco/worktrees/thr_1"),
      stdin: undefined,
    },
    {
      command: ["git", "merge-base", "HEAD", plan.branchName],
      cwd: REPO,
      stdin: undefined,
    },
    {
      command: ["git", "diff", "--name-only", "abc123"],
      cwd: path.join(REPO, ".eco/worktrees/thr_1"),
      stdin: undefined,
    },
    {
      command: ["git", "diff", "--binary", "abc123"],
      cwd: path.join(REPO, ".eco/worktrees/thr_1"),
      stdin: undefined,
    },
  ]);
  expect(calls.some((call) => call.command[1] === "apply")).toBe(false);
});

test("applyApprovedDiff materializes files when workspace drifted from merge-base", async () => {
  const fixturesRoot = path.join(import.meta.dir, ".git-fixtures");
  await fs.mkdir(fixturesRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(fixturesRoot, "apply-"));
  const runner = createGitRunner();
  const service = new GitWorktreeService(runner);
  const plan = createWorktreePlan(root, "thr_drift");

  execFileSync("git", ["init", "-b", "main"], {
    cwd: root,
    env: { ...process.env, GIT_TEMPLATE_DIR: "" },
  });
  await fs.writeFile(path.join(root, "preload.js"), "base\n");
  execFileSync("git", ["add", "preload.js"], { cwd: root });
  execFileSync("git", [...TEST_GIT_IDENTITY_ARGS, "commit", "-m", "seed"], { cwd: root });

  await service.createWorktree(plan);
  await fs.writeFile(path.join(plan.worktreePath, "preload.js"), "worktree-final\n");
  await fs.writeFile(path.join(root, "preload.js"), "main-drift\n");

  await service.applyApprovedDiff(plan);

  expect(await fs.readFile(path.join(root, "preload.js"), "utf8")).toBe("worktree-final\n");
});

test("changedFiles includes untracked new files without staging", async () => {
  const plan = createWorktreePlan(REPO, "thr_status");
  const calls: Array<{ command: string[]; cwd: string }> = [];
  const runner: CommandRunner = {
    async run(command, cwd) {
      calls.push({ command, cwd });
      if (command[1] === "merge-base") {
        return { exitCode: 0, stdout: "base123\n", stderr: "" };
      }
      if (command[1] === "diff" && command.includes("--name-only")) {
        return { exitCode: 0, stdout: "existing.ts\n", stderr: "" };
      }
      if (command[1] === "ls-files") {
        return { exitCode: 0, stdout: "src/new.ts\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const service = new GitWorktreeService(runner);
  const files = await service.changedFiles(plan);

  expect(files).toEqual(["existing.ts", "src/new.ts"]);
  expect(calls.some((call) => call.command[1] === "add")).toBe(false);
});

test("collectWorktreeChanges stages untracked files before diffing", async () => {
  const plan = createWorktreePlan(REPO, "thr_new");
  const calls: Array<{ command: string[]; cwd: string }> = [];
  const runner: CommandRunner = {
    async run(command, cwd) {
      calls.push({ command, cwd });
      if (command[1] === "merge-base") {
        return { exitCode: 0, stdout: "base123\n", stderr: "" };
      }
      if (command[1] === "diff" && command.includes("--name-only")) {
        return { exitCode: 0, stdout: "src/new.ts\n", stderr: "" };
      }
      if (command[1] === "diff" && command.includes("--binary")) {
        return {
          exitCode: 0,
          stdout: "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const service = new GitWorktreeService(runner);
  const { files, diff } = await service.collectWorktreeChanges(plan);

  expect(files).toEqual(["src/new.ts"]);
  expect(diff).toContain("new file mode 100644");
  expect(calls[0]).toEqual({
    command: ["git", "add", "-A"],
    cwd: plan.worktreePath,
  });
});

test("collectWorktreeChanges does not stage direct workspace plans", async () => {
  const plan = createSessionPlan(REPO, "thr_direct");
  const calls: Array<{ command: string[]; cwd: string }> = [];
  const runner: CommandRunner = {
    async run(command, cwd) {
      calls.push({ command, cwd });
      if (command[1] === "merge-base") {
        return { exitCode: 0, stdout: "base123\n", stderr: "" };
      }
      if (command[1] === "diff" && command.includes("--name-only")) {
        return { exitCode: 0, stdout: "src/direct.ts\n", stderr: "" };
      }
      if (command[1] === "diff" && command.includes("--binary")) {
        return {
          exitCode: 0,
          stdout: "diff --git a/src/direct.ts b/src/direct.ts\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const service = new GitWorktreeService(runner);
  const { files, diff } = await service.collectWorktreeChanges(plan);

  expect(files).toEqual(["src/direct.ts"]);
  expect(diff).toContain("src/direct.ts");
  expect(calls.some((call) => call.command.join(" ") === "git add -A")).toBe(false);
});

test("discardWorktreeChanges no-ops for direct workspace plans", async () => {
  const plan = createSessionPlan(REPO, "thr_direct");
  const calls: Array<{ command: string[]; cwd: string }> = [];
  const runner: CommandRunner = {
    async run(command, cwd) {
      calls.push({ command, cwd });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const service = new GitWorktreeService(runner);
  await service.discardWorktreeChanges(plan);

  expect(calls).toEqual([]);
});
