import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { removeTempDirectory } from "../test/helpers/temp-directory";
import { OpenAIAccountService, readAuthRefreshStamp } from "../src/main/openai-account-service";
import { parseOpenAIAccountImport } from "../src/main/openai-account-import";
import { writeFakeCodexLogin } from "../test-support/fake-codex-login";
import { OpenAIAccountStore } from "../src/main/openai-account-store";

function authJson(input: { accountId: string; refreshToken: string; stamp: string; unknown?: unknown }): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    last_refresh: input.stamp,
    unrecognized_codex_field: input.unknown ?? { retained: true, nested: [1, "two"] },
    tokens: {
      access_token: `access-${input.refreshToken}`,
      refresh_token: input.refreshToken,
      account_id: input.accountId,
      id_token: `id-${input.refreshToken}`,
    },
  }, null, 2);
}

async function makeService(t: test.TestContext, executable?: string, onAccountsChanged?: ConstructorParameters<typeof OpenAIAccountService>[2]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-sqlite-"));
  const service = new OpenAIAccountService(root, executable, onAccountsChanged);
  await service.initialize();
  t.after(async () => {
    await service.dispose();
    await removeTempDirectory(root);
  });
  return { root, service };
}

function quotaResponse(usedPercent = 24) {
  return {
    rateLimits: {
      planType: "plus",
      primary: { usedPercent, windowDurationMins: 300, resetsAt: 2_000_000_000 },
      secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: 2_000_086_400 },
    },
    rateLimitResetCredits: { availableCount: 2 },
  };
}

async function makeQuotaService(t: test.TestContext, onAccountsChanged?: ConstructorParameters<typeof OpenAIAccountService>[2]) {
  const quotaRead = t.mock.fn(async (): Promise<ReturnType<typeof quotaResponse>> => quotaResponse());
  const client = {
    async request<T>(method: string): Promise<T> {
      if (method === "account/read") {
        return { account: { type: "chatgpt", planType: "plus", email: "quota@example.test" } } as T;
      }
      assert.equal(method, "account/rateLimits/read");
      return await quotaRead() as T;
    },
  };
  const fixture = await makeService(t, 'unused-codex', onAccountsChanged);
  t.mock.method(fixture.service as unknown as { runAccountClient: unknown }, 'runAccountClient', async (_input: unknown, operation: (client: typeof client) => unknown) => operation(client));
  return { ...fixture, quotaRead };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`condition did not become true within ${timeoutMs}ms`);
}

test("Node SQLite migrates and archives complete legacy account data idempotently", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-migrate-"));
  t.after(async () => removeTempDirectory(root));
  const accountsDir = path.join(root, "codex-accounts");
  const id = "oa_legacy_one";
  const rawAuth = ` {\n  "tokens": {"access_token":"at-legacy", "account_id":"chatgpt-legacy"},\n  "mystery": {"leave": [1, 2]}\n}\n`;
  await fs.mkdir(path.join(accountsDir, id), { recursive: true });
  await fs.writeFile(path.join(accountsDir, "accounts.json"), JSON.stringify([{
    id,
    name: "Legacy",
    proxyUrl: "http://127.0.0.1:7890",
    createdAt: "2026-01-02T03:04:05.000Z",
    email: "legacy@example.com",
    password: "raw password with spaces ",
    pickupUrl: "https://example.test/pickup?key=a%2Fb&x=1",
    twoFactorSecret: "JBSWY3DPEHPK3PXP",
  }]), "utf8");
  await fs.writeFile(path.join(accountsDir, "active_account.txt"), id, "utf8");
  await fs.writeFile(path.join(accountsDir, id, "auth.json"), rawAuth, "utf8");

  let service = new OpenAIAccountService(root);
  await service.initialize();
  assert.deepEqual(await service.getAccountDetails(id), {
    id,
    name: "Legacy",
    proxyMode: "manual",
    proxyUrl: "http://127.0.0.1:7890",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    email: "legacy@example.com",
    password: "raw password with spaces ",
    pickupUrl: "https://example.test/pickup?key=a%2Fb&x=1",
    twoFactorSecret: "JBSWY3DPEHPK3PXP",
    authJson: rawAuth,
  });
  assert.equal(await fs.readFile(path.join(root, "codex-accounts", "accounts.json")).then(() => true, () => false), false);
  const archives = await fs.readdir(path.join(root, "codex-accounts-archive"));
  assert.equal(archives.length, 1);
  const archive = path.join(root, "codex-accounts-archive", archives[0]!);
  assert.equal(await fs.readFile(path.join(archive, id, "auth.json"), "utf8"), rawAuth);

  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  const row = db.prepare("SELECT email, password, pickup_url, two_factor_secret, auth_json, updated_at FROM openai_accounts WHERE id = ?").get(id) as Record<string, string>;
  assert.equal(row.password, "raw password with spaces ");
  assert.equal(row.auth_json, rawAuth);
  assert.equal(row.updated_at, "2026-01-02T03:04:05.000Z");
  db.close();
  await service.dispose();

  service = new OpenAIAccountService(root);
  await service.initialize();
  assert.equal((await service.listAccounts()).length, 1);
  assert.equal(await service.getAuthJsonContent(id), rawAuth);
  await service.dispose();
});

