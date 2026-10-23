import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Check,
  CheckCheck,
  ChevronDown,
  Circle,
  ClipboardList,
  Folder,
  ImagePlus,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  Plus,
  Search,
  Send,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { type ClipboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadSummary } from "../shared/ipc";
import {
  type ProjectTodo,
  type ProjectTodoImage,
  TODO_MAX_IMAGE_BYTES,
  TODO_MAX_IMAGES,
} from "../shared/project-todos";
import { formatIpcInvokeError } from "./AppMessage";
import {
  isAllowedImageMediaType,
  readImageFileAsAttachment,
  revokeComposerAttachmentPreview,
} from "./composer-attachments";
import { createTodoImage } from "./project-todo-images";
import { projectDisplayName, type SchedulingProjectOption } from "./SchedulingProjectField";
import "./project-todos.css";

export interface TodoEditorDraft {
  id?: string;
  revision?: number;
  projectPath: string;
  text: string;
  images: ProjectTodoImage[];
  completed: boolean;
}
function todoApi() {
  const api = window.eco;
  if (!api) throw new Error("Desktop API is unavailable.");
  return api;
}

interface Props {
  projects: readonly SchedulingProjectOption[];
  currentProjectPath?: string | undefined;
  threads: readonly ThreadSummary[];
  draft: TodoEditorDraft;
  onDraftChange(draft: TodoEditorDraft): void;
  onClose(): void;
  onCompose(todo: ProjectTodo, threadId?: string): Promise<void>;
}
export function ProjectTodoPanel(props: Props) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [items, setItems] = useState<ProjectTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const [selected, setSelected] = useState(
    props.draft.id || props.draft.text || props.draft.images.length
      ? props.draft.projectPath
      : (props.currentProjectPath ?? ""),
  );
  const [query, setQuery] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [undo, setUndo] = useState<{ item: ProjectTodo; revision: number }>();
  const [preview, setPreview] = useState<ProjectTodoImage>();
  const [composeTarget, setComposeTarget] = useState<ProjectTodo>();
  const [threadQuery, setThreadQuery] = useState("");
  const threadPickerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(props.draft);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  function updateDraft(next: TodoEditorDraft) {
    draftRef.current = next;
    setDraft(next);
    props.onDraftChange(next);
  }
  const change = (update: Partial<TodoEditorDraft>) => {
    const next = { ...draftRef.current, ...update };
    draftRef.current = next;
    updateDraft(next);
  };
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setItems(await todoApi().listProjectTodos());
    } catch (caught) {
      setError(formatIpcInvokeError(caught));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const previous = document.activeElement as HTMLElement | null;
    previewRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [preview]);
  useEffect(() => {
    if (!composeTarget) return;
    const previous = document.activeElement as HTMLElement | null;
    threadPickerRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [composeTarget]);
  const targetThreads = useMemo(() => {
    const needle = threadQuery.trim().toLocaleLowerCase();
    return props.threads
      .filter((thread) => thread.workspacePath === composeTarget?.projectPath &&
        (!needle || thread.title.toLocaleLowerCase().includes(needle) || thread.prompt.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [props.threads, composeTarget?.projectPath, threadQuery]);
  const projects = useMemo(() => {
    const map = new Map(props.projects.map((project) => [project.path, project]));
    for (const item of items)
      if (!map.has(item.projectPath))
        map.set(item.projectPath, { path: item.projectPath, name: projectDisplayName([], item.projectPath) });
    if (draft.projectPath && !map.has(draft.projectPath))
      map.set(draft.projectPath, {
        path: draft.projectPath,
        name: projectDisplayName([], draft.projectPath),
      });
    return [...map.values()];
  }, [props.projects, items, draft.projectPath]);
  const pendingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items)
      if (!item.completed) counts.set(item.projectPath, (counts.get(item.projectPath) ?? 0) + 1);
    return counts;
  }, [items]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter(
      (item) =>
        (!selected || item.projectPath === selected) &&
        (!needle ||
          item.text.toLocaleLowerCase().includes(needle) ||
          projectDisplayName(projects, item.projectPath).toLocaleLowerCase().includes(needle)),
    );
  }, [items, selected, query, projects]);
  const pending = filtered.filter((item) => !item.completed);
  const completed = filtered.filter((item) => item.completed);
  async function action(key: string, task: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    setError("");
    try {
      await task();
    } catch (caught) {
      setError(formatIpcInvokeError(caught));
    } finally {
      busyRef.current = false;
      setBusy("");
      if (key === "save" || key === "images") requestAnimationFrame(() => inputRef.current?.focus());
    }
  }
  function replace(item: ProjectTodo) {
    setItems((current) =>
      current.some((row) => row.id === item.id)
        ? current.map((row) => (row.id === item.id ? item : row))
        : [item, ...current],
    );
  }
  function reset() {
    updateDraft({ projectPath: draftRef.current.projectPath, text: "", images: [], completed: false });
    inputRef.current?.focus();
  }
  function save() {
    const snapshot = draftRef.current;
    if ((!snapshot.text.trim() && !snapshot.images.length) || !snapshot.projectPath) return;
    void action("save", async () => {
      const saved = await todoApi().saveProjectTodo(snapshot);
      replace(saved);
      setSelected(saved.projectPath);
      setQuery("");
      reset();
    });
  }
  async function addImages(files: File[]) {
    if (!files.length) return;
    await action("images", async () => {
      const snapshot = draftRef.current;
      if (snapshot.images.length + files.length > TODO_MAX_IMAGES) throw new Error(t("todos.imageLimit"));
      if (files.some((file) => !isAllowedImageMediaType(file.type) || file.size > TODO_MAX_IMAGE_BYTES))
        throw new Error(t("todos.imageInvalid"));
      const additions = await Promise.all(
        files.map(async (file) => {
          const image = await readImageFileAsAttachment(file);
          if (!image?.data) throw new Error(t("todos.imageInvalid"));
          try {
            return await createTodoImage(image.id, image.mediaType, image.data);
          } catch {
            throw new Error(t("todos.imageInvalid"));
          } finally {
            revokeComposerAttachmentPreview(image);
          }
        }),
      );
      change({ images: [...draftRef.current.images, ...additions] });
      inputRef.current?.focus();
    });
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (busyRef.current) {
      event.preventDefault();
      return;
    }
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .flatMap((item) => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
    if (!images.length) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      const field = event.currentTarget;
      change({
        text:
          draftRef.current.text.slice(0, field.selectionStart) +
          text +
          draftRef.current.text.slice(field.selectionEnd),
      });
    }
    void addImages(images);
  }
  function chooseProject(path: string) {
    setSelected(path);
    setQuery("");
    if (path && !draft.id) change({ projectPath: path });
  }
  const canSave = Boolean(draft.projectPath && (draft.text.trim() || draft.images.length));
  function renderCard(item: ProjectTodo) {
    return (
      <motion.article
        key={item.id}
        className={`todo-card${item.completed ? " is-completed" : ""}`}
        layout={!reducedMotion}
        initial={reducedMotion ? false : { opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.98 }}
        transition={{ type: "spring", bounce: 0, duration: 0.24 }}
      >
        <button
          type="button"
          className="todo-check"
          disabled={!!busy}
          aria-label={t(item.completed ? "todos.reopen" : "todos.complete")}
          title={t(item.completed ? "todos.reopen" : "todos.complete")}
          onClick={() =>
            void action(item.id, async () =>
              replace(await todoApi().saveProjectTodo({ ...item, completed: !item.completed })),
            )
          }
        >
          {item.completed ? <Check size={14} /> : <Circle size={19} />}
        </button>
        <div className="todo-card-body">
          {item.text ? (
            <button
              type="button"
              className="todo-text"
              disabled={!!busy}
              onClick={() => void edit(item)}
              title={t("todos.edit")}
            >
              {item.text}
            </button>
          ) : (
            <span className="todo-image-label">{t("todos.imageTodo")}</span>
          )}
          {!!item.images.length && (
            <div className="todo-thumbnails">
              {item.images.map((image, index) => (
                <button
                  type="button"
                  key={image.id}
                  onClick={() =>
                    void action(item.id, async () => {
                      const full = await todoApi().getProjectTodo(item.id);
                      setPreview(full.images[index]);
                    })
                  }
                  disabled={!!busy}
                  aria-label={t("todos.previewImage", { index: index + 1 })}
                >
                  <img src={image.thumbnail} alt={t("todos.imageAlt", { index: index + 1 })} loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="todo-card-actions">
          <button
            type="button"
            className="todo-icon todo-secondary-action"
            disabled={!!busy}
            onClick={() => void edit(item)}
            aria-label={t("todos.edit")}
            title={t("todos.edit")}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="todo-icon todo-secondary-action"
            disabled={!!busy}
            onClick={() =>
              void action(item.id, async () => {
                const revision = await todoApi().trashProjectTodo({
                  id: item.id,
                  revision: item.revision,
                  deleted: true,
                });
                setItems((current) => current.filter((row) => row.id !== item.id));
                setUndo({ item, revision });
              })
            }
            aria-label={t("todos.delete")}
            title={t("todos.delete")}
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            className="todo-send"
            disabled={!!busy}
            onClick={() => {
              setThreadQuery("");
              setError("");
              setComposeTarget(item);
            }}
            aria-label={t("todos.composeExisting")}
            title={t("todos.composeExisting")}
          >
            <MessageSquarePlus size={15} />
          </button>
          <button
            type="button"
            className="todo-send"
            disabled={!!busy}
            onClick={() =>
              void action(item.id, async () => props.onCompose(await todoApi().getProjectTodo(item.id)))
            }
            aria-label={t("todos.compose")}
            title={t("todos.compose")}
          >
            {busy === item.id ? <LoaderCircle size={15} className="spinning" /> : <Send size={15} />}
          </button>
        </div>
      </motion.article>
    );
  }
  async function edit(item: ProjectTodo) {
    if (draftRef.current.id === item.id) {
      inputRef.current?.focus();
      return;
    }
    await action(item.id, async () => {
      // Keep a new note before opening another one, so switching never discards input.
      const current = draftRef.current;
      if (current.text.trim() || current.images.length) replace(await todoApi().saveProjectTodo(current));
      const full = await todoApi().getProjectTodo(item.id);
      updateDraft(full);
      inputRef.current?.focus();
    });
  }
  function groups(rows: ProjectTodo[]) {
    return projects.flatMap((project) => {
      const children = rows.filter((item) => item.projectPath === project.path);
      if (!children.length) return [];
      return [
        <section className="todo-group" key={project.path} aria-label={project.name}>
          {!selected && (
            <h3>
              <Folder size={13} />
              {project.name}
              <span>{children.length}</span>
            </h3>
          )}
          <AnimatePresence initial={false}>{children.map(renderCard)}</AnimatePresence>
        </section>,
      ];
    });
  }
  return (
    <div
      className="todo-backdrop"
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      <div
        className="todo-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="todo-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (preview) setPreview(undefined);
            else if (composeTarget) {
              if (!busy) { setComposeTarget(undefined); setError(""); }
            }
            else if (!busy) props.onClose();
          }
          if (event.key !== "Tab") return;
          const nodes = Array.from(
            (preview ? previewRef.current : composeTarget ? threadPickerRef.current : panelRef.current)?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
            ) ?? [],
          ).filter((node) => node.getClientRects().length);
          const first = nodes[0],
            last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="todo-header" inert={!!composeTarget}>
          <div className="todo-title-icon">
            <ClipboardList size={22} />
          </div>
          <div>
            <h2 id="todo-title">{t("todos.title")}</h2>
            <p>{t("todos.subtitle")}</p>
          </div>
          <button
            type="button"
            className="todo-icon todo-close"
            disabled={!!busy}
            onClick={props.onClose}
            aria-label={t("common.close")}
          >
            <X size={19} />
          </button>
        </header>
        <div className="todo-layout" inert={!!composeTarget}>
          <aside className="todo-projects" aria-label={t("todos.projects")}>
            <span className="todo-rail-label">{t("todos.projects")}</span>
            <button
              type="button"
              className={!selected ? "is-selected" : ""}
              onClick={() => chooseProject("")}
            >
              <ClipboardList size={15} />
              <span>{t("todos.all")}</span>
              <small>{items.filter((item) => !item.completed).length}</small>
            </button>
            <div className="todo-project-divider" />
            {projects.map((project) => (
              <button
                type="button"
                key={project.path}
                title={project.path}
                className={selected === project.path ? "is-selected" : ""}
                onClick={() => chooseProject(project.path)}
              >
                <Folder size={15} />
                <span>{project.name}</span>
                {!!pendingCounts.get(project.path) && <small>{pendingCounts.get(project.path)}</small>}
              </button>
            ))}
          </aside>
          <main className="todo-main">
            <div className="todo-main-heading">
              <h3>
                {selected ? projectDisplayName(projects, selected) : t("todos.all")}
                <span>
                  {selected
                    ? (pendingCounts.get(selected) ?? 0)
                    : items.filter((item) => !item.completed).length}
                </span>
              </h3>
              <label className="todo-search">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("todos.search")}
                  aria-label={t("todos.search")}
                />
                {query && (
                  <button
                    type="button"
                    className="todo-icon"
                    aria-label={t("todos.clearSearch")}
                    onClick={() => setQuery("")}
                  >
                    <X size={12} />
                  </button>
                )}
              </label>
            </div>
            <fieldset
              aria-label={t("todos.inputLabel")}
              className={`todo-capture${dragging ? " is-dragging" : ""}${draft.id ? " is-editing" : ""}`}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) {
                  event.preventDefault();
                  setDragging(true);
                }
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void addImages(Array.from(event.dataTransfer.files));
              }}
            >
              {draft.id && (
                <div className="todo-edit-label">
                  <Pencil size={12} />
                  {t("todos.editing")}
                  <button type="button" disabled={!!busy} onClick={reset}>
                    {t("todos.cancelEdit")}
                  </button>
                </div>
              )}
              <textarea
                ref={inputRef}
                value={draft.text}
                maxLength={100000}
                readOnly={!!busy}
                aria-label={t("todos.inputLabel")}
                placeholder={t("todos.placeholder")}
                onChange={(event) => change({ text: event.target.value })}
                onPaste={paste}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (!busy) save();
                  }
                }}
              />
              {!!draft.images.length && (
                <div className="todo-draft-images">
                  {draft.images.map((image, index) => (
                    <div key={image.id}>
                      <button
                        type="button"
                        onClick={() => setPreview(image)}
                        aria-label={t("todos.previewImage", { index: index + 1 })}
                      >
                        <img src={image.thumbnail} alt={t("todos.imageAlt", { index: index + 1 })} />
                      </button>
                      <button
                        type="button"
                        className="todo-remove-image"
                        disabled={!!busy}
                        onClick={() => change({ images: draft.images.filter((row) => row.id !== image.id) })}
                        aria-label={t("todos.removeImage", { index: index + 1 })}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="todo-capture-footer">
                <label className="todo-project-select">
                  <Folder size={13} />
                  <select
                    value={draft.projectPath}
                    disabled={!!busy}
                    aria-label={t("todos.targetProject")}
                    onChange={(event) => change({ projectPath: event.target.value })}
                  >
                    <option value="" disabled>
                      {t("todos.selectProject")}
                    </option>
                    {projects.map((project) => (
                      <option key={project.path} value={project.path}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={11} />
                </label>
                <button
                  type="button"
                  className="todo-icon"
                  disabled={!!busy || draft.images.length >= TODO_MAX_IMAGES}
                  onClick={() => fileRef.current?.click()}
                  aria-label={t("todos.addImages")}
                  title={t("todos.addImages")}
                >
                  <ImagePlus size={16} />
                </button>
                <input
                  ref={fileRef}
                  hidden
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  onChange={(event) => {
                    void addImages(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <span className="todo-key-hint">{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} ↵</span>
                <button type="button" className="todo-add" disabled={!canSave || !!busy} onClick={save}>
                  {busy === "save" || busy === "images" ? (
                    <LoaderCircle size={14} className="spinning" />
                  ) : draft.id ? (
                    <Check size={14} />
                  ) : (
                    <Plus size={14} />
                  )}{" "}
                  {t(draft.id ? "todos.save" : "todos.add")}
                </button>
              </div>
            </fieldset>
            {error && !composeTarget && (
              <div className="todo-error" role="alert">
                <span>{error}</span>
                <button type="button" disabled={!!busy} onClick={() => void refresh()}>
                  {t("todos.refresh")}
                </button>
              </div>
            )}
            <div className="todo-scroll" aria-busy={loading}>
              {loading ? (
                <div className="todo-empty">
                  <LoaderCircle size={24} className="spinning" />
                  <p>{t("common.loading")}</p>
                </div>
              ) : (
                <>
                  {pending.length
                    ? groups(pending)
                    : !error && (
                        <div className="todo-empty">
                          <div className="todo-empty-symbol">
                            {query ? <Search size={25} /> : <CheckCheck size={27} />}
                          </div>
                          <h4>{t(query ? "todos.noResults" : "todos.empty")}</h4>
                          <p>{t(query ? "todos.searchHint" : "todos.emptyHint")}</p>
                        </div>
                      )}
                  {!!completed.length && (
                    <>
                      <button
                        type="button"
                        className={`todo-completed-toggle${showCompleted ? " is-open" : ""}`}
                        onClick={() => setShowCompleted((value) => !value)}
                      >
                        <ChevronDown size={13} />
                        {t("todos.completed")}
                        <span>{completed.length}</span>
                      </button>
                      {showCompleted && groups(completed)}
                    </>
                  )}
                </>
              )}
            </div>
            <footer className="todo-footnote">
              <Send size={12} />
              {t("todos.sendHint")}
            </footer>
          </main>
        </div>
        {undo && (
          <div className="todo-undo" role="status" inert={!!composeTarget}>
            <Check size={14} />
            <span>{t("todos.deleted")}</span>
            <button
              type="button"
              disabled={!!busy}
              onClick={() =>
                void action("undo", async () => {
                  const revision = await todoApi().trashProjectTodo({
                    id: undo.item.id,
                    revision: undo.revision,
                    deleted: false,
                  });
                  replace({ ...undo.item, revision });
                  setUndo(undefined);
                })
              }
            >
              <Undo2 size={13} />
              {t("todos.undo")}
            </button>
            <button
              type="button"
              className="todo-icon"
              onClick={() => setUndo(undefined)}
              aria-label={t("common.close")}
            >
              <X size={13} />
            </button>
          </div>
        )}
        {composeTarget && (
          <div className="todo-thread-overlay" onClick={() => {
            if (!busy) { setComposeTarget(undefined); setError(""); }
          }}>
            <div className="todo-thread-picker" ref={threadPickerRef} role="dialog" aria-modal="true"
              aria-labelledby="todo-thread-title" onClick={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <h3 id="todo-thread-title">{t("todos.selectThread")}</h3>
                  <p>{projectDisplayName(projects, composeTarget.projectPath)}</p>
                </div>
                <button type="button" className="todo-icon" disabled={!!busy}
                  aria-label={t("common.close")} onClick={() => { setComposeTarget(undefined); setError(""); }}>
                  <X size={18} />
                </button>
              </header>
              <label className="todo-thread-search">
                <Search size={15} />
                <input value={threadQuery} onChange={(event) => setThreadQuery(event.target.value)}
                  placeholder={t("todos.searchThreads")} aria-label={t("todos.searchThreads")} />
              </label>
              <div className="todo-thread-list" aria-busy={!!busy}>
                {targetThreads.map((thread) => (
                  <button type="button" key={thread.id} disabled={!!busy}
                    onClick={() => void action(thread.id, async () =>
                      props.onCompose(await todoApi().getProjectTodo(composeTarget.id), thread.id))}>
                    {busy === thread.id ? <LoaderCircle size={16} className="spinning" /> : <MessageSquarePlus size={16} />}
                    <span>{thread.title || thread.prompt}</span>
                  </button>
                ))}
                {!targetThreads.length && <p className="todo-thread-empty">
                  {t(threadQuery.trim() ? "todos.noThreadsFound" : "todos.noThreads")}
                </p>}
              </div>
              {error && <p className="todo-error" role="alert">{error}</p>}
              <p className="todo-thread-hint">{t("todos.existingHint")}</p>
            </div>
          </div>
        )}
        {preview && (
          <div
            className="todo-preview"
            ref={previewRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("todos.preview")}
          >
            <button
              type="button"
              className="todo-preview-scrim"
              onClick={() => setPreview(undefined)}
              aria-label={t("common.close")}
            />
            <button
              type="button"
              className="todo-icon"
              onClick={() => setPreview(undefined)}
              aria-label={t("common.close")}
            >
              <X size={22} />
            </button>
            <img
              src={preview.data ? `data:${preview.mediaType};base64,${preview.data}` : preview.thumbnail}
              alt={t("todos.preview")}
            />
          </div>
        )}
      </div>
    </div>
  );
}
