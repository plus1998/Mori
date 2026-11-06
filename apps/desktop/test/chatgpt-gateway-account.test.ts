import { afterEach, expect, test } from "bun:test";
import { createGatewayFetchHandler, type EcoGatewayServer, type GatewayConfig } from "@eco/gateway";
import {
  prepareClaudeBridgeMessagesRequest,
  prepareGatewayBindingForwardRequest,
} from "../src/main/anthropic-proxy";
import { postAuxiliaryBridgeRequest } from "../src/main/bridge-auxiliary-request";
import { resolveChatGptGatewayAccountId } from "../src/main/chatgpt-gateway-account";
import { globalClaudeBridgeBindingRegistry } from "../src/main/claude-bridge-binding";
import { createEcoSdkBridgeHandler } from "../src/main/eco-sdk-bridge";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import { runImageView } from "../src/main/vision-analysis";
import { buildAcpThreadRuntimeConfig } from "../src/shared/thread-runtime-config";
import { createBuiltInAgentTemplates, resolveOrchestrationSnapshot } from "../src/shared/agent-orchestration";
import { createBlankSubagentOrchestrationForm, buildSubagentOrchestrationFromForm } from "../src/renderer/agent-resource-form";

const provider: ProviderConfigSecret = {
  id: "oauth",
  name: "ChatGPT OAuth",
  baseUrl: "https://api.openai.com",
  requestPath: "",
  version: "v1",
  defaultModel: "gpt-5",
  enabled: true,
  hasApiKey: false,
  apiKey: "",
  authMethod: "chatgpt_subscription",
  credentialPoolId: "chatgpt-default",
  apiCompat: "openai_responses",
  createdAt: "",
  updatedAt: "",
};

afterEach(() => globalClaudeBridgeBindingRegistry.clearAllForTests());

function thread(separateVision: boolean) {
  const runtimeConfig = buildAcpThreadRuntimeConfig();
  runtimeConfig.orchestrationSelection = {
    mainPrompt: { mode: "builtin" },
    subagents: { mode: "none" },
    mainModel: { providerId: "oauth", modelId: "gpt-5", accountId: "bound-main-account" },
  };
  if (separateVision)
    runtimeConfig.visionModel = {
      providerId: "oauth",
      modelId: "gpt-5",
      candidateModelId: "account:oauth:gpt-5",
    };
  return { runtimeConfig };
}

test("main and unclassified requests still require a bound thread account", () => {
  for (const role of [undefined, "main", "planner"]) {
    const headers = new Headers(role ? { "x-eco-route-role": role } : {});
    expect(() => resolveChatGptGatewayAccountId(headers, () => undefined)).toThrow("没有会话标识");
    headers.set("x-gateway-thread-id", "thr_main");
    expect(() => resolveChatGptGatewayAccountId(headers, () => undefined)).toThrow("找不到");
    expect(() => resolveChatGptGatewayAccountId(headers, () => ({}))).toThrow("尚未选择");
  }
});

test("stateless OAuth calls require their own explicit account, independently of the main account", () => {
  for (const role of ["auxiliary", "vision", "coder", "custom_researcher"]) {
    const headers = new Headers({ "x-eco-route-role": role });
    expect(() => resolveChatGptGatewayAccountId(headers, () => thread(true))).toThrow("尚未选择账号");
    headers.set("x-eco-oauth-account-id", "chosen-account");
    expect(
      resolveChatGptGatewayAccountId(headers, () => {
        throw new Error("must not borrow main account");
      }),
    ).toBe("chosen-account");
  }
});

