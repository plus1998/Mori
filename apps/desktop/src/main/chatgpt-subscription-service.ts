import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  IncrementalSseParser,
  parseResponsesSseFrame,
  normalizeResponsesUsage,
  type GatewayCredentialResult,
  type GatewayProvider,
  type GatewayUpstreamErrorInfo,
} from "@eco/gateway";
import type { AccountUsageRecord } from "./account-usage-store";

const AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
const ACCESS_TOKEN_SKEW_MS = 60_000;
const GENERAL_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const UNAVAILABLE_COOLDOWN_MS = 30_000;
const SAFE_UPSTREAM_DIAGNOSTIC_HEADERS = [
  "content-type",
  "request-id",
  "x-request-id",
  "openai-request-id",
  "anthropic-request-id",
  "x-eco-provider-request-id",
  "retry-after",
] as const;

function readSafeUpstreamDiagnosticHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    SAFE_UPSTREAM_DIAGNOSTIC_HEADERS.flatMap((name) => {
      const value = headers.get(name)?.trim();
      return value ? [[name, value] as const] : [];
    }),
  );
}

function readUpstreamErrorCode(body: string): string | undefined {
  try {
    const payload = JSON.parse(body) as { error?: { code?: unknown }; code?: unknown };
    const code = payload.error?.code ?? payload.code;
    return typeof code === "string" && code.trim() ? code.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readUpstreamErrorDetails(body: string): {
  code?: string;
  param?: string;
  message?: string;
  type?: string;
  rawEvent?: unknown;
} {
  let rawEvent: unknown = body;
  try {
    const payload = JSON.parse(body) as {
      error?: { code?: unknown; param?: unknown; message?: unknown; type?: unknown };
      code?: unknown;
      param?: unknown;
      message?: unknown;
    };
    rawEvent = payload;
    const error = payload.error;
    return {
      ...(typeof (error?.code ?? payload.code) === "string"
        ? { code: String(error?.code ?? payload.code).trim() }
        : {}),
      ...(typeof (error?.param ?? payload.param) === "string"
        ? { param: String(error?.param ?? payload.param).trim() }
        : {}),
      ...(typeof (error?.message ?? payload.message) === "string"
        ? { message: String(error?.message ?? payload.message).trim() }
        : {}),
      ...(typeof error?.type === "string" && error.type.trim()
        ? { type: error.type.trim() }
        : {}),
      rawEvent,
    };
  } catch {
    return { rawEvent };
  }
}

function eventErrorDetails(event: Record<string, unknown>): {
  code?: string;
  param?: string;
  message: string;
  type?: string;
  eventType?: string;
  rawEvent?: unknown;
} {
  const response = isRecord(event.response) ? event.response : undefined;
  const errorSource =
    isRecord(event.error)
      ? event.error
      : response && isRecord(response.error)
        ? response.error
        : event;
  const message =
    typeof event.error === "string"
      ? event.error
      : readOptionalString(errorSource, "message") ??
        readOptionalString(event, "message") ??
        "官方 Responses 流返回失败事件";
  const code = readOptionalString(errorSource, "code") ?? readOptionalString(event, "code");
  const param = readOptionalString(errorSource, "param") ?? readOptionalString(event, "param");
  const type =
    readOptionalString(errorSource, "type") ??
    readOptionalString(event, "error_type") ??
    readOptionalString(event, "type");
  const eventType = readOptionalString(event, "type");
  return {
    message,
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
    ...(type ? { type } : {}),
    ...(eventType ? { eventType } : {}),
    rawEvent: event,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function explainResponsesError(statusCode: number, errorCode: string | undefined, body: string): string {
  if (errorCode === "subscription_sharing_usage_limit_exceeded") {
    return "该账号的 ChatGPT 订阅用量受限，本轮已停止。请查看 Usage，并在账号设置中手动测试；真实测试完成后才会恢复自动选用。";
  }
  if (errorCode === "subscription_sharing_user_not_eligible") {
    return "该 ChatGPT 账号当前不具备订阅共享资格（用户、工作区或策略限制）。请在 ChatGPT 中确认账号和工作区权限；重复发送请求或反复授权无法绕过此限制。";
  }
  return `官方 Responses API 请求失败（${statusCode}）${body ? `：${body.slice(0, 240)}` : ""}`;
}

export type ChatGptSubscriptionStatus =
  | "needs_login"
  | "ready"
  | "refreshing"
  | "rate_limited"
  | "subscription_usage_paused"
  | "temporarily_unavailable"
  | "not_eligible"
  | "reauthorization_required"
  | "disabled";

export interface ChatGptSubscriptionAccountView {
  accountId: string;
  displayName: string;
  email?: string;
  proxyUrl?: string;
  subject?: string;
  status: ChatGptSubscriptionStatus;
  enabled: boolean;
  cooldownUntil?: number;
  lastUsedAt?: number;
  lastSuccessAt?: number;
  lastErrorCode?: string;
  lastErrorAt?: number;
  subscriptionUsagePausedAt?: number;
  subscriptionUsagePause?: ChatGptSubscriptionUsagePauseEvidence;
  hasCredentials: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ChatGptSubscriptionUsagePauseEvidence {
  code: "subscription_sharing_usage_limit_exceeded";
  pausedAt: number;
  statusCode: number;
  message: string;
  type?: string;
  eventType?: string;
  rawEvent?: unknown;
  providerRequestId?: string;
  responseId?: string;
  param?: string;
  logicalRequestId?: string;
  attemptIndex?: number;
  bridgeBindingId?: string;
  threadId?: string;
  turnId?: string;
  runAttemptId?: string;
}

interface StoredAccount {
  accountId: string;
  displayName: string;
  clientId?: string;
  subject?: string;
  issuer?: string;
  email?: string;
  proxyUrl?: string;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  scopes: string[];
  accessTokenExpiresAt?: number;
  earliestRefreshAt?: number;
  status: ChatGptSubscriptionStatus;
  enabled: boolean;
  cooldownUntil?: number;
  lastUsedAt?: number;
  lastSuccessAt?: number;
  lastErrorCode?: string;
  lastErrorAt?: number;
  subscriptionUsagePausedAt?: number;
  subscriptionUsagePause?: ChatGptSubscriptionUsagePauseEvidence;
  createdAt: number;
  updatedAt: number;
}

interface PersistedState {
  version: 1;
  extAgentHostId: string;
  accounts: StoredAccount[];
}

interface SecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface PendingLogin {
  accountId: string;
  clientId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  server: Server;
}

export interface ChatGptSubscriptionLogin {
  authorizationUrl: string;
  result: Promise<ChatGptSubscriptionAccountView>;
}

export class ChatGptSubscriptionService {
  private state: PersistedState = {
    version: 1,
    extAgentHostId: `urn:uuid:${randomUUID()}`,
    accounts: [],
  };
  private initialized = false;
  private readonly refreshLocks = new Map<string, Promise<StoredAccount>>();
  private readonly explicitProxyFetches = new Map<string, typeof fetch>();
  private roundRobinCursor = 0;
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly jwks = createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json"));
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly codec: SecretCodec,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly explicitProxyFetchFactory?: (proxyUrl: string) => typeof fetch,
    private readonly onUsage?: (record: AccountUsageRecord) => void,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.codec.isAvailable()) {
      throw new Error("系统安全存储不可用，无法安全保存 ChatGPT 订阅凭据");
    }
    const filePath = this.statePath();
    try {
      const raw = await fs.readFile(filePath, "utf8");
      this.state = JSON.parse(this.codec.decrypt(raw)) as PersistedState;
      this.validateState();
      for (const account of this.state.accounts) {
        if (account.subscriptionUsagePause || account.subscriptionUsagePausedAt) {
          account.subscriptionUsagePausedAt ??= account.updatedAt || Date.now();
          account.status = account.enabled ? "subscription_usage_paused" : "disabled";
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
    this.initialized = true;
  }

  getHostId(): string {
    return this.state.extAgentHostId;
  }

  listAccounts(): ChatGptSubscriptionAccountView[] {
    return this.state.accounts.map((account) => this.toView(account));
  }

  async createAccount(displayName: string, proxyUrl?: string): Promise<ChatGptSubscriptionAccountView> {
    this.assertInitialized();
    const now = Date.now();
    const normalizedProxyUrl = normalizeAccountProxyUrl(proxyUrl);
    const account: StoredAccount = {
      accountId: randomUUID(),
      displayName: displayName.trim() || "ChatGPT 账号",
      ...(normalizedProxyUrl ? { proxyUrl: normalizedProxyUrl } : {}),
      scopes: [],
      status: "needs_login",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.state.accounts.push(account);
    await this.persist();
    return this.toView(account);
  }

  async setProxyUrl(accountId: string, proxyUrl?: string): Promise<ChatGptSubscriptionAccountView> {
    const account = this.findRequiredAccount(accountId);
    const normalizedProxyUrl = normalizeAccountProxyUrl(proxyUrl);
    if (normalizedProxyUrl) {
      account.proxyUrl = normalizedProxyUrl;
    } else {
      delete account.proxyUrl;
    }
    account.updatedAt = Date.now();
    await this.persist();
    return this.toView(account);
  }

  async deleteAccount(accountId: string): Promise<void> {
    this.assertInitialized();
    const account = this.findAccount(accountId);
    if (account?.refreshToken && account.clientId) {
      try {
        await this.revoke(account);
      } catch {
        // Local deletion still proceeds; the UI can direct the user to ChatGPT settings.
      }
    }
    this.state.accounts = this.state.accounts.filter((entry) => entry.accountId !== accountId);
    await this.persist();
  }

  async setEnabled(accountId: string, enabled: boolean): Promise<ChatGptSubscriptionAccountView> {
    const account = this.findRequiredAccount(accountId);
    account.enabled = enabled;
    account.status = enabled
      ? (account.subscriptionUsagePause || account.subscriptionUsagePausedAt
          ? "subscription_usage_paused"
          : account.refreshToken
            ? (account.status === "not_eligible" ? "not_eligible" : "ready")
            : "needs_login")
      : "disabled";
    account.updatedAt = Date.now();
    await this.persist();
    return this.toView(account);
  }

  async resetAvailability(accountId: string): Promise<ChatGptSubscriptionAccountView> {
    const account = this.findRequiredAccount(accountId);
    if (account.subscriptionUsagePause || account.subscriptionUsagePausedAt) {
      account.status = account.enabled ? "subscription_usage_paused" : "disabled";
      account.updatedAt = Date.now();
      await this.persist();
      return this.toView(account);
    }
    account.status = account.refreshToken ? "ready" : "needs_login";
    delete account.cooldownUntil;
    delete account.lastErrorCode;
    delete account.lastErrorAt;
    account.updatedAt = Date.now();
    await this.persist();
    return this.toView(account);
  }

  async beginLogin(accountId: string, options: { includeAccountHints?: boolean } = {}): Promise<ChatGptSubscriptionLogin> {
    this.assertInitialized();
    const account = this.findRequiredAccount(accountId);
    if (this.pendingLogins.has(accountId)) {
      throw new Error("该账号已有进行中的 ChatGPT OAuth 授权，请先完成或取消当前授权");
    }
    const state = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const clientId = account.clientId || "dynamic_agent_client";
    const server = createServer((request, response) => {
      void this.handleCallback(request.url, account.accountId, response).catch((error) => {
        response.statusCode = 500;
        response.end("ChatGPT 登录失败，请返回 Eco Coding 重试。");
        this.rejectPending(account.accountId, error);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("无法启动本地 OAuth 回调端口");
    }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const pending: PendingLogin = { accountId, clientId, state, nonce, codeVerifier, redirectUri, server };
    this.pendingLogins.set(accountId, pending);
    const params = new URLSearchParams({
      client_id: clientId,
      ext_agent_host_id: this.state.extAgentHostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
    });
    if (clientId === "dynamic_agent_client") {
      params.set("agent_name_hint", "Eco Coding");
    } else if (options.includeAccountHints !== false && account.idToken) {
      params.set("id_token_hint", account.idToken);
      if (account.email) params.set("login_hint", account.email);
    }
    let resolveResult!: (value: ChatGptSubscriptionAccountView) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<ChatGptSubscriptionAccountView>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    (pending as PendingLogin & { resolve?: typeof resolveResult; reject?: typeof rejectResult }).resolve = resolveResult;
    (pending as PendingLogin & { resolve?: typeof resolveResult; reject?: typeof rejectResult }).reject = rejectResult;
    return { authorizationUrl: `${AUTHORIZATION_ENDPOINT}?${params.toString()}`, result };
  }

  /** Cancel a pending login when the embedded OAuth window is closed. */
  cancelLogin(accountId: string, reason = "ChatGPT OAuth 登录已取消"): void {
    this.rejectPending(accountId, new Error(reason));
  }

  async resolveCredential(provider: GatewayProvider): Promise<{ accessToken: string; accountId: string; upstreamProxyUrl?: string }> {
    this.assertInitialized();
    const poolId = provider.credentialPoolId || "chatgpt-default";
    if (poolId !== "chatgpt-default") {
      throw new Error(`未知的 ChatGPT 订阅账号池：${poolId}`);
    }
    const candidates = this.state.accounts.filter((account) => {
      const now = Date.now();
      return account.enabled && account.status !== "disabled" && account.refreshToken &&
        !account.subscriptionUsagePause && !account.subscriptionUsagePausedAt &&
        account.status !== "subscription_usage_paused" &&
        account.status !== "reauthorization_required" && account.status !== "not_eligible" &&
        (!account.cooldownUntil || account.cooldownUntil <= now);
    });
    if (candidates.length === 0) {
      const pausedAccounts = this.state.accounts.filter((account) =>
        account.enabled && Boolean(account.refreshToken) && (
          account.subscriptionUsagePause || account.subscriptionUsagePausedAt ||
          account.status === "subscription_usage_paused"
        ),
      );
      if (pausedAccounts.length > 0) {
        // A local pool rejection, not a new upstream HTTP failure. There is no
        // known cooldown; only a successful manual test can restore selection.
        throw Object.assign(new Error(
          "没有可用的 ChatGPT 订阅账号：用量受限账号已暂停，请在账号设置中手动测试，测试成功后才能恢复",
        ), {
          statusCode: 403,
          errorCode: "subscription_sharing_usage_limit_exceeded",
          ...(pausedAccounts.length === 1 ? { accountId: pausedAccounts[0]!.accountId } : {}),
        });
      }
      const hasIneligibleAccount = this.state.accounts.some((account) =>
        account.enabled && account.status === "not_eligible" && Boolean(account.refreshToken),
      );
      const error = new Error(hasIneligibleAccount
        ? "The ChatGPT user is not eligible for subscription sharing."
        : "没有可用的 ChatGPT 订阅账号，请先登录账号或等待账号冷却结束");
      if (hasIneligibleAccount) {
        Object.assign(error, {
          statusCode: 403,
          errorCode: "subscription_sharing_user_not_eligible",
        });
      }
      throw error;
    }
    const account = candidates[this.roundRobinCursor++ % candidates.length]!;
    const refreshed = await this.ensureFresh(account);
    refreshed.lastUsedAt = Date.now();
    refreshed.updatedAt = Date.now();
    await this.persist();
    return {
      accessToken: refreshed.accessToken!,
      accountId: refreshed.accountId,
      ...(refreshed.proxyUrl ? { upstreamProxyUrl: refreshed.proxyUrl } : {}),
    };
  }

  async testAccount(accountId: string, modelId: string): Promise<{ success: true; message: string }> {
    this.assertInitialized();
    const account = this.findRequiredAccount(accountId);
    if (!account.refreshToken) throw new Error("此账号尚未完成官方 OAuth 授权");
    const model = modelId.trim();
    if (!model) throw new Error("请先选择要测试的模型");
    // Each quota failure replaces the evidence object, even when pausedAt is
    // retained. A probe may only clear the pause it started against.
    const testedPause = account.subscriptionUsagePause;
    const testedPausedAt = account.subscriptionUsagePausedAt;
    const provider = subscriptionTestProvider(model);
    const logicalRequestId = randomUUID();
    let response: Response | undefined;
    let providerRequestId: string | undefined;
    let responseBody = "";
    let responseId: string | undefined;
    let failure: GatewayUpstreamErrorInfo | undefined;
    let completed = false;
    let terminalReported = false;

    const reportOnce = async (input: GatewayCredentialResult): Promise<void> => {
      if (terminalReported) return;
      terminalReported = true;
      await this.reportCredentialResult(input);
    };

    try {
      const refreshed = await this.ensureFresh(account);
      const requestBody = JSON.stringify({
        model,
        input: [{ role: "user", content: "hi" }],
        store: false,
        stream: true,
      });
      process.stderr.write(`[chatgpt-subscription] test hi request body=${requestBody}\n`);
      response = await this.fetchFor(refreshed)("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${refreshed.accessToken}`,
        },
        body: requestBody,
      });
      providerRequestId =
        response.headers.get("x-request-id") ??
        response.headers.get("request-id") ??
        response.headers.get("openai-request-id") ??
        undefined;

      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const parser = new IncrementalSseParser();
        const decoder = new TextDecoder();
        const inspectFrames = (frames: ReturnType<IncrementalSseParser["push"]>): boolean => {
          for (const frame of frames) {
            let event: Record<string, unknown>;
            try {
              event = parseResponsesSseFrame(frame) as unknown as Record<string, unknown>;
            } catch (error) {
              failure = {
                message: error instanceof Error ? error.message : String(error),
                code: "invalid_stream",
                ...(frame.event ? { eventType: frame.event } : {}),
                rawEvent: frame.data,
              };
              return true;
            }
            const eventResponse = isRecord(event.response) ? event.response : undefined;
            responseId = readOptionalString(eventResponse ?? {}, "id") ?? responseId;
            const type = readOptionalString(event, "type");
            if (
              eventResponse?.usage && this.onUsage &&
              (type === "response.completed" || type === "response.failed" || type === "response.incomplete")
            ) {
              const usageModel = readOptionalString(eventResponse, "model") ?? model;
              const usage = normalizeResponsesUsage(eventResponse.usage as never, usageModel);
              if (usage) {
                this.onUsage({
                  ...usage, kind: "chatgpt_oauth", accountId, modelId: usageModel,
                  eventId: `oauth-test:${responseId ?? logicalRequestId}`, observedAt: Date.now(),
                });
              } else {
                process.stderr.write("[account-usage] OAuth account test returned invalid usage; tokens not recorded.\n");
              }
            }
            if (type === "response.completed") {
              if (!responseId) {
                failure = {
                  message: "官方 Responses 流完成事件缺少 response.id",
                  code: "invalid_stream",
                  eventType: type,
                  rawEvent: event,
                };
                return true;
              }
              completed = true;
              return true;
            }
            if (
              type === "response.failed" ||
              type === "response.incomplete" ||
              type === "error" ||
              isRecord(event.error)
            ) {
              failure = eventErrorDetails(event);
              if (type === "response.incomplete" && !failure.code) {
                failure.code = "response_incomplete";
              }
              return true;
            }
          }
          return false;
        };
        try {
          while (!completed && !failure) {
            const { done, value } = await reader.read();
            if (done) {
              responseBody += decoder.decode();
              inspectFrames(parser.finish());
              break;
            }
            responseBody += decoder.decode(value, { stream: true });
            if (inspectFrames(parser.push(value))) {
              break;
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      } else if (response.ok) {
        failure = {
          message: "官方 Responses 接口未返回可读取的流",
          code: "incomplete_stream",
          eventType: "stream",
          rawEvent: { reason: "missing_body" },
        };
      } else {
        responseBody = await response.text();
      }

      const diagnosticHeaders = readSafeUpstreamDiagnosticHeaders(response.headers);
      process.stderr.write(
        `[chatgpt-subscription] test hi upstream response status=${response.status} ` +
          `headers=${JSON.stringify(diagnosticHeaders)} ` +
          `body=${responseBody}\n`,
      );

      if (!response.ok) {
        const httpError = readUpstreamErrorDetails(responseBody);
        failure = {
          message: httpError.message ?? (responseBody.trim() || `HTTP ${response.status}`),
          ...(httpError.code ? { code: httpError.code } : {}),
          ...(httpError.param ? { param: httpError.param } : {}),
          ...(httpError.type ? { type: httpError.type } : {}),
          eventType: "http",
          rawEvent: httpError.rawEvent,
        };
      } else if (!failure && !completed) {
        failure = {
          message: "官方 Responses 流在 response.completed 前结束",
          code: "incomplete_stream",
          eventType: "stream",
          rawEvent: { reason: "eof_before_completed" },
        };
      }

      if (failure) {
        await reportOnce({
          provider,
          accountId,
          resultType: "failed",
          statusCode: response.status,
          logicalRequestId,
          attemptIndex: 0,
          ...(providerRequestId ? { providerRequestId } : {}),
          ...(responseId ? { responseId } : {}),
          error: failure,
        });
        if (!response.ok) {
          throw new Error(explainResponsesError(response.status, failure.code, responseBody.trim()));
        }
        throw new Error(
          `官方 Responses 流返回失败：${failure.message}` +
            `（code=${failure.code ?? "upstream_error"}` +
            `${failure.param ? `，param=${failure.param}` : ""}）`,
        );
      }

      await reportOnce({
        provider,
        accountId,
        resultType: "completed",
        statusCode: response.status,
        logicalRequestId,
        attemptIndex: 0,
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(responseId ? { responseId } : {}),
      });
      const current = this.findRequiredAccount(accountId);
      if (
        (current.subscriptionUsagePause || current.subscriptionUsagePausedAt) && (
          current.subscriptionUsagePause !== testedPause ||
          current.subscriptionUsagePausedAt !== testedPausedAt
        )
      ) {
        throw new Error("测试期间收到新的 ChatGPT 订阅用量限制，账号仍已暂停，请重新手动测试");
      }
      if (current.subscriptionUsagePause || current.subscriptionUsagePausedAt) {
        delete current.subscriptionUsagePause;
        delete current.subscriptionUsagePausedAt;
        delete current.cooldownUntil;
        delete current.lastErrorCode;
        delete current.lastErrorAt;
        current.status = current.enabled ? "ready" : "disabled";
        current.lastSuccessAt = Date.now();
        current.updatedAt = Date.now();
        await this.persist();
      }
      if (current.subscriptionUsagePause || current.subscriptionUsagePausedAt) {
        throw new Error("测试期间收到新的 ChatGPT 订阅用量限制，账号仍已暂停，请重新手动测试");
      }
      return { success: true, message: "官方 OAuth 授权有效，已成功发送测试消息 hi" };
    } catch (error) {
      if (!terminalReported) {
        const message = error instanceof Error ? error.message : String(error);
        await reportOnce({
          provider,
          accountId,
          resultType: "failed",
          ...(response ? { statusCode: response.status } : {}),
          logicalRequestId,
          attemptIndex: 0,
          ...(providerRequestId ? { providerRequestId } : {}),
          ...(responseId ? { responseId } : {}),
          error: {
            message,
            code: response ? "invalid_stream" : "transport_error",
            eventType: response ? "stream" : "transport",
            rawEvent: { message },
          },
        });
      }
      throw error;
    }
  }

  /**
   * Fetch the model catalog with an OAuth access token from one available account.
   * ChatGPT subscription providers must use this path instead of the generic
   * API-key model discovery request.
   */
  async listModels(accountId?: string, signal?: AbortSignal): Promise<Array<{ id: string; displayName?: string }>> {
    this.assertInitialized();
    let account: StoredAccount;
    if (accountId) {
      account = this.findRequiredAccount(accountId);
      if (!account.refreshToken) throw new Error("此账号尚未完成官方 OAuth 授权");
    } else {
      const candidates = this.state.accounts.filter((candidate) => {
        const now = Date.now();
        return candidate.enabled && candidate.status !== "disabled" && candidate.refreshToken &&
          !candidate.subscriptionUsagePause && !candidate.subscriptionUsagePausedAt &&
          candidate.status !== "subscription_usage_paused" &&
          candidate.status !== "reauthorization_required" && candidate.status !== "not_eligible" &&
          (!candidate.cooldownUntil || candidate.cooldownUntil <= now);
      });
      if (candidates.length === 0) {
        throw new Error("没有可用于自动选用的 ChatGPT 订阅账号；受限账号仍可在账号详情中手动测试");
      }
      account = candidates[this.roundRobinCursor++ % candidates.length]!;
    }
    const refreshed = await this.ensureFresh(account);
    refreshed.lastUsedAt = Date.now();
    refreshed.updatedAt = Date.now();
    const response = await this.fetchFor(refreshed)("https://api.openai.com/v1/models", {
      method: "GET",
      ...(signal ? { signal } : {}),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${refreshed.accessToken}`,
      },
    });
    const responseBody = await response.text();
    const errorCode = response.ok ? undefined : readUpstreamErrorCode(responseBody);
    if (!response.ok) {
      await this.reportCredentialResult({
        provider: subscriptionTestProvider("gpt-5"),
        accountId: refreshed.accountId,
        resultType: "failed",
        statusCode: response.status,
        logicalRequestId: randomUUID(),
        attemptIndex: 0,
        error: {
          message: responseBody.trim() || `HTTP ${response.status}`,
          ...(errorCode ? { code: errorCode } : {}),
          eventType: "http",
        },
      });
    }
    if (!response.ok) {
      throw new Error(`官方模型列表获取失败（${response.status}）${errorCode === "subscription_sharing_user_not_eligible" ? "该账号当前不具备订阅共享资格" : responseBody.trim().slice(0, 240)}`);
    }
    const payload = JSON.parse(responseBody) as {
      models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
    };
    const models = Array.from(new Set(
      (payload.models ?? [])
        .filter((model) => model.visibility === "list")
        .map((model) => (typeof model.slug === "string" ? model.slug.trim() : ""))
        .filter(Boolean),
    )).map((id) => {
      const model = payload.models?.find((entry) => entry.slug === id);
      return {
        id,
        ...(typeof model?.display_name === "string" && model.display_name.trim()
          ? { displayName: model.display_name.trim() }
          : {}),
      };
    });
    if (models.length === 0) {
      throw new Error("官方模型列表为空");
    }
    return models;
  }

  async reportCredentialResult(input: GatewayCredentialResult): Promise<void> {
    if (!input.accountId) return;
    const account = this.findAccount(input.accountId);
    if (!account) return;
    const now = Date.now();
    const statusCode = input.statusCode;
    const errorCode = input.error?.code;
    const alreadyPaused = Boolean(
      account.subscriptionUsagePause || account.subscriptionUsagePausedAt,
    );

    if (
      alreadyPaused ||
      (input.resultType === "failed" && errorCode === "subscription_sharing_usage_limit_exceeded")
    ) {
      if (errorCode === "subscription_sharing_usage_limit_exceeded") {
        const pausedAt = account.subscriptionUsagePausedAt ?? now;
        account.subscriptionUsagePausedAt = pausedAt;
        account.subscriptionUsagePause = {
          code: errorCode,
          pausedAt,
          statusCode: statusCode ?? 0,
          message: input.error?.message ?? "ChatGPT subscription usage limit exceeded",
          ...(input.error?.type ? { type: input.error.type } : {}),
          ...(input.error?.eventType ? { eventType: input.error.eventType } : {}),
          ...(input.error?.rawEvent !== undefined ? { rawEvent: input.error.rawEvent } : {}),
          ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
          ...(input.responseId ? { responseId: input.responseId } : {}),
          ...(input.error?.param ? { param: input.error.param } : {}),
          logicalRequestId: input.logicalRequestId,
          attemptIndex: input.attemptIndex,
          ...(input.bridgeBindingId ? { bridgeBindingId: input.bridgeBindingId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.runAttemptId ? { runAttemptId: input.runAttemptId } : {}),
        };
      }
      account.status = account.enabled ? "subscription_usage_paused" : "disabled";
      if (input.resultType === "failed" && errorCode === "subscription_sharing_usage_limit_exceeded") {
        account.lastErrorCode = errorCode;
        account.lastErrorAt = now;
      }
      if (input.resultType === "completed") {
        account.lastSuccessAt = now;
      }
      delete account.cooldownUntil;
    } else if (input.resultType === "failed" && statusCode === 401) {
      account.status = "reauthorization_required";
      account.lastErrorCode = "invalid_user";
      account.lastErrorAt = now;
    } else if (input.resultType === "failed" && errorCode === "subscription_sharing_user_not_eligible") {
      account.status = "not_eligible";
      account.lastErrorCode = errorCode;
      account.lastErrorAt = now;
      delete account.cooldownUntil;
    } else if (input.resultType === "failed" && statusCode === 403) {
      // Do not turn an unknown 403 into an eligibility diagnosis. Preserve the
      // actual HTTP failure so a newly introduced upstream policy is visible.
      account.status = "temporarily_unavailable";
      account.lastErrorCode = "http_403";
      account.lastErrorAt = now;
      account.cooldownUntil = now + UNAVAILABLE_COOLDOWN_MS;
    } else if (input.resultType === "failed" && statusCode === 429) {
      account.status = "rate_limited";
      account.lastErrorCode = errorCode ?? "http_429";
      account.lastErrorAt = now;
      account.cooldownUntil = now + GENERAL_RATE_LIMIT_COOLDOWN_MS;
    } else if (input.resultType === "failed" && statusCode === 503) {
      account.status = "temporarily_unavailable";
      account.lastErrorCode = errorCode ?? "http_503";
      account.lastErrorAt = now;
      account.cooldownUntil = now + UNAVAILABLE_COOLDOWN_MS;
    } else if (input.resultType === "failed" && statusCode && statusCode >= 400) {
      account.lastErrorAt = now;
      account.lastErrorCode = errorCode ?? `http_${statusCode}`;
    } else if (input.resultType === "completed") {
      // A late success is still useful evidence, but it cannot revoke a
      // subscription-usage pause. Only testAccount may clear that pause.
      if (!account.subscriptionUsagePause) {
        account.status = "ready";
        delete account.cooldownUntil;
        delete account.lastErrorCode;
        delete account.lastErrorAt;
      }
      account.lastSuccessAt = now;
    }
    account.updatedAt = now;
    await this.persist();
  }

  private async ensureFresh(account: StoredAccount): Promise<StoredAccount> {
    if ((account.accessTokenExpiresAt ?? 0) - ACCESS_TOKEN_SKEW_MS > Date.now() && account.accessToken) {
      return account;
    }
    const existing = this.refreshLocks.get(account.accountId);
    if (existing) return existing;
    const promise = this.refresh(account).finally(() => this.refreshLocks.delete(account.accountId));
    this.refreshLocks.set(account.accountId, promise);
    return promise;
  }

  private async refresh(account: StoredAccount): Promise<StoredAccount> {
    if (!account.clientId || !account.refreshToken) {
      account.status = "needs_login";
      throw new Error(`ChatGPT 账号 ${account.displayName} 尚未完成 OAuth 登录`);
    }
    const subscriptionUsagePaused = Boolean(
      account.subscriptionUsagePause || account.subscriptionUsagePausedAt,
    );
    if (!subscriptionUsagePaused) account.status = "refreshing";
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: account.clientId,
      refresh_token: account.refreshToken,
      resource: RESOURCE,
    });
    let response: Response;
    try {
      response = await this.fetchFor(account)(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (error) {
      if (!subscriptionUsagePaused) {
        account.status = "temporarily_unavailable";
        account.cooldownUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
      }
      await this.persist();
      throw error;
    }
    if (!response.ok) {
      if (!subscriptionUsagePaused) {
        account.status =
          response.status === 401 ? "reauthorization_required" : "temporarily_unavailable";
        if (response.status !== 401) account.cooldownUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
      }
      await this.persist();
      throw new Error(`ChatGPT token refresh failed (${response.status})`);
    }
    const token = (await response.json()) as TokenResponse;
    this.applyTokenResponse(account, token);
    if (!subscriptionUsagePaused) account.status = "ready";
    account.updatedAt = Date.now();
    await this.persist();
    return account;
  }

  private async handleCallback(urlValue: string | undefined, accountId: string, response: import("node:http").ServerResponse) {
    const pending = this.pendingLogins.get(accountId);
    if (!pending) throw new Error("OAuth 登录已过期");
    const url = new URL(urlValue || "/", pending.redirectUri);
    if (url.pathname !== "/auth/callback") {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== pending.state) throw new Error("OAuth state 校验失败");
    const oauthError = url.searchParams.get("error");
    if (oauthError) throw new Error(`ChatGPT 授权失败：${oauthError}`);
    const code = url.searchParams.get("code");
    if (!code) throw new Error("OAuth 回调缺少授权码");
    const callbackClientId = url.searchParams.get("client_id");
    if (pending.clientId === "dynamic_agent_client" && !callbackClientId) {
      throw new Error("OAuth 回调缺少 OpenAI issued client_id");
    }
    if (pending.clientId !== "dynamic_agent_client" && callbackClientId && callbackClientId !== pending.clientId) {
      throw new Error("OAuth 回调的 client_id 与已保存账号不匹配");
    }
    const clientId = callbackClientId || pending.clientId;
    const account = this.findRequiredAccount(accountId);
    const tokenResponse = await this.fetchFor(account)(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: pending.codeVerifier,
        redirect_uri: pending.redirectUri,
        resource: RESOURCE,
      }),
    });
    if (!tokenResponse.ok) throw new Error(`ChatGPT token exchange failed (${tokenResponse.status})`);
    const token = (await tokenResponse.json()) as TokenResponse;
    const idToken = token.id_token;
    if (!idToken) throw new Error("OAuth token response missing id_token");
    const verified = await jwtVerify(idToken, this.jwks, {
      issuer: ISSUER,
      audience: clientId,
    });
    if (verified.payload.nonce !== pending.nonce) throw new Error("ChatGPT OAuth nonce 校验失败");
    if (typeof verified.payload.sub !== "string" || (account.subject && account.subject !== verified.payload.sub)) {
      throw new Error("ChatGPT OAuth identity does not match the selected account");
    }
    const scopes = (token.scope || "").split(/\s+/).filter(Boolean);
    if (!scopes.includes(REQUIRED_SCOPE)) throw new Error("ChatGPT 订阅使用权限未授予");
    account.clientId = clientId;
    account.subject = verified.payload.sub;
    account.issuer = ISSUER;
    if (typeof verified.payload.email === "string") account.email = verified.payload.email;
    account.idToken = idToken;
    account.scopes = scopes;
    this.applyTokenResponse(account, token);
    if (!account.subscriptionUsagePause && !account.subscriptionUsagePausedAt) account.status = "ready";
    account.enabled = true;
    account.updatedAt = Date.now();
    await this.persist();
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<h1>Eco Coding 登录成功</h1><p>可以关闭此窗口并返回 Eco Coding。</p>");
    this.resolvePending(accountId, this.toView(account));
  }

  private applyTokenResponse(account: StoredAccount, token: TokenResponse): void {
    if (token.access_token) account.accessToken = token.access_token;
    if (token.refresh_token) account.refreshToken = token.refresh_token;
    account.accessTokenExpiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;
    if (token.earliest_refresh_at !== undefined) account.earliestRefreshAt = token.earliest_refresh_at;
    else delete account.earliestRefreshAt;
    if (token.scope) account.scopes = token.scope.split(/\s+/).filter(Boolean);
  }

  private async revoke(account: StoredAccount): Promise<void> {
    const discovery = await this.fetchFor(account)("https://auth.openai.com/.well-known/openid-configuration");
    if (!discovery.ok) return;
    const config = (await discovery.json()) as { revocation_endpoint?: string };
    if (!config.revocation_endpoint) return;
    await this.fetchFor(account)(config.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: account.refreshToken!, token_type_hint: "refresh_token", client_id: account.clientId! }),
    });
  }

  private statePath(): string { return path.join(this.dataDir, "chatgpt-subscription", "accounts.json"); }

  private persist(): Promise<void> {
    const write = this.persistQueue.then(async () => {
      await fs.mkdir(path.dirname(this.statePath()), { recursive: true });
      const encrypted = this.codec.encrypt(JSON.stringify(this.state));
      const temp = `${this.statePath()}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, encrypted, { mode: 0o600 });
      await fs.rename(temp, this.statePath());
    });
    this.persistQueue = write.catch(() => undefined);
    return write;
  }

  private validateState(): void {
    if (this.state.version !== 1 || !this.state.extAgentHostId || !Array.isArray(this.state.accounts)) {
      throw new Error("ChatGPT subscription credential store is invalid");
    }
  }

  private findAccount(accountId: string): StoredAccount | undefined { return this.state.accounts.find((account) => account.accountId === accountId); }
  private findRequiredAccount(accountId: string): StoredAccount { const account = this.findAccount(accountId); if (!account) throw new Error(`找不到 ChatGPT 账号：${accountId}`); return account; }
  private assertInitialized(): void { if (!this.initialized) throw new Error("ChatGPT subscription service is not initialized"); }
  private toView(account: StoredAccount): ChatGptSubscriptionAccountView {
    return {
      accountId: account.accountId,
      displayName: account.displayName,
      ...(account.email ? { email: account.email } : {}),
      ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
      ...(account.subject ? { subject: account.subject } : {}),
      status: account.status,
      enabled: account.enabled,
      ...(account.cooldownUntil ? { cooldownUntil: account.cooldownUntil } : {}),
      ...(account.lastUsedAt ? { lastUsedAt: account.lastUsedAt } : {}),
      ...(account.lastSuccessAt ? { lastSuccessAt: account.lastSuccessAt } : {}),
      ...(account.lastErrorCode ? { lastErrorCode: account.lastErrorCode } : {}),
      ...(account.lastErrorAt ? { lastErrorAt: account.lastErrorAt } : {}),
      ...(account.subscriptionUsagePausedAt
        ? { subscriptionUsagePausedAt: account.subscriptionUsagePausedAt }
        : {}),
      ...(account.subscriptionUsagePause
        ? { subscriptionUsagePause: account.subscriptionUsagePause }
        : {}),
      hasCredentials: Boolean(account.refreshToken),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  private fetchFor(account: StoredAccount): typeof fetch {
    if (account.proxyUrl && this.explicitProxyFetchFactory) {
      let fetcher = this.explicitProxyFetches.get(account.proxyUrl);
      if (!fetcher) {
        fetcher = this.explicitProxyFetchFactory(account.proxyUrl);
        this.explicitProxyFetches.set(account.proxyUrl, fetcher);
      }
      return fetcher;
    }
    return this.fetchImpl;
  }

  private resolvePending(accountId: string, value: ChatGptSubscriptionAccountView): void {
    const pending = this.pendingLogins.get(accountId);
    if (!pending) return;
    this.pendingLogins.delete(accountId);
    pending.server.close();
    (pending as PendingLogin & { resolve?: (value: ChatGptSubscriptionAccountView) => void }).resolve?.(value);
  }

  private rejectPending(accountId: string, error: unknown): void {
    const pending = this.pendingLogins.get(accountId);
    if (!pending) return;
    this.pendingLogins.delete(accountId);
    pending.server.close();
    (pending as PendingLogin & { reject?: (reason?: unknown) => void }).reject?.(error);
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  earliest_refresh_at?: number;
  scope?: string;
}

function randomBase64Url(bytes: number): string { return randomBytes(bytes).toString("base64url"); }

function normalizeAccountProxyUrl(proxyUrl?: string): string | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("无效的代理 URL");
  }
  if (!["http:", "https:", "socks:", "socks5:"].includes(url.protocol)) {
    throw new Error("代理仅支持 http://、https://、socks5:// 或 socks://");
  }
  if (!url.hostname) throw new Error("代理 URL 缺少主机名");
  return trimmed;
}

function subscriptionTestProvider(modelId: string): GatewayProvider {
  return {
    id: "eco-coding-chatgpt",
    name: "ChatGPT OAuth",
    upstreamKind: "responses",
    baseUrl: "https://api.openai.com",
    apiKey: "local-unused",
    authMethod: "chatgpt_subscription",
    credentialPoolId: "chatgpt-default",
    upstreamModelId: modelId,
    models: [modelId],
  };
}
