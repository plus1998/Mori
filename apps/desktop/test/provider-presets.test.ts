import { expect, test } from "bun:test";
import {
  applyProviderPreset,
  DEFAULT_NEW_PROVIDER_PRESET_ID,
  findMatchingProviderPreset,
  findPresetEndpointVariant,
  findPresetForForm,
  getProviderPresetById,
  getProviderPresetEndpointVariants,
  togglePresetEndpointVariant,
  MAINSTREAM_PROVIDER_PRESETS,
} from "../src/renderer/provider-presets";
import type { ProviderConfigInput } from "../src/shared/ipc";

test("mainstream provider presets are sorted alphabetically by display name", () => {
  const names = MAINSTREAM_PROVIDER_PRESETS.map((preset) => preset.name);
  const sorted = [...names].sort((a, b) => {
    const sortA = a === "百炼" ? "Bailian" : a;
    const sortB = b === "百炼" ? "Bailian" : b;
    return sortA.localeCompare(sortB, "en", { sensitivity: "base", numeric: true });
  });
  expect(names).toEqual(sorted);
  expect(MAINSTREAM_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
    "anthropic",
    "bailian",
    "chatgpt-subscription",
    "deepseek",
    "kimi",
    "minimax",
    "openai",
    "opencode-zen",
    "tencent",
    "typesafe",
    "xiaomi-mimo",
  ]);
});

test("default new provider preset stays OpenAI even when presets are sorted", () => {
  expect(getProviderPresetById(DEFAULT_NEW_PROVIDER_PRESET_ID)?.id).toBe("openai");
  expect(MAINSTREAM_PROVIDER_PRESETS[0]?.id).toBe("anthropic");
});

