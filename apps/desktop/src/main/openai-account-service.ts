import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { createUpstreamFetchController } from "@eco/gateway";
import { SocksProxyAgent } from "socks-proxy-agent";
import { SocksClient } from "socks";
import type {
  OpenAIAccount as OpenAIAccountShared,
  OpenAIAccountCreateInput,
  OpenAIAccountDetails,
  OpenAIAccountQuota,
  OpenAIAccountImageQuota,
  OpenAIAccountSyncStatus,
  OpenAIAccountUpdateInput,
} from "../shared/openai-account";
import { OpenAIAccountStore } from "./openai-account-store";
import { startCodexBrowserLogin } from "./codex-browser-login";

export type { OpenAIAccount, OpenAIAccountQuota } from "../shared/openai-account";

/**
 * OpenAI Account Management Service
 *
 * Stores account data and raw auth.json content in eco-coding.sqlite. The
 * running CODEX_HOME/auth.json is the only runtime credential file.
 *
 * Directory structure:
 *   <userData>/eco-coding.sqlite
 *   <userData>/codex/auth.json (active account credentials published atomically)
 */

type OpenAIAccount = OpenAIAccountShared;

export interface OpenAIAccountStatus {
  isLoggedIn: boolean;
  message: string;
}

export interface OpenAIAccountLoginResult {
  success: boolean;
  message: string;
}

const ACCOUNT_ID_PATTERN = /^oa_[A-Za-z0-9_-]+$/;

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

