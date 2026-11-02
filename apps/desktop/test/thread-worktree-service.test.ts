import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandRunner } from "@eco/workspace";
import { ConversationStore } from "../src/main/conversation-store";
import { ThreadWorktreeService } from "../src/main/thread-worktree-service";
import type { ThreadSummary } from "../src/shared/ipc";

const exec = promisify(execFile);
const roots: string[] = [];
const databases: DatabaseSync[] = [];
async function openStore(filename: string) {
  const db = new DatabaseSync(filename);
  databases.push(db);
  const store = new ConversationStore(db, { freshStorageMode: "v2_only", requiredStorageMode: "v2_only" });
  store.initialize();
  return { store, db };
}
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const calls: string[][] = [];
const runner: CommandRunner = {
  async run(command, cwd) {
    calls.push(command);
    try {
      const { stdout, stderr } = await exec(command[0]!, command.slice(1), {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 128,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? String(error),
      };
    }
  },
};
async function git(cwd: string, ...args: string[]) {
  const result = await runner.run(["git", ...args], cwd);
  if (result.exitCode) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function fixture(
  options: {
    commits?: boolean;
    init?: boolean;
    coreKind?: ThreadSummary["coreKind"];
    workspaceSubdir?: string;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-worktree-"));
  roots.push(root);
  const repo = path.join(root, "project");
  await fs.mkdir(repo);
  if (options.init !== false) {
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Mori Test");
    await git(repo, "config", "user.email", "mori@example.test");
    if (options.commits !== false) {
      await fs.writeFile(path.join(repo, "file.txt"), "base\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "base");
    }
  }
  const workspacePath = options.workspaceSubdir ? path.join(repo, options.workspaceSubdir) : repo;
  if (options.workspaceSubdir) await fs.mkdir(workspacePath, { recursive: true });
  const dbPath = path.join(root, "conversation.sqlite");
  const { store, db } = await openStore(dbPath);
  const now = new Date().toISOString();
  const thread: ThreadSummary = {
    id: "thr_test",
    title: "Worktree",
    prompt: "implement",
    workspacePath,
    coreKind: options.coreKind ?? "claude",
    status: "idle",
    message: "",
    createdAt: now,
    updatedAt: now,
  };
  store.saveThread(thread);
  return { root, repo, store, db, thread, dbPath, service: new ThreadWorktreeService(store, runner) };
}
async function commitEdit(cwd: string, name = "change.txt") {
  await fs.writeFile(path.join(cwd, name), "changed\n");
  await git(cwd, "add", name);
  await git(cwd, "commit", "-m", name);
}

test("isolated creation starts at project HEAD without dirty files; records survive restart", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.repo, "file.txt"), "dirty\n");
  await fs.writeFile(path.join(f.repo, "untracked.txt"), "local\n");
  const status = await f.service.create(f.thread.id);
  expect(status.error).toBeUndefined();
  expect(status.exists).toBe(true);
  const record = status.location!.worktree!;
  expect(record.targetBranch).toBe("main");
  expect(await fs.readFile(path.join(record.worktreePath, "file.txt"), "utf8")).toBe("base\n");
  expect(await fs.exists(path.join(record.worktreePath, "untracked.txt"))).toBe(false);
  expect(await git(record.worktreePath, "rev-parse", "HEAD")).toBe(record.baseCommit);
  f.db.close();
  databases.splice(databases.indexOf(f.db), 1);
  const { store: reopened } = await openStore(f.dbPath);
  const restored = await new ThreadWorktreeService(reopened, runner).resolve(f.thread.id);
  expect(restored.cwd).toBe(record.worktreePath);
  expect(reopened.listThreadWorktrees(f.thread.id)).toHaveLength(1);
  expect(reopened.getThread(f.thread.id)?.workLocation?.worktree?.branchName).toBe(record.branchName);
});

test("opening a repository subdirectory places worktrees beside the repository root", async () => {
  const f = await fixture({ workspaceSubdir: path.join("packages", "app") });
  const status = await f.service.create(f.thread.id);
  const record = status.location!.worktree!;
  const worktreeParent = await fs.realpath(path.dirname(f.repo));
  expect(path.relative(worktreeParent, record.worktreePath)).toMatch(
    new RegExp(`^\\.mori-worktrees${path.sep.replace("\\", "\\\\")}`),
  );
  expect(record.worktreePath.startsWith(path.join(f.repo, ".mori-worktrees"))).toBe(false);
  expect(await fs.exists(path.join(f.repo, ".mori-worktrees"))).toBe(false);
  expect(await fs.exists(path.join(record.worktreePath, "file.txt"))).toBe(true);
});

test("normal merge is proven against pinned target branch and cleanup keeps conversation", async () => {
  const f = await fixture();
  const created = await f.service.create(f.thread.id);
  const record = created.location!.worktree!;
  await commitEdit(record.worktreePath);
  expect((await f.service.status(f.thread.id)).merged).toBe("unmerged");
  await git(f.repo, "merge", "--no-ff", record.branchName, "-m", "merge");
  await git(f.repo, "checkout", "-b", "another");
  expect((await f.service.status(f.thread.id)).merged).toBe("git");
  f.store.conversationV2().sendMessage({
    principalId: "test",
    conversationId: f.thread.id,
    clientCommandId: "send",
    messageId: "m1",
    text: "saved history",
  });
  const cleaned = await f.service.cleanup({ threadId: f.thread.id, worktreeId: record.id });
  expect(cleaned.location?.worktree?.state).toBe("removed");
  expect(cleaned.location?.mode).toBe("needs_choice");
  expect(cleaned.branchExists).toBe(false);
  expect(f.store.conversationV2().getMessage(f.thread.id, "m1")?.body).toBe("saved history");
  await expect(f.service.resolve(f.thread.id)).rejects.toThrow("请先选择");
  await f.service.selectLocation({ threadId: f.thread.id, choice: "project", worktreeId: record.id });
  expect((await f.service.resolve(f.thread.id)).cwd).toBe(f.repo);
});

test("squash merge requires explicit confirmation; new branch commits revoke it", async () => {
  const f = await fixture();
  const record = (await f.service.create(f.thread.id)).location!.worktree!;
  await commitEdit(record.worktreePath);
  await git(f.repo, "merge", "--squash", record.branchName);
  await git(f.repo, "commit", "-m", "squash");
  expect((await f.service.status(f.thread.id)).canClean).toBe(false);
  const request = { threadId: f.thread.id, worktreeId: record.id };
  const observed = await f.service.status(f.thread.id);
  const confirmRequest = {
    ...request,
    expectedBranchCommit: observed.branchCommit!,
    expectedTargetCommit: observed.targetCommit!,
  };
  expect((await f.service.confirmMerged(confirmRequest)).merged).toBe("confirmed");
  await commitEdit(record.worktreePath, "next.txt");
  expect((await f.service.status(f.thread.id)).merged).toBe("unmerged");
  await expect(f.service.confirmMerged(confirmRequest)).rejects.toThrow("已变化");
  const nextTip = await f.service.status(f.thread.id);
  await f.service.confirmMerged({
    ...request,
    expectedBranchCommit: nextTip.branchCommit!,
    expectedTargetCommit: nextTip.targetCommit!,
  });
  const offset = calls.length;
  expect((await f.service.cleanup(request)).location?.worktree?.state).toBe("removed");
  expect(calls.slice(offset).some((args) => args.includes("--force") || args.includes("-D"))).toBe(false);
});

test("tracked, untracked and ignored files block cleanup without staging or changing files", async () => {
  const f = await fixture();
  const record = (await f.service.create(f.thread.id)).location!.worktree!;
  await fs.writeFile(path.join(record.worktreePath, "file.txt"), "dirty");
  await fs.writeFile(path.join(record.worktreePath, "loose.txt"), "loose");
  await fs.writeFile(path.join(record.worktreePath, ".gitignore"), "deps/\n");
  await fs.mkdir(path.join(record.worktreePath, "deps"));
  await fs.writeFile(path.join(record.worktreePath, "deps", "asset"), "keep");
  const before = await git(record.worktreePath, "diff", "--cached");
  const status = await f.service.status(f.thread.id);
  expect(status.canClean).toBe(false);
  expect(status.changedFiles).toContain("file.txt");
  expect(status.changedFiles).toContain("loose.txt");
  expect(status.changedFiles).not.toContain("deps/");
  await expect(f.service.cleanup({ threadId: f.thread.id, worktreeId: record.id })).rejects.toThrow(
    "loose.txt",
  );
  expect(await fs.readFile(path.join(record.worktreePath, "file.txt"), "utf8")).toBe("dirty");
  expect(await git(record.worktreePath, "diff", "--cached")).toBe(before);
  expect(f.store.getThread(f.thread.id)?.workLocation?.worktree?.error).toContain("loose.txt");
});

test("ignored dependency files do not block cleanup after the branch is merged", async () => {
  const f = await fixture();
  const record = (await f.service.create(f.thread.id)).location!.worktree!;
  await fs.writeFile(path.join(record.worktreePath, ".gitignore"), "node_modules/\n");
  await fs.mkdir(path.join(record.worktreePath, "node_modules", "dependency"), { recursive: true });
  await fs.writeFile(path.join(record.worktreePath, "node_modules", "dependency", "index.js"), "module\n");
  await git(record.worktreePath, "add", ".gitignore");
  await git(record.worktreePath, "commit", "-m", "ignore dependencies");
  await git(f.repo, "merge", "--no-ff", record.branchName, "-m", "merge");
  const status = await f.service.status(f.thread.id);
  expect(status.changedFiles).toEqual([]);
  expect(status.canClean).toBe(true);
  expect((await f.service.cleanup({ threadId: f.thread.id, worktreeId: record.id })).location?.mode).toBe(
    "needs_choice",
  );
});

test("Agent removal requires explicit location choice, can reattach unmerged branch, then create another generation", async () => {
  const f = await fixture();
  const record = (await f.service.create(f.thread.id)).location!.worktree!;
  await commitEdit(record.worktreePath);
  await git(f.repo, "worktree", "remove", record.worktreePath);
  const missing = await f.service.status(f.thread.id);
  expect(missing.location?.worktree?.state).toBe("missing");
  expect(missing.location?.mode).toBe("needs_choice");
  expect(missing.canReattach).toBe(true);
  const attached = await f.service.selectLocation({
    threadId: f.thread.id,
    choice: "reattach",
    worktreeId: record.id,
  });
  expect(attached.exists).toBe(true);
  expect(attached.location?.mode).toBe("isolated");
  expect((await f.service.resolve(f.thread.id)).cwd).toBe(record.worktreePath);
  await git(f.repo, "worktree", "remove", record.worktreePath);
  await f.service.status(f.thread.id);
  const next = await f.service.selectLocation({
    threadId: f.thread.id,
    choice: "new_worktree",
    worktreeId: record.id,
  });
  expect(next.exists).toBe(true);
  expect(next.location?.worktree?.id).not.toBe(record.id);
  expect(f.store.listThreadWorktrees(f.thread.id)).toHaveLength(2);
  expect(await git(f.repo, "rev-parse", `refs/heads/${record.branchName}`)).toBeTruthy();
  await expect(f.service.cleanup({ threadId: f.thread.id, worktreeId: record.id })).rejects.toThrow("已变化");
});

for (const invalid of ["non-git", "unborn", "detached"] as const)
  test(`creation rejects ${invalid} with durable diagnostic and never starts in project directory`, async () => {
    const f = await fixture({ init: invalid !== "non-git", commits: invalid !== "unborn" });
    if (invalid === "detached") await git(f.repo, "checkout", "--detach");
    const status = await f.service.create(f.thread.id);
    expect(status.exists).toBe(false);
    expect(status.location?.mode).toBe("needs_choice");
    expect(f.store.listThreadWorktrees(f.thread.id)[0]?.error).toBeTruthy();
    await expect(f.service.resolve(f.thread.id)).rejects.toThrow("请先选择");
  });

test("mismatched branch and replacement path cannot be cleaned", async () => {
  const f = await fixture();
  const record = (await f.service.create(f.thread.id)).location!.worktree!;
  await git(record.worktreePath, "checkout", "-b", "someone-else");
  expect((await f.service.status(f.thread.id)).error).toContain("不匹配");
  await expect(f.service.cleanup({ threadId: f.thread.id, worktreeId: record.id })).rejects.toThrow("不匹配");
  expect(await fs.exists(record.worktreePath)).toBe(true);
  await git(f.repo, "worktree", "remove", record.worktreePath);
  await fs.mkdir(record.worktreePath);
  await fs.writeFile(path.join(record.worktreePath, "valuable"), "keep");
  expect((await f.service.status(f.thread.id)).canClean).toBe(false);
  expect(await fs.readFile(path.join(record.worktreePath, "valuable"), "utf8")).toBe("keep");
});

test("legacy conversations use project directory without requiring Git; deletion leaves worktree intact", async () => {
  const plain = await fixture({ init: false });
  expect((await plain.service.resolve(plain.thread.id)).cwd).toBe(plain.repo);
  const f = await fixture();
  const record = (await f.service.create(f.thread.id)).location!.worktree!;
  f.store.deleteThread(f.thread.id);
  expect(await fs.exists(record.worktreePath)).toBe(true);
  expect(f.store.listThreadWorktrees(f.thread.id)).toHaveLength(1);
});

for (const coreKind of ["claude", "codex", "pi", "acp"] as const)
  test(`${coreKind}: changing location clears old runtime binding but retains messages`, async () => {
    const f = await fixture({ coreKind });
    const record = (await f.service.create(f.thread.id)).location!.worktree!;
    if (coreKind === "claude") f.store.saveSdkSession(f.thread.id, "old-session", record.worktreePath);
    else
      f.store.saveThreadCoreSession({
        threadId: f.thread.id,
        coreKind,
        externalSessionId: "old-session",
        cwd: record.worktreePath,
      });
    f.store.conversationV2().sendMessage({
      principalId: "test",
      conversationId: f.thread.id,
      clientCommandId: "send",
      text: "keep this",
    });
    await git(f.repo, "worktree", "remove", record.worktreePath);
    await f.service.status(f.thread.id);
    await f.service.selectLocation({ threadId: f.thread.id, choice: "project", worktreeId: record.id });
    f.store.resetThreadRuntimeForWorkLocation(f.thread.id);
    expect(f.store.getSdkSession(f.thread.id)).toBeUndefined();
    expect(f.store.getThreadCoreSession(f.thread.id)).toBeUndefined();
    expect(f.store.getThread(f.thread.id)?.workLocation?.contextResetPending).toBe(true);
    f.store.saveThreadCoreSession({
      threadId: f.thread.id,
      coreKind,
      externalSessionId: "new-session",
      cwd: f.repo,
    });
    expect(f.store.getThread(f.thread.id)?.workLocation?.contextResetPending).toBeUndefined();
    expect(f.store.conversationV2().head(f.thread.id).lastSeq).toBeGreaterThan(0);
  });

test("missing directory with matching Git registration can reattach without pruning other records", async () => {
  const f = await fixture();
  const record = (await f.service.create(f.thread.id)).location!.worktree!;
  await commitEdit(record.worktreePath);
  await fs.rm(record.worktreePath, { recursive: true });
  expect((await f.service.status(f.thread.id)).canReattach).toBe(true);
  const result = await f.service.selectLocation({
    threadId: f.thread.id,
    worktreeId: record.id,
    choice: "reattach",
  });
  expect(result.exists).toBe(true);
  expect(await fs.readFile(path.join(record.worktreePath, "change.txt"), "utf8")).toBe("changed\n");
});

test("missing branch cannot be treated as cleanable or merged", async () => {
  const f = await fixture();
  const record = (await f.service.create(f.thread.id)).location!.worktree!;
  await git(f.repo, "worktree", "remove", record.worktreePath);
  await git(f.repo, "branch", "-D", record.branchName);
  const status = await f.service.status(f.thread.id);
  expect(status.error).toContain("分支不存在");
  expect(status.canClean).toBe(false);
  expect(status.merged).toBe("unmerged");
  expect(status.canReattach).toBe(false);
  await expect(f.service.cleanup({ threadId: f.thread.id, worktreeId: record.id })).rejects.toThrow("分支不存在");
});

test("cleanup command failure preserves exact record, branch, files and diagnostic", async () => {
  const f = await fixture();
  const record = (await f.service.create(f.thread.id)).location!.worktree!;
  const failing = new ThreadWorktreeService(f.store, {
    run: (args, cwd, options) =>
      args[1] === "worktree" && args[2] === "remove"
        ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "permission denied for test" })
        : runner.run(args, cwd, options),
  });
  await expect(failing.cleanup({ threadId: f.thread.id, worktreeId: record.id })).rejects.toThrow(
    "permission denied",
  );
  expect(await fs.exists(record.worktreePath)).toBe(true);
  expect(f.store.getThread(f.thread.id)?.workLocation?.worktree?.error).toContain("permission denied");
  expect(await git(f.repo, "rev-parse", `refs/heads/${record.branchName}`)).toBe(record.baseCommit);
});

test("overlapping status reads and runtime resolution serialize without failing a run", async () => {
  const f = await fixture();
  const created = await f.service.create(f.thread.id);
  const results = await Promise.all([
    f.service.status(f.thread.id),
    f.service.resolve(f.thread.id),
    f.service.status(f.thread.id),
  ]);
  expect(results[1].cwd).toBe(created.worktreePath);
  await expect(f.service.create(f.thread.id)).rejects.toThrow("活动工作树");
});
