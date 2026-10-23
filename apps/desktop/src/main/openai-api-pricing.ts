import type { ModelCostRates, ParsedUsage } from "@eco/runtime";
import type { CodexApiPricing, CodexApiTokenRates } from "../shared/models";

export const OPENAI_API_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";

/** Parse only Standard text-token tables. Never infer prices from model families. */
export function parseOpenAiApiPricing(markdown: string): Record<string, CodexApiPricing> {
  const prices: Record<string, CodexApiPricing> = {};
  const lines = markdown.split(/\r?\n/);
  const thresholdMatch = markdown.match(
    /Short context:\s*≤([\d.]+)K input tokens\.\s*Long context:\s*>\1K input tokens\./,
  );
  const threshold = thresholdMatch ? Number(thresholdMatch[1]) * 1000 : undefined;
  let tier = "";
  let sawStandard = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    const tierMatch = line.match(/^(?:#{1,6}\s+)?(Standard|Batch|Flex|Fast|Ultrafast)(?: pricing data)?$/i);
    if (tierMatch) {
      tier = tierMatch[1]?.toLowerCase() ?? "";
      if (tier === "standard") sawStandard = true;
    }
    if (tier !== "standard" || !line.startsWith("|")) continue;
    const headers = cells(line).map((value) => value.toLowerCase());
    const modelIndex = headers.indexOf("model");
    const wide = headers.includes("short context input");
    if (modelIndex < 0 || headers.includes("training") || headers.includes("modality")) continue;
    if (
      !wide &&
      !(headers.includes("input") && headers.includes("output") && headers.includes("cached input"))
    )
      continue;
    if (wide && threshold === undefined) throw new Error("官方 API 价格表缺少长短上下文分界，无法解析。");
    const separator = cells(lines[++i] ?? "");
    if (separator.length !== headers.length || separator.some((value) => !/^:?-{3,}:?$/.test(value))) {
      throw new Error("官方 API 价格表格式已变化：缺少表头分隔行。");
    }
    let rowCount = 0;
    while (lines[i + 1]?.trim().startsWith("|")) {
      const row = cells(lines[++i] ?? "");
      if (row.length !== headers.length) throw new Error("官方 API 价格表不完整：列数不匹配。");
      rowCount += 1;
      // Specialized tables also contain embeddings/moderation with different units.
      if (headers[0] === "category" && row[0] !== "Codex") continue;
      const modelId = row[modelIndex]
        ?.replace(/\s*\([^)]*\)$/, "")
        .replace(/`/g, "")
        .trim();
      if (!modelId || !/^[a-z0-9][a-z0-9.-]*$/.test(modelId)) {
        throw new Error("官方 API 价格表包含无法识别的模型名称。");
      }
      const readRates = (prefix: string): CodexApiTokenRates | undefined => {
        const read = (name: string) => {
          const index = headers.indexOf(`${prefix}${name}`);
          return index < 0 ? undefined : parseDollarRate(row[index] ?? "");
        };
        const input = read("input");
        const output = read("output");
        const cacheRead = read("cached input");
        const cacheWrite = prefix ? read("30m write") : undefined;
        if (
          input === undefined &&
          output === undefined &&
          cacheRead === undefined &&
          cacheWrite === undefined
        )
          return undefined;
        if (input === undefined || output === undefined)
          throw new Error(`官方 API 价格表 ${modelId} 缺少输入或输出价格。`);
        return {
          input,
          output,
          ...(cacheRead !== undefined && { cacheRead }),
          ...(cacheWrite !== undefined && { cacheWrite }),
        };
      };
      const shortContext = readRates(wide ? "short context " : "");
      if (!shortContext) throw new Error(`官方 API 价格表 ${modelId} 缺少 Standard 单价。`);
      const longContext = wide ? readRates("long context ") : undefined;
      const pricing: CodexApiPricing = {
        shortContext,
        ...(wide && { shortContextMaxInputTokens: threshold as number }),
        ...(longContext && { longContext }),
      };
      const previous = prices[modelId];
      if (previous && JSON.stringify(previous) !== JSON.stringify(pricing)) {
        throw new Error(`官方 API 价格表 ${modelId} 存在冲突的 Standard 单价。`);
      }
      prices[modelId] = pricing;
    }
    if (!rowCount) throw new Error("官方 API 价格表为空。");
  }
  if (!sawStandard || Object.keys(prices).length === 0) {
    throw new Error("官方 API 价格页面格式已变化：未找到 Standard 模型价格表。");
  }
  return prices;
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((value) => value.trim());
}

function parseDollarRate(value: string): number | undefined {
  if (value === "-") return undefined;
  if (!/^\$\d+(?:\.\d+)?$/.test(value)) throw new Error(`官方 API 价格表包含无法识别的单价：${value}`);
  const rate = Number(value.slice(1));
  if (!Number.isFinite(rate)) throw new Error(`官方 API 单价无效：${value}`);
  return rate;
}

export function resolveOpenAiApiRates(
  pricing: CodexApiPricing | undefined,
  usage: ParsedUsage,
  isAggregate = false,
): ModelCostRates | null {
  if (!pricing) return null;
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  // A sum of many short requests must never be billed at a long-request rate.
  if (
    isAggregate &&
    pricing.shortContextMaxInputTokens !== undefined &&
    totalInput > pricing.shortContextMaxInputTokens
  )
    return null;
  const rates =
    pricing.shortContextMaxInputTokens !== undefined && totalInput > pricing.shortContextMaxInputTokens
      ? pricing.longContext
      : pricing.shortContext;
  if (
    !rates ||
    (usage.cacheReadTokens > 0 && rates.cacheRead === undefined) ||
    (usage.cacheCreationTokens > 0 && rates.cacheWrite === undefined)
  )
    return null;
  return { ...rates };
}

/** Reject corrupted/old cache entries rather than accepting guessed default prices. */
export function isCodexApiPricing(value: unknown): value is CodexApiPricing {
  const validRates = (rates: unknown): rates is CodexApiTokenRates => {
    if (!rates || typeof rates !== "object") return false;
    const record = rates as Record<string, unknown>;
    const valid = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
    return (
      valid(record.input) &&
      valid(record.output) &&
      (record.cacheRead === undefined || valid(record.cacheRead)) &&
      (record.cacheWrite === undefined || valid(record.cacheWrite))
    );
  };
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    validRates(record.shortContext) &&
    (record.longContext === undefined || validRates(record.longContext)) &&
    (record.shortContextMaxInputTokens === undefined ||
      (typeof record.shortContextMaxInputTokens === "number" &&
        Number.isFinite(record.shortContextMaxInputTokens) &&
        record.shortContextMaxInputTokens > 0))
  );
}
