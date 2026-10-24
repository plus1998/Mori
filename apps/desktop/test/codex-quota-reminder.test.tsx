import { expect, test } from "bun:test";
import { createElement } from "react";
import { CodexQuotaReminder, CodexQuotaReminderCard } from "../src/renderer/CodexQuotaReminder";
import { ComposerThreadUsagePills } from "../src/renderer/ComposerThreadUsagePills";
import {
  CODEX_AUTH_RECENT_USE_MS,
  CodexQuotaMonitor,
  type CodexQuotaReminderSnapshot,
  codexQuotaDisplayWindow,
  codexQuotaReminderKey,
  hasRecentCodexAuthUsage,
  isCodexAuthConversation,
  isCodexAuthThread,
  lowCodexQuotaWindows,
} from "../src/renderer/codex-quota-reminder";
import type { ThreadSummary } from "../src/shared/ipc";
import type { OpenAIAccount, OpenAIAccountQuota } from "../src/shared/openai-account";
import { renderLocalized } from "./i18n-test";

const quota: OpenAIAccountQuota = {
  planType: "plus",
  email: "user@example.test",
  fetchedAt: Date.now(),
  resetCreditsAvailable: 2,
  rateLimit: {
    allowed: true,
    limitReached: false,
    primaryWindow: {
      usedPercent: 94,
      limitWindowSeconds: 18000,
      resetAfterSeconds: 3600,
      resetAt: 1800000000,
    },
    secondaryWindow: {
      usedPercent: 50,
      limitWindowSeconds: 604800,
      resetAfterSeconds: 86400,
      resetAt: 1800000000,
    },
  },
};
const snapshot: CodexQuotaReminderSnapshot = {
  accountId: "A",
  accountName: "Current",
  quota,
  switching: false,
};
const account: OpenAIAccount = {
  id: "A",
  name: "Current",
  proxyMode: "system",
  isLoggedIn: true,
  authState: "configured",
  hasProfileData: false,
  createdAt: "2026-10-21",
};
const active = (id: string | null = "A") => ({
  activeAccountId: id,
  isLoggedIn: id !== null,
  message: "",
  syncStatus: { state: "ok" as const },
});
const bridge = () => ({
  openAIAccountsGetActive: async () => active(),
  openAIAccountsList: async () => [{ ...account, quota }],
  openAIAccountsQueryQuota: async (_id: string) => quota,
});

test("composer quota prefers the shortest period unless a longer period is exhausted", () => {
  const fiveHour = { ...quota.rateLimit.primaryWindow!, usedPercent: 13 };
  const weekly = { ...quota.rateLimit.secondaryWindow!, usedPercent: 26 };
  expect(codexQuotaDisplayWindow([fiveHour, weekly])).toBe(fiveHour);
  expect(codexQuotaDisplayWindow([weekly, fiveHour])).toBe(fiveHour);
  expect(codexQuotaDisplayWindow([fiveHour, { ...weekly, usedPercent: 99.9 }])).toBe(fiveHour);
  const exhausted = { ...weekly, usedPercent: 100 };
  expect(codexQuotaDisplayWindow([fiveHour, exhausted])).toBe(exhausted);
  expect(codexQuotaDisplayWindow([exhausted, fiveHour])).toBe(exhausted);
  expect(codexQuotaDisplayWindow([weekly])).toBe(weekly);
  expect(codexQuotaDisplayWindow([])).toBeUndefined();
});

test("a fresh composer renders the account quota control without thread usage", () => {
  const markup = renderLocalized(createElement(ComposerThreadUsagePills, {
    accountQuota: createElement(CodexQuotaReminder, {
      variant: "composer",
      threads: [],
      onSwitchAccount: () => undefined,
      eco: {
        ...bridge(),
        openAIAccountsResetQuota: async () => ({ outcome: "nothingToReset" as const }),
        onOpenAIAccountsChanged: () => () => undefined,
      },
    }),
  }), "zh-CN");
  expect(markup).toContain("codex-quota-mini");
  expect(markup).not.toContain("thread-info-float-pill-cost");
  expect(markup).not.toContain("thread-info-context-ring");
});

