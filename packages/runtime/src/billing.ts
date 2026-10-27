import type { ParsedUsage } from "./usage";

export interface ModelCostRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface TokenCostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheCreationUsd: number;
  totalUsd: number;
}

export interface RequestBillingDelta {
  plannerTokenCostUsd: number;
  ecoCostUsd: number;
  plannerBreakdown: TokenCostBreakdown | null;
  ecoBreakdown: TokenCostBreakdown | null;
  pricingResolved: boolean;
}

export interface ThreadBillingTotals {
  sourceReportedCostUsd: number;
  plannerTokenCostUsd: number;
  ecoCostUsd: number;
  savedUsd: number;
  savedPct: number;
}

export function tokenTotalsFromUsage(usage: ParsedUsage): TokenTotals {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheCreation: usage.cacheCreationTokens,
  };
}

function resolveCacheReadRate(rates: ModelCostRates): number {
  return rates.cacheRead ?? rates.input * 0.1;
}

function resolveCacheWriteRate(rates: ModelCostRates): number {
  return rates.cacheWrite ?? rates.input * 1.25;
}

export function estimateCostBreakdown(usage: ParsedUsage, rates: ModelCostRates): TokenCostBreakdown {
  const cacheReadRate = resolveCacheReadRate(rates);
  const cacheWriteRate = resolveCacheWriteRate(rates);
  const inputUsd = (usage.inputTokens * rates.input) / 1_000_000;
  const outputUsd = (usage.outputTokens * rates.output) / 1_000_000;
  const cacheReadUsd = (usage.cacheReadTokens * cacheReadRate) / 1_000_000;
  const cacheCreationUsd = (usage.cacheCreationTokens * cacheWriteRate) / 1_000_000;
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheCreationUsd,
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheCreationUsd,
  };
}

export function estimateCostFromTokens(usage: ParsedUsage, rates: ModelCostRates): number {
  return estimateCostBreakdown(usage, rates).totalUsd;
}

export function mergeCostBreakdowns(
  current: TokenCostBreakdown,
  incoming: TokenCostBreakdown,
): TokenCostBreakdown {
  return {
    inputUsd: current.inputUsd + incoming.inputUsd,
    outputUsd: current.outputUsd + incoming.outputUsd,
    cacheReadUsd: current.cacheReadUsd + incoming.cacheReadUsd,
    cacheCreationUsd: current.cacheCreationUsd + incoming.cacheCreationUsd,
    totalUsd: current.totalUsd + incoming.totalUsd,
  };
}

export function emptyCostBreakdown(): TokenCostBreakdown {
  return {
    inputUsd: 0,
    outputUsd: 0,
    cacheReadUsd: 0,
    cacheCreationUsd: 0,
    totalUsd: 0,
  };
}

export function computeRequestBilling(
  delta: ParsedUsage,
  actualRates: ModelCostRates | null,
  plannerRates: ModelCostRates | null,
): RequestBillingDelta {
  const plannerBreakdown = plannerRates ? estimateCostBreakdown(delta, plannerRates) : null;
  const ecoBreakdown = actualRates ? estimateCostBreakdown(delta, actualRates) : null;
  return {
    plannerTokenCostUsd: plannerBreakdown?.totalUsd ?? 0,
    ecoCostUsd: ecoBreakdown?.totalUsd ?? 0,
    plannerBreakdown,
    ecoBreakdown,
    pricingResolved: Boolean(actualRates && plannerRates),
  };
}

export function computeSavings(
  plannerTokenCostUsd: number,
  ecoCostUsd: number,
): {
  savedUsd: number;
  savedPct: number;
} {
  const savedUsd = plannerTokenCostUsd - ecoCostUsd;
  const savedPct = plannerTokenCostUsd > 0 ? (savedUsd / plannerTokenCostUsd) * 100 : 0;
  return { savedUsd, savedPct };
}

export function computeThreadBillingTotals(
  sourceReportedCostUsd: number,
  plannerTokenCostUsd: number,
  ecoCostUsd: number,
): ThreadBillingTotals {
  const { savedUsd, savedPct } = computeSavings(plannerTokenCostUsd, ecoCostUsd);
  return {
    sourceReportedCostUsd,
    plannerTokenCostUsd,
    ecoCostUsd,
    savedUsd,
    savedPct,
  };
}

export function formatSavingsLine(savedUsd: number, savedPct: number): string {
  if (savedUsd >= 0) {
    return `Mori saved $${savedUsd.toFixed(4)} (${savedPct.toFixed(1)}%) for you`;
  }
  return `Mori overpaid by $${Math.abs(savedUsd).toFixed(4)} (${Math.abs(savedPct).toFixed(1)}%)`;
}

export function formatSavingsPct(savedPct: number): string {
  return `${savedPct.toFixed(1)}%`;
}
