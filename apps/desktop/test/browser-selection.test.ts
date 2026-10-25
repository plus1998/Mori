import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { BrowserInstanceView } from "../src/shared/browser";
import type { BrowserSelectionContent } from "../src/shared/browser-selection";
import { browserSelectionReference } from "../src/shared/browser-selection";
import { BrowserSelectionService } from "../src/main/browser-selection-service";
import { ComposerReferenceService } from "../src/main/composer-reference-service";
import { composerReferences, composerReferenceToken } from "../src/shared/composer-references";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eco-browser-selection-test-"));
  directories.push(directory);
  const content: BrowserSelectionContent = {
    kind: "text", frameUrl: "https://example.com/", documentToken: "123",
    selectorPath: ["#buy"], tag: "button", name: "立即购买", role: "button",
    text: "立即购买", context: "商品 立即购买", textTruncated: false,
    fingerprint: "original", bounds: { x: 1, y: 2, width: 50, height: 20 },
  };
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let live = true;
  let screenshotEmpty = false;
  let validation = true;
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      if (sessionId === "") throw new Error("Empty session id is not allowed");
      commands.push({ method, ...(params ? { params } : {}) });
      if (method === "DOM.resolveNode") return { object: { objectId: "node1" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: { ...content, kind: "element" } } };
      return {};
    },
  });
  const guest = Object.assign(new EventEmitter(), {
    debugger: dbg, isDestroyed: () => !live, getType: () => "webview", getURL: () => "https://example.com/",
    focus: () => {},
    capturePage: async () => ({ isEmpty: () => screenshotEmpty, toPNG: () => Buffer.from("saved-png") }),
    mainFrame: { framesInSubtree: [{ detached: false, executeJavaScript: async (script: string) => {
      if (script.includes(".call(document, 'text')")) return content;
      if (!validation) throw new Error("引用的元素内容已变化，请重新选择。");
      return { tag: "button" };
    } }] },
  });
  const getTarget = () => {
    if (!live) throw new Error("引用的网页已关闭。");
    return { guest: guest as unknown as WebContents, instance: { id: "web1", threadId: "thread1", title: "商城", url: "https://example.com/" } as BrowserInstanceView };
  };
  const service = new BrowserSelectionService({ directory, getTarget });
  return {
    service, guest, dbg, commands, directory,
    close: () => { live = false; }, change: () => { validation = false; },
    emptyScreenshot: () => { screenshotEmpty = true; },
    reopenService: () => new BrowserSelectionService({ directory, getTarget }),
  };
}

test("selection snapshots survive service restart and tab closure, with copyable reference tokens", async () => {
  const env = setup();
  const selection = (await env.service.capture("web1", "text"))!;
  const ref = browserSelectionReference(selection);
  expect(composerReferences(composerReferenceToken(ref))).toEqual([ref]);
  expect(ref.label).toBe("立即购买");
  env.close();
  expect(env.reopenService().preview(selection.id).selection).toEqual(selection);
  expect(env.service.preview(selection.id).screenshotDataUrl).toContain(Buffer.from("saved-png").toString("base64"));
  await expect(env.service.validate(selection.id)).rejects.toThrow("已关闭");
  expect(() => env.service.read("../../secrets")).toThrow("ID 无效");
});

test("failed screenshots do not create incomplete references", async () => {
  const env = setup();
  env.emptyScreenshot();
  await expect(env.service.capture("web1", "text")).rejects.toThrow("截图为空");
  expect(fs.readdirSync(env.directory)).toEqual([]);
});

test("element picking consumes CDP inspect events and removes only its own listeners", async () => {
  const env = setup();
  const unrelated = () => {};
  env.dbg.on("message", unrelated);
  const result = env.service.capture("web1", "element");
  await new Promise(resolve => setTimeout(resolve, 0));
  env.dbg.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 7 }, "");
  expect(await result).toMatchObject({ kind: "element", text: "立即购买" });
  expect(env.commands.find(command => command.method === "Overlay.setInspectMode" && command.params?.mode === "none")?.params).toMatchObject({ highlightConfig: { showInfo: false } });
  expect(env.dbg.listeners("message")).toEqual([unrelated]);
  expect(env.guest.listenerCount("before-input-event")).toBe(0);
});

