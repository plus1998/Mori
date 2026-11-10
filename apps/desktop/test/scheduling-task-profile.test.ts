import { expect, test } from "bun:test";
import { buildResourcesFromRouteProfile } from "../src/shared/agent-orchestration";
import type { CandidateModelView, ModelSettingsSnapshot } from "../src/shared/ipc";
import { buildAcpThreadRuntimeConfig, materializeThreadOrchestrationSnapshot, resolveThreadOrchestrationSnapshot, runtimeRoleRoutesFromOrchestrationSnapshot } from "../src/shared/thread-runtime-config";
import { freezeSchedulingProfile } from "../src/main/scheduling-profile";
import { isCandidateModelReferenceAvailable, resolveCandidateModelRouteDefaults } from "../src/main/candidate-model-defaults";
import { replaceSchedulingMainModel } from "../src/renderer/scheduling-task-profile";
import { resolveThreadRuntimeConfig } from "../src/main/thread-runtime-routes";

const nextModel: CandidateModelView = {
  id: "new-candidate", providerId: "new-provider", modelId: "claude-haiku", displayName: "Haiku",
  apiCompat: "anthropic", baseUrl: "https://new.example", sortOrder: 0,
  createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
};

function fixture() {
  const bundle = buildResourcesFromRouteProfile({
    id: "old-profile", name: "Saved task",
    routes: (["main", "explore", "architect", "coder", "reviewer", "tester"] as const).map(role => ({
      role, providerId: "old-provider", modelId: "deepseek-flash", candidateModelId: "deleted-candidate",
    })), createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  }, { mainAgentConfigId: "main", subagentOrchestrationId: "subagents" });
  bundle.mainAgentConfig.modelRef.candidateModelId = "deleted-candidate";
  for (const agent of bundle.subagentOrchestration.agents) agent.modelRef.candidateModelId = "deleted-candidate";
  const settings: ModelSettingsSnapshot = {
    providers: ["old-provider", nextModel.providerId].map(id => ({
      id, name: id, baseUrl: "https://provider.example", requestPath: "", version: "v1",
      apiCompat: "anthropic" as const, defaultModel: "default", enabled: true, hasApiKey: true,
      createdAt: nextModel.createdAt, updatedAt: nextModel.updatedAt,
    })), routeProfiles: [], agentTemplates: [], mainAgentConfigs: [bundle.mainAgentConfig],
    mainAgentPrompts: [], subagentOrchestrations: [bundle.subagentOrchestration],
  };
  const source = {
    isBuiltInCodexProvider: () => false, isChatGptSubscriptionProvider: () => false,
    listCandidateModels: (id: string) => id === nextModel.providerId ? [nextModel] : [],
  };
  const resolveRoutes = (config: ReturnType<typeof buildAcpThreadRuntimeConfig>) =>
    resolveCandidateModelRouteDefaults(runtimeRoleRoutesFromOrchestrationSnapshot(resolveThreadOrchestrationSnapshot(settings, config)!, config.mainAgentModelOverride), source);
  const isModelAvailable = (model: Parameters<typeof isCandidateModelReferenceAvailable>[0]) =>
    settings.providers.some(provider => provider.id === model.providerId) && isCandidateModelReferenceAvailable(model, source);
  const initial = { coreKind: "pi" as const, runtimeConfig: {
    ...buildAcpThreadRuntimeConfig(), ...materializeThreadOrchestrationSnapshot(settings, bundle.selection),
  } };
  // Model defaults were pinned when the task was created; the global
  // orchestration still contains the now-deleted soft reference.
  const saved = freezeSchedulingProfile(initial, settings, config =>
    runtimeRoleRoutesFromOrchestrationSnapshot(resolveThreadOrchestrationSnapshot(settings, config)!).map(route => ({
      ...route, baseUrl: "https://saved.example", apiCompat: "openai_responses" as const,
      requestPath: "", version: "v1", tokenCountMode: "provider_native" as const,
    })), () => true);
  return { settings, resolveRoutes, isModelAvailable, saved, initial };
}

test("changing a scheduled task main model preserves frozen subagents instead of reloading deleted candidates", () => {
  const { settings, resolveRoutes, isModelAvailable, saved } = fixture();
  const before = structuredClone(saved);
  const edited = replaceSchedulingMainModel(saved, settings, nextModel);
  // This was the editor's old behavior: reload the global orchestration while
  // changing the main model, resurrecting the deleted subagent references.
  expect(() => resolveRoutes({ ...edited.runtimeConfig,
    ...materializeThreadOrchestrationSnapshot(settings, edited.runtimeConfig.orchestrationSelection!),
  })).toThrow("模型 deleted-candidate 已不存在");
  const frozen = freezeSchedulingProfile(edited, settings, resolveRoutes, isModelAvailable);
  expect(frozen.runtimeConfig.resolvedOrchestrationSnapshot?.mainAgent.modelRef).toMatchObject({
    providerId: nextModel.providerId, modelId: nextModel.modelId, apiCompat: "anthropic", baseUrl: nextModel.baseUrl,
  });
  expect(frozen.runtimeConfig.resolvedOrchestrationSnapshot?.agents).toEqual(saved.runtimeConfig.resolvedOrchestrationSnapshot?.agents);
  expect(resolveRoutes(frozen.runtimeConfig).filter(route => route.role !== "main").every(route =>
    route.baseUrl === "https://saved.example" && route.requestPath === "" && route.tokenCountMode === "provider_native" && !route.candidateModelId)).toBe(true);
  expect(saved).toEqual(before);
});

