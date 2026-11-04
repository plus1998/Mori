import { AccountWakeBatches } from "./account-wake-batches";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { SocksClient } from "socks";
import type { AccountUsageRecord } from "./account-usage-store";
import type {
  OpenAIAccount as OpenAIAccountShared,
  OpenAIAccountCreateInput,
  OpenAIAccountDetails,
  OpenAIAccountProxyConfig,
  OpenAIAccountProxyMode,
  OpenAIAccountQuota,
  OpenAIAccountImageQuota,
  OpenAIAccountUpdateInput,
  OpenAIAccountWakeResult,
} from "../shared/openai-account";
import { OpenAIAccountStore } from "./openai-account-store";
import { startCodexBrowserLogin, type CodexBrowserLogin } from "./codex-browser-login";
import {
  withIsolatedCodexAccountClient,
  readCodexAccountQuota,
  type CodexQuotaClient,
} from "./codex-account-quota";
import { CodexQuotaRefreshPolicy, type QuotaRefreshReason } from "./codex-quota-refresh-policy";
import { mergeCodexQuotaUpdate } from "./codex-quota-update";
import { wakeCodexAccount } from "./codex-account-wake";
import { isCodexReauthenticationRequired } from "./codex-reauthentication";
import { queryReadonlyAccountQuotas, readReadonlyQuota, ReadonlyQuotaError, redactAccountSummaryStrings } from "./readonly-account-quota";
import {
  buildCodexProxyEnv,
  resolveCodexProxyUrl,
  type CodexProxyEnvironment,
  type SystemProxyResolver,
} from "./codex-proxy";

export type { OpenAIAccount, OpenAIAccountQuota } from "../shared/openai-account";

/**
 * OpenAI Account Management Service
 *
 * Stores account data and raw auth.json content in eco-coding.sqlite. The
 * Main-process credential operations own refresh tokens. Each conversation
 * selects an account explicitly and receives only that account’s access token.
 *
 * Directory structure:
 *   <userData>/eco-coding.sqlite
 */

type OpenAIAccount = OpenAIAccountShared;

export interface OpenAIAccountLoginResult {
  success: boolean;
  message: string;
}

const ACCOUNT_ID_PATTERN = /^oa_[A-Za-z0-9_-]+$/;

function assertProxyMode(value: unknown): asserts value is OpenAIAccountProxyMode | undefined {
  if (value !== undefined && value !== "system" && value !== "direct" && value !== "manual") {
    throw new Error("账号代理模式无效。");
  }
}

function parseAuthJson(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("JSON 格式无效");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("auth.json 必须是 JSON 对象");
  }
  const auth = parsed as Record<string, unknown>;
  const tokens = typeof auth.tokens === "object" && auth.tokens !== null
    ? (auth.tokens as Record<string, unknown>)
    : undefined;
  const accessToken = tokens?.access_token ?? auth.access_token;
  const accountId = tokens?.account_id ?? auth.account_id;
  if (typeof accessToken !== "string" || !accessToken.trim() || typeof accountId !== "string" || !accountId.trim()) {
    throw new Error("格式无效：缺少 access_token 或 account_id");
  }
  return auth;
}

function contentFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function decodeJwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof parsed.exp === "number" && Number.isFinite(parsed.exp) ? parsed.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `auth.json`'s refresh stamp in integer microseconds. Codex can write fractional
 * ISO timestamps past millisecond precision; Date.parse alone would treat those
 * as equal and could choose the wrong credential copy.
 */
export function readAuthRefreshStamp(content: string): number | undefined {
  try {
    const parsed = JSON.parse(content) as { last_refresh?: unknown };
    if (typeof parsed.last_refresh !== "string") return undefined;
    const ms = Date.parse(parsed.last_refresh);
    if (Number.isNaN(ms)) return undefined;
    const fractional = parsed.last_refresh.match(/\.(\d+)(?=Z|[+-]\d{2}:?\d{2}$)/i)?.[1] ?? "";
    const microsWithinMillisecond = fractional.slice(3, 6).padEnd(3, "0");
    return ms * 1_000 + (microsWithinMillisecond ? Number(microsWithinMillisecond) : 0);
  } catch {
    return undefined;
  }
}

