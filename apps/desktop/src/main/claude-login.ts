import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AccountBrowserPage } from "./account-browser-page";
import { isClaudeLoginAccountId, type ClaudeLoginAccount, type ClaudeLoginProfileInput } from "../shared/claude-login";
import { webChatProxyConfig } from "../shared/web-chat-list";
import { buildCodexProxyEnv } from "./codex-proxy";
import { ClaudeSessionKeyConnectionError, exchangeClaudeSessionKey, validateClaudeSessionKey, type ClaudeSessionKeyNetwork } from "./claude-session-key-oauth";
import { startSocksToHttpBridge } from "./socks-http-bridge";

type Profile = ClaudeLoginProfileInput & { id: string };

const LAUNCHER_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const CLI_TIMEOUT_MS = 12_000;

function validatedInput(input: ClaudeLoginProfileInput): ClaudeLoginProfileInput {
  if (typeof input?.name !== "string" || typeof input?.proxy !== "string") throw new Error("Claude 账号参数无效。");
  const name = input.name.trim();
  const proxy = input.proxy.trim();
  if (!name || name.length > 100) throw new Error("请填写 1 至 100 个字符的账号名称。");
  const config = webChatProxyConfig(proxy);
  if (config.proxyRules?.startsWith("socks4:")) throw new Error("Claude 登录代理支持 HTTP、HTTPS 和 SOCKS5。");
  const signInProfile: NonNullable<ClaudeLoginProfileInput["signInProfile"]> = {};
  for (const field of ["email", "pickupUrl"] as const) {
    const value = input.signInProfile?.[field];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string") throw new Error("Claude 登录资料无效。");
    signInProfile[field] = value.trim();
  }
  if (signInProfile.pickupUrl && !["https:", "http:"].includes(URL.parse(signInProfile.pickupUrl)?.protocol ?? "")) {
    throw new Error("收件地址须为 HTTP 或 HTTPS 链接。");
  }
  return { name, proxy: config.mode === "fixed_servers" ? new URL(proxy).href : proxy, signInProfile };
}

function systemProxyUrl(resolution: string): string | undefined {
  const first = resolution.split(";", 1)[0]?.trim();
  if (first === "DIRECT") return undefined;
  const match = /^(PROXY|HTTP|HTTPS|SOCKS5) (\S+)$/u.exec(first ?? "");
  if (!match?.[2]) throw new Error("Claude Code 无法使用系统返回的代理，请为此账号指定代理。");
  const protocol = match[1] === "HTTPS" ? "https" : match[1] === "SOCKS5" ? "socks5" : "http";
  return validatedInput({ name: "Claude", proxy: `${protocol}://${match[2]}` }).proxy;
}

function authUrl(value: string): { href: string; callbackOrigin: string } {
  const url = new URL(value.replace(/^MORI_CLAUDE_AUTH_URL=/u, "").trim());
  const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
  if (url.protocol !== "https:" || !["claude.com", "claude.ai"].includes(url.hostname)
    || url.username || url.password || url.port || !url.searchParams.get("state")
    || callback.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)
    || !callback.port || callback.pathname !== "/callback" || callback.username || callback.password) {
    throw new Error("Claude Code 返回了无效的登录地址。");
  }
  return { href: url.href, callbackOrigin: callback.origin };
}

function canNavigate(url: string, callbackOrigin: string): boolean {
  const target = URL.parse(url);
  return Boolean(target && (target.protocol === "https:" || (
    target.origin === callbackOrigin && target.pathname === "/callback"
  )));
}

export async function prepareClaudeBrowser(page: AccountBrowserPage): Promise<void> {
  const contents = page.webContents;
  // Initialize the guest renderer before applying its language and time zone settings.
  await contents.loadURL("about:blank");
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  await contents.debugger.sendCommand("Emulation.setUserAgentOverride", { userAgent: "", acceptLanguage: "en-US,en" });
  await contents.debugger.sendCommand("Emulation.setLocaleOverride", { locale: "en_US" });
  await contents.debugger.sendCommand("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
}

function launch(executable: string, args: string[], configDir: string, env: NodeJS.ProcessEnv, signal: AbortSignal, captureOutput = false) {
  const child = spawn(executable, args, {
    cwd: configDir, env, signal, windowsHide: true, stdio: ["ignore", captureOutput ? "pipe" : "ignore", "ignore"],
  });
  let stdout = "";
  child.stdout?.setEncoding("utf8").on("data", chunk => { if (stdout.length < 16_384) stdout += chunk; });
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    let error: Error | undefined;
    child.once("error", failure => { error = failure; });
    child.once("close", code => {
      if (error) reject(error);
      else resolve({ code, stdout });
    });
  });
}

