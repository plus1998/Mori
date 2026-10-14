import type { ProviderConfigInput } from "../shared/ipc";
import type { UpstreamApiCompat } from "../shared/api-compat";

export interface ProviderEndpointVariant {
  requestPath: string;
  apiCompat: UpstreamApiCompat;
  /** When set, overrides preset.version for this endpoint. */
  version?: string;
}

export interface ProviderPresetDefinition {
  id: string;
  name: string;
  iconSrc: string;
  baseUrl: string;
  requestPath: string;
  version: string;
  apiCompat: UpstreamApiCompat;
  defaultModel: string;
  apiKeyUrl: string;
  authMethod?: ProviderConfigInput["authMethod"];
  credentialPoolId?: string;
  /** Alternate request endpoints still belonging to this provider preset. */
  endpointVariants?: ProviderEndpointVariant[];
}

const PROVIDER_PRESET_SORT_NAME_OVERRIDES: Record<string, string> = {
  bailian: "Bailian",
};

function providerPresetSortKey(preset: ProviderPresetDefinition): string {
  return PROVIDER_PRESET_SORT_NAME_OVERRIDES[preset.id] ?? preset.name;
}

function compareProviderPresets(a: ProviderPresetDefinition, b: ProviderPresetDefinition): number {
  return providerPresetSortKey(a).localeCompare(providerPresetSortKey(b), "en", {
    sensitivity: "base",
    numeric: true,
  });
}

