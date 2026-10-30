import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-app";
import { ensureTaskPanelOpen } from "./helpers/task-panel";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("browser address editing and screenshots work together in the personal workspace", async ({
  ecoPage: page,
  electronApp,
}) => {
  test.setTimeout(120_000);
  const server = createServer((request, response) => {
    const second = request.url?.startsWith("/second");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<title>${second ? "Second" : "First"} page</title>
      <style>html,body{margin:0;width:100%;height:100%;background:${second ? "#772211" : "#114477"}}
        #reference{position:absolute;top:20px;left:20px;color:white}</style>
      <span id="reference">Selected reference text</span>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const firstUrl = `http://127.0.0.1:${port}/first?foo=bar`;
  const secondUrl = `http://127.0.0.1:${port}/second?foo=baz`;

  try {
    await page.evaluate((workspacePath) => {
      if (!window.eco) throw new Error("Desktop API unavailable");
      return window.eco.openWorkspacePath(workspacePath);
    }, repoRoot);
    await ensureTaskPanelOpen(page);
    await page.locator(".subagent-task-panel-tab-add").click();
    const newAddress = page.locator(".subagent-task-panel-tab-pane--new.is-active .browser-panel-address");
    await newAddress.fill(firstUrl);
    await newAddress.press("Enter");

    const pane = page.locator(".subagent-task-panel-tab-pane--browser.is-active");
    const address = pane.locator(".browser-panel-address");
    await expect(address).toHaveValue("127.0.0.1");
    const dockedAddressWidth = await address.evaluate((node) => node.getBoundingClientRect().width);
    const dockedCenterDifference = await address.evaluate((node) => {
      const input = node.getBoundingClientRect();
      const chromeElement = node.closest(".browser-panel-chrome");
      if (!chromeElement) throw new Error("Browser toolbar not found");
      const chrome = chromeElement.getBoundingClientRect();
      return Math.abs((input.left + input.right - chrome.left - chrome.right) / 2);
    });
    expect(dockedCenterDifference).toBeLessThan(3);
    await address.click();
    await expect(address).toHaveValue(firstUrl);
    expect(
      await address.evaluate(
        (node: HTMLInputElement) => node.selectionStart === 0 && node.selectionEnd === node.value.length,
      ),
    ).toBe(true);

    await address.fill("unsaved draft");
    await address.evaluate((node: HTMLInputElement) => node.blur());
    await expect(address).toHaveValue("127.0.0.1");
    await address.click();
    await expect(address).toHaveValue(firstUrl);

    await address.click({ button: "right" });
    await page.getByRole("menuitem", { name: /全选|Select all/i }).click();
    expect(
      await address.evaluate(
        (node: HTMLInputElement) => node.selectionStart === 0 && node.selectionEnd === node.value.length,
      ),
    ).toBe(true);

    await pane.getByRole("button", { name: /清空地址|Clear address/ }).click();
    await expect(address).toBeFocused();
    await expect(address).toHaveValue("");
    await address.fill(secondUrl);
    await address.press("Enter");
    await expect(address).toHaveValue("127.0.0.1");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          if (!window.eco) throw new Error("Desktop API unavailable");
          const state = await window.eco.getBrowserState();
          return state.instances.find((item) => item.id === state.focusedBrowserId)?.url;
        }),
      )
      .toBe(secondUrl);

    const screenshot = pane.getByRole("button", { name: /截取网页|Capture screenshot/ });
    await expect(screenshot).toBeEnabled();
    await screenshot.click();
    const gallery = page.getByRole("region", { name: /图库|Image gallery/ });
    const currentImage = gallery.locator(".image-gallery-card--current img");
    await expect(currentImage).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () =>
        currentImage.evaluate((image: HTMLImageElement) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas context unavailable");
          context.drawImage(image, 0, 0);
          const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
          if (red === undefined || green === undefined || blue === undefined)
            throw new Error("Pixel unavailable");
          return Math.max(Math.abs(red - 119), Math.abs(green - 34), Math.abs(blue - 17));
        }),
      )
      .toBeLessThanOrEqual(2);

    await address.click();
    await address.fill(firstUrl);
    await address.press("Enter");
    await expect(screenshot).toBeEnabled();
    await screenshot.click();
    await expect(gallery.getByLabel(/第 2 张，共 2 张|Image 2 of 2/)).toBeVisible();
    await expect
      .poll(async () =>
        currentImage.evaluate((image: HTMLImageElement) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas context unavailable");
          context.drawImage(image, 0, 0);
          const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
          if (red === undefined || green === undefined || blue === undefined)
            throw new Error("Pixel unavailable");
          return Math.max(Math.abs(red - 17), Math.abs(green - 68), Math.abs(blue - 119));
        }),
      )
      .toBeLessThanOrEqual(2);
    await page.screenshot({ path: "/tmp/mori-browser-toolbar-e2e.png" });

    const more = pane.getByRole("button", { name: /浏览器更多操作|More browser actions/ });
    await expect(pane.getByRole("button", { name: /选择网页元素并引用|Reference an element/ })).toBeVisible();
    await expect(
      pane.locator(".browser-panel-leading").getByRole("button", {
        name: /选择网页元素并引用|Reference an element/,
      }),
    ).toBeVisible();
    const device = pane.getByRole("button", { name: /设备视窗|Device viewport/ });
    await expect(device).toBeVisible();
    await device.click();
    await expect(pane.locator(".browser-viewport-controls")).toBeVisible();
    await device.click();
    await expect(pane.locator(".browser-viewport-controls")).toHaveCount(0);
    await more.click();
    const menu = page.getByRole("menu", { name: /浏览器更多操作|More browser actions/ });
    await expect(
      menu.getByRole("menuitem", { name: /引用网页中选中的文字|Reference selected text/ }),
    ).toBeVisible();
    await menu.getByRole("menuitem", { name: /下载记录|Downloads/ }).click();
    await expect(pane.getByRole("region", { name: /下载记录|Downloads/ })).toBeVisible();
    await more.click();
    await menu.getByRole("menuitem", { name: /下载记录|Downloads/ }).click();
    await expect(pane.getByRole("region", { name: /下载记录|Downloads/ })).toHaveCount(0);
    await more.focus();
    await more.press("Enter");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();

    await electronApp.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (!guest) throw new Error("Browser guest not found");
      guest.focus();
      await guest.executeJavaScript(`(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#reference'));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      })()`);
    }, firstUrl);
    await more.click();
    await menu.getByRole("menuitem", { name: /引用网页中选中的文字|Reference selected text/ }).click();
    await expect(page.locator(".composer-browser-selection")).toContainText("Selected reference text");

    await more.click();
    await menu.getByRole("menuitem", { name: /左右分屏|Split side by side/ }).click();
    await expect(page.locator(".browser-task-workspace.is-split")).toBeVisible();
    const splitPanes = page.locator(".subagent-task-panel-tab-pane--browser.is-active");
    await expect(splitPanes).toHaveCount(2);
    for (const splitPane of await splitPanes.all()) {
      await expect(
        splitPane.getByRole("button", { name: /选择网页元素并引用|Reference an element/ }),
      ).toBeVisible();
      await expect(splitPane.getByRole("button", { name: /设备视窗|Device viewport/ })).toBeVisible();
      const metrics = await splitPane.evaluate((element) => {
        const addressElement = element.querySelector(".browser-panel-address");
        const cameraElement = element.querySelector(
          '[aria-label="截取网页"], [aria-label="Capture screenshot"]',
        );
        const menuElement = element.querySelector(
          '[aria-label="浏览器更多操作"], [aria-label="More browser actions"]',
        );
        const chromeElement = element.querySelector(".browser-panel-chrome");
        if (!addressElement || !cameraElement || !menuElement || !chromeElement) {
          throw new Error("Browser toolbar controls not found");
        }
        const address = addressElement.getBoundingClientRect();
        const camera = cameraElement.getBoundingClientRect();
        const menuButton = menuElement.getBoundingClientRect();
        const chrome = chromeElement.getBoundingClientRect();
        return {
          addressWidth: address.width,
          rowDifference: Math.abs(address.top - camera.top),
          menuDifference: Math.abs(camera.top - menuButton.top),
          rightGap: chrome.right - menuButton.right,
        };
      });
      expect(metrics.addressWidth).toBeGreaterThan(40);
      expect(metrics.rowDifference).toBeLessThan(4);
      expect(metrics.menuDifference).toBeLessThan(4);
      expect(metrics.rightGap).toBeLessThan(12);
    }
    const focusedPane = page.locator(".subagent-task-panel-tab-pane--browser.is-focused");
    await focusedPane.getByRole("button", { name: /浏览器更多操作|More browser actions/ }).click();
    await menu.getByRole("menuitem", { name: /退出分屏|Exit split view/ }).click();
    await expect(page.locator(".browser-task-workspace.is-split")).toHaveCount(0);

    await page.getByRole("button", { name: /全屏显示任务面板|Show task panel full screen/ }).click();
    await expect(page.locator(".codex-main-pane.is-task-panel-fullscreen")).toBeVisible();
    await expect
      .poll(() => address.evaluate((node) => node.getBoundingClientRect().width))
      .toBeGreaterThan(dockedAddressWidth);
    const addressStyle = await address.evaluate((node) => {
      const input = node.getBoundingClientRect();
      const chromeElement = node.closest(".browser-panel-chrome");
      if (!chromeElement) throw new Error("Browser toolbar not found");
      const chrome = chromeElement.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        centerDifference: Math.abs((input.left + input.right - chrome.left - chrome.right) / 2),
        textAlign: style.textAlign,
        radius: Number.parseFloat(style.borderTopLeftRadius),
      };
    });
    expect(addressStyle.centerDifference).toBeLessThan(3);
    expect(addressStyle.textAlign).toBe("center");
    expect(addressStyle.radius).toBeGreaterThanOrEqual(14);
    await gallery
      .locator(".image-gallery-card--current .image-gallery-card-media")
      .click({ position: { x: 10, y: 10 } });
    await expect(page.getByRole("dialog", { name: /图片预览|Image preview/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await screenshot.click();
    await expect(gallery.getByLabel(/第 3 张，共 3 张|Image 3 of 3/)).toBeVisible();
    await page.screenshot({ path: "/tmp/mori-browser-toolbar-fullscreen-e2e.png" });

    await page.getByRole("button", { name: /退出全屏任务面板|Exit full-screen task panel/ }).click();
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!window) throw new Error("Application window not found");
      window.setMinimumSize(600, 600);
      window.setSize(700, 750);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(720);
    await gallery
      .locator(".image-gallery-card--current .image-gallery-card-media")
      .click({ position: { x: 10, y: 10 } });
    await expect(page.getByRole("dialog", { name: /图片预览|Image preview/ })).toBeVisible();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
