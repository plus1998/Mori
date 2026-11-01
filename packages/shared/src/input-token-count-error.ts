/** A missing counting capability, distinct from auth, transport and malformed-response errors. */
export class InputTokenCountUnsupportedError extends Error {
  readonly code = "input_token_count_unsupported";

  constructor(message: string) {
    super(message);
    this.name = "InputTokenCountUnsupportedError";
  }
}

export function isInputTokenCountUnsupportedError(error: unknown): error is InputTokenCountUnsupportedError {
  return error instanceof Error && "code" in error && error.code === "input_token_count_unsupported";
}

/** An actual upstream HTTP failure, not a missing counting capability or invalid local input. */
export class InputTokenCountUpstreamError extends Error {
  readonly code = "input_token_count_upstream_error";
  readonly responseHeaders: Record<string, string> = {};

  constructor(
    readonly statusCode: number,
    readonly responseBody: string,
    headers?: Headers,
  ) {
    super(`token count 上游请求失败：HTTP ${statusCode}${responseBody.trim() ? `；${responseBody.trim()}` : ""}`);
    this.name = "InputTokenCountUpstreamError";
    // Retain retry timing and request attribution without forwarding cookies or credentials.
    for (const key of ["retry-after", "retry-after-ms", "request-id", "x-request-id"]) {
      const value = headers?.get(key);
      if (value) this.responseHeaders[key] = value;
    }
  }
}

export function isInputTokenCountUpstreamError(error: unknown): error is InputTokenCountUpstreamError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "input_token_count_upstream_error" &&
    "statusCode" in error &&
    Number.isInteger(error.statusCode) &&
    Number(error.statusCode) >= 400 &&
    Number(error.statusCode) <= 599
  );
}

/** Both SDK count requests and generation preflight preserve the same HTTP semantics. */
export function inputTokenCountUpstreamErrorResponse(error: InputTokenCountUpstreamError): Response {
  return Response.json(
    {
      error: {
        message: error.message,
        type: "input_token_count_error",
        code: error.code,
        origin: "upstream",
        status: error.statusCode,
      },
    },
    {
      status: error.statusCode,
      headers: { ...error.responseHeaders, "x-eco-error-origin": "upstream" },
    },
  );
}
