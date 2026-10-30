/**
 * CDP E2E: MyCodexFree + gpt-5.6-luna PI native web_search.
 *
 *   ECO_DEV_CDP_URL=http://127.0.0.1:9334 node scripts/dev-cdp-web-search-luna-smoke.mjs
 */
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.ECO_DEV_CDP_URL ?? "http://127.0.0.1:9334";
const TIMEOUT_MS = Number.parseInt(process.env.ECO_WEB_SEARCH_SMOKE_TIMEOUT_MS ?? "420000", 10);
const MARKER = process.env.ECO_SMOKE_MARKER?.trim() || `WS${Date.now().toString(36).toUpperCase()}`;

mkdirSync(".smoke-artifacts", { recursive: true });

const MAIN_AGENT_CONFIG_ID = "user.custom.main_7";
const PROVIDER_ID = "mycodexfree-t7hfgr";
const MODEL_ID = "gpt-5.6-luna";

function buildPrompt(marker) {
  return [
    `Mori PI web search smoke. Marker=${marker}.`,
    "You MUST call the web_search tool (do not guess from memory).",
    "Search query: today's date in Asia/Shanghai timezone and one recent headline about OpenAI.",
    "After the tool returns, reply with one line exactly:",
    `WEB_SEARCH_DONE:${marker}`,
    "Include a short summary of what web_search returned.",
  ].join("\n");
}

const results = { marker: MARKER, steps: [], pass: false, threadId: null, webSearchHits: [] };

function step(name, ok, detail) {
  results.steps.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  console.log(`[web-search-luna] ${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? `: ${detail}` : ""}`);
}

async function collectWebSearchEvents(page, threadId) {
  return page.evaluate(async (tid) => {
    const proj = await window.eco.getThreadRunProjection?.({ threadId: tid, mode: "feed" });
    if (!proj) return [];
    const hits = [];
    const scan = (items) => {
      for (const item of items ?? []) {
        const blob = JSON.stringify(item);
        if (/web_search|WebSearch/i.test(blob)) {
          hits.push({
            eventType: item.eventType,
            toolName: item.toolName ?? item.name,
            text: (item.text ?? item.message ?? blob).slice(0, 400),
          });
        }
      }
    };
    scan(proj.timeline);
    for (const agent of proj.agents ?? []) scan(agent.timeline);
    return hits;
  }, threadId);
}

