import { expect, test } from "bun:test";
import { buildThreadWorkLocationPrompt } from "../src/main/thread-work-location-context";
import type { ThreadSummary } from "../src/shared/ipc";

const thread = {
  id: "t1",
  workspacePath: "/project",
  prompt: "original task",
  workLocation: { mode: "direct", contextResetPending: true },
} as ThreadSummary;

for (const coreKind of ["claude", "codex", "pi", "acp"] as const)
  test(`${coreKind} fresh session receives persisted conversation after work location change`, () => {
    const result = buildThreadWorkLocationPrompt({
      thread: { ...thread, coreKind },
      prompt: "continue now",
      cwd: "/project",
      history: [
        { role: "user", message: "previous request" },
        { role: "main", message: "previous answer" },
      ],
      hasRuntimeSession: false,
    });
    expect(result).toContain("工作位置已由用户改为：/project");
    expect(result).toContain("original task");
    expect(result).toContain("previous request");
    expect(result).toContain("previous answer");
    expect(result).toContain("continue now");
  });

test("resumable session and ordinary direct development keep prompt unchanged", () => {
  for (const selected of [thread, { ...thread, workLocation: { mode: "direct" as const } }]) {
    expect(
      buildThreadWorkLocationPrompt({
        thread: selected,
        prompt: "next",
        cwd: "/project",
        history: [],
        hasRuntimeSession: true,
      }),
    ).toBe("next");
  }
});

test("isolated runs receive exact branch, target and both directories", () => {
  const result = buildThreadWorkLocationPrompt({
    thread: {
      ...thread,
      workLocation: {
        mode: "isolated",
        worktree: {
          id: "w1",
          threadId: "t1",
          workspacePath: "/project",
          repositoryPath: "/project/.git",
          worktreePath: "/isolated",
          branchName: "mori/task",
          targetBranch: "beta",
          baseCommit: "abc",
          state: "active",
          createdAt: "now",
          updatedAt: "now",
        },
      },
    },
    prompt: "work",
    cwd: "/isolated",
    history: [],
    hasRuntimeSession: false,
  });
  expect(result).toContain("隔离工作树：/isolated");
  expect(result).toContain("项目目录：/project");
  expect(result).toContain("工作分支：mori/task");
  expect(result).toContain("目标分支：beta");
});
