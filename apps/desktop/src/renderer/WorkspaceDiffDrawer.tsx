import { Diff, X } from "lucide-react";
import { Component, lazy, type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { WorkspaceDiffResult, WorkspaceFileDiffResult } from "../shared/ipc";
import { i18n } from "./i18n";
import { clearVitePreloadRecovery } from "./vite-preload-recovery";
import { WorkspaceDiffFileTree } from "./WorkspaceDiffFileTree";
import { loadCachedWorkspaceFileDiff, readCachedWorkspaceFileDiff } from "./workspace-review-cache";

const GitDiffViewer = lazy(() =>
  import("./GitDiffViewer").then((module) => {
    clearVitePreloadRecovery();
    return { default: module.GitDiffViewer };
  }),
);

class DiffViewerErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[eco] Git diff viewer failed", error);
  }

  render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <div className="workspace-diff-viewer-error" role="alert">
        <span>{i18n.t("workspace.diff.viewerFailed")}</span>
        <button type="button" onClick={() => window.location.reload()}>
          {i18n.t("workspace.diff.reload")}
        </button>
      </div>
    );
  }
}

function DiffViewerLoading() {
  return (
    <div
      className="workspace-diff-code-loading"
      role="status"
      aria-label={i18n.t("workspace.diff.loadingViewer")}
    >
      <span />
      <span />
      <span />
    </div>
  );
}

function formatDiffStat(value: number): string {
  return value > 0 ? String(value) : "0";
}

type LoadWorkspaceFileDiff = (workspacePath: string, path: string) => Promise<WorkspaceFileDiffResult>;

interface WorkspaceDiffDrawerProps {
  open: boolean;
  loading: boolean;
  discardBusy?: boolean;
  error?: string;
  diff?: WorkspaceDiffResult;
  selectedPath?: string;
  loadFileDiff?: LoadWorkspaceFileDiff;
  revision?: number;
  onSelectPath: (path: string) => void;
  onDiscardPath?: (path: string) => void | Promise<void>;
  onDiscardAll?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  onClose: () => void;
}

export interface WorkspaceDiffPanelProps {
  loading: boolean;
  discardBusy?: boolean;
  error?: string;
  diff?: WorkspaceDiffResult;
  selectedPath?: string;
  loadFileDiff?: LoadWorkspaceFileDiff;
  showHeader?: boolean;
  /** Bump to drop the per-file diff cache (e.g. after a manual refresh). */
  revision?: number;
  onSelectPath: (path: string) => void;
  onDiscardPath?: (path: string) => void | Promise<void>;
  onDiscardAll?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  onClose?: () => void;
}

