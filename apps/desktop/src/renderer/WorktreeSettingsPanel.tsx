import { Copy, FolderOpen, GitBranch, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ManagedWorktree,
  ThreadWorkLocation,
  WorktreeSettingsSnapshot,
} from "../shared/thread-worktree";
import "./worktree-settings.css";

interface Props {
  onOpenThread: (threadId: string) => void;
  onLocationChange: (threadId: string, location: ThreadWorkLocation) => void;
}

type Confirmation = { item: ManagedWorktree; action: "cleanup" | "confirm" };

function projectPath(item: ManagedWorktree): string {
  return item.record.repositoryRoot ?? item.record.workspacePath;
}

function displayError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "");
}

export function WorktreeSettingsPanel({ onOpenThread, onLocationChange }: Props) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<WorktreeSettingsSnapshot>();
  const [rootPath, setRootPath] = useState("");
  const [items, setItems] = useState<ManagedWorktree[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();

  useEffect(() => {
    let active = true;
    const api = window.eco;
    if (!api?.getWorktreeSettings || !api.listManagedWorktrees) {
      setError(t("worktrees.unavailable"));
      setBusy(false);
      return;
    }
    void Promise.allSettled([
      api.getWorktreeSettings().then((nextSettings) => {
        if (!active) return;
        setSettings(nextSettings);
        setRootPath(nextSettings.rootPath);
      }),
      api.listManagedWorktrees().then((nextItems) => {
        if (active) setItems(nextItems);
      }),
    ]).then((results) => {
      if (!active) return;
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) setError(failures.map((result) => displayError(result.reason)).join("\n"));
      setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [t]);

  async function run(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await operation();
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    const api = window.eco;
    if (!api?.listManagedWorktrees) throw new Error(t("worktrees.unavailable"));
    setItems(await api.listManagedWorktrees());
    setConfirmation(undefined);
  }

  async function saveSettings() {
    const api = window.eco;
    if (!api?.saveWorktreeSettings) throw new Error(t("worktrees.unavailable"));
    const next = await api.saveWorktreeSettings({ rootPath });
    setSettings(next);
    setRootPath(next.rootPath);
    setNotice(t("worktrees.rootSaved"));
  }

  async function executeConfirmation() {
    if (!confirmation) return;
    const api = window.eco;
    if (!api) throw new Error(t("worktrees.unavailable"));
    const { item, action } = confirmation;
    const request = {
      threadId: item.record.threadId,
      worktreeId: item.record.id,
      ...(item.branchCommit ? { expectedBranchCommit: item.branchCommit } : {}),
      ...(item.targetCommit ? { expectedTargetCommit: item.targetCommit } : {}),
    };
    const result =
      action === "cleanup"
        ? await api.cleanupManagedWorktree(request)
        : await api.confirmManagedWorktreeMerged(request);
    if (result.location && item.attached) onLocationChange(item.record.threadId, result.location);
    setConfirmation(undefined);
    setNotice(t(action === "cleanup" ? "worktrees.cleanupDone" : "worktrees.confirmDone"));
    await refresh();
  }

  const groups = new Map<string, [ManagedWorktree, ...ManagedWorktree[]]>();
  for (const item of items) {
    const key = item.record.repositoryPath || projectPath(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  return (
    <div className="worktrees-settings-panel">
      <header className="settings-page-header">
        <h1>{t("worktrees.title")}</h1>
        <p className="settings-page-desc">{t("worktrees.subtitle")}</p>
      </header>
      {notice ? (
        <p className="worktrees-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="worktrees-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="settings-section">
        <div className="settings-section-head">
          <h2 className="settings-section-label">{t("worktrees.creation")}</h2>
        </div>
        <div className="worktrees-root-card">
          <label htmlFor="worktrees-root">{t("worktrees.root")}</label>
          <div className="worktrees-root-input">
            <input
              id="worktrees-root"
              type="text"
              spellCheck={false}
              value={rootPath}
              placeholder={settings?.defaultRootPath}
              disabled={busy}
              aria-describedby="worktrees-root-hint"
              onChange={(event) => setRootPath(event.target.value)}
            />
            <button
              type="button"
              className="settings-secondary-button"
              disabled={busy || (settings !== undefined && rootPath === settings.rootPath)}
              onClick={() => void run(saveSettings)}
            >
              {t("common.save")}
            </button>
          </div>
          <p id="worktrees-root-hint" className="settings-section-subtitle">
            {t("worktrees.rootHint")}
          </p>
        </div>
      </section>

      <section className="settings-section" aria-busy={busy}>
        <div className="settings-section-head">
          <h2 className="settings-section-label">{t("worktrees.managed")}</h2>
          <button
            type="button"
            className="worktrees-icon-button"
            disabled={busy}
            aria-label={t("worktrees.refresh")}
            title={t("worktrees.refresh")}
            onClick={() => void run(refresh)}
          >
            {busy ? <LoaderCircle size={16} className="thread-worktree-spinner" /> : <RefreshCw size={16} />}
          </button>
        </div>
        <p className="settings-section-subtitle worktrees-policy">{t("worktrees.cleanupPolicy")}</p>
        {busy && !settings ? <p role="status">{t("worktrees.loading")}</p> : null}
        {!busy && !error && items.length === 0 ? (
          <div className="worktrees-empty">
            <GitBranch size={26} aria-hidden />
            <strong>{t("worktrees.empty")}</strong>
            <p>{t("worktrees.emptyHint")}</p>
          </div>
        ) : null}
        {[...groups].map(([key, group]) => {
          const root = projectPath(group[0]);
          return (
            <details className="worktrees-project" key={key} open>
              <summary>
                <span className="worktrees-project-copy">
                  <strong>{root.split(/[\\/]/).filter(Boolean).at(-1) ?? root}</strong>
                  <small title={root}>{root}</small>
                </span>
                <span className="worktrees-count">{t("worktrees.count", { count: group.length })}</span>
              </summary>
              {group.map((item) => {
                const { record } = item;
                const confirming = confirmation?.item.record.id === record.id ? confirmation : undefined;
                return (
                  <article className="worktrees-entry" key={record.id}>
                    <div className="worktrees-entry-head">
                      <div className="worktrees-entry-copy">
                        {item.threadExists ? (
                          <button
                            type="button"
                            className="worktrees-chat-link"
                            onClick={() => onOpenThread(record.threadId)}
                          >
                            {item.threadTitle}
                          </button>
                        ) : (
                          <strong>{item.threadTitle}</strong>
                        )}
                        <div className="worktrees-badges">
                          <span className={item.error || record.state === "missing" ? "needs-attention" : ""}>
                            {t(item.error ? "worktrees.state.error" : `worktrees.state.${record.state}`)}
                          </span>
                          {!item.threadExists ? (
                            <span>{t("worktrees.deletedChat")}</span>
                          ) : !item.attached ? (
                            <span>{t("worktrees.detached")}</span>
                          ) : null}
                          {item.busy ? <span>{t("worktrees.busy")}</span> : null}
                          {item.merged ? (
                            <span>
                              {t(
                                item.merged === "git"
                                  ? "worktrees.merged"
                                  : item.merged === "confirmed"
                                    ? "worktrees.confirmed"
                                    : "worktrees.unmerged",
                              )}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="worktrees-icon-button"
                        title={t("worktrees.copyPath")}
                        aria-label={t("worktrees.copyPath")}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await navigator.clipboard.writeText(record.worktreePath);
                            setNotice(t("worktrees.copied"));
                          })
                        }
                      >
                        <Copy size={15} />
                      </button>
                      <button
                        type="button"
                        className="worktrees-icon-button"
                        title={t("worktrees.openFolder")}
                        aria-label={t("worktrees.openFolder")}
                        disabled={busy || !item.exists}
                        onClick={() =>
                          void run(async () => {
                            if (!window.eco) throw new Error(t("worktrees.unavailable"));
                            await window.eco.openWorkspaceInFileManager(record.worktreePath);
                          })
                        }
                      >
                        <FolderOpen size={16} />
                      </button>
                    </div>
                    <code className="worktrees-path">{record.worktreePath}</code>
                    <details className="worktrees-entry-details">
                      <summary>{t("worktrees.details")}</summary>
                      <dl>
                        <dt>{t("worktrees.branch")}</dt>
                        <dd>
                          <code>{record.branchName}</code>
                        </dd>
                        <dt>{t("worktrees.target")}</dt>
                        <dd>
                          <code>{record.targetBranch}</code>
                        </dd>
                      </dl>
                      {item.blockingReasons?.length ? (
                        <ul className="worktrees-blocking-reasons">
                          {item.blockingReasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : null}
                      <div className="worktrees-entry-actions">
                        {item.merged === "unmerged" && item.branchCommit && item.targetCommit ? (
                          <button
                            type="button"
                            className="settings-secondary-button"
                            disabled={busy || item.busy || Boolean(item.error)}
                            onClick={() => setConfirmation({ item, action: "confirm" })}
                          >
                            {t("worktrees.confirmMerged")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="settings-secondary-button worktrees-cleanup"
                          disabled={busy || item.busy || !item.canClean}
                          onClick={() => setConfirmation({ item, action: "cleanup" })}
                        >
                          <Trash2 size={14} />
                          {t("worktrees.cleanup")}
                        </button>
                      </div>
                    </details>
                    {item.error ? <p className="worktrees-error">{item.error}</p> : null}
                    {confirming ? (
                      <fieldset
                        className="worktrees-confirmation"
                        aria-label={t(
                          confirming.action === "cleanup" ? "worktrees.cleanup" : "worktrees.confirmMerged",
                        )}
                      >
                        <p>
                          {t(
                            confirming.action === "cleanup"
                              ? "worktrees.cleanupHint"
                              : "worktrees.confirmHint",
                            {
                              commit: confirming.item.branchCommit?.slice(0, 12),
                              branch: record.targetBranch,
                            },
                          )}
                        </p>
                        <div className="worktrees-entry-actions">
                          <button
                            type="button"
                            className="settings-secondary-button"
                            disabled={busy}
                            onClick={() => void run(executeConfirmation)}
                          >
                            {t(
                              confirming.action === "cleanup"
                                ? "worktrees.cleanupAction"
                                : "worktrees.confirmAction",
                            )}
                          </button>
                          <button
                            type="button"
                            className="settings-secondary-button"
                            disabled={busy}
                            onClick={() => setConfirmation(undefined)}
                          >
                            {t("common.cancel")}
                          </button>
                        </div>
                      </fieldset>
                    ) : null}
                  </article>
                );
              })}
            </details>
          );
        })}
      </section>
    </div>
  );
}
