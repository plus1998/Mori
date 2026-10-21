import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { CodexAppServerClient } from "@eco/runtime/codex-app-server-client";

export interface CodexBrowserLoginResult {
  success: boolean;
  message: string;
}

export const CODEX_BROWSER_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;

/** The final OAuth page is shown before the local app-server callback arrives. */
export function isCodexAuthCompletionPageText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/gu, " ");
  return normalized.includes("signed in to codex") && normalized.includes("you may now close this page");
}

/** The app-server login API returns a URL with open_browser=false on every OS. */
export async function startCodexBrowserLogin(input: {
  executable: string;
  codexHomeDir: string;
  env?: NodeJS.ProcessEnv;
  onAuthenticated: (signal: AbortSignal) => Promise<void>;
}): Promise<{
  authUrl: string;
  expiresAt: number;
  result: Promise<CodexBrowserLoginResult>;
  cancel: () => void;
}> {
  await fs.mkdir(input.codexHomeDir, { recursive: true });
  const child = spawn(input.executable, ["app-server", "--stdio", "-c", 'cli_auth_credentials_store="file"'], {
    env: { ...process.env, ...input.env, CODEX_HOME: input.codexHomeDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Drain stderr without printing OAuth URLs, tokens, or proxy credentials.
  child.stderr.resume();
  let finished = false;
  let authenticating = false;
  const authenticationAbort = new AbortController();
  let loginId: string | undefined;
  let resolveResult!: (result: CodexBrowserLoginResult) => void;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<CodexBrowserLoginResult>((resolve) => { resolveResult = resolve; });
  const stop = () => {
    client.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000);
    killTimer.unref();
    child.once("exit", () => clearTimeout(killTimer));
  };
  const settle = (value: CodexBrowserLoginResult) => {
    if (finished) return;
    finished = true;
    if (!value.success) authenticationAbort.abort(new Error(value.message));
    if (timeout) clearTimeout(timeout);
    stop();
    resolveResult(value);
  };
  const client = CodexAppServerClient.attachToProcess(child, {
    timeoutMs: 30_000,
    onNotification: (method, raw) => {
      if (method !== "account/login/completed" || finished || authenticating) return;
      const notification = raw as { loginId?: unknown; success?: unknown; error?: unknown } | null;
      if (!loginId || notification?.loginId !== loginId) return;
      if (notification.success !== true) {
        settle({ success: false, message: `登录失败：${typeof notification.error === "string" ? notification.error : "授权未完成"}` });
        return;
      }
      authenticating = true;
      void input.onAuthenticated(authenticationAbort.signal).then(
        () => settle({ success: true, message: "登录成功" }),
        (error: unknown) => settle({ success: false, message: `登录凭据保存失败：${error instanceof Error ? error.message : String(error)}` }),
      );
    },
  });
  child.once("error", (error) => settle({ success: false, message: `启动登录失败：${error.message}` }));
  child.once("exit", (code, signal) => {
    if (!authenticating) settle({ success: false, message: `登录进程提前退出（${signal ?? code}）` });
  });
  try {
    await client.initialize({ clientInfo: { name: "eco_coding", title: "Eco Coding", version: "0.1.0" } });
    const response = await client.request<{ type: string; loginId: string; authUrl: string }>(
      "account/login/start", { type: "chatgpt" },
      { onResult: (response) => { loginId = response.loginId; } },
    );
    if (response.type !== "chatgpt" || !response.loginId || new URL(response.authUrl).protocol !== "https:") {
      throw new Error("Codex 返回了无效的登录地址");
    }
    const expiresAt = Date.now() + CODEX_BROWSER_LOGIN_TIMEOUT_MS;
    if (!finished) timeout = setTimeout(() => settle({ success: false, message: "登录超时（10 分钟）" }), CODEX_BROWSER_LOGIN_TIMEOUT_MS);
    return { authUrl: response.authUrl, expiresAt, result, cancel: () => settle({ success: false, message: "登录已取消" }) };
  } catch (error) {
    settle({ success: false, message: `启动登录失败：${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
}