test("damaged legacy data fails initialization and leaves source files untouched", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-damaged-"));
  t.after(async () => removeTempDirectory(root));
  const accountsDir = path.join(root, "codex-accounts");
  const source = path.join(accountsDir, "accounts.json");
  await fs.mkdir(accountsDir, { recursive: true });
  await fs.writeFile(source, "{ broken", "utf8");
  const service = new OpenAIAccountService(root);
  await assert.rejects(service.initialize(), /accounts\.json 损坏/u);
  assert.equal(await fs.readFile(source, "utf8"), "{ broken");
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  const count = (db.prepare("SELECT COUNT(*) AS count FROM openai_accounts").get() as { count: number }).count;
  assert.equal(count, 0);
  db.close();
});

test("profile editor details preserve raw values and explicitly cleared fields are removed", async (t) => {
  const { service } = await makeService(t);
  const account = await service.createAccount({
    name: "Profile",
    proxyUrl: "http://proxy.example.test:8080",
    email: "profile@example.test",
    password: "fictional password with trailing space ",
    pickupUrl: "https://pickup.example.test/?key=a%2Fb",
    twoFactorSecret: "JBSWY3DPEHPK3PXP",
  });
  const created = await service.getAccountDetails(account.id);
  assert.equal(created.email, "profile@example.test");
  assert.equal(created.password, "fictional password with trailing space ");
  assert.equal(created.pickupUrl, "https://pickup.example.test/?key=a%2Fb");
  assert.equal(created.twoFactorSecret, "JBSWY3DPEHPK3PXP");

  await service.updateAccount({ accountId: account.id, name: "Profile" });
  const partialUpdate = await service.getAccountDetails(account.id);
  assert.equal(partialUpdate.proxyUrl, "http://proxy.example.test:8080");
  assert.equal(partialUpdate.email, "profile@example.test");
  assert.equal(partialUpdate.password, "fictional password with trailing space ");

  await service.updateAccount({
    accountId: account.id,
    name: "Profile",
    proxyUrl: "",
    email: "",
    password: "replacement password",
    pickupUrl: "",
    twoFactorSecret: "",
  });
  const updated = await service.getAccountDetails(account.id);
  assert.equal(updated.proxyUrl, undefined);
  assert.equal(updated.email, undefined);
  assert.equal(updated.password, "replacement password");
  assert.equal(updated.pickupUrl, undefined);
  assert.equal(updated.twoFactorSecret, undefined);
  assert.equal((await service.listAccounts())[0]?.hasProfileData, true);
  assert.equal("password" in (await service.listAccounts())[0]!, false);
});

