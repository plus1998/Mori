import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { CodexAppServerClient } from "@eco/runtime/codex-app-server-client";

export interface CodexBrowserLoginResult {
  success: boolean;
  message: string;
}

export const CODEX_BROWSER_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;

export interface CodexBrowserLogin {
  loginId: string;
  authUrl: string;
  expiresAt: number;
  result: Promise<CodexBrowserLoginResult>;
  cancel: () => void;
  submitCallback: (callbackUrl: string) => Promise<void>;
}

const isLoopback = (url: URL) => url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);

async function submitLoginCallback(authUrl: string, callbackUrl: string, signal: AbortSignal): Promise<void> {
  const authorization = new URL(authUrl);
  const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
  let callback: URL;
  try { callback = new URL(callbackUrl.trim()); }
  catch { throw new Error("请输入授权完成后地址栏中的完整回调地址"); }
  if (!isLoopback(redirect) || redirect.pathname !== "/auth/callback" || callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.username || callback.password || callback.hash) {
    throw new Error("回调地址必须与本次授权链接中的本机重定向地址一致");
  }
  const state = authorization.searchParams.get("state");
  if (!state || callback.searchParams.getAll("state").length !== 1 || callback.searchParams.get("state") !== state) {
    throw new Error("回调地址不属于本次登录，请使用当前授权链接重新授权");
  }
  if (callback.searchParams.has("error")) throw new Error("授权未完成，请在浏览器重新授权");
  if (callback.searchParams.getAll("code").length !== 1 || !callback.searchParams.get("code")) throw new Error("回调地址缺少授权码，请复制授权完成后的完整地址");

  const get = (url: URL) => new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
    // Always connect directly to loopback; never use a proxy or follow arbitrary redirects.
    const request = http.get({ hostname: "127.0.0.1", port: redirect.port || "80", path: `${url.pathname}${url.search}`, signal, headers: { Host: redirect.host } }, (response) => {
      response.resume();
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 400) resolve(response.headers);
      else reject(new Error(`Codex 拒绝了回调（HTTP ${response.statusCode ?? "未知"}），请检查地址或重新授权`));
    });
    request.setTimeout(60_000, () => request.destroy(new Error("提交回调超时，请检查登录状态后重试")));
    request.on("error", reject);
  });
  const headers = await get(callback);
  if (headers.location) {
    const success = new URL(headers.location, redirect);
    // CLI versions with a local success page complete only after that page is visited.
    if (isLoopback(success) && success.port === redirect.port && success.pathname === "/success" && !success.username && !success.password) await get(success);
  }
}

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
}): Promise<CodexBrowserLogin> {
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
    let submitting = false;
    return {
      loginId: response.loginId, authUrl: response.authUrl, expiresAt, result,
      cancel: () => settle({ success: false, message: "登录已取消" }),
      submitCallback: async (callbackUrl) => {
        if (finished || authenticating) throw new Error("本次登录已结束，请检查登录状态或重新生成授权链接");
        if (submitting) throw new Error("正在提交回调，请等待登录结果");
        submitting = true;
        try { await submitLoginCallback(response.authUrl, callbackUrl, authenticationAbort.signal); }
        finally { submitting = false; }
      },
    };
  } catch (error) {
    settle({ success: false, message: `启动登录失败：${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
}
