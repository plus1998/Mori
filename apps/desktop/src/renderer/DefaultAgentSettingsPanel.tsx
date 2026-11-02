import type { CoreKind } from "@eco/runtime/core-runtime";
import { Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CursorModelOption } from "../shared/ipc";
import { AcpModelSettingsDialog } from "./AcpModelSettingsDialog";

interface DefaultAgentSettingsPanelProps {
  defaultCoreKind: CoreKind;
  codexAvailable: boolean;
  codexUnavailableReason?: string;
  piAvailable?: boolean;
  piUnavailableReason?: string;
  cursorAvailable?: boolean;
  cursorUnavailableReason?: string;
  cursorProbeLoading?: boolean;
  acpCursorModelId?: string | undefined;
  acpCursorApiKeyConfigured?: boolean;
  cursorModels?: CursorModelOption[];
  cursorModelsLoading?: boolean;
  cursorModelsError?: string;
  onAcpCursorModelChange?: (modelId: string | undefined) => void;
  onManageCursorApiKeys?: () => void;
  onRefreshCursorModels?: () => void;
  busy?: boolean;
  onChange: (coreKind: CoreKind) => void;
  /** Test-only: start with the model settings dialog open. */
  initialModelSettingsOpen?: boolean;
}

function AcpCoreTag({ label }: { label: string }) {
  return (
    <span className="sidebar-core-acp-tag" aria-hidden="true">
      {label}
    </span>
  );
}

