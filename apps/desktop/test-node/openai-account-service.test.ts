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

test("image switches and per-account quota survive restart, invalidate on account change, and preserve active Codex auth", async (t) => {
  const { root, service } = await makeService(t);
  const a = await service.createAccount("A");
  const b = await service.createAccount("B");
  const rawA = authJson({ accountId: "chatgpt-A", refreshToken: "A", stamp: "2026-10-14" });
  const rawB = authJson({ accountId: "chatgpt-B", refreshToken: "B", stamp: "2026-10-14" });
  await service.setAuthJson(a.id, rawA);
  await service.setAuthJson(b.id, rawB);
  await service.setActiveAccount(a.id);
  await service.applyPendingTransition();
  const activeFile = path.join(root, "codex/auth.json");
  const before = await fs.readFile(activeFile, "utf8");
  await service.setImageGenerationEnabled(b.id, true);
  service.saveImageQuota(b.id, rawB, { source: "chatgpt_image_gen", status: "available", fetchedAt: Date.now(), remaining: 120 });
  assert.equal(await fs.readFile(activeFile, "utf8"), before);
  assert.equal(await service.getActiveAccountId(), a.id);
  assert.equal((await service.listAccounts()).find((x) => x.id === b.id)?.imageGenerationEnabled, true);
  assert.equal((await service.listAccounts()).find((x) => x.id === a.id)?.imageQuota, undefined);
  const store = await OpenAIAccountStore.open(path.join(root, "eco-coding.sqlite"));
  try {
    assert.equal(store.get(b.id)?.imageQuota?.remaining, 120);
    assert.equal(store.get(b.id)?.imageGenerationEnabled, true);
    const changed = authJson({ accountId: "chatgpt-replaced", refreshToken: "C", stamp: "2026-10-14" });
    store.saveAuthJson(b.id, changed);
    assert.equal(store.get(b.id)?.imageQuota, undefined);
    assert.throws(() => store.saveImageQuota(b.id, rawB, { source: "chatgpt_image_gen", status: "available", fetchedAt: Date.now(), remaining: 120 }), /凭据已变更/);
  } finally { store.close(); }
});

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

function quotaResponse(usedPercent = 24): Response {
  return Response.json({
    plan_type: "plus",
    email: "quota@example.test",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: usedPercent, limit_window_seconds: 18_000, reset_after_seconds: 3_600, reset_at: Math.floor(Date.now() / 1_000) + 3_600 },
      secondary_window: { used_percent: 41, limit_window_seconds: 604_800, reset_after_seconds: 86_400, reset_at: Math.floor(Date.now() / 1_000) + 86_400 },
    },
    rate_limit_reset_credits: { available_count: 2 },
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`condition did not become true within ${timeoutMs}ms`);
}

