import type { AcpHostUiFeatures } from "@eco/runtime/acp-host-ui-features";
import { formatCostUsd, formatUsageBadge, shortenModelId } from "@eco/runtime/usage";
import { ListTodo, ReceiptText, X } from "lucide-react";
import {
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  CoderTodoItem,
  GitSettingsSnapshot,
  GitWorkingTreeStatus,
  RoutePricingHint,
  RuntimeAgentRole,
  RuntimeRoleRouteConfig,
  SubagentEnabledSettings,
  ThreadBillingSnapshot,
  ThreadContextSnapshot,
  ThreadStatus,
  ThreadUsageLedgerEventView,
  WorkspaceDiffResult,
  WorkspaceInfo,
} from "../shared/ipc";
import {
  billingEmptyHintKey,
  contextCardPlaceholderKey,
  shouldShowBillingUsagePanel,
  shouldShowContextUsagePanel,
  shouldShowThreadUsagePanels,
} from "../shared/thread-usage-summary";
import { CoderTodoPanel } from "./CoderTodoPanel";
import { ComposerHoverTooltip } from "./ComposerHoverTooltip";
import { ContextCard } from "./ContextCard";
import type { ComposerAgentModelLabel } from "./composer-agent-model-labels";
import { composerFloatingStyleForAnchor, observeComposerFloatingViewport } from "./composer-floating";
import { i18n } from "./i18n";
import { RollingBillingAmount } from "./RollingBillingAmount";
import type { RuntimeAgentDisplayNames } from "./runtime-agent-display";
import type { RuntimeAgentThemes } from "./runtime-agent-theme";
import { ThreadInfoHelpButton } from "./ThreadInfoHelpButton";
import { UsageBreakdownPanel } from "./UsageBreakdownPanel";
import { WorkspaceGitCommitGraph } from "./WorkspaceGitCommitGraph";
import { WorkspaceGitSection } from "./WorkspaceGitSection";

export interface ThreadUsageSummary {
  billing?: ThreadBillingSnapshot;
  ledgerEvents?: ThreadUsageLedgerEventView[];
  context?: ThreadContextSnapshot;
  contextTokens?: number;
}

export function shouldShowBillingSavings(savedUsd: number): boolean {
  return savedUsd !== 0;
}

export function formatBillingCacheHitRate(billing: ThreadBillingSnapshot): string {
  const cacheRead = Math.max(0, billing.totalTokens.cacheRead);
  const promptTokens =
    Math.max(0, billing.totalTokens.input) + cacheRead + Math.max(0, billing.totalTokens.cacheCreation);
  const ratio = promptTokens > 0 ? cacheRead / promptTokens : 0;
  return `${Math.round(ratio * 100)}%`;
}

export function resolveBillingMainModelLabel(
  billing: ThreadBillingSnapshot | undefined,
  agentModelLabels: readonly ComposerAgentModelLabel[] | undefined,
  fallback: string,
): string {
  const selectedMainModel = agentModelLabels?.find((label) => label.main)?.modelId?.trim();
  if (selectedMainModel) {
    return shortenModelId(selectedMainModel);
  }
  const billedMainModel = billing?.plannerModelLabel?.split(" · ")[0]?.trim();
  return billedMainModel || fallback;
}

