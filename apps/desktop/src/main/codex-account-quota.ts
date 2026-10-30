import { spawn } from "node:child_process";
import { CodexAppServerClient, type CodexAppServerServerRequestHandler } from "@eco/runtime/codex-app-server-client";
import type { OpenAIAccountQuota, OpenAIAccountQuotaWindow } from "../shared/openai-account";
import type { CodexProxyEnvironment } from "./codex-proxy";
import { buildCodexAppServerEnv } from "./codex-runtime-lifecycle";

export interface CodexQuotaClient {
  request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  addNotificationHandler?: (handler: (method: string, params: unknown) => void) => () => void;
}

interface AccountResponse {
  account: { type: string; email?: string | null; planType?: string | null } | null;
  requiresOpenaiAuth?: boolean;
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface RateLimitSnapshot {
  planType?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  rateLimitReachedType?: string | null;
}

interface RateLimitsResponse {
  accountId?: string | null;
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  rateLimitResetCredits?: { availableCount: number } | null;
  ordinaryUsageAllowed?: boolean | null;
}

function isAuthenticationError(error: unknown): boolean {
  return error instanceof Error && /\b401\b|unauthorized|access[_ ]token.*expir|token[_ ]expired/iu.test(error.message);
}

/** Account RPCs do not create a thread or run a model turn. */
export async function readCodexAccountQuota(client: CodexQuotaClient, refreshToken = false, expectedAccountId?: string): Promise<OpenAIAccountQuota> {
  const requestOptions = { timeoutMs: 30_000 };
  let account: AccountResponse;
  let result: RateLimitsResponse;
  try {
    account = await client.request<AccountResponse>("account/read", { refreshToken }, requestOptions);
    result = await client.request<RateLimitsResponse>("account/rateLimits/read", undefined, requestOptions);
  } catch (error) {
    // Refresh once, and only for an authentication failure. Network/server
    // errors must remain visible instead of rotating credentials unnecessarily.
    if (refreshToken || !isAuthenticationError(error)) throw error;
    account = await client.request<AccountResponse>("account/read", { refreshToken: true }, requestOptions);
    result = await client.request<RateLimitsResponse>("account/rateLimits/read", undefined, requestOptions);
  }
  // account/read describes the selected model provider. A gateway that does
  // not require OpenAI auth returns null even with valid managed ChatGPT auth.
  // The quota RPC authenticates separately; only accept this case when its
  // response proves that the quota belongs to the requested account.
  const providerHidesAccount = account.account === null && account.requiresOpenaiAuth === false;
  if (providerHidesAccount) {
    if (!expectedAccountId || result.accountId !== expectedAccountId) {
      throw new Error("当前模型网关不返回登录账号信息，额度响应也未确认所查询的账号身份，无法保存额度。");
    }
  } else if (account.account?.type !== "chatgpt") {
    throw new Error("额度查询需要 ChatGPT 登录凭据，请重新登录该账号。");
  }
  if (result.accountId && expectedAccountId && result.accountId !== expectedAccountId) throw new Error("Codex 返回的额度不属于所查询的账号，请重新刷新。");
  // Do not select an unrelated premium/model bucket when a multi-bucket
  // response omits the ordinary Codex bucket.
  const limits = result.rateLimitsByLimitId ? result.rateLimitsByLimitId.codex : result.rateLimits;
  if (!limits) throw new Error("Codex 未返回账号额度。");
  const fetchedAt = Date.now();
  const mapWindow = (window: RateLimitWindow | null | undefined): OpenAIAccountQuotaWindow | null => {
    if (!window) return null;
    if (!Number.isFinite(window.usedPercent)) throw new Error("Codex 返回的额度使用比例无效。");
    const resetAt = window.resetsAt ?? 0;
    return {
      usedPercent: window.usedPercent,
      limitWindowSeconds: (window.windowDurationMins ?? 0) * 60,
      resetAt,
      resetAfterSeconds: resetAt > 0 ? Math.max(0, Math.ceil(resetAt - fetchedAt / 1_000)) : 0,
    };
  };
  const primaryWindow = mapWindow(limits.primary);
  const secondaryWindow = mapWindow(limits.secondary);
  const limitReached = Boolean(limits.rateLimitReachedType) ||
    [primaryWindow, secondaryWindow].some((window) => window !== null && window.usedPercent >= 100);
  return {
    planType: limits.planType ?? account.account?.planType ?? "unknown",
    email: account.account?.email ?? "",
    rateLimit: {
      allowed: result.ordinaryUsageAllowed ?? !limitReached,
      limitReached,
      primaryWindow,
      secondaryWindow,
    },
    resetCreditsAvailable: result.rateLimitResetCredits?.availableCount ?? 0,
    fetchedAt,
  };
}

/** An inactive account gets its own CODEX_HOME, never the running account's auth. */
export async function queryIsolatedCodexAccountQuota(input: {
  executable: string;
  codexHomeDir: string;
  proxy: CodexProxyEnvironment;
  refreshToken: boolean;
  expectedAccountId: string;
  beforeRead?: ((client: CodexQuotaClient, refreshToken: boolean, expectedAccountId: string) => Promise<void>) | undefined;
}): Promise<OpenAIAccountQuota> {
  return withIsolatedCodexAccountClient(input, async (client) => {
    await input.beforeRead?.(client, input.refreshToken, input.expectedAccountId);
    return readCodexAccountQuota(client, input.beforeRead ? false : input.refreshToken, input.expectedAccountId);
  });
}

/** Token refresh and quota reads share isolation and cleanup, without requiring a model turn. */
export async function withIsolatedCodexAccountClient<T>(input: {
  executable: string;
  codexHomeDir: string;
  proxy: CodexProxyEnvironment;
  credentialsStore?: "ephemeral";
  onServerRequest?: CodexAppServerServerRequestHandler;
  signal?: AbortSignal;
}, operation: (client: CodexQuotaClient) => Promise<T>): Promise<T> {
  input.signal?.throwIfAborted();
  const env = buildCodexAppServerEnv(process.env, input.codexHomeDir, input.proxy);
  // These would override the account's file-backed login in the child process.
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  const child = spawn(input.executable, ["app-server", "--stdio", "-c", `cli_auth_credentials_store="${input.credentialsStore ?? "file"}"`], {
    env,
    ...(input.credentialsStore === "ephemeral" ? { cwd: input.codexHomeDir } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const client = CodexAppServerClient.attachToProcess(child, {
    timeoutMs: 30_000,
    ...(input.onServerRequest ? { onServerRequest: input.onServerRequest } : {}),
  });
  const abort = () => { client.close(); child.kill("SIGTERM"); };
  input.signal?.addEventListener("abort", abort, { once: true });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
    client.close();
  });
  try {
    await client.initialize({
      clientInfo: { name: "eco_coding", title: "Mori", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    return await operation(client);
  } catch (error) {
    throw spawnError ?? error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    client.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
  }
}
