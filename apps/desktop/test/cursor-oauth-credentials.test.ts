import { expect, test } from "bun:test";
import type { CursorOAuthCredential } from "../src/main/cursor-api-key-store";
import { CursorOAuthCredentials, renewCursorOAuthToken } from "../src/main/cursor-oauth-credentials";

const tokenWithExpiry = (expiresAt: number) =>
  `header.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString("base64url")}.signature`;

test("refreshes a Cursor account once for concurrent sessions and persists rotated credentials", async () => {
  const initial: CursorOAuthCredential = {
    kind: "oauth", accountId: "account", value: JSON.stringify({ accessToken: "old", refreshToken: "refresh" }),
    expiresAt: Date.now() + 30_000,
  };
  let current = initial;
  let refreshCalls = 0;
  const newAccess = tokenWithExpiry(Date.now() + 3_600_000);
  const broker = new CursorOAuthCredentials({
    read: () => current,
    decode: (value) => value,
    encode: (value) => value,
    renew: async (_credential, refresh) => {
      expect(refresh).toBe("refresh");
      refreshCalls++;
      return { accessToken: newAccess, refreshToken: "rotated" };
    },
    replace: (previous, encrypted, expiresAt) => {
      expect(previous).toBe(initial);
      current = { ...current, value: encrypted, expiresAt };
      return true;
    },
  });

  const first = broker.accessToken("account");
  expect(broker.accessToken("account")).toBe(first);
  expect(await first).toBe(newAccess);
  expect(await broker.accessToken("account")).toBe(newAccess);
  expect(refreshCalls).toBe(1);
  expect(JSON.parse(current.value).refreshToken).toBe("rotated");
});

test("keeps a concurrent browser authorization when a refresh result arrives late", async () => {
  let current: CursorOAuthCredential = {
    kind: "oauth", accountId: "account", value: JSON.stringify({ accessToken: "old", refreshToken: "refresh" }),
    expiresAt: Date.now() - 30_000,
  };
  const freshAccess = tokenWithExpiry(Date.now() + 3_600_000);
  const broker = new CursorOAuthCredentials({
    read: () => current,
    decode: (value) => value,
    encode: (value) => value,
    renew: async () => {
      current = { ...current, value: freshAccess, expiresAt: Date.now() + 3_600_000 };
      return { accessToken: tokenWithExpiry(Date.now() + 600_000) };
    },
    replace: () => false,
  });

  expect(await broker.accessToken("account")).toBe(freshAccess);
});

test("rejects ended Cursor sessions without disclosing response bodies", async () => {
  const fetcher = (async (_input, init) => {
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh" });
    return Response.json({ shouldLogout: true });
  }) as typeof fetch;
  await expect(renewCursorOAuthToken(fetcher, "refresh")).rejects.toThrow("请重新授权");
});
