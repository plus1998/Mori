import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CODEX_MODELS_JSON_URL,
  CodexRemoteModelCatalogService,
  parseCodexModelsJson,
  resolveCodexModelCatalogCachePath,
} from "../src/main/codex-model-catalog-remote";

const MODELS_JSON = JSON.stringify({
  models: [
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      description: "Flagship.",
      priority: 2,
      visibility: "list",
      supported_in_api: true,
      context_window: 272000,
      max_context_window: 872000,
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "ultra", description: "Delegation" },
      ],
      input_modalities: ["text", "image"],
      model_messages: { instructions_template: "x".repeat(5000) },
    },
    {
      slug: "gpt-6.1-sol",
      display_name: "GPT-6.1-Sol",
      priority: 1,
      visibility: "list",
      context_window: 272000,
      supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
      input_modalities: ["text"],
    },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", priority: 43, visibility: "hide" },
  ],
});

async function tempCachePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-catalog-"));
  return path.join(dir, "codex-model-catalog.json");
}

function fetchReturning(body: string, status = 200): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("parseCodexModelsJson", () => {
  test("keeps picker metadata and drops prompt templates", () => {
    const entries = parseCodexModelsJson(MODELS_JSON);
    expect(entries.map((entry) => entry.modelId)).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
      "codex-auto-review",
    ]);
    const astra = entries[0];
    expect(astra).toMatchObject({
      displayName: "GPT-6-Astra",
      description: "Flagship.",
      priority: 2,
      contextWindow: 272000,
      maxContextWindow: 872000,
      defaultReasoningEffort: "low",
      reasoningEfforts: ["low", "ultra"],
      supportsImageInput: true,
      hidden: false,
      origin: "remote",
    });
    expect(JSON.stringify(entries)).not.toContain("instructions_template");
    expect(entries[2].hidden).toBe(true);
    expect(entries[1].supportsImageInput).toBe(false);
  });

  test("rejects a catalog without usable models instead of returning an empty list", () => {
    expect(() => parseCodexModelsJson("{}")).toThrow(/models/);
    expect(() => parseCodexModelsJson('{"models":[]}')).toThrow(/没有任何模型/);
    expect(() => parseCodexModelsJson('{"models":[{"display_name":"x"}]}')).toThrow(/缺少 slug/);
    expect(() => parseCodexModelsJson("not json")).toThrow(/解析失败/);
  });
});

describe("CodexRemoteModelCatalogService", () => {
  test("fetches once, hides hidden models, orders by priority, and reuses the disk cache", async () => {
    const cachePath = await tempCachePath();
    const first = fetchReturning(MODELS_JSON);
    const service = new CodexRemoteModelCatalogService({ cachePath, fetchImpl: first.fetchImpl });

    const models = await service.listModels();
    expect(first.calls).toEqual([CODEX_MODELS_JSON_URL]);
    expect(models.map((model) => model.modelId)).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);

    const status = await service.getStatus();
    expect(status).toMatchObject({ sourceUrl: CODEX_MODELS_JSON_URL, remoteCount: 3, manualCount: 0 });
    expect(typeof status.fetchedAt).toBe("number");

    const second = fetchReturning(MODELS_JSON);
    const reloaded = new CodexRemoteModelCatalogService({ cachePath, fetchImpl: second.fetchImpl });
    const cached = await reloaded.listModels();
    expect(second.calls).toEqual([]);
    expect(cached.map((model) => model.modelId)).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
    expect((await reloaded.getStatus()).fetchedAt).toBe(status.fetchedAt);
  });

  test("manual adds survive a refresh and a restart, and can be removed", async () => {
    const cachePath = await tempCachePath();
    const first = fetchReturning(MODELS_JSON);
    const service = new CodexRemoteModelCatalogService({ cachePath, fetchImpl: first.fetchImpl });
    await service.addManualModel({ modelId: "gpt-6.1-sol-preview", displayName: "Preview" });

    await expect(service.addManualModel({ modelId: "gpt-6.1-sol-preview" })).rejects.toThrow(/已在手动添加/);
    await expect(service.addManualModel({ modelId: "gpt-6-astra" })).rejects.toThrow(
      /已存在于 Codex 模型目录/,
    );
    await expect(service.addManualModel({ modelId: "  " })).rejects.toThrow(/不能为空/);

    const reloaded = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: fetchReturning(MODELS_JSON).fetchImpl,
    });
    expect((await reloaded.listModels()).at(-1)).toMatchObject({
      modelId: "gpt-6.1-sol-preview",
      displayName: "Preview",
      origin: "manual",
    });
    expect(await reloaded.removeManualModel("gpt-6.1-sol-preview")).toBe(true);
    expect(await reloaded.removeManualModel("gpt-6-astra")).toBe(false);
    expect((await reloaded.listModels()).some((model) => model.origin === "manual")).toBe(false);
  });

  test("a failed refresh keeps the cached list but reports the error", async () => {
    const cachePath = await tempCachePath();
    const good = fetchReturning(MODELS_JSON);
    const service = new CodexRemoteModelCatalogService({ cachePath, fetchImpl: good.fetchImpl });
    const before = await service.listModels();
    const fetchedAt = (await service.getStatus()).fetchedAt;

    const failing = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: fetchReturning("", 503).fetchImpl,
    });
    await expect(failing.refresh()).rejects.toThrow(/HTTP 503/);
    const status = await failing.getStatus();
    expect(status.fetchedAt).toBe(fetchedAt);
    expect(status.lastError).toContain("HTTP 503");
    expect((await failing.listModels()).map((model) => model.modelId)).toEqual(
      before.map((model) => model.modelId),
    );
  });

  test("a malformed upstream body never replaces the cached catalog", async () => {
    const cachePath = await tempCachePath();
    const service = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: fetchReturning(MODELS_JSON).fetchImpl,
    });
    await service.listModels();

    const broken = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: fetchReturning("<html>proxy intercepted</html>").fetchImpl,
    });
    await expect(broken.refresh()).rejects.toThrow(/解析失败/);
    expect((await broken.listModels()).length).toBe(2);
    expect((await broken.getStatus()).lastError).toContain("解析失败");
  });

  test("with no cache and a dead network the picker reports the failure instead of inventing models", async () => {
    const cachePath = await tempCachePath();
    const dead = fetchReturning("", 599);
    const service = new CodexRemoteModelCatalogService({ cachePath, fetchImpl: dead.fetchImpl });
    expect(await service.listModels()).toEqual([]);
    expect((await service.getStatus()).lastError).toContain("HTTP 599");

    // Repeated picker opens must not each wait for the fetch timeout.
    await service.listModels();
    expect(dead.calls.length).toBe(1);
  });

  test("cache path lives next to the other desktop caches", () => {
    expect(resolveCodexModelCatalogCachePath("/tmp/eco-user-data")).toBe(
      path.join("/tmp/eco-user-data", "codex-model-catalog.json"),
    );
  });
});
