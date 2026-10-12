const ECO_SDK_ALIAS_PATTERN = /^eco-[a-z]+-[a-f0-9]{12}$/;

/**
 * Vendor prefixes dropped from display names: these families are household
 * names, so `gpt-6.1-sol` reads better as `6.1 Sol` and `claude-opus-5_5` as
 * `Opus 5.5`.
 */
const MODEL_VENDOR_PREFIX_PATTERN = /^(gpt|claude)[-_]/i;
const MODEL_VENDOR_ALIASES: Record<string, string> = { gpt: "GPT", claude: "Claude" };

/**
 * Humanizes a raw model id for compact UI (composer label, model menus):
 * - strips a leading `gpt` / `claude` vendor prefix
 * - turns `-` separated tokens into capitalized words (`qwen3.8-flash-next` →
 *   `Qwen3.8 Flash Next`)
 * - turns a separator between single digits into `.` (`opus-5_5` / `opus-4-6`
 *   → `Opus 5.5` / `Opus 4.6`); other `_` characters are kept as-is
 */
export function formatModelDisplayName(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return "";
  }
  const slash = trimmed.lastIndexOf("/");
  const leaf = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).trim();
  if (!leaf) {
    return trimmed;
  }
  const bareVendor = MODEL_VENDOR_ALIASES[leaf.toLowerCase()];
  if (bareVendor) {
    return bareVendor;
  }
  const prefixLength = leaf.match(MODEL_VENDOR_PREFIX_PATTERN)?.[0].length ?? 0;
  const body = leaf.slice(prefixLength);
  const parts = mergeDigitVersionTokens(body.split("-"))
    .map((part) => capitalizeModelSegment(part))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" ") : leaf;
}

/**
 * Joins adjacent single-digit tokens (`4`, `6`) into one version token
 * (`4.6`), so `claude-opus-4-6` reads as `Opus 4.6`. Only single digits join:
 * `llama-3.3-70b` stays `Llama 3.3 70b`.
 */
function mergeDigitVersionTokens(tokens: string[]): string[] {
  const merged: string[] = [];
  // True while the last entry is made only of single-digit source tokens.
  let mergeable = false;
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    const singleDigit = /^\d$/.test(token);
    if (mergeable && singleDigit) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}.${token}`;
      continue;
    }
    merged.push(token);
    mergeable = singleDigit;
  }
  return merged;
}

function capitalizeModelSegment(segment: string): string {
  const normalized = segment.replace(/(\d)_(?=\d)/g, "$1.");
  if (!normalized) {
    return "";
  }
  return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

export function isEcoSdkModelAlias(modelId: string): boolean {
  return ECO_SDK_ALIAS_PATTERN.test(modelId.trim());
}

/** Prefer configured upstream id when live usage reports an SDK alias. */
export function pickDisplayModelId(
  live: string | undefined,
  configured: string | undefined,
): string | undefined {
  const liveTrimmed = live?.trim();
  const configuredTrimmed = configured?.trim();
  if (!liveTrimmed) {
    return configuredTrimmed || undefined;
  }
  if (isEcoSdkModelAlias(liveTrimmed)) {
    return configuredTrimmed || undefined;
  }
  return liveTrimmed;
}