test("import parser handles Markdown wrappers, optional fields, and line-numbered errors", () => {
  const markdown = "[person@example.com---- raw password ----https://mail.test/pickup?key=a%2Fb&x=1----JBSWY3DPEHPK3PXP](https://export.test/record?id=9)\nsolo@example.com----pw";
  const parsed = parseOpenAIAccountImport(markdown);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.rows, [
    {
      lineNumber: 1,
      email: "person@example.com",
      password: " raw password ",
      pickupUrl: "https://mail.test/pickup?key=a%2Fb&x=1",
      twoFactorSecret: "JBSWY3DPEHPK3PXP",
    },
    { lineNumber: 2, email: "solo@example.com", password: "pw" },
  ]);
  const bad = parseOpenAIAccountImport("\nnot-an-email----pw\nuser@example.com----pw----ftp://bad.test\nuser@example.com----pw----https://ok.test----2fa----extra\n----\n");
  assert.deepEqual(bad.errors.map((entry) => entry.lineNumber), [2, 3, 4, 5]);
});

test("import separates a Markdown-wrapped pickup URL and 2FA without storing the wrapper target", () => {
  const pickupUrl = "https://mail.test/pickup?email=person%40example.com&token=fictional";
  const secret = "JBSWY3DPEHPK3PXP";
  const parsed = parseOpenAIAccountImport([
    `person@example.com----pw----[${pickupUrl}----${secret}](${pickupUrl.replace("&", "\\&")}----${secret})`,
    `other@example.com----pw----[${pickupUrl}](https://ignored.test/?token=do-not-store)----${secret}`,
  ].join("\n"));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.rows.map(({ pickupUrl, twoFactorSecret }) => ({ pickupUrl, twoFactorSecret })), [
    { pickupUrl, twoFactorSecret: secret },
    { pickupUrl, twoFactorSecret: secret },
  ]);
  assert.equal(JSON.stringify(parsed.rows).includes("ignored.test"), false);
  const extra = parseOpenAIAccountImport(`person@example.com----pw----[${pickupUrl}----${secret}----extra](${pickupUrl})`);
  assert.match(extra.errors[0]?.message ?? "", /多余/u);
});

test("import preserves password brackets and Markdown-looking passwords literally", () => {
  for (const password of ["abc[def", "abc]def(", "[literal](https://password.test)"]) {
    for (const wrapped of [false, true]) {
      const line = `person@example.com----${password}----https://pickup.test/?key=x----SECRET`;
      const parsed = parseOpenAIAccountImport(wrapped ? `[${line}](https://export.test/record)` : line);
      assert.deepEqual(parsed.errors, []);
      assert.equal(parsed.rows[0]?.password, password);
      assert.equal(parsed.rows[0]?.pickupUrl, "https://pickup.test/?key=x");
      assert.equal(parsed.rows[0]?.twoFactorSecret, "SECRET");
    }
  }
});

test("refresh stamps retain microsecond ordering beyond Date.parse precision", () => {
  const earlier = readAuthRefreshStamp('{"last_refresh":"2026-10-01T01:00:00.123456Z"}');
  const later = readAuthRefreshStamp('{"last_refresh":"2026-10-01T01:00:00.123987Z"}');
  assert.ok(earlier !== undefined && later !== undefined);
  assert.ok(later > earlier);
});

test("imports merge non-empty data by case-insensitive email and roll back the entire SQLite transaction", async (t) => {
  const { root, service } = await makeService(t);
  const existing = await service.createAccount({
    name: "Keep this name",
    email: "person@example.com",
    password: "old password",
    pickupUrl: "https://old.test/?a=1",
    twoFactorSecret: "OLDSECRET",
    proxyUrl: "http://proxy.test:8080",
  });
  const result = service.importAccounts([
    "PERSON@example.com----new password",
    "person@example.com--------https://new.test/pickup?x=a%2Fb----NEWSECRET",
    "new@example.com----pw----https://pickup.test/?token=abc",
    "----pw",
  ].join("\n"));
  assert.deepEqual(result, { added: 2, updated: 1 });
  const existingDetails = await service.getAccountDetails(existing.id);
  assert.equal(existingDetails.name, "Keep this name");
  assert.equal(existingDetails.proxyUrl, "http://proxy.test:8080");
  assert.equal(existingDetails.password, "new password");
  assert.equal(existingDetails.pickupUrl, "https://new.test/pickup?x=a%2Fb");
  assert.equal(existingDetails.twoFactorSecret, "NEWSECRET");
  const list = await service.listAccounts();
  assert.equal(list.find((account) => account.email === "new@example.com")?.name, "导入账号 2");
  assert.equal(list.find((account) => account.email === undefined)?.name, "导入账号 3");

  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  db.exec(`CREATE TRIGGER reject_import BEFORE INSERT ON openai_accounts
    WHEN NEW.email = 'abort@example.com'
    BEGIN SELECT RAISE(ABORT, 'forced import failure'); END;`);
  assert.throws(() => service.importAccounts("first@example.com----pw\nabort@example.com----pw"), /forced import failure/u);
  assert.equal((await service.listAccounts()).some((account) => account.email === "first@example.com"), false);
  db.close();
});