const PROVIDER_PRESET_DEFINITIONS: ProviderPresetDefinition[] = [
  {
    id: "typesafe",
    name: "TypeSafe (Jev)",
    iconSrc: "./provider-icons/system-one.png",
    baseUrl: "https://api.typesafe.ai",
    requestPath: "",
    version: "v1",
    apiCompat: "system_one",
    defaultModel: "jev-latest",
    apiKeyUrl: "https://console.typesafe.ai",
  },
  {
    id: "chatgpt-subscription",
    name: "ChatGPT OAuth",
    iconSrc: "./provider-icons/openai.svg",
    baseUrl: "https://api.openai.com",
    requestPath: "",
    version: "v1",
    apiCompat: "openai_responses",
    defaultModel: "gpt-5",
    apiKeyUrl: "https://chatgpt.com/settings/usage",
    authMethod: "chatgpt_subscription",
    credentialPoolId: "chatgpt-default",
  },
  {
    id: "openai",
    name: "OpenAI",
    iconSrc: "./provider-icons/openai.svg",
    baseUrl: "https://api.openai.com",
    requestPath: "",
    version: "v1",
    apiCompat: "openai_responses",
    defaultModel: "gpt-4o",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    endpointVariants: [
      { requestPath: "", apiCompat: "openai_responses" },
      { requestPath: "", apiCompat: "openai_chat_completions" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    iconSrc: "./provider-icons/claude.ico",
    baseUrl: "https://api.anthropic.com",
    requestPath: "",
    version: "v1",
    apiCompat: "anthropic",
    defaultModel: "claude-sonnet-4-20250514",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    iconSrc: "./provider-icons/opencode-zen.ico",
    baseUrl: "https://opencode.ai",
    requestPath: "/zen",
    version: "v1",
    apiCompat: "anthropic",
    defaultModel: "claude-opus-4-7",
    apiKeyUrl: "https://opencode.ai/",
    endpointVariants: [
      { requestPath: "/zen", apiCompat: "anthropic" },
      { requestPath: "/zen", apiCompat: "openai_responses" },
      { requestPath: "/zen", apiCompat: "openai_chat_completions" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    iconSrc: "./provider-icons/deepseek.ico",
    baseUrl: "https://api.deepseek.com",
    requestPath: "/anthropic",
    version: "v1",
    apiCompat: "anthropic",
    defaultModel: "deepseek-v4-flash",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    endpointVariants: [
      { requestPath: "/anthropic", apiCompat: "anthropic" },
      { requestPath: "", apiCompat: "openai_responses" },
      { requestPath: "", apiCompat: "openai_chat_completions" },
    ],
  },
  {
    id: "bailian",
    name: "百炼",
    iconSrc: "./provider-icons/bailian.png",
    baseUrl: "https://dashscope.aliyuncs.com",
    requestPath: "/compatible-mode",
    version: "v1",
    apiCompat: "openai_chat_completions",
    defaultModel: "qwen-plus",
    apiKeyUrl: "https://bailian.console.aliyun.com/",
    endpointVariants: [
      { requestPath: "/compatible-mode", apiCompat: "openai_chat_completions" },
      { requestPath: "/compatible-mode", apiCompat: "openai_responses" },
      { requestPath: "/apps/anthropic", apiCompat: "anthropic" },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    iconSrc: "./provider-icons/minimax.ico",
    baseUrl: "https://api.minimax.io",
    requestPath: "/anthropic",
    version: "v1",
    apiCompat: "anthropic",
    defaultModel: "MiniMax-M2.7",
    apiKeyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    endpointVariants: [
      { requestPath: "/anthropic", apiCompat: "anthropic" },
      { requestPath: "", apiCompat: "openai_responses" },
      { requestPath: "", apiCompat: "openai_chat_completions" },
    ],
  },
  {
    id: "kimi",
    name: "Kimi",
    iconSrc: "./provider-icons/kimi.ico",
    baseUrl: "https://api.moonshot.cn",
    requestPath: "",
    version: "v1",
    apiCompat: "openai_chat_completions",
    defaultModel: "kimi-k2.6",
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
    endpointVariants: [
      { requestPath: "", apiCompat: "openai_chat_completions" },
      { requestPath: "", apiCompat: "openai_responses" },
      { requestPath: "/anthropic", apiCompat: "anthropic" },
    ],
  },
  {
    id: "tencent",
    name: "Tencent Hunyuan",
    iconSrc: "./provider-icons/tencent-hunyuan.png",
    baseUrl: "https://tokenhub.tencentmaas.com",
    requestPath: "",
    version: "v1",
    apiCompat: "openai_chat_completions",
    defaultModel: "hy4-preview",
    apiKeyUrl: "https://cloud.tencent.com/document/product/1823/130078",
    endpointVariants: [
      { requestPath: "", apiCompat: "openai_chat_completions" },
      { requestPath: "", apiCompat: "openai_responses" },
      { requestPath: "", apiCompat: "anthropic" },
    ],
  },
  {
    id: "xiaomi-mimo",
    name: "Xiaomi MiMo",
    iconSrc: "./provider-icons/xiaomi-mimo.ico",
    baseUrl: "https://api.xiaomimimo.com",
    requestPath: "",
    version: "v1",
    apiCompat: "openai_chat_completions",
    defaultModel: "mimo-v2.5",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/docs",
    endpointVariants: [
      { requestPath: "", apiCompat: "openai_chat_completions" },
      { requestPath: "/anthropic", apiCompat: "anthropic" },
    ],
  },
];

export const DEFAULT_NEW_PROVIDER_PRESET_ID = "openai";

export const MAINSTREAM_PROVIDER_PRESETS: ProviderPresetDefinition[] = [...PROVIDER_PRESET_DEFINITIONS].sort(
  compareProviderPresets,
);

export function getProviderPresetById(id: string): ProviderPresetDefinition | undefined {
  return MAINSTREAM_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function getProviderPresetEndpointVariants(
  preset: ProviderPresetDefinition,
): ProviderEndpointVariant[] {
  if (preset.endpointVariants?.length) {
    return preset.endpointVariants;
  }
  return [{ requestPath: preset.requestPath, apiCompat: preset.apiCompat }];
}

function resolveVariantVersion(preset: ProviderPresetDefinition, variant: ProviderEndpointVariant): string {
  return variant.version ?? preset.version;
}

export function presetSupportsEndpoint(
  preset: ProviderPresetDefinition,
  endpoint: Pick<ProviderConfigInput, "requestPath" | "apiCompat" | "version">,
): boolean {
  const apiCompat = endpoint.apiCompat ?? "anthropic";
  const requestPath = normalizeRequestPathForCompare(endpoint.requestPath);
  const version = (endpoint.version ?? "v1").trim();
  return getProviderPresetEndpointVariants(preset).some(
    (variant) =>
      variant.apiCompat === apiCompat &&
      normalizeRequestPathForCompare(variant.requestPath) === requestPath &&
      resolveVariantVersion(preset, variant) === version,
  );
}

export function formBelongsToProviderPreset(
  form: Pick<ProviderConfigInput, "baseUrl" | "requestPath" | "apiCompat" | "version" | "authMethod">,
  preset: ProviderPresetDefinition,
): boolean {
  if ((form.authMethod ?? "api_key") !== (preset.authMethod ?? "api_key")) {
    return false;
  }
  if (normalizeComparable(form.baseUrl) !== normalizeComparable(preset.baseUrl)) {
    return false;
  }
  return presetSupportsEndpoint(preset, form);
}

export function findPresetForForm(
  form: Pick<ProviderConfigInput, "baseUrl" | "requestPath" | "apiCompat" | "version" | "authMethod">,
): ProviderPresetDefinition | undefined {
  return MAINSTREAM_PROVIDER_PRESETS.find((preset) => formBelongsToProviderPreset(form, preset));
}

export function findPresetEndpointVariant(
  preset: ProviderPresetDefinition,
  apiCompat: UpstreamApiCompat,
): ProviderEndpointVariant | undefined {
  return getProviderPresetEndpointVariants(preset).find((variant) => variant.apiCompat === apiCompat);
}

export function togglePresetEndpointVariant(
  preset: ProviderPresetDefinition,
  current: Pick<ProviderConfigInput, "requestPath" | "apiCompat" | "version">,
): ProviderEndpointVariant {
  const variants = getProviderPresetEndpointVariants(preset);
  if (variants.length === 0) {
    return { requestPath: preset.requestPath, apiCompat: preset.apiCompat };
  }
  if (variants.length === 1) {
    return variants[0]!;
  }

  const currentApiCompat = current.apiCompat ?? "anthropic";
  const currentRequestPath = normalizeRequestPathForCompare(current.requestPath);
  const currentVersion = (current.version ?? "v1").trim();
  const currentIndex = variants.findIndex(
    (variant) =>
      variant.apiCompat === currentApiCompat &&
      normalizeRequestPathForCompare(variant.requestPath) === currentRequestPath &&
      resolveVariantVersion(preset, variant) === currentVersion,
  );
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % variants.length;
  return variants[nextIndex]!;
}

export function applyProviderPreset(
  form: ProviderConfigInput,
  preset: ProviderPresetDefinition,
): ProviderConfigInput {
  return {
    ...form,
    ...(preset.id === "chatgpt-subscription" && !form.id ? { id: "eco-coding-chatgpt" } : {}),
    name: preset.name,
    baseUrl: preset.baseUrl,
    requestPath: preset.requestPath,
    version: preset.version,
    apiCompat: preset.apiCompat,
    defaultModel: preset.defaultModel,
    authMethod: preset.authMethod ?? "api_key",
    credentialPoolId: preset.credentialPoolId ?? "",
    enabled: true,
  };
}

export function findMatchingProviderPreset(
  form: Pick<ProviderConfigInput, "baseUrl" | "requestPath" | "apiCompat" | "defaultModel" | "version">,
): ProviderPresetDefinition | undefined {
  return findPresetForForm(form);
}

function normalizeComparable(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function normalizeRequestPathForCompare(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}
