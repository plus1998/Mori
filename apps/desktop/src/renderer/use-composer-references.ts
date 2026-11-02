import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type KeyboardEvent,
} from "react";
import {
  composerReferenceToken,
  composerReferences,
  parseMentionQuery,
  type ComposerReference,
  type ComposerReferenceKind,
} from "../shared/composer-references";
import type { ComposerSkillsInputHandle } from "./ComposerSkillsInput";
import { matchesProjectSearchTerms } from "../shared/project-pinyin-search";
import {
  filterComposerCapabilityReferences,
  type ComposerCapabilityReference,
} from "../shared/composer-capability-references";

export function useComposerReferences({
  prompt,
  cursor,
  inputRef,
  onChange,
  capabilities,
  projects,
}: {
  prompt: string;
  cursor: number;
  inputRef: RefObject<ComposerSkillsInputHandle | null>;
  onChange(value: string): void;
  capabilities: readonly ComposerCapabilityReference[];
  projects: readonly { path: string; name: string; searchTerms?: readonly string[] }[];
}) {
  const query = useMemo(() => parseMentionQuery(prompt, cursor), [prompt, cursor]);
  const queryKey = query ? JSON.stringify(query) : "";
  const [selectedKind, setSelectedKind] = useState<ComposerReferenceKind>();
  const [dismissed, setDismissed] = useState("");
  const [result, setResult] = useState<{
    key: string;
    items: ComposerReference[];
    hasMore: boolean;
    error?: string;
  }>({ key: "", items: [], hasMore: false });
  const [activeIndex, setActiveIndex] = useState(0);
  const pendingSelection = useRef<{ prompt: string; cursor: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    if (!pending || pending.prompt !== prompt) return;
    pendingSelection.current = undefined;
    // The child editor has rendered its atomic chip. Position the caret now;
    // a delayed animation frame can otherwise overwrite the user's next selection.
    inputRef.current?.focus();
    inputRef.current?.setCursor(pending.cursor);
    inputRef.current?.fitHeight();
  }, [prompt, inputRef]);
  const open = Boolean(query && dismissed !== queryKey);
  useEffect(() => {
    setSelectedKind(query?.kind);
  }, [open, query?.start, query?.kind]);
  const searchRequest = useMemo(() => ({
    query: query?.query ?? "",
    ...(selectedKind ? { kind: selectedKind } : {}),
  }), [query?.query, selectedKind]);
  const searchKey = JSON.stringify(searchRequest);
  useEffect(() => {
    if (!queryKey) setDismissed("");
    setActiveIndex(0);
  }, [queryKey]);
  useEffect(() => {
    if (!open || !query) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const api = window.eco;
      if (!api) {
        setResult({ key: searchKey, items: [], hasMore: false, error: "引用服务尚未连接" });
        return;
      }
      void api
        .searchComposerReferences(searchRequest)
        .then((value) => {
          if (!cancelled) setResult({ key: searchKey, ...value });
        })
        .catch((error) => {
          if (!cancelled) setResult({ key: searchKey, items: [], hasMore: false, error: String(error) });
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, searchKey, searchRequest]);
  const referenced = useMemo(
    () => new Set(composerReferences(prompt).map((item) => `${item.kind}:${item.id}`)),
    [prompt],
  );
  const matchingProjects = useMemo(() => {
    if (!query || (selectedKind && selectedKind !== "project")) return [];
    const term = query.query.trim().toLocaleLowerCase();
    return projects.filter((project) =>
      !referenced.has(`project:${project.path}`) &&
      (`${project.name} ${project.path}`.toLocaleLowerCase().includes(term)
        || matchesProjectSearchTerms(project.searchTerms, term)),
    );
  }, [projects, query, referenced, selectedKind]);
  const items = useMemo(
    () =>
      [
        ...matchingProjects.slice(0, 12)
              .map((project): ComposerReference => ({
                kind: "project", id: project.path, label: project.name, detail: project.path,
              })),
        ...(query ? filterComposerCapabilityReferences(capabilities, searchRequest) : []),
        ...(result.key === searchKey ? result.items : []),
      ].filter((item) => !referenced.has(`${item.kind}:${item.id}`)),
    [capabilities, matchingProjects, query, result, searchKey, searchRequest, referenced],
  );
  const selectionKey = items.map((item) => `${item.kind}:${item.id}`).join("|");
  useEffect(() => {
    setActiveIndex(0);
  }, [selectionKey]);
  const close = useCallback(() => setDismissed(queryKey), [queryKey]);
  const select = (reference: ComposerReference) => {
    if (!query) return;
    const replacement = `${composerReferenceToken(reference)} `;
    const next = prompt.slice(0, query.start) + replacement + prompt.slice(cursor);
    const nextCursor = query.start + replacement.length;
    pendingSelection.current = { prompt: next, cursor: nextCursor };
    onChange(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((value) =>
        items.length ? (value + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0,
      );
      return true;
    }
    if (
      (event.key === "Enter" || event.key === "Tab") &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      const selected = items[activeIndex];
      if (selected) select(selected);
      return true;
    }
    return false;
  };
  return {
    open,
    selectedKind,
    setSelectedKind,
    items,
    activeIndex,
    setActiveIndex,
    select,
    close,
    onKeyDown,
    loading: open && result.key !== searchKey,
    error: result.key === searchKey ? result.error : undefined,
    hasMore: matchingProjects.length > 12 || (result.key === searchKey && result.hasMore),
  };
}
