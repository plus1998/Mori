import { GATEWAY_UPSTREAM_RETRY, runWithUpstreamResponseRetry } from "@eco/openai-anthropic-bridge";
import {
  fetchWithRequestLifecycle,
  type RequestLifecycleContext,
  tryEmitHttpUpstreamFailure,
  tryEmitUpstreamFailed,
} from "../request-lifecycle.js";
import type { GatewayLogFn } from "../server.js";
import type { GatewayUpstreamErrorInfo, ResolvedProviderRoute } from "../types.js";
import { readUpstreamRequestId } from "./request-id-headers.js";
import {
  extractUpstreamErrorCode,
  extractUpstreamErrorMessage,
  extractUpstreamErrorInfo,
  formatUpstreamHttpError,
} from "./upstream-error.js";
import { UPSTREAM_PROXY_URL } from "../upstream-proxy.js";

export interface FetchUpstreamWithRetryOptions {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  lifecycle?: RequestLifecycleContext | undefined;
  onLog?: GatewayLogFn | undefined;
  signal?: AbortSignal | undefined;
  maxAttempts?: number | undefined;
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  maxElapsedMs?: number | undefined;
  /** Optional account-level proxy selected after credential resolution. */
  upstreamProxyUrl?: string | undefined;
  /** Adds provider/model/url context to per-attempt HTTP lifecycle failures. */
  httpFailureContext?: {
    route: ResolvedProviderRoute;
    upstreamUrl: string;
  };
}

/**
 * Same-route upstream fetch with transient HTTP / network retries before any
 * client body is written. Uses lifecycle attemptIndex when provided.
 */
export async function fetchUpstreamWithRetry(options: FetchUpstreamWithRetryOptions): Promise<Response> {
  const {
    fetchImpl,
    url,
    init,
    lifecycle,
    onLog = () => undefined,
    signal,
    maxAttempts = GATEWAY_UPSTREAM_RETRY.maxAttempts,
    baseDelayMs = GATEWAY_UPSTREAM_RETRY.baseDelayMs,
    maxDelayMs = GATEWAY_UPSTREAM_RETRY.maxDelayMs,
    maxElapsedMs = GATEWAY_UPSTREAM_RETRY.maxElapsedMs,
  } = options;

  const requestInit = {
    ...(signal ? { ...init, signal } : init),
    ...(options.upstreamProxyUrl ? { [UPSTREAM_PROXY_URL]: options.upstreamProxyUrl } : {}),
  } as RequestInit;

  let currentAttemptIsSubscriptionQuotaFailure = false;
  const formatFailure = (status: number, bodyText: string): string =>
    options.httpFailureContext
      ? formatUpstreamHttpError({
          route: options.httpFailureContext.route,
          upstreamUrl: options.httpFailureContext.upstreamUrl,
          status,
          bodyText,
        })
      : extractUpstreamErrorMessage(bodyText);
  const attemptDetails = new Map<
    number,
    { errorInfo?: GatewayUpstreamErrorInfo; providerRequestId?: string; bodyText?: string }
  >();
  const { value } = await runWithUpstreamResponseRetry(
    async () => {
      const response = lifecycle
        ? await fetchWithRequestLifecycle(fetchImpl, url, requestInit, lifecycle)
        : await fetchImpl(url, requestInit);
      currentAttemptIsSubscriptionQuotaFailure = false;
      if (response.status >= 400) {
        let bodyText = "";
        let errorInfo: GatewayUpstreamErrorInfo | undefined;
        try {
          bodyText = await response.clone().text();
          errorInfo = extractUpstreamErrorInfo(bodyText, "http");
        } catch {
          // General transient statuses remain retryable when the body cannot be inspected.
        }
        currentAttemptIsSubscriptionQuotaFailure =
          extractUpstreamErrorCode(bodyText) === "subscription_sharing_usage_limit_exceeded";
        const providerRequestId = readUpstreamRequestId(response.headers);
        attemptDetails.set(lifecycle?.attemptIndex ?? -1, {
          ...(errorInfo ? { errorInfo } : {}),
          ...(providerRequestId ? { providerRequestId } : {}),
          ...(bodyText ? { bodyText } : {}),
        });
      }
      return response;
    },
    {
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      maxElapsedMs,
      signal,
      shouldRetryStatus: (status) =>
        status === 429 && currentAttemptIsSubscriptionQuotaFailure
          ? false
          : status === 408 || status === 429 || status === 529 || status >= 500,
      onRetry: ({ attempt, status, error, delayMs }) => {
        if (status !== undefined) {
          const details = attemptDetails.get(attempt - 1);
          if (lifecycle && lifecycle.tracker.upstreamTerminalFor(lifecycle.attemptIndex) === undefined) {
            tryEmitUpstreamFailed(lifecycle, {
              stage: "http",
              error:
                (details?.bodyText && formatFailure(status, details.bodyText)) ||
                `Transient upstream HTTP ${status} on attempt ${attempt}`,
              statusCode: status,
              ...(details?.providerRequestId
                ? { providerRequestId: details.providerRequestId }
                : {}),
              ...(details?.errorInfo ? { errorInfo: details.errorInfo } : {}),
            });
          }
          onLog(`upstream retry attempt=${attempt} status=${status} delayMs=${delayMs} url=${url}`);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        onLog(`upstream retry attempt=${attempt} transport=${message} delayMs=${delayMs} url=${url}`);
      },
    },
  );

  if (lifecycle && value.status >= 400) {
    const attemptIndex = lifecycle.attemptIndex;
    const providerRequestId = readUpstreamRequestId(value.headers);
    const details = attemptDetails.get(attemptIndex);
    const resolvedProviderRequestId = providerRequestId ?? details?.providerRequestId;
    tryEmitHttpUpstreamFailure(lifecycle, {
      error:
        (details?.bodyText && formatFailure(value.status, details.bodyText)) ||
        `Upstream returned HTTP ${value.status}`,
      statusCode: value.status,
      ...(resolvedProviderRequestId ? { providerRequestId: resolvedProviderRequestId } : {}),
      ...(details?.errorInfo ? { errorInfo: details.errorInfo } : {}),
    });
  }
  return value;
}
