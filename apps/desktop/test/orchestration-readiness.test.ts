import { expect, test } from "bun:test";
import {
  areCodingRoutesReady,
  diagnoseOrchestrationSnapshotReadiness,
  invalidOrchestrationFieldsFromIssues,
  isOrchestrationSnapshotReady,
  orchestrationIssueDetailKey,
} from "../src/renderer/orchestration-readiness";
import { CODING_AGENT_TEMPLATE_IDS, createBuiltInAgentTemplates } from "../src/shared/agent-orchestration";
import type { ModelSettingsSnapshot, ResolvedOrchestrationSnapshot, ToolPolicy } from "../src/shared/ipc";

const tools: ToolPolicy = { allowed: [], disallowed: [] };
const exploreTools = createBuiltInAgentTemplates().find(
  (template) => template.id === CODING_AGENT_TEMPLATE_IDS.explore,
)!.defaultTools;

const provider: ModelSettingsSnapshot["providers"][number] = {
  id: "p1",
  name: "Provider",
  baseUrl: "https://api.example.test",
  requestPath: "",
  version: "v1",
  apiCompat: "anthropic",
  defaultModel: "main-model",
  enabled: true,
  hasApiKey: true,
  apiKeyPreview: "sk-...",
  createdAt: "2026-06-07T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
};

function orchestrationSnapshot(agentEnabled: boolean): ResolvedOrchestrationSnapshot {
  return {
    selection: {
      mainAgentConfigId: "custom-main",
      mainPrompt: { mode: "custom_append", promptId: "custom-prompt" },
      subagents: { mode: "orchestration", orchestrationId: "custom-subagents" },
    },
    mainAgentConfigName: "Custom Main",
    mainPromptDisplayName: "Custom Prompt",
    subagentOrchestrationDisplayName: "Custom Subagents",
    mainAgent: {
      agentKey: "main",
      name: "Main",
      systemPromptPreset: "custom_append",
      prompt: "Lead.",
      modelRef: { providerId: "p1", modelId: "main-model" },
      tools,
      skills: [],
    },
    agents: [
      {
        agentKey: "explore",
        templateId: CODING_AGENT_TEMPLATE_IDS.explore,
        modelRef: { providerId: "p1", modelId: "explore-model" },
        tools: exploreTools,
        mcpServers: [],
        skills: [],
        enabled: true,
      },
      {
        agentKey: "draft",
        templateId: "draft",
        modelRef: { providerId: "missing", modelId: "draft-model" },
        tools,
        mcpServers: [],
        skills: [],
        enabled: agentEnabled,
      },
    ],
    strategy: { kind: "autonomous" },
    resolvedAt: "2026-06-07T00:00:00.000Z",
  };
}

test("isOrchestrationSnapshotReady ignores disabled agent model refs", () => {
  const providers = new Map([[provider.id, provider]]);

  expect(isOrchestrationSnapshotReady(orchestrationSnapshot(false), providers)).toBe(true);
  expect(isOrchestrationSnapshotReady(orchestrationSnapshot(true), providers)).toBe(false);
});

test("isOrchestrationSnapshotReady validates Explore when its node exists", () => {
  const providers = new Map([[provider.id, provider]]);
  const draft = orchestrationSnapshot(false);
  draft.agents[0]!.modelRef = { providerId: "missing", modelId: "explore-model" };

  expect(isOrchestrationSnapshotReady(draft, providers)).toBe(false);
  draft.agents = draft.agents.filter((agent) => agent.agentKey !== "explore");
  expect(isOrchestrationSnapshotReady(draft, providers)).toBe(true);
});

