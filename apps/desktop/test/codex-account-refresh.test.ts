import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type CodexQuotaClient } from "../src/main/codex-account-quota";
import { isCodexReauthenticationRequired } from "../src/main/codex-reauthentication";
import { OpenAIAccountService } from "../src/main/openai-account-service";
import { CodexOAuthLoginService } from "../src/main/codex-oauth-login";
import { canUseOpenAIAccountCredentials } from "../src/shared/openai-account";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function auth(exp: number, refresh = "refresh-old", idExp = exp): string {
  const jwt = (value: number) =>
    `e30.${Buffer.from(JSON.stringify({ exp: value })).toString("base64url")}.sig`;
  return JSON.stringify({
    tokens: {
      access_token: jwt(exp),
      id_token: jwt(idExp),
      refresh_token: refresh,
      account_id: "acct-refresh",
    },
  });
}
const expired = auth(1);
const fresh = auth(2_000_000_000, "refresh-rotated");
async function setup(handler: (method: string, params: unknown, root: string) => Promise<unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-account-refresh-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const client: CodexQuotaClient = {
    request: async <T>(method: string, params?: unknown) => (await handler(method, params, root)) as T,
  };
  const service = new OpenAIAccountService(root, "unused", undefined, async () => client);
  await service.initialize();
  cleanups.push(() => service.dispose());
  const account = await service.createAccount("Refreshable");
  await service.setAuthJson(account.id, expired);
  await service.setActiveAccount(account.id);
  await service.applyPendingTransition();
  return { root, service, id: account.id };
}

test("expired access tokens with refresh credentials remain eligible; list reads never refresh", async () => {
  let requests = 0;
  const { service, id } = await setup(async () => {
    requests++;
    throw new Error("unexpected RPC");
  });
  const account = (await service.listAccounts())[0]!;
  expect(account).toMatchObject({ id, isLoggedIn: false, authState: "refreshable" });
  expect(canUseOpenAIAccountCredentials(account)).toBe(true);
  expect(await service.getActiveStatus()).toMatchObject({ isLoggedIn: false, authState: "refreshable" });
  expect(requests).toBe(0);
  expect(canUseOpenAIAccountCredentials({ isLoggedIn: true, authState: "reauthorization_required" })).toBe(
    false,
  );
  expect(canUseOpenAIAccountCredentials({ isLoggedIn: false, authState: "expired" })).toBe(false);
});

test("concurrent use shares one native refresh and persists rotated tokens without quota or model calls", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const calls: string[] = [];
  const { service, id, root } = await setup(async (method, params, dir) => {
    calls.push(method);
    expect(params).toEqual({ refreshToken: true });
    entered();
    await gate;
    await fs.writeFile(path.join(dir, "codex/auth.json"), fresh);
    return { account: { type: "chatgpt" } };
  });
  const first = service.ensureAccountCredentials(id);
  expect(service.ensureAccountCredentials(id)).toBe(first);
  const activeUse = service.ensureActiveCredentials();
  try {
    await started;
    expect((await service.listAccounts())[0]?.authState).toBe("refreshing");
  } finally {
    release();
  }
  await Promise.all([first, activeUse]);
  expect(calls).toEqual(["account/read"]);
  expect(await service.getAuthJsonContent(id)).toBe(fresh);
  expect(await fs.readFile(path.join(root, "codex/auth.json"), "utf8")).toBe(fresh);
  expect(await service.getActiveStatus()).toMatchObject({ isLoggedIn: true, authState: "configured" });
  await service.ensureActiveCredentials();
  expect(calls).toHaveLength(1);
});

test("an RPC acknowledgement without fresh credentials is retryable, not a successful refresh", async () => {
  const { service, id } = await setup(async () => ({ account: { type: "chatgpt" } }));
  await expect(service.ensureAccountCredentials(id)).rejects.toThrow("尚未写回有效的新访问令牌");
  expect(await service.getAuthJsonContent(id)).toBe(expired);
  expect((await service.listAccounts())[0]?.authState).toBe("refreshable");
  expect(service.getSyncStatus().state).toBe("ok");
});

for (const failure of ["401 unauthorized", "fetch failed", "workspace routing discovery failed"]) {
  test(`${failure} preserves refreshability and allows a later successful retry`, async () => {
    let fail = true;
    const { service, id } = await setup(async (_method, _params, root) => {
      if (fail) throw new Error(failure);
      await fs.writeFile(path.join(root, "codex/auth.json"), fresh);
      return {};
    });
    await expect(service.ensureAccountCredentials(id)).rejects.toThrow(failure);
    expect((await service.listAccounts())[0]?.authState).toBe("refreshable");
    expect(await service.getAuthJsonContent(id)).toBe(expired);
    expect(service.getSyncStatus().state).toBe("ok");
    fail = false;
    await service.ensureAccountCredentials(id);
    expect((await service.listAccounts())[0]?.authState).toBe("configured");
  });
}

