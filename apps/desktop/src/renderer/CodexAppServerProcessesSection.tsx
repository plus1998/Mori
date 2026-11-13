import { ChevronRight, Cpu, Loader2, Power } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CODEX_APP_SERVER_IDLE_TIMEOUT_MS, type CodexAppServerProcessView } from "../shared/ipc";
import { startResourcePanelPolling } from "./resource-panel-polling";

export function CodexAppServerProcessesSection({
  onCountChange,
}: {
  onCountChange: (count: number) => void;
}) {
  const { t } = useTranslation();
  const [processes, setProcesses] = useState<CodexAppServerProcessView[]>([]);
  const [error, setError] = useState("");
  const [stopError, setStopError] = useState("");
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState<number>();
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    onCountChange(processes.length);
  }, [onCountChange, processes.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: exiting a process invalidates the snapshot.
  useEffect(() => {
    let cancelled = false;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        if (!window.eco) throw new Error("Desktop API unavailable");
        const snapshot = await window.eco.listCodexAppServerProcesses();
        if (!cancelled) {
          setProcesses(snapshot);
          setError("");
        }
      } catch (reason) {
        if (!cancelled) setError(String(reason));
      } finally {
        fetching = false;
        if (!cancelled) setLoading(false);
      }
    };
    const stopPolling = startResourcePanelPolling(refresh, 2000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [epoch]);

  const stop = async (pid: number) => {
    setStopping(pid);
    setStopError("");
    try {
      if (!window.eco) throw new Error("Desktop API unavailable");
      await window.eco.stopCodexAppServerProcess(pid);
      setProcesses((current) => current.filter((process) => process.pid !== pid));
      setEpoch((value) => value + 1);
    } catch (reason) {
      setStopError(String(reason));
    } finally {
      setStopping(undefined);
    }
  };

  return (
    <section className="running-resources-section running-resources-codex-section">
      <details className="running-resources-details">
        <summary className="running-resources-section-title" aria-label={t("app.running.codexAppServers")}>
          <ChevronRight className="running-resources-disclosure-icon" size={13} aria-hidden />
          <Cpu size={14} aria-hidden />
          {t("app.running.codexAppServers")}
          <span className="running-resources-count">{processes.length}</span>
        </summary>
        <p className="running-resources-empty">
          {t("app.running.codexIdleReleaseHint", { minutes: CODEX_APP_SERVER_IDLE_TIMEOUT_MS / 60_000 })}
        </p>
        {error ? (
          <p className="running-resources-error" role="alert">
            {t("app.running.loadFailed", { detail: error })}
          </p>
        ) : null}
        {stopError ? (
          <p className="running-resources-error" role="alert">
            {stopError}
          </p>
        ) : null}
        {loading ? (
          <p className="running-resources-empty" role="status">
            <Loader2 size={15} className="is-spinning" aria-hidden />
            {t("app.running.loading")}
          </p>
        ) : null}
        {!loading && !error && processes.length === 0 ? (
          <p className="running-resources-empty">{t("app.running.noCodexAppServers")}</p>
        ) : null}
        <ul className="running-resources-list" aria-label={t("app.running.codexAppServers")}>
          {processes.map((process) => {
            const account = process.account;
            const accountLabel = account
              ? [account.name ?? account.id, account.email].filter(Boolean).join(" · ")
              : "";
            const accountDisplay =
              account?.status === "binding"
                ? `${t("app.running.codexAccountBinding")} · ${accountLabel}`
                : accountLabel;
            const proxyLabel =
              process.proxy.mode === "system"
                ? t("app.running.codexProxySystem")
                : t("app.running.codexProxyManual");
            return (
              <li key={process.pid} className="running-resources-row" aria-busy={stopping === process.pid}>
                <span className="running-resources-kind is-codex">
                  <Cpu size={17} aria-hidden />
                  <span className="running-resources-live-dot" />
                </span>
                <div className="running-resources-item" title={`PID ${process.pid}`}>
                  <span className="running-resources-item-title">codex app-server</span>
                  <span className="running-resources-meta">
                    <span className="running-resources-endpoint">
                      {t("app.running.codexAppServerPid", { pid: process.pid })}
                    </span>
                    <span className="running-resources-meta-divider" aria-hidden />
                    <span className="running-resources-owner">
                      {t(
                        process.busy ? "app.running.codexAppServerBusy" : "app.running.codexAppServerRunning",
                      )}
                    </span>
                  </span>
                  {account ? (
                    <span
                      className="running-resources-process-detail"
                      title={`${accountDisplay}\n${account.id}`}
                    >
                      {t("app.running.codexProcessAccount", { account: accountDisplay })}
                    </span>
                  ) : null}
                  {process.proxy.endpoint ? (
                    <>
                      <span
                        className="running-resources-process-detail is-proxy"
                        title={`${proxyLabel} · ${process.proxy.endpoint}`}
                      >
                        {t("app.running.codexProcessProxy", { proxy: proxyLabel })} · {process.proxy.endpoint}
                      </span>
                      {process.proxy.bridgeEndpoint ? (
                        <span
                          className="running-resources-process-detail is-proxy"
                          title={process.proxy.bridgeEndpoint}
                        >
                          {t("app.running.codexProxyBridge", { endpoint: process.proxy.bridgeEndpoint })}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="running-resources-icon-button running-resources-exit-button is-destructive"
                  disabled={stopping !== undefined || process.busy}
                  aria-label={t("app.running.stopCodexProcess", { pid: process.pid })}
                  title={t(
                    process.busy ? "app.running.codexProcessBusyHint" : "app.running.stopCodexProcessHint",
                  )}
                  onClick={() => void stop(process.pid)}
                >
                  {stopping === process.pid ? (
                    <Loader2 size={14} className="is-spinning" aria-hidden />
                  ) : (
                    <Power size={14} aria-hidden />
                  )}
                  <span>{t("app.running.exitProcess")}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