function WorkspaceDiffFilePreview({
  workspacePath,
  listRevision,
  activePath,
  activeFile,
  loadFileDiff,
}: {
  workspacePath?: string;
  listRevision: string;
  activePath: string;
  activeFile?: WorkspaceDiffResult["files"][number];
  loadFileDiff?: LoadWorkspaceFileDiff;
}) {
  const { t } = useTranslation();
  const identity = `${workspacePath ?? ""}::${activePath}`;
  const cacheKey = `${identity}::${listRevision}`;
  const [loaded, setLoaded] = useState<{ identity: string; result: WorkspaceFileDiffResult }>();
  const [failed, setFailed] = useState<{ key: string; message: string }>();
  const fileDiff =
    readCachedWorkspaceFileDiff(cacheKey) ?? (loaded?.identity === identity ? loaded.result : undefined);
  const fileError = failed?.key === cacheKey ? failed.message : undefined;

  useEffect(() => {
    if (!workspacePath || !loadFileDiff || !activePath) {
      return;
    }
    let cancelled = false;
    void loadCachedWorkspaceFileDiff(cacheKey, () => loadFileDiff(workspacePath, activePath))
      .then((result) => {
        if (cancelled) {
          return;
        }
        setLoaded({ identity, result });
        setFailed(undefined);
      })
      .catch((caught) => {
        if (cancelled) {
          return;
        }
        const message = caught instanceof Error ? caught.message : String(caught);
        setFailed({ key: cacheKey, message });
      });
    return () => {
      cancelled = true;
    };
  }, [activePath, cacheKey, identity, loadFileDiff, workspacePath]);

  if (!loadFileDiff || !workspacePath) {
    return <p className="workspace-diff-empty">{t("workspace.diff.contentUnavailable")}</p>;
  }
  if (fileError) {
    return (
      <p className="workspace-diff-empty" role="alert">
        {fileError}
      </p>
    );
  }
  if (!fileDiff) {
    return <DiffViewerLoading />;
  }
  if (fileDiff.binary) {
    const preview = fileDiff.imagePreview;
    if (preview) {
      return (
        <div className="workspace-diff-drawer-media">
          <img
            className="workspace-diff-drawer-media-img"
            src={`data:${preview.mimeType};base64,${preview.base64}`}
            alt={activePath}
          />
          {preview.source === "head" ? (
            <p className="workspace-diff-drawer-media-note" role="status">
              {t("workspace.diff.imageFromHead")}
            </p>
          ) : null}
        </div>
      );
    }
    return (
      <p className="workspace-diff-empty" role="status">
        {t("workspace.diff.binaryFile")}
      </p>
    );
  }
  if (!fileDiff.patch.trim()) {
    return <p className="workspace-diff-empty">{t("workspace.diff.noChanges")}</p>;
  }

  return (
    <>
      {fileDiff.patchTruncated ? (
        <p className="workspace-diff-drawer-truncated" role="status">
          {t("workspace.diff.truncated")}
        </p>
      ) : null}
      <DiffViewerErrorBoundary>
        <Suspense fallback={<DiffViewerLoading />}>
          <GitDiffViewer
            patch={fileDiff.patch}
            selectedPath={activePath}
            additions={activeFile?.additions ?? fileDiff.additions}
            deletions={activeFile?.deletions ?? fileDiff.deletions}
          />
        </Suspense>
      </DiffViewerErrorBoundary>
    </>
  );
}

