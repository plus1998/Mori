import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Plus,
  Trash2,
  Check,
  Loader2,
  LogIn,
  FileUp,
  Search,
  X,
  Pencil,
  RefreshCw,
  MoreHorizontal,
  Globe2,
  ShieldCheck,
  UserRound,
  Copy,
  Eye,
  EyeOff,
  Mail,
  KeyRound,
  Inbox,
  ChevronDown,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  OpenAIAccount,
  OpenAIAccountDetails,
  OpenAIAccountImageQuota,
  OpenAIAccountProxyMode,
  OpenAIAccountQuota,
  OpenAIAccountQuotaWindow,
  OpenAIAccountSyncStatus,
} from "../../shared/openai-account";
import { type AppLocale, formatAppDateTime } from "../../shared/locale";
import { CodexModelCatalogSection } from "./CodexModelCatalogSection";

type Translate = TFunction<"translation", undefined>;

const CODEX_ACCOUNT_ACTION_MENU_WIDTH = 220;
const MENU_VIEWPORT_MARGIN = 8;

function formatResetTime(window: OpenAIAccountQuotaWindow, fetchedAt: number, t: Translate): string {
  const resetAt = window.resetAt > 0 ? window.resetAt * 1_000 : fetchedAt + window.resetAfterSeconds * 1_000;
  return formatQuotaResetTime(resetAt, t);
}

