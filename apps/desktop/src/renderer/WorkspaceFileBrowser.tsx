import {
  ChevronRight,
  PanelLeft,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MaterialFileIcon } from "./MaterialFileIcon";
import { WorkspaceExplorerTree } from "./WorkspaceExplorerTree";
import { type WorkspaceFile, WorkspaceFilePreview } from "./WorkspaceFilePreview";
import { WorkspaceFileOpenActions } from "./WorkspaceFileOpenActions";
import {
  ancestorDirectories,
  basename,
  buildWorkspaceRoot,
  collectRefreshDirectories,
  mergeWorkspaceEntries,
  type WorkspaceEntry,
  type WorkspacePathSegment,
  type WorkspaceTreeItem,
  workspacePathSegments,
} from "./workspace-file-browser-logic";
import "./workspace-file-browser.css";

interface WorkspaceApi {
  listWorkspaceEntries(input: { workspacePath: string; directoryPath: string }): Promise<WorkspaceEntry[]>;
  readWorkspaceFile(input: { workspacePath: string; filePath: string }): Promise<WorkspaceFile>;
  writeWorkspaceFile(input: {
    workspacePath: string;
    filePath: string;
    content: string;
  }): Promise<{ path: string; name: string; size: number }>;
}

export interface WorkspaceFileBrowserProps {
  workspacePath: string;
  threadId?: string;
  target?: { path: string; line?: number; column?: number; requestId: number; restricted?: boolean };
}

function filterWorkspaceItems(
  items: Record<string, WorkspaceTreeItem>,
  rootItem: string,
  query: string,
): Record<string, WorkspaceTreeItem> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;

  const result: Record<string, WorkspaceTreeItem> = {};
  const keep = (index: string): boolean => {
    const item = items[index];
    if (!item) return false;
    const matches = item.data.toLowerCase().includes(normalizedQuery);
    if (!item.isFolder) {
      if (matches) result[index] = item;
      return matches;
    }
    const children = (item.children ?? []).filter(keep);
    if (matches || children.length > 0) {
      result[index] = {
        ...item,
        children: matches ? (item.children ?? []) : children,
      };
      return true;
    }
    return false;
  };
  keep(rootItem);
  return result;
}

