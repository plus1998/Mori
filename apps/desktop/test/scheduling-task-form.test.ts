import { expect, test } from "bun:test";
import { translateCatalog } from "../src/shared/i18n-catalogs";
import { filterSchedulingProjects, projectDisplayName } from "../src/renderer/SchedulingProjectField";
import { scheduleIntervalLabel, scheduleTriggerFor } from "../src/renderer/schedule-form";

const projects = [
  { path: "/work/eco-coding", name: "eco-coding" },
  { path: "/work/notes", name: "notes" },
  { path: "/work/vendor/eco-server", name: "vendor-eco-server" },
];

test("intervals render in the largest whole unit instead of raw minutes", () => {
  const tenHours = scheduleIntervalLabel(600 * 60);
  expect(translateCatalog("zh-CN", tenHours.key, tenHours.options)).toBe("每 10 小时");
  expect(translateCatalog("en-US", tenHours.key, tenHours.options)).toBe("Every 10 hours");
  const threeDays = scheduleIntervalLabel(3 * 86_400);
  expect(translateCatalog("zh-CN", threeDays.key, threeDays.options)).toBe("每 3 天");
  const minutes = scheduleIntervalLabel(90 * 60);
  expect(translateCatalog("zh-CN", minutes.key, minutes.options)).toBe("每 90 分钟");
});

test("the interval field unit converts into the saved trigger seconds", () => {
  const trigger = scheduleTriggerFor({
    triggerType: "interval", at: "2026-01-01T00:00:00.000Z", interval: { amount: "10", unit: "hours" },
    cron: "", timezone: "UTC", catchUp: { amount: "24", unit: "hours" },
  });
  expect(trigger).toEqual({ type: "interval", everySeconds: 36_000, anchorAt: "2026-01-01T00:00:00.000Z" });
});

test("project search matches names before paths and keeps the caller order", () => {
  expect(filterSchedulingProjects(projects, "ECO").map((project) => project.path)).toEqual([
    "/work/eco-coding",
    "/work/vendor/eco-server",
  ]);
  expect(filterSchedulingProjects(projects, "/work/vendor").map((project) => project.path)).toEqual([
    "/work/vendor/eco-server",
  ]);
  expect(filterSchedulingProjects(projects, "missing")).toEqual([]);
  expect(filterSchedulingProjects(projects, "").length).toBe(projects.length);
});

test("a task directory outside the project list still shows a readable name", () => {
  expect(projectDisplayName(projects, "/work/notes")).toBe("notes");
  expect(projectDisplayName(projects, "/srv/backups")).toBe("backups");
});
