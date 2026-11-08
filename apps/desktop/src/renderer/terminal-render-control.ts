import type { Terminal } from "ghostty-web";

// ghostty-web 0.4.0 has no invalidation API (coder/ghostty-web#208).
// Keep its private hooks here and fail explicitly when upgrading the library.
type RenderLoopTerminal = {
  animationFrameId: number | undefined;
  startRenderLoop(): void;
  writeInternal(data: string | Uint8Array, callback?: () => void): void;
  scrollbarOpacity: number;
  lastCursorY: number;
  cursorMoveEmitter: { fire(): void };
  selectionManager: { requestRender(): void };
};
type BlinkRenderer = Pick<
  NonNullable<Terminal["renderer"]>,
  "render" | "setCursorBlink" | "setHoveredHyperlinkId" | "setHoveredLinkRange"
> & {
  startCursorBlink(): void;
  cursorVisible: boolean;
  cursorBlinkInterval: number | undefined;
  hoveredHyperlinkId: number;
  hoveredLinkRange: Parameters<NonNullable<Terminal["renderer"]>["setHoveredLinkRange"]>[0];
};

export interface TerminalRenderControl {
  setActive(active: boolean): void;
  dispose(): void;
}

export function installTerminalRenderControl(terminal: Terminal, active: boolean): TerminalRenderControl {
  const loop = terminal as unknown as RenderLoopTerminal;
  const renderer = terminal.renderer as unknown as BlinkRenderer | undefined;
  const element = terminal.element;
  if (
    !renderer ||
    !terminal.wasmTerm ||
    !element ||
    typeof loop.startRenderLoop !== "function" ||
    typeof loop.animationFrameId !== "number" ||
    typeof loop.scrollbarOpacity !== "number" ||
    typeof loop.writeInternal !== "function" ||
    typeof loop.cursorMoveEmitter?.fire !== "function" ||
    typeof loop.selectionManager?.requestRender !== "function" ||
    typeof renderer.startCursorBlink !== "function"
  ) {
    throw new Error("Unsupported ghostty-web render loop; update terminal-render-control before upgrading");
  }
  const original = {
    render: renderer.render,
    blink: renderer.setCursorBlink,
    startBlink: renderer.startCursorBlink,
    write: loop.writeInternal,
    clear: terminal.clear,
    reset: terminal.reset,
    selection: loop.selectionManager.requestRender,
    hyperlink: renderer.setHoveredHyperlinkId,
    linkRange: renderer.setHoveredLinkRange,
  };
  let enabled = active;
  let disposed = false;
  let frame: number | undefined;
  let force = true;
  const canDraw = () => !disposed && enabled && document.visibilityState === "visible";
  const focused = () => document.hasFocus() && element.contains(document.activeElement);
  const request = (full = false) => {
    force ||= full;
    if (!canDraw() || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!canDraw() || !terminal.wasmTerm) return;
      const fullRedraw = force;
      force = false;
      original.render.call(
        renderer,
        terminal.wasmTerm,
        fullRedraw,
        terminal.viewportY,
        terminal,
        loop.scrollbarOpacity,
      );
      const cursor = terminal.wasmTerm.getCursor();
      if (cursor.y !== loop.lastCursorY) {
        loop.lastCursorY = cursor.y;
        loop.cursorMoveEmitter.fire();
      }
    });
  };
  // Replace the perpetual rAF with one frame per invalidation. Read current
  // viewport/buffer at paint time so reset, scroll and batched writes coalesce.
  cancelAnimationFrame(loop.animationFrameId);
  loop.animationFrameId = undefined;
  original.blink.call(renderer, false);
  renderer.render = (_buffer, full) => request(full);
  renderer.startCursorBlink = () => {
    renderer.cursorBlinkInterval = window.setInterval(() => {
      renderer.cursorVisible = !renderer.cursorVisible;
      request();
    }, 530);
  };
  renderer.setCursorBlink = (value) => {
    original.blink.call(renderer, value && canDraw() && focused());
    request();
  };
  loop.writeInternal = function (...args) {
    original.write.apply(this, args);
    request();
  };
  terminal.clear = function () {
    original.clear.call(this);
    request(true);
  };
  terminal.reset = function () {
    original.reset.call(this);
    request(true);
  };
  // SelectionManager.requestRender is an empty hook upstream, including during
  // drag/auto-scroll and selection clearing; the public change event misses it.
  loop.selectionManager.requestRender = () => request();
  renderer.setHoveredHyperlinkId = function (id) {
    const changed = this.hoveredHyperlinkId !== id;
    original.hyperlink.call(this, id);
    if (changed) request();
  };
  renderer.setHoveredLinkRange = function (range) {
    const previous = this.hoveredLinkRange;
    const changed =
      previous?.startX !== range?.startX ||
      previous?.startY !== range?.startY ||
      previous?.endX !== range?.endX ||
      previous?.endY !== range?.endY;
    original.linkRange.call(this, range);
    if (changed) request();
  };
  const scroll = terminal.onScroll(() => request());
  const update = () => {
    renderer.setCursorBlink(Boolean(terminal.options.cursorBlink));
    if (!canDraw()) {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      force = true;
    } else request(true);
  };
  document.addEventListener("visibilitychange", update);
  element.addEventListener("focusin", update);
  element.addEventListener("focusout", update);
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  update();
  return {
    setActive(value) {
      if (enabled === value || disposed) return;
      enabled = value;
      update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      update();
      scroll.dispose();
      document.removeEventListener("visibilitychange", update);
      element.removeEventListener("focusin", update);
      element.removeEventListener("focusout", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      renderer.render = original.render;
      renderer.setCursorBlink = original.blink;
      renderer.startCursorBlink = original.startBlink;
      renderer.setHoveredHyperlinkId = original.hyperlink;
      renderer.setHoveredLinkRange = original.linkRange;
      loop.writeInternal = original.write;
      terminal.clear = original.clear;
      terminal.reset = original.reset;
      loop.selectionManager.requestRender = original.selection;
    },
  };
}
