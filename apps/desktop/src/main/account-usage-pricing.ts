import type { ModelCostRates, ParsedUsage } from "@eco/runtime";
import type { UsageBillingPricingLookup } from "./usage-billing-artifacts";

/** OAuth billing reads the same official snapshot as the management dialog. */
export function createAccountUsagePricingLookup(input: {
  lookupChatGptApiRates: (
    modelId: string,
    usage: ParsedUsage,
    isAggregate: boolean,
  ) => Promise<ModelCostRates | null>;
  lookupOtherPricing: UsageBillingPricingLookup;
}): UsageBillingPricingLookup {
  return async (route, usage, isAggregate = false) => {
    if (route.provider.authMethod !== "chatgpt_subscription")
      return input.lookupOtherPricing(route, usage, isAggregate);
    if (!usage) return null;
    const rates = await input.lookupChatGptApiRates(route.modelId, usage, isAggregate);
    return rates ? { providerKey: "openai", modelId: route.modelId, rates } : null;
  };
}
