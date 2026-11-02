import { expect, test } from "bun:test";
import type { WorktreePlan } from "@eco/workspace";
import { ActiveRunRuntimeStateStore } from "../src/main/active-run-runtime-state";

function plan(suffix: string): WorktreePlan {
  return {
    workspacePath: "/workspace",
    worktreePath: `/workspace/.eco/worktrees/${suffix}`,
    branchName: `eco/${suffix}`,
  };
}

test("ActiveRunRuntimeStateStore tracks active runs and worktree plans", () => {
  const store = new ActiveRunRuntimeStateStore();
  const controller = new AbortController();

  expect(store.hasRun("thr_runtime")).toBe(false);
  store.startRun("thr_runtime", { controller, worktreePlan: plan("initial") });

  expect(store.hasRun("thr_runtime")).toBe(true);
  expect(store.worktreePlan("thr_runtime")).toMatchObject({
    worktreePath: "/workspace/.eco/worktrees/initial",
  });

  store.setWorktreePlan("thr_runtime", plan("resolved"));
  expect(store.worktreePlan("thr_runtime")).toMatchObject({
    worktreePath: "/workspace/.eco/worktrees/resolved",
  });

  store.finishRun("thr_runtime");
  expect(store.hasRun("thr_runtime")).toBe(false);
  expect(store.worktreePlan("thr_runtime")).toBeUndefined();
});

test("ActiveRunRuntimeStateStore aborts active controllers only", () => {
  const store = new ActiveRunRuntimeStateStore();
  const controller = new AbortController();
  store.startRun("thr_runtime", { controller });

  expect(store.abortRun("missing", "missing")).toBe(false);
  expect(controller.signal.aborted).toBe(false);

  expect(store.abortRun("thr_runtime", "cancelled by user")).toBe(true);
  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe("cancelled by user");
});

test("ActiveRunRuntimeStateStore restarts with fresh runtime state", () => {
  const store = new ActiveRunRuntimeStateStore();
  store.startRun("thr_runtime", {
    controller: new AbortController(),
    worktreePlan: plan("old"),
  });

  store.startRun("thr_runtime", { controller: new AbortController() });

  expect(store.hasRun("thr_runtime")).toBe(true);
  expect(store.worktreePlan("thr_runtime")).toBeUndefined();
});

test("only the active Codex turn owns a failure without a runAttemptId", () => {
  const store = new ActiveRunRuntimeStateStore();
  const oldController = new AbortController();
  store.startRun("thr_runtime", { controller: oldController });
  expect(store.bindCodexTurn("thr_runtime", oldController, "turn_old")).toBe(true);
  expect(store.ownsRequest("thr_runtime", { turnId: "turn_old" })).toBe(true);

  const controller = new AbortController();
  store.startRun("thr_runtime", { controller });
  expect(store.ownsRequest("thr_runtime", { turnId: "turn_old" })).toBe(false);
  expect(store.bindCodexTurn("thr_runtime", oldController, "turn_old")).toBe(false);
  expect(store.bindCodexTurn("thr_runtime", controller, "turn_new")).toBe(true);
  store.clearCodexTurn("thr_runtime", oldController, "turn_old");
  expect(store.ownsRequest("thr_runtime", { turnId: "turn_old" })).toBe(false);
  expect(store.ownsRequest("thr_runtime", {})).toBe(false);
  expect(store.ownsRequest("other_thread", { turnId: "turn_new" })).toBe(false);
  expect(controller.signal.aborted).toBe(false);
  expect(store.ownsRequest("thr_runtime", { turnId: "turn_new" })).toBe(true);

  store.clearCodexTurn("thr_runtime", controller, "turn_new");
  expect(store.ownsRequest("thr_runtime", { turnId: "turn_new" })).toBe(false);
});

test("Bridge failures require a matching runAttemptId even if a turn matches", () => {
  const store = new ActiveRunRuntimeStateStore();
  const controller = new AbortController();
  store.startRun("thr_runtime", { controller });
  store.bindCodexTurn("thr_runtime", controller, "turn_current");
  expect(store.ownsRequest("thr_runtime", {
    runAttemptId: "run_old", currentRunAttemptId: "run_current", turnId: "turn_current",
  })).toBe(false);
  expect(store.ownsRequest("thr_runtime", { runAttemptId: "run_current" })).toBe(false);
  expect(store.ownsRequest("thr_runtime", {
    runAttemptId: "run_current", currentRunAttemptId: "run_current",
  })).toBe(true);
  store.abortRun("thr_runtime", "quota limit");
  expect(store.ownsRequest("thr_runtime", { turnId: "turn_current" })).toBe(false);
  expect(store.bindCodexTurn("thr_runtime", controller, "turn_late")).toBe(false);
});

test("managed worktrees admit one writer across chats and keep the lease until finalization", () => {
  const store = new ActiveRunRuntimeStateStore();
  const controller = new AbortController();
  store.startRun("owner", { controller, worktreePlan: plan("shared"), exclusiveWorkspace: true });
  expect(() => store.startRun("other-core", { controller: new AbortController(), worktreePlan: plan("shared") })).toThrow("owner");
  expect(store.hasRun("other-core")).toBe(false);
  store.abortRun("owner", "stop");
  expect(() => store.startRun("other-core", { controller: new AbortController(), worktreePlan: plan("shared") })).toThrow("owner");
  store.startRun("different-worktree", { controller: new AbortController(), worktreePlan: plan("other"), exclusiveWorkspace: true });
  expect(() => store.setWorktreePlan("different-worktree", plan("shared"))).toThrow("owner");
  expect(store.worktreePlan("different-worktree")?.worktreePath).toBe(plan("other").worktreePath);
  store.finishRun("owner");
  store.startRun("other-core", { controller: new AbortController(), worktreePlan: plan("shared"), exclusiveWorkspace: true });
  expect(store.hasRun("other-core")).toBe(true);
});

test("managed writer cannot enter a directory already used by a direct chat", () => {
  const store = new ActiveRunRuntimeStateStore();
  store.startRun("direct", { controller: new AbortController(), worktreePlan: plan("shared") });
  expect(() => store.startRun("managed", { controller: new AbortController(), worktreePlan: { ...plan("shared"), worktreePath: `${plan("shared").worktreePath}/../shared` }, exclusiveWorkspace: true })).toThrow("direct");
  store.startRun("direct-legacy", { controller: new AbortController(), worktreePlan: plan("shared") });
  expect(store.hasRun("direct-legacy")).toBe(true);
});
