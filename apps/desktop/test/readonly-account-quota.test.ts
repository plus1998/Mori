import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpenAIAccountService } from "../src/main/openai-account-service";
import { queryReadonlyAccountQuotas, readReadonlyQuota, type ReadonlyQuotaAccount } from "../src/main/readonly-account-quota";
import type { CodexQuotaClient } from "../src/main/codex-account-quota";
import { MORI_ACCOUNT_QUOTA_TOOL, MORI_MODEL_TOOLS, modelManagementToolInput } from "../src/main/mori-assistant-models";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
const auth = (id = "acct-a", expired = false) => JSON.stringify({
  auth_mode: "chatgpt", OPENAI_API_KEY: "sk-private-key", cookie: "private-cookie",
  tokens: { account_id: id, access_token: jwt(expired ? 1 : 4_000_000_000), refresh_token: "private-refresh", id_token: "private-id-token" },
});
const cache = JSON.stringify({ fetchedAt: 1_700_000_000_000, planType: "plus", email: "not-needed@example.test",
  rateLimit: { primaryWindow: { usedPercent: 40, limitWindowSeconds: 18_000, resetAt: 2_000_000_000 }, secondaryWindow: null } });
const account = (id: string, overrides: Partial<ReadonlyQuotaAccount> = {}): ReadonlyQuotaAccount => ({
  id, name: `Label ${id}`, authJson: auth(), proxyMode: "direct", proxyUrl: null,
  quotaJson: cache, quotaAccountId: "acct-a", ...overrides,
});
const limits = { accountId: "acct-a", rateLimits: { primary: { usedPercent: 1 } },
  rateLimitsByLimitId: {
    codex: { planType: "plus", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 95, windowDurationMins: 10_080 } },
    premium: { primary: { usedPercent: 4 } },
  },
  access_token: "ignored-upstream-token", cookie: "ignored-upstream-cookie",
};
function client(handler: (method: string, params: unknown) => unknown): CodexQuotaClient {
  return { request: async <T>(method: string, params?: unknown) => await handler(method, params) as T };
}

test("readonly RPC binds access-only external auth, preserves all buckets/windows and never requests refresh", async () => {
  const calls: Array<[string, unknown]> = [];
  const result = await readReadonlyQuota(client((method, params) => {
    calls.push([method, params]); return method === "account/rateLimits/read" ? limits : {};
  }), auth());
  expect(calls).toEqual([
    ["account/login/start", { type: "chatgptAuthTokens", accessToken: jwt(4_000_000_000), chatgptAccountId: "acct-a" }],
    ["account/rateLimits/read", undefined],
  ]);
  expect(result.buckets).toEqual([
    { bucket: "codex", planType: "plus", windows: [
      { window: "primary", usedPercent: 25, windowSeconds: 18_000, resetAt: 2_000_000_000 },
      { window: "secondary", usedPercent: 95, windowSeconds: 604_800, resetAt: null },
    ] },
    { bucket: "premium", planType: "unknown", windows: [{ window: "primary", usedPercent: 4, windowSeconds: null, resetAt: null }] },
  ]);
  expect(JSON.stringify(result)).not.toContain("ignored-upstream");
});