function bridge(
  resolveCredential: NonNullable<GatewayConfig["resolveCredential"]>,
  inspect?: (body: Record<string, unknown>) => void,
) {
  let calls = 0;
  const handleRequest = createGatewayFetchHandler(
    {
      host: "127.0.0.1",
      port: 0,
      providers: [
        {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          upstreamKind: "responses",
          upstreamModelId: "gpt-5",
          models: ["gpt-5"],
          apiKey: "",
          authMethod: "chatgpt_subscription",
          credentialPoolId: "chatgpt-default",
        },
      ],
      resolveCredential,
    },
    async (_url, init) => {
      calls++;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-token");
      const body = JSON.parse(String(init?.body));
      inspect?.(body);
      expect(body.stream).toBe(true);
      expect(body.store).toBe(false);
      const response = {
        id: "resp_test",
        object: "response",
        status: "completed",
        model: "gpt-5",
        output: [
          {
            type: "message",
            id: "msg_test",
            role: "assistant",
            content: [{ type: "output_text", text: "测试标题" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      };
      return new Response(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  );
  const gateway: EcoGatewayServer = {
    port: 0,
    handleRequest,
    stop: () => undefined,
    getProviders: () => [],
    setProviders: () => undefined,
    setUpstreamUserAgent: () => undefined,
    setUpstreamUserAgents: () => undefined,
    setUpstreamProxyUrl: () => undefined,
    getUpstreamProxyUrl: () => undefined,
  };
  return {
    handler: createEcoSdkBridgeHandler({
      gateway,
      prepareClaudeMessages: ({ path, body, model, headers }) =>
        prepareClaudeBridgeMessagesRequest({ path, body, requestedModel: model, headers }),
      prepareGatewayBindingForward: ({ face, body, model, headers }) =>
        prepareGatewayBindingForwardRequest({ face, body, requestedModel: model, headers }),
    }),
    calls: () => calls,
  };
}

test("title's auxiliary request reaches the OAuth gateway without a thread binding", async () => {
  const { handler, calls } = bridge(async ({ request }) => {
    expect(request?.headers.get("x-eco-route-role")).toBe("auxiliary");
    expect(resolveChatGptGatewayAccountId(request?.headers, () => undefined)).toBe("bound-aux-account");
    return { accessToken: "oauth-token", accountId: "pool-account" };
  });
  const result = await postAuxiliaryBridgeRequest({
    route: { role: "auxiliary", provider, modelId: "gpt-5", accountId: "bound-aux-account" },
    prompt: { messages: [{ role: "user", content: "生成一个标题" }], maxTokens: 128 },
    logEventPrefix: "oauth-title-regression",
    fetcher: ((url, init) => handler(new Request(String(url), init))) as typeof fetch,
  });
  expect(result).toMatchObject({ ok: true, text: "测试标题" });
  expect(calls()).toBe(1);
});

test("independent image_view uses native Responses and its selected account through the binding", async () => {
  let inspected = false;
  const { handler } = bridge(
    async ({ request }) => {
      expect(resolveChatGptGatewayAccountId(request?.headers, () => ({}))).toBe("vision-account");
      return { accessToken: "oauth-token", accountId: "vision-account" };
    },
    (body) => {
      inspected = true;
      expect(body).not.toHaveProperty("messages");
      expect(body.input).toMatchObject([
        {
          role: "user",
          content: [
            { type: "input_text", text: "看图" },
            { type: "input_image", image_url: "data:image/png;base64,YWJj" },
          ],
        },
      ]);
    },
  );
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  try {
    const text = await runImageView(
      {
        threadId: "thr_vision",
        prompt: "看图",
        attachments: [{ mediaType: "image/png", data: "YWJj" }],
        billingAgentId: "image_view:test",
      },
      {
        resolveRoute: () => ({
          role: "vision",
          provider,
          modelId: "gpt-5",
          apiCompat: "openai_responses",
          accountId: "vision-account",
        }),
        startProxy: async (route, images) => {
          expect(images).toEqual([]); // The native request already carries its own images.
          const binding = globalClaudeBridgeBindingRegistry.create({
            threadId: "thr_vision",
            routes: [
              {
                ...route,
                aliasModelId: "eco-vision-test",
              },
            ],
          });
          return {
            baseUrl: `http://127.0.0.1:${server.port}`,
            apiKey: binding.credential,
            aliasModelId: "eco-vision-test",
            close: async () => {},
          };
        },
        registerBilling: () => {},
        unregisterBilling: () => {},
      },
    );
    expect(text).toBe("测试标题");
    expect(inspected).toBe(true);
  } finally {
    server.stop(true);
  }
});

for (const face of ["messages", "responses"] as const) {
  for (const role of ["vision", "main", "coder", "custom_researcher"] as const) {
    test(`${face}: binding stamps ${role} for OAuth credential resolution`, async () => {
      const binding = globalClaudeBridgeBindingRegistry.create({
        threadId: "thr_test",
        routes: [
          {
            role,
            provider,
            modelId: "gpt-5",
            accountId: "bound-vision-account",
            aliasModelId: "eco-test",
            apiCompat: "openai_responses",
          },
        ],
      });
      const { handler, calls } = bridge(async ({ request }) => {
        // Caller supplied the opposite role: the resolved binding must win.
        expect(request?.headers.get("x-eco-route-role")).toBe(role);
        const accountId = resolveChatGptGatewayAccountId(request?.headers, () => thread(true));
        expect(accountId).toBe(role === "main" ? "bound-main-account" : "bound-vision-account");
        return { accessToken: "oauth-token", accountId: accountId ?? "pool-account" };
      });
      const response = await handler(
        new Request(`http://bridge.test/v1/${face}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": binding.credential,
            "x-eco-route-role": role === "main" ? "vision" : "main",
            "x-eco-oauth-account-id": "wrong-caller-account",
          },
          body: JSON.stringify({
            model: "eco-test",
            stream: true,
            ...(face === "messages"
              ? { max_tokens: 128, messages: [{ role: "user", content: "看图" }] }
              : { store: false, input: [{ role: "user", content: "看图" }] }),
          }),
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(calls()).toBe(1);
      binding.state = "closing";
    });
  }
}

test("an unavailable OAuth pool returns its real error without another credential path", async () => {
  const { handler, calls } = bridge(async () => {
    throw Object.assign(new Error("账号用量已暂停"), {
      statusCode: 403,
      errorCode: "subscription_sharing_usage_limit_exceeded",
    });
  });
  const response = await handler(
    new Request("http://bridge.test/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gateway-provider-id": "oauth",
        "x-gateway-upstream-kind": "responses",
        "x-eco-route-role": "auxiliary",
      },
      body: JSON.stringify({
        model: "gpt-5",
        stream: true,
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
  expect(response.status).toBe(403);
  expect(((await response.json()) as { error: { message: string } }).error.message).toBe("账号用量已暂停");
  expect(calls()).toBe(0);
});

function codexThread() {
  const result = thread(false);
  const templates = createBuiltInAgentTemplates();
  const form = createBlankSubagentOrchestrationForm({ templates });
  form.agents[0]!.agentKey = "Research_Agent";
  for (const agent of form.agents) {
    agent.providerId = "eco-coding-chatgpt";
    agent.modelId = "gpt-5";
    agent.candidateModelId = "account:oauth:gpt-5";
    agent.accountId = `account-${agent.agentKey}`;
  }
  const orchestration = buildSubagentOrchestrationFromForm(form, { templates });
  const selection = { ...result.runtimeConfig.orchestrationSelection!,
    subagents: { mode: "orchestration" as const, orchestrationId: orchestration.id } };
  result.runtimeConfig.orchestrationSelection = selection;
  result.runtimeConfig.resolvedOrchestrationSnapshot = resolveOrchestrationSnapshot(selection, {
    mainAgentConfigs: [], mainAgentPrompts: [], subagentOrchestrations: [orchestration],
  });
  return result;
}

test("native Codex OAuth children resolve their saved account from thread attribution, ignoring caller account and role", async () => {
  const saved = codexThread();
  const agent = saved.runtimeConfig.resolvedOrchestrationSnapshot!.agents[0]!;
  const { handler, calls } = bridge(async ({ request }) => {
    const accountId = resolveChatGptGatewayAccountId(request?.headers, () => saved,
      (id) => ({ ecoThreadId: "thr_parent", billingRole: id === "codex_child" ? agent.agentKey.toLowerCase() : "main",
        isSubagentThread: id === "codex_child" }));
    expect(accountId).toBe(`account-${agent.agentKey}`);
    return { accessToken: "oauth-token", accountId };
  });
  const response = await handler(new Request("http://bridge.test/v1/responses", {
    method: "POST", headers: { "content-type": "application/json",
      "x-gateway-provider-id": provider.id, "x-gateway-upstream-kind": "responses",
      "x-eco-route-role": "main", "x-eco-oauth-account-id": "wrong-caller-account",
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "codex_child", turn_id: "turn_child", request_kind: "turn" }),
    }, body: JSON.stringify({ model: "gpt-5", store: false, stream: true, input: [{ role: "user", content: "hi" }] }),
  }));
  expect(response.status).toBe(200);
  await response.text();
  expect(calls()).toBe(1);
  const headers = new Headers({ "x-codex-turn-metadata": JSON.stringify({
    thread_id: "codex_child", turn_id: "turn_child", request_kind: "turn",
  }) });
  const attribution = () => ({ ecoThreadId: "thr_parent", billingRole: agent.agentKey.toLowerCase(), isSubagentThread: true });
  delete agent.modelRef.accountId;
  expect(() => resolveChatGptGatewayAccountId(headers, () => saved, attribution)).toThrow("尚未选择账号");
  expect(() => resolveChatGptGatewayAccountId(headers, () => saved, () => undefined)).toThrow("找不到");
});

for (const face of ["messages", "responses"] as const) {
  test(`${face}: missing subagent binding account clears caller account and fails without borrowing the main account`, async () => {
    const binding = globalClaudeBridgeBindingRegistry.create({ threadId: "thr_test", routes: [{
      role: "coder", provider, modelId: "gpt-5", aliasModelId: "eco-missing-account", apiCompat: "openai_responses",
    }] });
    const { handler, calls } = bridge(async ({ request }) => {
      expect(request?.headers.get("x-eco-oauth-account-id")).toBeNull();
      const accountId = resolveChatGptGatewayAccountId(request?.headers, () => thread(false));
      throw new Error(`Unexpected account: ${accountId}`);
    });
    const response = await handler(new Request(`http://bridge.test/v1/${face}`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": binding.credential,
        "x-eco-oauth-account-id": "caller-or-main-account" },
      body: JSON.stringify({ model: "eco-missing-account", stream: true,
        ...(face === "messages" ? { max_tokens: 128, messages: [{ role: "user", content: "hi" }] }
          : { store: false, input: "hi" }) }),
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toContain("尚未选择账号");
    expect(calls()).toBe(0);
  });
}
