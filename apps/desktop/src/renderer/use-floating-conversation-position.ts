import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";

export interface FloatingConversationPosition {
  centerX: number;
  bottom: number;
}

/** Keep the whole active surface below the panel toolbar and inside the pane. */
export function clampFloatingConversationPosition(
  position: FloatingConversationPosition,
  pane: { width: number; height: number },
  surface: { width: number; height: number },
): FloatingConversationPosition {
  const halfWidth = surface.width / 2;
  const minX = Math.min(halfWidth + 16, pane.width / 2);
  return {
    centerX: Math.max(minX, Math.min(position.centerX, pane.width - minX)),
    bottom: Math.max(16, Math.min(position.bottom, pane.height - surface.height - 56)),
  };
}

export function useFloatingConversationPosition({
  paneRef,
  conversationRef,
  ballRef,
  enabled,
  minimized,
}: {
  paneRef: RefObject<HTMLDivElement | null>;
  conversationRef: RefObject<HTMLDivElement | null>;
  ballRef: RefObject<HTMLButtonElement | null>;
  enabled: boolean;
  minimized: boolean;
}) {
  // Pointer moves update two CSS variables, without rerendering the conversation.
  const positionsRef = useRef<{ ball?: FloatingConversationPosition; conversation?: FloatingConversationPosition }>({});
  const stopDragRef = useRef<(() => void) | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const positionKey = minimized ? "ball" : "conversation";
  const variablePrefix = minimized ? "--floating-ball" : "--floating-conversation";

  const geometry = () => {
    const pane = paneRef.current;
    const surface = minimized ? ballRef.current : conversationRef.current;
    if (!pane || !surface) return;
    return { pane, paneRect: pane.getBoundingClientRect(), surfaceRect: surface.getBoundingClientRect() };
  };

  const place = (position: FloatingConversationPosition) => {
    const bounds = geometry();
    if (!bounds) return;
    const next = clampFloatingConversationPosition(position, bounds.paneRect, bounds.surfaceRect);
    positionsRef.current[positionKey] = next;
    bounds.pane.style.setProperty(`${variablePrefix}-x`, `${next.centerX}px`);
    bounds.pane.style.setProperty(`${variablePrefix}-bottom`, `${next.bottom}px`);
  };

  useLayoutEffect(() => {
    if (!enabled) return;
    const pane = paneRef.current;
    const surface = minimized ? ballRef.current : conversationRef.current;
    if (!pane || !surface) return;
    const sync = () => {
      const position = positionsRef.current[positionKey];
      if (position) place(position);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(pane);
    observer.observe(surface);
    return () => {
      observer.disconnect();
      stopDragRef.current?.();
    };
  }, [enabled, minimized, paneRef, conversationRef, ballRef]);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || !event.isPrimary) return;
    const bounds = geometry();
    if (!bounds) return;
    stopDragRef.current?.();
    suppressClickRef.current = false;
    const { pane, paneRect, surfaceRect } = bounds;
    const handle = event.currentTarget;
    const { pointerId, clientX, clientY } = event;
    const start = {
      centerX: surfaceRect.left + surfaceRect.width / 2 - paneRect.left,
      bottom: paneRect.bottom - surfaceRect.bottom,
    };
    let active = true;
    const stop = () => {
      if (!active) return;
      active = false;
      pane.removeAttribute("data-floating-conversation-dragging");
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", stop);
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("visibilitychange", visibility);
      handle.removeEventListener("lostpointercapture", end);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      stopDragRef.current = undefined;
    };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if ((next.buttons & 1) === 0) return stop();
      const dx = next.clientX - clientX;
      const dy = next.clientY - clientY;
      if (!suppressClickRef.current && Math.hypot(dx, dy) < 4) return;
      suppressClickRef.current = true;
      pane.setAttribute("data-floating-conversation-dragging", "");
      place({ centerX: start.centerX + dx, bottom: start.bottom - dy });
    };
    const end = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId) stop();
    };
    const key = (next: globalThis.KeyboardEvent) => {
      if (next.key !== "Escape") return;
      next.preventDefault();
      next.stopPropagation();
      stop();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") stop();
    };
    stopDragRef.current = stop;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", key, true);
    document.addEventListener("visibilitychange", visibility);
    handle.addEventListener("lostpointercapture", end);
    try {
      handle.setPointerCapture(pointerId);
    } catch (error) {
      stop();
      throw error;
    }
    event.preventDefault();
  };

  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current || event.detail === 0) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!enabled) return;
    if (event.key === "Home") {
      event.preventDefault();
      delete positionsRef.current[positionKey];
      paneRef.current?.style.removeProperty(`${variablePrefix}-x`);
      paneRef.current?.style.removeProperty(`${variablePrefix}-bottom`);
      return;
    }
    const bounds = geometry();
    if (!bounds || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    place({
      centerX: bounds.surfaceRect.left + bounds.surfaceRect.width / 2 - bounds.paneRect.left
        + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
      bottom: bounds.paneRect.bottom - bounds.surfaceRect.bottom
        + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0),
    });
  };

  return { onPointerDown, onClickCapture, onKeyDown };
}