test("all accounts survive partial failures, expired/missing credentials and cache corruption", async () => {
  const records = [account("bound"), account("inactive"), account("expired", { authJson: auth("acct-a", true) }),
    account("missing", { authJson: null }), account("corrupt", { quotaJson: "invalid-private-cache" }),
    account("wrong-cache", { quotaAccountId: "acct-other" })];
  const queried: string[] = [];
  const result = await queryReadonlyAccountQuotas({ accounts: records, source: "live", authUnchanged: () => true,
    query: async (record) => {
      queried.push(record.id);
      if (record.id === "inactive") throw new Error("401 Bearer private-refresh sk-private-key private-cookie");
      if (record.id === "corrupt" || record.id === "wrong-cache") throw new Error("upstream private-id-token");
      return readReadonlyQuota(client((method) => method === "account/rateLimits/read" ? limits : {}), record.authJson!);
    },
  });
  expect(result.accounts.map((item) => item.accountId)).toEqual(records.map((item) => item.id));
  expect(queried).toEqual(["bound", "inactive", "corrupt", "wrong-cache"]);
  expect(result.accounts[0]).toMatchObject({ status: "ok", source: "live", freshness: "live", cachedAt: 1_700_000_000_000 });
  expect(result.accounts[1]).toMatchObject({ status: "error", source: "cache", freshness: "stale", error: { code: "refresh_required" } });
  expect(result.accounts[2]?.error?.code).toBe("refresh_required");
  expect(result.accounts[3]).toMatchObject({ error: { code: "missing_credentials" }, buckets: [], cacheStatus: "identity_mismatch" });
  expect(result.accounts[4]).toMatchObject({ error: { code: "query_failed" }, buckets: [], cacheStatus: "invalid" });
  expect(result.accounts[5]).toMatchObject({ buckets: [], cacheStatus: "identity_mismatch" });
  const output = JSON.stringify(result);
  for (const secret of [jwt(4_000_000_000), "private-refresh", "sk-private-key", "private-cookie", "private-id-token", "invalid-private-cache", "not-needed@example.test"])
    expect(output).not.toContain(secret);
});

test("cache mode performs no RPC, filters wrong ownership and reports staleness", async () => {
  const result = await queryReadonlyAccountQuotas({ accounts: [account("a"), account("b", { quotaAccountId: "other" })],
    source: "cache", authUnchanged: () => true, query: async () => { throw new Error("unexpected RPC"); } });
  expect(result.accounts[0]).toMatchObject({ source: "cache", freshness: "stale", fetchedAt: 1_700_000_000_000 });
  expect(result.accounts[1]).toMatchObject({ source: null, freshness: "unavailable", buckets: [] });
});

test("an auxiliary bucket without windows does not discard the ordinary quota", async () => {
  const result = await readReadonlyQuota(client((method) => method === "account/rateLimits/read" ? {
    ...limits, rateLimitsByLimitId: { ...limits.rateLimitsByLimitId, creditsOnly: { primary: null, secondary: null } },
  } : {}), auth());
  expect(result.buckets.map((bucket) => bucket.bucket)).toEqual(["codex", "premium", "creditsOnly"]);
  expect(result.buckets[2]?.windows).toEqual([]);
});

test("supported flat/mixed auth formats work; malformed and expired credentials never start RPC", async () => {
  for (const raw of [JSON.stringify({ access_token: jwt(4_000_000_000), account_id: "acct-a" }),
    JSON.stringify({ tokens: { access_token: jwt(4_000_000_000) }, account_id: "acct-a" })]) {
    const result = await readReadonlyQuota(client((method) => method === "account/rateLimits/read" ? limits : {}), raw);
    expect(result.buckets[0]?.bucket).toBe("codex");
  }
  for (const [raw, code] of [["invalid-private-json", "invalid_credentials"], ["{}", "invalid_credentials"], [auth("acct-a", true), "refresh_required"]]) {
    let called = false;
    await expect(readReadonlyQuota(client(() => { called = true; return {}; }), raw!)).rejects.toMatchObject({ code });
    expect(called).toBe(false);
  }
});

test("cancelling during one account query prevents subsequent account reads", async () => {
  const controller = new AbortController();
  const reads: string[] = [];
  await expect(queryReadonlyAccountQuotas({ accounts: [account("a"), account("b")], source: "live", signal: controller.signal,
    authUnchanged: () => true, query: async (record) => {
      reads.push(record.id);
      controller.abort();
      throw new Error("cancelled private-refresh");
    },
  })).rejects.toThrow();
  expect(reads).toEqual(["a"]);
});

test("missing/mismatched response identity, malformed buckets and account replacement reject data", async () => {
  for (const [response, code] of [
    [{ ...limits, accountId: undefined }, "identity_mismatch"],
    [{ ...limits, accountId: "other" }, "identity_mismatch"],
    [{ ...limits, rateLimitsByLimitId: {} }, "invalid_response"],
    [{ ...limits, rateLimitsByLimitId: { codex: { primary: { usedPercent: NaN } } } }, "invalid_response"],
  ] as const) {
    await expect(readReadonlyQuota(client((method) => method === "account/rateLimits/read" ? response : {}), auth())).rejects.toMatchObject({ code });
  }
  const result = await queryReadonlyAccountQuotas({ accounts: [account("deleted")], source: "live", authUnchanged: () => false,
    query: () => readReadonlyQuota(client((method) => method === "account/rateLimits/read" ? limits : {}), auth()) });
  expect(result.accounts[0]).toMatchObject({ status: "error", error: { code: "account_changed" }, buckets: [], source: null });
});