test("Escape cancels a selection and clears the inspect overlay without persisting a reference", async () => {
  const env = setup();
  const result = env.service.capture("web1", "element");
  await new Promise(resolve => setTimeout(resolve, 0));
  let prevented = false;
  env.guest.emit("before-input-event", { preventDefault: () => { prevented = true; } }, { key: "Escape" });
  expect(await result).toBeNull();
  expect(prevented).toBe(true);
  expect(fs.readdirSync(env.directory)).toEqual([]);
});

test("immediate cancellation and concurrent requests cannot leave a late inspect overlay", async () => {
  const env = setup();
  const pending = env.service.capture("web1", "element");
  await expect(env.service.capture("web1", "element")).rejects.toThrow("先完成");
  env.service.cancel("web1");
  expect(await pending).toBeNull();
  expect(env.commands.some(command => command.params?.mode === "searchForNode")).toBe(false);
  expect(fs.readdirSync(env.directory)).toEqual([]);
});

test("cancelling while a screenshot is pending does not persist an orphaned snapshot", async () => {
  const env = setup();
  const capture = env.guest.capturePage;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  env.guest.capturePage = async () => { await gate; return capture(); };
  const pending = env.service.capture("web1", "text");
  await new Promise(resolve => setTimeout(resolve, 0));
  env.service.cancel("web1");
  release();
  expect(await pending).toBeNull();
  expect(fs.readdirSync(env.directory)).toEqual([]);
});

test("Agent reads immutable selections only after explicit grants and refuses stale live actions", async () => {
  const env = setup();
  const selection = (await env.service.capture("web1", "text"))!;
  const browserCalls: string[] = [];
  const service = new ComposerReferenceService({
    todos: { references: () => [], resolveReference: () => { throw new Error("No test todos"); }, invoke: () => { throw new Error("No test todos"); }, disposeThread() {} },
    selections: env.service, listThreads: () => [], getThread: () => undefined, listSsh: () => [], listBrowsers: () => [],
    listCapabilities: async () => [], readHistory: () => ({ messages: [], hasMore: false, historyRevision: 0 }),
    readMessage: () => undefined, readTools: () => ({}),
    browserTool: async (id, action) => { browserCalls.push(action); return { id, action }; },
  });
  await expect(service.readBrowserSelection("thread1", { selectionId: selection.id })).rejects.toThrow("明确引用");
  const prompt = await service.resolvePrompt("thread1", `修改 ${composerReferenceToken(browserSelectionReference(selection))}`);
  expect(prompt).toContain('"text":"立即购买"');
  expect(prompt).toContain('"selectionId"');
  expect((await service.readBrowserSelection("thread1", { selectionId: selection.id, includeScreenshot: true })).content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  await expect(service.browserTool("thread1", { browserId: "web1", action: "agent_browser_click" })).rejects.toThrow("selectionId");
  await service.browserTool("thread1", { browserId: "web1", selectionId: selection.id, action: "agent_browser_snapshot" });
  env.change();
  await expect(service.browserTool("thread1", { browserId: "web1", selectionId: selection.id, action: "agent_browser_click" })).rejects.toThrow("已变化");
  expect(browserCalls).toEqual(["agent_browser_snapshot"]);
  const saved = await service.readBrowserSelection("thread1", { selectionId: selection.id });
  expect(JSON.parse(saved.content[0]!.type === "text" ? saved.content[0]!.text : "{}").live.available).toBe(false);
  await expect(service.readBrowserSelection("other-thread", { selectionId: selection.id })).rejects.toThrow("明确引用");
  service.disposeThread("thread1");
  await expect(service.readBrowserSelection("thread1", { selectionId: selection.id })).rejects.toThrow("明确引用");
});
