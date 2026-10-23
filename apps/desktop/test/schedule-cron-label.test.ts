import { expect, test } from "bun:test";
import { createElement } from "react";
import type { ScheduleDefinition, ScheduleTrigger } from "../src/shared/scheduling";
import { scheduleCronLabel } from "../src/renderer/schedule-cron-label";
import { ScheduledMessagesCardBody } from "../src/renderer/ScheduledMessagesCardBody";
import { renderLocalized } from "./i18n-test";

function cron(expression: string, timezone = "Asia/Shanghai"): Extract<ScheduleTrigger, { type: "cron" }> {
  return { type: "cron", expression, timezone };
}

test("daily schedules use wall-clock language and retain their own timezone", () => {
  expect(scheduleCronLabel(cron("30 10 * * *"), "zh-CN")).toBe("每天10点30分 · Asia/Shanghai");
  expect(scheduleCronLabel(cron("0 10 * * *"), "zh-CN")).toBe("每天10点整 · Asia/Shanghai");
  expect(scheduleCronLabel(cron("  05  00 * * *  ", "America/New_York"), "zh-CN"))
    .toBe("每天0点5分 · America/New_York");
  expect(scheduleCronLabel(cron("59 23 * * *", "UTC"), "zh-CN")).toBe("每天23点59分 · UTC");
  expect(scheduleCronLabel(cron("30 10 * * *"), "en-US")).toBe("At 10:30, every day · Asia/Shanghai");
});

test("weekday, interval, monthly and advanced cron rules retain their restrictions", () => {
  expect(scheduleCronLabel(cron("30 10 * * MON-FRI"), "zh-CN")).toContain("星期一至星期五");
  expect(scheduleCronLabel(cron("*/15 * * * *"), "zh-CN")).toBe("每隔 15 分钟 · Asia/Shanghai");
  expect(scheduleCronLabel(cron("30 10 1 * *"), "zh-CN")).toContain("每月 1 号");
  expect(scheduleCronLabel(cron("30 10 L * *"), "zh-CN")).toContain("每月的最后一天");
  expect(scheduleCronLabel(cron("30 10 * * MON#2"), "zh-CN")).toContain("第二个 星期一");
  expect(scheduleCronLabel(cron("30 10 1 * MON"), "zh-CN")).toContain("或者为星期一");
  expect(scheduleCronLabel(cron("30 10 * * 0"), "zh-CN"))
    .toBe(scheduleCronLabel(cron("30 10 * * 7"), "zh-CN"));
});

test("invalid cron is not silently presented as a valid daily rule", () => {
  expect(() => scheduleCronLabel(cron("99 10 * * *"), "zh-CN")).toThrow();
});

test("message cards show the readable rule and expose raw cron only in the tooltip", () => {
  const message: ScheduleDefinition = {
    id: "daily-message", kind: "session_message", threadId: "thread", name: "Daily reminder",
    prompt: "Daily reminder", trigger: cron("30 10 * * *"), enabled: true, maxLatenessSeconds: 0,
    source: "user", revision: 1, nextRunAt: "2026-10-24T02:30:00Z",
    createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z",
  };
  const element = createElement(ScheduledMessagesCardBody, { messages: [message], occurrences: [] });
  const chinese = renderLocalized(element, "zh-CN");
  expect(chinese).toContain('<small title="30 10 * * * · Asia/Shanghai">每天10点30分 · Asia/Shanghai</small>');
  expect(chinese).toContain('dateTime="2026-10-24T02:30:00Z"');
  expect(renderLocalized(element, "en-US")).toContain("At 10:30, every day · Asia/Shanghai");
});
