import { expect, test } from "bun:test";
import { ClaudeBackgroundTaskRegistry, isClaudeBashTaskType } from "../src/main/claude-background-tasks";

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
      registry.replaceThread({
        threadId: "thr_1",
        workspacePath: "/workspace",
        owner,
        tasks: [],
        stopTask: async () => {},
      });
    },
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
  registry.replaceThread({
    threadId: "thr_1",
    workspacePath: "/workspace",
    owner: firstOwner,
    tasks: [
      { taskId: "bash_old", taskType: "shell", description: "old" },
      { taskId: "bash_keep", taskType: "shell", description: "keep" },
    ],
    stopTask: noopStop,
  });
  registry.replaceThread({
    threadId: "thr_1",
    workspacePath: "/workspace",
    owner: firstOwner,
    tasks: [{ taskId: "bash_keep", taskType: "shell", description: "keep" }],
    stopTask: noopStop,
  });
  expect(registry.list("thr_1").map((task) => task.taskId)).toEqual(["bash_keep"]);

  registry.replaceThread({
    threadId: "thr_1",
    workspacePath: "/workspace",
    owner: secondOwner,
    tasks: [{ taskId: "bash_new", taskType: "shell", description: "new" }],
    stopTask: noopStop,
  });
  registry.clearThread("thr_1", firstOwner);
  expect(registry.list("thr_1").map((task) => task.taskId)).toEqual(["bash_new"]);
  registry.clearThread("thr_1", secondOwner);
  expect(registry.list("thr_1")).toEqual([]);
});

test("does not report success without a terminal event or close the owning Query", async () => {
  const registry = new ClaudeBackgroundTaskRegistry({ stopTaskTimeoutMs: 10 });
  registry.replaceThread({
    threadId: "thr_1",
    workspacePath: "/workspace",
    owner: {},
    tasks: [{ taskId: "bash_hung", taskType: "local_bash", description: "sleep 120" }],
    stopTask: async () => {},
  });
  await expect(registry.stop("thr_1", "bash_hung")).rejects.toThrow("timed out");
  expect(registry.list("thr_1")).toHaveLength(1);
});

test("keeps the task visible and surfaces SDK stop errors", async () => {
  const registry = new ClaudeBackgroundTaskRegistry();
  registry.replaceThread({
    threadId: "thr_1",
    workspacePath: "/workspace",
    owner: {},
    tasks: [{ taskId: "bash", taskType: "local_bash", description: "sleep 120", isBackgrounded: false }],
    stopTask: async () => {
      throw new Error("SDK refused stop");
    },
  });
  await expect(registry.stop("thr_1", "bash")).rejects.toThrow("SDK refused stop");
  expect(registry.list()[0]?.isBackgrounded).toBe(false);
});

test("a replacement Query cannot confirm termination of the previous Query's task", async () => {
  const registry = new ClaudeBackgroundTaskRegistry();
  const replace = (owner: object) =>
    registry.replaceThread({
      threadId: "thr_1",
      workspacePath: "/workspace",
      owner,
      tasks: [{ taskId: "bash", taskType: "local_bash", description: "sleep 120" }],
      stopTask: async () => {},
    });
  replace({});
  const stopping = registry.stop("thr_1", "bash");
  const rejected = stopping.catch((error) => error);
  replace({});
  expect(String(await rejected)).toContain("before Bash termination was confirmed");
  expect(registry.list()).toHaveLength(1);
});
