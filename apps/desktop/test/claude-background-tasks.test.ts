import { expect, test } from "bun:test";
import {
  ClaudeBackgroundTaskRegistry,
  isClaudeBashTaskType,
} from "../src/main/claude-background-tasks";

test("recognizes Claude shell task type variants", () => {
  expect(isClaudeBashTaskType("local_bash")).toBe(true);
  expect(isClaudeBashTaskType("shell")).toBe(true);
  expect(isClaudeBashTaskType("Bash process")).toBe(true);
  expect(isClaudeBashTaskType("local_agent")).toBe(false);
});

test("tracks only live Claude Bash tasks and stops them through their Query", async () => {
  const registry = new ClaudeBackgroundTaskRegistry();
  const owner = {};
  const stopped: string[] = [];
  registry.replaceThread({
    threadId: "thr_1",
    workspacePath: "/workspace",
    owner,
    tasks: [
      {
        taskId: "bash_1",
        taskType: "local_bash",
        description: "bun run dev",
      },
      {
        taskId: "agent_1",
        taskType: "local_agent",
        description: "Explore code",
      },
    ],
    stopTask: async (taskId) => {
      stopped.push(taskId);
    },
    forceClose: () => {},
  });

  expect(registry.list("thr_1")).toEqual([
    {
      threadId: "thr_1",
      taskId: "bash_1",
      workspacePath: "/workspace",
      label: "bun run dev",
      status: "running",
      taskType: "local_bash",
    },
  ]);
  await expect(registry.stop("thr_1", "bash_1")).resolves.toEqual({
    stopped: true,
    mode: "task",
  });
  expect(stopped).toEqual(["bash_1"]);
  expect(registry.list()).toEqual([]);
});

test("level snapshots replace membership and stale Query owners cannot clear a new run", () => {
  const registry = new ClaudeBackgroundTaskRegistry();
  const firstOwner = {};
  const secondOwner = {};
  const noopStop = async () => {};
  const noopClose = () => {};
  registry.replaceThread({
    threadId: "thr_1",
    workspacePath: "/workspace",
    owner: firstOwner,
    tasks: [
      { taskId: "bash_old", taskType: "shell", description: "old" },
      { taskId: "bash_keep", taskType: "shell", description: "keep" },
    ],
    stopTask: noopStop,
    forceClose: noopClose,
  });
  registry.replaceThread({
    threadId: "thr_1",
    workspacePath: "/workspace",
    owner: firstOwner,
    tasks: [{ taskId: "bash_keep", taskType: "shell", description: "keep" }],
    stopTask: noopStop,
    forceClose: noopClose,
  });
  expect(registry.list("thr_1").map((task) => task.taskId)).toEqual(["bash_keep"]);

  registry.replaceThread({
    threadId: "thr_1",
    workspacePath: "/workspace",
    owner: secondOwner,
    tasks: [{ taskId: "bash_new", taskType: "shell", description: "new" }],
    stopTask: noopStop,
    forceClose: noopClose,
  });
  registry.clearThread("thr_1", firstOwner);
  expect(registry.list("thr_1").map((task) => task.taskId)).toEqual(["bash_new"]);
  registry.clearThread("thr_1", secondOwner);
  expect(registry.list("thr_1")).toEqual([]);
});

test("falls back to closing the owning Query when task stop does not settle", async () => {
  const registry = new ClaudeBackgroundTaskRegistry({ stopTaskTimeoutMs: 10 });
  let closed = false;
  registry.replaceThread({
    threadId: "thr_1",
    workspacePath: "/workspace",
    owner: {},
    tasks: [{ taskId: "bash_hung", taskType: "local_bash", description: "sleep 120" }],
    stopTask: async () => new Promise<void>(() => {}),
    forceClose: () => {
      closed = true;
    },
  });

  await expect(registry.stop("thr_1", "bash_hung")).resolves.toEqual({
    stopped: true,
    mode: "query",
  });
  expect(closed).toBe(true);
  expect(registry.list("thr_1")).toEqual([]);
});
