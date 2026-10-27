/**
 * Live smoke: composer prompt-image → vision sensor report.
 * Asserts describe-only contract (no advice / user-facing chat).
 *
 *   ECO_DEV_CDP_URL=http://127.0.0.1:9366 bun scripts/dev-cdp-vision-sensor-smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildVisionAnalysisRequestBody } from "../src/shared/prompt-image-vision.ts";

const cdpUrl = process.env.ECO_DEV_CDP_URL ?? "http://127.0.0.1:9366";
const TIMEOUT_MS = Number.parseInt(process.env.ECO_VISION_SMOKE_TIMEOUT_MS ?? "180000", 10);
const IMAGE_PATH =
  process.env.ECO_VISION_SMOKE_IMAGE?.trim() ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".smoke-artifacts", "vision-smoke.jpg");
const MARKER = `VS${Date.now().toString(36).toUpperCase()}`;

const ADVICE_RE =
  /建议你|建议改|下一步[：:]|你可以|你应该|推荐你|帮你改|可以改成|不妨|试着|请修复|我建议/i;

const results = {
  marker: MARKER,
  steps: [],
  pass: false,
  threadId: null,
  report: null,
  requestContract: null,
};

function step(name, ok, detail) {
  results.steps.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  console.log(`[vision-sensor] ${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? `: ${detail}` : ""}`);
}

// Static contract (no model): new system prompt must be describe-only.
{
  const body = buildVisionAnalysisRequestBody({
    model: "smoke",
    prompt: "帮我改这个界面",
    imageCount: 1,
  });
  const system = body.system;
  const user = body.messages[0]?.content[0]?.text ?? "";
  const ok =
    system.includes("private image-interpretation sensor") &&
    system.includes("Do not suggest fixes") &&
    system.includes("Do not address the user") &&
    user.includes("Observation focus") &&
    user.includes("帮我改这个界面");
  results.requestContract = { systemHead: system.slice(0, 120), userHead: user.slice(0, 160) };
  step("request contract (describe-only)", ok);
}

if (!fs.existsSync(IMAGE_PATH)) {
  step("image file exists", false, IMAGE_PATH);
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}
step("image file exists", true, IMAGE_PATH);

const imageBase64 = fs.readFileSync(IMAGE_PATH).toString("base64");
const mediaType = IMAGE_PATH.toLowerCase().endsWith(".jpg") || IMAGE_PATH.toLowerCase().endsWith(".jpeg")
  ? "image/jpeg"
  : "image/png";

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const context = browser.contexts()[0];
  const page = context?.pages().find((p) => p.url().includes("5173")) ?? context?.pages()[0];
  if (!page) throw new Error("No Mori page from CDP");
  step("cdp page", true, page.url());

  await page.waitForFunction(() => typeof window.eco?.startThread === "function", undefined, {
    timeout: 45_000,
  });

  const prep = await page.evaluate(async () => {
    const settings = await window.eco.getModelSettings();
    const workflow = await window.eco.getWorkflowSettings();
    const workspace = await window.eco.getCurrentWorkspace();
    const selection = workflow.defaultOrchestrationSelection;
    const mainConfig =
      (selection?.mainAgentConfigId
        ? settings.mainAgentConfigs.find((c) => c.id === selection.mainAgentConfigId)
        : undefined) ?? settings.mainAgentConfigs[0];
    if (!mainConfig?.modelRef?.providerId || !mainConfig.modelRef.modelId) {
      throw new Error("main agent config missing modelRef");
    }
    const provider = settings.providers.find((p) => p.id === mainConfig.modelRef.providerId && p.enabled);
    if (!provider) throw new Error(`provider ${mainConfig.modelRef.providerId} not enabled`);
    const orchestrationSelection = selection ?? {
      mainAgentConfigId: mainConfig.id,
      mainPrompt: { mode: "builtin" },
      subagents: { mode: "none" },
    };
    const runtimeConfig = {
      orchestrationSelection,
      mainAgentModelOverride: {
        providerId: mainConfig.modelRef.providerId,
        modelId: mainConfig.modelRef.modelId,
        thinkingEffort: mainConfig.modelRef.thinkingEffort ?? "off",
        ...(mainConfig.modelRef.candidateModelId
          ? { candidateModelId: mainConfig.modelRef.candidateModelId }
          : {}),
      },
      ...(workflow.defaultVisionModel ? { visionModel: workflow.defaultVisionModel } : {}),
      subagentEnabled: {
        explore: false,
        architect: false,
        coder: false,
        reviewer: false,
        tester: false,
      },
      sessionMode: workflow.sessionMode ?? "agent",
      bashReviewMode: workflow.defaultBashReviewMode ?? "allow_all",
      integrationsEnabled: {
        ...(workflow.integrationsEnabled ?? {}),
        browser: false,
        imageGeneration: false,
      },
    };
    return {
      workspacePath: workspace?.path,
      providerName: provider.name,
      providerId: provider.id,
      modelId: mainConfig.modelRef.modelId,
      mainAgentName: mainConfig.name,
      visionModel: workflow.defaultVisionModel ?? null,
      coreKind: workflow.defaultCoreKind ?? "codex",
      runtimeConfig,
    };
  });

  step(
    "resolve runtime",
    Boolean(prep.workspacePath && prep.modelId),
    `${prep.coreKind} / ${prep.mainAgentName} / ${prep.modelId}` +
      (prep.visionModel ? ` / vision=${prep.visionModel.modelId}` : ""),
  );
  if (!prep.workspacePath) throw new Error("No workspace path");

  const prompt = [
    `Mori vision sensor smoke. Marker=${MARKER}.`,
    "帮我改这个界面布局，给出具体修改建议和下一步。",
    "（测视觉传感器：你应只依据图片理解报告工作；不要臆造看不见的内容。）",
  ].join("\n");

  const start = await page.evaluate(
    async ({ workspacePath, prompt: p, runtimeConfig, coreKind, attachments }) => {
      const result = await window.eco.startThread({
        workspacePath,
        prompt: p,
        coreKind,
        runtimeConfig,
        attachments,
      });
      return { threadId: result.thread.id, status: result.thread.status, coreKind: result.thread.coreKind };
    },
    {
      workspacePath: prep.workspacePath,
      prompt,
      runtimeConfig: prep.runtimeConfig,
      coreKind: prep.coreKind,
      attachments: [{ mediaType, data: imageBase64 }],
    },
  );
  results.threadId = start.threadId;
  step("start thread with image", true, `${start.threadId} core=${start.coreKind}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let report = null;
  let lastStatus = start.status;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(async (tid) => {
      const thread = await window.eco.getThread?.(tid);
      const proj = await window.eco.getThreadRunProjection?.({ threadId: tid, mode: "feed" });
      const texts = [];
      const scan = (items) => {
        for (const item of items ?? []) {
          const role = item.role ?? item.agentRole;
          const meta = item.metadata ?? {};
          const text = typeof item.text === "string" ? item.text : typeof item.message === "string" ? item.message : "";
          const isVisionFinal =
            (role === "vision" || meta.visionAnalysis === true) &&
            /##\s*(Overview|总览)/i.test(text);
          if (isVisionFinal || /<vision_analysis[\s>][\s\S]*##\s*(Overview|总览)/i.test(text)) {
            texts.push(text);
          }
        }
      };
      scan(proj?.timeline);
      for (const agent of proj?.agents ?? []) scan(agent.timeline);
      // Subagent session rows may expose report on stop events
      for (const item of proj?.timeline ?? []) {
        if (item.report && typeof item.report === "string") texts.push(item.report);
        if (item.eventType === "subagent.stop" && item.report) texts.push(item.report);
      }
      return {
        status: thread?.status,
        message: thread?.message,
        texts,
        timelineLen: proj?.timeline?.length ?? 0,
      };
    }, start.threadId);

    lastStatus = snap.status;
    if (snap.texts.length > 0) {
      report = snap.texts.join("\n\n---\n\n");
      break;
    }
    if (snap.status === "failed") {
      step("thread run", false, snap.message ?? "failed");
      break;
    }
    if (snap.status === "completed" || snap.status === "idle") {
      // completed without captured report — try one more broad scrape
      const broad = await page.evaluate(async (tid) => {
        const proj = await window.eco.getThreadRunProjection?.({ threadId: tid, mode: "feed" });
        return JSON.stringify(proj).slice(0, 20000);
      }, start.threadId);
      const m = broad.match(/##\s*(Overview|总览)[\s\S]{20,4000}/i);
      if (m) {
        report = m[0];
      } else if (/visionAnalysis|role":"vision"/i.test(broad)) {
        report = broad;
      }
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (!report) {
    step("vision report found", false, `status=${lastStatus} timeout=${TIMEOUT_MS}ms`);
  } else {
    results.report = report.slice(0, 6000);
    step("vision report found", true, `${report.length} chars`);
    const hasStructure = /##\s*(Overview|总览)/i.test(report) || /vision_analysis/i.test(report);
    step("report has structure", hasStructure);
    const adviceHits = report.match(ADVICE_RE) ?? [];
    step("report has no advice phrases", adviceHits.length === 0, adviceHits.slice(0, 8).join(" | ") || "none");
  }

  await page.screenshot({ path: ".smoke-artifacts/cdp-vision-sensor-smoke.png", fullPage: false });
  step("screenshot", true, ".smoke-artifacts/cdp-vision-sensor-smoke.png");

  results.pass = results.steps.every((s) => s.ok);
} catch (error) {
  step("unexpected error", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

fs.mkdirSync(".smoke-artifacts", { recursive: true });
fs.writeFileSync(".smoke-artifacts/cdp-vision-sensor-smoke.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
process.exit(results.pass ? 0 : 1);
