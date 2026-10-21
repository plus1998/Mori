import { expect, test } from "bun:test";
import {
  approveAllPendingBashApprovalsForThread,
  buildResolvedBashApprovalThreadPatch,
  cancelBashApprovalsForThread,
  getPendingBashApprovalByToolUseId,
  getPendingBashApprovalForThread,
  listPendingBashApprovalsForThread,
  registerPendingBashApproval,
  resolveBashApprovalIdempotent,
  resolvePendingBashApproval,
} from "../src/main/bash-approval-bridge";

test("resolved Bash approvals keep the thread running without a slogan summary", () => {
  expect(buildResolvedBashApprovalThreadPatch("approved")).toEqual({
    status: "running",
    message: "",
  });
  expect(buildResolvedBashApprovalThreadPatch("approved_remember_prefix")).toEqual({
    status: "running",
    message: "",
  });
  expect(buildResolvedBashApprovalThreadPatch("denied")).toEqual({
    status: "running",
    message: "",
  });
});

test("registers and resolves pending Bash approvals", async () => {
  const pending = registerPendingBashApproval("thread_1", {
    toolUseId: "tool_bash_1",
    threadId: "thread_1",
    command: "date",
    cwd: "/repo",
    reason: "Eco requires user confirmation before running Bash.",
    riskScore: 5,
    riskLevel: "low",
    agentId: "main:attempt_execution_0",
  });

  expect(getPendingBashApprovalForThread("thread_1")?.command).toBe("date");
  expect(getPendingBashApprovalByToolUseId("tool_bash_1")?.cwd).toBe("/repo");
  expect(resolvePendingBashApproval("tool_bash_1", { decision: "approved" })).toBe(true);
  await expect(pending).resolves.toEqual({ decision: "approved" });
  expect(getPendingBashApprovalForThread("thread_1")).toBeUndefined();
});

test("SDK suppressed persistent rules cannot be granted by desktop or mobile resolution", async () => {
  const pending = registerPendingBashApproval("thread_sdk_hint", {
    toolUseId: "sdk_hint",
    threadId: "thread_sdk_hint",
    command: "example",
    cwd: "/repo",
    reason: "SDK requires one-time approval",
    riskScore: 50,
    riskLevel: "medium",
    agentId: "main",
    defaultToNo: true,
    suppressAlwaysAllowRule: true,
  });
  expect(() => resolvePendingBashApproval("sdk_hint", { decision: "approved_remember_prefix" })).toThrow(
    "forbids persistent",
  );
  expect(getPendingBashApprovalByToolUseId("sdk_hint")).toBeDefined();
  expect(() => resolveBashApprovalIdempotent("sdk_hint", { decision: "approved_for_session" })).toThrow(
    "forbids persistent",
  );
  expect(resolvePendingBashApproval("sdk_hint", { decision: "approved" })).toBe(true);
  await expect(pending).resolves.toEqual({ decision: "approved" });
});

test("idempotent resolve succeeds twice without throwing (PC/mobile race)", async () => {
  const pending = registerPendingBashApproval("thread_race", {
    toolUseId: "tool_race_1",
    threadId: "thread_race",
    command: "echo race",
    cwd: "/repo",
    reason: "race",
    riskScore: 5,
    riskLevel: "low",
    agentId: "main:race",
  });

  const first = resolveBashApprovalIdempotent("tool_race_1", { decision: "approved" });
  expect(first).toEqual({
    ok: true,
    alreadyResolved: false,
    request: expect.objectContaining({ toolUseId: "tool_race_1", command: "echo race" }),
  });
  await expect(pending).resolves.toEqual({ decision: "approved" });

  const second = resolveBashApprovalIdempotent("tool_race_1", { decision: "approved" });
  expect(second).toEqual({ ok: true, alreadyResolved: true });

  const neverExisted = resolveBashApprovalIdempotent("tool_ghost", { decision: "denied" });
  expect(neverExisted).toEqual({ ok: true, alreadyResolved: true });
});

test("cancels pending Bash approvals for a thread", async () => {
  const pending = registerPendingBashApproval("thread_2", {
    toolUseId: "tool_bash_2",
    threadId: "thread_2",
    command: "npm test",
    cwd: "/repo",
    reason: "Eco requires user confirmation before running Bash.",
    riskScore: 5,
    riskLevel: "low",
    agentId: "main:attempt_execution_0",
  });

  cancelBashApprovalsForThread("thread_2", "cancelled by user");
  await expect(pending).rejects.toThrow("cancelled by user");
  expect(resolvePendingBashApproval("tool_bash_2", { decision: "denied" })).toBe(false);
});

test("approveAllPendingBashApprovalsForThread flushes only the target thread", async () => {
  const keep = registerPendingBashApproval("thread_keep", {
    toolUseId: "tool_keep",
    threadId: "thread_keep",
    command: "echo keep",
    cwd: "/repo",
    reason: "keep",
    riskScore: 5,
    riskLevel: "low",
    agentId: "main:keep",
  });
  const first = registerPendingBashApproval("thread_flush", {
    toolUseId: "tool_flush_1",
    threadId: "thread_flush",
    command: "echo one",
    cwd: "/repo",
    reason: "flush",
    riskScore: 5,
    riskLevel: "low",
    agentId: "main:flush",
  });
  const second = registerPendingBashApproval("thread_flush", {
    toolUseId: "tool_flush_2",
    threadId: "thread_flush",
    command: "echo two",
    cwd: "/repo",
    reason: "flush",
    riskScore: 5,
    riskLevel: "low",
    agentId: "main:flush",
  });

  expect(listPendingBashApprovalsForThread("thread_flush")).toHaveLength(2);

  const approved = approveAllPendingBashApprovalsForThread("thread_flush");
  expect(approved.map((entry) => entry.toolUseId).sort()).toEqual(["tool_flush_1", "tool_flush_2"]);
  await expect(first).resolves.toEqual({ decision: "approved" });
  await expect(second).resolves.toEqual({ decision: "approved" });
  expect(listPendingBashApprovalsForThread("thread_flush")).toEqual([]);
  expect(getPendingBashApprovalForThread("thread_keep")?.toolUseId).toBe("tool_keep");

  expect(resolvePendingBashApproval("tool_keep", { decision: "denied" })).toBe(true);
  await expect(keep).resolves.toEqual({ decision: "denied" });
});
