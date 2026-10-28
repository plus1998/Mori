import { expect, mock, test } from "bun:test";
import type { Session } from "electron";

type RequestHandler = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
type CheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
const handlers = new Map<string, { request?: RequestHandler; check?: CheckHandler }>();

mock.module("electron", () => ({
  session: {
    fromPartition(partition: string) {
      const entry: { request?: RequestHandler; check?: CheckHandler } = {};
      handlers.set(partition, entry);
      return {
        setPermissionRequestHandler(handler: RequestHandler) { entry.request = handler; },
        setPermissionCheckHandler(handler: CheckHandler) { entry.check = handler; },
        on() {}, off() {},
      };
    },
  },
  shell: {},
  webContents: { fromId: () => undefined },
}));
const { BrowserHost } = await import("../src/main/browser-host");

test("browser partitions allow website copy in both permission paths and deny clipboard reads", async () => {
  const host = new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast() {},
    resolveWorkspacePath: () => "/tmp/browser-permissions-test",
  });
  try {
    // Cover personal browsing, conversation browsing, and persistent web chat partitions.
    for (const options of [
      { threadId: null },
      { threadId: "clipboard-thread" },
      { threadId: "clipboard-thread", webChatSiteId: "chatgpt", newBrowser: true },
    ]) {
      const state = await host.openSharedSession({ ...options, url: "https://example.test", revealUi: false });
      const browser = state.instances.find(instance => instance.id === state.focusedBrowserId)!;
      const { request, check } = handlers.get(browser.partition)!;
      expect(request).toBeFunction();
      expect(check).toBeFunction();
      expect(check!(null, "deprecated-sync-clipboard-read", "https://example.test", { isMainFrame: true })).toBe(false);
      for (const permission of ["clipboard-sanitized-write", "clipboard-read", "media", "geolocation", "notifications"] as const) {
        const allowed = permission === "clipboard-sanitized-write";
        expect(check!(null, permission, "https://example.test", { isMainFrame: true })).toBe(allowed);
        const callback = mock((_granted: boolean) => {});
        request!({} as never, permission, callback, { requestingUrl: "https://example.test", isMainFrame: true });
        expect(callback.mock.calls).toEqual([[allowed]]);
      }
    }
  } finally {
    host.dispose();
  }
});
