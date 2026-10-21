import { expect, test } from "bun:test";
import {
  countManualOverrides,
  emptyManualSpecForm,
  formToManualSpec,
  listManualOverrideFields,
  manualSpecToForm,
  mergeEffectiveCapabilityHint,
  mergeEffectivePricingHint,
  prefillManualSpecFormFromCandidate,
  prefillManualSpecFormFromHints,
  tryFormToManualSpec,
} from "../src/renderer/agent-resource-manual-spec-form";
import type { RouteCapabilityHint, RoutePricingHint } from "../src/shared/ipc";

test("manualSpecToForm round-trips all fields", () => {
  const form = manualSpecToForm({
    contextTokens: 200_000,
    maxOutputTokens: 8_192,
    supportsImageInput: true,
    supportsReasoning: false,
    inputPerM: 3,
    outputPerM: 15,
    cacheReadPerM: 0.3,
    cacheWritePerM: 3.75,
  });
  expect(form.contextTokens).toBe("200000");
  expect(form.maxOutputTokens).toBe("8192");
  expect(form.supportsImageInput).toBe("yes");
  expect(form.supportsReasoning).toBe("no");
  expect(form.inputPerM).toBe("3");
  expect(form.outputPerM).toBe("15");
  expect(form.cacheReadPerM).toBe("0.3");
  expect(form.cacheWritePerM).toBe("3.75");
});

test("formToManualSpec strict validates token and rate fields", () => {
  const form = emptyManualSpecForm();
  form.contextTokens = "abc";
  expect(() => formToManualSpec(form, { strict: true })).toThrow(
    /手动上下文上限必须是正整数|manual context limit must be a positive integer/i,
  );

  form.contextTokens = "128000";
  form.inputPerM = "bad";
  expect(() => formToManualSpec(form, { strict: true })).toThrow(
    /输入价格必须是正数|input price must be a positive number/i,
  );
});

test("tryFormToManualSpec ignores invalid partial input", () => {
  const form = emptyManualSpecForm();
  form.contextTokens = "256,000";
  form.inputPerM = "3";
  expect(tryFormToManualSpec(form)).toEqual({ contextTokens: 256_000, inputPerM: 3 });
});

test("formToManualSpec preserves zero pricing as free", () => {
  const form = emptyManualSpecForm();
  form.inputPerM = "0";
  form.outputPerM = "0";
  form.cacheReadPerM = "0";
  form.cacheWritePerM = "0";
  form.priceMultiplier = "0";
  expect(formToManualSpec(form, { strict: true })).toEqual({
    priceMultiplier: 0,
    inputPerM: 0,
    outputPerM: 0,
    cacheReadPerM: 0,
    cacheWritePerM: 0,
  });
});

test("countManualOverrides and listManualOverrideFields", () => {
  const form = emptyManualSpecForm();
  form.contextTokens = "200000";
  form.supportsImageInput = "yes";
  form.outputPerM = "15";
  expect(countManualOverrides(form)).toBe(3);
  expect([...listManualOverrideFields(form)]).toEqual(["contextTokens", "supportsImageInput", "outputPerM"]);
});

test("mergeEffectiveCapabilityHint prefers manual values", () => {
  const auto: RouteCapabilityHint = {
    role: "main",
    modelId: "vendor",
    providerName: "Vendor",
    supportsImageInput: false,
    supportsReasoning: false,
    capabilitiesResolved: true,
    contextTokens: 128_000,
    maxOutputTokens: 4_096,
    contextLimitResolved: true,
  };
  const merged = mergeEffectiveCapabilityHint(auto, {
    contextTokens: 256_000,
    supportsImageInput: true,
  });
  expect(merged?.contextTokens).toBe(256_000);
  expect(merged?.maxOutputTokens).toBe(4_096);
  expect(merged?.supportsImageInput).toBe(true);
  expect(merged?.supportsReasoning).toBe(false);
});

test("mergeEffectivePricingHint prefers manual input/output and merges cache", () => {
  const auto: RoutePricingHint = {
    role: "main",
    modelId: "vendor",
    providerName: "Vendor",
    rates: { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.1 },
    pricingResolved: true,
  };
  const merged = mergeEffectivePricingHint(auto, {
    inputPerM: 5,
    outputPerM: 10,
  });
  expect(merged?.rates).toEqual({ inputPerM: 5, outputPerM: 10, cacheReadPerM: 0.1 });
});

