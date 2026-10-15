import { formatCostUsd, formatRoleModelLabel, formatUsageBadge } from "@eco/runtime/usage";
import { ChevronDown, CircleHelp } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { buildAgentViewRows, buildBillingTokenBreakdown } from "../shared/billing-token-breakdown";
import type {
  ThreadBillingSnapshot,
  ThreadSubagentBillingSnapshot,
  ThreadUsageLedgerEventView,
} from "../shared/ipc";
import { resolveLedgerEventTiming } from "../shared/ledger-event-timing";
import {
  ledgerEventRouteRoleDiffers,
  partitionLedgerEventsForDisplay,
  resolveBillingPrimarySource,
  resolveLedgerEventBillingRole,
  snapshotTokenTotal,
  sortLedgerEventsNewestFirst,
  sumLedgerEventTokens,
} from "../shared/ledger-events-display";
import { formatModelDisplayName } from "../shared/model-id";
import { resolveSubagentRunDisplayTitle } from "./activity-log";
import { composerFloatingViewport, observeComposerFloatingViewport } from "./composer-floating";
import { i18n } from "./i18n";
import {
  formatRuntimeRoleModelLabel,
  type RuntimeAgentDisplayNames,
  resolveRuntimeAgentName,
} from "./runtime-agent-display";
import { formatTokenSpeedSegmentPlain, TokenSpeedSegmentsView } from "./TokenSpeedSegments";
import { resolveTokenSpeedSegments } from "./token-speed";
import { useTokenSpeedDisplayMode } from "./token-speed-preferences";

type BreakdownView = "agent" | "model" | "events";

interface UsageBreakdownPanelProps {
  billing?: ThreadBillingSnapshot;
  ledgerEvents?: ThreadUsageLedgerEventView[];
  variant: "full" | "compact";
  agentDisplayNames?: RuntimeAgentDisplayNames;
}

function formatLedgerEventAgentLabel(event: ThreadUsageLedgerEventView): string | undefined {
  if (!event.agentId) {
    return undefined;
  }
  const agentId = event.agentId.trim();
  if (!agentId) {
    return undefined;
  }
  if (agentId === event.billingRole || agentId === "planner") {
    return i18n.t("usage.mainSession");
  }
  return agentId.slice(-8);
}

function attributionStatusLabel(status: ThreadUsageLedgerEventView["attributionStatus"]): string {
  if (status === "pending") {
    return i18n.t("usage.pending");
  }
  if (status === "unattributed") {
    return i18n.t("usage.unattributed");
  }
  return "";
}

