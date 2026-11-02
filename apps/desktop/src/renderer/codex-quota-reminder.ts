import { canUseOpenAIAccountCredentials } from "../shared/openai-account";
import { isCodexAuthThread } from "../shared/codex-auth-thread";
import type { ThreadSummary } from "../shared/ipc";
import type { OpenAIAccountQuota, OpenAIAccountQuotaWindow, OpenAIAccountQuotaRefreshState } from "../shared/openai-account";

export { CODEX_QUOTA_REFRESH_MS } from "../shared/codex-quota-refresh";

/** Resolve the reset timestamp using the snapshot time for relative-only windows. */
export function codexQuotaResetAt(window: OpenAIAccountQuotaWindow, fetchedAt: number): number | undefined {
  if (window.resetAt > 0 && Number.isFinite(window.resetAt)) return window.resetAt * 1_000;
  if (window.resetAfterSeconds > 0 && Number.isFinite(window.resetAfterSeconds) && fetchedAt > 0 && Number.isFinite(fetchedAt)) {
    return fetchedAt + window.resetAfterSeconds * 1_000;
  }
  return undefined;
}

/** Identify the standard quota periods without rounding other durations into them. */
export function codexQuotaPeriod(seconds: number): "week" | "month" | "hours" | "unknown" {
  if (seconds === 7 * 24 * 3_600) return "week";
  if (seconds === 30 * 24 * 3_600) return "month";
  return seconds > 0 ? "hours" : "unknown";
}

export const CODEX_AUTH_RECENT_USE_MS = 30 * 60_000;

export { isCodexAuthThread } from "../shared/codex-auth-thread";

export function hasRecentCodexAuthUsage(threads: readonly ThreadSummary[], now = Date.now()): boolean {
  return threads.some((thread) => {
    if (!isCodexAuthThread(thread)) return false;
    return (
      thread.status === "running" ||
      thread.status === "queued" ||
      now - Date.parse(thread.updatedAt) <= CODEX_AUTH_RECENT_USE_MS
    );
  });
}

export function lowCodexQuotaWindows(quota: OpenAIAccountQuota): OpenAIAccountQuotaWindow[] {
  return [quota.rateLimit.primaryWindow, quota.rateLimit.secondaryWindow]
    .filter(
      (window): window is OpenAIAccountQuotaWindow =>
        window !== null &&
        Number.isFinite(window.usedPercent) &&
        window.usedPercent > 90 &&
        window.usedPercent <= 100,
    )
    .sort((a, b) => b.usedPercent - a.usedPercent);
}

/** Show the shortest quota period unless another period is fully exhausted. */
export function codexQuotaDisplayWindow(
  windows: readonly OpenAIAccountQuotaWindow[],
): OpenAIAccountQuotaWindow | undefined {
  let shortest: OpenAIAccountQuotaWindow | undefined;
  for (const window of windows) {
    if (window.usedPercent === 100) return window;
    if (!shortest || window.limitWindowSeconds < shortest.limitWindowSeconds) shortest = window;
  }
  return shortest;
}

export interface CodexQuotaReminderSnapshot {
  accountId: string;
  accountName: string;
  quota: OpenAIAccountQuota;
  refreshState?: OpenAIAccountQuotaRefreshState;
}

/**
 * Identity of a reminder: which account and which low windows caused it. Dismissing a reminder
 * only hides that exact situation, so a later window running low shows the reminder again.
 */
export function codexQuotaReminderKey(snapshot: CodexQuotaReminderSnapshot): string | undefined {
  const windows = lowCodexQuotaWindows(snapshot.quota);
  if (windows.length === 0) return undefined;
  return `${snapshot.accountId}:${windows
    .map((window) => `${window.limitWindowSeconds}:${window.resetAt}`)
    .sort()
    .join("/")}`;
}

