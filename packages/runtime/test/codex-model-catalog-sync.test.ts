import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodexGatewayModelAlias } from "../src/codex-config-sync";
import {
  applyManualCatalogCapabilities,
  buildAliasCatalogEntry,
  buildEcoCodexModelCatalogDocument,
  type CodexBundledModelEntry,
  type CodexGatewayCatalogRoute,
  collectCodexGatewayCatalogRoutes,
  fingerprintEcoModelCatalog,
  fingerprintEcoModelCatalogRuntime,
  mergeCodexGatewayCatalogRoutes,
  parseBundledCodexModelCatalog,
  resolveCodexMultiAgentVersion,
  resolveEcoModelCatalogPath,
  selectFreeformApplyPatchTemplate,
  selectNativeTemplateForModel,
  syncEcoCodexModelCatalog,
  writeEcoCodexModelCatalog,
} from "../src/codex-model-catalog-sync";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function nativeModelsFixture(): CodexBundledModelEntry[] {
  return [
    {
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      priority: 10,
      apply_patch_tool_type: "freeform",
      context_window: 400_000,
      max_context_window: 400_000,
      input_modalities: ["text", "image"],
      supports_parallel_tool_calls: true,
      supports_reasoning_summaries: true,
      supports_search_tool: true,
    },
    {
      slug: "gpt-5.2",
      display_name: "GPT-5.2",
      priority: 20,
      apply_patch_tool_type: "freeform",
      context_window: 256_000,
      max_context_window: 256_000,
      input_modalities: ["text"],
      supports_parallel_tool_calls: true,
    },
    {
      slug: "o3",
      display_name: "o3",
      priority: 30,
      apply_patch_tool_type: "function",
      context_window: 200_000,
    },
  ];
}

test("parseBundledCodexModelCatalog rejects invalid JSON and empty catalogs", () => {
  expect(() => parseBundledCodexModelCatalog("{")).toThrow(/invalid/i);
  expect(() => parseBundledCodexModelCatalog("{}")).toThrow(/models/i);
  expect(() => parseBundledCodexModelCatalog(JSON.stringify({ models: [] }))).toThrow(/no models/i);
  expect(() => parseBundledCodexModelCatalog(JSON.stringify({ models: [{ display_name: "x" }] }))).toThrow(
    /slug/i,
  );
});

test("selectFreeformApplyPatchTemplate prefers lowest priority freeform entry", () => {
  const template = selectFreeformApplyPatchTemplate(nativeModelsFixture());
  expect(template.slug).toBe("gpt-5.4");
  expect(() =>
    selectFreeformApplyPatchTemplate([{ slug: "only-function", apply_patch_tool_type: "function" }]),
  ).toThrow(/freeform/i);
});

test("selectNativeTemplateForModel uses exact and longest-prefix matches", () => {
  const natives = nativeModelsFixture();
  const freeform = selectFreeformApplyPatchTemplate(natives);
  expect(selectNativeTemplateForModel(natives, "gpt-5.2", freeform)).toMatchObject({
    known: true,
    template: { slug: "gpt-5.2" },
  });
  expect(selectNativeTemplateForModel(natives, "gpt-5.4-pro", freeform)).toMatchObject({
    known: true,
    template: { slug: "gpt-5.4" },
  });
  expect(selectNativeTemplateForModel(natives, "deepseek-v4-flash", freeform)).toMatchObject({
    known: false,
    template: { slug: freeform.slug },
  });
});

