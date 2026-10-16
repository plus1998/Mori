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
} from "../shared/composer-references";
import type { ComposerSkillsInputHandle } from "./ComposerSkillsInput";
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
}: {
  prompt: string;
  cursor: number;
  inputRef: RefObject<ComposerSkillsInputHandle | null>;
  onChange(value: string): void;
  capabilities: readonly ComposerCapabilityReference[];
}) {
  const query = useMemo(() => parseMentionQuery(prompt, cursor), [prompt, cursor]);
  const queryKey = query ? JSON.stringify(query) : "";
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
    if (!queryKey) setDismissed("");
    setActiveIndex(0);
  }, [queryKey]);
  useEffect(() => {
    if (!open || !query) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const api = window.eco;
      if (!api) {
        setResult({ key: queryKey, items: [], hasMore: false, error: "引用服务尚未连接" });
        return;
      }
      void api
        .searchComposerReferences({ query: query.query, ...(query.kind ? { kind: query.kind } : {}) })
        .then((value) => {
          if (!cancelled) setResult({ key: queryKey, ...value });
        })
        .catch((error) => {
          if (!cancelled) setResult({ key: queryKey, items: [], hasMore: false, error: String(error) });
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, queryKey]);
  const referenced = useMemo(
    () => new Set(composerReferences(prompt).map((item) => `${item.kind}:${item.id}`)),
    [prompt],
  );
  const items = useMemo(
    () =>
      [
        ...(query ? filterComposerCapabilityReferences(capabilities, query) : []),
        ...(result.key === queryKey ? result.items : []),
      ].filter((item) => !referenced.has(`${item.kind}:${item.id}`)),
    [capabilities, query, result, queryKey, referenced],
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
    items,
    activeIndex,
    setActiveIndex,
    select,
    close,
    onKeyDown,
    loading: open && result.key !== queryKey,
    error: result.key === queryKey ? result.error : undefined,
    hasMore: result.key === queryKey && result.hasMore,
  };
}
