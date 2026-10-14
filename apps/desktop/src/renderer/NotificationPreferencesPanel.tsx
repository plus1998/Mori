import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { BASH_REVIEW_MODES, type BashReviewMode, isBashReviewMode } from "../shared/bash-review-ui";
import type { FollowUpDeliveryMode } from "../shared/ipc";
import type { AppLocalePreference } from "../shared/locale";
import {
  type NotificationSettingsSnapshot,
  TURN_COMPLETION_NOTIFY_MODES,
  type TurnCompletionNotifyMode,
} from "../shared/notification-settings";
import {
  THINKING_DISPLAY_MODES,
  type ThinkingDisplayMode,
} from "./thinking-display-preferences";
import {
  TOKEN_SPEED_DISPLAY_MODES,
  type TokenSpeedDisplayMode,
} from "./token-speed-preferences";

interface NotificationPreferencesPanelProps {
  settings: NotificationSettingsSnapshot;
  onSave: (settings: NotificationSettingsSnapshot) => Promise<void>;
  localePreference: AppLocalePreference;
  onLocalePreferenceChange: (preference: AppLocalePreference) => void;
  cacheBreakTipsEnabled: boolean;
  onCacheBreakTipsEnabledChange: (enabled: boolean) => void;
  followUpDeliveryMode: FollowUpDeliveryMode;
  onFollowUpDeliveryModeChange: (mode: FollowUpDeliveryMode) => void | Promise<void>;
  defaultBashReviewMode?: BashReviewMode;
  onDefaultBashReviewModeChange?: (mode: BashReviewMode) => void | Promise<void>;
  showBilling?: boolean;
  onShowBillingChange?: (enabled: boolean) => void | Promise<void>;
  tokenSpeedMode?: TokenSpeedDisplayMode;
  onTokenSpeedModeChange?: (mode: TokenSpeedDisplayMode) => void | Promise<void>;
  thinkingDisplayMode?: ThinkingDisplayMode;
  onThinkingDisplayModeChange?: (mode: ThinkingDisplayMode) => void | Promise<void>;
}

const LOCALE_OPTIONS: readonly AppLocalePreference[] = ["system", "zh-CN", "en-US"];
const FOLLOW_UP_DELIVERY_OPTIONS: readonly FollowUpDeliveryMode[] = ["queue", "steer"];

