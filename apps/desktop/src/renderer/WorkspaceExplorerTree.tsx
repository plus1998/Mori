import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import "./workspace-explorer-tree.css";

export interface ExplorerTreeItem {
  index: string;
  data: string;
  children?: string[];
  isFolder: boolean;
}

/** Keep the extension visible when the stem is truncated with an ellipsis. */
export function splitFileLabelName(name: string, isFolder = false): { stem: string; ext: string } {
  if (isFolder || !name) return { stem: name, ext: "" };
  // Dotfiles like `.gitignore` / `.env` have no useful extension to pin.
  if (name.startsWith(".") && name.indexOf(".", 1) < 0) {
    return { stem: name, ext: "" };
  }
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return { stem: name, ext: "" };
  }
  return {
    stem: name.slice(0, lastDot),
    ext: name.slice(lastDot),
  };
}

export interface WorkspaceExplorerTreeProps {
  items: Record<string, ExplorerTreeItem>;
  rootItem: string;
  expandedItems: string[];
  selectedItems: string[];
  focusedItem?: string;
  treeLabel: string;
  /** When true, skip rendering the root node and show its children at depth 0. */
  hideRoot?: boolean;
  className?: string;
  renderLeading?: (item: ExplorerTreeItem, context: { expanded: boolean }) => ReactNode;
  renderTrailing?: (item: ExplorerTreeItem) => ReactNode;
  onExpandItem: (index: string) => void;
  onCollapseItem: (index: string) => void;
  onSelectItem: (index: string) => void;
  onFocusItem?: (index: string) => void;
  /** Opt in for large review lists with a known fixed row height and gap. */
  virtualScrollRef?: RefObject<HTMLDivElement | null>;
}

interface FlatNode {
  index: string;
  depth: number;
}

function collectVisibleNodes(
  items: Record<string, ExplorerTreeItem>,
  rootItem: string,
  expanded: Set<string>,
  hideRoot: boolean,
): FlatNode[] {
  const result: FlatNode[] = [];

  const walk = (index: string, depth: number) => {
    const item = items[index];
    if (!item) return;
    result.push({ index, depth });
    if (!item.isFolder || !expanded.has(index)) return;
    for (const child of item.children ?? []) {
      if (items[child]) walk(child, depth + 1);
    }
  };

  const root = items[rootItem];
  if (!root) return result;

  if (hideRoot) {
    if (!expanded.has(rootItem)) return result;
    for (const child of root.children ?? []) {
      if (items[child]) walk(child, 0);
    }
    return result;
  }

  walk(rootItem, 0);
  return result;
}

