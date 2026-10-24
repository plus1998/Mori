import type { OpenAIAccount } from "../shared/openai-account";

export function hasAvailableCodexQuota(account: OpenAIAccount): boolean {
  if (!account.isLoggedIn || account.authState !== "configured" || !account.quota) return false;
  const { rateLimit } = account.quota;
  const windows = [rateLimit.primaryWindow, rateLimit.secondaryWindow].filter((window) => window !== null);
  return (
    rateLimit.allowed &&
    !rateLimit.limitReached &&
    windows.length > 0 &&
    windows.every(
      (window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent < 100,
    )
  );
}

type AccountSwitchBridge = Pick<
  NonNullable<Window["eco"]>,
  "openAIAccountsList" | "openAIAccountsGetActive" | "openAIAccountsQueryQuota"
>;

/** Opening uses saved quotas; only an explicit refresh queries the accounts. */
export async function loadCodexSwitchAccounts(eco: AccountSwitchBridge, refreshQuota = false): Promise<{
  accounts: OpenAIAccount[];
  failedCount: number;
}> {
  const [accounts, active] = await Promise.all([eco.openAIAccountsList(), eco.openAIAccountsGetActive()]);
  const candidates = accounts.filter(
    (account) =>
      account.id !== active.activeAccountId && account.isLoggedIn && account.authState === "configured",
  );
  if (!refreshQuota) return { accounts: candidates, failedCount: 0 };
  const results = await Promise.allSettled(
    candidates.map(async ({ quotaRefresh: _previousRefresh, ...account }) => ({
      ...account,
      quota: await eco.openAIAccountsQueryQuota(account.id),
    })),
  );
  return {
    accounts: results.map((result, index) =>
      result.status === "fulfilled" ? result.value : candidates[index]!,
    ),
    failedCount: results.filter((result) => result.status === "rejected").length,
  };
}
