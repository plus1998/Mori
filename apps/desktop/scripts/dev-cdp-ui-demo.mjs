/**
 * Demo: drive Eco dev main window via CDP — new conversation + composer input.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.ECO_DEV_CDP_URL ?? "http://127.0.0.1:9333";
const marker = `CDP_DEMO_${Date.now()}`;
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".smoke-artifacts");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const context = browser.contexts()[0];
  const page = context?.pages().find((p) => p.url().includes("5173")) ?? context?.pages()[0];
  if (!page) {
    throw new Error("No Mori page from CDP");
  }

  console.log("[demo] 1. 当前页面:", page.url());

  const newChat = page.locator("button.sidebar-action").filter({ hasText: "新对话" });
  await newChat.waitFor({ state: "visible", timeout: 15_000 });
  await newChat.click();
  console.log("[demo] 2. 已点击「新对话」");
  await page.waitForTimeout(800);

  await page.screenshot({ path: path.join(outDir, "cdp-demo-after-new-chat.png") });

  const composer = page.locator('.composer-skill-input-control[role="textbox"]').first();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await composer.click();
  await composer.evaluate((node, text) => {
    node.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, text);
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }, `你好，这是 CDP 自动化测试 ${marker}`);
  console.log("[demo] 3. 已在 Composer 输入:", marker);

  await page.waitForTimeout(500);
  const composerText = (await composer.textContent())?.trim() ?? "";
  console.log(
    "[demo] 4. Composer 内容:",
    composerText.includes(marker) ? "包含 marker ✓" : composerText.slice(0, 80),
  );

  await page.screenshot({ path: path.join(outDir, "cdp-demo-after-type.png") });
  console.log("[demo] 5. 截图:", path.join(outDir, "cdp-demo-after-type.png"));
  console.log("[demo] PASS");
} finally {
  await browser.close();
}
