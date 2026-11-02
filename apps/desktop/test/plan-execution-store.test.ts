import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createConversationStore } from "../src/main/conversation-store";
import type { ThreadPendingPlan, ThreadSummary } from "../src/shared/ipc";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mori-plan-execution-"));
  directories.push(dir);
  const dbPath = path.join(dir, "test.sqlite");
  const store = await createConversationStore(dbPath);
  const thread = (id: string, status: ThreadSummary["status"] = "running"): ThreadSummary => ({
    id,
    title: id,
    prompt: "implement",
    workspacePath: dir,
    coreKind: "pi",
    status,
    message: "",
    createdAt: "2026-11-02T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
  });
  store.saveThread(thread("source", "awaiting_plan"));
  store.saveThread(thread("execution"));
  const pending: ThreadPendingPlan & { routesJson: string } = {
    threadId: "source",
    userPrompt: "implement",
    analysis: "reason",
    plan: "# Version one\n\n1. Implement 😀",
    workspacePath: dir,
    worktreePath: dir,
    routesJson: "[]",
  };
  store.savePendingPlan(pending);
  const planId = store.getPendingPlan("source")!.referenceId!;
  const attempt = (
    attemptId: string,
    status: "running" | "completed" | "failed" | "cancelled" = "running",
  ) => ({
    threadId: "execution",
    attemptId,
    phase: "execution" as const,
    retryIndex: 0,
    status,
    startedAt: "2026-11-02T00:01:00Z",
    ...(status !== "running" ? { endedAt: "2026-11-02T00:02:00Z" } : {}),
  });
  return { dir, dbPath, store, thread, pending, planId, attempt };
}

test("plan references persist immutable numbered content versions across reopening", async () => {
  const { store, dbPath, pending, planId } = await setup();
  store.savePendingPlan(pending);
  expect(store.getPendingPlan("source")?.version).toBe(1);
  store.savePendingPlan({ ...pending, plan: "# Version two" });
  const second = store.getPendingPlan("source")!;
  expect(second.version).toBe(2);
  expect(second.referenceId).not.toBe(planId);
  const reopened = await createConversationStore(dbPath);
  expect(reopened.getPlanReference(planId).plan).toBe(pending.plan);
  expect(reopened.getPendingPlan("source")?.referenceId).toBe(second.referenceId);
  expect(reopened.searchPlanReferences("Version two", 10)).toMatchObject([
    { kind: "plan", id: second.referenceId },
  ]);
  expect(() => reopened.validatePlanExecution(planId, pending.workspacePath)).toThrow("已更新");
});

test("reserving links both conversations without resolving approval, and rejects duplicate execution", async () => {
  const { store, dir, planId, thread } = await setup();
  store.reservePlanExecution(planId, "execution");
  expect(store.getThread("source")?.status).toBe("awaiting_plan");
  expect(store.getPendingPlan("source")?.referenceId).toBe(planId);
  expect(store.listPlanExecutions("source")).toEqual(store.listPlanExecutions("execution"));
  expect(store.listPlanExecutions("source")[0]?.status).toBe("queued");
  expect(() => store.validatePlanExecution(planId, dir)).toThrow("已交给");
  expect(() => store.assertPlanApprovalNotHandedOff("source")).toThrow("已交给");
  expect(() =>
    store.saveThread(thread("duplicate"), () => store.reservePlanExecution(planId, "duplicate")),
  ).toThrow("已交给");
  expect(store.getThread("duplicate")).toBeUndefined();
});

test("only the first launched runtime attempt releases the exact matching source approval", async () => {
  const { store, planId, attempt } = await setup();
  store.reservePlanExecution(planId, "execution");
  expect(() => store.startPlanExecution("execution", "not-started")).toThrow("执行尚未启动");
  expect(store.getPendingPlan("source")?.referenceId).toBe(planId);
  store.upsertRunAttempt(attempt("first"));
  expect(store.startPlanExecution("execution", "first")).toBe("source");
  expect(store.getPendingPlan("source")).toBeUndefined();
  expect(store.getThread("source")?.status).toBe("idle");
  expect(store.listPlanExecutions("source")[0]).toMatchObject({
    attemptId: "first",
    status: "running",
    version: 1,
  });
  expect(store.startPlanExecution("execution", "first")).toBeUndefined();
  expect(store.startPlanExecution("execution", "unrelated-later-run")).toBeUndefined();
});

