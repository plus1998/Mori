import type { CodexQuotaResetOutcome } from "../shared/openai-account";

interface CodexQuotaClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** A retry must retain the same key: the reset credit may already have been spent. */
export async function consumeCodexQuotaReset(
  client: CodexQuotaClient,
  idempotencyKey: string,
): Promise<{ outcome: CodexQuotaResetOutcome }> {
  if (!idempotencyKey.trim()) throw new Error("额度重置缺少幂等键。");
  const result = await client.request<{ outcome?: unknown }>("account/rateLimitResetCredit/consume", {
    idempotencyKey,
  });
  const outcome = result?.outcome;
  if (
    outcome !== "reset" &&
    outcome !== "alreadyRedeemed" &&
    outcome !== "nothingToReset" &&
    outcome !== "noCredit"
  ) {
    throw new Error("Codex 返回了未知的额度重置结果。");
  }
  // Official protocol requires a fresh read; never infer the new windows locally.
  await client.request("account/rateLimits/read");
  return { outcome };
}
