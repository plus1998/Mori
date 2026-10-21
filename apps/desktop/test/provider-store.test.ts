import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProviderStore } from "../src/main/provider-store";
import { removeTempDirectory } from "./helpers/temp-directory";

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!sqliteAvailable)(
  "candidate remote compaction migrates as off and persists per model",
  async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-candidate-remote-compaction-"));
    const filename = path.join(dir, "eco.sqlite");
    let store = await createProviderStore(filename);
    const provider = store.saveProvider({
      name: "Responses",
      baseUrl: "https://example.test",
      apiKey: "test",
      defaultModel: "legacy",
      enabled: true,
      apiCompat: "openai_responses",
    });
    const legacy = store.saveCandidateModel({
      providerId: provider.id,
      modelId: "legacy",
      manualSpec: { contextTokens: 128_000, supportsNativeWebSearch: false },
    });
    const db = new DatabaseSync(filename);
    try {
      // Simulate the pre-upgrade schema with a real candidate row.
      db.exec("ALTER TABLE provider_candidate_models DROP COLUMN manual_supports_remote_compaction");
      store = await createProviderStore(filename);
      expect(store.listCandidateModels(provider.id)[0]?.manualSpec).toEqual(legacy.manualSpec);
      const remote = store.saveCandidateModel({
        providerId: provider.id,
        modelId: "remote",
        manualSpec: { supportsRemoteCompaction: true },
      });
      store = await createProviderStore(filename);
      expect(
        store.listCandidateModels(provider.id).find((model) => model.id === remote.id)?.manualSpec
          ?.supportsRemoteCompaction,
      ).toBe(true);
      expect(
        store.listCandidateModels(provider.id).find((model) => model.id === legacy.id)?.manualSpec
          ?.supportsRemoteCompaction,
      ).toBeUndefined();
      store.syncCandidateModels(provider.id, [
        { id: "remote", displayName: "Remote" },
        { id: "added", displayName: "Added" },
      ]);
      expect(
        store.listCandidateModels(provider.id).find((model) => model.id === remote.id)?.manualSpec
          ?.supportsRemoteCompaction,
      ).toBe(true);
      expect(
        store.listCandidateModels(provider.id).find((model) => model.modelId === "added")?.manualSpec,
      ).toBeUndefined();
      store.saveCandidateModel({ ...remote, manualSpec: { supportsRemoteCompaction: false } });
      expect(
        store.listCandidateModels(provider.id).find((model) => model.id === remote.id)?.manualSpec
          ?.supportsRemoteCompaction,
      ).toBe(false);
      const { manualSpec: _manualSpec, ...withoutManual } = remote;
      store.saveCandidateModel(withoutManual);
      expect(
        store.listCandidateModels(provider.id).find((model) => model.id === remote.id)?.manualSpec,
      ).toBeUndefined();
    } finally {
      db.close();
      await removeTempDirectory(dir);
    }
  },
);

test.skipIf(!sqliteAvailable)("provider version defaults to v1 and persists custom value", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-version-"));
  const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

  const defaulted = store.saveProvider({
    name: "DefaultVersion",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    defaultModel: "m1",
    enabled: true,
  });
  expect(defaulted.version).toBe("v1");
  expect(store.listProviders()[0]?.version).toBe("v1");

  const custom = store.saveProvider({
    id: defaulted.id,
    name: "DefaultVersion",
    baseUrl: "https://api.example.com",
    version: "v2",
    apiKey: "k",
    defaultModel: "m1",
    enabled: true,
  });
  expect(custom.version).toBe("v2");

  const emptied = store.saveProvider({
    id: defaulted.id,
    name: "DefaultVersion",
    baseUrl: "https://api.example.com",
    version: "  ",
    apiKey: "k",
    defaultModel: "m1",
    enabled: true,
  });
  expect(emptied.version).toBe("v1");
});

test.skipIf(!sqliteAvailable)("fresh provider store does not auto-seed providers or routes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-store-"));
  const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

  const settings = store.getSettings();
  expect(settings.providers).toHaveLength(0);
  expect(settings.routeProfiles).toHaveLength(0);
});