test("ambiguous duplicate emails reject the whole import with the matching line number", async (t) => {
  const { root, service } = await makeService(t);
  const one = await service.createAccount({ name: "one", email: "dup@example.com" });
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  db.prepare(`INSERT INTO openai_accounts
    (id,name,created_at,updated_at,email) VALUES(?,?,?,?,?)`).run(
    "oa_duplicate", "two", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "DUP@example.com",
  );
  db.close();
  assert.throws(() => service.importAccounts("okay@example.com----pw\ndup@example.com----pw"), /第 2 行/u);
  assert.equal((await service.listAccounts()).some((account) => account.email === "okay@example.com"), false);
  assert.equal((await service.getAccountDetails(one.id)).email, "dup@example.com");
});

/**
 * writeFakeCodexLogin 写的是 `#!/usr/bin/env node` 的 POSIX 脚本（无扩展名），Windows 的进程创建
 * 语义无法启动它（真实的 Windows codex 是 `node_modules/.bin/codex.exe`），所以依赖这个 fixture 的
 * OAuth 用例只在 POSIX 上跑 —— 不假装覆盖 Windows 的进程启动语义。
 */
function skipPosixOnlyCodexFakeOnWindows(): boolean {
  return process.platform === "win32";
}

test("OAuth login uses an isolated CODEX_HOME and reports success only after SQLite save", async (t) => {
  if (skipPosixOnlyCodexFakeOnWindows()) return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-oauth-"));
  t.after(async () => removeTempDirectory(root));
  const executable = path.join(root, "fake-codex");
  const loginAuth = authJson({ accountId: "chatgpt-oauth", refreshToken: "oauth", stamp: "2026-10-05T01:00:00.000Z" });
  await writeFakeCodexLogin(executable, loginAuth);
  const service = new OpenAIAccountService(root, executable);
  await service.initialize();
  const account = await service.createAccount("OAuth");
  const login = await service.startLogin(account.id);
  assert.ok(login);
  assert.match(login.authUrl, /^https:\/\/auth\.openai\.com/u);
  assert.deepEqual(await login.result, { success: true, message: "登录成功" });
  assert.equal(await service.getAuthJsonContent(account.id), loginAuth);
  assert.equal((await service.listAccounts())[0]?.isLoggedIn, true);
  assert.equal((await fs.readdir(path.join(root, "codex-accounts", account.id))).some((entry) => entry.startsWith("oauth-login-")), false);
  await service.dispose();
});

