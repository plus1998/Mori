export type AccountUsageKind = "chatgpt_login" | "chatgpt_oauth" | "custom_provider";
export type AccountUsagePeriod = "5h" | "day" | "week" | "month";

export interface AccountUsageQuery {
  kind: AccountUsageKind;
  accountId: string;
  period: AccountUsagePeriod;
  /** Exclusive bucket-start cursor. */
  before?: number;
}

export interface AccountUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Included in outputTokens, never added to totalTokens again. */
  reasoningTokens: number;
  totalTokens: number;
  records: number;
  estimatedCostUsd: number;
  unpricedRecords: number;
}

export interface AccountUsageBucket extends AccountUsageTotals {
  startAt: number;
  endAt: number;
}

export interface AccountUsageHistory {
  trackingStartedAt: number;
  firstUsageAt: number | null;
  totals: AccountUsageTotals;
  buckets: AccountUsageBucket[];
  nextBefore?: number;
  timeZone: string;
  recordingFailure?: { count: number; lastError: string; lastErrorAt: number };
}

export interface UsageOverviewQuery {
  period: AccountUsagePeriod | "all";
  /** A timestamp inside the selected window. Defaults to now. */
  at?: number | undefined;
  providerKey?: string | undefined;
  modelId?: string | undefined;
}

export interface UsageOverviewRow extends AccountUsageTotals {
  providerKey: string;
  providerName: string;
  modelId: string;
}

export interface UsageOverview {
  trackingStartedAt: number;
  startAt: number | null;
  endAt: number | null;
  timeZone: string;
  totals: AccountUsageTotals;
  rows: UsageOverviewRow[];
  /** Historical dimensions remain available after deleting a provider. */
  dimensions: Array<{ providerKey: string; providerName: string; modelId: string }>;
  recordingFailures: number;
}
