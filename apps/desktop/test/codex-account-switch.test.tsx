import { expect, test } from "bun:test";
import { createElement } from "react";
import { CodexAccountSwitchList } from "../src/renderer/CodexAccountSwitchDialog";
import { hasAvailableCodexQuota, loadCodexSwitchAccounts } from "../src/renderer/codex-account-switch";
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

test("opening uses saved quotas without querying accounts", async () => {
  const result = await loadCodexSwitchAccounts({
    openAIAccountsList: async () => [
      account("current"), account("ready"),
      account("missing", { isLoggedIn: false }),
      account("unknown", { quota: undefined }),
      account("exhausted", { quota: { ...quota, rateLimit: { ...quota.rateLimit, limitReached: true } } }),
    ],
    openAIAccountsGetActive: async () => ({
      activeAccountId: "current", isLoggedIn: true, message: "", syncStatus: { state: "ok" },
    }),
    openAIAccountsQueryQuota: async () => { throw new Error("Opening must not query quotas"); },
  });
  expect(result.accounts.map((item) => item.id)).toEqual(["ready", "unknown", "exhausted"]);
  expect(result.failedCount).toBe(0);
});

test("manual refresh retains exhausted and failed accounts but excludes current and logged-out accounts", async () => {
  const queried: string[] = [];
  const result = await loadCodexSwitchAccounts({
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
  }, true);
  expect(queried.sort()).toEqual(["exhausted", "query-failed", "ready"]);
  expect(result.accounts.map((item) => item.id)).toEqual(["ready", "exhausted", "query-failed"]);
  expect(result.accounts[1]?.quota?.rateLimit.limitReached).toBe(true);
  expect(result.accounts[2]?.quota).toEqual(quota);
  expect(result.failedCount).toBe(1);
});

test("account loading failures are surfaced instead of returning an empty successful list", async () => {
  await expect(
    loadCodexSwitchAccounts({
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
      refreshingId: undefined,
      onRefresh: () => undefined,
    }),
    "zh-CN",
  );
  expect(markup).toContain("Personal");
  expect(markup).toContain("5 小时额度");
  expect(markup).toContain("7 天额度");
  expect(markup).toContain("剩余 70%");
  expect(markup).toContain("剩余 20%");
  expect(markup).toContain('aria-label="刷新 Personal 的额度"');
  expect(markup).not.toMatch(/<button[^>]*>[\s\S]*<button[\s\S]*<\/button>[\s\S]*<\/button>/);
  const empty = renderLocalized(
    createElement(CodexAccountSwitchList, {
      accounts: [],
      disabled: false,
      switchingId: undefined,
      onSelect: () => undefined,
      refreshingId: undefined,
      onRefresh: () => undefined,
    }),
    "zh-CN",
  );
  expect(empty).toContain("暂无其他已登录账号");
  expect(empty).not.toContain("设置");
});

test("exhausted and unknown quota accounts stay visible with refresh enabled and switching disabled", () => {
  const markup = renderLocalized(
    createElement(CodexAccountSwitchList, {
      accounts: [
        account("Exhausted", {
          quota: { ...quota, rateLimit: { ...quota.rateLimit, primaryWindow: { ...quota.rateLimit.primaryWindow!, usedPercent: 100 } } },
        }),
        account("Unknown", { quota: undefined }),
      ],
      disabled: false,
      switchingId: undefined,
      refreshingId: undefined,
      onSelect: () => undefined,
      onRefresh: () => undefined,
    }),
    "zh-CN",
  );
  expect(markup).toContain("Exhausted");
  expect(markup).toContain("剩余 0%");
  expect(markup).toContain("暂无可用额度");
  expect(markup).toContain("尚无额度数据");
  expect(markup.match(/class="codex-switch-account" disabled=""/g)).toHaveLength(2);
  expect(markup).toMatch(/aria-label="刷新 Exhausted 的额度"[^>]*>/);
  expect(markup).not.toMatch(/class="mcp-icon-button codex-switch-card-refresh"[^>]*disabled/);
});

test("search matches names and both email sources case-insensitively, including exhausted accounts", () => {
  const accounts = [
    account("Work", { email: "work@example.test" }),
    account("Empty", { quota: { ...quota, email: "empty@example.test", rateLimit: { ...quota.rateLimit, limitReached: true } } }),
  ];
  const render = (query: string) => renderLocalized(
    createElement(CodexAccountSwitchList, {
      accounts,
      query,
      disabled: false,
      switchingId: undefined,
      refreshingId: undefined,
      onSelect: () => undefined,
      onRefresh: () => undefined,
    }),
    "zh-CN",
  );
  for (const query of ["  WORK  ", "WORK@EXAMPLE.TEST"]) {
    expect(render(query)).toContain("<strong>Work</strong>");
    expect(render(query)).not.toContain("<strong>Empty</strong>");
  }
  expect(render("EMPTY@EXAMPLE.TEST")).toContain("<strong>Empty</strong>");
  expect(render("missing")).toContain("未找到匹配的账号");
  expect(render("missing")).not.toContain("暂无其他已登录账号");
  expect(render("  ")).toContain("<strong>Work</strong>");
  expect(render("  ")).toContain("<strong>Empty</strong>");
});
