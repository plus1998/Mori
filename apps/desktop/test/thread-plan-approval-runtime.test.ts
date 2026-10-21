import { expect, test } from "bun:test";
import {
  resolveThreadPlanApprovalRuntime,
  type ThreadPlanApprovalRuntimeServices,
} from "../src/main/thread-plan-approval-runtime";
import type { ThreadPendingPlanWithRoutes } from "../src/main/thread-plan-ready-effects";
import type { RuntimeConfigResolution } from "../src/main/thread-runtime-routes";
import type { RoleRouteConfig, ThreadSummary } from "../src/shared/ipc";

const thread: ThreadSummary = {
  id: "thr_approval",
  title: "Approval",
  prompt: "Build billing ledger",
  workspacePath: "/repo",
  status: "awaiting_plan",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  message: "等待批准计划",
};

const pendingPlan: ThreadPendingPlanWithRoutes = {
  threadId: thread.id,
  userPrompt: thread.prompt,
  analysis: "Need explicit usage attribution.",
  plan: "1. Capture usage\n2. Project billing",
  workspacePath: "/repo",
  worktreePath: "/repo/.worktrees/thr_approval",
  routesJson: '{"main":"sonnet"}',
};

const roleRoutes: RoleRouteConfig[] = [
  {
    role: "main",
    providerId: "p1",
    modelId: "planner-model",
    apiCompat: "anthropic",
  },
];

function services(
  overrides: Partial<ThreadPlanApprovalRuntimeServices> = {},
): ThreadPlanApprovalRuntimeServices {
  return {
    getThread: () => thread,
    hasActiveRun: () => false,
    getPendingPlan: () => pendingPlan,
    resolveRoleRoutes: () => roleRoutes,
    resolveRuntimeConfig: () => ({ ok: true, routes: [] }) satisfies RuntimeConfigResolution,
    ...overrides,
  };
}

test("resolveThreadPlanApprovalRuntime rejects invalid approval state before launch", () => {
  expect(() => resolveThreadPlanApprovalRuntime(thread.id, services({ getThread: () => undefined }))).toThrow(
    "Thread was not found.",
  );
  expect(() =>
    resolveThreadPlanApprovalRuntime(
      thread.id,
      services({ getThread: () => ({ ...thread, status: "idle" }) }),
    ),
  ).toThrow("This thread is not waiting for plan approval.");
  expect(() => resolveThreadPlanApprovalRuntime(thread.id, services({ hasActiveRun: () => true }))).toThrow(
    "Thread is already running.",
  );
  expect(() =>
    resolveThreadPlanApprovalRuntime(thread.id, services({ getPendingPlan: () => undefined })),
  ).toThrow("找不到待批准的计划。");
  expect(() =>
    resolveThreadPlanApprovalRuntime(
      thread.id,
      services({
        getPendingPlan: () => ({
          ...pendingPlan,
          plan: "   ",
        }),
      }),
    ),
  ).toThrow("计划内容不能为空。");
  expect(() =>
    resolveThreadPlanApprovalRuntime(
      thread.id,
      services({
        resolveRuntimeConfig: () => ({ ok: false, reason: "missing coder route" }),
      }),
    ),
  ).toThrow("missing coder route");
});

test("resolveThreadPlanApprovalRuntime returns execution launch context", () => {
  const runtime = resolveThreadPlanApprovalRuntime(thread.id, services());

  expect(runtime).toMatchObject({
    thread,
    pendingPlan,
    roleRoutes,
    runtimeConfig: { routes: [] },
    launchMode: "execution",
  });
});
