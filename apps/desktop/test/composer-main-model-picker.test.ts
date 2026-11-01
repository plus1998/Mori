import { expect, test } from "bun:test";
import { buildMainModelProviderOptions, resolvePickerThinkingEffort,
  thinkingEffortsForModel } from "../src/renderer/ComposerMainModelPicker";
import type { CandidateModelView, CommitModelOptionView } from "../src/shared/ipc";

test("groups candidate models by provider while preserving each model identity", () => {
  const candidates = [
    { candidateModelId: "a-messages", providerId: "openrouter", providerName: "OpenRouter",
      modelId: "model-a", modelLabel: "Model A" },
    { candidateModelId: "b-responses", providerId: "openrouter", providerName: "OpenRouter",
      modelId: "model-b", modelLabel: "Model B" },
    { candidateModelId: "c-system-one", providerId: "other", providerName: "Other",
      modelId: "model-c", modelLabel: "Model C" },
  ] as CommitModelOptionView[];
  const providers = buildMainModelProviderOptions(candidates,
    [{ modelId: "gpt-5.6-luna", displayName: "Luna" }], true);
  expect(providers.map((entry) => entry.name)).toEqual([
    "OpenRouter", "Other", "ChatGPT Login", "ChatGPT OAuth",
  ]);
  expect(providers[0]?.models).toEqual([
    { id: "model-a", name: "Model A", candidateModelId: "a-messages" },
    { id: "model-b", name: "Model B", candidateModelId: "b-responses" },
  ]);
  expect(providers[0]?.icon).toBe("./provider-icons/openrouter.ico");
  expect(providers[2]?.models).toEqual([{ id: "gpt-5.6-luna", name: "Luna" }]);
  expect(buildMainModelProviderOptions(candidates, [], false).some((entry) => entry.id === "login"))
    .toBe(false);
});

test("shows only supported thinking strengths from the Login catalog", () => {
  const providers = buildMainModelProviderOptions([], [
    { modelId: "gpt-5", displayName: "GPT-5", reasoningEfforts: ["none", "low", "high", "unsupported"] },
  ], true);
  expect(providers.find((entry) => entry.id === "login")?.models[0]?.reasoningEfforts)
    .toEqual(["off", "low", "high"]);
});

test("uses low for an unset strength and respects model-supported levels", () => {
  expect(resolvePickerThinkingEffort(undefined, ["off", "low", "medium", "high"])).toBe("low");
  expect(resolvePickerThinkingEffort("high", ["off", "low", "medium", "high"])).toBe("high");
  expect(resolvePickerThinkingEffort(undefined, ["medium", "high"])).toBe("medium");
  expect(resolvePickerThinkingEffort(undefined, [])).toBeUndefined();
});

test("waits for a custom model capability before offering or saving a strength", () => {
  const model = { id: "model-a", name: "Model A", candidateModelId: "candidate-a" };
  expect(thinkingEffortsForModel(model, {})).toEqual([]);
  expect(thinkingEffortsForModel(model, {
    "candidate-a": { id: "candidate-a", resolvedSupportsReasoning: false } as CandidateModelView,
  })).toEqual([]);
  expect(thinkingEffortsForModel(model, {
    "candidate-a": { id: "candidate-a", resolvedSupportsReasoning: true } as CandidateModelView,
  })).toContain("low");
});
