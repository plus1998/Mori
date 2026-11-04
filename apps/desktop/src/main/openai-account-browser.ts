import { BrowserWindow, session, type Session } from "electron";
import type { AccountBrowserPage } from "./account-browser-page";
import fs from "node:fs/promises";

/** A disk-backed Chromium profile shared by an account's OAuth and ChatGPT tabs. */
export class OpenAIAccountBrowser {
  private readonly work = new Map<string, Promise<unknown>>();
  private readonly profiles = new Map<string, { session: Session; proxyKey: string; releaseProxy: () => void }>();
  private readonly pages = new Map<string, AccountBrowserPage>();

  constructor(private readonly deps: {
    getProfile: (accountId: string) => Promise<{ path: string; name: string; proxyMode: string; proxyUrl?: string }>;
    configureProxy: (session: Session, proxyMode: string, proxyUrl?: string) => Promise<() => void>;
    openPage: (input: { accountId: string; name: string; session: Session; windowed: boolean; presentationLocked: boolean }) => Promise<AccountBrowserPage>;
    closePages: (accountId: string) => Promise<void>;
    reportError: (error: unknown) => void;
  }) {}

  /** Serialize profile setup, tab creation and deletion for each account. */
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
      // Retain the session if configuration fails so a subsequent settings edit
      // can retry applying the proxy to tabs that are still open.
      existing.proxyKey = "";
      try { await ses.closeAllConnections(); }
      finally { existing.releaseProxy(); }
    }
    const releaseProxy = await this.deps.configureProxy(ses, profile.proxyMode, profile.proxyUrl);
    this.profiles.set(accountId, { session: ses, proxyKey, releaseProxy });
    return ses;
  }

  async open(accountId: string): Promise<void> {
    return this.run(accountId, async () => {
      await this.getSession(accountId);
      const existing = this.pages.get(accountId);
      if (existing && !existing.isDestroyed()) {
        existing.focus();
        return;
      }
      const page = await this.createPage(accountId);
      this.pages.set(accountId, page);
      page.onClosed(() => {
        if (this.pages.get(accountId) === page) this.pages.delete(accountId);
      });
      try {
        await page.webContents.loadURL("https://chatgpt.com/");
      } catch (error) {
        await page.close();
        throw error;
      }
    });
  }

  /** Caller serializes this with account deletion and login setup via run(). */
  async createPage(accountId: string, login = false): Promise<AccountBrowserPage> {
    const ses = await this.getSession(accountId);
    const profile = await this.deps.getProfile(accountId);
    const page = await this.deps.openPage({ accountId, name: profile.name, session: ses, windowed: true, presentationLocked: login });
    page.onClosed(() => {
      ses.flushStorageData();
      void ses.cookies.flushStore().catch(this.deps.reportError);
    });
    return page;
  }

  async refreshProxy(accountId: string): Promise<void> {
    if (this.profiles.has(accountId)) await this.getSession(accountId);
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
    await this.deps.closePages(accountId);
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