test("an in-flight source approval prevents launching the same plan elsewhere", async () => {
  const { store, planId, dir } = await setup();
  const v2 = store.conversationV2();
  v2.acceptCommand({
    principalId: "desktop-local",
    conversationId: "source",
    clientCommandId: "approval-in-flight",
    commandType: "plan.resolve",
    expectedHistoryRevision: v2.head("source").historyRevision,
    request: { resolution: "approve" },
  });
  expect(() => store.validatePlanExecution(planId, dir)).toThrow("正在处理审批");
  expect(store.listPlanExecutions("source")).toHaveLength(0);
});

test("a source plan revised during preparation keeps its new pending approval", async () => {
  const { store, planId, pending, attempt } = await setup();
  store.reservePlanExecution(planId, "execution");
  store.savePendingPlan({ ...pending, plan: "# A newer plan" });
  store.upsertRunAttempt(attempt("first"));
  expect(store.startPlanExecution("execution", "first")).toBeUndefined();
  expect(store.getPendingPlan("source")?.version).toBe(2);
  expect(store.getThread("source")?.status).toBe("awaiting_plan");
  expect(store.listPlanExecutions("source")[0]?.version).toBe(1);
});

test("failed launch retains source approval and allows a different execution conversation", async () => {
  const { store, planId, thread } = await setup();
  store.reservePlanExecution(planId, "execution");
  store.failQueuedPlanExecution("execution", "Worktree creation failed");
  expect(store.getPendingPlan("source")?.referenceId).toBe(planId);
  expect(store.getThread("source")?.status).toBe("awaiting_plan");
  expect(store.listPlanExecutions("source")[0]).toMatchObject({
    status: "failed",
    message: "Worktree creation failed",
  });
  store.saveThread(thread("retry"));
  expect(() => store.reservePlanExecution(planId, "retry")).not.toThrow();
});

for (const status of ["completed", "failed", "cancelled"] as const) {
  test(`execution outcome ${status} survives reopening and is not overwritten by unrelated asks`, async () => {
    const { store, planId, attempt, dbPath } = await setup();
    store.reservePlanExecution(planId, "execution");
    store.upsertRunAttempt(attempt("first"));
    store.startPlanExecution("execution", "first");
    store.upsertRunAttempt(attempt("first", status));
    store.settlePlanExecution("execution", "first", status === "failed" ? "Provider error" : "");
    store.upsertRunAttempt({ ...attempt("second"), phase: "ask" });
    store.startPlanExecution("execution", "second");
    store.upsertRunAttempt({ ...attempt("second", "completed"), phase: "ask" });
    store.settlePlanExecution("execution", "second");
    const reopened = await createConversationStore(dbPath);
    reopened.recoverPlanExecutions();
    expect(reopened.listPlanExecutions("source")[0]).toMatchObject({ status, attemptId: "first" });
    expect(reopened.getThread("source")?.status).toBe("idle");
  });
}

