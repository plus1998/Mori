import { afterEach, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ProviderStore } from "../src/main/provider-store";
import { AccountModelCatalogService } from "../src/main/account-model-catalog";
import { listProviderUpstreamModels, testProviderConnection } from "../src/main/provider-models";
import { ModelManagementService, type ModelManagementBackend } from "../src/main/model-management-service";
import { ModelManagementMcpGateway } from "../src/main/model-management-mcp-gateway";
import { McpHubGateway } from "../src/main/mcp-hub-gateway";
import type { ProviderConfigView } from "../src/shared/ipc";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const db = new DatabaseSync(":memory:");
  cleanup.push(() => db.close());
  const store = new ProviderStore(db);
  store.initialize();
  const provider = store.saveProvider({
    name: "Test",
    baseUrl: "https://example.test",
    defaultModel: "",
    enabled: true,
    apiKey: "secret-management-test",
    apiCompat: "openai_chat_completions",
    upstreamProxyUrl: "http://private-user:private-password@localhost:9999",
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-model-management-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const catalog = new AccountModelCatalogService({
    cachePath: path.join(dir, "catalog.json"),
    catalogName: "Test",
    sourceUrl: "https://catalog.test",
    fetchModels: async () => {
      throw new Error("catalog offline");
    },
  });
  const builtin: ProviderConfigView = {
    ...provider,
    id: "account",
    name: "Account",
    authMethod: "auth_json",
    hasApiKey: false,
  };
  const backend: ModelManagementBackend = {
    listProviders: () => [...store.listProviders(), builtin],
    modelSource: (id) => (id === builtin.id ? "codex_catalog" : "provider"),
    saveProvider: async (input) => store.saveProvider(input),
    deleteProvider: async (id) => {
      store.deleteProvider(id);
      return { ok: true };
    },
    listModels: async (id) =>
      id === builtin.id
        ? (await catalog.listModels()).map((model, index) => ({
            id: `catalog-${model.modelId}`,
            providerId: id,
            modelId: model.modelId,
            displayName: model.displayName,
            sortOrder: index,
            createdAt: "",
            updatedAt: "",
          }))
        : store.listCandidateModels(id),
    listUpstreamModels: (id) => listProviderUpstreamModels(store, { providerId: id }),
    saveModel: async (input) => store.saveCandidateModel(input),
    deleteModel: async (id) => store.deleteCandidateModel(id),
    importModels: (id, ids) => store.bulkImportCandidateModels(id, ids),
    reorderModels: (id, ids) => store.reorderCandidateModels(id, ids),
    testProvider: (id, modelId) =>
      testProviderConnection(store, { providerId: id, defaultModel: modelId, thinkingEffort: "off" }),
    saveCatalogModel: async (_source, input) => {
      await catalog.addManualModel(input);
    },
    deleteCatalogModel: (_source, id) => catalog.removeManualModel(id),
    refreshCatalog: async () => {
      await catalog.refresh();
    },
  };
  return { store, provider, backend, service: new ModelManagementService(backend) };
}

test("provider partial updates persist credentials, endpoint settings and omitted fields without exposing secrets", async () => {
  const { service, store, provider } = await setup();
  const updated = await service.invoke("save_provider", { id: provider.id, enabled: false });
  expect(store.getProviderWithSecret(provider.id)).toMatchObject({
    enabled: false,
    apiKey: "secret-management-test",
    apiCompat: provider.apiCompat,
    upstreamProxyUrl: provider.upstreamProxyUrl,
    name: provider.name,
  });
  const result = JSON.stringify([updated, await service.invoke("list_providers", {})]);
  for (const secret of ["secret-management-test", "private-user", "private-password", "apiKeyPreview"])
    expect(result).not.toContain(secret);
  await service.invoke("save_provider", { id: provider.id, apiKey: "replacement", upstreamProxyUrl: "" });
  expect(store.getProviderWithSecret(provider.id)?.apiKey).toBe("replacement");
  expect(store.getProviderWithSecret(provider.id)?.upstreamProxyUrl).toBeUndefined();
});

test("provider creation and invalid requests never silently update another provider", async () => {
  const { service, store, provider } = await setup();
  const created = (await service.invoke("save_provider", {
    name: "New",
    baseUrl: "http://localhost:8000",
    apiCompat: "anthropic",
  })) as ProviderConfigView;
  expect(store.listProviders().find((item) => item.id === created.id)).toMatchObject({
    name: "New",
    enabled: true,
  });
  for (const args of [
    { id: "missing", enabled: false },
    { id: provider.id, enabled: "false" },
    { id: provider.id, surprise: true },
    { id: provider.id, apiCompat: "made-up" },
    { id: provider.id, baseUrl: "file:///tmp/key" },
  ])
    await expect(service.invoke("save_provider", args)).rejects.toThrow();
  expect(store.listProviders().find((item) => item.id === provider.id)?.enabled).toBe(true);
});

test("model edits preserve capabilities, mapping and pricing; null explicitly clears selected overrides", async () => {
  const { service, store, provider } = await setup();
  const original = store.saveCandidateModel({
    providerId: provider.id,
    modelId: "a",
    displayName: "Alpha",
    sortOrder: 3,
    modelsDevMapping: { providerKey: "vendor", modelId: "catalog-a" },
    manualSpec: { contextTokens: 32000, inputPerM: 2, supportsImageInput: true },
  });
  await service.invoke("save_model", {
    providerId: provider.id,
    modelId: "a",
    manualSpec: { inputPerM: 1, supportsReasoning: false },
  });
  expect(store.listCandidateModels(provider.id)[0]).toMatchObject({
    id: original.id,
    displayName: "Alpha",
    sortOrder: 3,
    modelsDevMapping: original.modelsDevMapping,
    manualSpec: { contextTokens: 32000, inputPerM: 1, supportsImageInput: true, supportsReasoning: false },
  });
  await service.invoke("save_model", {
    providerId: provider.id,
    modelId: "a",
    manualSpec: { inputPerM: null },
    modelsDevMapping: null,
  });
  expect(store.listCandidateModels(provider.id)[0]?.manualSpec?.inputPerM).toBeUndefined();
  expect(store.listCandidateModels(provider.id)[0]?.manualSpec?.contextTokens).toBe(32000);
  expect(store.listCandidateModels(provider.id)[0]?.modelsDevMapping).toBeUndefined();
  await service.invoke("save_model", { providerId: provider.id, modelId: "a", manualSpec: null });
  expect(store.listCandidateModels(provider.id)[0]?.manualSpec).toBeUndefined();
  await expect(
    service.invoke("save_model", {
      providerId: provider.id,
      modelId: "a",
      manualSpec: { contextTokens: -1 },
    }),
  ).rejects.toThrow();
});

test("import keeps existing model configuration and reorder updates the provider default only with a complete order", async () => {
  const { service, store, provider } = await setup();
  await service.invoke("save_model", { providerId: provider.id, modelId: "a", displayName: "Keep" });
  await service.invoke("import_models", { providerId: provider.id, modelIds: ["a", "b", "b"] });
  expect(store.listCandidateModels(provider.id)).toHaveLength(2);
  expect(store.listCandidateModels(provider.id)[0]?.displayName).toBe("Keep");
  await expect(
    service.invoke("reorder_models", { providerId: provider.id, modelIds: ["b"] }),
  ).rejects.toThrow("全部");
  await expect(
    service.invoke("reorder_models", { providerId: provider.id, modelIds: ["a", "a"] }),
  ).rejects.toThrow("全部");
  await service.invoke("reorder_models", { providerId: provider.id, modelIds: ["b", "a"] });
  expect(store.listProviders()[0]?.defaultModel).toBe("b");
  await service.invoke("delete_model", { providerId: provider.id, modelId: "b" });
  expect(store.listCandidateModels(provider.id).map((model) => model.modelId)).toEqual(["a"]);
  await expect(
    service.invoke("delete_model", { providerId: provider.id, modelId: "missing" }),
  ).rejects.toThrow("找不到模型");
});

test("account catalogs use real manual catalog persistence, reject unsupported edits and propagate refresh/deletion failures", async () => {
  const { service } = await setup();
  await expect(service.invoke("delete_provider", { providerId: "account" })).rejects.toThrow("内置账号");
  await expect(service.invoke("save_provider", { id: "account", enabled: false })).rejects.toThrow(
    "内置账号",
  );
  await expect(
    service.invoke("save_model", {
      providerId: "account",
      modelId: "a",
      manualSpec: { contextTokens: 1000 },
    }),
  ).rejects.toThrow("仅支持");
  await service.invoke("save_model", { providerId: "account", modelId: "manual-a", displayName: "Manual" });
  expect(await service.invoke("list_models", { providerId: "account" })).toMatchObject({
    models: [{ modelId: "manual-a", displayName: "Manual" }],
  });
  await expect(service.invoke("refresh_model_catalog", { providerId: "account" })).rejects.toThrow(
    "catalog offline",
  );
  await expect(
    service.invoke("delete_model", { providerId: "account", modelId: "remote-or-missing" }),
  ).rejects.toThrow("未删除模型");
  await service.invoke("delete_model", { providerId: "account", modelId: "manual-a" });
  expect(await service.invoke("list_models", { providerId: "account" })).toEqual({ models: [] });
});

test("discovery and connection tests use saved credentials against a real local upstream", async () => {
  const requests: Array<{ url: string; auth: string | undefined; body: string }> = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: String(request.url), auth: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.method === "GET"
          ? { data: [{ id: "real-upstream-model" }] }
          : { choices: [{ message: { content: "ok" } }] },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );
  const { service, provider } = await setup();
  await service.invoke("save_provider", {
    id: provider.id,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    upstreamProxyUrl: "",
  });
  expect(await service.invoke("list_models", { providerId: provider.id, source: "upstream" })).toMatchObject({
    ok: true,
    models: [{ id: "real-upstream-model" }],
  });
  expect(await service.invoke("list_models", { providerId: provider.id })).toEqual({ models: [] });
  expect(
    await service.invoke("test_provider", { providerId: provider.id, modelId: "real-upstream-model" }),
  ).toMatchObject({ ok: true });
  expect(requests.map((request) => request.url)).toEqual(["/v1/models", "/v1/chat/completions"]);
  expect(requests.every((request) => request.auth === "Bearer secret-management-test")).toBe(true);
  const testedRequest = requests[1];
  if (!testedRequest) throw new Error("缺少模型测试请求。");
  expect(JSON.parse(testedRequest.body).model).toBe("real-upstream-model");
});

