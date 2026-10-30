import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpenAIAccountService } from "../src/main/openai-account-service";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const token = `e30.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString("base64url")}.signature`;
const auth = (identity: string) => JSON.stringify({ tokens: { access_token: token, refresh_token: "PRIVATE_REFRESH", account_id: identity },
  OPENAI_API_KEY: "PRIVATE_KEY", cookie: "PRIVATE_COOKIE" });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-global-account-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const events: unknown[] = [];
  const service = new OpenAIAccountService(root, undefined, (event) => events.push(event));
  await service.initialize();
  cleanups.push(() => service.dispose());
  const a = await service.createAccount("A");
  const b = await service.createAccount("B PRIVATE_REFRESH");
  const c = await service.createAccount("C");
  for (const account of [a, b, c]) await service.setAuthJson(account.id, auth(account.id));
  await service.setActiveAccount(a.id);
  await service.applyPendingTransition();
  service["authWatcher"]?.close(); service["authWatcher"] = null;
  if (service["authPoll"]) clearInterval(service["authPoll"]);
  const store = service["getStore"]();
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  cleanups.push(async () => db.close());
  const accountDump = () => JSON.stringify(["openai_accounts", "openai_account_quotas"].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  const main = path.join(root, "codex", "auth.json");
  const input = () => ({ accountId: b.id, expectedAccountId: a.id, revision: service.accountChoiceRevisionReadonly(b.id)! });
  service.ensureAccountCredentials = async () => { throw new Error("Unexpected renewal"); };
  service.getExternalChatGptTokens = async () => { throw new Error("Unexpected runtime token lookup"); };
  events.length = 0;
  return { root, service, store, events, a, b, c, main, input, accountDump };
}
function expectSafe(value: unknown) {
  for (const secret of [token, "PRIVATE_REFRESH", "PRIVATE_KEY", "PRIVATE_COOKIE", "PRIVATE_FAILURE"])
    expect(JSON.stringify(value)).not.toContain(secret);
}

test("global selection atomically publishes an existing login; all account credentials and quota records remain unchanged", async () => {
  const f = await setup();
  const before = f.accountDump();
  const result = await f.service.switchGlobalAccountFromAssistant(f.input(), new AbortController().signal);
  expect(result).toMatchObject({ status: "applied", selectedAccountId: f.b.id, syncState: "ok" });
  expect(await fs.readFile(f.main, "utf8")).toBe(auth(f.b.id));
  expect(f.accountDump()).toBe(before);
  expect(f.service.getPendingAccountId()).toBeUndefined();
  expectSafe([result, f.events, f.service.listAccountChoicesReadonly()]);
});

for (const phase of ["publish", "commit"] as const) test(`global ${phase} failure restores previous selection and file, removes its pending request, and redacts notifications`, async () => {
  const f = await setup();
  const before = f.accountDump();
  const mainBefore = await fs.readFile(f.main, "utf8");
  const originalPublish = f.service["publishMainAuth"].bind(f.service);
  const originalCommit = f.store.commitPendingTransition.bind(f.store);
  if (phase === "publish") f.service["publishMainAuth"] = async () => { throw new Error("PRIVATE_FAILURE PRIVATE_REFRESH"); };
  else f.store.commitPendingTransition = () => { throw new Error("PRIVATE_FAILURE PRIVATE_COOKIE"); };
  const result = await f.service.switchGlobalAccountFromAssistant(f.input(), new AbortController().signal);
  f.service["publishMainAuth"] = originalPublish;
  f.store.commitPendingTransition = originalCommit;
  expect(result).toMatchObject({ status: "failed", code: "publication_failed", selectedAccountId: f.a.id, syncState: "error" });
  expect(await fs.readFile(f.main, "utf8")).toBe(mainBefore);
  expect(f.accountDump()).toBe(before);
  expect(f.service.getPendingAccountId()).toBeUndefined();
  // A later coordinator pass cannot silently retry the rejected request.
  await f.service.applyPendingTransition();
  expect(await f.service.getActiveAccountId()).toBe(f.a.id);
  expectSafe([result, f.events, f.service.getSyncStatus()]);
});