export function WorkspaceExplorerTree({
  items,
  rootItem,
  expandedItems,
  selectedItems,
  focusedItem,
  treeLabel,
  hideRoot = true,
  className,
  renderLeading,
  renderTrailing,
  onExpandItem,
  onCollapseItem,
  onSelectItem,
  onFocusItem,
  virtualScrollRef,
}: WorkspaceExplorerTreeProps) {
  const treeId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const expanded = useMemo(() => new Set(expandedItems), [expandedItems]);
  const selected = useMemo(() => new Set(selectedItems), [selectedItems]);
  const nodes = useMemo(
    () => collectVisibleNodes(items, rootItem, expanded, hideRoot),
    [expanded, hideRoot, items, rootItem],
  );
  const activeIndex =
    focusedItem && items[focusedItem]
      ? focusedItem
      : (selectedItems.find((index) => items[index]) ?? nodes[0]?.index);
  const virtualized = virtualScrollRef !== undefined && nodes.length > 300;
  const getItemKey = useCallback((index: number) => nodes[index]!.index, [nodes]);
  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => virtualScrollRef?.current ?? null,
    estimateSize: () => 42,
    getItemKey,
    overscan: 8,
    enabled: virtualized,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const visibleNodes = virtualized ? virtualRows.map((row) => nodes[row.index]!) : nodes;

  useEffect(() => {
    if (!activeIndex || !listRef.current) return;
    if (virtualized) {
      const index = nodes.findIndex((node) => node.index === activeIndex);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
      return;
    }
    const escaped =
      typeof CSS !== "undefined" && "escape" in CSS
        ? CSS.escape(activeIndex)
        : activeIndex.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const row = listRef.current.querySelector<HTMLElement>(`[data-tree-index="${escaped}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, nodes, virtualized, virtualizer]);

  const toggleFolder = useCallback(
    (index: string) => {
      if (expanded.has(index)) onCollapseItem(index);
      else onExpandItem(index);
    },
    [expanded, onCollapseItem, onExpandItem],
  );

  const activateItem = useCallback(
    (index: string) => {
      const item = items[index];
      if (!item) return;
      onFocusItem?.(index);
      onSelectItem(index);
      // Clicking a folder row selects it and expands if collapsed; collapse only via chevron.
      if (item.isFolder && !expanded.has(index)) onExpandItem(index);
    },
    [expanded, items, onExpandItem, onFocusItem, onSelectItem],
  );

  const moveFocus = useCallback(
    (direction: 1 | -1) => {
      if (nodes.length === 0) return;
      const current = activeIndex ? nodes.findIndex((node) => node.index === activeIndex) : -1;
      const nextIndex =
        current < 0
          ? direction === 1
            ? 0
            : nodes.length - 1
          : Math.min(Math.max(current + direction, 0), nodes.length - 1);
      const next = nodes[nextIndex];
      if (next) onFocusItem?.(next.index);
    },
    [activeIndex, nodes, onFocusItem],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const item = activeIndex ? items[activeIndex] : undefined;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowRight":
        if (!item || !activeIndex) break;
        event.preventDefault();
        if (item.isFolder && !expanded.has(activeIndex)) onExpandItem(activeIndex);
        else moveFocus(1);
        break;
      case "ArrowLeft":
        if (!item || !activeIndex) break;
        event.preventDefault();
        if (item.isFolder && expanded.has(activeIndex)) onCollapseItem(activeIndex);
        else moveFocus(-1);
        break;
      case "Enter":
      case " ":
        if (!activeIndex) break;
        event.preventDefault();
        activateItem(activeIndex);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={listRef}
      className={["workspace-explorer-tree", className].filter(Boolean).join(" ")}
      role="tree"
      aria-label={treeLabel}
      tabIndex={0}
      style={
        virtualized
          ? {
              paddingTop: virtualRows[0]?.start ?? 0,
              paddingBottom: Math.max(0, virtualizer.getTotalSize() - (virtualRows.at(-1)?.end ?? 0)),
            }
          : undefined
      }
      onKeyDown={onKeyDown}
    >
      {visibleNodes.map((node) => {
        const item = items[node.index];
        if (!item) return null;
        const isExpanded = item.isFolder && expanded.has(node.index);
        const isSelected = selected.has(node.index);
        const isFocused = activeIndex === node.index;
        const { stem, ext } = splitFileLabelName(item.data, Boolean(item.isFolder));
        return (
          <div
            key={node.index}
            className={[
              "workspace-explorer-tree__row",
              isSelected && "is-selected",
              isFocused && "is-focused",
              item.isFolder && "is-folder",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ "--tree-depth": node.depth } as CSSProperties}
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={item.isFolder ? isExpanded : undefined}
            aria-level={node.depth + 1}
            data-tree-index={node.index}
            tabIndex={-1}
            onClick={() => activateItem(node.index)}
            onFocus={() => onFocusItem?.(node.index)}
          >
            <span
              className="workspace-explorer-tree__indent"
              style={{ width: node.depth * 16 }}
              aria-hidden
            />
            {item.isFolder ? (
              <button
                type="button"
                className="workspace-explorer-tree__chevron"
                tabIndex={-1}
                aria-hidden
                onClick={(event) => {
                  event.stopPropagation();
                  onFocusItem?.(node.index);
                  toggleFolder(node.index);
                }}
              >
                {isExpanded ? (
                  <ChevronDown size={14} strokeWidth={2} />
                ) : (
                  <ChevronRight size={14} strokeWidth={2} />
                )}
              </button>
            ) : (
              <span className="workspace-explorer-tree__leading">
                {renderLeading?.(item, { expanded: false })}
              </span>
            )}
            {item.isFolder ? (
              <span className="workspace-explorer-tree__leading">
                {renderLeading?.(item, { expanded: Boolean(isExpanded) })}
              </span>
            ) : null}
            <span className="workspace-explorer-tree__label" id={`${treeId}-${node.index}`} title={item.data}>
              {ext ? (
                <>
                  <span className="workspace-explorer-tree__label-stem">{stem}</span>
                  <span className="workspace-explorer-tree__label-ext">{ext}</span>
                </>
              ) : (
                <span className="workspace-explorer-tree__label-stem">{stem}</span>
              )}
            </span>
            {renderTrailing ? (
              <span className="workspace-explorer-tree__trailing">{renderTrailing(item)}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
