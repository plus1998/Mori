import { AlertTriangle, Loader2, Pencil, Shield, ShieldAlert, ShieldCheck, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type BashApprovalChoice,
  bashApprovalInitialChoiceIndex,
  buildBashApprovalChoices,
  canSubmitBashApprovalWithEnter,
  formatBashApprovalRememberPrefix,
} from "../shared/bash-approval-ui";
import type { BashApprovalDecision, BashApprovalRequest } from "../shared/ipc";
import { presentMcpApproval } from "../shared/mcp-approval-presentation";
import { ExpandablePreBlock } from "./ExpandablePreBlock";

export interface BashApprovalResolutionInput {
  decision: BashApprovalDecision;
  feedback?: string;
}

interface BashApprovalPanelProps {
  request: BashApprovalRequest;
  busy?: boolean;
  variant?: "feed" | "dock";
  onResolve: (resolution: BashApprovalResolutionInput) => void;
  onSkip: () => void;
}

interface BashApprovalOption {
  choice: BashApprovalChoice;
}

const CIRCLED_OPTION_MARKERS = ["①", "②", "③", "④", "⑤"] as const;

// The reviewer hardcodes these Chinese prefixes onto rationale when the
// approval *request itself* fails (transport error, invalid JSON, model
// unavailable). A genuine risk-control rejection rationale is written in the
// user's locale and never contains them, so they reliably distinguish
// "couldn't review" from "reviewed and declined" — regardless of locale.
const REVIEW_REQUEST_ERROR_MARKERS = [
  "审批模型审批失败",
  "审批模型不可用",
  "辅助模型审批失败",
  "辅助模型不可用",
  "审批失败或返回了无效 JSON",
];

function isReviewRequestError(rationale: string): boolean {
  return REVIEW_REQUEST_ERROR_MARKERS.some((marker) => rationale.includes(marker));
}