test("even labels and bucket strings cannot echo known credential values", async () => {
  const result = await queryReadonlyAccountQuotas({ accounts: [account("a", { name: "private-refresh private-cookie private-id-token sk-private-key" })],
    source: "live", authUnchanged: () => true,
    query: () => readReadonlyQuota(client((method) => method === "account/rateLimits/read" ? {
      ...limits, rateLimitsByLimitId: { "private-refresh": { planType: "private-id-token", primary: { usedPercent: 20 } } },
    } : {}), auth()),
  });
  expect(JSON.stringify(result)).not.toMatch(/private-refresh|private-cookie|private-id-token|sk-private-key/);
});

test("publication rechecks accounts completed before a later slow account query", async () => {
  let replaced = false;
  const result = await queryReadonlyAccountQuotas({ accounts: [account("first"), account("later")], source: "live",
    authUnchanged: (record) => record.id !== "first" || !replaced,
    query: async (record) => {
      if (record.id === "later") replaced = true;
      return readReadonlyQuota(client((method) => method === "account/rateLimits/read" ? limits : {}), auth());
    },
  });
  expect(result.accounts[0]).toMatchObject({ error: { code: "account_changed" }, cachedAt: null, buckets: [] });
  expect(result.accounts[1]?.status).toBe("ok");
});

test("quota capability has a closed schema and redacts rejected tool inputs before persistence", () => {
  const definition = MORI_MODEL_TOOLS.find((tool) => tool.name === MORI_ACCOUNT_QUOTA_TOOL)!;
  expect(definition.inputSchema).toMatchObject({ additionalProperties: false, properties: { source: { enum: ["live", "cache"] } } });
  expect(modelManagementToolInput(MORI_ACCOUNT_QUOTA_TOOL, { source: "private-refresh", apiKey: "sk-private-key", authJson: auth() }))
    .toEqual({ source: "[invalid]" });
});

