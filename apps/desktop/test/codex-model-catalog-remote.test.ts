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
import { OPENAI_API_PRICING_URL } from "../src/main/openai-api-pricing";
import { PRICING_MARKDOWN } from "./openai-api-pricing-fixture";

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
    return new Response(String(input) === OPENAI_API_PRICING_URL ? PRICING_MARKDOWN : body, { status });
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
  test("reads never fetch; concurrent manual refreshes share one request per source", async () => {
    const cachePath = await tempCachePath();
    const responses = {
      models: Promise.withResolvers<Response>(),
      prices: Promise.withResolvers<Response>(),
    };
    const calls: string[] = [];
    const service = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: (async (input) => {
        calls.push(String(input));
        return String(input) === OPENAI_API_PRICING_URL ? responses.prices.promise : responses.models.promise;
      }) as typeof fetch,
    });
    expect(await service.listModels()).toEqual([]);
    expect(await service.listRuntimeModels()).toEqual([]);
    expect(calls).toEqual([]);
    const refreshed = [service.refresh(), service.refresh()];
    responses.models.resolve(new Response(MODELS_JSON));
    responses.prices.resolve(new Response(PRICING_MARKDOWN));
    const results = await Promise.all(refreshed);
    expect(calls.sort()).toEqual([CODEX_MODELS_JSON_URL, OPENAI_API_PRICING_URL].sort());
    expect(results[0]?.[0]?.contextWindow).toBe(272_000);
    expect(results[1]?.[0]?.apiPricing?.shortContext.input).toBe(2);
  });

  test("runtime includes hidden models; only changed windows notify the runtime", async () => {
    let changed = 0;
    let body = MODELS_JSON;
    const service = new CodexRemoteModelCatalogService({
      cachePath: await tempCachePath(),
      fetchImpl: (async (input) =>
        new Response(String(input) === OPENAI_API_PRICING_URL ? PRICING_MARKDOWN : body)) as typeof fetch,
      onContextWindowsChanged: () => {
        changed += 1;
      },
    });
    await service.refresh();
    expect((await service.listRuntimeModels()).map((model) => model.modelId)).toContain("codex-auto-review");
    expect(changed).toBe(1);
    body = MODELS_JSON.replace("Flagship.", "Renamed description.");
    await service.refresh();
    expect(changed).toBe(1);
    body = MODELS_JSON.replaceAll("272000", "300000");
    await service.refresh();
    expect(changed).toBe(2);
  });

  test("models and official prices share a persisted snapshot and never refresh on stale reads", async () => {
    const cachePath = await tempCachePath();
    const first = fetchReturning(MODELS_JSON);
    const service = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: first.fetchImpl,
      now: () => 1000,
    });
    const models = await service.refresh();
    expect(models.map((model) => model.modelId)).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
    expect(models[0]?.apiPricing?.shortContext.input).toBe(2);
    expect(await service.getStatus()).toMatchObject({
      fetchedAt: 1000,
      pricingFetchedAt: 1000,
      pricingSourceUrl: OPENAI_API_PRICING_URL,
    });
    const second = fetchReturning("", 500);
    const reloaded = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: second.fetchImpl,
      now: () => 999999999,
    });
    expect(await reloaded.listModels()).toEqual(models);
    expect(
      await reloaded.resolveApiRates("gpt-6.1-sol", {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toMatchObject({ input: 2, output: 10 });
    expect(
      await reloaded.resolveApiRates("gpt-6.1-sol-preview", {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBeNull();
    expect(second.calls).toEqual([]);
  });

  test("manual models survive refresh/restart without triggering network requests", async () => {
    const cachePath = await tempCachePath();
    const first = fetchReturning(MODELS_JSON);
    const service = new CodexRemoteModelCatalogService({ cachePath, fetchImpl: first.fetchImpl });
    await service.addManualModel({ modelId: "gpt-6.1-sol-preview", displayName: "Preview" });
    expect(first.calls).toEqual([]);
    await service.refresh();
    await expect(service.addManualModel({ modelId: "gpt-6.1-sol-preview" })).rejects.toThrow(/已在手动添加/);
    await expect(service.addManualModel({ modelId: "gpt-6-astra" })).rejects.toThrow(
      /已存在于 Codex 模型目录/,
    );
    await expect(service.addManualModel({ modelId: " " })).rejects.toThrow(/不能为空/);
    const reloaded = new CodexRemoteModelCatalogService({ cachePath, fetchImpl: first.fetchImpl });
    expect((await reloaded.listModels()).at(-1)).toMatchObject({
      modelId: "gpt-6.1-sol-preview",
      origin: "manual",
    });
    expect((await reloaded.listModels()).at(-1)?.apiPricing).toBeUndefined();
    expect(await reloaded.removeManualModel("gpt-6.1-sol-preview")).toBe(true);
    expect(await reloaded.removeManualModel("gpt-6-astra")).toBe(false);
  });

  test("either source failing preserves both old snapshots and exposes an error across restart", async () => {
    const cachePath = await tempCachePath();
    const service = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: fetchReturning(MODELS_JSON).fetchImpl,
      now: () => 1000,
    });
    const before = await service.refresh();
    for (const failedSource of [CODEX_MODELS_JSON_URL, OPENAI_API_PRICING_URL]) {
      const failing = new CodexRemoteModelCatalogService({
        cachePath,
        now: () => 2000,
        fetchImpl: (async (input) =>
          new Response(
            String(input) === OPENAI_API_PRICING_URL
              ? PRICING_MARKDOWN
              : MODELS_JSON.replaceAll("272000", "400000"),
            { status: String(input) === failedSource ? 503 : 200 },
          )) as typeof fetch,
      });
      await expect(failing.refresh()).rejects.toThrow(/HTTP 503/);
      expect(await failing.listModels()).toEqual(before);
      expect(await failing.getStatus()).toMatchObject({
        fetchedAt: 1000,
        pricingFetchedAt: 1000,
        lastError: expect.stringContaining("HTTP 503"),
      });
    }
    const reloaded = new CodexRemoteModelCatalogService({ cachePath });
    expect(await reloaded.listModels()).toEqual(before);
    expect((await reloaded.getStatus()).lastError).toContain("HTTP 503");
  });

  test("changed pricing markup cannot partially replace the model snapshot", async () => {
    const cachePath = await tempCachePath();
    const service = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: fetchReturning(MODELS_JSON).fetchImpl,
    });
    const before = await service.refresh();
    const broken = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: (async (input) =>
        new Response(
          String(input) === OPENAI_API_PRICING_URL
            ? "<html>denied</html>"
            : MODELS_JSON.replaceAll("272000", "400000"),
        )) as typeof fetch,
    });
    await expect(broken.refresh()).rejects.toThrow(/官方 API/);
    expect(await broken.listModels()).toEqual(before);
  });

  test("v1 caches keep their models without inventing prices or fetching on migration", async () => {
    const cachePath = await tempCachePath();
    await fs.writeFile(
      cachePath,
      JSON.stringify({ version: 1, remote: parseCodexModelsJson(MODELS_JSON), manual: [], fetchedAt: 123 }),
    );
    const service = new CodexRemoteModelCatalogService({
      cachePath,
      fetchImpl: fetchReturning("", 599).fetchImpl,
    });
    expect((await service.listModels()).length).toBe(2);
    expect((await service.listModels())[0]?.apiPricing).toBeUndefined();
    expect((await service.getStatus()).pricingFetchedAt).toBeUndefined();
  });

  test("cache path lives next to the other desktop caches", () => {
    expect(resolveCodexModelCatalogCachePath("/tmp/eco-user-data")).toBe(
      path.join("/tmp/eco-user-data", "codex-model-catalog.json"),
    );
  });
});