async function waitForMarkerOrWebSearch(page, threadId, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastHits = [];
  while (Date.now() < deadline) {
    const hits = await collectWebSearchEvents(page, threadId);
    lastHits = hits;
    if (hits.length > 0) return { kind: "web_search", hits };

    const markerHit = await page.evaluate(
      async ({ tid, marker: m }) => {
        const proj = await window.eco.getThreadRunProjection?.({ threadId: tid, mode: "feed" });
        if (!proj) return null;
        const texts = [];
        for (const item of proj.timeline ?? []) {
          if (item.eventType === "message.final" && item.role !== "user" && item.text) texts.push(item.text);
        }
        return texts.some((t) => t.includes(m)) ? texts.join("\n").slice(-300) : null;
      },
      { tid: threadId, marker },
    );
    if (markerHit) return { kind: "marker", tail: markerHit, hits: lastHits };

    const thread = await page.evaluate(async (tid) => window.eco.getThread?.(tid), threadId);
    if (thread?.status === "failed" || thread?.status === "completed") {
      return { kind: "terminal", status: thread.status, hits: lastHits, message: thread.message };
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(`Timeout waiting for web_search or ${marker}`);
}

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const context = browser.contexts()[0];
  const page = context?.pages().find((p) => p.url().includes("5173")) ?? context?.pages()[0];
  if (!page) throw new Error("No Mori page from CDP");
  step("cdp page", true, page.url());

  await page.waitForFunction(() => typeof window.eco?.startThread === "function", undefined, {
    timeout: 45_000,
  });

  const prep = await page.evaluate(
    async ({ mainAgentConfigId, providerId, modelId }) => {
      const settings = await window.eco.getModelSettings();
      const workflow = await window.eco.getWorkflowSettings();
      const workspace = await window.eco.getCurrentWorkspace();
      const mainConfig = settings.mainAgentConfigs.find((c) => c.id === mainAgentConfigId);
      if (!mainConfig) throw new Error(`missing main agent config ${mainAgentConfigId}`);
      const provider = settings.providers.find((p) => p.id === providerId);
      if (!provider?.enabled) throw new Error(`provider ${providerId} not enabled`);
      const candidates = await window.eco.listCandidateModels(providerId);
      const luna = candidates.find((c) => c.modelId === modelId);
      const orchestrationSelection = {
        mainAgentConfigId,
        mainPrompt: { mode: "builtin" },
        subagents: { mode: "none" },
      };
      const runtimeConfig = {
        orchestrationSelection,
        mainAgentModelOverride: {
          providerId,
          modelId,
          thinkingEffort: "off",
          ...(luna?.id ? { candidateModelId: luna.id } : {}),
        },
        subagentEnabled: {
          explore: false,
          architect: false,
          coder: false,
          reviewer: false,
          tester: false,
        },
        sessionMode: "agent",
        bashReviewMode: "allow_all",
        integrationsEnabled: workflow.integrationsEnabled ?? { browser: false, imageGeneration: false },
      };
      return {
        workspacePath: workspace?.path,
        providerName: provider.name,
        mainAgentName: mainConfig.name,
        candidateId: luna?.id,
        runtimeConfig,
      };
    },
    { mainAgentConfigId: MAIN_AGENT_CONFIG_ID, providerId: PROVIDER_ID, modelId: MODEL_ID },
  );
  step("resolve mycodexfree+luna runtime", true, `${prep.providerName} / ${prep.mainAgentName} / ${MODEL_ID}`);

  if (!prep.workspacePath) throw new Error("No workspace path");

  const prompt = buildPrompt(MARKER);
  const start = await page.evaluate(
    async ({ workspacePath, prompt, runtimeConfig }) => {
      const result = await window.eco.startThread({
        workspacePath,
        prompt,
        coreKind: "pi",
        runtimeConfig,
      });
      return { threadId: result.thread.id, status: result.thread.status, coreKind: result.thread.coreKind };
    },
    { workspacePath: prep.workspacePath, prompt, runtimeConfig: prep.runtimeConfig },
  );
  results.threadId = start.threadId;
  step("start PI thread", true, `${start.threadId} core=${start.coreKind} status=${start.status}`);

  const outcome = await waitForMarkerOrWebSearch(page, start.threadId, `WEB_SEARCH_DONE:${MARKER}`, TIMEOUT_MS);
  results.webSearchHits = outcome.hits ?? [];

  if (outcome.hits?.length) {
    step("web_search activity in feed", true, `${outcome.hits.length} hit(s)`);
  } else {
    step("web_search activity in feed", false, outcome.kind === "terminal" ? `status=${outcome.status} ${outcome.message ?? ""}` : "none");
  }

  if (outcome.kind === "marker" || outcome.kind === "web_search") {
    step("assistant completion", true, outcome.kind);
  } else if (outcome.kind === "terminal") {
    step("assistant completion", outcome.status === "completed", outcome.status);
  }

  await page.screenshot({ path: ".smoke-artifacts/cdp-web-search-luna-smoke.png", fullPage: false });
  step("screenshot", true, ".smoke-artifacts/cdp-web-search-luna-smoke.png");

  results.pass =
    results.steps.every((s) => s.ok) &&
    results.webSearchHits.length > 0 &&
    (outcome.kind === "marker" || outcome.kind === "web_search" || outcome.status === "completed");
} catch (error) {
  step("unexpected error", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
process.exit(results.pass ? 0 : 1);