test.skipIf(!sqliteAvailable)(
  "provider lookup and partial saves preserve subscription authentication",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-subscription-auth-"));
    const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));
    const input = {
      id: "eco-coding-chatgpt",
      name: "ChatGPT OAuth",
      baseUrl: "https://api.openai.com",
      apiCompat: "openai_responses" as const,
      tokenCountMode: "openai_responses" as const,
      authMethod: "chatgpt_subscription" as const,
      credentialPoolId: "chatgpt-default",
      apiKey: "",
      defaultModel: "gpt-6-astra",
      enabled: true,
    };
    const saved = store.saveProvider(input);
    expect(saved.authMethod).toBe(input.authMethod);
    expect(saved.credentialPoolId).toBe(input.credentialPoolId);

    // Settings reads must see the same authentication as the provider list;
    // otherwise the built-in provider migration emits settings.updated on every read.
    for (let read = 0; read < 3; read += 1) {
      expect(store.getProviderWithSecret(input.id)).toEqual({
        ...store.listProviders()[0],
        apiKey: "",
      });
      expect(store.getProviderWithSecret(input.id)?.updatedAt).toBe(saved.updatedAt);
    }

    // An edit that omits auth fields must retain the existing subscription binding.
    const edited = store.saveProvider({
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey: "",
      defaultModel: input.defaultModel,
      enabled: true,
    });
    expect(edited.authMethod).toBe(input.authMethod);
    expect(edited.credentialPoolId).toBe(input.credentialPoolId);
    expect(store.listProviders()[0]?.authMethod).toBe(input.authMethod);
    expect(store.listProviders()[0]?.credentialPoolId).toBe(input.credentialPoolId);
  },
);

test.skipIf(!sqliteAvailable)("route profiles have no active flag semantics", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-profiles-"));
  const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

  const provider = store.saveProvider({
    name: "P",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    defaultModel: "m1",
    enabled: true,
  });

  const routes = (modelId: string) => [
    { role: "main" as const, providerId: provider.id, modelId },
    { role: "explore" as const, providerId: provider.id, modelId },
    { role: "architect" as const, providerId: provider.id, modelId },
    { role: "coder" as const, providerId: provider.id, modelId },
    { role: "reviewer" as const, providerId: provider.id, modelId },
    { role: "tester" as const, providerId: provider.id, modelId },
  ];

  const first = store.saveRouteProfile({
    name: "方案一",
    routes: routes("m1"),
  });

  const second = store.saveRouteProfile({
    name: "方案二",
    routes: routes("m2"),
  });

  const profiles = store.getSettings().routeProfiles;
  expect(profiles).toHaveLength(2);
  expect(profiles.every((profile) => !("isActive" in profile))).toBe(true);
  expect(first.id).not.toBe(second.id);
});

test.skipIf(!sqliteAvailable)(
  "settings expose built-in agents without derived saved orchestrations",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-orchestration-"));
    const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

    const provider = store.saveProvider({
      name: "P",
      baseUrl: "https://api.example.com",
      apiKey: "k",
      defaultModel: "m1",
      enabled: true,
    });

    store.saveRouteProfile({
      name: "默认编程",
      routes: [
        { role: "main", providerId: provider.id, modelId: "planner-model" },
        { role: "explore", providerId: provider.id, modelId: "explore-model" },
        { role: "architect", providerId: provider.id, modelId: "architect-model" },
        { role: "coder", providerId: provider.id, modelId: "coder-model" },
        { role: "reviewer", providerId: provider.id, modelId: "reviewer-model" },
        { role: "tester", providerId: provider.id, modelId: "tester-model" },
      ],
    });

    const settings = store.getSettings();
    expect(settings.agentTemplates.map((template) => template.id)).toContain("builtin.coding.coder");
    expect(settings.mainAgentConfigs).toEqual([]);
    expect(settings.mainAgentPrompts).toEqual([]);
    expect(settings.subagentOrchestrations).toEqual([]);
    expect(settings.routeProfiles).toHaveLength(1);
    expect(settings.routeProfiles[0]?.name).toBe("默认编程");
  },
);

