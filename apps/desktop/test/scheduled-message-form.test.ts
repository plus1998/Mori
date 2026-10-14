import { describe, expect, test } from "bun:test";
import type { ScheduleDefinition } from "../src/shared/scheduling";
import { initialScheduledMessageForm, messageDurationWithUnit, scheduledMessageLatenessFor, scheduledMessageName, scheduledMessageTriggerFor } from "../src/renderer/scheduled-message-form";

const now = Date.parse("2026-10-08T00:00:00Z");
const definition: ScheduleDefinition = {
  id: "message", kind: "session_message", name: "Check build", prompt: "Check the build", threadId: "thread",
  trigger: { type: "at", at: new Date(now + 7200_377).toISOString() },
  enabled: true, source: "user", maxLatenessSeconds: 86400, revision: 1,
  nextRunAt: new Date(now + 7200_000).toISOString(), createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
};

describe("scheduled message timing", () => {
  test("new messages default to a one-shot delay starting when saved", () => {
    const form = initialScheduledMessageForm(undefined, now);
    expect(form.timingMode).toBe("delay");
    form.duration.amount = "2";
    const savedAt = now + 300_000;
    expect(scheduledMessageTriggerFor(form, savedAt)).toEqual({ type: "at", at: new Date(savedAt + 7200_000).toISOString() });
    form.duration = { amount: "1", unit: "days" };
    expect(scheduledMessageTriggerFor(form, savedAt)).toEqual({ type: "at", at: new Date(savedAt + 86400_000).toISOString() });
  });

  test("editing the body preserves the original deadline, even when already waiting", () => {
    const form = initialScheduledMessageForm(definition, now + 60_000);
    form.prompt = "Check deployment instead";
    expect(scheduledMessageTriggerFor(form, now + 10 * 3600_000)).toEqual(definition.trigger);
    form.timingMode = "delay";
    expect(scheduledMessageTriggerFor(form, now + 10 * 3600_000)).toEqual({ type: "at", at: new Date(now + 11 * 3600_000).toISOString() });
  });

  test("advanced recurrence survives body editing until explicitly replaced with a delay", () => {
    const trigger = { type: "cron" as const, expression: "0 9 * * *", timezone: "Asia/Shanghai" };
    const form = initialScheduledMessageForm({ ...definition, trigger }, now);
    form.prompt = "Changed body";
    expect(scheduledMessageTriggerFor(form, now + 3600_000)).toEqual(trigger);
    form.timingMode = "delay";
    expect(scheduledMessageTriggerFor(form, now).type).toBe("at");
    const interval = { type: "interval" as const, everySeconds: 3600, anchorAt: new Date(now + 7200_377).toISOString() };
    expect(scheduledMessageTriggerFor(initialScheduledMessageForm({ ...definition, trigger: interval }, now), now)).toEqual(interval);
  });

  test("fixed intervals have one duration and an explicit first date, without a separate delay", () => {
    const form = initialScheduledMessageForm(undefined, now);
    form.timingMode = "interval";
    form.duration = { amount: "2", unit: "hours" };
    const savedAt = now + 300_000;
    expect(scheduledMessageTriggerFor(form, savedAt)).toEqual({ type: "interval", everySeconds: 7200, anchorAt: new Date(now + 3600_000).toISOString() });
    form.timingMode = "schedule";
    expect(scheduledMessageTriggerFor(form, savedAt)).toEqual({ type: "at", at: new Date(now + 3600_000).toISOString() });
    form.timingMode = "delay";
    expect(scheduledMessageTriggerFor(form, savedAt)).toEqual({ type: "at", at: new Date(savedAt + 7200_000).toISOString() });
  });

  test("inactive time fields cannot affect the selected send mode", () => {
    const form = initialScheduledMessageForm(undefined, now);
    form.at = "";
    form.cron = "";
    expect(scheduledMessageTriggerFor(form, now)).toEqual({ type: "at", at: new Date(now + 3600_000).toISOString() });
    form.timingMode = "cron";
    form.cron = "0 9 * * *";
    form.duration.amount = "";
    expect(scheduledMessageTriggerFor(form, now)).toEqual({ type: "cron", expression: form.cron, timezone: form.timezone });
    form.timingMode = "schedule";
    form.at = initialScheduledMessageForm(undefined, now).at;
    expect(scheduledMessageTriggerFor(form, now)).toEqual({ type: "at", at: new Date(now + 3600_000).toISOString() });
    form.timingMode = "interval";
    expect(() => scheduledMessageTriggerFor(form, now)).toThrow();
  });

  test("duration unit changes preserve the actual delay and interval", () => {
    const form = initialScheduledMessageForm(undefined, now);
    form.duration.amount = "2";
    const original = scheduledMessageTriggerFor(form, now);
    form.duration = messageDurationWithUnit(form.duration, "minutes");
    expect(form.duration).toEqual({ amount: "120", unit: "minutes" });
    expect(scheduledMessageTriggerFor(form, now)).toEqual(original);
    form.duration = messageDurationWithUnit(form.duration, "days");
    expect(scheduledMessageTriggerFor(form, now)).toEqual(original);
    const interval = { type: "interval" as const, everySeconds: 61, anchorAt: definition.trigger.type === "at" ? definition.trigger.at : "" };
    const intervalForm = initialScheduledMessageForm({ ...definition, trigger: interval }, now);
    expect(scheduledMessageTriggerFor(intervalForm, now)).toEqual(interval);
    intervalForm.duration = messageDurationWithUnit(intervalForm.duration, "hours");
    expect(scheduledMessageTriggerFor(intervalForm, now)).toEqual(interval);
  });

  test("invalid delays and intervals cannot create a schedule", () => {
    const form = initialScheduledMessageForm(undefined, now);
    for (const timingMode of ["delay", "interval"] as const) {
      for (const amount of ["", "0", "-1", "abc", "Infinity", "1e30"]) {
        expect(() => scheduledMessageTriggerFor({ ...form, timingMode, duration: { ...form.duration, amount } }, now)).toThrow();
      }
    }
  });

  test("the catch-up window uses the same units and enforces its own range", () => {
    const form = initialScheduledMessageForm(undefined, now);
    expect(scheduledMessageLatenessFor(form)).toBe(86400);
    form.lateness = messageDurationWithUnit(form.lateness, "days");
    expect(form.lateness).toEqual({ amount: "1", unit: "days" });
    expect(scheduledMessageLatenessFor(form)).toBe(86400);
    for (const amount of ["", "-1", "2", "Infinity"]) {
      expect(() => scheduledMessageLatenessFor({ ...form, lateness: { amount, unit: "days" } })).toThrow();
    }
    form.lateness.amount = "0";
    expect(scheduledMessageLatenessFor(form)).toBe(0);
  });

  test("the optional list name uses the first line of the message", () => {
    expect(scheduledMessageName({ name: "", prompt: "  Check build\nThen deploy  " })).toBe("Check build");
    expect(scheduledMessageName({ name: "  Custom name  ", prompt: "Check build" })).toBe("Custom name");
    expect(scheduledMessageName({ name: "", prompt: "a".repeat(300) })).toHaveLength(200);
  });
});
