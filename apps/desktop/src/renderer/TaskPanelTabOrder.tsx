import { Children, isValidElement, type ReactNode, useCallback, useEffect, useState } from "react";
import { TaskPanelTabContextMenu, type TaskPanelTabMenuAnchor } from "./TaskPanelTabContextMenu";
import { useTaskPanelTabDrag } from "./use-task-panel-tab-drag";
import "./task-panel-tab-drag.css";

/** Keep a replacement in its source slot, including DOM and keyboard order. */
export function TaskPanelTabOrder({
  openTabIds,
  children,
  label,
  onReorder,
  onCloseTabs,
}: {
  openTabIds: readonly string[];
  children: ReactNode;
  label: string;
  onCloseTabs?: ((ids: readonly string[]) => void) | undefined;
  onReorder?: ((source: string, target: string, position: "before" | "after") => void) | undefined;
}) {
  const dragHandlers = useTaskPanelTabDrag(openTabIds, onReorder);
  const [menu, setMenu] = useState<TaskPanelTabMenuAnchor>();
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const orderedChildren = Children.toArray(children);
  const renderedTabIds = new Set(
    orderedChildren.flatMap((child) => {
      const id = isValidElement<{ "data-task-panel-tab-id"?: string }>(child)
        ? child.props["data-task-panel-tab-id"]
        : undefined;
      return id ? [id] : [];
    }),
  );
  const visibleTabIds = openTabIds.filter((id) => renderedTabIds.has(id));
  useEffect(() => {
    if (menu && !visibleTabIds.includes(menu.tabId)) closeMenu();
  }, [menu, visibleTabIds, closeMenu]);
  const positions = new Map(openTabIds.map((id, index) => [id, index]));
  const position = (child: ReactNode) => {
    const tabId = isValidElement<{ "data-task-panel-tab-id"?: string }>(child)
      ? child.props["data-task-panel-tab-id"]
      : undefined;
    return tabId ? (positions.get(tabId) ?? openTabIds.length) : openTabIds.length;
  };
  return (
    <>
      <div
        className="subagent-task-panel-tabs"
        role="tablist"
        aria-label={label}
        {...dragHandlers}
        onContextMenu={(event) => {
          if (!onCloseTabs || !(event.target instanceof Element)) return;
          const shell = event.target.closest<HTMLElement>("[data-task-panel-tab-id]");
          const tabId = shell?.dataset.taskPanelTabId;
          if (!tabId || !visibleTabIds.includes(tabId)) return;
          event.preventDefault();
          setMenu({
            tabId,
            x: event.clientX,
            y: event.clientY,
            trigger: shell.querySelector<HTMLElement>('[role="tab"]') ?? shell,
          });
        }}
        onKeyDown={(event) => {
          if (
            !onCloseTabs ||
            !(event.target instanceof Element) ||
            !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          )
            return;
          const shell = event.target.closest<HTMLElement>("[data-task-panel-tab-id]");
          const tabId = shell?.dataset.taskPanelTabId;
          if (!tabId || !visibleTabIds.includes(tabId)) return;
          event.preventDefault();
          const rect = shell.getBoundingClientRect();
          setMenu({
            tabId,
            x: rect.left,
            y: rect.bottom,
            trigger: shell.querySelector<HTMLElement>('[role="tab"]') ?? shell,
          });
        }}
      >
        {orderedChildren.sort((left, right) => position(left) - position(right))}
      </div>
      {menu && visibleTabIds.includes(menu.tabId) && onCloseTabs && (
        <TaskPanelTabContextMenu
          key={`${menu.tabId}:${menu.x}:${menu.y}`}
          anchor={menu}
          tabIds={openTabIds}
          onClose={closeMenu}
          onCloseTabs={onCloseTabs}
        />
      )}
    </>
  );
}