test("prefillManualSpecFormFromCandidate fills resolved values for editing", () => {
  const form = prefillManualSpecFormFromCandidate({
    resolvedContextTokens: 200_000,
    resolvedMaxOutputTokens: 8_192,
    resolvedSupportsImageInput: true,
    resolvedSupportsReasoning: false,
    resolvedInputPerM: 3,
    resolvedOutputPerM: 15,
    manualSpec: { priceMultiplier: 1.5 },
  });
  expect(form.contextTokens).toBe("200000");
  expect(form.maxOutputTokens).toBe("8192");
  expect(form.supportsImageInput).toBe("yes");
  expect(form.supportsReasoning).toBe("no");
  expect(form.priceMultiplier).toBe("1.5");
  expect(form.inputPerM).toBe("");
  expect(form.outputPerM).toBe("");
});

test("prefillManualSpecFormFromHints fills catalog capabilities and pricing", () => {
  const form = prefillManualSpecFormFromHints(
    {
      role: "main",
      modelId: "gpt-4o",
      providerName: "OpenAI",
      supportsImageInput: true,
      supportsReasoning: false,
      capabilitiesResolved: true,
      contextLimitResolved: true,
      catalogContextTokens: 128_000,
      catalogMaxOutputTokens: 16_384,
      catalogSupportsImageInput: true,
      catalogSupportsReasoning: false,
    },
    {
      role: "main",
      modelId: "gpt-4o",
      providerName: "OpenAI",
      pricingResolved: true,
      catalogRates: { inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 },
    },
  );
  expect(form.contextTokens).toBe("128000");
  expect(form.maxOutputTokens).toBe("16384");
  expect(form.supportsImageInput).toBe("yes");
  expect(form.inputPerM).toBe("2.5");
  expect(form.outputPerM).toBe("10");
  expect(form.cacheReadPerM).toBe("1.25");
  expect(form.priceMultiplier).toBe("1");
});

test("mergeEffectivePricingHint applies price multiplier to catalog rates", () => {
  const merged = mergeEffectivePricingHint(
    {
      role: "main",
      modelId: "gpt-4o",
      providerName: "OpenAI",
      pricingResolved: true,
      rates: { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.2 },
    },
    { priceMultiplier: 1.5 },
  );
  expect(merged?.rates?.inputPerM).toBeCloseTo(3);
  expect(merged?.rates?.outputPerM).toBeCloseTo(12);
  expect(merged?.rates?.cacheReadPerM).toBeCloseTo(0.3);
});

test("mergeEffectivePricingHint treats price multiplier zero as free", () => {
  const merged = mergeEffectivePricingHint(
    {
      role: "main",
      modelId: "gpt-4o",
      providerName: "OpenAI",
      pricingResolved: true,
      rates: { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.2 },
    },
    { priceMultiplier: 0 },
  );
  expect(merged?.rates).toEqual({ inputPerM: 0, outputPerM: 0, cacheReadPerM: 0 });
});

test("manualSpecToForm defaults supportsNativeWebSearch to true", () => {
  expect(manualSpecToForm(undefined).supportsNativeWebSearch).toBe(true);
  expect(manualSpecToForm({ supportsNativeWebSearch: false }).supportsNativeWebSearch).toBe(false);
});

test("formToManualSpec only persists supportsNativeWebSearch when false", () => {
  expect(formToManualSpec({ ...emptyManualSpecForm(), supportsNativeWebSearch: true })).toBeUndefined();
  expect(
    formToManualSpec({ ...emptyManualSpecForm(), supportsNativeWebSearch: false })?.supportsNativeWebSearch,
  ).toBe(false);
});

test("remote compaction defaults off, persists opt-in and survives candidate prefill", () => {
  expect(manualSpecToForm().supportsRemoteCompaction).toBe(false);
  expect(formToManualSpec(emptyManualSpecForm())).toBeUndefined();
  const form = manualSpecToForm({ supportsRemoteCompaction: true });
  expect(form.supportsRemoteCompaction).toBe(true);
  expect(formToManualSpec(form)).toEqual({ supportsRemoteCompaction: true });
  expect(countManualOverrides(form)).toBe(1);
  expect(listManualOverrideFields(form)).toEqual(new Set(["supportsRemoteCompaction"]));
  expect(
    prefillManualSpecFormFromCandidate({
      manualSpec: { supportsRemoteCompaction: true },
      resolvedContextTokens: 100_000,
    }).supportsRemoteCompaction,
  ).toBe(true);
  expect(prefillManualSpecFormFromHints().supportsRemoteCompaction).toBe(false);
  expect(
    mergeEffectiveCapabilityHint(undefined, { supportsRemoteCompaction: true })?.supportsRemoteCompaction,
  ).toBe(true);
  expect(formToManualSpec({ ...form, supportsRemoteCompaction: false })).toBeUndefined();
});
