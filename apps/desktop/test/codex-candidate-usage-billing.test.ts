import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type GatewayUsageEvent, startEcoGateway } from "@eco/gateway";
import { CodexTurnRouteRegistry } from "@eco/runtime";
import { resolveCandidateModelRequestRoute } from "../src/main/candidate-model-request-route";
import { resolveCodexGatewayUsageBilling } from "../src/main/codex-gateway-usage-billing";
import { registerResolvedCodexGatewayTurnRoute } from "../src/main/codex-runtime-run";
import { createConversationStore } from "../src/main/conversation-store";
import { createEcoSdkBridgeHandler } from "../src/main/eco-sdk-bridge";
import { classifyGatewayUsageEvent } from "../src/main/gateway-usage-dispatch";
import { createProviderStore } from "../src/main/provider-store";
import { resolveSingleUsageBillingOrchestration } from "../src/main/single-usage-billing-orchestration";
import {
  applySingleUsageBillingEffects,
  type UsageBillingUpdatedEvent,
} from "../src/main/usage-billing-effects";
import { UsageLedgerCoordinator } from "../src/main/usage-ledger-coordinator";
import type { ChatApiCompat } from "../src/shared/api-compat";
import { removeTempDirectory } from "./helpers/temp-directory";

// Real Bridge, Gateway and V2 SQLite ledger; only upstream inference is synthetic.
// Freeze the driver route BEFORE the response, as CodexAppServerDriver does.
test.each<ChatApiCompat>([
  "openai_responses",
  "anthropic",
  "openai_chat_completions",
])("candidate Codex usage reaches the live conversation bill over %s", async (apiCompat) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-candidate-billing-"));
  const tasks: Promise<void>[] = [];
  const observed: GatewayUsageEvent[] = [];
  const emitted: UsageBillingUpdatedEvent[] = [];
  const registry = new CodexTurnRouteRegistry();
  const threadId = "thr_candidate_billing";
  const codexThreadId = "codex_billing";
  const turnId = "turn_billing";
  const attemptId = "attempt_billing";
  const agentId = "main:attempt_billing";
  const at = "2026-11-06T00:00:00.000Z";
  const dbPath = path.join(dir, "eco.sqlite");
  const providers = await createProviderStore(dbPath);
  const store = await createConversationStore(dbPath);
  const provider = providers.saveProvider({
    name: "Offline billing",
    baseUrl: "https://offline.test",
    apiCompat,
    apiKey: "test",
    defaultModel: "deepseek-flash",
    enabled: true,
  });
  const candidate = providers.saveCandidateModel({
    providerId: provider.id,
    modelId: "deepseek-flash",
    manualSpec: { inputPerM: 1, outputPerM: 4, cacheReadPerM: 0.02 },
  });
  store.saveThread({
    id: threadId,
    title: "Billing",
    prompt: "Hi",
    workspacePath: dir,
    coreKind: "codex",
    status: "running",
    message: "",
    createdAt: at,
    updatedAt: at,
  });
  store.upsertRunAttempt({
    threadId,
    attemptId,
    phase: "execution",
    retryIndex: 0,
    status: "running",
    startedAt: at,
  });
  store.upsertAgentInstance({
    threadId,
    agentId,
    role: "main",
    kind: "main",
    status: "active",
    runAttemptId: attemptId,
    startedAt: at,
    updatedAt: at,
  });
  const owner = registry.registerPending(codexThreadId, {
    aliasModelId: candidate.id,
    providerId: provider.id,
    upstreamModelId: candidate.modelId,
    apiCompat,
  });
  registry.bindPending(owner, turnId);
  const providerWithSecret = providers.getProviderWithSecret(provider.id);
  if (!providerWithSecret || !candidate.manualSpec) throw new Error("Missing fixture provider or prices");
  const route = {
    role: "main" as const,
    provider: providerWithSecret,
    modelId: candidate.modelId,
    candidateModelId: candidate.id,
    apiCompat,
    manualSpec: candidate.manualSpec,
  };
  const coordinator = new UsageLedgerCoordinator({
    store,
    metrics: { listEntries: () => [] },
    writeError: (message) => {
      throw new Error(message);
    },
  });
  const bill = async (event: GatewayUsageEvent) => {
    expect(classifyGatewayUsageEvent(event).kind).toBe("codex");
    const resolved = resolveCodexGatewayUsageBilling({
      event,
      resolveThreadAttribution: () => ({ ecoThreadId: threadId, billingRole: "main" }),
      resolveParentCodexThreadId: () => undefined,
      resolveRuntimeRoutes: () => [route],
      runAttemptId: () => attemptId,
      plannerAgentId: () => agentId,
    });
    if (resolved.status !== "resolved") throw new Error(`Billing rejected: ${resolved.reason}`);
    const registration = registerResolvedCodexGatewayTurnRoute(
      {
        billingResult: resolved,
        requestedModel: event.requestedModel,
        providerId: event.providerId,
        upstreamModelId: event.upstreamModelId,
      },
      registry,
    );
    if (registration.status !== "registered")
      throw new Error(`Registration failed: ${JSON.stringify(registration)}`);
    const billing = await resolveSingleUsageBillingOrchestration({
      request: resolved.billingInput,
      runtimeRoutes: [route],
      lookupPricing: async () => null,
    });
    if (!billing) throw new Error("Expected nonempty usage");
    await applySingleUsageBillingEffects(
      {
        usageLedger: coordinator,
        context: { applyUpdate: async () => false, getSnapshot: () => undefined, emitLive: () => {} },
        subagentMetrics: { recordContextObservation: () => undefined, recordSdkUsage: () => undefined },
        emitUsageUpdated: (event) => emitted.push(event),
        schedulePersistThreadMetrics: () => {},
      },
      billing.effectsInput,
    );
  };
  const gateway = await startEcoGateway(
    { host: "127.0.0.1", port: 0, providers: [] },
    {
      embedded: true,
      onLog: () => {},
      onUsage: (event) => {
        observed.push(event);
        const task = bill(event);
        tasks.push(task);
        return task;
      },
      fetchImpl: async () => {
        if (apiCompat === "anthropic")
          return Response.json({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: candidate.modelId,
            content: [{ type: "text", text: "OK" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 20 },
          });
        if (apiCompat === "openai_chat_completions")
          return Response.json({
            id: "chat_1",
            object: "chat.completion",
            model: candidate.modelId,
            choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          });
        const response = {
          id: "resp_1",
          object: "response",
          status: "completed",
          model: candidate.modelId,
          output: [],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        };
        return new Response(
          [
            { type: "response.created", response: { ...response, status: "in_progress" } },
            { type: "response.completed", response },
          ]
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  );
  try {
    const bridge = createEcoSdkBridgeHandler({
      gateway,
      resolveCandidateModel: (id) => resolveCandidateModelRequestRoute(providers, id),
      resolveEcoThreadIdFromCodex: () => threadId,
      onLog: () => {},
    });
    const response = await bridge(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: codexThreadId,
            turn_id: turnId,
            request_kind: "turn",
          }),
        },
        body: JSON.stringify({
          model: candidate.id,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }],
          stream: apiCompat === "openai_responses",
        }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(tasks);
    expect(observed).toHaveLength(1);
    expect(registry.peek(codexThreadId, turnId)?.apiCompat).toBe(apiCompat);
    expect(store.listUsageLedgerEvents(threadId)).toHaveLength(1);
    expect(emitted.at(-1)?.payload.billing.ecoCostUsd).toBeCloseTo(0.00018, 10);
    // Repeated delivery cannot double-charge the durable bill.
    const event = observed[0];
    if (!event) throw new Error("Expected upstream usage");
    await bill(event);
    expect(store.listUsageLedgerEvents(threadId)).toHaveLength(1);
    expect(coordinator.resolveV2BillingSnapshot(threadId).ecoCostUsd).toBeCloseTo(0.00018, 10);
    expect((await createConversationStore(dbPath)).listUsageLedgerEvents(threadId)).toHaveLength(1);
    // A real protocol change must still fail; do not relax the registry's identity check.
    const conflict = registerResolvedCodexGatewayTurnRoute(
      {
        billingResult: {
          status: "resolved",
          codexThreadId,
          turnId,
          requestKind: "turn",
          billingInput: { apiCompat: apiCompat === "anthropic" ? "openai_responses" : "anthropic" },
        },
        requestedModel: candidate.id,
        providerId: provider.id,
        upstreamModelId: candidate.modelId,
      },
      registry,
    );
    expect(conflict.status).toBe("conflict");
    expect(registry.peek(codexThreadId, turnId)?.apiCompat).toBe(apiCompat);
  } finally {
    gateway.stop();
    await removeTempDirectory(dir);
  }
});