test("editing a saved task works after its global orchestration has been deleted", () => {
  const { settings, resolveRoutes, isModelAvailable, saved } = fixture();
  settings.mainAgentConfigs = [];
  settings.subagentOrchestrations = [];
  saved.runtimeConfig.mainAgentModelOverride = { providerId: "old-provider", modelId: "override", candidateModelId: "deleted-candidate" };
  const edited = replaceSchedulingMainModel(saved, settings, nextModel);
  expect(edited.runtimeConfig.mainAgentModelOverride).toBeUndefined();
  expect(edited.runtimeConfig.orchestrationSelection?.mainModel?.candidateModelId).toBe(nextModel.id);
  const frozen = freezeSchedulingProfile(edited, settings, resolveRoutes, isModelAvailable);
  expect(frozen.runtimeConfig.resolvedOrchestrationSnapshot?.agents).toEqual([]);
  expect(frozen.runtimeConfig.orchestrationSelection?.subagents).toEqual({ mode: "none" });
});

test("deleted subagent candidates are automatically removed before resolving routes", () => {
  const { settings, resolveRoutes, isModelAvailable, initial } = fixture();
  const edited = replaceSchedulingMainModel(initial, settings, nextModel);
  const frozen = freezeSchedulingProfile(edited, settings, resolveRoutes, isModelAvailable);
  expect(frozen.runtimeConfig.resolvedOrchestrationSnapshot?.agents).toEqual([]);
  expect(frozen.runtimeConfig.orchestrationSelection?.subagents).toEqual({ mode: "none" });
  expect(Object.values(frozen.runtimeConfig.subagentEnabled).every(enabled => !enabled)).toBe(true);
});

test("saving a new main model automatically clears subagents whose provider was deleted", () => {
  const { settings, resolveRoutes, isModelAvailable, saved } = fixture();
  settings.providers = settings.providers.filter(provider => provider.id !== "old-provider");
  const edited = replaceSchedulingMainModel(saved, settings, nextModel);
  const before = structuredClone(edited);
  const frozen = freezeSchedulingProfile(edited, settings, resolveRoutes, isModelAvailable);
  const providers = settings.providers.map(provider => ({ ...provider, apiKey: "test" }));
  expect(resolveThreadRuntimeConfig(settings, providers, resolveRoutes(frozen.runtimeConfig), { requireCompleteCodingRoutes: false }).ok).toBe(true);
  expect(frozen.runtimeConfig.resolvedOrchestrationSnapshot?.agents).toEqual([]);
  expect(frozen.runtimeConfig.resolvedOrchestrationSnapshot?.subagentOrchestrationDisplayName).toBeUndefined();
  expect(frozen.runtimeConfig.resolvedOrchestrationSnapshot?.strategy).toEqual({ kind: "autonomous" });
  expect(Object.values(frozen.runtimeConfig.subagentEnabled).every(enabled => !enabled)).toBe(true);
  expect(frozen.runtimeConfig.orchestrationSelection?.subagents).toEqual({ mode: "none" });
  expect(frozen.runtimeConfig.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe(nextModel.modelId);
  expect(edited).toEqual(before);
});

test("a mixed roster keeps valid frozen agents and the task's saved prompt and permissions", () => {
  const { settings, resolveRoutes, isModelAvailable, saved } = fixture();
  const snapshot = saved.runtimeConfig.resolvedOrchestrationSnapshot!;
  snapshot.mainAgent.prompt = "Saved custom prompt";
  snapshot.mainAgent.systemPromptPreset = "custom_append";
  snapshot.selection.mainPrompt = { mode: "custom_append", promptId: "deleted-prompt" };
  saved.runtimeConfig.orchestrationSelection = structuredClone(snapshot.selection);
  saved.runtimeConfig.bashReviewMode = "allow_all";
  saved.runtimeConfig.mcpServersEnabled = { saved: true };
  snapshot.agents[0]!.modelRef = { providerId: nextModel.providerId, modelId: "pinned-agent", baseUrl: "https://pinned.example", apiCompat: "anthropic" };
  settings.providers = settings.providers.filter(provider => provider.id !== "old-provider");
  const edited = replaceSchedulingMainModel(saved, settings, nextModel);
  const before = structuredClone(edited);
  const frozen = freezeSchedulingProfile(edited, settings, resolveRoutes, isModelAvailable);
  const result = frozen.runtimeConfig.resolvedOrchestrationSnapshot!;
  expect(result.agents).toEqual([snapshot.agents[0]!]);
  expect(result.mainAgent.prompt).toBe(snapshot.mainAgent.prompt);
  expect(result.selection.mainPrompt).toEqual(snapshot.selection.mainPrompt);
  expect(frozen.runtimeConfig.mcpServersEnabled).toEqual({ saved: true });
  expect(frozen.runtimeConfig.bashReviewMode).toBe("allow_all");
  expect(frozen.runtimeConfig.subagentEnabled.explore).toBe(true);
  expect(frozen.runtimeConfig.subagentEnabled.coder).toBe(false);
  expect(edited).toEqual(before);
});
