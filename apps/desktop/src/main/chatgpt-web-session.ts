import type { OpenAIAccountWebAuth } from "../shared/openai-account";

export class ChatGptWebSessionError extends Error {
  constructor(message: string, readonly reauthorizationRequired = false, readonly waitingForLogin = false) { super(message); }
}

/** Session endpoint returns a Web bearer token; it never returns a Codex refresh token. */
export function parseChatGptWebSession(value: unknown, expectedEmail?: string, now = Date.now()): OpenAIAccountWebAuth {
  const data = value as { accessToken?: unknown; user?: { email?: unknown }; error?: unknown } | null;
  if (!data || typeof data.accessToken !== "string" || !data.accessToken) {
    throw new ChatGptWebSessionError("ChatGPT Web 会话已失效，请重新登录 Web。", true, true);
  }
  if (data.error) throw new ChatGptWebSessionError("ChatGPT Web 未能更新会话，请重新登录 Web。", true);
  let claims: { exp?: unknown; "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown } };
  try { claims = JSON.parse(Buffer.from(data.accessToken.split(".")[1]!, "base64url").toString("utf8")); }
  catch { throw new ChatGptWebSessionError("ChatGPT Web 返回了无效的访问令牌。"); }
  const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  const expiresAt = typeof claims.exp === "number" ? claims.exp * 1000 : NaN;
  if (typeof accountId !== "string" || !accountId || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new ChatGptWebSessionError("ChatGPT Web 访问令牌缺少账号身份或已过期。");
  }
  const email = typeof data.user?.email === "string" ? data.user.email : undefined;
  if (expectedEmail && (!email || email.toLowerCase() !== expectedEmail.trim().toLowerCase())) {
    throw new ChatGptWebSessionError("当前 Web 登录账号与账号资料中的邮箱不一致，请切换到正确的账号。", true);
  }
  return { accessToken: data.accessToken, accountId, expiresAt, ...(email ? { email } : {}) };
}

export function webAuthJson(auth: OpenAIAccountWebAuth): string {
  return JSON.stringify({ tokens: { access_token: auth.accessToken, account_id: auth.accountId } });
}