test("buildAliasCatalogEntry forces freeform apply_patch and keeps unknown models conservative", () => {
  const natives = nativeModelsFixture();
  const freeform = selectFreeformApplyPatchTemplate(natives);
  const known = buildAliasCatalogEntry(
    "eco_route_v1.known",
    {
      providerId: "openai",
      modelId: "gpt-5.2",
      apiCompat: "openai_responses",
      displayName: "OpenAI / gpt-5.2",
    },
    natives[1]!,
    true,
  );
  expect(known.apply_patch_tool_type).toBe("freeform");
  expect(known.supports_parallel_tool_calls).toBe(true);
  expect(known.display_name).toBe("OpenAI / gpt-5.2");

  const unknown = buildAliasCatalogEntry(
    "eco_route_v1.unknown",
    {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      apiCompat: "openai_chat_completions",
    },
    freeform,
    false,
  );
  expect(unknown.apply_patch_tool_type).toBe("freeform");
  expect(unknown.supports_parallel_tool_calls).toBe(false);
  expect(unknown.supports_search_tool).toBe(false);
  expect(unknown.input_modalities).toEqual(["text"]);
  expect(unknown.context_window).toBe(128_000);
  expect(unknown.max_context_window).toBe(128_000);
  // Unknown / third-party models must not inherit GPT code_mode_only freeform `exec`.
  // Same registration DeepSeek's official Codex catalog uses (shell_command + tool_mode null).
  expect(unknown.shell_type).toBe("shell_command");
  expect(unknown.tool_mode).toBeNull();
  expect(unknown.multi_agent_version).toBe("v1");

  const grok = buildAliasCatalogEntry(
    "eco_route_v1.grok",
    {
      providerId: "mygrok",
      modelId: "grok-4.5",
      apiCompat: "openai_responses",
    },
    freeform,
    false,
  );
  expect(grok.shell_type).toBe("shell_command");
  expect(grok.tool_mode).toBeNull();
  expect(grok.apply_patch_tool_type).toBe("freeform");
  expect(grok.multi_agent_version).toBe("v1");

  // models.dev / manual context must override the unknown-model 128k default
  // (e.g. gpt-5.6-* has catalog context 1_050_000 and max output 128_000).
  const withModelsDevContext = buildAliasCatalogEntry(
    "eco_route_v1.large",
    {
      providerId: "codex",
      modelId: "gpt-5.6-luna",
      apiCompat: "openai_responses",
      manualSpec: { contextTokens: 1_050_000 },
    },
    freeform,
    false,
  );
  expect(withModelsDevContext.context_window).toBe(1_050_000);
  expect(withModelsDevContext.max_context_window).toBe(1_050_000);
});

test("Codex Multi-Agent v2 starts at GPT-5.6 Terra", () => {
  expect(resolveCodexMultiAgentVersion("gpt-5.6-sol")).toBe("v2");
  expect(resolveCodexMultiAgentVersion("gpt-5.6-terra-preview")).toBe("v2");
  expect(resolveCodexMultiAgentVersion("gpt-6")).toBe("v2");
  expect(resolveCodexMultiAgentVersion("gpt-6-astra")).toBe("v2");
  expect(resolveCodexMultiAgentVersion("gpt-5.6-luna")).toBe("v1");
  expect(resolveCodexMultiAgentVersion("LongCat-2.0")).toBe("v1");
});

test("applyManualCatalogCapabilities overrides only declared fields", () => {
  const entry: CodexBundledModelEntry = {
    slug: "alias",
    apply_patch_tool_type: "freeform",
    context_window: 128_000,
    input_modalities: ["text"],
  };
  applyManualCatalogCapabilities(entry, {
    contextTokens: 64_000,
    supportsImageInput: true,
  });
  expect(entry.context_window).toBe(64_000);
  expect(entry.max_context_window).toBe(64_000);
  expect(entry.input_modalities).toEqual(["text", "image"]);
});

test("mergeCodexGatewayCatalogRoutes dedupes aliases with later sources winning", () => {
  const low: CodexGatewayCatalogRoute = {
    providerId: "p1",
    modelId: "m1",
    apiCompat: "anthropic",
    displayName: "low",
  };
  const high: CodexGatewayCatalogRoute = {
    providerId: "p1",
    modelId: "m1",
    apiCompat: "anthropic",
    displayName: "high",
    manualSpec: { contextTokens: 99_000 },
  };
  const merged = mergeCodexGatewayCatalogRoutes([low], [high]);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.displayName).toBe("high");
  expect(merged[0]?.manualSpec?.contextTokens).toBe(99_000);
});

