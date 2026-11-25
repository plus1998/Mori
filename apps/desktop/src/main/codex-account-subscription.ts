import type { OpenAIAccountSubscription } from "../shared/openai-account";

export async function readCodexAccountSubscription(
  request: (path: string, init: RequestInit) => Promise<Response>,
  accessToken: string,
  chatgptAccountId: string,
): Promise<OpenAIAccountSubscription> {
  const query = new URLSearchParams({ account_id: chatgptAccountId });
  const response = await request(`/backend-api/subscriptions?${query}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { status: "error", httpStatus: response.status };
  }
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) return { status: "error" };
  const { active_until: activeUntil, will_renew: willRenew } = data as Record<string, unknown>;
  if (activeUntil == null || activeUntil === "") return { status: "unavailable" };
  if (typeof activeUntil !== "string" || !Number.isFinite(Date.parse(activeUntil))) return { status: "error" };
  return {
    status: "available",
    activeUntil,
    ...(typeof willRenew === "boolean" ? { willRenew } : {}),
  };
}