test("recent-use tracking only enables Codex Auth within 30 minutes or while running", () => {
  const now = Date.now();
  const thread = {
    coreKind: "codex",
    status: "completed",
    updatedAt: new Date(now - 1000).toISOString(),
    runtimeConfig: { orchestrationSelection: { mainAgentConfigId: "__openai_official__" } },
  } as ThreadSummary;
  expect(hasRecentCodexAuthUsage([thread], now)).toBe(true);
  expect(hasRecentCodexAuthUsage([{ ...thread, coreKind: "claude" }], now)).toBe(false);
  const old = { ...thread, updatedAt: new Date(now - CODEX_AUTH_RECENT_USE_MS - 1).toISOString() };
  expect(hasRecentCodexAuthUsage([old], now)).toBe(false);
  expect(isCodexAuthThread(old)).toBe(true);
  expect(isCodexAuthThread({ ...old, coreKind: "claude" })).toBe(false);
  expect(hasRecentCodexAuthUsage([{ ...old, status: "running" }], now)).toBe(true);
  expect(
    hasRecentCodexAuthUsage(
      [
        {
          ...thread,
          runtimeConfig: {
            ...thread.runtimeConfig!,
            mainAgentModelOverride: { providerId: "third-party", modelId: "m" },
          },
        },
      ],
      now,
    ),
  ).toBe(false);
});

test("any real quota window below 10% triggers, and exactly 10% does not", () => {
  for (const [usedPercent, count] of [
    [90, 0],
    [90.1, 1],
    [100, 1],
    [NaN, 0],
    [-2, 0],
    [101, 0],
  ]) {
    expect(
      lowCodexQuotaWindows({
        ...quota,
        rateLimit: {
          ...quota.rateLimit,
          primaryWindow: { ...quota.rateLimit.primaryWindow!, usedPercent: usedPercent! },
        },
      }),
    ).toHaveLength(count!);
  }
  const low = lowCodexQuotaWindows({
    ...quota,
    rateLimit: {
      ...quota.rateLimit,
      secondaryWindow: { ...quota.rateLimit.secondaryWindow!, usedPercent: 98 },
    },
  });
  expect(low.map((window) => window.usedPercent)).toEqual([98, 94]);
});

test("mounts, repeated UI events and identity changes only read cache; manual refresh queries upstream", async () => {
  const api = bridge();
  const queried: string[] = [];
  api.openAIAccountsQueryQuota = async (id) => { queried.push(id); return quota; };
  let enabled = false;
  const updates: (CodexQuotaReminderSnapshot | undefined)[] = [];
  const monitor = new CodexQuotaMonitor(api, { enabled: () => enabled,
    onChange: (value) => updates.push(value), onError() {} });
  await monitor.refresh();
  enabled = true;
  await monitor.refresh();
  for (let i = 0; i < 10; i++) await monitor.accountsChanged();
  expect(queried).toEqual([]);
  expect(updates.at(-1)).toEqual(snapshot);
  api.openAIAccountsGetActive = async () => active("B");
  api.openAIAccountsList = async () => [{ ...account, id: "B", name: "Next", quota }];
  await monitor.accountsChanged();
  expect(updates.at(-1)?.accountId).toBe("B");
  expect(queried).toEqual([]);
  await monitor.refresh(true);
  expect(queried).toEqual(["B"]);
  monitor.dispose();
  await monitor.refresh(true);
  expect(queried).toEqual(["B"]);
});

test("switching identity while loading a cache cannot publish the previous account's snapshot", async () => {
  const api = bridge();
  let selected = "A";
  let finish!: (value: OpenAIAccount[]) => void;
  const pending = new Promise<OpenAIAccount[]>((resolve) => { finish = resolve; });
  api.openAIAccountsGetActive = async () => active(selected);
  api.openAIAccountsList = async () => selected === "A" ? pending : [{ ...account, id: "B", name: "Next", quota }];
  const updates: (CodexQuotaReminderSnapshot | undefined)[] = [];
  const monitor = new CodexQuotaMonitor(api, { enabled: () => true,
    onChange: (value) => updates.push(value), onError() {} });
  const first = monitor.refresh();
  await Promise.resolve();
  selected = "B";
  finish([{ ...account, quota }]);
  await first;
  await monitor.refresh();
  expect(updates.filter(Boolean).map((value) => value!.accountId)).toEqual(["B"]);
  monitor.dispose();
});