export function BashApprovalPanel({
  request,
  busy,
  variant = "dock",
  onResolve,
  onSkip,
}: BashApprovalPanelProps) {
  const { t } = useTranslation();
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [denyFeedback, setDenyFeedback] = useState("");
  const denyInputRef = useRef<HTMLInputElement>(null);
  const rememberCommand = request.command.trim();
  const rememberCommandPreview = formatBashApprovalRememberPrefix(rememberCommand);
  const options = useMemo<BashApprovalOption[]>(
    () =>
      buildBashApprovalChoices({
        ...(request.suppressAlwaysAllowRule !== undefined && {
          suppressAlwaysAllowRule: request.suppressAlwaysAllowRule,
        }),
        includeRememberPrefix: !request.filesystemTool && request.kind !== "image_generation",
      }).map((choice) => ({ choice })),
    [request.filesystemTool, request.kind, request.suppressAlwaysAllowRule],
  );

  function resolveChoice(choice: BashApprovalChoice) {
    if (busy) {
      return;
    }
    if (choice === "approve") {
      onResolve({ decision: "approved" });
      return;
    }
    if (choice === "approve_remember_prefix") {
      onResolve({ decision: "approved_remember_prefix" });
      return;
    }
    if (choice === "deny") {
      onResolve({ decision: "denied" });
      return;
    }
    // deny_custom: free-form only; Enter with text submits (not bare click).
    const feedback = denyFeedback.trim();
    if (!feedback) {
      denyInputRef.current?.focus();
      return;
    }
    onResolve({ decision: "denied", feedback });
  }

  function submitHighlightedChoice() {
    const option = options[highlightIndex];
    if (!option) {
      return;
    }
    if (canSubmitBashApprovalWithEnter(option.choice, request.defaultToNo)) resolveChoice(option.choice);
  }

  useEffect(() => {
    setHighlightIndex(
      bashApprovalInitialChoiceIndex(
        options.map((option) => option.choice),
        request.defaultToNo,
      ),
    );
    setDenyFeedback("");
  }, [request.toolUseId, request.defaultToNo, options]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (busy) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const inDenyField = target === denyInputRef.current;

      if (event.key === "Escape") {
        event.preventDefault();
        onSkip();
        return;
      }
      if (inDenyField) {
        if (event.key === "Enter" && denyFeedback.trim()) {
          event.preventDefault();
          onResolve({ decision: "denied", feedback: denyFeedback.trim() });
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex((index) => (index + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex((index) => (index - 1 + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitHighlightedChoice();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, denyFeedback, highlightIndex, onResolve, onSkip, options, request.defaultToNo]);

  const presentation = presentMcpApproval(request);
  const title =
    presentation.description?.trim() ||
    presentation.reason ||
    (request.filesystemTool
      ? t("approval.bash.fileTitle", { tool: request.filesystemTool })
      : t("approval.bash.title"));
  const runningLabel = request.filesystemTool
    ? t("approval.bash.runningTool", { tool: request.filesystemTool })
    : t("approval.bash.runningCommand", { command: request.command });
  const panelLabel = request.filesystemTool ? t("approval.bash.fileLabel") : t("approval.bash.label");
  const detail = presentation.filesystemPath ?? request.command;
  const docked = variant === "dock";

  function renderOption(option: BashApprovalOption, optionIndex: number) {
    const highlighted = highlightIndex === optionIndex;

    if (option.choice === "deny_custom") {
      return (
        <li key={option.choice}>
          <div
            className={[
              "bash-approval-option-row",
              "bash-approval-option-deny",
              highlighted ? "is-highlighted" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onMouseEnter={() => setHighlightIndex(optionIndex)}
          >
            <span className="bash-approval-option-index" aria-hidden>
              <Pencil size={14} strokeWidth={1.75} />
            </span>
            <input
              ref={denyInputRef}
              type="text"
              className="bash-approval-option-deny-input"
              disabled={busy}
              value={denyFeedback}
              placeholder={t("approval.bash.otherPlaceholder")}
              aria-label={t("approval.bash.feedbackAria")}
              onFocus={() => setHighlightIndex(optionIndex)}
              onChange={(event) => setDenyFeedback(event.target.value)}
            />
          </div>
        </li>
      );
    }

    if (option.choice === "approve_remember_prefix") {
      return (
        <li key={option.choice}>
          <button
            type="button"
            role="option"
            aria-selected={highlighted}
            className={["bash-approval-option-row", highlighted ? "is-highlighted" : ""]
              .filter(Boolean)
              .join(" ")}
            disabled={busy}
            onMouseEnter={() => setHighlightIndex(optionIndex)}
            onClick={() => {
              setHighlightIndex(optionIndex);
              resolveChoice(option.choice);
            }}
          >
            <span className="bash-approval-option-index" aria-hidden>
              {CIRCLED_OPTION_MARKERS[optionIndex] ?? `${optionIndex + 1}.`}
            </span>
            <span className="bash-approval-option-label bash-approval-option-remember">
              <span className="bash-approval-option-remember-intro">{t("approval.bash.rememberPrefix")}</span>
              <span className="bash-approval-option-remember-command" title={rememberCommand}>
                {rememberCommandPreview}
              </span>
            </span>
          </button>
        </li>
      );
    }

    const label = option.choice === "deny" ? t("approval.bash.deny") : t("approval.bash.approve");

    return (
      <li key={option.choice}>
        <button
          type="button"
          role="option"
          aria-selected={highlighted}
          className={[
            "bash-approval-option-row",
            option.choice === "deny" ? "bash-approval-option-deny-action" : "",
            highlighted ? "is-highlighted" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          disabled={busy}
          onMouseEnter={() => setHighlightIndex(optionIndex)}
          onClick={() => {
            setHighlightIndex(optionIndex);
            resolveChoice(option.choice);
          }}
        >
          <span className="bash-approval-option-index" aria-hidden>
            {CIRCLED_OPTION_MARKERS[optionIndex] ?? `${optionIndex + 1}.`}
          </span>
          <span className="bash-approval-option-label">{label}</span>
        </button>
      </li>
    );
  }

  const reviewRationale = request.reviewRationale?.trim();
  const reviewError = reviewRationale ? isReviewRequestError(reviewRationale) : false;

  const panelBody = (
    <>
      <header className="bash-approval-top">
        <p className="bash-approval-title">{title}</p>
        {!request.filesystemTool && !docked ? (
          <span className={`bash-approval-risk bash-approval-risk-${request.riskLevel}`}>
            <span className="bash-approval-risk-icon" aria-hidden>
              <RiskLevelIcon level={request.riskLevel} />
            </span>
            <span className="bash-approval-risk-label">{t(`approval.bash.risk.${request.riskLevel}`)}</span>
            <span className="bash-approval-risk-score">{request.riskScore}</span>
          </span>
        ) : null}
      </header>

      {reviewRationale ? (
        <aside
          className={
            reviewError
              ? "bash-approval-review-rationale bash-approval-review-rationale-error"
              : "bash-approval-review-rationale"
          }
          role="status"
        >
          {reviewError ? (
            <p className="bash-approval-review-rationale-body bash-approval-review-rationale-body-error">
              {reviewRationale}
            </p>
          ) : (
            <>
              <p className="bash-approval-review-rationale-title">
                {t("approval.bash.autoReviewFailedTitle")}
              </p>
              <p className="bash-approval-review-rationale-hint">{t("approval.bash.autoReviewFailedHint")}</p>
              <p className="bash-approval-review-rationale-body">{reviewRationale}</p>
            </>
          )}
        </aside>
      ) : null}

      {presentation.reason?.trim() &&
      presentation.reason.trim() !== request.reviewRationale?.trim() &&
      presentation.reason.trim() !== presentation.description?.trim() ? (
        <p className="bash-approval-gate-reason">{presentation.reason.trim()}</p>
      ) : null}

      <ExpandablePreBlock
        text={detail}
        className="bash-approval-command-wrap"
        wrapClassName="bash-approval-command-body-wrap"
        preClassName="bash-approval-command"
        fadeClassName="bash-approval-command-fade"
        hintClassName="bash-approval-command-hint"
        maxCollapsedHeight={112}
        maxExpandedHeight={280}
      />

      <ul className="bash-approval-option-list" role="listbox" aria-label={t("approval.bash.options")}>
        {options.map(renderOption)}
      </ul>

      <footer className="bash-approval-footer">
        <button type="button" className="bash-approval-dismiss" disabled={busy} onClick={onSkip}>
          {busy ? (
            <>
              <Loader2 size={14} className="spinning" aria-hidden />
              {t("common.processing")}
            </>
          ) : (
            t("common.skip")
          )}
        </button>
      </footer>
    </>
  );

  if (docked) {
    return (
      <div className="codex-composer is-compact bash-approval-dock-shell">
        <div className="composer-primary bash-approval-dock-inner">{panelBody}</div>
      </div>
    );
  }

  const panel = (
    <section className="bash-approval-panel codex-style" aria-label={panelLabel}>
      {panelBody}
    </section>
  );

  return (
    <div className="bash-approval-shell">
      <div className="bash-approval-running" aria-hidden>
        <span className="bash-approval-mini-icon">
          <Terminal size={16} />
        </span>
        <span className="bash-approval-running-label">{runningLabel}</span>
      </div>
      {panel}
    </div>
  );
}

function RiskLevelIcon({ level }: { level: BashApprovalRequest["riskLevel"] }) {
  const size = 13;
  switch (level) {
    case "critical":
      return <ShieldAlert size={size} />;
    case "high":
      return <AlertTriangle size={size} />;
    case "medium":
      return <Shield size={size} />;
    case "low":
      return <ShieldCheck size={size} />;
  }
  return null;
}
