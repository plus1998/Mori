import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { composerFloatingStyleForAnchor } from "./composer-floating";

/** A shared surface for the composer menu and its configuration / scheduling views. */
export function ComposerAbovePanel({
  anchorRef,
  triggerRef,
  className = "",
  label,
  role = "dialog",
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLElement | null> | undefined;
  className?: string;
  label: string;
  role?: "dialog" | "menu";
  onClose(): void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const update = () =>
      setStyle(
        composerFloatingStyleForAnchor(anchor, {
          width: anchor.getBoundingClientRect().width,
          align: "start",
          prefer: "above",
          minHeight: 80,
          gap: 10,
        }),
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);
  useEffect(() => {
    const panel = panelRef.current;
    const frame = requestAnimationFrame(() => {
      const preferred = panel?.querySelector<HTMLElement>("[data-panel-autofocus]");
      if (preferred) preferred.focus();
      else if (!panel?.contains(document.activeElement))
        panel?.querySelector<HTMLElement>("button:not(:disabled), textarea, input, select")?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (panel?.contains(document.activeElement)) triggerRef?.current?.focus();
    };
  }, [triggerRef]);
  useEffect(() => {
    const isNestedMenu = (target: EventTarget | null) =>
      target instanceof Element && target.closest(".composer-field-select-menu, .model-cascade-panel");
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef?.current?.contains(target) || isNestedMenu(target))
        return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !isNestedMenu(event.target)) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [onClose, triggerRef]);
  return createPortal(
    <div
      ref={panelRef}
      className={`composer-codex-popover composer-above-panel ${className}`}
      role={role}
      aria-label={label}
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}
