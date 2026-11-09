import { expect, test } from "bun:test";
import { buildResourcesFromRouteProfile } from "../src/shared/agent-orchestration";
import type { CandidateModelView, ModelSettingsSnapshot } from "../src/shared/ipc";
import { buildAcpThreadRuntimeConfig, materializeThreadOrchestrationSnapshot, resolveThreadOrchestrationSnapshot, runtimeRoleRoutesFromOrchestrationSnapshot } from "../src/shared/thread-runtime-config";
import { freezeSchedulingProfile } from "../src/main/scheduling-profile";
import { resolveCandidateModelRouteDefaults } from "../src/main/candidate-model-defaults";
import { replaceSchedulingMainModel } from "../src/renderer/scheduling-task-profile";

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
    providers: [], routeProfiles: [], agentTemplates: [], mainAgentConfigs: [bundle.mainAgentConfig],
    mainAgentPrompts: [], subagentOrchestrations: [bundle.subagentOrchestration],
  };
  const source = {
    isBuiltInCodexProvider: () => false, isChatGptSubscriptionProvider: () => false,
    listCandidateModels: (id: string) => id === nextModel.providerId ? [nextModel] : [],
  };
  const resolveRoutes = (config: ReturnType<typeof buildAcpThreadRuntimeConfig>) =>
    resolveCandidateModelRouteDefaults(runtimeRoleRoutesFromOrchestrationSnapshot(resolveThreadOrchestrationSnapshot(settings, config)!, config.mainAgentModelOverride), source);
  const initial = { coreKind: "pi" as const, runtimeConfig: {
    ...buildAcpThreadRuntimeConfig(), ...materializeThreadOrchestrationSnapshot(settings, bundle.selection),
  } };
  // Model defaults were pinned when the task was created; the global
  // orchestration still contains the now-deleted soft reference.
  const saved = freezeSchedulingProfile(initial, settings, config =>
    runtimeRoleRoutesFromOrchestrationSnapshot(resolveThreadOrchestrationSnapshot(settings, config)!).map(route => ({
      ...route, baseUrl: "https://saved.example", apiCompat: "openai_responses" as const,
      requestPath: "", version: "v1", tokenCountMode: "provider_native" as const,
    })));
  return { settings, resolveRoutes, saved, initial };
}

test("changing a scheduled task main model preserves frozen subagents instead of reloading deleted candidates", () => {
  const { settings, resolveRoutes, saved } = fixture();
  const before = structuredClone(saved);
  const edited = replaceSchedulingMainModel(saved, settings, nextModel);
  // This was the editor's old behavior: reload the global orchestration while
  // changing the main model, resurrecting the deleted subagent references.
  expect(() => resolveRoutes({ ...edited.runtimeConfig,
    ...materializeThreadOrchestrationSnapshot(settings, edited.runtimeConfig.orchestrationSelection!),
  })).toThrow("模型 deleted-candidate 已不存在");
  const frozen = freezeSchedulingProfile(edited, settings, resolveRoutes);
  expect(frozen.runtimeConfig.resolvedOrchestrationSnapshot?.mainAgent.modelRef).toMatchObject({
    providerId: nextModel.providerId, modelId: nextModel.modelId, apiCompat: "anthropic", baseUrl: nextModel.baseUrl,
  });
  expect(frozen.runtimeConfig.resolvedOrchestrationSnapshot?.agents).toEqual(saved.runtimeConfig.resolvedOrchestrationSnapshot?.agents);
  expect(resolveRoutes(frozen.runtimeConfig).filter(route => route.role !== "main").every(route =>
    route.baseUrl === "https://saved.example" && route.requestPath === "" && route.tokenCountMode === "provider_native" && !route.candidateModelId)).toBe(true);
  expect(saved).toEqual(before);
});

test("editing a saved task works after its global orchestration has been deleted", () => {
  const { settings, resolveRoutes, saved } = fixture();
  settings.mainAgentConfigs = [];
  settings.subagentOrchestrations = [];
  saved.runtimeConfig.mainAgentModelOverride = { providerId: "old-provider", modelId: "override", candidateModelId: "deleted-candidate" };
  const edited = replaceSchedulingMainModel(saved, settings, nextModel);
  expect(edited.runtimeConfig.mainAgentModelOverride).toBeUndefined();
  expect(edited.runtimeConfig.orchestrationSelection?.mainModel?.candidateModelId).toBe(nextModel.id);
  expect(() => freezeSchedulingProfile(edited, settings, resolveRoutes)).not.toThrow();
});

test("an unresolved deleted subagent candidate is still rejected explicitly", () => {
  const { settings, resolveRoutes, initial } = fixture();
  const edited = replaceSchedulingMainModel(initial, settings, nextModel);
  expect(() => freezeSchedulingProfile(edited, settings, resolveRoutes)).toThrow("模型 deleted-candidate 已不存在");
});
