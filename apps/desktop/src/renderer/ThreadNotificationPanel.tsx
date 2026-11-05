import { Switch } from "./components/Switch";
import { AudioLines, Bell, MessageCircle, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

export function ThreadNotificationPanel({
  wechatFollowEnabled,
  onWechatFollowChange,
  readAloudContent,
  readAloudHasError,
  onClose,
}: {
  wechatFollowEnabled: boolean;
  onWechatFollowChange(enabled: boolean): Promise<void>;
  readAloudContent: ReactNode;
  readAloudHasError: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [tab, setTab] = useState<"wechat" | "read">(readAloudHasError ? "read" : "wechat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (readAloudHasError) setTab("read");
  }, [readAloudHasError]);
  return (
    <>
      <header className="read-aloud-popover-heading">
        <span>
          <Bell size={17} aria-hidden />
          <strong>{t("settings.notifications")}</strong>
        </span>
        <button
          type="button"
          className="read-aloud-icon-button"
          aria-label={t("thread.closeNotifications")}
          onClick={onClose}
        >
          <X size={15} aria-hidden />
        </button>
      </header>
      <div className="thread-notification-tabs" role="tablist" aria-label={t("settings.notifications")}>
        {(["wechat", "read"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${id}-${value}-tab`}
            aria-selected={tab === value}
            aria-controls={`${id}-${value}-panel`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "wechat"
                  : event.key === "End"
                    ? "read"
                    : value === "wechat"
                      ? "read"
                      : "wechat";
              setTab(next);
              document.getElementById(`${id}-${next}-tab`)?.focus();
            }}
          >
            {value === "wechat" ? (
              <MessageCircle size={15} aria-hidden />
            ) : (
              <AudioLines size={15} aria-hidden />
            )}
            {t(value === "wechat" ? "thread.wechatNotifications" : "readAloud.title")}
            {value === "wechat" && wechatFollowEnabled ? (
              <i className="thread-notification-tab-dot" aria-hidden />
            ) : null}
          </button>
        ))}
      </div>
      <div
        className="read-aloud-popover-body"
        role="tabpanel"
        id={`${id}-wechat-panel`}
        aria-labelledby={`${id}-wechat-tab`}
        hidden={tab !== "wechat"}
        tabIndex={0}
      >
        <div className="thread-notification-wechat-row">
          <div>
            <strong>{t("thread.wechatCompletion")}</strong>
            <small>{t("thread.wechatFollowHint")}</small>
          </div>
          <Switch
            checked={wechatFollowEnabled}
            disabled={busy}
            aria-label={t("thread.wechatCompletion")}
            onCheckedChange={async (checked) => {
              const enabled = checked;
              setBusy(true);
              setError(undefined);
              try {
                await onWechatFollowChange(enabled);
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason));
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
        <p className="read-aloud-help thread-notification-scope">{t("thread.wechatScopeHint")}</p>
        {error ? (
          <div className="read-aloud-error" role="alert">
            <p>{error}</p>
          </div>
        ) : null}
      </div>
      <div
        className="read-aloud-popover-body"
        role="tabpanel"
        id={`${id}-read-panel`}
        aria-labelledby={`${id}-read-tab`}
        hidden={tab !== "read"}
        tabIndex={0}
      >
        {readAloudContent}
      </div>
    </>
  );
}
