import { expect, test } from "bun:test";
import { buildComposerAgentModelLabels } from "../src/renderer/composer-agent-model-labels";
import type { ResolvedOrchestrationSnapshot, ToolPolicy } from "../src/shared/ipc";
import { withTestLanguage } from "./support/test-language";

withTestLanguage("en-US");

const tools: ToolPolicy = { allowed: [], disallowed: [] };

const snapshot: ResolvedOrchestrationSnapshot = {
  selection: {
    mainAgentConfigId: "research-main",
    mainPrompt: { mode: "custom_append", promptId: "research-prompt" },
    subagents: { mode: "orchestration", orchestrationId: "research-subagents" },
  },
  mainAgentConfigName: "Research Main",
  mainPromptDisplayName: "Research Prompt",
  subagentOrchestrationDisplayName: "Research Subagents",
  mainAgent: {
    agentKey: "main",
    name: "Research Captain",
    systemPromptPreset: "custom_append",
    prompt: "Lead research.",
    modelRef: { providerId: "p1", modelId: "main-model" },
    tools,
    skills: [],
  },
  agents: [
    {
      agentKey: "research_lead",
      templateId: "researcher",
      displayName: "Research Lead",
      modelRef: { providerId: "p1", modelId: "research-model" },
      tools,
      mcpServers: [],
      skills: [],
      enabled: true,
    },
  ],
  strategy: { kind: "autonomous" },
  resolvedAt: "2026-06-07T00:00:00.000Z",
};

test("buildComposerAgentModelLabels localizes legacy coding labels", async () => {
  const labels = buildComposerAgentModelLabels({
    routes: [
      { role: "main", providerId: "p1", modelId: "main-model" },
      { role: "coder", providerId: "p1", modelId: "coder-model" },
    ],
  });

  expect(labels[0]).toMatchObject({
    role: "main",
    displayName: "Main Agent",
    main: true,
    modelId: "main-model",
  });
  expect(labels.find((label) => label.role === "coder")).toMatchObject({
    displayName: "Coder",
    subagentRole: "coder",
    modelId: "coder-model",
  });
  expect(labels.find((label) => label.role === "coder")).not.toHaveProperty("required");
});

test("buildComposerAgentModelLabels renders resolved orchestration labels", async () => {
  const labels = buildComposerAgentModelLabels({
    snapshot,
    routes: [
      { role: "main", providerId: "p1", modelId: "main-model" },
      { role: "research_lead", providerId: "p1", modelId: "research-model" },
    ],
    threadModelByRole: { research_lead: "live-research-model" },
  });

  expect(labels).toEqual([
    {
      role: "main",
      displayName: "Research Captain",
      modelId: "main-model",
      title: "Research Captain · main-model",
      main: true,
    },
    {
      role: "research_lead",
      displayName: "Research Lead",
      modelId: "live-research-model",
      title: "Research Lead · live-research-model",
      main: false,
    },
  ]);
});
