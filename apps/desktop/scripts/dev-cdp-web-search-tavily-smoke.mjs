/**
 * CDP E2E: MyCodexFree + gpt-5.6-luna PI Integrated Tavily web_search.
 *
 * Requires Tavily API key via ECO_TAVILY_API_KEY, TAVILY_API_KEY, or apps/desktop/.local/tavily-api-key
 *
 *   ECO_DEV_CDP_URL=http://127.0.0.1:9334 node scripts/dev-cdp-web-search-tavily-smoke.mjs
 */
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.ECO_DEV_CDP_URL ?? "http://127.0.0.1:9334";
const TIMEOUT_MS = Number.parseInt(process.env.ECO_WEB_SEARCH_SMOKE_TIMEOUT_MS ?? "420000", 10);
const MARKER = process.env.ECO_SMOKE_MARKER?.trim() || `TV${Date.now().toString(36).toUpperCase()}`;

const MAIN_AGENT_CONFIG_ID = "user.custom.main_7";
const PROVIDER_ID = "mycodexfree-t7hfgr";
const MODEL_ID = "gpt-5.6-luna";

function resolveTavilyApiKey() {
  const fromEnv = process.env.ECO_TAVILY_API_KEY?.trim() || process.env.TAVILY_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const localPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".local", "tavily-api-key");
  if (existsSync(localPath)) {
    return readFileSync(localPath, "utf8").trim();
  }
  return undefined;
}

async function resolveTavilyApiKeyFromPage(page) {
  const fromHost = resolveTavilyApiKey();
  if (fromHost) return fromHost;
  try {
    const clip = await page.evaluate(async () => {
      if (!navigator.clipboard?.readText) return "";
      return (await navigator.clipboard.readText()).trim();
    });
    if (/^tvly-[A-Za-z0-9_-]+$/i.test(clip)) return clip;
  } catch {
    // clipboard unavailable
  }
  return undefined;
}

mkdirSync(".smoke-artifacts", { recursive: true });

function buildPrompt(marker) {
  return [
    `Mori PI Integrated Tavily web search smoke. Marker=${marker}.`,
    "You MUST call the web_search tool (do not guess from memory).",
    "Search query: current weather in Shanghai China.",
    "After the tool returns, reply with one line exactly:",
    `TAVILY_SEARCH_DONE:${marker}`,
    "Mention that results came from Tavily Search.",
  ].join("\n");
}

const results = { marker: MARKER, steps: [], pass: false, threadId: null };

function step(name, ok, detail) {
  results.steps.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  console.log(`[web-search-tavily] ${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? `: ${detail}` : ""}`);
}

async function readToolEvents(page, threadId) {
  return page.evaluate(async (tid) => {
    const proj = await window.eco.getThreadRunProjection?.({ threadId: tid, mode: "feed" });
    if (!proj) return [];
    const hits = [];
    const scan = (items) => {
      for (const item of items ?? []) {
        if (item.eventType?.startsWith("tool.")) {
          hits.push({ eventType: item.eventType, text: item.text ?? "" });
        }
      }
    };
    scan(proj.timeline);
    for (const agent of proj.agents ?? []) scan(agent.timeline);
    return hits;
  }, threadId);
}

