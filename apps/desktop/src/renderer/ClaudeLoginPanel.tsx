import { useEffect, useState } from "react";
import { ChevronDown, Globe2, KeyRound, LifeBuoy, Loader2, LogIn, LogOut, MoreHorizontal, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { LoginAccountEditor, LoginAccountProfileFields } from "./components/LoginAccountEditor";
import { useTranslation } from "react-i18next";
import type { ClaudeLoginAccount, ClaudeLoginAction, ClaudeLoginProfileInput } from "../shared/claude-login";
import "./components/openai-account-cards.css";
import "./claude-login.css";

type AccountMenu = { id: string; kind: "web" | "code" | "more" };

type Editor = ClaudeLoginProfileInput & { id?: string; mode: "system" | "direct" | "manual" };

function SessionKeyField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const { t } = useTranslation();
  return (
    <label className="mcp-field">
      <span className="mcp-field-label">sessionKey</span>
      <input className="mcp-field-input" type="password" value={value} onChange={event => onChange(event.target.value)}
        disabled={disabled} autoComplete="off" spellCheck={false} maxLength={4096} />
      <span className="mcp-field-hint">{t("settings.claudeLogin.sessionKeyHint")}</span>
    </label>
  );
}

export function ClaudeLoginPanel() {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<ClaudeLoginAccount[]>();
  const [editor, setEditor] = useState<Editor>();
  const [pending, setPending] = useState<ClaudeLoginAction>();
  const [error, setError] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [loadingEditor, setLoadingEditor] = useState(false);
  const [sessionKeyAccount, setSessionKeyAccount] = useState<string>();
  const [sessionKey, setSessionKey] = useState("");
  const [accountMenu, setAccountMenu] = useState<AccountMenu>();

  async function refresh() {
    setAccounts(await window.eco!.claudeLoginList());
  }

  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  useEffect(() => {
    let active = true;
    const eco = window.eco!;
    const load = () => {
      void eco.claudeLoginList().then(
        result => { if (active) setAccounts(result); },
        reason => { if (active) showError(reason); },
      );
    };
    load();
    const unsubscribe = eco.onClaudeLoginResult(load);
    window.addEventListener("focus", load);
    return () => { active = false; unsubscribe(); window.removeEventListener("focus", load); };
  }, []);

  const menuOpen = accountMenu !== undefined;
  useEffect(() => {
    if (!menuOpen) return;
    function dismissMenu(event: PointerEvent) {
      if (!(event.target instanceof Element) || !event.target.closest(".claude-login-actions")) setAccountMenu(undefined);
    }
    document.addEventListener("pointerdown", dismissMenu);
    return () => document.removeEventListener("pointerdown", dismissMenu);
  }, [menuOpen]);

  function toggleMenu(id: string, kind: AccountMenu["kind"]) {
    setAccountMenu(previous => previous?.id === id && previous.kind === kind ? undefined : { id, kind });
  }

  async function run(action: ClaudeLoginAction, signInAfterSave?: "login" | "openWeb", keyAfterSave = "") {
    setPending(action.kind === "loginWithSessionKey" ? { kind: "login", id: action.id } : action);
    setError(undefined);
    closeSessionKeyForm();
    try {
      const accountId = await window.eco!.claudeLoginAction(action);
      if (action.kind === "save") {
        setEditor(undefined);
        if (signInAfterSave) {
          if (typeof accountId !== "string") throw new Error("Claude Login did not return the new account ID.");
          const login = { kind: signInAfterSave, id: accountId } as const;
          setAccounts(previous => [...(previous ?? []), {
            name: action.profile.name, proxy: action.profile.proxy, id: accountId, status: "signedOut", webStatus: "noSession",
          }]);
          setPending(login);
          await window.eco!.claudeLoginAction(keyAfterSave
            ? { kind: "loginWithSessionKey", id: accountId, sessionKey: keyAfterSave }
            : login);
        }
      }
      if (action.kind === "remove") setConfirmRemove(undefined);
    } catch (reason) {
      showError(reason);
    } finally {
      try { await refresh(); }
      catch (reason) { showError(reason); }
      finally { setPending(undefined); }
    }
  }

  function openCreate() {
    setError(undefined);
    closeSessionKeyForm();
    setEditor({ name: `Claude Login ${(accounts?.length ?? 0) + 1}`, proxy: "", mode: "system" });
  }

  async function openEdit(account: ClaudeLoginAccount) {
    setLoadingEditor(true);
    setError(undefined);
    closeSessionKeyForm();
    try {
      const profile = await window.eco!.claudeLoginDetails(account.id);
      setEditor({
        ...profile, id: account.id,
        mode: profile.proxy === "direct" ? "direct" : profile.proxy ? "manual" : "system",
        proxy: profile.proxy === "direct" ? "" : profile.proxy,
      });
    } catch (reason) { showError(reason); }
    finally { setLoadingEditor(false); }
  }

  function save(signInAfterSave?: "login" | "openWeb") {
    if (!editor) return;
    const profile = {
      name: editor.name,
      proxy: editor.mode === "manual" ? editor.proxy : editor.mode === "direct" ? "direct" : "",
      ...(editor.signInProfile ? { signInProfile: editor.signInProfile } : {}),
    };
    const key = signInAfterSave === "login" ? sessionKey.trim() : "";
    void run({ kind: "save", profile, ...(editor.id ? { id: editor.id } : {}) }, signInAfterSave, key);
  }

  function closeSessionKeyForm() {
    setSessionKeyAccount(undefined);
    setSessionKey("");
  }

  const cannotSave = Boolean(pending) || !editor?.name.trim() || (editor.mode === "manual" && !editor.proxy.trim());

  return (
    <section className="providers-list-section codex-accounts-panel claude-login-panel">
      <div className="codex-accounts-hero">
        <div className="codex-accounts-heading"><h2>Claude Login</h2></div>
        <div className="codex-account-header-actions">
          <button type="button" className="codex-action-secondary" disabled={Boolean(pending)} onClick={() => { setError(undefined); void refresh().catch(showError); }}>{t("common.refresh")}</button>
          <button type="button" className="settings-primary-button" disabled={Boolean(pending) || loadingEditor} onClick={openCreate}>
            <Plus size={15} />
            {t("settings.openaiAccounts.addAccount")}
          </button>
        </div>
      </div>
      <p>{t("settings.claudeLogin.description")}</p>
      {error && !editor && <div className="codex-account-sync-error" role="alert">{error}</div>}
      {editor && (
        <LoginAccountEditor
          editing={Boolean(editor.id)}
          name={editor.name}
          onNameChange={name => setEditor({ ...editor, name })}
          mode={editor.mode}
          proxyUrl={editor.proxy}
          onModeChange={mode => setEditor({ ...editor, mode })}
          onProxyUrlChange={proxy => setEditor({ ...editor, proxy })}
          busy={Boolean(pending)}
          error={error}
          profileFields={
            <LoginAccountProfileFields
              email={editor.signInProfile?.email ?? ""}
              pickupUrl={editor.signInProfile?.pickupUrl ?? ""}
              onEmailChange={email => setEditor({ ...editor, signInProfile: { ...editor.signInProfile, email } })}
              onPickupUrlChange={pickupUrl => setEditor({ ...editor, signInProfile: { ...editor.signInProfile, pickupUrl } })}
            />
          }
          onClose={() => { setEditor(undefined); setError(undefined); closeSessionKeyForm(); }}
          actions={
            <>
              {!editor.id && (
                <button type="button" className="settings-modal-cancel" disabled={cannotSave || Boolean(sessionKey.trim())} onClick={() => save()}>
                  {t("settings.openaiAccounts.saveProfileOnly")}
                </button>
              )}
              {!editor.id && (
                <button type="button" className="settings-modal-cancel" disabled={cannotSave || Boolean(sessionKey.trim())} onClick={() => save("openWeb")}>
                  {t("settings.claudeLogin.createAndOpenWeb")}
                </button>
              )}
              <button type="button" className="plan-button primary" disabled={cannotSave} onClick={() => save(editor.id ? undefined : "login")}>
                {pending?.kind === "save" ? <Loader2 size={14} className="mcp-spin" /> : null}
                {t(editor.id ? "common.save" : sessionKey.trim() ? "settings.claudeLogin.createWithSessionKey" : "settings.claudeLogin.createAndLogin")}
              </button>
            </>
          }
        >
          {!editor.id && <SessionKeyField value={sessionKey} onChange={setSessionKey} disabled={Boolean(pending)} />}
        </LoginAccountEditor>
      )}
      {accounts === undefined && !error && <div className="codex-empty-state" role="status" aria-busy="true">{t("common.loading")}</div>}
      {accounts?.length === 0 && (
        <div className="codex-empty-state">
          <UserRound size={24} />
          <strong>{t("settings.claudeLogin.empty")}</strong>
          <button type="button" className="settings-primary-button" disabled={Boolean(pending) || loadingEditor} onClick={openCreate}>
            <Plus size={15} />
            {t("settings.openaiAccounts.addAccount")}
          </button>
        </div>
      )}
      <div className="codex-account-list">
        {accounts?.map(account => {
          const signingIn = account.status === "signingIn" || (pending?.kind === "login" && pending.id === account.id);
          const disabled = Boolean(pending) || signingIn || loadingEditor;
          const status = signingIn ? "signingIn" : account.status;
          const codeTone = status === "signedIn" ? "ready" : status === "signingIn" ? "warning" : "danger";
          const webTone = account.webStatus === "hasSession" ? "ready" : "danger";
          const moreLabel = t("settings.openaiAccounts.moreActionsAria", { name: account.name });
          const menu = accountMenu?.id === account.id ? accountMenu.kind : undefined;
          const proxyLabel = t(account.proxy === "direct" ? "settings.openaiAccounts.proxyModeDirect"
            : account.proxy ? "settings.openaiAccounts.proxyOwn" : "settings.openaiAccounts.proxyModeSystem");
          return (
            <article key={account.id} className="codex-account-card">
              <div className="codex-account-card-main">
                <div className="codex-account-avatar" aria-hidden="true">
                  <span>{(account.email || account.name).slice(0, 1).toUpperCase()}</span>
                </div>
                <div className="codex-account-identity">
                  <div className="codex-account-identity-title">
                    <strong title={account.name}>{account.name}</strong>
                  </div>
                  <span title={account.email}>{account.email || proxyLabel}</span>
                </div>
                <div className="codex-account-header-actions claude-login-actions" onBlur={event => {
                  if (menu && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setAccountMenu(undefined);
                }} onKeyDown={event => {
                  if (event.key !== "Escape" || !menu) return;
                  event.stopPropagation();
                  setAccountMenu(undefined);
                  event.currentTarget.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus();
                }} onClick={event => {
                  if (!(event.target instanceof Element) || !event.target.closest("button[role=menuitem]")) return;
                  event.currentTarget.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus();
                  setAccountMenu(undefined);
                }}>
                  <div className="codex-account-status-tags">
                    <div className="codex-account-status-wrap">
                      <button type="button" className={`codex-status-tag is-${webTone}`} aria-haspopup="menu"
                        aria-expanded={menu === "web"} onClick={() => toggleMenu(account.id, "web")}>
                        <i /><span>Web</span><ChevronDown size={11} />
                      </button>
                      {menu === "web" && (
                        <div className="codex-account-status-popover" role="menu" aria-label={t("settings.claudeLogin.web")}>
                          <div className="codex-account-status-popover-header">
                            <span>{t("settings.claudeLogin.web")}</span>
                            <strong className={`is-${webTone}`}><i />{t(`settings.claudeLogin.webStatus.${account.webStatus}`)}</strong>
                          </div>
                          <button type="button" role="menuitem" className="codex-account-status-item is-primary" disabled={disabled}
                            onClick={() => void run({ kind: "openWeb", id: account.id })}>
                            <Globe2 size={14} /><span>{t("settings.claudeLogin.openWeb")}</span>
                          </button>
                          {account.webStatus === "hasSession" && (
                            <button type="button" role="menuitem" className="codex-account-status-item" disabled={disabled}
                              onClick={() => void run({ kind: "logoutWeb", id: account.id })}>
                              <LogOut size={14} /><span>{t("settings.claudeLogin.signOut")}</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="codex-account-status-wrap">
                      <button type="button" className={`codex-status-tag is-${codeTone}`} aria-haspopup="menu"
                        aria-expanded={menu === "code"} onClick={() => toggleMenu(account.id, "code")}>
                        <i /><span>Claude Code</span><ChevronDown size={11} />
                      </button>
                      {menu === "code" && (
                        <div className="codex-account-status-popover" role="menu" aria-label="Claude Code">
                          <div className="codex-account-status-popover-header">
                            <span>Claude Code</span>
                            <strong className={`is-${codeTone}`}><i />{t(`settings.claudeLogin.${status}`)}</strong>
                          </div>
                          {signingIn ? (
                            <button type="button" role="menuitem" className="codex-account-status-item" onClick={() => {
                              if (pending?.kind === "login") void window.eco!.claudeLoginAction({ kind: "cancel", id: account.id }).catch(showError);
                              else void run({ kind: "cancel", id: account.id });
                            }}><Loader2 size={14} className="mcp-spin" /><span>{t("common.cancel")}</span></button>
                          ) : (
                            <button type="button" role="menuitem" className="codex-account-status-item is-primary" disabled={disabled}
                              onClick={() => void run({ kind: "login", id: account.id })}>
                              <LogIn size={14} /><span>{t(account.status === "signedIn" ? "settings.claudeLogin.signInAgain" : "settings.claudeLogin.signIn")}</span>
                            </button>
                          )}
                          <button type="button" role="menuitem" className="codex-account-status-item" disabled={disabled} onClick={() => {
                            setError(undefined);
                            setSessionKey("");
                            setSessionKeyAccount(account.id);
                          }}><KeyRound size={14} /><span>{t("settings.claudeLogin.signInWithSessionKey")}</span></button>
                          <button type="button" role="menuitem" className="codex-account-status-item" onClick={() => {
                            setError(undefined);
                            void window.eco!.openAIAccountsOpenAssistant(account.id).catch(showError);
                          }}><LifeBuoy size={14} /><span>{t("assistant.title")}</span></button>
                          {account.status === "signedIn" && (
                            <button type="button" role="menuitem" className="codex-account-status-item" disabled={disabled}
                              onClick={() => void run({ kind: "logout", id: account.id })}>
                              <LogOut size={14} /><span>{t("settings.claudeLogin.signOut")}</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="codex-account-actions">
                    <div className="codex-account-actions-menu-wrap">
                      <button type="button" className="mcp-icon-button" aria-label={moreLabel} title={moreLabel}
                        aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => toggleMenu(account.id, "more")}>
                        <MoreHorizontal size={16} />
                      </button>
                      {menu === "more" && (
                        <div className="codex-account-actions-menu" role="menu" aria-label={moreLabel}>
                          <button type="button" role="menuitem" className="codex-account-actions-menu-item" disabled={disabled} onClick={() => void openEdit(account)}>
                            <Pencil size={14} />{t("common.edit")}
                          </button>
                          <button type="button" role="menuitem" className="codex-account-actions-menu-item" disabled={disabled} onClick={() => setConfirmRemove(account.id)}>
                            <Trash2 size={14} />{t("common.delete")}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              {sessionKeyAccount === account.id && (
                <form className="claude-login-session-key" onSubmit={event => {
                  event.preventDefault();
                  const key = sessionKey.trim();
                  if (!key || disabled) return;
                  void run({ kind: "loginWithSessionKey", id: account.id, sessionKey: key });
                }}>
                  <SessionKeyField value={sessionKey} onChange={setSessionKey} disabled={disabled} />
                  <div className="codex-account-header-actions">
                    <button type="button" className="codex-action-secondary" onClick={closeSessionKeyForm}>{t("common.cancel")}</button>
                    <button type="submit" className="plan-button primary" disabled={disabled || !sessionKey.trim()}>{t("settings.claudeLogin.signInWithSessionKey")}</button>
                  </div>
                </form>
              )}
              {confirmRemove === account.id && (
                <div className="claude-login-confirm">
                  <span>{t("settings.claudeLogin.confirmRemove", { name: account.name })}</span>
                  <button type="button" className="codex-action-secondary" disabled={disabled} onClick={() => void run({ kind: "remove", id: account.id })}>{t("common.delete")}</button>
                  <button type="button" className="codex-action-secondary" disabled={disabled} onClick={() => setConfirmRemove(undefined)}>{t("common.cancel")}</button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
