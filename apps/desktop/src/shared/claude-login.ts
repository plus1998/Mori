import type { OpenAIAccountProfile } from "./openai-account";

const CLAUDE_LOGIN_ACCOUNT_ID = /^claude-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;
export function isClaudeLoginAccountId(id: unknown): boolean {
  return typeof id === "string" && CLAUDE_LOGIN_ACCOUNT_ID.test(id);
}

export interface ClaudeLoginProfileInput {
  name: string;
  /** Empty uses the system proxy. The value "direct" disables proxies. */
  proxy: string;
  signInProfile?: Pick<OpenAIAccountProfile, "email" | "pickupUrl">;
}

export interface ClaudeLoginAccount extends Omit<ClaudeLoginProfileInput, "signInProfile"> {
  id: string;
  status: "signedOut" | "signedIn" | "unavailable" | "signingIn";
  webStatus: "hasSession" | "noSession" | "unavailable";
  email?: string;
}

export type ClaudeLoginAction =
  | { kind: "save"; profile: ClaudeLoginProfileInput; id?: string }
  | { kind: "loginWithSessionKey"; id: string; sessionKey: string }
  | { kind: "login" | "cancel" | "logout" | "openWeb" | "logoutWeb" | "remove"; id: string };

export interface ClaudeLoginResult {
  accountId: string;
  success: boolean;
  message: string;
}
