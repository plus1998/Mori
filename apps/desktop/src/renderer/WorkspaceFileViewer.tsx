import { ChevronDown, ChevronRight, FolderOpen, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MaterialFileIcon } from "./MaterialFileIcon";
import { WorkspaceFileOpenActions } from "./WorkspaceFileOpenActions";
import {
  type WorkspaceFile,
  WorkspaceFilePreview,
  type WorkspaceFilePreviewTarget,
} from "./WorkspaceFilePreview";
import {
  ancestorDirectories,
  basename,
  parentDirectory,
  type WorkspaceEntry,
  type WorkspacePathSegment,
  workspacePathSegments,
} from "./workspace-file-browser-logic";
import type { WorkspaceFileReference } from "./workspace-file-reference";
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

type FileViewerTarget = WorkspaceFileReference & {
  requestId: number;
  restricted?: boolean;
};

export interface WorkspaceFileViewerProps {
  workspacePath: string;
  threadId?: string;
  target?: FileViewerTarget;
  onViewedFileChange?: (target: FileViewerTarget) => void;
}

interface FileNavigatorBranchProps {
  directoryPath: string;
  depth: number;
  currentFilePath?: string;
  entriesByDirectory: Readonly<Record<string, WorkspaceEntry[]>>;
  expandedDirectories: ReadonlySet<string>;
  loadingDirectories: ReadonlySet<string>;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
}

