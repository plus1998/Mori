import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Copy, Globe2, KeyRound, Link2, Loader2, LogIn, LogOut, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import "./components/CodexExternalLoginDialog.css";
import { LoginAccountEditor } from "./components/LoginAccountEditor";
import type { AntigravityAccountInput, AntigravityAccountView, AntigravityLoginMode } from "../shared/ipc";

type AccountFilter = "all" | "ready" | "missing";
type AccountMenu = { id: string; kind: "web" | "cli" | "more" };

export function AntigravityAccountsPanel({ available }: { available: boolean }) {
  const { i18n, t } = useTranslation();
  const zh = i18n.language === "zh-CN";
  const [accounts, setAccounts] = useState<AntigravityAccountView[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<AccountFilter>("all");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<AccountMenu>();
  const menuAnchor = useRef<HTMLDivElement>(null);
  const [signOut, setSignOut] = useState<{ account: AntigravityAccountView; kind: "web" | "cli" | "delete" }>();
  const [editor, setEditor] = useState<AntigravityAccountInput>();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<{ id: string; mode: AntigravityLoginMode }>();
  const [externalAccount, setExternalAccount] = useState<AntigravityAccountView>();
  const [submitted, setSubmitted] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string>();
  const [linkCopied, setLinkCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (window.eco?.listAntigravityAccounts) setAccounts(await window.eco.listAntigravityAccounts());
  }, []);
  const report = useCallback((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)), []);

  useEffect(() => {
    void refresh().catch(report).finally(() => setLoading(false));
    const onFocus = () => { void refresh().catch(report); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, report]);
  useEffect(() => {
    if (!menu) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuAnchor.current?.contains(event.target)) setMenu(undefined);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [menu]);
  useEffect(() => {
    if (!login) return;
    let stopped = false;
    async function poll(id: string) {
      try {
        const status = await window.eco!.getAntigravityLoginStatus(id);
        if (stopped) return;
        if (status.state === "pending") {
          setAuthorizationUrl(status.authorizationUrl);
        } else if (status.state !== "idle") {
          setLogin(undefined);
          setCode("");
          setAuthorizationUrl(undefined);
          if (status.state === "failed") setError(status.message);
          if (status.state === "connected") setSucceeded(true);
          await refresh();
        }
      } catch (failure) {
        if (!stopped) report(failure);
      }
    }
    const timer = setInterval(() => void poll(login.id), 500);
    return () => {
      stopped = true;
      clearInterval(timer);
      void window.eco?.cancelAntigravityLogin(login.id).catch(() => {});
    };
  }, [login, refresh, report]);

  async function mutate(action: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(false);
    }
  }

  function signIn(id: string, mode: AntigravityLoginMode) {
    void mutate(async () => {
      await window.eco!.startAntigravityLogin(id, mode);
      setAuthorizationUrl(undefined);
      setLinkCopied(false);
      setSubmitted(false);
      setSucceeded(false);
      setLogin({ id, mode });
    });
  }

  function closeExternal() {
    if (busy) return;
    setLogin(undefined);
    setExternalAccount(undefined);
    setAuthorizationUrl(undefined);
    setCode("");
    setError("");
  }

  const locked = busy || Boolean(login);
  const readyCount = accounts.filter(account => account.connected || account.webHasSession).length;
  const search = query.trim().toLocaleLowerCase();
  const visibleAccounts = accounts.filter(account =>
    (filter === "all" || (account.connected || account.webHasSession) === (filter === "ready")) &&
    account.name.toLocaleLowerCase().includes(search),
  );
  const filters = [
    { id: "all", label: t("settings.openaiAccounts.filterAll"), count: accounts.length },
    { id: "ready", label: t("settings.openaiAccounts.filterReady"), count: readyCount },
    { id: "missing", label: t("settings.openaiAccounts.filterMissing"), count: accounts.length - readyCount },
  ] as const;
  const cliLabel = "CLI";
  const externalLabel = zh ? "外部授权" : "External authorization";
  const signOutLabel = zh ? "退出登录" : "Sign out";
  const confirmLabel = signOut?.kind === "delete" ? t("common.delete") : signOutLabel;

  function openEditor(account?: AntigravityAccountView) {
    setError("");
    setEditor(account ?? { name: "", proxyMode: "system" });
  }

  function openExternal(account: AntigravityAccountView) {
    setError("");
    setSucceeded(false);
    setSubmitted(false);
    setExternalAccount(account);
  }

  function toggleMenu(id: string, kind: AccountMenu["kind"]) {
    setMenu(current => current?.id === id && current.kind === kind ? undefined : { id, kind });
  }

  return (
    <section className="codex-accounts-panel providers-list-section">
      <div className="codex-accounts-hero">
        <div className="codex-accounts-heading"><h2>Antigravity</h2></div>
        <div className="codex-account-header-actions">
          <button type="button" className="settings-primary-button" disabled={locked} onClick={() => openEditor()}>
            <Plus size={15} />
            {t("settings.openaiAccounts.addAccount")}
          </button>
        </div>
      </div>
      {!available && <div className="codex-account-sync-error" role="status">{zh ? "使用 CLI 前请在 macOS 上安装 Antigravity CLI（agy），然后重新打开此页面。" : "To use the CLI, install Antigravity CLI (agy) on macOS and reopen this page."}</div>}
      {!editor && !externalAccount && !signOut && error && <div className="codex-account-sync-error" role="alert">{error}</div>}
      {accounts.length > 0 && (
        <div className="codex-account-controls">
          <div className="codex-account-filters" role="group" aria-label={t("settings.openaiAccounts.filterAria")}>
            {filters.map(({ id, label, count }) => (
              <button key={id} type="button" aria-pressed={filter === id} className={filter === id ? "is-selected" : ""}
                onClick={() => { setMenu(undefined); setFilter(id); }}>
                {label}<span>{count}</span>
              </button>
            ))}
          </div>
          <div className="codex-accounts-search">
            <Search size={14} className="search-input-icon" aria-hidden="true" />
            <input type="search" className="mcp-field-input search-input"
              aria-label={t("settings.openaiAccounts.searchPlaceholder")}
              placeholder={t("settings.openaiAccounts.searchPlaceholder")} value={query}
              onChange={event => { setMenu(undefined); setQuery(event.target.value); }} />
          </div>
        </div>
      )}
      {loading ? (
        <div className="codex-empty-state" role="status"><Loader2 size={20} className="mcp-spin" /><p>{t("common.loading")}</p></div>
      ) : accounts.length === 0 ? (
        <div className="codex-empty-state">
          <KeyRound size={22} aria-hidden="true" />
          <strong>{zh ? "暂无 Antigravity 账号" : "No Antigravity accounts"}</strong>
          <p>{zh ? "添加 Google 账号以使用 Antigravity。" : "Add a Google account to use Antigravity."}</p>
        </div>
      ) : visibleAccounts.length === 0 ? (
        <div className="codex-empty-state">
          <Search size={22} aria-hidden="true" />
          <strong>{search ? (zh ? "没有匹配的账号" : "No matching accounts") : t("settings.openaiAccounts.filterEmpty")}</strong>
        </div>
      ) : (
        <div className="codex-account-list">
          {visibleAccounts.map(account => {
            const openMenu = menu?.id === account.id ? menu.kind : undefined;
            const signingIn = login?.id === account.id && login.mode === "browser";
            const status = signingIn
              ? (zh ? "等待浏览器授权" : "Waiting for browser authorization")
              : account.connected
                ? t("settings.openaiAccounts.externalSignedIn")
                : t("settings.openaiAccounts.notLoggedIn");
            const tone = signingIn ? "warning" : account.connected ? "ready" : "danger";
            const moreLabel = t("settings.openaiAccounts.moreActionsAria", { name: account.name });
            const loginLabel = `${cliLabel} · ${account.name}`;
            const webLabel = `Web · ${account.name}`;
            const webTone = account.webHasSession ? "ready" : "danger";
            const webStatus = t(account.webHasSession ? "settings.openaiAccounts.webLoggedIn" : "settings.openaiAccounts.webNotLoggedIn");
            const proxyLabel = t(account.proxyMode === "manual" ? "settings.openaiAccounts.proxyOwn" :
              account.proxyMode === "direct" ? "settings.openaiAccounts.proxyDirect" : "settings.openaiAccounts.proxySystem");
            return (
              <article className="codex-account-card" key={account.id}>
                <div className="codex-account-card-main">
                  <div className="codex-account-avatar" aria-hidden="true"><span>{account.name.slice(0, 1).toLocaleUpperCase()}</span></div>
                  <div className="codex-account-identity">
                    <div className="codex-account-identity-title"><strong title={account.name}>{account.name}</strong></div>
                    {signingIn && <span role="status">{status}</span>}
                  </div>
                  <div className="codex-account-header-actions" ref={openMenu ? menuAnchor : undefined}
                    onBlur={event => {
                      if (openMenu && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setMenu(undefined);
                    }}
                    onKeyDown={event => {
                      if (event.key !== "Escape" || !openMenu) return;
                      event.stopPropagation();
                      event.currentTarget.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus();
                      setMenu(undefined);
                    }}
                    onClick={event => {
                      if (!(event.target instanceof Element) || !event.target.closest('button[role="menuitem"]')) return;
                      event.currentTarget.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus();
                      setMenu(undefined);
                    }}>
                    <div className="codex-account-status-tags">
                      <div className="codex-account-status-wrap">
                        <button type="button" className={`codex-status-tag is-${webTone}`} aria-label={webLabel}
                          aria-haspopup="menu" aria-expanded={openMenu === "web"} disabled={busy}
                          onClick={() => toggleMenu(account.id, "web")}>
                          <i /><span>Web</span><ChevronDown size={11} />
                        </button>
                        {openMenu === "web" && (
                          <div className="codex-account-status-popover" role="menu" aria-label={webLabel}>
                            <div className="codex-account-status-popover-header">
                              <span>Gemini</span><strong className={`is-${webTone}`}><i />{webStatus}</strong>
                            </div>
                            <button type="button" role="menuitem" className="codex-account-status-item is-primary"
                              onClick={() => void mutate(async () => {
                                await window.eco!.openAntigravityWeb(account.id);
                                await refresh();
                              })}>
                              <Globe2 size={14} />{account.webHasSession
                                ? (zh ? "打开 Gemini 网页" : "Open Gemini")
                                : (zh ? "登录 Gemini 网页" : "Sign in to Gemini Web")}
                            </button>
                            {account.webHasSession && (
                              <button type="button" role="menuitem" className="codex-account-status-item"
                                onClick={() => { setError(""); setSignOut({ account, kind: "web" }); }}>
                                <LogOut size={14} />{signOutLabel}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="codex-account-status-wrap">
                        <button type="button" className={`codex-status-tag is-${tone}`} aria-label={loginLabel}
                          aria-haspopup="menu" aria-expanded={openMenu === "cli"} disabled={locked && !signingIn}
                          onClick={() => toggleMenu(account.id, "cli")}>
                          {signingIn ? <Loader2 size={11} className="mcp-spin" /> : <i />}
                          <span>{cliLabel}</span><ChevronDown size={11} />
                        </button>
                        {openMenu === "cli" && (
                          <div className="codex-account-status-popover" role="menu" aria-label={loginLabel}>
                            <div className="codex-account-status-popover-header">
                              <span>Antigravity CLI</span><strong className={`is-${tone}`}><i />{status}</strong>
                            </div>
                            {signingIn ? (
                              <button type="button" role="menuitem" className="codex-account-status-item" disabled={busy}
                                onClick={() => void mutate(() => window.eco!.cancelAntigravityLogin(account.id))}>
                                <X size={14} />{t("common.cancel")}
                              </button>
                            ) : account.connected ? (
                              <button type="button" role="menuitem" className="codex-account-status-item" disabled={!available || locked}
                                onClick={() => { setError(""); setSignOut({ account, kind: "cli" }); }}>
                                <LogOut size={14} />{signOutLabel}
                              </button>
                            ) : (
                              <>
                                <button type="button" role="menuitem" className="codex-account-status-item is-primary" disabled={!available || locked}
                                  onClick={() => signIn(account.id, "browser")}>
                                  <LogIn size={14} />{zh ? "用账号浏览器授权" : "Authorize in account browser"}
                                </button>
                                <button type="button" role="menuitem" className="codex-account-status-item" disabled={!available || locked}
                                  onClick={() => openExternal(account)}>
                                  <Link2 size={14} />{externalLabel}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="codex-account-actions">
                      <div className="codex-account-actions-menu-wrap">
                        <button type="button" className="mcp-icon-button" aria-label={moreLabel} title={moreLabel}
                          aria-haspopup="menu" aria-expanded={openMenu === "more"} disabled={locked}
                          onClick={() => toggleMenu(account.id, "more")}>
                          <MoreHorizontal size={16} />
                        </button>
                        {openMenu === "more" && (
                          <div className="codex-account-actions-menu" role="menu" aria-label={moreLabel}>
                            <button type="button" role="menuitem" className="codex-account-actions-menu-item" onClick={() => openEditor(account)}>
                              <Pencil size={14} />{t("settings.openaiAccounts.editAccount")}
                            </button>
                            <button type="button" role="menuitem" className="codex-account-actions-menu-item"
                              onClick={() => { setError(""); setSignOut({ account, kind: "delete" }); }}>
                              <Trash2 size={14} />{t("common.delete")}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <details className="codex-account-details">
                  <summary>{t("settings.openaiAccounts.accountDetails")}<ChevronDown size={13} /></summary>
                  <div className="codex-account-details-content">
                    <div className="codex-account-details-row">
                      <button type="button" className="codex-proxy-link" disabled={locked} onClick={() => openEditor(account)}>
                        <Globe2 size={13} />{proxyLabel}
                      </button>
                    </div>
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      )}
      {signOut && (
        <div className="settings-modal-backdrop">
          <button type="button" className="settings-modal-backdrop-close" aria-label={t("common.close")} disabled={busy}
            onClick={() => setSignOut(undefined)} tabIndex={-1} />
          <div className="settings-modal settings-modal-provider-editor codex-account-editor" role="dialog" aria-modal="true" aria-labelledby="agy-sign-out-title"
            onKeyDown={event => {
              if (event.key === "Escape" && !busy) { event.stopPropagation(); setSignOut(undefined); }
            }}>
            <header className="settings-modal-header">
              <h2 className="settings-modal-title" id="agy-sign-out-title">{confirmLabel}{signOut.kind === "cli" ? " CLI" : signOut.kind === "web" ? " Web" : ""} · {signOut.account.name}</h2>
            </header>
            <div className="settings-modal-body">
              {error && <div className="codex-account-sync-error" role="alert">{error}</div>}
              <p>{signOut.kind === "delete"
                ? (zh ? "删除此账号的本地配置、Gemini 网页会话和 CLI 凭证。Mori 对话记录会保留，使用此账号的旧对话将无法继续。"
                  : "Remove this account’s local settings, Gemini web session, and CLI credentials. Mori keeps its conversation history. Conversations linked to this account cannot continue.")
                : signOut.kind === "web"
                ? (zh ? "退出会清除此账号在 Mori 内的 Gemini 网页会话。" : "Signing out clears this account’s Gemini web session in Mori.")
                : (zh ? "退出后，此账号的旧 CLI 会话将无法继续。" : "Signing out will prevent continuing this account’s existing CLI conversations.")}</p>
            </div>
            <footer className="settings-modal-footer settings-modal-footer-split">
              <button type="button" className="settings-modal-cancel" disabled={busy} onClick={() => setSignOut(undefined)} autoFocus>{t("common.cancel")}</button>
              <button type="button" className={signOut.kind === "delete" ? "plan-button cursor-api-key-delete-button" : "plan-button primary"} disabled={busy} onClick={() => void mutate(async () => {
                if (signOut.kind === "delete") await window.eco!.deleteAntigravityAccount(signOut.account.id);
                else if (signOut.kind === "web") await window.eco!.clearAntigravityWeb(signOut.account.id);
                else await window.eco!.logoutAntigravity(signOut.account.id);
                await refresh();
                setSignOut(undefined);
              })}>
                {busy && <Loader2 size={14} className="mcp-spin" />}{confirmLabel}
              </button>
            </footer>
          </div>
        </div>
      )}
      {externalAccount && (
        <div className="settings-modal-backdrop">
          <button type="button" className="settings-modal-backdrop-close" aria-label={t("common.close")} onClick={closeExternal} tabIndex={-1} />
          <div className="settings-modal codex-external-login" role="dialog" aria-modal="true" aria-labelledby="agy-external-title"
            onKeyDown={event => {
              if (event.key === "Escape") { event.stopPropagation(); closeExternal(); }
              if (event.key !== "Tab") return;
              const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)"));
              const next = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1)
                : !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : undefined;
              if (next) { event.preventDefault(); next.focus(); }
            }}>
            <header className="codex-external-header">
              <div className="codex-external-mark" aria-hidden="true"><Globe2 size={20} /></div>
              <div className="codex-external-heading">
                <h2 id="agy-external-title">{zh ? "外部授权" : "External authorization"} · {externalAccount.name}</h2>
                <p>{zh ? "可以在另一台电脑完成 Google 授权。" : "You can authorize with Google on another computer."}</p>
              </div>
              <button type="button" className="codex-external-icon-button codex-external-close" aria-label={t("common.close")} onClick={closeExternal}><X size={17} /></button>
            </header>
            <div className="codex-external-body">
              <section className="codex-external-step">
                <div className="codex-external-step-heading">
                  <span className="codex-external-step-number" aria-hidden="true">1</span>
                  <h3>{t("settings.openaiAccounts.externalBrowserStep")}</h3>
                </div>
                <div className="codex-external-link-row">
                  <Link2 size={16} className="codex-external-link-icon" aria-hidden="true" />
                  <input aria-label={t("settings.openaiAccounts.externalAuthUrl")} readOnly value={authorizationUrl ?? ""}
                    placeholder={t("settings.openaiAccounts.externalLinkPlaceholder")} onFocus={event => event.currentTarget.select()} />
                  <button type="button" className="codex-external-button is-primary" disabled={busy || succeeded || Boolean(login && !authorizationUrl)}
                    onClick={() => {
                      if (!authorizationUrl) { signIn(externalAccount.id, "code"); return; }
                      void navigator.clipboard.writeText(authorizationUrl).then(() => setLinkCopied(true)).catch(report);
                    }}>
                    {authorizationUrl ? <Copy size={14} /> : <Link2 size={14} />}
                    {t(authorizationUrl ? (linkCopied ? "settings.openaiAccounts.externalCopyDone" : "settings.openaiAccounts.externalCopy")
                      : "settings.openaiAccounts.externalGenerate")}
                  </button>
                </div>
              </section>
              <section className="codex-external-step codex-external-callback-step">
                <div className="codex-external-step-heading">
                  <span className="codex-external-step-number" aria-hidden="true">2</span>
                  <h3>{zh ? "填写授权结果" : "Enter the authorization result"}</h3>
                </div>
                <p className="codex-external-step-hint">{zh ? "在浏览器完成授权后，将 Antigravity 页面显示的授权码粘贴到这里。也可以粘贴包含授权码的完整返回地址。" : "After authorizing in your browser, paste the code shown by Antigravity or the full returned URL containing the code."}</p>
                <textarea className="codex-external-callback" aria-label={zh ? "授权码或完整返回地址" : "Authorization code or returned URL"}
                  value={code} onChange={event => setCode(event.target.value)} disabled={!authorizationUrl || busy || submitted}
                  rows={3} autoComplete="off" spellCheck={false} />
              </section>
              {login && !authorizationUrl && !submitted && <p role="status" className="codex-external-feedback"><Loader2 size={14} className="mcp-spin" />{zh ? "正在生成授权链接…" : "Generating authorization link…"}</p>}
              {submitted && login && <p role="status" className="codex-external-feedback"><Loader2 size={14} className="mcp-spin" />{t("settings.openaiAccounts.externalWaiting")}</p>}
              {succeeded && <p role="status" className="codex-external-feedback is-success">{t("settings.openaiAccounts.externalSignedIn")}</p>}
              {error && <p role="alert" className="codex-external-feedback is-error">{error}</p>}
            </div>
            <footer className="codex-external-footer">
              <button type="button" className="codex-external-text-button" onClick={closeExternal}>{t("common.close")}</button>
              <button type="button" className="codex-external-button is-primary"
                disabled={!succeeded && (!authorizationUrl || !code.trim() || busy || submitted)}
                onClick={() => {
                  if (succeeded) { closeExternal(); return; }
                  void mutate(async () => {
                    await window.eco!.submitAntigravityLoginCode(externalAccount.id, code);
                    setCode("");
                    setAuthorizationUrl(undefined);
                    setSubmitted(true);
                  });
                }}>
                {t(succeeded ? "common.done" : "settings.openaiAccounts.externalComplete")}
              </button>
            </footer>
          </div>
        </div>
      )}
      {editor && (
        <LoginAccountEditor
          editing={Boolean(editor.id)}
          name={editor.name}
          onNameChange={name => setEditor({ ...editor, name })}
          mode={editor.proxyMode}
          onModeChange={proxyMode => setEditor({ ...editor, proxyMode })}
          proxyUrl={editor.proxyUrl ?? ""}
          onProxyUrlChange={proxyUrl => setEditor({ ...editor, proxyUrl })}
          busy={busy}
          error={error}
          onClose={() => { if (!busy) { setEditor(undefined); setError(""); } }}
          actions={(
            <button type="button" className="plan-button primary"
              disabled={busy || !editor.name.trim() || (editor.proxyMode === "manual" && !editor.proxyUrl?.trim())}
              onClick={() => void mutate(async () => {
                await window.eco!.saveAntigravityAccount(editor);
                await refresh();
                setEditor(undefined);
              })}>
              {t("common.save")}
            </button>
          )}
        >
          <p className="mcp-field-hint">
            {zh ? "代理用于 Mori 内的 Gemini 网页和 agy 请求。CLI 外部授权使用打开链接的浏览器自己的网络设置。"
              : "This proxy applies to Gemini Web in Mori and agy requests. External CLI authorization uses the browser’s own network settings."}
          </p>
        </LoginAccountEditor>
      )}
    </section>
  );
}
