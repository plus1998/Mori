import { KeyRound, Lock, Pencil, Plus, Server, Trash2, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { CenterServerSyncDomain, CenterServerSyncDomainResult } from "../shared/center-server";
import type {
  SshAuthType,
  SshBookmarkSaveInput,
  SshBookmarkView,
  SshKeySource,
} from "../shared/ssh-bookmarks";
import { SSH_DEFAULT_PORT, sshBookmarkEndpointLabel } from "../shared/ssh-bookmarks";
import { SettingsSyncControl } from "./SettingsSyncControl";

export interface SshBookmarksPanelProps {
  workspacePath: string;
  bookmarks: SshBookmarkView[];
  busy?: boolean;
  centerServerSyncVisible?: boolean;
  onBookmarksChange: (bookmarks: SshBookmarkView[]) => void;
  onConnect: (bookmark: SshBookmarkView) => void | Promise<void>;
  onSyncDomain?: (
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ) => Promise<CenterServerSyncDomainResult>;
}

type FormMode = "idle" | "create" | "edit";

const emptyDraft = (): SshBookmarkSaveInput => ({
  name: "",
  host: "",
  port: SSH_DEFAULT_PORT,
  username: "",
  authType: "password",
  keySource: "path",
  keyPath: "",
  password: "",
  storedKey: "",
  extraArgs: "",
});

function SshBookmarkEditorDialog({
  open,
  mode,
  draft,
  editingBookmark,
  formError,
  saving,
  busy,
  onDraftChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "edit";
  draft: SshBookmarkSaveInput;
  editingBookmark?: SshBookmarkView;
  formError?: string;
  saving: boolean;
  busy?: boolean;
  onDraftChange: (updater: (current: SshBookmarkSaveInput) => SshBookmarkSaveInput) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const { t } = useTranslation();

  const fillDefaultKeyPath = useCallback(async () => {
    const defaultPath = (await window.eco?.getDefaultSshKeyPath?.())?.trim();
    if (!defaultPath) {
      return;
    }
    onDraftChange((current) => {
      if (current.authType !== "key" || current.keySource !== "path" || current.keyPath?.trim()) {
        return current;
      }
      return { ...current, keyPath: defaultPath };
    });
  }, [onDraftChange]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, saving]);

  if (!open) {
    return null;
  }

  const title = mode === "create" ? t("app.sshBookmarks.add") : t("app.sshBookmarks.edit");

  return createPortal(
    <div
      className="settings-modal-backdrop"
      onClick={() => {
        if (!saving) {
          onClose();
        }
      }}
    >
      <div
        className="settings-modal ssh-bookmarks-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-bookmark-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-modal-header">
          <h2 id="ssh-bookmark-dialog-title" className="settings-modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="mcp-icon-button"
            aria-label={t("app.sshBookmarks.cancel")}
            title={t("app.sshBookmarks.cancel")}
            disabled={saving}
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        <form className="ssh-bookmarks-dialog-form" onSubmit={onSubmit}>
          <div className="settings-modal-body ssh-bookmarks-dialog-body">
            <label className="ssh-bookmarks-field">
              <span>{t("app.sshBookmarks.nameLabel")}</span>
              <input
                type="text"
                value={draft.name}
                onChange={(event) => onDraftChange((current) => ({ ...current, name: event.target.value }))}
                placeholder={t("app.sshBookmarks.namePlaceholder")}
                autoFocus
                maxLength={80}
              />
            </label>

            <div className="ssh-bookmarks-field-row">
              <label className="ssh-bookmarks-field">
                <span>{t("app.sshBookmarks.hostLabel")}</span>
                <input
                  type="text"
                  value={draft.host}
                  onChange={(event) => onDraftChange((current) => ({ ...current, host: event.target.value }))}
                  placeholder={t("app.sshBookmarks.hostPlaceholder")}
                  maxLength={253}
                />
              </label>
              <label className="ssh-bookmarks-field ssh-bookmarks-field--port">
                <span>{t("app.sshBookmarks.portLabel")}</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port ?? SSH_DEFAULT_PORT}
                  onChange={(event) =>
                    onDraftChange((current) => ({
                      ...current,
                      port: Number.parseInt(event.target.value, 10) || SSH_DEFAULT_PORT,
                    }))
                  }
                />
              </label>
            </div>

            <label className="ssh-bookmarks-field">
              <span>{t("app.sshBookmarks.usernameLabel")}</span>
              <input
                type="text"
                value={draft.username}
                onChange={(event) =>
                  onDraftChange((current) => ({ ...current, username: event.target.value }))
                }
                placeholder={t("app.sshBookmarks.usernamePlaceholder")}
                maxLength={64}
              />
            </label>

            <fieldset className="ssh-bookmarks-auth-fieldset">
              <legend>{t("app.sshBookmarks.authTypeLabel")}</legend>
              <label className="ssh-bookmarks-radio">
                <input
                  type="radio"
                  name="ssh-auth-type"
                  checked={draft.authType === "password"}
                  onChange={() =>
                    onDraftChange((current) => ({ ...current, authType: "password" as SshAuthType }))
                  }
                />
                <span>{t("app.sshBookmarks.authPassword")}</span>
              </label>
              <label className="ssh-bookmarks-radio">
                <input
                  type="radio"
                  name="ssh-auth-type"
                  checked={draft.authType === "key"}
                  onChange={() => {
                    onDraftChange((current) => ({
                      ...current,
                      authType: "key" as SshAuthType,
                      keySource: (current.keySource ?? "path") as SshKeySource,
                    }));
                    void fillDefaultKeyPath();
                  }}
                />
                <span>{t("app.sshBookmarks.authKey")}</span>
              </label>
            </fieldset>

            {draft.authType === "password" ? (
              <label className="ssh-bookmarks-field">
                <span>{t("app.sshBookmarks.passwordLabel")}</span>
                <input
                  type="password"
                  value={draft.password ?? ""}
                  onChange={(event) =>
                    onDraftChange((current) => ({ ...current, password: event.target.value }))
                  }
                  placeholder={
                    mode === "edit" && editingBookmark?.hasPassword
                      ? t("app.sshBookmarks.passwordKeepPlaceholder")
                      : t("app.sshBookmarks.passwordPlaceholder")
                  }
                  autoComplete="off"
                />
              </label>
            ) : (
              <>
                <fieldset className="ssh-bookmarks-auth-fieldset">
                  <legend>{t("app.sshBookmarks.keySourceLabel")}</legend>
                  <label className="ssh-bookmarks-radio">
                    <input
                      type="radio"
                      name="ssh-key-source"
                      checked={draft.keySource === "path"}
                      onChange={() => {
                        onDraftChange((current) => ({ ...current, keySource: "path" as SshKeySource }));
                        void fillDefaultKeyPath();
                      }}
                    />
                    <span>{t("app.sshBookmarks.keyPathOption")}</span>
                  </label>
                  <label className="ssh-bookmarks-radio">
                    <input
                      type="radio"
                      name="ssh-key-source"
                      checked={draft.keySource === "stored"}
                      onChange={() =>
                        onDraftChange((current) => ({ ...current, keySource: "stored" as SshKeySource }))
                      }
                    />
                    <span>{t("app.sshBookmarks.keyStoredOption")}</span>
                  </label>
                </fieldset>
                {draft.keySource === "path" ? (
                  <label className="ssh-bookmarks-field">
                    <span>{t("app.sshBookmarks.keyPathLabel")}</span>
                    <input
                      type="text"
                      value={draft.keyPath ?? ""}
                      onChange={(event) =>
                        onDraftChange((current) => ({ ...current, keyPath: event.target.value }))
                      }
                      placeholder={t("app.sshBookmarks.keyPathPlaceholder")}
                      maxLength={1024}
                    />
                  </label>
                ) : (
                  <label className="ssh-bookmarks-field">
                    <span>{t("app.sshBookmarks.storedKeyLabel")}</span>
                    <textarea
                      value={draft.storedKey ?? ""}
                      onChange={(event) =>
                        onDraftChange((current) => ({ ...current, storedKey: event.target.value }))
                      }
                      placeholder={
                        mode === "edit" && editingBookmark?.hasStoredKey
                          ? t("app.sshBookmarks.storedKeyKeepPlaceholder")
                          : t("app.sshBookmarks.storedKeyPlaceholder")
                      }
                      rows={4}
                      spellCheck={false}
                    />
                  </label>
                )}
              </>
            )}

            <label className="ssh-bookmarks-field">
              <span>{t("app.sshBookmarks.extraArgsLabel")}</span>
              <input
                type="text"
                value={draft.extraArgs ?? ""}
                onChange={(event) =>
                  onDraftChange((current) => ({ ...current, extraArgs: event.target.value }))
                }
                placeholder={t("app.sshBookmarks.extraArgsPlaceholder")}
                maxLength={500}
              />
            </label>

            {formError ? <p className="ssh-bookmarks-form-error">{formError}</p> : null}
          </div>

          <footer className="settings-modal-footer ssh-bookmarks-dialog-footer">
            <button type="button" className="settings-modal-cancel" disabled={saving} onClick={onClose}>
              {t("app.sshBookmarks.cancel")}
            </button>
            <button type="submit" className="settings-modal-confirm" disabled={saving || busy}>
              {saving ? t("app.sshBookmarks.saving") : t("app.sshBookmarks.save")}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}

export function SshBookmarksPanel({
  workspacePath,
  bookmarks,
  busy,
  centerServerSyncVisible,
  onBookmarksChange,
  onConnect,
  onSyncDomain,
}: SshBookmarksPanelProps) {
  const { t } = useTranslation();
  const [formMode, setFormMode] = useState<FormMode>("idle");
  const [draft, setDraft] = useState<SshBookmarkSaveInput>(emptyDraft);
  const [editingBookmark, setEditingBookmark] = useState<SshBookmarkView | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [panelError, setPanelError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [connectingId, setConnectingId] = useState<string | undefined>();

  useEffect(() => {
    if (formMode === "idle") {
      setDraft(emptyDraft());
      setEditingBookmark(undefined);
      setFormError(undefined);
    }
  }, [formMode]);

  const mapSaveError = useCallback(
    (reason: string) => {
      switch (reason) {
        case "invalid_name":
          return t("app.sshBookmarks.invalidName");
        case "invalid_host":
          return t("app.sshBookmarks.invalidHost");
        case "invalid_username":
          return t("app.sshBookmarks.invalidUsername");
        case "invalid_port":
          return t("app.sshBookmarks.invalidPort");
        case "invalid_auth":
          return t("app.sshBookmarks.invalidAuth");
        case "invalid_key_path":
          return t("app.sshBookmarks.invalidKeyPath");
        case "missing_password":
          return t("app.sshBookmarks.missingPassword");
        case "missing_stored_key":
          return t("app.sshBookmarks.missingStoredKey");
        case "duplicate_name":
          return t("app.sshBookmarks.duplicateName");
        default:
          return reason;
      }
    },
    [t],
  );

  const closeEditor = useCallback(() => {
    if (saving) {
      return;
    }
    setFormMode("idle");
  }, [saving]);

  const startCreate = useCallback(() => {
    setDraft(emptyDraft());
    setEditingBookmark(undefined);
    setFormError(undefined);
    setFormMode("create");
  }, []);

  const startEdit = useCallback((bookmark: SshBookmarkView) => {
    setEditingBookmark(bookmark);
    setDraft({
      id: bookmark.id,
      name: bookmark.name,
      host: bookmark.host,
      port: bookmark.port,
      username: bookmark.username,
      authType: bookmark.authType,
      keySource: bookmark.keySource ?? "path",
      keyPath: bookmark.keyPath ?? "",
      extraArgs: bookmark.extraArgs ?? "",
      password: "",
      storedKey: "",
    });
    setFormError(undefined);
    setFormMode("edit");
  }, []);

  const persist = useCallback(
    async (input: SshBookmarkSaveInput) => {
      if (!window.eco?.saveSshBookmark) {
        throw new Error("SSH bookmark API unavailable");
      }
      const saved = await window.eco.saveSshBookmark(input);
      const next = await window.eco.getSshBookmarks?.();
      if (next) {
        onBookmarksChange(next);
      } else {
        onBookmarksChange(
          bookmarks.some((item) => item.id === saved.id)
            ? bookmarks.map((item) => (item.id === saved.id ? saved : item))
            : [...bookmarks, saved],
        );
      }
      return saved;
    },
    [bookmarks, onBookmarksChange],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setFormError(undefined);
      setSaving(true);
      try {
        await persist(draft);
        setFormMode("idle");
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setFormError(mapSaveError(message));
      } finally {
        setSaving(false);
      }
    },
    [draft, mapSaveError, persist],
  );

  const handleDelete = useCallback(
    async (bookmark: SshBookmarkView) => {
      if (!window.eco?.deleteSshBookmark) {
        return;
      }
      setSaving(true);
      try {
        const next = await window.eco.deleteSshBookmark(bookmark.id);
        onBookmarksChange(next);
        if (editingBookmark?.id === bookmark.id) {
          setFormMode("idle");
        }
      } finally {
        setSaving(false);
      }
    },
    [editingBookmark?.id, onBookmarksChange],
  );

  const handleConnect = useCallback(
    async (bookmark: SshBookmarkView) => {
      if (!workspacePath.trim()) {
        setPanelError(t("app.sshBookmarks.noWorkspace"));
        return;
      }
      setPanelError(undefined);
      setConnectingId(bookmark.id);
      try {
        await onConnect(bookmark);
      } finally {
        setConnectingId(undefined);
      }
    },
    [onConnect, t, workspacePath],
  );

  return (
    <section className="ssh-bookmarks-panel" aria-labelledby="ssh-bookmarks-title">
      <header className="ssh-bookmarks-header">
        <h2 id="ssh-bookmarks-title">{t("app.sshBookmarks.title")}</h2>
        <div className="ssh-bookmarks-header-actions">
          {onSyncDomain ? (
            <SettingsSyncControl
              domain="sshBookmarks"
              visible={centerServerSyncVisible ?? false}
              disabled={busy || saving}
              onSync={onSyncDomain}
            />
          ) : null}
          <button
            type="button"
            className="cs-icon-btn ssh-bookmarks-add-btn"
            onClick={startCreate}
            disabled={busy || saving || formMode !== "idle"}
            aria-label={t("app.sshBookmarks.add")}
            title={t("app.sshBookmarks.add")}
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <p className="ssh-bookmarks-subtitle">{t("app.sshBookmarks.subtitle")}</p>
      </header>

      {panelError ? <p className="ssh-bookmarks-panel-error">{panelError}</p> : null}

      <div className="ssh-bookmarks-list" role="list">
        {bookmarks.length === 0 ? (
          <p className="ssh-bookmarks-empty">{t("app.sshBookmarks.empty")}</p>
        ) : (
          bookmarks.map((bookmark) => (
            <div key={bookmark.id} className="ssh-bookmarks-row" role="listitem">
              <button
                type="button"
                className="ssh-bookmarks-item"
                disabled={Boolean(connectingId) || saving || busy}
                onClick={() => void handleConnect(bookmark)}
                title={`${bookmark.name}\n${sshBookmarkEndpointLabel(bookmark)}`}
              >
                <span className="ssh-bookmarks-item-icon" aria-hidden>
                  {bookmark.authType === "password" ? (
                    <Lock size={16} strokeWidth={1.5} />
                  ) : (
                    <KeyRound size={16} strokeWidth={1.5} />
                  )}
                </span>
                <span className="ssh-bookmarks-item-body">
                  <span className="ssh-bookmarks-item-title">{bookmark.name}</span>
                  <span className="ssh-bookmarks-item-desc">{sshBookmarkEndpointLabel(bookmark)}</span>
                </span>
                {connectingId === bookmark.id ? (
                  <span className="ssh-bookmarks-item-status">{t("app.sshBookmarks.connecting")}</span>
                ) : null}
              </button>
              <div className="ssh-bookmarks-row-actions">
                <button
                  type="button"
                  className="ssh-bookmarks-icon-btn"
                  title={t("app.sshBookmarks.edit")}
                  aria-label={t("app.sshBookmarks.editNamed", { name: bookmark.name })}
                  disabled={saving || busy}
                  onClick={() => startEdit(bookmark)}
                >
                  <Pencil size={15} strokeWidth={1.5} aria-hidden />
                </button>
                <button
                  type="button"
                  className="ssh-bookmarks-icon-btn ssh-bookmarks-remove"
                  title={t("app.sshBookmarks.remove")}
                  aria-label={t("app.sshBookmarks.removeNamed", { name: bookmark.name })}
                  disabled={saving || busy}
                  onClick={() => void handleDelete(bookmark)}
                >
                  <Trash2 size={15} strokeWidth={1.5} aria-hidden />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <SshBookmarkEditorDialog
        open={formMode !== "idle"}
        mode={formMode === "edit" ? "edit" : "create"}
        draft={draft}
        {...(editingBookmark ? { editingBookmark } : {})}
        {...(formError ? { formError } : {})}
        saving={saving}
        {...(busy !== undefined ? { busy } : {})}
        onDraftChange={setDraft}
        onClose={closeEditor}
        onSubmit={(event) => void handleSubmit(event)}
      />

      {!workspacePath.trim() ? (
        <p className="ssh-bookmarks-hint">
          <Server size={14} aria-hidden />
          <span>{t("app.sshBookmarks.noWorkspace")}</span>
        </p>
      ) : null}
    </section>
  );
}
