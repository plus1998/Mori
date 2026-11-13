import { Check, ChevronDown, CircleAlert, Search, X } from "lucide-react";
import {
  Children,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { clampComposerFloatingLeft, composerFloatingAvailableWidth } from "./composer-floating";

interface ComposerFieldSelectProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  /** Rendered as the placeholder option's label when no value is selected. */
  placeholder?: string | undefined;
  /** Rendered as the placeholder option when value is empty. */
  showPlaceholder?: boolean | undefined;
  title?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-labelledby"?: string | undefined;
  "aria-describedby"?: string | undefined;
  /** Highlight the trigger in red with a warning icon. */
  invalid?: boolean | undefined;
  invalidLabel?: string | undefined;
  /** Show a search box at the top of the menu that filters options by label. */
  searchable?: boolean | undefined;
  /** Placeholder for the search box. */
  searchPlaceholder?: string | undefined;
  /** Optional leading visual for a specific option (for built-in providers). */
  renderOptionIcon?: ((option: ComposerFieldOption) => ReactNode) | undefined;
  children: ReactNode;
}

interface ComposerFieldOption {
  value: string;
  label: string;
}

function textFromReactNode(node: ReactNode): string {
  if (node == null || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textFromReactNode).join("");
  }
  const props = (node as { props?: { children?: ReactNode } }).props;
  return props ? textFromReactNode(props.children) : "";
}

