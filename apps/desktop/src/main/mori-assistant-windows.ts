import { app, BrowserWindow, globalShortcut, Menu, type NativeImage, screen, Tray } from "electron";
import {
  MORI_ASSISTANT_CHANNELS,
  MORI_PET_SIZE_MAX,
  MORI_PET_SIZE_MIN,
  type MoriAssistantSettings,
  moriPetSize,
} from "../shared/mori-assistant";
import {
  type MoriPetHitMap,
  moriPetHitTest,
  moriPetLookDirection,
  resizeMoriPetBounds,
} from "../shared/mori-pet";
import type { MoriAssistantStore } from "./mori-assistant-store";

type MoriNotice = { title: string; body: string; threadId: string };

const assistantWindows = new WeakSet<BrowserWindow>();
export function isMoriAssistantWindow(window: BrowserWindow): boolean {
  return assistantWindows.has(window);
}

export class MoriAssistantWindows {
  private ball: BrowserWindow | undefined;
  private panel: BrowserWindow | undefined;
  private noticeWindow: BrowserWindow | undefined;
  private noticeQueue: MoriNotice[] = [];
  private notice: MoriNotice | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeCreation: Promise<void> | undefined;
  private tray: Tray | undefined;
  private shortcut: string | undefined;
  private shortcutSuspended = false;
  private moveTimer: ReturnType<typeof setTimeout> | undefined;
  private lookTimer: ReturnType<typeof setInterval> | undefined;
  private hitTimer: ReturnType<typeof setInterval> | undefined;
  private petHitMap: MoriPetHitMap | undefined;
  private petDragging = false;
  private petIgnoresMouse = false;
  constructor(
    private readonly options: {
      preload: string;
      renderer: string;
      icon?: NativeImage;
      store: MoriAssistantStore;
      showMain(): Promise<void>;
      reportError(error: unknown): void;
    },
  ) {}

  async setShortcutSuspended(suspended: boolean, settings: MoriAssistantSettings): Promise<void> {
    this.shortcutSuspended = suspended;
    await this.apply(settings);
  }

