/**
 * CDP smoke: PI Web Search settings UI + IPC (Integrated + model native toggle).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.ECO_DEV_CDP_URL ?? "http://127.0.0.1:9344";
const outDir = "/tmp/eco-web-search-settings-smoke";
mkdirSync(outDir, { recursive: true });

const failures = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.error("[web-search-smoke] FAIL:", message);
    return false;
  }
  console.log("[web-search-smoke] OK:", message);
  return true;
}

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const context = browser.contexts()[0];
  const page = context?.pages().find((p) => p.url().includes("5173")) ?? context?.pages()[0];
  if (!page) {
    throw new Error("No Mori page from CDP");
  }

  console.log("[web-search-smoke] page:", page.url());
  await page.waitForFunction(() => typeof window.eco !== "undefined", undefined, { timeout: 30_000 });

  const ipc = await page.evaluate(async () => {
    const eco = window.eco;
    if (!eco?.getIntegratedWebSearchSettings) {
      return { hasIntegratedApi: false };
    }
    const settings = await eco.getIntegratedWebSearchSettings();
    return {
      hasIntegratedApi: true,
      settings,
    };
  });
  assert(ipc.hasIntegratedApi, "preload exposes getIntegratedWebSearchSettings");
  assert(
    ipc.settings?.provider === "brave" ||
      ipc.settings?.provider === "tavily" ||
      ipc.settings?.provider === "doubao" ||
      ipc.settings?.provider === "deepseek",
    "integrated provider is brave, tavily, doubao, or deepseek",
  );
  assert(typeof ipc.settings?.enabled === "boolean", "integrated settings has enabled boolean");
  assert(typeof ipc.settings?.hasApiKey === "boolean", "integrated settings has hasApiKey boolean");

  const settingsBtn = page.locator("button.sidebar-settings-action").first();
  const settingsPage = page.locator(".settings-page");
  if (await settingsPage.isVisible().catch(() => false)) {
    assert(true, "settings already open from prior run");
  } else {
    await settingsBtn.waitFor({ state: "visible", timeout: 15_000 });
    await settingsBtn.click();
    await settingsPage.waitFor({ state: "visible", timeout: 10_000 });
    assert(true, "opened settings via sidebar");
  }

  const webSearchNav = page.getByRole("button", { name: /网络搜索|Web Search/i });
  await webSearchNav.waitFor({ state: "visible", timeout: 10_000 });
  await webSearchNav.click();

  const integratedSection = page.locator(".models-integrated-web-search-section");
  await integratedSection.waitFor({ state: "visible", timeout: 10_000 });
  assert(await integratedSection.isVisible(), "Integrated Web Search section visible on Web Search settings page");

  const pageTitle = page.getByRole("heading", { name: /网络搜索|Web Search/i });
  assert(await pageTitle.first().isVisible(), "Web Search page title visible");

  const integratedLabel = page.getByText(/Enable Web Search|启用网络搜索/i);
  assert(await integratedLabel.first().isVisible(), "Web Search enable label visible");

  // Native Web Search checkbox lives on provider/model spec, not this page.
  const providersNav = page.getByRole("button", { name: /提供商|Provider/i });
  if (await providersNav.first().isVisible().catch(() => false)) {
    await providersNav.first().click();
  }
  const nativeCheckbox = page.getByText(/Provider 原生 Web Search|Provider-native Web Search/i);
  const nativeVisible = await nativeCheckbox.first().isVisible().catch(() => false);
  if (!nativeVisible) {
    console.log("[web-search-smoke] SKIP: native web search checkbox not on providers root (open candidate model manually if needed)");
  } else {
    assert(true, "Provider native Web Search label visible in model spec area");
  }

  await page.screenshot({ path: path.join(outDir, "cdp-web-search-settings.png"), fullPage: false });
  console.log("[web-search-smoke] screenshot:", path.join(outDir, "cdp-web-search-settings.png"));

  if (failures.length > 0) {
    throw new Error(`${failures.length} assertion(s) failed:\n- ${failures.join("\n- ")}`);
  }
  console.log("[web-search-smoke] PASS");
} finally {
  await browser.close();
}
