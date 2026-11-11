import { expect, test } from "bun:test";
import { ChatGptWebAccountCredentials } from "../src/main/chatgpt-web-account-credentials";
import { ChatGptWebSessionError } from "../src/main/chatgpt-web-session";
import type { OpenAIAccountDetails } from "../src/shared/openai-account";

test("expired Web credentials renew from the browser once for concurrent callers and never refresh Codex", async () => {
  let account: OpenAIAccountDetails = { id: "web", name: "Web", proxyMode: "direct", createdAt: "", updatedAt: "", authJson: null,
    webAuth: { accessToken: "old", accountId: "identity", expiresAt: 1 } };
  let tail: Promise<unknown> = Promise.resolve();
  let reads = 0;
  let failure: Error | undefined;
  const owner = new ChatGptWebAccountCredentials({
    run: (_, action) => { const next = tail.then(action); tail = next.catch(() => {}); return next; },
    getAccount: async () => account,
    readSession: async () => { reads++; if (failure) throw failure; return { accessToken: "fresh", accountId: "identity", expiresAt: Date.now() + 3600_000 }; },
    saveSession: async (_, auth, error) => {
      const { webAuth, webAuthError, ...rest } = account;
      account = { ...rest, ...(auth ? { webAuth: auth } : {}), ...(error ? { webAuthError: error } : {}) };
    },
    ensureCodex: async () => { throw new Error("must not refresh Codex"); },
  });
  const results = await Promise.all([owner.forImages("web"), owner.forImages("web")]);
  expect(reads).toBe(1);
  expect(results.map(a => JSON.parse(a.authJson!).tokens.access_token)).toEqual(["fresh", "fresh"]);
  expect(account.authJson).toBeNull();
  failure = new Error("Network unavailable");
  account = { ...account, webAuth: { ...account.webAuth!, expiresAt: 1 } };
  await expect(owner.forImages("web")).rejects.toThrow("Network unavailable");
  expect(account.webAuth?.accessToken).toBe("fresh");
  failure = new ChatGptWebSessionError("Web session expired", true);
  await expect(owner.forImages("web")).rejects.toThrow("Web session expired");
  expect(account.webAuth).toBeUndefined();
  expect(account.webAuthError).toBe("Web session expired");
});

test("an existing browser Web session is discovered before falling back to Codex", async () => {
  let account: OpenAIAccountDetails = { id: "existing", name: "Existing", proxyMode: "direct", createdAt: "", updatedAt: "", authJson: null };
  let reads = 0;
  let codexRefreshes = 0;
  const owner = new ChatGptWebAccountCredentials({
    run: (_, action) => action(),
    getAccount: async () => account,
    readSession: async () => {
      reads++;
      return { accessToken: "browser-token", accountId: "web-account", expiresAt: Date.now() + 3600_000 };
    },
    saveSession: async (_, auth, error) => {
      account = { ...account, ...(auth ? { webAuth: auth } : {}), ...(error ? { webAuthError: error } : {}) };
    },
    ensureCodex: async () => { codexRefreshes++; },
  });

  const result = await owner.forImages("existing");
  expect(reads).toBe(1);
  expect(codexRefreshes).toBe(0);
  expect(JSON.parse(result.authJson!).tokens).toEqual({ access_token: "browser-token", account_id: "web-account" });
  expect(account.webAuth?.accountId).toBe("web-account");
});

test("a missing browser Web session keeps a Codex-only account on Codex credentials", async () => {
  const account: OpenAIAccountDetails = { id: "codex", name: "Codex", proxyMode: "direct", createdAt: "", updatedAt: "", authJson: '{"tokens":{"access_token":"codex-token"}}' };
  let codexRefreshes = 0;
  const owner = new ChatGptWebAccountCredentials({
    run: (_, action) => action(),
    getAccount: async () => account,
    readSession: async () => { throw new ChatGptWebSessionError("未登录", true, true); },
    saveSession: async () => { throw new Error("should not persist missing session"); },
    ensureCodex: async () => { codexRefreshes++; },
  });
  const result = await owner.forImages("codex");
  expect(codexRefreshes).toBe(1);
  expect(result.authJson).toBe(account.authJson);
});
