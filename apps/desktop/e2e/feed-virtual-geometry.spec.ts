import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

function fixtureUrl(): string {
  const rendererUrl =
    process.env.ECO_FEED_GEOMETRY_TEST_URL ??
    JSON.parse(readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8")).rendererUrl;
  return new URL("/e2e/fixtures/feed-virtual-geometry.html", rendererUrl).href;
}

async function geometry(page: Page, frames = 60) {
  return page.evaluate(async (count) => {
    const element = document.querySelector<HTMLElement>(".activity-messages");
    if (!element) throw new Error("Missing Feed scroll element");
    const model = document.querySelector("output");
    if (!model) throw new Error("Missing virtual model size");
    const values: { top: number; height: number; gap: number; model: number }[] = [];
    for (let index = 0; index < count; index += 1) {
      await new Promise(requestAnimationFrame);
      values.push({
        top: element.scrollTop,
        height: element.scrollHeight,
        gap: element.scrollHeight - element.clientHeight - element.scrollTop,
        model: Number(model.textContent),
      });
    }
    return values;
  }, frames);
}

function expectStable(values: Awaited<ReturnType<typeof geometry>>, following: boolean) {
  const settled = values.slice(-30);
  expect(Math.max(...settled.map((v) => v.top)) - Math.min(...settled.map((v) => v.top))).toBeLessThanOrEqual(
    1,
  );
  expect(new Set(settled.map((v) => v.height)).size).toBe(1);
  for (const value of settled) {
    if (following) expect(Math.abs(value.gap)).toBeLessThanOrEqual(1);
  }
}

test("unmeasured tall rows cannot change scroll extent or trigger an end-follow loop", async ({ page }) => {
  await page.goto(fixtureUrl());
  expectStable(await geometry(page), true);
  await expect(page.locator('.run-log-virtual-row[data-index="34"]')).toBeAttached();
  await page.getByRole("button", { name: "Hold measurements" }).click();
  const before = (await geometry(page, 1))[0];
  if (!before) throw new Error("Missing geometry sample");
  await page.getByRole("button", { name: "Toggle tall content" }).click();
  const unmeasured = await geometry(page);
  expect(unmeasured.every((value) => value.height === before.height)).toBe(true);
  expect(unmeasured.every((value) => Math.abs(value.height - value.model) <= 1)).toBe(true);
  await expect(page.locator('.run-log-virtual-row[data-index="34"]')).toBeAttached();
  await page.getByRole("button", { name: "Deliver measurements" }).click();
  expectStable(await geometry(page), true);
  for (const action of [
    "Toggle width",
    "Toggle terminal height",
    "Toggle tall content",
    "Toggle width",
    "Toggle terminal height",
  ]) {
    await page.getByRole("button", { name: action }).click();
    expectStable(await geometry(page), true);
  }
});

test("history navigation and delayed reflow settle without pulling the reader to the end", async ({
  page,
}) => {
  await page.goto(fixtureUrl());
  expectStable(await geometry(page), true);
  await page.getByRole("button", { name: "Read history" }).click();
  await page.locator(".activity-messages").focus();
  await page.keyboard.press("Home");
  const history = await geometry(page);
  expectStable(history, false);
  expect(history.at(-1)?.top).toBe(0);
  await page.getByRole("button", { name: "Toggle width" }).click();
  const resized = await geometry(page);
  expectStable(resized, false);
  expect(resized.at(-1)?.top).toBe(0);
  await page.locator(".activity-messages").focus();
  await page.keyboard.press("End");
  await geometry(page);
  await page.getByRole("button", { name: "Follow end" }).click();
  expectStable(await geometry(page), true);
});

test("live growth, append and completion shrink preserve the end and a detached reader", async ({ page }) => {
  await page.goto(fixtureUrl());
  expectStable(await geometry(page), true);
  for (const action of ["Toggle live content", "Append row", "Toggle live content", "Append row"]) {
    await page.getByRole("button", { name: action }).click();
    expectStable(await geometry(page), true);
  }
  await page.getByRole("button", { name: "Read history" }).click();
  await page.locator(".activity-messages").focus();
  await page.keyboard.press("PageUp");
  const history = (await geometry(page)).at(-1);
  if (!history) throw new Error("Missing history sample");
  expect(history.gap).toBeGreaterThan(120);
  await page.getByRole("button", { name: "Append row" }).click();
  const appended = await geometry(page);
  expectStable(appended, false);
  expect(appended.at(-1)?.top).toBe(history.top);
  await page.getByRole("button", { name: "Follow end" }).click();
  expectStable(await geometry(page), true);
});
