import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startEcoGateway } from "@eco/gateway";
import {
  emitClaudeGatewayUsageIfSession,
  prepareClaudeBridgeMessagesRequest,
  prepareGatewayBindingForwardRequest,
} from "../src/main/anthropic-proxy";
import { resolveCandidateModelRequestRoute } from "../src/main/candidate-model-request-route";
import { globalClaudeBridgeBindingRegistry } from "../src/main/claude-bridge-binding";
import { createEcoSdkBridgeHandler } from "../src/main/eco-sdk-bridge";
import { handleGatewayRequestLifecycleEvent } from "../src/main/gateway-request-lifecycle";
import { createProviderStore } from "../src/main/provider-store";
import { removeTempDirectory } from "./helpers/temp-directory";

function modelResponse(url: string, model: string): Response {
  if (url.endsWith("/messages"))
    return Response.json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  if (url.endsWith("/chat/completions"))
    return Response.json({
      id: "chat_test",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  return Response.json({
    id: "resp_test",
    object: "response",
    model,
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "OK", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
}
function request(model: string, face = "responses", credential?: string, role?: string) {
  return new Request(`http://localhost/v1/${face}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential ? { "x-api-key": credential, authorization: `Bearer ${credential}` } : {}),
      ...(role ? { "x-eco-route-role": role } : {}),
      // Stale PI stamps must never override the freshly resolved candidate.
      "x-gateway-provider-id": "stale-provider",
      "x-gateway-upstream-kind": "responses",
    },
    body: JSON.stringify({
      model,
      ...(face === "responses"
        ? { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }] }
        : { messages: [{ role: "user", content: "Hi" }], max_tokens: 16 }),
    }),
  });
}

test("same candidate ID uses edited supplier address, path, protocol and key without gateway restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-candidate-live-"));
  const calls: Array<{ url: string; model: string; key: string | null }> = [];
  const handle = async (req: Request) => {
    const body = (await req.json()) as { model: string };
    calls.push({
      url: req.url,
      model: body.model,
      key: req.headers.get("x-api-key") ?? req.headers.get("authorization"),
    });
    return modelResponse(req.url, body.model);
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const newer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const gateway = await startEcoGateway(
    { host: "127.0.0.1", port: 0, providers: [] },
    { embedded: true, onLog: () => {} },
  );
  try {
    const store = await createProviderStore(path.join(dir, "eco.sqlite"));
    const provider = store.saveProvider({
      name: "Live",
      baseUrl: server.url.origin,
      requestPath: "/before",
      version: "v1",
      apiCompat: "anthropic",
      apiKey: "before-key",
      defaultModel: "upstream",
      enabled: true,
    });
    const candidate = store.saveCandidateModel({ providerId: provider.id, modelId: "upstream" });
    const bridge = createEcoSdkBridgeHandler({
      gateway,
      resolveCandidateModel: (id) => resolveCandidateModelRequestRoute(store, id),
      onLog: () => {},
    });
    {
      const response = await bridge(request(candidate.id));
      if (response.status !== 200) throw new Error(await response.text());
      expect(response.status).toBe(200);
    }
    store.saveProvider({
      ...provider,
      baseUrl: newer.url.origin,
      requestPath: "/after",
      version: "v2",
      apiCompat: "openai_chat_completions",
      apiKey: "after-key",
    });
    {
      const response = await bridge(request(candidate.id));
      if (response.status !== 200) throw new Error(await response.text());
      expect(response.status).toBe(200);
    }
    expect(calls).toEqual([
      { url: `${server.url.origin}/before/v1/messages`, model: "upstream", key: "before-key" },
      { url: `${newer.url.origin}/after/v2/chat/completions`, model: "upstream", key: "Bearer after-key" },
    ]);
    expect(gateway.getProviders()).toEqual([]);
    store.saveCandidateModel({
      id: candidate.id,
      providerId: provider.id,
      modelId: "renamed",
      endpointId: "default",
    });
    {
      const response = await bridge(request(candidate.id));
      if (response.status !== 200) throw new Error(await response.text());
      expect(response.status).toBe(200);
    }
    expect(calls.at(-1)?.model).toBe("renamed");
    store.deleteCandidateModel(candidate.id);
    expect((await bridge(request(candidate.id))).status).toBe(400);
    expect(calls).toHaveLength(3);
  } finally {
    gateway.stop();
    server.stop(true);
    newer.stop(true);
    await removeTempDirectory(dir);
  }
});

test("concurrent requests retain their captured endpoint while later requests see changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-candidate-snapshot-"));
  let start!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const gateway = await startEcoGateway(
    { host: "127.0.0.1", port: 0, providers: [] },
    {
      embedded: true,
      onLog: () => {},
      fetchImpl: (async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("old.test")) {
          start();
          await finished;
        }
        return modelResponse(url, JSON.parse(String(init?.body)).model);
      }) as typeof fetch,
    },
  );
  try {
    const store = await createProviderStore(path.join(dir, "eco.sqlite"));
    const provider = store.saveProvider({
      name: "Snapshot",
      baseUrl: "https://old.test",
      apiCompat: "openai_responses",
      apiKey: "test",
      defaultModel: "m",
      enabled: true,
    });
    const candidate = store.saveCandidateModel({ providerId: provider.id, modelId: "m" });
    const bridge = createEcoSdkBridgeHandler({
      gateway,
      resolveCandidateModel: (id) => resolveCandidateModelRequestRoute(store, id),
      onLog: () => {},
    });
    const first = bridge(request(candidate.id));
    await started;
    store.saveProvider({ ...provider, baseUrl: "https://new.test" });
    {
      const response = await bridge(request(candidate.id));
      if (response.status !== 200) throw new Error(await response.text());
      expect(response.status).toBe(200);
    }
    finish();
    expect((await first).status).toBe(200);
    expect(calls).toEqual(["https://old.test/v1/responses", "https://new.test/v1/responses"]);
    store.saveProvider({ ...provider, enabled: false });
    expect((await bridge(request(candidate.id))).status).toBe(400);
    expect(calls).toHaveLength(2);
  } finally {
    finish();
    gateway.stop();
    await removeTempDirectory(dir);
  }
});

test("Claude and PI bindings read current candidate endpoints and keep shared-model role attribution", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-candidate-binding-"));
  const calls: string[] = [],
    roles: string[] = [],
    lifecycleRoles: string[] = [],
    usageRoles: string[] = [];
  const gateway = await startEcoGateway(
    { host: "127.0.0.1", port: 0, providers: [] },
    {
      embedded: true,
      onLog: () => {},
      onRequestLifecycle: (event) =>
        handleGatewayRequestLifecycleEvent(event, {
          onUpstreamRequestId: () => {},
          onUpstreamConnectionError: () => {},
          onLogicalCompleted: ({ role }) => {
            lifecycleRoles.push(role);
          },
        }),
      onUsage: async (event) => {
        await emitClaudeGatewayUsageIfSession(event);
      },
      fetchImpl: (async (input, init) => {
        calls.push(String(input));
        return modelResponse(String(input), JSON.parse(String(init?.body)).model);
      }) as typeof fetch,
    },
  );
  try {
    const store = await createProviderStore(path.join(dir, "eco.sqlite"));
    const provider = store.saveProvider({
      name: "Bound",
      baseUrl: "https://before.test",
      apiCompat: "anthropic",
      apiKey: "test",
      defaultModel: "m",
      enabled: true,
    });
    const candidate = store.saveCandidateModel({ providerId: provider.id, modelId: "m" });
    const secret = store.getProviderWithSecret(provider.id)!;
    const binding = globalClaudeBridgeBindingRegistry.create({
      threadId: "test-thread",
      routes: (["main", "coder"] as const).map((role) => ({
        role,
        provider: secret,
        modelId: "m",
        candidateModelId: candidate.id,
        aliasModelId: candidate.id,
        apiCompat: "anthropic",
      })),
      callbacks: {
        onUsage: ({ role, providerBaseUrl }) => {
          usageRoles.push(role);
          expect(providerBaseUrl).toBe("https://after.test");
        },
        onMessagesRequest: ({ role }) => {
          roles.push(role);
        },
      },
    });
    const bridge = createEcoSdkBridgeHandler({
      gateway,
      resolveCandidateModel: (id) => resolveCandidateModelRequestRoute(store, id),
      onLog: () => {},
      prepareClaudeMessages: ({ path, body, model, headers, candidateRoute }) =>
        prepareClaudeBridgeMessagesRequest({ path, body, requestedModel: model, headers, candidateRoute }),
      prepareGatewayBindingForward: ({ face, body, model, headers, candidateRoute }) =>
        prepareGatewayBindingForwardRequest({ face, body, requestedModel: model, headers, candidateRoute }),
    });
    store.saveProvider({ ...provider, baseUrl: "https://after.test", requestPath: "/proxy" });
    for (const [face, role] of [
      ["messages", "main"],
      ["responses", "coder"],
    ]) {
      const response = await bridge(request(candidate.id, face, binding.credential, role));
      if (response.status !== 200) throw new Error(await response.text());
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(calls).toEqual(["https://after.test/proxy/v1/messages", "https://after.test/proxy/v1/messages"]);
    expect(roles).toEqual(["main", "coder"]);
    expect(binding.routes[0]?.provider.baseUrl).toBe("https://before.test");
    expect(binding.requestRoutes.size).toBe(2);
    expect(binding.inFlight).toBe(0);
    await globalClaudeBridgeBindingRegistry.close(binding.bindingId);
    expect(binding.requestRoutes.size).toBe(0);
    expect(usageRoles).toEqual(["main", "coder"]);
    expect(lifecycleRoles).toEqual(["main", "coder"]);
  } finally {
    gateway.stop();
    await removeTempDirectory(dir);
  }
});
