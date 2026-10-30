import fs from "node:fs/promises";
import path from "node:path";
import type { OpenAIAccountAuthState } from "../shared/openai-account";
import { startCodexBrowserLogin } from "./codex-browser-login";

/**
 * Codex OAuth Login Service
 *
 * Manages `codex login` via the Codex CLI to authenticate users
 * with their OpenAI ChatGPT subscription. Auth is stored in
 * CODEX_HOME/auth.json.
 */

export interface CodexOAuthLoginStatus {
  isLoggedIn: boolean;
  authState?: OpenAIAccountAuthState;
  message: string;
}

export interface CodexOAuthLoginResult {
  success: boolean;
  message: string;
}

function buildLoginEnv(codexHomeDir: string, upstreamProxyUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHomeDir };
  if (upstreamProxyUrl) {
    env.http_proxy = upstreamProxyUrl;
    env.https_proxy = upstreamProxyUrl;
  }
  return env;
}

export class CodexOAuthLoginService {
  constructor(
    private readonly codexHomeDir: string,
    private readonly codexExecutable: string,
    private readonly upstreamProxyUrl?: string,
  ) {}

  /** Check if the user is currently logged in. */
  async getStatus(): Promise<CodexOAuthLoginStatus> {
    try {
      // Check if auth.json exists in CODEX_HOME
      const authPath = path.join(this.codexHomeDir, "auth.json");
      const exists = await fs.access(authPath).then(() => true).catch(() => false);

      if (!exists) {
        return { isLoggedIn: false, message: "未登录" };
      }

      // Check if auth.json is valid JSON and not expired
      try {
        const content = await fs.readFile(authPath, "utf-8");
        const auth = JSON.parse(content);

        // auth.json structure: { auth_mode, tokens: { access_token, ... }, last_refresh }
        const accessToken = auth.tokens?.access_token ?? auth.access_token;
        if (!accessToken) {
          return { isLoggedIn: false, message: "登录信息无效" };
        }

        // Access token expiry controls requests; id_token expiry does not revoke authorization.
        if (typeof accessToken === "string") {
          try {
            const payload = JSON.parse(
              Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf-8"),
            );
            if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) {
              const refresh = auth.tokens?.refresh_token ?? auth.refresh_token;
              return typeof refresh === "string" && refresh.trim()
                ? { isLoggedIn: false, authState: "refreshable", message: "已授权，访问令牌待刷新" }
                : { isLoggedIn: false, authState: "expired", message: "登录已过期" };
            }
          } catch {
            // Opaque access tokens have no locally readable expiry.
          }
        }

        return { isLoggedIn: true, message: "已登录" };
      } catch {
        return { isLoggedIn: false, message: "登录信息无效" };
      }
    } catch (error) {
      return {
        isLoggedIn: false,
        message: `检查登录状态失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Start the OAuth login flow and return the auth URL.
   *
   * Uses `codex login` and parses the output to extract the authorization URL.
   * The caller is responsible for opening the URL in a browser.
   * After the user authorizes, OpenAI redirects to the local server callback
   * and the codex process completes the auth, writing auth.json.
   */
  async startLogin(): Promise<{
    authUrl: string;
    expiresAt: number;
    result: Promise<CodexOAuthLoginResult>;
    cancel: () => void;
  } | null> {
    return startCodexBrowserLogin({
      executable: this.codexExecutable,
      codexHomeDir: this.codexHomeDir,
      env: buildLoginEnv(this.codexHomeDir, this.upstreamProxyUrl),
      onAuthenticated: async (signal) => {
        const content = await fs.readFile(path.join(this.codexHomeDir, "auth.json"), "utf8");
        signal.throwIfAborted();
        const auth = JSON.parse(content) as { tokens?: { access_token?: string }; access_token?: string };
        if (!(auth.tokens?.access_token ?? auth.access_token)) throw new Error("auth.json 缺少 access_token");
      },
    });
  }

  /**
   * Logout the user by removing auth.json.
   */
  async logout(): Promise<CodexOAuthLoginResult> {
    try {
      const authPath = path.join(this.codexHomeDir, "auth.json");
      await fs.access(authPath).then(() => fs.unlink(authPath)).catch(() => {});
      return { success: true, message: "已退出登录" };
    } catch (error) {
      return {
        success: false,
        message: `退出登录失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
