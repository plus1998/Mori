import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from "react";
import { isBrowserTaskTabId } from "../shared/browser";
import { isNewTaskPanelTabId } from "./task-panel-tabs";

type Reorder = (source: string, target: string, position: "before" | "after") => void;
type Drag = {
  list: HTMLDivElement;
  node: HTMLElement;
  id: string;
  pointerId: number;
  startX: number;
  startScroll: number;
  x: number;
  y: number;
  active: boolean;
  frame?: number;
  target?: HTMLElement | undefined;
  position?: "before" | "after" | undefined;
};
const TAB = "[data-task-panel-tab-id]";
const canDrag = (id: string) => isBrowserTaskTabId(id) || isNewTaskPanelTabId(id);

/** Keep frame-by-frame pointer motion outside React; commit the order once on release. */
export function useTaskPanelTabDrag(ids: readonly string[], onReorder: Reorder | undefined) {
  const drag = useRef<Drag | undefined>(undefined);
  const callback = useRef(onReorder);
  callback.current = onReorder;
  const suppressClickUntil = useRef(0);

  const finish = useCallback((commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = undefined;
    if (current.frame !== undefined) cancelAnimationFrame(current.frame);
    current.node.style.removeProperty("transform");
    current.node.classList.remove("is-tab-dragging");
    current.target?.classList.remove("is-tab-drop-before", "is-tab-drop-after");
    document.body.classList.remove("is-dragging-browser-tab");
    if (current.list.hasPointerCapture(current.pointerId))
      current.list.releasePointerCapture(current.pointerId);
    if (!current.active) return;
    suppressClickUntil.current = Date.now() + 250;
    const targetId = current.target?.dataset.taskPanelTabId;
    if (commit && targetId && current.position) callback.current?.(current.id, targetId, current.position);
  }, []);

  useEffect(() => {
    const current = drag.current;
    if (current && !ids.includes(current.id)) finish(false);
  }, [ids, finish]);
  useEffect(() => () => finish(false), [finish]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current?.active) {
        event.preventDefault();
        finish(false);
      }
    };
    const blur = () => finish(false);
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", blur);
    };
  }, [finish]);

  function paint() {
    const current = drag.current;
    if (!current?.active) return;
    const bounds = current.list.getBoundingClientRect();
    const within = current.y >= bounds.top - 20 && current.y <= bounds.bottom + 20;
    if (within) {
      const edge = 32;
      const scroll =
        current.x < bounds.left + edge
          ? -Math.min(12, (bounds.left + edge - current.x) / 3)
          : current.x > bounds.right - edge
            ? Math.min(12, (current.x - bounds.right + edge) / 3)
            : 0;
      current.list.scrollLeft += scroll;
    }
    current.node.style.transform = `translateX(${current.x - current.startX + current.list.scrollLeft - current.startScroll}px)`;
    current.target?.classList.remove("is-tab-drop-before", "is-tab-drop-after");
    current.target = undefined;
    current.position = undefined;
    if (within && current.x >= bounds.left - 20 && current.x <= bounds.right + 20) {
      const tabs = [...current.list.querySelectorAll<HTMLElement>(TAB)].filter(
        (node) => node !== current.node,
      );
      const target = tabs.find((node) => {
        const rect = node.getBoundingClientRect();
        return current.x < rect.left + rect.width / 2;
      });
      current.target = target ?? tabs.at(-1);
      current.position = target ? "before" : "after";
      current.target?.classList.add(`is-tab-drop-${current.position}`);
    }
    current.frame = requestAnimationFrame(paint);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!onReorder || event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest(".subagent-task-panel-tab-close")) return;
    const node = event.target.closest<HTMLElement>(TAB);
    const id = node?.dataset.taskPanelTabId;
    if (!node || !id || !canDrag(id)) return;
    finish(false);
    drag.current = {
      list: event.currentTarget,
      node,
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startScroll: event.currentTarget.scrollLeft,
      x: event.clientX,
      y: event.clientY,
      active: false,
    };
  }

  return {
    onPointerDown,
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      current.x = event.clientX;
      current.y = event.clientY;
      if (!current.active && Math.abs(current.x - current.startX) >= 5) {
        current.active = true;
        current.list.setPointerCapture(event.pointerId);
        current.node.classList.add("is-tab-dragging");
        document.body.classList.add("is-dragging-browser-tab");
        paint();
      }
      if (current.active) event.preventDefault();
    },
    onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
      const current = drag.current;
      if (current?.pointerId !== event.pointerId) return;
      current.x = event.clientX;
      current.y = event.clientY;
      if (current.active) {
        if (current.frame !== undefined) cancelAnimationFrame(current.frame);
        paint();
      }
      finish(true);
    },
    onPointerCancel() {
      finish(false);
    },
    onLostPointerCapture() {
      finish(false);
    },
    onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
      if (Date.now() < suppressClickUntil.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
      if (
        !onReorder ||
        !event.altKey ||
        !["ArrowLeft", "ArrowRight"].includes(event.key) ||
        !(event.target instanceof Element)
      )
        return;
      if (event.target.closest(".subagent-task-panel-tab-close")) return;
      const id = event.target.closest<HTMLElement>(TAB)?.dataset.taskPanelTabId;
      if (!id || !canDrag(id)) return;
      const before = event.key === "ArrowLeft";
      const target = ids[ids.indexOf(id) + (before ? -1 : 1)];
      if (target) {
        event.preventDefault();
        onReorder(id, target, before ? "before" : "after");
      }
    },
  };
}
