import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SchedulingStore } from "../src/main/scheduling-store";
import { SchedulingService, type SchedulingDeps } from "../src/main/scheduling-service";
import { SchedulingMcpGateway } from "../src/main/scheduling-mcp-gateway";
import type { ScheduleCreateInput, ScheduleExecutionProfile, ScheduleOccurrence } from "../src/shared/scheduling";
import { buildAcpThreadRuntimeConfig } from "../src/shared/thread-runtime-config";
import { canDispatchScheduledMessage, canDispatchScheduledMessageStatus } from "../src/main/scheduling-dispatch-policy";
import type { ThreadStatus } from "../src/shared/ipc";
import { SystemSleepBlocker } from "../src/main/system-sleep-blocker";
import { approveScheduledPlan, assertScheduledPlanCurrent, inspectScheduledPlanCommand } from "../src/main/scheduled-plan-execution";
import { inspectScheduledRun } from "../src/main/scheduling-inspection";

const baseTime = Date.parse("2026-10-08T00:00:00Z");
const profile: ScheduleExecutionProfile = { coreKind: "acp", runtimeConfig: buildAcpThreadRuntimeConfig({ cursorModelId: "cheap-model" }) };
const task = (requestId: string, at = baseTime + 60_000): ScheduleCreateInput => ({ kind: "scheduled_task", requestId, name: requestId, prompt: "Self-contained instructions", workspacePath: "/tmp/project", executionProfile: profile, trigger: { type: "at", at: new Date(at).toISOString() } });

