import { BrowserWindow, session, type Session, type WebContents } from "electron";
import type { AccountBrowserPage } from "./account-browser-page";
import fs from "node:fs/promises";
import { ChatGptWebSessionError, parseChatGptWebSession } from "./chatgpt-web-session";

const backgroundWindows = new WeakSet<BrowserWindow>();
export const isOpenAIAccountBackgroundWindow = (window: BrowserWindow): boolean => backgroundWindows.has(window);

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

  /** Fetch in an account page so Chromium can renew cookies and handle proxy auth. */
  async readWebSession(accountId: string, expectedEmail?: string, contents?: WebContents) {
    const ses = await this.getSession(accountId);
    const hidden = contents ? undefined : new BrowserWindow({
      show: false, webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    if (hidden) {
      backgroundWindows.add(hidden);
      hidden.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    }
    const page = contents ?? hidden!.webContents;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          if (hidden) await page.loadURL("https://chatgpt.com/");
          if (new URL(page.getURL()).origin !== "https://chatgpt.com") {
            throw new ChatGptWebSessionError("请在账号浏览器中完成 ChatGPT Web 登录。", true, true);
          }
          const result = await page.executeJavaScript(`(async () => {
            const response = await fetch("https://chatgpt.com/api/auth/session", {
              credentials: "include", mode: "same-origin", cache: "no-store", redirect: "error",
              signal: AbortSignal.timeout(20000), headers: { Accept: "application/json" }
            });
            const json = response.headers.get("content-type")?.includes("application/json");
            return { status: response.status, json, body: json ? await response.json() : null };
          })()`) as { status: number; json: boolean; body: unknown };
          if (result.status !== 200) throw new ChatGptWebSessionError(
            `ChatGPT Web 会话刷新失败（HTTP ${result.status}），请打开 Web 检查登录或验证。`,
            result.status === 401, result.status === 401,
          );
          if (!result.json) throw new ChatGptWebSessionError("ChatGPT Web 会话接口返回了验证页面，请打开 Web 完成验证。");
          return parseChatGptWebSession(result.body, expectedEmail);
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ChatGptWebSessionError("ChatGPT Web 会话刷新超时，请打开 Web 检查网络或验证。")), 30_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      hidden?.destroy();
    }
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
