import { ChevronRight, Cpu, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodexAppServerProcessView } from "../shared/ipc";
import { startResourcePanelPolling } from "./resource-panel-polling";

export function CodexAppServerProcessesSection({
  onCountChange,
}: {
  onCountChange: (count: number) => void;
}) {
  const { t } = useTranslation();
  const [processes, setProcesses] = useState<CodexAppServerProcessView[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    onCountChange(processes.length);
  }, [onCountChange, processes.length]);

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
  }, []);

  return (
    <section className="running-resources-section running-resources-codex-section">
      <details className="running-resources-details">
        <summary className="running-resources-section-title" aria-label={t("app.running.codexAppServers")}>
          <ChevronRight className="running-resources-disclosure-icon" size={13} aria-hidden />
          <Cpu size={14} aria-hidden />
          {t("app.running.codexAppServers")}
          <span className="running-resources-count">{processes.length}</span>
        </summary>
        {error ? (
          <p className="running-resources-error" role="alert">
            {t("app.running.loadFailed", { detail: error })}
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
            const accountDisplay = account?.status === "binding"
              ? `${t("app.running.codexAccountBinding")} · ${accountLabel}`
              : accountLabel;
            const proxyLabel = process.proxy.mode === "system"
              ? t("app.running.codexProxySystem")
              : t("app.running.codexProxyManual");
            return (
              <li key={process.pid} className="running-resources-row">
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
                    <span className="running-resources-owner">{t("app.running.codexAppServerRunning")}</span>
                  </span>
                  {account ? (
                    <span className="running-resources-process-detail" title={`${accountDisplay}\n${account.id}`}>
                      {t("app.running.codexProcessAccount", { account: accountDisplay })}
                    </span>
                  ) : null}
                  {process.proxy.endpoint ? (
                    <>
                      <span className="running-resources-process-detail is-proxy" title={`${proxyLabel} · ${process.proxy.endpoint}`}>
                        {t("app.running.codexProcessProxy", { proxy: proxyLabel })} · {process.proxy.endpoint}
                      </span>
                      {process.proxy.bridgeEndpoint ? (
                        <span className="running-resources-process-detail is-proxy" title={process.proxy.bridgeEndpoint}>
                          {t("app.running.codexProxyBridge", { endpoint: process.proxy.bridgeEndpoint })}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
