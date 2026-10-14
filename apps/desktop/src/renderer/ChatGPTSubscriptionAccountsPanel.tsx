import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, Globe2, KeyRound, MoreHorizontal, Plus, RefreshCw, ShieldCheck, Trash2, UserRound, X } from "lucide-react";

type Account = {
  accountId: string;
  displayName: string;
  email?: string;
  proxyUrl?: string;
  status: string;
  enabled: boolean;
  hasCredentials: boolean;
  lastErrorCode?: string;
  lastSuccessAt?: number;
};

type ModelOption = { id: string; displayName?: string };

function statusLabel(account: Account): string {
  if (!account.enabled || account.status === "disabled") return "已停用";
  if (account.status === "ready") return "可用";
  if (account.status === "refreshing") return "刷新中";
  if (account.status === "rate_limited") return "已限流";
  if (account.status === "temporarily_unavailable") return "暂时不可用";
  if (account.status === "not_eligible") return "订阅不可用";
  if (account.status === "reauthorization_required") return "需要重新授权";
  return "待登录";
}

function statusTone(account: Account): "ready" | "warning" | "muted" | "danger" {
  if (!account.enabled || account.status === "disabled") return "muted";
  if (account.status === "ready") return "ready";
  if (account.status === "rate_limited" || account.status === "not_eligible" || account.status === "reauthorization_required") return "danger";
  if (account.status === "temporarily_unavailable" || account.status === "refreshing") return "warning";
  return "muted";
}

