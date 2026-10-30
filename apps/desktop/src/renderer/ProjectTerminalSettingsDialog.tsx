import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_TERMINAL_STARTUP_COMMAND_LENGTH } from "../shared/project-terminal-settings";
import "./project-terminal-settings.css";

export function ProjectTerminalSettingsDialog({
  workspacePath,
  projectName,
  onClose,
}: {
  workspacePath: string;
  projectName: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const commandRef = useRef<HTMLTextAreaElement>(null);
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (loaded) commandRef.current?.focus();
  }, [loaded]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (!window.eco) throw new Error("Desktop API unavailable");
        const snapshot = await window.eco.getProjectTerminalSettings(workspacePath);
        if (!cancelled) {
          setCommand(snapshot.startupCommand);
          setLoaded(true);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  async function save() {
    if (!loaded || saving || !window.eco) return;
    setSaving(true);
    setError(undefined);
    try {
      await window.eco.saveProjectTerminalSettings({ workspacePath, startupCommand: command });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="settings-modal project-terminal-settings-modal"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="settings-modal-header">
          <h2 id={`${id}-title`} className="settings-modal-title">
            {t("terminal.projectSettingsTitle", { name: projectName })}
          </h2>
        </header>
        <div className="settings-modal-body">
          <p className="project-terminal-settings-path">{workspacePath}</p>
          <div className="settings-field">
            <label htmlFor={`${id}-command`}>{t("terminal.startupCommand")}</label>
            <textarea
              ref={commandRef}
              id={`${id}-command`}
              rows={4}
              maxLength={MAX_TERMINAL_STARTUP_COMMAND_LENGTH}
              placeholder="nvm use 18"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={command}
              disabled={loading || saving || !loaded}
              aria-describedby={`${id}-hint`}
              onChange={(event) => setCommand(event.target.value)}
            />
            <span id={`${id}-hint`} className="settings-field-hint">
              {t("terminal.startupCommandHint")}
            </span>
          </div>
          {loading ? <p role="status">{t("common.loading")}</p> : null}
          {error ? (
            <p className="settings-form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="settings-modal-footer">
          <button type="button" className="settings-modal-cancel" disabled={saving} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="settings-modal-confirm" disabled={!loaded || saving}>
            {t(saving ? "terminal.savingSettings" : "common.save")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
