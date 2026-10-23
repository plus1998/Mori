import type { OpenAIAccountDetails, OpenAIAccountQuota } from "../shared/openai-account";

const RETRY_DELAY_MS = 60_000;

type QuotaAccount = Pick<OpenAIAccountDetails, "id" | "authJson" | "quota">;

/** A snapshot read after a window's reset already covers that reset. */
export function hasUnrefreshedCodexQuotaReset(quota: OpenAIAccountQuota, now: number): boolean {
  return [quota.rateLimit.primaryWindow, quota.rateLimit.secondaryWindow].some((window) => {
    if (!window || !Number.isFinite(window.resetAt) || window.resetAt <= 0) return false;
    const resetAt = window.resetAt * 1_000;
    return quota.fetchedAt < resetAt && resetAt <= now;
  });
}

/** Runs in the main process, including while account settings and conversation UI are closed. */
export class CodexQuotaResetRefresher {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retryAfter = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly queryQuota: (accountId: string) => Promise<OpenAIAccountQuota>,
    private readonly onError: (accountId: string, error: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {}

  refreshDueAccounts(accounts: readonly QuotaAccount[]): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const now = this.now();
    const accountIds = new Set(accounts.map((account) => account.id));
    for (const id of this.retryAfter.keys()) {
      if (!accountIds.has(id)) this.retryAfter.delete(id);
    }
    for (const account of accounts) {
      if (
        !account.authJson ||
        !account.quota ||
        !hasUnrefreshedCodexQuotaReset(account.quota, now) ||
        this.inFlight.has(account.id) ||
        (this.retryAfter.get(account.id) ?? 0) > now
      )
        continue;
      const work = Promise.resolve()
        .then(async () => {
          if (this.disposed) return;
          try {
            await this.queryQuota(account.id);
            this.retryAfter.delete(account.id);
          } catch (error) {
            this.retryAfter.set(account.id, this.now() + RETRY_DELAY_MS);
            this.onError(account.id, error);
          }
        })
        .finally(() => this.inFlight.delete(account.id));
      this.inFlight.set(account.id, work);
    }
    return Promise.all(this.inFlight.values()).then(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(this.inFlight.values());
    this.retryAfter.clear();
  }
}
