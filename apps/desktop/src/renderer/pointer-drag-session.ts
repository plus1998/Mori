/** End captured drags even when the renderer never sees the release. */
export function startPointerDragSession({
  handle,
  pointerId,
  capture = true,
  onMove,
  onEnd,
}: {
  handle: HTMLElement;
  pointerId: number;
  capture?: boolean;
  onMove: (event: PointerEvent) => void;
  onEnd: (release?: PointerEvent) => void;
}): () => void {
  const doc = handle.ownerDocument;
  const view = doc.defaultView;
  if (!view) throw new Error("Pointer drag requires a window.");
  const win = view;
  let active = true;

  function finish(release?: PointerEvent) {
    if (!active) return;
    active = false;
    win.removeEventListener("pointerdown", cancelPointer, true);
    win.removeEventListener("pointermove", move, true);
    win.removeEventListener("pointerup", releasePointer, true);
    win.removeEventListener("pointercancel", cancelPointer, true);
    win.removeEventListener("blur", stop);
    win.removeEventListener("keydown", keyDown, true);
    doc.removeEventListener("visibilitychange", visibilityChange);
    handle.removeEventListener("lostpointercapture", lostCapture);
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    onEnd(release);
  }

  function stop() {
    finish();
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    if ((event.buttons & 1) === 0) {
      stop();
      return;
    }
    onMove(event);
  }

  function releasePointer(event: PointerEvent) {
    if (event.pointerId === pointerId) finish(event);
  }

  function cancelPointer(event: PointerEvent) {
    if (event.pointerId === pointerId) stop();
  }

  function lostCapture(event: PointerEvent) {
    // Transferring implicit touch capture from a child to the handle emits
    // lostpointercapture on the child while the gesture is still active.
    if (event.target === handle) cancelPointer(event);
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

  win.addEventListener("pointerdown", cancelPointer, true);
  win.addEventListener("pointermove", move, true);
  win.addEventListener("pointerup", releasePointer, true);
  win.addEventListener("pointercancel", cancelPointer, true);
  win.addEventListener("blur", stop);
  win.addEventListener("keydown", keyDown, true);
  doc.addEventListener("visibilitychange", visibilityChange);
  handle.addEventListener("lostpointercapture", lostCapture);
  try {
    if (capture) handle.setPointerCapture(pointerId);
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
