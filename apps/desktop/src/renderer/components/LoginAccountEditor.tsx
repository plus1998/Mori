import { useId, useState, type ReactNode } from "react";
import { Copy, Eye, EyeOff, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OpenAIAccountProxyMode } from "../../shared/openai-account";
import "./openai-account-cards.css";

export function LoginAccountEditor({
  editing,
  name,
  onNameChange,
  mode,
  proxyUrl,
  onModeChange,
  onProxyUrlChange,
  busy,
  error,
  onClose,
  profileFields,
  children,
  actions,
}: {
  editing: boolean;
  name: string;
  onNameChange: (name: string) => void;
  mode: OpenAIAccountProxyMode;
  proxyUrl: string;
  onModeChange: (mode: OpenAIAccountProxyMode) => void;
  onProxyUrlChange: (value: string) => void;
  busy: boolean;
  error?: string | undefined;
  onClose: () => void;
  profileFields?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <div className="settings-modal-backdrop">
      <button type="button" className="settings-modal-backdrop-close" aria-label={t("common.close")} onClick={onClose} disabled={busy} />
      <div className="settings-modal settings-modal-provider-editor codex-account-editor" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="settings-modal-header">
          <h2 className="settings-modal-title" id={titleId}>
            {t(editing ? "settings.openaiAccounts.editAccount" : "settings.openaiAccounts.addAccount")}
          </h2>
          <div className="settings-modal-header-actions">
            <button type="button" className="mcp-icon-button" aria-label={t("common.close")} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="settings-modal-body openai-account-modal-body">
          {error ? <div className="codex-account-sync-error" role="alert">{error}</div> : null}
          <label className="mcp-field">
            <span className="mcp-field-label">{t("settings.openaiAccounts.name")}</span>
            <input className="mcp-field-input" type="text" value={name}
              placeholder={t("settings.openaiAccounts.namePlaceholder")} onChange={event => onNameChange(event.target.value)} autoFocus />
          </label>
          {profileFields}
          <LoginAccountProxyFields mode={mode} proxyUrl={proxyUrl} disabled={busy}
            onModeChange={onModeChange} onProxyUrlChange={onProxyUrlChange} />
          {children}
        </div>
        <footer className="settings-modal-footer settings-modal-footer-split">
          <button type="button" className="settings-modal-cancel" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <div className="settings-modal-footer-actions">{actions}</div>
        </footer>
      </div>
    </div>
  );
}

export function LoginAccountProxyFields({
  mode,
  proxyUrl,
  onModeChange,
  onProxyUrlChange,
  disabled = false,
}: {
  mode: OpenAIAccountProxyMode;
  proxyUrl: string;
  onModeChange: (mode: OpenAIAccountProxyMode) => void;
  onProxyUrlChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const options: Array<{ mode: OpenAIAccountProxyMode; label: string; hint: string }> = [
    {
      mode: "system",
      label: t("settings.openaiAccounts.proxyModeSystem"),
      hint: t("settings.openaiAccounts.proxyModeSystemHint"),
    },
    {
      mode: "direct",
      label: t("settings.openaiAccounts.proxyModeDirect"),
      hint: t("settings.openaiAccounts.proxyModeDirectHint"),
    },
    {
      mode: "manual",
      label: t("settings.openaiAccounts.proxyModeManual"),
      hint: t("settings.openaiAccounts.proxyModeManualHint"),
    },
  ];
  const selected = options.find((option) => option.mode === mode) ?? options[0]!;
  return (
    <div className="openai-proxy-fields">
      <span className="mcp-field-label">{t("settings.openaiAccounts.proxyMode")}</span>
      <div
        className="openai-proxy-mode-toggle"
        role="radiogroup"
        aria-label={t("settings.openaiAccounts.proxyMode")}
      >
        {options.map((option) => (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={option.mode === mode}
            className={option.mode === mode ? "is-active" : ""}
            disabled={disabled}
            onClick={() => onModeChange(option.mode)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mcp-field-hint">{selected.hint}</p>
      {mode === "manual" ? (
        <label className="mcp-field openai-manual-proxy-field">
          <span className="mcp-field-label">{t("settings.openaiAccounts.proxyUrl")}</span>
          <input
            className="mcp-field-input"
            type="url"
            value={proxyUrl}
            placeholder="http://127.0.0.1:7890"
            disabled={disabled}
            onChange={(event) => onProxyUrlChange(event.target.value)}
          />
        </label>
      ) : null}
    </div>
  );
}

function ProfileSecretInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <label className="mcp-field">
      <span className="mcp-field-label">{label}</span>
      <div className="openai-secret-field">
        <input
          className="mcp-field-input"
          type={visible ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" className="mcp-icon-button" aria-label={visible ? t("common.hideValue") : t("common.showValue")} onClick={() => setVisible((shown) => !shown)}>
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        <button type="button" className="mcp-icon-button" aria-label={t("common.copyNamed", { name: label })} disabled={!value} onClick={() => void navigator.clipboard.writeText(value)}>
          <Copy size={14} />
        </button>
      </div>
    </label>
  );
}

export function LoginAccountProfileFields({
  email,
  pickupUrl,
  secrets,
  onEmailChange,
  onPickupUrlChange,
}: {
  email: string;
  pickupUrl: string;
  secrets?: {
    password: string;
    twoFactorSecret: string;
    instanceKey: string;
    onPasswordChange: (value: string) => void;
    onTwoFactorSecretChange: (value: string) => void;
  };
  onEmailChange: (value: string) => void;
  onPickupUrlChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="openai-profile-fields">
      <legend>
        {t("settings.openaiAccounts.profileLegend")} <span>{t("settings.openaiAccounts.optionalBadge")}</span>
      </legend>
      {secrets && <p>{t("settings.openaiAccounts.profileHint")}</p>}
      <div className="openai-profile-grid">
      <label className="mcp-field openai-profile-wide">
        <span className="mcp-field-label">{t("settings.openaiAccounts.emailField")}</span>
        <input className="mcp-field-input" type="email" autoComplete="off" value={email} onChange={(event) => onEmailChange(event.target.value)} placeholder="name@example.com" />
      </label>
      {secrets && <>
        <ProfileSecretInput key={`password-${secrets.instanceKey}`} label={t("settings.openaiAccounts.passwordField")} value={secrets.password} onChange={secrets.onPasswordChange} />
        <ProfileSecretInput key={`twofa-${secrets.instanceKey}`} label={t("settings.openaiAccounts.twoFactorField")} value={secrets.twoFactorSecret} onChange={secrets.onTwoFactorSecretChange} placeholder="Base32" />
      </>}
      <label className="mcp-field openai-profile-wide">
        <span className="mcp-field-label">{t("settings.openaiAccounts.pickupField")}</span>
        <input className="mcp-field-input" type="url" value={pickupUrl} onChange={(event) => onPickupUrlChange(event.target.value)} placeholder="https://example.com" />
      </label>
      </div>
    </fieldset>
  );
}
