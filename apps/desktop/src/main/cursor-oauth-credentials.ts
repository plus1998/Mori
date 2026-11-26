import type { CursorOAuthCredential } from "./cursor-api-key-store";

export interface CursorOAuthTokens {
  accessToken: string;
  refreshToken?: string;
}

export function cursorTokenExpiry(token: string): number {
  const payload = token.split(".")[1];
  let exp: unknown;
  try {
    if (payload) exp = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.exp;
  } catch {
    // JSON parser errors may quote credential material.
  }
  if (typeof exp !== "number" || !Number.isSafeInteger(exp * 1000) || exp <= 0) {
    throw new Error("Cursor 访问令牌缺少有效的到期时间。");
  }
  return exp * 1000;
}

export function readCursorOAuthTokens(raw: string): CursorOAuthTokens {
  // Older Mori versions persisted the access token alone.
  if (!raw.startsWith("{")) return { accessToken: raw };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && "accessToken" in value
      && typeof value.accessToken === "string" && value.accessToken
      && (!("refreshToken" in value) || typeof value.refreshToken === "string")) {
      return value as CursorOAuthTokens;
    }
  } catch {
    // JSON parser errors may quote credential material.
  }
  throw new Error("Cursor 登录凭证格式无效，请重新授权。");
}

export async function renewCursorOAuthToken(fetcher: typeof fetch, refreshToken: string): Promise<CursorOAuthTokens> {
  // The Agent CLI only re-exchanges API keys. This is Cursor IDE's session OAuth client.
  const response = await fetcher("https://api2.cursor.sh/oauth/token", {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Cursor 拒绝续期，请重新授权。");
    throw new Error(`Cursor 续期失败（HTTP ${response.status}）。`);
  }

  let result: { access_token?: unknown; refresh_token?: unknown; shouldLogout?: unknown } | null;
  try {
    result = await response.json();
  } catch {
    throw new Error("Cursor 续期响应格式无效。");
  }
  if (result?.shouldLogout === true) throw new Error("Cursor 登录会话已终止，请重新授权。");
  if (typeof result?.access_token !== "string" || !result.access_token) {
    throw new Error("Cursor 续期未返回访问令牌。");
  }
  return {
    accessToken: result.access_token,
    refreshToken: typeof result.refresh_token === "string" && result.refresh_token ? result.refresh_token : refreshToken,
  };
}

const RENEW_BEFORE_MS = 5 * 60_000;

export class CursorOAuthCredentials {
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly deps: {
    read: (accountId: string) => CursorOAuthCredential;
    decode: (encrypted: string) => string;
    encode: (raw: string) => string;
    renew: (current: CursorOAuthCredential, refreshToken: string) => Promise<CursorOAuthTokens>;
    replace: (current: CursorOAuthCredential, encrypted: string, expiresAt: number) => boolean;
  }) {}

  accessToken(accountId: string): Promise<string> {
    const existing = this.pending.get(accountId);
    if (existing) return existing;
    const pending = this.getOrRenew(accountId);
    this.pending.set(accountId, pending);
    void pending.finally(() => this.pending.delete(accountId)).catch(() => {});
    return pending;
  }

  private async getOrRenew(accountId: string): Promise<string> {
    const current = this.deps.read(accountId);
    const tokens = readCursorOAuthTokens(this.deps.decode(current.value));
    if (current.expiresAt > Date.now() + RENEW_BEFORE_MS) return tokens.accessToken;
    if (!tokens.refreshToken) {
      if (current.expiresAt > Date.now()) return tokens.accessToken;
      throw new Error("Cursor CLI 授权已过期，请重新授权。");
    }
    const renewed = await this.deps.renew(current, tokens.refreshToken);
    const expiry = cursorTokenExpiry(renewed.accessToken);
    if (expiry <= Date.now()) throw new Error("Cursor 续期返回了已过期的访问令牌。");
    const encrypted = this.deps.encode(JSON.stringify(renewed));
    if (this.deps.replace(current, encrypted, expiry)) return renewed.accessToken;
    // A concurrent browser login can overwrite the credentials during the request.
    const latest = this.deps.read(accountId);
    if (latest.expiresAt <= Date.now()) throw new Error("Cursor CLI 授权已过期，请重新授权。");
    return readCursorOAuthTokens(this.deps.decode(latest.value)).accessToken;
  }
}
