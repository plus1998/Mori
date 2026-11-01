import path from "node:path";
import { expect, test } from "bun:test";
import { BackgroundTerminalTaskRegistry } from "../src/main/background-terminal-tasks";
import type { InteractiveTerminalManager } from "../src/main/interactive-terminal-manager";

/** 跨平台的路径 fixture：POSIX 上保持原样，Windows 上是 `<当前盘>` 下的同一路径。 */
const PROJECT = path.resolve(path.parse(process.cwd()).root, "tmp", "project");

test("BackgroundTerminalTaskRegistry starts, lists, exits, and stops tasks", async () => {
  const commands: Array<{ workspacePath: string; command: readonly string[] }> = [];
  const killed: string[] = [];
  let sessionIndex = 0;
  const manager = {
    spawnCommand: (
      workspacePath: string,
      command: readonly string[],
      _descriptor?: unknown,
      _size?: unknown,
      onSessionCreated?: (sessionId: string) => void,
    ) => {
      commands.push({ workspacePath, command });
      const sessionId = `session_${++sessionIndex}`;
      onSessionCreated?.(sessionId);
      return { sessionId };
    },
    kill: (sessionId: string) => {
      killed.push(sessionId);
      return true;
    },
  } as unknown as InteractiveTerminalManager;
  const registry = new BackgroundTerminalTaskRegistry(manager);

  const task = registry.start({
    workspacePath: PROJECT,
    command: ["echo", "ready"],
    label: "dev server",
    threadId: "thr_1",
  });

  expect(task.taskId).toBeTruthy();
  expect(task.sessionId).toBe("session_1");
  expect(task.status).toBe("running");
  expect(task.threadId).toBe("thr_1");
  expect(commands).toHaveLength(1);
  expect(commands[0]?.workspacePath).toBe(PROJECT);
  expect(commands[0]?.command.at(-1)).toBe("ready");
  expect(registry.list({ threadId: "thr_1" })).toHaveLength(1);

  registry.handleTerminalEvent({ type: "output", sessionId: task.sessionId, data: "building...\r\n" });
  expect(registry.get(task.taskId)?.output).toBe("building...\r\n");
  expect(registry.list({ threadId: "thr_1" })[0]?.output).toBeUndefined();

  registry.handleTerminalEvent({ type: "exit", sessionId: task.sessionId, exitCode: 1 });
  expect(registry.get(task.taskId)?.status).toBe("failed");
  expect(registry.get(task.taskId)?.exitCode).toBe(1);

  const completedStop = await registry.stop(task.taskId);
  expect(completedStop.stopped).toBe(false);
  expect(completedStop.task?.status).toBe("failed");
  expect(killed).toEqual([]);

  const runningTask = registry.start({
    workspacePath: PROJECT,
    command: ["sleep", "10"],
  });
  const stopped = await registry.stop(runningTask.taskId);
  expect(stopped.stopped).toBe(true);
  expect(stopped.task?.status).toBe("stopped");
  expect(killed).toEqual([runningTask.sessionId]);
});
