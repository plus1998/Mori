import { expect, test } from "bun:test";
import { collectRunningTerminals } from "../src/renderer/running-resources";
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
