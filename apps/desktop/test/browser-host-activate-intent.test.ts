import { expect, mock, test } from "bun:test";

// BrowserHost imports electron main-process modules at module load time —
// stub them before the dynamic import so the test runs under bun.
mock.module("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler: () => {} }) },
  shell: { openExternal: async () => true },
  webContents: { fromId: () => undefined },
  BrowserWindow: class {},
  app: { on: () => {}, getAppPath: () => "" },
  ipcMain: { handle: () => {}, on: () => {} },
  nativeTheme: { shouldUseDarkColors: false },
  contextBridge: {},
  clipboard: {},
  screen: {},
}));

const { BrowserHost } = await import("../src/main/browser-host");

function createTestHost(): BrowserHost {
  return new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast: () => {},
    resolveWorkspacePath: () => "/tmp/ws-t1",
  } as never);
}

test("activateBrowserId addresses a live page, then drops with it", async () => {
  const host = createTestHost();
  try {
    await host.openSharedSession({
      threadId: "t1",
      workspacePath: "/tmp/ws-t1",
      revealUi: false,
      activate: true,
    });

    const opened = host.getState();
    const activatedId = opened.activateBrowserId;
    expect(activatedId).toBeTruthy();
    expect(opened.guestInstances.map((guest) => guest.id)).toContain(activatedId!);

    // Closing that page must stop advertising the intent: a stale id makes the
    // renderer re-open a phantom tab and focus a browser main no longer knows.
    host.closeBrowser(activatedId!);
    const closed = host.getState();
    expect(closed.activateBrowserId).toBeUndefined();
    expect(closed.guestInstances.map((guest) => guest.id)).not.toContain(activatedId!);
  } finally {
    host.dispose();
  }
});

test("closing another page keeps the activate intent on the live one", async () => {
  const host = createTestHost();
  try {
    await host.openSharedSession({
      threadId: "t1",
      workspacePath: "/tmp/ws-t1",
      revealUi: false,
      activate: true,
    });
    const activatedId = host.getState().activateBrowserId!;

    await host.openSharedSession({
      threadId: "t1",
      workspacePath: "/tmp/ws-t1",
      revealUi: false,
      newBrowser: true,
      updateUiFocus: false,
    });
    const other = host
      .getState()
      .guestInstances.map((guest) => guest.id)
      .find((id) => id !== activatedId);
    expect(other).toBeTruthy();

    host.closeBrowser(other!);
    expect(host.getState().activateBrowserId).toBe(activatedId);
  } finally {
    host.dispose();
  }
});

test("global resource list includes other conversations and closes pages without switching scope", async () => {
  const host = createTestHost();
  try {
    for (const threadId of ["t1", "t2"]) {
      await host.openSharedSession({ threadId, url: `https://${threadId}.example.com`, revealUi: false });
    }
    host.setUiScope("t1");
    const state = host.getState();
    expect(state.instances.map((page) => page.threadId)).toEqual(["t1"]);
    expect(state.allInstances.map((page) => page.threadId)).toEqual(["t1", "t2"]);
    const other = state.allInstances.find((page) => page.threadId === "t2");
    if (!other) throw new Error("Missing other conversation's browser");
    host.closeBrowser(other.id);
    expect(host.getState().uiScopeId).toBe("t1");
    expect(host.getState().allInstances.map((page) => page.threadId)).toEqual(["t1"]);
  } finally {
    host.dispose();
  }
});
