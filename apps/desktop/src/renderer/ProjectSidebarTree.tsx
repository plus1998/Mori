import {
  Folder,
  FolderOpen,
  Home,
  LoaderCircle,
  MessageCirclePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Terminal,
  Trash2,
} from "lucide-react";
import { type DragEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadSummary } from "../shared/ipc";
import type { AppLocale } from "../shared/locale";
import { ICON_SIZE, ICON_STROKE } from "./icon-metrics";
import { coreDisplayName, coreIconSrc } from "./SidebarCoreSelector";
import type { ProjectReorderPosition } from "./project-sidebar-order";
import { formatRelativeTime } from "./relative-time";

const PROJECT_DRAG_MIME = "application/x-eco-project-path";

export interface ProjectTreeItem {
  project: { path: string; name: string; pinned?: boolean; isHome?: boolean };
  projectThreads: ThreadSummary[];
  collapsed: boolean;
  visibleThreads: ThreadSummary[];
  hasMore: boolean;
}

interface ProjectSidebarTreeProps {
  projectTree: ProjectTreeItem[];
  currentProjectPath: string | undefined;
  activeThreadId: string | undefined;
  revealTarget?: { kind: "project" | "thread"; id: string; requestId: number } | undefined;
  unreadThreadIds: ReadonlySet<string>;
  pinnedThreadIds: ReadonlySet<string>;
  draftThreadIds?: ReadonlySet<string>;
  onSwitchProject: (path: string) => void;
  onSelectThread: (thread: ThreadSummary) => void;
  onToggleProjectCollapsed: (path: string) => void;
  onExpandProjectThreads: (path: string) => void;
  onReorderProjects: (draggedPath: string, targetPath: string, position: ProjectReorderPosition) => void;
  onOpenProjectPath: (path: string) => Promise<void>;
  onPinProject: (path: string) => void;
  onUnpinProject: (path: string) => void;
  onRemoveProject: (path: string) => void;
  onRenameProject: (path: string, name: string) => void;
  onResetProjectName: (path: string) => void;
  onOpenTerminalSettings?: (path: string, name: string) => void;
  customProjectNames?: Readonly<Record<string, string>> | undefined;
  onPinThread: (threadId: string) => void;
  onUnpinThread: (threadId: string) => void;
  deletingThreadId?: string | undefined;
  onDeleteThread: (thread: ThreadSummary) => void;
  pendingBashApprovalThreadIds?: ReadonlySet<string>;
  pendingPlanThreadIds?: ReadonlySet<string>;
}

function isExternalFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function isInternalProjectDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(PROJECT_DRAG_MIME);
}

function resolveDropPosition(event: DragEvent, element: HTMLElement): ProjectReorderPosition {
  const rect = element.getBoundingClientRect();
  const offsetY = event.clientY - rect.top;
  return offsetY < rect.height / 2 ? "before" : "after";
}

