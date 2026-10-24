import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("editing a multiline Composer does not clamp its sibling Feed's reading position", async ({ page }) => {
  const rendererUrl = process.env.ECO_COMPOSER_TEST_URL ??
    JSON.parse(readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8")).rendererUrl;
  await page.goto(new URL("/e2e/fixtures/composer-height.html", rendererUrl).href);
  const composer = page.getByRole("textbox");
  const feed = page.getByTestId("feed");
  await expect(composer).toBeVisible();
  await composer.focus();
  await composer.press("End");
  const before = await feed.evaluate((node) => {
    node.scrollTop = node.scrollHeight - node.clientHeight - 60;
    return node.scrollTop;
  });
  for (let index = 0; index < 5; index += 1) await composer.press("Backspace");
  expect(await feed.evaluate((node) => node.scrollTop)).toBeCloseTo(before, 0);

  await composer.fill(Array.from({ length: 20 }, () => "Long draft").join("\n"));
  expect(await composer.evaluate((node) => node.clientHeight)).toBe(200);
  expect(await composer.evaluate((node) => node.scrollHeight)).toBeGreaterThan(200);
  await composer.fill("One line");
  expect(await composer.evaluate((node) => node.clientHeight)).toBe(28);
});
