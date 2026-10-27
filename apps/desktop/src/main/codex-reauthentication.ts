/** Only explicit permanent refresh failures mean the user must authorize again. */
export function isCodexReauthenticationRequired(error: unknown): boolean {
  const inspect = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") {
      return (
        /\b(?:invalid_grant|refresh_token_expired|refresh_token_reused|refresh_token_invalidated)\b/iu.test(
          value,
        ) ||
        /Your access token could not be refreshed\.\s+Please log out and sign in again\./u.test(value) ||
        /Your access token could not be refreshed because your refresh token (?:has expired|was already used|was revoked)\./u.test(
          value,
        )
      );
    }
    if (!value || typeof value !== "object" || depth >= 3) return false;
    const details = value as Record<string, unknown>;
    // Codex RPC errors may put the OAuth code in data rather than the message.
    return [details.message, details.code, details.data, details.error].some((part) =>
      inspect(part, depth + 1),
    );
  };
  return inspect(error, 0);
}
