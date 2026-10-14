import { describe, expect, test } from "bun:test";
import { latestScheduleTime, nextScheduleTime, normalizeScheduleTrigger, previewSchedule } from "../src/main/schedule-time";

describe("schedule time", () => {
  test("ISO requires timezone; intervals are anchored and do not drift", () => {
    expect(() => normalizeScheduleTrigger({ type: "at", at: "2026-10-08T12:00" })).toThrow();
    const trigger = normalizeScheduleTrigger({ type: "interval", anchorAt: "2026-10-08T12:00:00+08:00", everySeconds: 5400 });
    expect(nextScheduleTime(trigger, Date.parse("2026-10-08T06:20:00Z"))).toBe("2026-10-08T07:00:00.000Z");
    expect(latestScheduleTime(trigger, Date.parse("2026-10-08T06:20:00Z"), "2026-10-08T04:00:00.000Z")).toBe("2026-10-08T05:30:00.000Z");
    expect(() => normalizeScheduleTrigger({ type: "interval", anchorAt: "2026-10-08T12:00:00Z", everySeconds: 59 })).toThrow();
  });
  test("five-field cron, explicit timezone, no random jitter", () => {
    const trigger = normalizeScheduleTrigger({ type: "cron", expression: "0 9 * * MON-FRI", timezone: "Asia/Shanghai" });
    expect(previewSchedule(trigger, Date.parse("2026-10-08T00:00:00Z"))[0]).toBe("2026-10-08T01:00:00.000Z");
    expect(normalizeScheduleTrigger({ type: "cron", expression: "0 9 * * THU", timezone: "Asia/Shanghai" }).type).toBe("cron");
    expect(() => normalizeScheduleTrigger({ type: "cron", expression: "0 0 9 * * *", timezone: "UTC" })).toThrow();
    expect(() => normalizeScheduleTrigger({ type: "cron", expression: "H 9 * * *", timezone: "UTC" })).toThrow();
    expect(() => normalizeScheduleTrigger({ type: "cron", expression: "0 9 * * *", timezone: "invalid" })).toThrow();
  });
  test("latest overdue cron includes the exact due tick", () => {
    const trigger = { type: "cron" as const, expression: "0 9 * * *", timezone: "Asia/Shanghai" };
    expect(latestScheduleTime(trigger, Date.parse("2026-10-08T01:00:00Z"), "2026-10-07T01:00:00.000Z")).toBe("2026-10-08T01:00:00.000Z");
  });
  test("DST: nonexistent 02:30 moves to 03:30; repeated 01:30 occurs once", () => {
    const spring = { type: "cron" as const, expression: "30 2 * * *", timezone: "America/New_York" };
    expect(nextScheduleTime(spring, Date.parse("2026-03-08T05:00:00Z"))).toBe("2026-03-08T07:30:00.000Z");
    const autumn = { type: "cron" as const, expression: "30 1 * * *", timezone: "America/New_York" };
    const first = nextScheduleTime(autumn, Date.parse("2026-11-01T04:00:00Z"))!;
    expect(first).toBe("2026-11-01T05:30:00.000Z");
    expect(nextScheduleTime(autumn, Date.parse(first))).toBe("2026-11-02T06:30:00.000Z");
  });
});
