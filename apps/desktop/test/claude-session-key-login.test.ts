import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeLoginService } from "../src/main/claude-login";
import { exchangeClaudeSessionKey, validateClaudeSessionKey, type ClaudeSessionKeyNetwork } from "../src/main/claude-session-key-oauth";

const personalOrg = "10000000-0000-4000-8000-000000000000";
const teamOrg = "20000000-0000-4000-8000-000000000000";
const scopes = "user:profile user:inference user:sessions:claude_code";

test.skipIf(process.platform === "win32").each([
  { mode: "direct", proxy: "direct", endpoint: undefined },
  { mode: "manual", proxy: "http://account-proxy.example:8080/", endpoint: "http://account-proxy.example:8080/" },
])("sessionKey sign-in and auth commands use the account's $mode route", async ({ proxy, endpoint }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-claude-session-key-test-"));
  const executable = path.join(root, "claude");
  const requests: string[] = [];
  let state: string;
  let challenge: string;
  const fetcher: ClaudeSessionKeyNetwork["fetch"] = async (url, init) => {
    requests.push(url);
    expect(init?.redirect).toBe("error");
    const cookie = new Headers(init?.headers).get("cookie");
    if (url.endsWith("/api/organizations")) {
      expect(cookie).toBe("sessionKey=example-session-cookie");
      return Response.json([{ uuid: personalOrg }, { uuid: teamOrg, raven_type: "team" }]);
    }
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/authorize")) {
      expect(url).toBe(`https://claude.ai/v1/oauth/${teamOrg}/authorize`);
      expect(cookie).toBe("sessionKey=example-session-cookie");
      expect(body.organization_uuid).toBe(teamOrg);
      expect(body.code_challenge_method).toBe("S256");
      state = body.state;
      challenge = body.code_challenge;
      return Response.json({ redirect_uri: `${body.redirect_uri}?code=example-auth-code&state=${state}` });
    }
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(cookie).toBeNull();
    expect(body.code).toBe("example-auth-code");
    expect(body.state).toBe(state);
    expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(challenge);
    return Response.json({ refresh_token: "example-refresh-token", scope: scopes });
  };
  try {
    await fs.writeFile(executable, `#!/bin/sh
[ "$HTTPS_PROXY" = '${endpoint ?? ""}' ] || exit 8
[ "$https_proxy" = '${endpoint ?? ""}' ] || exit 9
[ "$NO_PROXY" = '${endpoint ? "127.0.0.1,localhost,::1" : "*"}' ] || exit 10
case "$*" in
  'auth login --claudeai')
    [ . -ef "$CLAUDE_CONFIG_DIR" ] || exit 2
    [ "$CLAUDE_CODE_OAUTH_REFRESH_TOKEN" = 'example-refresh-token' ] || exit 3
    [ "$CLAUDE_CODE_OAUTH_SCOPES" = '${scopes}' ] || exit 4
    touch "$CLAUDE_CONFIG_DIR/signed-in"
    ;;
  'auth status')
    [ -z "$CLAUDE_CODE_OAUTH_REFRESH_TOKEN" ] || exit 5
    if [ ! -f "$CLAUDE_CONFIG_DIR/signed-in" ]; then
      printf '{"loggedIn":false,"authMethod":"none","configDirectory":"%s"}\n' "$CLAUDE_CONFIG_DIR"
      exit 1
    fi
    printf '{"loggedIn":true,"authMethod":"claude.ai","configDirectory":"%s"}\n' "$CLAUDE_CONFIG_DIR"
    ;;
  'auth logout') rm -f "$CLAUDE_CONFIG_DIR/signed-in" ;;
  *) exit 7 ;;
esac
`, { mode: 0o700 });
    const unavailable = async () => { throw new Error("An explicit sessionKey login route should not open a browser or resolve the system proxy"); };
    let hasWebSession = false;
    const service = new ClaudeLoginService(root, () => executable, unavailable, {
      open: unavailable, attachAssistant: unavailable, clear: unavailable,
    }, async (_id, networkProxy) => {
      expect(networkProxy).toBe(endpoint);
      return { fetch: fetcher, close: async () => {} };
    }, {
      open: async () => { hasWebSession = true; },
      hasSession: async () => hasWebSession,
      clear: async () => { hasWebSession = false; },
    });
    const id = await service.save({ name: "Example", proxy });
    expect(await service.loginWithSessionKey(id, " example-session-cookie ")).toBe(true);
    expect(requests).toHaveLength(3);
    expect(await service.list()).toEqual([{ id, name: "Example", proxy, status: "signedIn", webStatus: "noSession" }]);
    await service.openWeb(id);
    await service.logoutWeb(id);
    expect((await service.list())[0]).toMatchObject({ status: "signedIn", webStatus: "noSession" });
    await service.openWeb(id);
    await service.logout(id);
    expect((await service.list())[0]).toMatchObject({ status: "signedOut", webStatus: "hasSession" });
    const profile = await fs.readFile(path.join(root, id, "profile.json"), "utf8");
    expect(JSON.parse(profile)).toEqual({ id, name: "Example", proxy, signInProfile: {} });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects a pasted Cookie header and strips provider response bodies from login errors", async () => {
  expect(() => validateClaudeSessionKey("sessionKey=one; another=two")).toThrow();
  const unauthorized = async () => new Response("example-session-cookie", { status: 401 });
  await expect(exchangeClaudeSessionKey(unauthorized, "example-session-cookie", new AbortController().signal))
    .rejects.toThrow(/^读取 Claude 组织失败（HTTP 401）。$/u);
});

test("distinguishes an explicit Cloudflare challenge from a generic 403", async () => {
  const signal = new AbortController().signal;
  const forbidden = async () => new Response("private-response-body", { status: 403 });
  const challenge = async () => new Response("private-response-body", {
    status: 403, headers: { "cf-mitigated": "challenge", "Content-Type": "text/html" },
  });
  await expect(exchangeClaudeSessionKey(forbidden, "example-session-cookie", signal))
    .rejects.toThrow(/^读取 Claude 组织失败（HTTP 403）。$/u);
  await expect(exchangeClaudeSessionKey(challenge, "example-session-cookie", signal))
    .rejects.toThrow(/^读取 Claude 组织失败，Claude 要求在浏览器中完成安全验证（HTTP 403）。$/u);
});

test("a mismatched OAuth state stops before token exchange", async () => {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    if (calls.length === 1) return Response.json([{ uuid: personalOrg }]);
    return Response.json({ redirect_uri: "https://platform.claude.com/oauth/code/callback?code=fake&state=wrong" });
  };
  await expect(exchangeClaudeSessionKey(fetcher, "example-session-cookie", new AbortController().signal))
    .rejects.toThrow("state 无效");
  expect(calls).toHaveLength(2);
});
