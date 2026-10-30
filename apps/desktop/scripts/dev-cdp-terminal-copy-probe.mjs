/**
 * Dev smoke: the terminal copies only on an explicit gesture.
 *
 * Regression guard for the ghostty-web default (it wrote the clipboard on every mouseup /
 * dblclick that ended a selection). Requires `bun run dev` to be running, and — because the
 * main process and preload compile only at dev startup — a dev restart after touching
 * src/main or src/preload.
 *
 * Usage: bun run smoke:cdp-terminal-copy
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.ECO_DEV_CDP_URL ?? "http://127.0.0.1:9333";
const artifactRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const failures = [];

function quoteForShell(value) {
  if (process.platform === "win32") {
    if (value.includes('"'))
      throw new Error("Cannot quote a Windows shell argument containing a double quote");
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const context = browser.contexts()[0];
  const rendererPort = process.env.ECO_RENDERER_PORT ?? "5173";
  const page = context.pages().find((p) => p.url().startsWith(`http://127.0.0.1:${rendererPort}/`));
  if (!page) {
    throw new Error(`No Mori renderer page on CDP for port ${rendererPort}`);
  }

  const canvas = page.locator(".ghostty-terminal-mount canvas").first();
  if ((await canvas.count()) === 0) {
    await page
      .getByRole("button", { name: /打开终端|Open terminal/ })
      .first()
      .click();
  }
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("Terminal canvas has no layout box");
  }

  // Every clipboard read below goes through the app's own bridge, so a stale dev process
  // (main/preload compile once at dev startup) must fail loudly instead of reading a
  // half-wired app.
  if ((await page.evaluate(() => typeof window.eco.readClipboardText)) !== "function") {
    throw new Error(
      "window.eco.readClipboardText is missing — restart `bun run dev` (main and preload compile only at dev startup)",
    );
  }

  const writeClipboard = (text) => page.evaluate((value) => navigator.clipboard.writeText(value), text);
  const readClipboard = () => page.evaluate(() => window.eco.readClipboardText());

  const focusTerminal = async () => {
    await page.mouse.click(box.x + 30, box.y + box.height - 24);
  };
  const dragAcrossCanvas = async () => {
    await page.mouse.move(box.x + 2, box.y + 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 20, box.y + box.height - 6, { steps: 24 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  const openMenu = async () => {
    await page.mouse.click(box.x + 120, box.y + 60, { button: "right" });
    await page.waitForTimeout(400);
  };
  const menu = page.locator('[data-component="terminal-context-menu"]');

  await focusTerminal();
  await page.keyboard.type("echo TERMSEL_MARKER_123");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_000);

  // 1. Selecting text must not touch the clipboard.
  await writeClipboard("SELECTION_SENTINEL");
  await dragAcrossCanvas();
  check("drag-select leaves the clipboard alone", (await readClipboard()) === "SELECTION_SENTINEL");

  // 2. Ctrl+C and the platform's other copy chords copy the current selection.
  const copyChords = ["Control+c", "Control+Shift+c", ...(process.platform === "darwin" ? ["Meta+c"] : [])];
  for (const chord of copyChords) {
    await writeClipboard("SHORTCUT_COPY_SENTINEL");
    await page.keyboard.press(chord);
    await page.waitForTimeout(400);
    check(`${chord} copies the selection`, (await readClipboard()).includes("TERMSEL_MARKER_123"));
  }

  // 3. Right-click opens Eco's menu instead of the library's browser-menu hand-off.
  await dragAcrossCanvas();
  await openMenu();
  check("right-click opens the terminal menu", await menu.isVisible());
  const items = (await menu.innerText()).replaceAll("\n", " | ");
  check(
    "menu offers copy / paste / select-all",
    /复制.*粘贴.*全选|Copy.*Paste.*Select All/s.test(items),
    items,
  );
  check(
    "ghostty browser-menu hand-off stays suppressed",
    (await page.evaluate(
      () => document.querySelector(".ghostty-terminal-mount textarea")?.style.position,
    )) === "absolute",
  );

  // 4. Copy through the menu keeps the selection long enough to read it.
  await page.screenshot({ path: path.join(artifactRoot, `mori-terminal-context-menu-${process.pid}.png`) });
  await writeClipboard("MENU_COPY_SENTINEL");
  await menu.getByRole("menuitem", { name: /复制|Copy/ }).click();
  await page.waitForTimeout(400);
  check("menu copy writes the terminal selection", (await readClipboard()).includes("TERMSEL_MARKER_123"));
  check("menu closes after the action", (await menu.count()) === 0);

  // 5. Select-all runs through the menu without the click clearing it.
  await dragAcrossCanvas();
  await openMenu();
  await menu.getByRole("menuitem", { name: /全选|Select All/ }).click();
  await page.waitForTimeout(400);
  await writeClipboard("SELECT_ALL_SENTINEL");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+Shift+c");
  await page.waitForTimeout(400);
  check("select-all survives the menu click", (await readClipboard()) !== "SELECT_ALL_SENTINEL");

  // 6. Escape dismisses the menu without also reaching the terminal.
  await page.evaluate(() => {
    window.__terminalSmokeEscapeCount = 0;
    document.querySelector(".ghostty-terminal-mount").addEventListener("keydown", (event) => {
      if (event.key === "Escape") window.__terminalSmokeEscapeCount += 1;
    });
  });
  await openMenu();
  await page.locator(".ghostty-terminal-mount textarea").focus();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape dismisses the menu", (await menu.count()) === 0);
  check(
    "menu Escape does not reach the terminal",
    (await page.evaluate(() => window.__terminalSmokeEscapeCount)) === 0,
  );

  // 7. Capture a menu paste in a raw-mode child, never execute clipboard contents.
  {
    const dir = mkdtempSync(path.join(artifactRoot, "mori-terminal-paste-probe-"));
    const readyPath = path.join(dir, "ready");
    const receivedPath = path.join(dir, "received");
    const marker = `TERM_PASTE_MARKER_${process.pid}_${Date.now()}`;
    const source = `
      const fs = require("node:fs");
      const chunks = [];
      let bytes = 0;
      let timer;
      const finish = () => {
        process.stdin.setRawMode(false);
        fs.writeFileSync(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
        process.exit(0);
      };
      process.stdin.setRawMode(true);
      process.stdin.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 1024 * 1024) chunks.push(chunk);
        clearTimeout(timer);
        timer = setTimeout(finish, 500);
      });
      timer = setTimeout(finish, 8000);
      fs.writeFileSync(${JSON.stringify(readyPath)}, "");
    `;
    const encoded = Buffer.from(source).toString("base64");
    const runner = `eval(Buffer.from('${encoded}', 'base64').toString())`;
    await focusTerminal();
    await page.keyboard.type(`${quoteForShell(process.execPath)} -e ${quoteForShell(runner)}`);
    await page.keyboard.press("Enter");
    try {
      for (let i = 0; i < 50 && !existsSync(readyPath); i++) await page.waitForTimeout(100);
      if (!existsSync(readyPath)) throw new Error("Raw terminal paste receiver did not start");
      await writeClipboard(marker);
      await openMenu();
      await menu.getByRole("menuitem", { name: /粘贴|Paste/ }).click();
      for (let i = 0; i < 90 && !existsSync(receivedPath); i++) await page.waitForTimeout(100);
      check(
        "menu paste reaches the terminal",
        existsSync(receivedPath) && readFileSync(receivedPath, "utf8").includes(marker),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("\nAll terminal copy checks passed.");
}
