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
