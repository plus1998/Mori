import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "./fixtures/electron-app";
import { waitForEcoReady } from "./helpers/eco-page";
import { ensureTaskPanelOpen } from "./helpers/task-panel";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const test = base.extend({
  ecoPage: async ({ electronApp }, use) => {
    const isRenderer = (page: { url(): string }) => page.url().startsWith("http://127.0.0.1:");
    await expect.poll(() => electronApp.windows().some(isRenderer), { timeout: 60_000 }).toBe(true);
    const page = electronApp.windows().find(isRenderer)!;
    await waitForEcoReady(page);
    await use(page);
  },
});

/**
 * A stale `revealBrowserId` used to drag the work panel back to the previous browser
 * tab as soon as the new tab's guest was created, so opening B left A active.
 */
test("opening a second browser tab keeps the new tab active", async ({ ecoPage: page }) => {
  test.setTimeout(180_000);

  const bodies: Record<string, string> = {
    a: "<title>Tab A</title><h1>A</h1>",
    b: "<title>Tab B</title><h1>B</h1>",
  };
  const server = createServer((request, response) => {
    const name = (request.url ?? "").replace(/^\//, "") || "a";
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(bodies[name] ?? bodies.a);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    await page.evaluate(async (workspacePath) => {
      await window.eco.openWorkspacePath(workspacePath);
    }, repoRoot);
    await ensureTaskPanelOpen(page);

    // Step 1 — an existing browser tab A.
    await openBrowserTab(page, `http://127.0.0.1:${port}/a`);
    const idsAfterA = await browserIds(page);
    expect(idsAfterA).toHaveLength(1);
    const tabA = idsAfterA[0]!;
    expect(await activeTabControl(page)).toBe(`subagent-task-tab-browser-${tabA}`);

    // Step 2 — the start page becomes tab B, and B stays the active tab.
    await openBrowserTab(page, `http://127.0.0.1:${port}/b`);
    const idsAfterB = await browserIds(page);
    expect(idsAfterB).toHaveLength(2);
    const tabB = idsAfterB.find((id) => id !== tabA)!;

    await expect
      .poll(() => page.evaluate(async () => (await window.eco.getBrowserState()).focusedBrowserId))
      .toBe(tabB);
    expect(await activeTabControl(page)).toBe(`subagent-task-tab-browser-${tabB}`);
    await expect(page.locator(".subagent-task-panel-tab-pane--browser.is-active")).toHaveCount(1);
    await expect(
      page.locator(".subagent-task-panel-tab-pane--browser.is-active .browser-panel-address"),
    ).toHaveValue("127.0.0.1");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function activeTabControl(page: import("@playwright/test").Page): Promise<string | null> {
  return page
    .locator('.subagent-task-panel-tabs [role="tab"].is-active')
    .first()
    .getAttribute("aria-controls");
}

async function openBrowserTab(page: import("@playwright/test").Page, url: string): Promise<void> {
  await page.locator(".subagent-task-panel-tab-add").click();
  await expect(page.locator(".subagent-task-panel-tab-pane--new.is-active")).toBeVisible();
  const address = page.locator(".subagent-task-panel-tab-pane--new.is-active .browser-panel-address");
  await address.fill(url);
  await address.press("Enter");
  await expect(page.locator('.subagent-task-panel-tabs [role="tab"].is-active')).toHaveCount(1);
}

async function browserIds(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(async () => (await window.eco.getBrowserState()).instances.map((i) => i.id));
}
