import { CONTEXT_SEGMENT_LABELS, contextSegmentDisplayLabel } from "@eco/runtime/context-breakdown";
import { formatTokenCount } from "@eco/runtime/usage";
import { Gauge, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadContextSnapshot, ThreadRoleContextSnapshot, ThreadStatus } from "../shared/ipc";
import { resolveSubagentRunDisplayTitle } from "./activity-log";
import { i18n } from "./i18n";
import {
  formatRuntimeRoleModelLabel,
  type RuntimeAgentDisplayNames,
  resolveRuntimeAgentName,
} from "./runtime-agent-display";
import { type RuntimeAgentThemes, resolveRuntimeAgentThemeColor } from "./runtime-agent-theme";

interface ContextCardProps {
  context?: ThreadContextSnapshot;
  placeholder?: string;
  /** When false, hide the card if there is no snapshot yet. */
  showWhenEmpty?: boolean;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
  threadId?: string;
  threadStatus?: ThreadStatus;
  contextCompactionInFlight?: boolean;
  autoCompactSuspended?: boolean;
  promptCacheInvalidated?: boolean;
  onDismiss?: () => void;
}

function shortAgentId(agentId: string): string {
  if (agentId.length <= 8) {
    return agentId;
  }
  return agentId.slice(0, 8);
}

function formatContextK(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 1_048_576) {
    const rounded = value / 1024;
    return rounded >= 100 ? `${Math.round(rounded)}K` : `${rounded.toFixed(1)}K`;
  }
  return `${(value / 1_048_576).toFixed(1)}M`;
}

function occupancyTone(pct: number): "ok" | "warn" | "critical" {
  if (pct >= 95) {
    return "critical";
  }
  if (pct >= 85) {
    return "warn";
  }
  return "ok";
}

function pctClass(pct: number): string {
  const tone = occupancyTone(pct);
  if (tone === "critical") {
    return "context-card-pct context-card-pct-critical";
  }
  if (tone === "warn") {
    return "context-card-pct context-card-pct-warn";
  }
  return "context-card-pct";
}

function formatOccupancyStatus(pct: number): string {
  if (pct >= 100) {
    return i18n.t("context.status.full");
  }
  if (pct >= 95) {
    return i18n.t("context.status.nearLimit");
  }
  if (pct >= 85) {
    return i18n.t("context.status.warning");
  }
  return i18n.t("context.status.used");
}

function contextRoles(context: ThreadContextSnapshot): ThreadRoleContextSnapshot[] {
  if (context.roles && context.roles.length > 0) {
    return context.roles;
  }
  return [
    {
      role: context.displayRole ?? "main",
      occupied: context.occupied,
      limit: context.limit,
      occupancyPct: context.occupancyPct,
      limitsResolved: context.limitsResolved,
      ...(context.modelId && { modelId: context.modelId }),
      segments: context.segments,
      ...(context.maxOutputTokens !== undefined && { maxOutputTokens: context.maxOutputTokens }),
    },
  ];
}

function resolvePlannerSnapshot(
  context: ThreadContextSnapshot,
  roles: ThreadRoleContextSnapshot[],
): ThreadRoleContextSnapshot {
  const fromRoles = roles.find((role) => role.role === "main");
  if (fromRoles) {
    return fromRoles;
  }
  return {
    role: "main",
    occupied: context.occupied,
    limit: context.limit,
    occupancyPct: context.occupancyPct,
    limitsResolved: context.limitsResolved,
    ...(context.modelId && { modelId: context.modelId }),
    segments: context.segments,
    ...(context.maxOutputTokens !== undefined && { maxOutputTokens: context.maxOutputTokens }),
  };
}

function hasDetailedBreakdown(role: ThreadRoleContextSnapshot): boolean {
  const visibleSegments = role.segments.filter((segment) => segment.tokens > 0);
  return (
    visibleSegments.length > 1 ||
    visibleSegments.some(
      (segment) => segment.key !== "conversation" || segment.label !== CONTEXT_SEGMENT_LABELS.conversation,
    )
  );
}

interface FlatSubagentRow {
  key: string;
  role: ThreadRoleContextSnapshot["role"];
  title: string;
  snapshot: ThreadRoleContextSnapshot;
}

