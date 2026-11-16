import {
  ArrowRight,
  Check,
  CheckCircle2,
  Cloud,
  Laptop,
  Loader2,
  Monitor,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { CodexSharingSnapshot } from "../../shared/codex-account-sharing";
import { canUseOpenAIAccountCredentials, type OpenAIAccount } from "../../shared/openai-account";
import "./codex-account-sharing.css";

export function CodexAccountSharingDialog({
  accounts,
  initialAccountId,
  onClose,
  onOpenConnection,
}: {
  accounts: OpenAIAccount[];
  initialAccountId: string | null;
  onClose: () => void;
  onOpenConnection?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const localAccounts = accounts.filter((a) => !a.sharedSource);
  const [accountId, setAccountId] = useState(
    () =>
      initialAccountId ??
      localAccounts.find(canUseOpenAIAccountCredentials)?.id ??
      localAccounts[0]?.id ??
      "",
  );
  const [snapshot, setSnapshot] = useState<CodexSharingSnapshot>();
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const formKey = useRef("");
  const selectedAccount = localAccounts.find((a) => a.id === accountId);
  const devices = snapshot?.devices.filter((d) => d.id !== snapshot.deviceId) ?? [];

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
      dialog.current?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const api = window.eco;
      if (!api) throw new Error("桌面服务尚未就绪。");
      const next = await api.openAIAccountsSharingGet();
      if (!mounted.current) return;
      setSnapshot(next);
      setError("");
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!snapshot) return;
    const key = `${snapshot.deviceId}:${accountId}`;
    if (formKey.current === key && dirty) return;
    formKey.current = key;
    setSelected(
      snapshot.shares
        .filter((s) => s.ownerDeviceId === snapshot.deviceId && s.accountId === accountId && !s.revokedAt)
        .map((s) => s.recipientDeviceId),
    );
  }, [snapshot, accountId, dirty]);

  async function save() {
    if (!accountId || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const available = new Set(devices.map((d) => d.id));
      const recipients = selected.filter((id) => available.has(id));
      const api = window.eco;
      if (!api) throw new Error("桌面服务尚未就绪。");
      const next = await api.openAIAccountsSharingSave(accountId, recipients);
      if (!mounted.current) return;
      setSnapshot(next);
      setDirty(false);
      setNotice(t(recipients.length ? "codexShare.saved" : "codexShare.savedStop"));
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="codex-sharing-dialog"
      aria-label={t("codexShare.title")}
      onCancel={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="codex-sharing-surface">
        <header className="codex-sharing-header">
          <div>
            <h2 id="codex-sharing-title">{t("codexShare.title")}</h2>
            <p>{t("codexShare.intro")}</p>
          </div>
          <button type="button" className="mcp-icon-button" aria-label={t("common.close")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="codex-sharing-body">
          {loading && !snapshot ? (
            <div className="codex-sharing-empty" role="status">
              <Loader2 size={22} className="mcp-spin" />
              {t("common.loading")}
            </div>
          ) : !snapshot ? (
            <div className="codex-sharing-empty" role="alert">
              <strong>{t("codexShare.loadFailed")}</strong>
              <p>{error}</p>
              <button type="button" className="codex-action-secondary" onClick={() => void refresh()}>
                {t("common.retry")}
              </button>
            </div>
          ) : !snapshot.connected ? (
            <div className="codex-sharing-empty">
              <Cloud size={28} />
              <strong>{t("codexShare.disconnected")}</strong>
              <p>{t("codexShare.disconnectedHint")}</p>
              {onOpenConnection ? (
                <button
                  type="button"
                  className="settings-primary-button"
                  onClick={() => {
                    onClose();
                    onOpenConnection();
                  }}
                >
                  {t("codexShare.openConnection")}
                  <ArrowRight size={14} />
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <div className="codex-sharing-host">
                <div className="codex-sharing-host-icon">
                  <Monitor size={23} />
                </div>
                <div>
                  <span>{t("codexShare.host")}</span>
                  <strong>{snapshot.deviceName}</strong>
                </div>
                <span className="codex-sharing-presence is-online">
                  <i />
                  {t("codexShare.online")}
                </span>
              </div>
              <p className="codex-sharing-host-hint">{t("codexShare.hostHint")}</p>
              {localAccounts.length === 0 ? (
                <div className="codex-sharing-empty">
                  <strong>{t("codexShare.noAccounts")}</strong>
                  <p>{t("codexShare.noAccountsHint")}</p>
                </div>
              ) : (
                <>
                  <label className="codex-sharing-account">
                    <span>{t("codexShare.account")}</span>
                    <select
                      value={accountId}
                      disabled={saving}
                      onChange={(e) => {
                        setAccountId(e.target.value);
                        setDirty(false);
                        setNotice("");
                        setError("");
                      }}
                    >
                      {localAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="codex-sharing-section-heading">
                    <strong>{t("codexShare.recipients")}</strong>
                    <button
                      type="button"
                      className="mcp-icon-button"
                      aria-label={t("common.refresh")}
                      disabled={loading || saving}
                      onClick={() => void refresh()}
                    >
                      <RefreshCw size={14} className={loading ? "mcp-spin" : ""} />
                    </button>
                  </div>
                  <p className="codex-sharing-hint">{t("codexShare.recipientsHint")}</p>
                  {devices.length === 0 ? (
                    <div className="codex-sharing-empty is-compact">
                      <Laptop size={25} />
                      <strong>{t("codexShare.noDevices")}</strong>
                      <p>{t("codexShare.noDevicesHint")}</p>
                    </div>
                  ) : (
                    <div className="codex-sharing-devices">
                      {devices.map((device) => (
                        <label
                          key={device.id}
                          className={`codex-sharing-device ${selected.includes(device.id) ? "is-selected" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={selected.includes(device.id)}
                            disabled={saving || Boolean(snapshot.error)}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setSelected((previous) =>
                                checked
                                  ? [...previous, device.id]
                                  : previous.filter((id) => id !== device.id),
                              );
                              setDirty(true);
                              setNotice("");
                            }}
                          />
                          <span className="codex-sharing-checkbox">
                            <Check size={13} />
                          </span>
                          <Laptop size={19} />
                          <span className="codex-sharing-device-name">{device.name}</span>
                          <span className={`codex-sharing-presence ${device.online ? "is-online" : ""}`}>
                            <i />
                            {t(device.online ? "codexShare.online" : "codexShare.offline")}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
              {snapshot.error ? (
                <p className="codex-sharing-error" role="alert">
                  {snapshot.error}
                </p>
              ) : null}
              {error ? (
                <p className="codex-sharing-error" role="alert">
                  {error}
                </p>
              ) : null}
              {notice ? (
                <p className="codex-sharing-notice" role="status">
                  <CheckCircle2 size={15} />
                  {notice}
                </p>
              ) : null}
            </>
          )}
        </div>
        <footer className="codex-sharing-footer">
          <p>
            <ShieldCheck size={15} />
            {t("codexShare.privacy")}
          </p>
          {snapshot?.connected && localAccounts.length > 0 ? (
            <div>
              <span>
                {selected.length
                  ? t("codexShare.selected", { count: selected.length })
                  : dirty
                    ? t("codexShare.noneSelected")
                    : ""}
              </span>
              <button
                type="button"
                className="settings-primary-button"
                disabled={
                  !snapshot?.connected ||
                  Boolean(snapshot.error) ||
                  !selectedAccount ||
                  !dirty ||
                  saving ||
                  loading
                }
                onClick={() => void save()}
              >
                {saving ? <Loader2 size={14} className="mcp-spin" /> : <Check size={14} />}
                {t("codexShare.save")}
              </button>
            </div>
          ) : null}
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