test.skipIf(!sqliteAvailable)("provider token count mode is persisted explicitly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-token-count-mode-"));
  const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

  const provider = store.saveProvider({
    name: "P",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    defaultModel: "m1",
    tokenCountMode: "openai_responses",
    enabled: true,
  });
  expect(provider.tokenCountMode).toBe("openai_responses");
  expect(store.getProviderWithSecret(provider.id)?.tokenCountMode).toBe("openai_responses");

  expect(() =>
    store.saveProvider({
      id: provider.id,
      name: "P",
      baseUrl: "https://api.example.com",
      apiKey: "",
      defaultModel: "m1",
      tokenCountMode: "invalid" as never,
      enabled: true,
    }),
  ).toThrow("无效的 Provider token 计数模式");
});

test.skipIf(!sqliteAvailable)("candidate model manual pricing preserves zero values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-candidate-zero-"));
  const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

  const provider = store.saveProvider({
    name: "P",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    defaultModel: "m1",
    enabled: true,
  });

  const saved = store.saveCandidateModel({
    providerId: provider.id,
    modelId: "free-model",
    manualSpec: {
      inputPerM: 0,
      outputPerM: 0,
      cacheReadPerM: 0,
      cacheWritePerM: 0,
      priceMultiplier: 0,
    },
  });

  expect(saved.manualSpec).toEqual({
    inputPerM: 0,
    outputPerM: 0,
    cacheReadPerM: 0,
    cacheWritePerM: 0,
    priceMultiplier: 0,
  });
  expect(store.listCandidateModels(provider.id)[0]?.manualSpec).toEqual(saved.manualSpec);
});

test.skipIf(!sqliteAvailable)(
  "upstream model sync adds candidates without overwriting manual metadata",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-candidate-sync-"));
    const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));
    const provider = store.saveProvider({
      id: "eco-coding-chatgpt",
      name: "ChatGPT OAuth",
      baseUrl: "https://api.openai.com",
      apiKey: "",
      authMethod: "chatgpt_subscription",
      defaultModel: "gpt-5",
      enabled: true,
    });

    const first = store.syncCandidateModels(provider.id, [
      { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
    ]);
    expect(first.changed).toBe(true);
    expect(first.models[0]?.displayName).toBe("GPT-5.6 Luna");

    store.saveCandidateModel({
      id: first.models[0]!.id,
      providerId: provider.id,
      modelId: "gpt-5.6-luna",
      displayName: "我的模型",
      manualSpec: { contextTokens: 12345 },
    });
    const second = store.syncCandidateModels(provider.id, [
      { id: "gpt-5.6-luna", displayName: "官方名称" },
      { id: "gpt-5.6-mini", displayName: "GPT-5.6 Mini" },
    ]);
    expect(second.changed).toBe(true);
    expect(second.models).toHaveLength(2);
    expect(second.models.find((model) => model.modelId === "gpt-5.6-luna")).toMatchObject({
      displayName: "我的模型",
      manualSpec: { contextTokens: 12345 },
    });
  },
);

test.skipIf(!sqliteAvailable)("deletes the only unreferenced provider and its candidate models", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-delete-only-"));
  const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

  const provider = store.saveProvider({
    name: "Only",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    defaultModel: "m1",
    enabled: true,
  });
  store.saveCandidateModel({
    providerId: provider.id,
    modelId: "m1",
  });

  store.deleteProvider(provider.id);

  expect(store.listProviders()).toEqual([]);
  expect(store.listCandidateModels(provider.id)).toEqual([]);
});

test.skipIf(!sqliteAvailable)(
  "deleting a provider removes legacy route profiles that reference it",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-delete-route-"));
    const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

    const provider = store.saveProvider({
      name: "Referenced",
      baseUrl: "https://api.example.com",
      apiKey: "k",
      defaultModel: "m1",
      enabled: true,
    });
    store.saveCandidateModel({
      providerId: provider.id,
      modelId: "m1",
    });
    store.saveRouteProfile({
      name: "Uses provider",
      routes: [
        { role: "main", providerId: provider.id, modelId: "m1" },
        { role: "explore", providerId: provider.id, modelId: "m1" },
        { role: "architect", providerId: provider.id, modelId: "m1" },
        { role: "coder", providerId: provider.id, modelId: "m1" },
        { role: "reviewer", providerId: provider.id, modelId: "m1" },
        { role: "tester", providerId: provider.id, modelId: "m1" },
      ],
    });

    store.deleteProvider(provider.id);

    expect(store.listProviders()).toEqual([]);
    expect(store.listCandidateModels(provider.id)).toEqual([]);
    expect(store.listRouteProfiles()).toEqual([]);
  },
);