function formatLastUsed(timestamp?: number): string {
  if (!timestamp) return "尚未成功调用";
  return `最近成功 ${new Date(timestamp).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

export function ChatGPTSubscriptionAccountsPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string>();
  const [dialog, setDialog] = useState<"add" | Account>();
  const [displayName, setDisplayName] = useState("");
  const [proxyDraft, setProxyDraft] = useState("");
  const [proxyAccount, setProxyAccount] = useState<Account>();
  const [testDialog, setTestDialog] = useState<Account>();
  const [testResult, setTestResult] = useState<{ success: boolean; message: string }>();
  const [menu, setMenu] = useState<{ account: Account; top: number; left: number }>();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);

  const refresh = useCallback(async () => {
    if (!window.eco?.chatGptSubscriptionAccountsList) return;
    try {
      const next = (await window.eco.chatGptSubscriptionAccountsList()) as Account[];
      setAccounts(next);
      return next;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshModels = useCallback(async () => {
    if (!window.eco?.listProviderModels) return;
    setModelsLoading(true);
    setModelsError(undefined);
    try {
      const result = await window.eco.listProviderModels({ providerId: "eco-coding-chatgpt", authMethod: "chatgpt_subscription" });
      if (!result.ok) throw new Error(result.error);
      setModels(result.models as ModelOption[]);
      setSelectedModel((current) => result.models.some((model) => model.id === current) ? current : result.models[0]?.id ?? "");
    } catch (error) {
      setModels([]);
      setSelectedModel("");
      setModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const next = await refresh();
      if (next?.some((account) => account.enabled && account.hasCredentials && account.status === "ready")) await refreshModels();
    })();
    return window.eco?.onChatGptSubscriptionLoginResult((result) => {
      setMessage(result.success ? undefined : result.message || "ChatGPT 授权失败");
      void refresh().then(() => refreshModels());
    });
  }, [refresh, refreshModels]);

  useEffect(() => {
    if (!dialog && !proxyAccount && !testDialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) { setDialog(undefined); setProxyAccount(undefined); setTestDialog(undefined); }
      } else if (event.key === "Tab") {
        const elements = dialogRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled), a[href]");
        const first = elements?.[0];
        const last = elements?.[elements.length - 1];
        if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => { document.removeEventListener("keydown", handleKeyDown, true); previouslyFocused?.focus(); };
  }, [dialog, proxyAccount, testDialog, busy]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuTriggerRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close(); menuTriggerRef.current?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
      if (event.key === "Tab") close();
    };
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
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
  }, [menu]);

  async function addAccount(copyAuthorization = false) {
    if (!window.eco) return;
    setBusy(true); setMessage(undefined);
    try {
      const name = displayName.trim();
      if (!name) return;
      const account = (await window.eco.chatGptSubscriptionAccountCreate(name, proxyDraft.trim() || undefined)) as Account;
      setDialog(undefined);
      await refresh();
      if (copyAuthorization) {
        const result = await window.eco.chatGptSubscriptionAccountAuthorizationUrl(account.accountId);
        if (!result.success || !result.authorizationUrl) throw new Error(result.message);
        if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持复制到剪贴板，请使用内置授权窗口");
        await navigator.clipboard.writeText(result.authorizationUrl);
        setMessage("授权链接已复制，请在已登录 ChatGPT 的浏览器中打开；完成授权后返回 Eco Coding。");
      } else {
        const result = await window.eco.chatGptSubscriptionAccountLogin(account.accountId);
        if (!result.success) throw new Error(result.message);
        await refreshModels();
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function saveProxy() {
    if (!window.eco || !proxyAccount) return;
    setBusy(true); setMessage(undefined);
    try {
      await window.eco.chatGptSubscriptionAccountSetProxy(proxyAccount.accountId, proxyDraft.trim() || undefined);
      setProxyAccount(undefined); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function login(accountId: string) {
    setBusy(true); setMessage(undefined);
    try {
      const result = await window.eco?.chatGptSubscriptionAccountLogin(accountId);
      if (result && !result.success) throw new Error(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function copyAuthorizationUrl(account: Account) {
    setBusy(true); setMessage(undefined);
    try {
      const result = await window.eco?.chatGptSubscriptionAccountAuthorizationUrl(account.accountId);
      if (!result?.success || !result.authorizationUrl) throw new Error(result?.message || "授权链接生成失败");
      if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持复制到剪贴板，请使用内置授权窗口");
      await navigator.clipboard.writeText(result.authorizationUrl);
      setMessage("授权链接已复制，请在已登录 ChatGPT 的浏览器中打开；完成授权后返回 Eco Coding。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function testAccount(account: Account) {
    setBusy(true); setTestResult(undefined);
    try {
      const result = await window.eco?.chatGptSubscriptionAccountTest(account.accountId, selectedModel);
      if (!result) throw new Error("测试服务不可用");
      setTestResult(result);
      await refresh();
    } catch (error) { setTestResult({ success: false, message: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  }

  async function setEnabled(account: Account) {
    setBusy(true); setMessage(undefined);
    try { await window.eco?.chatGptSubscriptionAccountSetEnabled(account.accountId, !account.enabled); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function resetAvailability(account: Account) {
    setBusy(true); setMessage(undefined);
    try {
      await window.eco?.chatGptSubscriptionAccountResetAvailability(account.accountId);
      await refresh();
      setMessage("已清除本地不可用状态，可以重新测试账号。");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function deleteAccount(account: Account) {
    setBusy(true); setMessage(undefined);
    try { await window.eco?.chatGptSubscriptionAccountDelete(account.accountId); setDialog(undefined); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  const availableCount = accounts.filter((account) => account.enabled && account.status === "ready").length;
  const openAddDialog = () => { setMessage(undefined); setDisplayName(`ChatGPT 账号 ${accounts.length + 1}`); setProxyDraft(""); setDialog("add"); };

  return (
    <section className="chatgpt-subscription-panel providers-list-section">
      <div className="chatgpt-subscription-hero">
        <div className="chatgpt-subscription-heading">
          <h2>ChatGPT 账号</h2>
          <p><ShieldCheck size={14} />官方 OAuth 授权，使用 ChatGPT 订阅与 Agent 对话。</p>
        </div>
        <button type="button" className="settings-primary-button" disabled={busy} onClick={openAddDialog}><Plus size={15} /> 添加账号</button>
      </div>

      <div className="chatgpt-list-toolbar">
        <span>{accounts.length} 个账号<span className="chatgpt-toolbar-divider">·</span>{availableCount} 个可用</span>
        <div className="chatgpt-toolbar-links">
          <button type="button" className="chatgpt-inline-link" disabled={busy || modelsLoading || !availableCount} onClick={() => void refreshModels()}><RefreshCw size={13} className={modelsLoading ? "mcp-spin" : undefined} />{modelsLoading ? "同步中…" : "同步模型"}</button>
          <a className="chatgpt-inline-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">套餐与工作区 <ExternalLink size={12} /></a>
        </div>
      </div>

      {message ? <p className="chatgpt-notice" role="status">{message}</p> : null}
      {modelsError ? <p className="chatgpt-notice is-error" role="alert">模型同步失败：{modelsError}</p> : null}
      {accounts.length === 0 ? (
        <div className="chatgpt-empty-state">
          <UserRound size={24} />
          <strong>尚未添加 ChatGPT 账号</strong>
          <p>添加并授权账号后，即可在对话中选择 ChatGPT 模型。</p>
          <button type="button" className="settings-primary-button" disabled={busy} onClick={openAddDialog}><Plus size={15} /> 添加账号</button>
        </div>
      ) : (
        <div className="chatgpt-account-list">
          {accounts.map((account) => {
            const tone = statusTone(account);
            return <article key={account.accountId} className="chatgpt-account-row">
              <div className="chatgpt-account-row-main">
                <div className="chatgpt-account-avatar"><img src="./provider-icons/openai.svg" alt="ChatGPT" /></div>
                <div className="chatgpt-account-identity"><strong title={account.displayName}>{account.displayName}</strong><span title={account.email}>{account.email || "尚未绑定邮箱"}</span></div>
                <span className={`chatgpt-status-badge is-${tone}`}><i />{statusLabel(account)}</span>
                <div className="chatgpt-account-actions">
                  {account.hasCredentials && account.status !== "reauthorization_required" ? <button type="button" className="chatgpt-action-secondary" disabled={busy} onClick={() => { setTestResult(undefined); setTestDialog(account); if (!models.length && account.status === "ready") void refreshModels(); }}>测试连接</button> : <button type="button" className="chatgpt-action-primary" disabled={busy} onClick={() => void login(account.accountId)}><KeyRound size={14} />{account.hasCredentials ? "重新授权" : "开始授权"}</button>}
                  <button type="button" className="mcp-icon-button" aria-label={`${account.displayName} 更多操作`} aria-haspopup="menu" aria-expanded={menu?.account.accountId === account.accountId} disabled={busy} onClick={(event) => {
                    if (menu?.account.accountId === account.accountId) { setMenu(undefined); return; }
                    menuTriggerRef.current = event.currentTarget;
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ account, top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 246)), left: Math.max(8, Math.min(rect.right - 180, window.innerWidth - 188)) });
                  }}><MoreHorizontal size={16} /></button>
                </div>
              </div>
              <div className="chatgpt-account-meta">
                <button type="button" className="chatgpt-proxy-link" disabled={busy} onClick={() => { setMessage(undefined); setProxyDraft(account.proxyUrl ?? ""); setProxyAccount(account); }}><Globe2 size={13} />{account.proxyUrl ? "独立代理" : "全局代理"}<span>配置</span></button>
                <span>{formatLastUsed(account.lastSuccessAt)}</span>
              </div>
              {account.status === "not_eligible" ? <p className="chatgpt-account-warning">当前账号不具备订阅共享资格，可在 ChatGPT 中检查套餐与工作区，或通过更多操作重新检测。</p> : null}
            </article>;
          })}
        </div>
      )}

      {menu ? createPortal(
        <div ref={menuRef} className="account-action-menu chatgpt-action-menu" role="menu" aria-label="账号操作" style={{ position: "fixed", top: menu.top, left: menu.left }}>
          <button type="button" role="menuitem" className="account-action-item" onClick={() => { setMenu(undefined); void login(menu.account.accountId); }}><KeyRound size={14} />{menu.account.hasCredentials ? "重新授权" : "开始授权"}</button>
          <button type="button" role="menuitem" className="account-action-item" onClick={() => { setMenu(undefined); void copyAuthorizationUrl(menu.account); }}><Copy size={14} />复制授权链接</button>
          {menu.account.hasCredentials && !["ready", "needs_login", "disabled"].includes(menu.account.status) ? <button type="button" role="menuitem" className="account-action-item" onClick={() => { setMenu(undefined); void resetAvailability(menu.account); }}><RefreshCw size={14} />重新检测</button> : null}
          <button type="button" role="menuitem" className="account-action-item" onClick={() => { setMenu(undefined); void setEnabled(menu.account); }}>{menu.account.enabled ? "停用账号" : "启用账号"}</button>
          <button type="button" role="menuitem" className="account-action-item danger" onClick={() => { setMenu(undefined); setMessage(undefined); setDialog(menu.account); }}><Trash2 size={14} />删除账号</button>
        </div>, document.body,
      ) : null}

      {testDialog ? createPortal(
        <div className="settings-modal-backdrop">
          <button type="button" className="settings-modal-backdrop-close" aria-label="关闭" disabled={busy} onClick={() => setTestDialog(undefined)} tabIndex={-1} />
          <form ref={dialogRef} className="settings-modal settings-modal-provider-editor chatgpt-test-modal" role="dialog" aria-modal="true" aria-labelledby="chatgpt-test-title" onSubmit={(event) => { event.preventDefault(); if (!busy && selectedModel) void testAccount(testDialog); }}>
            <header className="settings-modal-header"><h2 className="settings-modal-title" id="chatgpt-test-title">测试连接</h2><button type="button" className="mcp-icon-button" aria-label="关闭" disabled={busy} onClick={() => setTestDialog(undefined)}><X size={17} /></button></header>
            <div className="settings-modal-body openai-account-modal-body">
              <p className="chatgpt-test-description">向选定模型发送“hi”，检查 {testDialog.displayName} 的连接。</p>
              <div className="chatgpt-test-model-section">
                <label className="mcp-field"><span className="mcp-field-label">测试模型</span><select className="mcp-field-input" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={busy || modelsLoading || !models.length} autoFocus><option value="">{modelsLoading ? "获取模型中…" : "请选择模型"}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName || model.id}</option>)}</select></label>
                <button type="button" className="chatgpt-inline-link chatgpt-test-refresh-link" disabled={busy || modelsLoading} onClick={() => void refreshModels()}><RefreshCw size={13} />重新获取模型</button>
              </div>
              {modelsError ? <p className="chatgpt-notice is-error" role="alert">{modelsError}</p> : null}
              {testDialog.status === "not_eligible" ? <p className="chatgpt-notice">此账号上次被官方判定为订阅共享资格不可用。本次测试会直接向官方接口验证。</p> : null}
              {testResult ? <p className={`chatgpt-notice ${testResult.success ? "is-success" : "is-error"}`} role="status">{testResult.message}</p> : null}
            </div>
            <footer className="settings-modal-footer"><button type="button" className="settings-modal-cancel" disabled={busy} onClick={() => setTestDialog(undefined)}>关闭</button><button type="submit" className="settings-primary-button" disabled={busy || modelsLoading || !selectedModel}>{busy ? "测试中…" : "发送 hi"}</button></footer>
          </form>
        </div>, document.body,
      ) : null}

      {dialog ? createPortal(
        <div className="settings-modal-backdrop">
          <button type="button" className="settings-modal-backdrop-close" aria-label="关闭" disabled={busy} onClick={() => setDialog(undefined)} tabIndex={-1} />
          <form ref={dialogRef} className="settings-modal settings-modal-provider-editor" role="dialog" aria-modal="true" aria-labelledby="chatgpt-account-dialog-title" onSubmit={(event) => { event.preventDefault(); if (!busy) void (dialog === "add" ? addAccount() : deleteAccount(dialog)); }}>
            <header className="settings-modal-header"><h2 className="settings-modal-title" id="chatgpt-account-dialog-title">{dialog === "add" ? "添加 ChatGPT 订阅账号" : "删除 ChatGPT 订阅账号"}</h2><button type="button" className="mcp-icon-button" aria-label="关闭" disabled={busy} onClick={() => setDialog(undefined)}><X size={17} /></button></header>
            <div className="settings-modal-body openai-account-modal-body">
              {dialog === "add" ? <><label className="mcp-field"><span className="mcp-field-label">账号显示名称</span><input className="mcp-field-input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={busy} required autoFocus /><span className="mcp-field-hint">创建后会打开官方 OAuth 授权窗口。</span></label><label className="mcp-field"><span className="mcp-field-label">账号代理 <em>可选</em></span><input className="mcp-field-input" value={proxyDraft} onChange={(event) => setProxyDraft(event.target.value)} placeholder="留空则使用全局代理" disabled={busy} /><span className="mcp-field-hint">支持 HTTP、HTTPS 和 SOCKS5，也支持用户名密码。</span></label></> : <div className="chatgpt-delete-copy"><div className="chatgpt-delete-icon"><Trash2 size={18} /></div><p>删除“{dialog.displayName}”的授权和本地凭据？</p><small>删除后需要重新登录才能使用此账号。</small></div>}
              {message ? <p className="settings-form-error" role="alert">{message}</p> : null}
            </div>
            <footer className="settings-modal-footer"><button type="button" className="settings-modal-cancel" disabled={busy} onClick={() => setDialog(undefined)} autoFocus={dialog !== "add"}>取消</button><div className="settings-modal-footer-actions">{dialog === "add" ? <button type="button" className="settings-modal-cancel" disabled={busy || !displayName.trim()} onClick={() => void addAccount(true)}>添加并复制链接</button> : null}<button type="submit" className={dialog === "add" ? "settings-primary-button" : "settings-danger-button"} disabled={busy || (dialog === "add" && !displayName.trim())}>{busy ? "处理中…" : dialog === "add" ? "添加并登录" : "删除账号"}</button></div></footer>
          </form>
        </div>, document.body,
      ) : null}

      {proxyAccount ? createPortal(
        <div className="settings-modal-backdrop">
          <button type="button" className="settings-modal-backdrop-close" aria-label="关闭" disabled={busy} onClick={() => setProxyAccount(undefined)} tabIndex={-1} />
          <form ref={dialogRef} className="settings-modal settings-modal-provider-editor" role="dialog" aria-modal="true" aria-labelledby="chatgpt-account-proxy-title" onSubmit={(event) => { event.preventDefault(); void saveProxy(); }}>
            <header className="settings-modal-header"><h2 className="settings-modal-title" id="chatgpt-account-proxy-title">账号代理</h2><button type="button" className="mcp-icon-button" aria-label="关闭" disabled={busy} onClick={() => setProxyAccount(undefined)}><X size={17} /></button></header>
            <div className="settings-modal-body openai-account-modal-body"><p className="chatgpt-proxy-account-name">{proxyAccount.displayName}</p><label className="mcp-field"><span className="mcp-field-label">代理 URL</span><input className="mcp-field-input" value={proxyDraft} onChange={(event) => setProxyDraft(event.target.value)} placeholder="留空则使用全局代理" disabled={busy} autoFocus /><span className="mcp-field-hint">此账号的官方授权和 API 请求都会使用该代理。</span></label>{message ? <p className="settings-form-error" role="alert">{message}</p> : null}</div>
            <footer className="settings-modal-footer"><button type="button" className="settings-modal-cancel" disabled={busy} onClick={() => setProxyAccount(undefined)}>取消</button><div className="settings-modal-footer-actions"><button type="submit" className="settings-primary-button" disabled={busy}>{busy ? "保存中…" : "保存代理"}</button></div></footer>
          </form>
        </div>, document.body,
      ) : null}
    </section>
  );
}
