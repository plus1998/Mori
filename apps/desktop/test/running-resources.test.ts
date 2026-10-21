import { expect, test } from "bun:test";
import {
  collectRunningTerminals,
  selectClaudeBackgroundTasksForThread,
  selectCodexBackgroundTerminalsForThread,
} from "../src/renderer/running-resources";
import type { BackgroundTerminalTask } from "../src/shared/ipc";

function task(status: BackgroundTerminalTask["status"], sessionId = "background"): BackgroundTerminalTask {
  return {
    taskId: `task-${sessionId}`,
    sessionId,
    workspacePath: "/workspace/other",
    threadId: "thread-other",
    command: ["bun", "run", "dev"],
    label: "开发服务",
    status,
    startedAt: "2026-10-15T00:00:00Z",
  };
}

test("merges PTYs with background task ownership without duplicating the terminal", () => {
  const terminals = collectRunningTerminals(
    [
      { sessionId: "shell", workspacePath: "/workspace/one", kind: "local" },
      {
        sessionId: "ssh",
        workspacePath: "/workspace/two",
        kind: "ssh",
        label: "服务器",
        endpoint: "dev@host",
      },
      { sessionId: "background", workspacePath: "/workspace/other", kind: "command" },
    ],
    [task("running")],
  );
  expect(terminals).toHaveLength(3);
  expect(terminals.find((entry) => entry.sessionId === "background")).toMatchObject({
    taskId: "task-background",
    threadId: "thread-other",
    label: "开发服务",
  });
  expect(terminals.find((entry) => entry.sessionId === "ssh")).toMatchObject({
    kind: "ssh",
    endpoint: "dev@host",
  });
});

test("includes starting tasks and excludes finished task history across all workspaces", () => {
  expect(
    collectRunningTerminals(
      [],
      [
        task("starting", "starting"),
        task("running"),
        task("exited", "exited"),
        task("failed", "failed"),
        task("stopped", "stopped"),
      ],
    ).map((terminal) => terminal.sessionId),
  ).toEqual(["starting", "background"]);
});

test("includes Codex Unified Exec processes as Agent Bash resources", () => {
  const [terminal] = collectRunningTerminals(
    [],
    [],
    [
      {
        codexThreadId: "codex-thread",
        threadId: "thread-owner",
        itemId: "item-bash",
        processId: "process-bash",
        workspacePath: "/workspace/agent",
        command: "bun run dev\nVITE ready",
        osPid: 56282,
        cpuPercent: 2.5,
        rssKb: 208320,
      },
    ],
  );

  expect(terminal).toMatchObject({
    sessionId: "codex:codex-thread:process-bash",
    workspacePath: "/workspace/agent",
    kind: "command",
    label: "bun run dev",
    threadId: "thread-owner",
    codexThreadId: "codex-thread",
    codexProcessId: "process-bash",
    osPid: 56282,
    cpuPercent: 2.5,
    rssKb: 208320,
  });
});

test("selects Agent Bash processes for the active conversation, not the whole workspace", () => {
  const terminals = [
    {
      codexThreadId: "codex-thread-a",
      threadId: "thread-a",
      itemId: "item-a",
      processId: "process-a",
      workspacePath: "/workspace/shared",
      command: "bun run dev",
    },
    {
      codexThreadId: "codex-thread-b",
      threadId: "thread-b",
      itemId: "item-b",
      processId: "process-b",
      workspacePath: "/workspace/shared",
      command: "sleep 120",
    },
  ];

  expect(selectCodexBackgroundTerminalsForThread(terminals, "thread-a").map((item) => item.itemId)).toEqual([
    "item-a",
  ]);
  expect(selectCodexBackgroundTerminalsForThread(terminals, "thread-b").map((item) => item.itemId)).toEqual([
    "item-b",
  ]);
  expect(selectCodexBackgroundTerminalsForThread(terminals, undefined)).toEqual([]);
});

test("includes Claude background Bash tasks and scopes them by conversation", () => {
  const tasks = [
    {
      threadId: "thread-a",
      taskId: "claude-task-a",
      workspacePath: "/workspace/shared",
      label: "bun run dev",
      status: "running" as const,
      taskType: "local_bash",
    },
    {
      threadId: "thread-b",
      taskId: "claude-task-b",
      workspacePath: "/workspace/shared",
      label: "sleep 120",
      status: "running" as const,
      taskType: "local_bash",
    },
  ];

  expect(selectClaudeBackgroundTasksForThread(tasks, "thread-a")).toEqual([tasks[0]]);
  const [terminal] = collectRunningTerminals([], [], [], [tasks[0]!]);
  expect(terminal).toMatchObject({
    sessionId: "claude:thread-a:claude-task-a",
    threadId: "thread-a",
    claudeTaskId: "claude-task-a",
    workspacePath: "/workspace/shared",
    label: "bun run dev",
    kind: "command",
  });
});
