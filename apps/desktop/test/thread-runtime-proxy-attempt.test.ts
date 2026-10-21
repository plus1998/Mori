import { expect, test } from "bun:test";
import type { StartedAnthropicProxy } from "../src/main/anthropic-proxy";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import type { RunAttemptContext } from "../src/main/thread-run-attempt";
import { runThreadRequestWithRuntimeProxy } from "../src/main/thread-runtime-proxy-attempt";
import type { AgentRole } from "../src/shared/ipc";

function attemptContext(threadId: string): RunAttemptContext {
  return { threadId, runAttemptId: "attempt_test", phase: "execution" };
}

function provider(id: string): ProviderConfigSecret {
  return {
    id,
    name: `Provider ${id}`,
    baseUrl: `https://${id}.example.test`,
    requestPath: "/v1/messages",
    version: "v1",
    apiCompat: "anthropic",
    defaultModel: "claude-test",
    enabled: true,
    hasApiKey: true,
    apiKeyPreview: "sk-...",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    apiKey: "secret",
  };
}

function runtimeRoute(role: AgentRole): RuntimeRoute {
  return {
    role,
    provider: provider("p1"),
    modelId: `${role}-model`,
    apiCompat: "anthropic",
  };
}

function startedProxy(closeEvents: string[]): StartedAnthropicProxy {
  return {
    apiKey: "local-key",
    baseUrl: "http://127.0.0.1:41234",
    bindingId: "cbb_test",
    routes: [
      { ...runtimeRoute("main"), aliasModelId: "eco-planner" },
      { ...runtimeRoute("coder"), aliasModelId: "eco-coder" },
    ],
    async close() {
      closeEvents.push("closed");
    },
  };
}

test("runThreadRequestWithRuntimeProxy skips proxy start when config fails", async () => {
  let proxyStarted = false;

  const result = await runThreadRequestWithRuntimeProxy({
    context: attemptContext("thr_config"),
    resolveRuntimeConfig: () => ({ ok: false, reason: "missing route" }),
    recordRouteFingerprint: () => {
      throw new Error("should not record");
    },
    startRuntimeProxy: async (_routes, _attachments, context) => {
      expect(context.runAttemptId).toBe("attempt_test");
      proxyStarted = true;
      return startedProxy([]);
    },
    run: async () => ({ ok: true }),
  });

  expect(result).toEqual({ ok: false, reason: "missing route" });
  expect(proxyStarted).toBe(false);
});

test("runThreadRequestWithRuntimeProxy records routes, builds driver routes and closes proxy", async () => {
  const closeEvents: string[] = [];
  const records: Array<{ threadId: string; routes: RuntimeRoute[] }> = [];
  const order: string[] = [];

  const result = await runThreadRequestWithRuntimeProxy({
    context: attemptContext("thr_proxy"),
    resolveRuntimeConfig: () => ({ ok: true, routes: [runtimeRoute("main")] }),
    recordRouteFingerprint: (threadId, routes) => {
      order.push("record");
      records.push({ threadId, routes: [...routes] });
    },
    startRuntimeProxy: async () => {
      order.push("start");
      return startedProxy(closeEvents);
    },
    onProxyReady: (attempt) => {
      order.push("ready");
      expect(attempt.plannerRoute?.aliasModelId).toBe("eco-planner");
      expect(attempt.routes[0]?.primary.modelId).toBe("eco-planner");
    },
    run: async (attempt) => {
      order.push("run");
      return { ok: true, planCaptured: attempt.routes.length === 2 };
    },
  });

  expect(result).toEqual({ ok: true, planCaptured: true });
  expect(records).toEqual([{ threadId: "thr_proxy", routes: [runtimeRoute("main")] }]);
  expect(closeEvents).toEqual(["closed"]);
  expect(order).toEqual(["start", "ready", "run", "record"]);
});

test("runThreadRequestWithRuntimeProxy does not record fingerprint when run throws", async () => {
  const closeEvents: string[] = [];
  let recorded = false;

  await expect(
    runThreadRequestWithRuntimeProxy({
      context: attemptContext("thr_throw_no_record"),
      resolveRuntimeConfig: () => ({ ok: true, routes: [runtimeRoute("main")] }),
      recordRouteFingerprint: () => {
        recorded = true;
      },
      startRuntimeProxy: async () => startedProxy(closeEvents),
      run: async () => {
        throw new Error("driver failed");
      },
    }),
  ).rejects.toThrow("driver failed");

  expect(recorded).toBe(false);
  expect(closeEvents).toEqual(["closed"]);
});

test("runThreadRequestWithRuntimeProxy closes proxy when run throws", async () => {
  const closeEvents: string[] = [];

  await expect(
    runThreadRequestWithRuntimeProxy({
      context: attemptContext("thr_throw"),
      resolveRuntimeConfig: () => ({ ok: true, routes: [runtimeRoute("main")] }),
      recordRouteFingerprint: () => {},
      startRuntimeProxy: async () => startedProxy(closeEvents),
      run: async () => {
        throw new Error("driver failed");
      },
    }),
  ).rejects.toThrow("driver failed");

  expect(closeEvents).toEqual(["closed"]);
});
