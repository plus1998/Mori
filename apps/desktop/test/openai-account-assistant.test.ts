import { expect, test } from "bun:test";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { generateAccountTotp, isAccountLoginPage, accountLoginFillScript } from "../src/main/openai-account-assistant-data";
import { OpenAIAccountAssistantView } from "../src/renderer/components/OpenAIAccountAssistantView";
import { OpenAIAccountProfilePresence } from "../src/renderer/components/OpenAIAccountsPanel";

test("TOTP matches every SHA-1 RFC 6238 test vector and rolls over at the period boundary", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  for (const [seconds, code] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]] as const) {
    expect(generateAccountTotp(secret, seconds * 1_000, 8).code).toBe(code);
  }
  expect(generateAccountTotp(secret, 59_999)).toEqual({ code: "287082", remainingSeconds: 1 });
  expect(generateAccountTotp(secret, 60_000).remainingSeconds).toBe(30);
  expect(generateAccountTotp(secret.toLowerCase().match(/.{1,4}/gu)!.join(" "), 59_000, 8).code).toBe("94287082");
});

test("invalid 2FA secrets report a useful error instead of generating a code", () => {
  for (const value of ["", "A", "AAA", "AAAAAA", "not a secret!", "AAAA0AAA", "AB"]) expect(() => generateAccountTotp(value)).toThrow("2FA 密钥");
});

test("only HTTPS OpenAI login origins can receive filled credentials", () => {
  expect(isAccountLoginPage("https://auth.openai.com/log-in/password")).toBe(true);
  for (const url of ["https://auth.openai.com.attacker.test", "http://auth.openai.com", "file:///test", "https://pickup.test"]) expect(isAccountLoginPage(url)).toBe(false);
});

function runFill(field: "email" | "password" | "code", value: string, inputs: Array<{ visible?: boolean; disabled?: boolean; readOnly?: boolean; maxLength?: number }>) {
  class Input {
    disabled = false;
    readOnly = false;
    maxLength = -1;
    visible = true;
    text = "";
    events: string[] = [];
    constructor(props: object) { Object.assign(this, props); }
    get value() { return this.text; }
    set value(value: string) { this.text = value; }
    getClientRects() { return this.visible ? [{}] : []; }
    focus() {}
    dispatchEvent(event: Event) { this.events.push(event.type); }
  }
  const elements = inputs.map((props) => new Input(props));
  const filled = vm.runInNewContext(accountLoginFillScript(field, value), {
    document: { querySelectorAll: () => elements }, HTMLInputElement: Input, Event,
  }) as boolean;
  return { filled, elements };
}

test("fill skips hidden and disabled fields, preserves literal passwords, and does not submit", () => {
  const value = 'password " \\ ${literal}';
  const { filled, elements } = runFill("password", value, [{ visible: false }, { disabled: true }, {}]);
  expect(filled).toBe(true);
  expect(elements.map((element) => element.text)).toEqual(["", "", value]);
  expect(elements[2]?.events).toEqual(["input", "change"]);
  expect(runFill("email", "a@example.test", []).filled).toBe(false);
});

test("fill supports six separate OTP boxes", () => {
  const { elements } = runFill("code", "012345", Array.from({ length: 6 }, () => ({ maxLength: 1 })));
  expect(elements.map((element) => element.text)).toEqual(["0", "1", "2", "3", "4", "5"]);
});

test("assistant masks passwords, shows a live code, and offers mailbox and field actions", () => {
  const markup = renderToStaticMarkup(createElement(OpenAIAccountAssistantView, {
    state: { accountId: "oa_test", name: "Test", email: "a@example.test", hasPassword: true, hasPickupUrl: true, pickupHost: "pickup.test", hasTwoFactorSecret: true, code: "012345", remainingSeconds: 9, loginRemainingSeconds: 599, canFill: true, hasLoginWindow: true, pinned: true },
    busy: false, password: "", notice: "", error: "", onAction: () => {}, onHidePassword: () => {}, onLogin: () => {},
  }));
  expect(markup).toContain("••••••••••••");
  expect(markup).toContain("当前验证码 012345");
  expect(markup).toContain("复制验证码");
  expect(markup).toContain("打开收件箱");
  expect(markup).toContain("登录超时倒计时");
  expect(markup).toContain("09:59");
  expect(markup).toContain("取消置顶");
  expect(markup).not.toContain("打开登录页");
});

test("profile presence identifies saved fields without exposing their values", () => {
  const markup = renderToStaticMarkup(createElement(OpenAIAccountProfilePresence, { fields: { email: true, password: false, pickupUrl: true, twoFactorSecret: false } }));
  expect(markup).toContain('title="邮箱已保存"');
  expect(markup).toContain('title="密码未保存"');
  expect(markup).toContain('title="收件箱已保存"');
});
