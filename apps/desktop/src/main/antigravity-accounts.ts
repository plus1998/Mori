import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { AcpClient, AcpJsonRpcPeer, killChildProcessTree, spawnManagedProcess } from "@eco/runtime";
import type { AccountBrowserPage } from "./account-browser-page";
import { prepareAccountLoginBrowser } from "./account-login-locale";
import { webChatProxyConfig } from "../shared/web-chat-list";
import type { AntigravityAccountInput, AntigravityAccount, AntigravityLoginMode, AntigravityLoginStatus } from "../shared/ipc";

const ACCOUNT_ID = /^agy_[0-9a-f-]{36}$/u;

export function isAntigravityAccountId(id: unknown): id is `agy_${string}` {
  return typeof id === "string" && ACCOUNT_ID.test(id);
}
const PROFILE_READY = "verified";
const TOKEN_PATH = path.join("antigravity-cli", "antigravity-oauth-token");
const PROCESS_TIMEOUT = 10 * 60_000;
const STORAGE_MARKER = "Using file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set";

export function findAntigravityExecutable(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const locations = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local/bin")];
  return locations.filter(location => path.isAbsolute(location)).map(location => path.join(location, "agy"))
    .find(executable => {
      try {
        accessSync(executable, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

type Login = {
  id: string;
  status: AntigravityLoginStatus;
  controller: AbortController;
  submit?: (code: string) => void;
};

export class AntigravityAccounts {
  private login: Login | undefined;
  private readonly removingCredentials = new Set<string>();
  private readonly saving = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly resolveProxyEnv: (profile: AntigravityAccountInput) => Promise<NodeJS.ProcessEnv>,
    private readonly createLoginPage: (id: string, allowNavigation: (url: string) => boolean) => Promise<AccountBrowserPage>,
  ) {}

  private accountDir(id: unknown): string {
    if (!isAntigravityAccountId(id)) throw new Error("Antigravity account ID is invalid.");
    return path.join(this.root, id);
  }

  private async tokenExists(dir: string): Promise<boolean> {
    try {
      const file = await fs.lstat(path.join(dir, TOKEN_PATH));
      if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error("Antigravity token file permissions are unsafe.");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async connected(dir: string): Promise<boolean> {
    try {
      await fs.access(path.join(dir, PROFILE_READY));
      return await this.tokenExists(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async profile(id: unknown): Promise<AntigravityAccountInput> {
    const dir = this.accountDir(id);
    const profile = await fs.readFile(path.join(dir, "profile.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (profile !== undefined) return this.parseProfile(JSON.parse(profile));
    return { name: await fs.readFile(path.join(dir, "name"), "utf8"), proxyMode: "system" };
  }

  async proxyEnv(id: string): Promise<NodeJS.ProcessEnv> {
    return this.resolveProxyEnv(await this.profile(id));
  }

  async list(): Promise<AntigravityAccount[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return Promise.all(entries.filter(entry => entry.isDirectory() && ACCOUNT_ID.test(entry.name)).sort((a, b) =>
      a.name.localeCompare(b.name)).map(async entry => ({
      ...await this.profile(entry.name),
      id: entry.name,
      connected: !this.removingCredentials.has(entry.name) && await this.connected(this.accountDir(entry.name)),
    })));
  }

  private parseProfile(input: unknown): AntigravityAccountInput {
    if (!input || typeof input !== "object") throw new Error("Invalid Antigravity account.");
    const { name, proxyMode, proxyUrl } = input as Partial<AntigravityAccountInput>;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new Error("Enter an account name (1–80 characters).");
    if (proxyMode !== "system" && proxyMode !== "direct" && proxyMode !== "manual") throw new Error("Invalid Antigravity proxy mode.");
    if (proxyMode !== "manual") return { name: name.trim(), proxyMode };
    if (typeof proxyUrl !== "string" || !proxyUrl.trim() || webChatProxyConfig(proxyUrl.trim()).mode !== "fixed_servers") {
      throw new Error("Enter a proxy URL in manual mode.");
    }
    return { name: name.trim(), proxyMode, proxyUrl: proxyUrl.trim() };
  }

  async save(input: unknown): Promise<AntigravityAccount> {
    const profile = this.parseProfile(input);
    const id = (input as AntigravityAccountInput).id;
    if (id !== undefined) {
      const dir = this.accountDir(id);
      if (this.busy(id)) throw new Error("Wait for the Antigravity account operation to finish.");
      this.saving.add(id);
      const temp = path.join(dir, `.profile-${randomUUID()}`);
      try {
        await fs.writeFile(temp, JSON.stringify(profile), { flag: "wx", mode: 0o600 });
        await fs.rename(temp, path.join(dir, "profile.json"));
        return { ...profile, id, connected: await this.connected(dir) };
      } finally {
        this.saving.delete(id);
        await fs.rm(temp, { force: true });
      }
    }
    const account = { ...profile, id: `agy_${randomUUID()}`, connected: false };
    const dir = this.accountDir(account.id);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const pending = await fs.mkdtemp(path.join(this.root, ".new-"));
    try {
      await fs.writeFile(path.join(pending, "profile.json"), JSON.stringify(profile), { mode: 0o600 });
      await fs.rename(pending, dir);
    } finally {
      await fs.rm(pending, { recursive: true, force: true });
    }
    return account;
  }

  private async launch(id: string, proxyEnv: NodeJS.ProcessEnv) {
    const executable = findAntigravityExecutable();
    if (!executable) throw new Error("Install the Antigravity CLI (agy) on macOS.");
    const dir = this.accountDir(id);
    await this.profile(id);
    const cliDir = path.join(dir, "antigravity-cli");
    await fs.mkdir(cliDir, { mode: 0o700 })
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const settings = {
      toolPermission: "request-review",
      permissions: { deny: [`read_file(${this.root}/**)`, `write_file(${this.root}/**)`] },
    };
    await fs.writeFile(path.join(cliDir, "settings.json"), JSON.stringify(settings), { flag: "wx", mode: 0o600 })
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const workspace = path.join(dir, "login-workspace");
    const logs = path.join(dir, "mori-logs");
    await Promise.all([workspace, logs].map(folder => fs.mkdir(folder, { mode: 0o700 })
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; })));
    const logFile = path.join(logs, `${randomUUID()}.log`);
    await fs.writeFile(logFile, "", { flag: "wx", mode: 0o600 });
    const args = ["acp", "--gemini-dir", dir, "--app-data-dir", "antigravity-cli",
      "--sandbox", "--disable-telemetry", "--log-file", logFile];
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      LANG: process.env.LANG,
      TMPDIR: os.tmpdir(),
      AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
      ...proxyEnv,
    };
    const verifyStorage = async (peer?: AcpJsonRpcPeer) => {
      // agy initializes credential storage on its first authenticated RPC.
      // A read-only list request emits the marker even for an unsigned-in account.
      if (peer) await peer.request("session/list", { cwd: workspace }).catch(() => {});

      const log = await fs.readFile(logFile, "utf8");
      if (!log.includes(STORAGE_MARKER)) throw new Error("Antigravity could not verify isolated token storage. Use a supported agy version.");
    };
    return { executable, args, env, dir, workspace, verifyStorage };
  }

  private busy(id: string): boolean {
    return (this.login?.id === id && this.login.status.state === "pending") || this.removingCredentials.has(id) || this.saving.has(id);
  }

  async assertReady(id: string): Promise<string> {
    if (!findAntigravityExecutable()) throw new Error("Install the Antigravity CLI (agy) on macOS.");
    if (this.busy(id)) throw new Error("Wait for the Antigravity account operation to finish.");
    const dir = this.accountDir(id);
    if (!await this.connected(dir)) throw new Error("Sign in to this Antigravity account in Settings.");
    return fs.readFile(path.join(dir, PROFILE_READY), "utf8");
  }

  async assertThreadReady(id: string, generation: string | undefined): Promise<void> {
    if (await this.assertReady(id) !== (generation ?? "")) {
      throw new Error("This conversation belongs to a previous Antigravity CLI sign-in. Start a new conversation.");
    }
  }

  async runtime(id: string, proxyEnv: NodeJS.ProcessEnv, generation: string | undefined) {
    await this.assertThreadReady(id, generation);
    const launch = await this.launch(id, proxyEnv);
    await this.assertThreadReady(id, generation);
    return launch;
  }

  private async withConnection<T>(
    launch: Awaited<ReturnType<AntigravityAccounts["launch"]>>,
    cb: (peer: AcpJsonRpcPeer, client: AcpClient, init: Awaited<ReturnType<AcpClient["initialize"]>>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const { child } = spawnManagedProcess({
      command: launch.executable, args: launch.args, env: launch.env, cwd: launch.workspace,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.resume();
    const lines = createInterface({ input: child.stdout! });
    const peer = new AcpJsonRpcPeer({
      write: line => child.stdin!.write(line),
      onLine: callback => { lines.on("line", callback); },
    });
    const cancel = () => peer.dispose();
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdin!.on("error", cancel);
    child.once("error", cancel);
    child.once("exit", cancel);
    const client = new AcpClient({ peer, clientInfo: { name: "Mori", version: "1" } });
    try {
      const init = await client.initialize();
      await launch.verifyStorage(peer);
      signal?.throwIfAborted();
      return await cb(peer, client, init);
    } finally {
      signal?.removeEventListener("abort", cancel);
      peer.dispose();
      lines.close();
      killChildProcessTree(child);
    }
  }

  start(id: unknown, mode: unknown): void {
    this.accountDir(id);
    if (typeof id !== "string" || (mode !== "browser" && mode !== "code")) throw new Error("Invalid Antigravity sign-in request.");
    if (this.login?.status.state === "pending" || this.busy(id)) throw new Error("An Antigravity account operation is in progress.");
    const login: Login = { id, status: { state: "pending" }, controller: new AbortController() };
    this.login = login;
    void this.signIn(login, mode);
  }

  status(id: unknown): AntigravityLoginStatus {
    if (!this.login || this.login.id !== id) return { state: "idle" };
    return this.login.status;
  }

  submit(id: unknown, input: unknown): void {
    const login = this.login;
    const value = typeof input === "string" ? input.trim() : "";
    if (!login || login.id !== id || !login.submit || login.status.state !== "pending" ||
      !login.status.authorizationUrl || !value || value.length > 4096 || /\s/u.test(value)) {
      throw new Error("Enter a valid Antigravity authorization code.");
    }
    let code = value;
    if (value.startsWith("http://") || value.startsWith("https://")) {
      const callback = URL.parse(value);
      const authorization = new URL(login.status.authorizationUrl);
      const redirect = URL.parse(authorization.searchParams.get("redirect_uri") ?? "");
      if (!callback || !redirect || callback.origin !== redirect.origin || callback.pathname !== redirect.pathname ||
        callback.username || callback.password || callback.hash || callback.searchParams.has("error") ||
        callback.searchParams.get("state") !== authorization.searchParams.get("state") ||
        callback.searchParams.getAll("code").length !== 1) {
        throw new Error("The returned URL does not match this Antigravity authorization.");
      }
      code = callback.searchParams.get("code") ?? "";
      if (!code || /\s/u.test(code)) throw new Error("The returned URL has no valid authorization code.");
    }
    const send = login.submit;
    delete login.submit;
    login.status = { state: "pending" };
    send(code);
  }

  cancel(id?: unknown): void {
    if (id === undefined || this.login?.id === id) this.login?.controller.abort();
  }

  private async signIn(login: Login, mode: AntigravityLoginMode): Promise<void> {
    const signal = login.controller.signal;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      login.controller.abort();
    }, PROCESS_TIMEOUT);
    let attempted = false;
    try {
      const profile = await this.profile(login.id);
      const proxyEnv = await this.resolveProxyEnv(profile);
      if (profile.proxyMode === "manual" && !proxyEnv.HTTPS_PROXY) throw new Error("Could not configure this Antigravity account’s manual proxy.");
      const launch = await this.launch(login.id, proxyEnv);
      if (await this.tokenExists(launch.dir)) throw new Error("Sign out before switching this Antigravity account.");
      attempted = true;
      if (mode === "browser") {
        await this.browserLogin(login, launch);
      } else {
        // Check isolated storage before starting the code login process.
        await this.withConnection(launch, async () => {}, signal);
        await this.codeLogin(login, await this.launch(login.id, proxyEnv));
      }
      await this.withConnection(await this.launch(login.id, proxyEnv), async (peer, client, init) => {
        if (!await this.tokenExists(launch.dir)) throw new Error("Antigravity did not save an isolated credential.");
        let sessionId: string;
        try {
          ({ sessionId } = await client.newSession({ cwd: launch.workspace }));
        } catch {
          throw new Error("Antigravity saved a credential but could not open an authenticated ACP session.");
        }
        if (init.agentCapabilities?.sessionCapabilities?.close) await peer.request("session/close", { sessionId });
      }, signal);
      signal.throwIfAborted();
      await fs.writeFile(path.join(launch.dir, PROFILE_READY), randomUUID(), { mode: 0o600 });
      login.status = { state: "connected" };
    } catch (error) {
      if (attempted) {
        try {
          await fs.rm(path.join(this.accountDir(login.id), TOKEN_PATH), { force: true });
        } catch {
          login.status = { state: "failed", message: "Antigravity could not remove the credential from the incomplete sign-in." };
          return;
        }
      }
      login.status = timedOut
        ? { state: "failed", message: "Antigravity authorization expired. Generate a new authorization link." }
        : signal.aborted
        ? { state: "cancelled" }
        : { state: "failed", message: error instanceof Error ? error.message : "Antigravity sign-in failed." };
    } finally {
      clearTimeout(timer);
      login.controller.abort();
      delete login.submit;
    }
  }

  private async browserLogin(
    login: Login,
    launch: Awaited<ReturnType<AntigravityAccounts["launch"]>>,
  ): Promise<void> {
    const signal = login.controller.signal;
    signal.throwIfAborted();
    const openerDir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-agy-browser-login-"));
    const urlFile = path.join(openerDir, "url");
    const stop = new AbortController();
    const browserSignal = AbortSignal.any([signal, stop.signal]);
    let page: AccountBrowserPage | undefined;
    let stopWatching: (() => void) | undefined;
    try {
      // agy invokes macOS open via PATH. Route just this login subprocess to Mori.
      await fs.writeFile(path.join(openerDir, "open"), [
        "#!/bin/sh",
        "umask 077",
        'printf "%s\\n" "$@" > "$MORI_AGY_AUTH_URL.tmp" && /bin/mv "$MORI_AGY_AUTH_URL.tmp" "$MORI_AGY_AUTH_URL"',
        "",
      ].join("\n"), { mode: 0o700 });
      const env = { ...launch.env, PATH: `${openerDir}:${launch.env.PATH}`, MORI_AGY_AUTH_URL: urlFile };
      await this.withConnection({ ...launch, env }, async (peer, _client, init) => {
        if (!init.authMethods?.some(method => method.id === "oauth-personal")) {
          throw new Error("This agy version does not advertise Google sign-in.");
        }
        await Promise.all([
          peer.request("authenticate", { methodId: "oauth-personal" }, PROCESS_TIMEOUT)
            .catch(() => { throw new Error("Google browser authorization did not complete."); }),
          (async () => {
            const url = await this.waitForBrowserAuthorizationUrl(urlFile, browserSignal);
            const redirect = URL.parse(url.searchParams.get("redirect_uri") ?? "");
            if (!redirect || redirect.protocol !== "http:" || !redirect.port ||
              !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) || redirect.username || redirect.password ||
              !url.searchParams.get("state")) {
              throw new Error("Antigravity did not provide a valid local authorization callback.");
            }
            const opened = await this.createLoginPage(login.id, target => {
              const destination = URL.parse(target);
              return Boolean(destination && (destination.protocol === "https:" ||
                (destination.origin === redirect.origin && destination.pathname === redirect.pathname)));
            });
            if (browserSignal.aborted) {
              await opened.close();
              browserSignal.throwIfAborted();
            }
            page = opened;
            stopWatching = opened.onClosed(() => login.controller.abort());
            await prepareAccountLoginBrowser(opened);
            browserSignal.throwIfAborted();
            await opened.webContents.loadURL(url.href);
          })(),
        ]);
      }, browserSignal);
    } finally {
      stop.abort();
      stopWatching?.();
      try {
        await page?.close();
      } finally {
        await fs.rm(openerDir, { recursive: true, force: true });
      }
    }
  }

  private async waitForBrowserAuthorizationUrl(file: string, signal: AbortSignal): Promise<URL> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const args = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (args !== undefined) {
        const candidate = args.split("\n").find(arg => arg.startsWith("https://accounts.google.com/"));
        return new URL(this.authorizationUrl(candidate));
      }
      await delay(100, undefined, { signal });
    }
    throw new Error("Antigravity did not hand off a browser authorization link.");
  }

  private authorizationUrl(value: string | undefined): string {
    const url = value ? URL.parse(value) : null;
    if (!url || url.origin !== "https://accounts.google.com" || url.username || url.password ||
      !url.pathname.startsWith("/o/oauth2/") || !url.searchParams.get("client_id") ||
      url.searchParams.get("response_type") !== "code") {
      throw new Error("Antigravity did not provide a valid Google authorization URL.");
    }
    return url.href;
  }

  private async codeLogin(
    login: Login,
    launch: Awaited<ReturnType<AntigravityAccounts["launch"]>>,
  ): Promise<void> {
    const signal = login.controller.signal;
    signal.throwIfAborted();
    const { child } = spawnManagedProcess({
      command: launch.executable, args: [...launch.args, "--login"],
      env: { ...launch.env, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" },
      cwd: launch.workspace, stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(new Error("Antigravity authorization did not finish."));
        const cancel = () => { fail(); };
        signal.addEventListener("abort", cancel, { once: true });
        child.once("error", fail);
        child.stdin!.on("error", fail);
        let opened = false;
        const inspect = (stream: NodeJS.ReadableStream) => {
          let output = "";
          stream.on("data", (chunk: Buffer) => {
            if (opened || signal.aborted) return;
            output = (output + chunk.toString()).slice(-32_768);
            const match = output.match(/https:\/\/accounts\.google\.com\/[^\s\x1b<>"']+(?=[\s\x1b])/u);
            if (!match) return;
            opened = true;
            let url: string;
            try {
              url = this.authorizationUrl(match[0]);
            } catch {
              fail();
              return;
            }
            login.submit = code => { child.stdin!.write(`${code}\n`); };
            login.status = { state: "pending", authorizationUrl: url };
          });
        };
        inspect(child.stdout!);
        inspect(child.stderr!);
        child.once("close", code => {
          signal.removeEventListener("abort", cancel);
          if (code === 0 && opened) resolve();
          else fail();
        });
      });
      await launch.verifyStorage();
    } finally {
      killChildProcessTree(child);
    }
  }

  async deleteAccount(id: string, cleanup: () => Promise<void>): Promise<void> {
    const dir = this.accountDir(id);
    if (this.busy(id)) throw new Error("Wait for the Antigravity account operation to finish.");
    this.removingCredentials.add(id);
    try {
      await this.profile(id);
      await cleanup();
      // Remove the account from the list atomically before cleaning up its files.
      const removed = path.join(this.root, `.deleted-${randomUUID()}`);
      await fs.rename(dir, removed);
      await fs.rm(removed, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (this.login?.id === id) this.login = undefined;
    } finally {
      this.removingCredentials.delete(id);
    }
  }

  async logout(id: unknown, disposeSessions: (id: string) => void): Promise<void> {
    this.accountDir(id);
    if (typeof id !== "string" || this.busy(id)) throw new Error("An Antigravity account operation is in progress.");
    this.removingCredentials.add(id);
    try {
      disposeSessions(id);
      const launch = await this.launch(id, await this.proxyEnv(id));
      await this.withConnection(launch, async (peer, _client, init) => {
        const auth = init.agentCapabilities?.auth as { logout?: object } | undefined;
        if (!auth?.logout) throw new Error("This agy version does not support ACP logout.");
        await peer.request("logout", {});
        if (await this.tokenExists(launch.dir)) throw new Error("Antigravity still has a saved credential after logout.");
      });
      await fs.rm(path.join(launch.dir, PROFILE_READY), { force: true });
      // Retire native CLI history while keeping the account settings and its Web profile.
      await fs.rename(path.join(launch.dir, "antigravity-cli"), path.join(launch.dir, `.signed-out-${randomUUID()}`));
    } finally {
      this.removingCredentials.delete(id);
    }
  }
}