export class ClaudeLoginService {
  private readonly operations = new Map<string, { login: boolean; controller: AbortController; done: Promise<void> }>();

  constructor(
    private readonly root: string,
    private readonly resolveExecutable: () => string,
    private readonly resolveSystemProxy: () => Promise<string>,
    private readonly browser: {
      open: (id: string, allowNavigation: (url: string) => boolean) => Promise<AccountBrowserPage>;
      attachAssistant: (id: string, page: AccountBrowserPage, expiresAt: number) => Promise<void>;
      clear: (id: string) => Promise<void>;
    },
    private readonly openSessionKeyNetwork: (id: string, proxyUrl?: string) => Promise<ClaudeSessionKeyNetwork>,
    private readonly web: {
      open: (id: string) => Promise<void>;
      hasSession: (id: string) => Promise<boolean>;
      clear: (id: string) => Promise<void>;
    },
  ) {}

  async list(): Promise<ClaudeLoginAccount[]> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.root);
    const profiles = await Promise.all(entries.filter(isClaudeLoginAccountId).map(id =>
      this.read(id).catch(error => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      })));
    const accounts = await Promise.all(profiles.filter(profile => profile !== undefined).map(async (profile): Promise<ClaudeLoginAccount> => {
      const [code, webStatus] = await Promise.all([
        this.operations.get(profile.id)?.login
          ? { status: "signingIn" as const }
          : this.status(profile.id).catch(() => ({ status: "unavailable" as const })),
        this.web.hasSession(profile.id).then(present => present ? "hasSession" as const : "noSession" as const)
          .catch(() => "unavailable" as const),
      ]);
      return { id: profile.id, name: profile.name, proxy: profile.proxy, ...code, webStatus };
    }));
    return accounts.sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(input: ClaudeLoginProfileInput, accountId?: string): Promise<string> {
    const id = accountId ?? `claude-${randomUUID()}`;
    const profile = { ...validatedInput(input), id };
    await this.withOperation(id, async () => {
      if (accountId !== undefined) await this.read(id);
      const dir = this.profileDir(id);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, "profile.json");
      const temporary = path.join(dir, "profile.next.json");
      await fs.writeFile(temporary, JSON.stringify(profile), { mode: 0o600 });
      await fs.rename(temporary, file);
    });
    return id;
  }

  async login(id: string): Promise<boolean> {
    let completed = false;
    await this.withOperation(id, async (signal) => {
      const profile = await this.read(id);
      const executable = this.resolveExecutable();
      const configDir = await this.configDir(id);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mori-claude-auth-"));
      const windows = process.platform === "win32";
      const launcher = path.join(directory, windows ? "browser.cmd" : "browser");
      const output = path.join(directory, "url");
      const browserAbort = new AbortController();
      const expiresAt = Date.now() + LOGIN_TIMEOUT_MS;
      const loginSignal = AbortSignal.any([signal, browserAbort.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)]);
      let page: AccountBrowserPage | undefined;
      let stopWatchingClose: (() => void) | undefined;
      let socks: Awaited<ReturnType<typeof startSocksToHttpBridge>> | undefined;
      let result: ReturnType<typeof launch> | undefined;
      try {
        await fs.writeFile(launcher, windows
          ? '@echo off\r\nset "MORI_CLAUDE_AUTH_URL=%~1"\r\n>"%MORI_CLAUDE_AUTH_OUTPUT%" set MORI_CLAUDE_AUTH_URL\r\n'
          : '#!/bin/sh\numask 077\nprintf "%s\\n" "$1" > "$MORI_CLAUDE_AUTH_OUTPUT"\n', { mode: 0o700 });
        const upstream = await this.resolveLoginProxy(profile);
        if (upstream?.startsWith("socks5:")) socks = await startSocksToHttpBridge(upstream);
        const endpoint = socks ? `http://127.0.0.1:${socks.port}` : upstream;
        const env = buildCodexProxyEnv(this.cliEnv(configDir), endpoint ? { mode: "proxy", url: endpoint } : { mode: "direct" });
        result = launch(executable, ["auth", "login", "--claudeai"], configDir, {
          ...env, BROWSER: launcher, MORI_CLAUDE_AUTH_OUTPUT: output,
        }, loginSignal);
        const url = await Promise.race([
          this.waitForLauncher(output, AbortSignal.any([loginSignal, AbortSignal.timeout(LAUNCHER_TIMEOUT_MS)])),
          result.then(() => { throw new Error("Claude Code 未将登录页交给账号浏览器。"); }),
        ]);
        loginSignal.throwIfAborted();
        page = await this.browser.open(id, target => canNavigate(target, url.callbackOrigin));
        stopWatchingClose = page.onClosed(() => browserAbort.abort());
        loginSignal.throwIfAborted();
        await prepareClaudeBrowser(page);
        loginSignal.throwIfAborted();
        await this.browser.attachAssistant(id, page, expiresAt);
        loginSignal.throwIfAborted();
        await Promise.race([
          page.webContents.loadURL(url.href).then(() => result!, () => {
            throw new Error("Claude 登录页加载失败，请检查账号代理。");
          }),
          result,
        ]).then(({ code }) => {
          if (code !== 0) throw new Error("Claude Code 授权失败，请检查登录页面和账号代理。");
        });
        if ((await this.status(id)).status !== "signedIn") throw new Error("Claude Code 未确认订阅账号登录。");
        completed = true;
      } catch (error) {
        if (!signal.aborted && !browserAbort.signal.aborted) {
          if (loginSignal.aborted) throw new Error("Claude Code 登录超时。");
          throw error;
        }
      } finally {
        browserAbort.abort();
        await result?.catch(() => {});
        stopWatchingClose?.();
        try {
          await page?.close();
        } finally {
          socks?.close();
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
    }, true);
    return completed;
  }

  async loginWithSessionKey(id: string, value: string): Promise<boolean> {
    const sessionKey = validateClaudeSessionKey(value);
    let completed = false;
    await this.withOperation(id, async signal => {
      const loginSignal = AbortSignal.any([signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)]);
      let socks: Awaited<ReturnType<typeof startSocksToHttpBridge>> | undefined;
      let network: ClaudeSessionKeyNetwork | undefined;
      try {
        const profile = await this.read(id);
        const executable = this.resolveExecutable();
        const configDir = await this.configDir(id);
        const upstream = await this.resolveLoginProxy(profile);
        if (upstream?.startsWith("socks5:")) socks = await startSocksToHttpBridge(upstream);
        const endpoint = socks ? `http://127.0.0.1:${socks.port}` : upstream;
        network = await this.openSessionKeyNetwork(id, endpoint);
        const { refreshToken, scopes } = await exchangeClaudeSessionKey(network.fetch, sessionKey, loginSignal);
        loginSignal.throwIfAborted();
        const env = buildCodexProxyEnv(this.cliEnv(configDir), endpoint ? { mode: "proxy", url: endpoint } : { mode: "direct" });
        const result = await launch(executable, ["auth", "login", "--claudeai"], configDir, {
          ...env,
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken,
          CLAUDE_CODE_OAUTH_SCOPES: scopes,
        }, loginSignal);
        if (result.code !== 0) throw new Error("Claude Code 未能用换取的 OAuth refresh token 登录。");
        if ((await this.status(id)).status !== "signedIn") throw new Error("Claude Code 未确认订阅账号登录。");
        completed = true;
      } catch (error) {
        if (signal.aborted) return;
        if (loginSignal.aborted) throw new Error("Claude sessionKey 登录超时。");
        if (error instanceof ClaudeSessionKeyConnectionError) {
          const failure = socks?.getLastFailure();
          if (failure?.code === "ETIMEDOUT" && failure.phase !== "tunnel") {
            const stage = failure.phase === "socks-handshake" ? "握手" : "TCP 连接";
            throw new Error(`${error.step}失败，账号的 SOCKS5 代理${stage}超时（${Math.round(failure.elapsedMs / 1000)} 秒）。`);
          }
        }
        throw error;
      } finally {
        try {
          await network?.close();
        } finally {
          socks?.close();
        }
      }
    }, true);
    return completed;
  }

  private async resolveLoginProxy(profile: Profile): Promise<string | undefined> {
    if (profile.proxy === "direct") return undefined;
    return profile.proxy || systemProxyUrl(await this.resolveSystemProxy());
  }

  async cancel(id: string): Promise<void> {
    const operation = this.operations.get(id);
    if (!operation?.login) return;
    operation.controller.abort();
    await operation.done;
  }

  dispose(): void {
    for (const operation of this.operations.values()) operation.controller.abort();
  }

  async openWeb(id: string): Promise<void> {
    await this.withOperation(id, async () => {
      await this.read(id);
      await this.web.open(id);
    });
  }

  async logoutWeb(id: string): Promise<void> {
    await this.withOperation(id, async () => {
      await this.read(id);
      await this.web.clear(id);
    });
  }

  async logout(id: string, remove = false): Promise<void> {
    await this.withOperation(id, async (signal) => {
      await this.read(id);
      const configDir = await this.configDir(id);
      const result = await launch(this.resolveExecutable(), ["auth", "logout"], configDir, this.cliEnv(configDir),
        AbortSignal.any([signal, AbortSignal.timeout(CLI_TIMEOUT_MS)]));
      if (result.code !== 0) throw new Error("Claude Code 退出登录失败。");
      if (remove) {
        await this.browser.clear(id);
        await fs.rm(configDir, { recursive: true, force: true });
        await fs.unlink(path.join(this.profileDir(id), "profile.json"));
      }
    });
  }

  private async status(id: string): Promise<Pick<ClaudeLoginAccount, "status" | "email">> {
    const configDir = await this.configDir(id);
    const result = await launch(this.resolveExecutable(), ["auth", "status"], configDir, this.cliEnv(configDir),
      AbortSignal.timeout(CLI_TIMEOUT_MS), true);
    const info = JSON.parse(result.stdout);
    if (info.configDirectory !== configDir || ![0, 1].includes(result.code ?? -1)
      || (info.loggedIn === true && info.authMethod !== "claude.ai")) {
      throw new Error("Claude Code 未使用该目录的 Claude 订阅账号。");
    }
    return info.loggedIn === true && info.authMethod === "claude.ai"
      ? { status: "signedIn", ...(typeof info.email === "string" ? { email: info.email } : {}) }
      : { status: "signedOut" };
  }

  async read(id: string): Promise<Profile> {
    return { ...validatedInput(JSON.parse(await fs.readFile(path.join(this.profileDir(id), "profile.json"), "utf8"))), id };
  }

  private profileDir(id: string): string {
    if (!isClaudeLoginAccountId(id)) throw new Error("Claude 账号 ID 无效。");
    return path.join(this.root, id);
  }

  private async configDir(id: string): Promise<string> {
    const directory = path.join(this.profileDir(id), "cli");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  private cliEnv(configDir: string): NodeJS.ProcessEnv {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|BROWSER$|NODE_OPTIONS$|BUN_OPTIONS$)/iu.test(key)));
    return { ...buildCodexProxyEnv(clean, { mode: "direct" }), CLAUDE_CONFIG_DIR: configDir };
  }

  private async withOperation(id: string, action: (signal: AbortSignal) => Promise<void>, login = false): Promise<void> {
    this.profileDir(id);
    if (this.operations.has(id)) throw new Error("此 Claude 账号正在执行其他操作。");
    const controller = new AbortController();
    const done = Promise.resolve().then(() => action(controller.signal)).finally(() => { this.operations.delete(id); });
    this.operations.set(id, { controller, login, done });
    await done;
  }

  private async waitForLauncher(file: string, signal: AbortSignal): Promise<ReturnType<typeof authUrl>> {
    while (!signal.aborted) {
      const value = await fs.readFile(file, "utf8").catch(error => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
      if (value.endsWith("\n")) {
        await fs.unlink(file);
        try { return authUrl(value); }
        catch { throw new Error("Claude Code 返回了无效的登录地址。"); }
      }
      await delay(100, undefined, { signal }).catch(() => {});
    }
    throw new Error("Claude Code 未将登录页交给账号浏览器。");
  }
}
