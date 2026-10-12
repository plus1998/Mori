import { Users } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SubagentEnabledSettings, SubagentRole } from "../shared/ipc";
import { formatModelDisplayName } from "../shared/model-id";
import { ComposerHoverTooltip } from "./ComposerHoverTooltip";
import type { ComposerAgentModelLabel } from "./composer-agent-model-labels";
import { composerFloatingStyleForAnchor } from "./composer-floating";
import { COMPOSER_TOOLBAR_ICON_PX, COMPOSER_TOOLBAR_ICON_STROKE } from "./composer-icon-metrics";

function rowClassName(options: { subagent: boolean; enabled: boolean; planner: boolean }): string {
  const parts = ["composer-agent-row"];
  if (options.planner) {
    parts.push("is-main", "is-active");
    return parts.join(" ");
  }
  if (options.subagent) {
    parts.push(options.enabled ? "is-active" : "is-disabled");
  }
  return parts.join(" ");
}

interface ComposerAgentModelsProps {
  labels: ComposerAgentModelLabel[];
  subagentSettings: SubagentEnabledSettings | null;
  canEditSubagents: boolean;
  subagentSaving?: boolean | undefined;
  compact?: boolean | undefined;
  embedded?: boolean | undefined;
  onToggleSubagent?: (role: SubagentRole, enabled: boolean) => void;
}

function AgentRowContent({
  displayName,
  modelShort,
  status,
  switchControl,
}: {
  displayName: string;
  modelShort: string;
  status?: string | undefined;
  switchControl?: ReactNode;
}) {
  return (
    <>
      <span className="composer-agent-row-main">
        <span className="composer-agent-row-role">{displayName}</span>
        <span className="composer-agent-row-model">{modelShort}</span>
      </span>
      <span className="composer-agent-row-meta">
        {status ? <span className="composer-agent-row-status">{status}</span> : null}
        {switchControl}
      </span>
    </>
  );
}