test("mainstream provider presets are valid service roots", () => {
  expect(MAINSTREAM_PROVIDER_PRESETS).toHaveLength(11);

  const ids = new Set<string>();
  for (const preset of MAINSTREAM_PROVIDER_PRESETS) {
    expect(ids.has(preset.id)).toBe(false);
    ids.add(preset.id);

    expect(preset.name.trim()).not.toBe("");
    expect(preset.iconSrc).toMatch(/^\.\/provider-icons\/.+\.(ico|svg|png)$/);
    expect(preset.defaultModel.trim()).not.toBe("");
    expect(preset.apiKeyUrl).toMatch(/^https:\/\//);
    expect(preset.baseUrl).toMatch(/^https:\/\//);
    expect(preset.baseUrl).not.toMatch(/\/v1\/?$/);
    expect(preset.requestPath === "" || preset.requestPath.startsWith("/")).toBe(true);
    expect(["anthropic", "openai_responses", "openai_chat_completions", "system_one"]).toContain(preset.apiCompat);
  }
});

test("applying a provider preset keeps edit identity and entered api key", () => {
  const form: ProviderConfigInput = {
    id: "provider_existing",
    name: "Custom",
    baseUrl: "https://example.test",
    requestPath: "",
    version: "v1",
    apiCompat: "anthropic",
    apiKey: "already-entered",
    defaultModel: "old-model",
    enabled: false,
  };

  const preset = getProviderPresetById("openai")!;
  const next = applyProviderPreset(form, preset);

  expect(next.id).toBe(form.id);
  expect(next.apiKey).toBe(form.apiKey);
  expect(next.name).toBe(preset.name);
  expect(next.baseUrl).toBe(preset.baseUrl);
  expect(next.requestPath).toBe(preset.requestPath);
  expect(next.version).toBe(preset.version);
  expect(next.apiCompat).toBe(preset.apiCompat);
  expect(next.defaultModel).toBe(preset.defaultModel);
  expect(next.enabled).toBe(true);
});

test("applying a provider preset resets connection fields when switching presets", () => {
  const tencent = MAINSTREAM_PROVIDER_PRESETS.find((entry) => entry.id === "tencent");
  const openai = MAINSTREAM_PROVIDER_PRESETS.find((entry) => entry.id === "openai");
  expect(tencent).toBeDefined();
  expect(openai).toBeDefined();

  const afterTencent = applyProviderPreset(providerToForm(), tencent!);
  expect(afterTencent.version).toBe("v1");
  expect(afterTencent.requestPath).toBe("");
  expect(afterTencent.baseUrl).toBe("https://tokenhub.tencentmaas.com");
  expect(afterTencent.defaultModel).toBe("hy4-preview");

  const afterOpenai = applyProviderPreset(afterTencent, openai!);
  expect(afterOpenai.version).toBe("v1");
  expect(afterOpenai.requestPath).toBe("");
});

function providerToForm(): ProviderConfigInput {
  return {
    name: "Anthropic compatible",
    baseUrl: "https://api.anthropic.com",
    requestPath: "",
    version: "v1",
    apiCompat: "anthropic",
    apiKey: "",
    defaultModel: "",
    enabled: true,
  };
}

test("matching provider preset tolerates slash normalization", () => {
  const preset = MAINSTREAM_PROVIDER_PRESETS.find((entry) => entry.id === "opencode-zen");
  expect(preset).toBeDefined();

  const match = findMatchingProviderPreset({
    baseUrl: `${preset!.baseUrl}/`,
    requestPath: "zen/",
    version: "v1",
    apiCompat: preset!.apiCompat,
    defaultModel: preset!.defaultModel,
  });

  expect(match?.id).toBe(preset!.id);
});

test("matching provider preset includes version for TokenHub hunyuan", () => {
  const preset = MAINSTREAM_PROVIDER_PRESETS.find((entry) => entry.id === "tencent");
  expect(preset).toBeDefined();

  const match = findMatchingProviderPreset({
    baseUrl: preset!.baseUrl,
    requestPath: preset!.requestPath,
    version: "v1",
    apiCompat: preset!.apiCompat,
    defaultModel: "other-model",
  });

  expect(match?.id).toBe(preset!.id);
});

test("matching provider preset ignores default model differences", () => {
  const preset = MAINSTREAM_PROVIDER_PRESETS.find((entry) => entry.id === "anthropic");
  expect(preset).toBeDefined();

  const match = findMatchingProviderPreset({
    baseUrl: preset!.baseUrl,
    requestPath: preset!.requestPath,
    version: "v1",
    apiCompat: preset!.apiCompat,
    defaultModel: "some-other-model",
  });

  expect(match?.id).toBe(preset!.id);
});

test("deepseek preset still matches when switching to openai responses endpoint", () => {
  const preset = getProviderPresetById("deepseek");
  expect(preset).toBeDefined();

  const match = findPresetForForm({
    baseUrl: preset!.baseUrl,
    requestPath: "",
    version: "v1",
    apiCompat: "openai_responses",
    defaultModel: "deepseek-v4-flash",
  });

  expect(match?.id).toBe("deepseek");
});

test("deepseek preset still matches when switching to openai chat endpoint", () => {
  const preset = getProviderPresetById("deepseek");
  expect(preset).toBeDefined();

  const match = findPresetForForm({
    baseUrl: preset!.baseUrl,
    requestPath: "",
    version: "v1",
    apiCompat: "openai_chat_completions",
    defaultModel: "deepseek-v4-flash",
  });

  expect(match?.id).toBe("deepseek");
});

test("openai preset still matches when switching to chat completions endpoint", () => {
  const preset = getProviderPresetById("openai");
  expect(preset).toBeDefined();

  const match = findPresetForForm({
    baseUrl: preset!.baseUrl,
    requestPath: "",
    version: "v1",
    apiCompat: "openai_chat_completions",
    defaultModel: "gpt-4o",
  });

  expect(match?.id).toBe("openai");
});

test("anthropic preset does not match unsupported openai responses endpoint", () => {
  const preset = getProviderPresetById("anthropic");
  expect(preset).toBeDefined();

  const match = findPresetForForm({
    baseUrl: preset!.baseUrl,
    requestPath: "",
    version: "v1",
    apiCompat: "openai_responses",
    defaultModel: "claude-sonnet-4-20250514",
  });

  expect(match).toBeUndefined();
});

test("findPresetEndpointVariant resolves deepseek openai chat path", () => {
  const preset = getProviderPresetById("deepseek");
  expect(preset).toBeDefined();

  const variant = findPresetEndpointVariant(preset!, "openai_chat_completions");
  expect(variant).toEqual({ requestPath: "", apiCompat: "openai_chat_completions" });
});

test("togglePresetEndpointVariant cycles only within supported endpoints", () => {
  const preset = getProviderPresetById("deepseek");
  expect(preset).toBeDefined();

  const first = togglePresetEndpointVariant(preset!, {
    apiCompat: "anthropic",
    requestPath: "/anthropic",
    version: "v1",
  });
  expect(first).toEqual({ requestPath: "", apiCompat: "openai_responses" });

  const second = togglePresetEndpointVariant(preset!, { ...first, version: "v1" });
  expect(second).toEqual({ requestPath: "", apiCompat: "openai_chat_completions" });

  const third = togglePresetEndpointVariant(preset!, { ...second, version: "v1" });
  expect(third).toEqual({ requestPath: "/anthropic", apiCompat: "anthropic" });

  const fourth = togglePresetEndpointVariant(preset!, {
    apiCompat: "openai_responses",
    requestPath: "",
    version: "v1",
  });
  expect(fourth).toEqual({ requestPath: "", apiCompat: "openai_chat_completions" });
});

test("bailian preset matches anthropic and responses endpoint variants", () => {
  const preset = getProviderPresetById("bailian");
  expect(preset).toBeDefined();

  expect(
    findPresetForForm({
      baseUrl: preset!.baseUrl,
      requestPath: "/apps/anthropic",
      version: "v1",
      apiCompat: "anthropic",
    })?.id,
  ).toBe("bailian");

  expect(
    findPresetForForm({
      baseUrl: preset!.baseUrl,
      requestPath: "/compatible-mode",
      version: "v1",
      apiCompat: "openai_responses",
    })?.id,
  ).toBe("bailian");
});

test("kimi preset matches responses and anthropic endpoint variants", () => {
  const preset = getProviderPresetById("kimi");
  expect(preset).toBeDefined();

  expect(
    findPresetForForm({
      baseUrl: preset!.baseUrl,
      requestPath: "",
      version: "v1",
      apiCompat: "openai_responses",
    })?.id,
  ).toBe("kimi");

  expect(
    findPresetForForm({
      baseUrl: preset!.baseUrl,
      requestPath: "/anthropic",
      version: "v1",
      apiCompat: "anthropic",
    })?.id,
  ).toBe("kimi");
});

test("tencent hunyuan preset matches anthropic messages endpoint", () => {
  const preset = getProviderPresetById("tencent");
  expect(preset).toBeDefined();

  const match = findPresetForForm({
    baseUrl: preset!.baseUrl,
    requestPath: "",
    version: "v1",
    apiCompat: "anthropic",
  });

  expect(match?.id).toBe("tencent");
});

test("tencent hunyuan endpoint toggle cycles chat responses and anthropic on same base", () => {
  const preset = getProviderPresetById("tencent");
  expect(preset).toBeDefined();

  const next = togglePresetEndpointVariant(preset!, {
    apiCompat: "openai_chat_completions",
    requestPath: "",
    version: "v1",
  });

  expect(next).toEqual({ requestPath: "", apiCompat: "openai_responses" });

  const third = togglePresetEndpointVariant(preset!, { ...next, version: "v1" });
  expect(third).toEqual({ requestPath: "", apiCompat: "anthropic" });
});

test("opencode zen preset exposes anthropic responses and chat variants on /zen", () => {
  const preset = getProviderPresetById("opencode-zen");
  expect(preset).toBeDefined();
  expect(preset!.apiCompat).toBe("anthropic");

  const variants = getProviderPresetEndpointVariants(preset!);
  expect(variants).toEqual([
    { requestPath: "/zen", apiCompat: "anthropic" },
    { requestPath: "/zen", apiCompat: "openai_responses" },
    { requestPath: "/zen", apiCompat: "openai_chat_completions" },
  ]);
});
