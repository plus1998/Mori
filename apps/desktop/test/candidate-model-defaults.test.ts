import { expect, test } from "bun:test";
import type { CandidateModelView, ModelSettingsSnapshot, RuntimeRoleRouteConfig } from "../src/shared/ipc";
import {
  chatGptCatalogCandidateId,
  codexCatalogCandidateId,
  resolveCandidateModelRouteDefaults,
  isCandidateModelReferenceAvailable,
} from "../src/main/candidate-model-defaults";
import { buildDriverRoutesFromRuntime, resolveThreadRuntimeConfig } from "../src/main/thread-runtime-routes";

const candidate: CandidateModelView = {
  id: "saved-model",
  providerId: "vendor",
  modelId: "upstream-model",
  baseUrl: "https://vendor.example",
  apiCompat: "openai_responses",
  manualSpec: { contextTokens: 200000, maxOutputTokens: 16000 },
  sortOrder: 0,
  createdAt: "2026-11-02T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
};
const source = {
  isBuiltInCodexProvider: (id: string) => id === "openai",
  isChatGptSubscriptionProvider: (id: string) => id === "eco-coding-chatgpt",
  listCandidateModels: (id: string) => (id === "vendor" ? [candidate] : []),
};

test("only deleted candidate references are unavailable; catalog and frozen routes stay valid", () => {
  expect(isCandidateModelReferenceAvailable({ providerId: "vendor", modelId: candidate.modelId, candidateModelId: candidate.id }, source)).toBe(true);
  expect(isCandidateModelReferenceAvailable({ providerId: "vendor", modelId: "deleted", candidateModelId: "deleted-id" }, source)).toBe(false);
  expect(isCandidateModelReferenceAvailable({ providerId: "vendor", modelId: "pinned", baseUrl: "https://saved.example" }, source)).toBe(true);
  expect(isCandidateModelReferenceAvailable({ providerId: "openai", modelId: "gpt-test", candidateModelId: codexCatalogCandidateId("gpt-test") }, source)).toBe(true);
  expect(isCandidateModelReferenceAvailable({ providerId: "eco-coding-chatgpt", modelId: "gpt-test", candidateModelId: "account:eco-coding-chatgpt:gpt-test" }, source)).toBe(true);
  expect(isCandidateModelReferenceAvailable({ providerId: "vendor", modelId: "gpt-test", candidateModelId: codexCatalogCandidateId("gpt-test") }, source)).toBe(false);
});

test("persisted Login catalog selections resolve main and subagent models without stored candidates", () => {
  const routes: RuntimeRoleRouteConfig[] = [
    {
      role: "main",
      providerId: "openai",
      modelId: "gpt-6.1-sol",
      candidateModelId: codexCatalogCandidateId("gpt-6.1-sol"),
    },
    {
      role: "coder",
      providerId: "openai",
      modelId: "gpt-6-luna",
      candidateModelId: "cand-openai-gpt-6-luna",
      thinkingEffort: "high",
    },
  ];
  const resolved = resolveCandidateModelRouteDefaults(routes, {
    ...source,
    listCandidateModels: () => {
      throw new Error("Account catalog selections must not query candidate rows");
    },
  });
  expect(resolved.map((route) => route.candidateModelId)).toEqual([undefined, undefined]);
  expect(routes[1]?.candidateModelId).toBe("cand-openai-gpt-6-luna");
  const settings: ModelSettingsSnapshot = {
    providers: [],
    routeProfiles: [],
    agentTemplates: [],
    mainAgentConfigs: [],
    mainAgentPrompts: [],
    subagentOrchestrations: [],
  };
  const runtime = resolveThreadRuntimeConfig(settings, [], resolved, { requireCompleteCodingRoutes: false });
  expect(runtime.ok).toBe(true);
  if (!runtime.ok) throw new Error(runtime.reason);
  const driverRoutes = buildDriverRoutesFromRuntime(runtime.routes);
  expect(driverRoutes.map((route) => [route.providerId, route.upstreamModelId])).toEqual([
    ["openai", "gpt-6.1-sol"],
    ["openai", "gpt-6-luna"],
  ]);
  expect(driverRoutes[1]?.thinkingEffort).toBe("high");
  // Runtime defaults can be applied more than once during start/continue.
  expect(resolveCandidateModelRouteDefaults(resolved, source)).toEqual(resolved);
});

test("OAuth catalog selections retain the managed provider route without a candidate endpoint", () => {
  const route: RuntimeRoleRouteConfig = {
    role: "reviewer",
    providerId: "eco-coding-chatgpt",
    modelId: "gpt-6-luna",
    candidateModelId: chatGptCatalogCandidateId("gpt-6-luna"),
  };
  expect(resolveCandidateModelRouteDefaults([route], source)).toEqual([
    { role: "reviewer", providerId: "eco-coding-chatgpt", modelId: "gpt-6-luna", apiCompat: "openai_responses" },
  ]);
});

