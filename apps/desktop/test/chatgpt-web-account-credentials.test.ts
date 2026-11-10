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
