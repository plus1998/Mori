import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { isBrowserTaskTabId } from "../shared/browser";
import { startPointerDragSession } from "./pointer-drag-session";
import { isNewTaskPanelTabId } from "./task-panel-tabs";

type Reorder = (source: string, target: string, position: "before" | "after") => void;
type Drag = {
  id: string;
  node: HTMLElement;
  stop: () => void;
};
const TAB = "[data-task-panel-tab-id]";
const canDrag = (id: string) => isBrowserTaskTabId(id) || isNewTaskPanelTabId(id);

function outsideViewport(point: PointerEvent, view: Window) {
  return point.clientX < 0 || point.clientY < 0 ||
    point.clientX >= view.innerWidth || point.clientY >= view.innerHeight;
}

/** Keep pointer motion outside React and commit once, after releasing the gesture. */
export function useTaskPanelTabDrag(
  ids: readonly string[],
  enabled: boolean,
  onReorder: Reorder | undefined,
  onDetach: ((id: string) => void) | undefined,
) {
  const drag = useRef<Drag | undefined>(undefined);
  const callbacks = useRef({ onReorder, onDetach });
  callbacks.current = { onReorder, onDetach };
  const suppressClickUntil = useRef(0);

  useEffect(() => {
    const current = drag.current;
    if (current && (!enabled || !ids.includes(current.id) || !current.node.isConnected)) current.stop();
  }, [enabled, ids]);
  useEffect(() => () => drag.current?.stop(), []);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!enabled || (!onReorder && !onDetach) || event.button !== 0 ||
      !event.isPrimary || !(event.target instanceof Element)) return;
    if (event.target.closest(".subagent-task-panel-tab-close")) return;
    const tab = event.target.closest<HTMLElement>(TAB);
    const id = tab?.dataset.taskPanelTabId;
    const list = event.currentTarget;
    const window = list.ownerDocument.defaultView;
    if (!tab || !id || !window || !canDrag(id)) return;
    const node = tab;
    const view = window;
    drag.current?.stop();
    suppressClickUntil.current = 0;
    const startX = event.clientX;
    const startY = event.clientY;
    const initialBounds = node.getBoundingClientRect();
    const startScroll = list.scrollLeft;
    const pointerId = event.pointerId;
    let x = startX;
    let y = startY;
    let active = false;
    let frame: number | undefined;
    let target: HTMLElement | undefined;
    let position: "before" | "after" | undefined;
    let exitedWindow = false;

    function clearTarget() {
      target?.classList.remove("is-tab-drop-before", "is-tab-drop-after");
      target = undefined;
      position = undefined;
    }

    function paint(autoscroll: boolean) {
      const bounds = list.getBoundingClientRect();
      const within = y >= bounds.top - 20 && y <= bounds.bottom + 20 &&
        x >= bounds.left - 20 && x <= bounds.right + 20;
      // A transformed child contributes to scrollWidth. Clear its transform
      // before measuring the real range, then keep the preview inside that range.
      node.style.removeProperty("transform");
      const scroll = list.scrollLeft;
      if (within && autoscroll) {
        const edge = Math.min(32, bounds.width / 2);
        const delta = x < bounds.left + edge ? -Math.min(12, (bounds.left + edge - x) / 3) :
          x > bounds.right - edge ? Math.min(12, (x - bounds.right + edge) / 3) : 0;
        list.scrollLeft += delta;
      }
      const left = initialBounds.left - (list.scrollLeft - startScroll);
      const min = Math.min(0, bounds.left - left);
      const max = Math.max(0, bounds.right - initialBounds.width - left);
      const offset = Math.min(max, Math.max(min, x - startX + list.scrollLeft - startScroll));
      node.style.transform = `translateX(${offset}px)`;
      clearTarget();
      if (within) {
        const tabs = [...list.querySelectorAll<HTMLElement>(TAB)].filter(tab => tab !== node);
        target = tabs.find(tab => {
          const rect = tab.getBoundingClientRect();
          return x < rect.left + rect.width / 2;
        });
        position = target ? "before" : "after";
        target ??= tabs.at(-1);
        target?.classList.add(`is-tab-drop-${position}`);
      }
      if (autoscroll && list.scrollLeft !== scroll) schedulePaint();
    }

    function schedulePaint() {
      if (frame !== undefined) return;
      frame = view.requestAnimationFrame(() => {
        frame = undefined;
        paint(true);
      });
    }

    const stop = startPointerDragSession({
      handle: list,
      pointerId,
      capture: false,
      onMove(point) {
        x = point.clientX;
        y = point.clientY;
        if (!active && Math.hypot(x - startX, y - startY) < 5) return;
        if (!active) {
          if (!list.isConnected || !node.isConnected) {
            stop();
            return;
          }
          try {
            list.setPointerCapture(pointerId);
          } catch (error) {
            stop();
            throw error;
          }
          active = true;
          node.classList.add("is-tab-dragging");
          list.ownerDocument.body.classList.add("is-dragging-browser-tab");
        }
        point.preventDefault();
        if (outsideViewport(point, view)) {
          // An OS may withhold pointerup once the cursor is outside this window.
          // End the gesture as soon as it crosses the edge.
          exitedWindow = true;
          stop();
          return;
        }
        schedulePaint();
      },
      onEnd(release) {
        drag.current = undefined;
        if (frame !== undefined) view.cancelAnimationFrame(frame);
        if (!active) return;
        if (release && !outsideViewport(release, view)) {
          x = release.clientX;
          y = release.clientY;
          paint(false);
        } else if (release) exitedWindow = true;
        const targetId = target?.dataset.taskPanelTabId;
        const placement = position;
        clearTarget();
        node.style.removeProperty("transform");
        node.classList.remove("is-tab-dragging");
        list.ownerDocument.body.classList.remove("is-dragging-browser-tab");
        suppressClickUntil.current = Date.now() + 250;
        if (exitedWindow) {
          if (isBrowserTaskTabId(id)) callbacks.current.onDetach?.(id);
        } else if (release && targetId && placement) {
          callbacks.current.onReorder?.(id, targetId, placement);
        }
      },
    });
    drag.current = { id, node, stop };
  }

  return {
    onPointerDown,
    onDragStart(event: React.DragEvent<HTMLDivElement>) {
      if (event.target instanceof Element) {
        const id = event.target.closest<HTMLElement>(TAB)?.dataset.taskPanelTabId;
        if (id && canDrag(id)) event.preventDefault();
      }
    },
    onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
      if (Date.now() < suppressClickUntil.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
      if (!enabled || !onReorder || !event.altKey ||
        !["ArrowLeft", "ArrowRight"].includes(event.key) || !(event.target instanceof Element)) return;
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
