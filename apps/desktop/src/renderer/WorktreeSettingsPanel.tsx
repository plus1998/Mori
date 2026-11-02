import {
  ChevronDown,
  CirclePlus,
  Copy,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ManagedWorktree,
  ThreadWorkLocation,
  ThreadWorktreeRecord,
  WorktreeSettingsSnapshot,
} from "../shared/thread-worktree";
import "./worktree-settings.css";

interface Props {
  onOpenThread: (threadId: string) => void;
  onNewThread: (record: ThreadWorktreeRecord) => Promise<void>;
  onLocationChange: (threadId: string, location: ThreadWorkLocation) => void;
}

type Confirmation = { item: ManagedWorktree; action: "cleanup" | "confirm" | "forget" };

function projectPath(item: ManagedWorktree): string {
  return item.record.repositoryRoot ?? item.record.workspacePath;
}

function displayError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "");
}

export function WorktreeSettingsPanel({ onOpenThread, onNewThread, onLocationChange }: Props) {
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

  async function startChat(item: ManagedWorktree) {
    const api = window.eco;
    if (!api) throw new Error(t("worktrees.unavailable"));
    const latest = (await api.listManagedWorktrees()).find(
      (candidate) => candidate.record.id === item.record.id,
    );
    if (!latest?.exists || latest.error || latest.record.state !== "active")
      throw new Error(latest?.error || t("worktrees.unavailableWorktree"));
    await onNewThread(latest.record);
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
        : action === "forget" ? await api.forgetManagedWorktree(request)
        : await api.confirmManagedWorktreeMerged(request);
    if (result.location && item.attached) onLocationChange(item.record.threadId, result.location);
    setConfirmation(undefined);
    setNotice(t(action === "cleanup" ? "worktrees.cleanupDone" : action === "forget" ? "worktrees.forgetDone" : "worktrees.confirmDone"));
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
          <div className="worktrees-root-copy">
            <label htmlFor="worktrees-root">{t("worktrees.root")}</label>
            <p id="worktrees-root-hint" className="settings-section-subtitle">
              {t("worktrees.rootHint")}
            </p>
          </div>
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
            {!settings || rootPath !== settings.rootPath ? (
              <button
                type="button"
                className="settings-secondary-button"
                disabled={busy || (settings !== undefined && rootPath === settings.rootPath)}
                onClick={() => void run(saveSettings)}
              >
                {t("common.save")}
              </button>
            ) : null}
          </div>
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
                  <strong title={root}>{root.split(/[\\/]/).filter(Boolean).at(-1) ?? root}</strong>
                </span>
                <span className="worktrees-count">{t("worktrees.count", { count: group.length })}</span>
                <ChevronDown size={18} strokeWidth={1.7} className="worktrees-project-chevron" aria-hidden />
              </summary>
              {group.map((item) => {
                const { record } = item;
                const confirming = confirmation?.item.record.id === record.id ? confirmation : undefined;
                return (
                  <article className="worktrees-entry" key={record.id}>
                    <div className="worktrees-row-actions">
                      <button
                        type="button"
                        className="worktrees-icon-button"
                        title={t("worktrees.newChat")}
                        aria-label={t("worktrees.newChat")}
                        disabled={busy || !item.exists || Boolean(item.error)}
                        onClick={() => void run(() => startChat(item))}
                      >
                        <CirclePlus size={19} strokeWidth={1.6} aria-hidden />
                      </button>
                      <span title={item.busy ? t("worktrees.busy") : item.blockingReasons?.join("\n")}>
                        <button
                          type="button"
                          className="worktrees-icon-button worktrees-cleanup"
                          aria-label={t(item.canForget ? "worktrees.forget" : "worktrees.cleanup")}
                          title={t(item.canForget ? "worktrees.forget" : "worktrees.cleanup")}
                          disabled={busy || item.busy || (!item.canClean && !item.canForget)}
                          onClick={() => setConfirmation({ item, action: item.canForget ? "forget" : "cleanup" })}
                        >
                          <Trash2 size={19} strokeWidth={1.6} aria-hidden />
                        </button>
                      </span>
                    </div>
                    <details className="worktrees-entry-details">
                      <summary title={t("worktrees.details")} aria-label={t("worktrees.details")}>
                        <span className="worktrees-entry-copy">
                          <strong>{item.threadTitle}</strong>
                          <code className="worktrees-path" title={record.worktreePath}>
                            {record.worktreePath}
                          </code>
                        </span>
                      </summary>
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
                      <dl>
                        <dt>{t("worktrees.branch")}</dt>
                        <dd>
                          <code>{record.checkoutBranch === "" ? "detached HEAD" : record.checkoutBranch ?? record.branchName}</code>
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
                        {item.threadExists ? (
                          <button
                            type="button"
                            className="settings-secondary-button"
                            onClick={() => onOpenThread(record.threadId)}
                          >
                            {t("worktrees.openChat")}
                          </button>
                        ) : null}

                        <button
                          type="button"
                          className="settings-secondary-button"
                          disabled={busy || !item.exists}
                          onClick={() =>
                            void run(async () => {
                              if (!window.eco) throw new Error(t("worktrees.unavailable"));
                              await window.eco.openWorkspaceInFileManager(record.worktreePath);
                            })
                          }
                        >
                          <FolderOpen size={15} />
                          {t("worktrees.openFolder")}
                        </button>
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
                          className="settings-secondary-button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await navigator.clipboard.writeText(record.worktreePath);
                              setNotice(t("worktrees.copied"));
                            })
                          }
                        >
                          <Copy size={14} />
                          {t("worktrees.copyPath")}
                        </button>
                      </div>
                    </details>
                    {item.error ? <p className="worktrees-error">{item.error}</p> : null}
                    {confirming ? (
                      <fieldset
                        className="worktrees-confirmation"
                        aria-label={t(
                          confirming.action === "cleanup" ? "worktrees.cleanup" : confirming.action === "forget" ? "worktrees.forget" : "worktrees.confirmMerged",
                        )}
                      >
                        <p>
                          {t(
                            confirming.action === "cleanup"
                              ? "worktrees.cleanupHint"
                              : confirming.action === "forget" ? "worktrees.forgetHint" : "worktrees.confirmHint",
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
                                : confirming.action === "forget" ? "worktrees.forget" : "worktrees.confirmAction",
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
        {items.length ? (
          <p className="settings-section-subtitle worktrees-policy">{t("worktrees.cleanupPolicy")}</p>
        ) : null}
      </section>
    </div>
  );
}