for (const phase of ["execution", "continuation"] as const) {
  test(`failed plan follows resumed ${phase} and discards its stale card error`, async () => {
    const { store, planId, attempt, dbPath } = await setup();
    store.reservePlanExecution(planId, "execution");
    store.upsertRunAttempt(attempt("first"));
    store.startPlanExecution("execution", "first");
    store.upsertRunAttempt(attempt("first", "failed"));
    store.settlePlanExecution("execution", "first", "Selected model is at capacity.");
    expect(store.listPlanExecutions("source")[0]?.status).toBe("failed");

    store.upsertRunAttempt({ ...attempt("retry"), phase, retryIndex: 1 });
    expect(store.startPlanExecution("execution", "retry")).toBeUndefined();
    expect(store.listPlanExecutions("source")[0]).toMatchObject({ attemptId: "retry", status: "running", message: "" });
    expect(store.listPlanExecutions("execution")).toEqual(store.listPlanExecutions("source"));
    expect(store.getPendingPlan("source")).toBeUndefined();
    expect(store.getThread("source")?.status).toBe("idle");
    // A delayed terminal callback from the old attempt cannot fail the retry.
    store.settlePlanExecution("execution", "first", "Selected model is at capacity.");
    expect(store.listPlanExecutions("source")[0]?.status).toBe("running");
    expect(store.listRunAttempts("execution").find(item => item.attemptId === "first")?.status).toBe("failed");

    store.upsertRunAttempt({ ...attempt("retry", "completed"), phase, retryIndex: 1 });
    store.settlePlanExecution("execution", "retry", "");
    const reopened = await createConversationStore(dbPath);
    reopened.recoverPlanExecutions();
    expect(reopened.listPlanExecutions("source")[0]).toMatchObject({ attemptId: "retry", status: "completed", message: "" });
    // Success ends this execution; later work must not reopen the plan.
    reopened.upsertRunAttempt(attempt("later"));
    reopened.startPlanExecution("execution", "later");
    expect(reopened.listPlanExecutions("source")[0]).toMatchObject({ attemptId: "retry", status: "completed" });
  });
}

test("transient errors cannot settle a running attempt or bind an unstarted retry", async () => {
  const { store, planId, attempt } = await setup();
  store.reservePlanExecution(planId, "execution");
  store.upsertRunAttempt(attempt("first"));
  store.startPlanExecution("execution", "first");
  store.settlePlanExecution("execution", "first", "temporary provider error");
  expect(store.listPlanExecutions("source")[0]).toMatchObject({ status: "running", message: "" });
  store.upsertRunAttempt(attempt("first", "failed"));
  store.settlePlanExecution("execution", "first", "Provider error");
  store.startPlanExecution("execution", "not-started");
  store.startPlanExecution("execution", "first");
  expect(store.listPlanExecutions("source")[0]).toMatchObject({ attemptId: "first", status: "failed", message: "Provider error" });
});

test("resuming after a stop or restart updates the link while preserving changed source approval", async () => {
  const { store, dbPath, planId, attempt, pending } = await setup();
  store.reservePlanExecution(planId, "execution");
  store.upsertRunAttempt(attempt("first"));
  store.startPlanExecution("execution", "first");
  store.upsertRunAttempt(attempt("first", "cancelled"));
  store.settlePlanExecution("execution", "first", "User stopped");
  store.savePendingPlan({ ...pending, plan: "# Revised source plan" });
  store.updateThread("source", { status: "awaiting_plan", message: "New approval" });
  store.upsertRunAttempt(attempt("second"));
  store.startPlanExecution("execution", "second");
  expect(store.listPlanExecutions("source")[0]).toMatchObject({ attemptId: "second", status: "running", version: 1, message: "" });

  const reopened = await createConversationStore(dbPath);
  reopened.recoverPlanExecutions();
  expect(reopened.listPlanExecutions("source")[0]?.status).toBe("interrupted");
  reopened.upsertRunAttempt(attempt("second", "cancelled"));
  reopened.upsertRunAttempt(attempt("third"));
  reopened.startPlanExecution("execution", "third");
  expect(reopened.listPlanExecutions("source")[0]).toMatchObject({ attemptId: "third", status: "running", version: 1, message: "" });
  expect(reopened.getPendingPlan("source")?.version).toBe(2);
  expect(reopened.getThread("source")?.status).toBe("awaiting_plan");
});

