import type { GatewayUpstreamErrorInfo, ResolvedProviderRoute } from "../types.js";

/** Extract a short user-facing message from an upstream error body. */
export function extractUpstreamErrorMessage(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return "empty error body";
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (
      parsed.error &&
      typeof parsed.error === "object" &&
      typeof parsed.error.message === "string" &&
      parsed.error.message.trim()
    ) {
      return parsed.error.message.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // not JSON
  }
  return trimmed.length > 400 ? `${trimmed.slice(0, 397)}…` : trimmed;
}

/** Extract a machine-readable upstream error code when the body is JSON. */
export function extractUpstreamErrorCode(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" && parsed.error.code.trim()
      ? parsed.error.code.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Preserve the provider error envelope without copying request credentials. */
export function extractUpstreamErrorInfo(
  bodyText: string,
  eventType?: string,
): GatewayUpstreamErrorInfo | undefined {
  const message = extractUpstreamErrorMessage(bodyText);
  let rawEvent: unknown = bodyText;
  let code: string | undefined;
  let param: string | undefined;
  let type: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    rawEvent = parsed;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (error && typeof error === "object" && !Array.isArray(error)) {
        const errorRecord = error as Record<string, unknown>;
        code = readString(errorRecord.code);
        param = readString(errorRecord.param);
        type = readString(errorRecord.type);
      }
      code ??= readString(record.code);
      param ??= readString(record.param);
      type ??= readString(record.error_type);
    }
  } catch {
    // Plain-text errors are still useful evidence.
  }
  if (!message && !code && !param) {
    return undefined;
  }
  return {
    message,
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
    ...(type ? { type } : {}),
    ...(eventType ? { eventType } : {}),
    rawEvent,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Attribute upstream failures to provider/model/url so Eco UI does not look like an internal fault. */
export function formatUpstreamHttpError(input: {
  route: ResolvedProviderRoute;
  upstreamUrl: string;
  status: number;
  bodyText: string;
  errorOrigin?: string;
}): string {
  const detail = extractUpstreamErrorMessage(input.bodyText);
  return [
    input.errorOrigin === "eco.context_budget"
      ? `Eco context budget · provider=${input.route.provider.id}`
      : `Upstream provider ${input.route.provider.id}`,
    `model=${input.route.upstreamModelId}`,
    `url=${input.upstreamUrl}`,
    `status=${input.status}`,
    detail,
  ].join(" · ");
}

export function upstreamErrorResponse(input: {
  route: ResolvedProviderRoute;
  upstreamUrl: string;
  status: number;
  bodyText: string;
  errorOrigin?: string;
}): Response {
  const message = formatUpstreamHttpError(input);
  const errorInfo = extractUpstreamErrorInfo(input.bodyText);
  const errorCode = errorInfo?.code;
  const headers = new Headers({ "content-type": "application/json" });
  if (errorCode) headers.set("x-eco-upstream-error-code", errorCode);
  const origin = input.errorOrigin === "eco.context_budget" ? "eco.context_budget" : "upstream";
  headers.set("x-eco-error-origin", origin);
  return Response.json(
    {
      error: {
        message,
        origin,
        type: errorInfo?.type ?? "upstream_error",
        ...(errorCode ? { code: errorCode } : {}),
        ...(errorInfo?.param ? { param: errorInfo.param } : {}),
        providerId: input.route.provider.id,
        model: input.route.upstreamModelId,
        url: input.upstreamUrl,
        status: input.status,
      },
    },
    {
      status: input.status >= 400 && input.status < 600 ? input.status : 502,
      headers,
    },
  );
}
