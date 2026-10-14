import { Clock3, Folder, Search } from "lucide-react";
import { type RefObject, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ThreadSummary } from "../shared/ipc";
import type { ScheduleDefinition } from "../shared/scheduling";

export interface SidebarSearchProject {
  path: string;
  name: string;
}

export type SidebarSearchResult =
  | { kind: "thread"; key: string; thread: ThreadSummary; projectName: string }
  | { kind: "scheduled_message"; key: string; message: ScheduleDefinition; thread: ThreadSummary }
  | { kind: "project"; key: string; project: SidebarSearchProject };

interface SidebarSearchDialogProps {
  open: boolean;
  threads: readonly ThreadSummary[];
  projects: readonly SidebarSearchProject[];
  scheduledMessages?: readonly ScheduleDefinition[];
  schedulingError?: string;
  onClose: () => void;
  onSelectThread: (thread: ThreadSummary) => void;
  onSelectProject: (path: string) => void;
  onSelectScheduledMessage?: (message: ScheduleDefinition, thread: ThreadSummary) => void;
}

const MAX_THREAD_RESULTS = 10;
const MAX_PROJECT_RESULTS = 8;
const MAX_MESSAGE_RESULTS = 10;
const EMPTY_MESSAGES: readonly ScheduleDefinition[] = [];

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function buildSidebarSearchResults(
  threads: readonly ThreadSummary[],
  projects: readonly SidebarSearchProject[],
  query: string,
  scheduledMessages: readonly ScheduleDefinition[] = EMPTY_MESSAGES,
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
      projectName: projectNames.get(thread.workspacePath) ?? thread.workspacePath.split("/").at(-1) ?? "项目",
    }),
  );
  const projectResults = projects
    .filter(
      (project) =>
        !normalizedQuery ||
        normalizeSearchText(project.name).includes(normalizedQuery) ||
        normalizeSearchText(project.path).includes(normalizedQuery),
    )
    .slice(0, MAX_PROJECT_RESULTS)
    .map(
      (project): SidebarSearchResult => ({
        kind: "project",
        key: `project:${project.path}`,
        project,
      }),
    );
  const threadsById = new Map(threads.map(thread => [thread.id, thread]));
  const messageResults: SidebarSearchResult[] = [];
  for (const message of [...scheduledMessages].sort((left, right) =>
    (left.nextRunAt ?? "9999").localeCompare(right.nextRunAt ?? "9999") || right.createdAt.localeCompare(left.createdAt))) {
    if (message.kind !== "session_message" || !message.threadId) continue;
    const thread = threadsById.get(message.threadId);
    if (!thread) continue;
    if (normalizedQuery && ![message.name, message.prompt, thread.title].some(text => normalizeSearchText(text).includes(normalizedQuery))) continue;
    messageResults.push({ kind: "scheduled_message", key: `scheduled_message:${message.id}`, message, thread });
    if (messageResults.length === MAX_MESSAGE_RESULTS) break;
  }
  return [...threadResults.filter(result => result.kind === "thread" && result.thread.status === "running"), ...messageResults,
    ...threadResults.filter(result => result.kind === "thread" && result.thread.status !== "running"), ...projectResults];
}

export function SidebarSearchDialog({
  open,
  threads,
  projects,
  scheduledMessages = EMPTY_MESSAGES,
  schedulingError,
  onClose,
  onSelectThread,
  onSelectProject,
  onSelectScheduledMessage,
}: SidebarSearchDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeResultRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const results = useMemo(
    () => buildSidebarSearchResults(threads, projects, deferredQuery, scheduledMessages),
    [deferredQuery, projects, threads, scheduledMessages],
  );
  const runningThreadResults = results.filter(
    (result) => result.kind === "thread" && result.thread.status === "running",
  );
  const recentThreadResults = results.filter(
    (result) => result.kind === "thread" && result.thread.status !== "running",
  );
  const projectResults = results.filter((result) => result.kind === "project");
  const messageResults = results.filter(result => result.kind === "scheduled_message");
  const activeResult = results[activeIndex];

  useEffect(() => {
    if (!open) return undefined;
    setQuery("");
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

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
    } else {
      onSelectProject(result.project.path);
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
              if (
                event.nativeEvent.isComposing ||
                event.key === "Process" ||
                event.keyCode === 229
              ) {
                return;
              }
              if (event.key === "ArrowDown" && results.length > 0) {
                event.preventDefault();
                setActiveIndex((current) => (current + 1) % results.length);
                return;
              }
              if (event.key === "ArrowUp" && results.length > 0) {
                event.preventDefault();
                setActiveIndex((current) => (current - 1 + results.length) % results.length);
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
          {schedulingError && <div className="sidebar-search-empty" role="alert">{schedulingError}</div>}
          {results.length === 0 ? (
            <div className="sidebar-search-empty">{t("nav.noSearchResults")}</div>
          ) : (
            <>
              {runningThreadResults.length > 0 ? (
                <SearchResultGroup
                  label={t("nav.running")}
                  results={runningThreadResults}
                  allResults={results}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  activeResultRef={activeResultRef}
                  onActivate={setActiveIndex}
                  onSelect={selectResult}
                />
              ) : null}
              {messageResults.length > 0 ? <SearchResultGroup
                label={t("scheduling.session_message")}
                results={messageResults}
                allResults={results}
                activeIndex={activeIndex}
                listboxId={listboxId}
                activeResultRef={activeResultRef}
                onActivate={setActiveIndex}
                onSelect={selectResult}
              /> : null}
              {recentThreadResults.length > 0 ? (
                <SearchResultGroup
                  label={t("nav.threads")}
                  results={recentThreadResults}
                  allResults={results}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  activeResultRef={activeResultRef}
                  onActivate={setActiveIndex}
                  onSelect={selectResult}
                />
              ) : null}
              {projectResults.length > 0 ? (
                <SearchResultGroup
                  label={t("nav.projects")}
                  results={projectResults}
                  allResults={results}
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
                {result.kind === "project" ? <Folder size={17} /> : result.kind === "scheduled_message" ? <Clock3 size={17}/> : <span />}
              </span>
              <span className="sidebar-search-result-title">
                {result.kind === "project" ? result.project.name : result.kind === "scheduled_message" ? result.message.name : result.thread.title}
              </span>
              <span className="sidebar-search-result-meta">
                {result.kind === "project" ? result.project.path : result.kind === "thread" ? result.projectName :
                  `${result.thread.title} · ${result.message.error ? t("scheduling.needsAttention") : result.message.enabled && result.message.nextRunAt ? new Date(result.message.nextRunAt).toLocaleString(i18n.language) : t("scheduling.paused")}`}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