/** ChatGPT account id inside `auth.json` — the guard against copying tokens across accounts. */
export function readAuthAccountId(content: string): string | undefined {
  try {
    const auth = JSON.parse(content) as { account_id?: unknown; tokens?: { account_id?: unknown } };
    const accountId = auth.tokens?.account_id ?? auth.account_id;
    return typeof accountId === "string" ? accountId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start a local HTTP CONNECT proxy that tunnels through SOCKS5 (with auth).
 * Returns { port, close } for the local server.
 */
export function startSocksToHttpBridge(proxyUrl: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(proxyUrl);
    const socksHost = parsed.hostname;
    const socksPort = Number(parsed.port) || 1080;
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;

    const server = http.createServer();

    server.on("connect", (req, clientSocket, head) => {
      const requestTarget = req.url;
      if (!requestTarget) {
        clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      console.log(`[socks-bridge] CONNECT request: ${requestTarget}`);
      const [targetHost, targetPort] = requestTarget.split(":");
      if (!targetHost) {
        clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      const port = targetPort ? parseInt(targetPort, 10) : 443;

      SocksClient.createConnection({
        proxy: {
          ipaddress: socksHost,
          port: socksPort,
          type: 5,
          ...(username ? { userId: username } : {}),
          ...(password ? { password } : {}),
        },
        destination: {
          host: targetHost,
          port,
        },
        command: "connect",
      })
        .then(({ socket }) => {
          console.log(`[socks-bridge] Tunnel established to ${targetHost}:${port}`);
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) socket.write(head);
          socket.pipe(clientSocket);
          clientSocket.pipe(socket);
          socket.on("error", (e) => console.error(`[socks-bridge] socket error:`, e.message));
          clientSocket.on("error", (e) => console.error(`[socks-bridge] client error:`, e.message));
        })
        .catch((err) => {
          console.error(`[socks-bridge] SOCKS connect failed:`, err.message);
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          clientSocket.destroy();
        });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () => {
          server.close();
        },
      });
    });

    server.on("error", reject);
  });
}

export class OpenAIAccountService {
  private readonly accountsDir: string;
  private readonly mainCodexDir: string;
  private readonly databasePath: string;
  private store: OpenAIAccountStore | undefined;
  private readonly accountWork = new Map<string, Promise<void>>();
  private initialized = false;
  private readonly codexExecutableProvider: () => string | undefined;
  private readonly activeLogins = new Map<string, CodexBrowserLogin>();
  private readonly quotaQueries = new Map<string, Promise<OpenAIAccountQuota>>();
  private readonly credentialRefreshes = new Map<string, Promise<void>>();
  private readonly refreshingAccounts = new Set<string>();
  private readonly wakeRequests = new Map<string, Promise<OpenAIAccountWakeResult>>();
  private readonly quotaRefreshPolicy = new CodexQuotaRefreshPolicy();
  private disposing = false;
  wakeBatches!: AccountWakeBatches;

  constructor(
    userDataDir: string,
    codexExecutable: string | (() => string | undefined) = () => undefined,
    private readonly onAccountsChanged?: () => void,
    private readonly resolveSystemProxy?: SystemProxyResolver,
    private readonly onUsage?: (record:AccountUsageRecord,aggregate:boolean) => void,
    private readonly runAccountClient: typeof withIsolatedCodexAccountClient = withIsolatedCodexAccountClient,
  ) {
    this.accountsDir = path.join(userDataDir, "codex-accounts");
    this.mainCodexDir = path.join(userDataDir, "codex");
    this.databasePath = path.join(userDataDir, "eco-coding.sqlite");
    this.codexExecutableProvider = typeof codexExecutable === "string" ? () => codexExecutable : codexExecutable;
  }

  async initialize(options: { startBackground?: boolean } = {}): Promise<void> {
    if (this.initialized) return;
    this.disposing = false;
    await fs.mkdir(this.accountsDir, { recursive: true });
    await fs.mkdir(this.mainCodexDir, { recursive: true });
    this.store = await OpenAIAccountStore.open(this.databasePath);
    try {
      await this.store.migrateLegacyFiles(this.accountsDir);
      const mainAuth = await this.readFileOrNull(path.join(this.mainCodexDir, "auth.json"));
      this.store.migrateSessionAccounts(mainAuth);
      if (mainAuth !== null) {
        const archive = path.join(path.dirname(this.accountsDir), "codex-accounts-archive");
        await fs.mkdir(archive, { recursive: true });
        await fs.rename(path.join(this.mainCodexDir, "auth.json"), path.join(archive, `global-auth-${Date.now()}.json`));
      }
      this.wakeBatches = new AccountWakeBatches({
        load: () => this.getStore().getWakeBatches(),
        save: (state) => this.getStore().setWakeBatches(state),
        accounts: () => this.getStore().list().map(({ id, name }) => ({ id, name })),
        wake: (id) => this.wakeAccount(id),
        changed: () => this.onAccountsChanged?.(),
      });
      this.initialized = true;
      if (options.startBackground !== false) this.wakeBatches.start();
    } catch (error) {
      this.initialized = false;
      this.store.close();
      this.store = undefined;
      throw error;
    }
  }

  private getStore(): OpenAIAccountStore {
    if (!this.store) throw new Error("OpenAI account service is not initialized");
    return this.store;
  }

