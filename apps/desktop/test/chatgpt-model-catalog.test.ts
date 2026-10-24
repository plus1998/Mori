import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ChatGptModelCatalogService,
  resolveChatGptModelCatalogCachePath,
} from "../src/main/chatgpt-model-catalog";
import { PRICING_MARKDOWN } from "./openai-api-pricing-fixture";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function cachePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-catalog-"));
  directories.push(dir);
  return resolveChatGptModelCatalogCachePath(dir);
}
const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 };

test("ChatGPT reads and restarts stay offline; manual refresh persists models and exact official prices", async () => {
  const cache = await cachePath();
  const accounts: (string | undefined)[] = [];
  let priceCalls = 0;
  const options = {
    cachePath: cache,
    fetchModels: async (_signal: AbortSignal, accountId?: string) => {
      accounts.push(accountId);
      return [
        { id: "gpt-6.1-sol", displayName: "Sol" },
        { id: "oauth-preview", displayName: "Preview" },
      ];
    },
    fetchImpl: (async () => {
      priceCalls++;
      return new Response(PRICING_MARKDOWN);
    }) as typeof fetch,
    now: () => 1000,
  };
  const service = new ChatGptModelCatalogService(options);
  expect(await service.listModels()).toEqual([]);
  await service.getStatus();
  await service.addManualModel({ modelId: "local-only" });
  expect(accounts).toEqual([]);
  expect(priceCalls).toBe(0);
  await Promise.all([service.refresh("paused-account"), service.refresh("paused-account")]);
  expect(service.getLoadedDefaultModelId()).toBe("gpt-6.1-sol");
  expect(accounts).toEqual(["paused-account"]);
  expect(priceCalls).toBe(1);
  expect(await service.resolveApiRates("gpt-6.1-sol", usage)).toMatchObject({ input: 2, output: 10 });
  expect(await service.resolveApiRates("gpt-6.1-sol-preview", usage)).toBeNull();
  expect(await service.resolveApiRates("gpt-6.1-sol", { ...usage, inputTokens: 300_000 })).toMatchObject({
    input: 4,
  });
  expect(await service.resolveApiRates("gpt-6.1-sol", { ...usage, inputTokens: 300_000 }, true)).toBeNull();
  const restarted = new ChatGptModelCatalogService({ ...options, now: () => Number.MAX_SAFE_INTEGER });
  expect(await restarted.listModels()).toEqual(await service.listModels());
  expect(
    (await restarted.listModels()).find((m) => m.modelId === "oauth-preview")?.apiPricing,
  ).toBeUndefined();
  expect(await restarted.getStatus()).toMatchObject({ fetchedAt: 1000, pricingFetchedAt: 1000 });
  expect(await restarted.removeManualModel("local-only")).toBe(true);
  expect(await restarted.removeManualModel("gpt-6.1-sol")).toBe(false);
  expect(accounts).toHaveLength(1);
  expect(priceCalls).toBe(1);
});

for (const failure of ["oauth", "pricing", "empty"] as const) {
  test(`${failure} refresh failure preserves both cached snapshots and exposes the error after restart`, async () => {
    let broken = false;
    const options = {
      cachePath: await cachePath(),
      fetchModels: async () => {
        if (broken && failure === "oauth") throw new Error("OAuth requires authorization");
        return broken && failure === "empty"
          ? []
          : [{ id: broken ? "changed-model" : "gpt-6.1-sol", displayName: "Model" }];
      },
      fetchImpl: (async () =>
        new Response(
          broken && failure === "pricing" ? "changed pricing format" : PRICING_MARKDOWN,
        )) as typeof fetch,
      now: () => (broken ? 2000 : 1000),
    };
    const service = new ChatGptModelCatalogService(options);
    const snapshot = await service.refresh();
    broken = true;
    await expect(service.refresh()).rejects.toThrow();
    const restarted = new ChatGptModelCatalogService(options);
    expect(await restarted.listModels()).toEqual(snapshot);
    expect(await restarted.getStatus()).toMatchObject({
      fetchedAt: 1000,
      pricingFetchedAt: 1000,
      lastError: expect.any(String),
    });
  });
}
