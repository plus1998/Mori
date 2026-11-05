import { Switch } from "./components/Switch";
import { KeyRound, Loader2, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { CursorApiKeyInput, CursorApiKeyView } from "../shared/ipc";

interface CursorApiKeysPanelProps {
  busy?: boolean | undefined;
  revision?: number;
}

type DialogState =
  | { type: "add" }
  | { type: "edit"; account: CursorApiKeyView }
  | { type: "delete"; account: CursorApiKeyView }
  | { type: "import" };

export function CursorApiKeysPanel({ busy = false, revision = 0 }: CursorApiKeysPanelProps) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<CursorApiKeyView[]>([]);
  const [dialog, setDialog] = useState<DialogState>();
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [importText, setImportText] = useState("");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
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

  const mutate = async (operation: (api: NonNullable<typeof window.eco>) => Promise<void>) => {
    if (disabled) return;
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
    setName(`Cursor API Key ${accounts.length + 1}`);
    setApiKey("");
    setDialog({ type: "add" });
  };

  const openEdit = (account: CursorApiKeyView) => {
    setError(undefined);
    setMessage(undefined);
    setName(account.name);
    setApiKey("");
    setDialog({ type: "edit", account });
  };

  const save = async () => {
    if (!dialog || (dialog.type !== "add" && dialog.type !== "edit")) return;
    await mutate(async (api) => {
      const input: CursorApiKeyInput = {
        ...(dialog.type === "edit" ? { id: dialog.account.id } : {}),
        name,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        enabled: dialog.type === "edit" ? dialog.account.enabled : true,
      };
      const updated = await api.saveCursorApiKey(input);
      setAccounts((current) => dialog.type === "edit"
        ? current.map((item) => item.id === updated.id ? updated : item)
        : [...current, updated]);
      setDialog(undefined);
      setApiKey("");
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
          {filteredAccounts.map((account) => (
            <article className={`codex-account-card cursor-api-key-card${account.enabled ? "" : " is-disabled"}`} key={account.id}>
              <div className="codex-account-card-main">
                <div className="codex-account-avatar"><KeyRound size={17} /></div>
                <div className="codex-account-identity">
                  <strong title={account.name}>{account.name}</strong>
                  <span className="cursor-api-key-preview">{account.apiKeyPreview}</span>
                </div>
                <span className={`codex-status-badge ${account.enabled ? "is-ready" : "is-danger"}`}><i />{t(account.enabled ? "settings.cursorApiKeys.stateEnabled" : "settings.cursorApiKeys.stateDisabled")}</span>
                <div className="codex-account-actions">
                  <Switch
                    title={account.enabled ? t("settings.cursorApiKeys.disable") : t("settings.cursorApiKeys.enabled")}
                    checked={account.enabled}
                    disabled={disabled}
                    aria-label={`${account.name}: ${t("settings.cursorApiKeys.enabled")}`}
                    onCheckedChange={() => void toggle(account)}
                  />
                  <button type="button" className="mcp-icon-button" title={t("settings.cursorApiKeys.edit")} aria-label={t("settings.cursorApiKeys.edit")} disabled={disabled} onClick={() => openEdit(account)}><Pencil size={14} /></button>
                  <button type="button" className="mcp-icon-button danger" title={t("settings.cursorApiKeys.delete")} aria-label={t("settings.cursorApiKeys.delete")} disabled={disabled} onClick={() => { setError(undefined); setDialog({ type: "delete", account }); }}><Trash2 size={14} /></button>
                </div>
              </div>
            </article>
          ))}
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
                <label className="mcp-field">
                  <span className="mcp-field-label">{t("settings.cursorApiKeys.value")}</span>
                  <input className="mcp-field-input" type="password" autoComplete="off" value={apiKey} placeholder={dialog.type === "edit" ? dialog.account.apiKeyPreview : t("settings.cursorApiKeys.valuePlaceholder")} disabled={disabled} onChange={(event) => setApiKey(event.target.value)} />
                  {dialog.type === "edit" ? <span className="mcp-field-hint">{t("settings.cursorApiKeys.keepExisting")}</span> : null}
                </label>
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
                <button type="button" className="plan-button primary" disabled={disabled || !name.trim() || (!apiKey.trim() && dialog.type === "add")} onClick={() => void save()}>{mutating ? <Loader2 size={14} className="mcp-spin" /> : null}{t("common.save")}</button>
              )}
            </footer>
          </div>
        </div>, document.body,
      ) : null}
    </section>
  );
}