export function ProjectSidebarTree({
  projectTree,
  currentProjectPath,
  activeThreadId,
  revealTarget,
  unreadThreadIds,
  pinnedThreadIds,
  draftThreadIds,
  onSwitchProject,
  onSelectThread,
  onToggleProjectCollapsed,
  onExpandProjectThreads,
  onReorderProjects,
  onOpenProjectPath,
  onPinProject,
  onUnpinProject,
  onRemoveProject,
  onRenameProject,
  onResetProjectName,
  onOpenTerminalSettings,
  customProjectNames,
  onPinThread,
  onUnpinThread,
  deletingThreadId,
  onDeleteThread,
  pendingBashApprovalThreadIds,
  pendingPlanThreadIds,
}: ProjectSidebarTreeProps) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language) as AppLocale;
  const [fileDropActive, setFileDropActive] = useState(false);
  const [draggingPath, setDraggingPath] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ path: string; position: ProjectReorderPosition }>();
  const [openMenuPath, setOpenMenuPath] = useState<string>();
  const [renamingPath, setRenamingPath] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const renameDraftRef = useRef("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const revealThreadVisible =
    revealTarget?.kind === "thread" &&
    projectTree.some(
      (item) => !item.collapsed && item.visibleThreads.some((thread) => thread.id === revealTarget.id),
    );

  useEffect(() => {
    if (renamingPath) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingPath]);

  function startRenameProject(projectPath: string, currentName: string) {
    renameDraftRef.current = currentName;
    setRenameDraft(currentName);
    setRenamingPath(projectPath);
    setOpenMenuPath(undefined);
  }

  function commitRenameProject() {
    const projectPath = renamingPath;
    if (!projectPath) {
      setRenamingPath(undefined);
      return;
    }
    setRenamingPath(undefined);
    onRenameProject(projectPath, renameDraftRef.current);
  }

  useLayoutEffect(() => {
    if (!revealTarget || (revealTarget.kind === "thread" && !revealThreadVisible)) {
      return;
    }
    const attribute = revealTarget.kind === "thread" ? "data-thread-id" : "data-project-path";
    const target = Array.from(treeRef.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? []).find(
      (element) => element.getAttribute(attribute) === revealTarget.id,
    );
    if (!target) {
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
    target.classList.remove("sidebar-reveal-highlight");
    void target.offsetWidth;
    target.classList.add("sidebar-reveal-highlight");
    return () => target.classList.remove("sidebar-reveal-highlight");
  }, [revealTarget, revealThreadVisible]);

  useEffect(() => {
    if (!openMenuPath) {
      return;
    }
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".sidebar-menu-wrap")) {
        return;
      }
      setOpenMenuPath(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenuPath(undefined);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuPath]);

  function clearFileDropState() {
    dragCounterRef.current = 0;
    setFileDropActive(false);
  }

  function handleTreeDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!isExternalFileDrag(event)) {
      return;
    }
    event.preventDefault();
    dragCounterRef.current += 1;
    setFileDropActive(true);
  }

  function handleTreeDragOver(event: DragEvent<HTMLDivElement>) {
    if (isInternalProjectDrag(event)) {
      return;
    }
    if (!isExternalFileDrag(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setFileDropActive(true);
  }

  function handleTreeDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!isExternalFileDrag(event)) {
      return;
    }
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setFileDropActive(false);
    }
  }

  async function handleTreeDrop(event: DragEvent<HTMLDivElement>) {
    if (isInternalProjectDrag(event)) {
      return;
    }
    if (!isExternalFileDrag(event)) {
      return;
    }
    event.preventDefault();
    clearFileDropState();

    if (!window.eco) {
      return;
    }

    for (const file of event.dataTransfer.files) {
      const path = window.eco.getPathForFile(file);
      if (!path) {
        continue;
      }
      try {
        await onOpenProjectPath(path);
        return;
      } catch {
        // try next dropped item
      }
    }
  }

  function handleProjectDragStart(event: DragEvent<HTMLElement>, projectPath: string, isHome?: boolean) {
    if (isHome) {
      return;
    }
    event.dataTransfer.setData(PROJECT_DRAG_MIME, projectPath);
    event.dataTransfer.effectAllowed = "move";
    setDraggingPath(projectPath);
  }

  function handleProjectDragEnd() {
    setDraggingPath(undefined);
    setDropTarget(undefined);
  }

  function handleProjectRowDragOver(event: DragEvent<HTMLElement>, projectPath: string, isHome?: boolean) {
    if (!isInternalProjectDrag(event) || isHome) {
      return;
    }
    const draggedPath = event.dataTransfer.getData(PROJECT_DRAG_MIME);
    if (draggedPath && projectTree.some(({ project }) => project.isHome && project.path === draggedPath)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const position = resolveDropPosition(event, event.currentTarget);
    setDropTarget({ path: projectPath, position });
  }

  function handleProjectRowDrop(event: DragEvent<HTMLElement>, projectPath: string, isHome?: boolean) {
    if (!isInternalProjectDrag(event) || isHome) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const draggedPath = event.dataTransfer.getData(PROJECT_DRAG_MIME);
    if (!draggedPath || draggedPath === projectPath) {
      setDropTarget(undefined);
      setDraggingPath(undefined);
      return;
    }
    if (projectTree.some(({ project }) => project.isHome && project.path === draggedPath)) {
      setDropTarget(undefined);
      setDraggingPath(undefined);
      return;
    }
    const position = resolveDropPosition(event, event.currentTarget);
    onReorderProjects(draggedPath, projectPath, position);
    setDropTarget(undefined);
    setDraggingPath(undefined);
  }

  const treeClassNames = ["project-tree"];
  if (fileDropActive) {
    treeClassNames.push("project-tree-drop-target");
  }
  if (openMenuPath) {
    treeClassNames.push("project-tree-menu-open");
  }

  const displayProjectTree = [
    ...projectTree.filter(({ project }) => project.isHome),
    ...projectTree.filter(({ project }) => project.pinned && !project.isHome),
    ...projectTree.filter(({ project }) => !project.pinned && !project.isHome),
  ];

  function renderProjectItem({
    project,
    projectThreads,
    collapsed,
    visibleThreads,
    hasMore,
  }: ProjectTreeItem) {
    const rowClassNames = ["project-group-row"];
    if (draggingPath === project.path) {
      rowClassNames.push("dragging");
    }
    if (dropTarget?.path === project.path && dropTarget.position === "before") {
      rowClassNames.push("drop-before");
    }
    if (dropTarget?.path === project.path && dropTarget.position === "after") {
      rowClassNames.push("drop-after");
    }
    const isProjectActive = currentProjectPath === project.path && !activeThreadId;
    const projectMainClassNames = ["project-group-main"];
    if (isProjectActive) {
      projectMainClassNames.push("active");
    }
    if (openMenuPath === project.path) {
      projectMainClassNames.push("menu-open");
    }

    return (
      <li key={project.path} className="project-group">
        <div className={rowClassNames.join(" ")}>
          <fieldset
            aria-label={t("projectTree.dragArea", { name: project.name })}
            className={projectMainClassNames.join(" ")}
            data-project-path={project.path}
            draggable={!project.isHome}
            onDragStart={(event) => handleProjectDragStart(event, project.path, project.isHome)}
            onDragEnd={handleProjectDragEnd}
            onDragOver={(event) => handleProjectRowDragOver(event, project.path, project.isHome)}
            onDrop={(event) => handleProjectRowDrop(event, project.path, project.isHome)}
          >
            {renamingPath === project.path ? (
              <div className="project-group-rename">
                <input
                  ref={renameInputRef}
                  type="text"
                  className="project-rename-input"
                  value={renameDraft}
                  placeholder={t("projectTree.renamePlaceholder", { name: project.name })}
                  aria-label={t("projectTree.renameProject", { name: project.name })}
                  onChange={(event) => {
                    renameDraftRef.current = event.target.value;
                    setRenameDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRenameProject();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingPath(undefined);
                    }
                  }}
                  onBlur={commitRenameProject}
                />
              </div>
            ) : (
              <button
                type="button"
                className="project-group-toggle"
                aria-expanded={!collapsed}
                aria-label={
                  collapsed
                    ? t("projectTree.expandProject", { name: project.name })
                    : t("projectTree.collapseProject", { name: project.name })
                }
                onClick={() => onToggleProjectCollapsed(project.path)}
              >
                {project.pinned && !project.isHome ? (
                  <span className="project-pin-indicator" title={t("projectTree.pinned")} aria-hidden>
                    <Pin size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
                  </span>
                ) : null}
                {project.isHome ? (
                  <Home size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
                ) : collapsed ? (
                  <Folder size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
                ) : (
                  <FolderOpen size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
                )}
                <span>{project.name}</span>
              </button>
            )}
            <span
              className={
                openMenuPath === project.path ? "project-row-actions menu-open" : "project-row-actions"
              }
            >
              {!project.isHome ? (
                <span className="project-menu-wrap sidebar-menu-wrap">
                  <button
                    type="button"
                    className="project-menu-trigger"
                    title={t("projectTree.actions", { name: project.name })}
                    aria-label={t("projectTree.actions", { name: project.name })}
                    aria-haspopup="menu"
                    aria-expanded={openMenuPath === project.path}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath((current) => (current === project.path ? undefined : project.path));
                    }}
                  >
                    <MoreHorizontal size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
                  </button>
                  {openMenuPath === project.path ? (
                    <div className="project-menu" role="menu">
                      <ProjectActionMenu
                        pinned={Boolean(project.pinned)}
                        hasCustomName={Boolean(customProjectNames?.[project.path])}
                        {...(onOpenTerminalSettings
                          ? {
                              onOpenTerminalSettings: () => {
                                setOpenMenuPath(undefined);
                                onOpenTerminalSettings(project.path, project.name);
                              },
                            }
                          : {})}
                        onTogglePin={() => {
                          if (project.pinned) {
                            onUnpinProject(project.path);
                          } else {
                            onPinProject(project.path);
                          }
                          setOpenMenuPath(undefined);
                        }}
                        onStartRename={() => {
                          startRenameProject(project.path, project.name);
                        }}
                        onResetName={() => {
                          onResetProjectName(project.path);
                          setOpenMenuPath(undefined);
                        }}
                        onRemove={() => {
                          onRemoveProject(project.path);
                          setOpenMenuPath(undefined);
                        }}
                      />
                    </div>
                  ) : null}
                </span>
              ) : null}
              <button
                type="button"
                className="project-new-chat"
                title={t("projectTree.newThread", { name: project.name })}
                aria-label={t("projectTree.newThread", { name: project.name })}
                onClick={(event) => {
                  event.stopPropagation();
                  onSwitchProject(project.path);
                }}
              >
                <MessageCirclePlus size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
              </button>
            </span>
          </fieldset>
        </div>
        {!collapsed ? (
          projectThreads.length > 0 ? (
            <>
              {visibleThreads.map((thread) => {
                const isThreadBusy = thread.status === "running" || thread.status === "queued";
                const isThreadAwaitingApproval = isThreadWaitingForApproval(thread, {
                  hasPendingBashApproval: pendingBashApprovalThreadIds?.has(thread.id) === true,
                  hasPendingPlan: pendingPlanThreadIds?.has(thread.id) === true,
                });
                const isThreadUnread = unreadThreadIds.has(thread.id);
                const hasThreadStatusIndicator =
                  isThreadAwaitingApproval ||
                  isThreadBusy ||
                  thread.status === "failed" ||
                  thread.status === "blocked" ||
                  isThreadUnread;
                const isThreadPinned = pinnedThreadIds.has(thread.id);
                const rowClassName = [
                  "chat-item-row",
                  activeThreadId === thread.id ? "active" : "",
                  isThreadPinned ? "is-thread-pinned" : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <div key={thread.id} className={rowClassName} data-thread-id={thread.id}>
                    <button type="button" className="chat-item nested" onClick={() => onSelectThread(thread)}>
                      {thread.coreKind ? (
                        <img
                          className="chat-item-core-icon"
                          src={coreIconSrc(thread.coreKind)}
                          alt={coreDisplayName(thread.coreKind)}
                        />
                      ) : null}
                      <span className="chat-item-title-row">
                        <span className="chat-item-title">{thread.title}</span>
                        {draftThreadIds?.has(thread.id) ? (
                          <span className="chat-item-draft" title={t("projectTree.draftHint")}>
                            {t("projectTree.draft")}
                          </span>
                        ) : null}
                      </span>
                      {hasThreadStatusIndicator ? (
                        <span className="chat-item-meta">
                          {isThreadAwaitingApproval ? (
                            <span
                              className="chat-item-approval"
                              title={thread.message || t("projectTree.awaitingApproval")}
                            >
                              {t("projectTree.awaitingApproval")}
                            </span>
                          ) : isThreadBusy ? (
                            <span
                              className="chat-item-loading"
                              title={thread.cancelling ? t("activity.stopping") : thread.status}
                              role="img"
                              aria-label={thread.cancelling ? t("activity.stopping") : thread.status}
                            >
                              <LoaderCircle
                                size={ICON_SIZE.sm}
                                strokeWidth={ICON_STROKE}
                                className="spinning"
                                aria-hidden
                              />
                            </span>
                          ) : isThreadUnread ? (
                            <span
                              className="chat-item-unread-dot"
                              title={t("projectTree.completedUnread")}
                              role="status"
                              aria-label={t("projectTree.completedUnread")}
                            />
                          ) : (
                            <span className={`status-dot ${thread.status}`} title={thread.status} />
                          )}
                        </span>
                      ) : null}
                    </button>
                    <span
                      className={
                        hasThreadStatusIndicator
                          ? "chat-item-trailing chat-item-trailing-actions-only"
                          : "chat-item-trailing"
                      }
                    >
                      {!hasThreadStatusIndicator ? (
                        <span className="chat-item-trailing-label">
                          {isThreadPinned ? (
                            <span className="chat-item-pin-indicator" aria-hidden>
                              <Pin size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
                            </span>
                          ) : (
                            <span className="chat-item-time">
                              {formatRelativeTime(thread.updatedAt ?? thread.createdAt, Date.now(), locale)}
                            </span>
                          )}
                        </span>
                      ) : null}
                      <span className="chat-item-trailing-actions">
                        {!hasThreadStatusIndicator ? (
                          <button
                            type="button"
                            className="chat-item-row-action"
                            title={isThreadPinned ? t("projectTree.unpin") : t("projectTree.pin")}
                            aria-label={
                              isThreadPinned
                                ? t("projectTree.unpinNamed", { name: thread.title })
                                : t("projectTree.pinNamed", { name: thread.title })
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              if (isThreadPinned) {
                                onUnpinThread(thread.id);
                              } else {
                                onPinThread(thread.id);
                              }
                            }}
                          >
                            {isThreadPinned ? (
                              <PinOff size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
                            ) : (
                              <Pin size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
                            )}
                          </button>
                        ) : null}
                        {!isThreadBusy ? (
                          <button
                            type="button"
                            className="chat-item-row-action chat-item-row-action-danger"
                            title={t("projectTree.deleteThread")}
                            aria-label={t("projectTree.deleteThreadNamed", { name: thread.title })}
                            disabled={deletingThreadId === thread.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              onDeleteThread(thread);
                            }}
                          >
                            {deletingThreadId === thread.id ? (
                              <LoaderCircle
                                size={ICON_SIZE.sm}
                                strokeWidth={ICON_STROKE}
                                className="spinning"
                                aria-hidden
                              />
                            ) : (
                              <Trash2 size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
                            )}
                          </button>
                        ) : null}
                      </span>
                    </span>
                  </div>
                );
              })}
              {hasMore ? (
                <button
                  type="button"
                  className="project-expand"
                  onClick={() => onExpandProjectThreads(project.path)}
                >
                  {t("projectTree.showMore")}
                </button>
              ) : null}
            </>
          ) : (
            <p className="project-empty">{t("projectTree.noThreads")}</p>
          )
        ) : null}
      </li>
    );
  }

  function renderProjectSection(label: string, items: ProjectTreeItem[]) {
    if (items.length === 0) {
      return null;
    }
    return (
      <section className="project-tree-section" aria-label={label}>
        <div className="project-tree-section-label">{label}</div>
        <ul className="project-tree-section-list">{items.map(renderProjectItem)}</ul>
      </section>
    );
  }

  return (
    <div
      ref={treeRef}
      aria-label={t("projectTree.list")}
      className={treeClassNames.join(" ")}
      onDragEnter={handleTreeDragEnter}
      onDragOver={handleTreeDragOver}
      onDragLeave={handleTreeDragLeave}
      onDrop={handleTreeDrop}
      role="tree"
    >
      {projectTree.length === 0 ? (
        <p className="project-tree-empty-drop">{t("projectTree.dropFolder")}</p>
      ) : null}
      {renderProjectSection(t("nav.projects"), displayProjectTree)}
    </div>
  );
}

