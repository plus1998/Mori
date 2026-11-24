import { expect, test } from "./fixtures/electron-app";

test("new tabs reorder and stay docked while browser pages detach outside the window", async ({
  ecoPage: page,
  electronApp,
}) => {
  const panel = page.locator("#task-panel");
  await page.getByRole("button", { name: /^(打开任务侧栏|Open task sidebar)$/u }).click();
  await panel.getByRole("button", { name: /^(新标签页|New tab)$/u, exact: true }).click();
  const tabs = panel.locator('[data-task-panel-tab-id^="new-tab:"]');
  await expect(tabs).toHaveCount(2);
  const firstId = await tabs.first().getAttribute("data-task-panel-tab-id");
  if (!firstId) throw new Error("Source tab is missing");
  const first = page.locator(`[data-task-panel-tab-id="${firstId}"]`).getByRole("tab");
  const shield = page.locator("body.is-dragging-browser-tab");
  const [from, to] = await Promise.all([first.boundingBox(), tabs.last().boundingBox()]);
  if (!from || !to) throw new Error("Tabs are not visible");

  const y = from.y + from.height / 2;
  await page.mouse.move(from.x + 20, y);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 5, y, { steps: 10 });
  await page.mouse.up();
  await expect(tabs.last()).toHaveAttribute("data-task-panel-tab-id", firstId);

  const source = await first.boundingBox();
  if (!source) throw new Error("Reordered tab is not visible");
  await page.mouse.move(source.x + 20, y);
  await page.mouse.down();
  await page.mouse.move(source.x + 35, y);
  await expect(shield).toHaveCount(1);
  // Model a release that happened outside Chromium without delivering pointerup.
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointermove", {
    pointerId: 1, pointerType: "mouse", buttons: 0, clientX: 1, clientY: 1,
  })));
  await expect(shield).toHaveCount(0);
  await page.mouse.up();
  await expect(tabs.last()).toHaveAttribute("data-task-panel-tab-id", firstId);

  await page.mouse.move(source.x + 20, y);
  await page.mouse.down();
  const viewportWidth = await page.evaluate(() => innerWidth);
  await page.mouse.move(viewportWidth + 25, y, { steps: 12 });
  await expect(shield).toHaveCount(0);
  await page.mouse.up();

  await expect(tabs).toHaveCount(2);
  await expect(tabs.last()).toHaveAttribute("data-task-panel-tab-id", firstId);
  expect(await page.evaluate(async () => (await window.eco.getBrowserState()).allInstances)).toEqual([]);

  await first.click();
  const address = panel.locator(".task-panel-new-tab:visible").getByRole("textbox");
  await address.fill(new URL("/splash-icon.png", page.url()).href);
  await address.press("Enter");
  const browserTab = panel.locator('[data-task-panel-tab-id^="browser:"]').getByRole("tab");
  await expect(browserTab).toBeVisible();
  const browserId = await browserTab.evaluate(node => node.closest<HTMLElement>("[data-task-panel-tab-id]")
    ?.dataset.taskPanelTabId?.slice("browser:".length));
  if (!browserId) throw new Error("Browser id is missing");
  try {
    const loaded = await browserTab.boundingBox();
    if (!loaded) throw new Error("Browser tab is missing");
    await page.mouse.move(loaded.x + loaded.width / 2, loaded.y + loaded.height / 2);
    await page.mouse.down();
    await page.mouse.move(viewportWidth + 25, loaded.y + loaded.height / 2, { steps: 12 });
    await expect(shield).toHaveCount(0);
    await page.mouse.up();
    await expect.poll(() => electronApp.windows().filter(window => window.url().includes("browser.html?browserId="))
      .map(window => new URL(window.url()).searchParams.get("browserId"))).toEqual([browserId]);
    await expect.poll(() => page.evaluate(async id =>
      (await window.eco.getBrowserState()).allInstances.find(tab => tab.id === id)?.windowed, browserId)).toBe(true);
    await expect(tabs).toHaveCount(1);
    await page.locator('.codex-main-toolbar-button[aria-controls="task-panel"]').click();
    await expect(panel).toBeHidden();
  } finally {
    await page.evaluate(id => window.eco.browserCloseInstance({ browserId: id }), browserId);
  }
});
