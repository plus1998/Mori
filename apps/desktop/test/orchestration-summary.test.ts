import { expect, test } from "bun:test";
import {
  buildOrchestrationSummary,
  formatOrchestrationDisplayName,
  resolveThreadOrchestrationSummary,
} from "../src/renderer/orchestration-summary";
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
  routeProfiles: [],
  agentTemplates: createBuiltInAgentTemplates(),
  mainAgentConfigs: [bundle.mainAgentConfig],
  mainAgentPrompts: [],
  subagentOrchestrations: [bundle.subagentOrchestration],
};
const snapshot = resolveOrchestrationSnapshot(bundle.selection, settings);

function runtimeConfig(): ThreadRuntimeConfig {
  return {
    orchestrationSelection: bundle.selection,
    resolvedOrchestrationSnapshot: snapshot,
    sessionMode: "plan",
    bashReviewMode: "auto",
    subagentEnabled: {
      explore: true,
      architect: false,
      coder: true,
      reviewer: false,
      tester: true,
    },
  };
}

test("buildOrchestrationSummary describes the three selected components", () => {
  const summary = buildOrchestrationSummary(settings, snapshot);

  expect(summary.selection).toEqual(bundle.selection);
  expect(summary.name).toBe("Default Coding Main Config · 内置提示词 · Default Coding Subagents");
  expect(summary.main.modelId).toBe("gpt-5-codex");
  expect(summary.enabledAgents.find((agent) => agent.agentKey === "explore")?.modelId).toBe("gpt-5-mini");
});

test("thread orchestration summary applies runtime subagent switches", () => {
  const summary = resolveThreadOrchestrationSummary(settings, runtimeConfig());

  expect(summary?.enabledAgents.map((agent) => agent.agentKey)).toEqual(["explore", "coder", "tester"]);
  expect(summary?.disabledAgentCount).toBe(2);
  expect(summary?.highRiskLabels).toHaveLength(3);
  expect(summary?.highRiskLabels).toContain("Bash");
});

test("formatOrchestrationDisplayName has no saved-combination identity", () => {
  expect(formatOrchestrationDisplayName(snapshot)).toContain("Default Coding Main Config");
  expect(formatOrchestrationDisplayName(snapshot)).toContain("Default Coding Subagents");
  expect(formatOrchestrationDisplayName(snapshot)).not.toContain("coding-default");
});
