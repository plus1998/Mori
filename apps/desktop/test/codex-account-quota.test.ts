import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCodexAccountQuota, type CodexQuotaClient } from "../src/main/codex-account-quota";
import { OpenAIAccountService } from "../src/main/openai-account-service";

const rateLimits = {
  rateLimits: { primary: { usedPercent: 99 } },
  rateLimitsByLimitId: {
    codex: {
      planType: "plus",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
      secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 2_000_600_000 },
    },
  },
  rateLimitResetCredits: { availableCount: 2 },
};
const accountResponse = { account: { type: "chatgpt", email: "demo@example.test", planType: "plus" } };

function quotaClient(handler: (method: string, params: unknown) => unknown): CodexQuotaClient {
  return { request: async <T>(method: string, params?: unknown) => await handler(method, params) as T };
}

test("Codex quota reads use the Codex bucket and preserve both windows", async () => {
  const calls: string[] = [];
  const quota = await readCodexAccountQuota(quotaClient((method) => {
    calls.push(method);
    return method === "account/read" ? accountResponse : rateLimits;
  }));
  expect(calls).toEqual(["account/read", "account/rateLimits/read"]);
  expect(quota).toMatchObject({
    planType: "plus", email: "demo@example.test", resetCreditsAvailable: 2,
    rateLimit: {
      allowed: false, limitReached: true,
      primaryWindow: { usedPercent: 25, limitWindowSeconds: 18_000, resetAt: 2_000_000_000 },
      secondaryWindow: { usedPercent: 100, limitWindowSeconds: 604_800, resetAt: 2_000_600_000 },
    },
  });
});

test("a quota 401 refreshes the managed token once and retries without a model turn", async () => {
  const calls: Array<[string, unknown]> = [];
  let reads = 0;
  await readCodexAccountQuota(quotaClient((method, params) => {
    calls.push([method, params]);
    if (method === "account/read") return accountResponse;
    if (++reads === 1) throw new Error("401 Unauthorized");
    return rateLimits;
  }));
  expect(calls).toEqual([
    ["account/read", { refreshToken: false }], ["account/rateLimits/read", undefined],
    ["account/read", { refreshToken: true }], ["account/rateLimits/read", undefined],
  ]);
});

test("a gateway can hide account metadata while the quota RPC confirms the managed account", async () => {
  const quota = await readCodexAccountQuota(quotaClient((method) => method === "account/read"
    ? { account: null, requiresOpenaiAuth: false }
    : { ...rateLimits, accountId: "acct-quota" }), false, "acct-quota");
  expect(quota.planType).toBe("plus");
  expect(quota.rateLimit.primaryWindow?.usedPercent).toBe(25);
  expect(quota.email).toBe(""); // The gateway did not supply account metadata.
});

test("hidden gateway metadata requires an exact quota account identity", async () => {
  for (const accountId of [undefined, "acct-other"]) {
    await expect(readCodexAccountQuota(quotaClient((method) => method === "account/read"
      ? { account: null, requiresOpenaiAuth: false }
      : { ...rateLimits, accountId }), false, "acct-quota")).rejects.toThrow("未确认所查询的账号身份");
  }
  await expect(readCodexAccountQuota(quotaClient((method) => method === "account/read"
    ? { account: null, requiresOpenaiAuth: false }
    : { ...rateLimits, accountId: "acct-quota" }))).rejects.toThrow("未确认所查询的账号身份");
});

test("missing ChatGPT login and API key login remain authentication errors", async () => {
  for (const account of [null, { type: "apiKey" }]) {
    await expect(readCodexAccountQuota(quotaClient((method) => method === "account/read"
      ? { account, requiresOpenaiAuth: true }
      : { ...rateLimits, accountId: "acct-quota" }), false, "acct-quota")).rejects.toThrow("需要 ChatGPT 登录凭据");
  }
});

