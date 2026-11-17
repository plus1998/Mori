import { ExternalLink, RefreshCw, RotateCcw, Search, Trash2 } from "lucide-react";
import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { WorkspaceDiffFileStatus, WorkspaceDiffResult } from "../shared/ipc";
import { MaterialFileIcon } from "./MaterialFileIcon";
import { type ExplorerTreeItem, WorkspaceExplorerTree } from "./WorkspaceExplorerTree";
import { type ContextMenuBox, contextMenuBoxForPoint } from "./context-menu-layout";

const ROOT_ID = "__workspace-diff-root__";

type DiffFile = WorkspaceDiffResult["files"][number];

interface DiffTreeItem extends ExplorerTreeItem {
  filePath?: string;
  file?: DiffFile;
}

interface WorkspaceDiffFileTreeProps {
  files: DiffFile[];
  rootLabel?: string;
  activePath?: string;
  discardBusy: boolean;
  onSelectPath: (path: string) => void;
  onDiscardPath?: (path: string) => void | Promise<void>;
  workspacePath?: string;
  onDeletePath?: (path: string) => void | Promise<void>;
  onOpenContainingFolder?: (absolutePath: string) => void | Promise<void>;
  /** Manual reload of the changed-file list; omit to hide the refresh button. */
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
}

function compactSingleChildDirectories(items: Record<string, DiffTreeItem>, rootId: string): void {
  const visit = (id: string) => {
    const item = items[id];
    if (!item?.isFolder || !item.children) return;

    for (const childId of [...item.children]) {
      if (items[childId]?.isFolder) visit(childId);
    }

    while (item.children && item.children.length === 1) {
      const childId: string = item.children[0]!;
      const child: DiffTreeItem | undefined = items[childId];
      if (!child?.isFolder) break;
      item.data = `${item.data}/${child.data}`;
      item.children = child.children ?? [];
      if (child.filePath) item.filePath = child.filePath;
      delete items[childId];
    }
  };

  const root = items[rootId];
  if (!root?.children) return;
  for (const childId of [...root.children]) {
    if (items[childId]?.isFolder) visit(childId);
  }
}

export function buildDiffTree(
  files: DiffFile[],
  rootLabel = "Changes",
): {
  items: Record<string, DiffTreeItem>;
  expandedItems: string[];
  fileItemIds: Record<string, string>;
} {
  const items: Record<string, DiffTreeItem> = {
    [ROOT_ID]: {
      index: ROOT_ID,
      data: rootLabel,
      isFolder: true,
      children: [],
    },
  };
  const expandedItems = [ROOT_ID];
  const fileItemIds: Record<string, string> = {};
  const childrenByParent = new Map<string, Set<string>>();

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let parentId = ROOT_ID;
    let parentPath = "";

    segments.forEach((segment, segmentIndex) => {
      const isFile = segmentIndex === segments.length - 1;
      const currentPath = parentPath ? `${parentPath}/${segment}` : segment;
      const itemId = isFile ? `file:${file.path}` : `directory:${currentPath}`;
      if (!items[itemId]) {
        items[itemId] = isFile
          ? {
              index: itemId,
              data: segment,
              isFolder: false,
              filePath: file.path,
              file,
            }
          : {
              index: itemId,
              data: segment,
              isFolder: true,
              children: [],
              filePath: currentPath,
            };
        if (!isFile) expandedItems.push(itemId);
      }
      const parent = items[parentId]!;
      let children = childrenByParent.get(parentId);
      if (!children) {
        children = new Set();
        childrenByParent.set(parentId, children);
      }
      if (parent.children && !children.has(itemId)) {
        children.add(itemId);
        parent.children.push(itemId);
      }
      parentId = itemId;
      parentPath = currentPath;
    });
    fileItemIds[file.path] = `file:${file.path}`;
  }

  compactSingleChildDirectories(items, ROOT_ID);
  return { items, expandedItems: expandedItems.filter((index) => items[index] !== undefined), fileItemIds };
}

