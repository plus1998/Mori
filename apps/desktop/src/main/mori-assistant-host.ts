import path from "node:path";
import { BrowserWindow, ipcMain, type NativeImage } from "electron";
import { MORI_ASSISTANT_CHANNELS as C } from "../shared/mori-assistant";
import { type MoriAssistantDeps, MoriAssistantService } from "./mori-assistant-service";
import { MoriAssistantWechat } from "./mori-assistant-wechat";
import { MoriAssistantWindows } from "./mori-assistant-windows";

export class MoriAssistantHost {
  readonly service: MoriAssistantService;
  readonly windows: MoriAssistantWindows;
  readonly wechat: MoriAssistantWechat;
  private unsubscribe: (() => void) | undefined;
  private readonly handlers: string[] = [];
  private ready: Promise<void> | undefined;
  private closed = false;
  constructor(
    deps: Omit<MoriAssistantDeps, "changed" | "settingsChanged"> & {
      moriShortcut(): string;
      preload: string;
      renderer: string;
      icon?: NativeImage;
      showMain(): Promise<void>;
      subscribeTasks(callback: (threadId: string) => void): () => void;
      reportError(error: unknown): void;
    },
  ) {
    const changed = () => {
      if (this.closed) return;
      this.service.wechatStatus = this.wechat.status;
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send(C.changed);
    };
    this.service = new MoriAssistantService({
      ...deps,
      changed,
      settingsChanged: async (settings) => {
        await this.windows.apply({ ...settings, shortcut: deps.moriShortcut() });
        await this.wechat.setEnabled(settings.enabled && settings.wechatEnabled);
      },
    });
    this.wechat = new MoriAssistantWechat(path.join(deps.dataDir, "mori-wechat.json"), {
      changed,
      receive: async (text, id) => {
        const before = await this.service.snapshot();
        if (before.pendingInput) {
          await this.service.respond(before.pendingInput.id, text, "wechat");
          return "已收到回答，Mori 将继续处理。";
        }
        await this.service.send(text, "wechat", id);
        const snapshot = await this.service.snapshot();
        return snapshot.messages
          .filter((message) => message.role === "assistant" && message.runId === `mori-run-${id}`)
          .map((message) => message.body)
          .join("\n\n");
      },
      respondIfPending: async (text) => {
        const snapshot = await this.service.snapshot();
        if (!snapshot.pendingInput) return false;
        await this.service.respond(snapshot.pendingInput.id, text, "wechat");
        return true;
      },
    });
    this.windows = new MoriAssistantWindows({
      preload: deps.preload,
      renderer: deps.renderer,
      ...(deps.icon ? { icon: deps.icon } : {}),
      store: this.service.store,
      showMain: deps.showMain,
      reportError: deps.reportError,
    });
    this.service.canNotifyWechat = () => this.wechat.canNotify;
    this.service.onWechatReply = (text, messageId, id) =>
      this.wechat.enqueueNotification(text, messageId, id);
    const runningThreads = new Set(
      deps.conversations.listThreads().filter((thread) => thread.status === "running").map((thread) => thread.id),
    );
    this.unsubscribe = deps.subscribeTasks((id) => {
      const wasRunning = runningThreads.size > 0;
      if (deps.conversations.getThread(id)?.status === "running") runningThreads.add(id);
      else runningThreads.delete(id);
      if (wasRunning !== (runningThreads.size > 0)) this.service.capabilitiesChanged();
      void this.service.taskChanged(id).catch(deps.reportError);
    });
    const handle = <Args extends unknown[]>(channel: string, callback: (...args: Args) => unknown) => {
      ipcMain.handle(channel, async (_event, ...args) => {
        await this.ready;
        return callback(...(args as Args));
      });
      this.handlers.push(channel);
    };
    handle(C.snapshot, (cursor?: string) => this.service.snapshot(cursor));
    handle(C.saveSettings, async (value) => {
      await this.service.saveSettings(value);
      return this.service.snapshot();
    });
    handle(C.send, async (request: { text: string; commandId: string }) => {
      if (!request || typeof request.text !== "string" || typeof request.commandId !== "string")
        throw new Error("助手消息参数无效。");
      if (!this.service.settings.enabled) throw new Error("请先在设置中启用助手。");
      // A turn outlives the IPC acknowledgement. Progress and errors arrive as state.
      const accepted = await this.service.enqueue(request.text, "desktop", request.commandId);
      void accepted.completion.catch(deps.reportError);
      return { accepted: true };
    });
    handle(C.cancel, () => this.service.cancel());
    handle(C.draft, (value) => this.service.setDraft(value));
    handle(C.newSession, () => this.service.newSession());
    handle(C.selectSession, (id: string) => this.service.selectSession(id));
    handle(C.respond, (request: { id: string; answer: string }) =>
      this.service.respond(request.id, request.answer),
    );
    handle(C.floating, (visible: boolean) => (visible ? this.windows.showPanel() : this.windows.hidePanel()));
    handle(C.show, async () => {
      this.windows.hidePanel();
      await deps.showMain();
    });
    handle(C.openTask, async (id: string) => {
      this.windows.hidePanel();
      await deps.openThread(id);
    });
    handle(C.wechatBind, () => this.wechat.bind());
    handle(C.wechatDisconnect, () => this.wechat.disconnect());
    handle(C.ballMove, (delta: { x: number; y: number }) => this.windows.moveBall(delta.x, delta.y));
    handle(C.noticeGet, () => this.windows.currentNotice);
    handle(C.noticeOpen, async () => {
      const notice = this.windows.takeNotice();
      if (notice) await deps.openThread(notice.threadId);
    });
  }

  initialize(): Promise<void> {
    this.ready ??= (async () => {
      await this.wechat.load();
      await this.service.initialize();
    })();
    return this.ready;
  }
  get keepsBackground(): boolean {
    return this.service.settings.enabled && this.service.settings.backgroundEnabled;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    for (const channel of this.handlers) ipcMain.removeHandler(channel);
    this.windows.close();
    await this.wechat.setEnabled(false);
    await this.service.close();
    await this.wechat.close();
  }
}
