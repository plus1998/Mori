import type { ThreadSummary } from "../shared/ipc";
import type { OpenAIAccountQuota, OpenAIAccountQuotaWindow } from "../shared/openai-account";

export const CODEX_QUOTA_REFRESH_MS = 2 * 60_000;
export const CODEX_AUTH_RECENT_USE_MS = 30 * 60_000;

export function hasRecentCodexAuthUsage(threads: readonly ThreadSummary[], now = Date.now()): boolean {
  return threads.some((thread) => {
    if (thread.coreKind !== "codex") return false;
    const config = thread.runtimeConfig;
    const providerId =
      config?.mainAgentModelOverride?.providerId ??
      config?.resolvedOrchestrationSnapshot?.mainAgent.modelRef.providerId;
    if (
      providerId !== "openai" &&
      !(
        providerId === undefined &&
        config?.orchestrationSelection?.mainAgentConfigId === "__openai_official__"
      )
    )
      return false;
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

type QuotaBridge = Pick<
  NonNullable<Window["eco"]>,
  "openAIAccountsGetActive" | "openAIAccountsList" | "openAIAccountsQueryQuota"
>;

function activeAccountSignature(active: Awaited<ReturnType<QuotaBridge["openAIAccountsGetActive"]>>): string {
  return JSON.stringify([
    active.activeAccountId,
    active.pendingAccountId === undefined ? "none" : active.pendingAccountId,
    active.isLoggedIn,
    active.syncStatus,
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
      if (signature === this.activeSignature) return;
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