async function setupService() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-readonly-quota-test-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex.cjs");
  const log = path.join(root, "rpc.jsonl");
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input:process.stdin});
const log = ${JSON.stringify(log)};
let identity;
function send(value) { process.stdout.write(JSON.stringify(value)+'\\n'); }
fs.appendFileSync(log, JSON.stringify({args:process.argv.slice(2), home:process.env.CODEX_HOME, realHome:fs.realpathSync(process.env.CODEX_HOME), cwd:process.cwd(), authExists:fs.existsSync(process.env.CODEX_HOME+'/auth.json')})+'\\n');
rl.on('line', line => {
 const p=JSON.parse(line);
 if (p.id === 900) { fs.appendFileSync(log, JSON.stringify({refreshReply:p})+'\\n'); send({id:quotaId,result:{...${JSON.stringify(limits)},accountId:identity}}); return; }
 if (p.id === undefined) return;
 fs.appendFileSync(log, JSON.stringify({method:p.method,params:p.params})+'\\n');
 if (p.method==='initialize') send({id:p.id,result:{}});
 else if (p.method==='account/login/start') { identity=p.params.chatgptAccountId; send({id:p.id,result:{type:'chatgptAuthTokens'}}); }
 else if (p.method==='account/rateLimits/read') {
  if(identity==='needs-refresh') { global.quotaId=p.id; send({id:900,method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:identity}}); }
  else send({id:p.id,result:{...${JSON.stringify(limits)},accountId:identity}});
 } else send({id:p.id,error:{code:-1,message:'unexpected RPC private-refresh'}});
});
`, { mode: 0o755 });
  const service = new OpenAIAccountService(root, executable);
  await service.initialize();
  cleanup.push(() => service.dispose());
  return { root, service, log };
}

test("service queries every configured account in ephemeral processes; rejects refresh; DB and main auth stay unchanged", async () => {
  const { root, service, log } = await setupService();
  const ids: string[] = [];
  for (const [label, upstream] of [["active", "acct-a"], ["inactive", "acct-b"], ["refresh", "needs-refresh"]]) {
    const created = await service.createAccount({ name: label!, proxyMode: "direct" });
    await service.setAuthJson(created.id, auth(upstream));
    ids.push(created.id);
  }
  const missing = await service.createAccount("missing");
  ids.push(missing.id);
  await service.setActiveAccount(ids[0]!);
  await service.applyPendingTransition();
  // Stop unrelated background reconciliation; retain the real store and service query implementation.
  service["authWatcher"]?.close();
  service["authWatcher"] = null;
  if (service["authPoll"]) clearInterval(service["authPoll"]);
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  cleanup.push(async () => db.close());
  const dump = () => ["openai_accounts", "openai_account_quotas", "openai_account_settings"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  const before = JSON.stringify(dump());
  const mainPath = path.join(root, "codex", "auth.json");
  const mainBefore = await fs.readFile(mainPath, "utf8");
  const activeBefore = await service.getActiveAccountId();
  const choices = service.listAccountChoicesReadonly();
  expect(choices.map((choice) => choice.accountId)).toEqual(ids);
  expect(choices.map((choice) => choice.selectable)).toEqual([true, true, true, false]);
  const revision = service.accountChoiceRevisionReadonly(ids[0]!);
  expect(revision).not.toBeNull();
  expect(JSON.stringify(choices)).not.toContain(revision!);
  for (const secret of [jwt(4_000_000_000), "private-refresh", "private-cookie", "private-id-token", "sk-private-key"])
    expect(JSON.stringify(choices)).not.toContain(secret);
  expect(JSON.stringify(dump())).toBe(before);
  expect(await fs.readFile(mainPath, "utf8")).toBe(mainBefore);
  // These paths are explicitly forbidden, even if someone refactors the implementation later.
  service.ensureAccountCredentials = async () => { throw new Error("unexpected refresh"); };
  service.getExternalChatGptTokens = async () => { throw new Error("unexpected token manager"); };
  service.queryQuota = async () => { throw new Error("unexpected mutating quota API"); };
  const result = await service.queryAllAccountQuotasReadonly();
  expect(result.accounts.map((item) => item.accountId)).toEqual(ids);
  expect(result.accounts.slice(0, 2).map((item) => item.status)).toEqual(["ok", "ok"]);
  expect(result.accounts[2]?.error?.code).toBe("refresh_required");
  expect(result.accounts[3]?.error?.code).toBe("missing_credentials");
  expect(JSON.stringify(dump())).toBe(before);
  expect(await fs.readFile(mainPath, "utf8")).toBe(mainBefore);
  expect(await service.getActiveAccountId()).toBe(activeBefore);
  const events = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const processes = events.filter((event) => event.home);
  expect(processes).toHaveLength(3);
  for (const event of processes) {
    expect(event.args).toContain('cli_auth_credentials_store="ephemeral"');
    expect(event.authExists).toBe(false);
    expect(event.cwd).toBe(event.realHome);
    expect(await fs.stat(event.home).catch(() => null)).toBeNull();
  }
  expect(events.filter((event) => event.method).map((event) => event.method))
    .toEqual(Array(3).fill(["initialize", "account/login/start", "account/rateLimits/read"]).flat());
  expect(events.find((event) => event.refreshReply)?.refreshReply.error).toBeDefined();
  const logged = JSON.stringify(events);
  for (const secret of ["private-refresh", "private-cookie", "private-id-token", "sk-private-key"]) expect(logged).not.toContain(secret);
  const output = JSON.stringify(result);
  expect(output).not.toContain(jwt(4_000_000_000));
  expect(output).not.toContain("private-refresh");
  const oldLog = await fs.readFile(log, "utf8");
  const cached = await service.queryAllAccountQuotasReadonly("cache");
  expect(cached.accounts.map((item) => item.accountId)).toEqual(ids);
  expect(await fs.readFile(log, "utf8")).toBe(oldLog);
  expect(JSON.stringify(dump())).toBe(before);
});