async function fixture(t: test.TestContext, overrides: Partial<SchedulingDeps> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-scheduling-test-"));
  const dbPath = path.join(directory, "test.sqlite");
  const store = new SchedulingStore(dbPath);
  let now = baseTime;
  let busy = false;
  const dispatched: ScheduleOccurrence[] = [];
  const states = new Map<string, ReturnType<SchedulingDeps["inspect"]>>();
  const deps: SchedulingDeps = {
    inheritProfile: () => ({ workspacePath: "/tmp/inherited", executionProfile: structuredClone(profile) }),
    validateProfile: value => { if (!value.runtimeConfig.cursorModelId) throw new Error("Model missing"); },
    assertThread: id => { if (id !== "source") throw new Error("Thread missing"); },
    canDispatch: () => !busy,
    dispatch: async occurrence => { dispatched.push(occurrence); states.set(occurrence.id, { status: "running" }); return { threadId: occurrence.threadId! }; },
    inspect: occurrence => states.get(occurrence.id) ?? { status: "unknown", error: "Unknown delivery" },
    onChanged: () => {}, onError: error => { throw error; }, ...overrides,
  };
  const service = new SchedulingService(store, deps, () => now);
  t.after(async () => { service.stop(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { store, service, deps, dbPath, dispatched, states, setNow: (value: number) => { now = value; }, setBusy: (value: boolean) => { busy = value; } };
}

async function sleepFixture(t: test.TestContext, overrides: Partial<SchedulingDeps> = {}) {
  const f = await fixture(t, overrides);
  let nextId = 0;
  const assertions = new Set<number>();
  const blocker = new SystemSleepBlocker({
    start: () => { const id = ++nextId; assertions.add(id); return id; },
    stop: id => assertions.delete(id),
    isStarted: id => assertions.has(id),
  });
  let runningWork = false;
  f.deps.onChanged = () => blocker.sync(runningWork || f.service.hasWorkRequiringAwake());
  return {
    ...f, blocker,
    setRunningWork: (value: boolean) => { runningWork = value; f.deps.onChanged(); },
  };
}

test("schedule deletion checks the revision inside the service and keeps legacy deletion compatible", async t => {
  const f = await fixture(t);
  const created = f.service.create(task("revision-delete"));
  const updated = f.service.update({ id: created.id, expectedRevision: 1, prompt: "Latest edit" });
  assert.throws(() => f.service.remove(created.id, { source: "user" }, 1), /修改/);
  assert.throws(() => f.service.remove(created.id, { source: "user" }, Number.NaN), /修改/);
  assert.equal(f.store.get(created.id)?.prompt, updated.prompt);
  f.service.remove(created.id, { source: "user" }, updated.revision);
  assert.equal(f.store.get(created.id), undefined);
  const legacy = f.service.create(task("legacy-delete"));
  f.service.remove(legacy.id);
  assert.equal(f.store.get(legacy.id), undefined);
});

test("scheduled plans persist approval, dispatch once through native approval and consume the one-shot", async t => {
  const current = { thread: { status: "awaiting_plan" as const }, pendingPlan: { plan: "Implement the stored plan" }, historyRevision: 9 };
  const receipts = new Map<string, { status: "completed" }>();
  const requests: unknown[] = [];
  const f = await fixture(t, {
    assertPlanApproval: (_thread, approval, plan) => assertScheduledPlanCurrent(approval, plan, current),
    dispatch: occurrence => approveScheduledPlan(occurrence, current, async request => {
      requests.push(request);
      receipts.set(occurrence.id, { status: "completed" });
    }),
    inspect: occurrence => inspectScheduledPlanCommand(receipts.get(occurrence.id)),
  });
  const input: ScheduleCreateInput = {
    kind: "session_message", requestId: "plan", threadId: "source", name: "Execute plan",
    prompt: current.pendingPlan.plan, planApproval: { expectedHistoryRevision: 9 },
    trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() },
  };
  const saved = f.service.create(input);
  assert.equal(f.service.create(input).id, saved.id);
  const reopened = new SchedulingStore(f.dbPath);
  assert.deepEqual(reopened.get(saved.id)?.planApproval, { expectedHistoryRevision: 9 });
  reopened.close();
  f.setNow(baseTime + 60_000);
  await f.service.tick();
  const occurrence = f.store.occurrences()[0]!;
  assert.deepEqual(requests, [{ principalId: "eco-scheduler", clientCommandId: `scheduled_plan_${occurrence.id}`, threadId: "source", expectedHistoryRevision: 9 }]);
  assert.equal(f.store.get(saved.id), undefined);
  await f.service.tick();
  assert.equal(f.store.occurrences()[0]?.status, "completed");
  assert.equal(requests.length, 1);
});

test("scheduled plans reject stale state, repeated execution, image payloads and Agent approval", async t => {
  let current = { thread: { status: "awaiting_plan" as const }, pendingPlan: { plan: "Plan A" }, historyRevision: 9 };
  let approved = 0;
  const f = await fixture(t, {
    assertPlanApproval: (_thread, approval, plan) => assertScheduledPlanCurrent(approval, plan, current),
    dispatch: occurrence => approveScheduledPlan(occurrence, current, async () => { approved++; }),
    inspect: () => inspectScheduledPlanCommand(undefined),
  });
  const input = { kind: "session_message" as const, requestId: "guard-plan", name: "Execute", threadId: "source", prompt: "Plan A", planApproval: { expectedHistoryRevision: 9 }, trigger: { type: "at" as const, at: new Date(baseTime + 60_000).toISOString() } };
  assert.throws(() => f.service.create({ ...input, planApproval: { expectedHistoryRevision: 8 } }), /变更/);
  assert.throws(() => f.service.create(input, { source: "agent", threadId: "source" }), /仅支持用户/);
  assert.throws(() => f.service.create({ ...input, attachments: [{ mediaType: "image/png", contentRef: `sha256:${"a".repeat(64)}`, byteLength: 1 }] }), /参数无效/);
  assert.throws(() => f.service.create({ ...input, trigger: { type: "interval", everySeconds: 60, anchorAt: input.trigger.at } }), /一次性/);
  const saved = f.service.create(input);
  assert.throws(() => f.service.create({ ...input, planApproval: { expectedHistoryRevision: 10 } }), /请求标识/);
  assert.throws(() => f.service.update({ id: saved.id, expectedRevision: 1, prompt: "Plan B" }), /不能修改/);
  assert.throws(() => f.service.update({ id: saved.id, expectedRevision: 1, trigger: { type: "interval", everySeconds: 60, anchorAt: input.trigger.at } }), /重复执行/);
  const updated = f.service.update({ id: saved.id, expectedRevision: 1, name: "Updated", trigger: { type: "at", at: new Date(baseTime + 120_000).toISOString() } });
  assert.equal(updated.planApproval?.expectedHistoryRevision, 9);
  current = { ...current, pendingPlan: { plan: "Plan B" }, historyRevision: 10 };
  f.setNow(baseTime + 120_000);
  await f.service.tick();
  assert.equal(approved, 0);
  assert.equal(f.store.occurrences()[0]?.status, "failed");
  assert.match(f.store.occurrences()[0]?.error ?? "", /变更/);
});

test("future schedules block sleep immediately, including after restart; pause and delete release", async t => {
  const f = await sleepFixture(t);
  const definition = f.service.create(task("keep-awake"));
  assert.equal(f.blocker.isBlocking, true);
  f.blocker.sync(false);
  f.service.start();
  assert.equal(f.blocker.isBlocking, true);
  assert.equal(f.dispatched.length, 0);

  const paused = f.service.update({ id: definition.id, expectedRevision: 1, enabled: false });
  assert.equal(f.blocker.isBlocking, false);
  f.service.update({ id: definition.id, expectedRevision: paused.revision, enabled: true });
  assert.equal(f.blocker.isBlocking, true);
  f.service.remove(definition.id);
  assert.equal(f.blocker.isBlocking, false);
});

test("overdue one-shots stay awake while pending; cancelling the pending run releases", async t => {
  const f = await sleepFixture(t);
  const definition = f.service.create(task("busy-awake"));
  f.setBusy(true);
  f.setNow(baseTime + 60_000);
  await f.service.tick();
  assert.equal(f.store.get(definition.id)?.nextRunAt, null);
  assert.equal(f.store.occurrences()[0]?.status, "pending");
  assert.equal(f.blocker.isBlocking, true);
  f.service.update({ id: definition.id, expectedRevision: 1, enabled: false });
  assert.equal(f.blocker.isBlocking, false);
});

test("one-shot messages stay awake after definition cleanup until the delivered run completes", async t => {
  const f = await sleepFixture(t);
  const message = f.service.create({ kind: "session_message", requestId: "awake-message", name: "Wake", threadId: "source", prompt: "Continue", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } }, { source: "agent", threadId: "source" });
  assert.equal(f.blocker.isBlocking, true);
  f.setNow(baseTime + 60_000);
  await f.service.tick();
  assert.equal(f.store.get(message.id), undefined);
  assert.equal(f.blocker.isBlocking, true);
  f.states.set(f.dispatched[0]!.id, { status: "completed" });
  await f.service.tick();
  assert.equal(f.blocker.isBlocking, false);
});

test("a paused manual run acquires before dispatch and survives deletion during dispatch", async t => {
  let completeDispatch!: (value: { threadId: string }) => void;
  const dispatch = new Promise<{ threadId: string }>(resolve => { completeDispatch = resolve; });
  const f = await sleepFixture(t, { dispatch: () => dispatch });
  const definition = f.service.create(task("manual-awake"));
  f.service.update({ id: definition.id, expectedRevision: 1, enabled: false });
  assert.equal(f.blocker.isBlocking, false);
  const occurrence = f.service.runNow(definition.id, "manual");
  assert.equal(f.store.occurrences()[0]?.status, "dispatching");
  assert.equal(f.blocker.isBlocking, true);
  f.service.remove(definition.id);
  assert.equal(f.blocker.isBlocking, true);
  completeDispatch({ threadId: "thr_manual" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.blocker.isBlocking, true);
  f.states.set(occurrence.id, { status: "completed" });
  await f.service.tick();
  assert.equal(f.blocker.isBlocking, false);
});

test("pausing schedules for approval releases only when no ordinary work remains", async t => {
  const f = await sleepFixture(t);
  f.service.create({ ...task("approval-awake"), trigger: { type: "interval", everySeconds: 60, anchorAt: new Date(baseTime + 60_000).toISOString() } });
  f.setNow(baseTime + 60_000);
  await f.service.tick();
  f.setRunningWork(true);
  f.states.set(f.dispatched[0]!.id, { status: "waiting_user" });
  await f.service.tick();
  assert.equal(f.service.hasWorkRequiringAwake(), false);
  assert.equal(f.blocker.isBlocking, true);
  f.setRunningWork(false);
  assert.equal(f.blocker.isBlocking, false);
});

test("stopping the scheduler releases future schedules even when another change arrives later", async t => {
  const f = await sleepFixture(t);
  f.service.create(task("stop-awake"));
  f.service.start();
  assert.equal(f.blocker.isBlocking, true);
  f.service.stop();
  assert.equal(f.blocker.isBlocking, false);
  f.deps.onChanged();
  assert.equal(f.blocker.isBlocking, false);
});

test("definitions persist and creation/run-now retries deduplicate", async t => {
  const f = await fixture(t);
  const definition = f.service.create(task("one"));
  assert.equal(f.service.create(task("one")).id, definition.id);
  assert.throws(() => f.service.create({ ...task("one"), prompt: "different" }), /请求标识/);
  assert.throws(() => f.service.create(task("one", baseTime + 120_000)), /请求标识/);
  const reopened = new SchedulingStore(f.dbPath);
  assert.equal(reopened.get(definition.id)?.executionProfile?.runtimeConfig.cursorModelId, "cheap-model");
  reopened.close();
  const manual = f.service.runNow(definition.id, "stable-manual");
  assert.equal(f.service.runNow(definition.id, "stable-manual").id, manual.id);
  assert.throws(() => f.service.runNow(definition.id, "another"), /已有/);
  await f.service.tick();
  assert.equal(f.dispatched.length, 1);
});

test("Agent creation inherits host profile; later Agent updates preserve user's cheaper configuration", async t => {
  const f = await fixture(t);
  const created = f.service.create({ ...task("auto"), executionProfile: { ...profile, coreKind: "codex" } } as ScheduleCreateInput, { source: "agent", threadId: "source" });
  assert.equal(created.executionProfile?.coreKind, "acp");
  assert.equal(created.workspacePath, "/tmp/inherited");
  const updated = f.service.update({ id: created.id, expectedRevision: 1, executionProfile: { coreKind: "pi", runtimeConfig: { ...profile.runtimeConfig, cursorModelId: "cheaper-user-model" } } });
  const agentUpdate = f.service.update({ id: created.id, expectedRevision: updated.revision, prompt: "Updated instructions" }, { source: "agent", threadId: "source" });
  assert.equal(agentUpdate.executionProfile?.coreKind, "pi");
  assert.equal(agentUpdate.executionProfile?.runtimeConfig.cursorModelId, "cheaper-user-model");
  assert.equal(f.service.create(task("auto"), { source: "agent", threadId: "source" }).executionProfile?.runtimeConfig.cursorModelId, "cheaper-user-model");
  assert.throws(() => f.service.update({ id: created.id, expectedRevision: agentUpdate.revision, executionProfile: profile }, { source: "agent", threadId: "source" }), /运行配置/);
  assert.throws(() => f.service.update({ id: created.id, expectedRevision: 1, prompt: "stale" }), /配置已被修改/);
  assert.throws(() => f.service.remove(created.id, { source: "agent", threadId: "other" }), /当前会话/);
});

test("busy messages wait without dispatch; pausing cancels pending occurrences", async t => {
  const f = await fixture(t);
  const definition = f.service.create({ kind: "session_message", requestId: "msg", name: "wake", threadId: "source", prompt: "Check again", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } }, { source: "agent", threadId: "source" });
  f.setBusy(true); f.setNow(baseTime + 60_000); await f.service.tick();
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.store.occurrences()[0]?.status, "pending");
  f.service.pauseAutomaticMessages("source");
  f.setBusy(false); await f.service.tick();
  assert.equal(f.store.occurrences()[0]?.status, "cancelled");
  assert.equal(f.store.get(definition.id)?.enabled, false);
});

