/**
 * One-off: verify dev Electron CDP can drive Eco main window UI.
 */
import { chromium } from "@playwright/test";

const cdpUrl = process.env.ECO_DEV_CDP_URL ?? "http://127.0.0.1:9333";

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No browser context from CDP");
  }
  const page = context.pages().find((p) => p.url().includes("5173")) ?? context.pages()[0];
  if (!page) {
    throw new Error("No page from CDP");
  }

  console.log("[cdp-ui] page url:", page.url());
  console.log("[cdp-ui] title:", await page.title());

  const hasEco = await page.evaluate(() => typeof window.eco !== "undefined");
  console.log("[cdp-ui] window.eco:", hasEco);
  if (!hasEco) {
    throw new Error("window.eco not ready");
  }

  const sidebarNew = page.locator("button.sidebar-action").first();
  const sidebarCount = await sidebarNew.count();
  console.log("[cdp-ui] sidebar-action buttons:", sidebarCount);

  const composer = page.locator('.composer-skill-input-control[role="textbox"]').first();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  console.log("[cdp-ui] composer visible: yes");

  await page.screenshot({ path: ".smoke-artifacts/cdp-ui-probe.png", fullPage: false });
  console.log("[cdp-ui] screenshot: apps/desktop/.smoke-artifacts/cdp-ui-probe.png");
  console.log("[cdp-ui] PASS — can read DOM and capture Mori dev UI via CDP");
} finally {
  await browser.close();
}
