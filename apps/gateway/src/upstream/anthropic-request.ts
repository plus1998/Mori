/** Protocol/client metadata from the actual Anthropic caller, excluding credentials and local routing. */
export function pickAnthropicClientHeaders(clientHeaders: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of clientHeaders) {
    if (
      name === "accept" || name === "user-agent" || name === "x-app" ||
      name === "anthropic-version" || name === "anthropic-beta" ||
      name === "anthropic-dangerous-direct-browser-access" ||
      name === "anthropic-user-profile-id" || name === "anthropic-workspace-id" ||
      name.startsWith("x-stainless-") || name.startsWith("x-claude-code-")
    ) headers[name] = value;
  }
  return headers;
}

/** Preserve the SDK's beta API selection without copying unrelated local query parameters. */
export function withAnthropicBetaQuery(upstreamUrl: string, clientUrl?: string): string {
  if (!clientUrl || new URL(clientUrl).searchParams.get("beta") !== "true") return upstreamUrl;
  const url = new URL(upstreamUrl);
  url.searchParams.set("beta", "true");
  return url.toString();
}
