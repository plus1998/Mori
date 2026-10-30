import { ClipboardPaste, Copy, TextSelect } from "lucide-react";
import { type CSSProperties, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ICON_SIZE, ICON_STROKE } from "./icon-metrics";
import { type TerminalContextMenuBox, terminalContextMenuBoxForPoint } from "./terminal-context-menu-layout";

/** Screen position (viewport coordinates) the menu opens at, plus the selection it acts on. */
export interface TerminalContextMenuAnchor {
  x: number;
  y: number;
  hasSelection: boolean;
}

export interface TerminalContextMenuPanelProps {
  hasSelection: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}

interface TerminalContextMenuProps extends TerminalContextMenuPanelProps {
  anchor: TerminalContextMenuAnchor;
  onClose: () => void;
}

/**
 * ghostty-web clears the terminal selection on any click that lands outside its canvas, and
 * that handler sits on `document`. Menu clicks therefore must not bubble past the React
 * root: the actions read or replace the selection, which would otherwise be wiped first.
 */
function runMenuAction(event: MouseEvent<HTMLButtonElement>, action: () => void): void {
  event.stopPropagation();
  action();
}

export function TerminalContextMenuPanel({
  hasSelection,
  onCopy,
  onPaste,
  onSelectAll,
}: TerminalContextMenuPanelProps) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        className="terminal-context-menu-item"
        role="menuitem"
        disabled={!hasSelection}
        onClick={(event) => {
          runMenuAction(event, onCopy);
        }}
      >
        <Copy size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{t("terminal.menu.copy")}</span>
      </button>
      <button
        type="button"
        className="terminal-context-menu-item"
        role="menuitem"
        onClick={(event) => {
          runMenuAction(event, onPaste);
        }}
      >
        <ClipboardPaste size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{t("terminal.menu.paste")}</span>
      </button>
      <button
        type="button"
        className="terminal-context-menu-item"
        role="menuitem"
        onClick={(event) => {
          runMenuAction(event, onSelectAll);
        }}
      >
        <TextSelect size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{t("terminal.menu.selectAll")}</span>
      </button>
    </>
  );
}

export function TerminalContextMenu({
  anchor,
  hasSelection,
  onCopy,
  onPaste,
  onSelectAll,
  onClose,
}: TerminalContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<TerminalContextMenuBox | undefined>(undefined);

  // Measure after mount (before paint) so edge clamping uses the real menu height.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    setBox(
      terminalContextMenuBoxForPoint(
        { x: anchor.x, y: anchor.y },
        { height: menu.getBoundingClientRect().height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onWheel = () => {
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Keyboard users land inside the menu instead of typing into the shell behind it.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  if (typeof document === "undefined") {
    return null;
  }

  const style: CSSProperties = box
    ? {
        position: box.position,
        top: `${box.top}px`,
        left: `${box.left}px`,
        width: `${box.width}px`,
        zIndex: box.zIndex,
      }
    : { position: "fixed", top: `${anchor.y}px`, left: `${anchor.x}px`, visibility: "hidden" };

  return createPortal(
    <div
      ref={menuRef}
      className="terminal-context-menu"
      role="menu"
      aria-label={t("terminal.menu.label")}
      style={style}
      data-component="terminal-context-menu"
    >
      <TerminalContextMenuPanel
        hasSelection={hasSelection}
        onCopy={onCopy}
        onPaste={onPaste}
        onSelectAll={onSelectAll}
      />
    </div>,
    document.body,
  );
}
