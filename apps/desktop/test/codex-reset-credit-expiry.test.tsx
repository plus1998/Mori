import { expect, test } from "bun:test";
import { createElement } from "react";
import { CodexResetCreditExpiry } from "../src/renderer/CodexResetCreditExpiry";
import type { OpenAIAccountResetCredits } from "../src/shared/openai-account";
import { formatAppDateTime } from "../src/shared/locale";
import { renderLocalized } from "./i18n-test";

const resetCredits: OpenAIAccountResetCredits = {
  availableCount: 5,
  credits: [
    { id: "never", expiresAt: null },
    { id: "later", expiresAt: 1_800_020_000 },
    { id: "sooner", expiresAt: 1_800_010_000 },
    { id: "same-expiry", expiresAt: 1_800_010_000 },
  ],
};

test("reset expiries are grouped, sorted and localized with an explicit local time zone", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const markup = renderLocalized(createElement(CodexResetCreditExpiry, resetCredits), locale);
    const time = formatAppDateTime(locale, 1_800_010_000_000, {
      year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    });
    expect(markup).toContain(locale === "zh-CN" ? `2 张 · 有效期至 ${time}` : `2 resets · Expires ${time}`);
    expect(markup).toContain(locale === "zh-CN" ? "1 张 · 不过期" : "1 reset · Does not expire");
    expect(markup).toContain(locale === "zh-CN" ? "1 张 · 有效期未知" : "1 reset · Expiry unknown");
    expect(markup.indexOf(time)).toBeLessThan(markup.indexOf(locale === "zh-CN" ? "1 张 · 不过期" : "1 reset · Does not expire"));
  }
});

test("missing expiry details remain unknown, and an empty balance hides the expiry summary", () => {
  const markup = renderLocalized(createElement(CodexResetCreditExpiry, { availableCount: 5, credits: [] }), "zh-CN");
  expect(markup).toContain("5 张 · 有效期未知");
  expect(markup).not.toContain("不过期");
  expect(renderLocalized(createElement(CodexResetCreditExpiry, { availableCount: 0, credits: [] }), "zh-CN")).toBe("");
});