test("one-shot messages disappear after queue hand-off; receipts and retry tombstones remain", async t => {
  const f = await fixture(t);
  const input: ScheduleCreateInput = { kind: "session_message", requestId: "consume", name: "Check", threadId: "source", prompt: "Check build", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } };
  const message = f.service.create(input);
  f.setBusy(true); f.setNow(baseTime + 60_000); await f.service.tick();
  assert.ok(f.store.get(message.id));
  f.setBusy(false); await f.service.tick();
  assert.equal(f.store.get(message.id), undefined);
  assert.equal(f.store.occurrences()[0]?.status, "running");
  assert.throws(() => f.service.create(input), /已删除/);
  f.states.set(f.dispatched[0]!.id, { status: "completed" });
  await f.service.tick();
  assert.equal(f.store.occurrences()[0]?.status, "completed");
  assert.equal(f.dispatched.length, 1);
});

test("sending a one-shot message now consumes its future date; recurring messages keep theirs", async t => {
  const f = await fixture(t);
  const oneShot = f.service.create({ kind: "session_message", requestId: "send-now", name: "Check", threadId: "source", prompt: "Check build", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } });
  f.setBusy(true);
  const occurrence = f.service.runNow(oneShot.id, "manual");
  await f.service.tick();
  assert.equal(f.store.get(oneShot.id)?.nextRunAt, null);
  f.setBusy(false); await f.service.tick();
  assert.equal(f.store.get(oneShot.id), undefined);
  f.states.set(occurrence.id, { status: "completed" });
  f.setNow(baseTime + 60_000); await f.service.tick();
  assert.equal(f.dispatched.length, 1);

  const recurring = f.service.create({ kind: "session_message", requestId: "keep-repeat", name: "Check", threadId: "source", prompt: "Check build", trigger: { type: "interval", anchorAt: new Date(baseTime + 120_000).toISOString(), everySeconds: 60 } });
  f.service.runNow(recurring.id, "manual-repeat");
  await f.service.tick();
  assert.equal(f.store.get(recurring.id)?.nextRunAt, new Date(baseTime + 120_000).toISOString());
});

