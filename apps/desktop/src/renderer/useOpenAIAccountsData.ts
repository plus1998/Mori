import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenAIAccount } from "../shared/openai-account";

export interface OpenAIAccountsData {
  /** Undefined until the first successful local database read. */
  accounts: OpenAIAccount[] | undefined;
  error: string | undefined;
  refresh: () => Promise<void>;
}

/** Own this at the settings-page level so tab changes retain the last snapshot. */
export function useOpenAIAccountsData(enabled = true): OpenAIAccountsData {
  const eco = window.eco;
  const [accounts, setAccounts] = useState<OpenAIAccount[]>();
  const [error, setError] = useState<string>();
  const requestId = useRef(0);
  const active = useRef(false);

  const refresh = useCallback(async () => {
    if (!active.current || !eco) return;
    const id = ++requestId.current;
    setError(undefined);
    try {
      const list = await eco.openAIAccountsList();
      if (active.current && id === requestId.current) setAccounts(list);
    } catch (cause) {
      if (active.current && id === requestId.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [eco]);

  useEffect(() => {
    if (!enabled || !eco) return;
    active.current = true;
    const unsubscribe = eco.onOpenAIAccountsChanged(() => { void refresh(); });
    void refresh();
    return () => {
      active.current = false;
      requestId.current += 1;
      unsubscribe();
    };
  }, [enabled, eco, refresh]);

  return { accounts, error, refresh };
}
