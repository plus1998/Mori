import { expect, test } from "bun:test";
import { parseOpenAiApiPricing, resolveOpenAiApiRates } from "../src/main/openai-api-pricing";
import { PRICING_MARKDOWN } from "./openai-api-pricing-fixture";

const usage = { inputTokens: 200_000, outputTokens: 1000, cacheReadTokens: 72_000, cacheCreationTokens: 0 };

test("parses official Standard prices without mixing other tiers, finetuning or cache-write durations", () => {
  const prices = parseOpenAiApiPricing(PRICING_MARKDOWN);
  expect(prices["gpt-6.1-sol"]).toEqual({
    shortContext: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    shortContextMaxInputTokens: 272_000,
    longContext: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
  });
  expect(prices["gpt-5.4-mini"]).toEqual({ shortContext: { input: 0.75, output: 4.5, cacheRead: 0.075 } });
  expect(prices["gpt-5.3-codex"]).toEqual({ shortContext: { input: 1.75, output: 14, cacheRead: 0.175 } });
  expect(prices["gpt-5.5-pro"]?.shortContext.cacheRead).toBeUndefined();
  expect(prices["text-embedding-3-small"]).toBeUndefined();
});

test("chooses context price from individual total input including cache, with exact threshold boundary", () => {
  const price = parseOpenAiApiPricing(PRICING_MARKDOWN)["gpt-6.1-sol"];
  expect(resolveOpenAiApiRates(price, usage)?.input).toBe(2);
  expect(resolveOpenAiApiRates(price, { ...usage, cacheReadTokens: 72_001 })?.input).toBe(4);
  expect(resolveOpenAiApiRates(price, { ...usage, outputTokens: 200_000 })?.input).toBe(2);
  expect(resolveOpenAiApiRates(price, { ...usage, inputTokens: 300_000 }, true)).toBeNull();
});

test("missing prices and unsupported cached-token rates stay unresolved", () => {
  const prices = parseOpenAiApiPricing(PRICING_MARKDOWN);
  expect(resolveOpenAiApiRates(prices["gpt-6-unknown"], usage)).toBeNull();
  expect(resolveOpenAiApiRates(prices["gpt-5.5-pro"], usage)).toBeNull();
  expect(resolveOpenAiApiRates(prices["gpt-5.4-mini"], { ...usage, cacheCreationTokens: 1 })).toBeNull();
});

test("rejects changed, missing, truncated or conflicting official tables", () => {
  for (const body of [
    "<html>access denied</html>",
    PRICING_MARKDOWN.replace("$2.00 | $10.00", "$unknown | $10.00"),
    PRICING_MARKDOWN.replace("≤272K", "≤400K"),
    PRICING_MARKDOWN.replace("| gpt-6-astra | $10.00 |", "| gpt-6-astra |"),
    PRICING_MARKDOWN +
      "\nStandard\n| Model | Input | Output | Cached input |\n| --- | --- | --- | --- |\n| gpt-6.1-sol | $99 | $99 | $9 |",
  ])
    expect(() => parseOpenAiApiPricing(body)).toThrow(/官方 API/);
});