test("network failures do not rotate a token and repeated authentication errors are surfaced", async () => {
  for (const [message, expectedRefreshes] of [["503 unavailable", 0], ["401 Unauthorized", 1]] as const) {
    let refreshes = 0;
    await expect(readCodexAccountQuota(quotaClient((method, params) => {
      if (method === "account/read") {
        if ((params as { refreshToken: boolean }).refreshToken) refreshes++;
        return accountResponse;
      }
      throw new Error(message);
    }))).rejects.toThrow(message);
    expect(refreshes).toBe(expectedRefreshes);
  }
});

test("invalid quota percentages fail instead of displaying a fabricated zero", async () => {
  await expect(readCodexAccountQuota(quotaClient((method) => method === "account/read"
    ? accountResponse : { rateLimits: { primary: {} } }))).rejects.toThrow("使用比例无效");
});

test("missing Codex buckets and a different account's quota cannot be cached as this account", async () => {
  for (const response of [
    { ...rateLimits, rateLimitsByLimitId: { premium: rateLimits.rateLimitsByLimitId.codex } },
    { ...rateLimits, accountId: "acct-other" },
  ]) {
    await expect(readCodexAccountQuota(quotaClient((method) => method === "account/read"
      ? accountResponse : response), false, "acct-quota")).rejects.toThrow();
  }
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function auth(exp: number, refresh: string, stamp: string): string {
  const jwt = `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
  return JSON.stringify({
    auth_mode: "chatgpt", last_refresh: stamp,
    tokens: { access_token: jwt, id_token: jwt, refresh_token: refresh, account_id: "acct-quota" },
  });
}
const expiredAuth = auth(1, "old-refresh", "2026-01-01T00:00:00Z");
const freshAuth = auth(2_000_000_000, "new-refresh", "2026-10-22T00:00:00Z");

test("wake deduplicates hi, keeps the selected account and reports a post-reply quota failure separately", async () => {
  const root = await serviceRoot();
  let notify: ((method: string, params: unknown) => void) | undefined;
  let turns = 0;
  let reads = 0;
  const client = quotaClient((method, params) => {
    if (method === "account/read") return accountResponse;
    if (method === "account/rateLimits/read") {
      if (++reads > 1) throw new Error("quota offline after reply");
      return rateLimits;
    }
    if (method === "model/list") return { data: [{ model: "gpt-6-luna", isDefault: true }] };
    if (method === "thread/start") {
      expect(params).toMatchObject({ model: "gpt-5.6-luna" });
      return { thread: { id: "wake" } };
    }
    if (method === "turn/start") {
      turns++;
      notify?.("turn/completed", { threadId: "wake", turn: { id: "turn", status: "completed", items: [{ type: "agentMessage", text: "hi!" }] } });
      return { turn: { id: "turn" } };
    }
    return {};
  });
  client.addNotificationHandler = (handler) => { notify = handler; return () => { notify = undefined; }; };
  const service = new OpenAIAccountService(root, "unused", undefined, async () => client);
  await service.initialize();
  cleanups.push(() => service.dispose());
  const account = await service.createAccount("Wake");
  await service.setAuthJson(account.id, freshAuth);
  await service.setActiveAccount(account.id);
  await service.applyPendingTransition();
  service.setWakeModel("gpt-5.6-luna");
  const first = service.wakeAccount(account.id);
  expect(service.wakeAccount(account.id)).toBe(first);
  expect(await first).toEqual({ reply: "hi!", quotaError: "quota offline after reply" });
  expect(turns).toBe(1);
  expect(await service.getActiveAccountId()).toBe(account.id);
  expect((await service.listAccounts())[0]?.quotaRefresh?.error).toBe("quota offline after reply");
});

for (const modelFailure of ["turn/start", "turn/completed"] as const) {
  for (const quotaFails of [false, true]) {
    test(`${modelFailure} model failure stays separate from quota state (quota fails: ${quotaFails})`, async () => {
      const root = await serviceRoot();
      let notify: ((method: string, params: unknown) => void) | undefined;
      let reads = 0;
      const unsupported = new Error("model_not_found: selected model is not supported for this account");
      const client = quotaClient((method) => {
        if (method === "account/read") return accountResponse;
        if (method === "account/rateLimits/read") {
          if (++reads === 3 && quotaFails) throw new Error("quota endpoint offline");
          return rateLimits;
        }
        if (method === "thread/start") return { thread: { id: "wake" } };
        if (method === "turn/start") {
          if (modelFailure === "turn/start") throw unsupported;
          notify?.("turn/completed", {
            threadId: "wake", turn: { id: "turn", status: "failed", error: { message: unsupported.message } },
          });
          return { turn: { id: "turn" } };
        }
        return {};
      });
      client.addNotificationHandler = (handler) => { notify = handler; return () => { notify = undefined; }; };
      const service = new OpenAIAccountService(root, "unused", undefined, async () => client);
      await service.initialize();
      cleanups.push(() => service.dispose());
      const account = await service.createAccount("Model test");
      await service.setAuthJson(account.id, freshAuth);
      await service.setActiveAccount(account.id);
      await service.applyPendingTransition();
      service.setWakeModel("unsupported-model");
      const cached = await service.queryQuota(account.id);
      await expect(service.wakeAccount(account.id)).rejects.toThrow(unsupported.message);
      expect(reads).toBe(3); // original cache, preflight, independent post-test read
      const updated = (await service.listAccounts()).find((entry) => entry.id === account.id);
      expect(updated?.quota?.rateLimit).toEqual(cached.rateLimit);
      expect(updated?.quotaRefresh?.error).toBe(quotaFails ? "quota endpoint offline" : undefined);
      if (quotaFails) {
        expect(updated?.quota).toEqual(cached);
        expect(updated?.quotaRefresh?.retryAt).toBeGreaterThan(Date.now());
      } else {
        expect(updated?.quotaRefresh?.retryAt).toBeUndefined();
        expect(updated?.quotaRefresh?.authRequired).toBeUndefined();
        expect(updated?.quota?.fetchedAt).toBeGreaterThanOrEqual(cached.fetchedAt);
      }
      expect(service.getSyncStatus().state).toBe("ok");
    });
  }
}

test("quota preflight failure prevents model testing and remains a quota error", async () => {
  const root = await serviceRoot();
  const calls: string[] = [];
  const client = quotaClient((method) => {
    calls.push(method);
    if (method === "account/read") return accountResponse;
    if (method === "account/rateLimits/read") throw new Error("quota preflight offline");
    return {};
  });
  const service = new OpenAIAccountService(root, "unused", undefined, async () => client);
  await service.initialize();
  cleanups.push(() => service.dispose());
  const account = await service.createAccount("Quota failure");
  await service.setAuthJson(account.id, freshAuth);
  await service.setActiveAccount(account.id);
  await service.applyPendingTransition();
  await expect(service.wakeAccount(account.id)).rejects.toThrow("quota preflight offline");
  expect(calls).not.toContain("turn/start");
  expect((await service.listAccounts())[0]?.quotaRefresh?.error).toBe("quota preflight offline");
});

async function serviceRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-quota-test-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("an expired active account refreshes through the shared client and writes SQLite even when usage fails", async () => {
  const root = await serviceRoot();
  let failQuota = false;
  let refreshes = 0;
  const client = quotaClient(async (method, params) => {
    if (method === "account/read") {
      if ((params as { refreshToken: boolean }).refreshToken) {
        refreshes++;
        await fs.writeFile(path.join(root, "codex", "auth.json"), freshAuth);
      }
      return accountResponse;
    }
    if (failQuota) throw new Error("503 unavailable");
    return rateLimits;
  });
  const service = new OpenAIAccountService(root, "unused", undefined, async () => client);
  await service.initialize();
  cleanups.push(() => service.dispose());
  const account = await service.createAccount("Active");
  await service.setAuthJson(account.id, expiredAuth);
  await service.setActiveAccount(account.id);
  await service.applyPendingTransition();
  const quota = await service.queryQuota(account.id);
  expect(refreshes).toBe(1);
  expect(await service.getAuthJsonContent(account.id)).toBe(freshAuth);
  expect((await service.listAccounts())[0]?.quota).toEqual(quota);

  // Stage another expired credential so the failed read still has to refresh.
  await service.setAuthJson(account.id, expiredAuth);
  await service.applyPendingTransition();
  failQuota = true;
  await expect(service.queryQuota(account.id)).rejects.toThrow("503 unavailable");
  expect(await service.getAuthJsonContent(account.id)).toBe(freshAuth);
  expect((await service.listAccounts())[0]?.quota).toEqual(quota);
  expect(service.getSyncStatus().state).toBe("ok");
});

test("startup keeps reset-due cache without querying; actual usage refreshes it", async () => {
  const root = await serviceRoot();
  const setup = new OpenAIAccountService(root, "unused", undefined, async () => quotaClient((method) =>
    method === "account/read" ? accountResponse : rateLimits));
  await setup.initialize();
  const account = await setup.createAccount("Reset while closed");
  await setup.setAuthJson(account.id, freshAuth);
  await setup.setActiveAccount(account.id);
  await setup.applyPendingTransition();
  const cached = await setup.queryQuota(account.id);
  await setup.dispose();
  const now = Date.now();
  cached.fetchedAt = now - 6 * 60_000;
  if (!cached.rateLimit.primaryWindow) throw new Error("Missing primary test window");
  cached.rateLimit.primaryWindow.resetAt = Math.floor(now / 1_000) - 1;
  cached.rateLimit.primaryWindow.usedPercent = 100;
  const db = new DatabaseSync(path.join(root, "eco-coding.sqlite"));
  try {
    db.prepare("UPDATE openai_account_quotas SET quota_json = ?, fetched_at = ? WHERE account_id = ?")
      .run(JSON.stringify(cached), cached.fetchedAt, account.id);
  } finally {
    db.close();
  }
  let reads = 0;
  let published!: () => void;
  const refreshed = new Promise<void>((resolve) => { published = resolve; });
  const service = new OpenAIAccountService(root, "unused", () => {
    if (reads > 0) published();
  }, async () => quotaClient((method) => {
    if (method === "account/read") return accountResponse;
    reads++;
    return rateLimits;
  }));
  cleanups.push(() => service.dispose());
  await service.initialize();
  expect(reads).toBe(0);
  expect((await service.listAccounts())[0]?.quota).toEqual(cached);
  service.setQuotaUsage("task", true);
  await refreshed;
  expect(reads).toBe(1);
  const updated = (await service.listAccounts()).find((entry) => entry.id === account.id)?.quota;
  expect(updated?.fetchedAt).toBeGreaterThan(cached.fetchedAt);
  expect(updated?.rateLimit.primaryWindow?.usedPercent).toBe(25);
  expect(await service.getActiveAccountId()).toBe(account.id);
  expect(service.getSyncStatus().state).toBe("ok");
});

test.skipIf(process.platform === "win32")("inactive wake uses its own credentials and proxy home, refreshes quota and preserves the running account", async () => {
  const root = await serviceRoot();
  const executable = path.join(root, "fake-codex-wake");
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') send(req.id, {});
  else if (req.method === 'account/read') {
    if (req.params.refreshToken) fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), ${JSON.stringify(freshAuth)});
    send(req.id, ${JSON.stringify(accountResponse)});
  } else if (req.method === 'account/rateLimits/read') send(req.id, ${JSON.stringify(rateLimits)});
  else if (req.method === 'model/list') send(req.id, {data:[{model:'gpt-6-luna',isDefault:true}]});
  else if (req.method === 'thread/start') {
    if (!req.params.ephemeral || req.params.modelProvider !== 'openai') process.exit(20);
    send(req.id, {thread:{id:'wake'}});
  } else if (req.method === 'turn/start') {
    if (req.params.input[0].text !== 'hi') process.exit(21);
    if (req.params.model === 'unsupported-model') {
      process.stdout.write(JSON.stringify({id:req.id,error:{code:-32600,message:'model_not_found'}})+'\\n');
      return;
    }
    send(req.id, {turn:{id:'turn',status:'inProgress'}});
    notify('turn/completed', {threadId:'wake',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'Hello!'}]}});
  } else if (req.method === 'thread/unsubscribe') send(req.id, {});
});
`, { mode: 0o755 });
  const service = new OpenAIAccountService(root, executable);
  await service.initialize();
  cleanups.push(() => service.dispose());
  const active = await service.createAccount("Running");
  await service.setAuthJson(active.id, freshAuth.replaceAll("acct-quota", "acct-running"));
  await service.setActiveAccount(active.id);
  await service.applyPendingTransition();
  const original = await fs.readFile(path.join(root, "codex", "auth.json"), "utf8");
  const inactive = await service.createAccount("Wake inactive");
  await service.setAuthJson(inactive.id, expiredAuth);
  expect(await service.wakeAccount(inactive.id)).toEqual({ reply: "Hello!" });
  expect(await service.getActiveAccountId()).toBe(active.id);
  expect(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8")).toBe(original);
  expect(await service.getAuthJsonContent(inactive.id)).toBe(freshAuth);
  expect((await service.listAccounts()).find((entry) => entry.id === inactive.id)?.quota?.rateLimit.primaryWindow?.usedPercent).toBe(25);
  service.setWakeModel("unsupported-model");
  await expect(service.wakeAccount(inactive.id)).rejects.toThrow("model_not_found");
  expect((await service.listAccounts()).find((entry) => entry.id === inactive.id)?.quotaRefresh?.error).toBeUndefined();
  expect(await service.getActiveAccountId()).toBe(active.id);
  expect(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8")).toBe(original);
  expect((await fs.readdir(path.join(root, "codex-accounts"))).some((name) => name.startsWith("quota-"))).toBe(false);
});

test.skipIf(process.platform === "win32")("inactive account query rotates its own auth, deduplicates requests, and preserves the running account", async () => {
  const root = await serviceRoot();
  const executable = path.join(root, "fake-codex");
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') send(req.id, {});
  else if (req.method === 'account/read') {
    if (!req.params.refreshToken) process.exit(12);
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), ${JSON.stringify(freshAuth)});
    send(req.id, ${JSON.stringify(accountResponse)});
  } else if (req.method === 'account/rateLimits/read') send(req.id, ${JSON.stringify(rateLimits)});
});
`, { mode: 0o755 });
  const service = new OpenAIAccountService(root, executable);
  await service.initialize();
  cleanups.push(() => service.dispose());
  const active = await service.createAccount("Running");
  await service.setAuthJson(active.id, freshAuth.replaceAll("acct-quota", "acct-running"));
  await service.setActiveAccount(active.id);
  await service.applyPendingTransition();
  const original = await fs.readFile(path.join(root, "codex", "auth.json"), "utf8");
  const inactive = await service.createAccount("Inactive");
  await service.setAuthJson(inactive.id, expiredAuth);
  const first = service.queryQuota(inactive.id);
  expect(service.queryQuota(inactive.id)).toBe(first);
  await first;
  expect(await service.getAuthJsonContent(inactive.id)).toBe(freshAuth);
  expect(await fs.readFile(path.join(root, "codex", "auth.json"), "utf8")).toBe(original);
  expect(await service.getActiveAccountId()).toBe(active.id);
  expect((await fs.readdir(path.join(root, "codex-accounts"))).some((name) => name.startsWith("quota-"))).toBe(false);
});
