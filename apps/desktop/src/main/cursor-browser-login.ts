import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  killChildProcessTree,
  resolveCursorAgentExecutable,
  wrapForWindowsShellScript,
} from "@eco/runtime/acp-cursor-agent";
import { cursorTokenExpiry, type CursorOAuthTokens } from "./cursor-oauth-credentials";
import { spawnManagedProcess } from "@eco/runtime";
import type { AccountBrowserPage } from "./account-browser-page";

export async function loginCursorInBrowser(page: AccountBrowserPage, proxyEnv: NodeJS.ProcessEnv): Promise<{ tokens: CursorOAuthTokens; expiresAt: number }> {
  const controller = new AbortController();
  const unsubscribe = page.onClosed(() => controller.abort());
  try {
    if (page.isDestroyed()) controller.abort();
    return await runCursorBrowserLogin(proxyEnv, controller.signal, url => page.webContents.loadURL(url));
  } finally {
    unsubscribe();
  }
}

export async function runCursorBrowserLogin(
  proxyEnv: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onUrl: (url: string) => void | Promise<void>,
): Promise<{ tokens: CursorOAuthTokens; expiresAt: number }> {
  signal.throwIfAborted();
  const executable = resolveCursorAgentExecutable();
  const target = wrapForWindowsShellScript(executable, ["login"]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-cursor-login-"));
  try {
    const env = {
      ...process.env,
      ...proxyEnv,
      HOME: dir,
      USERPROFILE: dir,
      APPDATA: dir,
      XDG_CONFIG_HOME: dir,
      CURSOR_API_KEY: undefined,
      CURSOR_AUTH_TOKEN: undefined,
      AGENT_CLI_CREDENTIAL_STORE: "file",
      NO_OPEN_BROWSER: "1",
    };
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Cursor 登录已取消。"));
        return;
      }
      const { child } = spawnManagedProcess({
        command: target.command, args: target.args,
        env,
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      let failure: Error | undefined;
      const cancel = (message: string) => {
        if (failure) return;
        failure = new Error(message);
        killChildProcessTree(child);
      };
      const timeout = setTimeout(() => cancel("Cursor 登录超时，请重试。"), 10 * 60_000);
      const abort = () => cancel("Cursor 登录已取消。");
      signal.addEventListener("abort", abort, { once: true });
      let opened = false;
      const listen = (stream: NodeJS.ReadableStream) => {
        let output = "";
        stream.on("data", (chunk: Buffer) => {
          if (opened || failure) return;
          output = (output + chunk.toString()).slice(-16_384);
          const link = output.match(/https:\/\/cursor\.com\/loginDeepControl\?[^\s\x1b]+(?=[\s\x1b])/u)?.[0];
          if (!link) return;
          opened = true;
          void Promise.resolve().then(() => onUrl(link)).catch(() => {
            cancel("无法打开 Cursor 授权页面。");
          });
        });
      };
      if (child.stdout) listen(child.stdout);
      if (child.stderr) listen(child.stderr);
      child.once("error", () => { failure ??= new Error("无法启动 Cursor CLI 登录。"); });
      child.once("close", (code) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0 || !opened) reject(new Error("Cursor CLI 未完成浏览器授权，请重试。"));
        else resolve();
      });
    });

    signal.throwIfAborted();
    const configDir = process.platform === "darwin" ? ".cursor" : process.platform === "win32" ? "Cursor" : "cursor";
    const raw = await fs.readFile(path.join(dir, configDir, "auth.json"), "utf8");
    const credentials = readJsonObject(raw, "Cursor CLI 保存的登录凭证格式无效。");
    const token = credentials?.accessToken;
    if (typeof token !== "string" || !token) throw new Error("Cursor CLI 未保存访问令牌。");
    const expiresAt = cursorTokenExpiry(token);
    if (expiresAt <= Date.now()) throw new Error("Cursor CLI 返回了已过期的访问令牌。");
    const refreshToken = credentials.refreshToken;
    return {
      tokens: { accessToken: token, ...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}) },
      expiresAt,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function readJsonObject(raw: string, errorMessage: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // JSON parser errors can quote credential material.
  }
  throw new Error(errorMessage);
}