/**
 * Whether the conversation the user is looking at draws on the Codex account.
 *
 * Falls back to recent Codex Auth usage while no thread is selected yet (a fresh draft), so the
 * reminder can still surface right after Codex usage.
 */
export function isCodexAuthConversation(threads: readonly ThreadSummary[], activeThreadId?: string): boolean {
  const active = activeThreadId ? threads.find((thread) => thread.id === activeThreadId) : undefined;
  return active ? isCodexAuthThread(active) : hasRecentCodexAuthUsage(threads);
}

type QuotaBridge = Pick<
  NonNullable<Window["eco"]>,
  "openAIAccountsList" | "openAIAccountsQueryQuota"
>;

/** Cache-only change notifications; opening details requests a read with the view cooldown. */
export class CodexQuotaMonitor {
  private inFlight: Promise<void> | undefined;
  private queryInFlight: "manual" | "view" | undefined;
  private readonly queuedQueries = new Map<"manual" | "view", Promise<void>>();
  private generation = 0;
  private refreshAgain = false;
  private disposed = false;

  constructor(
    private readonly eco: QuotaBridge,
    private readonly options: {
      enabled: () => boolean;
      accountId: () => string | undefined;
      onChange: (snapshot: CodexQuotaReminderSnapshot | undefined) => void;
      onError: (error: string) => void;
    },
  ) {}

  invalidate(): void {
    this.generation++;
    this.options.onChange(undefined);
    if (this.inFlight) this.refreshAgain = true;
    else void this.refresh();
  }

  accountsChanged(): Promise<void> {
    if (this.disposed || !this.options.enabled()) return Promise.resolve();
    if (this.inFlight) this.refreshAgain = true;
    return this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
  }

  refresh(mode: boolean | "view" = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const reason = mode === "view" ? "view" : mode ? "manual" : undefined;
    if (this.inFlight) {
      if (!reason || this.queryInFlight === "manual" || (reason === "view" && this.queryInFlight === "view"))
        return this.inFlight;
      // Opening during a cache read must still check freshness afterwards.
      let queued = this.queuedQueries.get(reason);
      if (!queued) {
        queued = this.inFlight.then(() => this.refresh(mode)).finally(() => { this.queuedQueries.delete(reason); });
        this.queuedQueries.set(reason, queued);
      }
      return queued;
    }
    const generation = this.generation;
    const current = () => !this.disposed && generation === this.generation;
    const request = (async () => {
      try {
        if (!this.options.enabled()) {
          if (current()) this.options.onChange(undefined);
          return;
        }
        const accountId = this.options.accountId();
        if (!accountId) { this.options.onChange(undefined); return; }
        if (reason) await this.eco.openAIAccountsQueryQuota(accountId, reason);
        const accounts = await this.eco.openAIAccountsList();
        if (!current()) return;
        if (!this.options.enabled() || this.options.accountId() !== accountId) {
          this.options.onChange(undefined);
          this.refreshAgain = true;
          return;
        }
        const account = accounts.find((entry) => entry.id === accountId);
        if (!account) throw new Error("此会话选定的账号已被移除，请重新选择模型账号。");
        if (!canUseOpenAIAccountCredentials(account)) throw new Error("此会话选定的账号需要重新登录。");
        const quota = account.quota;
        if (quota) {
          const snapshot: CodexQuotaReminderSnapshot = {
            accountId, accountName: account.name, quota,
            ...(account.quotaRefresh ? { refreshState: account.quotaRefresh } : {}),
          };
          this.options.onChange(snapshot);
        } else this.options.onChange(undefined);
        const error = account.quotaRefresh?.error;
        if (error) this.options.onError(error);
      } catch (error) {
        if (current()) this.options.onError(error instanceof Error ? error.message : String(error));
      }
    })();
    this.inFlight = request;
    this.queryInFlight = reason;
    void request.finally(() => {
      this.inFlight = undefined;
      this.queryInFlight = undefined;
      if (this.refreshAgain && !this.disposed) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    return request;
  }
}
