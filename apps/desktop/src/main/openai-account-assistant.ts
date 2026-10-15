import { BrowserWindow, clipboard, dialog, screen } from "electron";
import type { OpenAIAccountAssistantAction, OpenAIAccountAssistantActionResult, OpenAIAccountAssistantState, OpenAIAccountDetails } from "../shared/openai-account";
import { accountLoginFillScript, generateAccountTotp, isAccountLoginPage } from "./openai-account-assistant-data";

export class OpenAIAccountAssistant {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly loginWindows = new Map<string, BrowserWindow>();
  private readonly loginDeadlines = new Map<string, number>();
  private readonly pickupWindows = new Map<string, BrowserWindow>();

  constructor(private readonly deps: {
    getDetails: (accountId: string) => Promise<OpenAIAccountDetails>;
    preloadPath: string;
    loadRenderer: (window: BrowserWindow, accountId: string) => Promise<void>;
    parent: () => BrowserWindow | undefined;
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
      title: "Codex 登录助手", alwaysOnTop: true, resizable: false, show: false,
      ...(process.platform === "darwin" ? { type: "panel" as const, titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 15 } } : { autoHideMenuBar: true }),
      // The helper remains useful while the login page or another app has focus.
      // Keep its TOTP countdown running rather than throttling background timers.
      webPreferences: { preload: this.deps.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    this.windows.set(accountId, window);
    window.on("closed", () => this.windows.delete(accountId));
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
        state.codeError = error instanceof Error ? error.message : String(error);
      }
    }
    return state;
  }

  async action(accountId: string, action: OpenAIAccountAssistantAction): Promise<OpenAIAccountAssistantActionResult> {
    const account = await this.deps.getDetails(accountId);
    if (action.type === "togglePin") {
      const window = this.windows.get(accountId);
      if (!window || window.isDestroyed()) throw new Error("登录助手已关闭");
      window.setAlwaysOnTop(!window.isAlwaysOnTop());
      return { message: window.isAlwaysOnTop() ? "已置顶" : "已取消置顶" };
    }
    if (action.type === "revealPassword") {
      if (!account.password) throw new Error("未保存密码，请先编辑账号资料");
      return { message: "密码已显示", value: account.password };
    }
    if (action.type === "openPickup") {
      if (!account.pickupUrl) throw new Error("未保存取件地址，请先编辑账号资料");
      const url = new URL(account.pickupUrl);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error("取件地址必须为 HTTP(S) 网页");
      const existing = this.pickupWindows.get(accountId);
      if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return { message: "收件页已打开" }; }
      const window = new BrowserWindow({
        width: 920, height: 700, title: `收件箱 · ${account.name}`, autoHideMenuBar: true,
        // Keep the inbox as a standalone window. On macOS, an owned child
        // window can disappear when it is moved to another display.
        webPreferences: { partition: `openai-pickup-${accountId}`, nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      this.pickupWindows.set(accountId, window);
      window.on("closed", () => this.pickupWindows.delete(accountId));
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//u.test(url)) void window.loadURL(url).catch((error: unknown) => {
          dialog.showErrorBox("收件页打开失败", error instanceof Error ? error.message : String(error));
        });
        return { action: "deny" };
      });
      try { await window.loadURL(url.href); } catch (error) { window.destroy(); throw error; }
      return { message: "收件页已打开" };
    }
    if ((action.type !== "copy" && action.type !== "fill") || !["email", "password", "code"].includes(action.field)) {
      throw new Error("无效的登录助手操作");
    }
    const label = { email: "邮箱", password: "密码", code: "验证码" }[action.field];
    const value = action.field === "code"
      ? account.twoFactorSecret ? generateAccountTotp(account.twoFactorSecret).code : undefined
      : account[action.field];
    if (!value) throw new Error(`未保存${label === "验证码" ? "2FA 密钥" : label}，请先编辑账号资料`);
    if (action.type === "copy") {
      clipboard.writeText(value);
      return { message: `${label}已复制` };
    }
    const login = this.loginWindows.get(accountId);
    if (!login || login.isDestroyed() || !isAccountLoginPage(login.webContents.getURL())) {
      throw new Error("请在 Eco 中打开这个账号的登录页，再使用填入");
    }
    const filled = await login.webContents.executeJavaScript(accountLoginFillScript(action.field, value), true) as boolean;
    if (!filled) throw new Error(`当前登录页没有可填写的${label}输入框，请进入对应步骤`);
    login.focus();
    return { message: `${label}已填入` };
  }

  dispose(): void {
    for (const window of [...this.windows.values(), ...this.pickupWindows.values(), ...this.loginWindows.values()]) {
      if (!window.isDestroyed()) window.close();
    }
    this.windows.clear();
    this.pickupWindows.clear();
    this.loginWindows.clear();
    this.loginDeadlines.clear();
  }
}