test("sending an overdue waiting message now replaces its pending delivery and sends only once", async t => {
  const f = await fixture(t);
  const message = f.service.create({ kind: "session_message", requestId: "waiting-send-now", name: "Continue", threadId: "source", prompt: "Continue", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() }, maxLatenessSeconds: 10 });
  f.setBusy(true); f.setNow(baseTime + 60_000); await f.service.tick();
  const pending = f.store.occurrences(["pending"])[0]!;
  // An explicit send starts a fresh waiting window, even if the old tick has expired.
  f.setNow(baseTime + 75_000);
  const manual = f.service.runNow(message.id, "send-waiting");
  assert.equal(f.store.occurrences().find(item => item.id === pending.id)?.status, "cancelled");
  assert.equal(f.store.occurrences(["pending"]).length, 1);
  assert.equal(manual.scheduledAt, new Date(baseTime + 75_000).toISOString());
  assert.equal(f.service.runNow(message.id, "send-waiting").id, manual.id);
  assert.equal(f.dispatched.length, 0, "manual sending must still respect a busy conversation");
  const reopened = new SchedulingStore(f.dbPath);
  assert.equal(reopened.runNow(message, "send-waiting", baseTime + 75_000).id, manual.id);
  reopened.close();
  f.setBusy(false); await f.service.tick();
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0]?.id, manual.id);
  assert.equal(f.store.get(message.id), undefined);
  f.states.set(manual.id, { status: "completed" });
  f.setNow(baseTime + 120_000); await f.service.tick();
  assert.equal(f.dispatched.length, 1);
});