function proxyEndpointForLog(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "invalid-proxy-url";
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
  private authWatcher: fsSync.FSWatcher | null = null;
  private authPoll: ReturnType<typeof setInterval> | undefined;
  private authDebounce: ReturnType<typeof setTimeout> | undefined;
  private authSyncQueue: Promise<void> = Promise.resolve();
  private isPublishingMainAuth = false;
  private authWatcherHealthy = false;
  private syncStatus: OpenAIAccountSyncStatus = { state: "ok" };
  private initialized = false;
  private readonly codexExecutableProvider: () => string | undefined;
  private readonly activeLogins = new Map<string, { cancel: () => void; result: Promise<OpenAIAccountLoginResult> }>();

  constructor(
    userDataDir: string,
    codexExecutable: string | (() => string | undefined) = () => undefined,
    private readonly onAccountsChanged?: (state: { syncStatus: OpenAIAccountSyncStatus }) => void,
  ) {
    this.accountsDir = path.join(userDataDir, "codex-accounts");
    this.mainCodexDir = path.join(userDataDir, "codex");
    this.databasePath = path.join(userDataDir, "eco-coding.sqlite");
    this.codexExecutableProvider = typeof codexExecutable === "string" ? () => codexExecutable : codexExecutable;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.accountsDir, { recursive: true });
    await fs.mkdir(this.mainCodexDir, { recursive: true });
    this.store = await OpenAIAccountStore.open(this.databasePath);
    try {
      await this.store.migrateLegacyFiles(this.accountsDir);
      const persistedConflict = this.store.getLatestSyncConflict();
      if (persistedConflict) {
        this.setSyncStatus({
          state: "conflict",
          message: persistedConflict.message,
          updatedAt: persistedConflict.updatedAt,
        });
      }
      this.startAuthWatcher();
      // Reconcile credentials left by the prior process before applying a queued switch.
      await this.reconcileMainAuth({ allowPublishMissing: true }).catch((error) => this.setSyncError(error));
      if (this.store.getPendingTransition()) await this.applyPendingTransition();
      this.authPoll = setInterval(() => {
        if (!this.authWatcherHealthy) this.startAuthWatcher();
        this.enqueueMainAuthReconcile();
      }, 5_000);
      this.authPoll.unref?.();
      this.initialized = true;
    } catch (error) {
      this.authWatcher?.close();
      this.authWatcher = null;
      this.authWatcherHealthy = false;
      this.store.close();
      this.store = undefined;
      throw error;
    }
  }

  /**
   * Watch the main codex auth.json for changes (token refreshes).
   * When it changes, sync the content back to the active account's directory.
   */
  private startAuthWatcher(): void {
    if (this.authWatcher) return;
    try {
      fsSync.mkdirSync(this.mainCodexDir, { recursive: true });
      this.authWatcher = fsSync.watch(this.mainCodexDir, (_eventType, filename) => {
        const name = filename?.toString();
        if (name === "auth.json") this.debounceMainAuthReconcile();
      });
      this.authWatcherHealthy = true;
      this.authWatcher.on("error", (error) => {
        this.authWatcher?.close();
        this.authWatcher = null;
        this.authWatcherHealthy = false;
        this.setSyncError(new Error(`auth.json 文件监听失败：${error.message}`));
      });
    } catch (error) {
      this.authWatcherHealthy = false;
      this.setSyncError(new Error(`auth.json 文件监听失败：${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async syncMainAuthFromActiveAccount(): Promise<boolean> {
    return (await this.runAuthWork(() => this.reconcileMainAuth({ allowPublishMissing: true }))) === "published";
  }

  private getStore(): OpenAIAccountStore {
    if (!this.store) throw new Error("OpenAI account service is not initialized");
    return this.store;
  }

  private setSyncStatus(status: OpenAIAccountSyncStatus): void {
    const changed = this.syncStatus.state !== status.state || this.syncStatus.message !== status.message;
    this.syncStatus = status;
    if (changed) this.onAccountsChanged?.({ syncStatus: status });
  }

  private setSyncError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.setSyncStatus({ state: "error", message, updatedAt: new Date().toISOString() });
  }

  private setSyncConflict(message: string, mainContent?: string, storedContent?: string | null): void {
    // Both raw credential copies remain available: the account JSON stays in SQLite,
    // and the running-directory version is left untouched until a user action resolves it.
    if (mainContent !== undefined) this.recordSyncConflict(mainContent, storedContent ?? null, message);
    this.setSyncStatus({ state: "conflict", message, updatedAt: new Date().toISOString() });
  }

  private recordSyncConflict(mainContent: string, storedContent: string | null, message: string): void {
    this.getStore().recordSyncConflict(this.getStore().getActiveAccountId(), mainContent, storedContent, message);
  }

  private debounceMainAuthReconcile(): void {
    if (this.authDebounce) clearTimeout(this.authDebounce);
    this.authDebounce = setTimeout(() => this.enqueueMainAuthReconcile(), 250);
  }

  private enqueueMainAuthReconcile(): void {
    void this.runAuthWork(() => this.reconcileMainAuth());
  }

  private runAuthWork<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.authSyncQueue.then(work);
    this.authSyncQueue = operation.then(
      () => undefined,
      (error) => this.setSyncError(error),
    );
    return operation;
  }

  private async readFileOrNull(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }

  private async readStableMainAuth(): Promise<string | null> {
    const mainAuthPath = path.join(this.mainCodexDir, "auth.json");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const content = await this.readFileOrNull(mainAuthPath);
      if (content === null) {
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      try {
        parseAuthJson(content);
        return content;
      } catch (error) {
        if (attempt === 3) throw new Error(`运行目录 auth.json 持续无效：${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    return null;
  }

  private async publishMainAuth(content: string | null): Promise<void> {
    const authPath = path.join(this.mainCodexDir, "auth.json");
    this.isPublishingMainAuth = true;
    try {
      if (content === null) {
        await fs.rm(authPath, { force: true });
        return;
      }
      parseAuthJson(content);
      const tempPath = path.join(this.mainCodexDir, `.auth-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempPath, authPath);
    } finally {
      this.isPublishingMainAuth = false;
    }
  }

  private async reconcileMainAuth(options: { allowPublishMissing?: boolean } = {}): Promise<"same" | "published" | "stored" | "missing"> {
    if (this.isPublishingMainAuth) return "same";
    const activeId = this.getStore().getActiveAccountId();
    const mainContent = await this.readStableMainAuth();
    if (!activeId) {
      if (mainContent !== null) {
        this.setSyncConflict("运行目录存在 auth.json，但当前没有活动账号，无法确认凭据归属", mainContent, null);
        return "same";
      }
      this.getStore().clearUnassignedSyncConflict();
      this.markSyncRecovered();
      return "missing";
    }

    const account = this.getStore().get(activeId);
    if (!account) throw new Error(`当前 OpenAI 账号不存在：${activeId}`);
    const storedContent = account.authJson;
    if (mainContent === null) {
      if (storedContent === null) {
        this.markSyncRecovered();
        return "missing";
      }
      if (!options.allowPublishMissing) return "missing";
      await this.publishMainAuth(storedContent);
      this.getStore().setLastPublishedFingerprint(contentFingerprint(storedContent));
      this.getStore().clearSyncConflict(activeId);
      this.markSyncRecovered();
      return "published";
    }
    if (storedContent === null) {
      this.setSyncConflict(`账号 ${account.name} 在 SQLite 中没有凭据，运行目录凭据未回写`, mainContent, null);
      return "same";
    }

    parseAuthJson(mainContent);
    parseAuthJson(storedContent);
    const mainAccountId = readAuthAccountId(mainContent);
    const storedAccountId = readAuthAccountId(storedContent);
    if (!mainAccountId || !storedAccountId || mainAccountId !== storedAccountId) {
      this.setSyncConflict(`账号身份不匹配，保留账号 ${account.name} 和运行目录中的双方凭据`, mainContent, storedContent);
      return "same";
    }
    if (mainContent === storedContent) {
      const fingerprint = contentFingerprint(mainContent);
      if (this.getStore().getLastPublishedFingerprint() !== fingerprint) {
        this.getStore().setLastPublishedFingerprint(fingerprint);
      }
      this.getStore().clearSyncConflict(activeId);
      this.markSyncRecovered();
      return "same";
    }

    const mainStamp = readAuthRefreshStamp(mainContent);
    const storedStamp = readAuthRefreshStamp(storedContent);
    let direction: "main" | "stored" | undefined;
    if (mainStamp !== undefined && storedStamp !== undefined && mainStamp !== storedStamp) {
      direction = mainStamp > storedStamp ? "main" : "stored";
    } else {
      const lastPublished = this.getStore().getLastPublishedFingerprint();
      if (lastPublished === contentFingerprint(mainContent)) direction = "stored";
      else if (lastPublished === contentFingerprint(storedContent)) direction = "main";
    }
    if (!direction) {
      this.setSyncConflict(`无法判断账号 ${account.name} 的凭据哪一份更新，已保留双方内容`, mainContent, storedContent);
      return "same";
    }

    if (direction === "main") {
      this.getStore().saveAuthJson(activeId, mainContent);
      this.getStore().setLastPublishedFingerprint(contentFingerprint(mainContent));
      this.getStore().clearSyncConflict(activeId);
      this.markSyncRecovered();
      return "stored";
    }
    await this.publishMainAuth(storedContent);
    this.getStore().setLastPublishedFingerprint(contentFingerprint(storedContent));
    this.getStore().clearSyncConflict(activeId);
    this.markSyncRecovered();
    return "published";
  }

  private markSyncRecovered(): void {
    if (!this.authWatcherHealthy) {
      if (this.syncStatus.state !== "error") this.setSyncError(new Error("auth.json 文件监听不可用，正在由轮询同步"));
      return;
    }
    const conflict = this.getStore().getLatestSyncConflict();
    if (conflict) {
      this.setSyncStatus({ state: "conflict", message: conflict.message, updatedAt: conflict.updatedAt });
      return;
    }
    this.setSyncStatus({ state: "ok", updatedAt: new Date().toISOString() });
  }

  getSyncStatus(): OpenAIAccountSyncStatus {
    return this.syncStatus;
  }

  reportSyncError(error: unknown): void {
    this.setSyncError(error);
  }

  getPendingAccountId(): string | null | undefined {
    return this.getStore().getPendingTransition()?.targetAccountId;
  }

  /** Flush the running auth file after the old app-server has stopped. */
  async flushFinalAuthWriteback(): Promise<void> {
    await this.runAuthWork(() => this.reconcileMainAuth());
  }

  async applyPendingTransition(): Promise<void> {
    await this.runAuthWork(() => this.applyPendingTransitionUnlocked());
  }

  private async applyPendingTransitionUnlocked(): Promise<void> {
    const store = this.getStore();
    if (!store.getPendingTransition()) return;

    // Capture the old runtime's last refresh before publishing another account.
    await this.reconcileMainAuth();
    const previousContent = await this.readFileOrNull(path.join(this.mainCodexDir, "auth.json"));
    let publishedUncommitted = false;
    try {
      for (;;) {
        const latest = store.getPendingTransition();
        if (!latest) {
          if (publishedUncommitted) {
            await this.publishMainAuth(previousContent);
            publishedUncommitted = false;
            // A new request can arrive while restoring the original file.
            continue;
          }
          this.markSyncRecovered();
          break;
        }
        const targetId = latest.targetAccountId;
        const targetAccount = targetId ? store.get(targetId) : undefined;
        if (targetId && !targetAccount) throw new Error(`待切换的 OpenAI 账号不存在：${targetId}`);
        const publishContent = latest.stagedAuth?.accountId === targetId
          ? latest.stagedAuth.authJson
          : targetAccount?.authJson ?? null;
        if (publishContent !== null) parseAuthJson(publishContent);
        await this.publishMainAuth(publishContent);
        publishedUncommitted = true;
        const newest = store.getPendingTransition();
        if (JSON.stringify(newest) !== JSON.stringify(latest)) continue;
        const fingerprint = publishContent === null ? undefined : contentFingerprint(publishContent);
        // Both staged credentials and account selection commit in one transaction.
        store.commitPendingTransition(fingerprint);
        publishedUncommitted = false;
        if (targetId) store.clearSyncConflict(targetId);
        this.markSyncRecovered();
        for (const accountId of latest.deleteAccountIds) {
          if (accountId !== targetId) await fs.rm(this.accountDir(accountId), { recursive: true, force: true });
        }
        break;
      }
    } catch (error) {
      if (publishedUncommitted) {
        try {
          await this.publishMainAuth(previousContent);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], "账号切换失败，恢复原 auth.json 也失败，请检查本地存储");
        }
      }
      throw error;
    }
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
  }

  /** Stop file polling and close the SQLite handle after the final writeback. */
  async dispose(): Promise<void> {
    const logins = [...this.activeLogins.values()];
    for (const login of logins) login.cancel();
    await Promise.all(logins.map((login) => login.result)).catch((error) => this.setSyncError(error));
    if (this.authDebounce) clearTimeout(this.authDebounce);
    if (this.authPoll) clearInterval(this.authPoll);
    this.authWatcher?.close();
    this.authWatcher = null;
    this.authPoll = undefined;
    await this.flushFinalAuthWriteback().catch((error) => this.setSyncError(error));
    this.authWatcherHealthy = false;
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
    if (expiresAt !== undefined && expiresAt * 1000 <= Date.now()) return "expired";
    return "configured";
  }

  /** List all accounts with their login status. */
  async listAccounts(): Promise<OpenAIAccount[]> {
    return this.getStore().list().map((account) => {
      const authState = this.readAuthState(account.authJson);
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
        ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
        ...(lastLogin ? { lastLogin } : {}),
        ...(account.quota ? { quota: account.quota } : {}),
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
    const account = this.getStore().create(input);
    await fs.mkdir(this.accountDir(account.id), { recursive: true });
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
    const authState = this.readAuthState(account.authJson);
    return {
      id: account.id,
      name: account.name,
      createdAt: account.createdAt,
      isLoggedIn: authState === "configured",
      authState,
      hasProfileData: Boolean(account.email || account.password || account.pickupUrl || account.twoFactorSecret),
      profileFields: { email: Boolean(account.email), password: Boolean(account.password), pickupUrl: Boolean(account.pickupUrl), twoFactorSecret: Boolean(account.twoFactorSecret) },
      ...(account.email ? { email: account.email } : {}),
      ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
    };
  }

  /** Delete an account and its auth data. */
  async deleteAccount(accountId: string): Promise<void> {
    await this.requireAccount(accountId);
    const store = this.getStore();
    const activeId = store.getActiveAccountId();
    const pending = store.getPendingTransition();
    if (activeId === accountId) {
      store.queueTransition(null, { deleteAccountId: accountId });
    } else {
      if (pending?.targetAccountId === accountId) {
        if (pending.stagedAuth && pending.stagedAuth.accountId === activeId && activeId) {
          store.queueTransition(activeId, { stagedAuth: pending.stagedAuth });
        } else {
          store.cancelPendingTransition();
        }
      }
      store.delete(accountId);
      await fs.rm(this.accountDir(accountId), { recursive: true, force: true });
      this.markSyncRecovered();
    }
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
  }

  /** Check if an account has a valid auth.json. */
  async isAccountLoggedIn(accountId: string): Promise<boolean> {
    const account = await this.requireAccount(accountId);
    return this.readAuthState(account.authJson) === "configured";
  }

  /** Start login for a specific account. */
  async startLogin(
    accountId: string,
  ): Promise<{ authUrl: string; expiresAt: number; result: Promise<OpenAIAccountLoginResult>; cancel: () => void } | null> {
    const account = await this.requireAccount(accountId);
    this.activeLogins.get(accountId)?.cancel();
    const codexExecutable = this.codexExecutableProvider();
    if (!codexExecutable) throw new Error("Codex CLI 未找到，仍可导入和编辑账号资料");
    const codexHomeDir = path.join(this.accountDir(accountId), `oauth-login-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    let bridge: { close: () => void } | undefined;
    try {
      let proxyUrl = account.proxyUrl?.trim();
      if (proxyUrl && new URL(proxyUrl).protocol.startsWith("socks")) {
        const socksBridge = await startSocksToHttpBridge(proxyUrl);
        bridge = socksBridge;
        proxyUrl = `http://127.0.0.1:${socksBridge.port}`;
      }
      const login = await startCodexBrowserLogin({
        executable: codexExecutable,
        codexHomeDir,
        ...(proxyUrl ? { env: {
          HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl,
          NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
        } } : {}),
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
          this.setSyncError(saveError);
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
      this.activeLogins.set(accountId, { cancel: login.cancel, result });
      return { authUrl: login.authUrl, expiresAt: login.expiresAt, result, cancel: login.cancel };
    } catch (error) {
      bridge?.close();
      // A failed startup is not a completed login; preserve any credential file.
      if (await this.readFileOrNull(path.join(codexHomeDir, "auth.json")) === null) {
        await fs.rm(codexHomeDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private async saveCredentialsAfterLogin(accountId: string, content: string): Promise<void> {
    parseAuthJson(content);
    const store = this.getStore();
    if (store.getActiveAccountId() === accountId) {
      const pending = store.getPendingTransition();
      store.queueTransition(pending ? pending.targetAccountId : accountId, { stagedAuth: { accountId, authJson: content } });
    } else {
      store.saveAuthJson(accountId, content);
    }
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
  }

  /** Get the currently active account ID. */
  async getActiveAccountId(): Promise<string | null> {
    return this.getStore().getActiveAccountId();
  }

  /** Request a deferred switch; the runtime scheduler commits it once Codex is idle. */
  async setActiveAccount(accountId: string | null): Promise<void> {
    if (accountId) await this.requireAccount(accountId);
    const pending = this.getStore().getPendingTransition();
    if (accountId === this.getStore().getActiveAccountId() && pending && pending.targetAccountId !== accountId) {
      if (pending.stagedAuth) {
        this.getStore().queueTransition(accountId, { stagedAuth: pending.stagedAuth });
      } else {
        this.getStore().cancelPendingTransition();
      }
      this.onAccountsChanged?.({ syncStatus: this.syncStatus });
      return;
    }
    if (accountId === this.getStore().getActiveAccountId() && !pending) return;
    this.getStore().queueTransition(accountId);
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
  }

  /** Get login status for the active account. */
  async getActiveStatus(): Promise<OpenAIAccountStatus> {
    const activeId = await this.getActiveAccountId();
    if (!activeId) {
      return { isLoggedIn: false, message: "未选择账号" };
    }
    const isLoggedIn = await this.isAccountLoggedIn(activeId);
    if (!isLoggedIn) {
      return { isLoggedIn: false, message: "账号未登录" };
    }
    // Also check main auth.json exists
    const mainAuth = await this.readFileOrNull(path.join(this.mainCodexDir, "auth.json"));
    if (!mainAuth) return { isLoggedIn: false, message: "auth.json 未同步" };
    return { isLoggedIn: true, message: "已登录" };
  }

  /** Manually set auth.json content for an account. */
  async setAuthJson(accountId: string, content: string): Promise<OpenAIAccountLoginResult> {
    await this.requireAccount(accountId);
    try {
      parseAuthJson(content);
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "auth.json 格式无效" };
    }
    if (this.getStore().getActiveAccountId() === accountId) {
      const pending = this.getStore().getPendingTransition();
      this.getStore().queueTransition(pending ? pending.targetAccountId : accountId, { stagedAuth: { accountId, authJson: content } });
    } else {
      this.getStore().saveAuthJson(accountId, content);
    }
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
    return { success: true, message: "auth.json 已保存" };
  }

  /** Get the raw auth.json content for an account. */
  async getAuthJsonContent(accountId: string): Promise<string | null> {
    await this.requireAccount(accountId);
    return this.getStore().getAuthJson(accountId);
  }

  async getAccountDetails(accountId: string): Promise<OpenAIAccountDetails> {
    return await this.requireAccount(accountId);
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
    await this.requireAccount(input.accountId);
    this.getStore().update(input);
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
    return { success: true };
  }

  importAccounts(input: string): { added: number; updated: number } {
    const result = this.getStore().importProfiles(input);
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
    return result;
  }

  async setImageGenerationEnabled(accountId: string, enabled: boolean): Promise<void> {
    await this.requireAccount(accountId);
    this.getStore().setImageGenerationEnabled(accountId, enabled);
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
  }

  saveImageQuota(accountId: string, authJson: string, quota: OpenAIAccountImageQuota): void {
    this.getStore().saveImageQuota(accountId, authJson, quota);
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
  }

  async cancelPendingAccountSwitch(): Promise<{ success: boolean }> {
    const store = this.getStore();
    const pending = store.getPendingTransition();
    const activeId = store.getActiveAccountId();
    if (pending?.stagedAuth && pending.stagedAuth.accountId === activeId && pending.targetAccountId !== activeId) {
      store.queueTransition(activeId, { stagedAuth: pending.stagedAuth });
    } else {
      store.cancelPendingTransition();
    }
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
    return { success: true };
  }

  /** Quota/usage data for an OpenAI account. */
  async getActiveProxyUrl(): Promise<string | undefined> {
    const activeId = await this.getActiveAccountId();
    if (!activeId) return undefined;
    return (await this.requireAccount(activeId)).proxyUrl?.trim() || undefined;
  }

  async queryQuota(accountId: string): Promise<OpenAIAccountQuota> {
    const account = await this.requireAccount(accountId);
    let auth: {
      access_token?: string;
      account_id?: string;
      tokens?: { access_token?: string; account_id?: string };
    };
    try {
      const content = account.authJson;
      if (!content) throw new Error("missing auth.json");
      auth = JSON.parse(content);
    } catch (e) {
      console.error(`[openai-quota] Failed to read auth.json for ${accountId}.`);
      throw new Error("OpenAI account auth.json could not be read.");
    }

    // Token can be at top level or nested under "tokens"
    const accessToken = auth.access_token ?? auth.tokens?.access_token;
    const chatgptAccountId = auth.account_id ?? auth.tokens?.account_id;
    if (!accessToken || !chatgptAccountId) {
      console.error(`[openai-quota] Missing access_token or account_id for ${accountId}`);
      throw new Error("OpenAI account credentials are incomplete.");
    }

    // Get the account's proxy URL.
    const proxyUrl = account.proxyUrl?.trim() || undefined;

    let quota: OpenAIAccountQuota;
    try {
      console.log(
        `[openai-quota] Querying usage for account ${accountId}${proxyUrl ? ` via proxy ${proxyEndpointForLog(proxyUrl)}` : ""}`,
      );

      let resp: { status: number; ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> };

      if (proxyUrl) {
        const parsed = new URL(proxyUrl);
        if (parsed.protocol.startsWith("socks")) {
          // Use SocksProxyAgent (supports auth)
          const agent = new SocksProxyAgent(proxyUrl);
          const data = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = https.request(
              {
                host: "chatgpt.com",
                port: 443,
                path: "/backend-api/wham/usage",
                method: "GET",
                agent,
                timeout: 20000,
                headers: {
                  authorization: `Bearer ${accessToken}`,
                  "chatgpt-account-id": chatgptAccountId,
                  "openai-beta": "codex-1",
                  "oai-language": "zh-CN",
                  originator: "Codex Desktop",
                  accept: "application/json",
                  "sec-fetch-site": "none",
                  "sec-fetch-mode": "no-cors",
                  "sec-fetch-dest": "empty",
                  priority: "u=4, i",
                },
              },
              (res) => {
                let body = "";
                res.on("data", (chunk) => (body += chunk));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
              },
            );
            req.on("error", reject);
            req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
            req.end();
          });
          resp = {
            status: data.status,
            ok: data.status === 200,
            json: async () => JSON.parse(data.body),
            text: async () => data.body,
          };
        } else {
          // HTTP proxy: use undici via createUpstreamFetchController
          const controller = createUpstreamFetchController(proxyUrl);
          try {
            const fetcher = controller.fetch;
            const r = await fetcher("https://chatgpt.com/backend-api/wham/usage", {
              method: "GET",
              headers: {
                authorization: `Bearer ${accessToken}`,
                "chatgpt-account-id": chatgptAccountId,
                "openai-beta": "codex-1",
                "oai-language": "zh-CN",
                originator: "Codex Desktop",
                accept: "application/json",
                "sec-fetch-site": "none",
                "sec-fetch-mode": "no-cors",
                "sec-fetch-dest": "empty",
                priority: "u=4, i",
              },
            });
            resp = r;
          } finally {
            controller.close();
          }
        }
      } else {
        const r = await fetch("https://chatgpt.com/backend-api/wham/usage", {
          method: "GET",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "chatgpt-account-id": chatgptAccountId,
            "openai-beta": "codex-1",
            "oai-language": "zh-CN",
            originator: "Codex Desktop",
            accept: "application/json",
            "sec-fetch-site": "none",
            "sec-fetch-mode": "no-cors",
            "sec-fetch-dest": "empty",
            priority: "u=4, i",
          },
        });
        resp = r;
      }

      console.log(`[openai-quota] Response status: ${resp.status}`);
      if (!resp.ok) {
        await resp.text().catch(() => "");
        console.error(`[openai-quota] Non-OK response for ${accountId}: ${resp.status}`);
        throw new Error(`OpenAI quota request failed with status ${resp.status}.`);
      }

      const data = (await resp.json()) as {
        plan_type?: string;
        email?: string;
        rate_limit?: {
          allowed?: boolean;
          limit_reached?: boolean;
          primary_window?: {
            used_percent?: number;
            limit_window_seconds?: number;
            reset_after_seconds?: number;
            reset_at?: number;
          };
          secondary_window?: {
            used_percent?: number;
            limit_window_seconds?: number;
            reset_after_seconds?: number;
            reset_at?: number;
          };
        };
        rate_limit_reset_credits?: {
          available_count?: number;
        };
      };

      quota = {
        planType: data.plan_type ?? "unknown",
        email: data.email ?? "",
        rateLimit: {
          allowed: data.rate_limit?.allowed ?? true,
          limitReached: data.rate_limit?.limit_reached ?? false,
          primaryWindow: data.rate_limit?.primary_window
            ? {
                usedPercent: data.rate_limit.primary_window.used_percent ?? 0,
                limitWindowSeconds: data.rate_limit.primary_window.limit_window_seconds ?? 0,
                resetAfterSeconds: data.rate_limit.primary_window.reset_after_seconds ?? 0,
                resetAt: data.rate_limit.primary_window.reset_at ?? 0,
              }
            : null,
          secondaryWindow: data.rate_limit?.secondary_window
            ? {
                usedPercent: data.rate_limit.secondary_window.used_percent ?? 0,
                limitWindowSeconds: data.rate_limit.secondary_window.limit_window_seconds ?? 0,
                resetAfterSeconds: data.rate_limit.secondary_window.reset_after_seconds ?? 0,
                resetAt: data.rate_limit.secondary_window.reset_at ?? 0,
              }
            : null,
        },
        resetCreditsAvailable: data.rate_limit_reset_credits?.available_count ?? 0,
        fetchedAt: Date.now(),
      };
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("OpenAI quota request failed with status")) {
        throw e;
      }
      console.error(`[openai-quota] Request failed for ${accountId}.`);
      throw new Error("OpenAI quota request failed.");
    }
    // Only a successful refresh updates the snapshot and its timestamp. Keep
    // storage errors distinct from network errors and do not claim success.
    try {
      this.getStore().saveQuota(accountId, chatgptAccountId, quota);
    } catch (error) {
      throw new Error(`额度已获取，但保存缓存失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.onAccountsChanged?.({ syncStatus: this.syncStatus });
    return quota;
  }
}