function pauseNextPublication(service: OpenAIAccountService) {
  const internal = service as unknown as { publishMainAuth(content: string | null): Promise<void> };
  const originalPublish = internal.publishMainAuth.bind(service);
  let notifyPublished!: () => void;
  let release!: () => void;
  const published = new Promise<void>((resolve) => { notifyPublished = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let pause = true;
  internal.publishMainAuth = async (content) => {
    await originalPublish(content);
    if (pause) {
      pause = false;
      notifyPublished();
      await released;
    }
  };
  return { published, release };
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
  assert.equal(await service.getActiveAccountId(), id);
  assert.deepEqual(await service.getAccountDetails(id), {
    id,
    name: "Legacy",
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

test("Codex refresh writes back after replacement and survives a half-written auth.json", async (t) => {
  const { root, service } = await makeService(t);
  const account = await service.createAccount("Watcher");
  const first = authJson({ accountId: "chatgpt-watch", refreshToken: "first", stamp: "2026-10-01T01:00:00.000Z" });
  await service.setAuthJson(account.id, first);
  await service.setActiveAccount(account.id);
  await service.applyPendingTransition();
  const mainPath = path.join(root, "codex", "auth.json");

  const replacement = authJson({ accountId: "chatgpt-watch", refreshToken: "replaced", stamp: "2026-10-01T02:00:00.000Z" });
  const replacementTemp = path.join(root, "codex", "replacement.tmp");
  await fs.writeFile(replacementTemp, replacement, "utf8");
  await fs.rename(replacementTemp, mainPath);
  await waitFor(async () => (await service.getAuthJsonContent(account.id)) === replacement);

  const afterHalfWrite = authJson({ accountId: "chatgpt-watch", refreshToken: "after-half", stamp: "2026-10-01T03:00:00.000Z" });
  await fs.writeFile(mainPath, "{\"tokens\":", "utf8");
  setTimeout(() => { void fs.writeFile(mainPath, afterHalfWrite, "utf8"); }, 320);
  await waitFor(async () => (await service.getAuthJsonContent(account.id)) === afterHalfWrite, 2_500);
  await fs.writeFile(mainPath, "{", "utf8");
  await waitFor(async () => service.getSyncStatus().state === "error", 2_500);
  assert.equal(await service.getAuthJsonContent(account.id), afterHalfWrite);
  const recovered = authJson({ accountId: "chatgpt-watch", refreshToken: "recovered", stamp: "2026-10-01T04:00:00.000Z" });
  await fs.writeFile(mainPath, recovered, "utf8");
  await waitFor(async () => (await service.getAuthJsonContent(account.id)) === recovered, 2_500);
  assert.equal(service.getSyncStatus().state, "ok");
});

test("file watcher failure is visible and clears after the watcher is restored", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-watcher-error-"));
  t.after(async () => removeTempDirectory(root));
  const originalWatch = fsSync.watch;
  const mutableFs = fsSync as unknown as { watch: typeof fsSync.watch };
  mutableFs.watch = (() => { throw new Error("forced watcher failure"); }) as typeof fsSync.watch;
  const service = new OpenAIAccountService(root);
  try {
    await service.initialize();
    assert.equal(service.getSyncStatus().state, "error");
    assert.match(service.getSyncStatus().message ?? "", /文件监听失败/u);
  } finally {
    mutableFs.watch = originalWatch;
  }
  (service as unknown as { startAuthWatcher(): void }).startAuthWatcher();
  await service.flushFinalAuthWriteback();
  assert.equal(service.getSyncStatus().state, "ok");
  await service.dispose();
});

test("SQLite write errors are shown and a later successful write clears the error", async (t) => {
  const { root, service } = await makeService(t);
  const account = await service.createAccount("SQLite write error");
  const initial = authJson({ accountId: "chatgpt-db-error", refreshToken: "initial", stamp: "2026-10-02T10:00:00.000Z" });
  await service.setAuthJson(account.id, initial);
  await service.setActiveAccount(account.id);
  await service.applyPendingTransition();
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  db.exec(`CREATE TRIGGER reject_auth_write BEFORE UPDATE OF auth_json ON openai_accounts
    BEGIN SELECT RAISE(ABORT, 'forced auth database failure'); END;`);
  const mainPath = path.join(root, "codex", "auth.json");
  const refreshed = authJson({ accountId: "chatgpt-db-error", refreshToken: "newer", stamp: "2026-10-02T11:00:00.000Z" });
  await fs.writeFile(mainPath, refreshed, "utf8");
  await waitFor(async () => service.getSyncStatus().state === "error", 2_500);
  assert.equal(await service.getAuthJsonContent(account.id), initial);
  db.exec("DROP TRIGGER reject_auth_write");
  await fs.writeFile(mainPath, refreshed, "utf8");
  await waitFor(async () => (await service.getAuthJsonContent(account.id)) === refreshed, 2_500);
  assert.equal(service.getSyncStatus().state, "ok");
  db.close();
});

test("five-second polling catches an auth replacement after file watching is unavailable", async (t) => {
  const { root, service } = await makeService(t);
  const account = await service.createAccount("Polling");
  const first = authJson({ accountId: "chatgpt-poll", refreshToken: "first", stamp: "2026-10-02T01:00:00.000Z" });
  await service.setAuthJson(account.id, first);
  await service.setActiveAccount(account.id);
  await service.applyPendingTransition();
  const internal = service as unknown as { authWatcher: { close(): void } | null; authWatcherHealthy: boolean };
  internal.authWatcher?.close();
  internal.authWatcher = null;
  internal.authWatcherHealthy = false;

  const polled = authJson({ accountId: "chatgpt-poll", refreshToken: "poll-caught", stamp: "2026-10-02T02:00:00.000Z" });
  await fs.writeFile(path.join(root, "codex", "auth.json"), polled, "utf8");
  await waitFor(async () => (await service.getAuthJsonContent(account.id)) === polled, 7_000);
});

test("account identity mismatch preserves both credential copies and reports a conflict", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-conflict-"));
  t.after(async () => removeTempDirectory(root));
  const id = "oa_conflict";
  const databaseAuth = authJson({ accountId: "chatgpt-db", refreshToken: "db-copy", stamp: "2026-10-03T01:00:00.000Z" });
  const mainAuth = authJson({ accountId: "chatgpt-other", refreshToken: "main-copy", stamp: "2026-10-03T02:00:00.000Z" });
  const accountDir = path.join(root, "codex-accounts", id);
  await fs.mkdir(accountDir, { recursive: true });
  await fs.writeFile(path.join(root, "codex-accounts", "accounts.json"), JSON.stringify([{ id, name: "Conflict", createdAt: "2026-01-01T00:00:00.000Z" }]), "utf8");
  await fs.writeFile(path.join(root, "codex-accounts", "active_account.txt"), id, "utf8");
  await fs.writeFile(path.join(accountDir, "auth.json"), databaseAuth, "utf8");
  await fs.mkdir(path.join(root, "codex"), { recursive: true });
  await fs.writeFile(path.join(root, "codex", "auth.json"), mainAuth, "utf8");
  let service = new OpenAIAccountService(root);
  t.after(async () => {
    await service.dispose();
    await removeTempDirectory(root);
  });
  await service.initialize();
  assert.equal(service.getSyncStatus().state, "conflict");
  assert.equal(await service.getAuthJsonContent(id), databaseAuth);
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), mainAuth);
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  const conflict = db.prepare("SELECT main_auth_json, account_auth_json FROM openai_account_sync_conflicts LIMIT 1").get() as { main_auth_json: string; account_auth_json: string };
  assert.equal(conflict.main_auth_json, mainAuth);
  assert.equal(conflict.account_auth_json, databaseAuth);
  db.close();

  const nextAccount = await service.createAccount("Next account");
  const nextAuth = authJson({ accountId: "chatgpt-next", refreshToken: "next", stamp: "2026-10-03T03:00:00.000Z" });
  await service.setAuthJson(nextAccount.id, nextAuth);
  await service.setActiveAccount(nextAccount.id);
  await service.applyPendingTransition();
  assert.equal(await service.getActiveAccountId(), nextAccount.id);
  assert.equal(service.getSyncStatus().state, "conflict");
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), nextAuth);

  await service.dispose();
  service = new OpenAIAccountService(root);
  await service.initialize();
  assert.equal(service.getSyncStatus().state, "conflict");
});