export function WorkspaceFileBrowser({ workspacePath, threadId, target }: WorkspaceFileBrowserProps) {
  const { t } = useTranslation();
  const api = window.eco as unknown as WorkspaceApi | undefined;
  const [items, setItems] = useState<Record<string, WorkspaceTreeItem>>(() =>
    buildWorkspaceRoot(workspacePath),
  );
  const [expandedItems, setExpandedItems] = useState<string[]>([]);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [focusedItem, setFocusedItem] = useState<string>(workspacePath);
  const [activeTarget, setActiveTarget] = useState<WorkspaceFileBrowserProps["target"]>();
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeQuery, setTreeQuery] = useState("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const requestRef = useRef(0);
  const appliedTargetRequestRef = useRef<number | undefined>(undefined);
  const [treeVisible, setTreeVisible] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const confirmDiscardIfDirty = useCallback(() => {
    if (!dirtyRef.current) return true;
    return window.confirm(t("fileBrowser.unsavedConfirm"));
  }, [t]);

  const loadDirectory = useCallback(
    async (directoryPath: string) => {
      if (!api) {
        setTreeError(t("fileBrowser.apiUnavailable"));
        return false;
      }
      try {
        const entries = await api.listWorkspaceEntries({ workspacePath, directoryPath });
        setItems((current) => mergeWorkspaceEntries(current, directoryPath, entries));
        setTreeError(null);
        return true;
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : t("fileBrowser.directoryLoadFailed"));
        return false;
      }
    },
    [api, t, workspacePath],
  );

  useEffect(() => {
    setItems(buildWorkspaceRoot(workspacePath));
    setExpandedItems([workspacePath]);
    setSelectedItems([]);
    setFocusedItem(workspacePath);
    setFile(null);
    setActiveTarget(undefined);
    setStatus("idle");
    setErrorMessage(null);
    setTreeQuery("");
    setDirty(false);
    void loadDirectory(workspacePath);
  }, [loadDirectory, workspacePath]);

  const readFile = useCallback(
    async (filePath: string, requestId: number) => {
      if (!api) {
        setErrorMessage(t("fileBrowser.apiUnavailable"));
        setStatus("error");
        return;
      }
      setStatus("loading");
      setErrorMessage(null);
      try {
        const result = await api.readWorkspaceFile({ workspacePath, filePath });
        if (requestId !== requestRef.current) return;
        setFile(result);
        setDirty(false);
        setStatus("idle");
      } catch (error) {
        if (requestId === requestRef.current) {
          setErrorMessage(error instanceof Error ? error.message : t("fileBrowser.readFailed"));
          setStatus("error");
        }
      }
    },
    [api, t, workspacePath],
  );

  const selectFile = useCallback(
    (filePath: string) => {
      if (filePath === activeTarget?.path) return;
      if (!confirmDiscardIfDirty()) return;
      const requestId = ++requestRef.current;
      setSelectedItems([filePath]);
      setFocusedItem(filePath);
      setActiveTarget({ path: filePath, requestId });
      setFile(null);
      setDirty(false);
      void readFile(filePath, requestId);
    },
    [activeTarget?.path, confirmDiscardIfDirty, readFile],
  );

  useEffect(() => {
    if (!target || target.path === workspacePath) return;
    if (appliedTargetRequestRef.current === target.requestId) return;
    if (!confirmDiscardIfDirty()) {
      appliedTargetRequestRef.current = target.requestId;
      return;
    }
    appliedTargetRequestRef.current = target.requestId;
    const requestId = ++requestRef.current;
    setSelectedItems([target.path]);
    setFocusedItem(target.path);
    setActiveTarget({ ...target, requestId });
    setDirty(false);
    if (target.restricted) {
      setFile(null);
      setStatus("idle");
      setErrorMessage(null);
    } else {
      setFile(null);
      void readFile(target.path, requestId);
    }
    void (async () => {
      if (!api) return;
      const directories = ancestorDirectories(workspacePath, target.path);
      let parent = workspacePath;
      try {
        for (const directory of directories) {
          if (!(await loadDirectory(parent))) return;
          parent = directory;
        }
        if (!(await loadDirectory(parent))) return;
        if (requestId === requestRef.current) {
          setExpandedItems((current) => [...new Set([...current, ...directories, workspacePath])]);
        }
      } catch {
        // loadDirectory catches expected IPC failures; this keeps an unexpected failure local.
      }
    })();
  }, [api, confirmDiscardIfDirty, loadDirectory, readFile, target, workspacePath]);

  const retryActiveFile = () => {
    if (!activeTarget || activeTarget.restricted) return;
    if (!confirmDiscardIfDirty()) return;
    const requestId = ++requestRef.current;
    setActiveTarget({ ...activeTarget, requestId });
    setDirty(false);
    void readFile(activeTarget.path, requestId);
  };

  /** Reload expanded directories (keeping expansion) and re-read the open file. */
  const refreshBrowser = useCallback(async () => {
    if (!api) {
      setTreeError(t("fileBrowser.apiUnavailable"));
      return;
    }
    if (!confirmDiscardIfDirty()) return;
    setRefreshing(true);
    try {
      // Every directory is independent (mergeWorkspaceEntries writes one directory
      // per call), so reload them in parallel and keep going when one fails:
      // loadDirectory already surfaces the first failure through treeError.
      await Promise.all(collectRefreshDirectories(workspacePath, expandedItems).map(loadDirectory));
      if (activeTarget && !activeTarget.restricted) {
        const requestId = ++requestRef.current;
        setActiveTarget({ ...activeTarget, requestId });
        setDirty(false);
        // Awaited so the refresh icon keeps spinning until the open file is back on screen.
        await readFile(activeTarget.path, requestId);
      }
    } catch {
      // loadDirectory catches expected IPC failures; this keeps an unexpected failure local.
      setTreeError(t("fileBrowser.directoryLoadFailed"));
    } finally {
      setRefreshing(false);
    }
  }, [
    activeTarget,
    api,
    confirmDiscardIfDirty,
    expandedItems,
    loadDirectory,
    readFile,
    t,
    workspacePath,
  ]);

  const visibleItems = useMemo(
    () => filterWorkspaceItems(items, workspacePath, treeQuery),
    [items, treeQuery, workspacePath],
  );
  const visibleExpandedItems = useMemo(() => {
    if (!treeQuery.trim()) return expandedItems;
    return Object.values(visibleItems)
      .filter((item) => item.isFolder)
      .map((item) => item.index);
  }, [expandedItems, treeQuery, visibleItems]);
  const visibleSelectedItems = selectedItems.filter((index) => visibleItems[index]);
  const visibleFocusedItem = visibleItems[focusedItem] ? focusedItem : workspacePath;

  const breadcrumbs = useMemo(
    () =>
      activeTarget && !activeTarget.restricted
        ? workspacePathSegments(workspacePath, activeTarget.path)
        : [],
    [activeTarget, workspacePath],
  );

  return (
    <div className={treeVisible ? "workspace-file-browser" : "workspace-file-browser is-tree-hidden"}>
      {treeVisible ? (
      <div className="workspace-file-browser__tree">
        <div className="workspace-file-browser__toolbar" aria-busy={refreshing}>
          <label className="workspace-file-browser__search">
            <Search size={15} aria-hidden />
            <input
              type="search"
              value={treeQuery}
              placeholder={t("fileBrowser.filterFiles")}
              aria-label={t("fileBrowser.filterFiles")}
              onChange={(event) => setTreeQuery(event.target.value)}
            />
            {treeQuery ? (
              <button
                type="button"
                className="workspace-file-browser__search-clear"
                aria-label={t("common.clear")}
                title={t("common.clear")}
                onClick={() => setTreeQuery("")}
              >
                ×
              </button>
            ) : null}
          </label>
          <button
            type="button"
            className="workspace-file-browser__refresh"
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            disabled={refreshing}
            onClick={() => void refreshBrowser()}
          >
            <RefreshCw size={15} className={refreshing ? "spinning" : undefined} aria-hidden />
          </button>
        </div>
        {treeError ? (
          <div className="workspace-file-browser__tree-error" role="status">
            <span>
              {t("fileBrowser.directoryLoadFailed")}: {treeError}
            </span>
            <button type="button" onClick={() => void loadDirectory(workspacePath)}>
              <RotateCcw size={13} aria-hidden="true" />
              {t("fileBrowser.retry")}
            </button>
          </div>
        ) : null}
        <WorkspaceExplorerTree
          items={visibleItems}
          rootItem={workspacePath}
          expandedItems={visibleExpandedItems}
          selectedItems={visibleSelectedItems}
          focusedItem={visibleFocusedItem}
          treeLabel={t("fileBrowser.treeLabel", { workspace: basename(workspacePath) })}
          hideRoot
          className="workspace-file-browser__explorer"
          renderLeading={(item) =>
            item.isFolder ? null : (
              <MaterialFileIcon path={item.index} size={16} className="workspace-file-browser__file-icon" />
            )
          }
          onExpandItem={(index) => {
            setExpandedItems((current) => [...new Set([...current, index])]);
            if (items[index]?.isFolder && items[index]?.children?.length === 0) {
              void loadDirectory(index);
            }
          }}
          onCollapseItem={(index) => {
            setExpandedItems((current) => current.filter((value) => value !== index));
          }}
          onSelectItem={(index) => {
            setSelectedItems([index]);
            const selectedItem = items[index];
            if (selectedItem && !selectedItem.isFolder) selectFile(index);
          }}
          onFocusItem={setFocusedItem}
        />
      </div>
      ) : null}
      <div className="workspace-file-browser__preview">
        {breadcrumbs.length > 0 ? (
          <div className="workspace-file-browser__header">
            <nav className="workspace-file-browser__header-breadcrumbs" aria-label={t("fileViewer.pathLabel")}>
              {breadcrumbs.map((segment, index) => (
                <span className="workspace-file-header__breadcrumb-part" key={segment.path}>
                  {index > 0 ? (
                    <ChevronRight className="workspace-file-header__breadcrumb-separator" aria-hidden="true" />
                  ) : null}
                  <span
                    className={segment.kind === "file" ? "is-file" : ""}
                  >
                    {segment.name}
                  </span>
                </span>
              ))}
            </nav>
            <div className="workspace-file-browser__header-actions">
              <button
                type="button"
                className="workspace-file-header__action-btn workspace-file-header__action-btn--icon"
                title={t("fileViewer.toggleTree")}
                aria-pressed={treeVisible}
                onClick={() => setTreeVisible((prev) => !prev)}
              >
                <PanelLeft size={15} aria-hidden="true" />
              </button>
              {activeTarget ? (
                <WorkspaceFileOpenActions key={activeTarget.path} filePath={activeTarget.path} requestId={activeTarget.requestId}
                  workspacePath={workspacePath} {...(threadId ? { threadId } : {})} />
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="workspace-file-browser__preview-content">
        {activeTarget?.restricted ? (
          <div className="workspace-file-browser__message">{t("fileBrowser.restricted")}</div>
        ) : status === "loading" ? (
          <div className="workspace-file-browser__message">
            {t("fileBrowser.loadingFile", { name: basename(activeTarget?.path || "") })}
          </div>
        ) : status === "error" ? (
          <div className="workspace-file-browser__error">
            <p>
              {t("fileBrowser.readFailed")}: {errorMessage || t("fileBrowser.unknownError")}
            </p>
            <button type="button" onClick={retryActiveFile} disabled={!activeTarget}>
              <RotateCcw size={13} aria-hidden="true" />
              {t("fileBrowser.retry")}
            </button>
          </div>
        ) : file ? (
          <WorkspaceFilePreview
            file={file}
            workspacePath={workspacePath}
            onDirtyChange={setDirty}
            {...(activeTarget && { target: activeTarget })}
          />
        ) : (
          <div className="workspace-file-browser__message">{t("fileBrowser.selectFile")}</div>
        )}
        </div>
      </div>
    </div>
  );
}
