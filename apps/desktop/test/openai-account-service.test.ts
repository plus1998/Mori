import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { removeTempDirectory } from "./helpers/temp-directory";
import { OpenAIAccountService } from "../src/main/openai-account-service";
import { writeFakeCodexLogin } from "../test-support/fake-codex-login";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDirectory(dir)));
});

async function createService(): Promise<{ root: string; service: OpenAIAccountService }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-accounts-"));
  tempDirs.push(root);
  const service = new OpenAIAccountService(root, "codex-test");
  await service.initialize();
  return { root, service };
}

test("wake model defaults to automatic Luna and remembers an explicit choice across restarts", async () => {
  const { root, service } = await createService();
  expect(service.getWakeModel()).toBeNull();
  service.setWakeModel(" gpt-5.6-luna ");
  expect(service.getWakeModel()).toBe("gpt-5.6-luna");
  service.dispose();
  const reopened = new OpenAIAccountService(root, "codex-test");
  try {
    await reopened.initialize();
    expect(reopened.getWakeModel()).toBe("gpt-5.6-luna");
    expect(() => reopened.setWakeModel(" ")).toThrow("不能为空");
    expect(reopened.getWakeModel()).toBe("gpt-5.6-luna");
    reopened.setWakeModel(null);
    expect(reopened.getWakeModel()).toBeNull();
  } finally {
    reopened.dispose();
  }
});

function jwtWithExpiry(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("account operations reject traversal and unregistered ids before filesystem access", async () => {
  const { root, service } = await createService();
  const sentinel = path.join(root, "sentinel.txt");
  await fs.writeFile(sentinel, "keep", "utf8");

  await expect(service.deleteAccount("../sentinel.txt")).rejects.toThrow("Invalid OpenAI account id");
  await expect(service.setAuthJson("oa_not_registered", "{}")).rejects.toThrow(
    "OpenAI account not found",
  );
  await expect(service.getAuthJsonContent("oa_not_registered")).rejects.toThrow(
    "OpenAI account not found",
  );
  expect(await fs.readFile(sentinel, "utf8")).toBe("keep");

  service.dispose();
});

test("expired JWT credentials are not reported as logged in", async () => {
  const { service } = await createService();
  const account = await service.createAccount("Expired");
  const result = await service.setAuthJson(
    account.id,
    JSON.stringify({
      tokens: {
        access_token: jwtWithExpiry(Math.floor(Date.now() / 1000) - 60),
        account_id: "chatgpt-account",
      },
    }),
  );

  expect(result.success).toBe(true);
  expect(await service.isAccountLoggedIn(account.id)).toBe(false);
  expect((await service.listAccounts())[0]).toMatchObject({
    id: account.id,
    isLoggedIn: false,
    authState: "expired",
  });

  service.dispose();
});

test("account proxy modes keep system, direct, and manual states distinct", async () => {
  const { service } = await createService();
  await expect(service.createAccount({ name: "Missing manual URL", proxyMode: "manual" })).rejects.toThrow(
    "手动代理模式需要填写代理地址",
  );
  const system = await service.createAccount({ name: "System", proxyMode: "system" });
  const direct = await service.createAccount({ name: "Direct", proxyMode: "direct" });
  const manual = await service.createAccount({
    name: "Manual",
    proxyMode: "manual",
    proxyUrl: "socks5://127.0.0.1:7890",
  });

  expect(system).toMatchObject({ proxyMode: "system" });
  expect(system.proxyUrl).toBeUndefined();
  expect(direct).toMatchObject({ proxyMode: "direct" });
  expect(direct.proxyUrl).toBeUndefined();
  expect(manual).toMatchObject({ proxyMode: "manual", proxyUrl: "socks5://127.0.0.1:7890" });

  await service.updateAccount({
    accountId: manual.id,
    name: manual.name,
    proxyMode: "direct",
    proxyUrl: "",
  });
  expect((await service.listAccounts()).find((account) => account.id === manual.id)).toMatchObject({
    proxyMode: "direct",
  });
  expect((await service.listAccounts()).find((account) => account.id === manual.id)?.proxyUrl).toBeUndefined();

  service.dispose();
});

test("proxy mode migration maps legacy blank and configured URLs to system and manual", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-accounts-"));
  tempDirs.push(root);
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  db.exec(`
    CREATE TABLE openai_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      proxy_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      email TEXT,
      password TEXT,
      pickup_url TEXT,
      two_factor_secret TEXT,
      auth_json TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO openai_accounts
      (id, name, proxy_url, created_at, updated_at, email, password, pickup_url, two_factor_secret, auth_json)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
  `);
  insert.run("oa_legacy_system", "Legacy system", null, "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
  insert.run(
    "oa_legacy_manual",
    "Legacy manual",
    "http://127.0.0.1:7890",
    "2026-10-01T00:00:00.000Z",
    "2026-10-01T00:00:00.000Z",
  );
  db.close();

  const service = new OpenAIAccountService(root, "codex-test");
  await service.initialize();
  expect((await service.listAccounts()).map((account) => [account.id, account.proxyMode, account.proxyUrl])).toEqual([
    ["oa_legacy_system", "system", undefined],
    ["oa_legacy_manual", "manual", "http://127.0.0.1:7890"],
  ]);
  service.dispose();
});

// writeFakeCodexLogin 是 POSIX shebang 脚本（无扩展名），Windows 无法直接启动它，所以这个用例只在
// POSIX 上跑：不假装覆盖 Windows 的进程启动语义。
test.skipIf(process.platform === "win32")("cancelling an OAuth login settles the result and terminates the codex child", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-accounts-"));
  tempDirs.push(root);
  const executable = path.join(root, "fake-codex");
  await writeFakeCodexLogin(executable);

  const service = new OpenAIAccountService(root, executable);
  await service.initialize();
  const account = await service.createAccount("Cancellable");
  const login = await service.startLogin(account.id);
  if (!login) throw new Error("Expected the fake Codex process to emit an auth URL");

  login.cancel();

  await expect(login.result).resolves.toEqual({ success: false, message: "登录已取消" });
  service.dispose();
});