  async apply(settings: MoriAssistantSettings): Promise<void> {
    const shortcut = !this.shortcutSuspended && settings.enabled ? settings.shortcut : "";
    if (shortcut && shortcut !== this.shortcut) {
      if (
        !globalShortcut.register(shortcut, () => {
          void this.showPanel().catch(this.options.reportError);
        })
      )
        throw new Error("助手快捷键不可用或已被占用，请更换快捷键。");
    }
    if (this.shortcut && this.shortcut !== shortcut) globalShortcut.unregister(this.shortcut);
    this.shortcut = shortcut || undefined;
    if (settings.enabled && settings.floatingEnabled) await this.showBall(moriPetSize(settings));
    else {
      this.ball?.destroy();
      this.ball = undefined;
      if (this.lookTimer) clearInterval(this.lookTimer);
      this.lookTimer = undefined;
      if (this.hitTimer) clearInterval(this.hitTimer);
      this.hitTimer = undefined;
      this.petHitMap = undefined;
      this.petDragging = false;
      this.clearNotices();
    }
    if (settings.enabled && settings.backgroundEnabled && !this.tray) {
      if (!this.options.icon) throw new Error("应用图标不可用，暂时无法启用后台运行。");
      this.tray = new Tray(this.options.icon.resize({ width: 18, height: 18 }));
      this.tray.setToolTip("Mori 助手");
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: "与 Mori 对话",
            click: () => {
              void this.showPanel().catch(this.options.reportError);
            },
          },
          {
            label: "打开 Mori",
            click: () => {
              void this.options.showMain().catch(this.options.reportError);
            },
          },
          { type: "separator" },
          { label: "退出 Mori", click: () => app.quit() },
        ]),
      );
      this.tray.on("click", () => {
        void this.showPanel().catch(this.options.reportError);
      });
    } else if ((!settings.enabled || !settings.backgroundEnabled) && this.tray) {
      this.tray.destroy();
      this.tray = undefined;
    }
    if (!settings.enabled) {
      this.panel?.destroy();
      this.panel = undefined;
    }
  }

  private async create(mode: "ball" | "panel" | "notice", ballSize = 64): Promise<BrowserWindow> {
    const window = new BrowserWindow({
      width: mode === "ball" ? ballSize : mode === "notice" ? 280 : 430,
      height: mode === "ball" ? ballSize : mode === "notice" ? 96 : 640,
      frame: false,
      transparent: mode !== "panel",
      hasShadow: mode === "panel",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: mode === "panel",
      minWidth: mode === "ball" ? MORI_PET_SIZE_MIN : mode === "notice" ? 280 : 360,
      minHeight: mode === "ball" ? MORI_PET_SIZE_MIN : mode === "notice" ? 96 : 420,
      show: false,
      title: "Mori 助手",
      ...(this.options.icon ? { icon: this.options.icon } : {}),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: mode !== "ball",
      },
    });
    assistantWindows.add(window);
    if (mode === "ball") {
      this.ball = window;
      this.petHitMap = undefined;
      this.petDragging = false;
      this.petIgnoresMouse = false;
      const resetInput = () => {
        this.petHitMap = undefined;
        this.petDragging = false;
        this.updatePetInput();
      };
      window.webContents.on("did-start-loading", resetInput);
      window.webContents.on("render-process-gone", resetInput);
      window.on("closed", () => {
        if (this.ball !== window) return;
        if (this.hitTimer) clearInterval(this.hitTimer);
        if (this.lookTimer) clearInterval(this.lookTimer);
        this.hitTimer = this.lookTimer = undefined;
        this.ball = undefined;
        this.petHitMap = undefined;
        this.petDragging = false;
      });
      this.updatePetInput();
      this.hitTimer = setInterval(() => this.updatePetInput(), 16);
    }
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("close", (event) => {
      if (mode === "panel") {
        event.preventDefault();
        window.hide();
      }
    });
    if (process.env.VITE_DEV_SERVER_URL) {
      const url = new URL(process.env.VITE_DEV_SERVER_URL);
      url.searchParams.set("mori", mode);
      await window.loadURL(url.href);
    } else await window.loadFile(this.options.renderer, { query: { mori: mode } });
    return window;
  }

  private creation: Promise<void> | undefined;
  async showBall(size: number): Promise<void> {
    if (this.creation) {
      await this.creation;
      this.resizeBall(size);
      return;
    }
    if (this.ball && !this.ball.isDestroyed()) {
      this.resizeBall(size);
      this.ball.showInactive();
      return;
    }
    this.creation = (async () => {
      const ball = await this.create("ball", size);
      this.ball = ball;
      const work = screen.getPrimaryDisplay().workArea;
      const saved = this.options.store.state.ballPosition;
      const display = saved ? screen.getDisplayNearestPoint(saved).workArea : work;
      ball.setPosition(
        Math.round(
          Math.max(
            display.x,
            Math.min(
              Math.max(saved?.x ?? work.x + work.width - size - 26, display.x),
              display.x + display.width - size,
            ),
          ),
        ),
        Math.round(
          Math.min(
            Math.max(saved?.y ?? work.y + work.height - size - 46, display.y),
            Math.max(display.y, display.y + display.height - size),
          ),
        ),
      );
      ball.on("moved", () => {
        this.positionNotice();
        if (this.moveTimer) clearTimeout(this.moveTimer);
        this.moveTimer = setTimeout(() => {
          if (ball.isDestroyed()) return;
          const { x, y } = ball.getBounds();
          this.options.store.state.ballPosition = { x, y };
          void this.options.store.save().catch(this.options.reportError);
        }, 200);
      });
      ball.showInactive();
      let lastDirection: number | null | undefined;
      this.lookTimer = setInterval(() => {
        if (ball.isDestroyed()) {
          if (this.lookTimer) clearInterval(this.lookTimer);
          this.lookTimer = undefined;
          return;
        }
        if (!ball.isVisible()) return;
        const bounds = ball.getBounds();
        const cursor = screen.getCursorScreenPoint();
        const dx = cursor.x - (bounds.x + bounds.width / 2);
        const dy = cursor.y - (bounds.y + bounds.height / 2);
        const distance = Math.hypot(dx, dy);
        const direction =
          distance > bounds.width / 2 + 2 && distance < Math.max(320, bounds.width * 2.5)
            ? moriPetLookDirection(dx, dy)
            : null;
        if (direction === lastDirection) return;
        lastDirection = direction;
        ball.webContents.send(MORI_ASSISTANT_CHANNELS.petLook, direction);
      }, 120);
    })();
    try {
      await this.creation;
    } finally {
      this.creation = undefined;
    }
  }

  isPetSender(webContentsId: number): boolean {
    return !!this.ball && !this.ball.isDestroyed() && this.ball.webContents.id === webContentsId;
  }

  setPetHitMap(map: MoriPetHitMap): void {
    if (
      !map ||
      !Number.isInteger(map.width) ||
      !Number.isInteger(map.height) ||
      map.width < 1 ||
      map.height < 1 ||
      map.width > MORI_PET_SIZE_MAX ||
      map.height > MORI_PET_SIZE_MAX ||
      !(map.alpha instanceof Uint8Array) ||
      map.alpha.length !== map.width * map.height
    )
      throw new Error("宠物点击范围无效。");
    this.petHitMap = map;
    this.updatePetInput();
  }

  setPetDragging(active: boolean): void {
    if (typeof active !== "boolean") throw new Error("宠物拖动状态无效。");
    this.petDragging = active;
    this.updatePetInput();
  }

  private updatePetInput(): void {
    if (!this.ball || this.ball.isDestroyed()) return;
    const bounds = this.ball.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const hit =
      this.petDragging ||
      (this.petHitMap &&
        moriPetHitTest(
          this.petHitMap,
          ((cursor.x - bounds.x) * this.petHitMap.width) / bounds.width,
          ((cursor.y - bounds.y) * this.petHitMap.height) / bounds.height,
        ));
    const ignore = !hit;
    if (ignore === this.petIgnoresMouse) return;
    this.petIgnoresMouse = ignore;
    this.ball.setIgnoreMouseEvents(ignore);
  }

  private resizeBall(size: number): void {
    if (!this.ball || this.ball.isDestroyed()) return;
    const current = this.ball.getBounds();
    if (current.width === size && current.height === size) return;
    const area = screen.getDisplayNearestPoint({
      x: Math.round(current.x + current.width / 2),
      y: Math.round(current.y + current.height / 2),
    }).workArea;
    const bounds = resizeMoriPetBounds(current, size, area);
    this.ball.setBounds(bounds);
    this.updatePetInput();
    this.options.store.state.ballPosition = { x: bounds.x, y: bounds.y };
    this.positionNotice();
  }

  private panelCreation: Promise<BrowserWindow> | undefined;
  async showPanel(): Promise<void> {
    if (!this.panel || this.panel.isDestroyed()) {
      this.panelCreation ??= this.create("panel");
      try {
        this.panel = await this.panelCreation;
      } finally {
        this.panelCreation = undefined;
      }
    }
    const anchor =
      this.ball && !this.ball.isDestroyed()
        ? this.ball.getBounds()
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
    const bounds = this.panel.getBounds();
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    const x = Math.max(
      area.x,
      Math.min(
        anchor.x - width + (this.ball && !this.ball.isDestroyed() ? anchor.width : 64),
        area.x + area.width - width,
      ),
    );
    const y = Math.max(area.y, Math.min(anchor.y - height - 12, area.y + area.height - height));
    this.panel.setBounds({ x, y, width, height });
    this.panel.show();
    this.panel.focus();
  }

  hidePanel(): void {
    this.panel?.hide();
  }
  async togglePanel(): Promise<void> {
    if (this.panelCreation) await this.panelCreation;
    if (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) {
      this.hidePanel();
    } else {
      await this.showPanel();
    }
  }
  get currentNotice(): MoriNotice | undefined {
    return this.notice;
  }
  showPetReaction(kind: "completion" | "failed" | "approval" | "question"): void {
    if (this.ball && !this.ball.isDestroyed())
      this.ball.webContents.send(MORI_ASSISTANT_CHANNELS.petReaction, kind);
  }
  showNotice(notice: MoriNotice, kind: "completion" | "approval" | "question"): void {
    if (!this.ball || this.ball.isDestroyed()) return;
    if (kind !== "completion") this.showPetReaction(kind);
    this.noticeQueue.push(notice);
    void this.showNextNotice().catch(this.options.reportError);
  }
  private async showNextNotice(): Promise<void> {
    if (
      this.notice ||
      this.noticeCreation ||
      !this.noticeQueue.length ||
      !this.ball ||
      this.ball.isDestroyed()
    )
      return;
    this.notice = this.noticeQueue.shift();
    this.noticeCreation = (async () => {
      if (!this.noticeWindow || this.noticeWindow.isDestroyed())
        this.noticeWindow = await this.create("notice");
      if (!this.notice || !this.ball || this.ball.isDestroyed()) {
        this.noticeWindow.destroy();
        this.noticeWindow = undefined;
        return;
      }
      this.positionNotice();
      this.noticeWindow.webContents.send(MORI_ASSISTANT_CHANNELS.changed);
      this.noticeWindow.showInactive();
      this.noticeTimer = setTimeout(() => {
        this.takeNotice();
      }, 12000);
    })();
    try {
      await this.noticeCreation;
    } catch (error) {
      this.notice = undefined;
      this.noticeWindow?.hide();
      throw error;
    } finally {
      this.noticeCreation = undefined;
      if (!this.notice && this.noticeQueue.length) void this.showNextNotice().catch(this.options.reportError);
    }
  }
  takeNotice(): MoriNotice | undefined {
    const notice = this.notice;
    this.notice = undefined;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    this.noticeWindow?.hide();
    void this.showNextNotice().catch(this.options.reportError);
    return notice;
  }
  private positionNotice(): void {
    if (!this.ball || this.ball.isDestroyed() || !this.noticeWindow || this.noticeWindow.isDestroyed())
      return;
    const ball = this.ball.getBounds();
    const area = screen.getDisplayNearestPoint({ x: ball.x, y: ball.y }).workArea;
    const width = 280;
    const height = 96;
    const x = ball.x - width - 4 >= area.x ? ball.x - width - 4 : ball.x + ball.width + 4;
    this.noticeWindow.setPosition(
      Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
      Math.round(
        Math.max(area.y, Math.min(ball.y + (ball.height - height) / 2, area.y + area.height - height)),
      ),
    );
  }
  private clearNotices(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    this.notice = undefined;
    this.noticeQueue = [];
    this.noticeWindow?.destroy();
    this.noticeWindow = undefined;
  }
  moveBall(dx: number, dy: number): void {
    if (
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      Math.abs(dx) > 500 ||
      Math.abs(dy) > 500 ||
      !this.ball ||
      this.ball.isDestroyed()
    )
      return;
    const { x, y } = this.ball.getBounds();
    this.ball.setPosition(Math.round(x + dx), Math.round(y + dy));
  }

  close(): void {
    if (this.shortcut) globalShortcut.unregister(this.shortcut);
    if (this.moveTimer) clearTimeout(this.moveTimer);
    if (this.lookTimer) clearInterval(this.lookTimer);
    if (this.hitTimer) clearInterval(this.hitTimer);
    this.tray?.destroy();
    this.panel?.destroy();
    this.ball?.destroy();
    this.clearNotices();
  }
}