test("collectCodexGatewayCatalogRoutes expands providers and prioritizes effective routes", () => {
  const routes = collectCodexGatewayCatalogRoutes({
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        enabled: true,
        apiCompat: "openai_chat_completions",
        defaultModel: "deepseek-v4-flash",
        models: [
          {
            modelId: "deepseek-v4-pro",
            displayName: "DeepSeek Pro",
            manualSpec: { contextTokens: 128_000 },
          },
        ],
      },
    ],
    routeConfigs: [
      {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        apiCompat: "openai_chat_completions",
        displayName: "route config",
      },
    ],
    effectiveRoutes: [
      {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        apiCompat: "openai_chat_completions",
        displayName: "effective",
        manualSpec: { supportsImageInput: false },
      },
    ],
  });
  const flash = routes.find((route) => route.modelId === "deepseek-v4-flash");
  const pro = routes.find((route) => route.modelId === "deepseek-v4-pro");
  expect(flash?.displayName).toBe("effective");
  expect(flash?.manualSpec?.supportsImageInput).toBe(false);
  expect(pro?.displayName).toBe("DeepSeek Pro");
  expect(pro?.manualSpec?.contextTokens).toBe(128_000);
});

test("collectCodexGatewayCatalogRoutes retains all configured orchestration and historical thread routes", () => {
  const routes = collectCodexGatewayCatalogRoutes({
    providers: [
      {
        id: "provider",
        enabled: true,
        apiCompat: "openai_responses",
        models: [{ modelId: "candidate" }],
      },
    ],
    orchestrationAgents: [
      {
        providerId: "provider",
        modelId: "subagent-model",
        apiCompat: "anthropic",
        manualSpec: { supportsImageInput: true },
      },
    ],
    effectiveRoutes: [
      {
        providerId: "retired-provider",
        modelId: "historical-thread-model",
        apiCompat: "openai_chat_completions",
        manualSpec: { contextTokens: 96_000 },
      },
    ],
  });

  expect(routes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ providerId: "provider", modelId: "candidate" }),
      expect.objectContaining({
        providerId: "provider",
        modelId: "subagent-model",
        apiCompat: "anthropic",
        manualSpec: { supportsImageInput: true },
      }),
      expect.objectContaining({
        providerId: "retired-provider",
        modelId: "historical-thread-model",
        apiCompat: "openai_chat_completions",
        manualSpec: { contextTokens: 96_000 },
      }),
    ]),
  );
});

test("buildEcoCodexModelCatalogDocument keeps native entries and adds freeform aliases", () => {
  const document = buildEcoCodexModelCatalogDocument(nativeModelsFixture(), [
    {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      apiCompat: "openai_chat_completions",
    },
    {
      providerId: "openai",
      modelId: "gpt-5.2",
      apiCompat: "openai_responses",
    },
  ]);
  const nativeSlugs = document.models.map((entry) => entry.slug);
  expect(nativeSlugs).toContain("gpt-5.4");
  expect(nativeSlugs).toContain("gpt-5.2");
  const deepseekAlias = buildCodexGatewayModelAlias(
    "deepseek",
    "deepseek-v4-flash",
    "openai_chat_completions",
  );
  const openaiAlias = buildCodexGatewayModelAlias("openai", "gpt-5.2", "openai_responses");
  const deepseek = document.models.find((entry) => entry.slug === deepseekAlias);
  const openai = document.models.find((entry) => entry.slug === openaiAlias);
  expect(deepseek?.apply_patch_tool_type).toBe("freeform");
  expect(openai?.apply_patch_tool_type).toBe("freeform");
  expect(openai?.supports_parallel_tool_calls).toBe(true);
  expect(deepseek?.supports_parallel_tool_calls).toBe(false);
  expect(document.models.find((entry) => entry.slug === "gpt-5.4")?.context_window).toBe(262_144);
  expect(document.models.find((entry) => entry.slug === "gpt-5.2")?.context_window).toBe(256_000);
});

