import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import { Switch } from "./components/Switch";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BASH_REVIEW_MODES, type BashReviewMode, isBashReviewMode } from "../shared/bash-review-ui";
import type { FollowUpDeliveryMode } from "../shared/ipc";
import type { AppLocalePreference } from "../shared/locale";
import {
  type NotificationSettingsSnapshot,
  TURN_COMPLETION_NOTIFY_MODES,
  type TurnCompletionNotifyMode,
} from "../shared/notification-settings";
import { THINKING_DISPLAY_MODES, type ThinkingDisplayMode } from "./thinking-display-preferences";
import { TOKEN_SPEED_DISPLAY_MODES, type TokenSpeedDisplayMode } from "./token-speed-preferences";
import "./settings-form-pages.css";

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
    <div className="notification-preferences settings-form-page">
      <header className="settings-page-header">
        <h1>{t("settings.preferences")}</h1>
      </header>

      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <span className="settings-section-label">{t("settings.preferences.general")}</span>
          </div>
        </div>

        <SettingsGroup>
          <SettingsRow
            label={t("settings.language")}
            description={t("settings.languageSubtitle")}
            stackControlOnNarrow
            control={(controlProps) => (
              <span className="notification-settings-select">
                <select
                  {...controlProps}
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
            )}
          />

          <SettingsRow
            label={t("settings.followUpDelivery")}
            description={t(
              followUpDeliveryMode === "queue"
                ? "settings.followUpDeliveryHint.queue"
                : "settings.followUpDeliveryHint.steer",
            )}
            stackControlOnNarrow
            control={(controlProps) => (
              <span className="notification-settings-select">
                <select
                  {...controlProps}
                  value={followUpDeliveryMode}
                  disabled={followUpBusy}
                  onChange={(event) => {
                    const mode = event.target.value as FollowUpDeliveryMode;
                    if (!FOLLOW_UP_DELIVERY_OPTIONS.includes(mode) || followUpDeliveryMode === mode || followUpBusy)
                      return;
                    setFollowUpBusy(true);
                    void Promise.resolve(onFollowUpDeliveryModeChange(mode)).finally(() => {
                      setFollowUpBusy(false);
                    });
                  }}
                >
                  {FOLLOW_UP_DELIVERY_OPTIONS.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`settings.followUpDelivery.${mode}`)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden />
              </span>
            )}
          />

          <SettingsRow
            label={t("settings.defaultBashReviewMode")}
            description={t("settings.defaultBashReviewModeHint")}
            stackControlOnNarrow
            control={(controlProps) => (
              <span className="notification-settings-select">
                <select
                  key={bashReviewSelectKey}
                  {...controlProps}
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
            )}
          />
        </SettingsGroup>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <span className="settings-section-label">{t("settings.notifications")}</span>
          </div>
        </div>

        <SettingsGroup>
          <SettingsRow
            label={t("settings.notifications.turnCompletion")}
            description={t("settings.notifications.turnCompletionHint")}
            stackControlOnNarrow
            control={(controlProps) => (
              <span className="notification-settings-select">
                <select
                  {...controlProps}
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
            )}
          />

          <SettingsRow
            label={t("settings.notifications.permission")}
            description={t("settings.notifications.permissionHint")}
            control={(controlProps) => (
              <Switch
                {...controlProps}
                title={t(settings.permissionEnabled ? "composer.enabledNamed" : "composer.disabledNamed", {
                  name: t("settings.notifications.permission"),
                })}
                checked={settings.permissionEnabled}
                disabled={busy}
                onCheckedChange={(checked) => void save({ ...settings, permissionEnabled: checked })}
              />
            )}
          />

          <SettingsRow
            label={t("settings.notifications.question")}
            description={t("settings.notifications.questionHint")}
            control={(controlProps) => (
              <Switch
                {...controlProps}
                title={t(settings.questionEnabled ? "composer.enabledNamed" : "composer.disabledNamed", {
                  name: t("settings.notifications.question"),
                })}
                checked={settings.questionEnabled}
                disabled={busy}
                onCheckedChange={(checked) => void save({ ...settings, questionEnabled: checked })}
              />
            )}
          />
        </SettingsGroup>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <span className="settings-section-label">{t("settings.preferences.display")}</span>
          </div>
        </div>

        <SettingsGroup>
          <SettingsRow
            label={t("settings.showBilling")}
            description={t("settings.showBillingHint")}
            control={(controlProps) => (
              <Switch
                {...controlProps}
                title={t(showBilling ? "composer.enabledNamed" : "composer.disabledNamed", {
                  name: t("settings.showBilling"),
                })}
                checked={showBilling}
                onCheckedChange={(checked) => void onShowBillingChange(checked)}
              />
            )}
          />

          <SettingsRow
            label={t("settings.tokenSpeed")}
            description={t(`settings.tokenSpeed.${tokenSpeedMode}Hint`)}
            stackControlOnNarrow
            control={(controlProps) => (
              <span className="notification-settings-select">
                <select
                  {...controlProps}
                  value={tokenSpeedMode}
                  onChange={(event) => {
                    const mode = event.target.value as TokenSpeedDisplayMode;
                    if (TOKEN_SPEED_DISPLAY_MODES.includes(mode) && tokenSpeedMode !== mode) {
                      void onTokenSpeedModeChange(mode);
                    }
                  }}
                >
                  {TOKEN_SPEED_DISPLAY_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`settings.tokenSpeed.${mode}`)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden />
              </span>
            )}
          />

          <SettingsRow
            label={t("settings.thinkingContentDefault")}
            description={t(`settings.thinkingContentDefault.${thinkingDisplayMode}Hint`)}
            stackControlOnNarrow
            control={(controlProps) => (
              <span className="notification-settings-select">
                <select
                  {...controlProps}
                  value={thinkingDisplayMode}
                  onChange={(event) => {
                    const mode = event.target.value as ThinkingDisplayMode;
                    if (THINKING_DISPLAY_MODES.includes(mode) && thinkingDisplayMode !== mode) {
                      void onThinkingDisplayModeChange(mode);
                    }
                  }}
                >
                  {THINKING_DISPLAY_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`settings.thinkingContentDefault.${mode}`)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden />
              </span>
            )}
          />

          <SettingsRow
            label={t("settings.cacheBreakTips")}
            description={t("settings.cacheBreakTipsHint")}
            control={(controlProps) => (
              <Switch
                {...controlProps}
                title={t(cacheBreakTipsEnabled ? "composer.enabledNamed" : "composer.disabledNamed", {
                  name: t("settings.cacheBreakTips"),
                })}
                checked={cacheBreakTipsEnabled}
                onCheckedChange={(checked) => onCacheBreakTipsEnabledChange(checked)}
              />
            )}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}