export interface ProjectActionMenuProps {
  pinned: boolean;
  hasCustomName: boolean;
  onTogglePin: () => void;
  onStartRename: () => void;
  onResetName: () => void;
  onRemove: () => void;
  onOpenTerminalSettings?: () => void;
}

export function ProjectActionMenu({
  pinned,
  hasCustomName,
  onTogglePin,
  onStartRename,
  onResetName,
  onRemove,
  onOpenTerminalSettings,
}: ProjectActionMenuProps) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        className="project-menu-item"
        role="menuitem"
        onClick={onTogglePin}
      >
        {pinned ? (
          <PinOff size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
        ) : (
          <Pin size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
        )}
        <span>{pinned ? t("projectTree.unpin") : t("projectTree.pin")}</span>
      </button>
      <button
        type="button"
        className="project-menu-item"
        role="menuitem"
        onClick={onStartRename}
      >
        <Pencil size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{t("projectTree.rename")}</span>
      </button>
      {hasCustomName ? (
        <button
          type="button"
          className="project-menu-item"
          role="menuitem"
          onClick={onResetName}
        >
          <RotateCcw size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
          <span>{t("projectTree.resetName")}</span>
        </button>
      ) : null}
      {onOpenTerminalSettings ? (
        <button type="button" className="project-menu-item" role="menuitem" onClick={onOpenTerminalSettings}>
          <Terminal size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
          <span>{t("terminal.projectSettings")}</span>
        </button>
      ) : null}
      <button
        type="button"
        className="project-menu-item danger"
        role="menuitem"
        onClick={onRemove}
      >
        <Trash2 size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{t("projectTree.remove")}</span>
      </button>
    </>
  );
}

export function isThreadWaitingForApproval(
  thread: Pick<ThreadSummary, "status">,
  input?: { hasPendingBashApproval?: boolean; hasPendingPlan?: boolean },
): boolean {
  if (thread.status === "awaiting_plan" || input?.hasPendingPlan === true) {
    return true;
  }
  return input?.hasPendingBashApproval === true;
}
