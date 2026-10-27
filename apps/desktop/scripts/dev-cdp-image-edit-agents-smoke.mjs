/**
 * CDP smoke: image-to-image Creative Drawing once per Eco core (pi / claude / codex).
 *
 *   ECO_DEV_CDP_URL=http://127.0.0.1:9334 bun scripts/dev-cdp-image-edit-agents-smoke.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

/** Minimal 1x1 red PNG (no pngjs dependency). */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

const cdpUrl = process.env.ECO_DEV_CDP_URL?.trim() || (await resolveCdpUrl());
const CORES = /** @type {Array<'pi'|'claude'|'codex'>} */ (
  (process.env.ECO_I2I_CORES?.trim() || "pi,claude,codex")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const PER_CORE_TIMEOUT_MS = Number.parseInt(process.env.ECO_I2I_SMOKE_TIMEOUT_MS ?? "420000", 10);
const MARKER_BASE = process.env.ECO_SMOKE_MARKER?.trim() || `I2I${Date.now().toString(36).toUpperCase()}`;
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".smoke-artifacts");
mkdirSync(outDir, { recursive: true });

async function resolveCdpUrl() {
  for (const port of [9334, 9333, 9335, 9344]) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (version.ok) return `http://127.0.0.1:${port}`;
    } catch {
      // next
    }
  }
  throw new Error("No Mori dev CDP on 9333/9334/9335/9344");
}

function buildSourcePng(filePath) {
  writeFileSync(filePath, RED_PNG);
}