test("sending a waiting recurring message now preserves its next planned date", async t => {
  const f = await fixture(t);
  const message = f.service.create({ kind: "session_message", requestId: "recurring-send-now", name: "Continue", threadId: "source", prompt: "Continue", trigger: { type: "interval", anchorAt: new Date(baseTime + 60_000).toISOString(), everySeconds: 60 } });
  f.setBusy(true); f.setNow(baseTime + 60_000); await f.service.tick();
  const nextRunAt = f.store.get(message.id)!.nextRunAt;
  const manual = f.service.runNow(message.id, "send-recurring");
  assert.equal(f.store.occurrences(["pending"]).length, 1);
  assert.equal(f.store.get(message.id)?.nextRunAt, nextRunAt);
  f.setBusy(false); await f.service.tick();
  assert.equal(f.dispatched.length, 1);
  f.states.set(manual.id, { status: "completed" });
  f.setNow(Date.parse(nextRunAt!)); await f.service.tick();
  assert.equal(f.dispatched.length, 2);
});

test("send now never replaces a started message, including when another tick is pending", async t => {
  const f = await fixture(t);
  const message = f.service.create({ kind: "session_message", requestId: "started-send-now", name: "Continue", threadId: "source", prompt: "Continue", trigger: { type: "interval", anchorAt: new Date(baseTime + 60_000).toISOString(), everySeconds: 60 } });
  f.setBusy(true); f.setNow(baseTime + 60_000); await f.service.tick();
  const pending = f.store.occurrences(["pending"])[0]!;
  for (const status of ["dispatching", "running", "waiting_user"] as const) {
    f.store.saveOccurrence({ ...pending, id: "started-message", status });
    assert.throws(() => f.service.runNow(message.id, `blocked-${status}`), /已有/);
    assert.equal(f.store.occurrences(["pending"]).length, 1);
    assert.equal(f.store.occurrences().length, 2);
  }
});

test("run now retains the pending-run guard for independent tasks", async t => {
  const f = await fixture(t);
  const definition = f.service.create(task("waiting-task"));
  f.setBusy(true); f.setNow(baseTime + 60_000); await f.service.tick();
  assert.throws(() => f.service.runNow(definition.id, "do-not-replace-task"), /已有/);
  assert.equal(f.store.occurrences(["pending"]).length, 1);
});

test("failed message hand-off remains visible with an explicit error", async t => {
  const f = await fixture(t, { dispatch: async () => { throw new Error("Queue unavailable"); }, inspect: () => ({ status: "failed" }) });
  const message = f.service.create({ kind: "session_message", requestId: "not-sent", name: "Check", threadId: "source", prompt: "Check build", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } });
  f.setNow(baseTime + 60_000); await f.service.tick();
  assert.equal(f.store.get(message.id)?.error, "Queue unavailable");
  assert.equal(f.store.get(message.id)?.enabled, false);
  assert.equal(f.store.occurrences()[0]?.status, "failed");
});

test("restart consumes a one-shot with a recovered queue receipt without dispatching it again", async t => {
  const f = await fixture(t);
  const message = f.service.create({ kind: "session_message", requestId: "recover-sent", name: "Check", threadId: "source", prompt: "Check build", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } });
  f.setBusy(true); f.setNow(baseTime + 60_000); await f.service.tick();
  const occurrence = f.store.occurrences()[0]!;
  f.store.saveOccurrence({ ...occurrence, status: "dispatching", threadId: "source" });
  f.states.set(occurrence.id, { status: "running" });
  f.service.start();
  assert.equal(f.store.get(message.id), undefined);
  assert.equal(f.store.occurrences()[0]?.status, "running");
  assert.equal(f.dispatched.length, 0);
});

test("cleanup preserves a new date saved while the previous message is being dispatched", async t => {
  const f = await fixture(t);
  const message = f.service.create({ kind: "session_message", requestId: "reschedule", name: "Check", threadId: "source", prompt: "Check build", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } });
  f.deps.dispatch = async occurrence => {
    f.service.update({ id: message.id, expectedRevision: message.revision, trigger: { type: "at", at: new Date(baseTime + 120_000).toISOString() } });
    return { threadId: occurrence.threadId! };
  };
  f.setNow(baseTime + 60_000); await f.service.tick();
  assert.equal(f.store.get(message.id)?.nextRunAt, new Date(baseTime + 120_000).toISOString());
});

test("a delayed creation retry cannot resurrect a deleted schedule", async t => {
  const f = await fixture(t);
  const definition = f.service.create(task("deleted"));
  f.service.remove(definition.id);
  assert.throws(() => f.service.create(task("deleted")), /已删除/);
});

test("an Agent awakened by a message can schedule its next wakeup during that turn", async t => {
  const f = await fixture(t);
  const wakeup = (requestId: string): ScheduleCreateInput => ({ kind: "session_message", requestId, name: requestId,
    threadId: "source", prompt: "Check again", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } });
  const actor = { source: "agent" as const, threadId: "source", wakeDelaySeconds: 60 };
  const first = f.service.create(wakeup("first"), actor);
  assert.throws(() => f.service.create(wakeup("too-soon"), actor), /已有待触发/);
  f.setNow(baseTime + 60_000); await f.service.tick();
  assert.equal(f.store.occurrences(["running"])[0]?.scheduleId, first.id);
  const next = f.service.create(wakeup("next"), actor);
  assert.equal(next.nextRunAt, new Date(baseTime + 120_000).toISOString());
  assert.throws(() => f.service.create(wakeup("duplicate-pending"), actor), /已有待触发/);
  f.setNow(baseTime + 120_000); await f.service.tick();
  assert.equal(f.dispatched.length, 1);
  f.states.set(f.dispatched[0]!.id, { status: "completed" });
  await f.service.tick();
  assert.equal(f.dispatched.length, 2);
});

