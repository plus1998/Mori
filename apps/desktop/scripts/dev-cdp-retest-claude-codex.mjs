/**
 * Retest after slim MCP env + Codex claim fix.
 * ECO_DEV_CDP_URL=http://127.0.0.1:9334 bun scripts/dev-cdp-retest-claude-codex.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.ECO_DEV_CDP_URL?.trim() || "http://127.0.0.1:9334";
const HOME = path.join(process.env.USERPROFILE || "", ".eco", "projects", "home");
const SOURCE = path.join(HOME, "cdp-i2i-source.png");
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
mkdirSync(HOME, { recursive: true });
writeFileSync(SOURCE, RED_PNG);
const MARKER = `RT${Date.now().toString(36).toUpperCase()}`;

async function goHome(page) {
  await page.getByRole("button", { name: /新对话/ }).click({ timeout: 10_000 });
  await page.waitForTimeout(700);
}

async function selectCore(page, kind) {
  await goHome(page);
  const trigger = page.getByRole("button", { name: /当前 Core/ });
  await trigger.click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const picked = await page.evaluate((k) => {
    const menu = document.querySelector(".sidebar-core-menu");
    const items = [...(menu?.querySelectorAll('[role="menuitemradio"]') ?? [])];
    const match = items.find((el) => {
      const t = (el.textContent || "").toLowerCase();
      if (k === "claude") return t.includes("claude");
      if (k === "codex") return t.includes("codex");
      return t.includes("π") || t.includes("pi");
    });
    if (!match) return { ok: false };
    match.click();
    return { ok: true, label: (match.textContent || "").trim() };
  }, kind);
  if (!picked.ok) throw new Error(`selectCore(${kind}) failed`);
  await page.waitForTimeout(500);
  console.log(`[retest] core=${kind} ${picked.label}`);
}

async function setIntegrations(page, { browser, drawing }) {
  await page.getByRole("button", { name: /配置会话集成/ }).click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const result = await page.evaluate(({ browserOn, drawingOn }) => {
    const dialog = document.querySelector("dialog, [role='dialog']");
    if (!dialog) return { ok: false, reason: "no_dialog" };
    const boxes = [...dialog.querySelectorAll('input[type="checkbox"]')];
    const byName = (name) => boxes.find((b) => (b.getAttribute("aria-label") || "") === name);
    const browserBox = byName("浏览器");
    const drawingBox = byName("创意绘画");
    if (browserBox && browserBox.checked !== browserOn) browserBox.click();
    if (drawingBox && drawingBox.checked !== drawingOn) drawingBox.click();
    return {
      ok: true,
      browser: browserBox?.checked ?? null,
      drawing: drawingBox?.checked ?? null,
    };
  }, { browserOn: browser, drawingOn: drawing });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  console.log(`[retest] integrations =>`, result);
  return result;
}

async function sendNew(page, prompt) {
  const before = await page.evaluate(async () => ((await window.eco.listThreads?.()) ?? []).map((t) => t.id));
  const composer = page.locator('.composer-skill-input-control[role="textbox"], [role="textbox"]').first();
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await composer.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(200);
  const send = page.getByRole("button", { name: "发送" });
  if (await send.isEnabled()) await send.click();
  else await page.keyboard.press("Enter");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const hit = await page.evaluate(
      async ({ beforeIds, m }) => {
        const threads = (await window.eco.listThreads?.()) ?? [];
        return (
          [...threads]
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
            .find((t) => !beforeIds.includes(t.id) && t.prompt?.includes(m)) ?? null
        );
      },
      { beforeIds: before, m: prompt.slice(0, 24) },
    );
    if (hit) return hit;
    await page.waitForTimeout(500);
  }
  throw new Error("thread not found");
}

async function poll(page, threadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // approve pending
    const pending = await page.evaluate(async (tid) => (await window.eco.getPendingBashApproval?.(tid)) ?? null, threadId);
    if (pending?.toolUseId) {
      await page.evaluate(
        async ({ toolUseId }) => window.eco.resolveBashApproval?.({ toolUseId, decision: "approved" }),
        { toolUseId: pending.toolUseId },
      );
      console.log(`[retest] approved ${pending.kind || "tool"}`);
    }
    const snap = await page.evaluate(async (tid) => {
      const t = ((await window.eco.listThreads?.()) ?? []).find((x) => x.id === tid);
      const arts = (await window.eco.listImageGenerationArtifacts?.(tid)) ?? [];
      let integ = null;
      try {
        integ = JSON.parse(t?.runtimeConfigJson || "{}").integrationsEnabled;
      } catch {
        /* ignore */
      }
      return {
        status: t?.status,
        message: String(t?.message || "").slice(0, 240),
        core: t?.coreKind,
        integrations: integ,
        arts: arts.map((a) => ({ status: a.status, err: a.errorMessage, path: a.images?.[0]?.absolutePath })),
      };
    }, threadId);
    const done = ["completed", "idle", "failed", "blocked", "cancelled", "abandoned"].includes(String(snap.status));
    const artDone = snap.arts.some((a) => a.status === "completed");
    if (done || artDone || /ENAMETOOLONG/i.test(snap.message)) {
      return snap;
    }
    await page.waitForTimeout(1500);
  }
  return { timeout: true };
}

const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts()[0]?.pages()[0];
if (!page) throw new Error("no page");
await page.bringToFront();

const results = {};

// 1) Claude + browser only (no drawing) — previously ENAMETOOLONG
await selectCore(page, "claude");
await setIntegrations(page, { browser: true, drawing: false });
const claudeThread = await sendNew(page, `${MARKER}_CLAUDE_BROWSER reply exactly: CLAUDE_OK_BROWSER`);
console.log(`[retest] claude thread ${claudeThread.id}`);
results.claudeBrowser = { threadId: claudeThread.id, ...(await poll(page, claudeThread.id, 120_000)) };
console.log("[retest] claudeBrowser", results.claudeBrowser);

// 2) Codex + drawing image-edit
await selectCore(page, "codex");
await setIntegrations(page, { browser: true, drawing: true });
const src = SOURCE.replace(/\\/g, "/");
const prompt = [
  `Marker=${MARKER}_CODEX`,
  "Call mcp__mori_image_generation__create_image once for image-to-image.",
  `input_images=["${src}"]`,
  'prompt="watercolor red square, soft edges"',
  `When done reply exactly: IMAGE_EDIT_OK:${MARKER}_CODEX:<abs_path>`,
  `On failure reply exactly: IMAGE_EDIT_FAIL:${MARKER}_CODEX:<error>`,
].join("\n");
const codexThread = await sendNew(page, prompt);
console.log(`[retest] codex thread ${codexThread.id}`);
results.codexI2i = { threadId: codexThread.id, ...(await poll(page, codexThread.id, 420_000)) };
console.log("[retest] codexI2i", results.codexI2i);

console.log("\n=== RETEST SUMMARY ===");
console.log(JSON.stringify(results, null, 2));
await browser.close().catch(() => undefined);

const claudeOk =
  !/ENAMETOOLONG/i.test(String(results.claudeBrowser?.message || "")) &&
  results.claudeBrowser?.status !== "blocked";
const codexOk = (results.codexI2i?.arts || []).some((a) => a.status === "completed");
process.exit(claudeOk && codexOk ? 0 : 1);
