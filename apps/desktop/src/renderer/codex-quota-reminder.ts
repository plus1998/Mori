import { isCodexAuthThread } from "../shared/codex-auth-thread";
import type { ThreadSummary } from "../shared/ipc";
import type { OpenAIAccountQuota, OpenAIAccountQuotaWindow, OpenAIAccountQuotaRefreshState } from "../shared/openai-account";
import { CODEX_QUOTA_REFRESH_MS, nextCodexQuotaResetCheckAt } from "../shared/codex-quota-refresh";

export { CODEX_QUOTA_REFRESH_MS } from "../shared/codex-quota-refresh";

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
  switching: boolean;
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
  "openAIAccountsGetActive" | "openAIAccountsList" | "openAIAccountsQueryQuota"
>;

/** syncStatus.updatedAt is rewritten by every credential reconcile; only its verdict matters here. */
function activeAccountSignature(active: Awaited<ReturnType<QuotaBridge["openAIAccountsGetActive"]>>): string {
  return JSON.stringify([
    active.activeAccountId,
    active.pendingAccountId === undefined ? "none" : active.pendingAccountId,
    active.isLoggedIn,
    active.syncStatus.state,
    active.syncStatus.message ?? "",
  ]);
}

/** Cache reads on UI events; upstream reads only on manual refresh or a due reset. */
export class CodexQuotaMonitor {
  private inFlight: Promise<void> | undefined;
  private manualInFlight = false;
  private queuedManual: Promise<void> | undefined;
  private generation = 0;
  private refreshAgain = false;
  private disposed = false;
  private activeSignature: string | undefined;
  private resetTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly resetChecks = new Map<string, { at: number; error?: string }>();

  constructor(
    private readonly eco: QuotaBridge,
    private readonly options: {
      enabled: () => boolean;
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
    if (this.resetTimer) clearTimeout(this.resetTimer);
  }

  private scheduleReset(snapshot: CodexQuotaReminderSnapshot): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = undefined;
    if (snapshot.switching || (typeof document !== "undefined" && document.hidden)) return;
    const resetAt = nextCodexQuotaResetCheckAt(snapshot.quota, snapshot.refreshState);
    if (resetAt === undefined) return;
    const dueAt = Math.max(resetAt, (this.resetChecks.get(snapshot.accountId)?.at ?? 0) + CODEX_QUOTA_REFRESH_MS);
    // Re-evaluate distant resets before the platform timeout limit (about 24 days).
    const delay = Math.min(2_147_483_647, Math.max(0, dueAt - Date.now()));
    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined;
      if (this.disposed || !this.options.enabled() || (typeof document !== "undefined" && document.hidden)) return;
      void (async () => {
        try {
          const active = await this.eco.openAIAccountsGetActive();
          if (this.disposed || !this.options.enabled() || active.activeAccountId !== snapshot.accountId ||
            !active.isLoggedIn || active.pendingAccountId !== undefined || active.syncStatus.state !== "ok") return;
          if (Date.now() >= dueAt) {
            this.resetChecks.set(snapshot.accountId, { at: Date.now() });
            await this.eco.openAIAccountsQueryQuota(snapshot.accountId, "reset");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.resetChecks.set(snapshot.accountId, { at: Date.now(), error: message });
          if (!this.disposed) this.options.onError(message);
        } finally {
          if (!this.disposed) await this.refresh();
        }
      })();
    }, delay);
    this.resetTimer.unref?.();
  }

  refresh(manual = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) {
      // A user request waits for a cache read, then still performs its explicit refresh.
      if (!manual || this.manualInFlight) return this.inFlight;
      if (!this.queuedManual) {
        this.queuedManual = this.inFlight.then(() => this.refresh(true)).finally(() => { this.queuedManual = undefined; });
      }
      return this.queuedManual;
    }
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = undefined;
    const generation = this.generation;
    const current = () => !this.disposed && generation === this.generation;
    const request = (async () => {
      try {
        if (!this.options.enabled()) {
          if (current()) this.options.onChange(undefined);
          return;
        }
        const active = await this.eco.openAIAccountsGetActive();
        if (!current()) return;
        const signature = activeAccountSignature(active);
        if (this.activeSignature !== undefined && this.activeSignature !== signature) this.options.onChange(undefined);
        this.activeSignature = signature;
        if (!active.activeAccountId || !active.isLoggedIn) {
          this.options.onChange(undefined);
          return;
        }
        const accountId = active.activeAccountId;
        if (manual) await this.eco.openAIAccountsQueryQuota(accountId, "manual");
        const accounts = await this.eco.openAIAccountsList();
        const confirmed = await this.eco.openAIAccountsGetActive();
        if (!current()) return;
        if (!this.options.enabled()) { this.options.onChange(undefined); return; }
        if (activeAccountSignature(confirmed) !== signature) {
          this.options.onChange(undefined);
          this.refreshAgain = true;
          return;
        }
        const account = accounts.find((entry) => entry.id === accountId);
        if (!account) throw new Error("当前使用账号已从账号列表移除。");
        const quota = account.quota;
        if (quota) {
          const snapshot: CodexQuotaReminderSnapshot = {
            accountId, accountName: account.name, quota,
            switching: confirmed.pendingAccountId !== undefined,
            ...(account.quotaRefresh ? { refreshState: account.quotaRefresh } : {}),
          };
          this.options.onChange(snapshot);
          this.scheduleReset(snapshot);
        } else this.options.onChange(undefined);
        const resetCheck = this.resetChecks.get(accountId);
        if (quota && resetCheck && quota.fetchedAt >= resetCheck.at) this.resetChecks.delete(accountId);
        const error = account.quotaRefresh?.error ?? this.resetChecks.get(accountId)?.error ??
          (confirmed.syncStatus.state !== "ok" ? confirmed.syncStatus.message || "账号同步失败" : undefined);
        if (error) this.options.onError(error);
      } catch (error) {
        if (current()) this.options.onError(error instanceof Error ? error.message : String(error));
      }
    })();
    this.inFlight = request;
    this.manualInFlight = manual;
    void request.finally(() => {
      this.inFlight = undefined;
      this.manualInFlight = false;
      if (this.refreshAgain && !this.disposed) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    return request;
  }
}