test("isOrchestrationSnapshotReady evaluates the temporary main model override", () => {
  const overrideProvider = { ...provider, id: "p2", name: "Override Provider" };
  const providers = new Map([
    [provider.id, provider],
    [overrideProvider.id, overrideProvider],
  ]);
  const draft = orchestrationSnapshot(false);
  draft.mainAgent.modelRef = { providerId: "p1", modelId: "" };

  expect(isOrchestrationSnapshotReady(draft, providers)).toBe(false);
  expect(
    isOrchestrationSnapshotReady(draft, providers, {
      providerId: "p1",
      modelId: "gpt-5.6-sol",
      thinkingEffort: "high",
    }),
  ).toBe(true);
  expect(
    isOrchestrationSnapshotReady(draft, providers, {
      providerId: "p2",
      modelId: "gpt-5.6-sol",
      thinkingEffort: "high",
    }),
  ).toBe(false);
});

test("areCodingRoutesReady accepts the actual configured coding roster", () => {
  const providers = new Map([[provider.id, provider]]);

  expect(
    areCodingRoutesReady(
      [
        { role: "main", providerId: "p1", modelId: "main-model" },
        { role: "coder", providerId: "p1", modelId: "coder-model" },
      ],
      providers,
    ),
  ).toBe(true);
});

test("diagnoseOrchestrationSnapshotReadiness reports disabled provider on enabled subagent", () => {
  const disabled = { ...provider, id: "mycodexfree", name: "MyCodexFree", enabled: false };
  const providers = new Map([
    [provider.id, provider],
    [disabled.id, disabled],
  ]);
  const draft = orchestrationSnapshot(false);
  draft.agents[0]!.modelRef = { providerId: "mycodexfree", modelId: "gpt-5.6-luna" };

  const issues = diagnoseOrchestrationSnapshotReadiness(draft, providers);
  expect(issues).toEqual([
    {
      field: "subagentOrchestration",
      kind: "provider_disabled",
      agentKey: "explore",
      providerId: "mycodexfree",
      providerName: "MyCodexFree",
      modelId: "gpt-5.6-luna",
      orchestrationName: "Custom Subagents",
    },
  ]);
  expect(invalidOrchestrationFieldsFromIssues(issues)).toEqual(["subagentOrchestration"]);
});

test("diagnoseOrchestrationSnapshotReadiness reports missing provider and empty main model", () => {
  const providers = new Map([[provider.id, provider]]);
  const draft = orchestrationSnapshot(false);
  draft.mainAgent.modelRef = { providerId: "p1", modelId: "" };
  draft.agents[0]!.modelRef = { providerId: "gone", modelId: "explore-model" };

  const issues = diagnoseOrchestrationSnapshotReadiness(draft, providers);
  expect(issues).toEqual([
    {
      field: "mainAgent",
      kind: "model_empty",
      providerId: "p1",
      providerName: "Provider",
      modelId: "",
      mainAgentConfigName: "Custom Main",
    },
    {
      field: "subagentOrchestration",
      kind: "provider_missing",
      agentKey: "explore",
      providerId: "gone",
      providerName: "gone",
      modelId: "explore-model",
      orchestrationName: "Custom Subagents",
    },
  ]);
  expect(invalidOrchestrationFieldsFromIssues(issues)).toEqual(["mainAgent", "subagentOrchestration"]);
});

test("diagnoseOrchestrationSnapshotReadiness is empty when snapshot is ready", () => {
  const providers = new Map([[provider.id, provider]]);
  expect(diagnoseOrchestrationSnapshotReadiness(orchestrationSnapshot(false), providers)).toEqual([]);
});

test("orchestrationIssueDetailKey maps field and kind to i18n keys", () => {
  expect(
    orchestrationIssueDetailKey({
      field: "subagentOrchestration",
      kind: "provider_disabled",
      providerId: "x",
      providerName: "X",
      modelId: "m",
      agentKey: "explore",
    }),
  ).toBe("composer.hint.issue.subagent.provider_disabled");
  expect(
    orchestrationIssueDetailKey({
      field: "mainAgent",
      kind: "model_empty",
      providerId: "p1",
      providerName: "Provider",
      modelId: "",
    }),
  ).toBe("composer.hint.issue.main.model_empty");
});
