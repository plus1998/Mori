import { afterEach, expect, test } from "bun:test";
import type { Terminal } from "ghostty-web";
import {
  installTerminalRenderControl,
  type TerminalRenderControl,
} from "../src/renderer/terminal-render-control";

const originals = ["document", "window", "requestAnimationFrame", "cancelAnimationFrame"].map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);
let control: TerminalRenderControl | undefined;
afterEach(() => {
  control?.dispose();
  control = undefined;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function setup(active = true) {
  const element = Object.assign(new EventTarget(), { contains: (value: unknown) => value === element });
  let focused = true;
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    activeElement: element,
    hasFocus: () => focused,
  });
  const frames = new Map<number, FrameRequestCallback>();
  const intervals = new Map<number, () => void>();
  let sequence = 0;
  const request = (cb: FrameRequestCallback) => {
    frames.set(++sequence, cb);
    return sequence;
  };
  const win = Object.assign(new EventTarget(), {
    setInterval: (cb: () => void) => {
      intervals.set(++sequence, cb);
      return sequence;
    },
  });
  for (const [name, value] of Object.entries({
    document: doc,
    window: win,
    requestAnimationFrame: request,
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }))
    Object.defineProperty(globalThis, name, { configurable: true, value });
  const draws: Array<{
    buffer: unknown;
    forced: boolean | undefined;
    viewport: number | undefined;
    opacity: number | undefined;
  }> = [];
  const scrolls = new Set<() => void>();
  const terminal = {
    element,
    wasmTerm: { text: "", getCursor: () => ({ y: 0 }) },
    viewportY: 0,
    scrollbarOpacity: 0,
    lastCursorY: 0,
    cursorMoveEmitter: { fire() {} },
    selectionManager: { requestRender() {} },
    animationFrameId: request(() => {}),
    options: { cursorBlink: true },
    renderer: {
      cursorVisible: true,
      hoveredHyperlinkId: 0,
      hoveredLinkRange: null as unknown,
      cursorBlinkInterval: undefined as number | undefined,
      cursorBlink: false,
      render(buffer: unknown, forced?: boolean, viewport?: number, _provider?: unknown, opacity?: number) {
        draws.push({ buffer, forced, viewport, opacity });
      },
      startCursorBlink() {},
      setCursorBlink(value: boolean) {
        if (value === this.cursorBlink) return;
        this.cursorBlink = value;
        if (value) this.startCursorBlink();
        else {
          if (this.cursorBlinkInterval !== undefined) intervals.delete(this.cursorBlinkInterval);
          this.cursorBlinkInterval = undefined;
          this.cursorVisible = true;
        }
      },
      setHoveredHyperlinkId(id: number) {
        this.hoveredHyperlinkId = id;
      },
      setHoveredLinkRange(range: unknown) {
        this.hoveredLinkRange = range;
      },
    },
    startRenderLoop() {
      throw new Error("perpetual render loop must never restart");
    },
    writeInternal(data: string) {
      this.wasmTerm.text += data;
    },
    clear() {
      this.wasmTerm.text = "";
    },
    reset() {
      this.wasmTerm = { text: "reset", getCursor: () => ({ y: 0 }) };
    },
    onScroll(callback: () => void) {
      scrolls.add(callback);
      return {
        dispose() {
          scrolls.delete(callback);
        },
      };
    },
  };
  const originalRender = terminal.renderer.render;
  const originalWrite = terminal.writeInternal;
  const renderControl = installTerminalRenderControl(terminal as unknown as Terminal, active);
  control = renderControl;
  const paint = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(0);
  };
  return {
    terminal,
    doc,
    draws,
    frames,
    intervals,
    scrolls,
    originalRender,
    originalWrite,
    paint,
    control: renderControl,
    focus(value: boolean) {
      focused = value;
      win.dispatchEvent(new Event(value ? "focus" : "blur"));
    },
    visibility(value: string) {
      doc.visibilityState = value;
      doc.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

test("visible terminal is idle between changes; output bursts coalesce into one paint", () => {
  const env = setup();
  env.paint();
  expect(env.draws.length).toBe(1);
  expect(env.frames.size).toBe(0);
  for (let i = 0; i < 50; i++) env.terminal.writeInternal(`${i},`);
  expect(env.frames.size).toBe(1);
  env.paint();
  expect(env.draws.length).toBe(2);
  expect(env.terminal.wasmTerm.text).toEndWith("49,");
  expect(env.frames.size).toBe(0);
});

test("inactive and hidden terminals keep output without painting or blinking; resume forces current viewport", () => {
  const env = setup(false);
  expect(env.frames.size).toBe(0);
  expect(env.intervals.size).toBe(0);
  env.terminal.writeInternal("background");
  env.terminal.renderer.render({}, true);
  env.paint();
  expect(env.draws.length).toBe(0);
  env.terminal.viewportY = 3;
  env.terminal.scrollbarOpacity = 0.5;
  env.control.setActive(true);
  env.paint();
  expect(env.draws[0]).toMatchObject({ forced: true, viewport: 3, opacity: 0.5 });
  expect(env.terminal.wasmTerm.text).toBe("background");
  env.visibility("hidden");
  env.terminal.writeInternal(" hidden");
  env.paint();
  expect(env.draws.length).toBe(1);
  expect(env.intervals.size).toBe(0);
  env.visibility("visible");
  env.control.setActive(true);
  env.paint();
  expect(env.draws.length).toBe(2);
  expect(env.frames.size).toBe(0);
});

test("cursor blink repaints only on its timer and pauses when the window loses focus", () => {
  const env = setup();
  env.paint();
  expect(env.intervals.size).toBe(1);
  const blink = env.intervals.values().next().value;
  if (!blink) throw new Error("cursor blink timer was not installed");
  blink();
  env.paint();
  expect(env.draws.length).toBe(2);
  expect(env.terminal.renderer.cursorVisible).toBe(false);
  env.focus(false);
  env.paint();
  expect(env.intervals.size).toBe(0);
  expect(env.frames.size).toBe(0);
  expect(env.terminal.renderer.cursorVisible).toBe(true);
  env.focus(true);
  env.paint();
  expect(env.intervals.size).toBe(1);
});

test("scroll, selection and link hover invalidate a single frame without reviving the loop", () => {
  const env = setup();
  env.paint();
  env.terminal.renderer.setHoveredHyperlinkId(0);
  env.terminal.renderer.setHoveredLinkRange(null);
  expect(env.frames.size).toBe(0);
  env.terminal.viewportY = 2;
  for (const cb of env.scrolls) cb();
  env.terminal.selectionManager.requestRender();
  env.terminal.renderer.setHoveredHyperlinkId(3);
  env.terminal.renderer.setHoveredLinkRange(null);
  env.paint();
  expect(env.draws.length).toBe(2);
  expect(env.draws[1]?.viewport).toBe(2);
  expect(env.frames.size).toBe(0);
});

test("reset paints the new WASM buffer and clear removes old content", () => {
  const env = setup();
  env.paint();
  const oldBuffer = env.terminal.wasmTerm;
  env.terminal.reset();
  env.paint();
  expect(env.draws.at(-1)?.buffer).toBe(env.terminal.wasmTerm);
  expect(env.draws.at(-1)?.buffer).not.toBe(oldBuffer);
  env.terminal.clear();
  env.paint();
  expect(env.terminal.wasmTerm.text).toBe("");
  expect(env.draws.at(-1)?.forced).toBe(true);
});

test("dispose restores hooks and cancels pending frames, subscriptions and cursor timers", () => {
  const env = setup();
  env.terminal.writeInternal("pending");
  env.control.dispose();
  expect(env.frames.size).toBe(0);
  expect(env.intervals.size).toBe(0);
  expect(env.scrolls.size).toBe(0);
  expect(env.terminal.renderer.render).toBe(env.originalRender);
  expect(env.terminal.writeInternal).toBe(env.originalWrite);
  env.visibility("hidden");
  env.visibility("visible");
  env.control.setActive(true);
  expect(env.frames.size).toBe(0);
});

test("unsupported upstream API is reported explicitly", () => {
  expect(() => installTerminalRenderControl({} as Terminal, true)).toThrow("Unsupported ghostty-web");
});