test("permanent refresh rejection survives restart and only new credentials clear it", async () => {
  let requests = 0;
  const { service, id, root } = await setup(async () => {
    requests++;
    throw new Error("invalid_grant: refresh token revoked");
  });
  await expect(service.ensureAccountCredentials(id)).rejects.toThrow("invalid_grant");
  expect((await service.listAccounts())[0]?.authState).toBe("reauthorization_required");
  await expect(service.ensureAccountCredentials(id)).rejects.toThrow("需要重新登录");
  expect(requests).toBe(1);
  await service.dispose();
  const reopened = new OpenAIAccountService(root, "unused");
  await reopened.initialize();
  cleanups.push(() => reopened.dispose());
  expect((await reopened.listAccounts())[0]?.authState).toBe("reauthorization_required");
  await reopened.setAuthJson(id, expired);
  await reopened.applyPendingTransition();
  expect((await reopened.listAccounts())[0]?.authState).toBe("reauthorization_required");
  await reopened.setAuthJson(id, fresh);
  await reopened.applyPendingTransition();
  expect((await reopened.listAccounts())[0]?.authState).toBe("configured");
});

test("a routing error after successful token rotation still saves the new credentials", async () => {
  const { service, id } = await setup(async (_method, _params, root) => {
    await fs.writeFile(path.join(root, "codex/auth.json"), fresh);
    throw new Error("workspace routing discovery failed");
  });
  await expect(service.ensureActiveCredentials()).rejects.toThrow("workspace routing discovery failed");
  expect(await service.getAuthJsonContent(id)).toBe(fresh);
  expect((await service.listAccounts())[0]?.authState).toBe("configured");
  await service.ensureActiveCredentials();
});

test("refresh rejection recognizes Codex's permanent messages without treating account changes or generic 401 as revocation", () => {
  for (const reason of ["has expired", "was already used", "was revoked"]) {
    expect(
      isCodexReauthenticationRequired(
        new Error(
          `Your access token could not be refreshed because your refresh token ${reason}. Please log out and sign in again.`,
        ),
      ),
    ).toBe(true);
  }
  for (const code of [
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
    "invalid_grant",
  ]) {
    expect(isCodexReauthenticationRequired(new Error(code))).toBe(true);
  }
  for (const message of [
    "401 unauthorized",
    "fetch failed",
    "workspace routing discovery failed",
    "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
  ]) {
    expect(isCodexReauthenticationRequired(new Error(message))).toBe(false);
  }
});

test("legacy OAuth status checks access token expiry instead of ID token expiry", async () => {
  const { root } = await setup(async () => ({}));
  const oauth = new CodexOAuthLoginService(path.join(root, "codex"), "unused");
  await fs.writeFile(path.join(root, "codex/auth.json"), auth(2_000_000_000, "refresh", 1));
  expect((await oauth.getStatus()).isLoggedIn).toBe(true);
  await fs.writeFile(path.join(root, "codex/auth.json"), expired);
  expect(await oauth.getStatus()).toMatchObject({ isLoggedIn: false, authState: "refreshable" });
  await fs.writeFile(path.join(root, "codex/auth.json"), auth(1, ""));
  expect(await oauth.getStatus()).toMatchObject({ isLoggedIn: false, authState: "expired" });
});

test("structured RPC refresh rejection codes are recognized without conflating HTTP 401", () => {
  expect(
    isCodexReauthenticationRequired(
      Object.assign(new Error("account/read failed"), {
        data: { error: { code: "refresh_token_invalidated" } },
      }),
    ),
  ).toBe(true);
  expect(isCodexReauthenticationRequired({ code: 401, data: { error: { code: "unauthorized" } } })).toBe(
    false,
  );
});

test("automatic quota refresh backs off token-refresh failures while manual retry remains available", async () => {
  let requests = 0;
  const { service, id } = await setup(async () => {
    requests++;
    throw new Error("refresh network offline");
  });
  await expect(service.queryQuota(id, "usage")).rejects.toThrow("refresh network offline");
  await expect(service.queryQuota(id, "usage")).rejects.toThrow("refresh network offline");
  expect(requests).toBe(1);
  const listed = (await service.listAccounts())[0]!;
  expect(listed.authState).toBe("refreshable");
  expect(listed.quotaRefresh?.error).toBe("refresh network offline");
  expect(listed.quotaRefresh?.authRequired).toBeUndefined();
  expect(service.getSyncStatus().state).toBe("ok");
  await expect(service.queryQuota(id, "manual")).rejects.toThrow("refresh network offline");
  expect(requests).toBe(2);
});
