import { expect, test } from "bun:test";
import { inspectScheduledRun } from "../src/main/scheduling-inspection";
import { ThreadFollowUpDrainScheduler } from "../src/main/thread-follow-up-drain-scheduler";

test("a claimed message stays in flight during async Core startup, then reports the actual failure", async () => {
  const scheduler = new ThreadFollowUpDrainScheduler();
  let release!: () => void;
  const startup = new Promise<void>(resolve => { release = resolve; });
  const draining = scheduler.drain("thread", () => startup);
  const receipt = {
    kind: "session_message" as const, thread: { status: "idle" as const, message: "" },
    followUp: { status: "delivered" as const }, hasAcceptedMessage: true, hasActiveRun: false,
    isDraining: scheduler.isDraining("thread"),
  };
  expect(inspectScheduledRun(receipt).status).toBe("running");
  release(); await draining;
  expect(scheduler.isDraining("thread")).toBe(false);
  expect(inspectScheduledRun({ ...receipt, thread: { status: "failed", message: "Authentication required" }, followUp: { status: "applied" }, isDraining: false })).toEqual({ status: "failed", error: "Authentication required" });
  // After a restart there is no live startup promise proving that a claim is being delivered.
  expect(inspectScheduledRun({ ...receipt, isDraining: new ThreadFollowUpDrainScheduler().isDraining("thread") }).status).toBe("unknown");
});

test("paused or missing message receipts require explicit attention; tasks retain their run lifecycle", () => {
  const input = { kind: "session_message" as const, thread: { status: "idle" as const, message: "", followUpQueuePaused: true }, followUp: { status: "queued" as const }, hasAcceptedMessage: true, hasActiveRun: false, isDraining: false };
  expect(inspectScheduledRun(input).status).toBe("waiting_user");
  expect(inspectScheduledRun({ ...input, followUp: undefined }).status).toBe("unknown");
  expect(inspectScheduledRun({ ...input, followUp: undefined, hasAcceptedMessage: false }).status).toBe("failed");
  expect(inspectScheduledRun({ ...input, kind: "scheduled_task", thread: { status: "completed", message: "" }, followUp: undefined }).status).toBe("completed");
});
