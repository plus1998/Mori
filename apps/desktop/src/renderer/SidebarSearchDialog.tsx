import {
  Activity,
  Clock3,
  Folder,
  Globe,
  ListTodo,
  Monitor,
  Search,
  Server,
  MessageSquare,
} from "lucide-react";
import { type RefObject, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { pathToName } from "../shared/home-project";
import type { ThreadSummary } from "../shared/ipc";
import type { ScheduleDefinition } from "../shared/scheduling";
import { matchesProjectSearchTerms } from "../shared/project-pinyin-search";
import type { ProjectTodo } from "../shared/project-todos";
import type { SshBookmarkView } from "../shared/ssh-bookmarks";
import type { WebChatItem } from "../shared/web-chat-list";

export interface SidebarSearchProject {
  path: string;
  name: string;
  /** Pinyin spellings of a Chinese project name, e.g. "会话存档" -> "huihuacundang". */
  searchTerms?: readonly string[];
}

export type SidebarSearchResult =
  | { kind: "thread"; key: string; thread: ThreadSummary; projectName: string }
  | { kind: "scheduled_message"; key: string; message: ScheduleDefinition; thread: ThreadSummary }
  | { kind: "project"; key: string; project: SidebarSearchProject }
  | { kind: "todo"; key: string; todo: ProjectTodo; projectName: string }
  | { kind: "web_chat"; key: string; item: WebChatItem }
  | { kind: "ssh_bookmark"; key: string; bookmark: SshBookmarkView }
  | { kind: "browser_page"; key: string; page: SidebarSearchBrowserPage };

export interface SidebarSearchBrowserPage {
  id: string;
  title: string;
  url: string;
  faviconUrl?: string;
}

export type SidebarSearchCategory =
  | "all"
  | "projects"
  | "threads"
  | "running"
  | "todos"
  | "websites"
  | "ssh"
  | "pages";

interface SidebarSearchDialogProps {
  open: boolean;
  threads: readonly ThreadSummary[];
  projects: readonly SidebarSearchProject[];
  scheduledMessages?: readonly ScheduleDefinition[];
  todos?: readonly ProjectTodo[];
  websites?: readonly WebChatItem[];
  sshBookmarks?: readonly SshBookmarkView[];
  browserPages?: readonly SidebarSearchBrowserPage[];
  schedulingError?: string;
  onClose: () => void;
  onSelectThread: (thread: ThreadSummary) => void;
  onSelectProject: (path: string) => void;
  onSelectScheduledMessage?: (message: ScheduleDefinition, thread: ThreadSummary) => void;
  onSelectTodo?: (todo: ProjectTodo) => void;
  onSelectWebsite?: (item: WebChatItem) => void;
  onSelectSshBookmark?: (bookmark: SshBookmarkView) => void;
  onSelectBrowserPage?: (page: SidebarSearchBrowserPage) => void;
}

const MAX_THREAD_RESULTS = 10;
const MAX_PROJECT_RESULTS = 8;
const MAX_MESSAGE_RESULTS = 10;
const EMPTY_MESSAGES: readonly ScheduleDefinition[] = [];
const EMPTY_TODOS: readonly ProjectTodo[] = [];
const EMPTY_WEBSITES: readonly WebChatItem[] = [];
const EMPTY_SSH: readonly SshBookmarkView[] = [];
const EMPTY_PAGES: readonly SidebarSearchBrowserPage[] = [];

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function buildSidebarSearchResults(
  threads: readonly ThreadSummary[],
  projects: readonly SidebarSearchProject[],
  query: string,
  scheduledMessages: readonly ScheduleDefinition[] = EMPTY_MESSAGES,
  resources: {
    todos?: readonly ProjectTodo[];
    websites?: readonly WebChatItem[];
    sshBookmarks?: readonly SshBookmarkView[];
    browserPages?: readonly SidebarSearchBrowserPage[];
  } = {},
): SidebarSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  const projectNames = new Map(projects.map((project) => [project.path, project.name]));
  const matchingThreads = [...threads]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .filter((thread) => !normalizedQuery || normalizeSearchText(thread.title).includes(normalizedQuery));
  const runningThreads = matchingThreads.filter((thread) => thread.status === "running");
  const recentThreads = matchingThreads
    .filter((thread) => thread.status !== "running")
    .slice(0, MAX_THREAD_RESULTS);
  const threadResults = [...runningThreads, ...recentThreads].map(
    (thread): SidebarSearchResult => ({
      kind: "thread",
      key: `thread:${thread.id}`,
      thread,
      projectName: projectNames.get(thread.workspacePath) ?? (pathToName(thread.workspacePath) || "项目"),
    }),
  );
  const projectResults = projects
    .filter(
      (project) =>
        !normalizedQuery ||
        normalizeSearchText(project.name).includes(normalizedQuery) ||
        normalizeSearchText(project.path).includes(normalizedQuery) ||
        matchesProjectSearchTerms(project.searchTerms, normalizedQuery),
    )
    .slice(0, MAX_PROJECT_RESULTS)
    .map(
      (project): SidebarSearchResult => ({
        kind: "project",
        key: `project:${project.path}`,
        project,
      }),
    );
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const messageResults: SidebarSearchResult[] = [];
  for (const message of [...scheduledMessages].sort(
    (left, right) =>
      (left.nextRunAt ?? "9999").localeCompare(right.nextRunAt ?? "9999") ||
      right.createdAt.localeCompare(left.createdAt),
  )) {
    if (message.kind !== "session_message" || !message.threadId) continue;
    const thread = threadsById.get(message.threadId);
    if (!thread) continue;
    if (
      normalizedQuery &&
      ![message.name, message.prompt, thread.title].some((text) =>
        normalizeSearchText(text).includes(normalizedQuery),
      )
    )
      continue;
    messageResults.push({
      kind: "scheduled_message",
      key: `scheduled_message:${message.id}`,
      message,
      thread,
    });
    if (messageResults.length === MAX_MESSAGE_RESULTS) break;
  }
  const projectTodos = resources.todos ?? EMPTY_TODOS;
  const todoResults: SidebarSearchResult[] = projectTodos
    .filter(
      (todo) =>
        !normalizedQuery ||
        [todo.text, todo.projectPath].some((text) => normalizeSearchText(text).includes(normalizedQuery)),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_MESSAGE_RESULTS)
    .map((todo) => ({
      kind: "todo",
      key: `todo:${todo.id}`,
      todo,
      projectName: projectNames.get(todo.projectPath) ?? (pathToName(todo.projectPath) || "项目"),
    }));
  const websiteResults: SidebarSearchResult[] = (resources.websites ?? EMPTY_WEBSITES)
    .filter(
      (item) =>
        !normalizedQuery ||
        [item.title, item.url].some((text) => normalizeSearchText(text).includes(normalizedQuery)),
    )
    .slice(0, MAX_PROJECT_RESULTS)
    .map((item) => ({ kind: "web_chat", key: `web_chat:${item.id}`, item }));
  const sshResults: SidebarSearchResult[] = (resources.sshBookmarks ?? EMPTY_SSH)
    .filter(
      (bookmark) =>
        !normalizedQuery ||
        [bookmark.name, bookmark.host, bookmark.username, String(bookmark.port)].some((text) =>
          normalizeSearchText(text).includes(normalizedQuery),
        ),
    )
    .slice(0, MAX_PROJECT_RESULTS)
    .map((bookmark) => ({ kind: "ssh_bookmark", key: `ssh_bookmark:${bookmark.id}`, bookmark }));
  const pageResults: SidebarSearchResult[] = (resources.browserPages ?? EMPTY_PAGES)
    .filter(
      (page) =>
        !normalizedQuery ||
        [page.title, page.url].some((text) => normalizeSearchText(text).includes(normalizedQuery)),
    )
    .slice(0, MAX_PROJECT_RESULTS)
    .map((page) => ({ kind: "browser_page", key: `browser_page:${page.id}`, page }));
  return [
    ...threadResults.filter((result) => result.kind === "thread" && result.thread.status === "running"),
    ...messageResults,
    ...threadResults.filter((result) => result.kind === "thread" && result.thread.status !== "running"),
    ...projectResults,
    ...todoResults,
    ...websiteResults,
    ...sshResults,
    ...pageResults,
  ];
}