test("resuming an old failed conversation cannot take over a plan active elsewhere", async () => {
  const { store, planId, attempt, thread, pending } = await setup();
  store.reservePlanExecution(planId, "execution");
  store.upsertRunAttempt(attempt("first"));
  store.startPlanExecution("execution", "first");
  store.upsertRunAttempt(attempt("first", "failed"));
  store.settlePlanExecution("execution", "first", "Provider error");
  store.savePendingPlan(pending);
  store.updateThread("source", { status: "awaiting_plan", message: "" });
  store.saveThread(thread("other"));
  store.reservePlanExecution(planId, "other");
  store.upsertRunAttempt(attempt("retry"));
  expect(() => store.startPlanExecution("execution", "retry")).not.toThrow();
  expect(store.listPlanExecutions("execution")[0]).toMatchObject({ attemptId: "first", status: "failed" });
  expect(store.listPlanExecutions("other")[0]?.status).toBe("queued");
});

test("a retry that really fails reports its own error and can be resumed again", async () => {
  const { store, planId, attempt } = await setup();
  store.reservePlanExecution(planId, "execution");
  for (const [id, error] of [["first", "Capacity error"], ["second", "Authentication error"]] as const) {
    store.upsertRunAttempt(attempt(id));
    store.startPlanExecution("execution", id);
    expect(store.listPlanExecutions("source")[0]).toMatchObject({ attemptId: id, status: "running", message: "" });
    store.upsertRunAttempt(attempt(id, "failed"));
    store.settlePlanExecution("execution", id, error);
    expect(store.listPlanExecutions("source")[0]).toMatchObject({ attemptId: id, status: "failed", message: error });
  }
  store.upsertRunAttempt(attempt("third"));
  store.startPlanExecution("execution", "third");
  expect(store.listPlanExecutions("source")[0]).toMatchObject({ attemptId: "third", status: "running", message: "" });
});

test("restart marks unfinished links interrupted and preserves unstarted approval", async () => {
  const { store, dbPath, planId } = await setup();
  store.reservePlanExecution(planId, "execution");
  const reopened = await createConversationStore(dbPath);
  reopened.recoverPlanExecutions();
  expect(reopened.listPlanExecutions("source")[0]?.status).toBe("interrupted");
  expect(reopened.getPendingPlan("source")?.referenceId).toBe(planId);
});

test("restart uses a committed terminal run outcome even if link settlement was interrupted", async () => {
  const { store, dbPath, planId, attempt } = await setup();
  store.reservePlanExecution(planId, "execution");
  store.upsertRunAttempt(attempt("first"));
  store.startPlanExecution("execution", "first");
  store.upsertRunAttempt(attempt("first", "completed"));
  const reopened = await createConversationStore(dbPath);
  reopened.recoverPlanExecutions();
  expect(reopened.listPlanExecutions("source")[0]?.status).toBe("completed");
});

test("approval release and attempt binding roll back together on storage failure", async () => {
  const { store, dbPath, planId, attempt } = await setup();
  store.reservePlanExecution(planId, "execution");
  store.upsertRunAttempt(attempt("first"));
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TRIGGER fail_source_update BEFORE UPDATE ON threads WHEN NEW.id = 'source'
    BEGIN SELECT RAISE(ABORT, 'injected source failure'); END;`);
  try {
    expect(() => store.startPlanExecution("execution", "first")).toThrow("injected source failure");
    expect(store.getPendingPlan("source")?.referenceId).toBe(planId);
    expect(store.getThread("source")?.status).toBe("awaiting_plan");
    expect(store.listPlanExecutions("source")[0]?.status).toBe("queued");
  } finally {
    db.close();
  }
});

test("deleted conversations are explicit and referenced snapshots remain until both sides are deleted", async () => {
  const { store, planId } = await setup();
  store.reservePlanExecution(planId, "execution");
  store.deleteThread("source");
  expect(store.listPlanExecutions("execution")[0]?.sourceDeleted).toBe(true);
  expect(store.getPlanReference(planId).version).toBe(1);
  store.deleteThread("execution");
  expect(() => store.getPlanReference(planId)).toThrow("不存在");
});

test("execution cannot target another project or a deleted source", async () => {
  const { store, planId } = await setup();
  expect(() => store.validatePlanExecution(planId, "/different-project")).toThrow("所属项目");
  store.deleteThread("source");
  expect(() => store.validatePlanExecution(planId, "/different-project")).toThrow("不存在");
});
