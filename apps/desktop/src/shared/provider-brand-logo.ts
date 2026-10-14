export type ProviderBrandId =
  | "grok"
  | "google"
  | "openai"
  | "anthropic"
  | "deepseek"
  | "doubao"
  | "bailian"
  | "kimi"
  | "minimax"
  | "hunyuan"
  | "xiaomi"
  | "opencode"
  | "system-one";

export const PROVIDER_BRAND_IDS: readonly ProviderBrandId[] = [
  "grok",
  "google",
  "openai",
  "anthropic",
  "deepseek",
  "doubao",
  "bailian",
  "kimi",
  "minimax",
  "hunyuan",
  "xiaomi",
  "opencode",
  "system-one",
];

/** Brand marks already shipped with the desktop app. */
export const PROVIDER_BRAND_LOGOS: Record<ProviderBrandId, string> = {
  grok: "./agent-icons/grok.ico",
  google: "./agent-icons/gemini.png",
  openai: "./provider-icons/openai.svg",
  anthropic: "./provider-icons/claude.ico",
  deepseek: "./provider-icons/deepseek.ico",
  doubao: "./provider-icons/doubao.png",
  bailian: "./provider-icons/bailian.png",
  kimi: "./provider-icons/kimi.ico",
  minimax: "./provider-icons/minimax.ico",
  hunyuan: "./provider-icons/tencent-hunyuan.png",
  xiaomi: "./provider-icons/xiaomi-mimo.ico",
  opencode: "./provider-icons/opencode-zen.ico",
  "system-one": "./provider-icons/system-one.png",
};

/** Ordered matchers: the first hit wins, so keep specific brands above generic ones. */
const PROVIDER_BRAND_PATTERNS: readonly { brand: ProviderBrandId; pattern: RegExp }[] = [
  { brand: "grok", pattern: /grok|xai|x-ai/ },
  { brand: "google", pattern: /google|gemini|gemma|imagen|nano-?banana|deepmind|veo/ },
  { brand: "anthropic", pattern: /anthropic|claude|sonnet|opus|haiku/ },
  { brand: "deepseek", pattern: /deepseek|深度求索/ },
  { brand: "doubao", pattern: /doubao|豆包|volcengine|方舟/ },
  { brand: "bailian", pattern: /bailian|百炼|dashscope|qwen|通义|tongyi|aliyun|alibaba/ },
  { brand: "kimi", pattern: /kimi|moonshot|月之暗面/ },
  { brand: "minimax", pattern: /minimax|abab|海螺/ },
  { brand: "hunyuan", pattern: /hunyuan|混元|tencent/ },
  { brand: "xiaomi", pattern: /xiaomi|mimo|小米/ },
  { brand: "opencode", pattern: /opencode/ },
  { brand: "system-one", pattern: /typesafe|system-?one/ },
  { brand: "openai", pattern: /openai|chatgpt|\bgpt|dall-?e|sora|(^|[^a-z0-9])o[1-4]([^a-z0-9]|$)/ },
];

export interface ProviderBrandLogoInput {
  /** Vendor display name, e.g. "百炼 API". Highest priority. */
  name?: string | undefined;
  /** Model id, e.g. "gpt-image-2". Second priority. */
  model?: string | undefined;
  /** API protocol / provider kind, e.g. "openai_compatible". Third priority. */
  protocol?: string | undefined;
  /** Base URL, used as a last resort (e.g. "dashscope.aliyuncs.com"). */
  endpoint?: string | undefined;
}

export interface ProviderBrandLogo {
  brand: ProviderBrandId;
  iconSrc: string;
}

function matchBrand(text: string): ProviderBrandId | undefined {
  const haystack = text.trim().toLowerCase();
  if (!haystack) return undefined;
  return PROVIDER_BRAND_PATTERNS.find((entry) => entry.pattern.test(haystack))?.brand;
}

/**
 * Resolve a vendor logo for a settings profile.
 * Order matters and mirrors how users name things: vendor name > model name > protocol > base URL.
 */
export function resolveProviderBrandLogo(input: ProviderBrandLogoInput): ProviderBrandLogo | undefined {
  const candidates = [input.name, input.model, input.protocol, input.endpoint];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const brand = matchBrand(candidate);
    if (brand) return { brand, iconSrc: PROVIDER_BRAND_LOGOS[brand] };
  }
  return undefined;
}
