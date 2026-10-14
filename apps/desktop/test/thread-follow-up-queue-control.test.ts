import { expect, test } from "bun:test";
import { ThreadFollowUpQueueControl } from "../src/main/thread-follow-up-queue-control";

test("Resume during Stop cleanup survives the old cancellation", () => {
  const control = new ThreadFollowUpQueueControl();
  control.stopped("thread");
  expect(control.shouldPauseCancelledRun("thread")).toBe(true);
  control.changed("thread"); // Resume before the cancelled run exits.
  expect(control.shouldPauseCancelledRun("thread")).toBe(false);
  control.finished("thread");
  // A subsequent unexpected interruption must still protect queued rows.
  expect(control.shouldPauseCancelledRun("thread")).toBe(true);
});

test("Stop after Guide/Resume is the latest queue intent, with independent threads", () => {
  const control = new ThreadFollowUpQueueControl();
  control.stopped("first");
  control.changed("first");
  control.stopped("first");
  control.changed("second");
  expect(control.shouldPauseCancelledRun("first")).toBe(true);
  expect(control.shouldPauseCancelledRun("second")).toBe(true);
  const revision = control.revision("first");
  control.changed("first"); // Pause, then Resume during cancelled preparation.
  control.changed("first");
  expect(control.revision("first")).toBeGreaterThan(revision);
  expect(control.shouldPauseCancelledRun("first")).toBe(false);
  control.clear("first");
  expect(control.revision("first")).toBe(0);
});
