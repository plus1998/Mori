import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browserAgentSessionKey } from "../src/shared/browser";
import { runAgentBrowser } from "../scripts/agent-browser-cli.mjs";
import { expect, test } from "./fixtures/electron-app";

test("background browser click/fill/type preserves Composer focus and text", async ({ ecoPage: page }) => {
  test.setTimeout(Number.parseInt(process.env.ECO_SMOKE_TIMEOUT_MS ?? "120000", 10));

  const marker = `FOCUS_TYPE_${Date.now()}`;
  const fillText = `FILL_${marker}`;
  const typeText = `TYPE_${marker}`;
  const composerSeed = `COMPOSER_${marker}`;
  const outDir = path.join("/tmp", "mori-browser-focus", marker);
  mkdirSync(outDir, { recursive: true });

  await page.waitForFunction(() => typeof window.eco?.saveBrowserSettings === "function");

  const newConversation = page.locator("button.sidebar-action").filter({ hasText: /新对话|New conversation/i });
  if ((await newConversation.count()) > 0) {
    await newConversation.first().click();
    await page.waitForTimeout(800);
  }

  await page.evaluate(async () => {
    await window.eco.saveBrowserSettings({
      agentIntegrationEnabled: true,
      openApprovalMode: "always_allow",
    });
  });

  // An isolated browser scope needs no model run or pre-existing conversation.
  const threadId = `focus-${marker}`;

  const html = `<!doctype html><html><body>
    <h1>${marker}</h1>
    <input id="field" type="text" value="" />
    <button onclick="window.focusClicks=(window.focusClicks||0)+1;window.lastClickTrusted=event.isTrusted">Focus target</button>
  </body></html>`;
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  await page.evaluate(
    async ({ url, tid, workspacePath }) => {
      await window.eco.browserOpen({ url, workspacePath, reveal: false, threadId: tid, newBrowser: true });
    },
    { url: dataUrl, tid: threadId, workspacePath: outDir },
  );
  await page.waitForTimeout(1200);

  const taskBtn = page.locator(".codex-main-toolbar-button[aria-controls='task-panel']").first();
  if ((await taskBtn.getAttribute("aria-expanded")) === "true") {
    await taskBtn.click();
    await page.waitForTimeout(600);
  }

  const composer = page.locator(".composer-skill-input-control[role='textbox']").first();
  await composer.waitFor({ state: "visible" });
  await composer.evaluate((node, seed) => {
    node.focus();
    node.textContent = "";
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, seed);
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: seed }));
    node.setAttribute("data-focus-type-blurs", "0");
    node.addEventListener("blur", () => {
      node.setAttribute("data-focus-type-blurs", String(Number(node.getAttribute("data-focus-type-blurs")) + 1));
    });
  }, composerSeed);

  const prepared = await page.evaluate(async (tid) => {
    if (typeof window.eco.browserDevPrepareAgentCdp !== "function") {
      return null;
    }
    return window.eco.browserDevPrepareAgentCdp(tid);
  }, threadId!);
  expect(prepared?.cdpPort, "browserDevPrepareAgentCdp must return cdpPort").toBeGreaterThan(0);

  const cdpPort = prepared!.cdpPort;
  const sessionKey = browserAgentSessionKey(threadId!);
  const abEnv = { AGENT_BROWSER_CDP: String(cdpPort), AGENT_BROWSER_SESSION: sessionKey };

  const snap = runAgentBrowser(["snapshot", "--interactive"], abEnv);
  expect(snap.ok, snap.stderr || snap.stdout).toBe(true);
  writeFileSync(path.join(outDir, "snapshot.txt"), snap.stdout);

  const refMatch = snap.stdout.match(/(?:@|\[ref=)(e\d+)/);
  expect(refMatch, "snapshot should contain an interactive element ref").toBeTruthy();
  const ref = `@${refMatch![1]}`;

  const buttonLine = snap.stdout.split("\n").find(line => line.includes("Focus target"));
  const buttonRef = buttonLine?.match(/(?:@|\[ref=)(e\d+)/)?.[1];
  expect(buttonRef, "snapshot should expose the native click target").toBeTruthy();
  const clicked = runAgentBrowser(["click", `@${buttonRef}`], abEnv);
  expect(clicked.ok, clicked.stderr || clicked.stdout).toBe(true);
  expect(await composer.evaluate(node => document.activeElement === node), "click stole Composer focus").toBe(true);
  expect(await composer.getAttribute("data-focus-type-blurs"), "click blurred Composer").toBe("0");
  const clickResult = runAgentBrowser(["eval", "({clicks:window.focusClicks,trusted:window.lastClickTrusted})"], abEnv);
  expect(clickResult.ok, clickResult.stderr || clickResult.stdout).toBe(true);
  expect(clickResult.stdout).toContain('"trusted": true');

  const fill = runAgentBrowser(["fill", ref, fillText], abEnv);
  expect(fill.ok, fill.stderr || fill.stdout).toBe(true);
  expect(await composer.evaluate(node => document.activeElement === node), "fill stole Composer focus").toBe(true);

  const composerAfterFill = await composer.evaluate((node) =>
    (node.textContent ?? "").replace(/\u200b/g, "").trim(),
  );
  console.log(`[focus-type-e2e] composer after fill: ${composerAfterFill}`);

  const type = runAgentBrowser(["type", ref, typeText], abEnv);
  expect(type.ok, type.stderr || type.stdout).toBe(true);
  expect(await composer.evaluate(node => document.activeElement === node), "type stole Composer focus").toBe(true);
  expect(await composer.getAttribute("data-focus-type-blurs"), "Composer blurred during automation").toBe("0");

  await page.waitForTimeout(300);
  const composerAfterType = await composer.evaluate((node) =>
    (node.textContent ?? "").replace(/\u200b/g, "").trim(),
  );
  console.log(`[focus-type-e2e] composer after type: ${composerAfterType}`);

  const evalField = runAgentBrowser(
    ["eval", "document.querySelector('#field')?.value ?? ''"],
    abEnv,
  );
  const fieldValue = evalField.ok ? evalField.stdout.trim() : "";
  console.log(`[focus-type-e2e] webview field: ${fieldValue}`);

  const report = {
    marker,
    threadId,
    cdpPort,
    ref,
    composerSeed,
    clickResult: clickResult.stdout,
    composerAfterFill,
    composerAfterType,
    fieldValue,
    composerLeakedFill: composerAfterFill.includes(fillText),
    composerLeakedType: composerAfterType.includes(typeText),
    fieldHasFill: fieldValue.includes(fillText),
    fieldHasType: fieldValue.includes(typeText),
  };
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

  expect(composerAfterFill.includes(fillText), "fill text leaked into Composer").toBe(false);
  expect(composerAfterType.includes(typeText), "type text leaked into Composer").toBe(false);
  const continuedText = " HUMAN_CONTINUES";
  await page.keyboard.type(continuedText);
  expect(await composer.textContent(), "human typing must continue in Composer without refocusing")
    .toBe(composerSeed + continuedText);
  expect(
    fieldValue.includes(fillText) || fieldValue.includes(typeText),
    "fill/type should reach webview input",
  ).toBe(true);
});
