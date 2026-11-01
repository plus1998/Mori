import { FolderOpen, Pencil, Play, Plus, Square, Terminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { BackgroundTerminalTask, StartupScript, StartupScriptSaveInput } from "../shared/ipc";

type ScriptTask = Pick<BackgroundTerminalTask, "taskId" | "startupScriptId" | "status" | "startedAt" | "exitCode">;

const emptyDraft = (workspacePath: string): StartupScriptSaveInput => ({
  name: "",
  workspacePath,
  command: "",
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRunning(task: ScriptTask | undefined): boolean {
  return task?.status === "starting" || task?.status === "running";
}

export function StartupScriptsPanel({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const [scripts, setScripts] = useState<StartupScript[]>([]);
  const [tasks, setTasks] = useState<ScriptTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [workingId, setWorkingId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<StartupScriptSaveInput>(() => emptyDraft(workspacePath));
  const [editorOpen, setEditorOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [logTaskId, setLogTaskId] = useState<string>();
  const [logText, setLogText] = useState("");
  const [logTruncated, setLogTruncated] = useState(false);

  const refresh = useCallback(async () => {
    const eco = window.eco;
    if (!eco?.listStartupScripts || !eco.listBackgroundTerminalTasks) {
      setLoadError(t("startupScripts.apiUnavailable"));
      setLoading(false);
      return;
    }
    try {
      const [nextScripts, allTasks] = await Promise.all([
        eco.listStartupScripts(),
        eco.listBackgroundTerminalTasks(),
      ]);
      setScripts(nextScripts);
      setTasks(allTasks.filter((task) => task.startupScriptId));
      setLoadError(undefined);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (!logTaskId) return;
    let disposed = false;
    const refreshLog = async () => {
      const openTask = window.eco?.openBackgroundTerminalTask;
      if (!openTask) return;
      try {
        const task = await openTask({ taskId: logTaskId });
        if (disposed) return;
        setLogText(task.output ?? "");
        setLogTruncated(task.outputTruncated ?? false);
      } catch (error) {
        if (!disposed) setActionError(errorMessage(error));
      }
    };
    void refreshLog();
    const timer = window.setInterval(() => void refreshLog(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [logTaskId]);

  const latestTaskByScript = useMemo(() => {
    const latest = new Map<string, ScriptTask>();
    for (const task of tasks) {
      if (!task.startupScriptId) continue;
      const previous = latest.get(task.startupScriptId);
      if (!previous || previous.startedAt < task.startedAt) latest.set(task.startupScriptId, task);
    }
    return latest;
  }, [tasks]);

  const beginCreate = () => {
    setEditingId(undefined);
    setDraft(emptyDraft(workspacePath));
    setActionError(undefined);
    setEditorOpen(true);
  };

  const beginEdit = (script: StartupScript) => {
    setEditingId(script.id);
    setDraft({ id: script.id, name: script.name, workspacePath: script.workspacePath, command: script.command });
    setActionError(undefined);
    setEditorOpen(true);
  };

  const cancelEdit = () => {
    setEditorOpen(false);
    setEditingId(undefined);
    setActionError(undefined);
  };

  const chooseDirectory = async () => {
    const choose = window.eco?.chooseStartupScriptDirectory;
    if (!choose) {
      setActionError(t("startupScripts.apiUnavailable"));
      return;
    }
    try {
      const selected = await choose({ defaultPath: draft.workspacePath || workspacePath });
      if (selected) setDraft((current) => ({ ...current, workspacePath: selected }));
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const saveScript = window.eco?.saveStartupScript;
    if (!saveScript) {
      setActionError(t("startupScripts.apiUnavailable"));
      return;
    }
    setSaving(true);
    setActionError(undefined);
    try {
      const fields = { name: draft.name, workspacePath: draft.workspacePath, command: draft.command };
      await saveScript({ ...fields, ...(editingId ? { id: editingId } : {}) });
      cancelEdit();
      await refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const start = async (script: StartupScript) => {
    const startScript = window.eco?.startStartupScript;
    if (!startScript) {
      setActionError(t("startupScripts.apiUnavailable"));
      return;
    }
    setWorkingId(script.id);
    setActionError(undefined);
    try {
      await startScript({ id: script.id });
      await refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorkingId(undefined);
    }
  };

  const stop = async (script: StartupScript, task: ScriptTask) => {
    const stopTask = window.eco?.stopBackgroundTerminalTask;
    if (!stopTask) {
      setActionError(t("startupScripts.apiUnavailable"));
      return;
    }
    setWorkingId(script.id);
    setActionError(undefined);
    try {
      const result = await stopTask({ taskId: task.taskId });
      if (!result.stopped) throw new Error(t("startupScripts.stopFailed"));
      await refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorkingId(undefined);
    }
  };

  const remove = async (script: StartupScript) => {
    const deleteScript = window.eco?.deleteStartupScript;
    if (!deleteScript) {
      setActionError(t("startupScripts.apiUnavailable"));
      return;
    }
    setWorkingId(script.id);
    setActionError(undefined);
    try {
      await deleteScript({ id: script.id });
      await refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setWorkingId(undefined);
    }
  };

  const showLog = async (task: ScriptTask) => {
    const getTask = window.eco?.openBackgroundTerminalTask;
    if (!getTask) {
      setActionError(t("startupScripts.apiUnavailable"));
      return;
    }
    setActionError(undefined);
    try {
      const fullTask = await getTask({ taskId: task.taskId });
      setLogTaskId(task.taskId);
      setLogText(fullTask.output ?? "");
      setLogTruncated(fullTask.outputTruncated ?? false);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  const formReady = Boolean(draft.name.trim() && draft.workspacePath.trim() && draft.command.trim());

  return (
    <section className="startup-scripts-panel" aria-labelledby="startup-scripts-title">
      <header className="startup-scripts-header">
        <div>
          <h2 id="startup-scripts-title">{t("startupScripts.title")}</h2>
          <p>{t("startupScripts.subtitle")}</p>
        </div>
        <button type="button" className="startup-scripts-add" onClick={beginCreate} disabled={editorOpen}>
          <Plus size={16} aria-hidden />
          <span>{t("startupScripts.add")}</span>
        </button>
      </header>

      {loadError ? <p className="startup-scripts-error" role="alert">{loadError}</p> : null}
      {actionError ? <p className="startup-scripts-error" role="alert">{actionError}</p> : null}

      {editorOpen ? (
        <form className="startup-scripts-editor" onSubmit={(event) => void save(event)}>
          <div className="startup-scripts-editor-heading">
            <h3>{editingId ? t("startupScripts.edit") : t("startupScripts.add")}</h3>
            <button type="button" className="startup-scripts-icon-button" onClick={cancelEdit} disabled={saving} aria-label={t("startupScripts.cancel")}>
              <X size={16} aria-hidden />
            </button>
          </div>
          <label>
            <span>{t("startupScripts.name")}</span>
            <input
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              maxLength={120}
              autoFocus
            />
          </label>
          <label>
            <span>{t("startupScripts.workingDirectory")}</span>
            <span className="startup-scripts-directory-field">
              <input
                value={draft.workspacePath}
                onChange={(event) => setDraft((current) => ({ ...current, workspacePath: event.target.value }))}
                placeholder={t("startupScripts.directoryPlaceholder")}
                spellCheck={false}
              />
              <button type="button" className="startup-scripts-icon-button" onClick={() => void chooseDirectory()} aria-label={t("startupScripts.chooseDirectory")} title={t("startupScripts.chooseDirectory")}>
                <FolderOpen size={16} aria-hidden />
              </button>
            </span>
          </label>
          <label>
            <span>{t("startupScripts.command")}</span>
            <textarea
              value={draft.command}
              onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
              placeholder={t("startupScripts.commandPlaceholder")}
              rows={7}
              spellCheck={false}
            />
          </label>
          <div className="startup-scripts-editor-actions">
            <button type="button" className="startup-scripts-secondary" onClick={cancelEdit} disabled={saving}>
              {t("startupScripts.cancel")}
            </button>
            <button type="submit" className="startup-scripts-primary" disabled={!formReady || saving}>
              {saving ? t("startupScripts.saving") : t("startupScripts.save")}
            </button>
          </div>
        </form>
      ) : null}

      {loading ? <p className="startup-scripts-empty">{t("startupScripts.loading")}</p> : null}
      {!loading && scripts.length === 0 && !editorOpen ? (
        <div className="startup-scripts-empty-state">
          <Terminal size={24} aria-hidden />
          <p>{t("startupScripts.empty")}</p>
          <button type="button" className="startup-scripts-secondary" onClick={beginCreate}>
            {t("startupScripts.add")}
          </button>
        </div>
      ) : null}

      <div className="startup-scripts-list" role="list">
        {scripts.map((script) => {
          const task = latestTaskByScript.get(script.id);
          const running = isRunning(task);
          const busy = saving || workingId === script.id;
          const status = task?.status ?? "idle";
          const expanded = Boolean(task && task.taskId === logTaskId);
          return (
            <article key={script.id} className="startup-scripts-card" role="listitem">
              <div className="startup-scripts-card-main">
                <div className="startup-scripts-card-title-row">
                  <h3>{script.name}</h3>
                  <span className={`startup-scripts-status startup-scripts-status--${status}`}>
                    {t(`startupScripts.status.${status}`)}
                  </span>
                  {task?.exitCode !== undefined ? <span className="startup-scripts-exit-code">{t("startupScripts.exitCode", { code: task.exitCode })}</span> : null}
                </div>
                <p className="startup-scripts-path" title={script.workspacePath}>{script.workspacePath}</p>
                <pre className="startup-scripts-command">{script.command}</pre>
              </div>
              <div className="startup-scripts-card-actions">
                {running && task ? (
                  <button type="button" className="startup-scripts-stop" onClick={() => void stop(script, task)} disabled={busy}>
                    <Square size={14} aria-hidden />
                    <span>{t("startupScripts.stop")}</span>
                  </button>
                ) : (
                  <button type="button" className="startup-scripts-run" onClick={() => void start(script)} disabled={busy}>
                    <Play size={14} aria-hidden />
                    <span>{t("startupScripts.start")}</span>
                  </button>
                )}
                <button type="button" className="startup-scripts-secondary" onClick={() => task && void showLog(task)} disabled={!task || busy}>
                  {t("startupScripts.viewLog")}
                </button>
                <button type="button" className="startup-scripts-icon-button" onClick={() => beginEdit(script)} disabled={running || busy} aria-label={t("startupScripts.editNamed", { name: script.name })} title={t("startupScripts.edit")}>
                  <Pencil size={15} aria-hidden />
                </button>
                <button type="button" className="startup-scripts-icon-button is-danger" onClick={() => void remove(script)} disabled={running || busy} aria-label={t("startupScripts.deleteNamed", { name: script.name })} title={t("startupScripts.delete")}>
                  <Trash2 size={15} aria-hidden />
                </button>
              </div>
              {expanded ? (
                <div className="startup-scripts-log">
                  <div className="startup-scripts-log-heading">
                    <strong>{t("startupScripts.log")}</strong>
                    <button type="button" className="startup-scripts-icon-button" aria-label={t("startupScripts.closeLog")} onClick={() => setLogTaskId(undefined)}>
                      <X size={15} aria-hidden />
                    </button>
                  </div>
                  {logTruncated ? <p className="startup-scripts-log-truncated">{t("startupScripts.logTruncated")}</p> : null}
                  <pre>{logText || t("startupScripts.logEmpty")}</pre>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
