export interface UpstreamModelOption {
  id: string;
  displayName?: string;
}

export interface CodexModelCatalogEntryView {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
}

/** Where a Codex-account model came from: the codex-rs catalog or a manual add. */
export type CodexCatalogModelOrigin = "remote" | "manual";

/** Official API Standard rates, USD per million tokens. Missing cache rates are unknown. */
export interface CodexApiTokenRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CodexApiPricing {
  shortContext: CodexApiTokenRates;
  longContext?: CodexApiTokenRates;
  shortContextMaxInputTokens?: number;
}

/** Trimmed codex-rs models-manager entry as shown in the Codex 账号 model list. */
export interface CodexCatalogModelView {
  modelId: string;
  displayName: string;
  description?: string;
  contextWindow?: number;
  maxContextWindow?: number;
  defaultReasoningEffort?: string;
  reasoningEfforts: string[];
  supportsImageInput?: boolean;
  priority?: number;
  hidden: boolean;
  origin: CodexCatalogModelOrigin;
  apiPricing?: CodexApiPricing;
}

export interface CodexModelCatalogStatusView {
  sourceUrl: string;
  /** Wall-clock ms of the last successful fetch; absent until one succeeds. */
  fetchedAt?: number;
  /** Last refresh failure; cleared by the next successful refresh. */
  lastError?: string;
  remoteCount: number;
  manualCount: number;
  pricingSourceUrl: string;
  pricingFetchedAt?: number;
}

export interface CodexModelCatalogSnapshot {
  models: CodexCatalogModelView[];
  status: CodexModelCatalogStatusView;
}

export interface AddCodexCatalogModelRequest {
  modelId: string;
  displayName?: string;
}

import type { UpstreamApiCompat } from "./api-compat";

export interface ListUpstreamModelsRequest {
  providerId?: string;
  /** Explicit OAuth account, including a usage-paused account used for manual testing. */
  accountId?: string;
  authMethod?: "api_key" | "oauth" | "auth_json" | "chatgpt_subscription";
  baseUrl?: string;
  /** Service path prefix, e.g. `/zen` or `/anthropic` (not full `/v1/chat/completions`). */
  requestPath?: string;
  /** API path version segment (e.g. `v1`). Empty defaults to `v1`. */
  version?: string;
  apiCompat?: UpstreamApiCompat;
  apiKey?: string;
  /** Per-provider upstream proxy override (draft form value); falls back to global proxy. */
  upstreamProxyUrl?: string;
}

export type ProviderRequestErrorCode =
  | "provider_not_found"
  | "provider_base_url_missing"
  | "base_url_missing";

export interface ProviderRequestError {
  ok: false;
  error: string;
  errorCode?: ProviderRequestErrorCode;
  providerId?: string;
  providerName?: string;
}

export type ListUpstreamModelsResult = { ok: true; models: UpstreamModelOption[] } | ProviderRequestError;

/** Thinking effort sent on connectivity tests (always disabled). */
export const ROUTE_TEST_THINKING_EFFORT = "off" as const;

export interface TestProviderConnectionRequest {
  providerId?: string;
  baseUrl?: string;
  requestPath?: string;
  /** API path version segment (e.g. `v1`). Empty defaults to `v1`. */
  version?: string;
  apiCompat?: UpstreamApiCompat;
  apiKey?: string;
  /** Per-provider upstream proxy override (draft form value); falls back to global proxy. */
  upstreamProxyUrl?: string;
  defaultModel?: string;
  thinkingEffort?: typeof ROUTE_TEST_THINKING_EFFORT;
}

export type TestProviderConnectionResult = { ok: true; reply: string } | ProviderRequestError;

export interface TestRoleRouteItem {
  role: string;
  providerId: string;
  modelId: string;
  apiCompat?: UpstreamApiCompat;
  thinkingEffort?: string;
}

export interface RoleRouteTestResult {
  role: string;
  modelId: string;
  ok: boolean;
  error?: string;
  reply?: string;
  elapsedMs?: number;
}

export interface TestRoleRoutesRequest {
  routes: TestRoleRouteItem[];
}

export interface TestRoleRoutesResult {
  results: RoleRouteTestResult[];
  passed: number;
  failed: number;
}
