import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { BrowserDownloads } from "../src/main/browser-downloads";

const sessions = new Map<string, EventEmitter>();
mock.module("electron", () => ({
  session: { fromPartition: (partition: string) => {
    if (!sessions.has(partition)) sessions.set(partition, Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }));
    return sessions.get(partition);
  } },
  shell: {}, webContents: { fromId: () => undefined },
}));
const { BrowserHost } = await import("../src/main/browser-host");

test("native download tools enforce conversation ownership, completion, and host review", async () => {
  let reviewed = 0;
  const host = new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast: () => {}, resolveWorkspacePath: () => "/tmp/download-host-test",
    authorizeDownloadAccess: async ({ threadId, file }) => {
      expect(threadId).toBe("thread-a");
      expect(file.name).toBe("test.txt");
      reviewed++;
    },
  });
  const registry = (host as unknown as { downloads: BrowserDownloads }).downloads;
  try {
    const opened = await host.openSharedSession({ threadId: "thread-a", revealUi: false });
    const browserId = opened.focusedBrowserId!;
    const item = Object.assign(new EventEmitter(), {
      savedPath: "",
      getFilename: () => "test.txt", getMimeType: () => "text/plain", getURL: () => "https://test.invalid/file",
      getTotalBytes: () => 4, getReceivedBytes: () => 4,
      setSavePath(value: string) { this.savedPath = value; }, cancel() { this.emit("done", {}, "cancelled"); },
    });
    registry.capture(browserId, item as never);
    const fileId = registry.list(browserId)[0]!.id;
    const listing = await host.invokeNativeAgentBrowserTool("thread-a", "agent_browser_files_list", { tabId: "t1" });
    expect(JSON.stringify(listing)).not.toContain(item.savedPath);
    expect(JSON.stringify(listing)).toContain(browserId);
    await expect(host.invokeNativeAgentBrowserTool("thread-a", "agent_browser_files_list", { tabId: "t2" })).rejects.toThrow("not found");
    await expect(host.invokeNativeAgentBrowserTool("thread-a", "agent_browser_files_get", { browserId, fileId })).rejects.toThrow("pending");
    expect(reviewed).toBe(0);
    fs.writeFileSync(item.savedPath, "test");
    item.emit("done", {}, "completed");
    await expect(host.invokeNativeAgentBrowserTool("thread-b", "agent_browser_files_get", { browserId, fileId })).rejects.toThrow("does not belong");
    expect(reviewed).toBe(0);
    const retrieved = await host.invokeNativeAgentBrowserTool("thread-a", "agent_browser_files_get", { browserId, fileId });
    expect(reviewed).toBe(1);
    expect(JSON.stringify(retrieved)).toContain(item.savedPath);
    expect(host.getState().instances[0]!.downloads?.[0]?.state).toBe("completed");
  } finally { host.dispose(); }
});

test("download hook uses the real guest source across shared sessions and removes its listener", async () => {
  const host = new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast: () => {}, resolveWorkspacePath: () => "/tmp/download-source-test",
  });
  const opened = await host.openSharedSession({ threadId: "thread", revealUi: false });
  const browserId = opened.focusedBrowserId!;
  const internals = host as unknown as { scopes: Map<string, { browsers: Map<string, { webContents?: unknown }> }> };
  internals.scopes.get("thread")!.browsers.get(browserId)!.webContents = { id: 901, isDestroyed: () => true };
  const session = sessions.get(opened.instances[0]!.partition)!;
  const item = Object.assign(new EventEmitter(), {
    savedPath: "", getFilename: () => "manual.txt", getMimeType: () => "text/plain",
    getURL: () => "https://test.invalid/file", getTotalBytes: () => 0, getReceivedBytes: () => 0,
    setSavePath(value: string) { this.savedPath = value; }, cancel() { this.emit("done", {}, "cancelled"); },
  });
  try {
    session.emit("will-download", {}, item, { id: 999 });
    expect(item.savedPath).toBe("");
    session.emit("will-download", {}, item, { id: 901 });
    expect(item.savedPath).toContain("eco-browser-downloads-");
    expect(host.getState().instances[0]!.downloads).toHaveLength(1);
  } finally { host.dispose(); }
  expect(session.listenerCount("will-download")).toBe(0);
});

test("UI deletion checks the current conversation and broadcasts the updated download list", async () => {
  const states: number[] = [];
  const host = new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast: state => states.push(state.instances.reduce((count, tab) => count + (tab.downloads?.length ?? 0), 0)),
    resolveWorkspacePath: () => "/tmp/download-delete-test",
  });
  try {
    const opened = await host.openSharedSession({ threadId: "a", revealUi: false });
    const browserId = opened.focusedBrowserId!;
    const registry = (host as unknown as { downloads: BrowserDownloads }).downloads;
    const item = Object.assign(new EventEmitter(), {
      savedPath: "", getFilename: () => "report.pdf", getMimeType: () => "application/pdf",
      getURL: () => "https://test.invalid/file", getTotalBytes: () => 4, getReceivedBytes: () => 4,
      setSavePath(value: string) { this.savedPath = value; }, cancel() {},
    });
    registry.capture(browserId, item as never);
    fs.writeFileSync(item.savedPath, "test");
    item.emit("done", {}, "completed");
    const fileId = registry.list(browserId)[0]!.id;
    host.setUiScope("b");
    await expect(host.removeDownloadForUi(browserId, fileId)).rejects.toThrow("current UI scope");
    expect(fs.existsSync(item.savedPath)).toBe(true);
    host.setUiScope("a");
    await host.removeDownloadForUi(browserId, fileId);
    expect(host.getState().instances[0]!.downloads).toEqual([]);
    expect(fs.existsSync(item.savedPath)).toBe(false);
    expect(states.at(-1)).toBe(0);
  } finally { host.dispose(); }
});

test("closing a tab aborts its parked file-access review", async () => {
  let accessSignal: AbortSignal | undefined;
  const host = new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast: () => {}, resolveWorkspacePath: () => "/tmp/download-abort-test",
    authorizeDownloadAccess: ({ signal }) => new Promise((_resolve, reject) => {
      accessSignal = signal;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }),
  });
  try {
    const opened = await host.openSharedSession({ threadId: "thread", revealUi: false });
    const browserId = opened.focusedBrowserId!;
    const registry = (host as unknown as { downloads: BrowserDownloads }).downloads;
    const item = Object.assign(new EventEmitter(), {
      savedPath: "", getFilename: () => "file.txt", getMimeType: () => "text/plain", getURL: () => "https://test.invalid/file",
      getTotalBytes: () => 4, getReceivedBytes: () => 4,
      setSavePath(value: string) { this.savedPath = value; }, cancel() {},
    });
    registry.capture(browserId, item as never);
    fs.writeFileSync(item.savedPath, "test");
    item.emit("done", {}, "completed");
    const fileId = registry.list(browserId)[0]!.id;
    const pending = host.invokeNativeAgentBrowserTool("thread", "agent_browser_files_get", { browserId, fileId });
    expect(accessSignal?.aborted).toBe(false);
    host.closeBrowser(browserId);
    await expect(pending).rejects.toThrow("Browser tab was closed");
    expect(accessSignal?.aborted).toBe(true);
  } finally { host.dispose(); }
});
