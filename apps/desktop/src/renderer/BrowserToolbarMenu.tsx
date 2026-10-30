import { Check } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ContextMenuBox, contextMenuBoxForPoint } from "./context-menu-layout";

export interface BrowserToolbarMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  active?: boolean;
  count?: number;
}

export function BrowserToolbarMenu({
  trigger,
  label,
  items,
  focusOnOpen,
  onClose,
}: {
  trigger: HTMLElement;
  label: string;
  items: readonly BrowserToolbarMenuItem[];
  focusOnOpen: boolean;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<ContextMenuBox>();

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = trigger.getBoundingClientRect();
    setBox(
      contextMenuBoxForPoint(
        { x: rect.right - 188, y: rect.bottom + 4 },
        { height: menu.getBoundingClientRect().height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    if (focusOnOpen) menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [trigger, focusOnOpen]);

  useEffect(() => {
    const dismiss = () => onClose();
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        (menuRef.current?.contains(event.target) || trigger.contains(event.target))
      )
        return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        trigger.focus();
        onClose();
      } else if (event.key === "Tab") {
        trigger.focus();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [trigger, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="browser-toolbar-menu composer-context-menu"
      role="menu"
      aria-label={label}
      style={box ?? { position: "fixed", visibility: "hidden" }}
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
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="composer-context-menu-item browser-toolbar-menu-item"
          disabled={item.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClose();
            if (focusOnOpen) trigger.focus();
            item.onSelect();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
          {item.count ? <span className="browser-toolbar-menu-count">{item.count}</span> : null}
          {item.active ? <Check size={14} aria-hidden /> : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
