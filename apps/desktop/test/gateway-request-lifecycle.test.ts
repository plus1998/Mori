import { afterEach, describe, expect, test } from "bun:test";
import {
  type ClaudeBridgeBindingRoute,
  globalClaudeBridgeBindingRegistry,
} from "../src/main/claude-bridge-binding";
import {
  clearGatewayRequestLifecycleStateForTests,
  handleGatewayRequestLifecycleEvent,
  resolveBindingRoleForRoutes,
} from "../src/main/gateway-request-lifecycle";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import type { RuntimeAgentRole } from "../src/shared/ipc";

const registry = globalClaudeBridgeBindingRegistry;

function providerSecret(id: string): ProviderConfigSecret {
  return {
    id,
    name: id,
    baseUrl: "http://mock",
    requestPath: "",
    version: "v1",
    defaultModel: "model-a",
    enabled: true,
    hasApiKey: true,
    apiKey: "sk",
    createdAt: "",
    updatedAt: "",
  };
}

function createBinding(routes: ClaudeBridgeBindingRoute[]) {
  return registry.create({
    threadId: "thread-1",
    runAttemptId: "attempt-1",
    routes,
  });
}

afterEach(() => {
  registry.clearAllForTests();
  clearGatewayRequestLifecycleStateForTests();
});

