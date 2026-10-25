import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserViewState } from "../src/shared/browser";

mock.module("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler() {}, on() {}, off() {} }) },
  shell: { openExternal: async () => {} },
  webContents: { fromId: () => undefined },
}));
const { BrowserHost } = await import("../src/main/browser-host");

function createHost(states: BrowserViewState[]) {
  return new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast: (state) => states.push(state),
    resolveWorkspacePath: () => "/tmp/browser-close-test",
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
