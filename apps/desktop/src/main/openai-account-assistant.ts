import { BrowserWindow, clipboard, dialog, screen } from "electron";
import type { I18nKey } from "../shared/i18n-catalogs";
import type { OpenAIAccountAssistantAction, OpenAIAccountAssistantActionResult, OpenAIAccountAssistantState, OpenAIAccountDetails } from "../shared/openai-account";
import { accountLoginFillScript, generateAccountTotp, isAccountLoginPage, TotpSecretError } from "./openai-account-assistant-data";

export class OpenAIAccountAssistant {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly loginWindows = new Map<string, BrowserWindow>();
  private readonly loginDeadlines = new Map<string, number>();
  private readonly pickupWindows = new Map<string, BrowserWindow>();
  private readonly pickupAccountNames = new Map<string, string>();

  constructor(private readonly deps: {
    getDetails: (accountId: string) => Promise<OpenAIAccountDetails>;
    preloadPath: string;
    loadRenderer: (window: BrowserWindow, accountId: string) => Promise<void>;
    parent: () => BrowserWindow | undefined;
    text: (key: I18nKey, variables?: Record<string, string | number>) => string;
  }) {}

  async open(accountId: string): Promise<void> {
    await this.deps.getDetails(accountId);
    const existing = this.windows.get(accountId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 352, height: 592, minWidth: 352, minHeight: 592,
      title: this.deps.text("assistant.windowTitle"), alwaysOnTop: true, resizable: false, show: false,
      ...(process.platform === "darwin" ? { type: "panel" as const, titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 15 } } : { autoHideMenuBar: true }),
      // The helper remains useful while the login page or another app has focus.
      // Keep its TOTP countdown running rather than throttling background timers.
      webPreferences: { preload: this.deps.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    this.windows.set(accountId, window);
    window.on("closed", () => this.windows.delete(accountId));
    // The static HTML carries a <title>; without this Electron would swap the localized window
    // title for that document title as soon as the page loads.
    window.on("page-title-updated", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
      await this.deps.loadRenderer(window, accountId);
      this.placeLoginPair(accountId, window, "login");
      window.show();
    } catch (error) {
      window.destroy();
      throw error;
    }
  }

  attachLogin(accountId: string, window: BrowserWindow, expiresAt?: number): void {
    this.loginWindows.set(accountId, window);
    if (expiresAt !== undefined) this.loginDeadlines.set(accountId, expiresAt);
    else this.loginDeadlines.delete(accountId);
    window.on("closed", () => {
      if (this.loginWindows.get(accountId) !== window) return;
      this.loginWindows.delete(accountId);
      this.loginDeadlines.delete(accountId);
    });
    const assistant = this.windows.get(accountId);
    if (assistant && !assistant.isDestroyed()) this.placeLoginPair(accountId, assistant, "assistant");
  }

  private placeLoginPair(accountId: string, assistant: BrowserWindow, anchor: "assistant" | "login"): void {
    const login = this.loginWindows.get(accountId);
    if (!login || login.isDestroyed()) return;
    const loginBounds = login.getBounds();
    const assistantBounds = assistant.getBounds();
    const anchorBounds = anchor === "assistant" ? assistantBounds : loginBounds;
    const area = screen.getDisplayMatching(anchorBounds).workArea;
    const gap = 5;
    const preferredLeft = anchor === "assistant" ? assistantBounds.x - loginBounds.width - gap : loginBounds.x;
    const pairWidth = loginBounds.width + gap + assistantBounds.width;
    const pairHeight = Math.max(loginBounds.height, assistantBounds.height);
    // Clamp the pair together so a screen edge cannot collapse the gap or
    // independently move one window down and break their top alignment.
    const left = Math.max(area.x, Math.min(preferredLeft, area.x + area.width - pairWidth));
    const top = Math.max(area.y, Math.min(anchorBounds.y, area.y + area.height - pairHeight));
    login.setPosition(left, top);
    assistant.setPosition(left + loginBounds.width + gap, top);
  }

  async state(accountId: string): Promise<OpenAIAccountAssistantState> {
    const account = await this.deps.getDetails(accountId);
    const login = this.loginWindows.get(accountId);
    const assistant = this.windows.get(accountId);
    const hasLoginWindow = Boolean(login && !login.isDestroyed());
    const state: OpenAIAccountAssistantState = {
      accountId, name: account.name, ...(account.email ? { email: account.email } : {}),
      hasPassword: Boolean(account.password), hasPickupUrl: Boolean(account.pickupUrl),
      hasTwoFactorSecret: Boolean(account.twoFactorSecret),
      canFill: Boolean(hasLoginWindow && login && isAccountLoginPage(login.webContents.getURL())),
      hasLoginWindow,
      pinned: assistant?.isAlwaysOnTop() ?? true,
    };
    if (hasLoginWindow) {
      const expiresAt = this.loginDeadlines.get(accountId);
      if (expiresAt !== undefined) {
        state.loginRemainingSeconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
      }
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
    const assistantTitle = this.deps.text("assistant.windowTitle");
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.setTitle(assistantTitle);
    }
    for (const [accountId, window] of this.pickupWindows) {
      if (window.isDestroyed()) continue;
      window.setTitle(this.deps.text("assistant.inboxWindowTitle", { name: this.pickupAccountNames.get(accountId) ?? "" }));
    }
  }

  async action(accountId: string, action: OpenAIAccountAssistantAction): Promise<OpenAIAccountAssistantActionResult> {
    const account = await this.deps.getDetails(accountId);
    if (action.type === "togglePin") {
      const window = this.windows.get(accountId);
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
      const existing = this.pickupWindows.get(accountId);
      if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return { message: this.deps.text("assistant.inboxOpened") }; }
      const window = new BrowserWindow({
        width: 920, height: 700, title: this.deps.text("assistant.inboxWindowTitle", { name: account.name }), autoHideMenuBar: true,
        // Keep the inbox as a standalone window. On macOS, an owned child
        // window can disappear when it is moved to another display.
        webPreferences: { partition: `openai-pickup-${accountId}`, nodeIntegration: false, contextIsolation: true, sandbox: true },
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
    const login = this.loginWindows.get(accountId);
    if (!login || login.isDestroyed() || !isAccountLoginPage(login.webContents.getURL())) {
      throw new Error(this.deps.text("assistant.fillNeedsLoginPage"));
    }
    const filled = await login.webContents.executeJavaScript(accountLoginFillScript(action.field, value), true) as boolean;
    if (!filled) throw new Error(this.deps.text("assistant.fillNoInput", { name: label }));
    login.focus();
    return { message: this.deps.text("assistant.filledNamed", { name: label }) };
  }

  dispose(): void {
    for (const window of [...this.windows.values(), ...this.pickupWindows.values(), ...this.loginWindows.values()]) {
      if (!window.isDestroyed()) window.close();
    }
    this.windows.clear();
    this.pickupWindows.clear();
    this.loginWindows.clear();
    this.loginDeadlines.clear();
    this.pickupAccountNames.clear();
  }
}
