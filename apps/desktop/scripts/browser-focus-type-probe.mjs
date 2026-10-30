/**
 * Probe: background webview fill/type vs Composer focus (dev CDP 9333).
 *
 * Prerequisites: `bun run dev` running, a conversation thread selected in Eco.
 * After changing main/preload, restart dev (or rebuild main) so browserDevPrepareAgentCdp exists.
 *
 * Usage:
 *   cd apps/desktop
 *   bun scripts/browser-focus-type-probe.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { browserAgentSessionKey } from "../src/shared/browser.ts";
import { runAgentBrowser } from "./agent-browser-cli.mjs";

const cdpUrl = process.env.ECO_DEV_CDP_URL ?? "http://127.0.0.1:9333";
const marker = process.env.ECO_SMOKE_MARKER ?? `FOCUS_TYPE_${Date.now()}`;
const fillText = `FILL_${marker}`;
const typeText = `TYPE_${marker}`;
const composerSeed = `COMPOSER_${marker}`;
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".smoke-artifacts", marker);

function ab(cdpPort, args, sessionKey) {
  return runAgentBrowser(args, {
    AGENT_BROWSER_CDP: String(cdpPort),
    AGENT_BROWSER_SESSION: sessionKey,
  });
}

async function readComposerText(page) {
  return page.locator(".composer-skill-input-control[role='textbox']").first().evaluate((node) => {
    return (node.textContent ?? "").replace(/\u200b/g, "").trim();
  });
}

async function closeTaskPanel(page) {
  const btn = page.locator(".codex-main-toolbar-button[aria-controls='task-panel']").first();
  if ((await btn.getAttribute("aria-expanded")) === "true") {
    await btn.click();
    await page.waitForTimeout(600);
  }
}

async function focusComposer(page, seed) {
  const composer = page.locator(".composer-skill-input-control[role='textbox']").first();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await composer.evaluate((node, value) => {
    node.focus();
    node.textContent = "";
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, value);
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }, seed);
}

const browser = await chromium.connectOverCDP(cdpUrl);
const results = [];

try {
  mkdirSync(outDir, { recursive: true });
  const context = browser.contexts()[0];
  const page = context?.pages().find((p) => p.url().includes("5173")) ?? context?.pages()[0];
  if (!page) {
    throw new Error("No Mori renderer page from CDP");
  }

  console.log(`[focus-probe] marker=${marker} page=${page.url()}`);

  await page.waitForFunction(() => typeof window.eco?.getBrowserState === "function");

  await page.evaluate(async () => {
    if (typeof window.eco?.saveBrowserSettings === "function") {
      await window.eco.saveBrowserSettings({
        agentIntegrationEnabled: true,
        openApprovalMode: "always_allow",
      });
    }
  });

  const threads = await page.evaluate(async () => {
    if (typeof window.eco?.listThreads !== "function") {
      return [];
    }
    return window.eco.listThreads();
  });
  const threadId = threads[0]?.id;
  if (!threadId) {
    throw new Error("No conversation thread — open a project and create/select a thread first.");
  }
  console.log(`[focus-probe] threadId=${threadId}`);

  const html = `<!doctype html><html><body>
    <h1>${marker}</h1>
    <input id="field" type="text" value="" />
  </body></html>`;
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  await page.evaluate(
    async ({ url, tid }) => {
      await window.eco.browserOpen({ url, reveal: false, threadId: tid, newBrowser: true });
    },
    { url: dataUrl, tid: threadId },
  );
  await page.waitForTimeout(1500);

  await closeTaskPanel(page);
  await focusComposer(page, composerSeed);
  const composerBefore = await readComposerText(page);
  console.log(`[focus-probe] composer before tools: ${JSON.stringify(composerBefore)}`);

  let cdpPort = (
    await page.evaluate(async () => {
      const state = await window.eco.getBrowserState();
      return state.cdpPort;
    })
  ) ?? undefined;

  if (!cdpPort && typeof page.evaluate(async () => window.eco?.browserDevPrepareAgentCdp) !== "undefined") {
    const prepared = await page.evaluate(async (tid) => {
      if (typeof window.eco?.browserDevPrepareAgentCdp !== "function") {
        return null;
      }
      return window.eco.browserDevPrepareAgentCdp(tid);
    }, threadId);
    cdpPort = prepared?.cdpPort;
    console.log(`[focus-probe] browserDevPrepareAgentCdp → cdpPort=${cdpPort ?? "none"}`);
  }

  if (!cdpPort) {
    const envPort = Number.parseInt(process.env.AGENT_BROWSER_CDP ?? "", 10);
    if (Number.isFinite(envPort) && envPort > 0) {
      cdpPort = envPort;
      console.log(`[focus-probe] using AGENT_BROWSER_CDP=${cdpPort}`);
    }
  }

  if (!cdpPort) {
    throw new Error(
      "No thread CDP port. Restart dev after rebuild, or set $env:AGENT_BROWSER_CDP from await eco.getBrowserState().",
    );
  }

  const sessionKey = browserAgentSessionKey(threadId);
  console.log(`[focus-probe] session=${sessionKey} cdpPort=${cdpPort}`);

  const snap = ab(cdpPort, ["snapshot", "--interactive"], sessionKey);
  if (!snap.ok) {
    throw new Error(`snapshot failed: ${snap.stderr || snap.stdout}`);
  }
  writeFileSync(path.join(outDir, "snapshot.txt"), snap.stdout);
  const refMatch = snap.stdout.match(/ref=e(\d+)/);
  if (!refMatch) {
    throw new Error("no ref=eN in snapshot");
  }
  const ref = `@e${refMatch[1]}`;
  console.log(`[focus-probe] using ref ${ref}`);

  const fill = ab(cdpPort, ["fill", ref, fillText], sessionKey);
  console.log(`[focus-probe] fill: ok=${fill.ok}`);
  results.push({ step: "fill", ok: fill.ok, detail: fill.stderr?.slice(0, 200) || fill.stdout?.slice(0, 200) });

  await page.waitForTimeout(200);
  const composerAfterFill = await readComposerText(page);
  console.log(`[focus-probe] composer after fill: ${JSON.stringify(composerAfterFill)}`);

  const type = ab(cdpPort, ["type", ref, typeText], sessionKey);
  console.log(`[focus-probe] type: ok=${type.ok}`);
  results.push({ step: "type", ok: type.ok, detail: type.stderr?.slice(0, 200) || type.stdout?.slice(0, 200) });

  await page.waitForTimeout(300);
  const composerAfterType = await readComposerText(page);
  console.log(`[focus-probe] composer after type: ${JSON.stringify(composerAfterType)}`);

  const evalField = ab(
    cdpPort,
    ["eval", "document.querySelector('#field')?.value ?? ''"],
    sessionKey,
  );
  const fieldValue = evalField.ok ? evalField.stdout.trim() : "";
  console.log(`[focus-probe] webview field value: ${JSON.stringify(fieldValue)}`);

  const composerLeakedFill = composerAfterFill.includes(fillText);
  const composerLeakedType = composerAfterType.includes(typeText);
  const fieldHasFill = fieldValue.includes(fillText);
  const fieldHasType = fieldValue.includes(typeText);

  const report = {
    marker,
    threadId,
    cdpPort,
    sessionKey,
    ref,
    composerSeed,
    composerBefore,
    composerAfterFill,
    composerAfterType,
    fieldValue,
    composerLeakedFill,
    composerLeakedType,
    fieldHasFill,
    fieldHasType,
    results,
  };
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

  await page.screenshot({ path: path.join(outDir, "screen.png") });

  console.log("\n[focus-probe] === SUMMARY ===");
  console.log(`  composer leaked fill text: ${composerLeakedFill}`);
  console.log(`  composer leaked type text: ${composerLeakedType}`);
  console.log(`  webview has fill: ${fieldHasFill}`);
  console.log(`  webview has type: ${fieldHasType}`);
  console.log(`  report: ${path.join(outDir, "report.json")}`);

  if (composerLeakedType || composerLeakedFill) {
    console.error("[focus-probe] FAIL — browser tool text appeared in Composer");
    process.exit(1);
  }
  if (!fieldHasFill && !fieldHasType) {
    console.error("[focus-probe] FAIL — text did not reach webview field either");
    process.exit(1);
  }
  console.log("[focus-probe] PASS — no Composer leak detected in this run");
} finally {
  await browser.close();
}
