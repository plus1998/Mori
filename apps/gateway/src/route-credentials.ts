import type { GatewayConfig, ResolvedProviderRoute } from "./types.js";

export function credentialResolutionErrorResponse(error: unknown): Response {
  const value = error as { statusCode?: unknown; errorCode?: unknown; accountId?: unknown };
  const statusCode = typeof value.statusCode === "number" && value.statusCode >= 400 && value.statusCode < 600
    ? value.statusCode
    : 503;
  const errorCode = typeof value.errorCode === "string" ? value.errorCode : undefined;
  const accountId = typeof value.accountId === "string" && value.accountId.trim()
    ? value.accountId.trim()
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const headers = new Headers({ "content-type": "application/json" });
  if (errorCode) headers.set("x-eco-upstream-error-code", errorCode);
  return new Response(JSON.stringify({
    error: {
      message,
      type: "credential_error",
      ...(errorCode ? { code: errorCode } : {}),
      ...(accountId ? { accountId } : {}),
    },
  }), { status: statusCode, headers });
}

/** Resolve local credentials for a provider without changing the public route contract. */
export async function resolveRouteCredential(
  route: ResolvedProviderRoute,
  config: GatewayConfig,
  request?: Request,
): Promise<ResolvedProviderRoute> {
  if (route.provider.authMethod !== "chatgpt_subscription") {
    return route;
  }
  if (!config.resolveCredential) {
    throw new Error(`Provider ${route.provider.id} requires a local ChatGPT subscription credential resolver`);
  }
  const credential = await config.resolveCredential({ provider: route.provider, ...(request ? { request } : {}) });
  if (!credential.accessToken.trim()) {
    throw new Error(`Provider ${route.provider.id} returned an empty ChatGPT access token`);
  }
  return {
    ...route,
    provider: {
      ...route.provider,
      apiKey: credential.accessToken,
      ...(credential.upstreamProxyUrl ? { upstreamProxyUrl: credential.upstreamProxyUrl } : {}),
    },
    ...(credential.accountId ? { credentialAccountId: credential.accountId } : {}),
  };
}

export async function reportRouteCredentialResult(
  route: ResolvedProviderRoute,
  config: GatewayConfig,
  upstreamResponse: Response,
): Promise<void> {
  if (route.provider.authMethod !== "chatgpt_subscription" || !config.reportCredentialResult) {
    return;
  }
  // HTTP success is not an upstream terminal. Only Response parsing can report
  // completed after observing the real protocol terminal.
  if (upstreamResponse.ok) {
    return;
  }
  let errorCode: string | undefined;
  let errorMessage = `Upstream returned HTTP ${upstreamResponse.status}`;
  errorCode = upstreamResponse.headers.get("x-eco-upstream-error-code")?.trim() || undefined;
  try {
    const body = await upstreamResponse.clone().text();
    const payload = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    if (!errorCode && typeof payload.error?.code === "string") errorCode = payload.error.code;
    if (typeof payload.error?.message === "string" && payload.error.message.trim()) {
      errorMessage = payload.error.message.trim();
    }
  } catch {
    // The original response is still returned to the caller; reporting is best effort.
  }
  await config.reportCredentialResult({
    provider: route.provider,
    resultType: "failed",
    logicalRequestId: route.logicalRequestId ?? "unattributed",
    attemptIndex: 0,
    ...(route.credentialAccountId ? { accountId: route.credentialAccountId } : {}),
    statusCode: upstreamResponse.status,
    error: {
      message: errorMessage,
      ...(errorCode ? { code: errorCode } : {}),
      eventType: "http",
    },
  });
}
