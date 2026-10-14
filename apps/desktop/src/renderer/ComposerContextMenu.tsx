import { ClipboardPaste, Copy, Scissors, TextSelect } from "lucide-react";
import { type CSSProperties, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { type ContextMenuBox, contextMenuBoxForPoint } from "./context-menu-layout";
import { ICON_SIZE, ICON_STROKE } from "./icon-metrics";

/**
 * Where the right-click happened (viewport coordinates) plus the selection the menu acts on.
 *
 * The offsets are captured at right-click time, in the Composer's serialized value space, so an
 * action still knows what it replaces after the menu button takes focus away from the editor.
 */
export interface ComposerContextMenuAnchor {
  x: number;
  y: number;
  start: number;
  end: number;
  selectedText: string;
}

export interface ComposerContextMenuPanelProps {
  hasSelection: boolean;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}

interface ComposerContextMenuProps extends ComposerContextMenuPanelProps {
  anchor: ComposerContextMenuAnchor;
  onClose: () => void;
}

/** Menu clicks must not reach the document: the editor selection they act on lives behind them. */
function runMenuAction(event: MouseEvent<HTMLButtonElement>, action: () => void): void {
  event.stopPropagation();
  action();
}

export function ComposerContextMenuPanel({
  hasSelection,
  onCut,
  onCopy,
  onPaste,
  onSelectAll,
}: ComposerContextMenuPanelProps) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        className="composer-context-menu-item"
        role="menuitem"
        disabled={!hasSelection}
        onClick={(event) => {
          runMenuAction(event, onCut);
        }}
      >
        <Scissors size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{t("composer.menu.cut")}</span>
      </button>
      <button
        type="button"
        className="composer-context-menu-item"
        role="menuitem"
        disabled={!hasSelection}
        onClick={(event) => {
          runMenuAction(event, onCopy);
        }}
      >
        <Copy size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{t("composer.menu.copy")}</span>
      </button>
      <button
        type="button"
        className="composer-context-menu-item"
        role="menuitem"
        onClick={(event) => {
          runMenuAction(event, onPaste);
        }}
      >
        <ClipboardPaste size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{t("composer.menu.paste")}</span>
      </button>
      <button
        type="button"
        className="composer-context-menu-item"
        role="menuitem"
        onClick={(event) => {
          runMenuAction(event, onSelectAll);
        }}
      >
        <TextSelect size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{t("composer.menu.selectAll")}</span>
      </button>
    </>
  );
}

/**
 * Right-click menu for the Composer input. Electron shows no native menu of its own, so without
 * this the input has no pointer route to cut / copy / paste / select-all. Same surface and
 * viewport clamping as the terminal and image menus (`context-menu-layout.ts`).
 */
export function ComposerContextMenu({
  anchor,
  hasSelection,
  onCut,
  onCopy,
  onPaste,
  onSelectAll,
  onClose,
}: ComposerContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<ContextMenuBox | undefined>(undefined);

  // Measure after mount (before paint) so edge clamping uses the real menu height.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    setBox(
      contextMenuBoxForPoint(
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

  // Keyboard users land inside the menu instead of typing into the Composer behind it.
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
      className="composer-context-menu"
      role="menu"
      aria-label={t("composer.menu.label")}
      style={style}
      data-component="composer-context-menu"
    >
      <ComposerContextMenuPanel
        hasSelection={hasSelection}
        onCut={onCut}
        onCopy={onCopy}
        onPaste={onPaste}
        onSelectAll={onSelectAll}
      />
    </div>,
    document.body,
  );
}