interface ThreadInfoPanelProps {
  threadId?: string;
  workspace?: WorkspaceInfo;
  workspacePath?: string;
  workspaceLabel?: string;
  gitStatus?: GitWorkingTreeStatus;
  gitBusy?: boolean;
  commitDisabled?: boolean;
  mainAgentConfigId?: string;
  agentModelLabels?: ComposerAgentModelLabel[];
  routes?: readonly RuntimeRoleRouteConfig[];
  routePricingHints?: RoutePricingHint[];
  subagentEnabled?: SubagentEnabledSettings;
  gitSettings?: GitSettingsSnapshot;
  onCheckoutGitBranch?: (branch: string) => void | Promise<void>;
  onCreateGitBranch?: (branch: string) => void | Promise<void>;
  onOpenGitSettings?: () => void;
  onSaveCommitModelPreference?: (candidateModelId: string) => void | Promise<void>;
  onCommitSuccess?: () => void | Promise<void>;
  onChangesDiffLoaded?: (diff: WorkspaceDiffResult) => void | Promise<void>;
  onPullSuccess?: () => void | Promise<void>;
  onPullError?: (message: string) => void;
  onResolveConflictsWithAgent?: (conflictFiles: string[]) => void | Promise<void>;
  scriptsDisabled?: boolean;
  onOpenScriptsDialog?: () => void;
  todos?: CoderTodoItem[];
  threadStatus?: ThreadStatus;
  usageSummary?: ThreadUsageSummary;
  hostUiFeatures?: AcpHostUiFeatures;
  contextCompactionInFlight?: boolean;
  autoCompactSuspended?: boolean;
  promptCacheInvalidated?: boolean;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
}

function hasBillingData(billing?: ThreadBillingSnapshot): billing is ThreadBillingSnapshot {
  if (!billing) {
    return false;
  }
  const total =
    billing.totalTokens.input +
    billing.totalTokens.output +
    billing.totalTokens.cacheRead +
    billing.totalTokens.cacheCreation;
  return (
    total > 0 ||
    billing.sourceReportedCostUsd > 0 ||
    billing.plannerTokenCostUsd > 0 ||
    billing.ecoCostUsd > 0
  );
}

function formatBillingPillCost(billing?: ThreadBillingSnapshot): string {
  const cost = billing?.ecoCostUsd ?? 0;
  if (cost <= 0) {
    return "$0";
  }
  return formatCostUsd(cost);
}

function resolvePlannerOccupancyPct(context?: ThreadContextSnapshot): number | undefined {
  if (!context) {
    return undefined;
  }
  const planner = context.roles?.find((role) => role.role === "main");
  return planner?.occupancyPct ?? context.occupancyPct;
}

function contextRingStroke(pct: number): string {
  if (pct >= 95) {
    return "#f87171";
  }
  if (pct >= 85) {
    return "#fbbf24";
  }
  return "#60a5fa";
}

function ContextOccupancyRing({
  pct,
  size = 14,
  strokeWidth = 2,
}: {
  pct?: number | undefined;
  size?: number;
  strokeWidth?: number;
}) {
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedPct = Math.max(0, Math.min(100, pct ?? 0));
  const offset = circumference * (1 - clampedPct / 100);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="thread-info-context-ring"
      aria-hidden
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
      {clampedPct > 0 ? (
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={contextRingStroke(clampedPct)}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      ) : null}
    </svg>
  );
}

