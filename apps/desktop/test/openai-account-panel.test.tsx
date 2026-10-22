import { expect, test } from "bun:test";
import { createElement } from "react";
import {
  OpenAIAccountProxyFields,
  OpenAIAccountProfileFields,
  OpenAIAccountQuotaSummary,
  OpenAIAccountSwitchStatus,
} from "../src/renderer/components/OpenAIAccountsPanel";
import type { OpenAIAccountQuota } from "../src/shared/openai-account";
import { renderLocalized } from "./i18n-test";

const cachedQuota: OpenAIAccountQuota = {
  planType: "plus",
  email: "demo@example.test",
  rateLimit: {
    allowed: true,
    limitReached: false,
    primaryWindow: { usedPercent: 37, limitWindowSeconds: 18_000, resetAfterSeconds: 3_600, resetAt: 0 },
    secondaryWindow: null,
  },
  resetCreditsAvailable: 2,
  fetchedAt: Date.parse("2025-01-01T08:30:00.000Z"),
};

test("account profile editor renders all four fields and masks secrets by default", () => {
  const markup = renderLocalized(
    createElement(OpenAIAccountProfileFields, {
      email: "demo@example.test",
      password: "fictional password",
      pickupUrl: "https://pickup.example.test/?key=demo",
      twoFactorSecret: "JBSWY3DPEHPK3PXP",
      instanceKey: "test-account",
      onEmailChange: () => undefined,
      onPasswordChange: () => undefined,
      onPickupUrlChange: () => undefined,
      onTwoFactorSecretChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toMatch(/type="email"[^>]*value="demo@example\.test"/u);
  expect(markup).toContain('type="url"');
  expect(markup).toContain('value="https://pickup.example.test/?key=demo"');
  expect(markup).toMatch(/type="password"[^>]*value="fictional password"/u);
  expect(markup).toMatch(/type="password"[^>]*value="JBSWY3DPEHPK3PXP"/u);
  expect(markup).toContain('aria-label="显示内容"');
  expect(markup).toContain('aria-label="复制密码"');
  expect(markup).toContain('aria-label="复制2FA 密钥"');
});

test("account profile editor labels every field in English for en-US", () => {
  const markup = renderLocalized(
    createElement(OpenAIAccountProfileFields, {
      email: "demo@example.test",
      password: "fictional password",
      pickupUrl: "https://pickup.example.test/?key=demo",
      twoFactorSecret: "JBSWY3DPEHPK3PXP",
      instanceKey: "test-account",
      onEmailChange: () => undefined,
      onPasswordChange: () => undefined,
      onPickupUrlChange: () => undefined,
      onTwoFactorSecretChange: () => undefined,
    }),
    "en-US",
  );

  expect(markup).toContain("Sign-in profile");
  expect(markup).toContain(">Email<");
  expect(markup).toContain(">Password<");
  expect(markup).toContain(">2FA secret<");
  expect(markup).toContain(">Inbox address<");
  expect(markup).toContain('aria-label="Show value"');
  expect(markup).toContain('aria-label="Copy Password"');
  expect(markup).not.toMatch(/[\u3400-\u9fff]/u);
});

test("account proxy editor exposes system, direct, and manual modes", () => {
  const render = (locale: "zh-CN" | "en-US", mode: "system" | "direct" | "manual") =>
    renderLocalized(createElement(OpenAIAccountProxyFields, {
      mode,
      proxyUrl: "http://127.0.0.1:7890",
      onModeChange: () => undefined,
      onProxyUrlChange: () => undefined,
    }), locale);

  const zh = render("zh-CN", "system");
  expect(zh).toContain("系统代理");
  expect(zh).toContain("不使用代理");
  expect(zh).toContain("手动代理");
  expect(zh).not.toContain('type="url"');
  expect(render("zh-CN", "manual")).toContain('type="url"');

  const en = render("en-US", "direct");
  expect(en).toContain("System proxy");
  expect(en).toContain("No proxy");
  expect(en).toContain("Manual proxy");
  expect(en).not.toMatch(/[\u3400-\u9fff]/u);
});

test("pending account switch shows the last target and a cancel action", () => {
  const markup = renderLocalized(
    createElement(OpenAIAccountSwitchStatus, {
      activeAccountId: "account-current",
      activeAccountName: "当前账号",
      pendingAccountId: "account-target",
      pendingAccountName: "目标账号",
      busy: false,
      onCancel: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("待切换：目标账号");
  expect(markup).toContain("取消切换");
  expect(markup).toContain('class="codex-active-summary"');
});

test("credential replacement on the active account has a distinct pending label", () => {
  const markup = renderLocalized(
    createElement(OpenAIAccountSwitchStatus, {
      activeAccountId: "account-current",
      activeAccountName: "当前账号",
      pendingAccountId: "account-current",
      pendingAccountName: "当前账号",
      busy: false,
      onCancel: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("凭据待应用：当前账号");
  expect(markup).toContain("取消凭据更新");
});

test("pending switch labels translate while the account name stays verbatim", () => {
  const markup = renderLocalized(
    createElement(OpenAIAccountSwitchStatus, {
      activeAccountId: "account-current",
      activeAccountName: "当前账号",
      pendingAccountId: "account-target",
      pendingAccountName: "目标账号",
      busy: false,
      onCancel: () => undefined,
    }),
    "en-US",
  );

  expect(markup).toContain("Switch pending: 目标账号");
  expect(markup).toContain("Cancel switch");
});

test("cached quota shows the last successful refresh time after credentials expire", () => {
  const markup = renderLocalized(
    createElement(OpenAIAccountQuotaSummary, {
      quota: cachedQuota,
      isLoggedIn: false,
      loading: false,
      error: undefined,
    }),
    "zh-CN",
  );
  expect(markup).toContain("剩余 63%");
  expect(markup).toContain("2 次重置");
  expect(markup).toContain('dateTime="2025-01-01T08:30:00.000Z"');
  expect(markup).toContain("上次刷新");
  expect(markup).toContain("已到重置时间，待刷新");
  expect(markup).not.toContain("1h 后重置");
});

test("cached quota renders English quota copy and app-locale timestamps for en-US", () => {
  const markup = renderLocalized(
    createElement(OpenAIAccountQuotaSummary, {
      quota: cachedQuota,
      isLoggedIn: false,
      loading: false,
      error: undefined,
    }),
    "en-US",
  );
  expect(markup).toContain("63% left");
  expect(markup).toContain("2 resets");
  expect(markup).toContain("Last refreshed");
  expect(markup).toContain("Reset due, waiting to refresh");
  // The timestamp must follow the app locale, not the OS locale.
  expect(markup).toMatch(/Last refreshed \d+\/\d+, \d\d:\d\d:\d\d (AM|PM)/u);
});

test("refreshing quota keeps the cached values visible with a loading indicator", () => {
  const markup = renderLocalized(
    createElement(OpenAIAccountQuotaSummary, {
      quota: cachedQuota,
      isLoggedIn: true,
      loading: true,
      error: undefined,
    }),
    "zh-CN",
  );
  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain('aria-label="正在刷新额度"');
  expect(markup).toContain("剩余 63%");
  expect(markup).toContain("上次刷新");
});

test("quota errors replace cached values with the actual failure, including during retry", () => {
  for (const loading of [false, true]) {
    const markup = renderLocalized(
      createElement(OpenAIAccountQuotaSummary, {
        quota: cachedQuota,
        isLoggedIn: true,
        loading,
        error: "OpenAI quota request failed with status 503.",
      }),
      "zh-CN",
    );
    expect(markup).toContain('role="alert">额度刷新失败：OpenAI quota request failed with status 503.</span>');
    expect(markup).not.toContain("剩余 63%");
    expect(markup).not.toContain('role="meter"');
    expect(markup).not.toContain("2 次重置");
    expect(markup).not.toContain("已到重置时间，待刷新");
    expect(markup).not.toContain("上次刷新");
    expect(markup).not.toContain("显示缓存");
  }
});

test("quota error shows the actual failure with a localized label for en-US", () => {
  const markup = renderLocalized(
    createElement(OpenAIAccountQuotaSummary, {
      quota: undefined,
      isLoggedIn: true,
      loading: false,
      error: "OpenAI quota request failed with status 503.",
    }),
    "en-US",
  );
  expect(markup).toContain('role="alert">Quota refresh failed: OpenAI quota request failed with status 503.</span>');
  expect(markup).not.toMatch(/[\u3400-\u9fff]/u);
});

test("quota summary shows five-hour and weekly windows with their own usage and reset times", () => {
  const fetchedAt = Date.now();
  const quota: OpenAIAccountQuota = {
    ...cachedQuota,
    fetchedAt,
    rateLimit: {
      allowed: false,
      limitReached: true,
      primaryWindow: { usedPercent: 37, limitWindowSeconds: 18_000, resetAfterSeconds: 3_600, resetAt: 0 },
      secondaryWindow: { usedPercent: 100, limitWindowSeconds: 604_800, resetAfterSeconds: 172_800, resetAt: 0 },
    },
  };
  const render = (locale: "zh-CN" | "en-US") => renderLocalized(createElement(OpenAIAccountQuotaSummary, {
    quota, isLoggedIn: true, loading: false, error: undefined,
  }), locale);
  const zh = render("zh-CN");
  expect(zh).toContain("5 小时额度");
  expect(zh).toContain("周额度");
  expect(zh).toMatch(/class="is-ok">剩余 63%/u);
  expect(zh).toMatch(/class="is-limited">剩余 0%/u);
  expect(zh).toContain('aria-valuenow="63"');
  expect(zh).toContain('aria-valuenow="0"');
  expect(zh).toContain("1h 后重置");
  expect(zh).toContain("2d 后重置");
  const en = render("en-US");
  expect(en).toContain("5-hour quota");
  expect(en).toContain("Weekly quota");
});

test("a single returned weekly window is labelled by duration without inventing a five-hour window", () => {
  const markup = renderLocalized(createElement(OpenAIAccountQuotaSummary, {
    quota: {
      ...cachedQuota,
      rateLimit: { ...cachedQuota.rateLimit, primaryWindow: {
        usedPercent: 12, limitWindowSeconds: 604_800, resetAfterSeconds: 0, resetAt: 0,
      } },
    },
    isLoggedIn: true, loading: false, error: undefined,
  }), "zh-CN");
  expect(markup).toContain("周额度");
  expect(markup).toContain("剩余 88%");
  expect(markup).not.toContain("5 小时额度");
});

test("expired accounts without cached quota still show refresh progress and the actual failure", () => {
  for (const loading of [true, false]) {
    const markup = renderLocalized(createElement(OpenAIAccountQuotaSummary, {
      quota: undefined, isLoggedIn: false, loading,
      error: loading ? undefined : "refresh token expired; sign in again",
    }), "zh-CN");
    expect(markup).toContain(loading ? "正在刷新额度" : "额度刷新失败");
    if (!loading) expect(markup).toContain('role="alert">额度刷新失败：refresh token expired; sign in again</span>');
  }
});