export function NotificationPreferencesPanel({
  settings,
  onSave,
  localePreference,
  onLocalePreferenceChange,
  cacheBreakTipsEnabled,
  onCacheBreakTipsEnabledChange,
  followUpDeliveryMode,
  onFollowUpDeliveryModeChange,
  defaultBashReviewMode = "always",
  onDefaultBashReviewModeChange = () => undefined,
  showBilling = true,
  onShowBillingChange = () => undefined,
  tokenSpeedMode = "hidden",
  onTokenSpeedModeChange = () => undefined,
  thinkingDisplayMode = "ephemeral",
  onThinkingDisplayModeChange = () => undefined,
}: NotificationPreferencesPanelProps) {
  const { t } = useTranslation();
  const turnSelectId = useId();
  const languageSelectId = useId();
  const cacheBreakTipsId = useId();
  const followUpDeliveryId = useId();
  const defaultBashReviewId = useId();
  const billingVisibilityId = useId();
  const tokenSpeedId = useId();
  const thinkingDisplayModeId = useId();
  const permissionId = useId();
  const questionId = useId();
  const [busy, setBusy] = useState(false);
  const [followUpBusy, setFollowUpBusy] = useState(false);
  const [bashReviewBusy, setBashReviewBusy] = useState(false);
  const [bashReviewSelectKey, setBashReviewSelectKey] = useState(0);

  async function save(next: NotificationSettingsSnapshot) {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
    } finally {
      setBusy(false);
    }
  }

  function localeLabel(id: AppLocalePreference): string {
    switch (id) {
      case "system":
        return t("settings.language.system");
      case "zh-CN":
        return t("settings.language.zh");
      case "en-US":
        return t("settings.language.en");
    }
  }

  return (
    <div className="notification-preferences">
      <header className="settings-page-header">
        <h1>{t("settings.preferences")}</h1>
      </header>

      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <span className="settings-section-label">{t("settings.preferences.general")}</span>
          </div>
        </div>

        <ul className="settings-rows">
          <li>
            <label className="notification-settings-row" htmlFor={languageSelectId}>
              <span className="settings-row-main">
                <strong>{t("settings.language")}</strong>
                <small>{t("settings.languageSubtitle")}</small>
              </span>
              <span className="notification-settings-select">
                <select
                  id={languageSelectId}
                  value={localePreference}
                  onChange={(event) => {
                    const next = event.target.value as AppLocalePreference;
                    if (!LOCALE_OPTIONS.includes(next)) {
                      return;
                    }
                    onLocalePreferenceChange(next);
                  }}
                >
                  {LOCALE_OPTIONS.map((id) => (
                    <option key={id} value={id}>
                      {localeLabel(id)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden />
              </span>
            </label>
          </li>

          <li>
            <div className="notification-settings-row">
              <span className="settings-row-main" id={followUpDeliveryId}>
                <strong>{t("settings.followUpDelivery")}</strong>
                <small>{t(followUpDeliveryMode === "queue" ? "settings.followUpDeliveryHint.queue" : "settings.followUpDeliveryHint.steer")}</small>
              </span>
              <div
                className="settings-segmented-control follow-up-delivery-segmented"
                role="group"
                aria-labelledby={followUpDeliveryId}
              >
                {FOLLOW_UP_DELIVERY_OPTIONS.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={followUpDeliveryMode === mode ? "active" : undefined}
                    aria-pressed={followUpDeliveryMode === mode}
                    disabled={followUpBusy}
                    onClick={() => {
                      if (followUpDeliveryMode === mode || followUpBusy) {
                        return;
                      }
                      setFollowUpBusy(true);
                      void Promise.resolve(onFollowUpDeliveryModeChange(mode)).finally(() => {
                        setFollowUpBusy(false);
                      });
                    }}
                  >
                    {t(`settings.followUpDelivery.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          </li>

          <li>
            <label className="notification-settings-row" htmlFor={defaultBashReviewId}>
              <span className="settings-row-main">
                <strong>{t("settings.defaultBashReviewMode")}</strong>
                <small>{t("settings.defaultBashReviewModeHint")}</small>
              </span>
              <span className="notification-settings-select">
                <select
                  key={bashReviewSelectKey}
                  id={defaultBashReviewId}
                  value={defaultBashReviewMode}
                  disabled={bashReviewBusy}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (!isBashReviewMode(next) || next === defaultBashReviewMode || bashReviewBusy) {
                      return;
                    }
                    setBashReviewBusy(true);
                    void Promise.resolve(onDefaultBashReviewModeChange(next)).finally(() => {
                      setBashReviewBusy(false);
                    });
                  }}
                >
                  {BASH_REVIEW_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(
                        mode === "always"
                          ? "bash.review.always"
                          : mode === "auto"
                            ? "bash.review.auto"
                            : "bash.review.allowAll",
                      )}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden />
              </span>
            </label>
          </li>
        </ul>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <span className="settings-section-label">{t("settings.notifications")}</span>
          </div>
        </div>

        <ul className="settings-rows">
          <li>
            <label className="notification-settings-row" htmlFor={turnSelectId}>
              <span className="settings-row-main">
                <strong>{t("settings.notifications.turnCompletion")}</strong>
                <small>{t("settings.notifications.turnCompletionHint")}</small>
              </span>
              <span className="notification-settings-select">
                <select
                  id={turnSelectId}
                  value={settings.turnCompletion}
                  disabled={busy}
                  onChange={(event) => {
                    const turnCompletion = event.target.value as TurnCompletionNotifyMode;
                    if (!TURN_COMPLETION_NOTIFY_MODES.includes(turnCompletion)) {
                      return;
                    }
                    void save({ ...settings, turnCompletion });
                  }}
                >
                  {TURN_COMPLETION_NOTIFY_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`settings.notifications.turnCompletion.${mode}`)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden />
              </span>
            </label>
          </li>

          <li>
            <div className="notification-settings-row">
              <span className="settings-row-main" id={permissionId}>
                <strong>{t("settings.notifications.permission")}</strong>
                <small>{t("settings.notifications.permissionHint")}</small>
              </span>
              <label
                className="composer-switch notification-settings-switch"
                title={t(settings.permissionEnabled ? "composer.enabledNamed" : "composer.disabledNamed", {
                  name: t("settings.notifications.permission"),
                })}
              >
                <input
                  type="checkbox"
                  checked={settings.permissionEnabled}
                  disabled={busy}
                  aria-labelledby={permissionId}
                  onChange={(event) => void save({ ...settings, permissionEnabled: event.target.checked })}
                />
                <span className="composer-switch-track" aria-hidden />
              </label>
            </div>
          </li>

          <li>
            <div className="notification-settings-row">
              <span className="settings-row-main" id={questionId}>
                <strong>{t("settings.notifications.question")}</strong>
                <small>{t("settings.notifications.questionHint")}</small>
              </span>
              <label
                className="composer-switch notification-settings-switch"
                title={t(settings.questionEnabled ? "composer.enabledNamed" : "composer.disabledNamed", {
                  name: t("settings.notifications.question"),
                })}
              >
                <input
                  type="checkbox"
                  checked={settings.questionEnabled}
                  disabled={busy}
                  aria-labelledby={questionId}
                  onChange={(event) => void save({ ...settings, questionEnabled: event.target.checked })}
                />
                <span className="composer-switch-track" aria-hidden />
              </label>
            </div>
          </li>
        </ul>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <span className="settings-section-label">{t("settings.preferences.display")}</span>
          </div>
        </div>

        <ul className="settings-rows">
          <li>
            <div className="notification-settings-row">
              <span className="settings-row-main" id={billingVisibilityId}>
                <strong>{t("settings.showBilling")}</strong>
                <small>{t("settings.showBillingHint")}</small>
              </span>
              <label
                className="composer-switch notification-settings-switch"
                title={t(showBilling ? "composer.enabledNamed" : "composer.disabledNamed", {
                  name: t("settings.showBilling"),
                })}
              >
                <input
                  type="checkbox"
                  checked={showBilling}
                  aria-labelledby={billingVisibilityId}
                  onChange={(event) => void onShowBillingChange(event.target.checked)}
                />
                <span className="composer-switch-track" aria-hidden />
              </label>
            </div>
          </li>

          <li>
            <div className="notification-settings-row">
              <span className="settings-row-main" id={tokenSpeedId}>
                <strong>{t("settings.tokenSpeed")}</strong>
                <small>{t(`settings.tokenSpeed.${tokenSpeedMode}Hint`)}</small>
              </span>
              <div
                className="settings-segmented-control token-speed-mode-segmented"
                role="group"
                aria-labelledby={tokenSpeedId}
              >
                {TOKEN_SPEED_DISPLAY_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={tokenSpeedMode === mode ? "active" : undefined}
                    aria-pressed={tokenSpeedMode === mode}
                    onClick={() => {
                      if (tokenSpeedMode === mode) {
                        return;
                      }
                      void onTokenSpeedModeChange(mode);
                    }}
                  >
                    {t(`settings.tokenSpeed.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          </li>

          <li>
            <div className="notification-settings-row">
              <span className="settings-row-main" id={thinkingDisplayModeId}>
                <strong>{t("settings.thinkingContentDefault")}</strong>
                <small>{t(`settings.thinkingContentDefault.${thinkingDisplayMode}Hint`)}</small>
              </span>
              <div
                className="settings-segmented-control thinking-content-default-segmented"
                role="group"
                aria-labelledby={thinkingDisplayModeId}
              >
                {THINKING_DISPLAY_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={thinkingDisplayMode === mode ? "active" : undefined}
                    aria-pressed={thinkingDisplayMode === mode}
                    onClick={() => {
                      if (thinkingDisplayMode === mode) {
                        return;
                      }
                      void onThinkingDisplayModeChange(mode);
                    }}
                  >
                    {t(`settings.thinkingContentDefault.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          </li>

          <li>
            <div className="notification-settings-row">
              <span className="settings-row-main" id={cacheBreakTipsId}>
                <strong>{t("settings.cacheBreakTips")}</strong>
                <small>{t("settings.cacheBreakTipsHint")}</small>
              </span>
              <label
                className="composer-switch notification-settings-switch"
                title={t(cacheBreakTipsEnabled ? "composer.enabledNamed" : "composer.disabledNamed", {
                  name: t("settings.cacheBreakTips"),
                })}
              >
                <input
                  type="checkbox"
                  checked={cacheBreakTipsEnabled}
                  aria-labelledby={cacheBreakTipsId}
                  onChange={(event) => onCacheBreakTipsEnabledChange(event.target.checked)}
                />
                <span className="composer-switch-track" aria-hidden />
              </label>
            </div>
          </li>
        </ul>
      </section>
    </div>
  );
}
