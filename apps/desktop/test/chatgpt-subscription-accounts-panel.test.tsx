import { expect, test } from "bun:test";
import i18next from "i18next";
import { createElement } from "react";
import {
  ChatGPTSubscriptionAccountsPanel,
  formatLastUsed,
  statusLabel,
} from "../src/renderer/ChatGPTSubscriptionAccountsPanel";
import { i18nCatalogs } from "../src/shared/i18n-catalogs";
import type { AppLocale } from "../src/shared/locale";
import { renderLocalized } from "./i18n-test";

const CJK = /[\u3400-\u9fff\u3040-\u30ff]/u;

async function translate(locale: AppLocale) {
  const instance = i18next.createInstance();
  await instance.init({
    resources: i18nCatalogs,
    lng: locale,
    fallbackLng: "en-US",
    supportedLngs: ["zh-CN", "en-US"],
    initImmediate: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance.t.bind(instance);
}

/**
 * Regression guard for the four strings a user circled on the ChatGPT accounts screen: the account
 * count line, the proxy label, the "Configure" link and the last-success timestamp. All four were
 * hardcoded Chinese, and the timestamp additionally formatted itself with the **OS** locale, so an
 * English UI still showed `最近成功 10/16 21:45`.
 */
test("ChatGPT accounts panel renders no Chinese in en-US", () => {
  const markup = renderLocalized(createElement(ChatGPTSubscriptionAccountsPanel), "en-US");

  expect(markup).not.toMatch(CJK);
  expect(markup).toContain("ChatGPT accounts");
  expect(markup).toContain("Add account");
  expect(markup).toContain("Sync models");
  expect(markup).toContain("Plans &amp; workspace");
  // The count line interpolates: 0 accounts (plural form) · 0 available.
  expect(markup).toMatch(/0 accounts<span[^>]*>·<\/span>0 available/u);
});

test("ChatGPT accounts panel keeps Chinese copy in zh-CN", () => {
  const markup = renderLocalized(createElement(ChatGPTSubscriptionAccountsPanel), "zh-CN");

  expect(markup).toContain("ChatGPT 账号");
  expect(markup).toMatch(/0 个账号<span[^>]*>·<\/span>0 个可用/u);
});

test("account row labels and timestamp follow the app locale, not the OS locale", async () => {
  const en = await translate("en-US");
  const zh = await translate("zh-CN");
  const at = new Date(2026, 9, 16, 21, 45).getTime();

  const account = {
    accountId: "acct_1",
    displayName: "demo",
    status: "ready",
    enabled: true,
    hasCredentials: true,
  } as Parameters<typeof statusLabel>[0];

  expect(statusLabel(account, en)).toBe("Available");
  expect(statusLabel(account, zh)).toBe("可用");

  const enStamp = formatLastUsed(at, en, "en-US");
  expect(enStamp).not.toMatch(CJK);
  expect(enStamp).toMatch(/^Last used /u);
  // en-US must not inherit the OS's numeric 24-hour pattern (`10/16 21:45`).
  expect(enStamp).toMatch(/(AM|PM)/u);

  const zhStamp = formatLastUsed(at, zh, "zh-CN");
  expect(zhStamp).toMatch(/^最近成功 /u);
  expect(zhStamp).not.toMatch(/(AM|PM)/u);

  expect(formatLastUsed(undefined, en, "en-US")).toBe("Never used successfully");
  expect(formatLastUsed(undefined, zh, "zh-CN")).toBe("尚未成功调用");
});
