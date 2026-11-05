import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

function fixtureUrl(query = ""): string {
  const rendererUrl = process.env.ECO_MAIN_MODEL_PICKER_TEST_URL ??
    JSON.parse(readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8")).rendererUrl;
  return new URL(`/e2e/fixtures/main-model-picker.html${query}`, rendererUrl).href;
}

test("read-only picker allows browsing without saving or changing model settings", async ({ page }) => {
  await page.goto(fixtureUrl("?readOnly"));
  await page.locator(".composer-model-trigger").click();
  await expect(page.getByRole("button", { name: "Login local model", exact: true })).toBeDisabled();
  await expect(page.getByRole("slider")).toBeDisabled();
  await expect(page.locator(".composer-main-model-picker-add-provider")).toHaveCount(0);
  await page.getByRole("button", { name: "ChatGPT OAuth", exact: true }).click();
  await page.getByRole("button", { name: "Local OAuth account", exact: true }).click();
  await expect(page.getByRole("button", { name: "OAuth local model", exact: true })).toBeDisabled();
  await page.locator(".composer-main-model-picker-search input").fill("OAuth");
  expect(await page.evaluate(() => (window as unknown as { pickerSelections(): number }).pickerSelections())).toBe(0);
});

test("read-only ACP picker blocks mouse and keyboard commits", async ({ page }) => {
  await page.goto(fixtureUrl("?readOnly&acp"));
  await page.locator(".composer-acp-model-trigger").click();
  await expect(page.locator(".model-cascade-model-item")).toBeDisabled();
  await expect(page.locator(".model-cascade-clear")).toBeDisabled();
  await page.locator(".model-cascade-search input").fill("GPT");
  await page.locator(".model-cascade-search input").press("Enter");
  expect(await page.evaluate(() => (window as unknown as { pickerSelections(): number }).pickerSelections())).toBe(0);
});

for (const pending of ["custom", "oauth-accounts"]) {
  test(`Login local models do not wait for pending ${pending}`, async ({ page }) => {
    await page.goto(fixtureUrl(`?pending=${pending}`));
    await page.locator(".composer-model-trigger").click();
    await expect(page.getByRole("button", { name: "Login local model", exact: true })).toBeVisible();
  });
}

test("OAuth uses its local catalog and switching sources never retains a remote loading state", async ({ page }) => {
  await page.goto(fixtureUrl());
  await page.locator(".composer-model-trigger").click();
  await page.getByRole("button", { name: "ChatGPT OAuth", exact: true }).click();
  await page.getByRole("button", { name: "Local OAuth account", exact: true }).click();
  await expect(page.getByRole("button", { name: "OAuth local model", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { pickerRemoteModelReads(): number }).pickerRemoteModelReads())).toBe(0);
  await page.getByRole("button", { name: "ChatGPT Login", exact: true }).click();
  await page.getByRole("button", { name: /^Local Login account/ }).click();
  await expect(page.getByRole("button", { name: "Login local model", exact: true })).toBeVisible();
});

test("an OAuth catalog failure is visible without blocking the Login catalog", async ({ page }) => {
  await page.goto(fixtureUrl("?pending=oauth-models"));
  await page.locator(".composer-model-trigger").click();
  await expect(page.getByRole("button", { name: "Login local model", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ChatGPT OAuth", exact: true }).click();
  await page.getByRole("button", { name: "Local OAuth account", exact: true }).click();
  await expect(page.locator(".composer-main-model-picker-models")).toContainText("Loading");
  await page.getByRole("button", { name: "ChatGPT Login", exact: true }).click();
  await page.getByRole("button", { name: /^Local Login account/ }).click();
  await expect(page.getByRole("button", { name: "Login local model", exact: true })).toBeVisible();
  // Keyboard activation delivers the delayed failure without an outside pointer closing the panel.
  await page.getByRole("button", { name: "Fail OAuth catalog", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("OAuth catalog read failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Login local model", exact: true })).toBeVisible();
});

test("reopening retains already loaded local models while a new disk read is pending", async ({ page }) => {
  await page.goto(fixtureUrl());
  const trigger = page.locator(".composer-model-trigger");
  await trigger.click();
  await expect(page.getByRole("button", { name: "Login local model", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hold catalog reads", exact: true }).click();
  await trigger.click();
  await expect(page.getByRole("button", { name: "Login local model", exact: true })).toBeVisible();
});
