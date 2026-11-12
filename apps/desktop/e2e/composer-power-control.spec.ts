import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

function fixtureUrl(query = "?fullEfforts") {
  const rendererUrl =
    process.env.ECO_MAIN_MODEL_PICKER_TEST_URL ??
    JSON.parse(readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8")).rendererUrl;
  return new URL(`/e2e/fixtures/main-model-picker.html${query}`, rendererUrl).href;
}
const saves = (page: Page) =>
  page.evaluate(() => (window as unknown as { pickerSelections(): number }).pickerSelections());
async function open(page: Page) {
  await page.goto(fixtureUrl());
  await page.locator(".composer-model-trigger").click();
  await expect(page.getByRole("slider")).toBeEnabled();
}

test("drag follows the pointer continuously and saves the nearest level only on release", async ({
  page,
}) => {
  await open(page);
  const range = page.getByRole("slider");
  await range.focus();
  await range.press("Home");
  const count = await saves(page);
  await expect
    .poll(async () => {
      const bounds = await range.boundingBox();
      const thumb = await page.locator(".composer-power-thumb-position").boundingBox();
      return thumb && bounds ? thumb.x + thumb.width / 2 - bounds.x : -1;
    })
    .toBeCloseTo(13, 0);
  const box = await range.boundingBox();
  if (!box) throw new Error("Missing slider");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 13, y);
  await page.mouse.down();
  const x = box.x + 13 + (box.width - 26) * 0.413;
  await page.mouse.move(x, y, { steps: 8 });
  await expect(range).toHaveValue("2");
  await expect(page.locator(".composer-power-rail")).toHaveAttribute("data-dragging", "true");
  const thumb = await page.locator(".composer-power-thumb-position").boundingBox();
  expect(thumb && thumb.x + thumb.width / 2).toBeCloseTo(x, 0);
  expect(await saves(page)).toBe(count);
  await page.mouse.up();
  await expect.poll(() => saves(page)).toBe(count + 1);
  await expect
    .poll(async () => {
      const settled = await page.locator(".composer-power-thumb-position").boundingBox();
      return settled ? settled.x + settled.width / 2 : -1;
    })
    .toBeCloseTo(box.x + 13 + (box.width - 26) * 0.4, 0);
});

test("pointer cancellation restores the committed level without saving", async ({ page }) => {
  await open(page);
  const range = page.getByRole("slider");
  await range.focus();
  await range.press("Home");
  const count = await saves(page);
  const box = await range.boundingBox();
  if (!box) throw new Error("Missing slider");
  await page.mouse.move(box.x + box.width * 0.8, box.y + 16);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 13, box.y + 16);
  await expect(range).toHaveValue("5");
  await range.dispatchEvent("pointercancel");
  await page.mouse.up();
  await expect(range).toHaveValue("0");
  expect(await saves(page)).toBe(count);
  await expect(page.locator(".composer-power-rail")).toHaveAttribute("data-pointer-down", "false");
});

test("drag coordinates respect a scaled popup and Escape cancels the preview", async ({ page }) => {
  await open(page);
  const range = page.getByRole("slider");
  await range.press("Home");
  await page.locator(".composer-main-model-picker").evaluate((panel) => {
    panel.style.animation = "none";
    panel.style.transform = "scale(.8)";
  });
  const count = await saves(page);
  const box = await range.boundingBox();
  if (!box) throw new Error("Missing slider");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 13 * 0.8, y);
  await page.mouse.down();
  const x = box.x + 13 * 0.8 + (box.width - 26 * 0.8) * 0.72;
  await page.mouse.move(x, y, { steps: 5 });
  await expect(range).toHaveValue("4");
  const thumb = await page.locator(".composer-power-thumb-position").boundingBox();
  expect(thumb && thumb.x + thumb.width / 2).toBeCloseTo(x, 0);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(range).toBeVisible();
  await expect(range).toHaveValue("0");
  expect(await saves(page)).toBe(count);
});

test("Fast uses separate filled and outlined icons and interrupts mode transitions cleanly", async ({
  page,
}) => {
  await open(page);
  const fast = page.getByRole("button", { name: "Fast", exact: true });
  const control = page.locator(".composer-power-control");
  const outline = await fast.locator("path").getAttribute("d");
  await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", "true");
  expect(await fast.locator("path").getAttribute("d")).not.toBe(outline);
  await expect(control).toHaveAttribute("data-fast-phase", "entering");
  await fast.click();
  await expect(control).toHaveAttribute("data-fast-phase", "exiting");
  await fast.click();
  await expect(control).toHaveAttribute("data-fast-phase", "active", { timeout: 3000 });
  await expect(page.locator(".composer-power-particles")).toHaveCSS("opacity", "1");
  await expect(page.locator(".composer-power-particles > span").first()).toHaveCSS(
    "animation-play-state",
    "running",
  );
  await expect(page.locator(".composer-power-ticks > span[data-filled=true]").first()).toHaveCSS(
    "opacity",
    "0",
  );
  await page.getByRole("slider").press("End");
  await expect(control).toHaveAttribute("data-maximum", "true");
  await expect(fast).toHaveCSS("color", "rgb(146, 79, 247)");
  await page.getByRole("slider").press("Home");
  await expect(fast).toHaveCSS("color", "rgb(2, 133, 255)");
});

test("track clicks and keyboard changes commit once and keep Fast enabled", async ({ page }) => {
  await open(page);
  const range = page.getByRole("slider");
  const fast = page.getByRole("button", { name: "Fast", exact: true });
  await fast.click();
  const count = await saves(page);
  await range.click({ position: { x: 1, y: 16 } });
  await expect(range).toHaveValue("0");
  await expect.poll(() => saves(page)).toBe(count + 1);
  await range.press("End");
  await expect(range).toHaveValue("5");
  await expect.poll(() => saves(page)).toBe(count + 2);
  await range.press("ArrowLeft");
  await expect(range).toHaveValue("4");
  await expect.poll(() => saves(page)).toBe(count + 3);
  await expect(fast).toHaveAttribute("aria-pressed", "true");
});

test("reduced motion skips particle, tick and thumb-scale animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  const control = page.locator(".composer-power-control");
  const fast = page.getByRole("button", { name: "Fast", exact: true });
  await fast.click();
  await expect(control).toHaveAttribute("data-fast-phase", "active");
  await expect(page.locator(".composer-power-particles")).toHaveCSS("display", "none");
  await expect(page.locator(".composer-power-ticks > span").first()).toHaveCSS("animation-name", "none");
  await page.getByRole("slider").hover();
  await expect(page.locator(".composer-power-thumb")).toHaveCSS("transform", "none");
  await fast.click();
  await expect(control).toHaveAttribute("data-fast-phase", "inactive");
});

for (const theme of ["light", "dark"]) {
  test(`control geometry stays inside the narrow ${theme} picker`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const track = page.locator(".composer-power-track");
    const range = page.getByRole("slider");
    await expect(track).toHaveCSS("height", "24px");
    await expect(track).toHaveCSS("border-radius", "12px");
    await range.press("End");
    const geometry = await page.locator(".composer-power-control").evaluate((control) => {
      const bounds = control.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, overflow: control.scrollWidth > control.clientWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(360);
    expect(geometry.overflow).toBe(false);
  });
}
