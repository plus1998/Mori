import { estimateCostFromTokens } from "@eco/runtime";
import type { AccountUsageRecord, AccountUsageStore } from "./account-usage-store";
import { resolveRatesForRoute } from "./billing-resolver";
import type { UsageBillingPricingLookup, UsageBillingPricingRoute } from "./usage-billing-artifacts";

/** Persist before pricing; a duplicate physical event never starts another price resolution. */
export async function recordProviderUsage(
  services: {
    store: Pick<AccountUsageStore, "append" | "setEstimatedCost">;
    lookupPricing: UsageBillingPricingLookup;
    recordingFailed(record: AccountUsageRecord, error: unknown): void;
    pricingFailed(record: AccountUsageRecord, error: unknown): void;
  },
  record: AccountUsageRecord,
  route?: UsageBillingPricingRoute,
): Promise<void> {
  try {
    if (!services.store.append(record)) return;
  } catch (error) {
    services.recordingFailed(record, error);
    return;
  }
  try {
    const lookup = route ? await services.lookupPricing(route, record) : null;
    const rates = resolveRatesForRoute(lookup, route?.manualSpec);
    if (
      !rates ||
      (record.cacheReadTokens > 0 && rates.cacheRead === undefined) ||
      (record.cacheCreationTokens > 0 && rates.cacheWrite === undefined)
    )
      return;
    services.store.setEstimatedCost(record, estimateCostFromTokens(record, rates));
  } catch (error) {
    services.pricingFailed(record, error);
  }
}