test("recurring catch-up coalesces, expired one-shot skips, and runs never overlap", async t => {
  const f = await fixture(t);
  const definition = f.service.create({ ...task("repeat"), trigger: { type: "interval", anchorAt: new Date(baseTime + 60_000).toISOString(), everySeconds: 60 } });
  f.setNow(baseTime + 4 * 60_000); await f.service.tick();
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0]?.scheduledAt, new Date(baseTime + 4 * 60_000).toISOString());
  f.setNow(baseTime + 6 * 60_000); await f.service.tick();
  assert.equal(f.dispatched.length, 1);
  f.states.set(f.dispatched[0]!.id, { status: "completed" });
  await f.service.tick();
  assert.equal(f.dispatched.length, 2);
  assert.notEqual(f.dispatched[0]?.threadId, f.dispatched[1]?.threadId);
  assert.equal(f.store.get(definition.id)?.nextRunAt, new Date(baseTime + 7 * 60_000).toISOString());
  const late = f.service.create({ ...task("late", baseTime + 7 * 60_000), maxLatenessSeconds: 10 });
  f.setNow(baseTime + 8 * 60_000); await f.service.tick();
  assert.equal(f.store.occurrences().find(item => item.scheduleId === late.id)?.status, "skipped");
});

test("profile edits replace waiting occurrences but cannot alter a started occurrence", async t => {
  const f = await fixture(t);
  const definition = f.service.create(task("editable"));
  f.setBusy(true); f.setNow(baseTime + 60_000); await f.service.tick();
  const edited = f.service.update({ id: definition.id, expectedRevision: 1, enabled: true, trigger: { type: "at", at: new Date(baseTime + 120_000).toISOString() }, executionProfile: { ...profile, runtimeConfig: { ...profile.runtimeConfig, cursorModelId: "edited-model" } } });
  assert.equal(f.store.occurrences()[0]?.status, "cancelled");
  f.setBusy(false); f.setNow(baseTime + 120_000); await f.service.tick();
  assert.equal(f.dispatched[0]?.definition.executionProfile?.runtimeConfig.cursorModelId, "edited-model");
  f.service.update({ id: edited.id, expectedRevision: edited.revision, executionProfile: profile });
  assert.equal(f.store.occurrences(["running"])[0]?.definition.executionProfile?.runtimeConfig.cursorModelId, "edited-model");
});

test("unknown crash receipt pauses schedule without re-dispatch; known completed receipt settles", async t => {
  const f = await fixture(t);
  const definition = f.service.create(task("unknown"));
  f.setBusy(true); f.setNow(baseTime + 60_000); await f.service.tick();
  const pending = f.store.occurrences()[0]!;
  f.store.saveOccurrence({ ...pending, status: "dispatching", threadId: "thr_unknown" });
  f.service.start();
  assert.equal(f.store.occurrences()[0]?.status, "unknown");
  assert.equal(f.store.get(definition.id)?.enabled, false);
  await f.service.tick();
  assert.equal(f.dispatched.length, 0);
});

test("model-only edit updates an overdue waiting one-shot without dropping it", async t => {
  const f = await fixture(t);
  const definition = f.service.create(task("waiting-edit"));
  f.setBusy(true); f.setNow(baseTime + 60_000); await f.service.tick();
  f.service.update({ id: definition.id, expectedRevision: 1, trigger: definition.trigger, executionProfile: { ...profile, runtimeConfig: { ...profile.runtimeConfig, cursorModelId: "new-cheap-model" } } });
  assert.equal(f.store.occurrences()[0]?.status, "pending");
  f.setBusy(false); await f.service.tick();
  assert.equal(f.dispatched[0]?.definition.executionProfile?.runtimeConfig.cursorModelId, "new-cheap-model");
});

test("approval pauses recurrence, preserves waiting run, and tracks user completion", async t => {
  const f = await fixture(t);
  const definition = f.service.create({ ...task("approval"), trigger: { type: "interval", everySeconds: 60, anchorAt: new Date(baseTime + 60_000).toISOString() } });
  f.setNow(baseTime + 60_000); await f.service.tick();
  const run = f.dispatched[0]!;
  f.states.set(run.id, { status: "waiting_user", error: "Approval required" });
  await f.service.tick();
  assert.equal(f.store.get(definition.id)?.enabled, false);
  assert.equal(f.store.occurrences()[0]?.status, "waiting_user");
  assert.throws(() => f.service.runNow(definition.id, "do-not-overlap"), /已有/);
  f.states.set(run.id, { status: "completed" });
  await f.service.tick();
  assert.equal(f.store.occurrences()[0]?.status, "completed");
  assert.equal(f.store.occurrences()[0]?.error, undefined);
});

