import { z } from "zod";
import type { OpenAIAccountResetCredits } from "../shared/openai-account";

const resetCreditsResponse = z.object({
  available_count: z.number().int().nonnegative(),
  credits: z.array(z.object({
    id: z.string().min(1),
    reset_type: z.string(),
    status: z.string(),
    expires_at: z.string().nullish(),
  })),
});

export async function readCodexAccountResetCredits(
  request: (path: string, init: RequestInit) => Promise<Response>,
  accessToken: string,
  chatgptAccountId: string,
): Promise<OpenAIAccountResetCredits> {
  const response = await request("/backend-api/wham/rate-limit-reset-credits", {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": chatgptAccountId,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`重置卡查询失败（HTTP ${response.status}）`);
  }
  const data = resetCreditsResponse.safeParse(await response.json().catch(() => undefined));
  if (!data.success) throw new Error("重置卡响应格式无效。");
  const credits = data.data.credits
    .filter((credit) => credit.status === "available" && credit.reset_type === "codex_rate_limits")
    .map((credit) => {
      const expiresAt = credit.expires_at == null ? null : Date.parse(credit.expires_at) / 1_000;
      if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new Error("重置卡有效期无效。");
      return { id: credit.id, expiresAt };
    });
  return { availableCount: data.data.available_count, credits };
}