export function DefaultAgentSettingsPanel({
  defaultCoreKind,
  codexAvailable,
  codexUnavailableReason,
  piAvailable = true,
  piUnavailableReason,
  cursorAvailable = true,
  cursorUnavailableReason,
  cursorProbeLoading = false,
  acpCursorModelId,
  acpCursorApiKeyConfigured = false,
  cursorModels = [],
  cursorModelsLoading = false,
  cursorModelsError,
  onAcpCursorModelChange,
  onManageCursorApiKeys,
  onRefreshCursorModels,
  busy,
  onChange,
  initialModelSettingsOpen = false,
}: DefaultAgentSettingsPanelProps) {
  const { t } = useTranslation();
  const [modelSettingsOpen, setModelSettingsOpen] = useState(initialModelSettingsOpen);
  const runtimeOptions = [
    {
      kind: "claude" as const,
      label: "Claude Code",
      description: t("settings.defaultAgent.claudeDescription"),
      iconSrc: "./agent-icons/claude-code.ico",
    },
    {
      kind: "codex" as const,
      label: "Codex",
      description: t("settings.defaultAgent.codexDescription"),
      iconSrc: "./agent-icons/codex.ico",
    },
    {
      kind: "pi" as const,
      label: "π",
      description: t("settings.defaultAgent.piDescription"),
      iconSrc: "./agent-icons/pi.svg",
    },
  ];
  const acpSelected = defaultCoreKind === "acp";
  const cursorDescription = cursorProbeLoading
    ? t("settings.defaultAgent.cursorProbing")
    : !cursorAvailable && cursorUnavailableReason
      ? cursorUnavailableReason
      : t("settings.defaultAgent.cursorDescription");

  return (
    <>
      <header className="settings-page-header">
        <h1>{t("settings.defaultAgent")}</h1>
      </header>

      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <span className="settings-section-label">{t("settings.defaultAgent.runtimeSection")}</span>
            <p className="settings-section-subtitle">{t("settings.defaultAgent.runtimeSubtitle")}</p>
          </div>
        </div>

        <div
          className="default-agent-options"
          role="radiogroup"
          aria-label={t("settings.defaultAgent.runtimeSection")}
        >
          {runtimeOptions.map((option) => {
            const selected = option.kind === defaultCoreKind;
            const unavailable =
              (option.kind === "codex" && !codexAvailable) || (option.kind === "pi" && !piAvailable);
            const unavailableReason =
              option.kind === "codex"
                ? codexUnavailableReason
                : option.kind === "pi"
                  ? piUnavailableReason
                  : undefined;
            return (
              <label
                key={option.kind}
                className={selected ? "default-agent-option is-selected" : "default-agent-option"}
                title={unavailable ? unavailableReason : undefined}
              >
                <input
                  type="radio"
                  name="default-agent"
                  value={option.kind}
                  checked={selected}
                  disabled={busy || unavailable}
                  onChange={() => onChange(option.kind)}
                />
                <span className="default-agent-option-icon" aria-hidden>
                  <img src={option.iconSrc} alt="" />
                </span>
                <span className="default-agent-option-body">
                  <strong>{option.label}</strong>
                  <small>
                    {unavailable
                      ? unavailableReason || t("settings.defaultAgent.unavailable")
                      : option.description}
                  </small>
                </span>
                <span className="default-agent-option-state" aria-hidden>
                  {selected ? <Check size={15} /> : null}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="settings-section default-agent-acp-section">
        <div className="settings-section-head">
          <div>
            <span className="settings-section-label">{t("settings.defaultAgent.acpSection")}</span>
            <p className="settings-section-subtitle">{t("settings.defaultAgent.acpSubtitle")}</p>
          </div>
        </div>

        <div
          className="default-agent-options"
          role="radiogroup"
          aria-label={t("settings.defaultAgent.acpSection")}
        >
          <label
            className={acpSelected ? "default-agent-option is-selected" : "default-agent-option"}
            title={
              cursorProbeLoading
                ? t("settings.defaultAgent.cursorProbing")
                : !cursorAvailable
                  ? cursorUnavailableReason
                  : undefined
            }
          >
            <input
              type="radio"
              name="default-agent"
              value="acp"
              checked={acpSelected}
              disabled={busy}
              onChange={() => onChange("acp")}
            />
            <span className="default-agent-option-icon" aria-hidden>
              <img src="./agent-icons/cursor.ico" alt="" />
            </span>
            <span className="default-agent-option-body">
              <strong className="default-agent-option-title">
                <span>Cursor</span>
                <AcpCoreTag label={t("settings.defaultAgent.acpLabel")} />
              </strong>
              <small>{cursorDescription}</small>
            </span>
            <span className="default-agent-option-state" aria-hidden>
              {acpSelected ? <Check size={15} /> : null}
            </span>
          </label>
        </div>

        {acpSelected ? (
          <>
            <button
              type="button"
              className="default-agent-model-entry"
              onClick={() => {
                setModelSettingsOpen(true);
                onRefreshCursorModels?.();
              }}
            >
              {t("settings.defaultAgent.modelSettings")}
            </button>
            <button
              type="button"
              className="default-agent-model-entry"
              onClick={onManageCursorApiKeys}
            >
              {t("settings.defaultAgent.cursorApiKey")}
              {" · "}
              <span
                className={
                  acpCursorApiKeyConfigured ? "default-agent-acp-key-state is-set" : "default-agent-acp-key-state"
                }
              >
                {acpCursorApiKeyConfigured
                  ? t("settings.defaultAgent.cursorApiKeyConfigured")
                  : t("settings.defaultAgent.cursorApiKeyNotSet")}
              </span>
            </button>
          </>
        ) : null}
      </section>

      {modelSettingsOpen ? (
        <AcpModelSettingsDialog
          models={cursorModels}
          {...(acpCursorModelId ? { selectedModelId: acpCursorModelId } : {})}
          loading={cursorModelsLoading}
          {...(cursorModelsError ? { error: cursorModelsError } : {})}
          {...(busy ? { busy } : {})}
          onChange={(modelId) => onAcpCursorModelChange?.(modelId)}
          {...(onRefreshCursorModels ? { onRefresh: onRefreshCursorModels } : {})}
          onClose={() => setModelSettingsOpen(false)}
        />
      ) : null}

    </>
  );
}
