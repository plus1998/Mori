import { expect, test } from "bun:test";
import { parseChatGptWebSession, webAuthJson } from "../src/main/chatgpt-web-session";

function session(exp = 2_000_000_000, identity: string | null = "web-account") {
  const claims = { exp, "https://api.openai.com/auth": { chatgpt_account_id: identity } };
  return { accessToken: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`, user: { email: "web@example.test" } };
}

test("Web session requires a fresh token for the expected account and contains no Codex refresh credentials", () => {
  const auth = parseChatGptWebSession(session(), "WEB@example.test", 1_000);
  expect(auth).toMatchObject({ accountId: "web-account", expiresAt: 2_000_000_000_000 });
  expect(JSON.parse(webAuthJson(auth))).toEqual({ tokens: { access_token: auth.accessToken, account_id: "web-account" } });
  expect(() => parseChatGptWebSession(session(), "other@example.test", 1_000)).toThrow("邮箱不一致");
  expect(() => parseChatGptWebSession(session(1), undefined, 2_000)).toThrow("已过期");
  expect(() => parseChatGptWebSession(session(2_000_000_000, null))).toThrow("缺少账号身份");
  expect(() => parseChatGptWebSession({})).toThrow("重新登录 Web");
  expect(() => parseChatGptWebSession({ accessToken: "broken" })).toThrow("无效");
});
