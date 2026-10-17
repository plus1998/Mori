import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import type { BrowserInstanceView } from "../shared/browser";
import type { BrowserSelection, BrowserSelectionContent, BrowserSelectionPreview } from "../shared/browser-selection";
import { assertBrowserGuestWebContents } from "./browser-cdp-proxy";
import { BROWSER_SELECTION_FUNCTION, BROWSER_SELECTION_LOCATE_FUNCTION } from "./browser-selection-script";

interface SelectionTarget { guest: WebContents; instance: BrowserInstanceView }
interface SelectionDeps {
  directory: string;
  getTarget(browserId: string): SelectionTarget;
}

/** Immutable snapshots outlive tabs and drafts; live operations require the original document. */
export class BrowserSelectionService {
  private pending: { browserId: string; cancel(): void } | undefined;
  private active: { browserId: string; cancelled: boolean } | undefined;

  constructor(private readonly deps: SelectionDeps) {}

  cancel(browserId: string) {
    if (this.active?.browserId === browserId) this.active.cancelled = true;
    if (this.pending?.browserId === browserId) this.pending.cancel();
  }

  async capture(browserId: string, kind: "element" | "text"): Promise<BrowserSelection | null> {
    if (this.active) throw new Error("请先完成或退出当前网页选择。");
    const operation = { browserId, cancelled: false };
    this.active = operation;
    try {
      const selection = await this.captureInternal(browserId, kind);
      if (!operation.cancelled) return selection;
      if (selection) {
        fs.rmSync(selection.screenshotPath, { force: true });
        fs.rmSync(path.join(this.deps.directory, `${selection.id}.json`), { force: true });
      }
      return null;
    } catch (error) {
      if (operation.cancelled) return null;
      throw error;
    } finally { this.active = undefined; }
  }