function buildFlatSubagentRows(
  instanceEntries: ThreadContextSnapshot["instances"],
  subagentRoles: ThreadRoleContextSnapshot[],
  agentDisplayNames?: RuntimeAgentDisplayNames,
): FlatSubagentRow[] {
  const instances = [...(instanceEntries ?? [])]
    .filter((instance) => instance.role !== "main" && instance.occupied > 0)
    .sort((left, right) => right.occupied - left.occupied);

  if (instances.length > 0) {
    return instances.map((instance) => ({
      key: instance.agentId,
      role: instance.role,
      title: `${resolveRuntimeAgentName(instance.role, agentDisplayNames) ?? resolveSubagentRunDisplayTitle(instance.role)} #${shortAgentId(instance.agentId)}`,
      snapshot: {
        role: instance.role,
        occupied: instance.occupied,
        limit: instance.limit,
        occupancyPct: instance.occupancyPct,
        limitsResolved: instance.limitsResolved,
        segments: instance.segments,
        ...(instance.modelId && { modelId: instance.modelId }),
        ...(instance.maxOutputTokens !== undefined && { maxOutputTokens: instance.maxOutputTokens }),
      },
    }));
  }

  return subagentRoles.map((role) => ({
    key: role.role,
    role: role.role,
    title: formatRuntimeRoleModelLabel(role.role, role.modelId, agentDisplayNames),
    snapshot: role,
  }));
}

function SubagentContextRow({
  row,
  agentThemes,
}: {
  row: FlatSubagentRow;
  agentThemes?: RuntimeAgentThemes;
}) {
  const { t } = useTranslation();
  const role = row.snapshot;
  const visibleSegments = role.segments.filter((segment) => segment.tokens > 0);
  const occupied = role.occupied;
  const limit = role.limit;
  const segmentTotal = visibleSegments.reduce((sum, segment) => sum + segment.tokens, 0);
  const freeTokens = Math.max(limit - occupied, 0);
  const accent = resolveRuntimeAgentThemeColor(row.role, agentThemes);

  return (
    <article
      className="context-card-subagent-row"
      aria-label={t("context.agentContext", { agent: row.title })}
    >
      <div className="context-card-subagent-row-head">
        <span className="context-card-subagent-row-dot" style={{ backgroundColor: accent }} aria-hidden />
        <div className="context-card-subagent-row-copy">
          <span className="context-card-subagent-row-title">{row.title}</span>
          <span className="context-card-subagent-row-tokens">
            ~{formatContextK(occupied)} / {formatContextK(limit)}
          </span>
        </div>
        <span className={pctClass(role.occupancyPct)}>{role.occupancyPct}%</span>
      </div>
      <div
        className="context-card-bar context-card-bar-subagent"
        role="img"
        aria-label={t("context.approxUsage", {
          agent: row.title,
          occupied: formatContextK(occupied),
          limit: formatContextK(limit),
        })}
      >
        {occupied > 0 ? (
          <span className="context-card-bar-occupied" style={{ flexGrow: occupied }}>
            {visibleSegments.map((segment) => (
              <span
                key={`${segment.key}-${segment.label}`}
                className="context-card-bar-segment"
                style={{ flexGrow: segment.tokens, backgroundColor: segment.color }}
              />
            ))}
            {occupied > segmentTotal ? (
              <span
                className="context-card-bar-segment context-card-bar-segment-gap"
                style={{ flexGrow: occupied - segmentTotal }}
              />
            ) : null}
          </span>
        ) : null}
        {freeTokens > 0 ? <span className="context-card-bar-free" style={{ flexGrow: freeTokens }} /> : null}
      </div>
    </article>
  );
}