function resolveFileStatus(file?: DiffFile): WorkspaceDiffFileStatus {
  return file?.status ?? "modified";
}

function statusMark(status: WorkspaceDiffFileStatus, isFolder: boolean): ReactNode {
  if (isFolder) {
    return <span className="workspace-diff-tree__folder-dot" aria-hidden />;
  }
  if (status === "untracked") {
    return <span className="workspace-diff-tree__git-mark is-untracked">U</span>;
  }
  if (status === "added") {
    return <span className="workspace-diff-tree__git-mark is-added">A</span>;
  }
  if (status === "deleted") {
    return <span className="workspace-diff-tree__git-mark is-deleted">D</span>;
  }
  return (
    <span className="workspace-diff-tree__git-mark is-modified" aria-hidden>
      <span />
    </span>
  );
}

export function WorkspaceDiffFileTree({
  files,
  rootLabel,
  activePath,
  discardBusy,
  onSelectPath,
  onDiscardPath,
  workspacePath,
  onDeletePath,
  onOpenContainingFolder,
  onRefresh,
  refreshing = false,
}: WorkspaceDiffFileTreeProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focusedItem, setFocusedItem] = useState<string>();
  const [collapsedItems, setCollapsedItems] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    item: DiffTreeItem;
    x: number;
    y: number;
    trigger: HTMLElement;
  }>();
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuBox, setMenuBox] = useState<ContextMenuBox>();
  const filteredFiles = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    if (!normalizedQuery) return files;
    return files.filter((file) => file.path.toLowerCase().includes(normalizedQuery));
  }, [files, deferredQuery]);
  const tree = useMemo(() => buildDiffTree(filteredFiles, rootLabel), [filteredFiles, rootLabel]);
  const expandedItems = useMemo(
    () => tree.expandedItems.filter((index) => !collapsedItems.includes(index)),
    [collapsedItems, tree.expandedItems],
  );
  const selectedItemId = activePath ? tree.fileItemIds[activePath] : undefined;
  const selectedItems = selectedItemId ? [selectedItemId] : [];

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return;
    setMenuBox(
      contextMenuBoxForPoint(
        contextMenu,
        { height: menuRef.current.getBoundingClientRect().height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    menuRef.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        contextMenu.trigger.focus();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  const absolutePath =
    contextMenu?.item.filePath && workspacePath
      ? `${workspacePath.replace(/[\\/]+$/, "")}/${contextMenu.item.filePath}`
      : undefined;
  const closeContextMenu = () => setContextMenu(undefined);

  return (
    <div className="workspace-diff-tree">
      <div className="workspace-diff-tree__toolbar" aria-busy={refreshing}>
        <label className="workspace-diff-tree__search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder={t("workspace.diff.filterFiles")}
            aria-label={t("workspace.diff.filterFiles")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="workspace-diff-tree__clear"
              aria-label={t("common.clear")}
              title={t("common.clear")}
              onClick={() => setQuery("")}
            >
              ×
            </button>
          ) : null}
        </label>
        {onRefresh ? (
          <button
            type="button"
            className="workspace-diff-tree__refresh"
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            disabled={refreshing}
            onClick={() => void onRefresh()}
          >
            <RefreshCw size={14} className={refreshing ? "spinning" : undefined} aria-hidden />
          </button>
        ) : null}
      </div>
      {files.length === 0 || filteredFiles.length === 0 ? (
        <p className="workspace-diff-drawer-files-empty">{t("workspace.diff.noMatchingFiles")}</p>
      ) : (
        <div className="workspace-diff-tree__scroll" ref={scrollRef}>
          <WorkspaceExplorerTree
            items={tree.items}
            rootItem={ROOT_ID}
            expandedItems={expandedItems}
            selectedItems={selectedItems}
            focusedItem={focusedItem ?? selectedItems[0] ?? ROOT_ID}
            onFocusItem={setFocusedItem}
            onContextMenu={(event, item) => {
              event.preventDefault();
              const treeItem = item as DiffTreeItem;
              setFocusedItem(item.index);
              if (!treeItem.isFolder && treeItem.filePath) onSelectPath(treeItem.filePath);
              setContextMenu({
                item: treeItem,
                x: event.clientX,
                y: event.clientY,
                trigger: event.currentTarget,
              });
            }}
            virtualScrollRef={scrollRef}
            treeLabel={t("workspace.diff.files")}
            hideRoot
            className="workspace-diff-tree__explorer"
            renderLeading={(item) => {
              const treeItem = item as DiffTreeItem;
              if (treeItem.isFolder) return null;
              return (
                <MaterialFileIcon
                  path={treeItem.filePath ?? treeItem.data}
                  size={16}
                  className="workspace-diff-tree__file-icon"
                />
              );
            }}
            renderTrailing={(item) => {
              const treeItem = item as DiffTreeItem;
              const status = resolveFileStatus(treeItem.file);
              return (
                <>
                  {statusMark(status, Boolean(treeItem.isFolder))}
                  {treeItem.filePath && !treeItem.isFolder && onDiscardPath ? (
                    <button
                      type="button"
                      className="workspace-diff-tree__discard"
                      aria-label={t("workspace.diff.discardFile", { path: treeItem.filePath })}
                      title={t("workspace.diff.discardFileTitle")}
                      disabled={discardBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        const path = treeItem.filePath;
                        if (path) void onDiscardPath(path);
                      }}
                    >
                      <RotateCcw size={13} aria-hidden />
                    </button>
                  ) : null}
                </>
              );
            }}
            onExpandItem={(index) => {
              setCollapsedItems((current) => current.filter((value) => value !== index));
            }}
            onCollapseItem={(index) => {
              setCollapsedItems((current) => [...new Set([...current, index])]);
            }}
            onSelectItem={(index) => {
              const selectedItem = tree.items[index];
              if (selectedItem?.filePath) onSelectPath(selectedItem.filePath);
            }}
          />
        </div>
      )}
      {contextMenu?.item.filePath && absolutePath
        ? createPortal(
            <div
              ref={menuRef}
              className="workspace-diff-context-menu"
              role="menu"
              aria-label={t("workspace.diff.fileMenuLabel")}
              style={menuBox ?? { position: "fixed", visibility: "hidden" }}
              onContextMenu={(event) => event.preventDefault()}
            >
              {onOpenContainingFolder ? (
                <button
                  type="button"
                  role="menuitem"
                  className="workspace-diff-context-menu-item"
                  onClick={() => {
                    closeContextMenu();
                    void onOpenContainingFolder(absolutePath);
                  }}
                >
                  <ExternalLink size={14} aria-hidden />
                  {t("workspace.diff.openContainingFolder")}
                </button>
              ) : null}
              {onDiscardPath ? (
                <button
                  type="button"
                  role="menuitem"
                  className="workspace-diff-context-menu-item"
                  disabled={discardBusy}
                  onClick={() => {
                    const path = contextMenu.item.filePath;
                    if (!path) return;
                    closeContextMenu();
                    void onDiscardPath(path);
                  }}
                >
                  <RotateCcw size={14} aria-hidden />
                  {t("workspace.diff.discardChanges")}
                </button>
              ) : null}
              {onDeletePath ? (
                <button
                  type="button"
                  role="menuitem"
                  className="workspace-diff-context-menu-item is-danger"
                  disabled={discardBusy}
                  onClick={() => {
                    const path = contextMenu.item.filePath;
                    if (!path) return;
                    closeContextMenu();
                    if (!window.confirm(t("workspace.diff.confirmDeleteFile", { path }))) return;
                    void onDeletePath(path);
                  }}
                >
                  <Trash2 size={14} aria-hidden />
                  {t("workspace.diff.deleteFile")}
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