  private async captureInternal(browserId: string, kind: "element" | "text"): Promise<BrowserSelection | null> {
    const operation = this.active!;
    const { guest, instance } = this.deps.getTarget(browserId);
    assertBrowserGuestWebContents(guest);
    if (kind === "text") {
      const matches: BrowserSelectionContent[] = [];
      for (const frame of guest.mainFrame.framesInSubtree) {
        if (frame.detached) continue;
        const content = await frame.executeJavaScript(`(${BROWSER_SELECTION_FUNCTION}).call(document, 'text')`) as BrowserSelectionContent | null;
        if (content) matches.push(content);
      }
      if (this.active?.cancelled) return null;
      if (matches.length !== 1) throw new Error(matches.length ? "多个 frame 中存在选中文字，请只保留一处选择。" : "请先在网页里选中文字，再点击引用文字。");
      return this.save(guest, instance, matches[0]!, operation);
    }

    const dbg = guest.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("DOM.enable");
    await dbg.sendCommand("Overlay.enable");
    if (this.active?.cancelled) return null;
    return new Promise<BrowserSelection | null>((resolve, reject) => {
      let settled = false;
      let capturing = false;
      let startup: Promise<unknown> = Promise.resolve();
      const disable = async () => {
        if (!guest.isDestroyed() && dbg.isAttached()) {
          // Chromium in Electron 37 also requires highlightConfig when disabling inspection.
          await dbg.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: { showInfo: false, showStyles: false } });
          await dbg.sendCommand("Overlay.hideHighlight");
        }
      };
      const cleanup = () => {
        dbg.removeListener("message", onMessage);
        dbg.removeListener("detach", onDetach);
        guest.removeListener("before-input-event", onInput);
        guest.removeListener("did-start-navigation", onNavigate);
        guest.removeListener("destroyed", onDestroyed);
        if (this.pending?.browserId === browserId) this.pending = undefined;
      };
      const finish = async (value: BrowserSelection | null, error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          await startup;
          await disable();
          if (error) reject(error);
          else resolve(value);
        } catch (failure) { reject(failure); }
      };
      const onInput = (event: Electron.Event, input: Electron.Input) => {
        if (input.key === "Escape") { event.preventDefault(); void finish(null); }
      };
      const onNavigate = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame) void finish(null, new Error("页面已跳转，请重新选择网页内容。"));
      };
      const onDestroyed = () => { void finish(null, new Error("网页已关闭，选择已取消。")); };
      const onDetach = () => { void finish(null, new Error("网页调试连接已断开，请重新选择。")); };
      const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>, sessionId?: string) => {
        if (method === "Overlay.inspectModeCanceled" && !capturing) { void finish(null); return; }
        if (method !== "Overlay.inspectNodeRequested" || capturing || settled) return;
        capturing = true;
        void (async () => {
          await disable();
          // Electron reports the root target with an empty session id; omit the argument there.
          const send = (method: string, args: Record<string, unknown>) => sessionId
            ? dbg.sendCommand(method, args, sessionId) : dbg.sendCommand(method, args);
          const node = await send("DOM.resolveNode", { backendNodeId: params.backendNodeId });
          if (!node.object?.objectId) throw new Error("未能读取选中的网页元素。");
          try {
            const result = await send("Runtime.callFunctionOn", {
              objectId: node.object.objectId,
              functionDeclaration: BROWSER_SELECTION_FUNCTION,
              arguments: [{ value: "element" }], returnByValue: true,
            });
            if (result.exceptionDetails || !result.result?.value) throw new Error(result.exceptionDetails?.exception?.description || "未能读取选中的网页元素。");
            if (settled) return;
            const selection = await this.save(guest, instance, result.result.value as BrowserSelectionContent, operation);
            await finish(selection);
          } finally {
            if (!guest.isDestroyed() && dbg.isAttached()) await send("Runtime.releaseObject", { objectId: node.object.objectId });
          }
        })().catch(error => { void finish(null, error); });
      };
      this.pending = { browserId, cancel: () => { void finish(null); } };
      dbg.on("message", onMessage);
      dbg.on("detach", onDetach);
      guest.on("before-input-event", onInput);
      guest.on("did-start-navigation", onNavigate);
      guest.once("destroyed", onDestroyed);
      startup = dbg.sendCommand("Overlay.setInspectMode", {
        mode: "searchForNode", highlightConfig: {
          showInfo: true, showStyles: false,
          contentColor: { r: 108, g: 140, b: 255, a: 0.18 },
          borderColor: { r: 108, g: 140, b: 255, a: 0.9 },
        },
      });
      void startup.then(() => { if (!settled) guest.focus(); }).catch(error => { void finish(null, error); });
    });
  }

  private async save(guest: WebContents, instance: BrowserInstanceView, content: BrowserSelectionContent, operation: { cancelled: boolean }): Promise<BrowserSelection> {
    if (operation.cancelled) throw new Error("网页选择已取消。");
    if (guest.isDestroyed() || guest.getURL() !== instance.url) throw new Error("页面已变化，请重新选择网页内容。");
    const image = await guest.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) throw new Error("网页截图为空，未创建引用，请重试。");
    if (guest.isDestroyed() || guest.getURL() !== instance.url) throw new Error("截图时页面已变化，请重新选择网页内容。");
    const id = randomUUID();
    const screenshotPath = path.join(this.deps.directory, `${id}.png`);
    const selection: BrowserSelection = {
      ...content, version: 1, id, browserId: instance.id, scopeId: instance.threadId,
      url: instance.url, title: instance.title, capturedAt: new Date().toISOString(), screenshotPath,
    };
    // Verify again after screenshot: navigation or a rerender must not create a misleading snapshot.
    await this.validateContent(guest, selection, false);
    if (operation.cancelled) throw new Error("网页选择已取消。");
    fs.mkdirSync(this.deps.directory, { recursive: true });
    try {
      fs.writeFileSync(screenshotPath, image.toPNG(), { flag: "wx" });
      fs.writeFileSync(path.join(this.deps.directory, `${id}.json`), JSON.stringify(selection), { flag: "wx" });
    } catch (error) {
      fs.rmSync(screenshotPath, { force: true });
      throw error;
    }
    return selection;
  }

  read(id: string): BrowserSelection {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) throw new Error("网页内容引用 ID 无效。");
    const file = path.join(this.deps.directory, `${id}.json`);
    if (!fs.existsSync(file)) throw new Error("网页内容引用已丢失，请重新选择。");
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as BrowserSelection;
    if (value.version !== 1 || value.id !== id || !Array.isArray(value.selectorPath)) throw new Error("网页内容引用数据损坏。");
    return { ...value, screenshotPath: path.join(this.deps.directory, `${id}.png`) };
  }

  preview(id: string): BrowserSelectionPreview {
    const selection = this.read(id);
    return { selection, screenshotDataUrl: `data:image/png;base64,${this.screenshot(id)}` };
  }

  screenshot(id: string): string {
    return fs.readFileSync(this.read(id).screenshotPath).toString("base64");
  }

  async validate(id: string, reveal = false) {
    const selection = this.read(id);
    const { guest } = this.deps.getTarget(selection.browserId);
    assertBrowserGuestWebContents(guest);
    if (guest.getURL() !== selection.url) throw new Error("引用的网页已跳转，历史内容仍可查看；请重新选择后操作。");
    await this.validateContent(guest, selection, reveal);
    return selection;
  }

  private async validateContent(guest: WebContents, selection: BrowserSelection, reveal: boolean) {
    let found = false;
    for (const frame of guest.mainFrame.framesInSubtree) {
      if (frame.detached) continue;
      const result = await frame.executeJavaScript(`(${BROWSER_SELECTION_LOCATE_FUNCTION})(${JSON.stringify(selection)}, ${reveal})`);
      if (result) {
        if (found) throw new Error("引用的网页 frame 不唯一，请重新选择。");
        found = true;
      }
    }
    if (!found) throw new Error("引用的页面已刷新或 frame 已关闭，历史内容仍可查看；请重新选择后操作。");
  }
}