test("per-account OAuth selections use Responses and preserve the exact account without the shared catalog", () => {
  const route: RuntimeRoleRouteConfig = {
    role: "custom_researcher", providerId: "eco-coding-chatgpt", modelId: "gpt-6-luna",
    candidateModelId: "account:eco-coding-chatgpt:gpt-6-luna", accountId: "research-account",
    apiCompat: "anthropic",
  };
  const resolved = resolveCandidateModelRouteDefaults([route], {
    ...source, listCandidateModels: () => { throw new Error("Must use the account catalog"); },
  });
  expect(resolved[0]).toEqual({ role: route.role, providerId: route.providerId,
    modelId: route.modelId, accountId: "research-account", apiCompat: "openai_responses" });
  expect(() => resolveCandidateModelRouteDefaults([{ ...route,
    candidateModelId: "account:eco-coding-chatgpt:different-model" }], source)).toThrow("已不存在");
});

test("catalog-shaped IDs do not bypass missing stored candidate validation", () => {
  const route: RuntimeRoleRouteConfig = {
    role: "coder",
    providerId: "vendor",
    modelId: "gpt-6-luna",
    candidateModelId: "cand-openai-gpt-6-luna",
  };
  expect(() => resolveCandidateModelRouteDefaults([route], source)).toThrow("已不存在");
  expect(() =>
    resolveCandidateModelRouteDefaults([{ ...route, providerId: "openai" }], {
      ...source,
      isBuiltInCodexProvider: () => false,
    }),
  ).toThrow("已不存在");
  expect(() =>
    resolveCandidateModelRouteDefaults(
      [
        {
          ...route,
          providerId: "eco-coding-chatgpt",
          candidateModelId: chatGptCatalogCandidateId(route.modelId),
        },
      ],
      { ...source, isChatGptSubscriptionProvider: () => false },
    ),
  ).toThrow("已不存在");
});

test("mismatched and missing account candidate references still fail", () => {
  for (const candidateModelId of ["saved-but-deleted", "cand-openai-other-model"]) {
    expect(() =>
      resolveCandidateModelRouteDefaults(
        [{ role: "coder", providerId: "openai", modelId: "gpt-6-luna", candidateModelId }],
        source,
      ),
    ).toThrow("已不存在");
  }
});

test("stored candidates keep endpoint defaults and route capability overrides", () => {
  const resolved = resolveCandidateModelRouteDefaults(
    [
      {
        role: "coder",
        providerId: "vendor",
        modelId: "old-model",
        candidateModelId: candidate.id,
        manualSpec: { maxOutputTokens: 8000 },
      },
    ],
    source,
  );
  expect(resolved[0]).toMatchObject({
    modelId: "upstream-model",
    baseUrl: candidate.baseUrl,
    apiCompat: "openai_responses",
    requestPath: "",
    version: "v1",
    manualSpec: { contextTokens: 200000, maxOutputTokens: 8000 },
  });
});

test("stored candidate protocol and endpoint errors remain explicit", () => {
  const route: RuntimeRoleRouteConfig = {
    role: "coder",
    providerId: "vendor",
    modelId: candidate.modelId,
    candidateModelId: candidate.id,
  };
  expect(() =>
    resolveCandidateModelRouteDefaults([route], {
      ...source,
      listCandidateModels: () => [{ ...candidate, apiCompat: "system_one" }],
    }),
  ).toThrow("仅可作为审批模型");
  const { baseUrl: _baseUrl, ...withoutEndpoint } = candidate;
  expect(() =>
    resolveCandidateModelRouteDefaults([route], {
      ...source,
      listCandidateModels: () => [withoutEndpoint],
    }),
  ).toThrow("缺少端点或协议配置");
});

test("pinned task endpoints do not relink to current candidate defaults", () => {
  const route: RuntimeRoleRouteConfig = {
    role: "explore", providerId: candidate.providerId, modelId: candidate.modelId,
    baseUrl: "https://pinned.example", apiCompat: "anthropic", requestPath: "", version: "v1",
  };
  expect(resolveCandidateModelRouteDefaults([route], {
    ...source, listCandidateModels: () => { throw new Error("Pinned routes must not query mutable candidates"); },
  })).toEqual([route]);
  expect(() => resolveCandidateModelRouteDefaults([{ ...route, candidateModelId: "deleted" }], source)).toThrow("已不存在");
});
