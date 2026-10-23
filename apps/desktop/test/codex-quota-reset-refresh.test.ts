import { expect, test } from "bun:test";
import {
  CodexQuotaResetRefresher,
  hasUnrefreshedCodexQuotaReset,
} from "../src/main/codex-quota-reset-refresh";
import type { OpenAIAccountQuota } from "../src/shared/openai-account";

const start = 1_800_000_000_000;
const fiveHours = 5 * 60 * 60 * 1_000;
const week = 7 * 24 * 60 * 60 * 1_000;

function quota(fetchedAt = start): OpenAIAccountQuota {
  return {
    fetchedAt,
    planType: "plus",
    email: "",
    resetCreditsAvailable: 0,
    rateLimit: {
      allowed: false,
      limitReached: true,
      primaryWindow: {
        usedPercent: 100,
        limitWindowSeconds: fiveHours / 1_000,
        resetAfterSeconds: fiveHours / 1_000,
        resetAt: (start + fiveHours) / 1_000,
      },
      secondaryWindow: {
        usedPercent: 75,
        limitWindowSeconds: week / 1_000,
        resetAfterSeconds: week / 1_000,
        resetAt: (start + week) / 1_000,
      },
    },
  };
}

test("refreshes at each window's reset, including a week after the five-hour reset was checked", async () => {
  let now = start;
  const account = { id: "A", authJson: "credentials", quota: quota() };
  const queries: string[] = [];
  const refresher = new CodexQuotaResetRefresher(
    async (id) => {
      queries.push(id);
      account.quota = quota(now);
      return account.quota;
    },
    () => {
      throw new Error("unexpected error");
    },
    () => now,
  );
  await refresher.refreshDueAccounts([account]);
  now = start + fiveHours - 1;
  await refresher.refreshDueAccounts([account]);
  expect(queries).toEqual([]);
  now++;
  await refresher.refreshDueAccounts([account]);
  expect(queries).toEqual(["A"]);
  await refresher.refreshDueAccounts([account]);
  expect(queries).toEqual(["A"]);
  now = start + week;
  await refresher.refreshDueAccounts([account]);
  expect(queries).toEqual(["A", "A"]);
  await refresher.refreshDueAccounts([account]);
  expect(queries).toHaveLength(2);
});

test("startup or wake catches both expired windows with one query per account, including inactive accounts", async () => {
  const queries: string[] = [];
  const refresher = new CodexQuotaResetRefresher(
    async (id) => {
      queries.push(id);
      return quota(start + week);
    },
    () => {},
    () => start + week,
  );
  await refresher.refreshDueAccounts([
    { id: "active", authJson: "active credentials", quota: quota() },
    { id: "inactive", authJson: "inactive credentials", quota: quota() },
    { id: "logged-out", authJson: null, quota: quota() },
    { id: "unknown-reset", authJson: "credentials" },
  ]);
  expect(queries).toEqual(["active", "inactive"]);
});

test("a failed query keeps the actual cached values, reports its error, and retries after a minute", async () => {
  let now = start + fiveHours;
  const account = { id: "A", authJson: "credentials", quota: quota() };
  const original = structuredClone(account.quota);
  const errors: unknown[] = [];
  let calls = 0;
  const failure = new Error("503 unavailable");
  const refresher = new CodexQuotaResetRefresher(
    async () => {
      if (++calls === 1) throw failure;
      account.quota = quota(now);
      return account.quota;
    },
    (_id, error) => errors.push(error),
    () => now,
  );
  await refresher.refreshDueAccounts([account]);
  expect(account.quota).toEqual(original);
  expect(errors).toEqual([failure]);
  now += 59_999;
  await refresher.refreshDueAccounts([account]);
  expect(calls).toBe(1);
  now++;
  await refresher.refreshDueAccounts([account]);
  expect(calls).toBe(2);
  await refresher.refreshDueAccounts([account]);
  expect(calls).toBe(2);
});

test("overlapping checks share in-flight reads and shutdown waits for credential writeback", async () => {
  let finish!: (value: OpenAIAccountQuota) => void;
  const pending = new Promise<OpenAIAccountQuota>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const refresher = new CodexQuotaResetRefresher(
    async () => {
      calls++;
      return pending;
    },
    () => {},
    () => start + week,
  );
  const accounts = [{ id: "A", authJson: "credentials", quota: quota() }];
  const first = refresher.refreshDueAccounts(accounts);
  await Promise.resolve();
  const second = refresher.refreshDueAccounts(accounts);
  expect(calls).toBe(1);
  let stopped = false;
  const shutdown = refresher.dispose().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish(quota(start + week));
  await Promise.all([first, second, shutdown]);
  await refresher.refreshDueAccounts(accounts);
  expect(calls).toBe(1);
});

test("missing or invalid reset times never invent a reset schedule", () => {
  for (const resetAt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const cached = quota();
    if (!cached.rateLimit.primaryWindow) throw new Error("Missing primary test window");
    cached.rateLimit.primaryWindow.resetAt = resetAt;
    cached.rateLimit.secondaryWindow = null;
    expect(hasUnrefreshedCodexQuotaReset(cached, start + week)).toBe(false);
  }
  const cached = quota(start + week);
  expect(hasUnrefreshedCodexQuotaReset(cached, start + week)).toBe(false);
});