function buildPrompt(marker, sourceAbs) {
  const posix = sourceAbs.replace(/\\/g, "/");
  return [
    `Marker=${marker}`,
    "Call mcp__eco_image_generation__create_image once for image-to-image.",
    `input_images=["${posix}"]`,
    'prompt="watercolor red square, soft edges"',
    `When done reply exactly: IMAGE_EDIT_OK:${marker}:<abs_path>`,
    `On failure reply exactly: IMAGE_EDIT_FAIL:${marker}:<error>`,
  ].join("\n");
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {'pi'|'claude'|'codex'} core
 */
async function selectCore(page, core) {
  const trigger = page.getByRole("button", { name: /当前 Core/ });
  await trigger.click({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const picked = await page.evaluate((kind) => {
    const menu = document.querySelector(".sidebar-core-menu");
    if (!menu) return { ok: false, reason: "menu_missing" };
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
    const match = items.find((el) => {
      const text = (el.textContent || "").toLowerCase();
      if (kind === "pi") return text.includes("π") || text.includes("pi");
      if (kind === "claude") return text.includes("claude");
      if (kind === "codex") return text.includes("codex");
      return false;
    });
    if (!match) return { ok: false, reason: "item_missing", items: items.map((i) => (i.textContent || "").trim()) };
    if (/** @type {HTMLButtonElement} */ (match).disabled) return { ok: false, reason: "disabled" };
    /** @type {HTMLElement} */ (match).click();
    return { ok: true, label: (match.textContent || "").trim() };
  }, core);
  if (!picked?.ok) {
    throw new Error(`selectCore(${core}) failed: ${JSON.stringify(picked)}`);
  }
  await page.waitForTimeout(600);
  const label = (await trigger.getAttribute("aria-label")) || "";
  console.log(`[i2i-smoke] core selected ${core}; trigger=${label}; menu=${picked.label}`);
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function ensureImageIntegration(page) {
  const card = page.getByRole("button", { name: /配置会话集成/ });
  await card.click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  const enabled = await page.evaluate(() => {
    const dialog = document.querySelector("dialog, [role='dialog']");
    if (!dialog) return { ok: false, reason: "no_dialog" };
    const boxes = [...dialog.querySelectorAll('input[type="checkbox"]')];
    const drawing = boxes.find((b) => (b.getAttribute("aria-label") || b.name || "") === "创意绘画");
    if (!drawing) return { ok: false, reason: "no_drawing", labels: boxes.map((b) => b.getAttribute("aria-label")) };
    if (!drawing.checked) drawing.click();
    return { ok: true, checked: true };
  });
  if (!enabled?.ok) {
    // Fallback: click visible label text
    const toggle = page.getByText(/创意绘画|Creative Drawing/).first();
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(200);
  const badge = await card.textContent().catch(() => "");
  console.log(`[i2i-smoke] image integration ensure => ${JSON.stringify(enabled)} badge=${badge}`);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} prompt
 */
async function sendPrompt(page, prompt) {
  const composer = page.locator('.composer-skill-input-control[role="textbox"]').first();
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await composer.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(300);
  const send = page.getByRole("button", { name: "发送" });
  if (await send.isEnabled()) await send.click();
  else await page.keyboard.press("Enter");
}

async function ensureAutoApproveOn(page) {
  const btn = page.getByRole("button", { name: /替我审批/ });
  if (!(await btn.isVisible().catch(() => false))) return;
  const pressed = await btn.getAttribute("aria-pressed");
  if (pressed !== "true") {
    await btn.click();
    await page.waitForTimeout(200);
  }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} threadId
 * @param {number} deadline
 */
async function autoApproveLoop(page, threadId, deadline) {
  while (Date.now() < deadline) {
    const pending = await page.evaluate(async (tid) => {
      return (await window.eco.getPendingBashApproval?.(tid)) ?? null;
    }, threadId);
    if (pending?.toolUseId) {
      await page.evaluate(
        async ({ toolUseId }) => {
          await window.eco.resolveBashApproval?.({ toolUseId, decision: "approved" });
        },
        { toolUseId: pending.toolUseId },
      );
      console.log(`[i2i-smoke] approved ${pending.kind ?? "tool"} ${pending.toolUseId}`);
    }
    // UI fallback (Codex elicitation / bash panel)
    const approveUi = page
      .getByRole("button", { name: /^(批准|允许|Allow|Approve|允许一次|仅本次)$/i })
      .or(page.locator(".bash-approval-submit, .bash-approval-option-row").filter({ hasText: /批准|允许|Allow|Approve/i }).first());
    if (await approveUi.first().isVisible().catch(() => false)) {
      await approveUi.first().click({ timeout: 2000 }).catch(() => undefined);
      console.log("[i2i-smoke] clicked UI approve");
    }
    await page.waitForTimeout(800);
  }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} beforeIds
 * @param {string} marker
 */
async function waitForThread(page, beforeIds, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await page.evaluate(
      async ({ before, m }) => {
        const threads = (await window.eco.listThreads?.()) ?? [];
        const sorted = [...threads].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        const fresh = sorted.find((t) => !before.includes(t.id) && t.prompt?.includes(m));
        if (fresh) return fresh;
        return sorted.find((t) => t.prompt?.includes(m)) ?? null;
      },
      { before: beforeIds, m: marker },
    );
    if (hit?.id) return hit;
    await page.waitForTimeout(500);
  }
  throw new Error(`No thread for marker=${marker}`);
}

/**
 * Pass when Creative Drawing artifact completes and thread idles.
 * Agent-awareness: feed (after user prompt) contains IMAGE_EDIT_OK or output path.
 * @param {import('@playwright/test').Page} page
 * @param {string} threadId
 * @param {string} marker
 */
async function waitForOutcome(page, threadId, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  void autoApproveLoop(page, threadId, deadline);
  while (Date.now() < deadline) {
    const status = await page.evaluate(
      async ({ tid, m }) => {
        const artifacts = (await window.eco.listImageGenerationArtifacts?.(tid)) ?? [];
        const completed = artifacts.filter((a) => a.status === "completed");
        const failed = artifacts.filter((a) => a.status === "failed");
        const runningArt = artifacts.filter((a) => a.status === "running");
        const threads = (await window.eco.listThreads?.()) ?? [];
        const thread = threads.find((t) => t.id === tid);
        const outPath = completed[0]?.images?.[0]?.absolutePath || "";
        const feed = document.querySelector(".codex-feed-stack")?.innerText ?? "";
        // Drop the user prompt block (contains both IMAGE_EDIT_OK/FAIL instructions).
        const splitAt = feed.indexOf(m);
        const afterPrompt = splitAt >= 0 ? feed.slice(splitAt + m.length) : feed;
        const okLine = afterPrompt.includes(`IMAGE_EDIT_OK:${m}`);
        const failLine = afterPrompt.includes(`IMAGE_EDIT_FAIL:${m}`);
        const timedOut = /Failed to call tool:\s*Request timed out/i.test(afterPrompt);
        return {
          status: thread?.status,
          message: String(thread?.message || "").slice(0, 240),
          completed: completed.length,
          failed: failed.length,
          runningArt: runningArt.length,
          okLine,
          failLine,
          timedOut,
          mentionsPath: false,
          firstCompletedPath: outPath,
          failMsg: failed[0]?.errorMessage,
        };
      },
      { tid: threadId, m: marker },
    );

    // path.basename is not in page context — fix mentionsPath in node:
    const base = status.firstCompletedPath ? path.basename(status.firstCompletedPath) : "";
    if (base) {
      const feedMentions = await page.evaluate((b) => {
        const feed = document.querySelector(".codex-feed-stack")?.innerText ?? "";
        return feed.includes(b);
      }, base);
      status.mentionsPath = feedMentions;
    }

    const done =
      status.status === "idle" ||
      status.status === "completed" ||
      status.status === "failed" ||
      status.status === "cancelled" ||
      status.status === "abandoned";
    if (status.completed > 0 && (done || status.okLine)) {
      return {
        pass: true,
        agentAware: Boolean(status.okLine || status.mentionsPath),
        ...status,
      };
    }
    if (
      (status.status === "blocked" || status.status === "failed") &&
      status.runningArt === 0 &&
      status.completed === 0
    ) {
      return {
        pass: false,
        agentAware: false,
        reason: status.message || status.status,
        ...status,
      };
    }
    if (done && status.runningArt === 0 && status.completed === 0 && (status.failLine || status.failed > 0 || status.timedOut)) {
      return { pass: false, agentAware: false, ...status };
    }
    await page.waitForTimeout(2000);
  }
  return { pass: false, reason: "deadline" };
}

const browser = await chromium.connectOverCDP(cdpUrl);
const page =
  browser.contexts()[0]?.pages().find((p) => p.url().includes("127.0.0.1:5173")) ??
  browser.contexts()[0]?.pages()[0];
if (!page) throw new Error("No Mori renderer page on CDP");

await page.waitForFunction(() => typeof window.eco !== "undefined", undefined, { timeout: 30_000 });

const homePath = await page.evaluate(async () => {
  const fromApi = await window.eco.getHomeProjectPath?.();
  if (fromApi) return fromApi;
  const threads = (await window.eco.listThreads?.()) ?? [];
  return threads.find((t) => t.workspacePath)?.workspacePath;
});
if (!homePath) throw new Error("Cannot resolve Home workspace path");

const sourceAbs = path.join(homePath, "cdp-i2i-source.png");
buildSourcePng(sourceAbs);
console.log(`[i2i-smoke] CDP=${cdpUrl} home=${homePath} source=${sourceAbs} markerBase=${MARKER_BASE}`);

await page.evaluate(async () => {
  await window.eco.saveImageGenerationEnabled?.(true);
});

/** @type {Array<Record<string, unknown>>} */
const results = [];

for (const core of CORES) {
  const marker = `${MARKER_BASE}_${core}`;
  console.log(`\n===== CORE ${core} marker=${marker} =====`);
  const step = { core, marker, pass: false };
  try {
    await page.getByRole("button", { name: "新对话" }).click({ timeout: 10_000 });
    await page.waitForTimeout(800);
    await page.evaluate(async (home) => {
      const current = await window.eco.getCurrentWorkspace?.();
      if (current?.path && current.path !== home) {
        await window.eco.openWorkspacePath?.(home);
      }
    }, homePath);
    await page.waitForTimeout(400);
    await selectCore(page, core);
    await ensureAutoApproveOn(page);
    await ensureImageIntegration(page);

    const beforeIds = await page.evaluate(async () => ((await window.eco.listThreads?.()) ?? []).map((t) => t.id));
    await sendPrompt(page, buildPrompt(marker, sourceAbs));
    const thread = await waitForThread(page, beforeIds, marker, 60_000);
    step.threadId = thread.id;
    step.coreKind = thread.coreKind;
    console.log(`[i2i-smoke] thread=${thread.id} coreKind=${thread.coreKind}`);
    if (thread.coreKind && thread.coreKind !== core) {
      throw new Error(`expected core ${core} got ${thread.coreKind}`);
    }

    const outcome = await waitForOutcome(page, thread.id, marker, PER_CORE_TIMEOUT_MS);
    Object.assign(step, outcome);
    step.pass = Boolean(outcome.pass);
    console.log(`[i2i-smoke] ${core} =>`, JSON.stringify(outcome));
  } catch (error) {
    step.pass = false;
    step.error = error instanceof Error ? error.message : String(error);
    console.error(`[i2i-smoke] ${core} ERROR`, step.error);
  }
  results.push(step);
  writeFileSync(path.join(outDir, `i2i-agents-${MARKER_BASE}.json`), JSON.stringify(results, null, 2));
}

const allPass = results.every((r) => r.pass);
console.log("\n===== SUMMARY =====");
console.log(JSON.stringify({ allPass, results }, null, 2));
writeFileSync(path.join(outDir, `i2i-agents-${MARKER_BASE}.json`), JSON.stringify({ allPass, results }, null, 2));
await browser.close().catch(() => undefined);
process.exit(allPass ? 0 : 1);
