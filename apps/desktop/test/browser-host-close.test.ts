import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserViewState } from "../src/shared/browser";

mock.module("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, off() {} }) },
  shell: { openExternal: async () => {} },
  webContents: { fromId: () => undefined },
}));
const { BrowserHost } = await import("../src/main/browser-host");

function createHost(states: BrowserViewState[], extra: Partial<ConstructorParameters<typeof BrowserHost>[0]> = {}) {
  return new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast: (state) => states.push(state),
    resolveWorkspacePath: () => "/tmp/browser-close-test",
    ...extra,
  });
}

function createGuest(id: number, deferred = false) {
  let destroyed = false;
  const guest = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => destroyed,
    getType: () => "webview",
    getURL: () => "http://127.0.0.1:18993/failed",
    getTitle: () => "Failed page",
    isLoading: () => false,
    setWindowOpenHandler() {},
    close() {
      destroyed = true;
      if (!deferred) guest.emit("destroyed");
    },
  });
  return guest;
}

for (const deferred of [false, true]) {
  test(`closing a failed page never broadcasts it again (${deferred ? "late" : "synchronous"} destruction)`, async () => {
    const states: BrowserViewState[] = [];
    const host = createHost(states);
    try {
      const first = await host.openSharedSession({
        threadId: "a",
        url: "https://other.test",
        revealUi: false,
      });
      host.consumePendingGuestAttach(700);
      const opened = await host.openSharedSession({
        threadId: "a",
        url: "http://127.0.0.1:18993/failed",
        newBrowser: true,
        activate: true,
        revealUi: false,
      });
      const id = opened.focusedBrowserId;
      if (!id || !first.focusedBrowserId) throw new Error("Missing test browser");
      expect(host.consumePendingGuestAttach(701)).toBe(id);
      const guest = createGuest(701, deferred);
      host.registerGuestWebContents(id, guest as never);
      guest.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", guest.getURL(), true);
      expect(host.getState().instances.find((page) => page.id === id)?.loadError?.code).toBe(-102);
      host.setVisible(true, id);
      host.focusBrowser(id, { reveal: true });
      states.length = 0;

      await host.closeBrowser(id);
      if (deferred) guest.emit("destroyed");
      expect(host.consumePendingGuestAttach(799)).toBeUndefined();
      // A late load callback must not resurrect a closed page either.
      guest.emit("did-stop-loading");
      expect(states.length).toBeGreaterThan(0);
      for (const state of states) {
        expect(state.instances.map((page) => page.id)).toEqual([first.focusedBrowserId]);
        expect(state.allGuestInstances.map((page) => page.id)).not.toContain(id);
        expect(state.activateBrowserId).toBeUndefined();
        expect(state.revealBrowserId).toBeUndefined();
      }
    } finally {
      await host.dispose();
    }
  });
}

test("unexpected guest destruction still preserves the tab for recovery", async () => {
  const host = createHost([]);
  try {
    const opened = await host.openSharedSession({
      threadId: "a",
      url: "https://recover.test",
      revealUi: false,
    });
    const id = opened.focusedBrowserId;
    if (!id) throw new Error("Missing test browser");
    const guest = createGuest(702);
    host.registerGuestWebContents(id, guest as never);
    guest.close();
    expect(host.getState().instances.map((page) => page.id)).toEqual([id]);
    expect(host.getState().guestInstances.map((page) => page.id)).toEqual([id]);
  } finally {
    await host.dispose();
  }
});

test("failed browser-window creation leaves the original page alive", async () => {
  const host = createHost([], { openBrowserWindow: async () => { throw new Error("Window renderer failed to load"); } });
  try {
    const opened = await host.openSharedSession({ threadId: "a", newBrowser: true });
    const id = opened.focusedBrowserId!;
    const guest = createGuest(911);
    host.registerGuestWebContents(id, guest as never);
    await expect(host.setWindowed(id, true)).rejects.toThrow("Window renderer failed");
    expect(guest.isDestroyed()).toBe(false);
    expect(host.getState().instances.find(page => page.id === id)?.windowed).toBeUndefined();
  } finally { await host.dispose(); }
});

test("main guest registration trusts the embedder supplied by the attach bridge", async () => {
  const actualHost = {};
  const host = createHost([], {
    getMainWindow: () => ({ webContents: {} } as never),
    getBrowserWindow: () => undefined,
  });
  try {
    const opened = await host.openSharedSession({ threadId: "a", revealUi: false });
    const browserId = opened.focusedBrowserId;
    if (!browserId) throw new Error("Missing test browser");
    const guest = Object.assign(createGuest(913), { hostWebContents: actualHost });
    expect(() => host.registerGuestWebContents(browserId, guest as never, actualHost as never)).not.toThrow();
  } finally { await host.dispose(); }
});

test("closing a page while its separate window is loading destroys the late window", async () => {
  let finishWindow: () => void = () => {};
  const closed: string[] = [];
  const host = createHost([], {
    openBrowserWindow: () => new Promise<void>(resolve => { finishWindow = resolve; }),
    closeBrowserWindow: id => { closed.push(id); },
  });
  try {
    const opened = await host.openSharedSession({ threadId: "a", newBrowser: true });
    const id = opened.focusedBrowserId!;
    host.registerGuestWebContents(id, createGuest(912) as never);
    const moving = host.setWindowed(id, true);
    const rejected = moving.catch(error => error as Error);
    await host.closeBrowser(id);
    finishWindow();
    expect((await rejected as Error).message).toContain("浏览器页面已关闭");
    expect(closed).toContain(id);
    expect(host.getState().allInstances).toHaveLength(0);
  } finally { await host.dispose(); }
});

test("account guests require explicit identity and cannot be assigned to an ordinary tab", async () => {
  const host = createHost([]);
  const accountSession = Object.assign(new EventEmitter(), {
    setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
  });
  try {
    host.setUiScope("account-test");
    const ordinary = await host.openSharedSession({ newBrowser: true });
    const opening = host.openAccountPage({ accountId: "account-a", name: "Account A", session: accountSession as never });
    const accountTab = host.getState().instances.find(tab => tab.accountId === "account-a")!;
    expect(host.consumePendingGuestAttach(901, accountSession as never)).toBeUndefined();
    expect(host.consumePendingGuestAttach(902, {} as never)).toBe(ordinary.focusedBrowserId);
    const guest = Object.assign(createGuest(901), { session: accountSession, setWebRTCIPHandlingPolicy() {} });
    host.registerGuestWebContents(accountTab.id, guest as never);
    const page = await opening;
    expect(page.webContents).toBe(guest as never);
    page.setClosable(false);
    expect((await host.closeBrowser(page.id)).instances.some(tab => tab.id === page.id)).toBe(true);
    await page.close();
    expect(page.isDestroyed()).toBe(true);
  } finally { await host.dispose(); }
});
