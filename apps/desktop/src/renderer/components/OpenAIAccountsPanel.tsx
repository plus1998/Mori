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
  PanelRightOpen,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OpenAIAccount, OpenAIAccountDetails, OpenAIAccountQuota, OpenAIAccountQuotaWindow, OpenAIAccountSyncStatus } from "../../shared/openai-account";
import { CodexModelCatalogSection } from "./CodexModelCatalogSection";

function formatResetTime(window: OpenAIAccountQuotaWindow, fetchedAt: number): string {
  const resetAt = window.resetAt > 0 ? window.resetAt * 1_000 : fetchedAt + window.resetAfterSeconds * 1_000;
  const seconds = Math.ceil((resetAt - Date.now()) / 1_000);
  if (seconds <= 0) return "已到重置时间，待刷新";
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m 后重置`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.ceil((seconds % 3600) / 60);
    return `${m > 0 ? `${h}h ${m}m` : `${h}h`} 后重置`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.ceil((seconds % 86400) / 3600);
  return `${h > 0 ? `${d}d ${h}h` : `${d}d`} 后重置`;
}

export function OpenAIAccountQuotaSummary({ quota, isLoggedIn, loading, error }: {
  quota: OpenAIAccountQuota | undefined;
  isLoggedIn: boolean;
  loading: boolean;
  error: string | undefined;
}) {
  if (!quota && !isLoggedIn) return null;
  const primary = quota?.rateLimit.primaryWindow;
  const refreshedAt = quota ? new Date(quota.fetchedAt) : undefined;
  return <span className="codex-quota-summary" aria-busy={loading}>
    {loading ? <Loader2 size={13} className="mcp-spin" aria-label="正在刷新额度" /> : null}
    {quota ? <>
      <b>{quota.planType}</b>
      {primary ? <em className={quota.rateLimit.limitReached ? "is-limited" : "is-ok"}>{Math.round(primary.usedPercent)}% 已使用</em> : null}
      {primary && (primary.resetAt > 0 || primary.resetAfterSeconds > 0) ? <span>{formatResetTime(primary, quota.fetchedAt)}</span> : null}
      {quota.resetCreditsAvailable > 0 ? <span>{quota.resetCreditsAvailable} 次重置</span> : null}
      <time className="codex-quota-refreshed-at" dateTime={refreshedAt!.toISOString()} title={refreshedAt!.toLocaleString()}>
        上次刷新 {refreshedAt!.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </time>
      {error ? <em className="is-error" title={error} role="status">刷新失败，显示缓存</em> : null}
    </> : <span className={error ? "is-error" : undefined} title={error}>{error ? "额度刷新失败" : loading ? "正在刷新额度" : "额度未获取"}</span>}
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
        <button type="button" className="mcp-icon-button" aria-label={visible ? "隐藏内容" : "显示内容"} onClick={() => setVisible((shown) => !shown)}>
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        <button type="button" className="mcp-icon-button" aria-label={`复制${label}`} disabled={!value} onClick={() => void navigator.clipboard.writeText(value)}>
          <Copy size={14} />
        </button>
      </div>
    </label>
  );
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
  return (
    <fieldset className="openai-profile-fields">
      <legend>登录资料 <span>选填</span></legend>
      <p>登录助手可复制或填入资料，并生成 2FA 验证码。</p>
      <div className="openai-profile-grid">
      <label className="mcp-field openai-profile-wide">
        <span className="mcp-field-label">邮箱</span>
        <input className="mcp-field-input" type="email" autoComplete="off" value={email} onChange={(event) => onEmailChange(event.target.value)} placeholder="name@example.com" />
      </label>
      <ProfileSecretInput key={`password-${instanceKey}`} label="密码" value={password} onChange={onPasswordChange} />
      <ProfileSecretInput key={`twofa-${instanceKey}`} label="2FA 密钥" value={twoFactorSecret} onChange={onTwoFactorSecretChange} placeholder="Base32 密钥" />
      <label className="mcp-field openai-profile-wide">
        <span className="mcp-field-label">收件箱地址</span>
        <input className="mcp-field-input" type="url" value={pickupUrl} onChange={(event) => onPickupUrlChange(event.target.value)} placeholder="https://example.com" />
      </label>
      </div>
    </fieldset>
  );
}

export function OpenAIAccountProfilePresence({ fields }: { fields: OpenAIAccount["profileFields"] }) {
  return <div className="codex-profile-presence" aria-label="已保存的登录资料">
    {([
      ["email", "邮箱", Mail], ["password", "密码", KeyRound],
      ["twoFactorSecret", "2FA", ShieldCheck], ["pickupUrl", "收件箱", Inbox],
    ] as const).map(([key, label, Icon]) => <span key={key} className={fields?.[key] ? "is-saved" : ""} title={`${label}${fields?.[key] ? "已保存" : "未保存"}`}><Icon size={12} />{label}</span>)}
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
  const summary = pendingAccountId !== undefined
    ? pendingAccountId === null
      ? "待停用当前账号"
      : pendingAccountId === activeAccountId
        ? `凭据待应用：${activeAccountName ?? "当前账号"}`
        : `待切换：${pendingAccountName ?? "目标账号"}`
    : activeAccountName
      ? `当前使用：${activeAccountName}`
      : "尚未选择当前账号";
  return (
    <>
      <span className="codex-active-summary"><i />{summary}</span>
      {pendingAccountId !== undefined ? (
        <button type="button" className="chatgpt-inline-link" disabled={busy} onClick={onCancel}>
          {pendingAccountId === activeAccountId ? "取消凭据更新" : "取消切换"}
        </button>
      ) : null}
    </>
  );
}

export function OpenAIAccountsPanel() {
  const { t } = useTranslation();
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
        if (!result.success) setOperationError(result.message);
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
  }, [eco, refresh]);

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
          menuRef.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        const index = items.indexOf(
          document.activeElement as HTMLButtonElement,
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

  const refreshQuotas = useCallback(async () => {
    if (!eco || accounts.length === 0 || quotaLoading || quotaLoadingId !== null) return;
    setQuotaLoading(true);
    try {
      await Promise.all(accounts.filter((account) => account.isLoggedIn).map((account) => refreshAccountQuota(account.id)));
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
          proxyUrl: modalProxy.trim(),
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
          proxyUrl: modalProxy.trim(),
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
          const loginResult = await eco.openAIAccountsStartLogin(account.id);
          if (!loginResult.success) throw new Error(loginResult.message);
        }
      }
      setModalOpen(false);
      setModalEditId(null);
      setModalName("");
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
    modalProxy,
    modalEmail,
    modalPassword,
    modalPickupUrl,
    modalTwoFactorSecret,
    modalMode,
    modalAuthJson,
    modalEditId,
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
      try {
        const result = await eco.openAIAccountsStartLogin(accountId);
        if (!result.success) { setOperationError(result.message); setLoggingInId(null); }
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : String(error));
        setLoggingInId(null);
      }
    },
    [eco],
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
      setImportMessage(`导入完成：新增 ${result.added} 个，更新 ${result.updated} 个`);
      setImportText("");
      await refresh();
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [eco, importText, refresh]);

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

  const openAssistant = useCallback(async (accountId: string) => {
    if (!eco) return;
    setOperationError("");
    try { await eco.openAIAccountsOpenAssistant(accountId); }
    catch (error) { setOperationError(error instanceof Error ? error.message : String(error)); }
  }, [eco]);

  const loggedInCount = accounts.filter((account) => account.isLoggedIn).length;
  const activeAccount = accounts.find(
    (account) => account.id === activeAccountId,
  );

  return (
    <section className="codex-accounts-panel providers-list-section">
      <div className="codex-accounts-hero">
        <div className="codex-accounts-heading">
          <h2>Codex 账号</h2>
          <p>
            管理工作账号与登录资料，切换时保留正在运行的任务。
          </p>
        </div>
        <div className="codex-account-header-actions">
          <button
            type="button"
            className="codex-action-secondary"
            disabled={busy}
            onClick={() => { setImportMessage(""); setImportOpen(true); }}
          >
            <FileUp size={14} />
            批量导入
          </button>
          <button
            type="button"
            className="settings-primary-button"
            disabled={busy}
            onClick={() => {
              setModalEditId(null);
              setModalName(`Codex 账号 ${accounts.length + 1}`);
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

      {loadError ? <div className="codex-account-sync-error">账号读取失败：{loadError}</div> : null}
      {operationError ? <div className="codex-account-sync-error">{operationError}</div> : null}
      {syncStatus.state !== "ok" ? (
        <div className={syncStatus.state === "conflict" ? "codex-account-sync-conflict" : "codex-account-sync-error"}>
          {syncStatus.state === "conflict" ? "凭据同步冲突：" : "凭据同步错误："}{syncStatus.message}
        </div>
      ) : null}

      {/* Above the account list on purpose: the list grows with every imported
          account and would otherwise push the model catalog out of view. */}
      <CodexModelCatalogSection />

      <div className="codex-accounts-toolbar">
        <span>
          {accounts.length} 个账号
          <span className="codex-toolbar-divider">·</span>
          {loggedInCount} 个已登录
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
            disabled={quotaLoading || quotaLoadingId !== null || !accounts.some((account) => account.isLoggedIn)}
          >
            <RefreshCw
              size={13}
              className={quotaLoading ? "mcp-spin" : undefined}
            />
            {quotaLoading
              ? "刷新中…"
              : t("settings.openaiAccounts.refreshQuota")}
          </button>
        </div>
      </div>

      <div className="codex-account-controls">
        <div className="codex-account-filters" role="group" aria-label="筛选账号">
          {([ ["all", "全部", accounts.length], ["ready", "已登录", loggedInCount], ["missing", "待登录", accounts.length - loggedInCount] ] as const).map(([value, label, count]) =>
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
              aria-label="清除搜索"
              onClick={() => setSearchQuery("")}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      </div>

      {loadError ? (
        <div className="codex-empty-state">
          <strong>账号列表读取失败</strong>
          <p>{loadError}</p>
          <button type="button" className="settings-primary-button" onClick={() => void refresh()}>重试</button>
        </div>
      ) : filteredAccounts.length === 0 ? (
        <div className="codex-empty-state">
          {searchQuery || accounts.length > 0 ? (
            <>
              <Search size={24} />
              <strong>{searchQuery ? t("settings.openaiAccounts.noMatch") : "这个分类下暂无账号"}</strong>
            </>
          ) : (
            <>
              <UserRound size={24} />
              <strong>{t("settings.openaiAccounts.noAccounts")}</strong>
              <p>添加并登录后，Codex Agent 才能使用该账号。</p>
              <button
                type="button"
                className="settings-primary-button"
                disabled={busy}
                onClick={() => {
                  setModalEditId(null);
                  setModalName("Codex 账号 1");
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
              ? isActive ? "凭据待应用" : "待切换"
              : pendingAccountId !== undefined && isActive
                ? pendingAccountId === null ? "待停用" : "等待切换"
              : !account.isLoggedIn
              ? account.authState === "expired"
                ? "登录已过期"
                : "需要登录"
              : isActive
                ? "当前使用"
                : "已登录";
            const statusTone = isPending
              ? "warning"
              : !account.isLoggedIn
              ? "danger"
              : isActive
                ? "ready"
                : "muted";
            const email = account.email || accountQuota?.email;
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
                    <strong title={account.name}>{account.name}</strong>
                    <span title={email}>
                      {email ||
                        (account.isLoggedIn
                          ? "Codex OAuth 已登录"
                          : "尚未登录")}
                    </span>
                  </div>
                  <span className={`codex-status-badge is-${statusTone}`}>
                    <i />
                    {status}
                  </span>
                  <div className="codex-account-actions">
                    <button type="button" className="codex-action-secondary codex-assistant-trigger" onClick={() => void openAssistant(account.id)}><PanelRightOpen size={14} />登录助手</button>
                    {!isActive && account.isLoggedIn ? (
                      <button
                        type="button"
                        className="codex-action-primary"
                        disabled={busy}
                        onClick={() => void handleSetActive(account.id)}
                      >
                        <Check size={14} />
                        设为当前
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
                        {loggingInId === account.id ? "登录中" : "登录"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="mcp-icon-button"
                      aria-label={`${account.name} 更多操作`}
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
                        setMenuPos({
                          top: Math.max(
                            8,
                            Math.min(rect.bottom + 4, window.innerHeight - 220),
                          ),
                          left: Math.max(
                            8,
                            Math.min(rect.right - 180, window.innerWidth - 188),
                          ),
                        });
                        setMenuOpenId(account.id);
                      }}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                </div>
                <div className="codex-account-meta">
                  <OpenAIAccountProfilePresence fields={account.profileFields} />
                  <button
                    type="button"
                    className="codex-proxy-link"
                    disabled={busy}
                    onClick={() => {
                      void openEdit(account.id);
                    }}
                  >
                    <Globe2 size={13} />
                    {account.proxyUrl ? "独立代理" : "系统网络"}
                  </button>
                  <span>
                    {account.lastLogin
                      ? `最近登录 ${new Date(account.lastLogin).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                      : "尚未登录"}
                  </span>
                  <OpenAIAccountQuotaSummary quota={accountQuota} isLoggedIn={account.isLoggedIn} loading={(quotaLoading && account.isLoggedIn) || quotaLoadingId === account.id} error={quotaErrors[account.id]} />
                </div>
                {menuOpenId === account.id
                  ? createPortal(
                      <div
                        ref={menuRef}
                        className="account-action-menu codex-account-action-menu"
                        role="menu"
                        aria-label="账号操作"
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
                            ? "重新登录"
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
                            !account.isLoggedIn || quotaLoading || quotaLoadingId !== null
                          }
                        >
                          <RefreshCw size={14} />
                          {t("settings.openaiAccounts.refreshQuota")}
                        </button>
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
                            设为当前
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
          <button type="button" className="settings-modal-backdrop-close" aria-label="关闭" disabled={busy} onClick={() => setImportOpen(false)} tabIndex={-1} />
          <div className="settings-modal settings-modal-provider-editor codex-import-modal" role="dialog" aria-modal="true" aria-labelledby="openai-account-import-title">
            <header className="settings-modal-header">
              <h2 className="settings-modal-title" id="openai-account-import-title">批量导入账号资料</h2>
              <button type="button" className="mcp-icon-button" aria-label="关闭" disabled={busy} onClick={() => setImportOpen(false)}><X size={18} /></button>
            </header>
            <div className="settings-modal-body">
              <div className="codex-import-intro"><div className="codex-import-icon"><FileUp size={22} /></div><div><strong>一次整理，登录时随手取用</strong><p>每行一个账号。按邮箱更新资料，整批校验通过后保存。</p></div></div>
              <div className="codex-import-format"><span>邮箱</span><i>----</i><span>密码</span><i>----</i><span>收件地址</span><i>----</i><span>2FA 密钥</span></div>
              <textarea
                className="mcp-field-input mcp-field-textarea codex-import-textarea"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={'name@example.com----password----https://example.com/pickup?id=123----JBSWY3DPEHPK3PXP'}
                rows={8}
                disabled={busy}
              />
              <div className="codex-import-help"><span>字段可留空，支持 Markdown 链接格式。</span><span>{importText.split(/\r?\n/u).filter((line) => line.trim()).length} 行待校验</span></div>
              {importMessage ? <div className="openai-import-result">{importMessage}</div> : null}
            </div>
            <footer className="settings-modal-footer">
              <button type="button" className="settings-modal-cancel" disabled={busy} onClick={() => setImportOpen(false)}>关闭</button>
              <div className="settings-modal-footer-actions">
                <button type="button" className="plan-button primary" disabled={busy || !importText.trim()} onClick={() => void handleImport()}>
                  {busy ? "校验并保存中…" : "校验并导入"}
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

              {/* Proxy - always visible */}
              <label className="mcp-field modal-proxy-field">
                <span className="mcp-field-label">
                  {t("settings.openaiAccounts.proxy")}
                </span>
                <input
                  className="mcp-field-input"
                  type="text"
                  value={modalProxy}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(e) => setModalProxy(e.target.value)}
                />
              </label>

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
                  disabled={busy || !modalName.trim()}
                >
                  {busy ? "保存中…" : "仅保存资料"}
                </button>
                {!modalEditId ? (
                <button
                  type="button"
                  className="plan-button primary"
                  onClick={() => void handleCreate(false)}
                  disabled={
                    busy ||
                    !modalName.trim() ||
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
                    {busy ? "保存中…" : "保存账号与 auth.json"}
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
