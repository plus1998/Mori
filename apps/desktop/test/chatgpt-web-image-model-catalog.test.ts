import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { ChatGptWebImageModelCatalogService, parseChatGptWebImageModels } from "../src/main/chatgpt-web-image-model-catalog";
import type { OpenAIAccount, OpenAIAccountDetails } from "../src/shared/openai-account";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function catalog(slugs: string[]) {
  return {
    models: slugs.map((slug) => ({ slug, title: slug, enabled_tools: ["image_gen_tool_enabled"] })),
    categories: slugs.map((slug) => ({ default_model: slug, human_category_name: slug })),
    versions: [{ enabled: true, slugs }],
  };
}

async function harness() {
  const directory = await fs.mkdtemp("/tmp/mori-web-image-models-test-");
  directories.push(directory);
  let selected = ["free", "plus"];
  const identities: Record<string, string> = { free: "free-upstream", plus: "plus-upstream" };
  const calls: string[] = [];
  let fail = false;
  let now = 1000;
  const options = {
    cachePath: path.join(directory, "catalog.json"),
    accounts: {
      listAccounts: async () => ["free", "plus", "disabled", "logged-out"].map((id) => ({
        id, name: id, imageGenerationEnabled: selected.includes(id), isLoggedIn: id !== "logged-out", authState: id === "logged-out" ? "missing" : "configured",
      }) as OpenAIAccount),
      getAccountDetails: async (id: string) => ({
        id, name: id, authJson: JSON.stringify({ tokens: { account_id: identities[id], access_token: "DO-NOT-CACHE" } }),
      }) as OpenAIAccountDetails,
    },
    fetchModels: async (id: string) => {
      calls.push(id);
      if (fail) throw new Error("HTTP 401");
      return catalog(id === "free" ? ["gpt-6", "gpt-6-t-mini"] : ["gpt-6", "gpt-6-thinking"]);
    },
    now: () => now,
  };
  return {
    options, calls, identities,
    select: (ids: string[]) => { selected = ids; },
    fail: (value: boolean) => { fail = value; },
    time: (value: number) => { now = value; },
  };
}

test("picker excludes internal/research models, disabled versions and models without image generation", () => {
  const input = catalog(["auto", "thinking", "disabled", "no-images", "internal", "research"]);
  input.categories = input.categories.filter((c) => !["internal", "research"].includes(c.default_model));
  input.versions = [{ enabled: true, slugs: ["auto"] }, { enabled: false, slugs: ["disabled"] }];
  input.models.find((m) => m.slug === "no-images")!.enabled_tools = ["search"];
  expect(parseChatGptWebImageModels(input).map((m) => m.modelId)).toEqual(["auto", "thinking"]);
  expect(() => parseChatGptWebImageModels({ models: [] })).toThrow("格式无效");
  expect(() => parseChatGptWebImageModels(catalog([]))).toThrow("未返回");
});

test("fetches each selected account once, intersects the pool, and stays offline across reopen/restart", async () => {
  const h = await harness();
  const service = new ChatGptWebImageModelCatalogService(h.options);
  const [first, concurrent] = await Promise.all([service.get(), service.get()]);
  expect(first.models.map((m) => m.modelId)).toEqual(["gpt-6"]);
  expect(concurrent).toEqual(first);
  expect(h.calls.sort()).toEqual(["free", "plus"]);
  h.time(Number.MAX_SAFE_INTEGER);
  expect(await new ChatGptWebImageModelCatalogService(h.options).get()).toEqual(first);
  expect(h.calls).toHaveLength(2);
  h.select(["plus"]);
  expect((await service.get()).models.map((m) => m.modelId)).toEqual(["gpt-6", "gpt-6-thinking"]);
  expect(h.calls).toHaveLength(2);
  h.identities.plus = "different-upstream-account";
  await service.get();
  expect(h.calls).toHaveLength(3);
  expect(await fs.readFile(h.options.cachePath, "utf8")).not.toContain("DO-NOT-CACHE");
});

test("only manual refresh updates cached data; errors survive restart and do not trigger automatic retries", async () => {
  const h = await harness();
  h.select(["plus"]);
  const service = new ChatGptWebImageModelCatalogService(h.options);
  h.fail(true);
  expect(await service.get()).toMatchObject({ models: [], lastError: "plus：HTTP 401" });
  h.fail(false);
  const restarted = new ChatGptWebImageModelCatalogService(h.options);
  expect(await restarted.get()).toMatchObject({ models: [], lastError: "plus：HTTP 401" });
  expect(h.calls).toHaveLength(1);
  const success = await restarted.get(true);
  expect(success.models).toHaveLength(2);
  expect(success.lastError).toBeUndefined();
  h.time(2000);
  h.fail(true);
  expect(await restarted.get(true)).toEqual({ ...success, lastError: "plus：HTTP 401" });
  expect(await restarted.get()).toEqual({ ...success, lastError: "plus：HTTP 401" });
  expect(h.calls).toHaveLength(3);
});

test("empty or logged-out pools make no requests; corrupt cache requires explicit refresh", async () => {
  const h = await harness();
  h.select(["logged-out"]);
  const service = new ChatGptWebImageModelCatalogService(h.options);
  expect(await service.get()).toMatchObject({ models: [], lastError: expect.stringContaining("已登录") });
  expect(h.calls).toHaveLength(0);
  await fs.writeFile(h.options.cachePath, "broken");
  h.select(["free"]);
  const restarted = new ChatGptWebImageModelCatalogService(h.options);
  expect(await restarted.get()).toMatchObject({ models: [], lastError: expect.stringContaining("缓存") });
  expect(h.calls).toHaveLength(0);
  expect((await restarted.get(true)).models).toHaveLength(2);
  expect(h.calls).toEqual(["free"]);
});

test("pool changes during a request do not return the previous pool's models to the new caller", async () => {
  const h = await harness();
  h.select(["plus"]);
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const service = new ChatGptWebImageModelCatalogService({
    ...h.options,
    fetchModels: async (id) => {
      started();
      await gate;
      return h.options.fetchModels(id);
    },
  });
  const original = service.get();
  await waiting;
  h.select(["free"]);
  const changed = service.get();
  finish();
  expect((await original).models.map((m) => m.modelId)).toEqual(["gpt-6", "gpt-6-thinking"]);
  expect((await changed).models.map((m) => m.modelId)).toEqual(["gpt-6", "gpt-6-t-mini"]);
});
