import { BrowserWindow, session, type BrowserWindowConstructorOptions, type Session } from "electron";
import fs from "node:fs/promises";

/** A disk-backed Chromium profile shared by an account's OAuth and ChatGPT windows. */
export class OpenAIAccountBrowser {
  private readonly work = new Map<string, Promise<unknown>>();
  private readonly profiles = new Map<string, { session: Session; proxyKey: string; releaseProxy: () => void }>();
  private readonly windows = new Map<string, BrowserWindow>();

  constructor(private readonly deps: {
    getProfile: (accountId: string) => Promise<{ path: string; name: string; proxyMode: string; proxyUrl?: string }>;
    configureProxy: (session: Session, proxyMode: string, proxyUrl?: string) => Promise<() => void>;
    reportError: (error: unknown) => void;
  }) {}

  /** Serialize profile setup, window creation and deletion for each account. */
  run<T>(accountId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.work.get(accountId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.work.set(accountId, next);
    void next.finally(() => {
      if (this.work.get(accountId) === next) this.work.delete(accountId);
    }).catch(() => {});
    return next;
  }

  async getSession(accountId: string): Promise<Session> {
    const profile = await this.deps.getProfile(accountId);
    const proxyKey = JSON.stringify([profile.proxyMode, profile.proxyUrl]);
    const existing = this.profiles.get(accountId);
    if (existing?.proxyKey === proxyKey) return existing.session;
    await fs.mkdir(profile.path, { recursive: true });
    const ses = existing?.session ?? session.fromPath(profile.path);
    if (existing) {
      this.profiles.delete(accountId);
      try { await ses.closeAllConnections(); }
      finally { existing.releaseProxy(); }
    }
    const releaseProxy = await this.deps.configureProxy(ses, profile.proxyMode, profile.proxyUrl);
    this.profiles.set(accountId, { session: ses, proxyKey, releaseProxy });
    return ses;
  }

  async open(accountId: string): Promise<void> {
    return this.run(accountId, async () => {
      const ses = await this.getSession(accountId);
      const existing = this.windows.get(accountId);
      if (existing && !existing.isDestroyed()) {
        existing.show();
        existing.focus();
        return;
      }
      const profile = await this.deps.getProfile(accountId);
      const window = new BrowserWindow({
        width: 1100, height: 800, title: `ChatGPT · ${profile.name}`, autoHideMenuBar: true,
        webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      this.windows.set(accountId, window);
      window.on("page-title-updated", event => event.preventDefault());
      window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      this.trackWindow(accountId, window);
      // Keep sign-in popups in the same account profile, without app IPC/preload access.
      window.webContents.setWindowOpenHandler(({ url }) => ({
        action: /^https?:\/\//u.test(url) ? "allow" : "deny",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true },
        } satisfies BrowserWindowConstructorOptions,
      }));
      window.webContents.on("did-create-window", popup => this.trackWindow(accountId, popup));
      try {
        await window.loadURL("https://chatgpt.com/");
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    });
  }

  trackWindow(accountId: string, window: BrowserWindow): void {
    const ses = window.webContents.session;
    window.on("closed", () => {
      if (this.windows.get(accountId) === window) this.windows.delete(accountId);
      ses.flushStorageData();
      void ses.cookies.flushStore().catch(this.deps.reportError);
    });
  }

  /** Must run inside run(), before the service removes the account directory. */
  async clear(accountId: string): Promise<void> {
    const profile = await this.deps.getProfile(accountId);
    const entry = this.profiles.get(accountId);
    if (!entry) {
      try { await fs.stat(profile.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    const ses = entry?.session ?? session.fromPath(profile.path);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && window.webContents.session === ses) window.destroy();
    }
    await ses.closeAllConnections();
    await ses.clearData();
    ses.flushStorageData();
    await ses.cookies.flushStore();
    entry?.releaseProxy();
    this.profiles.delete(accountId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.profiles.values()].map(async entry => {
      try {
        entry.session.flushStorageData();
        await entry.session.cookies.flushStore();
      } finally {
        entry.releaseProxy();
      }
    }));
    this.profiles.clear();
  }
}
