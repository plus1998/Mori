import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

function fixtureUrl(query = ""): string {
  const rendererUrl =
    process.env.ECO_ACCOUNT_FEEDBACK_TEST_URL ??
    JSON.parse(readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8")).rendererUrl;
  return new URL(`/e2e/fixtures/account-feedback.html${query}`, rendererUrl).href;
}

test("catalog and connection retries replace their earlier errors in both panel and dialogs", async ({
  page,
}) => {
  await page.goto(fixtureUrl());
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  const connection = page.getByRole("dialog");
  await connection.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "model refresh failed" })).toHaveCount(2);
  await connection.getByRole("button", { name: "Close", exact: true }).last().click();

  await page.getByRole("button", { name: "Models & pricing" }).click();
  const catalog = page.getByRole("dialog");
  await expect(catalog.getByRole("alert")).toContainText("model refresh failed");
  await catalog.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(catalog.getByRole("alert")).toHaveCount(0);
  await catalog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await connection.getByRole("button", { name: "Send hi", exact: true }).click();
  await expect(connection.getByRole("status")).toHaveText("connection failed");
  await expect(page.getByRole("alert")).toHaveText("account list unavailable");
  await connection.getByRole("button", { name: "Send hi", exact: true }).click();
  await expect(connection.getByRole("status")).toHaveText("connection succeeded");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(connection.locator(".chatgpt-notice")).toHaveCount(1);
  await connection.getByRole("combobox").selectOption("second");
  await expect(connection.getByRole("status")).toHaveCount(0);
});

test("a delayed model-read failure cannot overwrite a newer successful refresh", async ({ page }) => {
  await page.goto(fixtureUrl("?late-load"));
  await page.getByRole("button", { name: "Models & pricing" }).click();
  const catalog = page.getByRole("dialog");
  await catalog.getByRole("button", { name: "Refresh", exact: true }).click();
  await catalog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Deliver delayed failure" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
