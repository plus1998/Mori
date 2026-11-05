import { CircleAlert, CircleHelp, Download, ExternalLink, LoaderCircle, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DesktopUpdateState } from "../shared/desktop-update";
import { ComposerHoverTooltip } from "./ComposerHoverTooltip";
import { resolveSidebarUpdateAction } from "./desktop-update-banner-state";
import { ICON_SIZE, ICON_STROKE } from "./icon-metrics";

interface SidebarSettingsUpdateControlProps {
  state: DesktopUpdateState | undefined;
  onDownload: () => void;
  onInstall: () => void;
  onCheck: () => void;
  onOpenRelease: () => void;
}

export function SidebarSettingsUpdateControl({
  state,
  onDownload,
  onInstall,
  onCheck,
  onOpenRelease,
}: SidebarSettingsUpdateControlProps) {
  const { t } = useTranslation();
  const action = resolveSidebarUpdateAction(state);

  const tooltip = (() => {
    switch (action.kind) {
      case "checking":
        return t("update.checking");
      case "download":
        return t("update.available", { version: action.availableVersion ?? "" });
      case "progress":
        return t("update.downloading", { percent: action.percent ?? 0 });
      case "restart":
        return t("update.downloaded", { version: action.availableVersion ?? "" });
      case "installing":
        return t("update.installing");
      case "preparing":
        return t("update.preparing");
      case "error":
        if (action.error === "CHANNEL_FILE_NOT_FOUND") {
          return t("update.errorChannelMissing");
        }
        if (action.error === "LATEST_VERSION_NOT_FOUND") {
          return t("update.errorLatestMissing");
        }
        if (action.error === "NETWORK_ERROR") {
          return t("update.errorNetwork");
        }
        return action.error ? `${t("update.error")}: ${action.error}` : t("update.error");
      case "manual":
        return action.manualReason === "unsigned_macos"
          ? t("update.macosManualHint")
          : t("update.manualTitle");
      case "version":
      default:
        return action.currentVersion;
    }
  })();

  const ariaLabel = tooltip || action.currentVersion || t("nav.settings");

  if (action.kind === "version") {
    return (
      <ComposerHoverTooltip content={tooltip}>
        <button type="button" className="sidebar-settings-meta" aria-label={ariaLabel}>
          <CircleHelp size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
        </button>
      </ComposerHoverTooltip>
    );
  }

  if (action.kind === "checking" || action.kind === "installing" || action.kind === "preparing") {
    return (
      <ComposerHoverTooltip content={tooltip}>
        <span
          className="sidebar-settings-meta sidebar-settings-meta--busy"
          aria-label={ariaLabel}
          role="status"
        >
          <LoaderCircle
            size={ICON_SIZE.md}
            strokeWidth={ICON_STROKE}
            className="sidebar-settings-update-spin"
            aria-hidden
          />
        </span>
      </ComposerHoverTooltip>
    );
  }

  if (action.kind === "progress") {
    const percent = action.percent ?? 0;
    return (
      <ComposerHoverTooltip content={tooltip}>
        <span
          className="sidebar-settings-meta sidebar-settings-meta--progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={ariaLabel}
        >
          <svg className="sidebar-settings-update-ring" viewBox="0 0 32 32" aria-hidden>
            <circle className="sidebar-settings-update-ring-track" cx="16" cy="16" r="12" />
            <circle
              className="sidebar-settings-update-ring-value"
              cx="16"
              cy="16"
              r="12"
              style={{ strokeDashoffset: `${75.4 * (1 - percent / 100)}` }}
            />
          </svg>
          <span className="sidebar-settings-update-percent">{percent}</span>
        </span>
      </ComposerHoverTooltip>
    );
  }

  if (action.kind === "download") {
    return (
      <ComposerHoverTooltip content={tooltip}>
        <button
          type="button"
          className="sidebar-settings-meta sidebar-settings-meta--action sidebar-settings-meta--pulse"
          onClick={onDownload}
          aria-label={ariaLabel}
        >
          <Download size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
        </button>
      </ComposerHoverTooltip>
    );
  }

  if (action.kind === "restart") {
    return (
      <ComposerHoverTooltip content={tooltip}>
        <button
          type="button"
          className="sidebar-settings-meta sidebar-settings-meta--action sidebar-settings-meta--pulse"
          onClick={onInstall}
          aria-label={ariaLabel}
        >
          <RotateCw size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
        </button>
      </ComposerHoverTooltip>
    );
  }

  if (action.kind === "error") {
    return (
      <ComposerHoverTooltip content={tooltip}>
        <button
          type="button"
          className="sidebar-settings-meta sidebar-settings-meta--action sidebar-settings-meta--error"
          onClick={onCheck}
          aria-label={ariaLabel}
        >
          <CircleAlert size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
        </button>
      </ComposerHoverTooltip>
    );
  }

  return (
    <ComposerHoverTooltip content={tooltip}>
      <button
        type="button"
        className="sidebar-settings-meta sidebar-settings-meta--action"
        onClick={onOpenRelease}
        aria-label={ariaLabel}
      >
        <ExternalLink size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
      </button>
    </ComposerHoverTooltip>
  );
}
