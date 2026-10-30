import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { type ContextMenuBox, contextMenuBoxForPoint } from "./context-menu-layout";
import { type TaskPanelTabCloseAction, taskPanelTabsToClose } from "./task-panel-tab-state";

export interface TaskPanelTabMenuAnchor {
  tabId: string;
  x: number;
  y: number;
  trigger: HTMLElement;
}

const actions = [
  ["others", "task.closeOtherTabs"],
  ["right", "task.closeTabsToRight"],
  ["all", "task.closeAllTabs"],
] as const satisfies readonly (readonly [TaskPanelTabCloseAction, string])[];

export function TaskPanelTabContextMenu({
  anchor,
  tabIds,
  onClose,
  onCloseTabs,
}: {
  anchor: TaskPanelTabMenuAnchor;
  tabIds: readonly string[];
  onClose: () => void;
  onCloseTabs: (ids: readonly string[]) => void;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<ContextMenuBox>();

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    setBox(
      contextMenuBoxForPoint(
        anchor,
        { height: menu.getBoundingClientRect().height },
        {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      ),
    );
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor]);

  useEffect(() => {
    const dismiss = () => onClose();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") event.preventDefault();
        anchor.trigger.focus();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("wheel", dismiss, { capture: true, passive: true });
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="task-panel-tab-context-menu"
      role="menu"
      aria-label={t("task.tabMenuLabel")}
      style={box ?? { position: "fixed", visibility: "hidden" }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      {actions.map(([action, label]) => (
        <button
          key={action}
          type="button"
          role="menuitem"
          className="task-panel-tab-context-menu-item"
          disabled={taskPanelTabsToClose(tabIds, anchor.tabId, action).length === 0}
          onClick={() => {
            const closing = taskPanelTabsToClose(tabIds, anchor.tabId, action);
            onClose();
            anchor.trigger.focus();
            onCloseTabs(closing);
          }}
        >
          {t(label)}
        </button>
      ))}
    </div>,
    document.body,
  );
}
