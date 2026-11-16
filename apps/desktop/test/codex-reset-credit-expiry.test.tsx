import { expect, test } from "bun:test";
import { createElement } from "react";
import { CodexResetCreditExpiry } from "../src/renderer/CodexResetCreditExpiry";
import type { OpenAIAccountQuota } from "../src/shared/openai-account";
import { formatAppDateTime } from "../src/shared/locale";
import { renderLocalized } from "./i18n-test";

const quota: OpenAIAccountQuota = {
  planType: "plus", email: "", fetchedAt: 1_800_000_000_000,
  rateLimit: { allowed: true, limitReached: false, primaryWindow: null, secondaryWindow: null },
  resetCreditsAvailable: 5,
  resetCredits: [
    { id: "never", expiresAt: null },
    { id: "later", expiresAt: 1_800_020_000 },
    { id: "sooner", expiresAt: 1_800_010_000 },
    { id: "same-expiry", expiresAt: 1_800_010_000 },
  ],
};

test("reset expiries are grouped, sorted and localized with an explicit local time zone", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const markup = renderLocalized(createElement(CodexResetCreditExpiry, { quota }), locale);
    const time = formatAppDateTime(locale, 1_800_010_000_000, {
      year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    });
    expect(markup).toContain(locale === "zh-CN" ? `2 张 · 有效期至 ${time}` : `2 resets · Expires ${time}`);
    expect(markup).toContain(locale === "zh-CN" ? "1 张 · 不过期" : "1 reset · Does not expire");
    expect(markup).toContain(locale === "zh-CN" ? "1 张 · 有效期未知" : "1 reset · Expiry unknown");
    expect(markup.indexOf(time)).toBeLessThan(markup.indexOf(locale === "zh-CN" ? "1 张 · 不过期" : "1 reset · Does not expire"));
  }
});

test("old snapshots and count-only or empty details remain unknown, never non-expiring", () => {
  for (const resetCredits of [undefined, null, []]) {
    const { resetCredits: _details, ...countOnly } = quota;
    const markup = renderLocalized(createElement(CodexResetCreditExpiry, {
      quota: { ...countOnly, ...(resetCredits === undefined ? {} : { resetCredits }) },
    }), "zh-CN");
    expect(markup).toContain("5 张 · 有效期未知");
    expect(markup).not.toContain("不过期");
  }
  expect(renderLocalized(createElement(CodexResetCreditExpiry, {
    quota: { ...quota, resetCreditsAvailable: 0 },
  }), "zh-CN")).toBe("");
});
