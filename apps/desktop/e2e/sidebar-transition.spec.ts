import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

function fixtureUrl(): string {
  const rendererUrl = process.env.ECO_SIDEBAR_TRANSITION_TEST_URL ??
    JSON.parse(readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8")).rendererUrl;
  return new URL("/e2e/fixtures/sidebar-transition.html", rendererUrl).href;
}

test("already-visible selection does not starve history transitions when summaries rebase", async ({ page }) => {
  await page.goto(fixtureUrl());
  await page.getByRole("button", { name: "Receive event and open history" }).click();
  await expect(page.getByLabel("History")).toHaveText("History ready", { timeout: 2_000 });
});

test("search reveals the needed page and returning preserves expanded pages", async ({ page }) => {
  await page.goto(fixtureUrl());
  await page.getByRole("button", { name: "Open search result" }).click();
  await expect(page.getByLabel("Visible count")).toHaveText("30");
  await page.getByRole("button", { name: "Return to first page" }).click();
  await expect(page.getByLabel("Visible count")).toHaveText("30");
  await page.getByRole("button", { name: "Receive event and open history" }).click();
  await expect(page.getByLabel("History")).toHaveText("History ready", { timeout: 2_000 });
});
