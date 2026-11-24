import { startPointerDragSession } from "./pointer-drag-session";

/** Own the window-wide resize shield for exactly one pointer gesture. */
export function startTaskPanelResizeSession({
  handle,
  pointerId,
  onMove,
}: {
  handle: HTMLElement;
  pointerId: number;
  onMove: (clientX: number) => void;
}): () => void {
  const body = handle.ownerDocument.body;
  const stop = startPointerDragSession({
    handle,
    pointerId,
    onMove: event => onMove(event.clientX),
    onEnd: () => body.classList.remove("is-resizing-task-panel"),
  });
  body.classList.add("is-resizing-task-panel");
  return stop;
}