test.skipIf(process.platform === "win32")("deleting an account cancels login and removes only its browser profile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-accounts-"));
  tempDirs.push(root);
  const executable = path.join(root, "fake-codex");
  await writeFakeCodexLogin(executable);
  const service = new OpenAIAccountService(root, executable);
  await service.initialize({ startBackground: false });
  try {
    const first = await service.createAccount("First");
    const second = await service.createAccount("Second");
    const firstPath = await service.getBrowserDataPath(first.id);
    const secondPath = await service.getBrowserDataPath(second.id);
    expect(firstPath).toBe(path.join(root, "codex-accounts", first.id, "browser"));
    for (const profile of [firstPath, secondPath]) {
      await fs.mkdir(profile, { recursive: true });
      await fs.writeFile(path.join(profile, "site-data"), "profile fixture");
    }
    const login = await service.startLogin(first.id);
    if (!login) throw new Error("Expected login");
    await service.deleteAccount(first.id);
    expect(await login.result).toMatchObject({ success: false, message: "登录已取消" });
    await expect(fs.stat(path.dirname(firstPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(secondPath, "site-data"), "utf8")).toBe("profile fixture");
    await expect(service.getBrowserDataPath(first.id)).rejects.toThrow("OpenAI account not found");
    await expect(service.getBrowserDataPath("../escape")).rejects.toThrow("Invalid OpenAI account id");
    expect((await service.listAccounts()).map(account => account.id)).toEqual([second.id]);
  } finally {
    await service.dispose();
  }
});

// 旧版全局 auth.json 的一次性迁移：保留较新的凭据，之后不再维护全局副本。

const STALE_STAMP = "2026-09-28T02:02:53.237Z";
const FRESH_STAMP = "2026-09-28T02:46:01.085916Z"; // Codex 用微秒精度写，Date.parse 必须能解

function authJson(input: { refreshToken: string; lastRefresh: string; accountId?: string }): string {
  return JSON.stringify(
    {
      OPENAI_API_KEY: null,
      auth_mode: "chatgpt",
      last_refresh: input.lastRefresh,
      tokens: {
        id_token: `id-${input.refreshToken}`,
        access_token: `at-${input.refreshToken}`,
        refresh_token: input.refreshToken,
        account_id: input.accountId ?? "acct-shared",
      },
    },
    null,
    2,
  );
}

/** 预置一份「上次运行留下的漂移」盘面，再让服务启动时自己收敛。 */
async function seedDriftedState(
  root: string,
  input: {
    accountId: string;
    accountAuth: string;
    mainAuth: string;
  },
): Promise<void> {
  await fs.mkdir(path.join(root, "codex-accounts", input.accountId), { recursive: true });
  await fs.writeFile(
    path.join(root, "codex-accounts", input.accountId, "auth.json"),
    input.accountAuth,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "codex-accounts", "accounts.json"),
    JSON.stringify([{ id: input.accountId, name: "A", createdAt: "2026-09-28T00:00:00.000Z" }]),
    "utf8",
  );
  await fs.writeFile(path.join(root, "codex-accounts", "active_account.txt"), input.accountId, "utf8");
  await fs.mkdir(path.join(root, "codex"), { recursive: true });
  await fs.writeFile(path.join(root, "codex", "auth.json"), input.mainAuth, "utf8");
}

async function refreshTokenIn(filePath: string): Promise<string> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as {
    tokens: { refresh_token: string };
  };
  return parsed.tokens.refresh_token;
}