function BillingFloatPillLabel({
  billing,
  minimal = false,
  resetKey,
}: {
  billing?: ThreadBillingSnapshot;
  minimal?: boolean;
  resetKey?: string;
}) {
  const cost = billing?.ecoCostUsd ?? 0;
  const formattedCost = formatBillingPillCost(billing);
  if (minimal) {
    return (
      <span
        className={[
          "thread-info-float-pill-label",
          "composer-usage-pill-minimal",
          cost > 0 ? "thread-info-float-pill-cost" : "thread-info-float-pill-cost is-empty",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <RollingBillingAmount
          value={cost}
          formatted={formattedCost}
          {...(resetKey !== undefined && { resetKey })}
        />
      </span>
    );
  }
  return (
    <span className="thread-info-float-pill-label">
      <span>{i18n.t("billing.title")}</span>
      <span className={cost > 0 ? "thread-info-float-pill-cost" : "thread-info-float-pill-cost is-empty"}>
        <RollingBillingAmount
          value={cost}
          formatted={formattedCost}
          {...(resetKey !== undefined && { resetKey })}
        />
      </span>
    </span>
  );
}

function ContextFloatPillLabel({
  context,
  minimal = false,
}: {
  context?: ThreadContextSnapshot;
  minimal?: boolean;
}) {
  const occupancyPct = resolvePlannerOccupancyPct(context);
  if (minimal) {
    return (
      <span className="thread-info-float-pill-label composer-usage-pill-minimal composer-usage-pill-ring-only">
        <ContextOccupancyRing pct={occupancyPct} size={16} strokeWidth={2.25} />
      </span>
    );
  }
  return (
    <span className="thread-info-float-pill-label">
      <ContextOccupancyRing pct={occupancyPct} />
      <span>Context</span>
    </span>
  );
}

function BillingEmptyState({ hint }: { hint: string }) {
  return (
    <div className="thread-info-billing-empty-state" role="status" aria-live="polite">
      <div className="thread-info-billing-empty-hero">
        <div className="thread-info-billing-empty-icon" aria-hidden="true">
          <ReceiptText size={20} strokeWidth={1.8} />
        </div>
        <div className="thread-info-billing-empty-copy">
          <strong className="thread-info-billing-empty-title">{i18n.t("billing.emptyTitle")}</strong>
          <p className="thread-info-muted thread-info-billing-empty">{hint}</p>
        </div>
      </div>
      <div className="thread-info-billing-empty-fields" aria-hidden="true">
        <div className="thread-info-billing-empty-field">
          <span>{i18n.t("billing.emptyTokens")}</span>
          <strong>—</strong>
        </div>
        <div className="thread-info-billing-empty-field">
          <span>{i18n.t("billing.emptyCache")}</span>
          <strong>—</strong>
        </div>
        <div className="thread-info-billing-empty-field">
          <span>{i18n.t("billing.cost")}</span>
          <strong>—</strong>
        </div>
      </div>
    </div>
  );
}

function BillingFloatingCard({
  billing,
  ledgerEvents,
  threadStatus,
  tokenBadge,
  plannerLabel,
  showBilling,
  agentDisplayNames,
  resetKey,
  onDismiss,
  accountQuota,
}: {
  billing?: ThreadBillingSnapshot;
  ledgerEvents?: ThreadUsageLedgerEventView[];
  threadStatus?: ThreadStatus;
  tokenBadge: string | null;
  plannerLabel: string;
  showBilling: boolean;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  resetKey?: string;
  onDismiss: () => void;
  accountQuota?: ReactNode;
}) {
  const showComparison = Boolean(billing && shouldShowBillingSavings(billing.savedUsd));

  return (
    <div
      className={[
        "thread-info-float-card",
        "thread-info-billing-card",
        showBilling && billing ? "" : "is-empty",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="thread-info-float-card-header">
        <h4 className="thread-info-float-card-title">
          {i18n.t(showComparison ? "billing.comparison" : "billing.title")}
        </h4>
        <button
          type="button"
          className="thread-info-float-dismiss"
          onClick={onDismiss}
          aria-label={i18n.t("billing.closeComparison")}
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      {accountQuota}

      {showBilling && billing ? (
        <div
          className={["thread-info-billing-focus", showComparison ? "is-orchestrated" : ""]
            .filter(Boolean)
            .join(" ")}
        >
          <div className="thread-info-billing-focus-tokens" title={i18n.t("billing.tokenDetail")}>
            {tokenBadge}
          </div>
          <div className="thread-info-billing-focus-metrics">
            <span className="thread-info-billing-focus-metric">
              <span>{i18n.t("billing.cacheHitRate")}</span>
              <strong>{formatBillingCacheHitRate(billing)}</strong>
            </span>
            <span className="thread-info-billing-focus-metric thread-info-billing-focus-cost">
              <span className="thread-info-billing-focus-label">
                <span>{i18n.t("billing.cost")}</span>
                {showComparison ? (
                  <ThreadInfoHelpButton label={i18n.t("billing.ecoHelp")}>
                    {i18n.t("billing.ecoDescription")}
                  </ThreadInfoHelpButton>
                ) : null}
              </span>
              <strong>
                <RollingBillingAmount
                  value={billing.ecoCostUsd}
                  formatted={formatCostUsd(billing.ecoCostUsd)}
                  {...(resetKey !== undefined && { resetKey })}
                />
              </strong>
            </span>
          </div>
          {showComparison ? (
            <div className="thread-info-billing-comparison">
              <div
                className={[
                  "thread-info-billing-outcome",
                  billing.savedUsd > 0 ? "is-saving" : "is-over",
                ].join(" ")}
              >
                <span>{i18n.t(billing.savedUsd > 0 ? "billing.saved" : "billing.overpaid")}</span>
                <strong>{formatCostUsd(Math.abs(billing.savedUsd))}</strong>
                <span className="thread-info-billing-outcome-percent">
                  {Math.abs(billing.savedPct).toFixed(1)}%
                </span>
              </div>
              <div className="thread-info-billing-baseline">
                <span className="thread-info-billing-focus-label">
                  <span>{i18n.t("billing.unorchestratedEstimate")}</span>
                  <ThreadInfoHelpButton label={i18n.t("billing.unorchestratedHelp")}>
                    {i18n.t("billing.unorchestratedDescription", { model: plannerLabel })}
                  </ThreadInfoHelpButton>
                </span>
                <span>{formatCostUsd(billing.plannerTokenCostUsd)}</span>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <BillingEmptyState hint={i18n.t(billingEmptyHintKey(threadStatus))} />
      )}

      {showBilling && billing ? (
        <UsageBreakdownPanel
          billing={billing}
          {...(ledgerEvents && { ledgerEvents })}
          variant="full"
          {...(agentDisplayNames && { agentDisplayNames })}
        />
      ) : null}
    </div>
  );
}

function ThreadInfoFloatControl({
  label,
  ariaLabel,
  hoverTooltip,
  resetKey,
  width = 320,
  minHeight = 200,
  fixedHeight,
  openOn = "hover",
  align = "start",
  children,
}: {
  label: ReactNode;
  ariaLabel: string;
  hoverTooltip?: string | undefined;
  resetKey?: string | undefined;
  width?: number;
  minHeight?: number;
  fixedHeight?: number;
  openOn?: "hover" | "click";
  align?: "start" | "end";
  children: (closePanel: () => void) => ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>(() => ({ visibility: "hidden" }));
  const clickOnly = openOn === "click";
  const open = clickOnly ? pinned : hovered || pinned;

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const updatePanelPosition = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor) {
      return;
    }
    setPanelStyle(
      composerFloatingStyleForAnchor(anchor, {
        width,
        minHeight,
        prefer: "above",
        align,
        ...(fixedHeight !== undefined ? { fixedHeight } : {}),
      }),
    );
  }, [align, fixedHeight, minHeight, width]);

  const showPanel = useCallback(() => {
    clearCloseTimer();
    updatePanelPosition();
    setHovered(true);
  }, [clearCloseTimer, updatePanelPosition]);

  const scheduleClose = useCallback(() => {
    if (pinned) {
      return;
    }
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setHovered(false);
      closeTimerRef.current = null;
    }, 120);
  }, [clearCloseTimer, pinned]);

  const closePanel = useCallback(() => {
    clearCloseTimer();
    setHovered(false);
    setPinned(false);
  }, [clearCloseTimer]);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const nextTarget = event.relatedTarget as Node | null;
      if (
        nextTarget &&
        (triggerRef.current?.contains(nextTarget) || panelRef.current?.contains(nextTarget))
      ) {
        return;
      }
      scheduleClose();
    },
    [scheduleClose],
  );

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updatePanelPosition();
    const stopObservingViewport = observeComposerFloatingViewport(updatePanelPosition);
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      stopObservingViewport();
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);

  useEffect(() => {
    return () => clearCloseTimer();
  }, [clearCloseTimer]);

  useEffect(() => {
    clearCloseTimer();
    setHovered(false);
    setPinned(false);
  }, [clearCloseTimer, resetKey]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      closePanel();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closePanel();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closePanel, open]);

  const hoverTriggerProps = clickOnly
    ? {}
    : {
        onMouseEnter: showPanel,
        onMouseLeave: scheduleClose,
        onFocus: showPanel,
        onBlur: handleBlur,
      };

  const hoverPopoverProps = clickOnly
    ? {}
    : {
        onMouseEnter: showPanel,
        onMouseLeave: scheduleClose,
        onFocus: showPanel,
        onBlur: handleBlur,
      };

  const popover =
    open &&
    createPortal(
      <div
        ref={panelRef}
        className="thread-info-float-popover"
        role="dialog"
        aria-label={ariaLabel}
        style={panelStyle}
        {...hoverPopoverProps}
      >
        <div className="thread-info-float-popover-body">{children(closePanel)}</div>
      </div>,
      document.body,
    );

  return (
    <ComposerHoverTooltip content={hoverTooltip ?? ""} disabled={!hoverTooltip || open}>
      <span className="thread-info-float-control">
        <button
          ref={triggerRef}
          type="button"
          className={
            open ? "thread-info-float-reopen is-clickable is-active" : "thread-info-float-reopen is-clickable"
          }
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          {...hoverTriggerProps}
          onClick={() => {
            if (pinned) {
              closePanel();
              return;
            }
            updatePanelPosition();
            if (clickOnly) {
              setPinned(true);
              return;
            }
            setHovered(true);
            setPinned(true);
          }}
        >
          {label}
        </button>
        {popover}
      </span>
    </ComposerHoverTooltip>
  );
}

