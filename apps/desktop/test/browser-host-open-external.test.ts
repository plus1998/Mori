import { beforeEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

const openExternal = mock(async (_url: string): Promise<void> => {});
mock.module("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler() {}, on() {}, off() {} }) },
  shell: { openExternal },
  webContents: { fromId: () => undefined },
}));
const { BrowserHost } = await import("../src/main/browser-host");

beforeEach(() => openExternal.mockReset());

function createHost() {
  return new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast() {},
    resolveWorkspacePath: () => "/tmp/browser-open-external-test",
  });
}

function createGuest(id: number) {
  let url = "about:blank";
  let destroyed = false;
  const guest = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => destroyed,
    getType: () => "webview",
    getURL: () => {
      if (destroyed) throw new Error("WebContents is destroyed");
      return url;
    },
    getTitle: () => "Test page",
    isLoading: () => false,
    setWindowOpenHandler() {},
    async loadURL(next: string) {
      url = next;
      guest.emit("did-navigate", {}, next);
    },
    close() {
      if (destroyed) return;
      destroyed = true;
      guest.emit("destroyed");
    },
  });
  return guest;
}

test("external open uses the latest guest URL including redirects, query, and fragment", async () => {
  const host = createHost();
  try {
    const state = await host.openSharedSession({ threadId: "a", url: "https://example.test/start", revealUi: false });
    const id = state.focusedBrowserId!;
    const guest = createGuest(101);
    host.registerGuestWebContents(id, guest as never);
    const current = "https://example.test/中文?one=1&two=2#section";
    await guest.loadURL(current);
    await host.openExternalCurrent(id);
    expect(openExternal.mock.calls).toEqual([[current]]);
  } finally { host.dispose(); }
});

test("external open uses the visible URL after a guest is destroyed and pending URL is consumed", async () => {
  const host = createHost();
  try {
    const url = "https://example.test/restored";
    const state = await host.openSharedSession({ threadId: "a", url, revealUi: false });
    const id = state.focusedBrowserId!;
    const guest = createGuest(102);
    host.registerGuestWebContents(id, guest as never);
    await guest.loadURL(url);
    guest.close();
    expect(host.getState().instances[0]?.url).toBe(url);
    await host.openExternalCurrent(id);
    expect(openExternal.mock.calls).toEqual([[url]]);
  } finally { host.dispose(); }
});

test("external open uses the visible URL while a replacement guest is still blank", async () => {
  const host = createHost();
  try {
    const url = "https://example.test/restored";
    const state = await host.openSharedSession({ threadId: "a", url, revealUi: false });
    const id = state.focusedBrowserId!;
    const guest = createGuest(103);
    host.registerGuestWebContents(id, guest as never);
    // A redirect makes the restored URL differ from the initial load URL.
    await guest.loadURL(`${url}?redirected=true`);
    guest.close();
    const replacement = createGuest(104);
    host.registerGuestWebContents(id, replacement as never);
    expect(replacement.getURL()).toBe("about:blank");
    const visible = host.getState().instances[0]!.url;
    await host.openExternalCurrent(id);
    expect(openExternal.mock.calls).toEqual([[visible]]);
  } finally { host.dispose(); }
});

test("external open targets the requested tab before its guest attaches", async () => {
  const host = createHost();
  try {
    const url = "http://localhost:3000/preview?a=1&b=2";
    const first = await host.openSharedSession({ threadId: "a", url, revealUi: false });
    await host.openSharedSession({ threadId: "a", url: "https://other.test", newBrowser: true, revealUi: false });
    await host.openExternalCurrent(first.focusedBrowserId!);
    expect(openExternal.mock.calls).toEqual([[url]]);
  } finally { host.dispose(); }
});

test("Windows shell failures propagate with their original error details", async () => {
  const host = createHost();
  const error = new Error("Failed to open: 系统找不到指定的文件。 (0x2)");
  openExternal.mockRejectedValueOnce(error);
  try {
    const state = await host.openSharedSession({ threadId: "a", url: "https://example.test", revealUi: false });
    await expect(host.openExternalCurrent(state.focusedBrowserId!)).rejects.toBe(error);
  } finally { host.dispose(); }
});

test("unsupported pages reject instead of reporting a successful no-op", async () => {
  const host = createHost();
  try {
    for (const url of ["about:blank", "file:///C:/Users/test/page.html"]) {
      const state = await host.openSharedSession({ threadId: "a", url, revealUi: false });
      await expect(host.openExternalCurrent(state.focusedBrowserId!)).rejects.toThrow("Only HTTP and HTTPS");
    }
    expect(openExternal).not.toHaveBeenCalled();
  } finally { host.dispose(); }
});

test("external open still enforces the current UI scope", async () => {
  const host = createHost();
  try {
    const state = await host.openSharedSession({ threadId: "a", url: "https://example.test", revealUi: false });
    host.setUiScope("b");
    await expect(host.openExternalCurrent(state.focusedBrowserId!)).rejects.toThrow("does not belong");
    expect(openExternal).not.toHaveBeenCalled();
  } finally { host.dispose(); }
});