test.skipIf(!sqliteAvailable)("deleting an unreferenced provider does not rewrite routes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-delete-unreferenced-"));
  const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

  const retained = store.saveProvider({
    name: "Retained",
    baseUrl: "https://retained.example.com",
    apiKey: "k",
    defaultModel: "retained-model",
    enabled: true,
  });
  const removed = store.saveProvider({
    name: "Removed",
    baseUrl: "https://removed.example.com",
    apiKey: "k",
    defaultModel: "removed-model",
    enabled: true,
  });
  store.saveRouteProfile({
    name: "Retained routes",
    routes: [
      { role: "main", providerId: retained.id, modelId: "planner-model" },
      { role: "explore", providerId: retained.id, modelId: "explore-model" },
      { role: "architect", providerId: retained.id, modelId: "architect-model" },
      { role: "coder", providerId: retained.id, modelId: "coder-model" },
      { role: "reviewer", providerId: retained.id, modelId: "reviewer-model" },
      { role: "tester", providerId: retained.id, modelId: "tester-model" },
    ],
  });
  const routesBeforeDelete = store.listRouteProfiles()[0]?.routes;

  store.deleteProvider(removed.id);

  expect(store.listProviders().map((entry) => entry.id)).toEqual([retained.id]);
  expect(store.listRouteProfiles()[0]?.routes).toEqual(routesBeforeDelete);
});

test.skipIf(!sqliteAvailable)("rejects deleting an unknown provider", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-delete-missing-"));
  const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

  expect(() => store.deleteProvider("missing")).toThrow("找不到 Provider：missing");
});

test.skipIf(!sqliteAvailable)("per-provider upstream proxy persists, validates, and clears", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-proxy-"));
  const store = await createProviderStore(path.join(dir, "eco-coding.sqlite"));

  const saved = store.saveProvider({
    name: "ProxyProvider",
    baseUrl: "https://api.example.com",
    upstreamProxyUrl: " socks5://127.0.0.1:7890 ",
    apiKey: "k",
    defaultModel: "m1",
    enabled: true,
  });
  expect(saved.upstreamProxyUrl).toBe("socks5://127.0.0.1:7890");
  expect(store.getProviderWithSecret(saved.id)?.upstreamProxyUrl).toBe("socks5://127.0.0.1:7890");

  // Omitting the field keeps the existing value; empty string clears it.
  const kept = store.saveProvider({
    id: saved.id,
    name: "ProxyProvider",
    baseUrl: "https://api.example.com",
    apiKey: "k2",
    defaultModel: "m1",
    enabled: true,
  });
  expect(kept.upstreamProxyUrl).toBe("socks5://127.0.0.1:7890");
  const cleared = store.saveProvider({
    id: saved.id,
    name: "ProxyProvider",
    baseUrl: "https://api.example.com",
    upstreamProxyUrl: "  ",
    apiKey: "k2",
    defaultModel: "m1",
    enabled: true,
  });
  expect(cleared.upstreamProxyUrl).toBeUndefined();

  store.saveProvider({
    id: saved.id,
    name: "ProxyProvider",
    baseUrl: "https://api.example.com",
    upstreamProxyUrl: "socks5://127.0.0.1:7890",
    apiKey: "k2",
    defaultModel: "m1",
    enabled: true,
  });
  store.clearProviderUpstreamProxy(saved.id);
  expect(store.getProviderWithSecret(saved.id)?.upstreamProxyUrl).toBeUndefined();
  expect(() => store.clearProviderUpstreamProxy("missing")).toThrow("找不到 Provider：missing");

  expect(() =>
    store.saveProvider({
      id: saved.id,
      name: "ProxyProvider",
      baseUrl: "https://api.example.com",
      upstreamProxyUrl: "ftp://127.0.0.1:21",
      apiKey: "k2",
      defaultModel: "m1",
      enabled: true,
    }),
  ).toThrow(/无效的上游代理 URL/);
});
