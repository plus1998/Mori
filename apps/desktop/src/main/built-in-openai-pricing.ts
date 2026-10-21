import type { ModelCostRates } from "@eco/runtime";

/**
 * Default (public list) pricing for the built-in OpenAI provider — the virtual
 * "openai" provider backed by a ChatGPT auth.json login (Codex app-server).
 *
 * When models.dev has no matching model, use known public API list prices for
 * an API-equivalent estimate. These are not ChatGPT subscription charges or
 * measurements of the account's included usage allowance.
 *
 * Rates are USD per million tokens (ModelCostRates), Standard short-context:
 * https://developers.openai.com/api/docs/pricing
 */
export const BUILT_IN_OPENAI_DEFAULT_RATES: Readonly<Record<string, ModelCostRates>> = {
  // GPT-5.6 family (official USD/MTok; cache-write = 1.25× input).
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  // GPT-6.
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  // GPT-5.5 family.
  "gpt-5.5-pro": { input: 30, output: 180, cacheRead: 30, cacheWrite: 30 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
  // GPT-5.4 family.
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
  // Codex-family fallback (GPT-5.3 Codex list price).
  "gpt-5.3-codex": { input: 1.5, output: 12, cacheRead: 0.15, cacheWrite: 1.5 },
};

/**
 * Normalize a built-in OpenAI model id to a base key in
 * {@link BUILT_IN_OPENAI_DEFAULT_RATES}. Handles effort/variant suffixes such as
 * `gpt-5.6-luna-high` → `gpt-5.6-luna`, and `gpt-6` → `gpt-6-astra`.
 * Returns null when the model has no known default price.
 */
export function resolveBuiltInOpenAiDefaultRates(modelId: string | undefined): ModelCostRates | null {
  const raw = (modelId ?? "").trim().toLowerCase();
  if (!raw) {
    return null;
  }

  const base = raw
    // Strip effort/variant suffixes: -high/-low/-medium/-max/-fast/-flex,
    // and the trailing -openai-compact.
    .replace(/-(high|low|medium|max|fast|flex)$/, "")
    .replace(/-openai-compact$/, "")
    .trim();

  const candidates = [base, raw];
  for (const candidate of candidates) {
    const exact = BUILT_IN_OPENAI_DEFAULT_RATES[candidate];
    if (exact) {
      return exact;
    }
  }

  // Prefix matches for longer variant names not covered by the suffix strip.
  const prefixes: Array<[string, string]> = [
    ["gpt-6-astra", "gpt-6-astra"],
    ["gpt-6-sol", "gpt-6-sol"],
    ["gpt-6.1-sol", "gpt-6.1-sol"],
    ["gpt-6-luna", "gpt-6-luna"],
    ["gpt-5.6-sol", "gpt-5.6-sol"],
    ["gpt-5.6-terra", "gpt-5.6-terra"],
    ["gpt-5.6-luna", "gpt-5.6-luna"],
    ["gpt-5.5-pro", "gpt-5.5-pro"],
    ["gpt-5.4-mini", "gpt-5.4-mini"],
    ["gpt-5.4-nano", "gpt-5.4-nano"],
    ["gpt-5.5", "gpt-5.5"],
    ["gpt-5.4", "gpt-5.4"],
  ];
  for (const [prefix, key] of prefixes) {
    if (base === prefix || base.startsWith(`${prefix}-`)) {
      return BUILT_IN_OPENAI_DEFAULT_RATES[key] ?? null;
    }
  }

  // Keep the bare alias; unknown GPT-6 family members must remain unresolved.
  if (base === "gpt-6") {
    return BUILT_IN_OPENAI_DEFAULT_RATES["gpt-6-astra"] ?? null;
  }

  // Bare "gpt-5.6" → default to sol (matches sub2api behavior).
  if (base === "gpt-5.6") {
    return BUILT_IN_OPENAI_DEFAULT_RATES["gpt-5.6-sol"] ?? null;
  }

  return null;
}
