export type ProviderTokenCountMode =
  | "provider_native"
  /** @deprecated Persisted legacy value; normalized to provider_native on read. */
  | "local_heuristic"
  | "anthropic_messages"
  | "openai_responses"
  | "llama_tokenize";

export const PROVIDER_TOKEN_COUNT_MODES: readonly ProviderTokenCountMode[] = [
  "provider_native",
  "anthropic_messages",
  "openai_responses",
  "llama_tokenize",
];

export function normalizeProviderTokenCountMode(value: unknown): ProviderTokenCountMode {
  if (value === undefined || value === null || value === "" || value === "local_heuristic") {
    return "provider_native";
  }
  if (PROVIDER_TOKEN_COUNT_MODES.includes(value as ProviderTokenCountMode)) {
    return value as ProviderTokenCountMode;
  }
  throw new Error(`无效的 Provider token 计数模式：${String(value)}`);
}
