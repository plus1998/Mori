import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCandidateModelRouteDefaults } from "../src/main/candidate-model-defaults";
import { testProviderConnection } from "../src/main/provider-models";
import { createProviderStore } from "../src/main/provider-store";
import { resolveThreadRuntimeConfig } from "../src/main/thread-runtime-routes";
import { removeTempDirectory } from "./helpers/temp-directory";

test("saved model selection sends subsequent requests to the edited provider port and path", async () => {
  const requests: string[] = [];
  const serve = () =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(request.url);
        return Response.json({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
  const oldServer = serve();
  const newServer = serve();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-request-update-"));
  try {
    const filename = path.join(dir, "eco.sqlite");
    let store = await createProviderStore(filename);
    const provider = store.saveProvider({
      name: "Local",
      baseUrl: oldServer.url.origin,
      requestPath: "/old",
      version: "v1",
      apiCompat: "anthropic",
      apiKey: "local-test-key",
      defaultModel: "test-model",
      enabled: true,
    });
    // Discovered models also receive materialized provider defaults.
    const candidate = store.syncCandidateModels(provider.id, [{ id: "test-model" }]).models[0]!;
    const selection = {
      role: "main" as const,
      providerId: provider.id,
      modelId: candidate.modelId,
      candidateModelId: candidate.id,
    };
    const send = async () => {
      const routes = resolveCandidateModelRouteDefaults([selection], {
        isBuiltInCodexProvider: () => false,
        isChatGptSubscriptionProvider: () => false,
        listCandidateModels: (providerId) => store.listCandidateModels(providerId),
      });
      const runtime = resolveThreadRuntimeConfig(
        store.getSettings(),
        store.listProvidersWithSecrets(),
        routes,
        {
          requireCompleteCodingRoutes: false,
        },
      );
      if (!runtime.ok) throw new Error(runtime.reason);
      const route = runtime.routes[0]!;
      const result = await testProviderConnection(store, { ...route.provider, defaultModel: route.modelId });
      expect(result.ok).toBe(true);
    };
    await send();
    store.saveProvider({ ...provider, baseUrl: newServer.url.origin, requestPath: "/new", version: "v2" });
    // The same saved model selection resolves current configuration after reopening storage.
    store = await createProviderStore(filename);
    await send();
    expect(requests).toEqual([
      `${oldServer.url.origin}/old/v1/messages`,
      `${newServer.url.origin}/new/v2/messages`,
    ]);
  } finally {
    oldServer.stop(true);
    newServer.stop(true);
    await removeTempDirectory(dir);
  }
});