test("a blocked recurring task fails visibly and runs again at the next scheduled time", async t => {
  const f = await fixture(t);
  const definition = f.service.create({ ...task("recurring-failure"), trigger: { type: "interval", everySeconds: 60, anchorAt: new Date(baseTime + 60_000).toISOString() } });
  f.setNow(baseTime + 60_000); await f.service.tick();
  const run = f.dispatched[0]!;
  f.deps.inspect = occurrence => occurrence.id === run.id ? inspectScheduledRun({
    kind: "scheduled_task", thread: { status: "blocked", message: "Claude Code process exited with code 1" },
    followUp: undefined, hasAcceptedMessage: false, hasActiveRun: false, isDraining: false, hasPendingUserAction: false,
  }) : { status: "completed" };
  await f.service.tick();
  assert.equal(f.store.occurrences()[0]?.status, "failed");
  assert.equal(f.store.get(definition.id)?.enabled, true);
  assert.match(f.store.get(definition.id)?.error ?? "", /exited with code 1/);
  await f.service.tick();
  assert.equal(f.dispatched.length, 1);
  f.setNow(baseTime + 120_000); await f.service.tick();
  assert.equal(f.dispatched.length, 2);
  await f.service.tick();
  assert.equal(f.store.get(definition.id)?.error, undefined);
});

test("manual execution reconciles a stale waiting failure before checking for overlapping runs", async t => {
  const f = await fixture(t);
  const definition = f.service.create(task("stale-waiting-failure"));
  f.setNow(baseTime + 60_000); await f.service.tick();
  const run = f.dispatched[0]!;
  f.store.saveOccurrence({ ...f.store.occurrences()[0]!, status: "waiting_user", error: "Old failure" });
  f.states.set(run.id, { status: "failed", error: "Process exited" });
  const manual = f.service.runNow(definition.id, "retry-failed-run");
  await f.service.tick();
  assert.equal(f.store.occurrences().find(item => item.id === run.id)?.status, "failed");
  assert.notEqual(manual.id, run.id);
  assert.equal(f.dispatched.length, 2);
});

test("restart releases old waiting failures without re-enabling a user-paused recurring task", async t => {
  const f = await fixture(t);
  const definition = f.service.create({ ...task("restart-failure"), trigger: { type: "interval", everySeconds: 60, anchorAt: new Date(baseTime + 60_000).toISOString() } });
  f.setNow(baseTime + 60_000); await f.service.tick();
  const run = f.dispatched[0]!;
  f.store.saveOccurrence({ ...f.store.occurrences()[0]!, status: "waiting_user" });
  f.service.update({ id: definition.id, expectedRevision: 1, enabled: false });
  f.states.set(run.id, { status: "failed", error: "Process exited" });
  f.service.start();
  assert.equal(f.store.occurrences()[0]?.status, "failed");
  assert.equal(f.store.get(definition.id)?.enabled, false);
  const resumed = f.service.update({ id: definition.id, expectedRevision: 2, enabled: true });
  f.setNow(Date.parse(resumed.nextRunAt!)); await f.service.tick();
  assert.equal(f.dispatched.length, 2);
});

test("manual execution still rejects a genuinely active independent task", async t => {
  const f = await fixture(t);
  const definition = f.service.create(task("active-task"));
  f.setNow(baseTime + 60_000); await f.service.tick();
  assert.throws(() => f.service.runNow(definition.id, "overlap"), /已有/);
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.store.occurrences().length, 1);
});

test("a recurring task with invalid saved configuration still pauses before dispatch", async t => {
  let unavailable = false;
  const f = await fixture(t, {
    validateProfile: () => { if (unavailable) throw new Error("Saved model unavailable"); },
    inspect: () => ({ status: "failed" }),
  });
  const definition = f.service.create({ ...task("recurring-config-failure"), trigger: { type: "interval", everySeconds: 60, anchorAt: new Date(baseTime + 60_000).toISOString() } });
  unavailable = true; f.setNow(baseTime + 60_000); await f.service.tick();
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.store.get(definition.id)?.enabled, false);
  assert.equal(f.store.occurrences()[0]?.status, "failed");
  f.setNow(baseTime + 120_000); await f.service.tick();
  assert.equal(f.store.occurrences().length, 1);
});

test("missing model explicitly fails and pauses; never substitutes a default", async t => {
  let unavailable = false;
  const f = await fixture(t, { validateProfile: () => { if (unavailable) throw new Error("Saved model unavailable"); }, inspect: () => ({ status: "failed" }) });
  const definition = f.service.create(task("missing"));
  unavailable = true; f.setNow(baseTime + 60_000); await f.service.tick();
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.store.get(definition.id)?.enabled, false);
  assert.equal(f.store.occurrences()[0]?.error, "Saved model unavailable");
});

