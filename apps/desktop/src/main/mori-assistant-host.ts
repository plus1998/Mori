import path from "node:path";
import { BrowserWindow, dialog, ipcMain, type NativeImage } from "electron";
import { MORI_ASSISTANT_CHANNELS as C } from "../shared/mori-assistant";
import type { MoriPetHitMap } from "../shared/mori-pet";
import { type MoriAssistantDeps, MoriAssistantService } from "./mori-assistant-service";
import { MoriAssistantWechat } from "./mori-assistant-wechat";
import { MoriAssistantWindows } from "./mori-assistant-windows";
import { MoriPets } from "./mori-pets";
import { appendUpstreamLogLine } from "./upstream-log";

export class MoriAssistantHost {
  readonly service: MoriAssistantService;
  readonly windows: MoriAssistantWindows;
  readonly wechat: MoriAssistantWechat;
  readonly pets: MoriPets;
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
    this.pets = new MoriPets(deps.dataDir);
    const changed = () => {
      if (this.closed) return;
      this.service?.scheduledActions.reconcileWechatNotifications(id => this.wechat.hasSentNotification(id));
      this.wechat.setWaitingForInput(this.service.isWaitingForInput);
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
      // Always retain presence diagnostics in packaged builds, without payloads or credentials.
      typingDiagnostic: (event, fields) =>
        appendUpstreamLogLine(
          `[mori-wechat-typing] ${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...fields })}\n`,
        ),
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
    this.service.onWechatReply = (text, messageId, id) => {
      this.wechat.setWaitingForInput(this.service.isWaitingForInput);
      return this.wechat.enqueueNotification(text, messageId, id);
    };
    const initialThreads = deps.conversations.listThreads();
    const previousStatuses = new Map(initialThreads.map((thread) => [thread.id, thread.status]));
    const runningThreads = new Set(
      initialThreads.filter((thread) => thread.status === "running").map((thread) => thread.id),
    );
    const pendingThreads = new Set(
      initialThreads
        .filter((thread) => thread.status === "awaiting_plan" || deps.hasPendingTaskInput?.(thread.id))
        .map((thread) => thread.id),
    );
    this.unsubscribe = deps.subscribeTasks((id) => {
      const wasRunning = runningThreads.size > 0;
      const wasPending = pendingThreads.size > 0;
      const status = deps.conversations.getThread(id)?.status;
      const previousStatus = previousStatuses.get(id);
      if (status) previousStatuses.set(id, status);
      else previousStatuses.delete(id);
      if (previousStatus && previousStatus !== status && (status === "completed" || status === "failed"))
        this.windows.showPetReaction(status === "completed" ? "completion" : "failed");
      if (status === "running") runningThreads.add(id);
      else runningThreads.delete(id);
      if (status === "awaiting_plan" || deps.hasPendingTaskInput?.(id)) pendingThreads.add(id);
      else pendingThreads.delete(id);
      if (wasRunning !== runningThreads.size > 0 || wasPending !== pendingThreads.size > 0)
        this.service.capabilitiesChanged();
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
    handle(C.toggleFloating, () => this.windows.togglePanel());
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
    const handlePet = <T>(channel: string, callback: (value: T) => void) => {
      ipcMain.handle(channel, async (event, value: T) => {
        await this.ready;
        if (!this.windows.isPetSender(event.sender.id)) throw new Error("仅宠物窗口可以更新点击范围。");
        callback(value);
      });
      this.handlers.push(channel);
    };
    handlePet(C.petHitMap, (map: MoriPetHitMap) => this.windows.setPetHitMap(map));
    handlePet(C.petDragging, (active: boolean) => this.windows.setPetDragging(active));
    handle(C.noticeGet, () => this.windows.currentNotice);
    handle(C.noticeOpen, async () => {
      const notice = this.windows.takeNotice();
      if (notice) await deps.openThread(notice.threadId);
    });
    handle(C.petList, () => this.pets.list());
    handle(C.petAsset, (key: string) => this.pets.asset(key));
    handle(C.petImport, async () => {
      const result = await dialog.showOpenDialog({
        title: "选择 Codex Pets 宠物文件夹",
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return undefined;
      return this.pets.import(result.filePaths[0]);
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
