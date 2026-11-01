import { expect, test } from "bun:test";
import { mergeAgentRegistrySettings } from "../src/main/agent-registry-settings";
import { createBuiltInAgentTemplates } from "../src/shared/agent-orchestration";
import type { ModelSettingsSnapshot } from "../src/shared/ipc";

function emptySettings(): ModelSettingsSnapshot {
  return { providers: [], routeProfiles: [], agentTemplates: [],
    mainAgentConfigs: [], mainAgentPrompts: [], subagentOrchestrations: [] };
}

test("registry keeps prompts and subagent orchestration without main config resources", () => {
  const template = createBuiltInAgentTemplates()[0]!;
  const prompt = { id: "prompt", name: "Prompt", mode: "custom_append" as const,
    prompt: "Do research", updatedAt: "", source: "user" as const };
  const orchestration = { id: "subagents", name: "Subagents", agents: [],
    strategy: { kind: "autonomous" as const }, updatedAt: "", source: "user" as const };
  const merged = mergeAgentRegistrySettings(emptySettings(), {
    listAgentTemplates: () => [template],
    listMainAgentPrompts: () => [prompt],
    listSubagentOrchestrations: () => [orchestration],
  });
  expect(merged.agentTemplates).toContain(template);
  expect(merged.mainAgentPrompts).toEqual([prompt]);
  expect(merged.subagentOrchestrations).toEqual([orchestration]);
  expect(merged.mainAgentConfigs).toEqual([]);
});

test("Login provider is available for direct account selection", () => {
  const merged = mergeAgentRegistrySettings(emptySettings(), {
    listAgentTemplates: () => [],
    listMainAgentPrompts: () => [],
    listSubagentOrchestrations: () => [],
  });
  expect(merged.providers[0]?.id).toBe("openai");
  expect(merged.mainAgentConfigs).toEqual([]);
});