test("wakeup budget survives deletion; thread deletion cancels messages but keeps independent tasks", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 24; i++) {
    const wake = f.service.create({ kind: "session_message", requestId: `wake-${i}`, name: "Wake", threadId: "source", prompt: "check", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } }, { source: "agent", threadId: "source" });
    f.service.remove(wake.id);
  }
  assert.throws(() => f.service.create({ kind: "session_message", requestId: "over", name: "Wake", threadId: "source", prompt: "check", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } }, { source: "agent", threadId: "source" }), /24 次/);
  const independent = f.service.create(task("keep"), { source: "agent", threadId: "source" });
  f.service.threadDeleted("source");
  assert.ok(f.store.get(independent.id));
});

test("MCP authenticates conversation and rejects Core/model choice in Agent tools", async t => {
  const f = await fixture(t);
  const gateway = new SchedulingMcpGateway(f.service);
  t.after(() => gateway.close());
  const injection = await gateway.resolveInjection("source");
  const entry = injection.sdkEntry as { url: string; headers: Record<string, string> };
  const call = async (name: string, args: object, headers = entry.headers) => {
    const response = await fetch(entry.url, { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return response.json() as Promise<{ result: { isError?: boolean; content: Array<{ text: string }> } }>;
  };
  const rejected = await call("create_scheduled_task", { requestId: "mcp", name: "mcp", prompt: "independent", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() }, coreKind: "codex" });
  assert.equal(rejected.result.isError, true);
  const created = await call("create_scheduled_task", { requestId: "mcp", name: "mcp", prompt: "independent", trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } });
  const definition = JSON.parse(created.result.content[0]!.text);
  assert.equal(definition.executionProfile.coreKind, "acp");
  const unauthenticated = await call("list_schedules", {}, { ...entry.headers, Authorization: "Bearer invalid" });
  assert.equal(unauthenticated.result.isError, true);
  gateway.disposeThread("source");
  const revoked = await call("schedule_message", { requestId: "late-after-stop", name: "late", prompt: "check", delaySeconds: 60 });
  assert.equal(revoked.result.isError, true);
  assert.equal(f.store.list().length, 1);
});


test("due messages wait for active work, then dispatch once after a failed run", async t => {
  let status: ThreadStatus = "running";
  let active = true;
  let paused = false;
  let approval = false;
  const f = await fixture(t, {
    canDispatch: () => canDispatchScheduledMessage({
      thread: { status, followUpQueuePaused: paused }, hasActiveRun: active,
      hasPendingUserAction: approval, isCompacting: false, hasEditingFollowUp: false,
    }),
  });
  f.service.create({ kind: "session_message", requestId: "after-failure", name: "reminder",
    prompt: "Continue after the previous run ends", threadId: "source",
    trigger: { type: "at", at: new Date(baseTime + 60_000).toISOString() } });
  f.setNow(baseTime + 60_000);
  await f.service.tick();
  assert.equal(f.store.occurrences()[0]?.status, "pending");
  status = "failed";
  await f.service.tick();
  assert.equal(f.dispatched.length, 0, "the terminal projection cannot bypass an active runtime");
  active = false; paused = true;
  await f.service.tick();
  assert.equal(f.dispatched.length, 0);
  paused = false; approval = true;
  await f.service.tick();
  assert.equal(f.dispatched.length, 0);
  approval = false;
  await f.service.tick();
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.store.occurrences()[0]?.status, "running");
  await f.service.tick();
  assert.equal(f.dispatched.length, 1);
});

test("scheduled message terminal statuses exclude running, queued and plan approval", () => {
  for (const status of ["idle", "completed", "failed", "blocked"] as const)
    assert.equal(canDispatchScheduledMessageStatus(status), true);
  for (const status of ["running", "queued", "awaiting_plan"] as const)
    assert.equal(canDispatchScheduledMessageStatus(status), false);
});

test("Mori reminder can dispatch on a later tick while an Agent startup is still awaiting its receipt", async t => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const deliveries: string[] = [];
  const f = await fixture(t, {
    assertAssistantAction: () => {},
    dispatch: async occurrence => {
      if (occurrence.definition.kind === "scheduled_task") await blocked;
      deliveries.push(occurrence.definition.kind);
      return { threadId: occurrence.threadId! };
    },
  });
  f.service.create(task("slow-agent"));
  f.setNow(baseTime + 60_000);
  const firstTick = f.service.tick();
  await Promise.resolve();
  const reminder = f.service.create({
    kind: "assistant_action", threadId: "mori", requestId: "fast-reminder", name: "提醒", prompt: "开会",
    action: { type: "reminder" }, notification: { channel: "desktop" },
    trigger: { type: "at", at: new Date(baseTime + 61_000).toISOString() },
  });
  f.setNow(baseTime + 61_000);
  try {
    await f.service.tick();
    assert.deepEqual(deliveries, ["assistant_action"]);
    assert.equal(f.store.occurrences().find(item => item.scheduleId === reminder.id)?.status, "running");
  } finally { release(); await firstTick; }
  assert.deepEqual(deliveries, ["assistant_action", "scheduled_task"]);
});
