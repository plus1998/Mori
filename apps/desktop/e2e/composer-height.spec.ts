import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const rendererUrl = process.env.ECO_COMPOSER_TEST_URL ??
    JSON.parse(readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8")).rendererUrl;
  await page.goto(new URL("/e2e/fixtures/composer-height.html", rendererUrl).href);
});

test("editing a multiline Composer does not clamp its sibling Feed's reading position", async ({ page }) => {
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

for (const { name, line, count } of [
  { name: "plain text", line: "Draft line", count: 10 },
  { name: "chunked text", line: "Long draft ".repeat(43), count: 20 },
  { name: "large multiline text", line: "Long draft line", count: 1200 },
]) {
  test(`Composer follows consecutive trailing line breaks in ${name}`, async ({ page }) => {
    const composer = page.getByRole("textbox");
    const draft = Array.from({ length: count }, () => line).join("\n");
    await composer.fill(draft);
    await composer.evaluate(async (node, end) => {
      const path = "/src/renderer/composer-skills-editable.ts";
      (await import(/* @vite-ignore */ path)).setSelectionOffsets(node, end, end);
      node.scrollTop = node.scrollHeight;
    }, draft.length);

    for (let index = 0; index < 2; index += 1) {
      const before = await composer.evaluate((node) => node.scrollTop);
      await composer.press("Shift+Enter");
      const { scrollTop, remaining } = await composer.evaluate((node) => ({
        scrollTop: node.scrollTop,
        remaining: node.scrollHeight - node.clientHeight - node.scrollTop,
      }));
      expect(scrollTop).toBeGreaterThan(before);
      expect(remaining).toBeLessThanOrEqual(2);
    }

    await composer.press("x");
    const value = await page.getByTestId("draft-value").evaluate((node) => node.textContent);
    expect(value === `${draft}\n\nx`).toBe(true);
  });
}

test("Composer reveals a line break in the middle of a draft while the Feed stays put", async ({ page }) => {
  const composer = page.getByRole("textbox");
  const feed = page.getByTestId("feed");
  const draft = Array.from({ length: 20 }, () => "Draft line").join("\n");
  await composer.fill(draft);
  await composer.evaluate((node) => {
    window.getSelection()?.collapse(node.firstChild, 9 * "Draft line\n".length + 6);
    node.scrollTop = 0;
  });
  const before = await feed.evaluate((node) => {
    node.scrollTop = 400;
    return node.scrollTop;
  });

  await composer.press("Shift+Enter");
  const { scrollTop, caretBottom, visibleBottom } = await composer.evaluate((node) => ({
    scrollTop: node.scrollTop,
    caretBottom: window.getSelection()!.getRangeAt(0).getBoundingClientRect().bottom,
    visibleBottom: node.getBoundingClientRect().top + node.clientHeight,
  }));
  expect(scrollTop).toBeGreaterThan(0);
  expect(caretBottom).toBeCloseTo(visibleBottom, 0);
  expect(await feed.evaluate((node) => node.scrollTop)).toBe(before);
});
