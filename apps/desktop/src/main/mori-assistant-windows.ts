import { app, BrowserWindow, globalShortcut, Menu, type NativeImage, screen, Tray } from "electron";
import type { MoriAssistantSettings } from "../shared/mori-assistant";
import type { MoriAssistantStore } from "./mori-assistant-store";

const assistantWindows = new WeakSet<BrowserWindow>();
export function isMoriAssistantWindow(window: BrowserWindow): boolean {
  return assistantWindows.has(window);
}

export class MoriAssistantWindows {
  private ball: BrowserWindow | undefined;
  private panel: BrowserWindow | undefined;
  private tray: Tray | undefined;
  private shortcut: string | undefined;
  private moveTimer: ReturnType<typeof setTimeout> | undefined;
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

  async apply(settings: MoriAssistantSettings): Promise<void> {
    if (settings.enabled && settings.shortcut !== this.shortcut && settings.shortcut) {
      if (
        !globalShortcut.register(settings.shortcut, () => {
          void this.showPanel().catch(this.options.reportError);
        })
      )
        throw new Error("助手快捷键不可用或已被占用，请更换快捷键。");
    }
    if (this.shortcut && (!settings.enabled || this.shortcut !== settings.shortcut))
      globalShortcut.unregister(this.shortcut);
    this.shortcut = settings.enabled ? settings.shortcut : undefined;
    if (settings.enabled && settings.floatingEnabled) await this.showBall();
    else {
      this.ball?.destroy();
      this.ball = undefined;
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

  private async create(mode: "ball" | "panel"): Promise<BrowserWindow> {
    const window = new BrowserWindow({
      width: mode === "ball" ? 64 : 430,
      height: mode === "ball" ? 64 : 640,
      frame: false,
      transparent: mode === "ball",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: mode === "panel",
      minWidth: mode === "ball" ? 64 : 360,
      minHeight: mode === "ball" ? 64 : 420,
      show: false,
      title: "Mori 助手",
      ...(this.options.icon ? { icon: this.options.icon } : {}),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    assistantWindows.add(window);
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
  async showBall(): Promise<void> {
    if (this.creation) return this.creation;
    if (this.ball && !this.ball.isDestroyed()) {
      this.ball.showInactive();
      return;
    }
    this.creation = (async () => {
      const ball = await this.create("ball");
      this.ball = ball;
      const work = screen.getPrimaryDisplay().workArea;
      const saved = this.options.store.state.ballPosition;
      const display = saved ? screen.getDisplayNearestPoint(saved).workArea : work;
      ball.setPosition(
        Math.round(
          Math.min(Math.max(saved?.x ?? work.x + work.width - 90, display.x), display.x + display.width - 64),
        ),
        Math.round(
          Math.min(
            Math.max(saved?.y ?? work.y + work.height - 110, display.y),
            display.y + display.height - 64,
          ),
        ),
      );
      ball.on("moved", () => {
        if (this.moveTimer) clearTimeout(this.moveTimer);
        this.moveTimer = setTimeout(() => {
          if (ball.isDestroyed()) return;
          const { x, y } = ball.getBounds();
          this.options.store.state.ballPosition = { x, y };
          void this.options.store.save().catch(this.options.reportError);
        }, 200);
      });
      ball.showInactive();
    })();
    try {
      await this.creation;
    } finally {
      this.creation = undefined;
    }
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
    const x = Math.max(area.x, Math.min(anchor.x - width + 64, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(anchor.y - height - 12, area.y + area.height - height));
    this.panel.setBounds({ x, y, width, height });
    this.panel.show();
    this.panel.focus();
  }

  hidePanel(): void {
    this.panel?.hide();
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
    this.tray?.destroy();
    this.panel?.destroy();
    this.ball?.destroy();
  }
}
