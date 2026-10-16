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

function createViewportGuest(id: number) {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    id,
    commands,
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "about:blank",
    getTitle: () => "",
    isLoading: () => false,
    setWindowOpenHandler: () => {},
    on: () => {},
    close: () => {},
    debugger: {
      isAttached: () => true,
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        commands.push({ method, params });
      },
    },
    executeJavaScript: async () => ({ width: 390, height: 844, deviceScaleFactor: 3 }),
  };
}

test("Agent can discover named devices without creating a page or CDP session", async () => {
  const host = createTestHost();
  try {
    const result = await host.invokeNativeAgentBrowserTool("t1", "agent_browser_list_devices", {});
    const devices = JSON.parse((result?.content[0] as { text: string }).text).devices;
    expect(devices.find((device: { preset: string }) => device.preset === "iphone-16")).toMatchObject({
      name: "iPhone 16",
      width: 393,
      height: 852,
    });
    expect(devices.find((device: { preset: string }) => device.preset === "iphone-se")).toMatchObject({
      name: "iPhone SE",
      width: 375,
      height: 667,
    });
    expect(host.getState().allGuestInstances).toHaveLength(0);
    expect(host.getState().cdpPort).toBeUndefined();
  } finally {
    host.dispose();
  }
});

test("viewport changes stay tab-scoped and native Agent tools use the authenticated thread", async () => {
  const host = createTestHost();
  try {
    await host.openSharedSession({ threadId: "t1", revealUi: false });
    const first = host.getState().focusedBrowserId!;
    const guest = createViewportGuest(100);
    host.registerGuestWebContents(first, guest as never);
    await host.openSharedSession({ threadId: "t2", revealUi: false });
    const second = host.getState().focusedBrowserId!;
    const otherGuest = createViewportGuest(101);
    host.registerGuestWebContents(second, otherGuest as never);
    const result = await host.invokeNativeAgentBrowserTool("t1", "agent_browser_set_viewport", {
      preset: "phone",
    });
    const state = host.getState();
    expect(state.allInstances.find((page) => page.id === first)?.viewport?.width).toBe(390);
    expect(state.allInstances.find((page) => page.id === second)?.viewport).toBeUndefined();
    expect(otherGuest.commands).toHaveLength(0);
    expect(JSON.parse((result!.content[0] as { text: string }).text).metrics.width).toBe(390);
    expect(
      guest.commands.find((call) => call.method.endsWith("setDeviceMetricsOverride"))?.params
        ?.deviceScaleFactor,
    ).toBe(3);
    await host.setViewport(first, { preset: "auto" });
    expect(host.getState().allInstances.find((page) => page.id === first)?.viewport).toBeUndefined();
  } finally {
    host.dispose();
  }
});

test("concurrent viewport changes are applied in order and failed changes are visible", async () => {
  const host = createTestHost();
  try {
    await host.openSharedSession({ threadId: "t1", revealUi: false });
    const browserId = host.getState().focusedBrowserId!;
    const guest = createViewportGuest(102);
    host.registerGuestWebContents(browserId, guest as never);
    await Promise.all([
      host.setViewport(browserId, { preset: "phone" }),
      host.setViewport(browserId, { preset: "desktop" }),
    ]);
    expect(host.getState().instances[0]?.viewport?.width).toBe(1920);
    const widths = guest.commands
      .filter((call) => call.method.endsWith("setDeviceMetricsOverride"))
      .map((call) => call.params?.width);
    expect(widths).toEqual([390, 1920]);
    guest.debugger.sendCommand = async () => {
      throw new Error("Emulation failed");
    };
    await expect(host.setViewport(browserId, { preset: "phone" })).rejects.toThrow("Emulation failed");
    expect(host.getState().instances[0]?.viewportError).toBe("Emulation failed");
    expect(host.getState().instances[0]?.viewport?.width).toBe(1920);
  } finally {
    host.dispose();
  }
});

test("web AI pages share storage across threads while ordinary pages keep workspace storage", async () => {
  const host = createTestHost();
  try {
    await host.openSharedSession({ threadId: "a", workspacePath: "/tmp/a", webChatSiteId: "chatgpt" });
    await host.openSharedSession({ threadId: "b", workspacePath: "/tmp/b", webChatSiteId: "chatgpt" });
    await host.openSharedSession({ threadId: "b", newBrowser: true });
    const guests = host.getState().allGuestInstances;
    expect(guests).toHaveLength(3);
    expect(guests.filter((guest) => guest.partition.startsWith("persist:eco-web-chat-site-"))).toHaveLength(2);
    expect(guests.filter((guest) => guest.partition.startsWith("persist:eco-browser-w-"))).toHaveLength(1);
  } finally {
    host.dispose();
  }
});


test("different Chat AI sites keep independent sessions within the same thread", async () => {
  const host = createTestHost();
  try {
    await host.openSharedSession({ threadId: "a", workspacePath: "/tmp/a", webChatSiteId: "chatgpt" });
    await host.openSharedSession({ threadId: "a", webChatSiteId: "doubao" });
    const guests = host.getState().allGuestInstances;
    expect(guests).toHaveLength(2);
    expect(guests[0]!.partition).not.toBe(guests[1]!.partition);
  } finally { host.dispose(); }
});
