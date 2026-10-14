import type { PlanDelegationAgentOption } from "@eco/runtime/forced-plan-delegation";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileSearch,
  Loader2,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  UsersRound,
} from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadPendingPlan } from "../shared/ipc";
import { MAIN_SHELL_MEDIA_QUERIES } from "./activity-workspace-layout";
import { copyTextToClipboard } from "./clipboard";
import { MarkdownContent } from "./MarkdownContent";

interface PlanApprovalPanelProps {
  plan: ThreadPendingPlan;
  busy?: boolean | undefined;
  failureMessage?: string | undefined;
  variant?: "feed" | "dock";
  onApprove: () => void;
  /**
   * Approved with an explicit delegation target. Only rendered when the thread's locked
   * orchestration snapshot exposes at least one enabled, delegation-capable subagent.
   */
  onApproveWithSubagent?: ((agentKey: string, additionalMessage?: string) => void) | undefined;
  /** Starts a new landing composer prefilled with the current plan, without approving it. */
  onStartNewSession?: (() => void) | undefined;
  /** Confirms the plan was implemented and asks the current agent to review the code. */
  onReviewCode?: (() => void) | undefined;
  delegationAgents?: readonly PlanDelegationAgentOption[] | undefined;
  additionalMessage?: string | undefined;
  onAdditionalMessageChange?: ((value: string) => void) | undefined;
  onDismiss: () => void;
  onOpenInPanel?: () => void;
}