function ContextRoleBody({
  role,
  detailsOpen,
  agentDisplayNames,
}: {
  role: ThreadRoleContextSnapshot;
  detailsOpen: boolean;
  agentDisplayNames?: RuntimeAgentDisplayNames;
}) {
  const { t } = useTranslation();
  const visibleSegments = role.segments.filter((segment) => segment.tokens > 0);
  const occupied = role.occupied;
  const limit = role.limit;
  const segmentTotal = visibleSegments.reduce((sum, segment) => sum + segment.tokens, 0);
  const freeTokens = Math.max(limit - occupied, 0);
  const detailed = hasDetailedBreakdown(role);
  const roleLabel = formatRuntimeRoleModelLabel(role.role, role.modelId, agentDisplayNames);

  const tone = occupancyTone(role.occupancyPct);

  return (
    <div className="context-card-role-body context-card-role-body-main">
      <div className="context-card-hero">
        <div className={`context-card-hero-figure context-card-hero-figure-${tone}`}>
          <span className="context-card-hero-num">{role.occupancyPct}</span>
          <span className="context-card-hero-sign">%</span>
        </div>
        <div className="context-card-hero-copy">
          <span className={`context-card-hero-status ${pctClass(role.occupancyPct)}`}>
            {formatOccupancyStatus(role.occupancyPct)}
          </span>
          <span className="context-card-tokens">
            ~{formatContextK(occupied)} / {formatContextK(limit)}
          </span>
          <span className="context-card-main-model">{roleLabel}</span>
        </div>
      </div>

      <div
        className="context-card-bar"
        role="img"
        aria-label={t("context.usageAria", {
          agent: roleLabel,
          percent: role.occupancyPct,
          occupied: formatContextK(occupied),
          limit: formatContextK(limit),
        })}
      >
        {occupied > 0 ? (
          <span className="context-card-bar-occupied" style={{ flexGrow: occupied }}>
            {visibleSegments.map((segment) => (
              <span
                key={`${segment.key}-${segment.label}`}
                className="context-card-bar-segment"
                style={{
                  flexGrow: segment.tokens,
                  backgroundColor: segment.color,
                }}
              />
            ))}
            {occupied > segmentTotal ? (
              <span
                className="context-card-bar-segment context-card-bar-segment-gap"
                style={{ flexGrow: occupied - segmentTotal }}
              />
            ) : null}
          </span>
        ) : null}
        {freeTokens > 0 ? <span className="context-card-bar-free" style={{ flexGrow: freeTokens }} /> : null}
      </div>

      {detailed && detailsOpen ? (
        <ul className="context-card-breakdown">
          {visibleSegments.map((segment) => (
            <li key={`${segment.key}-${segment.label}`}>
              <span className="context-card-swatch" style={{ backgroundColor: segment.color }} />
              <span className="context-card-label">{contextSegmentDisplayLabel(segment)}</span>
              <span className="context-card-value">{formatTokenCount(segment.tokens)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {!role.limitsResolved ? (
        <p className="context-card-footnote">
          {t("context.estimatedLimit", { limit: formatContextK(role.limit) })}
        </p>
      ) : null}
    </div>
  );
}

export function ContextCard({
  context,
  placeholder,
  showWhenEmpty = true,
  agentDisplayNames,
  agentThemes,
  threadId: _threadId,
  threadStatus: _threadStatus,
  contextCompactionInFlight: _contextCompactionInFlight = false,
  autoCompactSuspended = false,
  promptCacheInvalidated = false,
  onDismiss,
}: ContextCardProps) {
  const { t } = useTranslation();
  const [plannerDetailsOpen, setPlannerDetailsOpen] = useState(true);

  if (!context) {
    if (!showWhenEmpty) {
      return null;
    }
    return (
      <div className="context-card context-card-empty" role="status" aria-live="polite">
        <div className="context-card-empty-header">
          <div className="context-card-empty-icon" aria-hidden="true">
            <Gauge size={21} strokeWidth={1.8} />
          </div>
          <div className="context-card-empty-copy">
            <h4 className="context-card-empty-title">{t("context.title")}</h4>
            <p className="context-card-placeholder">{placeholder ?? t("context.empty")}</p>
          </div>
        </div>
        <div className="context-card-empty-meter" aria-hidden="true">
          <div className="context-card-empty-track">
            <span />
            <span />
            <span />
            <span />
          </div>
          <span className="context-card-empty-meter-label">{t("context.emptyMeter")}</span>
        </div>
      </div>
    );
  }

  const roles = contextRoles(context);
  const planner = resolvePlannerSnapshot(context, roles);
  const subagentRoles = roles.filter((role) => role.role !== "main");
  const flatSubagents = buildFlatSubagentRows(context.instances, subagentRoles, agentDisplayNames);
  const plannerDetailed = hasDetailedBreakdown(planner);
  const hasSubagents = flatSubagents.length > 0;

  return (
    <div className={hasSubagents ? "context-card context-card-has-subagents" : "context-card"}>
      <div className="context-card-header">
        <div className="context-card-title-group">
          <h4 className="context-card-title">{t("context.title")}</h4>
        </div>
        <div className="context-card-header-actions">
          {plannerDetailed ? (
            <button
              type="button"
              className="context-card-collapse"
              onClick={() => setPlannerDetailsOpen((open) => !open)}
              aria-expanded={plannerDetailsOpen}
              aria-label={plannerDetailsOpen ? t("context.collapseBreakdown") : t("context.expandBreakdown")}
            >
              <span className="context-card-collapse-label">{plannerDetailsOpen ? "−" : "+"}</span>
            </button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              className="context-card-dismiss"
              onClick={onDismiss}
              aria-label={t("context.close")}
            >
              <X size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      {autoCompactSuspended ? (
        <p className="context-card-compact-suspended" role="status">
          {t("context.autoCompactSuspended")}
        </p>
      ) : null}

      {promptCacheInvalidated ? (
        <p className="context-card-cache-invalidated" role="status">
          {t("context.promptCacheInvalidated")}
        </p>
      ) : null}

      <section className="context-card-main" aria-label={t("context.mainAgent")}>
        <ContextRoleBody
          role={planner}
          detailsOpen={plannerDetailsOpen}
          {...(agentDisplayNames && { agentDisplayNames })}
        />
      </section>

      {hasSubagents ? (
        <div className="context-card-scroll" aria-label={t("context.subagentsAria")}>
          <p className="context-card-section-label">{t("context.subagents")}</p>
          <div className="context-card-subagent-group">
            {flatSubagents.map((row) => (
              <SubagentContextRow key={row.key} row={row} {...(agentThemes && { agentThemes })} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
