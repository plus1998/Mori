import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, CircleAlert, RotateCw } from "lucide-react";
import type { DesktopUpdateState } from "../shared/desktop-update";
import { desktopUpdateDetails, updateBytes, updateClock } from "./desktop-update-details";
import "./desktop-update-notice.css";

export function DesktopUpdateNotice({ state, onInstall, onRetry, onOpenRelease }: {
  state: DesktopUpdateState | undefined;
  onInstall: () => void;
  onRetry: () => void;
  onOpenRelease: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const busy = state?.phase === "downloading" || state?.phase === "preparing" || state?.phase === "installing";
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  if (!state || !["downloading", "preparing", "downloaded", "installing", "error"].includes(state.phase)) return null;
  const details = desktopUpdateDetails(state, now);
  const downloading = state.phase === "downloading";
  const ready = state.phase === "downloaded";
  const error = state.phase === "error" || Boolean(state.error);
  const title = error ? t("update.error") : downloading ? t("update.downloading", { percent: details.percent })
    : ready ? t("update.downloaded", { version: state.availableVersion })
    : state.phase === "preparing" ? t("update.preparing") : t("update.installing");
  const errorKey = state.error === "NETWORK_ERROR" ? "update.errorNetwork"
    : state.error === "CHANNEL_FILE_NOT_FOUND" ? "update.errorChannelMissing"
    : state.error === "LATEST_VERSION_NOT_FOUND" ? "update.errorLatestMissing" : undefined;
  return (
    <section className="desktop-update-notice" aria-label={t("update.noticeTitle")}>
      <div className="desktop-update-notice-heading" role="status" aria-live="polite">
        {error ? <CircleAlert size={16} aria-hidden /> : ready ? <RotateCw size={16} aria-hidden />
          : <LoaderCircle size={16} className="sidebar-settings-update-spin" aria-hidden />}
        <strong>{title}</strong>
      </div>
      {downloading ? (
        <>
          <progress max={100} {...(details.total > 0 ? { value: details.percent } : {})} aria-label={title} />
          <div className="desktop-update-notice-transfer">
            <span>{updateBytes(details.transferred, i18n.language)}{details.total > 0 ? ` / ${updateBytes(details.total, i18n.language)}` : ""}</span>
            <span>{updateBytes(details.bytesPerSecond, i18n.language)}/s</span>
          </div>
          <p>{details.stalled ? t("update.downloadStalled") : details.remainingSeconds !== undefined
            ? t("update.remaining", { time: updateClock(details.remainingSeconds) }) : t("update.estimating")}</p>
        </>
      ) : null}
      {state.phase === "preparing" || state.phase === "installing" ? (
        <p>{t(details.elapsedSeconds >= 120 ? "update.waitLonger" : "update.installHint")}</p>
      ) : null}
      {busy ? <p className="desktop-update-notice-elapsed">{t("update.elapsed", { time: updateClock(details.elapsedSeconds) })}</p> : null}
      {error ? <p className="desktop-update-notice-error">{errorKey ? t(errorKey) : state.error || t("update.error")}</p> : null}
      {ready || error ? <div className="desktop-update-notice-actions">
        <button type="button" onClick={ready ? onInstall : onRetry}>{t(ready ? "update.restart" : "common.retry")}</button>
        {error ? <button type="button" onClick={onOpenRelease}>{t("update.openRelease")}</button> : null}
      </div> : null}
    </section>
  );
}