function SubagentSwitchRows({
  labels,
  subagentSettings,
  canEditSubagents,
  subagentSaving,
  onToggleSubagent,
}: ComposerAgentModelsProps) {
  const { t } = useTranslation();
  const subagentLabels = labels.filter((label) => !label.main);

  return (
    <>
      {subagentLabels.map(({ role, displayName, modelId, subagentRole }) => {
        const enabled = subagentRole && subagentSettings ? subagentSettings[subagentRole] : true;
        const clickable = Boolean(canEditSubagents && subagentRole && subagentSettings && onToggleSubagent);
        const hasSwitch = Boolean(subagentRole);
        const modelShort = modelId?.trim() ? formatModelDisplayName(modelId) : t("common.notConfigured");

        return (
          <div key={role} className="composer-mcp-row">
            <div className="composer-mcp-row-main">
              <span className="composer-mcp-row-name">{displayName}</span>
              <span className="composer-mcp-row-transport">{modelShort}</span>
            </div>
            {hasSwitch && subagentRole ? (
              <label
                className="composer-switch"
                title={t(enabled ? "composer.enabledNamed" : "composer.disabledNamed", {
                  name: displayName,
                })}
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={subagentSaving || !clickable}
                  aria-label={t(enabled ? "composer.enabledAria" : "composer.disabledAria", {
                    name: displayName,
                  })}
                  onChange={() => onToggleSubagent?.(subagentRole, !enabled)}
                />
                <span className="composer-switch-track" aria-hidden />
              </label>
            ) : (
              <span className="composer-mcp-row-status">
                {enabled ? t("composer.enabled") : t("composer.disabled")}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

function AgentModelRows({
  labels,
  subagentSettings,
  canEditSubagents,
  subagentSaving,
  onToggleSubagent,
}: ComposerAgentModelsProps) {
  const { t } = useTranslation();
  return (
    <>
      {labels.map(({ role, displayName, modelId, title, main, subagentRole }) => {
        const subagent = !main;
        const enabled = subagentRole && subagentSettings ? subagentSettings[subagentRole] : true;
        const clickable = Boolean(canEditSubagents && subagentRole && subagentSettings && onToggleSubagent);
        const modelShort = modelId?.trim() ? formatModelDisplayName(modelId) : t("common.notConfigured");
        const className = rowClassName({ subagent, enabled, planner: main });
        const switchControl = subagentRole ? (
          <label
            className="composer-switch"
            title={t(enabled ? "composer.enabledNamed" : "composer.disabledNamed", {
              name: displayName,
            })}
          >
            <input
              type="checkbox"
              checked={enabled}
              disabled={subagentSaving || !clickable}
              aria-label={t(enabled ? "composer.enabledAria" : "composer.disabledAria", {
                name: displayName,
              })}
              onChange={() => onToggleSubagent?.(subagentRole, !enabled)}
            />
            <span className="composer-switch-track" aria-hidden />
          </label>
        ) : undefined;

        return (
          <div key={role} className={className} title={title}>
            <AgentRowContent
              displayName={displayName}
              modelShort={modelShort}
              status={main ? t("settings.models.mainAgent") : undefined}
              switchControl={switchControl}
            />
          </div>
        );
      })}
    </>
  );
}

export function ComposerAgentModelsCardBody(props: ComposerAgentModelsProps) {
  const { t } = useTranslation();
  if (props.embedded) {
    return (
      <div className="composer-agent-models-card-body is-embedded">
        <div className="composer-agents-list">
          <SubagentSwitchRows {...props} />
        </div>
      </div>
    );
  }

  const subagentLabels = props.labels.filter((label) => !label.main);
  const enabledSubagents = subagentLabels.filter(
    ({ subagentRole }) => !subagentRole || !props.subagentSettings || props.subagentSettings[subagentRole],
  ).length;
  const totalSubagents = subagentLabels.length;
  const summary = totalSubagents > 0 ? `${enabledSubagents}/${totalSubagents}` : String(props.labels.length);

  return (
    <div className="composer-agent-models-card-body">
      <div className="composer-agents-popover-header">
        <span>{t("composer.subagents")}</span>
        <span>{summary}</span>
      </div>
      <div className="composer-agents-list">
        <AgentModelRows {...props} />
      </div>
    </div>
  );
}

export function ComposerAgentModels({
  labels,
  subagentSettings,
  canEditSubagents,
  subagentSaving,
  compact,
  onToggleSubagent,
}: ComposerAgentModelsProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>(() => ({ visibility: "hidden" }));
  const subagentLabels = labels.filter((label) => !label.main);
  const enabledSubagents = subagentLabels.filter(
    ({ subagentRole }) => !subagentRole || !subagentSettings || subagentSettings[subagentRole],
  ).length;
  const totalSubagents = subagentLabels.length;
  const summary = totalSubagents > 0 ? `${enabledSubagents}/${totalSubagents}` : String(labels.length);

  const updatePanelPosition = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor) {
      return;
    }
    setPanelStyle(
      composerFloatingStyleForAnchor(anchor, {
        width: 340,
        minHeight: 180,
        prefer: "above",
      }),
    );
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);

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

  const popover =
    open &&
    createPortal(
      <div
        ref={panelRef}
        className="composer-codex-popover composer-agents-popover"
        role="dialog"
        aria-label={t("composer.subagentDetails")}
        style={panelStyle}
      >
        <div className="composer-agents-popover-header">
          <span>{t("composer.subagents")}</span>
          <span>{summary}</span>
        </div>
        <div className="composer-agents-list">
          <AgentModelRows
            labels={labels}
            subagentSettings={subagentSettings}
            canEditSubagents={canEditSubagents}
            {...(subagentSaving !== undefined && { subagentSaving })}
            {...(onToggleSubagent && { onToggleSubagent })}
          />
        </div>
      </div>,
      document.body,
    );

  return (
    <span className="composer-agents-control">
      <ComposerHoverTooltip content={t("composer.subagents")} disabled={open}>
        <button
          ref={triggerRef}
          type="button"
          className={[
            "composer-context-trigger",
            "composer-agents-trigger",
            compact ? "is-compact" : "",
            open ? "is-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={t("composer.subagentDetailsSummary", { summary })}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            if (open) {
              closePanel();
              return;
            }
            updatePanelPosition();
            setOpen(true);
          }}
        >
          <Users
            size={COMPOSER_TOOLBAR_ICON_PX}
            strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
            aria-hidden
            className="composer-context-trigger-icon"
          />
          <span className="composer-context-trigger-label">{enabledSubagents}</span>
        </button>
      </ComposerHoverTooltip>
      {popover}
    </span>
  );
}