test("switch requests coalesce, leave the old runtime credential until idle, then publish atomically", async (t) => {
  const { root, service } = await makeService(t);
  const first = await service.createAccount("Current");
  const second = await service.createAccount("Intermediate");
  const final = await service.createAccount("Last request wins");
  const firstAuth = authJson({ accountId: "chatgpt-current", refreshToken: "current", stamp: "2026-10-04T01:00:00.000Z" });
  const secondAuth = authJson({ accountId: "chatgpt-second", refreshToken: "second", stamp: "2026-10-04T01:00:00.000Z" });
  const finalAuth = authJson({ accountId: "chatgpt-final", refreshToken: "final", stamp: "2026-10-04T01:00:00.000Z" });
  await service.setAuthJson(first.id, firstAuth);
  await service.setAuthJson(second.id, secondAuth);
  await service.setAuthJson(final.id, finalAuth);
  await service.setActiveAccount(first.id);
  await service.applyPendingTransition();

  await service.setActiveAccount(second.id);
  await service.setActiveAccount(final.id);
  assert.equal(await service.getActiveAccountId(), first.id);
  assert.equal(service.getPendingAccountId(), final.id);
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), firstAuth);
  await service.applyPendingTransition();
  assert.equal(await service.getActiveAccountId(), final.id);
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), finalAuth);

  const replacement = authJson({ accountId: "chatgpt-final", refreshToken: "manual-replacement", stamp: "2026-10-04T02:00:00.000Z" });
  const result = await service.setAuthJson(final.id, replacement);
  assert.equal(result.success, true);
  assert.equal(await service.getAuthJsonContent(final.id), finalAuth);
  await service.applyPendingTransition();
  assert.equal(await service.getAuthJsonContent(final.id), replacement);
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), replacement);
});

