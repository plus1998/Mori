import { Copy } from "lucide-react";
import { type CSSProperties, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { type ContextMenuBox, type ContextMenuPoint, contextMenuBoxForPoint } from "./context-menu-layout";
import { ICON_SIZE, ICON_STROKE } from "./icon-metrics";

/** Viewport coordinates the image menu opens at. */
export type ImageContextMenuAnchor = ContextMenuPoint;

export interface ImageContextMenuPanelProps {
  onCopyImage: () => void;
}

interface ImageContextMenuProps extends ImageContextMenuPanelProps {
  anchor: ImageContextMenuAnchor;
  onClose: () => void;
}

/**
 * Menu actions must not bubble: the lightbox closes on a backdrop mousedown, and a click
 * inside a portaled menu still travels up the React tree to that handler.
 */
function runMenuAction(event: MouseEvent<HTMLButtonElement>, action: () => void): void {
  event.stopPropagation();
  action();
}

export function ImageContextMenuPanel({ onCopyImage }: ImageContextMenuPanelProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="image-context-menu-item"
      role="menuitem"
      onClick={(event) => {
        runMenuAction(event, onCopyImage);
      }}
    >
      <Copy size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
      <span>{t("lightbox.copyImage")}</span>
    </button>
  );
}

/**
 * Right-click menu over the image viewer stage. Portaled to `<body>` (the lightbox clips
 * its own overflow), positioned by the shared context-menu layout so it never runs off the
 * screen, and dismissed by an outside press, Escape, wheel, or window blur.
 */
export function ImageContextMenu({ anchor, onCopyImage, onClose }: ImageContextMenuProps) {
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
      className="image-context-menu"
      role="menu"
      aria-label={t("lightbox.imageMenu")}
      style={style}
      data-component="image-context-menu"
    >
      <ImageContextMenuPanel onCopyImage={onCopyImage} />
    </div>,
    document.body,
  );
}