async function waitForDone(page, threadId, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tools = await readToolEvents(page, threadId);
    const tavilyHit = tools.find(
      (t) => t.eventType === "tool.completed" && /Tavily Search results/i.test(t.text),
    );
    const markerHit = await page.evaluate(
      async ({ tid, marker: m }) => {
        const proj = await window.eco.getThreadRunProjection?.({ threadId: tid, mode: "feed" });
        if (!proj) return null;
        for (const item of proj.timeline ?? []) {
          if (item.eventType === "message.final" && item.role !== "user" && item.text?.includes(m)) {
            return item.text.slice(-400);
          }
        }
        return null;
      },
      { tid: threadId, marker: `TAVILY_SEARCH_DONE:${marker}` },
    );
    if (markerHit || tavilyHit) return { markerHit, tavilyHit, tools };
    const thread = await page.evaluate(async (tid) => window.eco.getThread?.(tid), threadId);
    if (thread?.status === "failed") return { failed: thread.message, tools };
    await page.waitForTimeout(2000);
  }
  throw new Error(`Timeout waiting for Tavily web_search (${marker})`);
}

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const context = browser.contexts()[0];
  const page = context?.pages().find((p) => p.url().includes("5173")) ?? context?.pages()[0];
  if (!page) throw new Error("No Mori page from CDP");
  step("cdp page", true, page.url());

  const tavilyApiKey = await resolveTavilyApiKeyFromPage(page);
  if (!tavilyApiKey) {
    throw new Error(
      "Missing Tavily API key. Set ECO_TAVILY_API_KEY or create apps/desktop/.local/tavily-api-key",
    );
  }
  step("resolve tavily api key", true, `len=${tavilyApiKey.length}`);

  await page.waitForFunction(() => typeof window.eco?.saveIntegratedWebSearchSettings === "function", undefined, {
    timeout: 45_000,
  });

  const configured = await page.evaluate(
    async ({ apiKey, providerId, modelId }) => {
      const integrated = await window.eco.saveIntegratedWebSearchSettings({
        enabled: true,
        provider: "tavily",
        apiKey,
      });
      const candidates = await window.eco.listCandidateModels(providerId);
      const luna = candidates.find((c) => c.modelId === modelId);
      if (!luna) throw new Error(`missing candidate ${modelId}`);
      const saved = await window.eco.saveCandidateModel({
        id: luna.id,
        providerId,
        modelId: luna.modelId,
        sortOrder: luna.sortOrder,
        ...(luna.displayName ? { displayName: luna.displayName } : {}),
        ...(luna.modelsDevMapping ? { modelsDevMapping: luna.modelsDevMapping } : {}),
        manualSpec: { ...(luna.manualSpec ?? {}), supportsNativeWebSearch: false },
      });
      const workflow = await window.eco.getWorkflowSettings();
      const workspace = await window.eco.getCurrentWorkspace();
      return {
        integrated,
        lunaManualSpec: saved.manualSpec,
        workspacePath: workspace?.path,
        runtimeConfig: {
          orchestrationSelection: {
            mainAgentConfigId: "user.custom.main_7",
            mainPrompt: { mode: "builtin" },
            subagents: { mode: "none" },
          },
          mainAgentModelOverride: {
            providerId,
            modelId,
            thinkingEffort: "off",
            candidateModelId: saved.id,
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
        },
      };
    },
    { apiKey: tavilyApiKey, providerId: PROVIDER_ID, modelId: MODEL_ID },
  );

  step(
    "configure tavily integrated + disable native",
    configured.integrated.enabled &&
      configured.integrated.provider === "tavily" &&
      configured.integrated.hasApiKey &&
      configured.lunaManualSpec?.supportsNativeWebSearch === false,
    `provider=${configured.integrated.provider}`,
  );

  if (!configured.workspacePath) throw new Error("No workspace path");

  const start = await page.evaluate(
    async ({ workspacePath, prompt, runtimeConfig }) => {
      const result = await window.eco.startThread({
        workspacePath,
        prompt,
        coreKind: "pi",
        runtimeConfig,
      });
      return { threadId: result.thread.id, status: result.thread.status };
    },
    {
      workspacePath: configured.workspacePath,
      prompt: buildPrompt(MARKER),
      runtimeConfig: configured.runtimeConfig,
    },
  );
  results.threadId = start.threadId;
  step("start PI thread", true, `${start.threadId} status=${start.status}`);

  const outcome = await waitForDone(page, start.threadId, MARKER, TIMEOUT_MS);
  step("WebSearch tool completed", Boolean(outcome.tavilyHit || outcome.tools?.some((t) => /WebSearch/i.test(t.text))));
  step("assistant marker or tavily result", Boolean(outcome.markerHit || outcome.tavilyHit));

  await page.screenshot({ path: ".smoke-artifacts/cdp-web-search-tavily-smoke.png", fullPage: false });
  step("screenshot", true, ".smoke-artifacts/cdp-web-search-tavily-smoke.png");

  results.pass = results.steps.every((s) => s.ok);
} catch (error) {
  step("unexpected error", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
process.exit(results.pass ? 0 : 1);
