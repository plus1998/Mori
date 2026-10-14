import { expect, test } from "bun:test";
import { buildResourcesFromRouteProfile } from "../src/shared/agent-orchestration";
import { freezeSchedulingProfile } from "../src/main/scheduling-profile";
import { materializeThreadOrchestrationSnapshot, buildAcpThreadRuntimeConfig, normalizeThreadRuntimeConfig, resolveThreadOrchestrationSnapshot, runtimeRoleRoutesFromOrchestrationSnapshot } from "../src/shared/thread-runtime-config";
import type { ModelSettingsSnapshot } from "../src/shared/ipc";

test("freezes effective main-model override and stays fixed when global configuration changes", () => {
  const bundle = buildResourcesFromRouteProfile({ id: "base", name: "Base", routes: (["planner", "explore", "architect", "coder", "reviewer", "tester"] as const).map(role => ({ role, providerId: "provider", modelId: "expensive" })), createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }, { mainAgentConfigId: "main", subagentOrchestrationId: "unused" });
  const settings: ModelSettingsSnapshot = { providers: [], routeProfiles: [], agentTemplates: [], mainAgentConfigs: [bundle.mainAgentConfig], mainAgentPrompts: [], subagentOrchestrations: [] };
  const selection = { mainAgentConfigId: "main", mainPrompt: { mode: "builtin" as const }, subagents: { mode: "none" as const } };
  const config = normalizeThreadRuntimeConfig({ ...buildAcpThreadRuntimeConfig(), ...materializeThreadOrchestrationSnapshot(settings, selection), mainAgentModelOverride: { providerId: "provider", modelId: "cheap", candidateModelId: "candidate" } });
  const saved = freezeSchedulingProfile({ coreKind: "pi", runtimeConfig: config }, settings, input => runtimeRoleRoutesFromOrchestrationSnapshot(resolveThreadOrchestrationSnapshot(settings, input)!, input.mainAgentModelOverride).map(route => ({ ...route, modelId: "effective-cheap" })));
  expect(saved.coreKind).toBe("pi");
  expect(saved.runtimeConfig.mainAgentModelOverride).toBeUndefined();
  expect(saved.runtimeConfig.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("effective-cheap");
  expect(saved.runtimeConfig.resolvedOrchestrationSnapshot?.mainAgent.modelRef.candidateModelId).toBeUndefined();
  settings.mainAgentConfigs[0]!.modelRef.modelId = "new-expensive-default";
  expect(resolveThreadOrchestrationSnapshot(settings, saved.runtimeConfig)?.mainAgent.modelRef.modelId).toBe("effective-cheap");
});

test("incomplete configuration and implicit Cursor model are rejected", () => {
  const settings: ModelSettingsSnapshot = { providers: [], routeProfiles: [], agentTemplates: [], mainAgentConfigs: [], mainAgentPrompts: [], subagentOrchestrations: [] };
  expect(() => freezeSchedulingProfile({ coreKind: "claude", runtimeConfig: buildAcpThreadRuntimeConfig() }, settings, () => [])).toThrow();
  expect(() => freezeSchedulingProfile({ coreKind: "acp", runtimeConfig: buildAcpThreadRuntimeConfig() }, settings, () => [])).toThrow();
});
