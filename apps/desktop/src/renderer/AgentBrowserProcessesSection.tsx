import { Cpu, Loader2, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AgentBrowserProcessView, isPersonalBrowserScopeId } from "../shared/browser";

export function AgentBrowserProcessesSection({
  threads,
  onCountChange,
}: {
  threads: readonly { id: string; title: string }[];
  onCountChange: (count: number) => void;
}) {
  const { t } = useTranslation();
  const [processes, setProcesses] = useState<AgentBrowserProcessView[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState<string>();
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    onCountChange(processes.length);
  }, [onCountChange, processes.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: stopping a process invalidates the snapshot.
  useEffect(() => {
    let cancelled = false;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        if (!window.eco) throw new Error("Desktop API unavailable");
        const snapshot = await window.eco.listAgentBrowserProcesses();
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
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [epoch]);

  const stop = async (resource: AgentBrowserProcessView) => {
    setStopping(resource.id);
    setError("");
    try {
      if (!window.eco) throw new Error("Desktop API unavailable");
      await window.eco.stopAgentBrowserProcess(resource.id);
      setEpoch((value) => value + 1);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setStopping(undefined);
    }
  };

  return (
    <section className="running-resources-section" aria-labelledby="running-resources-agent-processes-title">
      <h3 id="running-resources-agent-processes-title" className="running-resources-section-title">
        {t("app.running.agentProcesses")}
        <span className="running-resources-count">{processes.length}</span>
      </h3>
      {error ? (
        <p className="running-resources-error" role="alert">
          {t("app.running.loadFailed", { detail: error })}
        </p>
      ) : null}
      {loading ? <p className="running-resources-empty">{t("app.running.loading")}</p> : null}
      {!loading && !error && processes.length === 0 ? (
        <p className="running-resources-empty">{t("app.running.noAgentProcesses")}</p>
      ) : null}
      <ul className="running-resources-list" aria-label={t("app.running.agentProcesses")}>
        {processes.map((resource) => {
          const busy = stopping === resource.id || resource.state === "stopping";
          const owner =
            resource.threadId && isPersonalBrowserScopeId(resource.threadId)
              ? t("app.running.personal")
              : (threads.find((thread) => thread.id === resource.threadId)?.title ??
                resource.threadId ??
                t("app.running.previousSession"));
          return (
            <li key={resource.id} className="running-resources-row" aria-busy={busy}>
              <span className="running-resources-kind is-browser">
                <Cpu size={17} aria-hidden />
              </span>
              <div className="running-resources-item" title={`${owner}\n${resource.id}`}>
                <span className="running-resources-item-title">agent-browser</span>
                <span className="running-resources-meta">
                  <span className="running-resources-owner">{owner}</span>
                  <span className="running-resources-meta-divider" aria-hidden />
                  <span className="running-resources-endpoint">
                    PID {resource.pid} · {t(`app.running.agentProcess.${resource.state}`)}
                  </span>
                </span>
                {resource.error ? <span className="running-resources-error">{resource.error}</span> : null}
              </div>
              <button
                type="button"
                className="running-resources-icon-button is-destructive"
                disabled={Boolean(stopping) || busy}
                aria-label={t("app.running.stopAgentProcess", { pid: resource.pid })}
                title={t("app.running.stopAgentProcessHint")}
                onClick={() => void stop(resource)}
              >
                {busy ? (
                  <Loader2 size={14} className="is-spinning" aria-hidden />
                ) : (
                  <Square size={14} aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