function FileNavigatorBranch({
  directoryPath,
  depth,
  currentFilePath,
  entriesByDirectory,
  expandedDirectories,
  loadingDirectories,
  onSelectFile,
  onToggleDirectory,
}: FileNavigatorBranchProps) {
  const entries = entriesByDirectory[directoryPath] ?? [];
  return (
    <div role={depth === 0 ? "tree" : "group"} className="workspace-file-viewer__tree-group">
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isExpanded = isDirectory && expandedDirectories.has(entry.path);
        const isLoading = isDirectory && loadingDirectories.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              type="button"
              role="treeitem"
              aria-expanded={isDirectory ? isExpanded : undefined}
              aria-selected={!isDirectory && entry.path === currentFilePath}
              className={[
                "workspace-file-viewer__tree-item",
                isDirectory ? "is-directory" : "is-file",
                entry.path === currentFilePath ? "is-current" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ paddingLeft: 10 + depth * 22 }}
              onClick={() => (isDirectory ? onToggleDirectory(entry.path) : onSelectFile(entry.path))}
            >
              <span className="workspace-file-viewer__tree-chevron">
                {isDirectory ? isExpanded ? <ChevronDown /> : <ChevronRight /> : null}
              </span>
              {isDirectory ? null : (
                <span className="workspace-file-viewer__tree-icon">
                  <MaterialFileIcon path={entry.path} size={16} />
                </span>
              )}
              <span className="workspace-file-viewer__tree-name">{entry.name}</span>
              {isLoading ? <span className="workspace-file-viewer__tree-loading" aria-hidden="true" /> : null}
            </button>
            {isExpanded ? (
              <FileNavigatorBranch
                directoryPath={entry.path}
                depth={depth + 1}
                {...(currentFilePath ? { currentFilePath } : {})}
                entriesByDirectory={entriesByDirectory}
                expandedDirectories={expandedDirectories}
                loadingDirectories={loadingDirectories}
                onSelectFile={onSelectFile}
                onToggleDirectory={onToggleDirectory}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function WorkspaceFileViewer({ workspacePath, threadId, target, onViewedFileChange }: WorkspaceFileViewerProps) {
  const { t } = useTranslation();
  const api = window.eco as unknown as WorkspaceApi | undefined;
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTarget, setActiveTarget] = useState<FileViewerTarget | undefined>(target);
  const [navigatorRoot, setNavigatorRoot] = useState<WorkspacePathSegment | null>(null);
  const [entriesByDirectory, setEntriesByDirectory] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(() => new Set());
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const requestRef = useRef(0);
  const navigatorRequestRef = useRef(0);
  const activePathRef = useRef(target?.path);
  const activeTargetRef = useRef(activeTarget);
  activeTargetRef.current = activeTarget;
  // Must NOT seed with target.requestId: mount + open uses the same id, and the
  // early-return would skip the first read (path shown, "no file to display").
  const appliedTargetRequestRef = useRef<number | undefined>(undefined);
  const navigatorRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbRef = useRef<HTMLElement | null>(null);

  const confirmDiscardIfDirty = useCallback(() => {
    if (!dirtyRef.current) return true;
    return window.confirm(t("fileBrowser.unsavedConfirm"));
  }, [t]);

  const breadcrumbs = useMemo(
    () =>
      activeTarget && !activeTarget.restricted ? workspacePathSegments(workspacePath, activeTarget.path) : [],
    [activeTarget, workspacePath],
  );

  const readFile = useCallback(
    async (fileTarget: FileViewerTarget, requestId: number) => {
      if (!api) {
        setErrorMessage(t("fileBrowser.apiUnavailable"));
        setStatus("error");
        return;
      }
      setStatus("loading");
      setErrorMessage(null);
      try {
        const result = await api.readWorkspaceFile({
          workspacePath,
          filePath: fileTarget.path,
        });
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

  const loadDirectory = useCallback(
    async (directoryPath: string, navigatorRequestId: number) => {
      if (!api) {
        setDirectoryError(t("fileBrowser.apiUnavailable"));
        return false;
      }
      setLoadingDirectories((current) => new Set(current).add(directoryPath));
      try {
        const entries = await api.listWorkspaceEntries({ workspacePath, directoryPath });
        if (navigatorRequestId !== navigatorRequestRef.current) return false;
        setEntriesByDirectory((current) => ({ ...current, [directoryPath]: entries }));
        setDirectoryError(null);
        return true;
      } catch (error) {
        if (navigatorRequestId === navigatorRequestRef.current) {
          setDirectoryError(error instanceof Error ? error.message : t("fileBrowser.directoryLoadFailed"));
        }
        return false;
      } finally {
        if (navigatorRequestId === navigatorRequestRef.current) {
          setLoadingDirectories((current) => {
            const next = new Set(current);
            next.delete(directoryPath);
            return next;
          });
        }
      }
    },
    [t, workspacePath],
  );

  useEffect(() => {
    if (target && appliedTargetRequestRef.current === target.requestId) return;
    if (target && !confirmDiscardIfDirty()) {
      appliedTargetRequestRef.current = target.requestId;
      const current = activeTargetRef.current;
      if (current) {
        onViewedFileChange?.({ ...current, requestId: target.requestId });
      }
      return;
    }
    const requestId = target?.requestId ?? ++requestRef.current;
    requestRef.current = Math.max(requestRef.current, requestId);
    appliedTargetRequestRef.current = target?.requestId;
    activePathRef.current = target?.path;
    setActiveTarget(target);
    setFile(null);
    setDirty(false);
    setErrorMessage(null);
    if (!target || target.restricted) {
      setStatus("idle");
      return;
    }
    void readFile(target, requestId);
  }, [confirmDiscardIfDirty, onViewedFileChange, readFile, target]);

  useEffect(() => {
    if (!navigatorRoot) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!navigatorRef.current?.contains(node) && !breadcrumbRef.current?.contains(node)) {
        setNavigatorRoot(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavigatorRoot(null);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [navigatorRoot]);

  const openNavigator = useCallback(
    (segment: WorkspacePathSegment) => {
      if (!activeTarget) return;
      const rootPath = segment.kind === "file" ? parentDirectory(segment.path) : segment.path;
      const requestId = ++navigatorRequestRef.current;
      const branch = [rootPath, ...ancestorDirectories(rootPath, activeTarget.path)];
      setNavigatorRoot(segment);
      setDirectoryError(null);
      setExpandedDirectories(new Set(branch));
      void (async () => {
        for (const directoryPath of branch) {
          if (!(await loadDirectory(directoryPath, requestId))) return;
        }
      })();
    },
    [activeTarget, loadDirectory],
  );

  const toggleDirectory = useCallback(
    (directoryPath: string) => {
      if (expandedDirectories.has(directoryPath)) {
        setExpandedDirectories((current) => {
          const next = new Set(current);
          next.delete(directoryPath);
          return next;
        });
        return;
      }
      setExpandedDirectories((current) => new Set(current).add(directoryPath));
      if (!entriesByDirectory[directoryPath]) {
        void loadDirectory(directoryPath, navigatorRequestRef.current);
      }
    },
    [entriesByDirectory, expandedDirectories, loadDirectory],
  );

  const selectFile = useCallback(
    (filePath: string) => {
      if (filePath === activePathRef.current) return;
      if (!confirmDiscardIfDirty()) return;
      const requestId = ++requestRef.current;
      const nextTarget: FileViewerTarget = { path: filePath, requestId };
      appliedTargetRequestRef.current = requestId;
      activePathRef.current = filePath;
      setActiveTarget(nextTarget);
      setNavigatorRoot(null);
      setFile(null);
      setDirty(false);
      setErrorMessage(null);
      onViewedFileChange?.(nextTarget);
      void readFile(nextTarget, requestId);
    },
    [confirmDiscardIfDirty, onViewedFileChange, readFile],
  );

  const retry = () => {
    if (!activeTarget || activeTarget.restricted) return;
    if (!confirmDiscardIfDirty()) return;
    const requestId = ++requestRef.current;
    const nextTarget = { ...activeTarget, requestId };
    appliedTargetRequestRef.current = requestId;
    setActiveTarget(nextTarget);
    setDirty(false);
    onViewedFileChange?.(nextTarget);
    void readFile(nextTarget, requestId);
  };

  const previewTarget: WorkspaceFilePreviewTarget | undefined = activeTarget
    ? {
        requestId: activeTarget.requestId,
        ...(activeTarget.line === undefined ? {} : { line: activeTarget.line }),
        ...(activeTarget.column === undefined ? {} : { column: activeTarget.column }),
      }
    : undefined;

  const navigatorRootPath = navigatorRoot
    ? navigatorRoot.kind === "file"
      ? parentDirectory(navigatorRoot.path)
      : navigatorRoot.path
    : undefined;

  return (
    <div className="workspace-file-viewer">
      {breadcrumbs.length > 0 ? (
        <div className="workspace-file-viewer__header">
          <nav
            ref={breadcrumbRef}
            className="workspace-file-viewer__breadcrumbs"
            aria-label={t("fileViewer.pathLabel")}
          >
            {breadcrumbs.map((segment, index) => (
              <span className="workspace-file-viewer__breadcrumb-part" key={segment.path}>
                {index > 0 ? (
                  <ChevronRight className="workspace-file-viewer__breadcrumb-separator" aria-hidden="true" />
                ) : null}
                <button
                  type="button"
                  className={segment.kind === "file" ? "is-file" : ""}
                  aria-haspopup="tree"
                  aria-expanded={navigatorRoot?.path === segment.path}
                  title={t("fileViewer.openDirectory", { name: segment.name })}
                  onClick={() => openNavigator(segment)}
                >
                  {segment.name}
                </button>
              </span>
            ))}
          </nav>
          {activeTarget ? (
            <WorkspaceFileOpenActions key={activeTarget.path} filePath={activeTarget.path} requestId={activeTarget.requestId}
              workspacePath={workspacePath} {...(threadId ? { threadId } : {})} />
          ) : null}
        </div>
      ) : null}
      {navigatorRoot && navigatorRootPath ? (
        <div
          ref={navigatorRef}
          className="workspace-file-viewer__navigator"
          role="dialog"
          aria-label={t("fileViewer.fileList", { name: navigatorRoot.name })}
        >
          <div className="workspace-file-viewer__navigator-head">
            <span>
              <FolderOpen aria-hidden="true" />
              {basename(navigatorRootPath)}
            </span>
            <button
              type="button"
              aria-label={t("fileViewer.closeFileList")}
              title={t("fileViewer.closeFileList")}
              onClick={() => setNavigatorRoot(null)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="workspace-file-viewer__navigator-body">
            {directoryError ? (
              <div className="workspace-file-viewer__navigator-error" role="status">
                <span>
                  {t("fileBrowser.directoryLoadFailed")}: {directoryError}
                </span>
                <button
                  type="button"
                  onClick={() => void loadDirectory(navigatorRootPath, navigatorRequestRef.current)}
                >
                  <RotateCcw aria-hidden="true" />
                  {t("fileBrowser.retry")}
                </button>
              </div>
            ) : loadingDirectories.has(navigatorRootPath) && !entriesByDirectory[navigatorRootPath] ? (
              <div className="workspace-file-viewer__navigator-message">
                {t("fileViewer.loadingDirectory")}
              </div>
            ) : entriesByDirectory[navigatorRootPath]?.length === 0 ? (
              <div className="workspace-file-viewer__navigator-message">{t("fileViewer.emptyDirectory")}</div>
            ) : (
              <FileNavigatorBranch
                directoryPath={navigatorRootPath}
                depth={0}
                {...(activeTarget?.path ? { currentFilePath: activeTarget.path } : {})}
                entriesByDirectory={entriesByDirectory}
                expandedDirectories={expandedDirectories}
                loadingDirectories={loadingDirectories}
                onSelectFile={selectFile}
                onToggleDirectory={toggleDirectory}
              />
            )}
          </div>
        </div>
      ) : null}
      <div className="workspace-file-viewer__preview">
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
            <button type="button" onClick={retry} disabled={!activeTarget}>
              <RotateCcw size={13} aria-hidden="true" />
              {t("fileBrowser.retry")}
            </button>
          </div>
        ) : file ? (
          <WorkspaceFilePreview
            file={file}
            workspacePath={workspacePath}
            onDirtyChange={setDirty}
            {...(previewTarget ? { target: previewTarget } : {})}
          />
        ) : (
          <div className="workspace-file-browser__message">{t("fileViewer.noFile")}</div>
        )}
      </div>
    </div>
  );
}