  /** The runtime supplies its bound identity; notifications never initiate another RPC. */
  observeQuotaUpdate(accountId: string, chatgptAccountId: string, params: unknown): void {
    if (!this.store || this.disposing) return;
    const account = this.store.get(accountId);
    if (!account?.authJson || !account.quota || readAuthAccountId(account.authJson) !== chatgptAccountId) return;
    try {
      if (params && typeof params === "object" && "accountId" in params &&
          params.accountId != null && params.accountId !== chatgptAccountId) return;
      const quota = mergeCodexQuotaUpdate(account.quota, params);
      if (!quota || JSON.stringify(quota) === JSON.stringify(account.quota)) return;
      this.store.saveQuota(accountId, chatgptAccountId, quota);
      this.onAccountsChanged?.();
    } catch (error) {
      console.error(`[codex-quota] Invalid quota update for ${accountId}:`, error);
    }
  }

  private runAccountWork<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    if (this.disposing) return Promise.reject(new Error("账号服务正在关闭。"));
    const work = (this.accountWork.get(accountId) ?? Promise.resolve()).then(operation);
    const tail = work.then(() => undefined, () => undefined);
    this.accountWork.set(accountId, tail);
    void tail.then(() => {
      if (this.accountWork.get(accountId) === tail) this.accountWork.delete(accountId);
    });
    return work;
  }

  private async readFileOrNull(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    await this.wakeBatches?.stop();
    const logins = [...this.activeLogins.values()];
    for (const login of logins) login.cancel();
    await Promise.allSettled(logins.map((login) => login.result));
    await Promise.allSettled([...this.quotaQueries.values(), ...this.credentialRefreshes.values()]);
    await Promise.allSettled([...this.accountWork.values(), ...this.wakeRequests.values()]);
    this.store?.close();
    this.store = undefined;
    this.initialized = false;
  }

  private accountDir(accountId: string): string {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error("Invalid OpenAI account id.");
    }
    const accountsRoot = path.resolve(this.accountsDir);
    const resolved = path.resolve(accountsRoot, accountId);
    if (path.dirname(resolved) !== accountsRoot) {
      throw new Error("OpenAI account path escapes the accounts directory.");
    }
    return resolved;
  }

  private async requireAccount(accountId: string) {
    this.accountDir(accountId);
    const account = this.getStore().get(accountId);
    if (!account) {
      throw new Error(`OpenAI account not found: ${accountId}`);
    }
    return account;
  }

  private readAuthState(authJson: string | null): OpenAIAccount["authState"] {
    if (!authJson) return "missing";
    const auth = parseAuthJson(authJson);
    const tokens = typeof auth.tokens === "object" && auth.tokens !== null
      ? (auth.tokens as Record<string, unknown>)
      : undefined;
    const accessToken = (tokens?.access_token ?? auth.access_token) as string;
    const expiresAt = decodeJwtExpiry(accessToken);
    if (expiresAt !== undefined && expiresAt * 1000 <= Date.now()) {
      const refreshToken = tokens?.refresh_token ?? auth.refresh_token;
      return typeof refreshToken === "string" && refreshToken.trim() ? "refreshable" : "expired";
    }
    return "configured";
  }

  private accountAuthState(accountId: string, authJson: string | null): OpenAIAccount["authState"] {
    if (!authJson) return "missing";
    if (this.getStore().getRejectedCredentialFingerprint(accountId) === contentFingerprint(authJson)) {
      return "reauthorization_required";
    }
    if (this.refreshingAccounts.has(accountId)) return "refreshing";
    return this.readAuthState(authJson);
  }

  private recordCredentialFailure(accountId: string, authJson: string, error: unknown): void {
    if (isCodexReauthenticationRequired(error)) {
      this.getStore().rejectCredentials(accountId, contentFingerprint(authJson));
    }
  }

  /** Refresh on demand; operations on the same account share one credential owner. */
  ensureAccountCredentials(accountId: string): Promise<void> {
    const existing = this.credentialRefreshes.get(accountId);
    if (existing) return existing;
    const work = this.runAccountWork(accountId, () => this.ensureAccountCredentialsUnlocked(accountId));
    this.credentialRefreshes.set(accountId, work);
    void work.finally(() => this.credentialRefreshes.delete(accountId)).catch(() => undefined);
    return work;
  }

  /** External runtimes never receive refresh tokens or write their own auth.json. */
  async getExternalChatGptTokens(accountId: string, previousAccessToken?: string): Promise<{
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType?: string;
  }> {
    const work = this.runAccountWork(accountId, async () => {
      await this.ensureAccountCredentialsUnlocked(accountId);
      let account = await this.requireAccount(accountId);
      const read = (raw: string | null) => {
        if (!raw) throw new Error("账号没有登录凭据。");
        const auth = JSON.parse(raw);
        const tokens = auth.tokens ?? auth;
        if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("账号缺少 access token。");
        const identity = readAuthAccountId(raw);
        if (!identity) throw new Error("账号凭据缺少 ChatGPT 账号身份。");
        return { accessToken: tokens.access_token as string, chatgptAccountId: identity };
      };
      let tokens = read(account.authJson);
      // A second waiter reuses a refresh already completed by the first. The existing
      // credential operation is the sole refresh-token owner for this account.
      if (previousAccessToken && tokens.accessToken === previousAccessToken) {
        const original = account.authJson!;
        try {
          await this.withAccountClient(accountId, client => client.request("account/read", { refreshToken: true }, { timeoutMs: 30_000 }));
        } catch (error) {
          this.recordCredentialFailure(accountId, original, error);
          this.onAccountsChanged?.();
          throw error;
        }
        account = await this.requireAccount(accountId);
        tokens = read(account.authJson);
        if (tokens.accessToken === previousAccessToken) throw new Error("Codex 尚未回写新的访问令牌，请重新登录或重试。");
      }
      return { ...tokens, ...(account.quota?.planType ? { chatgptPlanType: account.quota.planType } : {}) };
    });
    return work;
  }

  async getAccountProxyConfig(accountId: string): Promise<OpenAIAccountProxyConfig> {
    const account = await this.requireAccount(accountId);
    return { mode: account.proxyMode, ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}) };
  }

  private async ensureAccountCredentialsUnlocked(accountId: string): Promise<void> {
    const account = await this.requireAccount(accountId);
    const state = this.accountAuthState(accountId, account.authJson);
    if (state === "configured") return;
    if (state !== "refreshable") throw new Error("账号需要重新登录：没有可刷新的凭据，或刷新凭据已明确失效。");
    const original = account.authJson!;
    this.refreshingAccounts.add(accountId);
    this.onAccountsChanged?.();
    try {
      await this.withAccountClient(accountId, async (client) => {
        await client.request("account/read", { refreshToken: true }, { timeoutMs: 30_000 });
      });
      // Some Codex versions return account metadata even if refresh failed. The
      // reconciled credential copy, not the RPC acknowledgement, proves freshness.
      const updated = await this.requireAccount(accountId);
      if (this.readAuthState(updated.authJson) !== "configured") {
        throw new Error("Codex 尚未写回有效的新访问令牌，请重试刷新；现有登录凭据已保留。");
      }
    } catch (error) {
      this.recordCredentialFailure(accountId, original, error);
      throw error;
    } finally {
      this.refreshingAccounts.delete(accountId);
      this.onAccountsChanged?.();
    }
  }

  /** List all accounts with their login status. */
  async listAccounts(): Promise<OpenAIAccount[]> {
    return this.getStore().list().map((account) => {
      const authState = this.accountAuthState(account.id, account.authJson);
      let lastLogin: string | undefined;
      if (account.authJson) {
        const auth = JSON.parse(account.authJson) as { last_refresh?: unknown };
        if (typeof auth.last_refresh === "string") lastLogin = auth.last_refresh;
      }
      const hasProfileData = Boolean(account.email || account.password || account.pickupUrl || account.twoFactorSecret);
      return {
        id: account.id,
        name: account.name,
        createdAt: account.createdAt,
        isLoggedIn: authState === "configured",
        authState,
        hasProfileData,
        profileFields: { email: Boolean(account.email), password: Boolean(account.password), pickupUrl: Boolean(account.pickupUrl), twoFactorSecret: Boolean(account.twoFactorSecret) },
        ...(account.email ? { email: account.email } : {}),
        proxyMode: account.proxyMode,
        ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
        ...(lastLogin ? { lastLogin } : {}),
        ...(account.quota ? { quota: account.quota } : {}),
        ...(this.quotaState(account.id, account.authJson) ? { quotaRefresh: this.quotaState(account.id, account.authJson)! } : {}),
        imageGenerationEnabled: account.imageGenerationEnabled ?? false,
        ...(account.imageQuota ? { imageQuota: account.imageQuota } : {}),
      };
    });
  }

  /** Create a new account (just registers it, doesn't log in yet). */
  async createAccount(nameOrInput: string | OpenAIAccountCreateInput, proxyUrl?: string): Promise<OpenAIAccount> {
    const input: OpenAIAccountCreateInput = typeof nameOrInput === "string"
      ? { name: nameOrInput, ...(proxyUrl !== undefined ? { proxyUrl } : {}) }
      : nameOrInput;
    assertProxyMode(input.proxyMode);
    if ((input.proxyMode ?? (input.proxyUrl?.trim() ? "manual" : "system")) === "manual" && !input.proxyUrl?.trim()) {
      throw new Error("手动代理模式需要填写代理地址。");
    }
    const account = this.getStore().create(input);
    await fs.mkdir(this.accountDir(account.id), { recursive: true });
    this.onAccountsChanged?.();
    const authState = this.accountAuthState(account.id, account.authJson);
    return {
      id: account.id,
      name: account.name,
      createdAt: account.createdAt,
      isLoggedIn: authState === "configured",
      authState,
      hasProfileData: Boolean(account.email || account.password || account.pickupUrl || account.twoFactorSecret),
      profileFields: { email: Boolean(account.email), password: Boolean(account.password), pickupUrl: Boolean(account.pickupUrl), twoFactorSecret: Boolean(account.twoFactorSecret) },
      ...(account.email ? { email: account.email } : {}),
      proxyMode: account.proxyMode,
      ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
    };
  }

  /** Delete an account and its auth data. */
  async deleteAccount(accountId: string): Promise<void> {
    await this.requireAccount(accountId);
    const login = this.activeLogins.get(accountId);
    if (login) {
      login.cancel();
      await login.result;
    }
    // Keep the account registered if filesystem cleanup fails so deletion can be retried.
    // Chromium can finish a profile write after its final guest closes. Retry
    // transient ENOTEMPTY/EBUSY filesystem errors; persistent failures still reject.
    await fs.rm(this.accountDir(accountId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    this.quotaRefreshPolicy.forget(accountId);
    this.getStore().delete(accountId);
    this.onAccountsChanged?.();
  }

  async getBrowserDataPath(accountId: string): Promise<string> {
    await this.requireAccount(accountId);
    return path.join(this.accountDir(accountId), "browser");
  }

  /** Check if an account has a valid auth.json. */
  async isAccountLoggedIn(accountId: string): Promise<boolean> {
    const account = await this.requireAccount(accountId);
    return this.accountAuthState(accountId, account.authJson) === "configured";
  }

  /** Start login for a specific account. */
  async startLogin(
    accountId: string,
  ): Promise<CodexBrowserLogin | null> {
    const account = await this.requireAccount(accountId);
    this.activeLogins.get(accountId)?.cancel();
    const codexExecutable = this.codexExecutableProvider();
    if (!codexExecutable) throw new Error("Codex CLI 未找到，仍可导入和编辑账号资料");
    const codexHomeDir = path.join(this.accountDir(accountId), `oauth-login-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    let bridge: { close: () => void } | undefined;
    try {
      let proxyUrl = await resolveCodexProxyUrl({
        mode: account.proxyMode,
        ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
      }, this.resolveSystemProxy);
      if (proxyUrl && new URL(proxyUrl).protocol.startsWith("socks")) {
        const socksBridge = await startSocksToHttpBridge(proxyUrl);
        bridge = socksBridge;
        proxyUrl = `http://127.0.0.1:${socksBridge.port}`;
      }
      const proxyEnvironment: CodexProxyEnvironment = proxyUrl
        ? { mode: "proxy", url: proxyUrl }
        : { mode: "direct" };
      const login = await startCodexBrowserLogin({
        executable: codexExecutable,
        codexHomeDir,
        env: buildCodexProxyEnv(process.env, proxyEnvironment),
        onAuthenticated: async (signal) => {
          let saveError: unknown;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            signal.throwIfAborted();
            try {
              const content = await fs.readFile(path.join(codexHomeDir, "auth.json"), "utf8");
              signal.throwIfAborted();
              parseAuthJson(content);
              await this.saveCredentialsAfterLogin(accountId, content);
              return;
            } catch (error) {
              saveError = error;
              if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 150));
            }
          }
          throw saveError;
        },
      });
      const result = login.result.then(async (result) => {
        const authPath = path.join(codexHomeDir, "auth.json");
        if (!result.success && await this.readFileOrNull(authPath) !== null) {
          return { ...result, message: `${result.message}。登录凭据已保留：${authPath}；可在恢复存储后重新保存 auth.json。` };
        }
        await fs.rm(codexHomeDir, { recursive: true, force: true });
        return result;
      }).finally(() => {
        bridge?.close();
        if (this.activeLogins.get(accountId)?.result === result) this.activeLogins.delete(accountId);
      });
      const session = { ...login, result };
      this.activeLogins.set(accountId, session);
      return session;
    } catch (error) {
      bridge?.close();
      // A failed startup is not a completed login; preserve any credential file.
      if (await this.readFileOrNull(path.join(codexHomeDir, "auth.json")) === null) {
        await fs.rm(codexHomeDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async submitLoginCallback(accountId: string, loginId: string, callbackUrl: string): Promise<void> {
    const login = this.activeLogins.get(accountId);
    if (!login || login.loginId !== loginId) throw new Error("登录已结束或已过期，请重新生成授权链接");
    await login.submitCallback(callbackUrl);
  }

  cancelLogin(accountId: string, loginId: string): void {
    const login = this.activeLogins.get(accountId);
    if (login?.loginId === loginId) login.cancel();
  }

  private async saveCredentialsAfterLogin(accountId: string, content: string): Promise<void> {
    parseAuthJson(content);
    this.getStore().saveAuthJson(accountId, content);
    this.onAccountsChanged?.();
  }

  /** Manually set auth.json content for an account. */
  async setAuthJson(accountId: string, content: string): Promise<OpenAIAccountLoginResult> {
    await this.requireAccount(accountId);
    try {
      parseAuthJson(content);
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "auth.json 格式无效" };
    }
    this.getStore().saveAuthJson(accountId, content);
    this.onAccountsChanged?.();
    return { success: true, message: "auth.json 已保存" };
  }

  /** Get the raw auth.json content for an account. */
  async getAuthJsonContent(accountId: string): Promise<string | null> {
    await this.requireAccount(accountId);
    return this.getStore().getAuthJson(accountId);
  }

  async getAccountDetails(accountId: string): Promise<OpenAIAccountDetails> {
    const account = await this.requireAccount(accountId);
    const quotaRefresh = this.quotaState(account.id, account.authJson);
    return { ...account, ...(quotaRefresh ? { quotaRefresh } : {}) };
  }

  private quotaState(accountId: string, authJson: string | null) {
    return authJson ? this.quotaRefreshPolicy.state(accountId, contentFingerprint(authJson)) : undefined;
  }

  /** Update account metadata and optional profile fields; empty strings explicitly clear. */
  async updateAccount(inputOrId: OpenAIAccountUpdateInput | string, name?: string, proxyUrl?: string): Promise<{ success: boolean }> {
    let input: OpenAIAccountUpdateInput;
    if (typeof inputOrId === "string") {
      const existing = await this.requireAccount(inputOrId);
      input = {
        accountId: inputOrId,
        name: name ?? existing.name,
        email: existing.email ?? "",
        password: existing.password ?? "",
        pickupUrl: existing.pickupUrl ?? "",
        twoFactorSecret: existing.twoFactorSecret ?? "",
        ...(proxyUrl !== undefined ? { proxyUrl } : {}),
      };
    } else {
      input = inputOrId;
    }
    const existing = await this.requireAccount(input.accountId);
    assertProxyMode(input.proxyMode);
    const effectiveManualProxy = input.proxyUrl !== undefined
      ? input.proxyUrl.trim()
      : existing.proxyMode === "manual"
        ? existing.proxyUrl?.trim()
        : undefined;
    if (input.proxyMode === "manual" && !effectiveManualProxy) {
      throw new Error("手动代理模式需要填写代理地址。");
    }
    this.getStore().update(input);
    this.onAccountsChanged?.();
    return { success: true };
  }

  importAccounts(input: string): { added: number; updated: number } {
    const result = this.getStore().importProfiles(input);
    this.onAccountsChanged?.();
    return result;
  }

  async setImageGenerationEnabled(accountId: string, enabled: boolean): Promise<void> {
    await this.requireAccount(accountId);
    this.getStore().setImageGenerationEnabled(accountId, enabled);
    this.onAccountsChanged?.();
  }

  saveImageQuota(accountId: string, authJson: string, quota: OpenAIAccountImageQuota): void {
    this.getStore().saveImageQuota(accountId, authJson, quota);
    this.onAccountsChanged?.();
  }

  queryQuota(accountId: string, reason: QuotaRefreshReason = "manual"): Promise<OpenAIAccountQuota> {
    const existing = this.quotaQueries.get(accountId);
    if (existing) return existing;
    // Serialize credential operations until refreshed tokens are saved to SQLite.
    const work = this.runAccountWork(accountId, async () => {
      const account = await this.requireAccount(accountId);
      if (!account.authJson) throw new Error("该账号没有登录凭据，请先登录。");
      const credentials = contentFingerprint(account.authJson);
      const decision = this.quotaRefreshPolicy.check(accountId, credentials, account.quota, reason);
      if (decision !== "query") {
        if (account.quota) return account.quota;
        throw new Error("尚无额度数据，请手动刷新。");
      }
      return this.trackQuotaQuery(accountId, async () => {
        await this.ensureAccountCredentialsUnlocked(accountId);
        return this.queryQuotaUnlocked(accountId);
      });
    });
    // An unavailable quota endpoint is not an auth-file synchronization error.
    this.quotaQueries.set(accountId, work);
    void work.finally(() => this.quotaQueries.delete(accountId)).catch(() => undefined);
    return work;
  }

  /** Assistant-only read capability. Never joins refresh, reconciliation, switching or writeback paths. */
  listAccountChoicesReadonly() {
    const accounts = this.getStore().listReadonlyQuotaAccounts();
    return redactAccountSummaryStrings(accounts.map((account) => {
      let authState: OpenAIAccount["authState"] | "invalid";
      try { authState = this.accountAuthState(account.id, account.authJson); }
      catch { authState = "invalid"; }
      return { accountId: account.id, label: account.name, authState, selectable: authState === "configured" };
    }), accounts);
  }

  async queryAllAccountQuotasReadonly(source: "live" | "cache" = "live", signal?: AbortSignal) {
    const store = this.getStore();
    return queryReadonlyAccountQuotas({
      accounts: store.listReadonlyQuotaAccounts(), source,
      ...(signal ? { signal } : {}),
      authUnchanged: (account) => store.readonlyQuotaAuthUnchanged(account.id, account.authJson),
      query: async (account) => {
        const executable = this.codexExecutableProvider();
        if (!executable) throw new ReadonlyQuotaError("runtime_unavailable");
        const codexHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-readonly-quota-"));
        let bridge: { close: () => void } | undefined;
        try {
          let proxyUrl = await resolveCodexProxyUrl({
            mode: account.proxyMode ?? (account.proxyUrl ? "manual" : "system"),
            ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
          }, this.resolveSystemProxy);
          if (proxyUrl && new URL(proxyUrl).protocol.startsWith("socks")) {
            const socksBridge = await startSocksToHttpBridge(proxyUrl);
            bridge = socksBridge;
            proxyUrl = `http://127.0.0.1:${socksBridge.port}`;
          }
          let refreshRequested = false;
          return await withIsolatedCodexAccountClient({
            executable, codexHomeDir, credentialsStore: "ephemeral",
            ...(signal ? { signal } : {}),
            proxy: proxyUrl ? { mode: "proxy", url: proxyUrl } : { mode: "direct" },
            onServerRequest: (method) => {
              if (method === "account/chatgptAuthTokens/refresh") {
                refreshRequested = true;
                throw new ReadonlyQuotaError("refresh_required");
              }
              throw new Error("只读额度查询拒绝服务端交互请求。");
            },
          }, async (client) => {
            try {
              const snapshot = await readReadonlyQuota(client, account.authJson!);
              if (refreshRequested) throw new ReadonlyQuotaError("refresh_required");
              return snapshot;
            } catch (error) {
              if (refreshRequested) throw new ReadonlyQuotaError("refresh_required");
              throw error;
            }
          });
        } finally {
          bridge?.close();
          await fs.rm(codexHomeDir, { recursive: true, force: true });
        }
      },
    });
  }

  private async trackQuotaQuery<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const before = await this.requireAccount(accountId);
    if (!before.authJson) throw new Error("该账号没有登录凭据，请先登录。");
    const original = contentFingerprint(before.authJson);
    this.quotaRefreshPolicy.begin(accountId, original);
    const credentials = () => {
      const auth = this.getStore().get(accountId)?.authJson;
      // A replaced identity must not inherit the previous identity's request outcome.
      return auth && readAuthAccountId(auth) === readAuthAccountId(before.authJson!) ? contentFingerprint(auth) : original;
    };
    try {
      const result = await operation();
      this.quotaRefreshPolicy.succeed(accountId, credentials());
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const displayedError = /\b401\b/u.test(message)
        ? new Error(`登录令牌已过期，请重新登录该账号。（${message}）`, { cause: error })
        : error;
      this.quotaRefreshPolicy.fail(accountId, credentials(), error, displayedError instanceof Error ? displayedError.message : undefined);
      this.recordCredentialFailure(accountId, before.authJson, error);
      throw displayedError;
    } finally {
      this.onAccountsChanged?.();
    }
  }

  /** Execute a reset and publish its required fresh read before releasing the auth queue. */
  async resetQuota<T>(accountId: string, operation: (client: CodexQuotaClient) => Promise<T>): Promise<T> {
    const work = this.runAccountWork(accountId, async () => {
      await this.ensureAccountCredentialsUnlocked(accountId);
      return this.trackQuotaQuery(accountId, async () => {
      let result!: T;
      await this.queryQuotaUnlocked(accountId, async (client) => { result = await operation(client); });
      return result;
      });
    });
    return work;
  }

  getWakeModel(): string | null {
    return this.getStore().getWakeModel();
  }

  setWakeModel(modelId: string | null): void {
    this.getStore().setWakeModel(modelId);
  }

  wakeAccount(accountId: string): Promise<OpenAIAccountWakeResult> {
    const existing = this.wakeRequests.get(accountId);
    if (existing) return existing;
    const modelId = this.getWakeModel();
    const work = this.runAccountWork(accountId, async () => {
      await this.ensureAccountCredentialsUnlocked(accountId);
      let reply: string | undefined;
      let wakeFailure: { error: unknown } | undefined;
      try {
        await this.trackQuotaQuery(accountId, () => this.queryQuotaUnlocked(accountId, async (client, refreshToken, expectedAccountId) => {
          // Verify this account and renew expired credentials before spending any quota.
          await readCodexAccountQuota(client, refreshToken, expectedAccountId);
          try {
            reply = await wakeCodexAccount(client, modelId,90_000,
              this.onUsage ? {accountId,onUsage:this.onUsage} : undefined);
          } catch (error) {
            // Finish the independent quota read, then report the model failure
            // outside trackQuotaQuery so it cannot poison quota errors/backoff.
            wakeFailure = { error };
          }
        }));
      } catch (error) {
        if (wakeFailure) throw wakeFailure.error;
        if (reply === undefined) throw error;
        return { reply, quotaError: error instanceof Error ? error.message : String(error) };
      }
      if (wakeFailure) throw wakeFailure.error;
      if (reply === undefined) throw new Error("Codex 唤醒未收到回复。");
      return { reply };
    });
    this.wakeRequests.set(accountId, work);
    void work.finally(() => this.wakeRequests.delete(accountId)).catch(() => undefined);
    return work;
  }

  private async queryQuotaUnlocked(
    accountId: string,
    beforeRead?: (client: CodexQuotaClient, refreshToken: boolean, expectedAccountId: string) => Promise<void>,
  ): Promise<OpenAIAccountQuota> {
    const { quota, expectedAccountId } = await this.withAccountClient(accountId, async (client, refreshToken, expectedAccountId) => {
      await beforeRead?.(client, refreshToken, expectedAccountId);
      const quota = await readCodexAccountQuota(client, beforeRead ? false : refreshToken, expectedAccountId);
      return { quota, expectedAccountId };
    });
    // Publish a new quota snapshot only after credential writeback also succeeds.
    try {
      this.getStore().saveQuota(accountId, expectedAccountId, quota);
    } catch (error) {
      throw new Error(`额度已获取，但保存缓存失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return quota;
  }

  private async withAccountClient<T>(
    accountId: string,
    operation: (client: CodexQuotaClient, refreshToken: boolean, expectedAccountId: string) => Promise<T>,
  ): Promise<T> {
    const account = await this.requireAccount(accountId);
    if (!account.authJson) throw new Error("该账号没有登录凭据，请先登录。");
    const chatgptAccountId = readAuthAccountId(account.authJson);
    if (!chatgptAccountId) throw new Error("账号凭据缺少 ChatGPT 账号身份，请重新登录。");
    const refreshToken = ["expired", "refreshable"].includes(this.readAuthState(account.authJson));
    let result: T;
    {
      const executable = this.codexExecutableProvider();
      if (!executable) throw new Error("Codex CLI 未找到，无法访问账号。");
      const codexHomeDir = await fs.mkdtemp(path.join(this.accountsDir, `quota-${accountId}-`));
      let bridge: { close: () => void } | undefined;
      let preserveCredentials = false;
      try {
        await fs.writeFile(path.join(codexHomeDir, "auth.json"), account.authJson, { mode: 0o600 });
        let proxyUrl = await resolveCodexProxyUrl({
          mode: account.proxyMode,
          ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
        }, this.resolveSystemProxy);
        if (proxyUrl && new URL(proxyUrl).protocol.startsWith("socks")) {
          const socksBridge = await startSocksToHttpBridge(proxyUrl);
          bridge = socksBridge;
          proxyUrl = `http://127.0.0.1:${socksBridge.port}`;
        }
        try {
          result = await this.runAccountClient({
            executable, codexHomeDir,
            proxy: proxyUrl ? { mode: "proxy", url: proxyUrl } : { mode: "direct" },
          }, (client) => operation(client, refreshToken, chatgptAccountId));
        } finally {
          const updatedAuth = await this.readFileOrNull(path.join(codexHomeDir, "auth.json"));
          if (updatedAuth !== null && updatedAuth !== account.authJson) {
            try {
              parseAuthJson(updatedAuth);
              if (readAuthAccountId(updatedAuth) !== chatgptAccountId) throw new Error("刷新后的账号身份不匹配");
              if (this.getStore().get(accountId)?.authJson !== account.authJson) throw new Error("查询期间账号凭据已变更");
              this.getStore().saveAuthJson(accountId, updatedAuth);
              this.onAccountsChanged?.();
            } catch (error) {
              preserveCredentials = true;
              throw new Error(`账号操作后的凭据保存失败，新凭据已保留在 ${codexHomeDir}：${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      } finally {
        bridge?.close();
        if (!preserveCredentials) await fs.rm(codexHomeDir, { recursive: true, force: true });
      }
    }
    return result;
  }
}