test("a failed account deletion rolls back conflict cleanup in the same transaction", async (t) => {
  const { root, service } = await makeService(t);
  const account = await service.createAccount("Conflict rollback");
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  t.after(() => db.close());
  db.prepare(`INSERT INTO openai_account_sync_conflicts
    (conflict_key,account_id,main_auth_json,account_auth_json,message,updated_at)
    VALUES(?,?,?,?,?,?)`).run("rollback", account.id, "main copy", "stored copy", "conflict", "2026-10-05T00:00:00.000Z");
  db.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON openai_accounts
    BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END;`);
  await assert.rejects(service.deleteAccount(account.id), /forced delete failure/u);
  assert.equal((await service.listAccounts()).length, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM openai_account_sync_conflicts").get() as { count: number }).count, 1);
});

test("quota snapshots survive restart and listing cached data makes no network requests", async (t) => {
  const { root, service, quotaRead } = await makeQuotaService(t);
  const account = await service.createAccount("Quota cache");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-quota", refreshToken: "quota", stamp: "2026-10-05T01:00:00.000Z" }));
  const quota = await service.queryQuota(account.id);
  assert.equal(quota.planType, "plus");
  assert.equal(quota.rateLimit.primaryWindow?.usedPercent, 24);
  assert.equal(quota.rateLimit.secondaryWindow?.usedPercent, 41);
  assert.equal(quota.resetCreditsAvailable, 2);
  assert.deepEqual((await service.listAccounts())[0]?.quota, quota);
  assert.deepEqual((await service.getAccountDetails(account.id)).quota, quota);

  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  const row = db.prepare("SELECT quota_json, fetched_at, chatgpt_account_id FROM openai_account_quotas WHERE account_id = ?").get(account.id) as { quota_json: string; fetched_at: number; chatgpt_account_id: string };
  assert.deepEqual(JSON.parse(row.quota_json), quota);
  assert.equal(row.fetched_at, quota.fetchedAt);
  assert.equal(row.chatgpt_account_id, "chatgpt-quota");
  db.close();
  await service.dispose();

  const restarted = new OpenAIAccountService(root);
  try {
    await restarted.initialize();
    assert.deepEqual((await restarted.listAccounts())[0]?.quota, quota);
    assert.equal(quotaRead.mock.callCount(), 1);
  } finally {
    await restarted.dispose();
  }
});

test("explicit quota refresh updates the snapshot, timestamp, and account-change event", async (t) => {
  let changeEvents = 0;
  const { service, quotaRead } = await makeQuotaService(t, () => { changeEvents += 1; });
  const account = await service.createAccount("Refresh");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-refresh", refreshToken: "quota", stamp: "2026-10-05T01:00:00.000Z" }));
  let usedPercent = 24;
  quotaRead.mock.mockImplementation(async () => quotaResponse(usedPercent));
  changeEvents = 0;
  const first = await service.queryQuota(account.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  usedPercent = 39;
  const second = await service.queryQuota(account.id);
  assert.equal(second.rateLimit.primaryWindow?.usedPercent, 39);
  assert.ok(second.fetchedAt > first.fetchedAt);
  assert.deepEqual((await service.listAccounts())[0]?.quota, second);
  assert.equal(changeEvents, 2);
});

test("failed quota refresh preserves the last successful snapshot and timestamp", async (t) => {
  const { service, quotaRead } = await makeQuotaService(t);
  const account = await service.createAccount("Offline cache");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-offline", refreshToken: "quota", stamp: "2026-10-05T01:00:00.000Z" }));
  const cached = await service.queryQuota(account.id);
  quotaRead.mock.mockImplementation(async () => { throw new Error("status 503 temporarily unavailable"); });
  await assert.rejects(service.queryQuota(account.id), /status 503/u);
  assert.deepEqual((await service.listAccounts())[0]?.quota, cached);
  quotaRead.mock.mockImplementation(async () => { throw new Error("offline"); });
  await assert.rejects(service.queryQuota(account.id), /offline/u);
  assert.deepEqual((await service.getAccountDetails(account.id)).quota, cached);
});

test("quota storage failures are reported and roll back the snapshot update", async (t) => {
  const { root, service, quotaRead } = await makeQuotaService(t);
  const account = await service.createAccount("Write failure");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-write", refreshToken: "quota", stamp: "2026-10-05T01:00:00.000Z" }));
  const cached = await service.queryQuota(account.id);
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER reject_quota_update BEFORE UPDATE ON openai_account_quotas
    BEGIN SELECT RAISE(ABORT, 'quota_cache_unavailable'); END;`);
  quotaRead.mock.mockImplementation(async () => quotaResponse(90));
  await assert.rejects(service.queryQuota(account.id), /额度已获取，但保存缓存失败：.*quota_cache_unavailable/u);
  assert.deepEqual((await service.listAccounts())[0]?.quota, cached);
});

