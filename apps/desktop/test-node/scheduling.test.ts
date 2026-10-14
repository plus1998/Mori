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
import { SystemSleepBlocker } from "../src/main/system-sleep-blocker";

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