export function ThreadInfoFloatStack({
  threadId,
  showBillingSection,
  billing,
  ledgerEvents,
  threadStatus,
  tokenBadge,
  plannerLabel,
  showBilling,
  context,
  contextPlaceholder,
  contextCompactionInFlight = false,
  autoCompactSuspended = false,
  promptCacheInvalidated = false,
  agentDisplayNames,
  agentThemes,
  variant = "panel",
  hostUiFeatures,
  showContext,
  accountQuota,
}: {
  threadId?: string;
  showBillingSection: boolean;
  billing?: ThreadBillingSnapshot;
  ledgerEvents?: ThreadUsageLedgerEventView[];
  threadStatus?: ThreadStatus;
  tokenBadge: string | null;
  plannerLabel: string;
  showBilling: boolean;
  context?: ThreadContextSnapshot;
  contextPlaceholder: string;
  contextCompactionInFlight?: boolean;
  autoCompactSuspended?: boolean;
  promptCacheInvalidated?: boolean;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
  variant?: "panel" | "composer";
  hostUiFeatures?: AcpHostUiFeatures;
  showContext?: boolean;
  accountQuota?: ReactNode;
}) {
  const { t } = useTranslation();
  const showContextFloat = showContext ?? shouldShowContextUsagePanel(threadStatus, hostUiFeatures);
  const showBillingFloat = showBillingSection && shouldShowBillingUsagePanel(threadStatus, hostUiFeatures);
  const contextOccupancyPct = resolvePlannerOccupancyPct(context);
  const hasContextSnapshot = context !== undefined;
  const floatOpenOn = variant === "composer" ? "click" : "hover";
  const floatAlign = variant === "composer" ? "end" : "start";

  if (!showBillingFloat && !showContextFloat) {
    return null;
  }

  return (
    <div
      className={["thread-info-float-stack", variant === "composer" ? "thread-info-float-stack-composer" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className={["thread-info-float-pills", variant === "composer" ? "composer-usage-pills" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        {showBillingFloat ? (
          <ThreadInfoFloatControl
            label={
              <BillingFloatPillLabel
                minimal={variant === "composer"}
                {...(billing !== undefined && { billing })}
                {...(threadId !== undefined && { resetKey: threadId })}
              />
            }
            ariaLabel={t("billing.comparisonCurrent", {
              cost: formatBillingPillCost(billing),
            })}
            resetKey={threadId}
            width={320}
            minHeight={220}
            openOn={floatOpenOn}
            align={floatAlign}
          >
            {(closePanel) => (
              <BillingFloatingCard
                {...(billing !== undefined && { billing })}
                {...(ledgerEvents && { ledgerEvents })}
                {...(threadStatus !== undefined && { threadStatus })}
                tokenBadge={tokenBadge}
                plannerLabel={plannerLabel}
                showBilling={showBilling}
                {...(agentDisplayNames && { agentDisplayNames })}
                {...(threadId !== undefined && { resetKey: threadId })}
                onDismiss={closePanel}
                accountQuota={accountQuota}
              />
            )}
          </ThreadInfoFloatControl>
        ) : null}
        {showContextFloat ? (
          <ThreadInfoFloatControl
            label={
              <ContextFloatPillLabel
                minimal={variant === "composer"}
                {...(context !== undefined && { context })}
              />
            }
            ariaLabel={
              contextOccupancyPct !== undefined
                ? t("billing.contextOccupancy", { pct: contextOccupancyPct })
                : "Context"
            }
            {...(variant === "composer" && contextOccupancyPct !== undefined
              ? { hoverTooltip: `${contextOccupancyPct}%` }
              : {})}
            resetKey={threadId}
            width={320}
            minHeight={hasContextSnapshot ? 360 : 160}
            {...(hasContextSnapshot ? { fixedHeight: 360 } : {})}
            openOn={floatOpenOn}
            align={floatAlign}
          >
            {(closePanel) => (
              <ContextCard
                {...(context !== undefined && { context })}
                placeholder={contextPlaceholder}
                showWhenEmpty
                {...(threadId !== undefined && { threadId })}
                {...(threadStatus !== undefined && { threadStatus })}
                contextCompactionInFlight={contextCompactionInFlight}
                autoCompactSuspended={autoCompactSuspended}
                promptCacheInvalidated={promptCacheInvalidated}
                {...(agentDisplayNames && { agentDisplayNames })}
                {...(agentThemes && { agentThemes })}
                onDismiss={closePanel}
              />
            )}
          </ThreadInfoFloatControl>
        ) : null}
      </div>
    </div>
  );
}

function hasProgressInfo(todos: CoderTodoItem[]): boolean {
  return todos.some(
    (todo) => todo.status === "pending" || todo.status === "running" || todo.status === "blocked",
  );
}

export function ThreadInfoPanel({
  threadId,
  workspace,
  workspacePath,
  workspaceLabel,
  gitStatus,
  gitBusy,
  commitDisabled,
  mainAgentConfigId,
  agentModelLabels,
  routes,
  routePricingHints,
  subagentEnabled,
  gitSettings,
  onCheckoutGitBranch,
  onCreateGitBranch,
  onOpenGitSettings,
  onSaveCommitModelPreference,
  onCommitSuccess,
  onChangesDiffLoaded,
  onPullSuccess,
  onPullError,
  onResolveConflictsWithAgent,
  scriptsDisabled,
  onOpenScriptsDialog,
  todos = [],
  threadStatus,
  usageSummary,
  hostUiFeatures,
  contextCompactionInFlight = false,
  autoCompactSuspended = false,
  promptCacheInvalidated = false,
  agentDisplayNames,
  agentThemes,
}: ThreadInfoPanelProps) {
  const { t } = useTranslation();
  const projectLabel =
    workspaceLabel?.trim() ||
    workspacePath?.split("/").filter(Boolean).pop() ||
    workspace?.name ||
    t("billing.noProject");
  const billing = usageSummary?.billing;
  const tokenBadge = billing
    ? formatUsageBadge({
        inputTokens: billing.totalTokens.input,
        outputTokens: billing.totalTokens.output,
        cacheReadTokens: billing.totalTokens.cacheRead,
        cacheCreationTokens: billing.totalTokens.cacheCreation,
      })
    : null;
  const plannerLabel = resolveBillingMainModelLabel(billing, agentModelLabels, t("billing.mainModel"));
  const showUsagePanels = shouldShowThreadUsagePanels(threadStatus);
  const showBilling = hasBillingData(billing);
  const showBillingSection = showUsagePanels && (showBilling || threadStatus !== undefined);
  const showProgress = hasProgressInfo(todos);
  const [commitsRefreshKey, setCommitsRefreshKey] = useState(0);
  const showCommitGraph = Boolean(workspacePath && gitStatus?.isGitRepository && gitStatus.hasGitCommits);

  async function handleCommitSuccess() {
    setCommitsRefreshKey((current) => current + 1);
    await onCommitSuccess?.();
  }

  async function handlePullSuccess() {
    setCommitsRefreshKey((current) => current + 1);
    await onPullSuccess?.();
  }

  return (
    <aside
      id="thread-info-panel"
      className="thread-info-panel"
      aria-label={threadId ? t("billing.threadInfo") : t("billing.workspace")}
    >
      <div className="thread-info-panel-scroll">
        <section className="thread-info-section thread-info-workspace-section">
          <h3 className="thread-info-heading">{t("billing.workspace")}</h3>
          <WorkspaceGitSection
            {...(workspacePath && { workspacePath })}
            workspaceLabel={projectLabel}
            {...(gitStatus && { gitStatus })}
            {...(gitBusy !== undefined && { gitBusy })}
            {...(commitDisabled !== undefined && { commitDisabled })}
            {...(mainAgentConfigId && { mainAgentConfigId })}
            {...(agentModelLabels && { agentModelLabels })}
            {...(routes && { routes })}
            {...(routePricingHints && { routePricingHints })}
            {...(subagentEnabled && { subagentEnabled })}
            {...(gitSettings && { gitSettings })}
            {...(onCheckoutGitBranch && { onCheckoutGitBranch })}
            {...(onCreateGitBranch && { onCreateGitBranch })}
            {...(onOpenGitSettings && { onOpenGitSettings })}
            {...(onSaveCommitModelPreference && { onSaveCommitModelPreference })}
            onCommitSuccess={() => void handleCommitSuccess()}
            {...(onChangesDiffLoaded && { onChangesDiffLoaded })}
            onPullSuccess={() => void handlePullSuccess()}
            {...(onPullError && { onPullError })}
            {...(onResolveConflictsWithAgent && { onResolveConflictsWithAgent })}
            {...(scriptsDisabled !== undefined && { scriptsDisabled })}
            {...(onOpenScriptsDialog && { onOpenScriptsDialog })}
          />
        </section>

        {showProgress ? (
          <section className="thread-info-section thread-info-todos">
            <h3 className="thread-info-heading">
              <ListTodo size={14} aria-hidden />
              {t("billing.progress")}
            </h3>
            {todos.length > 0 ? <CoderTodoPanel todos={todos} embedded compact /> : null}
          </section>
        ) : null}
      </div>

      {showUsagePanels ? (
        <ThreadInfoFloatStack
          {...(threadId !== undefined && { threadId })}
          showBillingSection={showBillingSection}
          {...(hostUiFeatures !== undefined && { hostUiFeatures })}
          {...(billing !== undefined && { billing })}
          {...(usageSummary?.ledgerEvents && { ledgerEvents: usageSummary.ledgerEvents })}
          {...(threadStatus !== undefined && { threadStatus })}
          tokenBadge={tokenBadge}
          plannerLabel={plannerLabel}
          showBilling={showBilling}
          {...(usageSummary?.context !== undefined && { context: usageSummary.context })}
          contextPlaceholder={t(contextCardPlaceholderKey(threadStatus))}
          contextCompactionInFlight={contextCompactionInFlight}
          autoCompactSuspended={autoCompactSuspended}
          promptCacheInvalidated={promptCacheInvalidated}
          {...(agentDisplayNames && { agentDisplayNames })}
          {...(agentThemes && { agentThemes })}
        />
      ) : null}

      {showCommitGraph ? (
        <div className="thread-info-git-graph-footer">
          <WorkspaceGitCommitGraph
            workspacePath={workspacePath!}
            refreshToken={`${commitsRefreshKey}:${gitStatus?.branch ?? ""}`}
          />
        </div>
      ) : null}
    </aside>
  );
}