test("an in-flight quota response cannot be saved under replaced account credentials", async (t) => {
  const { root, service, quotaRead } = await makeQuotaService(t);
  const account = await service.createAccount("Identity race");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-before", refreshToken: "old", stamp: "2026-10-05T01:00:00.000Z" }));
  let release!: (response: ReturnType<typeof quotaResponse>) => void;
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  quotaRead.mock.mockImplementation(() => {
    started();
    return new Promise<ReturnType<typeof quotaResponse>>((resolve) => { release = resolve; });
  });
  const result = service.queryQuota(account.id);
  await requested;
  // Simulate a separate SQLite writer replacing this identity during the RPC.
  const store = await OpenAIAccountStore.open(path.join(root, "eco-coding.sqlite"));
  t.after(() => store.close());
  store.saveAuthJson(account.id, authJson({ accountId: "chatgpt-after", refreshToken: "new", stamp: "2026-10-05T02:00:00.000Z" }));
  const rejected = assert.rejects(result, /账号凭据已变更/u);
  release(quotaResponse());
  await rejected;
  assert.equal((await service.listAccounts())[0]?.quota, undefined);
});

// Advance quota time without waking the independent five-second credential poll.
function quotaClock(t: test.TestContext) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const intervals: { callback: () => void; timer: ReturnType<typeof setInterval> }[] = [];
  const original = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback: () => void, delay: number) => {
    const timer = original(callback, delay);
    if (delay === 5 * 60_000) intervals.push({ callback, timer });
    return timer;
  });
  const cleared = t.mock.method(globalThis, "clearInterval");
  return { intervals, cleared, advance: (ms: number) => { now += ms; } };
}

async function activeQuotaFixture(t: test.TestContext) {
  const fixture = await makeQuotaService(t);
  const account = await fixture.service.createAccount("Usage policy");
  await fixture.service.setAuthJson(account.id, authJson({ accountId: "chatgpt-policy", refreshToken: "quota", stamp: "2026-10-05T01:00:00.000Z" }));
  return { ...fixture, account };
}

test("manual and automatic requests for the same account share the in-flight query", async (t) => {
  quotaClock(t);
  const { service, quotaRead, account } = await activeQuotaFixture(t);
  let release!: (response: ReturnType<typeof quotaResponse>) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  quotaRead.mock.mockImplementation(() => {
    entered();
    return new Promise((resolve) => { release = resolve; });
  });
  const first = service.queryQuota(account.id, "usage");
  await started;
  assert.equal(service.queryQuota(account.id), first);
  assert.equal(service.queryQuota(account.id, "switch"), first);
  release(quotaResponse());
  await first;
  assert.equal(quotaRead.mock.callCount(), 1);
});

test("quota reset saves and publishes exactly one fresh read, and reports a post-reset read failure", async (t) => {
  const { service, quotaRead, account } = await activeQuotaFixture(t);
  const cached = await service.queryQuota(account.id);
  let consumed = 0;
  quotaRead.mock.mockImplementation(async () => quotaResponse(0));
  const result = await service.resetQuota(account.id, async () => { consumed++; return { outcome: "reset" }; });
  assert.deepEqual(result, { outcome: "reset" });
  assert.equal(consumed, 1);
  assert.equal(quotaRead.mock.callCount(), 2);
  assert.equal((await service.listAccounts())[0]!.quota?.rateLimit.primaryWindow?.usedPercent, 0);
  quotaRead.mock.mockImplementation(async () => { throw new Error("post reset offline"); });
  await assert.rejects(service.resetQuota(account.id, async () => { consumed++; return {}; }), /post reset offline/);
  assert.equal(consumed, 2);
  assert.equal((await service.listAccounts())[0]!.quotaRefresh?.error, "post reset offline");
  assert.ok((await service.listAccounts())[0]!.quota!.fetchedAt >= cached.fetchedAt);
});
