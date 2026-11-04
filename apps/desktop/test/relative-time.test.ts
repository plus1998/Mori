import { expect, test } from "bun:test";
import { formatRelativeTime } from "../src/renderer/relative-time";

const now = Date.parse("2026-07-24T12:00:00.000Z");

test("relative time renders Chinese and English units", () => {
  expect(formatRelativeTime("2026-07-24T11:59:45.000Z", now, "zh-CN")).toBe("刚刚");
  expect(formatRelativeTime("2026-07-24T11:45:00.000Z", now, "zh-CN")).toBe("15分钟前");
  expect(formatRelativeTime("2026-07-23T12:00:00.000Z", now, "zh-CN")).toBe("1天前");
  expect(formatRelativeTime("2026-07-14T12:00:00.000Z", now, "zh-CN")).toBe("1周前");
  expect(formatRelativeTime("2026-05-24T12:00:00.000Z", now, "zh-CN")).toBe("2个月前");
  expect(formatRelativeTime("2025-07-24T12:00:00.000Z", now, "zh-CN")).toBe("1年前");
  expect(formatRelativeTime("2026-07-24T10:00:00.000Z", now, "en-US")).toBe("2 hours ago");
  expect(formatRelativeTime("2026-07-14T12:00:00.000Z", now, "en-US")).toBe("1 week ago");
  expect(formatRelativeTime(new Date(now - 360 * 86_400_000).toISOString(), now, "zh-CN")).toBe("12个月前");
});

test("relative time preserves invalid input behavior", () => {
  expect(formatRelativeTime("not-a-date", now, "en-US")).toBe("");
});
