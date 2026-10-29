import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

let cursor = { x: 0, y: 0 };
class PetWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), {
    id: 42,
    setWindowOpenHandler() {},
    send() {},
  });
  bounds = { x: 0, y: 0, width: 64, height: 64 };
  ignored: boolean[] = [];
  destroyed = false;
  setIgnoreMouseEvents(value: boolean) {
    this.ignored.push(value);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return true;
  }
  getBounds() {
    return this.bounds;
  }
  setBounds(value: typeof this.bounds) {
    this.bounds = value;
  }
  setPosition(x: number, y: number) {
    this.bounds = { ...this.bounds, x, y };
  }
  showInactive() {}
  async loadFile() {}
  async loadURL() {}
  destroy() {
    this.destroyed = true;
  }
}
mock.module("electron", () => ({
  app: {},
  BrowserWindow: PetWindow,
  globalShortcut: { unregister() {} },
  Menu: {},
  Tray: class {},
  screen: {
    getCursorScreenPoint: () => cursor,
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));
const { MoriAssistantWindows } = await import("../src/main/mori-assistant-windows");
const instances: InstanceType<typeof MoriAssistantWindows>[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.close();
});
async function setup() {
  cursor = { x: 0, y: 0 };
  const windows = new MoriAssistantWindows({
    preload: "test",
    renderer: "test",
    store: { state: { ballPosition: { x: 0, y: 0 } }, save: async () => {} } as never,
    showMain: async () => {},
    reportError: (error) => {
      throw error;
    },
  });
  instances.push(windows);
  await windows.showBall(64);
  const ball = (windows as unknown as { ball: PetWindow }).ball;
  return { windows, ball };
}

test("transparent pixels pass through, frame changes restore input, and dragging retains capture outside the pet", async () => {
  const { windows, ball } = await setup();
  const alpha = new Uint8Array(64 * 64);
  cursor = { x: 32, y: 32 };
  windows.setPetHitMap({ width: 64, height: 64, alpha });
  expect(ball.ignored.at(-1)).toBe(true);
  alpha[32 * 64 + 32] = 255;
  windows.setPetHitMap({ width: 64, height: 64, alpha });
  expect(ball.ignored.at(-1)).toBe(false);
  const calls = ball.ignored.length;
  windows.setPetHitMap({ width: 64, height: 64, alpha });
  expect(ball.ignored).toHaveLength(calls); // No repeated native calls while the result is unchanged.
  windows.setPetDragging(true);
  cursor = { x: -100, y: -100 };
  windows.setPetHitMap({ width: 64, height: 64, alpha });
  expect(ball.ignored.at(-1)).toBe(false);
  windows.setPetDragging(false);
  expect(ball.ignored.at(-1)).toBe(true);
});

test("resizing maps screen DIP coordinates back into the mask, and reload clears stale input", async () => {
  const { windows, ball } = await setup();
  const alpha = new Uint8Array(64 * 64);
  alpha[32 * 64 + 32] = 255;
  await windows.showBall(128);
  cursor = { x: ball.bounds.x + 64, y: ball.bounds.y + 64 };
  windows.setPetHitMap({ width: 64, height: 64, alpha });
  expect(ball.ignored.at(-1)).toBe(false);
  expect(windows.isPetSender(42)).toBe(true);
  expect(windows.isPetSender(43)).toBe(false);
  ball.webContents.emit("did-start-loading");
  expect(ball.ignored.at(-1)).toBe(true);
  expect(() => windows.setPetHitMap({ width: 64, height: 64, alpha: new Uint8Array(1) })).toThrow("无效");
});
