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
  const orchestration = buildSubagentOrchestrationFromForm(form, { templates });
  expect(orchestration.agents[0]?.modelRef).toMatchObject({
    providerId: "provider-1", modelId: "model-1", candidateModelId: "candidate-1",
    apiCompat: "openai_responses",
  });
  const copied = createCopiedSubagentOrchestrationForm(orchestration, {
    existingIds: [orchestration.id],
  });
  expect(copied.id).not.toBe(orchestration.id);
});
