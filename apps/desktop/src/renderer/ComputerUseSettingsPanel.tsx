import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import "./capability-settings.css";
import { SettingsButton, SettingsSelect } from "./components/SettingsControls";
import { SettingsPage, SettingsSection } from "./components/SettingsPage";
import { Switch } from "./components/Switch";
import { AlertTriangle, CheckCircle, ChevronDown, Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ComputerUseActionApprovalMode, ComputerUseSettingsSnapshot } from "../shared/computer-use";
import { PACKAGED_SCREEN_RECORDING_APP_LABEL } from "../shared/computer-use-screen-host";

interface ComputerUseDoctorResult {
  ok: boolean;
  /** True when the package's onboarding window was launched (macOS accessibility missing). */
  onboardingLaunched: boolean;
  /** True when Eco opened Screen Recording prefs (host screen TCC missing). */
  screenPromptOpened?: boolean;
  screenRecordingAppLabel?: string;
  reason?: string;
  output?: string;
  /** Diagnostics when the launched onboarding process failed or exited. */
  onboardingError?: string;
  missing?: string[];
}

interface DoctorStatus {
  kind: "ok" | "error";
  text: string;
}

interface ComputerUseSettingsPanelProps {
  settings: ComputerUseSettingsSnapshot;
  availability?: { available: boolean; reason?: string };
  onSave: (settings: ComputerUseSettingsSnapshot) => Promise<void>;
  onRunDoctor?: () => Promise<ComputerUseDoctorResult>;
  onCheckPermissionStatus?: () => Promise<{ ok: boolean; missing: string[] }>;
}

const PERMISSION_POLL_INTERVAL_MS = 3_000;

const ACTION_APPROVAL_OPTIONS: ComputerUseActionApprovalMode[] = ["always_ask", "always_allow"];

function resolveScreenRecordingAppLabel(explicit?: string): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  const fromPreload = typeof window !== "undefined" ? window.eco?.screenRecordingAppLabel?.trim() : undefined;
  if (fromPreload) {
    return fromPreload;
  }
  return typeof window !== "undefined" && window.eco?.isPackaged === true
    ? PACKAGED_SCREEN_RECORDING_APP_LABEL
    : "Electron";
}

function computerUseDoctorHint(
  t: (key: string, options?: Record<string, string>) => string,
  options: {
    platform: string | undefined;
    missing?: string[];
    screenApp: string;
  },
): string {
  if (options.platform === "win32") return t("settings.computerUse.doctorHintWindows");
  if (options.platform === "linux") return t("settings.computerUse.doctorHintLinux");
  const missing = options.missing ?? [];
  const screenApp = options.screenApp;
  const needsAccessibility = missing.includes("accessibility");
  const needsScreen = missing.includes("screenRecording");
  if (needsAccessibility && needsScreen) {
    return t("settings.computerUse.doctorHintBoth", { screenApp });
  }
  if (needsAccessibility) {
    return t("settings.computerUse.doctorHintAccessibility");
  }
  if (needsScreen) {
    return t("settings.computerUse.doctorHintScreen", { screenApp });
  }
  return t("settings.computerUse.doctorOnboardingHint", { screenApp });
}

