import { createHash, randomBytes } from "node:crypto";

const CLAUDE_ORIGIN = "https://claude.ai";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

type ClaudeOAuthRequest = Omit<RequestInit, "body"> & { body?: string };

export interface ClaudeSessionKeyNetwork {
  fetch(url: string, init: ClaudeOAuthRequest): Promise<Response>;
  close(): Promise<void>;
}

export class ClaudeSessionKeyConnectionError extends Error {
  constructor(readonly step: string) {
    super(`${step}失败，未能取得 Claude 的 HTTP 响应。`);
  }
}

export function validateClaudeSessionKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  // RFC 6265 cookie octets. A pasted Cookie header or multiple cookies are invalid.
  if (key.length > 4096 || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/u.test(key) || key.startsWith("sessionKey=")) {
    throw new Error("请填写 Claude 网页的 sessionKey Cookie 值。");
  }
  return key;
}

export async function exchangeClaudeSessionKey(fetcher: ClaudeSessionKeyNetwork["fetch"], sessionKey: string, signal: AbortSignal) {
  async function request<T>(url: string, step: string, init: ClaudeOAuthRequest): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, signal, redirect: "error", cache: "no-store" });
    } catch {
      signal.throwIfAborted();
      throw new ClaudeSessionKeyConnectionError(step);
    }
    const challenged = response.headers.get("cf-mitigated") === "challenge";
    if (challenged || !response.ok) {
      await response.body?.cancel();
      if (challenged) throw new Error(`${step}失败，Claude 要求在浏览器中完成安全验证（HTTP ${response.status}）。`);
      throw new Error(`${step}失败（HTTP ${response.status}）。`);
    }
    try {
      return await response.json() as T;
    } catch {
      signal.throwIfAborted();
      throw new Error(`${step}失败，Claude 返回了无效的 JSON。`);
    }
  }

  // Follow sub2api's CookieAuth flow, including its organization selection rule.
  const webHeaders = { Accept: "application/json", Cookie: `sessionKey=${sessionKey}` };
  const organizations = await request<unknown>(`${CLAUDE_ORIGIN}/api/organizations`, "读取 Claude 组织", { headers: webHeaders });
  if (!Array.isArray(organizations)) throw new Error("Claude 返回了无效的组织列表。");
  const organization = organizations.find(item => item?.raven_type === "team") ?? organizations[0];
  if (typeof organization?.uuid !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(organization.uuid)) {
    throw new Error("Claude 网页会话没有可用于 OAuth 的组织。");
  }

  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const authorization = await request<{ redirect_uri?: unknown }>(
    `${CLAUDE_ORIGIN}/v1/oauth/${organization.uuid}/authorize`, "获取 Claude OAuth 授权码", {
      method: "POST",
      headers: { ...webHeaders, Origin: CLAUDE_ORIGIN, Referer: `${CLAUDE_ORIGIN}/new`, "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "code",
        client_id: CLIENT_ID,
        organization_uuid: organization.uuid,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }),
    },
  );
  const callback = typeof authorization?.redirect_uri === "string" ? URL.parse(authorization.redirect_uri) : null;
  const code = callback?.searchParams.get("code");
  if (!callback || `${callback.origin}${callback.pathname}` !== REDIRECT_URI || callback.username || callback.password
    || !code || callback.searchParams.get("state") !== state) {
    throw new Error("Claude 返回的 OAuth 授权地址或 state 无效。");
  }

  const token = await request<{ refresh_token?: unknown; scope?: unknown }>(TOKEN_URL, "交换 Claude OAuth 凭据", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      code,
      state,
    }),
  });
  if (typeof token?.refresh_token !== "string" || !/^[!-~]+$/u.test(token.refresh_token)) {
    throw new Error("Claude 未返回可供 Claude Code 使用的 OAuth refresh token。");
  }
  // OAuth token responses omit scope when it matches the requested scope.
  const scope = token.scope === undefined ? SCOPES : token.scope;
  const scopes = typeof scope === "string" ? scope.trim().split(/\s+/u) : [];
  if (!scopes.includes("user:inference") || !scopes.includes("user:profile")) {
    throw new Error("Claude 返回的 OAuth 凭据缺少 Claude Code 登录所需权限。");
  }
  return { refreshToken: token.refresh_token, scopes: scopes.join(" ") };
}
