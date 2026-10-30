import { expect, test } from "bun:test";
import {
  assertScheduledPlanCurrent,
  inspectScheduledPlanCommand,
  scheduledPlanCommandId,
} from "../src/main/scheduled-plan-execution";

test("scheduled approval is bound to the pending plan and conversation revision", () => {
  const approval = { expectedHistoryRevision: 7 };
  const current = {
    thread: { status: "awaiting_plan" as const },
    pendingPlan: { plan: "Implement A" },
    historyRevision: 7,
  };
  expect(() => assertScheduledPlanCurrent(approval, "Implement A", current)).not.toThrow();
  expect(() =>
    assertScheduledPlanCurrent(approval, "Implement A", { ...current, pendingPlan: { plan: "Implement B" } }),
  ).toThrow("变更");
  expect(() =>
    assertScheduledPlanCurrent(approval, "Implement A", { ...current, historyRevision: 8 }),
  ).toThrow("变更");
  expect(() =>
    assertScheduledPlanCurrent(approval, "Implement A", { ...current, thread: { status: "running" } }),
  ).toThrow("已执行或已取消");
  expect(() =>
    assertScheduledPlanCurrent(approval, "Implement A", { ...current, pendingPlan: undefined }),
  ).toThrow("已执行或已取消");
  expect(() =>
    assertScheduledPlanCurrent(approval, "Implement A", { ...current, thread: undefined }),
  ).toThrow("已删除");
});

test("scheduled approval recovery uses the durable command receipt, never an unrelated run", () => {
  expect(scheduledPlanCommandId("occ_1")).toBe("scheduled_plan_occ_1");
  expect(inspectScheduledPlanCommand({ status: "completed" })).toEqual({ status: "completed" });
  expect(
    inspectScheduledPlanCommand({ status: "failed", error: { message: "Provider unavailable" } }),
  ).toEqual({ status: "failed", error: '{"message":"Provider unavailable"}' });
  expect(inspectScheduledPlanCommand(undefined).status).toBe("failed");
  expect(inspectScheduledPlanCommand({ status: "running" }).status).toBe("unknown");
  expect(inspectScheduledPlanCommand({ status: "accepted" }).status).toBe("unknown");
});