describe("gateway-request-lifecycle desktop bridge", () => {
  test("route mismatch fails closed without guessing routes[0]", () => {
    const binding = createBinding([
      {
        role: "coder",
        provider: providerSecret("pa"),
        modelId: "model-a",
        aliasModelId: "alias-a",
        apiCompat: "anthropic",
      },
      {
        role: "main",
        provider: providerSecret("pb"),
        modelId: "model-b",
        aliasModelId: "alias-b",
        apiCompat: "anthropic",
      },
    ]);

    const requestIds: string[] = [];
    handleGatewayRequestLifecycleEvent(
      {
        type: "upstream.headers",
        source: "messages",
        providerId: "unknown",
        requestedModel: "no-match",
        upstreamModelId: "no-match",
        bridgeBindingId: binding.bindingId,
        threadId: "thread-1",
        logicalRequestId: "lr_test_mismatch",
        attemptIndex: 0,
        providerRequestId: "req_mismatch",
        statusCode: 200,
        observedAt: new Date().toISOString(),
      },
      {
        onUpstreamRequestId: ({ requestId }) => requestIds.push(requestId),
        onUpstreamConnectionError: () => {},
      },
    );

    expect(requestIds).toEqual([]);
  });

  test("requested alias selects correct role when routes share provider and concrete model", () => {
    const binding = createBinding([
      {
        role: "coder",
        provider: providerSecret("pa"),
        modelId: "shared-model",
        aliasModelId: "alias-coder",
        apiCompat: "anthropic",
      },
      {
        role: "main",
        provider: providerSecret("pa"),
        modelId: "shared-model",
        aliasModelId: "alias-planner",
        apiCompat: "anthropic",
      },
    ]);

    const roles: RuntimeAgentRole[] = [];
    handleGatewayRequestLifecycleEvent(
      {
        type: "logical.completed",
        source: "messages",
        providerId: "pa",
        requestedModel: "alias-planner",
        upstreamModelId: "shared-model",
        bridgeBindingId: binding.bindingId,
        threadId: "thread-1",
        logicalRequestId: "lr_alias_planner",
        attemptIndex: 0,
        observedAt: new Date().toISOString(),
      },
      {
        onUpstreamRequestId: () => {},
        onUpstreamConnectionError: () => {},
        onLogicalCompleted: (input) => roles.push(input.role),
      },
    );
    expect(roles).toEqual(["main"]);
  });

  test("ambiguous concrete model match does not invoke lifecycle handlers", () => {
    const binding = createBinding([
      {
        role: "coder",
        provider: providerSecret("pa"),
        modelId: "shared-model",
        aliasModelId: "alias-coder",
        apiCompat: "anthropic",
      },
      {
        role: "main",
        provider: providerSecret("pa"),
        modelId: "shared-model",
        aliasModelId: "alias-planner",
        apiCompat: "anthropic",
      },
    ]);

    const completed: RuntimeAgentRole[] = [];
    handleGatewayRequestLifecycleEvent(
      {
        type: "logical.completed",
        source: "messages",
        providerId: "pa",
        requestedModel: "missing-alias",
        upstreamModelId: "shared-model",
        bridgeBindingId: binding.bindingId,
        threadId: "thread-1",
        logicalRequestId: "lr_ambiguous",
        attemptIndex: 0,
        observedAt: new Date().toISOString(),
      },
      {
        onUpstreamRequestId: () => {},
        onUpstreamConnectionError: () => {},
        onLogicalCompleted: (input) => completed.push(input.role),
      },
    );
    expect(completed).toEqual([]);
    expect(
      resolveBindingRoleForRoutes(binding.routes, {
        providerId: "pa",
        requestedModel: "missing-alias",
        upstreamModelId: "shared-model",
      }),
    ).toBeUndefined();
  });

  test("same binding concurrent logical requests with shared provider request id both adopt", () => {
    const binding = createBinding([
      {
        role: "coder",
        provider: providerSecret("pa"),
        modelId: "model-a",
        aliasModelId: "alias-a",
        apiCompat: "anthropic",
      },
    ]);

    const adopted: Array<{ logicalRequestId: string; requestId: string }> = [];
    const sharedProviderId = "req_shared_upstream";
    const baseEvent = {
      type: "upstream.headers" as const,
      source: "messages" as const,
      providerId: "pa",
      requestedModel: "alias-a",
      upstreamModelId: "model-a",
      bridgeBindingId: binding.bindingId,
      threadId: "thread-1",
      attemptIndex: 0,
      providerRequestId: sharedProviderId,
      statusCode: 200,
      observedAt: new Date().toISOString(),
    };

    handleGatewayRequestLifecycleEvent(
      { ...baseEvent, logicalRequestId: "lr_shared_a" },
      {
        onUpstreamRequestId: (input) => adopted.push(input),
        onUpstreamConnectionError: () => {},
      },
    );
    handleGatewayRequestLifecycleEvent(
      { ...baseEvent, logicalRequestId: "lr_shared_b" },
      {
        onUpstreamRequestId: (input) => adopted.push(input),
        onUpstreamConnectionError: () => {},
      },
    );
    handleGatewayRequestLifecycleEvent(
      { ...baseEvent, logicalRequestId: "lr_shared_a" },
      {
        onUpstreamRequestId: (input) => adopted.push(input),
        onUpstreamConnectionError: () => {},
      },
    );

    expect(adopted).toEqual([
      { threadId: "thread-1", role: "coder", requestId: sharedProviderId, logicalRequestId: "lr_shared_a" },
      { threadId: "thread-1", role: "coder", requestId: sharedProviderId, logicalRequestId: "lr_shared_b" },
    ]);
  });

  test("binding close clears dedupe and new binding can adopt same request id", async () => {
    const bindingA = createBinding([
      {
        role: "coder",
        provider: providerSecret("pa"),
        modelId: "model-a",
        aliasModelId: "alias-a",
        apiCompat: "anthropic",
      },
    ]);
    const adoptedA: string[] = [];
    const event = {
      type: "upstream.headers" as const,
      source: "messages" as const,
      providerId: "pa",
      requestedModel: "alias-a",
      upstreamModelId: "model-a",
      bridgeBindingId: bindingA.bindingId,
      threadId: "thread-1",
      logicalRequestId: "lr_test_dedupe",
      attemptIndex: 0,
      providerRequestId: "req_shared",
      statusCode: 200,
      observedAt: new Date().toISOString(),
    };
    handleGatewayRequestLifecycleEvent(event, {
      onUpstreamRequestId: ({ requestId }) => adoptedA.push(requestId),
      onUpstreamConnectionError: () => {},
    });
    handleGatewayRequestLifecycleEvent(event, {
      onUpstreamRequestId: ({ requestId }) => adoptedA.push(requestId),
      onUpstreamConnectionError: () => {},
    });
    expect(adoptedA).toEqual(["req_shared"]);

    await registry.close(bindingA.bindingId);

    const bindingB = createBinding([
      {
        role: "coder",
        provider: providerSecret("pa"),
        modelId: "model-a",
        aliasModelId: "alias-a",
        apiCompat: "anthropic",
      },
    ]);
    const adoptedB: string[] = [];
    handleGatewayRequestLifecycleEvent(
      {
        ...event,
        bridgeBindingId: bindingB.bindingId,
        logicalRequestId: "lr_test_dedupe_b",
        attemptIndex: 0,
      },
      {
        onUpstreamRequestId: ({ requestId }) => adoptedB.push(requestId),
        onUpstreamConnectionError: () => {},
      },
    );
    expect(adoptedB).toEqual(["req_shared"]);
  });

  test("logical completed handler receives provider request id", () => {
    const binding = createBinding([
      {
        role: "coder",
        provider: providerSecret("pa"),
        modelId: "model-a",
        aliasModelId: "alias-a",
        apiCompat: "anthropic",
      },
    ]);
    const completed: Array<{ role: RuntimeAgentRole; logicalRequestId: string; providerRequestId?: string }> =
      [];
    handleGatewayRequestLifecycleEvent(
      {
        type: "logical.completed",
        source: "messages",
        providerId: "pa",
        requestedModel: "alias-a",
        upstreamModelId: "model-a",
        bridgeBindingId: binding.bindingId,
        threadId: "thread-1",
        logicalRequestId: "lr_complete_1",
        attemptIndex: 0,
        providerRequestId: "req_logical_done",
        observedAt: new Date().toISOString(),
      },
      {
        onUpstreamRequestId: () => {},
        onUpstreamConnectionError: () => {},
        onLogicalCompleted: (input) =>
          completed.push({
            role: input.role,
            logicalRequestId: input.logicalRequestId,
            providerRequestId: input.providerRequestId,
          }),
      },
    );
    expect(completed).toEqual([
      { role: "coder", logicalRequestId: "lr_complete_1", providerRequestId: "req_logical_done" },
    ]);
  });

  test("concurrent logical requests same binding same role close independently by logicalRequestId", () => {
    const binding = createBinding([
      {
        role: "coder",
        provider: providerSecret("pa"),
        modelId: "model-a",
        aliasModelId: "alias-a",
        apiCompat: "anthropic",
      },
    ]);

    const completed: Array<{ role: RuntimeAgentRole; logicalRequestId: string }> = [];
    const failed: Array<{ role: RuntimeAgentRole; logicalRequestId: string; error: string }> = [];

    handleGatewayRequestLifecycleEvent(
      {
        type: "logical.completed",
        source: "messages",
        providerId: "pa",
        requestedModel: "alias-a",
        upstreamModelId: "model-a",
        bridgeBindingId: binding.bindingId,
        threadId: "thread-1",
        logicalRequestId: "lr_concurrent_1",
        attemptIndex: 0,
        observedAt: new Date().toISOString(),
      },
      {
        onUpstreamRequestId: () => {},
        onUpstreamConnectionError: () => {},
        onLogicalCompleted: (input) =>
          completed.push({ role: input.role, logicalRequestId: input.logicalRequestId }),
      },
    );

    handleGatewayRequestLifecycleEvent(
      {
        type: "logical.failed",
        source: "messages",
        providerId: "pa",
        requestedModel: "alias-a",
        upstreamModelId: "model-a",
        bridgeBindingId: binding.bindingId,
        threadId: "thread-1",
        logicalRequestId: "lr_concurrent_2",
        attemptIndex: 0,
        error: "transport failure",
        observedAt: new Date().toISOString(),
      },
      {
        onUpstreamRequestId: () => {},
        onUpstreamConnectionError: () => {},
        onLogicalFailed: (input) =>
          failed.push({ role: input.role, logicalRequestId: input.logicalRequestId, error: input.error }),
      },
    );

    expect(completed).toEqual([{ role: "coder", logicalRequestId: "lr_concurrent_1" }]);
    expect(failed).toEqual([
      { role: "coder", logicalRequestId: "lr_concurrent_2", error: "transport failure" },
    ]);
  });
});