async function rpc(
  entry: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
  method = "tools/call",
) {
  const response = await fetch(entry.url as string, {
    method: "POST",
    headers: {
      ...(entry.headers as Record<string, string>),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: method === "tools/call" ? { name, arguments: args } : {},
    }),
  });
  return response.json() as Promise<{
    result: {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: { tools: Array<{ name: string }> };
    };
  }>;
}

test("real HTTP Hub discovers and calls model tools; failures remain errors and revoked conversation access fails", async () => {
  const { service, backend, provider, store } = await setup();
  backend.deleteProvider = async () => ({
    ok: false,
    reason: "in_use",
    references: [{ kind: "active_thread", id: "running", name: "Running" }],
  });
  const gateway = new ModelManagementMcpGateway(service);
  const hub = new McpHubGateway();
  cleanup.push(() => gateway.close());
  cleanup.push(() => hub.close());
  const injection = await gateway.resolveInjection("thread-a");
  hub.registerThreadServerEntry({ name: "eco_models", threadId: "thread-a", sdkEntry: injection.sdkEntry });
  const prepared = await hub.prepareThread({ threadId: "thread-a", allowedServers: ["eco_models"] });
  const search = await rpc(prepared.sdkEntry, "search_tools", { query: "eco_models" });
  expect(search.result.structuredContent.tools.map((tool) => tool.name)).toContain(
    "eco_models:save_provider",
  );
  const updated = await rpc(prepared.sdkEntry, "call_tool", {
    name: "eco_models:save_provider",
    arguments: { id: provider.id, enabled: false },
  });
  expect(updated.result.isError).not.toBe(true);
  expect(store.listProviders()[0]?.enabled).toBe(false);
  const denied = await rpc(prepared.sdkEntry, "call_tool", {
    name: "eco_models:delete_provider",
    arguments: { providerId: provider.id },
  });
  expect(denied.result.isError).toBe(true);
  expect(denied.result.content[0]?.text).toContain("in_use");
  expect(store.listProviders()).toHaveLength(1);
  const invalid = await rpc(injection.sdkEntry, "save_provider", {
    id: provider.id,
    apiKey: "sensitive-input",
    unexpected: true,
  });
  expect(invalid.result.isError).toBe(true);
  expect(JSON.stringify(invalid)).not.toContain("sensitive-input");
  gateway.disposeThread("thread-a");
  expect((await rpc(injection.sdkEntry, "list_providers", {})).result.isError).toBe(true);
  const second = await gateway.resolveInjection("thread-b");
  expect((await rpc(second.sdkEntry, "list_providers", {})).result.isError).not.toBe(true);
});
