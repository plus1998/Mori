import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GatewayCredentialResult, GatewayProvider } from "@eco/gateway";
import { ChatGptSubscriptionService } from "../src/main/chatgpt-subscription-service";

const codec = {
  isAvailable: () => true,
  encrypt: (value: string) => `test:${Buffer.from(value).toString("base64")}`,
  decrypt: (value: string) => Buffer.from(value.slice("test:".length), "base64").toString("utf8"),
};

const subscriptionProvider: GatewayProvider = {
  id: "eco-coding-chatgpt",
  name: "ChatGPT subscription",
  upstreamKind: "responses",
  baseUrl: "https://api.openai.com",
  apiKey: "local-unused",
  authMethod: "chatgpt_subscription",
  credentialPoolId: "chatgpt-default",
  upstreamModelId: "gpt-5",
  models: ["gpt-5"],
};

function authorizeAccount(
  service: ChatGptSubscriptionService,
  options: { accessTokenExpiresAt?: number; accountIndex?: number } = {},
): void {
  const state = service as unknown as { state: { accounts: Array<Record<string, unknown>> } };
  const account = state.state.accounts[options.accountIndex ?? 0];
  if (!account) throw new Error("test account is missing");
  Object.assign(account, {
    clientId: "oaiapp_test",
    refreshToken: "test-refresh",
    accessToken: "test-access",
    accessTokenExpiresAt: options.accessTokenExpiresAt ?? Date.now() + 3600_000,
    status: "ready",
    scopes: ["chatgpt.tokens.use.direct"],
  });
}

function quotaResult(accountId: string): GatewayCredentialResult {
  return {
    provider: subscriptionProvider,
    accountId,
    resultType: "failed",
    statusCode: 200,
    providerRequestId: "req_quota",
    responseId: "resp_quota",
    logicalRequestId: "logical_quota",
    attemptIndex: 0,
    bridgeBindingId: "binding_quota",
    threadId: "thread_quota",
    turnId: "turn_quota",
    runAttemptId: "run_quota",
    error: {
      message: "Usage limit exceeded",
      code: "subscription_sharing_usage_limit_exceeded",
      param: "model",
      type: "invalid_request_error",
      eventType: "response.failed",
      rawEvent: {
        type: "response.failed",
        response: {
          id: "resp_quota",
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        },
      },
    },
  };
}