export function WorkspaceDiffPanel({
  loading,
  discardBusy = false,
  error,
  diff,
  selectedPath,
  loadFileDiff,
  showHeader = false,
  revision = 0,
  onSelectPath,
  onDiscardPath,
  onDiscardAll,
  onRefresh,
  refreshing = false,
  onClose,
}: WorkspaceDiffPanelProps) {
  const { t } = useTranslation();
  const files = diff?.files ?? [];
  const activePath = selectedPath ?? files[0]?.path;
  const activeFile = files.find((file) => file.path === activePath);
  const listRevision = `${revision}|${files
    .map((file) => `${file.path}:${file.additions}:${file.deletions}:${file.status}`)
    .join("|")}`;

  return (
    <>
      {showHeader ? (
        <header className="workspace-diff-drawer-header">
          <div className="workspace-diff-drawer-header-main">
            <h3 className="workspace-diff-drawer-title">{t("workspace.diff.changes")}</h3>
            {diff ? (
              <span className="workspace-diff-drawer-meta" title={t("git.commit.changedLines")}>
                <span className="diff-stat-add">+{formatDiffStat(diff.totalAdditions)}</span>
                <span className="diff-stat-del">-{formatDiffStat(diff.totalDeletions)}</span>
                <span className="workspace-diff-drawer-file-count">
                  {t("workspace.diff.fileCount", { count: diff.fileCount })}
                </span>
              </span>
            ) : null}
          </div>
          <div className="workspace-diff-drawer-header-actions">
            {onDiscardAll ? (
              <button
                type="button"
                className="workspace-diff-drawer-discard-all"
                disabled={discardBusy || files.length === 0}
                onClick={() => void onDiscardAll()}
              >
                {t("workspace.diff.discardAll")}
              </button>
            ) : null}
            {onClose ? (
              <button
                type="button"
                className="workspace-diff-drawer-close"
                onClick={onClose}
                aria-label={t("common.close")}
              >
                <X size={16} aria-hidden />
              </button>
            ) : null}
          </div>
        </header>
      ) : null}

      {loading && !diff ? (
        <div className="workspace-diff-drawer-state">{t("workspace.diff.loading")}</div>
      ) : error && files.length === 0 ? (
        <div className="workspace-diff-drawer-state workspace-diff-drawer-error" role="alert">
          {error}
        </div>
      ) : (
        <>
          {error ? (
            <div className="workspace-diff-drawer-error-banner" role="alert">
              {error}
            </div>
          ) : null}
          <div className="workspace-diff-drawer-body">
            <div className="workspace-diff-drawer-files">
              <WorkspaceDiffFileTree
                files={files}
                {...(diff?.workspacePath && {
                  rootLabel: diff.workspacePath.split(/[\\/]/).filter(Boolean).slice(-2).join(" / "),
                })}
                {...(activePath && { activePath })}
                discardBusy={discardBusy}
                onSelectPath={onSelectPath}
                {...(onDiscardPath && { onDiscardPath })}
                {...(onRefresh && { onRefresh })}
                refreshing={refreshing || loading}
              />
            </div>
            <div className="workspace-diff-drawer-preview">
              {files.length === 0 ? (
                <div className="workspace-diff-empty-state" role="status">
                  <Diff
                    className="workspace-diff-empty-state__icon"
                    size={48}
                    strokeWidth={1.25}
                    aria-hidden
                  />
                  <p className="workspace-diff-empty-state__title">{t("workspace.diff.emptyTitle")}</p>
                  <p className="workspace-diff-empty-state__hint">{t("workspace.diff.emptyHint")}</p>
                </div>
              ) : activePath ? (
                <WorkspaceDiffFilePreview
                  {...(diff?.workspacePath && { workspacePath: diff.workspacePath })}
                  listRevision={
                    activeFile?.revision !== undefined ? `${revision}:${activeFile.revision}` : listRevision
                  }
                  activePath={activePath}
                  {...(activeFile && { activeFile })}
                  {...(loadFileDiff && { loadFileDiff })}
                />
              ) : (
                <p className="workspace-diff-empty">{t("workspace.diff.selectFile")}</p>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

export function WorkspaceDiffDrawer({
  open,
  loading,
  discardBusy = false,
  error,
  diff,
  selectedPath,
  loadFileDiff,
  revision = 0,
  onSelectPath,
  onDiscardPath,
  onDiscardAll,
  onRefresh,
  refreshing = false,
  onClose,
}: WorkspaceDiffDrawerProps) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <>
      <button
        type="button"
        className="workspace-diff-drawer-backdrop"
        aria-label={t("workspace.diff.closePanel")}
        onClick={onClose}
      />
      <aside className="workspace-diff-drawer" aria-label={t("workspace.diff.workspaceChanges")}>
        <WorkspaceDiffPanel
          loading={loading}
          discardBusy={discardBusy}
          {...(error && { error })}
          {...(diff && { diff })}
          {...(selectedPath && { selectedPath })}
          {...(loadFileDiff && { loadFileDiff })}
          showHeader
          revision={revision}
          onSelectPath={onSelectPath}
          {...(onDiscardPath && { onDiscardPath })}
          {...(onDiscardAll && { onDiscardAll })}
          {...(onRefresh && { onRefresh })}
          refreshing={refreshing}
          onClose={onClose}
        />
      </aside>
    </>,
    document.body,
  );
}

export function useEcoWorkspaceFileDiffLoader(): LoadWorkspaceFileDiff {
  return useCallback(async (workspacePath, path) => {
    const eco = window.eco;
    if (!eco) {
      throw new Error(i18n.t("workspace.diff.contentUnavailable"));
    }
    return eco.getWorkspaceFileDiff({ workspacePath, path });
  }, []);
}
