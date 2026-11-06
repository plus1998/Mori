import { codexQuotaPeriod, codexQuotaResetAt } from "../src/renderer/codex-quota-reminder";
import { expect, test } from "bun:test";
import { associateOAuthModelEfforts, buildMainModelProviderOptions, modelPickerAccountMode, resolvePickerThinkingEffort,
  thinkingEffortsForModel } from "../src/renderer/ComposerMainModelPicker";
import type { CandidateModelView, CommitModelOptionView } from "../src/shared/ipc";

test("Login subagents inherit the process account while OAuth roles select their own account", () => {
  expect(modelPickerAccountMode("login", "main")).toBe("select");
  expect(modelPickerAccountMode("login", "subagent")).toBe("inherit");
  for (const purpose of ["main", "subagent", "auxiliary", "vision", "approval"] as const) {
    expect(modelPickerAccountMode("oauth", purpose)).toBe("select");
    expect(modelPickerAccountMode("custom-provider", purpose)).toBe("none");
  }
  for (const purpose of ["auxiliary", "vision", "approval"] as const) {
    expect(modelPickerAccountMode("login", purpose)).toBe("none");
  }
});

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

test("associates OAuth models with the official Codex catalog by exact ID", () => {
  const [matched, unknown] = associateOAuthModelEfforts([
    { id: "gpt-6.1-terra", name: "Terra", reasoningEfforts: [] },
    { id: "unlisted", name: "Unlisted", reasoningEfforts: [] },
  ], [{ modelId: "gpt-6.1-terra", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }]);
  expect(matched?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(matched?.unsupportedCatalogEfforts).toEqual(["ultra"]);
  expect(unknown?.reasoningUnknown).toBe(true);
  expect(thinkingEffortsForModel(unknown, {})).toEqual([]);
});

test("treats an empty official effort list as unknown", () => {
  const [model] = associateOAuthModelEfforts([{ id: "test", name: "Test" }],
    [{ modelId: "test", reasoningEfforts: [] }]);
  expect(model?.reasoningUnknown).toBe(true);
  expect(thinkingEffortsForModel(model, {})).toEqual([]);
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


test("identifies standard quota periods without rounding other windows", () => {
  expect(codexQuotaPeriod(5 * 3_600)).toBe("hours");
  expect(codexQuotaPeriod(7 * 24 * 3_600)).toBe("week");
  expect(codexQuotaPeriod(30 * 24 * 3_600)).toBe("month");
  expect(codexQuotaPeriod(29 * 24 * 3_600)).toBe("hours");
  expect(codexQuotaPeriod(0)).toBe("unknown");
});


test("resolves each quota window reset from its absolute or snapshot-relative time", () => {
  const window = { usedPercent: 20, limitWindowSeconds: 18_000, resetAfterSeconds: 300, resetAt: 1_800_000_000 };
  expect(codexQuotaResetAt(window, 1_700_000_000_000)).toBe(1_800_000_000_000);
  expect(codexQuotaResetAt({ ...window, resetAt: 0 }, 1_700_000_000_000)).toBe(1_700_000_300_000);
  expect(codexQuotaResetAt({ ...window, resetAt: 0, resetAfterSeconds: 0 }, 1_700_000_000_000)).toBeUndefined();
});