test("selection, credential revisions, login availability and an existing pending transition are checked inside the broker queue", async () => {
  const f = await setup();
  const before = await fs.readFile(f.main, "utf8");
  const staleSelection = await f.service.switchGlobalAccountFromAssistant({ ...f.input(), expectedAccountId: null }, new AbortController().signal);
  expect(staleSelection).toMatchObject({ status: "failed", code: "selection_changed" });
  const staleRevision = await f.service.switchGlobalAccountFromAssistant({ ...f.input(), revision: "old" }, new AbortController().signal);
  expect(staleRevision).toMatchObject({ status: "failed", code: "account_changed" });
  await f.service.setActiveAccount(f.c.id);
  const pendingBefore = f.store.getPendingTransition();
  const pending = await f.service.switchGlobalAccountFromAssistant(f.input(), new AbortController().signal);
  expect(pending).toMatchObject({ status: "failed", code: "transition_pending", pendingAccountId: f.c.id });
  expect(f.store.getPendingTransition()).toEqual(pendingBefore);
  f.store.cancelPendingTransition();
  const expired = JSON.stringify({ tokens: { access_token: `e30.${Buffer.from('{"exp":1}').toString("base64url")}.signature`, refresh_token: "PRIVATE_REFRESH", account_id: f.b.id } });
  f.store.saveAuthJson(f.b.id, expired);
  const unavailable = await f.service.switchGlobalAccountFromAssistant(f.input(), new AbortController().signal);
  expect(unavailable).toMatchObject({ status: "failed", code: "login_required" });
  expect(await fs.readFile(f.main, "utf8")).toBe(before);
  expect(await f.service.getActiveAccountId()).toBe(f.a.id);
  expect(f.service.getPendingAccountId()).toBeUndefined();
  expectSafe([staleSelection, staleRevision, pending, unavailable]);
});

test("a target credential change during publication rolls back instead of committing an unconfirmed login", async () => {
  const f = await setup();
  const before = await fs.readFile(f.main, "utf8");
  const original = f.service["publishMainAuth"].bind(f.service);
  f.service["publishMainAuth"] = async (content) => {
    await original(content);
    if (content === auth(f.b.id)) f.store.saveAuthJson(f.b.id, auth("replacement-identity"));
  };
  const result = await f.service.switchGlobalAccountFromAssistant(f.input(), new AbortController().signal);
  expect(result).toMatchObject({ status: "failed", code: "account_changed", selectedAccountId: f.a.id });
  expect(await fs.readFile(f.main, "utf8")).toBe(before);
  expect(f.service.getPendingAccountId()).toBeUndefined();
  expect(f.store.get(f.b.id)?.authJson).toBe(auth("replacement-identity"));
});

test("a newer settings request during publication is preserved while the uncommitted assistant publication is restored", async () => {
  const f = await setup();
  const before = await fs.readFile(f.main, "utf8");
  const original = f.service["publishMainAuth"].bind(f.service);
  f.service["publishMainAuth"] = async (content) => {
    await original(content);
    if (content === auth(f.b.id)) await f.service.setActiveAccount(f.c.id);
  };
  const result = await f.service.switchGlobalAccountFromAssistant(f.input(), new AbortController().signal);
  expect(result).toMatchObject({ status: "failed", code: "selection_changed", selectedAccountId: f.a.id, pendingAccountId: f.c.id });
  expect(await fs.readFile(f.main, "utf8")).toBe(before);
  expect(f.service.getPendingAccountId()).toBe(f.c.id);
  f.service["publishMainAuth"] = original;
});

test("failed restoration is explicitly reported and never claims the old login file was recovered", async () => {
  const f = await setup();
  const original = f.service["publishMainAuth"].bind(f.service);
  f.service["publishMainAuth"] = async (content) => {
    if (content === auth(f.a.id)) throw new Error("PRIVATE_FAILURE");
    await original(content);
  };
  f.store.commitPendingTransition = () => { throw new Error("PRIVATE_FAILURE"); };
  const result = await f.service.switchGlobalAccountFromAssistant(f.input(), new AbortController().signal);
  expect(result).toMatchObject({ status: "failed", code: "restoration_failed", selectedAccountId: f.a.id, syncState: "error" });
  expect(await fs.readFile(f.main, "utf8")).toBe(auth(f.b.id));
  expectSafe([result, f.events]);
  // Repair the intentionally broken storage boundary before normal disposal/writeback.
  f.service["publishMainAuth"] = original;
  await original(auth(f.a.id));
});

test("cancellation before or during publication cannot queue a later automatic switch", async () => {
  const f = await setup();
  const before = await fs.readFile(f.main, "utf8");
  const cancelled = new AbortController();
  cancelled.abort(new Error("PRIVATE_FAILURE"));
  const early = await f.service.switchGlobalAccountFromAssistant(f.input(), cancelled.signal);
  expect(early).toMatchObject({ status: "failed", code: "cancelled", selectedAccountId: f.a.id });
  const controller = new AbortController();
  const original = f.service["publishMainAuth"].bind(f.service);
  f.service["publishMainAuth"] = async (content) => {
    await original(content);
    if (content === auth(f.b.id)) controller.abort(new Error("PRIVATE_FAILURE"));
  };
  const result = await f.service.switchGlobalAccountFromAssistant(f.input(), controller.signal);
  expect(result).toMatchObject({ status: "failed", code: "cancelled", selectedAccountId: f.a.id });
  expect(await fs.readFile(f.main, "utf8")).toBe(before);
  expect(f.service.getPendingAccountId()).toBeUndefined();
  expectSafe([early, result, f.events]);
});
