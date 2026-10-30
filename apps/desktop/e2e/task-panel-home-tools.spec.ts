import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "./fixtures/electron-app";
import { waitForEcoReady } from "./helpers/eco-page";
import { ensureTaskPanelOpen } from "./helpers/task-panel";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const test = base.extend({
  ecoPage: async ({ electronApp }, use) => {
    // The first window is a splash with no preload API; wait for the real renderer.
    const isRenderer = (page: { url(): string }) => page.url().startsWith("http://127.0.0.1:");
    await expect.poll(() => electronApp.windows().some(isRenderer), { timeout: 60_000 }).toBe(true);
    const page = electronApp.windows().find(isRenderer)!;
    await waitForEcoReady(page);
    await use(page);
  },
});

test("local new tabs replace tools in place and create a browser only after address submission", async ({
  ecoPage: page,
  electronApp,
}) => {
  await page.evaluate(async (workspacePath) => {
    await window.eco.openWorkspacePath(workspacePath);
  }, repoRoot);
  await ensureTaskPanelOpen(page);
  const home = page.locator(".subagent-task-panel-tab-pane--new.is-active .task-panel-home-actions");
  await expect(home).toBeVisible();
  const originalTabId = await page
    .locator(".subagent-task-panel-tab--new.is-active")
    .getAttribute("aria-controls");
  await expect.poll(windowBrowserIds).toEqual([]);
  await expect.poll(guestCount).toBe(0);

  for (const [label, paneId] of [
    [/审查|Review/, "review"],
    [/文件|Files/, "files"],
    [/SSH/, "ssh-bookmarks"],
    [/创意绘画|Creative Drawing/, "image-generation"],
    [/语音合成|Speech Generation/, "speech-generation"],
    [/审查|Review/, "review"],
  ] as const) {
    await page.locator(".subagent-task-panel-tab-add").click();
    await expect(home).toBeVisible();
    const sourceId = (await page
      .locator(".subagent-task-panel-tab--new.is-active")
      .getAttribute("aria-controls"))!;
    const tabsBefore = await tabControls();
    const targetId = `subagent-task-tab-${paneId}`;
    const frames = await home.getByRole("button", { name: label }).evaluate(
      (button) =>
        new Promise<string[][]>((resolve) => {
          button.click();
          const samples: string[][] = [];
          const sample = () => {
            samples.push(
              Array.from(document.querySelectorAll('.subagent-task-panel-tabs [role="tab"]')).map(
                (tab) => tab.getAttribute("aria-controls")!,
              ),
            );
            if (samples.length < 6) requestAnimationFrame(sample);
            else resolve(samples);
          };
          requestAnimationFrame(sample);
        }),
    );
    const expected = tabsBefore.includes(targetId)
      ? tabsBefore.filter((id) => id !== sourceId)
      : tabsBefore.map((id) => (id === sourceId ? targetId : id));
    // Every painted frame keeps the replaced slot; there is no intermediate tab removal.
    for (const frame of frames) expect(frame).toEqual(expected);
    await expect(page.locator(`#subagent-task-tab-${paneId}`)).toBeVisible();
    await expect.poll(windowBrowserIds).toEqual([]);
    await expect.poll(guestCount).toBe(0);
    expect(await tabControls()).toContain(originalTabId);
    await expect(page.locator(".subagent-task-panel-tab--new")).toHaveCount(1);
  }

  // Opening Files must keep the existing Review tab, and selecting Review again must reuse it.
  await expect(
    page.locator('.subagent-task-panel-tab[aria-controls="subagent-task-tab-review"]'),
  ).toHaveCount(1);
  await expect(page.locator('.subagent-task-panel-tab[aria-controls="subagent-task-tab-files"]')).toHaveCount(
    1,
  );
  await expect(
    page.locator('.subagent-task-panel-tab[aria-controls="subagent-task-tab-ssh-bookmarks"]'),
  ).toHaveCount(1);

  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<title>Local browser test</title><h1>Browser created after Enter</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.locator(".subagent-task-panel-tab-add").click();
    await expect(home).toBeVisible();
    const beforeNavigation = await tabControls();
    const sourceId = (await page
      .locator(".subagent-task-panel-tab--new.is-active")
      .getAttribute("aria-controls"))!;
    const address = page.locator(".subagent-task-panel-tab-pane--new.is-active .browser-panel-address");
    await address.fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await expect.poll(windowBrowserIds).toEqual([]);
    await address.press("Enter");
    await expect(page.locator(".subagent-task-panel-tab--browser.is-active")).toHaveCount(1);
    await expect.poll(windowBrowserIds).toHaveLength(1);
    await expect.poll(guestCount).toBe(1);
    const browserId = (await windowBrowserIds())[0];
    expect(await tabControls()).toEqual(
      beforeNavigation.map((id) => (id === sourceId ? `subagent-task-tab-browser-${browserId}` : id)),
    );
    await expect(
      page.locator(".subagent-task-panel-tab-pane--browser.is-active .browser-panel-address"),
    ).toHaveValue("127.0.0.1");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  await page.locator(".subagent-task-panel-tab-add").click();
  await expect(home).toBeVisible();
  const beforeTerminal = await windowBrowserIds();
  await home.getByRole("button", { name: /终端|Terminal/ }).click();
  await expect.poll(windowBrowserIds).toEqual(beforeTerminal);
  await expect(
    page.locator('.codex-main-toolbar-button[aria-controls="task-panel"]').first(),
  ).toHaveAttribute("aria-expanded", "false");

  async function windowBrowserIds(): Promise<string[]> {
    return page.evaluate(async () =>
      (await window.eco.getBrowserState()).instances.map((instance) => instance.id),
    );
  }

  async function tabControls(): Promise<string[]> {
    return page
      .locator('.subagent-task-panel-tabs [role="tab"]')
      .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-controls")!));
  }

  async function guestCount(): Promise<number> {
    return electronApp.evaluate(
      ({ webContents }) =>
        webContents.getAllWebContents().filter((contents) => contents.getType() === "webview").length,
    );
  }
});
