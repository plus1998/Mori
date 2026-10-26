import { expect, test } from "bun:test";
import { startTaskPanelResizeSession } from "../src/renderer/task-panel-resize-session";

function pointer(type: string, pointerId = 7, buttons = 1, clientX = 400) {
  return Object.assign(new Event(type), { pointerId, buttons, clientX });
}

function setup(captureError = false) {
  const win = new EventTarget();
  const classes = new Set<string>();
  const doc = Object.assign(new EventTarget(), {
    defaultView: win,
    visibilityState: "visible",
    body: {
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    },
  });
  const captures = new Set<number>();
  let releases = 0;
  const handle = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    setPointerCapture(id: number) {
      if (captureError) throw new Error("Invalid pointer");
      captures.add(id);
    },
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture(id: number) {
      captures.delete(id);
      releases++;
      handle.dispatchEvent(pointer("lostpointercapture", id));
    },
  });
  const moves: number[] = [];
  return {
    win,
    doc,
    handle,
    classes,
    captures,
    moves,
    releases: () => releases,
    start: () =>
      startTaskPanelResizeSession({
        handle: handle as unknown as HTMLElement,
        pointerId: 7,
        onMove: (x) => moves.push(x),
      }),
  };
}

test("window-level movement updates width and pointerup removes the shield and capture", () => {
  const env = setup();
  const stop = env.start();
  expect(env.classes.has("is-resizing-task-panel")).toBe(true);
  env.win.dispatchEvent(pointer("pointermove", 7, 1, 350));
  expect(env.moves).toEqual([350]);
  env.win.dispatchEvent(pointer("pointerup", 7, 0));
  expect(env.classes.size).toBe(0);
  expect(env.captures.size).toBe(0);
  env.win.dispatchEvent(pointer("pointermove"));
  stop();
  expect(env.moves).toEqual([350]);
  expect(env.releases()).toBe(1);
});

for (const reason of [
  "lost capture",
  "cancel",
  "blur",
  "hidden",
  "escape",
  "missed release",
  "dispose",
] as const) {
  test(`${reason} ends resizing and restores the other controls`, () => {
    const env = setup();
    const stop = env.start();
    switch (reason) {
      case "lost capture":
        env.handle.releasePointerCapture(7);
        break;
      case "cancel":
        env.win.dispatchEvent(pointer("pointercancel"));
        break;
      case "blur":
        env.win.dispatchEvent(new Event("blur"));
        break;
      case "hidden":
        env.doc.visibilityState = "hidden";
        env.doc.dispatchEvent(new Event("visibilitychange"));
        break;
      case "escape": {
        const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
        env.win.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        break;
      }
      case "missed release":
        env.win.dispatchEvent(pointer("pointermove", 7, 0));
        break;
      case "dispose":
        stop();
        break;
    }
    expect(env.classes.size).toBe(0);
    expect(env.captures.size).toBe(0);
    env.win.dispatchEvent(pointer("pointermove"));
    expect(env.moves).toEqual([]);
    stop();
    expect(env.releases()).toBe(1);
  });
}

test("unrelated pointers and keys cannot move or cancel the gesture", () => {
  const env = setup();
  const stop = env.start();
  env.win.dispatchEvent(pointer("pointermove", 8));
  env.win.dispatchEvent(pointer("pointerup", 8));
  env.handle.dispatchEvent(pointer("lostpointercapture", 8));
  env.win.dispatchEvent(Object.assign(new Event("keydown"), { key: "ArrowLeft" }));
  env.doc.dispatchEvent(new Event("visibilitychange"));
  expect(env.moves).toEqual([]);
  expect(env.classes.has("is-resizing-task-panel")).toBe(true);
  stop();
});

test("a failed pointer capture leaves no shield or active listeners and reports the error", () => {
  const env = setup(true);
  expect(env.start).toThrow("Invalid pointer");
  expect(env.classes.size).toBe(0);
  env.win.dispatchEvent(pointer("pointermove"));
  expect(env.moves).toEqual([]);
});
