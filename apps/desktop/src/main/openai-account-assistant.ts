import { BrowserWindow, clipboard, dialog, screen, type Session } from "electron";
import type { AccountBrowserPage } from "./account-browser-page";
import type { I18nKey } from "../shared/i18n-catalogs";
import {
  openAIAccountAssistantTargets,
  openAIAccountAssistantTitleKeys,
  type OpenAIAccountAssistantAction,
  type OpenAIAccountAssistantActionResult,
  type OpenAIAccountAssistantState,
  type OpenAIAccountAssistantTarget,
  type OpenAIAccountProfile,
} from "../shared/openai-account";
import { accountLoginFillScript, generateAccountTotp, isAccountLoginPage, TotpSecretError } from "./openai-account-assistant-data";

function assistantKey(accountId: string, target: OpenAIAccountAssistantTarget): string {
  return `${target}:${accountId}`;
}

export class OpenAIAccountAssistant {
  private readonly windows = new Map<string, { window: BrowserWindow; target: OpenAIAccountAssistantTarget }>();
  private readonly logins = new Map<string, { page: AccountBrowserPage; expiresAt: number | undefined }>();
  private readonly pickupWindows = new Map<string, BrowserWindow>();
  private readonly pickupAccountNames = new Map<string, string>();

  constructor(private readonly deps: {
    getDetails: (accountId: string, target: OpenAIAccountAssistantTarget) => Promise<OpenAIAccountProfile & { name: string; provider?: "claude" }>;
    getClaudeBrowserSession: (accountId: string) => Promise<Session>;
    preloadPath: string;
    loadRenderer: (window: BrowserWindow, accountId: string, target: OpenAIAccountAssistantTarget) => Promise<void>;
    parent: () => BrowserWindow | undefined;
    text: (key: I18nKey, variables?: Record<string, string | number>) => string;
  }) {}

