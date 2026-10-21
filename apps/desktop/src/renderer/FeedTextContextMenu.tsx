import { Copy } from "lucide-react";
import { type CSSProperties, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { copyTextToClipboard } from "./clipboard";
import { type ContextMenuBox, contextMenuBoxForPoint } from "./context-menu-layout";
import { ICON_SIZE, ICON_STROKE } from "./icon-metrics";

/** Viewport position plus the text captured before the menu takes focus from the selection. */
export interface FeedTextContextMenuAnchor {
  x: number;
  y: number;
  selectedText: string;
}

export interface FeedTextContextMenuPanelProps {
  onCopy: () => void;
}

interface FeedTextContextMenuProps {
  anchor: FeedTextContextMenuAnchor;
  onClose: () => void;
}

function runMenuAction(event: MouseEvent<HTMLButtonElement>, action: () => void): void {
  event.stopPropagation();
  action();
}

export function FeedTextContextMenuPanel({ onCopy }: FeedTextContextMenuPanelProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="feed-text-context-menu-item"
      role="menuitem"
      onClick={(event) => {
        runMenuAction(event, onCopy);
      }}
    >
      <Copy size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
      <span>{t("common.copy")}</span>
    </button>
  );
}

/**
 * Right-click menu for a text selection in the Feed. The selected text is captured at opening
 * time because focusing the menu button can move the DOM selection away from the Feed.
 */
export function FeedTextContextMenu({ anchor, onClose }: FeedTextContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<ContextMenuBox>();

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

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
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
      className="feed-text-context-menu"
      role="menu"
      aria-label={t("activity.selectionMenuLabel")}
      style={style}
      data-component="feed-text-context-menu"
    >
      <FeedTextContextMenuPanel
        onCopy={() => {
          void copyTextToClipboard(anchor.selectedText).finally(onClose);
        }}
      />
    </div>,
    document.body,
  );
}
