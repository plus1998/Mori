import { expect, test } from "bun:test";
import { createElement } from "react";
import { CodexAccountSwitchList } from "../src/renderer/CodexAccountSwitchDialog";
import { hasAvailableCodexQuota, loadAvailableCodexAccounts } from "../src/renderer/codex-account-switch";
import type { OpenAIAccount, OpenAIAccountQuota } from "../src/shared/openai-account";
import { renderLocalized } from "./i18n-test";

const quota: OpenAIAccountQuota = {
  planType: "plus",
  email: "example@example.test",
  fetchedAt: 123,
  resetCreditsAvailable: 0,
  rateLimit: {
    allowed: true,
    limitReached: false,
    primaryWindow: { usedPercent: 30, limitWindowSeconds: 18000, resetAfterSeconds: 100, resetAt: 0 },
    secondaryWindow: { usedPercent: 80, limitWindowSeconds: 604800, resetAfterSeconds: 100, resetAt: 0 },
  },
};
function account(id: string, overrides: Partial<OpenAIAccount> = {}): OpenAIAccount {
  return {
    id,
    name: id,
    isLoggedIn: true,
    authState: "configured",
    hasProfileData: false,
    createdAt: "2026-10-15",
    quota,
    ...overrides,
  };
}

test("availability requires valid login and verified remaining quota in every window", () => {
  expect(hasAvailableCodexQuota(account("ready"))).toBe(true);
  for (const unavailable of [
    account("missing", { isLoggedIn: false }),
    account("expired", { authState: "expired" }),
    account("unknown", { quota: undefined }),
    account("blocked", { quota: { ...quota, rateLimit: { ...quota.rateLimit, allowed: false } } }),
    account("limited", { quota: { ...quota, rateLimit: { ...quota.rateLimit, limitReached: true } } }),
    account("no-windows", {
      quota: { ...quota, rateLimit: { ...quota.rateLimit, primaryWindow: null, secondaryWindow: null } },
    }),
    ...[100, 110, NaN, -1].map((usedPercent) =>
      account("exhausted", {
        quota: {
          ...quota,
          rateLimit: {
            ...quota.rateLimit,
            secondaryWindow: {
              ...{ usedPercent: 80, limitWindowSeconds: 604800, resetAfterSeconds: 100, resetAt: 0 },
              usedPercent,
            },
          },
        },
      }),
    ),
  ])
    expect(hasAvailableCodexQuota(unavailable)).toBe(false);
});

test("switcher refreshes quotas and hides current, logged-out, exhausted and failed accounts", async () => {
  const queried: string[] = [];
  const result = await loadAvailableCodexAccounts({
    openAIAccountsList: async () => [
      account("current"),
      account("ready"),
      account("no-login", { isLoggedIn: false }),
      account("expired", { authState: "expired" }),
      account("exhausted"),
      account("query-failed"),
    ],
    openAIAccountsGetActive: async () => ({
      activeAccountId: "current",
      isLoggedIn: true,
      message: "",
      syncStatus: { state: "ok" },
    }),
    openAIAccountsQueryQuota: async (id) => {
      queried.push(id);
      if (id === "query-failed") throw new Error("network failure");
      return id === "exhausted" ? { ...quota, rateLimit: { ...quota.rateLimit, limitReached: true } } : quota;
    },
  });
  expect(queried.sort()).toEqual(["exhausted", "query-failed", "ready"]);
  expect(result.accounts.map((item) => item.id)).toEqual(["ready"]);
  expect(result.failedCount).toBe(1);
});

test("account loading failures are surfaced instead of returning an empty successful list", async () => {
  await expect(
    loadAvailableCodexAccounts({
      openAIAccountsList: async () => {
        throw new Error("Cannot load accounts");
      },
      openAIAccountsGetActive: async () => ({
        activeAccountId: null,
        isLoggedIn: false,
        message: "",
        syncStatus: { state: "ok" },
      }),
      openAIAccountsQueryQuota: async () => quota,
    }),
  ).rejects.toThrow("Cannot load accounts");
});

test("account rows show both remaining windows and empty state has no settings navigation", () => {
  const markup = renderLocalized(
    createElement(CodexAccountSwitchList, {
      accounts: [account("Personal")],
      disabled: false,
      switchingId: undefined,
      onSelect: () => undefined,
    }),
    "zh-CN",
  );
  expect(markup).toContain("Personal");
  expect(markup).toContain("5 小时额度");
  expect(markup).toContain("7 天额度");
  expect(markup).toContain("剩余 70%");
  expect(markup).toContain("剩余 20%");
  const empty = renderLocalized(
    createElement(CodexAccountSwitchList, {
      accounts: [],
      disabled: false,
      switchingId: undefined,
      onSelect: () => undefined,
    }),
    "zh-CN",
  );
  expect(empty).toContain("暂无可用账号");
  expect(empty).not.toContain("设置");
});
