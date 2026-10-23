import type { ThreadSummary } from "../shared/ipc";
import type { OpenAIAccountQuota, OpenAIAccountQuotaWindow } from "../shared/openai-account";
import { CODEX_QUOTA_REFRESH_MS } from "../shared/codex-quota-refresh";

export { CODEX_QUOTA_REFRESH_MS } from "../shared/codex-quota-refresh";

export const CODEX_AUTH_RECENT_USE_MS = 30 * 60_000;

export function isCodexAuthThread(thread: ThreadSummary): boolean {
  if (thread.coreKind !== "codex") return false;
  const config = thread.runtimeConfig;
  const providerId =
    config?.mainAgentModelOverride?.providerId ??
    config?.resolvedOrchestrationSnapshot?.mainAgent.modelRef.providerId;
  return (
    providerId === "openai" ||
    (providerId === undefined && config?.orchestrationSelection?.mainAgentConfigId === "__openai_official__")
  );
}

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

export interface CodexQuotaReminderSnapshot {
  accountId: string;
  accountName: string;
  quota: OpenAIAccountQuota;
  switching: boolean;
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

/** One current-account request at a time; invalidated responses cannot cross account switches. */
export class CodexQuotaMonitor {
  private inFlight: Promise<void> | undefined;
  private generation = 0;
  private refreshAgain = false;
  private disposed = false;
  private activeSignature: string | undefined;
  private accountEventVersion = 0;
  private quotaRequestedAt = 0;
  private quotaAcceptedAt = 0;

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
    void this.refresh(true);
  }

  async accountsChanged(): Promise<void> {
    if (this.disposed || !this.options.enabled()) return;
    const version = ++this.accountEventVersion;
    try {
      const active = await this.eco.openAIAccountsGetActive();
      if (this.disposed || version !== this.accountEventVersion) return;
      const signature = activeAccountSignature(active);
      // queryQuota itself emits this event. Only identity/transition changes
      // invalidate a request, otherwise quota refresh would feed back forever.
      if (signature === this.activeSignature) {
        // Main-process reset refreshes publish a new cached snapshot. Read it
        // without querying again, including when our own quota read emits this event.
        if (this.inFlight || !active.activeAccountId || !active.isLoggedIn) return;
        const accounts = await this.eco.openAIAccountsList();
        const confirmed = await this.eco.openAIAccountsGetActive();
        if (this.disposed || version !== this.accountEventVersion || !this.options.enabled()) return;
        if (activeAccountSignature(confirmed) !== signature) {
          this.invalidate();
          return;
        }
        const account = accounts.find((entry) => entry.id === active.activeAccountId);
        const quota = account?.quota;
        // An old cache must not replace a failed request or a newer accepted result.
        if (!account || !quota || quota.fetchedAt <= Math.max(this.quotaRequestedAt, this.quotaAcceptedAt))
          return;
        this.quotaAcceptedAt = quota.fetchedAt;
        this.options.onChange({
          accountId: account.id,
          accountName: account.name,
          quota,
          switching: confirmed.pendingAccountId !== undefined,
        });
        return;
      }
      this.activeSignature = signature;
      this.invalidate();
    } catch (error) {
      if (!this.disposed && version === this.accountEventVersion) {
        this.options.onError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
  }

  refresh(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) {
      this.refreshAgain ||= force;
      return force ? this.inFlight.then(() => this.inFlight) : this.inFlight;
    }
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
        this.activeSignature = activeAccountSignature(active);
        if (active.syncStatus.state !== "ok") throw new Error(active.syncStatus.message || "账号同步失败");
        if (!active.activeAccountId || !active.isLoggedIn) {
          this.options.onChange(undefined);
          return;
        }
        const accountId = active.activeAccountId;
        this.quotaRequestedAt = Date.now();
        const [accounts, quota] = await Promise.all([
          this.eco.openAIAccountsList(),
          this.eco.openAIAccountsQueryQuota(accountId),
        ]);
        const confirmed = await this.eco.openAIAccountsGetActive();
        if (!current()) return;
        if (!this.options.enabled()) {
          this.options.onChange(undefined);
          return;
        }
        if (confirmed.activeAccountId !== accountId || !confirmed.isLoggedIn) {
          this.options.onChange(undefined);
          this.refreshAgain = true;
          return;
        }
        if (confirmed.syncStatus.state !== "ok")
          throw new Error(confirmed.syncStatus.message || "账号同步失败");
        const account = accounts.find((entry) => entry.id === accountId);
        if (!account) throw new Error("当前使用账号已从账号列表移除。");
        this.quotaAcceptedAt = quota.fetchedAt;
        this.options.onChange({
          accountId,
          accountName: account.name,
          quota,
          switching: confirmed.pendingAccountId !== undefined,
        });
      } catch (error) {
        if (current()) this.options.onError(error instanceof Error ? error.message : String(error));
      }
    })();
    this.inFlight = request;
    void request.finally(() => {
      this.inFlight = undefined;
      if (this.refreshAgain && !this.disposed) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    return request;
  }
}