test("migration keeps newer account credentials and archives the old global file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-accounts-"));
  tempDirs.push(root);
  const accountId = "oa_relogin";
  await seedDriftedState(root, {
    accountId,
    // 用户在上一轮运行里重新登录过：新凭据只落到了账号目录。
    accountAuth: authJson({ refreshToken: "rt-fresh", lastRefresh: FRESH_STAMP }),
    mainAuth: authJson({ refreshToken: "rt-stale", lastRefresh: STALE_STAMP }),
  });

  const service = new OpenAIAccountService(root, "codex-test");
  await service.initialize();

  expect(JSON.parse((await service.getAuthJsonContent(accountId))!).tokens.refresh_token).toBe("rt-fresh");
  expect(await fs.stat(path.join(root, "codex", "auth.json")).then(() => true, () => false)).toBe(false);
  service.dispose();
});

test("initialize never buries CODEX_HOME credentials that are newer than the account copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-accounts-"));
  tempDirs.push(root);
  const accountId = "oa_refreshed";
  await seedDriftedState(root, {
    accountId,
    // 反方向：Codex 已经刷新过 CODEX_HOME，账号目录才是旧的那份。
    accountAuth: authJson({ refreshToken: "rt-stale", lastRefresh: STALE_STAMP }),
    mainAuth: authJson({ refreshToken: "rt-fresh", lastRefresh: FRESH_STAMP }),
  });

  const service = new OpenAIAccountService(root, "codex-test");
  await service.initialize();

  expect(JSON.parse((await service.getAuthJsonContent(accountId))!).tokens.refresh_token).toBe("rt-fresh");
  expect(await fs.stat(path.join(root, "codex", "auth.json")).then(() => true, () => false)).toBe(false);
  service.dispose();
});

test("initialize also pulls a newer CODEX_HOME credential into the account copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-accounts-"));
  tempDirs.push(root);
  const accountId = "oa_refresh_race";
  await seedDriftedState(root, {
    accountId,
    // Codex 刷新完 CODEX_HOME 后 app 立刻退出，回写没跑完：账号目录偏旧。不抹平的话，
    // 下次重新激活这个账号会把旧凭据写回 CODEX_HOME。
    accountAuth: authJson({ refreshToken: "rt-stale", lastRefresh: STALE_STAMP }),
    mainAuth: authJson({ refreshToken: "rt-fresh", lastRefresh: FRESH_STAMP }),
  });

  const service = new OpenAIAccountService(root, "codex-test");
  await service.initialize();

  const saved = await service.getAuthJsonContent(accountId);
  if (!saved) throw new Error("Expected SQLite auth.json content");
  expect(JSON.parse(saved).tokens.refresh_token).toBe("rt-fresh");
  service.dispose();
});

test("migration preserves account credentials when the legacy global file belongs to another identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-accounts-"));
  tempDirs.push(root);
  const accountId = "oa_switching";
  const accountPath = path.join(root, "codex-accounts", accountId, "auth.json");
  await seedDriftedState(root, {
    accountId,
    // 切账号进行中：active 标记仍指向本账号，但 CODEX_HOME 里已经是另一个 ChatGPT
    // 账号的凭据。它更新，于是会走「回写账号目录」这条路——必须被账号 id 拦住。
    accountAuth: authJson({
      refreshToken: "rt-mine",
      lastRefresh: STALE_STAMP,
      accountId: "acct-mine",
    }),
    mainAuth: authJson({
      refreshToken: "rt-other",
      lastRefresh: FRESH_STAMP,
      accountId: "acct-other",
    }),
  });
  const service = new OpenAIAccountService(root, "codex-test");
  await service.initialize();
  const saved = await service.getAuthJsonContent(accountId);
  if (!saved) throw new Error("Expected the account credential to remain stored");
  expect(JSON.parse(saved).tokens.refresh_token).toBe("rt-mine");
  service.dispose();
});

test('conversations fetch only their chosen account tokens; deleting one account never selects another', async () => {
  const { root, service } = await createService();
  try {
    const a = await service.createAccount('A');
    const b = await service.createAccount('B');
    const raw = (id: string) => JSON.stringify({ tokens: { account_id: `chatgpt-${id}`, access_token: `access-${id}`, refresh_token: `private-${id}` } });
    await service.setAuthJson(a.id, raw('a'));
    await service.setAuthJson(b.id, raw('b'));
    const tokens = await Promise.all([service.getExternalChatGptTokens(a.id), service.getExternalChatGptTokens(b.id)]);
    expect(tokens).toEqual([
      { accessToken: 'access-a', chatgptAccountId: 'chatgpt-a' },
      { accessToken: 'access-b', chatgptAccountId: 'chatgpt-b' },
    ]);
    expect(JSON.stringify(tokens)).not.toContain('private-');
    expect(await fs.stat(path.join(root, 'codex', 'auth.json')).then(() => true, () => false)).toBe(false);
    await service.deleteAccount(a.id);
    await expect(service.getExternalChatGptTokens(a.id)).rejects.toThrow('not found');
    expect(await service.getExternalChatGptTokens(b.id)).toEqual(tokens[1]);
  } finally { await service.dispose(); }
});
