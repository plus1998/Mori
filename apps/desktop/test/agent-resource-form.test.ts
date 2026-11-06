import { expect, test } from "bun:test";
import {
  buildMainAgentPromptFromForm,
  buildSubagentOrchestrationFromForm,
  createBlankMainAgentPromptForm,
  createBlankSubagentOrchestrationForm,
  createCopiedSubagentOrchestrationForm,
} from "../src/renderer/agent-resource-form";
import { createBuiltInAgentTemplates } from "../src/shared/agent-orchestration";

test("custom main prompt remains independent of the selected model", () => {
  const form = createBlankMainAgentPromptForm();
  form.mainPrompt = "Coordinate research.";
  const prompt = buildMainAgentPromptFromForm(form);
  expect(prompt.prompt).toBe("Coordinate research.");
  expect(prompt.mode).toBe("custom_append");
});

test("subagent orchestration keeps its own candidate model", () => {
  const templates = createBuiltInAgentTemplates();
  const form = createBlankSubagentOrchestrationForm({ templates });
  const agent = form.agents[0]!;
  agent.providerId = "provider-1";
  agent.modelId = "model-1";
  agent.candidateModelId = "candidate-1";
  agent.apiCompat = "openai_responses";
  agent.accountId = "stale-oauth-account";
  const orchestration = buildSubagentOrchestrationFromForm(form, { templates });
  expect(orchestration.agents[0]?.modelRef).toMatchObject({
    providerId: "provider-1", modelId: "model-1", candidateModelId: "candidate-1",
    apiCompat: "openai_responses",
  });
  expect(orchestration.agents[0]?.modelRef).not.toHaveProperty("accountId");
  const copied = createCopiedSubagentOrchestrationForm(orchestration, {
    existingIds: [orchestration.id],
  });
  expect(copied.id).not.toBe(orchestration.id);
});

test("OAuth subagent accounts survive editing and copying and are required before saving enabled roles", () => {
  const templates = createBuiltInAgentTemplates();
  const form = createBlankSubagentOrchestrationForm({ templates });
  for (const agent of form.agents) {
    agent.providerId = "eco-coding-chatgpt";
    agent.modelId = "gpt-6-luna";
    agent.candidateModelId = "account:eco-coding-chatgpt:gpt-6-luna";
    agent.accountId = `account-${agent.agentKey}`;
    agent.thinkingEffort = "high";
    agent.apiCompat = "anthropic"; // Old Harness overrides cannot change OAuth's own protocol.
  }
  const saved = buildSubagentOrchestrationFromForm(form, { templates });
  expect(saved.agents[0]?.modelRef).toMatchObject({ accountId: form.agents[0]!.accountId,
    thinkingEffort: "high", apiCompat: "openai_responses" });
  const copied = createCopiedSubagentOrchestrationForm(saved);
  expect(copied.agents.map(agent => agent.accountId)).toEqual(form.agents.map(agent => agent.accountId));
  expect(buildSubagentOrchestrationFromForm(copied, { templates }).agents).toEqual(saved.agents);
  form.agents[0]!.accountId = "  ";
  expect(() => buildSubagentOrchestrationFromForm(form, { templates })).toThrow("尚未选择账号");
  form.agents[0]!.enabled = false;
  expect(() => buildSubagentOrchestrationFromForm(form, { templates })).not.toThrow();
});

test("Login subagents save model and thinking effort without an account or provider candidate", () => {
  const templates = createBuiltInAgentTemplates();
  const form = createBlankSubagentOrchestrationForm({ templates });
  for (const agent of form.agents) Object.assign(agent, {
    providerId: "openai", modelId: "gpt-6.1-sol", candidateModelId: "",
    accountId: "old-independent-login-account", thinkingEffort: "high",
  });
  const saved = buildSubagentOrchestrationFromForm(form, { templates });
  for (const agent of saved.agents) {
    expect(agent.modelRef).toEqual({ providerId: "openai", modelId: "gpt-6.1-sol", thinkingEffort: "high" });
    agent.modelRef.accountId = "legacy-account";
  }
  const copied = createCopiedSubagentOrchestrationForm(saved);
  expect(copied.agents.every((agent) => !agent.accountId)).toBe(true);
});
