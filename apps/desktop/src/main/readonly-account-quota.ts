import { z } from "zod";
import { CODEX_QUOTA_REFRESH_MS } from "../shared/codex-quota-refresh";
import type { CodexQuotaClient } from "./codex-account-quota";

/** Internal main-process input, never returned by the tool. */
export interface ReadonlyQuotaAccount {
  id: string;
  name: string;
  authJson: string | null;
  proxyMode: "system" | "direct" | "manual" | null;
  proxyUrl: string | null;
  quotaJson: string | null;
  quotaAccountId: string | null;
}

const messages = {
  missing_credentials: "账号没有登录凭据。",
  invalid_credentials: "账号登录凭据无效。",
  refresh_required: "实时查询需要更新登录凭据；只读查询未续期或回写凭据，请在账号设置中处理后重试。",
  identity_mismatch: "额度响应未确认所查询的账号归属，已拒绝使用。",
  account_changed: "查询期间账号已删除或凭据已变更，已丢弃查询结果。",
  invalid_response: "额度响应缺少有效的额度桶或窗口。",
  runtime_unavailable: "未找到 Codex CLI，无法实时查询额度。",
  query_failed: "实时额度查询失败；未更新凭据或额度缓存。",
} as const;
export class ReadonlyQuotaError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); }
}

const numeric = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER / 60);
const rpcWindow = z.object({
  usedPercent: numeric,
  windowDurationMins: numeric.nullish(),
  resetsAt: numeric.nullish(),
});
const rpcBucket = z.object({
  planType: z.string().nullish(),
  primary: rpcWindow.nullish(),
  secondary: rpcWindow.nullish(),
});
const rpcResponse = z.object({
  accountId: z.string(),
  rateLimits: rpcBucket,
  rateLimitsByLimitId: z.record(z.string(), rpcBucket).nullish(),
});
const cachedWindow = z.object({ usedPercent: numeric, limitWindowSeconds: numeric, resetAt: numeric });
const cachedQuota = z.object({
  fetchedAt: numeric.positive(),
  planType: z.string(),
  rateLimit: z.object({ primaryWindow: cachedWindow.nullable(), secondaryWindow: cachedWindow.nullable() }),
});

export interface WindowSummary {
  window: "primary" | "secondary";
  usedPercent: number;
  windowSeconds: number | null;
  resetAt: number | null; // Unix seconds, unlike fetchedAt/checkedAt (milliseconds).
}
export interface BucketSummary { bucket: string; planType: string; windows: WindowSummary[] }
export interface Snapshot { fetchedAt: number; buckets: BucketSummary[] }

function readTokens(raw: string | null): { accessToken: string; chatgptAccountId: string } {
  if (!raw) throw new ReadonlyQuotaError("missing_credentials");
  try {
    const auth = JSON.parse(raw);
    const tokens = auth.tokens ?? auth;
    const accessToken = tokens.access_token ?? auth.access_token;
    const chatgptAccountId = tokens.account_id ?? auth.account_id;
    if (typeof accessToken !== "string" || !accessToken.trim() ||
        typeof chatgptAccountId !== "string" || !chatgptAccountId.trim()) throw new Error();
    const payload = accessToken.split(".")[1];
    if (payload) {
      let claims: { exp?: unknown } = {};
      try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { /* Opaque tokens are checked upstream. */ }
      if (typeof claims.exp === "number" && claims.exp * 1_000 <= Date.now())
        throw new ReadonlyQuotaError("refresh_required");
    }
    return { accessToken, chatgptAccountId };
  } catch (error) {
    if (error instanceof ReadonlyQuotaError) throw error;
    throw new ReadonlyQuotaError("invalid_credentials");
  }
}

/** Only an access token enters this ephemeral client. There is no refresh-token owner here. */
export async function readReadonlyQuota(client: CodexQuotaClient, rawAuth: string): Promise<Snapshot> {
  const tokens = readTokens(rawAuth);
  try {
    await client.request("account/login/start", { type: "chatgptAuthTokens", ...tokens }, { timeoutMs: 30_000 });
    const raw = await client.request("account/rateLimits/read", undefined, { timeoutMs: 30_000 });
    const parsed = rpcResponse.safeParse(raw);
    if (!parsed.success) {
      if (!raw || typeof raw !== "object" || !("accountId" in raw) || typeof raw.accountId !== "string")
        throw new ReadonlyQuotaError("identity_mismatch");
      throw new ReadonlyQuotaError("invalid_response");
    }
    if (parsed.data.accountId !== tokens.chatgptAccountId) throw new ReadonlyQuotaError("identity_mismatch");
    const buckets = Object.entries(parsed.data.rateLimitsByLimitId ?? { codex: parsed.data.rateLimits }).map(([bucket, limits]) => ({
      bucket,
      planType: limits.planType ?? "unknown",
      windows: (["primary", "secondary"] as const).flatMap((window) => {
        const value = limits[window];
        return value ? [{ window, usedPercent: value.usedPercent,
          windowSeconds: value.windowDurationMins == null ? null : value.windowDurationMins * 60,
          resetAt: value.resetsAt ?? null }] : [];
      }),
    }));
    if (!buckets.length || buckets.every((bucket) => !bucket.windows.length)) throw new ReadonlyQuotaError("invalid_response");
    return { fetchedAt: Date.now(), buckets };
  } catch (error) {
    throw safeError(error);
  }
}