test("a failed automatic read keeps its timestamped cache and exposes the actual failure", async () => {
  const api = bridge();
  api.openAIAccountsList = async () => [{ ...account, quota, quotaRefresh: { attemptedAt: Date.now(), error: "503 offline" } }];
  const errors: string[] = [];
  const updates: (CodexQuotaReminderSnapshot | undefined)[] = [];
  const monitor = new CodexQuotaMonitor(api, { enabled: () => true,
    onChange: (value) => updates.push(value), onError: (error) => errors.push(error) });
  await monitor.refresh();
  expect(updates.at(-1)?.quota).toEqual(quota);
  expect(errors).toEqual(["503 offline"]);
  api.openAIAccountsQueryQuota = async () => { throw new Error("manual offline"); };
  await monitor.refresh(true);
  expect(errors.at(-1)).toBe("manual offline");
  expect(updates.at(-1)?.quota).toEqual(quota);
  monitor.dispose();
});

test("quota's own change event and reconcile timestamps never create upstream refresh feedback", async () => {
  const api = bridge();
  let queries = 0;
  let stamp = 0;
  let monitor!: CodexQuotaMonitor;
  api.openAIAccountsGetActive = async () => ({ ...active(), syncStatus: { state: "ok" as const,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + stamp++ * 5000).toISOString() } });
  api.openAIAccountsQueryQuota = async () => { queries++; void monitor.accountsChanged(); return quota; };
  monitor = new CodexQuotaMonitor(api, { enabled: () => true, onChange() {}, onError() {} });
  await monitor.refresh(true);
  await monitor.accountsChanged();
  await monitor.refresh();
  expect(queries).toBe(1);
  monitor.dispose();
});

test("background results update the cached snapshot without an upstream query", async () => {
  const api = bridge();
  let queries = 0;
  api.openAIAccountsQueryQuota = async () => { queries++; return quota; };
  const updates: (CodexQuotaReminderSnapshot | undefined)[] = [];
  const monitor = new CodexQuotaMonitor(api, { enabled: () => true,
    onChange: (value) => updates.push(value), onError() {} });
  await monitor.refresh();
  const refreshed = { ...quota, fetchedAt: Date.now() + 1000 };
  api.openAIAccountsList = async () => [{ ...account, quota: refreshed }];
  await monitor.accountsChanged();
  expect(updates.at(-1)?.quota).toEqual(refreshed);
  expect(queries).toBe(0);
  monitor.dispose();
});

test("an account with no cached quota stays unknown until a manual refresh", async () => {
  const api = bridge();
  api.openAIAccountsList = async () => [account];
  let queries = 0;
  api.openAIAccountsQueryQuota = async () => { queries++; return quota; };
  const updates: (CodexQuotaReminderSnapshot | undefined)[] = [];
  const monitor = new CodexQuotaMonitor(api, { enabled: () => true,
    onChange: (value) => updates.push(value), onError() {} });
  await monitor.refresh();
  expect(queries).toBe(0);
  expect(updates).toEqual([undefined]);
  monitor.dispose();
});

test("repeated explicit refreshes share one in-flight request", async () => {
  const api = bridge();
  let finish!: (value: OpenAIAccountQuota) => void;
  let queried = 0;
  const pending = new Promise<OpenAIAccountQuota>((resolve) => { finish = resolve; });
  api.openAIAccountsQueryQuota = async () => { queried++; return pending; };
  const monitor = new CodexQuotaMonitor(api, { enabled: () => true, onChange() {}, onError() {} });
  const first = monitor.refresh(true);
  await Promise.resolve();
  const others = [monitor.refresh(true), monitor.refresh(true)];
  expect(queried).toBe(1);
  finish(quota);
  await Promise.all([first, ...others]);
  expect(queried).toBe(1);
  monitor.dispose();
});