export function ComputerUseSettingsPanel({
  settings,
  availability,
  onSave,
  onRunDoctor,
  onCheckPermissionStatus,
}: ComputerUseSettingsPanelProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [doctorStatus, setDoctorStatus] = useState<DoctorStatus | undefined>();
  const pollTimerRef = useRef<number | undefined>(undefined);
  const hostPlatform = typeof window !== "undefined" ? window.eco?.platform : undefined;
  const screenApp = resolveScreenRecordingAppLabel();

  function stopPermissionPolling() {
    if (pollTimerRef.current !== undefined) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = undefined;
    }
  }

  useEffect(() => stopPermissionPolling, []);

  const unavailable = settings.agentIntegrationEnabled && availability?.available === false;
  const unavailableReason = availability?.reason ?? t("settings.computerUse.agentUnknownReason");

  async function save(next: ComputerUseSettingsSnapshot) {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
      stopPermissionPolling();
      setDoctorStatus(undefined);
    } catch (error) {
      // Master switch on while permissions are missing throws with guidance;
      // surface it here (the onboarding window is opened by the main process).
      setDoctorStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function runDoctor() {
    if (!onRunDoctor || doctorBusy) {
      return;
    }
    stopPermissionPolling();
    setDoctorBusy(true);
    try {
      const result = await onRunDoctor();
      if (result.ok) {
        setDoctorStatus({ kind: "ok", text: t("settings.computerUse.doctorOk") });
        return;
      }
      const hintScreenApp = resolveScreenRecordingAppLabel(result.screenRecordingAppLabel);
      const hint = computerUseDoctorHint(
        (key, options) => (options === undefined ? t(key) : t(key, options)),
        {
          platform: hostPlatform,
          ...(result.missing === undefined ? {} : { missing: result.missing }),
          screenApp: hintScreenApp,
        },
      );
      const remediating = result.onboardingLaunched || Boolean(result.screenPromptOpened);
      if (remediating) {
        setDoctorStatus({
          kind: "error",
          text: `${hint} ${t("settings.computerUse.waitingForPermissions")}`,
        });
        if (onCheckPermissionStatus) {
          pollTimerRef.current = window.setInterval(() => {
            void onCheckPermissionStatus().then((status) => {
              if (status.ok) {
                stopPermissionPolling();
                setDoctorStatus({ kind: "ok", text: t("settings.computerUse.doctorOk") });
              }
            });
          }, PERMISSION_POLL_INTERVAL_MS);
        }
        return;
      }
      setDoctorStatus({
        kind: "error",
        text: result.onboardingError ? `${hint} ${result.onboardingError}` : hint,
      });
    } catch (error) {
      setDoctorStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setDoctorBusy(false);
    }
  }

  const unavailableText = t("settings.computerUse.statusUnavailable", { reason: unavailableReason });
  const status =
    doctorStatus ?? (unavailable ? { kind: "error" as const, text: unavailableText } : undefined);

  return (
    <SettingsPage
      className="browser-settings capability-settings-page"
      title={t("settings.computerUse")}
      description={t("settings.computerUse.pageDesc")}
    >
      <SettingsGroup>
        <SettingsRow
          label={t("settings.computerUse.masterTitle")}
          description={t("settings.computerUse.masterHint")}
          control={(controlProps) => (
            <Switch
              {...controlProps}
              title={t(
                settings.agentIntegrationEnabled ? "composer.enabledNamed" : "composer.disabledNamed",
                {
                  name: t("settings.computerUse.masterTitle"),
                },
              )}
              checked={settings.agentIntegrationEnabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                void save({
                  ...settings,
                  agentIntegrationEnabled: checked,
                })
              }
            />
          )}
        />
      </SettingsGroup>

      <p className="computer-use-note" role="note">
        <Info size={13} aria-hidden />
        {t("settings.computerUse.sharedDesktopWarning")}
      </p>

      {status || onRunDoctor ? (
        <div className="computer-use-status">
          {status ? (
            <div
              className={
                status.kind === "ok"
                  ? "computer-use-alert computer-use-alert-ok"
                  : "computer-use-alert computer-use-alert-error"
              }
              role="status"
            >
              {status.kind === "ok" ? (
                <CheckCircle size={14} aria-hidden />
              ) : (
                <AlertTriangle size={14} aria-hidden />
              )}
              <p>{status.text}</p>
            </div>
          ) : null}
          {onRunDoctor ? (
            <SettingsButton
              variant="secondary"
              type="button"
              disabled={doctorBusy || busy}
              onClick={() => void runDoctor()}
            >
              {doctorBusy ? t("settings.computerUse.doctorBusy") : t("settings.computerUse.runDoctor")}
            </SettingsButton>
          ) : null}
        </div>
      ) : null}

      {settings.agentIntegrationEnabled ? (
        <SettingsSection title={t("settings.computerUse.permissions")}>
          <SettingsGroup>
            <SettingsRow
              label={t("settings.computerUse.actionApproval")}
              description={t("settings.computerUse.actionApprovalHint")}
              stackControlOnNarrow
              control={(controlProps) => (
                <label className="browser-settings-select">
                  <span className="sr-only">{t("settings.computerUse.actionApproval")}</span>
                  <SettingsSelect
                    {...controlProps}
                    variant="inline"
                    value={settings.actionApprovalMode}
                    disabled={busy}
                    onChange={(event) =>
                      void save({
                        ...settings,
                        actionApprovalMode: event.target.value as ComputerUseActionApprovalMode,
                      })
                    }
                  >
                    {ACTION_APPROVAL_OPTIONS.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`settings.computerUse.actionApproval.${mode}`)}
                      </option>
                    ))}
                  </SettingsSelect>
                  <ChevronDown
                    size={14}
                    strokeWidth={2}
                    aria-hidden
                    className="browser-settings-select-chevron"
                  />
                </label>
              )}
            />
          </SettingsGroup>
        </SettingsSection>
      ) : null}

      {hostPlatform === "darwin" ? (
        <p className="computer-use-note" role="note">
          <Info size={13} aria-hidden />
          {t("settings.computerUse.screenRecordingHostNote", { screenApp })}
        </p>
      ) : null}
    </SettingsPage>
  );
}
