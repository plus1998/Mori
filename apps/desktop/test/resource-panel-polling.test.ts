import { afterEach, expect, jest, test } from "bun:test";
import { startResourcePanelPolling } from "../src/renderer/resource-panel-polling";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  jest.useRealTimers();
  for (const [name, descriptor] of [
    ["window", originalWindow],
    ["document", originalDocument],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function setup() {
  jest.useFakeTimers();
  const surface = new EventTarget();
  let focused = true;
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  Object.defineProperty(globalThis, "window", { configurable: true, value: surface });
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  return {
    surface,
    doc,
    focus: (value: boolean) => {
      focused = value;
      surface.dispatchEvent(new Event(value ? "focus" : "blur"));
    },
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("resource polling stops while hidden, blurred or idle and refreshes immediately on return", async () => {
  const { surface, doc, focus } = setup();
  let calls = 0;
  stop = startResourcePanelPolling(async () => {
    calls++;
  }, 2000);
  await settle();
  expect(calls).toBe(1);
  focus(false);
  jest.advanceTimersByTime(10_000);
  await settle();
  expect(calls).toBe(1);
  focus(true);
  await settle();
  expect(calls).toBe(2);
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  jest.advanceTimersByTime(10_000);
  expect(calls).toBe(2);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  await settle();
  expect(calls).toBe(3);
  jest.advanceTimersByTime(60_000);
  await settle();
  const idleCalls = calls;
  jest.advanceTimersByTime(60_000);
  await settle();
  expect(calls).toBe(idleCalls);
  surface.dispatchEvent(new Event("pointermove"));
  await settle();
  expect(calls).toBe(idleCalls + 1);
});

test("an in-flight refresh never overlaps, and unmount prevents rescheduling", async () => {
  const { focus } = setup();
  let calls = 0;
  let release!: () => void;
  stop = startResourcePanelPolling(() => {
    calls++;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  }, 1500);
  focus(false);
  focus(true);
  jest.advanceTimersByTime(5000);
  expect(calls).toBe(1);
  stop();
  release();
  await settle();
  jest.advanceTimersByTime(5000);
  expect(calls).toBe(1);
});