describe("ChatGptSubscriptionService", () => {
  test("stores account metadata in an encrypted local record", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    const service = new ChatGptSubscriptionService(dataDir, codec);
    await service.initialize();
    const created = await service.createAccount("测试账号");
    expect(created.status).toBe("needs_login");
    expect(created.hasCredentials).toBe(false);
    const raw = await fs.readFile(path.join(dataDir, "chatgpt-subscription", "accounts.json"), "utf8");
    expect(raw.startsWith("test:")).toBe(true);
    expect(raw).not.toContain("测试账号");
    await service.deleteAccount(created.accountId);
    expect(service.listAccounts()).toHaveLength(0);
  });

  test("creates a copyable authorization URL without embedding the ID token", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    const service = new ChatGptSubscriptionService(dataDir, codec);
    await service.initialize();
    const account = await service.createAccount("浏览器授权账号");
    const login = await service.beginLogin(account.accountId, { includeAccountHints: false });
    const params = new URL(login.authorizationUrl).searchParams;
    expect(params.get("client_id")).toBe("dynamic_agent_client");
    expect(params.has("id_token_hint")).toBe(false);
    expect(params.has("login_hint")).toBe(false);
    service.cancelLogin(account.accountId);
    await expect(login.result).rejects.toThrow("已取消");
  });

  test("selects a ready account and refreshes an expired access token", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    const service = new ChatGptSubscriptionService(dataDir, codec, async () =>
      Response.json({
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
      }),
    );
    await service.initialize();
    const created = await service.createAccount("刷新账号");
    const state = service as unknown as { state: { accounts: Array<Record<string, unknown>> } };
    Object.assign(state.state.accounts[0], {
      clientId: "oaiapp_test",
      refreshToken: "old-refresh",
      status: "ready",
      accessTokenExpiresAt: Date.now() - 1,
      scopes: ["chatgpt.tokens.use.direct"],
    });
    const resolved = await service.resolveCredential({
      id: "eco-coding-chatgpt",
      name: "ChatGPT",
      upstreamKind: "responses",
      baseUrl: "https://api.openai.com",
      apiKey: "local-unused",
      authMethod: "chatgpt_subscription",
      credentialPoolId: "chatgpt-default",
      upstreamModelId: "gpt-5",
      models: ["gpt-5"],
    });
    expect(resolved.accessToken).toBe("refreshed-access");
    expect(resolved.accountId).toBe(created.accountId);
    expect(service.listAccounts()[0]?.status).toBe("ready");
  });

  test("uses another ready account after an explicit quota pause", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    const service = new ChatGptSubscriptionService(dataDir, codec);
    await service.initialize();
    const paused = await service.createAccount("受限账号");
    const healthy = await service.createAccount("正常账号");
    authorizeAccount(service, { accountIndex: 0 });
    authorizeAccount(service, { accountIndex: 1 });

    await service.reportCredentialResult(quotaResult(paused.accountId));

    const resolved = await service.resolveCredential(subscriptionProvider);
    expect(resolved.accountId).toBe(healthy.accountId);
    expect(service.listAccounts().find((account) => account.accountId === paused.accountId)?.status).toBe(
      "subscription_usage_paused",
    );
  });

  test("sends the official OAuth smoke-test message upstream", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    let requestBody: Record<string, unknown> | undefined;
    const service = new ChatGptSubscriptionService(dataDir, codec, async (input, init) => {
      if (String(input).endsWith("/responses")) {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","status":"completed"}}\n\n',
          { status: 200 },
        );
      }
      return Response.json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 3600,
        scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
      });
    });
    await service.initialize();
    const created = await service.createAccount("测试账号");
    const state = service as unknown as { state: { accounts: Array<Record<string, unknown>> } };
    Object.assign(state.state.accounts[0], {
      clientId: "oaiapp_test",
      refreshToken: "old-refresh",
      accessToken: "existing-access",
      accessTokenExpiresAt: Date.now() + 3600_000,
      status: "ready",
      scopes: ["chatgpt.tokens.use.direct"],
    });
    const result = await service.testAccount(created.accountId, "gpt-5-mini");
    expect(result.success).toBe(true);
    expect(requestBody?.model).toBe("gpt-5-mini");
    expect(requestBody?.stream).toBe(true);
    expect(requestBody?.store).toBe(false);
    expect(requestBody?.input).toEqual([{ role: "user", content: "hi" }]);
  });

  test("fetches the official model catalog with the selected OAuth account", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    let authorization: string | null = null;
    const service = new ChatGptSubscriptionService(dataDir, codec, async (input, init) => {
      if (String(input).endsWith("/models")) {
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json({ models: [
          { slug: "gpt-5", display_name: "GPT-5", visibility: "list" },
          { slug: "gpt-5", display_name: "GPT-5", visibility: "list" },
          { slug: "gpt-5-mini", display_name: "GPT-5 mini", visibility: "list" },
          { slug: "internal-preview", display_name: "Internal", visibility: "hidden" },
        ] });
      }
      return Response.json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 3600,
        scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
      });
    });
    await service.initialize();
    const created = await service.createAccount("模型账号");
    const state = service as unknown as { state: { accounts: Array<Record<string, unknown>> } };
    Object.assign(state.state.accounts[0], {
      clientId: "oaiapp_test",
      refreshToken: "test-refresh",
      accessToken: "test-access",
      accessTokenExpiresAt: Date.now() + 3600_000,
      status: "ready",
      scopes: ["chatgpt.tokens.use.direct"],
    });
    const models = await service.listModels();
    expect(authorization).toBe("Bearer test-access");
    expect(models).toEqual([
      { id: "gpt-5", displayName: "GPT-5" },
      { id: "gpt-5-mini", displayName: "GPT-5 mini" },
    ]);
    expect(service.listAccounts()[0]?.accountId).toBe(created.accountId);
  });

  test("marks an account unavailable when subscription sharing rejects eligibility", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    const service = new ChatGptSubscriptionService(dataDir, codec, async () => new Response(JSON.stringify({
      error: { code: "subscription_sharing_user_not_eligible" },
    }), { status: 403, headers: { "content-type": "application/json" } }));
    await service.initialize();
    const created = await service.createAccount("无资格账号");
    const state = service as unknown as { state: { accounts: Array<Record<string, unknown>> } };
    Object.assign(state.state.accounts[0], {
      clientId: "oaiapp_test",
      refreshToken: "test-refresh",
      accessToken: "test-access",
      accessTokenExpiresAt: Date.now() + 3600_000,
      status: "ready",
      scopes: ["chatgpt.tokens.use.direct"],
    });
    await expect(service.testAccount(created.accountId, "gpt-5")).rejects.toThrow("不具备订阅共享资格");
    expect(service.listAccounts()[0]?.status).toBe("not_eligible");
  });

  test("persists an explicit usage pause across restart and ignores a late success", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    const service = new ChatGptSubscriptionService(dataDir, codec);
    await service.initialize();
    const created = await service.createAccount("额度受限账号");
    authorizeAccount(service);

    await service.reportCredentialResult(quotaResult(created.accountId));
    expect(service.listAccounts()[0]).toMatchObject({
      status: "subscription_usage_paused",
      lastErrorCode: "subscription_sharing_usage_limit_exceeded",
      subscriptionUsagePause: {
        code: "subscription_sharing_usage_limit_exceeded",
        statusCode: 200,
        providerRequestId: "req_quota",
        responseId: "resp_quota",
        param: "model",
        logicalRequestId: "logical_quota",
        bridgeBindingId: "binding_quota",
        threadId: "thread_quota",
        turnId: "turn_quota",
        runAttemptId: "run_quota",
        rawEvent: {
          type: "response.failed",
          response: {
            id: "resp_quota",
            error: { code: "subscription_sharing_usage_limit_exceeded" },
          },
        },
      },
    });

    const restarted = new ChatGptSubscriptionService(dataDir, codec);
    await restarted.initialize();
    expect(restarted.listAccounts()[0]?.status).toBe("subscription_usage_paused");
    await expect(
      restarted.resolveCredential(subscriptionProvider),
    ).rejects.toMatchObject({
      message: expect.stringContaining("手动测试"),
      statusCode: 403,
      errorCode: "subscription_sharing_usage_limit_exceeded",
      accountId: created.accountId,
    });

    await restarted.reportCredentialResult({
      provider: subscriptionProvider,
      accountId: created.accountId,
      resultType: "completed",
      statusCode: 200,
      responseId: "resp_late_success",
      logicalRequestId: "logical_late",
      attemptIndex: 0,
    });
    expect(restarted.listAccounts()[0]?.status).toBe("subscription_usage_paused");
    await restarted.setEnabled(created.accountId, false);
    await restarted.setEnabled(created.accountId, true);
    await restarted.resetAvailability(created.accountId);
    expect(restarted.listAccounts()[0]).toMatchObject({
      status: "subscription_usage_paused",
      subscriptionUsagePause: { code: "subscription_sharing_usage_limit_exceeded" },
    });

    const afterLateSuccess = new ChatGptSubscriptionService(dataDir, codec);
    await afterLateSuccess.initialize();
    expect(afterLateSuccess.listAccounts()[0]).toMatchObject({
      status: "subscription_usage_paused",
      subscriptionUsagePause: { code: "subscription_sharing_usage_limit_exceeded" },
    });
  });

  test("a concurrent late success cannot overwrite the persisted usage pause", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    const service = new ChatGptSubscriptionService(dataDir, codec);
    await service.initialize();
    const created = await service.createAccount("并发晚到成功账号");
    authorizeAccount(service);

    await Promise.all([
      service.reportCredentialResult({
        provider: subscriptionProvider,
        accountId: created.accountId,
        resultType: "completed",
        statusCode: 200,
        responseId: "resp_concurrent_late",
        logicalRequestId: "logical_concurrent_late",
        attemptIndex: 0,
      }),
      service.reportCredentialResult(quotaResult(created.accountId)),
    ]);

    const restarted = new ChatGptSubscriptionService(dataDir, codec);
    await restarted.initialize();
    expect(restarted.listAccounts()[0]).toMatchObject({
      status: "subscription_usage_paused",
      subscriptionUsagePause: { code: "subscription_sharing_usage_limit_exceeded" },
    });
  });

  test("an entirely paused pool is non-retryable and does not invent a selected account", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    const service = new ChatGptSubscriptionService(dataDir, codec);
    await service.initialize();
    const first = await service.createAccount("受限账号一");
    const second = await service.createAccount("受限账号二");
    authorizeAccount(service, { accountIndex: 0 });
    authorizeAccount(service, { accountIndex: 1 });
    await service.reportCredentialResult(quotaResult(first.accountId));
    await service.reportCredentialResult(quotaResult(second.accountId));

    const error = await service.resolveCredential(subscriptionProvider).catch((error: unknown) => error);
    expect(error).toMatchObject({
      statusCode: 403,
      errorCode: "subscription_sharing_usage_limit_exceeded",
      message: expect.stringContaining("测试成功后才能恢复"),
    });
    expect(error).not.toHaveProperty("accountId");
  });

  test("ordinary HTTP 429 remains a general rate limit", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    const service = new ChatGptSubscriptionService(dataDir, codec);
    await service.initialize();
    const created = await service.createAccount("普通限流账号");
    authorizeAccount(service);

    await service.reportCredentialResult({
      provider: subscriptionProvider,
      accountId: created.accountId,
      resultType: "failed",
      statusCode: 429,
      logicalRequestId: "logical_429",
      attemptIndex: 0,
      error: { message: "Too many requests", code: "rate_limit_exceeded" },
    });

    expect(service.listAccounts()[0]).toMatchObject({
      status: "rate_limited",
      lastErrorCode: "rate_limit_exceeded",
    });
    expect(service.listAccounts()[0]?.subscriptionUsagePause).toBeUndefined();
    expect(service.listAccounts()[0]?.subscriptionUsagePausedAt).toBeUndefined();
  });

  test("manual test failure after refresh keeps the pause until a real completion", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    let responseMode: "malformed" | "completed" = "malformed";
    const service = new ChatGptSubscriptionService(dataDir, codec, async (input) => {
      if (String(input).endsWith("/oauth/token")) {
        return Response.json({
          access_token: "refreshed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
        });
      }
      if (responseMode === "malformed") {
        return new Response('data: {"type":"response.created"}\n\ndata: invalid-json\n\n', {
          status: 200,
          headers: { "x-request-id": "req_manual_fail" },
        });
      }
      return new Response(
        'data: {"type":"response.completed","response":{"id":"resp_manual_ok","status":"completed"}}\n\n',
        { status: 200, headers: { "x-request-id": "req_manual_ok" } },
      );
    });
    await service.initialize();
    const created = await service.createAccount("手动测试账号");
    authorizeAccount(service, { accessTokenExpiresAt: Date.now() - 1 });
    await service.reportCredentialResult(quotaResult(created.accountId));

    await expect(service.testAccount(created.accountId, "gpt-5")).rejects.toThrow("Invalid JSON");
    expect(service.listAccounts()[0]).toMatchObject({
      status: "subscription_usage_paused",
      subscriptionUsagePause: {
        code: "subscription_sharing_usage_limit_exceeded",
        providerRequestId: "req_quota",
      },
    });

    responseMode = "completed";
    await expect(service.testAccount(created.accountId, "gpt-5")).resolves.toMatchObject({
      success: true,
    });
    expect(service.listAccounts()[0]).toMatchObject({ status: "ready" });
    expect(service.listAccounts()[0]?.subscriptionUsagePause).toBeUndefined();
    expect(service.listAccounts()[0]?.subscriptionUsagePausedAt).toBeUndefined();
  });

  for (const initiallyPaused of [false, true]) {
    test(`a manual test cannot clear a newer pause (initially paused: ${initiallyPaused})`, async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
      let releaseResponse!: (response: Response) => void;
      let markRequestStarted!: () => void;
      const response = new Promise<Response>((resolve) => { releaseResponse = resolve; });
      const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
      const service = new ChatGptSubscriptionService(dataDir, codec, async () => {
        markRequestStarted();
        return response;
      });
      await service.initialize();
      const created = await service.createAccount("并发手动测试账号");
      authorizeAccount(service);
      if (initiallyPaused) await service.reportCredentialResult(quotaResult(created.accountId));
      const previousPausedAt = service.listAccounts()[0]?.subscriptionUsagePausedAt;

      const testResult = service.testAccount(created.accountId, "gpt-5");
      await requestStarted;
      await service.reportCredentialResult({
        ...quotaResult(created.accountId),
        providerRequestId: "req_newer_quota",
        logicalRequestId: "logical_newer_quota",
      });
      releaseResponse(new Response(
        'data: {"type":"response.completed","response":{"id":"resp_old_test","status":"completed"}}\n\n',
        { headers: { "x-request-id": "req_old_test" } },
      ));

      await expect(testResult).rejects.toThrow("测试期间收到新的");
      const restarted = new ChatGptSubscriptionService(dataDir, codec);
      await restarted.initialize();
      expect(restarted.listAccounts()[0]).toMatchObject({
        status: "subscription_usage_paused",
        subscriptionUsagePause: { providerRequestId: "req_newer_quota" },
      });
      if (initiallyPaused) {
        expect(restarted.listAccounts()[0]?.subscriptionUsagePausedAt).toBe(previousPausedAt);
      }
    });
  }

  test("a paused account can still fetch models for manual testing", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    let authorization: string | null = null;
    const service = new ChatGptSubscriptionService(dataDir, codec, async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({
        models: [{ slug: "gpt-5", display_name: "GPT-5", visibility: "list" }],
      });
    });
    await service.initialize();
    const created = await service.createAccount("暂停后拉模型");
    authorizeAccount(service);
    await service.reportCredentialResult(quotaResult(created.accountId));

    await expect(service.listModels(created.accountId)).resolves.toEqual([
      { id: "gpt-5", displayName: "GPT-5" },
    ]);
    expect(authorization).toBe("Bearer test-access");
    expect(service.listAccounts()[0]?.status).toBe("subscription_usage_paused");
  });

  test("resets a persisted availability state without changing credentials", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-chatgpt-"));
    const service = new ChatGptSubscriptionService(dataDir, codec);
    await service.initialize();
    const created = await service.createAccount("重新检测账号");
    const state = service as unknown as { state: { accounts: Array<Record<string, unknown>> } };
    Object.assign(state.state.accounts[0], {
      refreshToken: "test-refresh",
      accessToken: "test-access",
      status: "not_eligible",
      lastErrorCode: "subscription_sharing_user_not_eligible",
      lastErrorAt: Date.now(),
      cooldownUntil: Date.now() + 30_000,
    });
    const reset = await service.resetAvailability(created.accountId);
    expect(reset.status).toBe("ready");
    expect(reset.hasCredentials).toBe(true);
    expect(reset.lastErrorCode).toBeUndefined();
    expect(reset.cooldownUntil).toBeUndefined();
  });
});
