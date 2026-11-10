import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MultiAgentsService } from "../src/main/multi-agents-service";
import { MultiAgentsWorkspace } from "../src/main/multi-agents-workspace";
import { groupSidebarThreads } from "../src/renderer/multi-agents-sidebar";
import type { ThreadSummary } from "../src/shared/ipc";
import {
  type MultiAgentsConfig,
  type MultiAgentsTaskInput,
  validateMultiAgentsTasks,
} from "../src/shared/multi-agents";
import { parseThreadApprovePlanPayload } from "../src/shared/plan-approval";
import { normalizeThreadRuntimeConfig } from "../src/shared/thread-runtime-config";

const dirs: string[] = [],
  services: MultiAgentsService[] = [];
afterEach(async () => {
  services.splice(0).forEach((service) => service.close());
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
async function repo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-multi-agents-test-"));
  dirs.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@localhost");
  await fs.writeFile(path.join(dir, "base.txt"), "original\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
  return dir;
}
const config = (): MultiAgentsConfig => ({
  id: "pair",
  name: "双 Codex",
  mode: "sessions",
  maxConcurrency: 2,
  agentKeys: [],
  members: ["a", "b"].map((id) => ({
    id,
    name: `Coder ${id}`,
    responsibility: `负责 ${id}`,
    coreKind: "codex",
    runtimeConfig: normalizeThreadRuntimeConfig({
      orchestrationSelection: {
        mainModel: { providerId: "openai", modelId: "gpt-test", accountId: `account-${id}` },
        mainPrompt: { mode: "builtin" },
        subagents: { mode: "none" },
      },
      sessionMode: "agent",
    }),
  })),
});
const task = (id: string, memberId = "a", dependsOn: string[] = []): MultiAgentsTaskInput => ({
  id,
  memberId,
  dependsOn,
  title: id,
  instructions: `implement ${id}`,
  scope: [`${id}.txt`],
  acceptance: `test ${id}`,
});
const thread = (id: string, workspacePath: string): ThreadSummary => ({
  id,
  workspacePath,
  title: id,
  prompt: "implement",
  coreKind: "codex",
  status: "idle",
  message: "",
  createdAt: "2026-11-10T00:00:00Z",
  updatedAt: "2026-11-10T00:00:00Z",
});

test("task validation rejects spoofed members, duplicate ids, absent dependencies and cycles", () => {
  expect(() =>
    validateMultiAgentsTasks([{ ...task("x"), threadId: "another-user-thread" } as any], config()),
  ).toThrow("不能指定会话");
  expect(() => validateMultiAgentsTasks([task("x", "unknown")], config())).toThrow("未知成员");
  expect(() => validateMultiAgentsTasks([task("x"), task("x")], config())).toThrow("唯一");
  expect(() => validateMultiAgentsTasks([task("x", "a", ["absent"])], config())).toThrow("不存在");
  expect(() => validateMultiAgentsTasks([task("x", "a", ["y"]), task("y", "b", ["x"])], config())).toThrow(
    "成环",
  );
  validateMultiAgentsTasks([task("x"), task("y", "b", ["x"])], config());
});

test("snapshot includes staged, unstaged and untracked changes without touching the user's branch or index", async () => {
  const dir = await repo(),
    workspace = new MultiAgentsWorkspace();
  await fs.writeFile(path.join(dir, "staged.txt"), "staged\n");
  git(dir, "add", ".");
  await fs.writeFile(path.join(dir, "base.txt"), "changed\n");
  await fs.writeFile(path.join(dir, "untracked.txt"), "untracked\n");
  const head = git(dir, "rev-parse", "HEAD"),
    index = git(dir, "write-tree"),
    status = git(dir, "status", "--porcelain");
  const baseline = await workspace.capture(dir);
  expect(git(dir, "show", `${baseline}:base.txt`)).toBe("changed");
  expect(git(dir, "show", `${baseline}:untracked.txt`)).toBe("untracked");
  expect(git(dir, "show", `${baseline}:staged.txt`)).toBe("staged");
  expect(git(dir, "rev-parse", "HEAD")).toBe(head);
  expect(git(dir, "write-tree")).toBe(index);
  expect(git(dir, "status", "--porcelain")).toBe(status);
  const child = path.join(dir, "..", `${path.basename(dir)}-child`);
  dirs.push(child);
  git(dir, "worktree", "add", "-b", "member-a", child, head);
  await workspace.seed(child, baseline);
  await fs.writeFile(path.join(child, "result.txt"), "member result\n");
  const result = await workspace.capture(child);
  await workspace.integrate(dir, baseline, result);
  await workspace.integrate(dir, baseline, result);
  expect(await fs.readFile(path.join(dir, "result.txt"), "utf8")).toBe("member result\n");
  expect(git(dir, "write-tree")).toBe(index);
  // A conflict must preserve the parent's edits.
  await fs.writeFile(path.join(child, "base.txt"), "child\n");
  const conflict = await workspace.capture(child);
  await fs.writeFile(path.join(dir, "base.txt"), "parent\n");
  await expect(workspace.integrate(dir, baseline, conflict)).rejects.toThrow();
  expect(await fs.readFile(path.join(dir, "base.txt"), "utf8")).toBe("parent\n");
});

async function setup() {
  const dir = await repo();
  // Put database outside the repository so it is never included in a snapshot.
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-multi-agents-db-"));
  dirs.push(dbDir);
  const database = path.join(dbDir, "runs.sqlite");
  const threads = new Map<string, ThreadSummary>([["main", thread("main", dir)]]);
  const started: { id: string; accountId: string | undefined }[] = [],
    resumed: { id: string; key: string }[] = [],
    cancelled: string[] = [];
  let notifyFails = false;
  const workspace = new MultiAgentsWorkspace();
  const host = {
    latestAttempt: (id: string) => ({
      attemptId: `${id}:attempt`,
      status:
        threads.get(id)?.status === "running"
          ? "running"
          : threads.get(id)?.status === "failed"
            ? "failed"
            : "completed",
    }),
    thread: (id: string) => threads.get(id),
    busy: () => false,
    changed: () => {},
    validateMember: () => {},
    start: async (request: any, id: string, title: string, baseline: string) => {
      const child = path.join(dbDir, id);
      git(dir, "worktree", "add", "-b", id, child, "HEAD");
      await workspace.seed(child, baseline);
      const item = {
        ...thread(id, dir),
        title,
        status: "running" as const,
        workLocation: { mode: "isolated" as const, worktree: { worktreePath: child } as any },
      };
      threads.set(id, item);
      started.push({ id, accountId: request.runtimeConfig.orchestrationSelection.mainModel.accountId });
    },
    resume: async (id: string, _prompt: string, key: string) => {
      if (id === "main" && notifyFails) throw new Error("offline");
      resumed.push({ id, key });
      if (id !== "main") threads.get(id)!.status = "running";
    },
    cancel: async (id: string) => {
      cancelled.push(id);
      const item = threads.get(id);
      if (item) item.status = "idle";
    },
  };
  const service = new MultiAgentsService(new DatabaseSync(database), host);
  services.push(service);
  service.saveConfig(config());
  const plan = {
    referenceId: "plan-1",
    version: 1,
    threadId: "main",
    workspacePath: dir,
    worktreePath: dir,
    userPrompt: "build",
    analysis: "analysis",
    plan: "Build A and B",
  };
  await service.prepare("run-1", "main", "pair", plan, dir);
  const finish = async (taskId: string, content = `${taskId} result\n`) => {
    const current = service.runs()[0]!.tasks.find((task) => task.id === taskId)!;
    const item = threads.get(current.threadId!)!;
    await fs.writeFile(path.join(item.workLocation!.worktree!.worktreePath, `${taskId}.txt`), content);
    await service.tool(item.id, "multi_agents_report", { result: `${taskId} tested` });
    item.status = "idle";
  };
  return {
    dir,
    database,
    host,
    threads,
    started,
    resumed,
    cancelled,
    service,
    plan,
    finish,
    setNotifyFails: (value: boolean) => {
      notifyFails = value;
    },
  };
}

test("independent accounts, bounded concurrency, dependency snapshots, result wake-up and explicit acceptance", async () => {
  const { service, started, resumed, finish, dir, threads } = await setup();
  await service.tool("main", "multi_agents_submit_tasks", {
    tasks: [task("x"), task("y", "b"), task("z", "a", ["x", "y"])],
  });
  await service.tick();
  expect(started.map((item) => item.accountId)).toEqual(["account-a", "account-b"]);
  await expect(service.tool("main", "multi_agents_accept", { review: "looks good" })).rejects.toThrow(
    "未完成",
  );
  await finish("x");
  await finish("y");
  await service.tick();
  const z = service.runs()[0]!.tasks.find((task) => task.id === "z")!;
  const zPath = threads.get(z.threadId!)!.workLocation!.worktree!.worktreePath;
  expect(await fs.readFile(path.join(zPath, "x.txt"), "utf8")).toBe("x result\n");
  expect(await fs.readFile(path.join(zPath, "y.txt"), "utf8")).toBe("y result\n");
  await finish("z");
  await service.tick();
  expect(service.runs()[0]!.status).toBe("awaiting_review");
  expect(resumed.filter((item) => item.id === "main")).toHaveLength(1);
  await service.tick();
  expect(resumed.filter((item) => item.id === "main")).toHaveLength(1);
  await expect(service.tool("main", "multi_agents_integrate", { taskId: "z" })).rejects.toThrow("先整合依赖");
  for (const taskId of ["x", "y", "z"]) await service.tool("main", "multi_agents_integrate", { taskId });
  expect(await fs.readFile(path.join(dir, "z.txt"), "utf8")).toBe("z result\n");
  await service.tool("main", "multi_agents_accept", { review: "Reviewed all changes; task tests passed." });
  expect(service.runs()[0]!.status).toBe("completed");
});

test("failed member blocks dependencies; rework reuses the same conversation and restores downstream scheduling", async () => {
  const { service, started, threads, resumed, finish } = await setup();
  await service.tool("main", "multi_agents_submit_tasks", { tasks: [task("x"), task("y", "b", ["x"])] });
  await service.tick();
  const childId = started[0]!.id;
  threads.get(childId)!.status = "failed";
  threads.get(childId)!.message = "test failed";
  await service.tick();
  expect(service.runs()[0]!.tasks.map((task) => task.status)).toEqual(["failed", "blocked"]);
  await service.tool("main", "multi_agents_retry", { taskId: "x", instructions: "fix the failure" });
  await service.tick();
  expect(started).toHaveLength(1);
  expect(resumed.some((item) => item.id === childId)).toBe(true);
  await finish("x");
  await service.tick();
  expect(started).toHaveLength(2);
  expect(service.runs()[0]!.tasks[1]!.status).toBe("running");
});

test("a preparation failure before conversation creation can be retried without resuming a nonexistent session", async () => {
  const { service, host, started, finish } = await setup();
  const start = host.start;
  host.start = async () => {
    throw new Error("Codex CLI unavailable");
  };
  await service.tool("main", "multi_agents_submit_tasks", { tasks: [task("x")] });
  await service.tick();
  expect(service.runs()[0]!.tasks[0]!.status).toBe("failed");
  expect(service.runs()[0]!.tasks[0]!.error).toContain("Codex CLI unavailable");
  expect(service.runs()[0]!.tasks[0]!.threadId).toBeUndefined();
  host.start = start;
  await service.tool("main", "multi_agents_retry", {
    taskId: "x",
    instructions: "CLI installed; run the task",
  });
  await service.tick();
  expect(started).toHaveLength(1);
  await finish("x");
  await service.tick();
  expect(service.runs()[0]!.tasks[0]!.status).toBe("succeeded");
});

test("pause prevents new dispatch, stop cancels children, and result delivery survives a transient failure", async () => {
  const { service, started, finish, setNotifyFails, resumed, cancelled } = await setup();
  await service.tool("main", "multi_agents_submit_tasks", { tasks: [task("x"), task("y", "a")] });
  await service.control("run-1", "pause");
  await service.tick();
  expect(started).toHaveLength(0);
  await service.control("run-1", "resume");
  await service.tick();
  expect(started).toHaveLength(1);
  await finish("x");
  await service.tick();
  expect(started).toHaveLength(2);
  await finish("y");
  setNotifyFails(true);
  await service.tick();
  expect(service.runs()[0]!.pendingNotification).toBeDefined();
  setNotifyFails(false);
  await service.tick();
  expect(service.runs()[0]!.pendingNotification).toBeUndefined();
  expect(resumed.filter((item) => item.key.includes(":results:"))).toHaveLength(1);
  await service.control("run-1", "stop");
  expect(cancelled).toContain("main");
  expect(service.runs()[0]!.status).toBe("cancelled");
});

test("restart preserves identities and never silently restarts uncertain member executions", async () => {
  const { service, database, host, started } = await setup();
  await service.tool("main", "multi_agents_submit_tasks", { tasks: [task("x")] });
  await service.tick();
  const id = started[0]!.id;
  const reopened = new MultiAgentsService(new DatabaseSync(database), host);
  services.push(reopened);
  expect(reopened.runs()[0]!.status).toBe("interrupted");
  expect(reopened.runs()[0]!.tasks[0]).toMatchObject({ threadId: id, status: "failed" });
  await reopened.tick();
  expect(started).toHaveLength(1);
});

test("a cancelled runtime cannot become success merely because it reported a result earlier", async () => {
  const { service, host, finish } = await setup();
  await service.tool("main", "multi_agents_submit_tasks", { tasks: [task("x")] });
  await service.tick();
  await finish("x");
  host.latestAttempt = (id) => ({ attemptId: `${id}:attempt`, status: "cancelled" });
  await service.tick();
  expect(service.runs()[0]!.tasks[0]!.status).toBe("failed");
});

test("rework preserves attempts, reuses member conversations and invalidates downstream results", async () => {
  const { service, finish, started, dir, threads } = await setup();
  await service.tool("main", "multi_agents_submit_tasks", { tasks: [task("x"), task("y", "b", ["x"])] });
  await service.tick();
  await finish("x");
  await service.tick();
  await finish("y");
  await service.tick();
  await service.tool("main", "multi_agents_integrate", { taskId: "x" });
  await service.tool("main", "multi_agents_integrate", { taskId: "y" });
  await service.tool("main", "multi_agents_retry", { taskId: "x", instructions: "fix x after integration" });
  expect(service.runs()[0]!.tasks.map((task) => task.status)).toEqual(["queued", "queued"]);
  await service.tick();
  await finish("x", "x revised\n");
  await service.tick();
  const y = service.runs()[0]!.tasks[1]!;
  expect(
    await fs.readFile(
      path.join(threads.get(y.threadId!)!.workLocation!.worktree!.worktreePath, "x.txt"),
      "utf8",
    ),
  ).toBe("x revised\n");
  await finish("y", "y revised\n");
  await service.tick();
  expect(started).toHaveLength(2);
  expect(service.runs()[0]!.tasks.map((task) => task.history?.length)).toEqual([1, 1]);
  await service.tool("main", "multi_agents_integrate", { taskId: "x" });
  await expect(service.tool("main", "multi_agents_integrate", { taskId: "y" })).rejects.toThrow("整合冲突");
  expect(await fs.readFile(path.join(dir, "y.txt"), "utf8")).toBe("y result\n");
  await fs.writeFile(path.join(dir, "y.txt"), "y revised\n");
  await service.tool("main", "multi_agents_resolve_integration", {
    taskId: "y",
    review: "Resolved dependency overlap; checked x and y revisions.",
  });
  await service.tool("main", "multi_agents_accept", { review: "Both revisions tested." });
  expect(service.runs()[0]!.status).toBe("completed");
});

test("native configurations discard irrelevant unfinished session drafts", async () => {
  const { service } = await setup();
  const native = service.saveConfig({
    ...config(),
    mode: "subagents",
    agentKeys: ["coder", "reviewer"],
    members: [{ id: "unfinished" } as any],
  });
  expect(native.members).toEqual([]);
  expect(native.agentKeys).toEqual(["coder", "reviewer"]);
});

test("plan approval parses stable Multi-Agents configuration id and extra instructions", () => {
  const request = {
    principalId: "desktop",
    clientCommandId: "approve",
    threadId: "main",
    expectedHistoryRevision: 1,
    executionTarget: { kind: "multi_agents", configId: " pair ", additionalMessage: "test first" },
  };
  expect(parseThreadApprovePlanPayload(request).executionTarget).toEqual({
    kind: "multi_agents",
    configId: "pair",
    additionalMessage: "test first",
  });
  expect(() =>
    parseThreadApprovePlanPayload({ ...request, executionTarget: { kind: "multi_agents" } }),
  ).toThrow("请选择");
});

test("sidebar replaces a busy child list position with its expandable source and avoids duplicates", () => {
  const main = thread("main", "/workspace"),
    a = thread("a", "/workspace"),
    b = thread("b", "/workspace"),
    other = thread("other", "/workspace");
  const groups = [{ source: main, children: [a, b] }];
  expect(
    groupSidebarThreads([a, main, other], [a, main, b, other], groups, new Set()).map((row) => row.thread.id),
  ).toEqual(["main", "other"]);
  expect(
    groupSidebarThreads([a, main, other], [a, main, b, other], groups, new Set(["main"])).map((row) => [
      row.thread.id,
      row.depth,
    ]),
  ).toEqual([
    ["main", 0],
    ["a", 1],
    ["b", 1],
    ["other", 0],
  ]);
});
