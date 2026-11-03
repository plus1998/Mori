import { Unplug } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { countEnabledMcpServers } from "../shared/composer-mcp";
import type { McpServerConfigView } from "../shared/ipc";
import { sanitizeMcpServerName } from "../shared/mcp";
import type { McpServersEnabledSettings } from "../shared/thread-runtime-config";
import { ComposerHoverTooltip } from "./ComposerHoverTooltip";
import { composerFloatingStyleForAnchor } from "./composer-floating";
import { COMPOSER_TOOLBAR_ICON_PX, COMPOSER_TOOLBAR_ICON_STROKE } from "./composer-icon-metrics";

interface ComposerMcpServersProps {
  servers: readonly McpServerConfigView[];
  enabledSettings: McpServersEnabledSettings;
  canEdit: boolean;
  saving?: boolean | undefined;
  compact?: boolean | undefined;
  onToggleServer?: (serverKey: string, enabled: boolean) => void;
  displayNameOverrides?: Record<string, string>;
}

function McpServerRows({
  servers,
  enabledSettings,
  canEdit,
  saving,
  onToggleServer,
  displayNameOverrides,
}: ComposerMcpServersProps) {
  const { t } = useTranslation();
  const enabledServers = servers.filter((server) => server.enabled && server.name.trim());

  return (
    <>
      {enabledServers.map((server) => {
        const serverKey = sanitizeMcpServerName(server.name);
        const enabled = enabledSettings[serverKey] ?? false;
        const clickable = Boolean(canEdit && onToggleServer);
        const displayName = displayNameOverrides?.[serverKey] ?? server.name;

        return (
          <div key={server.id} className="composer-mcp-row">
            <div className="composer-mcp-row-main">
              <span className="composer-mcp-row-name">{displayName}</span>
              <span className="composer-mcp-row-transport">{server.transport}</span>
            </div>
            <label
              className="composer-switch"
              title={t(enabled ? "composer.enabledNamed" : "composer.disabledNamed", {
                name: displayName,
              })}
            >
              <input
                type="checkbox"
                checked={enabled}
                disabled={saving || !clickable}
                aria-label={t(enabled ? "composer.enabledAria" : "composer.disabledAria", {
                  name: displayName,
                })}
                onChange={() => onToggleServer?.(serverKey, !enabled)}
              />
              <span className="composer-switch-track" aria-hidden />
            </label>
          </div>
        );
      })}
    </>
  );
}

export function ComposerMcpCardBody(props: ComposerMcpServersProps) {
  const { t } = useTranslation();
  const enabledServers = props.servers.filter((server) => server.enabled && server.name.trim());

  if (enabledServers.length === 0) {
    return <p className="floating-workspace-card-empty">{t("composer.mcp.empty")}</p>;
  }

  return (
    <div className="composer-mcp-card-body is-embedded">
      <div className="composer-agents-list">
        <McpServerRows {...props} />
      </div>
    </div>
  );
}

export function ComposerMcpServers({
  servers,
  enabledSettings,
  canEdit,
  saving,
  compact,
  onToggleServer,
  displayNameOverrides,
}: ComposerMcpServersProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>(() => ({ visibility: "hidden" }));

  const enabledServers = servers.filter((server) => server.enabled && server.name.trim());
  const enabledCount = countEnabledMcpServers(enabledSettings);
  const summary = enabledServers.length > 0 ? `${enabledCount}/${enabledServers.length}` : "0";

  const updatePanelPosition = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor) {
      return;
    }
    setPanelStyle(
      composerFloatingStyleForAnchor(anchor, {
        width: 320,
        minHeight: 120,
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

  if (enabledServers.length === 0) {
    return null;
  }

  const popover =
    open &&
    createPortal(
      <div
        ref={panelRef}
        className="composer-codex-popover composer-agents-popover"
        role="dialog"
        aria-label={t("settings.mcp.title")}
        style={panelStyle}
      >
        <div className="composer-agents-popover-header">
          <span>{t("settings.mcp.title")}</span>
          <span>{summary}</span>
        </div>
        <div className="composer-agents-list">
          <McpServerRows
            servers={servers}
            enabledSettings={enabledSettings}
            canEdit={canEdit}
            {...(saving !== undefined && { saving })}
            {...(onToggleServer && { onToggleServer })}
            {...(displayNameOverrides && { displayNameOverrides })}
          />
        </div>
      </div>,
      document.body,
    );

  return (
    <span className="composer-agents-control">
      <ComposerHoverTooltip content="MCP" disabled={open}>
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
          aria-label={t("composer.mcp.configureSummary", { summary })}
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
          <Unplug
            size={COMPOSER_TOOLBAR_ICON_PX}
            strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
            aria-hidden
            className="composer-context-trigger-icon"
          />
          {enabledCount > 0 ? <span className="composer-context-trigger-label">{enabledCount}</span> : null}
        </button>
      </ComposerHoverTooltip>
      {popover}
    </span>
  );
}
