import { ArrowUpRight, FileText, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PLAN_EXECUTION_CHANGED, type PlanExecutionLink } from "../shared/plan-execution";

export function PlanExecutionLinks({
  threadId,
  onNavigate,
}: {
  threadId: string;
  onNavigate(threadId: string): void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ threadId: string; links: PlanExecutionLink[]; error?: string }>({
    threadId,
    links: [],
  });
  useEffect(() => {
    const api = window.eco;
    if (!api) return;
    let disposed = false;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void api
        .listPlanExecutions(threadId)
        .then((links) => {
          if (!disposed && request === revision) setState({ threadId, links });
        })
        .catch((error: unknown) => {
          if (!disposed && request === revision)
            setState((current) => ({
              threadId,
              links: current.threadId === threadId ? current.links : [],
              error: String(error),
            }));
        });
    };
    const unsubscribe = api.onThreadEvent((event) => {
      if (
        event &&
        typeof event === "object" &&
        "threadId" in event &&
        "type" in event &&
        event.threadId === threadId &&
        event.type === PLAN_EXECUTION_CHANGED
      )
        refresh();
    });
    refresh();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [threadId]);
  if (state.threadId !== threadId || (!state.links.length && !state.error)) return null;
  return (
    <section className="plan-execution-links" aria-label={t("planExecution.links")}>
      {state.links.map((link) => {
        const isSource = link.sourceThreadId === threadId;
        const targetId = isSource ? link.executionThreadId : link.sourceThreadId;
        const deleted = isSource ? link.executionDeleted : link.sourceDeleted;
        const title = isSource ? link.executionTitle : link.sourceTitle;
        return (
          <div key={link.id} className="plan-execution-link" data-status={link.status}>
            <FileText size={16} aria-hidden />
            <div className="plan-execution-link-content">
              <span className="plan-execution-link-heading">
                {t(isSource ? "planExecution.executionConversation" : "planExecution.sourcePlan", {
                  version: link.version,
                })}
                <span className="plan-execution-status" role="status">
                  {link.status === "running" || link.status === "queued" ? (
                    <LoaderCircle size={12} className="is-spinning" aria-hidden />
                  ) : null}
                  {t(`planExecution.status.${link.status}`)}
                </span>
              </span>
              <span className="plan-execution-link-title" title={link.planTitle}>
                {link.planTitle}
              </span>
              {link.message ? <span className="plan-execution-link-message">{link.message}</span> : null}
            </div>
            <button
              type="button"
              className="plan-execution-open"
              disabled={deleted}
              title={title}
              onClick={() => onNavigate(targetId)}
            >
              <span>{deleted ? t("planExecution.deleted") : title}</span>
              <ArrowUpRight size={14} aria-hidden />
            </button>
          </div>
        );
      })}
      {state.error ? (
        <p className="plan-execution-link-error" role="alert">
          {t("planExecution.loadFailed", { detail: state.error })}
        </p>
      ) : null}
    </section>
  );
}