function safeError(error: unknown): ReadonlyQuotaError {
  if (error instanceof ReadonlyQuotaError) return error;
  // Inspect for classification only. Never echo third-party errors (even partial JSON/HTTP bodies).
  const message = error instanceof Error ? error.message : "";
  return new ReadonlyQuotaError(/401|unauthoriz|token.*expir|auth.*refresh|refresh.*required/iu.test(message)
    ? "refresh_required" : "query_failed");
}

function cacheSnapshot(account: ReadonlyQuotaAccount): { snapshot: Snapshot | null; status: string } {
  if (!account.quotaJson) return { snapshot: null, status: "missing" };
  let identity: unknown;
  try { const auth = JSON.parse(account.authJson ?? "{}"); identity = auth.tokens?.account_id ?? auth.account_id; } catch { /* Invalid credentials cannot own a cache. */ }
  if (!identity || account.quotaAccountId !== identity) return { snapshot: null, status: "identity_mismatch" };
  try {
    const quota = cachedQuota.parse(JSON.parse(account.quotaJson));
    if (quota.fetchedAt > Date.now()) throw new Error();
    const windows = (["primary", "secondary"] as const).flatMap((window) => {
      const value = window === "primary" ? quota.rateLimit.primaryWindow : quota.rateLimit.secondaryWindow;
      return value ? [{ window, usedPercent: value.usedPercent,
        windowSeconds: value.limitWindowSeconds || null, resetAt: value.resetAt || null }] : [];
    });
    if (!windows.length) throw new Error();
    return { snapshot: { fetchedAt: quota.fetchedAt, buckets: [{ bucket: "codex", planType: quota.planType, windows }] }, status: "available" };
  } catch { return { snapshot: null, status: "invalid" }; }
}

/** Defense in depth for user labels/upstream bucket strings, in addition to field allowlisting. */
export function redactAccountSummaryStrings<T>(value: T, accounts: ReadonlyQuotaAccount[]): T {
  const secrets = new Set<string>();
  const visit = (item: unknown, key = "") => {
    if (typeof item === "string" && /token|key|cookie|password|secret|credential/iu.test(key) && item) secrets.add(item);
    else if (item && typeof item === "object") for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
  };
  for (const account of accounts) {
    try { visit(JSON.parse(account.authJson ?? "{}")); } catch { if (account.authJson) secrets.add(account.authJson); }
  }
  const scrub = (item: unknown): unknown => {
    if (typeof item === "string") {
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) item = (item as string).split(secret).join("[redacted]");
      return (item as string).replace(/\bBearer\s+\S+|\bsk-[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu, "[redacted]");
    }
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child)]));
    return item;
  };
  return scrub(value) as T;
}

export async function queryReadonlyAccountQuotas(input: {
  accounts: ReadonlyQuotaAccount[];
  source: "live" | "cache";
  query: (account: ReadonlyQuotaAccount) => Promise<Snapshot>;
  authUnchanged: (account: ReadonlyQuotaAccount) => boolean;
  signal?: AbortSignal;
}) {
  const checkedAt = Date.now();
  const accounts = [];
  // Bound concurrency to one process; failures remain per account and never suppress other accounts.
  for (const account of input.accounts) {
    input.signal?.throwIfAborted();
    const cache = cacheSnapshot(account);
    let snapshot = cache.snapshot;
    let source: "live" | "cache" | null = snapshot ? "cache" : null;
    let error: ReadonlyQuotaError | undefined;
    if (input.source === "live") {
      try {
        readTokens(account.authJson); // Refuse known expiry before spawning anything.
        snapshot = await input.query(account);
        source = "live";
      } catch (failure) { error = safeError(failure); }
    }
    accounts.push({
      accountId: account.id, label: account.name,
      status: error ? "error" : snapshot ? "ok" : "unavailable",
      ...(error ? { error: { code: error.code, message: error.message } } : {}),
      source,
      freshness: source === "live" ? "live" : snapshot ?
        (Date.now() - snapshot.fetchedAt < CODEX_QUOTA_REFRESH_MS ? "cached" : "stale") : "unavailable",
      fetchedAt: snapshot?.fetchedAt ?? null,
      cachedAt: cache.snapshot?.fetchedAt ?? null,
      cacheStatus: cache.status,
      ageSeconds: snapshot ? Math.max(0, Math.floor((Date.now() - snapshot.fetchedAt) / 1_000)) : null,
      buckets: snapshot?.buckets ?? [],
    });
  }
  input.signal?.throwIfAborted();
  // Recheck the entire set at publication time: a later slow query may overlap
  // replacement/deletion of an account whose query already completed.
  for (const [index, account] of input.accounts.entries()) {
    const summary = accounts[index]!;
    if (!input.authUnchanged(account)) {
      Object.assign(summary, {
        status: "error", error: { code: "account_changed", message: messages.account_changed },
        source: null, freshness: "unavailable", fetchedAt: null, cachedAt: null,
        cacheStatus: "account_changed", ageSeconds: null, buckets: [],
      });
    } else if (summary.fetchedAt !== null) {
      summary.ageSeconds = Math.max(0, Math.floor((Date.now() - summary.fetchedAt) / 1_000));
      if (summary.source === "cache") summary.freshness = Date.now() - summary.fetchedAt < CODEX_QUOTA_REFRESH_MS ? "cached" : "stale";
    }
  }
  return redactAccountSummaryStrings({ readOnly: true, checkedAt, requestedSource: input.source, accounts }, input.accounts);
}
