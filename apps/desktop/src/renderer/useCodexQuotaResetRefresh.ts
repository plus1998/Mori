import { useEffect, useRef } from "react";
import { canUseOpenAIAccountCredentials, type OpenAIAccount } from "../shared/openai-account";
import { CODEX_QUOTA_REFRESH_MS, nextCodexQuotaResetCheckAt, nextImageQuotaResetCheckAt } from "../shared/codex-quota-refresh";

/** Visible account lists only watch known reset times; ordinary UI loads stay cache-only. */
export function useCodexQuotaResetRefresh(
  accounts: readonly OpenAIAccount[],
  eco: Pick<NonNullable<Window["eco"]>, "openAIAccountsQueryQuota" | "openAIAccountsQueryImageQuota"> | undefined,
  reload: () => Promise<void>,
  onError: (message: string) => void,
): void {
  const lastChecks = useRef(new Map<string, number>());
  const lastImageChecks = useRef(new Map<string, number>());
  useEffect(() => {
    if (!eco) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (disposed || document.hidden) return;
      const due = accounts.flatMap((account) => {
        const at =
          canUseOpenAIAccountCredentials(account) && account.quota
            ? nextCodexQuotaResetCheckAt(account.quota, account.quotaRefresh)
            : undefined;
        const imageAt = canUseOpenAIAccountCredentials(account) && account.imageGenerationEnabled
          ? nextImageQuotaResetCheckAt(account.imageQuota)
          : undefined;
        return [
          ...(at === undefined ? [] : [{
            id: account.id,
            kind: "text" as const,
            at: Math.max(at, (lastChecks.current.get(account.id) ?? 0) + CODEX_QUOTA_REFRESH_MS),
          }]),
          ...(imageAt === undefined ? [] : [{
            id: account.id,
            kind: "image" as const,
            at: Math.max(imageAt, (lastImageChecks.current.get(account.id) ?? 0) + CODEX_QUOTA_REFRESH_MS),
          }]),
        ];
      });
      if (!due.length) return;
      const at = Math.min(...due.map((entry) => entry.at));
      timer = setTimeout(
        () => {
          if (disposed || document.hidden) return;
          void (async () => {
            // Each failure is recorded by the main process and displayed with the cached quota.
            const ready = due.filter((entry) => entry.at <= Date.now());
            if (!ready.length) {
              schedule();
              return;
            }
            const results = await Promise.allSettled(
              ready.map((entry) => {
                if (entry.kind === "image") {
                  lastImageChecks.current.set(entry.id, Date.now());
                  return eco.openAIAccountsQueryImageQuota(entry.id);
                }
                lastChecks.current.set(entry.id, Date.now());
                return eco.openAIAccountsQueryQuota(entry.id, "reset");
              }),
            );
            if (disposed) return;
            for (const result of results) {
              if (result.status === "rejected")
                onError(result.reason instanceof Error ? result.reason.message : String(result.reason));
            }
            await reload();
          })();
        },
        Math.min(2_147_483_647, Math.max(0, at - Date.now())),
      );
    };
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [accounts, eco, reload, onError]);
}