function formatQuotaResetTime(resetAt: number, t: Translate): string {
  const seconds = Math.ceil((resetAt - Date.now()) / 1_000);
  if (seconds <= 0) return t("settings.openaiAccounts.quotaResetDue");
  if (seconds < 3600) {
    return t("settings.openaiAccounts.quotaResetsIn", { duration: `${Math.ceil(seconds / 60)}m` });
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.ceil((seconds % 3600) / 60);
    return t("settings.openaiAccounts.quotaResetsIn", { duration: m > 0 ? `${h}h ${m}m` : `${h}h` });
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.ceil((seconds % 86400) / 3600);
  return t("settings.openaiAccounts.quotaResetsIn", { duration: h > 0 ? `${d}d ${h}h` : `${d}d` });
}

function QuotaRefreshedAt({ fetchedAt }: { fetchedAt: number }) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language) as AppLocale;
  const refreshedAt = new Date(fetchedAt);
  return (
    <time
      className="codex-quota-refreshed-at"
      dateTime={refreshedAt.toISOString()}
      title={formatAppDateTime(locale, refreshedAt)}
    >
      {t("settings.openaiAccounts.lastRefreshed", {
        time: formatAppDateTime(locale, refreshedAt, {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      })}
    </time>
  );
}

export function OpenAIAccountQuotaSummary({ quota, isLoggedIn, loading, error, showRefreshedAt = true }: {
  quota: OpenAIAccountQuota | undefined;
  isLoggedIn: boolean;
  loading: boolean;
  error: string | undefined;
  showRefreshedAt?: boolean;
}) {
  const { t } = useTranslation();
  if (!quota && !isLoggedIn && !loading && !error) return null;
  return <span className="codex-quota-summary codex-text-quota-summary" aria-busy={loading}>
    {loading ? <Loader2 size={13} className="mcp-spin" aria-label={t("settings.openaiAccounts.refreshingQuotaAria")} /> : null}
    {quota ? <>
      {[quota.rateLimit.primaryWindow, quota.rateLimit.secondaryWindow].map((window, index) => {
        if (!window) return null;
        const remaining = Math.min(100, Math.max(0, 100 - window.usedPercent));
        const tone = remaining <= 10 ? "is-limited" : remaining <= 20 ? "is-low" : "is-ok";
        const label = window.limitWindowSeconds === 604_800
          ? t("settings.openaiAccounts.weeklyQuota")
          : window.limitWindowSeconds > 0
            ? t("settings.openaiAccounts.windowHours", { count: window.limitWindowSeconds / 3_600 })
            : t("settings.openaiAccounts.quotaWindow");
        const remainingText = t("codexSwitch.remaining", { percent: Math.round(remaining) });
        return (
          <span className="codex-quota-window" key={index}>
            <span className="codex-quota-window-heading">
              <span>{label}</span>
              <em className={tone}>{remainingText}</em>
            </span>
            <span
              className={`codex-quota-energy ${tone}`}
              role="meter"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={remaining}
              aria-valuetext={remainingText}
            >
              <span style={{ width: `${remaining}%` }} />
            </span>
            {window.resetAt > 0 || window.resetAfterSeconds > 0 ? <span className="codex-quota-window-reset">{formatResetTime(window, quota.fetchedAt, t)}</span> : null}
          </span>
        );
      })}
      {quota.resetCreditsAvailable > 0 ? <span className="codex-quota-note">{t("settings.openaiAccounts.resetCredits", { count: quota.resetCreditsAvailable })}</span> : null}
      {showRefreshedAt ? <QuotaRefreshedAt fetchedAt={quota.fetchedAt} /> : null}
      {error ? <em className="codex-quota-note is-error" title={error} role="status">{t("settings.openaiAccounts.quotaFailedCached")}</em> : null}
    </> : <span className={error ? "is-error" : undefined} title={error}>{error ? t("settings.openaiAccounts.quotaError") : loading ? t("settings.openaiAccounts.quotaLoading") : t("settings.openaiAccounts.quotaIdle")}</span>}
  </span>;
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

export function OpenAIAccountProxyFields({
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

export function OpenAIAccountImageQuotaSummary({ account, loading, showRefreshedAt = true }: { account: OpenAIAccount; loading: boolean; showRefreshedAt?: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language) as AppLocale;
  const quota: OpenAIAccountImageQuota | undefined = account.imageQuota;
  const resetAt = quota?.status === "available" && quota.resetAt ? Date.parse(quota.resetAt) : undefined;
  return <div className="codex-quota-summary codex-image-quota-summary" aria-busy={loading}>
    {loading ? <Loader2 size={13} className="mcp-spin" aria-label={t("settings.openaiAccounts.imageQuotaLoadingAria")} /> : null}
    <span className="codex-quota-window-heading" title={t("settings.openaiAccounts.imageQuotaTooltip")}>
      <b>{t("settings.openaiAccounts.imageQuotaLabel")}</b>
      {quota?.status === "available" ? (
        <em className={quota.remaining === 0 ? "is-limited" : "is-ok"}>{t("settings.openaiAccounts.imageQuotaRemaining", { total: quota.remaining })}</em>
      ) : <span className={quota?.status === "error" ? "is-error" : undefined} title={quota?.error}>
        {quota?.status === "error" ? t("settings.openaiAccounts.imageQuotaFailed") : t("settings.openaiAccounts.imageQuotaIdle")}
      </span>}
    </span>
    {resetAt !== undefined && Number.isFinite(resetAt) ? <span className="codex-quota-window-reset" title={t("settings.openaiAccounts.imageQuotaRestoresAt", { time: formatAppDateTime(locale, new Date(resetAt)) })}>{formatQuotaResetTime(resetAt, t)}</span> : null}
    {quota && showRefreshedAt ? <QuotaRefreshedAt fetchedAt={quota.fetchedAt} /> : null}
    {quota?.status === "error" ? <span className="codex-image-quota-error is-error" role="alert">{quota.error}</span> : null}
  </div>;
}

export function OpenAIAccountProfileFields({
  email,
  password,
  pickupUrl,
  twoFactorSecret,
  instanceKey,
  onEmailChange,
  onPasswordChange,
  onPickupUrlChange,
  onTwoFactorSecretChange,
}: {
  email: string;
  password: string;
  pickupUrl: string;
  twoFactorSecret: string;
  instanceKey: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onPickupUrlChange: (value: string) => void;
  onTwoFactorSecretChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="openai-profile-fields">
      <legend>
        {t("settings.openaiAccounts.profileLegend")} <span>{t("settings.openaiAccounts.optionalBadge")}</span>
      </legend>
      <p>{t("settings.openaiAccounts.profileHint")}</p>
      <div className="openai-profile-grid">
      <label className="mcp-field openai-profile-wide">
        <span className="mcp-field-label">{t("settings.openaiAccounts.emailField")}</span>
        <input className="mcp-field-input" type="email" autoComplete="off" value={email} onChange={(event) => onEmailChange(event.target.value)} placeholder="name@example.com" />
      </label>
      <ProfileSecretInput key={`password-${instanceKey}`} label={t("settings.openaiAccounts.passwordField")} value={password} onChange={onPasswordChange} />
      <ProfileSecretInput key={`twofa-${instanceKey}`} label={t("settings.openaiAccounts.twoFactorField")} value={twoFactorSecret} onChange={onTwoFactorSecretChange} placeholder="Base32" />
      <label className="mcp-field openai-profile-wide">
        <span className="mcp-field-label">{t("settings.openaiAccounts.pickupField")}</span>
        <input className="mcp-field-input" type="url" value={pickupUrl} onChange={(event) => onPickupUrlChange(event.target.value)} placeholder="https://example.com" />
      </label>
      </div>
    </fieldset>
  );
}

export function OpenAIAccountProfilePresence({ fields }: { fields: OpenAIAccount["profileFields"] }) {
  const { t } = useTranslation();
  return <div className="codex-profile-presence" aria-label={t("settings.openaiAccounts.profilePresenceAria")}>
    {([
      ["email", t("settings.openaiAccounts.emailField"), Mail], ["password", t("settings.openaiAccounts.passwordField"), KeyRound],
      ["twoFactorSecret", t("settings.openaiAccounts.fieldTwoFactor"), ShieldCheck], ["pickupUrl", t("settings.openaiAccounts.fieldPickup"), Inbox],
    ] as const).map(([key, label, Icon]) => <span key={key} className={fields?.[key] ? "is-saved" : ""} title={t(fields?.[key] ? "settings.openaiAccounts.fieldSavedNamed" : "settings.openaiAccounts.fieldUnsavedNamed", { name: label })}><Icon size={12} />{label}</span>)}
  </div>;
}

export function OpenAIAccountSwitchStatus({
  activeAccountId,
  activeAccountName,
  pendingAccountId,
  pendingAccountName,
  busy,
  onCancel,
}: {
  activeAccountId: string | null;
  activeAccountName?: string | undefined;
  pendingAccountId: string | null | undefined;
  pendingAccountName?: string | undefined;
  busy: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const summary = pendingAccountId !== undefined
    ? pendingAccountId === null
      ? t("settings.openaiAccounts.pendingDeactivate")
      : pendingAccountId === activeAccountId
        ? t("settings.openaiAccounts.pendingCredentials", { name: activeAccountName ?? t("settings.openaiAccounts.currentAccountFallback") })
        : t("settings.openaiAccounts.pendingSwitch", { name: pendingAccountName ?? t("settings.openaiAccounts.targetAccountFallback") })
    : activeAccountName
      ? t("settings.openaiAccounts.inUseNamed", { name: activeAccountName })
      : t("settings.openaiAccounts.noCurrentAccount");
  return (
    <>
      <span className="codex-active-summary"><i />{summary}</span>
      {pendingAccountId !== undefined ? (
        <button type="button" className="chatgpt-inline-link" disabled={busy} onClick={onCancel}>
          {pendingAccountId === activeAccountId ? t("settings.openaiAccounts.cancelCredentials") : t("settings.openaiAccounts.cancelSwitch")}
        </button>
      ) : null}
    </>
  );
}

export function OpenAIAccountsPanel({ onError }: { onError: (message: string) => void }) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language) as AppLocale;
  const eco = window.eco;
  const [accounts, setAccounts] = useState<OpenAIAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [pendingAccountId, setPendingAccountId] = useState<string | null | undefined>();
  const [syncStatus, setSyncStatus] = useState<OpenAIAccountSyncStatus>({ state: "ok" });
  const [loadError, setLoadError] = useState<string>();
  const [operationError, setOperationError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "missing">("all");
  const [busy, setBusy] = useState(false);
  const [loggingInId, setLoggingInId] = useState<string | null>(null);
  const [quotaErrors, setQuotaErrors] = useState<Record<string, string>>({});
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaLoadingId, setQuotaLoadingId] = useState<string | null>(null);
  const [imageOperation, setImageOperation] = useState<{ accountId: string; kind: "toggle" | "quota" } | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEditId, setModalEditId] = useState<string | null>(null);
  const [modalName, setModalName] = useState("");
  const [modalProxyMode, setModalProxyMode] = useState<OpenAIAccountProxyMode>("system");
  const [modalProxy, setModalProxy] = useState("");
  const [modalAuthJson, setModalAuthJson] = useState("");
  const [modalEmail, setModalEmail] = useState("");
  const [modalPassword, setModalPassword] = useState("");
  const [modalPickupUrl, setModalPickupUrl] = useState("");
  const [modalTwoFactorSecret, setModalTwoFactorSecret] = useState("");
  const [modalMode, setModalMode] = useState<"login" | "manual">("login");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMessage, setImportMessage] = useState("");

  // Manual auth state for existing accounts
  const [manualAuthId, setManualAuthId] = useState<string | null>(null);
  const [manualAuthContent, setManualAuthContent] = useState("");

  const refresh = useCallback(async () => {
    if (!eco) return;
    try {
      const [list, active] = await Promise.all([
        eco.openAIAccountsList(),
        eco.openAIAccountsGetActive(),
      ]);
      setAccounts(list);
      setActiveAccountId(active.activeAccountId);
      setPendingAccountId(active.pendingAccountId);
      setSyncStatus(active.syncStatus);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [eco]);

  useEffect(() => {
    if (!eco) return undefined;
    void refresh();
    const unsubOauth = eco.onCodexOauthLoginResult(async (result) => {
      if (result.accountId) {
        setLoggingInId((current) => current === result.accountId ? null : current);
        if (!result.success) {
          setOperationError("");
          onError(result.message);
        }
      }
      await refresh();
    });
    const unsubAccounts = eco.onOpenAIAccountsChanged(async () => {
      await refresh();
    });
    return () => {
      if (typeof unsubOauth === "function") unsubOauth();
      unsubAccounts();
    };
  }, [eco, onError, refresh]);

  useEffect(() => {
    if (!menuOpenId) return;
    const close = () => setMenuOpenId(null);
    const onPointerDown = (event: PointerEvent) => {
      if (
        !menuRef.current?.contains(event.target as Node) &&
        !menuTriggerRef.current?.contains(event.target as Node)
      )
        close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        menuTriggerRef.current?.focus();
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input[type='checkbox']:not(:disabled)",
          ) ?? [],
        );
        const index = items.indexOf(
          document.activeElement as HTMLElement,
        );
        items[
          (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length
        ]?.focus();
      }
      if (event.key === "Tab") close();
    };
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [menuOpenId]);

  const refreshAccountQuota = useCallback(async (accountId: string) => {
    if (!eco) return;
    try {
      await eco.openAIAccountsQueryQuota(accountId);
      setQuotaErrors((previous) => {
        const next = { ...previous };
        delete next[accountId];
        return next;
      });
    } catch (error) {
      setQuotaErrors((previous) => ({ ...previous, [accountId]: error instanceof Error ? error.message : String(error) }));
    }
  }, [eco]);

  async function handleImageEnabled(accountId: string, enabled: boolean) {
    if (!eco || imageOperation) return;
    setImageOperation({ accountId, kind: "toggle" });
    setOperationError("");
    try {
      await eco.openAIAccountsSetImageEnabled(accountId, enabled);
      await refresh();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageOperation(null);
    }
  }

  async function handleImageQuotaRefresh(accountId: string) {
    if (!eco || imageOperation) return;
    setImageOperation({ accountId, kind: "quota" });
    setOperationError("");
    try {
      await eco.openAIAccountsQueryImageQuota(accountId);
      await refresh();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageOperation(null);
    }
  }

  const refreshQuotas = useCallback(async () => {
    if (!eco || accounts.length === 0 || quotaLoading || quotaLoadingId !== null) return;
    setQuotaLoading(true);
    try {
      await Promise.all(accounts.filter((account) => account.authState !== "missing").map((account) => refreshAccountQuota(account.id)));
      await refresh();
    } finally {
      setQuotaLoading(false);
    }
  }, [accounts, eco, quotaLoading, quotaLoadingId, refreshAccountQuota, refresh]);

  // Filtered accounts
  const filteredAccounts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return accounts.filter((a) => (!query || a.name.toLowerCase().includes(query) || a.email?.toLowerCase().includes(query))
      && (statusFilter === "all" || (statusFilter === "ready" ? a.isLoggedIn : !a.isLoggedIn)))
      .sort((a, b) => Number(b.id === activeAccountId) - Number(a.id === activeAccountId));
  }, [accounts, searchQuery, statusFilter, activeAccountId]);

  const handleCreate = useCallback(async (saveOnly = false) => {
    const name = modalName.trim();
    if (!eco || !name) return;
    setBusy(true);
    setOperationError("");
    try {
      if (modalEditId) {
        // Edit mode: update existing account
        await eco.openAIAccountsUpdate({
          accountId: modalEditId,
          name,
          proxyMode: modalProxyMode,
          proxyUrl: modalProxyMode === "manual" ? modalProxy.trim() : "",
          email: modalEmail,
          password: modalPassword,
          pickupUrl: modalPickupUrl,
          twoFactorSecret: modalTwoFactorSecret,
        });
        if (!saveOnly && modalMode === "manual" && modalAuthJson.trim()) {
          const authResult = await eco.openAIAccountsSetAuthJson(
            modalEditId,
            modalAuthJson.trim(),
          );
          if (!authResult.success) throw new Error(authResult.message);
        }
      } else {
        // Create mode
        const account = await eco.openAIAccountsCreate({
          name,
          proxyMode: modalProxyMode,
          ...(modalProxyMode === "manual" ? { proxyUrl: modalProxy.trim() } : {}),
          email: modalEmail,
          password: modalPassword,
          pickupUrl: modalPickupUrl,
          twoFactorSecret: modalTwoFactorSecret,
        });
        setModalEditId(account.id);
        if (!saveOnly && modalMode === "manual" && modalAuthJson.trim()) {
          const authResult = await eco.openAIAccountsSetAuthJson(account.id, modalAuthJson.trim());
          if (!authResult.success) throw new Error(authResult.message);
        } else if (!saveOnly && modalMode === "login") {
          try {
            const loginResult = await eco.openAIAccountsStartLogin(account.id);
            if (!loginResult.success) {
              onError(loginResult.message);
              return;
            }
          } catch (error) {
            onError(error instanceof Error ? error.message : String(error));
            return;
          }
        }
      }
      setModalOpen(false);
      setModalEditId(null);
      setModalName("");
      setModalProxyMode("system");
      setModalProxy("");
      setModalAuthJson("");
      setModalEmail("");
      setModalPassword("");
      setModalPickupUrl("");
      setModalTwoFactorSecret("");
      setModalMode("login");
      await refresh();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [
    eco,
    modalName,
    modalProxyMode,
    modalProxy,
    modalEmail,
    modalPassword,
    modalPickupUrl,
    modalTwoFactorSecret,
    modalMode,
    modalAuthJson,
    modalEditId,
    onError,
    refresh,
  ]);

  const handleDelete = useCallback(
    async (accountId: string) => {
      if (!eco) return;
      setBusy(true);
      try {
        await eco.openAIAccountsDelete(accountId);
        await refresh();
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [eco, refresh],
  );

  const handleLogin = useCallback(
    async (accountId: string) => {
      if (!eco) return;
      setLoggingInId(accountId);
      setOperationError("");
      try {
        const result = await eco.openAIAccountsStartLogin(accountId);
        if (!result.success) {
          onError(result.message);
          setLoggingInId(null);
        }
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
        setLoggingInId(null);
      }
    },
    [eco, onError],
  );

  const handleSetActive = useCallback(
    async (accountId: string) => {
      if (!eco) return;
      setBusy(true);
      try {
        await eco.openAIAccountsSetActive(accountId);
        await refresh();
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [eco, refresh],
  );

  const handleManualAuth = useCallback(async () => {
    if (!eco || !manualAuthId || !manualAuthContent.trim()) return;
    setBusy(true);
    try {
      const result = await eco.openAIAccountsSetAuthJson(
        manualAuthId,
        manualAuthContent.trim(),
      );
      if (!result.success) throw new Error(result.message);
      setManualAuthId(null);
      setManualAuthContent("");
      await refresh();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [eco, manualAuthId, manualAuthContent, refresh]);

  const openEdit = useCallback(async (accountId: string) => {
    if (!eco) return;
    setBusy(true);
    setOperationError("");
    try {
      const detail: OpenAIAccountDetails = await eco.openAIAccountsGetDetails(accountId);
      setModalEditId(detail.id);
      setModalName(detail.name);
      setModalProxyMode(detail.proxyMode);
      setModalProxy(detail.proxyUrl ?? "");
      setModalEmail(detail.email ?? "");
      setModalPassword(detail.password ?? "");
      setModalPickupUrl(detail.pickupUrl ?? "");
      setModalTwoFactorSecret(detail.twoFactorSecret ?? "");
      setModalAuthJson("");
      setModalMode("login");
      setModalOpen(true);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [eco]);

  const handleImport = useCallback(async () => {
    if (!eco) return;
    setBusy(true);
    setImportMessage("");
    setOperationError("");
    try {
      const result = await eco.openAIAccountsImport(importText);
      setImportMessage(t("settings.openaiAccounts.importDone", { added: result.added, updated: result.updated }));
      setImportText("");
      await refresh();
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [eco, importText, refresh, t]);

  const handleCancelSwitch = useCallback(async () => {
    if (!eco) return;
    setBusy(true);
    try {
      await eco.openAIAccountsCancelSwitch();
      await refresh();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [eco, refresh]);

  const loggedInCount = accounts.filter((account) => account.isLoggedIn).length;
  const activeAccount = accounts.find(
    (account) => account.id === activeAccountId,
  );

  return (
    <section className="codex-accounts-panel providers-list-section">
      <div className="codex-accounts-hero">
        <div className="codex-accounts-heading">
          <h2>{t("settings.models.tab.openaiAccounts")}</h2>
          <p>{t("settings.openaiAccounts.description")}</p>
        </div>
        <div className="codex-account-header-actions">
          <button
            type="button"
            className="codex-action-secondary"
            disabled={busy}
            onClick={() => { setImportMessage(""); setImportOpen(true); }}
          >
            <FileUp size={14} />
            {t("settings.openaiAccounts.bulkImport")}
          </button>
          <button
            type="button"
            className="settings-primary-button"
            disabled={busy}
            onClick={() => {
              setModalEditId(null);
              setModalName(t("settings.openaiAccounts.defaultAccountName", { index: accounts.length + 1 }));
              setModalProxyMode("system");
              setModalProxy("");
              setModalAuthJson("");
              setModalEmail("");
              setModalPassword("");
              setModalPickupUrl("");
              setModalTwoFactorSecret("");
              setModalMode("login");
              setModalOpen(true);
            }}
          >
            <Plus size={15} />
            {t("settings.openaiAccounts.addAccount")}
          </button>
        </div>
      </div>

      {loadError ? <div className="codex-account-sync-error">{t("settings.openaiAccounts.loadFailed", { message: loadError })}</div> : null}
      {operationError ? <div className="codex-account-sync-error">{operationError}</div> : null}
      {syncStatus.state !== "ok" ? (
        <div className={syncStatus.state === "conflict" ? "codex-account-sync-conflict" : "codex-account-sync-error"}>
          {syncStatus.state === "conflict"
            ? t("settings.openaiAccounts.syncConflict", { message: syncStatus.message })
            : t("settings.openaiAccounts.syncError", { message: syncStatus.message })}
        </div>
      ) : null}

      {/* Above the account list on purpose: the list grows with every imported
          account and would otherwise push the model catalog out of view. */}
      <CodexModelCatalogSection />

      <div className="codex-accounts-toolbar">
        <span>
          {t("settings.openaiAccounts.accountCount", { count: accounts.length })}
          <span className="codex-toolbar-divider">·</span>
          {t("settings.openaiAccounts.loggedInCount", { total: loggedInCount })}
        </span>
        {/* The active account already sorts first and carries a 当前使用 badge, so
            the switch line only appears while a switch or credential update is pending. */}
        {pendingAccountId !== undefined ? (
          <span className="codex-toolbar-switch"><OpenAIAccountSwitchStatus
            activeAccountId={activeAccountId}
            activeAccountName={activeAccount?.name}
            pendingAccountId={pendingAccountId}
            pendingAccountName={accounts.find((account) => account.id === pendingAccountId)?.name}
            busy={busy}
            onCancel={() => void handleCancelSwitch()}
          /></span>
        ) : null}
        <div className="codex-toolbar-links">
          <button
            type="button"
            className="chatgpt-inline-link"
            onClick={() => void refreshQuotas()}
            disabled={quotaLoading || quotaLoadingId !== null || !accounts.some((account) => account.authState !== "missing")}
          >
            <RefreshCw
              size={13}
              className={quotaLoading ? "mcp-spin" : undefined}
            />
            {quotaLoading
              ? t("settings.openaiAccounts.refreshing")
              : t("settings.openaiAccounts.refreshQuota")}
          </button>
        </div>
      </div>

      <div className="codex-account-controls">
        <div className="codex-account-filters" role="group" aria-label={t("settings.openaiAccounts.filterAria")}>
          {([
            ["all", t("settings.openaiAccounts.filterAll"), accounts.length],
            ["ready", t("settings.openaiAccounts.filterReady"), loggedInCount],
            ["missing", t("settings.openaiAccounts.filterMissing"), accounts.length - loggedInCount],
          ] as const).map(([value, label, count]) =>
            <button key={value} type="button" aria-pressed={statusFilter === value} className={statusFilter === value ? "is-selected" : ""} onClick={() => setStatusFilter(value)}>{label}<span>{count}</span></button>)}
        </div>
        <div className="codex-accounts-search">
          <Search size={14} className="search-input-icon" />
          <input
            className="mcp-field-input search-input"
            type="text"
            value={searchQuery}
            placeholder={t("settings.openaiAccounts.searchPlaceholder")}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchQuery ? (
            <button
              type="button"
              className="search-input-clear"
              aria-label={t("common.clearSearch")}
              onClick={() => setSearchQuery("")}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      </div>

      {loadError ? (
        <div className="codex-empty-state">
          <strong>{t("settings.openaiAccounts.listLoadFailed")}</strong>
          <p>{loadError}</p>
          <button type="button" className="settings-primary-button" onClick={() => void refresh()}>{t("common.retry")}</button>
        </div>
      ) : filteredAccounts.length === 0 ? (
        <div className="codex-empty-state">
          {searchQuery || accounts.length > 0 ? (
            <>
              <Search size={24} />
              <strong>{searchQuery ? t("settings.openaiAccounts.noMatch") : t("settings.openaiAccounts.filterEmpty")}</strong>
            </>
          ) : (
            <>
              <UserRound size={24} />
              <strong>{t("settings.openaiAccounts.noAccounts")}</strong>
              <p>{t("settings.openaiAccounts.noAccountsHint")}</p>
              <button
                type="button"
                className="settings-primary-button"
                disabled={busy}
                onClick={() => {
                  setModalEditId(null);
                  setModalName(t("settings.openaiAccounts.defaultAccountName", { index: 1 }));
                  setModalProxy("");
                  setModalAuthJson("");
                  setModalEmail("");
                  setModalPassword("");
                  setModalPickupUrl("");
                  setModalTwoFactorSecret("");
                  setModalMode("login");
                  setModalOpen(true);
                }}
              >
                <Plus size={15} />
                {t("settings.openaiAccounts.addAccount")}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="codex-account-list">
          {filteredAccounts.map((account) => {
            const accountQuota = account.quota;
            const isActive = activeAccountId === account.id;
            const isPending = pendingAccountId === account.id || (pendingAccountId !== undefined && isActive);
            const status = pendingAccountId === account.id
              ? isActive
                ? t("settings.openaiAccounts.pendingCredentialsBadge")
                : t("settings.openaiAccounts.pendingSwitchBadge")
              : pendingAccountId !== undefined && isActive
                ? pendingAccountId === null
                  ? t("settings.openaiAccounts.pendingDeactivateBadge")
                  : t("settings.openaiAccounts.waitingSwitchBadge")
              : !account.isLoggedIn
              ? account.authState === "expired"
                ? t("settings.openaiAccounts.expired")
                : t("settings.openaiAccounts.needsLogin")
              : isActive
                ? t("settings.openaiAccounts.inUse")
                : t("settings.openaiAccounts.loggedIn");
            const statusTone = isPending
              ? "warning"
              : !account.isLoggedIn
              ? "danger"
              : isActive
                ? "ready"
                : "muted";
            const email = account.email || accountQuota?.email;
            const isQuotaLoading = (quotaLoading && account.authState !== "missing") || quotaLoadingId === account.id;
            const showTextQuota = Boolean(accountQuota || account.isLoggedIn || isQuotaLoading || quotaErrors[account.id]);
            const showImageQuota = Boolean(account.imageGenerationEnabled || account.imageQuota);
            return (
              <article
                key={account.id}
                className={`codex-account-card ${isActive ? "is-active" : ""}`}
              >
                <div className="codex-account-card-main">
                  <div className="codex-account-avatar">
                    <span>{(email || account.name).slice(0, 1).toUpperCase()}</span>
                  </div>
                  <div className="codex-account-identity">
                    <div className="codex-account-identity-title">
                      <strong title={account.name}>{account.name}</strong>
                      {accountQuota?.planType ? <span className="codex-account-plan">{accountQuota.planType}</span> : null}
                    </div>
                    <span title={email}>
                      {email ||
                        (account.isLoggedIn
                          ? t("settings.openaiAccounts.oauthLoggedIn")
                          : t("settings.openaiAccounts.notLoggedIn"))}
                    </span>
                  </div>
                  <span className={`codex-status-badge is-${statusTone}`}>
                    <i />
                    {status}
                  </span>
                  <div className="codex-account-actions">
                    {!isActive && account.isLoggedIn ? (
                      <button
                        type="button"
                        className="codex-action-primary"
                        disabled={busy}
                        onClick={() => void handleSetActive(account.id)}
                      >
                        <Check size={14} />
                        {t("settings.openaiAccounts.setAsCurrent")}
                      </button>
                    ) : null}
                    {!account.isLoggedIn ? (
                      <button
                        type="button"
                        className="codex-action-primary"
                        disabled={busy || loggingInId !== null}
                        onClick={() => void handleLogin(account.id)}
                      >
                        {loggingInId === account.id ? <Loader2 size={14} className="mcp-spin" /> : <LogIn size={14} />}
                        {loggingInId === account.id ? t("settings.openaiAccounts.loggingIn") : t("settings.openaiAccounts.login")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="mcp-icon-button"
                      aria-label={t("settings.openaiAccounts.moreActionsAria", { name: account.name })}
                      aria-haspopup="menu"
                      aria-expanded={menuOpenId === account.id}
                      disabled={busy}
                      onClick={(event) => {
                        if (menuOpenId === account.id) {
                          setMenuOpenId(null);
                          return;
                        }
                        menuTriggerRef.current = event.currentTarget;
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        const menuWidth = Math.min(
                          CODEX_ACCOUNT_ACTION_MENU_WIDTH,
                          window.innerWidth - MENU_VIEWPORT_MARGIN * 2,
                        );
                        setMenuPos({
                          top: Math.max(
                            8,
                            Math.min(rect.bottom + 4, window.innerHeight - 260),
                          ),
                          left: Math.max(
                            MENU_VIEWPORT_MARGIN,
                            Math.min(
                              rect.right - menuWidth,
                              window.innerWidth - menuWidth - MENU_VIEWPORT_MARGIN,
                            ),
                          ),
                        });
                        setMenuOpenId(account.id);
                      }}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                </div>
                {showTextQuota || showImageQuota ? (
                  <div className={`codex-account-quotas ${showTextQuota && showImageQuota ? "has-image-quota" : ""}`}>
                    {showTextQuota ? <OpenAIAccountQuotaSummary quota={accountQuota} isLoggedIn={account.isLoggedIn} loading={isQuotaLoading} error={quotaErrors[account.id]} showRefreshedAt={false} /> : null}
                    {showImageQuota ? <OpenAIAccountImageQuotaSummary account={account} loading={imageOperation?.accountId === account.id && imageOperation.kind === "quota"} showRefreshedAt={false} /> : null}
                  </div>
                ) : null}
                <details className="codex-account-details">
                  <summary>
                    {t("settings.openaiAccounts.accountDetails")}
                    <ChevronDown size={13} />
                  </summary>
                  <div className="codex-account-details-content">
                    <OpenAIAccountProfilePresence fields={account.profileFields} />
                    <div className="codex-account-details-row">
                      <button
                        type="button"
                        className="codex-proxy-link"
                        disabled={busy}
                        onClick={() => void openEdit(account.id)}
                      >
                        <Globe2 size={13} />
                        {account.proxyMode === "manual"
                          ? t("settings.openaiAccounts.proxyOwn")
                          : account.proxyMode === "direct"
                            ? t("settings.openaiAccounts.proxyDirect")
                            : t("settings.openaiAccounts.proxySystem")}
                      </button>
                      <span>
                        {account.lastLogin
                          ? t("settings.openaiAccounts.lastLogin", {
                              time: formatAppDateTime(locale, new Date(account.lastLogin), {
                                month: "numeric",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              }),
                            })
                          : t("settings.openaiAccounts.notLoggedIn")}
                      </span>
                    </div>
                    {accountQuota ? <div className="codex-account-details-row">
                      <span>Codex</span>
                      <QuotaRefreshedAt fetchedAt={accountQuota.fetchedAt} />
                    </div> : null}
                    {account.imageQuota ? <div className="codex-account-details-row">
                      <span>{t("settings.openaiAccounts.imageQuotaLabel")}</span>
                      <QuotaRefreshedAt fetchedAt={account.imageQuota.fetchedAt} />
                    </div> : null}
                  </div>
                </details>
                {menuOpenId === account.id
                  ? createPortal(
                      <div
                        ref={menuRef}
                        className="account-action-menu codex-account-action-menu"
                        role="menu"
                        aria-label={t("settings.openaiAccounts.accountActionsAria")}
                        style={{
                          position: "fixed",
                          top: menuPos.top,
                          left: menuPos.left,
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="account-action-item"
                          onClick={() => {
                            setMenuOpenId(null);
                            void handleLogin(account.id);
                          }}
                          disabled={busy || loggingInId !== null}
                        >
                          <LogIn size={14} />
                          {account.isLoggedIn
                            ? t("settings.openaiAccounts.relogin")
                            : t("settings.openaiAccounts.login")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="account-action-item"
                          onClick={() => {
                            setMenuOpenId(null);
                            void openEdit(account.id);
                          }}
                          disabled={busy}
                        >
                          <Pencil size={14} />
                          {t("common.edit")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="account-action-item"
                          onClick={async () => {
                            setMenuOpenId(null);
                            if (!eco) return;
                            setQuotaLoadingId(account.id);
                            try {
                              await refreshAccountQuota(account.id);
                              await refresh();
                            } finally {
                              setQuotaLoadingId(null);
                            }
                          }}
                          disabled={
                            account.authState === "missing" || quotaLoading || quotaLoadingId !== null
                          }
                        >
                          <RefreshCw size={14} />
                          {t("settings.openaiAccounts.refreshQuota")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="account-action-item"
                          disabled={busy || !account.isLoggedIn || imageOperation !== null}
                          onClick={() => {
                            setMenuOpenId(null);
                            void handleImageQuotaRefresh(account.id);
                          }}
                        >
                          <RefreshCw size={14} />
                          {t("settings.openaiAccounts.refreshImageQuota")}
                        </button>
                        <label className="account-action-item codex-account-action-checkbox">
                          <input
                            type="checkbox"
                            role="menuitemcheckbox"
                            aria-label={t("settings.openaiAccounts.useForImageGeneration")}
                            aria-checked={account.imageGenerationEnabled ?? false}
                            checked={account.imageGenerationEnabled ?? false}
                            disabled={busy || imageOperation !== null}
                            onChange={(event) => void handleImageEnabled(account.id, event.target.checked)}
                          />
                          {t("settings.openaiAccounts.useForImageGeneration")}
                        </label>
                        {!isActive && account.isLoggedIn ? (
                          <button
                            type="button"
                            role="menuitem"
                            className="account-action-item"
                            onClick={() => {
                              setMenuOpenId(null);
                              void handleSetActive(account.id);
                            }}
                            disabled={busy}
                          >
                            <Check size={14} />
                            {t("settings.openaiAccounts.setAsCurrent")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          role="menuitem"
                          className="account-action-item danger"
                          onClick={() => {
                            setMenuOpenId(null);
                            void handleDelete(account.id);
                          }}
                          disabled={busy}
                        >
                          <Trash2 size={14} />
                          {t("common.delete")}
                        </button>
                      </div>,
                      document.body,
                    )
                  : null}
              </article>
            );
          })}
        </div>
      )}

      {/* Manual auth inline editor */}
      {manualAuthId && (
        <div className="manual-auth-panel">
          <div className="manual-auth-header">
            <span>{t("settings.openaiAccounts.manualAuth")}</span>
            <button type="button" onClick={() => setManualAuthId(null)}>
              <X size={14} />
            </button>
          </div>
          <textarea
            className="mcp-field-input mcp-field-textarea"
            value={manualAuthContent}
            placeholder='{"auth_mode":"chatgpt","tokens":{"access_token":"..."}}'
            onChange={(e) => setManualAuthContent(e.target.value)}
            disabled={busy}
            rows={4}
          />
          <div className="manual-auth-actions">
            <button
              type="button"
              className="mcp-save-button"
              onClick={() => void handleManualAuth()}
              disabled={busy || !manualAuthContent.trim()}
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      )}

      {importOpen ? (
        <div className="settings-modal-backdrop">
          <button type="button" className="settings-modal-backdrop-close" aria-label={t("common.close")} disabled={busy} onClick={() => setImportOpen(false)} tabIndex={-1} />
          <div className="settings-modal settings-modal-provider-editor codex-import-modal" role="dialog" aria-modal="true" aria-labelledby="openai-account-import-title">
            <header className="settings-modal-header">
              <h2 className="settings-modal-title" id="openai-account-import-title">{t("settings.openaiAccounts.bulkImportTitle")}</h2>
              <button type="button" className="mcp-icon-button" aria-label={t("common.close")} disabled={busy} onClick={() => setImportOpen(false)}><X size={18} /></button>
            </header>
            <div className="settings-modal-body">
              <div className="codex-import-intro"><div className="codex-import-icon"><FileUp size={22} /></div><div><strong>{t("settings.openaiAccounts.bulkImportIntro")}</strong><p>{t("settings.openaiAccounts.bulkImportIntroHint")}</p></div></div>
              <div className="codex-import-format">
                <span>{t("settings.openaiAccounts.emailField")}</span><i>----</i>
                <span>{t("settings.openaiAccounts.passwordField")}</span><i>----</i>
                <span>{t("settings.openaiAccounts.pickupAddressField")}</span><i>----</i>
                <span>{t("settings.openaiAccounts.twoFactorField")}</span>
              </div>
              <textarea
                className="mcp-field-input mcp-field-textarea codex-import-textarea"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={'name@example.com----password----https://example.com/pickup?id=123----JBSWY3DPEHPK3PXP'}
                rows={8}
                disabled={busy}
              />
              <div className="codex-import-help">
                <span>{t("settings.openaiAccounts.bulkImportHelp")}</span>
                <span>{t("settings.openaiAccounts.bulkImportPendingLines", { count: importText.split(/\r?\n/u).filter((line) => line.trim()).length })}</span>
              </div>
              {importMessage ? <div className="openai-import-result">{importMessage}</div> : null}
            </div>
            <footer className="settings-modal-footer">
              <button type="button" className="settings-modal-cancel" disabled={busy} onClick={() => setImportOpen(false)}>{t("common.close")}</button>
              <div className="settings-modal-footer-actions">
                <button type="button" className="plan-button primary" disabled={busy || !importText.trim()} onClick={() => void handleImport()}>
                  {busy ? t("settings.openaiAccounts.validating") : t("settings.openaiAccounts.validateAndImport")}
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}

      {/* Add Account Modal */}
      {modalOpen && (
        <div className="settings-modal-backdrop">
          <button
            type="button"
            className="settings-modal-backdrop-close"
            onClick={() => setModalOpen(false)}
            aria-label={t("common.close")}
            disabled={busy}
          />
          <div
            className="settings-modal settings-modal-provider-editor codex-account-editor"
            role="dialog"
            aria-modal="true"
          >
            <header className="settings-modal-header">
              <h2 className="settings-modal-title">
                {modalEditId
                  ? t("settings.openaiAccounts.editAccount")
                  : t("settings.openaiAccounts.addAccount")}
              </h2>
              <div className="settings-modal-header-actions">
                <button
                  type="button"
                  className="mcp-icon-button"
                  onClick={() => setModalOpen(false)}
                  aria-label={t("common.close")}
                >
                  <X size={18} />
                </button>
              </div>
            </header>

            <div className="settings-modal-body openai-account-modal-body">
              {operationError ? <div className="codex-account-sync-error">{operationError}</div> : null}
              <label className="mcp-field">
                <span className="mcp-field-label">
                  {t("settings.openaiAccounts.name")}
                </span>
                <input
                  className="mcp-field-input"
                  type="text"
                  value={modalName}
                  placeholder={t("settings.openaiAccounts.namePlaceholder")}
                  onChange={(e) => setModalName(e.target.value)}
                  autoFocus
                />
              </label>

              <OpenAIAccountProfileFields
                email={modalEmail}
                password={modalPassword}
                pickupUrl={modalPickupUrl}
                twoFactorSecret={modalTwoFactorSecret}
                instanceKey={modalEditId ?? "new"}
                onEmailChange={setModalEmail}
                onPasswordChange={setModalPassword}
                onPickupUrlChange={setModalPickupUrl}
                onTwoFactorSecretChange={setModalTwoFactorSecret}
              />

              <OpenAIAccountProxyFields
                mode={modalProxyMode}
                proxyUrl={modalProxy}
                disabled={busy}
                onModeChange={setModalProxyMode}
                onProxyUrlChange={setModalProxy}
              />

              {/* Mode toggle */}
              <div className="modal-mode-toggle">
                <button
                  type="button"
                  className={
                    modalMode === "login"
                      ? "modal-mode-btn active"
                      : "modal-mode-btn"
                  }
                  onClick={() => setModalMode("login")}
                >
                  <LogIn size={14} />
                  {t("settings.openaiAccounts.loginMode")}
                </button>
                <button
                  type="button"
                  className={
                    modalMode === "manual"
                      ? "modal-mode-btn active"
                      : "modal-mode-btn"
                  }
                  onClick={() => setModalMode("manual")}
                >
                  <FileUp size={14} />
                  {t("settings.openaiAccounts.manualMode")}
                </button>
              </div>

              {modalMode === "manual" && (
                <label className="mcp-field">
                  <span className="mcp-field-label">auth.json</span>
                  <textarea
                    className="mcp-field-input mcp-field-textarea"
                    value={modalAuthJson}
                    placeholder='{"auth_mode":"chatgpt","tokens":{"access_token":"..."}}'
                    onChange={(e) => setModalAuthJson(e.target.value)}
                    rows={5}
                  />
                </label>
              )}
            </div>

            <footer className="settings-modal-footer settings-modal-footer-split">
              <button
                type="button"
                className="settings-modal-cancel"
                onClick={() => setModalOpen(false)}
                disabled={busy}
              >
                {t("common.cancel")}
              </button>
              <div className="settings-modal-footer-actions">
                <button
                  type="button"
                  className="settings-modal-cancel"
                  onClick={() => void handleCreate(true)}
                  disabled={busy || !modalName.trim() || (modalProxyMode === "manual" && !modalProxy.trim())}
                >
                  {busy ? t("settings.openaiAccounts.saving") : t("settings.openaiAccounts.saveProfileOnly")}
                </button>
                {!modalEditId ? (
                <button
                  type="button"
                  className="plan-button primary"
                  onClick={() => void handleCreate(false)}
                  disabled={
                    busy ||
                    !modalName.trim() ||
                    (modalProxyMode === "manual" && !modalProxy.trim()) ||
                    (modalMode === "manual" && !modalAuthJson.trim())
                  }
                >
                  {busy ? <Loader2 size={14} className="mcp-spin" /> : null}
                  {modalMode === "login"
                    ? modalEditId
                      ? t("common.save")
                      : t("settings.openaiAccounts.createAndLogin")
                      : t("settings.openaiAccounts.createWithAuth")}
                </button>
                ) : modalMode === "manual" && modalAuthJson.trim() ? (
                  <button type="button" className="plan-button primary" onClick={() => void handleCreate(false)} disabled={busy}>
                    {busy ? t("settings.openaiAccounts.saving") : t("settings.openaiAccounts.saveAccountAndAuth")}
                  </button>
                ) : null}
              </div>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