test("staged active credentials preserve the latest switch and survive cancelling that switch", async (t) => {
  const { root, service } = await makeService(t);
  const current = await service.createAccount("Current");
  const target = await service.createAccount("Target");
  const oldAuth = authJson({ accountId: "chatgpt-current", refreshToken: "old", stamp: "2026-10-04T05:00:00.000Z" });
  const newAuth = authJson({ accountId: "chatgpt-current", refreshToken: "new", stamp: "2026-10-04T06:00:00.000Z" });
  const targetAuth = authJson({ accountId: "chatgpt-target", refreshToken: "target", stamp: "2026-10-04T05:00:00.000Z" });
  await service.setAuthJson(current.id, oldAuth);
  await service.setAuthJson(target.id, targetAuth);
  await service.setActiveAccount(current.id);
  await service.applyPendingTransition();

  await service.setActiveAccount(target.id);
  assert.equal((await service.setAuthJson(current.id, newAuth)).success, true);
  assert.equal(service.getPendingAccountId(), target.id);
  assert.equal(await service.getAuthJsonContent(current.id), oldAuth);

  await service.cancelPendingAccountSwitch();
  assert.equal(service.getPendingAccountId(), current.id);
  await service.applyPendingTransition();
  assert.equal(await service.getActiveAccountId(), current.id);
  assert.equal(await service.getAuthJsonContent(current.id), newAuth);
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), newAuth);
});

test("deleting a queued switch target clears the stale transition", async (t) => {
  const { root, service } = await makeService(t);
  const current = await service.createAccount("Current");
  const target = await service.createAccount("Pending target");
  const currentAuth = authJson({ accountId: "chatgpt-current", refreshToken: "current", stamp: "2026-10-04T07:00:00.000Z" });
  const targetAuth = authJson({ accountId: "chatgpt-target", refreshToken: "target", stamp: "2026-10-04T07:00:00.000Z" });
  await service.setAuthJson(current.id, currentAuth);
  await service.setAuthJson(target.id, targetAuth);
  await service.setActiveAccount(current.id);
  await service.applyPendingTransition();
  await service.setActiveAccount(target.id);

  await service.deleteAccount(target.id);
  assert.equal(service.getPendingAccountId(), undefined);
  assert.equal((await service.listAccounts()).some((account) => account.id === target.id), false);
  await service.applyPendingTransition();
  assert.equal(await service.getActiveAccountId(), current.id);
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), currentAuth);
});

test("shutdown flushes the last auth refresh into SQLite before closing the store", async (t) => {
  const { root, service } = await makeService(t);
  const account = await service.createAccount("Shutdown");
  const initial = authJson({ accountId: "chatgpt-shutdown", refreshToken: "before", stamp: "2026-10-04T03:00:00.000Z" });
  await service.setAuthJson(account.id, initial);
  await service.setActiveAccount(account.id);
  await service.applyPendingTransition();
  const lastRefresh = authJson({ accountId: "chatgpt-shutdown", refreshToken: "last-write", stamp: "2026-10-04T04:00:00.000Z" });
  await fs.writeFile(path.join(root, "codex", "auth.json"), lastRefresh, "utf8");
  await service.dispose();
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  const row = db.prepare("SELECT auth_json FROM openai_accounts WHERE id = ?").get(account.id) as { auth_json: string };
  assert.equal(row.auth_json, lastRefresh);
  db.close();
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

test("active OAuth relogin stages credentials until the idle switch publishes them", async (t) => {
  if (skipPosixOnlyCodexFakeOnWindows()) return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-active-oauth-"));
  t.after(async () => removeTempDirectory(root));
  const executable = path.join(root, "fake-codex");
  const newAuth = authJson({ accountId: "chatgpt-active-oauth", refreshToken: "relogged", stamp: "2026-10-05T02:00:00.000Z" });
  await writeFakeCodexLogin(executable, newAuth);
  const service = new OpenAIAccountService(root, executable);
  await service.initialize();
  const account = await service.createAccount("Active OAuth");
  const oldAuth = authJson({ accountId: "chatgpt-active-oauth", refreshToken: "old", stamp: "2026-10-05T01:00:00.000Z" });
  await service.setAuthJson(account.id, oldAuth);
  await service.setActiveAccount(account.id);
  await service.applyPendingTransition();
  const login = await service.startLogin(account.id);
  assert.ok(login);
  assert.deepEqual(await login.result, { success: true, message: "登录成功" });
  assert.equal(service.getPendingAccountId(), account.id);
  assert.equal(await service.getAuthJsonContent(account.id), oldAuth);
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), oldAuth);
  await service.applyPendingTransition();
  assert.equal(await service.getAuthJsonContent(account.id), newAuth);
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), newAuth);
  await service.dispose();
});