function optionNodes(children: ReactNode): ComposerFieldOption[] {
  const result: ComposerFieldOption[] = [];
  for (const child of Children.toArray(children)) {
    if (child && typeof child === "object" && "type" in child && child.type === "option" && child.props) {
      const props = child.props as { value?: unknown; children?: ReactNode };
      result.push({
        value: props.value == null ? "" : String(props.value),
        label: textFromReactNode(props.children),
      });
    }
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

const TRIGGER_MIN_WIDTH = 160;
const PANEL_WIDTH = 260;
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 0;
/** Search box (30px) plus its 6px top/bottom margins. */
const SEARCH_HEADER_HEIGHT = 42;

/**
 * Custom dropdown picker for simple value lists (main agent config, prompt,
 * subagent orchestration). Visually matches the auxiliary/vision model cascade
 * field so all orchestration pickers share one style language, instead of
 * falling back to the native OS `<select>` popup.
 */
export function ComposerFieldSelect({
  value,
  onChange,
  disabled,
  placeholder,
  showPlaceholder,
  title,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  invalid,
  invalidLabel,
  searchable = false,
  searchPlaceholder,
  renderOptionIcon,
  children,
}: ComposerFieldSelectProps) {
  const { t } = useTranslation();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Which element owns keyboard focus: the search box or an option row. */
  const [focusMode, setFocusMode] = useState<"search" | "item">("item");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>(() => ({ visibility: "hidden" }));

  const options = useMemo(() => optionNodes(children), [children]);
  const needle = query.trim().toLowerCase();
  const visibleOptions = useMemo(
    () =>
      searchable && needle
        ? options.filter((option) => option.label.toLowerCase().includes(needle))
        : options,
    [options, needle, searchable],
  );
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const showPlaceholderLabel = showPlaceholder && !selectedOption && Boolean(placeholder);
  const triggerLabel = selectedOption?.label ?? (showPlaceholderLabel ? placeholder : "");
  const isPlaceholder = !selectedOption;
  const hasOptions = options.length > 0;

  const updatePanelPosition = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor) {
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const availableWidth = composerFloatingAvailableWidth(margin);
    const width = Math.min(PANEL_WIDTH, Math.max(TRIGGER_MIN_WIDTH, Math.min(rect.width, availableWidth)));
    const left = clampComposerFloatingLeft(rect.left, width, margin);
    const spaceAbove = rect.top - margin;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const headerHeight = searchable ? SEARCH_HEADER_HEIGHT : HEADER_HEIGHT;
    const estimatedHeight = headerHeight + options.length * ROW_HEIGHT + 12;
    const minHeight = 88;
    const placeAbove = spaceAbove >= minHeight && spaceAbove >= spaceBelow;
    const availableSpace = Math.max(60, Math.floor(placeAbove ? spaceAbove : spaceBelow));
    const maxHeight = Math.min(estimatedHeight, availableSpace);
    setPanelStyle({
      position: "fixed",
      left,
      width,
      maxHeight,
      zIndex: 10002,
      ...(placeAbove ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
    });
  }, [options.length, searchable]);

  const closePanel = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    setFocusMode("item");
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const openPanel = useCallback(() => {
    if (disabled || !hasOptions) {
      return;
    }
    setQuery("");
    setFocusedIndex(Math.max(0, selectedIndex));
    setFocusMode(searchable ? "search" : "item");
    updatePanelPosition();
    setOpen(true);
  }, [disabled, hasOptions, selectedIndex, searchable, updatePanelPosition]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const updatePositions = () => {
      updatePanelPosition();
    };
    updatePanelPosition();
    window.addEventListener("resize", updatePositions);
    window.addEventListener("scroll", updatePositions, true);
    return () => {
      window.removeEventListener("resize", updatePositions);
      window.removeEventListener("scroll", updatePositions, true);
    };
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (focusMode === "search" && searchable) {
        searchInputRef.current?.focus();
        return;
      }
      buttonRefs.current[focusedIndex]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusMode, focusedIndex, open, searchable]);

  // Clamp the focused row when the search query shrinks the list.
  useEffect(() => {
    if (!open) {
      return;
    }
    if (focusedIndex >= visibleOptions.length) {
      setFocusedIndex(Math.max(0, visibleOptions.length - 1));
    }
  }, [focusedIndex, open, visibleOptions.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      closePanel(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        // First Escape with a non-empty query clears the filter, mirroring ModelCascadeSelect.
        if (searchable && query.trim()) {
          setQuery("");
          requestAnimationFrame(() => searchInputRef.current?.focus());
          return;
        }
        closePanel(true);
      } else if (event.key === "Tab") {
        closePanel(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closePanel, open, query, searchable]);

  function focusAt(index: number) {
    if (visibleOptions.length === 0) {
      return;
    }
    const nextIndex = clamp(index, 0, visibleOptions.length - 1);
    setFocusedIndex(nextIndex);
    setFocusMode("item");
    requestAnimationFrame(() => buttonRefs.current[nextIndex]?.focus());
  }

  function commit(option: ComposerFieldOption) {
    onChange(option.value);
    closePanel(true);
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const only = visibleOptions.length === 1 ? visibleOptions[0] : undefined;
      if (only) {
        commit(only);
      }
    }
  }

  function handleItemKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index === visibleOptions.length - 1 ? 0 : index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index === 0 ? visibleOptions.length - 1 : index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(visibleOptions.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = visibleOptions[index];
      if (option) {
        commit(option);
      }
    }
  }

  const popover =
    open &&
    createPortal(
      <div
        id={menuId}
        ref={panelRef}
        className="composer-codex-popover composer-field-select-menu"
        role="listbox"
        aria-label={ariaLabel ?? (triggerLabel || undefined)}
        aria-labelledby={labelledBy}
        style={panelStyle}
      >
        {searchable ? (
          <label className="model-cascade-search">
            <Search size={14} aria-hidden />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              placeholder={searchPlaceholder ?? t("composer.fieldSelect.search")}
              aria-label={searchPlaceholder ?? t("composer.fieldSelect.search")}
              disabled={disabled}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            {query ? (
              <button
                type="button"
                className="model-cascade-search-clear"
                aria-label={t("common.close")}
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
              >
                <X size={12} aria-hidden />
              </button>
            ) : null}
          </label>
        ) : null}
        <ul className="composer-field-select-menu-list" role="none">
          {visibleOptions.map((option, index) => {
            const selected = option.value === value;
            return (
              <li key={option.value} role="none">
                <button
                  ref={(node) => {
                    buttonRefs.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={focusedIndex === index ? 0 : -1}
                  className={
                    selected
                      ? "composer-field-select-menu-item is-selected"
                      : "composer-field-select-menu-item"
                  }
                  title={option.label}
                  onMouseEnter={() => setFocusedIndex(index)}
                  onKeyDown={(event) => handleItemKeyDown(event, index)}
                  onClick={() => commit(option)}
                >
                  <span className="composer-field-select-menu-icon" aria-hidden="true">
                    {renderOptionIcon?.(option)}
                  </span>
                  <span className="composer-field-select-menu-label">{option.label}</span>
                  {selected ? <Check size={14} strokeWidth={2} aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        {searchable && needle && visibleOptions.length === 0 ? (
          <p className="model-cascade-status">{t("composer.fieldSelect.noMatch")}</p>
        ) : null}
      </div>,
      document.body,
    );

  return (
    <span className="composer-field-select">
      {/* Keep option children mounted (hidden) so callers / SSR / tests can still observe values. */}
      <span className="composer-field-select-options" hidden aria-hidden="true">
        {children}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className={[
          "composer-field-select-trigger",
          open ? "is-active" : "",
          selectedOption ? "has-selection" : "",
          invalid ? "is-invalid" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        disabled={disabled}
        aria-label={ariaLabel ?? (triggerLabel || undefined)}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={title ?? (invalid ? invalidLabel : undefined) ?? triggerLabel}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            openPanel();
          }
        }}
        onClick={() => {
          if (open) {
            closePanel(false);
          } else {
            openPanel();
          }
        }}
      >
        <span
          className={
            isPlaceholder
              ? "composer-field-select-trigger-label is-placeholder"
              : "composer-field-select-trigger-label"
          }
        >
          {triggerLabel}
        </span>
        {invalid ? (
          <CircleAlert size={14} strokeWidth={2} aria-hidden className="composer-field-select-invalid-icon" />
        ) : null}
        <ChevronDown
          size={14}
          aria-hidden
          className={open ? "composer-field-select-chevron is-open" : "composer-field-select-chevron"}
        />
      </button>
      {popover}
    </span>
  );
}