export function SidebarSearchDialog({
  open,
  threads,
  projects,
  scheduledMessages = EMPTY_MESSAGES,
  todos = EMPTY_TODOS,
  websites = EMPTY_WEBSITES,
  sshBookmarks = EMPTY_SSH,
  browserPages = EMPTY_PAGES,
  schedulingError,
  onClose,
  onSelectThread,
  onSelectProject,
  onSelectScheduledMessage,
  onSelectTodo,
  onSelectWebsite,
  onSelectSshBookmark,
  onSelectBrowserPage,
}: SidebarSearchDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [category, setCategory] = useState<SidebarSearchCategory>("all");
  const [loadedTodos, setLoadedTodos] = useState<readonly ProjectTodo[]>(EMPTY_TODOS);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeResultRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const effectiveTodos = todos.length > 0 ? todos : loadedTodos;
  const results = useMemo(
    () =>
      buildSidebarSearchResults(threads, projects, deferredQuery, scheduledMessages, {
        todos: effectiveTodos,
        websites,
        sshBookmarks,
        browserPages,
      }),
    [
      deferredQuery,
      projects,
      threads,
      scheduledMessages,
      effectiveTodos,
      websites,
      sshBookmarks,
      browserPages,
    ],
  );
  const visibleResults = useMemo(
    () =>
      results.filter((result) => {
        if (category === "all") return true;
        if (category === "projects") return result.kind === "project";
        if (category === "threads") return result.kind === "thread" && result.thread.status !== "running";
        if (category === "running") return result.kind === "thread" && result.thread.status === "running";
        if (category === "todos") return result.kind === "todo" || result.kind === "scheduled_message";
        if (category === "websites") return result.kind === "web_chat";
        if (category === "ssh") return result.kind === "ssh_bookmark";
        return result.kind === "browser_page";
      }),
    [category, results],
  );
  const runningThreadResults = results.filter(
    (result) => result.kind === "thread" && result.thread.status === "running",
  );
  const recentThreadResults = results.filter(
    (result) => result.kind === "thread" && result.thread.status !== "running",
  );
  const projectResults = results.filter((result) => result.kind === "project");
  const messageResults = results.filter((result) => result.kind === "scheduled_message");
  const activeResult = visibleResults[activeIndex];

  useEffect(() => {
    setActiveIndex((current) =>
      visibleResults.length === 0 ? 0 : Math.min(current, visibleResults.length - 1),
    );
  }, [visibleResults.length]);

  useEffect(() => {
    if (!open) return undefined;
    setQuery("");
    setActiveIndex(0);
    setCategory("all");
    if (!todos.length)
      void window.eco
        ?.listProjectTodos?.()
        .then(setLoadedTodos)
        .catch(() => setLoadedTodos(EMPTY_TODOS));
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, todos.length]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  useEffect(() => {
    if (activeIndex < 0) return;
    activeResultRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  function selectResult(result: SidebarSearchResult | undefined) {
    if (!result) return;
    if (result.kind === "thread") {
      onSelectThread(result.thread);
    } else if (result.kind === "scheduled_message") {
      onSelectScheduledMessage?.(result.message, result.thread);
    } else if (result.kind === "project") {
      onSelectProject(result.project.path);
    } else if (result.kind === "todo") {
      onSelectTodo?.(result.todo);
    } else if (result.kind === "web_chat") {
      onSelectWebsite?.(result.item);
    } else if (result.kind === "ssh_bookmark") {
      onSelectSshBookmark?.(result.bookmark);
    } else if (result.kind === "browser_page") {
      onSelectBrowserPage?.(result.page);
    }
    onClose();
  }

  return createPortal(
    <div className="sidebar-search-backdrop">
      <button
        type="button"
        className="sidebar-search-backdrop-close"
        aria-label={t("dialog.search.closeAria")}
        tabIndex={-1}
        onClick={onClose}
      />
      <section className="sidebar-search-dialog" role="dialog" aria-modal="true" aria-label={t("nav.search")}>
        <div className="sidebar-search-input-wrap">
          <Search size={19} aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder={t("nav.searchPlaceholder")}
            aria-label={t("nav.searchPlaceholder")}
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-activedescendant={activeResult ? `${listboxId}-${activeIndex}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              // IME composition (e.g. Chinese candidate confirm): do not hijack Enter/arrows.
              if (event.nativeEvent.isComposing || event.key === "Process" || event.keyCode === 229) {
                return;
              }
              if (event.key === "ArrowDown" && visibleResults.length > 0) {
                event.preventDefault();
                setActiveIndex((current) => (current + 1) % visibleResults.length);
                return;
              }
              if (event.key === "ArrowUp" && visibleResults.length > 0) {
                event.preventDefault();
                setActiveIndex((current) => (current - 1 + visibleResults.length) % visibleResults.length);
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                selectResult(activeResult);
              }
            }}
          />
          <kbd>esc</kbd>
        </div>

        <div
          id={listboxId}
          className="sidebar-search-results"
          role="listbox"
          aria-label={t("nav.searchResults")}
        >
          {schedulingError && (
            <div className="sidebar-search-empty" role="alert">
              {schedulingError}
            </div>
          )}
          {visibleResults.length === 0 ? (
            <div className="sidebar-search-empty">{t("nav.noSearchResults")}</div>
          ) : (
            <>
              {runningThreadResults.some((result) => visibleResults.includes(result)) ? (
                <SearchResultGroup
                  label={t("nav.running")}
                  results={runningThreadResults.filter((result) => visibleResults.includes(result))}
                  allResults={visibleResults}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  activeResultRef={activeResultRef}
                  onActivate={setActiveIndex}
                  onSelect={selectResult}
                />
              ) : null}
              {messageResults.some((result) => visibleResults.includes(result)) ? (
                <SearchResultGroup
                  label={t("scheduling.session_message")}
                  results={messageResults.filter((result) => visibleResults.includes(result))}
                  allResults={visibleResults}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  activeResultRef={activeResultRef}
                  onActivate={setActiveIndex}
                  onSelect={selectResult}
                />
              ) : null}
              {recentThreadResults.some((result) => visibleResults.includes(result)) ? (
                <SearchResultGroup
                  label={t("nav.threads")}
                  results={recentThreadResults.filter((result) => visibleResults.includes(result))}
                  allResults={visibleResults}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  activeResultRef={activeResultRef}
                  onActivate={setActiveIndex}
                  onSelect={selectResult}
                />
              ) : null}
              {projectResults.some((result) => visibleResults.includes(result)) ? (
                <SearchResultGroup
                  label={t("nav.projects")}
                  results={projectResults.filter((result) => visibleResults.includes(result))}
                  allResults={visibleResults}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  activeResultRef={activeResultRef}
                  onActivate={setActiveIndex}
                  onSelect={selectResult}
                />
              ) : null}
              {visibleResults.some((result) => result.kind === "todo") ? (
                <SearchResultGroup
                  label={t("nav.todos", "待办")}
                  results={visibleResults.filter((result) => result.kind === "todo")}
                  allResults={visibleResults}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  activeResultRef={activeResultRef}
                  onActivate={setActiveIndex}
                  onSelect={selectResult}
                />
              ) : null}
              {visibleResults.some((result) => result.kind === "web_chat") ? (
                <SearchResultGroup
                  label={t("nav.websites", "网站")}
                  results={visibleResults.filter((result) => result.kind === "web_chat")}
                  allResults={visibleResults}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  activeResultRef={activeResultRef}
                  onActivate={setActiveIndex}
                  onSelect={selectResult}
                />
              ) : null}
              {visibleResults.some((result) => result.kind === "ssh_bookmark") ? (
                <SearchResultGroup
                  label={t("nav.sshBookmarks", "SSH 书签")}
                  results={visibleResults.filter((result) => result.kind === "ssh_bookmark")}
                  allResults={visibleResults}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  activeResultRef={activeResultRef}
                  onActivate={setActiveIndex}
                  onSelect={selectResult}
                />
              ) : null}
              {visibleResults.some((result) => result.kind === "browser_page") ? (
                <SearchResultGroup
                  label={t("nav.pages", "网页")}
                  results={visibleResults.filter((result) => result.kind === "browser_page")}
                  allResults={visibleResults}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  activeResultRef={activeResultRef}
                  onActivate={setActiveIndex}
                  onSelect={selectResult}
                />
              ) : null}
            </>
          )}
        </div>
        <nav className="sidebar-search-categories" aria-label={t("nav.searchCategories", "搜索分类")}>
          {(
            [
              ["all", t("nav.all", "全部")],
              ["projects", t("nav.projects")],
              ["threads", t("nav.searchSessions", "会话")],
              ["running", t("nav.searchRunning", "运行中")],
              ["todos", t("nav.todos", "待办")],
              ["websites", t("nav.websites", "网站")],
              ["ssh", t("nav.sshBookmarks", "SSH 书签")],
              ["pages", t("nav.pages", "网页")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={category === value ? "is-active" : ""}
              onClick={() => {
                setCategory(value);
                setActiveIndex(0);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </section>
    </div>,
    document.body,
  );
}

interface SearchResultGroupProps {
  label: string;
  results: readonly SidebarSearchResult[];
  allResults: readonly SidebarSearchResult[];
  activeIndex: number;
  listboxId: string;
  activeResultRef: RefObject<HTMLButtonElement | null>;
  onActivate: (index: number) => void;
  onSelect: (result: SidebarSearchResult) => void;
}

function SearchResultGroup({
  label,
  results,
  allResults,
  activeIndex,
  listboxId,
  activeResultRef,
  onActivate,
  onSelect,
}: SearchResultGroupProps) {
  const { t, i18n } = useTranslation();
  return (
    <section className="sidebar-search-group" aria-label={label}>
      <h2>{label}</h2>
      <div className="sidebar-search-group-list">
        {results.map((result) => {
          const index = allResults.findIndex((candidate) => candidate.key === result.key);
          const active = index === activeIndex;
          return (
            <button
              key={result.key}
              id={`${listboxId}-${index}`}
              ref={active ? activeResultRef : undefined}
              type="button"
              role="option"
              aria-selected={active}
              className={active ? "sidebar-search-result is-active" : "sidebar-search-result"}
              onMouseEnter={() => onActivate(index)}
              onClick={() => onSelect(result)}
            >
              <span className="sidebar-search-result-icon" aria-hidden>
                {result.kind === "project" ? (
                  <Folder size={17} />
                ) : result.kind === "scheduled_message" ? (
                  <Clock3 size={17} />
                ) : result.kind === "todo" ? (
                  <ListTodo size={17} />
                ) : result.kind === "web_chat" ? (
                  <Globe size={17} />
                ) : result.kind === "ssh_bookmark" ? (
                  <Server size={17} />
                ) : result.kind === "browser_page" ? (
                  <Monitor size={17} />
                ) : result.thread.status === "running" ? (
                  <Activity size={17} />
                ) : (
                  <MessageSquare size={17} />
                )}
              </span>
              <span className="sidebar-search-result-title">
                {result.kind === "project"
                  ? result.project.name
                  : result.kind === "scheduled_message"
                    ? result.message.name
                    : result.kind === "todo"
                      ? result.todo.text || "待办"
                      : result.kind === "web_chat"
                        ? result.item.title
                        : result.kind === "ssh_bookmark"
                          ? result.bookmark.name
                          : result.kind === "browser_page"
                            ? result.page.title
                            : result.thread.title}
              </span>
              <span className="sidebar-search-result-meta">
                {result.kind === "project"
                  ? result.project.path
                  : result.kind === "thread"
                    ? result.projectName
                    : result.kind === "todo"
                      ? result.projectName
                      : result.kind === "web_chat"
                        ? result.item.url
                        : result.kind === "ssh_bookmark"
                          ? `${result.bookmark.username}@${result.bookmark.host}:${result.bookmark.port}`
                          : result.kind === "browser_page"
                            ? result.page.url
                            : `${result.thread.title} · ${result.message.error ? t("scheduling.needsAttention") : result.message.enabled && result.message.nextRunAt ? new Date(result.message.nextRunAt).toLocaleString(i18n.language) : t("scheduling.paused")}`}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
