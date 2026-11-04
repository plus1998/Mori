import { BrowserWindow } from "electron";
import type { BrowserHost } from "./browser-host";
import { installBrowserGuestBridge } from "./browser-guest-bridge";

const browserWindows = new WeakSet<BrowserWindow>();
export const isBrowserWindow = (window: BrowserWindow): boolean => browserWindows.has(window);

/** Local browser chrome, with the same sandboxed webview as the work panel. */
export class BrowserWindows {
  private readonly windows = new Map<string, BrowserWindow>();

  constructor(private readonly deps: {
    host: () => BrowserHost;
    preloadPath: string;
    loadRenderer: (window: BrowserWindow, browserId: string) => Promise<void>;
    reportError: (error: unknown) => void;
  }) {}

  get(browserId: string): BrowserWindow | undefined {
    const window = this.windows.get(browserId);
    return window && !window.isDestroyed() ? window : undefined;
  }

  async open(browserId: string): Promise<void> {
    if (this.get(browserId)) return;
    const window = new BrowserWindow({
      width: 1000, height: 760, minWidth: 480, minHeight: 360,
      title: "Mori", show: false, autoHideMenuBar: true,
      webPreferences: {
        preload: this.deps.preloadPath, nodeIntegration: false,
        contextIsolation: true, sandbox: true, webviewTag: true,
      },
    });
    browserWindows.add(window);
    this.windows.set(browserId, window);
    const releaseBridge = installBrowserGuestBridge(window, this.deps.host(), browserId);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("close", event => {
      // BrowserHost owns cancellation and the OAuth callback close guard.
      event.preventDefault();
      void this.deps.host().closeBrowser(browserId).catch(this.deps.reportError);
    });
    window.on("closed", () => {
      releaseBridge();
      if (this.windows.get(browserId) === window) this.windows.delete(browserId);
    });
    try { await this.deps.loadRenderer(window, browserId); }
    catch (error) { this.close(browserId); throw error; }
  }

  focus(browserId: string): void {
    const window = this.get(browserId);
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  close(browserId: string): void {
    const window = this.get(browserId);
    this.windows.delete(browserId);
    window?.destroy();
  }
}