test("reminder shows reference-card content and disables reset without credits or while switching", () => {
  const props = { snapshot, onReset() {}, onSwitchAccount() {}, onDismiss() {} };
  const html = renderLocalized(createElement(CodexQuotaReminderCard, props), "zh-CN");
  for (const text of [
    "剩余 6% 使用量",
    "当前使用账号：Current",
    "5 小时",
    "切换账号",
    "使用重置",
    "可用重置：2 次",
    "将于",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("添加额度");
  expect(html).not.toContain("升级");
  for (const next of [
    { ...snapshot, switching: true },
    { ...snapshot, quota: { ...quota, resetCreditsAvailable: 0 } },
  ]) {
    const disabled = renderLocalized(
      createElement(CodexQuotaReminderCard, { ...props, snapshot: next }),
      "zh-CN",
    );
    expect(disabled).toMatch(/<button[^>]*disabled=""[^>]*>使用重置<\/button>/);
  }
});

test("the sidebar reminder only follows the conversation on screen", () => {
  const now = Date.now();
  const codexThread = {
    id: "codex",
    coreKind: "codex",
    status: "completed",
    updatedAt: new Date(now - 1000).toISOString(),
    runtimeConfig: { orchestrationSelection: { mainAgentConfigId: "__openai_official__" } },
  } as ThreadSummary;
  const claudeThread = {
    ...codexThread,
    id: "claude",
    coreKind: "claude",
    status: "running",
  } as ThreadSummary;
  expect(isCodexAuthConversation([codexThread, claudeThread], "codex")).toBe(true);
  expect(isCodexAuthConversation([codexThread, claudeThread], "claude")).toBe(false);
  // A Codex thread that ran recently must not leak the reminder into a Claude conversation.
  expect(isCodexAuthConversation([{ ...codexThread, status: "running" }, claudeThread], "claude")).toBe(
    false,
  );
  // Fresh drafts have no thread yet and fall back to recent usage.
  expect(isCodexAuthConversation([codexThread], undefined)).toBe(true);
  expect(isCodexAuthConversation([claudeThread], undefined)).toBe(false);
});

test("the reminder key is stable across refetches and changes when a window resets", () => {
  expect(codexQuotaReminderKey({ ...snapshot, quota: { ...quota, fetchedAt: Date.now() } })).toBe(
    codexQuotaReminderKey(snapshot),
  );
  const high = {
    ...quota,
    rateLimit: {
      ...quota.rateLimit,
      primaryWindow: { ...quota.rateLimit.primaryWindow!, usedPercent: 12 },
      secondaryWindow: { ...quota.rateLimit.secondaryWindow!, usedPercent: 20 },
    },
  };
  expect(codexQuotaReminderKey({ ...snapshot, quota: high })).toBeUndefined();
  expect(
    codexQuotaReminderKey({
      ...snapshot,
      quota: {
        ...quota,
        rateLimit: {
          ...quota.rateLimit,
          primaryWindow: { ...quota.rateLimit.primaryWindow!, resetAt: 1800099999 },
        },
      },
    }),
  ).not.toBe(codexQuotaReminderKey(snapshot));
});

test("the sidebar reminder hides above 10% headroom and is dismissible when it shows", () => {
  const props = { onReset() {}, onSwitchAccount() {}, onDismiss() {} };
  const shown = renderLocalized(createElement(CodexQuotaReminderCard, { ...props, snapshot }), "zh-CN");
  expect(shown).toContain("剩余 6% 使用量");
  expect(shown).toContain('aria-label="关闭"');
  expect(shown).not.toContain("ChatGPT Login 账号额度");
  const high = {
    ...snapshot,
    quota: {
      ...quota,
      rateLimit: {
        ...quota.rateLimit,
        primaryWindow: { ...quota.rateLimit.primaryWindow!, usedPercent: 88 },
        secondaryWindow: { ...quota.rateLimit.secondaryWindow!, usedPercent: 20 },
      },
    },
  };
  expect(renderLocalized(createElement(CodexQuotaReminderCard, { ...props, snapshot: high }), "zh-CN")).toBe(
    "",
  );
});

test("billing card shows every quota window even when no quota is low", () => {
  const html = renderLocalized(
    createElement(CodexQuotaReminderCard, {
      snapshot: {
        ...snapshot,
        quota: {
          ...quota,
          rateLimit: {
            ...quota.rateLimit,
            primaryWindow: { ...quota.rateLimit.primaryWindow!, usedPercent: 25 },
          },
        },
      },
      variant: "billing",
      onReset() {},
      onSwitchAccount() {},
    }),
    "zh-CN",
  );
  for (const text of [
    "ChatGPT Login 账号额度",
    "当前使用账号：Current",
    "5 小时",
    "7 天",
    "75%",
    "50%",
    "切换账号",
    "使用重置",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('aria-label="关闭"');
});