  async open(accountId: string, target: OpenAIAccountAssistantTarget): Promise<void> {
    await this.deps.getDetails(accountId, target);
    const key = assistantKey(accountId, target);
    const existing = this.windows.get(key)?.window;
    if (existing && !existing.isDestroyed()) {
      this.placeHelper(existing, key);
      existing.show();
      existing.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 352, height: 592, minWidth: 352, minHeight: 592,
      title: this.deps.text(openAIAccountAssistantTitleKeys[target]), alwaysOnTop: true, resizable: false, show: false,
      ...(process.platform === "darwin" ? { type: "panel" as const, titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 15 } } : { autoHideMenuBar: true }),
      // The helper remains useful while the login page or another app has focus.
      // Keep its TOTP countdown running rather than throttling background timers.
      webPreferences: { preload: this.deps.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    this.windows.set(key, { window, target });
    window.on("closed", () => this.windows.delete(key));
    // The static HTML carries a <title>; without this Electron would swap the localized window
    // title for that document title as soon as the page loads.
    window.on("page-title-updated", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
      await this.deps.loadRenderer(window, accountId, target);
      this.placeHelper(window, key);
      window.show();
    } catch (error) {
      window.destroy();
      throw error;
    }
  }

  attachLogin(accountId: string, target: OpenAIAccountAssistantTarget, page: AccountBrowserPage, expiresAt?: number): void {
    const key = assistantKey(accountId, target);
    this.logins.set(key, { page, expiresAt });
    page.onClosed(() => {
      if (this.logins.get(key)?.page === page) this.logins.delete(key);
    });
  }

  private placeHelper(assistant: BrowserWindow, key: string): void {
    const loginWindow = this.logins.get(key)?.page.window;
    const main = loginWindow ?? this.deps.parent();
    if (!main || main.isDestroyed()) return;
    const bounds = main.getBounds();
    const helper = assistant.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    if (loginWindow && area.width >= 480 + helper.width + 36) {
      const width = Math.min(bounds.width, area.width - helper.width - 36);
      const height = Math.min(bounds.height, area.height - 24);
      const x = Math.round(area.x + (area.width - width - helper.width - 12) / 2);
      const y = Math.round(area.y + (area.height - height) / 2);
      main.setBounds({ x, y, width, height });
      assistant.setPosition(x + width + 12, y);
      return;
    }
    assistant.setPosition(
      Math.max(area.x, Math.min(bounds.x + bounds.width + 12, area.x + area.width - helper.width)),
      Math.max(area.y, Math.min(bounds.y, area.y + area.height - helper.height)),
    );
  }

  private loginContents(page: AccountBrowserPage | undefined) {
    if (!page || page.isDestroyed()) return undefined;
    try { return page.webContents; }
    catch { return undefined; } // A renderer guest may be temporarily detached.
  }

  async state(accountId: string, target: OpenAIAccountAssistantTarget): Promise<OpenAIAccountAssistantState> {
    const account = await this.deps.getDetails(accountId, target);
    const key = assistantKey(accountId, target);
    const login = this.logins.get(key);
    const assistant = this.windows.get(key)?.window;
    const hasLoginWindow = Boolean(login && !login.page.isDestroyed());
    const contents = this.loginContents(login?.page);
    const state: OpenAIAccountAssistantState = {
      accountId, target, ...(account.provider ? { provider: account.provider } : {}), name: account.name, ...(account.email ? { email: account.email } : {}),
      hasPassword: Boolean(account.password), hasPickupUrl: Boolean(account.pickupUrl),
      hasTwoFactorSecret: Boolean(account.twoFactorSecret),
      canFill: Boolean(contents && isAccountLoginPage(contents.getURL(), account.provider)),
      hasLoginWindow,
      pinned: assistant?.isAlwaysOnTop() ?? true,
    };
    if (hasLoginWindow && login?.expiresAt !== undefined) {
      state.loginRemainingSeconds = Math.max(0, Math.ceil((login.expiresAt - Date.now()) / 1_000));
    }
    if (account.pickupUrl) state.pickupHost = new URL(account.pickupUrl).hostname;
    if (account.twoFactorSecret) {
      try {
        const otp = generateAccountTotp(account.twoFactorSecret);
        state.code = otp.code;
        state.remainingSeconds = otp.remainingSeconds;
      } catch (error) {
        state.codeError = error instanceof TotpSecretError ? this.deps.text(error.key) : error instanceof Error ? error.message : String(error);
      }
    }
    return state;
  }

  /**
   * Native window titles are decided when the window is created, so switching the app language has
   * no effect on a helper that is already open. Re-apply them from the catalog instead of leaving
   * the previous language on screen.
   */
  refreshTitles(): void {
    for (const { window, target } of this.windows.values()) {
      if (!window.isDestroyed()) window.setTitle(this.deps.text(openAIAccountAssistantTitleKeys[target]));
    }
    for (const [accountId, window] of this.pickupWindows) {
      if (window.isDestroyed()) continue;
      window.setTitle(this.deps.text("assistant.inboxWindowTitle", { name: this.pickupAccountNames.get(accountId) ?? "" }));
    }
  }

  async action(accountId: string, target: OpenAIAccountAssistantTarget, action: OpenAIAccountAssistantAction): Promise<OpenAIAccountAssistantActionResult> {
    const account = await this.deps.getDetails(accountId, target);
    const key = assistantKey(accountId, target);
    if (action.type === "togglePin") {
      const window = this.windows.get(key)?.window;
      if (!window || window.isDestroyed()) throw new Error(this.deps.text("assistant.windowClosed"));
      const wasPinned = window.isAlwaysOnTop();
      window.setAlwaysOnTop(!wasPinned);
      return { message: this.deps.text(wasPinned ? "assistant.unpinned" : "assistant.pinned") };
    }
    if (action.type === "revealPassword") {
      if (!account.password) throw new Error(this.deps.text("assistant.noPasswordSaved"));
      return { message: this.deps.text("assistant.passwordRevealed"), value: account.password };
    }
    if (action.type === "openPickup") {
      if (!account.pickupUrl) throw new Error(this.deps.text("assistant.noPickupUrlSaved"));
      const url = new URL(account.pickupUrl);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error(this.deps.text("assistant.pickupUrlInvalid"));
      const claudeSession = account.provider === "claude" ? await this.deps.getClaudeBrowserSession(accountId) : undefined;
      const existing = this.pickupWindows.get(accountId);
      if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return { message: this.deps.text("assistant.inboxOpened") }; }
      const window = new BrowserWindow({
        width: 920, height: 700, title: this.deps.text("assistant.inboxWindowTitle", { name: account.name }), autoHideMenuBar: true,
        // Keep the inbox as a standalone window. On macOS, an owned child
        // window can disappear when it is moved to another display.
        webPreferences: {
          ...(claudeSession ? { session: claudeSession } : { partition: `openai-pickup-${accountId}` }),
          nodeIntegration: false, contextIsolation: true, sandbox: true,
        },
      });
      this.pickupWindows.set(accountId, window);
      this.pickupAccountNames.set(accountId, account.name);
      window.on("closed", () => { this.pickupWindows.delete(accountId); this.pickupAccountNames.delete(accountId); });
      window.on("page-title-updated", (event) => event.preventDefault());
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//u.test(url)) void window.loadURL(url).catch((error: unknown) => {
          dialog.showErrorBox(this.deps.text("assistant.inboxOpenFailed"), error instanceof Error ? error.message : String(error));
        });
        return { action: "deny" };
      });
      try { await window.loadURL(url.href); } catch (error) { window.destroy(); throw error; }
      return { message: this.deps.text("assistant.inboxOpened") };
    }
    if ((action.type !== "copy" && action.type !== "fill") || !["email", "password", "code"].includes(action.field)) {
      throw new Error(this.deps.text("assistant.invalidAction"));
    }
    const label = {
      email: this.deps.text("settings.openaiAccounts.emailField"),
      password: this.deps.text("settings.openaiAccounts.passwordField"),
      code: this.deps.text("assistant.field.code"),
    }[action.field];
    const value = action.field === "code"
      ? account.twoFactorSecret ? generateAccountTotp(account.twoFactorSecret).code : undefined
      : account[action.field];
    if (!value) {
      if (action.field === "code") throw new Error(this.deps.text("assistant.noTwoFactorSaved"));
      if (action.field === "email") throw new Error(this.deps.text("assistant.noEmailSaved"));
      throw new Error(this.deps.text("assistant.noPasswordSaved"));
    }
    if (action.type === "copy") {
      clipboard.writeText(value);
      return { message: this.deps.text("assistant.copiedNamed", { name: label }) };
    }
    const login = this.logins.get(key)?.page;
    const contents = this.loginContents(login);
    const url = contents?.getURL();
    if (!login || !contents || !url || !isAccountLoginPage(url, account.provider)) {
      throw new Error(this.deps.text("assistant.fillNeedsLoginPage"));
    }
    const { origin, pathname } = new URL(url);
    const filled = await contents.executeJavaScript(accountLoginFillScript(action.field, value, origin, pathname), true) as boolean;
    if (!filled) throw new Error(this.deps.text("assistant.fillNoInput", { name: label }));
    login.focus();
    return { message: this.deps.text("assistant.filledNamed", { name: label }) };
  }

  closeAccount(accountId: string): void {
    for (const target of openAIAccountAssistantTargets) {
      const key = assistantKey(accountId, target);
      const window = this.windows.get(key)?.window;
      if (window && !window.isDestroyed()) window.destroy();
      this.windows.delete(key);
      this.logins.delete(key);
    }
    const pickup = this.pickupWindows.get(accountId);
    if (pickup && !pickup.isDestroyed()) pickup.destroy();
    this.pickupWindows.delete(accountId);
    this.pickupAccountNames.delete(accountId);
  }

  dispose(): void {
    for (const { window } of this.windows.values()) {
      if (!window.isDestroyed()) window.close();
    }
    for (const window of this.pickupWindows.values()) {
      if (!window.isDestroyed()) window.close();
    }
    this.windows.clear();
    this.pickupWindows.clear();
    this.logins.clear();
    this.pickupAccountNames.clear();
  }
}