export function formatLedgerEventTime(observedAt: string): string {
  const date = new Date(observedAt);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function formatLedgerEventProviderModel(
  event: Pick<ThreadUsageLedgerEventView, "modelId" | "aliasModelId" | "providerId">,
): { providerLabel?: string; modelLabel: string; title: string } | undefined {
  const providerId = event.providerId?.trim();
  const modelId = event.modelId?.trim();
  const fallbackAlias = event.aliasModelId?.trim();
  const resolvedModelId = modelId || fallbackAlias;
  if (!resolvedModelId) {
    return undefined;
  }
  const inferredProvider = !providerId && modelId?.includes("/") ? modelId.split("/")[0]?.trim() : undefined;
  const rawProviderLabel = providerId || inferredProvider;
  const providerPrefix = rawProviderLabel ? `${rawProviderLabel}/` : undefined;
  const providerModelId =
    modelId && providerPrefix && modelId.startsWith(providerPrefix)
      ? modelId.slice(providerPrefix.length)
      : resolvedModelId;
  const providerLabel =
    rawProviderLabel && !/^codex-[a-z0-9]+$/i.test(rawProviderLabel) ? rawProviderLabel : undefined;
  return {
    ...(providerLabel && { providerLabel }),
    modelLabel: formatModelDisplayName(providerModelId),
    title: providerLabel ? `${providerLabel} / ${providerModelId}` : providerModelId,
  };
}

export function BillingCostCell({
  ecoCostUsd,
  reportedCostUsd,
  className = "usage-breakdown-cost",
}: {
  ecoCostUsd: number;
  reportedCostUsd?: number | undefined;
  className?: string;
}) {
  return (
    <span className={className} title={reportedCostUsd !== undefined ? i18n.t("usage.costTitle") : undefined}>
      {formatCostUsd(ecoCostUsd)}
      {reportedCostUsd !== undefined && reportedCostUsd > 0 ? (
        <span className="usage-breakdown-cost-reported"> / {formatCostUsd(reportedCostUsd)}</span>
      ) : null}
    </span>
  );
}

export function formatUsageBreakdownAgentLabel(
  role: string,
  agentId: string | undefined,
  agentDisplayNames?: RuntimeAgentDisplayNames,
): string {
  const name =
    resolveRuntimeAgentName(role, agentDisplayNames) ??
    resolveSubagentRunDisplayTitle(role) ??
    formatRoleModelLabel(role);
  return agentId ? `${name} · #${agentId.slice(-8)}` : name;
}

export function ExpandableBillingSection({
  title,
  summary,
  children,
  className,
  defaultExpanded,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
  className?: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  return (
    <div className={["usage-breakdown-expandable", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="usage-breakdown-expand-trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="usage-breakdown-expand-title">{title}</span>
        {!expanded && summary ? <span className="usage-breakdown-expand-summary">{summary}</span> : null}
        <ChevronDown
          size={14}
          className={expanded ? "usage-breakdown-chevron open" : "usage-breakdown-chevron"}
          aria-hidden
        />
      </button>
      {expanded ? <div className="usage-breakdown-expand-body">{children}</div> : null}
    </div>
  );
}

function BillingSummaryRow({
  title,
  titleTooltip,
  meta,
  status,
  statusKind,
  tokenBadge,
  ecoCostUsd,
  reportedCostUsd,
}: {
  title: string;
  titleTooltip?: string;
  meta?: string;
  status?: string;
  statusKind?: "pending" | "unattributed";
  tokenBadge: string;
  ecoCostUsd: number;
  reportedCostUsd?: number;
}) {
  return (
    <li className="usage-breakdown-summary-row">
      <span className="usage-breakdown-summary-copy">
        <span className="usage-breakdown-summary-heading">
          <span className="usage-breakdown-summary-title" title={titleTooltip ?? title}>
            {title}
          </span>
          {status ? (
            <span
              className={[
                "usage-breakdown-summary-status",
                statusKind ? `usage-breakdown-summary-status-${statusKind}` : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {status}
            </span>
          ) : null}
        </span>
        {meta ? <span className="usage-breakdown-summary-meta">{meta}</span> : null}
      </span>
      <span className="usage-breakdown-summary-usage">
        <BillingCostCell
          ecoCostUsd={ecoCostUsd}
          {...(reportedCostUsd === undefined ? {} : { reportedCostUsd })}
          className="usage-breakdown-summary-cost"
        />
        <span className="usage-breakdown-summary-tokens" title={i18n.t("billing.tokenTitle")}>
          {tokenBadge}
        </span>
      </span>
    </li>
  );
}

function BreakdownRows({
  view,
  breakdown,
  compact,
  subagents = [],
  agentDisplayNames,
}: {
  view: BreakdownView;
  breakdown: NonNullable<ReturnType<typeof buildBillingTokenBreakdown>>;
  compact: boolean;
  subagents?: ThreadSubagentBillingSnapshot[];
  agentDisplayNames?: RuntimeAgentDisplayNames;
}) {
  if (view === "agent") {
    const agentRows = buildAgentViewRows(breakdown.byAgent, subagents);

    return (
      <ul
        className={[
          "usage-breakdown-list",
          "usage-breakdown-summary-list",
          compact ? "usage-breakdown-list-compact" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {agentRows.map((row) => {
          const status =
            row.kind === "unattributed"
              ? i18n.t("usage.unattributed")
              : row.kind === "pending"
                ? i18n.t("usage.pending")
                : undefined;
          const title =
            resolveRuntimeAgentName(row.role, agentDisplayNames) ??
            resolveSubagentRunDisplayTitle(row.role) ??
            row.label;
          return (
            <BillingSummaryRow
              key={`${row.role}:${row.kind}`}
              title={title}
              titleTooltip={
                row.modelId ? formatRuntimeRoleModelLabel(row.role, row.modelId, agentDisplayNames) : title
              }
              {...(row.modelId && { meta: formatModelDisplayName(row.modelId) })}
              {...(status && row.kind !== "primary"
                ? { status, statusKind: row.kind }
                : status
                  ? { status }
                  : {})}
              tokenBadge={row.tokenBadge}
              ecoCostUsd={row.ecoCostUsd}
            />
          );
        })}
        {subagents.map((row) => (
          <BillingSummaryRow
            key={row.agentId}
            title={formatUsageBreakdownAgentLabel(row.role, row.agentId, agentDisplayNames)}
            {...(row.modelId && { meta: formatModelDisplayName(row.modelId) })}
            tokenBadge={formatUsageBadge({
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              cacheReadTokens: row.cacheReadTokens,
              cacheCreationTokens: row.cacheCreationTokens,
            })}
            ecoCostUsd={row.ecoCostUsd}
          />
        ))}
      </ul>
    );
  }

  return (
    <ul
      className={[
        "usage-breakdown-list",
        "usage-breakdown-summary-list",
        compact ? "usage-breakdown-list-compact" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {breakdown.byModel.map((row) => (
        <BillingSummaryRow
          key={row.modelId}
          title={row.label}
          titleTooltip={row.modelId}
          meta={row.roles
            .map((role) => resolveRuntimeAgentName(role, agentDisplayNames) ?? formatRoleModelLabel(role))
            .join(" · ")}
          tokenBadge={row.tokenBadge}
          ecoCostUsd={row.ecoCostUsd}
          {...(row.reportedCostUsd === undefined ? {} : { reportedCostUsd: row.reportedCostUsd })}
        />
      ))}
    </ul>
  );
}

function LedgerEventRow({
  event,
  agentDisplayNames,
  showSource,
}: {
  event: ThreadUsageLedgerEventView;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  showSource?: boolean;
}) {
  const attributionLabel = attributionStatusLabel(event.attributionStatus);
  const billingRole = resolveLedgerEventBillingRole(event);
  const roleLabel =
    resolveRuntimeAgentName(billingRole, agentDisplayNames) ?? formatRoleModelLabel(billingRole);
  const routeRoleLabel =
    resolveRuntimeAgentName(event.routeRole, agentDisplayNames) ?? formatRoleModelLabel(event.routeRole);
  const providerModel = formatLedgerEventProviderModel(event);
  const formattedAgentLabel = formatLedgerEventAgentLabel(event);
  const agentLabel = formattedAgentLabel ? `agent ${formattedAgentLabel}` : i18n.t("usage.noAgent");
  const tokenBadge = formatUsageBadge({
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
  });
  const timing = resolveLedgerEventTiming(event);
  const tokenSpeedMode = useTokenSpeedDisplayMode();
  const timingSegments = resolveTokenSpeedSegments(
    {
      ...(timing.ttftMs !== undefined ? { ttftMs: timing.ttftMs } : {}),
      ...(timing.totalTps !== undefined ? { totalTps: timing.totalTps } : {}),
      ...(timing.prefillTps !== undefined ? { prefillTps: timing.prefillTps } : {}),
      ...(timing.decodeTps !== undefined ? { decodeTps: timing.decodeTps } : {}),
      tokenSource: "usage",
    },
    tokenSpeedMode,
  );
  const timingPlain =
    timingSegments.length > 0 ? timingSegments.map(formatTokenSpeedSegmentPlain).join(" · ") : undefined;
  const observedTime = formatLedgerEventTime(event.observedAt);
  const computedCostAvailable = event.ecoCostUsd !== undefined && event.pricingResolved !== false;
  const primaryCostUsd = computedCostAvailable ? event.ecoCostUsd : event.reportedCostUsd;
  const reportedCostUsd =
    computedCostAvailable && event.reportedCostUsd !== undefined ? event.reportedCostUsd : undefined;
  const detailParts = [
    roleLabel,
    providerModel?.title,
    agentLabel,
    ledgerEventRouteRoleDiffers(event) ? i18n.t("usage.route", { role: routeRoleLabel }) : undefined,
    attributionLabel || undefined,
    event.attributionReason,
    showSource ? event.source : undefined,
    timingPlain,
  ].filter(Boolean);

  return (
    <li
      className={[
        "usage-breakdown-row",
        event.attributionStatus !== "attributed" ? `usage-breakdown-row-${event.attributionStatus}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={detailParts.join(" · ")}
    >
      <span className="usage-breakdown-event-heading">
        <span
          className="usage-breakdown-event-model"
          title={providerModel?.title ?? i18n.t("usage.unknownModel")}
        >
          {providerModel?.modelLabel ?? i18n.t("usage.unknownModel")}
        </span>
        {attributionLabel ? (
          <span
            className={`usage-breakdown-event-status usage-breakdown-event-status-${event.attributionStatus}`}
            title={event.attributionReason}
          >
            {attributionLabel}
          </span>
        ) : null}
        <span
          className={[
            "usage-breakdown-event-cost",
            primaryCostUsd === undefined ? "usage-breakdown-event-cost-unavailable" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          title={
            primaryCostUsd === undefined
              ? i18n.t("usage.costUnavailable")
              : reportedCostUsd !== undefined
                ? i18n.t("usage.costTitle")
                : i18n.t("usage.eventCostTitle")
          }
        >
          {primaryCostUsd === undefined ? "—" : formatCostUsd(primaryCostUsd)}
          {reportedCostUsd !== undefined && reportedCostUsd > 0 ? (
            <span className="usage-breakdown-event-cost-reported">
              {" / "}
              {formatCostUsd(reportedCostUsd)}
            </span>
          ) : null}
        </span>
      </span>
      <span className="usage-breakdown-event-meta">
        {providerModel?.providerLabel ? (
          <span className="usage-breakdown-event-provider">{providerModel.providerLabel}</span>
        ) : null}
        <span className="usage-breakdown-event-role">{roleLabel}</span>
        <span
          className={formattedAgentLabel ? "usage-breakdown-event-agent" : "usage-breakdown-event-no-agent"}
        >
          {agentLabel}
        </span>
        {ledgerEventRouteRoleDiffers(event) ? (
          <span
            className="usage-breakdown-event-route"
            title={i18n.t("usage.proxyRoute", { role: routeRoleLabel })}
          >
            {i18n.t("usage.route", { role: routeRoleLabel })}
          </span>
        ) : null}
        {showSource ? <span className="usage-breakdown-event-source">{event.source}</span> : null}
      </span>
      <span className="usage-breakdown-event-footer">
        <span className="usage-breakdown-event-token-detail" title={i18n.t("billing.tokenTitle")}>
          {tokenBadge}
        </span>
        {timingSegments.length > 0 ? (
          <span
            className="usage-breakdown-event-timing"
            title={timingPlain ?? i18n.t("usage.eventTimingTitle")}
          >
            <TokenSpeedSegmentsView segments={timingSegments} />
          </span>
        ) : null}
      </span>
      {observedTime ? (
        <time className="usage-breakdown-event-time" dateTime={event.observedAt} title={event.observedAt}>
          {observedTime}
        </time>
      ) : null}
    </li>
  );
}

function LedgerEventList({
  events,
  compact,
  agentDisplayNames,
  showSource,
  scrollable = false,
}: {
  events: ThreadUsageLedgerEventView[];
  compact: boolean;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  showSource?: boolean;
  scrollable?: boolean;
}) {
  const list = (
    <ul
      className={`usage-breakdown-list usage-breakdown-events${compact ? " usage-breakdown-list-compact" : ""}`}
    >
      {events.map((event) => (
        <LedgerEventRow
          key={event.id}
          event={event}
          {...(agentDisplayNames && { agentDisplayNames })}
          {...(showSource && { showSource })}
        />
      ))}
    </ul>
  );

  if (!scrollable) {
    return list;
  }

  return <div className="usage-breakdown-events-scroll">{list}</div>;
}

export interface LedgerEventSummary {
  text: string;
  tokensMatch: boolean;
}

interface EventsSummaryPopoverPosition {
  top: number;
  left: number;
  width: number;
}

const EVENTS_SUMMARY_POPOVER_MAX_WIDTH = 280;
const EVENTS_SUMMARY_POPOVER_GAP = 6;
const EVENTS_SUMMARY_POPOVER_VIEWPORT_MARGIN = 8;

export function resolveEventsSummaryPopoverPosition(
  anchor: Pick<DOMRect, "top" | "bottom" | "right">,
  viewportWidth?: number,
): EventsSummaryPopoverPosition {
  const margin = EVENTS_SUMMARY_POPOVER_VIEWPORT_MARGIN;
  const rightBound =
    viewportWidth !== undefined ? viewportWidth - margin : composerFloatingViewport(margin).right;
  const width = Math.min(EVENTS_SUMMARY_POPOVER_MAX_WIDTH, Math.max(160, rightBound - margin));
  const left = Math.max(margin, Math.min(anchor.right - width, rightBound - width));

  return {
    top: anchor.bottom + EVENTS_SUMMARY_POPOVER_GAP,
    left,
    width,
  };
}

export function buildLedgerEventSummary(
  events: readonly ThreadUsageLedgerEventView[],
  billing?: ThreadBillingSnapshot,
): LedgerEventSummary | undefined {
  if (events.length === 0) {
    return undefined;
  }
  const primarySource = resolveBillingPrimarySource(billing);
  const { primaryEvents } = partitionLedgerEventsForDisplay(events, primarySource);
  const sortedPrimary = sortLedgerEventsNewestFirst(primaryEvents);
  if (sortedPrimary.length === 0) {
    return undefined;
  }
  const primaryTotals = sumLedgerEventTokens(sortedPrimary);
  const snapshotTokens = billing ? snapshotTokenTotal(billing) : primaryTotals.total;
  const tokensMatch = primaryTotals.total === snapshotTokens;
  const pendingCount = sortedPrimary.filter((event) => event.attributionStatus === "pending").length;
  const unattributedCount = sortedPrimary.filter(
    (event) => event.attributionStatus === "unattributed",
  ).length;
  const parts = [
    i18n.t("usage.primaryCount", { count: sortedPrimary.length }),
    formatUsageBadge(primaryTotals),
    tokensMatch
      ? i18n.t("usage.matchesTotal")
      : i18n.t("usage.totalMismatch", {
          primary: primaryTotals.total,
          snapshot: snapshotTokens,
        }),
  ];
  if (pendingCount > 0) {
    parts.push(i18n.t("usage.pendingCount", { count: pendingCount }));
  }
  if (unattributedCount > 0) {
    parts.push(i18n.t("usage.unattributedCount", { count: unattributedCount }));
  }
  return { text: parts.join(" · "), tokensMatch };
}

function LedgerEventRows({
  events,
  billing,
  compact,
  agentDisplayNames,
}: {
  events: ThreadUsageLedgerEventView[];
  billing?: ThreadBillingSnapshot;
  compact: boolean;
  agentDisplayNames?: RuntimeAgentDisplayNames;
}) {
  if (events.length === 0) {
    return <p className="usage-breakdown-events-empty">{i18n.t("usage.noEvents")}</p>;
  }

  const primarySource = resolveBillingPrimarySource(billing);
  const { primaryEvents } = partitionLedgerEventsForDisplay(events, primarySource);
  const sortedPrimary = sortLedgerEventsNewestFirst(primaryEvents);

  if (sortedPrimary.length === 0) {
    return <p className="usage-breakdown-events-empty">{i18n.t("usage.noPrimaryEvents")}</p>;
  }

  return (
    <LedgerEventList
      events={sortedPrimary}
      compact={compact}
      scrollable
      {...(agentDisplayNames && { agentDisplayNames })}
    />
  );
}

function EventsSummaryInfo({ summary }: { summary: LedgerEventSummary }) {
  const controlRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<EventsSummaryPopoverPosition>({
    top: 0,
    left: 0,
    width: EVENTS_SUMMARY_POPOVER_MAX_WIDTH,
  });
  const visible = hovered || pinned;

  const updatePosition = useCallback(() => {
    const control = controlRef.current;
    if (!control) {
      return;
    }
    setPosition(resolveEventsSummaryPopoverPosition(control.getBoundingClientRect()));
  }, []);

  const showOnHover = useCallback(() => {
    updatePosition();
    setHovered(true);
  }, [updatePosition]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    updatePosition();
    const stopObservingViewport = observeComposerFloatingViewport(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      stopObservingViewport();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [updatePosition, visible]);

  const popover = visible
    ? createPortal(
        <span
          className={["usage-breakdown-events-summary-popover", summary.tokensMatch ? "" : "is-warning"]
            .filter(Boolean)
            .join(" ")}
          role="tooltip"
          style={{
            top: position.top,
            left: position.left,
            width: position.width,
          }}
        >
          {summary.text}
        </span>,
        document.body,
      )
    : null;

  return (
    <>
      <span
        ref={controlRef}
        className="usage-breakdown-events-summary-control"
        onMouseEnter={showOnHover}
        onMouseLeave={() => setHovered(false)}
        onFocus={showOnHover}
        onBlur={() => setHovered(false)}
      >
        <button
          type="button"
          className="usage-breakdown-events-summary-button"
          aria-label={i18n.t("usage.eventsSummary")}
          aria-expanded={visible}
          onClick={() => {
            updatePosition();
            setPinned((current) => !current);
          }}
        >
          <CircleHelp size={12} aria-hidden />
        </button>
      </span>
      {popover}
    </>
  );
}

function ViewToggle({
  view,
  onChange,
  compact,
  showEvents,
  eventsSummary,
}: {
  view: BreakdownView;
  onChange: (view: BreakdownView) => void;
  compact: boolean;
  showEvents: boolean;
  eventsSummary?: LedgerEventSummary;
}) {
  return (
    <div
      className={`usage-breakdown-toggle${compact ? " usage-breakdown-toggle-compact" : ""}`}
      role="tablist"
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === "model"}
        className={view === "model" ? "active" : undefined}
        onClick={() => onChange("model")}
      >
        {i18n.t("usage.byModel")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "agent"}
        className={view === "agent" ? "active" : undefined}
        onClick={() => onChange("agent")}
      >
        {i18n.t("usage.byAgent")}
      </button>
      {showEvents ? (
        <span
          className={["usage-breakdown-events-tab-shell", view === "events" ? "is-active" : ""]
            .filter(Boolean)
            .join(" ")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "events"}
            className="usage-breakdown-events-tab"
            onClick={() => onChange("events")}
          >
            {i18n.t("usage.events")}
          </button>
          {eventsSummary ? <EventsSummaryInfo summary={eventsSummary} /> : null}
        </span>
      ) : null}
    </div>
  );
}

export function UsageBreakdownPanel({
  billing,
  ledgerEvents = [],
  variant,
  agentDisplayNames,
}: UsageBreakdownPanelProps) {
  useTranslation();
  const breakdown = useMemo(() => buildBillingTokenBreakdown(billing), [billing]);
  const [view, setView] = useState<BreakdownView>("model");
  const [expanded, setExpanded] = useState(false);
  const compact = variant === "compact";
  const showEvents = true;
  const eventsSummary = useMemo(
    () => buildLedgerEventSummary(ledgerEvents, billing),
    [billing, ledgerEvents],
  );

  if (!breakdown) {
    return null;
  }

  const subagents = billing?.subagents ?? [];
  const breakdownBody =
    view === "events" ? (
      <LedgerEventRows
        events={ledgerEvents}
        {...(billing && { billing })}
        compact={compact}
        {...(agentDisplayNames && { agentDisplayNames })}
      />
    ) : (
      <BreakdownRows
        view={view}
        breakdown={breakdown}
        compact={compact}
        subagents={subagents}
        {...(agentDisplayNames && { agentDisplayNames })}
      />
    );

  if (compact) {
    const summaryRows = breakdown.byModel.length > 0 ? breakdown.byModel : breakdown.byAgent;
    const summary = summaryRows.map((row) => `${row.label} ${row.tokenBadge}`).join(" · ");

    return (
      <div className="usage-breakdown usage-breakdown-compact">
        <button
          type="button"
          className="usage-breakdown-compact-trigger"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="usage-breakdown-compact-title">{i18n.t("usage.cumulative")}</span>
          <span className="usage-breakdown-compact-summary">{summary}</span>
          <ChevronDown
            size={14}
            className={expanded ? "usage-breakdown-chevron open" : "usage-breakdown-chevron"}
            aria-hidden
          />
        </button>
        {expanded ? (
          <div className="usage-breakdown-compact-body">
            <ViewToggle
              view={view}
              onChange={setView}
              compact
              showEvents={showEvents}
              {...(eventsSummary && { eventsSummary })}
            />
            {breakdownBody}
          </div>
        ) : null}
      </div>
    );
  }

  const summaryRows = breakdown.byModel.length > 0 ? breakdown.byModel : breakdown.byAgent;
  const summary = summaryRows.map((row) => `${row.label} ${row.tokenBadge}`).join(" · ");

  return (
    <ExpandableBillingSection title={i18n.t("usage.details")} summary={summary} defaultExpanded>
      <ViewToggle
        view={view}
        onChange={setView}
        compact={false}
        showEvents={showEvents}
        {...(eventsSummary && { eventsSummary })}
      />
      {breakdownBody}
    </ExpandableBillingSection>
  );
}