for (const transition of ["switch", "first activation", "credential replacement"] as const) {
  test(`cancelling ${transition} during publication restores the previous runtime credential`, async (t) => {
    const { root, service } = await makeService(t);
    const current = await service.createAccount("Current");
    const target = await service.createAccount("Target");
    const oldAuth = authJson({ accountId: "chatgpt-current", refreshToken: "old", stamp: "2026-10-05T01:00:00.000Z" });
    const targetAuth = authJson({ accountId: "chatgpt-target", refreshToken: "target", stamp: "2026-10-05T01:00:00.000Z" });
    await service.setAuthJson(current.id, oldAuth);
    await service.setAuthJson(target.id, targetAuth);
    if (transition !== "first activation") {
      await service.setActiveAccount(current.id);
      await service.applyPendingTransition();
    }
    if (transition === "credential replacement") {
      await service.setAuthJson(current.id, authJson({ accountId: "chatgpt-current", refreshToken: "new", stamp: "2026-10-05T02:00:00.000Z" }));
    } else {
      await service.setActiveAccount(target.id);
    }
    const barrier = pauseNextPublication(service);
    const applying = service.applyPendingTransition();
    try {
      await barrier.published;
      // Give the watcher a chance to enqueue a reconcile while DB still says Current.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await service.cancelPendingAccountSwitch();
    } finally {
      barrier.release();
    }
    await applying;
    await service.flushFinalAuthWriteback();
    assert.equal(await service.getActiveAccountId(), transition === "first activation" ? null : current.id);
    assert.equal(await service.getAuthJsonContent(current.id), oldAuth);
    const mainAuth = await fs.readFile(path.join(root, "codex", "auth.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    assert.equal(mainAuth, transition === "first activation" ? null : oldAuth);
    assert.equal(service.getPendingAccountId(), undefined);
    assert.equal(service.getSyncStatus().state, "ok");
  });
}

test("failed switch commit restores auth.json and rolls back off-target staged credentials", async (t) => {
  const { root, service } = await makeService(t);
  const current = await service.createAccount("Current");
  const target = await service.createAccount("Target");
  const oldAuth = authJson({ accountId: "chatgpt-current", refreshToken: "old", stamp: "2026-10-05T01:00:00.000Z" });
  const newAuth = authJson({ accountId: "chatgpt-current", refreshToken: "new", stamp: "2026-10-05T02:00:00.000Z" });
  const targetAuth = authJson({ accountId: "chatgpt-target", refreshToken: "target", stamp: "2026-10-05T01:00:00.000Z" });
  await service.setAuthJson(current.id, oldAuth);
  await service.setAuthJson(target.id, targetAuth);
  await service.setActiveAccount(current.id);
  await service.applyPendingTransition();
  await service.setActiveAccount(target.id);
  await service.setAuthJson(current.id, newAuth);
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER reject_switch BEFORE UPDATE OF value ON openai_account_settings
    WHEN NEW.key = 'active_account_id'
    BEGIN SELECT RAISE(ABORT, 'forced switch commit failure'); END;`);
  await assert.rejects(service.applyPendingTransition(), /forced switch commit failure/u);
  assert.equal(await service.getActiveAccountId(), current.id);
  assert.equal(await service.getAuthJsonContent(current.id), oldAuth);
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), oldAuth);
  assert.equal(service.getPendingAccountId(), target.id);
  assert.equal(service.getSyncStatus().state, "error");
  db.exec("DROP TRIGGER reject_switch");
  await service.applyPendingTransition();
  assert.equal(await service.getActiveAccountId(), target.id);
  assert.equal(await service.getAuthJsonContent(current.id), newAuth);
  assert.equal(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8"), targetAuth);
});

for (const active of [false, true]) {
  test(`OAuth ${active ? "staging" : "saving"} failure retains fresh auth.json and reports the SQLite cause`, async (t) => {
    if (skipPosixOnlyCodexFakeOnWindows()) return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-openai-oauth-failure-"));
    const executable = path.join(root, "fake-codex");
    const newAuth = authJson({ accountId: "chatgpt-oauth-failure", refreshToken: "fresh", stamp: "2026-10-05T02:00:00.000Z" });
    await writeFakeCodexLogin(executable, newAuth);
    const loginService = new OpenAIAccountService(root, executable);
    await loginService.initialize();
    t.after(async () => {
      await loginService.dispose();
      await removeTempDirectory(root);
    });
    const account = await loginService.createAccount("Failed login");
    const oldAuth = authJson({ accountId: "chatgpt-oauth-failure", refreshToken: "old", stamp: "2026-10-05T01:00:00.000Z" });
    await loginService.setAuthJson(account.id, oldAuth);
    if (active) {
      await loginService.setActiveAccount(account.id);
      await loginService.applyPendingTransition();
    }
    const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
    t.after(() => db.close());
    db.exec(active
      ? `CREATE TRIGGER reject_login BEFORE INSERT ON openai_account_settings
          WHEN NEW.key = 'pending_auth_json'
          BEGIN SELECT RAISE(ABORT, 'forced login database failure'); END;`
      : `CREATE TRIGGER reject_login BEFORE UPDATE OF auth_json ON openai_accounts
          BEGIN SELECT RAISE(ABORT, 'forced login database failure'); END;`);
    const login = await loginService.startLogin(account.id);
    assert.ok(login);
    const result = await login.result;
    assert.equal(result.success, false);
    assert.match(result.message, /forced login database failure/u);
    assert.equal(loginService.getSyncStatus().state, "error");
    assert.equal(await loginService.getAuthJsonContent(account.id), oldAuth);
    assert.equal(loginService.getPendingAccountId(), undefined);
    const accountDir = path.join(root, "codex-accounts", account.id);
    const retainedDirs = (await fs.readdir(accountDir)).filter((entry) => entry.startsWith("oauth-login-"));
    assert.equal(retainedDirs.length, 1);
    const retainedPath = path.join(accountDir, retainedDirs[0]!, "auth.json");
    assert.equal(await fs.readFile(retainedPath, "utf8"), newAuth);
    assert.ok(result.message.includes(retainedPath));
    db.exec("DROP TRIGGER reject_login");
    await loginService.setAuthJson(account.id, await fs.readFile(retainedPath, "utf8"));
    if (active) await loginService.applyPendingTransition();
    assert.equal(await loginService.getAuthJsonContent(account.id), newAuth);
  });
}

for (const deferred of [false, true]) {
  test(`${deferred ? "deferred" : "immediate"} account deletion clears its persisted credential conflicts`, async (t) => {
    const { root, service } = await makeService(t);
    const account = await service.createAccount("Conflict");
    const stored = authJson({ accountId: "chatgpt-owned", refreshToken: "owned", stamp: "2026-10-05T01:00:00.000Z" });
    const unrelated = authJson({ accountId: "chatgpt-unrelated", refreshToken: "unrelated", stamp: "2026-10-05T02:00:00.000Z" });
    await service.setAuthJson(account.id, stored);
    await service.setActiveAccount(account.id);
    await service.applyPendingTransition();
    await fs.writeFile(path.join(root, "codex", "auth.json"), unrelated, "utf8");
    await service.flushFinalAuthWriteback();
    assert.equal(service.getSyncStatus().state, "conflict");
    if (!deferred) {
      await service.setActiveAccount(null);
      await service.applyPendingTransition();
    }
    await service.deleteAccount(account.id);
    if (deferred) await service.applyPendingTransition();
    assert.equal((await service.listAccounts()).length, 0);
    assert.equal(service.getSyncStatus().state, "ok");
    const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
    t.after(() => db.close());
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM openai_account_sync_conflicts").get() as { count: number }).count, 0);
  });
}

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
  const { root, service } = await makeService(t);
  const account = await service.createAccount("Quota cache");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-quota", refreshToken: "quota", stamp: "2026-10-05T01:00:00.000Z" }));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => quotaResponse());
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
    assert.equal(fetchMock.mock.callCount(), 1);
  } finally {
    await restarted.dispose();
  }
});

test("explicit quota refresh updates the snapshot, timestamp, and account-change event", async (t) => {
  let changeEvents = 0;
  const { service } = await makeService(t, undefined, () => { changeEvents += 1; });
  const account = await service.createAccount("Refresh");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-refresh", refreshToken: "quota", stamp: "2026-10-05T01:00:00.000Z" }));
  let usedPercent = 24;
  t.mock.method(globalThis, "fetch", async () => quotaResponse(usedPercent));
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
  const { service } = await makeService(t);
  const account = await service.createAccount("Offline cache");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-offline", refreshToken: "quota", stamp: "2026-10-05T01:00:00.000Z" }));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => quotaResponse());
  const cached = await service.queryQuota(account.id);
  fetchMock.mock.mockImplementation(async () => new Response("temporarily unavailable", { status: 503 }));
  await assert.rejects(service.queryQuota(account.id), /status 503/u);
  assert.deepEqual((await service.listAccounts())[0]?.quota, cached);
  fetchMock.mock.mockImplementation(async () => { throw new Error("offline"); });
  await assert.rejects(service.queryQuota(account.id), /quota request failed/u);
  assert.deepEqual((await service.getAccountDetails(account.id)).quota, cached);
});

test("quota storage failures are reported and roll back the snapshot update", async (t) => {
  const { root, service } = await makeService(t);
  const account = await service.createAccount("Write failure");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-write", refreshToken: "quota", stamp: "2026-10-05T01:00:00.000Z" }));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => quotaResponse());
  const cached = await service.queryQuota(account.id);
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER reject_quota_update BEFORE UPDATE ON openai_account_quotas
    BEGIN SELECT RAISE(ABORT, 'quota_cache_unavailable'); END;`);
  fetchMock.mock.mockImplementation(async () => quotaResponse(90));
  await assert.rejects(service.queryQuota(account.id), /额度已获取，但保存缓存失败：.*quota_cache_unavailable/u);
  assert.deepEqual((await service.listAccounts())[0]?.quota, cached);
});

test("token refresh keeps the quota cache but changing the remote account hides it", async (t) => {
  const { service } = await makeService(t);
  const account = await service.createAccount("Identity");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-original", refreshToken: "old", stamp: "2026-10-05T01:00:00.000Z" }));
  t.mock.method(globalThis, "fetch", async () => quotaResponse());
  const cached = await service.queryQuota(account.id);
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-original", refreshToken: "new", stamp: "2026-10-05T02:00:00.000Z" }));
  assert.deepEqual((await service.listAccounts())[0]?.quota, cached);
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-different", refreshToken: "other", stamp: "2026-10-05T03:00:00.000Z" }));
  assert.equal((await service.listAccounts())[0]?.quota, undefined);
  assert.equal((await service.getAccountDetails(account.id)).quota, undefined);
});

test("an in-flight quota response cannot be saved under replaced account credentials", async (t) => {
  const { service } = await makeService(t);
  const account = await service.createAccount("Identity race");
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-before", refreshToken: "old", stamp: "2026-10-05T01:00:00.000Z" }));
  let release!: (response: Response) => void;
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", () => {
    started();
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const result = service.queryQuota(account.id);
  await requested;
  await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-after", refreshToken: "new", stamp: "2026-10-05T02:00:00.000Z" }));
  const rejected = assert.rejects(result, /账号凭据已变更/u);
  release(quotaResponse());
  await rejected;
  assert.equal((await service.listAccounts())[0]?.quota, undefined);
});

for (const deferred of [false, true]) {
  test(`${deferred ? "deferred" : "immediate"} account deletion removes its persisted quota`, async (t) => {
    const { root, service } = await makeService(t);
    const account = await service.createAccount("Delete quota");
    await service.setAuthJson(account.id, authJson({ accountId: "chatgpt-delete", refreshToken: "quota", stamp: "2026-10-05T01:00:00.000Z" }));
    t.mock.method(globalThis, "fetch", async () => quotaResponse());
    await service.queryQuota(account.id);
    if (deferred) {
      await service.setActiveAccount(account.id);
      await service.applyPendingTransition();
    }
    await service.deleteAccount(account.id);
    if (deferred) await service.applyPendingTransition();
    const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM openai_account_quotas").get() as { count: number }).count, 0);
    db.close();
  });
}
