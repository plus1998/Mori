import { useEffect, useRef } from "react";
import { canUseOpenAIAccountCredentials, type OpenAIAccount } from "../shared/openai-account";
import { nextImageQuotaResetCheckAt } from "../shared/codex-quota-refresh";

const IMAGE_RESET_CHECK_COOLDOWN_MS = 2 * 60_000;

/** Image balances have their own reset watcher; Codex quotas update on native/view events. */
export function useImageQuotaResetRefresh(
  accounts: readonly OpenAIAccount[],
  eco: Pick<NonNullable<Window["eco"]>, "openAIAccountsQueryImageQuota"> | undefined,
  reload: () => Promise<void>,
  onError: (message: string) => void,
): void {
  const lastImageChecks = useRef(new Map<string, number>());
  useEffect(() => {
    if (!eco) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (disposed || document.hidden) return;
      const due = accounts.flatMap((account) => {
        const imageAt = canUseOpenAIAccountCredentials(account) && account.imageGenerationEnabled
          ? nextImageQuotaResetCheckAt(account.imageQuota)
          : undefined;
        return [
          ...(imageAt === undefined ? [] : [{
            id: account.id,
            at: Math.max(imageAt, (lastImageChecks.current.get(account.id) ?? 0) + IMAGE_RESET_CHECK_COOLDOWN_MS),
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
                lastImageChecks.current.set(entry.id, Date.now());
                return eco.openAIAccountsQueryImageQuota(entry.id);
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