export function PlanApprovalPanel({
  plan,
  busy,
  failureMessage,
  variant = "feed",
  onApprove,
  onApproveWithSubagent,
  onStartNewSession,
  onReviewCode,
  delegationAgents,
  additionalMessage,
  onAdditionalMessageChange,
  onDismiss,
  onOpenInPanel,
}: PlanApprovalPanelProps) {
  const { t } = useTranslation();
  const planTrimmed = plan.plan.trim();
  const docked = variant === "dock";
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [executeMenuOpen, setExecuteMenuOpen] = useState(false);
  const [executeMenuView, setExecuteMenuView] = useState<"options" | "agents">("options");
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const textareaId = useId();

  const agents = delegationAgents ?? [];
  const executableAgents = agents.filter((agent) => agent.canExecutePlan);
  const canDelegate = executableAgents.length > 0 && Boolean(onApproveWithSubagent);
  const canOpenExecuteMenu = canDelegate || Boolean(onStartNewSession) || Boolean(onReviewCode);
  const executeMenuDisabled = Boolean(busy) || !planTrimmed;

  useEffect(() => {
    const mediaQuery = window.matchMedia(MAIN_SHELL_MEDIA_QUERIES.taskOverlay);
    const collapseOnWide = () => {
      if (!mediaQuery.matches) {
        setExpanded(false);
      }
    };
    collapseOnWide();
    mediaQuery.addEventListener("change", collapseOnWide);
    return () => mediaQuery.removeEventListener("change", collapseOnWide);
  }, []);

  // Close the menu when no execution option is available or the plan is unavailable.
  useEffect(() => {
    if (!canOpenExecuteMenu || executeMenuDisabled) {
      setExecuteMenuOpen(false);
    }
    if (!canDelegate) {
      setExecuteMenuView("options");
    }
  }, [canDelegate, canOpenExecuteMenu, executeMenuDisabled]);

  useEffect(() => {
    if (!executeMenuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (popoverRef.current?.contains(target) || toggleRef.current?.contains(target)) {
        return;
      }
      setExecuteMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [executeMenuOpen]);

  useEffect(() => {
    if (!executeMenuOpen) {
      return;
    }
    if (executeMenuView === "agents") {
      backRef.current?.focus();
    } else {
      firstOptionRef.current?.focus();
    }
  }, [executeMenuOpen, executeMenuView]);

  const closeExecuteMenu = () => {
    setExecuteMenuOpen(false);
    setExecuteMenuView("options");
    toggleRef.current?.focus();
  };

  const startNewSession = () => {
    if (executeMenuDisabled || !onStartNewSession) {
      return;
    }
    setExecuteMenuOpen(false);
    onStartNewSession();
  };

  const reviewCode = () => {
    if (executeMenuDisabled || !onReviewCode) {
      return;
    }
    closeExecuteMenu();
    onReviewCode();
  };

  const submitDelegation = (agent: PlanDelegationAgentOption) => {
    if (executeMenuDisabled || !agent.canExecutePlan) {
      return;
    }
    const note = additionalMessage?.trim();
    onApproveWithSubagent?.(agent.agentKey, note ? note : undefined);
    setExecuteMenuOpen(false);
  };

  const onPopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeExecuteMenu();
    }
  };

  const expandLabel = expanded ? t("approval.plan.collapse") : t("approval.plan.expand");
  const copyLabel = copied ? t("approval.plan.copied") : t("approval.plan.copy");

  const copyPlan = () => {
    if (!planTrimmed) {
      return;
    }
    void copyTextToClipboard(plan.plan).then((ok) => {
      if (!ok) {
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const body = (
    <>
      <header className="plan-approval-header">
        <h3 className={docked ? "plan-approval-dock-title" : undefined}>{t("approval.plan.title")}</h3>
        <div className="plan-approval-header-actions">
          <button
            type="button"
            className={`plan-approval-copy${copied ? " is-copied" : ""}`}
            onClick={copyPlan}
            disabled={!planTrimmed}
            title={copyLabel}
            aria-label={copyLabel}
          >
            {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
          </button>
          {docked ? (
            <button
              type="button"
              className="plan-approval-expand"
              onClick={() => setExpanded((current) => !current)}
              title={expandLabel}
              aria-label={expandLabel}
              aria-expanded={expanded}
            >
              {expanded ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
            </button>
          ) : null}
          {onOpenInPanel ? (
            <button
              type="button"
              className="plan-approval-open-panel"
              onClick={onOpenInPanel}
              title={t("approval.plan.open")}
              aria-label={t("approval.plan.open")}
            >
              <Maximize2 size={15} aria-hidden />
            </button>
          ) : null}
        </div>
      </header>
      {failureMessage ? (
        <div className="plan-approval-error" role="alert">
          <strong>{t("approval.plan.lastFailed")}</strong>
          <p>{failureMessage}</p>
        </div>
      ) : null}
      <div
        className={["plan-approval-markdown", docked ? "plan-approval-dock-markdown" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        <MarkdownContent text={plan.plan} />
      </div>
      <footer className={docked ? "bash-approval-footer plan-approval-dock-footer" : "plan-approval-actions"}>
        <button
          type="button"
          className={docked ? "bash-approval-dismiss" : "plan-button secondary"}
          onClick={onDismiss}
          disabled={busy}
        >
          {busy ? (
            <>
              <Loader2 size={14} className="spinning" aria-hidden />
              {t("common.processing")}
            </>
          ) : (
            t("common.dismiss")
          )}
        </button>
        <div className="plan-approval-execute-split">
          <button
            type="button"
            className={docked ? "bash-approval-submit" : "plan-button primary"}
            onClick={onApprove}
            disabled={busy || !planTrimmed}
          >
            {busy ? (
              <>
                <Loader2 size={14} className="spinning" aria-hidden />
                {t("common.processing")}
              </>
            ) : docked ? (
              <>
                {t("approval.plan.execute")} <kbd aria-hidden>↵</kbd>
              </>
            ) : (
              t("approval.plan.execute")
            )}
          </button>
          {canOpenExecuteMenu ? (
            <button
              ref={toggleRef}
              type="button"
              className={
                docked
                  ? "bash-approval-submit plan-approval-delegate-toggle"
                  : "plan-button primary plan-approval-delegate-toggle"
              }
              onClick={() => {
                setExecuteMenuView("options");
                setExecuteMenuOpen((current) => !current);
              }}
              disabled={executeMenuDisabled}
              aria-haspopup="dialog"
              aria-expanded={executeMenuOpen}
              aria-label={t("approval.plan.executeMenuAria")}
              title={t("approval.plan.executeMenuAria")}
            >
              <ChevronDown size={14} aria-hidden />
            </button>
          ) : null}
          {canOpenExecuteMenu && executeMenuOpen ? (
            <div
              ref={popoverRef}
              className="plan-approval-delegation-popover"
              role="dialog"
              aria-label={
                executeMenuView === "agents"
                  ? t("approval.plan.delegateTitle")
                  : t("approval.plan.executeMenuAria")
              }
              onKeyDown={onPopoverKeyDown}
            >
              {executeMenuView === "options" ? (
                <div className="plan-approval-menu-options">
                  {onStartNewSession ? (
                    <button
                      ref={firstOptionRef}
                      type="button"
                      className="plan-approval-menu-option"
                      onClick={startNewSession}
                      disabled={executeMenuDisabled}
                    >
                      <MessageCirclePlus size={16} aria-hidden />
                      <span>{t("approval.plan.executeInNewSession")}</span>
                    </button>
                  ) : null}
                  {onReviewCode ? (
                    <button
                      ref={!onStartNewSession ? firstOptionRef : undefined}
                      type="button"
                      className="plan-approval-menu-option"
                      onClick={reviewCode}
                      disabled={executeMenuDisabled}
                    >
                      <FileSearch size={16} aria-hidden />
                      <span>{t("approval.plan.reviewCode")}</span>
                    </button>
                  ) : null}
                  {canDelegate ? (
                    <button
                      ref={!onStartNewSession && !onReviewCode ? firstOptionRef : undefined}
                      type="button"
                      className="plan-approval-menu-option"
                      onClick={() => setExecuteMenuView("agents")}
                      disabled={executeMenuDisabled}
                    >
                      <UsersRound size={16} aria-hidden />
                      <span>{t("approval.plan.delegateTitle")}</span>
                      <ChevronRight size={15} aria-hidden />
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="plan-approval-menu-agents">
                  <button
                    ref={backRef}
                    type="button"
                    className="plan-approval-menu-back"
                    onClick={() => {
                      setExecuteMenuView("options");
                    }}
                    aria-label={t("approval.plan.backToOptions")}
                    title={t("approval.plan.backToOptions")}
                  >
                    <ArrowLeft size={16} aria-hidden />
                    <span>{t("approval.plan.delegateTitle")}</span>
                  </button>
                  <ul className="plan-approval-delegation-agents">
                    {agents.map((agent) => (
                      <li key={agent.agentKey}>
                        <button
                          type="button"
                          className={[
                            "plan-approval-delegation-agent",
                            agent.canExecutePlan ? "" : "is-read-only",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          onClick={() => submitDelegation(agent)}
                          disabled={executeMenuDisabled || !agent.canExecutePlan}
                          title={agent.canExecutePlan ? undefined : t("approval.plan.delegateReadOnly")}
                        >
                          <span className="plan-approval-delegation-agent-name">{agent.displayName}</span>
                          {agent.displayName !== agent.agentKey ? (
                            <span className="plan-approval-delegation-agent-key">{agent.agentKey}</span>
                          ) : null}
                          {agent.canExecutePlan ? null : (
                            <span className="plan-approval-delegation-agent-note">
                              {t("approval.plan.delegateReadOnly")}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <label className="plan-approval-delegation-message-label" htmlFor={textareaId}>
                    {t("approval.plan.delegateMessageLabel")}
                  </label>
                  <textarea
                    id={textareaId}
                    className="plan-approval-delegation-message"
                    value={additionalMessage ?? ""}
                    onChange={(event) => onAdditionalMessageChange?.(event.target.value)}
                    placeholder={t("approval.plan.delegateMessagePlaceholder")}
                    rows={2}
                    disabled={executeMenuDisabled}
                  />
                </div>
              )}
            </div>
          ) : null}
        </div>
      </footer>
    </>
  );

  if (docked) {
    return (
      <div
        className={["codex-composer", "is-compact", "plan-approval-dock-shell", expanded ? "is-expanded" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="composer-primary plan-approval-dock-inner">{body}</div>
      </div>
    );
  }

  return (
    <section className="plan-approval" aria-label={t("approval.plan.title")}>
      {body}
    </section>
  );
}
