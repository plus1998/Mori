import { expect, test } from "bun:test";
import { buildComposerGlobalRuntimeConfig } from "../src/renderer/composer-global-runtime-config";
import { buildResourcesFromRouteProfile } from "../src/shared/agent-orchestration";
import type { ModelSettingsSnapshot, WorkflowSettingsSnapshot } from "../src/shared/ipc";

const emptySettings: ModelSettingsSnapshot = {
  providers: [],
  routeProfiles: [],
  agentTemplates: [],
  mainAgentConfigs: [],
  mainAgentPrompts: [],
  subagentOrchestrations: [],
};

const globalEcoBundle = buildResourcesFromRouteProfile(
  {
    id: "global-default",
    name: "Global default",
    routes: [
      { role: "main", providerId: "provider-1", modelId: "main-global" },
      { role: "explore", providerId: "provider-1", modelId: "main-global" },
      { role: "architect", providerId: "provider-1", modelId: "main-global" },
      { role: "coder", providerId: "provider-1", modelId: "main-global" },
      { role: "reviewer", providerId: "provider-1", modelId: "main-global" },
      { role: "tester", providerId: "provider-1", modelId: "main-global" },
    ],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  },
  {
    mainAgentConfigId: "global-main",
    subagentOrchestrationId: "global-subagents",
  },
);

const globalEcoSettings: ModelSettingsSnapshot = {
  ...emptySettings,
  mainAgentConfigs: [globalEcoBundle.mainAgentConfig],
  mainAgentPrompts: globalEcoBundle.mainAgentPrompt ? [globalEcoBundle.mainAgentPrompt] : [],
  subagentOrchestrations: [globalEcoBundle.subagentOrchestration],
};

function workflowDefaults(overrides: Partial<WorkflowSettingsSnapshot> = {}): WorkflowSettingsSnapshot {
  return {
    sessionMode: "agent",
    contextWindowLimitTokens: 262_144,
    maxOutputLimitTokens: 32_768,
    followUpDeliveryMode: "steer",
    ...overrides,
  };
}

test("builds ACP Composer config from global settings", () => {
  const config = buildComposerGlobalRuntimeConfig({
    coreKind: "acp",
    settings: emptySettings,
    workflowDefaults: workflowDefaults({
      sessionMode: "plan",
      acpCursorModelId: "global-cursor-model",
      defaultAuxiliaryModel: {
        providerId: "provider-1",
        modelId: "auxiliary-global",
        candidateModelId: "candidate-auxiliary",
      },
      defaultVisionModel: {
        providerId: "provider-1",
        modelId: "vision-global",
        candidateModelId: "candidate-vision",
      },
      integrationsEnabled: { browser: true },
    }),
    mcpServers: [],
  });

  expect(config).toMatchObject({
    cursorModelId: "global-cursor-model",
    sessionMode: "agent",
    auxiliaryModel: {
      modelId: "auxiliary-global",
    },
    visionModel: {
      modelId: "vision-global",
    },
    integrationsEnabled: { browser: true },
  });
  expect(config?.orchestrationSelection).toBeUndefined();
});

test("builds Eco Composer config from the global default orchestration", () => {
  const config = buildComposerGlobalRuntimeConfig({
    coreKind: "claude",
    settings: globalEcoSettings,
    workflowDefaults: workflowDefaults({
      sessionMode: "plan",
      defaultOrchestrationSelection: globalEcoBundle.selection,
      defaultAuxiliaryModel: {
        providerId: "provider-1",
        modelId: "auxiliary-global",
      },
    }),
    mcpServers: [],
  });

  expect(config?.sessionMode).toBe("agent");
  expect(config?.orchestrationSelection).toEqual(globalEcoBundle.selection);
  expect(config?.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("main-global");
  expect(config?.auxiliaryModel?.modelId).toBe("auxiliary-global");
});

test("does not fall back to project settings when the global Eco config is missing", () => {
  const config = buildComposerGlobalRuntimeConfig({
    coreKind: "claude",
    settings: emptySettings,
    workflowDefaults: workflowDefaults(),
    mcpServers: [],
  });

  expect(config).toBeUndefined();
});
