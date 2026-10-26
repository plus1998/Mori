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
  const doc = handle.ownerDocument;
  const view = doc.defaultView;
  if (!view) throw new Error("Task panel resize requires a window.");
  const win = view;
  let active = true;

  function stop() {
    if (!active) return;
    active = false;
    doc.body.classList.remove("is-resizing-task-panel");
    win.removeEventListener("pointermove", move, true);
    win.removeEventListener("pointerup", end, true);
    win.removeEventListener("pointercancel", end, true);
    win.removeEventListener("blur", stop);
    win.removeEventListener("keydown", keyDown, true);
    doc.removeEventListener("visibilitychange", visibilityChange);
    handle.removeEventListener("lostpointercapture", end);
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    // A release outside the window may never deliver pointerup to this renderer.
    if ((event.buttons & 1) === 0) {
      stop();
      return;
    }
    onMove(event.clientX);
  }

  function end(event: PointerEvent) {
    if (event.pointerId === pointerId) stop();
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    stop();
  }

  function visibilityChange() {
    if (doc.visibilityState === "hidden") stop();
  }

  // Listen above the shield as well as on the captured handle. A lost capture
  // must not leave the shield swallowing every subsequent click in the app.
  win.addEventListener("pointermove", move, true);
  win.addEventListener("pointerup", end, true);
  win.addEventListener("pointercancel", end, true);
  win.addEventListener("blur", stop);
  win.addEventListener("keydown", keyDown, true);
  doc.addEventListener("visibilitychange", visibilityChange);
  handle.addEventListener("lostpointercapture", end);
  try {
    handle.setPointerCapture(pointerId);
    doc.body.classList.add("is-resizing-task-panel");
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
