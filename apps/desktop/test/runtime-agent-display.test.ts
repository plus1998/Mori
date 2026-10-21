import { expect, test } from "bun:test";
import {
  buildRuntimeAgentDisplayNames,
  formatRuntimeRoleModelLabel,
  resolveRuntimeAgentName,
} from "../src/renderer/runtime-agent-display";
import {
  buildResourcesFromRouteProfile,
  createBuiltInAgentTemplates,
  resolveOrchestrationSnapshot,
} from "../src/shared/agent-orchestration";
import type { ModelSettingsSnapshot, RouteProfileView, ThreadRuntimeConfig } from "../src/shared/ipc";

const routeProfile: RouteProfileView = {
  id: "coding-default",
  name: "Default Coding",
  routes: [
    { role: "main", providerId: "openai", modelId: "gpt-5-codex" },
    { role: "explore", providerId: "openai", modelId: "gpt-5-mini" },
    { role: "architect", providerId: "openai", modelId: "gpt-5" },
    { role: "coder", providerId: "openai", modelId: "gpt-5-codex" },
    { role: "reviewer", providerId: "openai", modelId: "gpt-5" },
    { role: "tester", providerId: "openai", modelId: "gpt-5-mini" },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const bundle = buildResourcesFromRouteProfile(routeProfile, {
  mainAgentConfigId: "main.coding",
  subagentOrchestrationId: "subagents.coding",
});
const settings: ModelSettingsSnapshot = {
  providers: [],
  routeProfiles: [routeProfile],
  agentTemplates: createBuiltInAgentTemplates(),
  mainAgentConfigs: [bundle.mainAgentConfig],
  mainAgentPrompts: [],
  subagentOrchestrations: [bundle.subagentOrchestration],
};

function runtimeConfig(sessionMode: "agent" | "plan"): ThreadRuntimeConfig {
  const snapshot = resolveOrchestrationSnapshot(bundle.selection, settings);
  return {
    orchestrationSelection: bundle.selection,
    resolvedOrchestrationSnapshot: snapshot,
    sessionMode,
    bashReviewMode: "auto",
    subagentEnabled: {
      explore: true,
      architect: true,
      coder: true,
      reviewer: sessionMode === "agent",
      tester: true,
    },
  };
}

test("buildRuntimeAgentDisplayNames maps snapshot agents to runtime roles", () => {
  const names = buildRuntimeAgentDisplayNames(settings, runtimeConfig("plan"));

  expect(names.main).toBe("Default Coding Main Config");
  expect(names.main).toBe("Default Coding Main Config");
  expect(names.explore).toBe("Explore");
  expect(names.eco_explore).toBe("Explore");
  expect(resolveRuntimeAgentName("eco_coder", names)).toBe("Coder");
});

test("formatRuntimeRoleModelLabel prefers runtime agent names and falls back to role labels", () => {
  const names = buildRuntimeAgentDisplayNames(settings, runtimeConfig("agent"));

  expect(formatRuntimeRoleModelLabel("reviewer", "gpt-5", names)).toBe("Reviewer · gpt-5");
  expect(formatRuntimeRoleModelLabel("unknown", "model-x", names)).toBe("unknown · model-x");
});
