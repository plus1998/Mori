import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

mock.module("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, off() {} }) },
  shell: {}, webContents: { fromId: () => undefined },
}));
const { BrowserHost } = await import("../src/main/browser-host");

function createHost() {
  return new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast() {}, resolveWorkspacePath: () => "/tmp/browser-reference-debug-test",
  });
}
function guest(id: number) {
  const commands: string[] = [];
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: async (method: string) => { commands.push(method); return { guestId: id }; },
  });
  return Object.assign(new EventEmitter(), {
    id, commands, debugger: dbg, isDestroyed: () => false, getType: () => "webview",
    getURL: () => "https://example.test/same", getTitle: () => "Test", isLoading: () => false,
    setWindowOpenHandler() {}, async loadURL() {},
  });
}

test("reference DevTools targets the exact page even when another same-URL tab has UI focus", async () => {
  const host = createHost();
  try {
    const first = await host.openSharedSession({ threadId: "a", url: "https://example.test/same", revealUi: false });
    const firstId = first.focusedBrowserId!;
    const a = guest(1);
    host.registerGuestWebContents(firstId, a as never);
    const second = await host.openSharedSession({ threadId: "b", url: "https://example.test/same", revealUi: false });
    const b = guest(2);
    host.registerGuestWebContents(second.focusedBrowserId!, b as never);
    const referenced = await host.invokeReferencedBrowserTool(firstId, "agent_browser_cdp", {
      method: "Page.getResourceContent", params: { frameId: "frame-a", url: "https://cdn.test/logo.svg" },
    });
    expect(JSON.parse(referenced.content[0]!.text!)).toMatchObject({ result: { guestId: 1 } });
    const focused = await host.invokeNativeAgentBrowserTool("b", "agent_browser_cdp", { method: "DOM.getDocument" });
    expect(JSON.parse(focused!.content[0]!.text!)).toMatchObject({ result: { guestId: 2 } });
    expect(a.commands).toEqual(["Page.getResourceContent"]);
    expect(b.commands).toEqual(["DOM.getDocument"]);
    await expect(host.invokeReferencedBrowserTool(firstId, "agent_browser_cdp", {
      method: "DOM.getDocument", browserId: second.focusedBrowserId,
    })).rejects.toThrow("不能改用");
  } finally { host.dispose(); }
});

test("eval passes the reference action allowlist while tab switching and URL substitution stay rejected", async () => {
  const host = createHost();
  try {
    // A closed page must fail at target resolution, not at the eval action allowlist.
    await expect(host.invokeReferencedBrowserTool("closed", "agent_browser_eval", { script: "document.body.outerHTML" })).rejects.toThrow("引用的网页已关闭");
    await expect(host.invokeReferencedBrowserTool("closed", "agent_browser_eval", { script: "1", session: "other" })).rejects.toThrow("不能改用");
    await expect(host.invokeReferencedBrowserTool("closed", "agent_browser_tab_switch", { tabId: "t1" })).rejects.toThrow("不适用于");
  } finally { host.dispose(); }
});
