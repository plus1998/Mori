import { ChevronDown, Globe2, KeyRound, Loader2, LogIn, MoreHorizontal, Pencil, Plus, Power, Search, Trash2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { CursorApiKeyInput, CursorApiKeyView } from "../shared/ipc";
import type { OpenAIAccountProxyMode } from "../shared/openai-account";
import { LoginAccountProxyFields } from "./components/LoginAccountEditor";
import "./components/openai-account-cards.css";
import "./cursor-api-keys.css";

interface CursorApiKeysPanelProps {
  busy?: boolean | undefined;
  revision?: number;
}

type DialogState =
  | { type: "add" }
  | { type: "edit"; account: CursorApiKeyView }
  | { type: "delete"; account: CursorApiKeyView }
  | { type: "import" };

type AccountMenu = { id: string; kind: "web" | "cli" | "more" };

export function CursorApiKeysPanel({ busy = false, revision = 0 }: CursorApiKeysPanelProps) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<CursorApiKeyView[]>([]);
  const [dialog, setDialog] = useState<DialogState>();
  const [authKind, setAuthKind] = useState<"apiKey" | "oauth">("apiKey");
  const [proxyMode, setProxyMode] = useState<OpenAIAccountProxyMode>("system");
  const [proxyUrl, setProxyUrl] = useState("");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [importText, setImportText] = useState("");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [authorizingId, setAuthorizingId] = useState<string>();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [accountMenu, setAccountMenu] = useState<AccountMenu>();
  const disabled = busy || loading || mutating;
  const enabledCount = accounts.filter((account) => account.enabled).length;
  const query = searchQuery.trim().toLocaleLowerCase();
  const filteredAccounts = accounts.filter((account) =>
    (statusFilter === "all" || account.enabled === (statusFilter === "enabled"))
    && (!query || account.name.toLocaleLowerCase().includes(query)),
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (!window.eco?.listCursorApiKeys) throw new Error(t("settings.cursorApiKeys.unavailable"));
        const keys = await window.eco.listCursorApiKeys();
        if (!cancelled) setAccounts(keys);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [t, revision]);

  const menuOpen = accountMenu !== undefined;
  useEffect(() => {
    if (!menuOpen) return;
    function dismissMenu(event: PointerEvent) {
      if (!(event.target instanceof Element) || !event.target.closest(".cursor-api-key-actions")) {
        setAccountMenu(undefined);
      }
    }
    document.addEventListener("pointerdown", dismissMenu);
    return () => document.removeEventListener("pointerdown", dismissMenu);
  }, [menuOpen]);

  function toggleMenu(id: string, kind: AccountMenu["kind"]) {
    setAccountMenu((previous) => previous?.id === id && previous.kind === kind ? undefined : { id, kind });
  }

  const mutate = async (operation: (api: NonNullable<typeof window.eco>) => Promise<void>) => {
    if (disabled) return;
    setAccountMenu(undefined);
    setMutating(true);
    setError(undefined);
    setMessage(undefined);
    try {
      if (!window.eco?.listCursorApiKeys) throw new Error(t("settings.cursorApiKeys.unavailable"));
      await operation(window.eco);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMutating(false);
    }
  };

  const closeDialog = () => {
    if (mutating) return;
    setDialog(undefined);
    setApiKey("");
    setImportText("");
    setError(undefined);
  };

  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (!mutating) {
        setDialog(undefined);
        setApiKey("");
        setImportText("");
        setError(undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dialog, mutating]);

  const openAdd = () => {
    setError(undefined);
    setMessage(undefined);
    setName(`Cursor ${accounts.length + 1}`);
    setAuthKind("apiKey");
    setProxyMode("system");
    setProxyUrl("");
    setApiKey("");
    setDialog({ type: "add" });
  };

  const openEdit = (account: CursorApiKeyView) => {
    setAccountMenu(undefined);
    setError(undefined);
    setMessage(undefined);
    setName(account.name);
    setAuthKind(account.oauthExpiresAt === undefined ? "apiKey" : "oauth");
    setProxyMode(account.proxyMode ?? "system");
    setProxyUrl(account.proxyUrl ?? "");
    setApiKey("");
    setDialog({ type: "edit", account });
  };

  const save = async () => {
    if (!dialog || (dialog.type !== "add" && dialog.type !== "edit")) return;
    await mutate(async (api) => {
      const input: CursorApiKeyInput = {
        ...(dialog.type === "edit" ? { id: dialog.account.id } : {}),
        name,
        proxyMode,
        ...(proxyMode === "manual" ? { proxyUrl } : {}),
        ...(authKind === "apiKey" && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        enabled: dialog.type === "edit" ? dialog.account.enabled : true,
      };
      const updated = await api.saveCursorApiKey({
        ...input,
        ...(authKind === "oauth" ? { authKind } : {}),
      });
      setAccounts((current) => dialog.type === "edit"
        ? current.map((item) => item.id === updated.id ? updated : item)
        : [...current, updated]);
      setDialog(undefined);
      setApiKey("");
    });
  };

  const openWeb = async (id: string) => {
    await mutate((api) => api.openCursorAccountWeb(id));
  };

  const authorizeCli = async (id: string) => {
    await mutate(async (api) => {
      setAuthorizingId(id);
      try {
        const updated = await api.loginCursorOAuth(id);
        setAccounts((current) => current.map((item) => item.id === id ? updated : item));
      } finally {
        setAuthorizingId(undefined);
      }
    });
  };

  const importKeys = async () => {
    await mutate(async (api) => {
      const result = await api.importCursorApiKeys(importText);
      setDialog(undefined);
      setImportText("");
      setMessage(
        t("settings.cursorApiKeys.importDone", {
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
        }),
      );
      setAccounts(result.accounts);
    });
  };

  const toggle = async (account: CursorApiKeyView) => {
    await mutate(async (api) => {
      const updated = await api.setCursorApiKeyEnabled(account.id, !account.enabled);
      setAccounts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    });
  };

  const remove = async (account: CursorApiKeyView) => {
    await mutate(async (api) => {
      await api.deleteCursorApiKey(account.id);
      setAccounts((current) => current.filter((item) => item.id !== account.id));
      setDialog(undefined);
    });
  };

  return (
    <section className="codex-accounts-panel providers-list-section cursor-api-keys-panel">
      <div className="codex-accounts-hero">
        <div className="codex-accounts-heading">
          <h2>{t("settings.cursorApiKeys.title")}</h2>
        </div>
        <div className="codex-account-header-actions">
          <button type="button" className="codex-action-secondary" disabled={disabled} onClick={() => { setError(undefined); setMessage(undefined); setDialog({ type: "import" }); }}>
            <Upload size={14} />
            {t("settings.cursorApiKeys.import")}
          </button>
          <button type="button" className="settings-primary-button" disabled={disabled} onClick={openAdd}>
            <Plus size={15} />
            {t("settings.cursorApiKeys.add")}
          </button>
        </div>
        <p className="codex-accounts-description">{t("settings.cursorApiKeys.description")}</p>
      </div>

      {error && !dialog ? <div className="codex-account-sync-error" role="alert">{error}</div> : null}
      {message ? <div className="openai-import-result" role="status">{message}</div> : null}

      <div className="codex-accounts-toolbar">
        <span>{t("settings.cursorApiKeys.count", { count: accounts.length })}<span className="codex-toolbar-divider">·</span>{t("settings.cursorApiKeys.enabledCount", { count: enabledCount })}</span>
      </div>
      <div className="codex-account-controls">
        <div className="codex-account-filters" role="group" aria-label={t("settings.cursorApiKeys.filter")}>
          {([
            ["all", t("settings.cursorApiKeys.all"), accounts.length],
            ["enabled", t("settings.cursorApiKeys.stateEnabled"), enabledCount],
            ["disabled", t("settings.cursorApiKeys.stateDisabled"), accounts.length - enabledCount],
          ] as const).map(([value, label, count]) => (
            <button type="button" key={value} aria-pressed={statusFilter === value} className={statusFilter === value ? "is-selected" : ""} onClick={() => setStatusFilter(value)}>{label}<span>{count}</span></button>
          ))}
        </div>
        <div className="codex-accounts-search">
          <Search size={14} className="search-input-icon" />
          <input type="search" className="mcp-field-input search-input" aria-label={t("settings.cursorApiKeys.search")} placeholder={t("settings.cursorApiKeys.search")} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
        </div>
      </div>

      {loading ? (
        <div className="codex-empty-state" role="status"><Loader2 size={20} className="mcp-spin" /><p>{t("settings.cursorApiKeys.loading")}</p></div>
      ) : accounts.length === 0 ? (
        <div className="codex-empty-state">
          <KeyRound size={22} />
          <strong>{t("settings.cursorApiKeys.empty")}</strong>
          <p>{t("settings.cursorApiKeys.emptyHint")}</p>
          <button type="button" className="settings-primary-button" disabled={disabled} onClick={openAdd}><Plus size={14} />{t("settings.cursorApiKeys.add")}</button>
        </div>
      ) : filteredAccounts.length === 0 ? (
        <div className="codex-empty-state">
          <Search size={22} />
          <strong>{t("settings.cursorApiKeys.noResults")}</strong>
        </div>
      ) : (
        <div className="codex-account-list">
          {filteredAccounts.map((account) => {
            const usesOAuth = account.oauthExpiresAt !== undefined;
            const expired = account.oauthExpiresAt !== undefined && account.oauthExpiresAt <= Date.now();
            const statusTone = !account.enabled ? "danger" : expired ? "warning" : "ready";
            const cliLabel = usesOAuth ? "CLI" : "API Key";
            const cliStatus = !account.enabled
              ? t("settings.cursorApiKeys.stateDisabled")
              : account.oauthExpiresAt === 0
                ? t("settings.cursorApiKeys.oauthNotAuthorized")
                : expired
                  ? t("settings.cursorApiKeys.oauthExpired")
                  : t(usesOAuth ? "settings.cursorApiKeys.oauthAuthorized" : "settings.cursorApiKeys.stateEnabled");
            const moreLabel = t("settings.openaiAccounts.moreActionsAria", { name: account.name });
            const menu = accountMenu?.id === account.id ? accountMenu.kind : undefined;
            return (
              <article className={`codex-account-card cursor-api-key-card${account.enabled ? "" : " is-disabled"}`} key={account.id}>
                <div className="codex-account-card-main">
                  <div className="codex-account-avatar" aria-hidden="true"><KeyRound size={16} /></div>
                  <div className="codex-account-identity">
                    <div className="codex-account-identity-title">
                      <strong title={account.name}>{account.name}</strong>
                    </div>
                    <span className="cursor-api-key-preview">
                      {account.oauthExpiresAt === undefined
                        ? account.apiKeyPreview
                        : account.oauthExpiresAt === 0
                          ? t("settings.cursorApiKeys.oauthNotAuthorized")
                          : account.oauthExpiresAt <= Date.now()
                            ? t("settings.cursorApiKeys.oauthExpired")
                            : t("settings.cursorApiKeys.oauthExpires", { date: new Date(account.oauthExpiresAt).toLocaleDateString() })}
                    </span>
                  </div>
                  <div
                    className="codex-account-header-actions cursor-api-key-actions"
                    onBlur={(event) => {
                      if (menu && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
                        setAccountMenu(undefined);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape" || !menu) return;
                      event.stopPropagation();
                      setAccountMenu(undefined);
                      event.currentTarget.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus();
                    }}
                    onClick={(event) => {
                      if (!(event.target instanceof Element) || !event.target.closest("button[role=menuitem]")) return;
                      event.currentTarget.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus();
                      setAccountMenu(undefined);
                    }}
                  >
                    <div className="codex-account-status-tags">
                      <div className="codex-account-status-wrap">
                        <button type="button" className="codex-status-tag" aria-haspopup="menu"
                          aria-expanded={menu === "web"} disabled={disabled}
                          onClick={() => toggleMenu(account.id, "web")}>
                          <i />
                          <span>Web</span>
                          <ChevronDown size={11} />
                        </button>
                        {menu === "web" ? (
                          <div className="codex-account-status-popover" role="menu" aria-label="Web">
                            <div className="codex-account-status-popover-header">
                              <span>Web</span>
                            </div>
                            <button type="button" role="menuitem" className="codex-account-status-item is-primary"
                              disabled={disabled} onClick={() => void openWeb(account.id)}>
                              <Globe2 size={14} />
                              <span>{t("settings.cursorApiKeys.openWeb")}</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                      <div className="codex-account-status-wrap">
                        <button type="button" className={`codex-status-tag is-${statusTone}`} aria-haspopup="menu"
                          aria-expanded={menu === "cli"} disabled={disabled}
                          onClick={() => toggleMenu(account.id, "cli")}>
                          {authorizingId === account.id ? <Loader2 size={11} className="mcp-spin" /> : <i />}
                          <span>{cliLabel}</span>
                          <ChevronDown size={11} />
                        </button>
                        {menu === "cli" ? (
                          <div className="codex-account-status-popover" role="menu" aria-label={cliLabel}>
                            <div className="codex-account-status-popover-header">
                              <span>{cliLabel}</span>
                              <strong className={`is-${statusTone}`}><i />{cliStatus}</strong>
                            </div>
                            {usesOAuth ? (
                              <button type="button" role="menuitem" className="codex-account-status-item is-primary"
                                disabled={disabled} onClick={() => void authorizeCli(account.id)}>
                                <LogIn size={14} />
                                <span>{t(account.oauthExpiresAt === 0 ? "settings.cursorApiKeys.oauthLogin" : "settings.cursorApiKeys.oauthRelogin")}</span>
                              </button>
                            ) : (
                              <button type="button" role="menuitem" className="codex-account-status-item is-primary"
                                disabled={disabled} onClick={() => openEdit(account)}>
                                <KeyRound size={14} />
                                <span>{t("settings.cursorApiKeys.edit")}</span>
                              </button>
                            )}
                            <button type="button" role="menuitem" className="codex-account-status-item"
                              disabled={disabled} onClick={() => void toggle(account)}>
                              <Power size={14} />
                              <span>{t(account.enabled ? "settings.cursorApiKeys.disable" : "settings.cursorApiKeys.enabled")}</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="codex-account-actions">
                      <div className="codex-account-actions-menu-wrap">
                        <button
                          type="button"
                          className="mcp-icon-button"
                          aria-label={moreLabel}
                          title={moreLabel}
                          aria-haspopup="menu"
                          aria-expanded={menu === "more"}
                          disabled={disabled}
                          onClick={() => toggleMenu(account.id, "more")}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                        {menu === "more" ? (
                          <div className="codex-account-actions-menu" role="menu" aria-label={moreLabel}>
                            <button
                              type="button"
                              role="menuitem"
                              className="codex-account-actions-menu-item"
                              disabled={disabled}
                              onClick={() => openEdit(account)}
                            >
                              <Pencil size={14} />
                              {t("settings.cursorApiKeys.edit")}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="codex-account-actions-menu-item"
                              disabled={disabled}
                              onClick={() => {
                                setError(undefined);
                                setDialog({ type: "delete", account });
                              }}
                            >
                              <Trash2 size={14} />
                              {t("settings.cursorApiKeys.delete")}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
                <details className="codex-account-details">
                  <summary>
                    {t("settings.openaiAccounts.accountDetails")}
                    <ChevronDown size={13} />
                  </summary>
                  <div className="codex-account-details-content">
                    <div className="codex-account-details-row">
                      <button type="button" className="codex-proxy-link" disabled={disabled} onClick={() => openEdit(account)}>
                        <Globe2 size={13} />
                        {t(account.proxyMode === "manual"
                          ? "settings.openaiAccounts.proxyOwn"
                          : account.proxyMode === "direct"
                            ? "settings.openaiAccounts.proxyDirect"
                            : "settings.openaiAccounts.proxySystem")}
                      </button>
                    </div>
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      )}

      {dialog ? createPortal(
        <div className="settings-modal-backdrop">
          <button type="button" className="settings-modal-backdrop-close" aria-label={t("common.close")} disabled={mutating} onClick={closeDialog} tabIndex={-1} />
          <div className="settings-modal settings-modal-provider-editor cursor-api-key-modal" role="dialog" aria-modal="true" aria-labelledby="cursor-api-key-dialog-title">
            <header className="settings-modal-header">
              <h2 className="settings-modal-title" id="cursor-api-key-dialog-title">
                {dialog.type === "import"
                  ? t("settings.cursorApiKeys.importTitle")
                  : dialog.type === "delete"
                    ? t("settings.cursorApiKeys.delete")
                  : dialog.type === "edit"
                    ? t("settings.cursorApiKeys.editTitle")
                    : t("settings.cursorApiKeys.addTitle")}
              </h2>
              <button type="button" className="mcp-icon-button" aria-label={t("common.close")} disabled={mutating} onClick={closeDialog}>
                <X size={17} />
              </button>
            </header>
            {dialog.type === "delete" ? (
              <div className="settings-modal-body"><p>{t("settings.cursorApiKeys.deleteConfirm", { name: dialog.account.name })}</p></div>
            ) : dialog.type === "import" ? (
              <div className="settings-modal-body">
                <p className="cursor-api-key-import-hint">{t("settings.cursorApiKeys.importHint")}</p>
                <textarea
                  className="mcp-field-input mcp-field-textarea cursor-api-key-import-textarea"
                  rows={8}
                  value={importText}
                  placeholder={t("settings.cursorApiKeys.importPlaceholder")}
                  disabled={disabled}
                  aria-label={t("settings.cursorApiKeys.importTitle")}
                  spellCheck={false}
                  onChange={(event) => setImportText(event.target.value)}
                  autoFocus
                />
              </div>
            ) : (
              <div className="settings-modal-body cursor-api-key-fields">
                <label className="mcp-field">
                  <span className="mcp-field-label">{t("settings.cursorApiKeys.name")}</span>
                  <input className="mcp-field-input" value={name} placeholder={t("settings.cursorApiKeys.namePlaceholder")} disabled={disabled} onChange={(event) => setName(event.target.value)} autoFocus />
                </label>
                {dialog.type === "add" ? (
                  <label className="mcp-field">
                    <span className="mcp-field-label">{t("settings.cursorApiKeys.authMethod")}</span>
                    <select className="mcp-field-input" value={authKind} disabled={disabled} onChange={(event) => setAuthKind(event.target.value === "oauth" ? "oauth" : "apiKey")}>
                      <option value="apiKey">API Key</option>
                      <option value="oauth">OAuth</option>
                    </select>
                  </label>
                ) : null}
                <LoginAccountProxyFields mode={proxyMode} proxyUrl={proxyUrl} onModeChange={setProxyMode}
                  onProxyUrlChange={setProxyUrl} disabled={disabled} />
                {authKind === "oauth" ? (
                  <p className="mcp-field-hint">{t("settings.cursorApiKeys.oauthHint")}</p>
                ) : <label className="mcp-field">
                  <span className="mcp-field-label">{t("settings.cursorApiKeys.value")}</span>
                  <input className="mcp-field-input" type="password" autoComplete="off" value={apiKey} placeholder={dialog.type === "edit" ? dialog.account.apiKeyPreview : t("settings.cursorApiKeys.valuePlaceholder")} disabled={disabled} onChange={(event) => setApiKey(event.target.value)} />
                  {dialog.type === "edit" ? <span className="mcp-field-hint">{t("settings.cursorApiKeys.keepExisting")}</span> : null}
                </label>}
              </div>
            )}
            {error ? <p className="settings-form-error cursor-api-key-dialog-error" role="alert">{error}</p> : null}
            <footer className="settings-modal-footer">
              <button type="button" className="settings-modal-cancel" disabled={mutating} onClick={closeDialog}>{t("common.cancel")}</button>
              {dialog.type === "delete" ? (
                <button type="button" className="plan-button cursor-api-key-delete-button" disabled={disabled} onClick={() => void remove(dialog.account)}>{t("settings.cursorApiKeys.delete")}</button>
              ) : dialog.type === "import" ? (
                <button type="button" className="plan-button primary" disabled={disabled || !importText.trim()} onClick={() => void importKeys()}>{mutating ? <Loader2 size={14} className="mcp-spin" /> : null}{t("settings.cursorApiKeys.import")}</button>
              ) : (
                <button type="button" className="plan-button primary" disabled={disabled || !name.trim() || (proxyMode === "manual" && !proxyUrl.trim()) || (authKind === "apiKey" && !apiKey.trim() && dialog.type === "add")} onClick={() => void save()}>{mutating ? <Loader2 size={14} className="mcp-spin" /> : null}{t("common.save")}</button>
              )}
            </footer>
          </div>
        </div>, document.body,
      ) : null}
    </section>
  );
}