test("buildEcoCodexModelCatalogDocument applies an explicit global cap after manual limits", () => {
  const document = buildEcoCodexModelCatalogDocument(
    nativeModelsFixture(),
    [
      {
        providerId: "provider",
        modelId: "custom-large",
        apiCompat: "openai_responses",
        manualSpec: { contextTokens: 1_048_576 },
      },
    ],
    131_072,
  );
  expect(document.models.find((entry) => entry.slug === "gpt-5.4")).toMatchObject({
    context_window: 131_072,
    max_context_window: 131_072,
  });
  const alias = document.models.find((entry) => entry.slug.startsWith("eco_route_v1."));
  expect(alias).toMatchObject({
    context_window: 131_072,
    max_context_window: 131_072,
  });
});

test("runtime catalog fingerprint ignores display labels and retains model behavior changes", () => {
  const document = { models: nativeModelsFixture() };
  const baseline = fingerprintEcoModelCatalogRuntime(document);
  const renamed = {
    models: document.models.map((model) => ({
      ...model,
      display_name: "New label",
      description: "New model picker description",
    })),
  };
  expect(fingerprintEcoModelCatalog(renamed)).not.toBe(fingerprintEcoModelCatalog(document));
  expect(fingerprintEcoModelCatalogRuntime(renamed)).toBe(baseline);
  for (const changes of [
    { context_window: 32_768 },
    { apply_patch_tool_type: "function" },
    { input_modalities: ["text"] },
    { slug: "new-model-id" },
  ]) {
    expect(
      fingerprintEcoModelCatalogRuntime({
        models: document.models.map((model) => ({ ...model, ...changes })),
      }),
    ).not.toBe(baseline);
  }
});

test("writeEcoCodexModelCatalog is atomic and reports unchanged fingerprints", async () => {
  const dir = await makeTempDir("eco-catalog-write-");
  const catalogPath = path.join(dir, "eco-model-catalog.json");
  const document = buildEcoCodexModelCatalogDocument(nativeModelsFixture(), [
    {
      providerId: "p",
      modelId: "m",
      apiCompat: "anthropic",
    },
  ]);
  const first = await writeEcoCodexModelCatalog(catalogPath, document);
  const second = await writeEcoCodexModelCatalog(catalogPath, document);
  expect(first.changed).toBe(true);
  expect(second.changed).toBe(false);
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(second.fingerprint).toBe(fingerprintEcoModelCatalog(document));
  const body = await fs.readFile(catalogPath, "utf8");
  expect(JSON.parse(body)).toEqual(document);
});

test("syncEcoCodexModelCatalog writes catalog under CODEX_HOME with freeform aliases", async () => {
  const ecoDataDir = await makeTempDir("eco-catalog-sync-");
  const fixture = JSON.stringify({ models: nativeModelsFixture() }, null, 2);
  const result = await syncEcoCodexModelCatalog({
    ecoDataDir,
    codexExecutable: "/bin/true",
    routes: [
      {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        apiCompat: "openai_chat_completions",
        manualSpec: { contextTokens: 96_000 },
      },
    ],
    runCodex: async () => fixture,
  });
  expect(result.catalogPath).toBe(resolveEcoModelCatalogPath(ecoDataDir));
  expect(result.changed).toBe(true);
  expect(result.nativeModelCount).toBe(3);
  expect(result.aliasSlugs.some((slug) => slug.startsWith("eco_route_v1."))).toBe(true);

  const written = JSON.parse(await fs.readFile(result.catalogPath, "utf8")) as {
    models: CodexBundledModelEntry[];
  };
  const alias = written.models.find((entry) => entry.slug.startsWith("eco_route_v1."));
  expect(alias?.apply_patch_tool_type).toBe("freeform");
  expect(alias?.context_window).toBe(96_000);
});

test("syncEcoCodexModelCatalog fails when freeform template is missing", async () => {
  const ecoDataDir = await makeTempDir("eco-catalog-missing-");
  await expect(
    syncEcoCodexModelCatalog({
      ecoDataDir,
      codexExecutable: "/bin/true",
      routes: [],
      runCodex: async () =>
        JSON.stringify({
          models: [{ slug: "only-function", apply_patch_tool_type: "function" }],
        }),
    }),
  ).rejects.toThrow(/freeform/i);
});
