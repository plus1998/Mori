import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
