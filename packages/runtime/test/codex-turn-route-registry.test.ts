import { expect, test } from "bun:test";
import { buildCodexGatewayModelAlias } from "../src/codex-config-sync.js";
import { CodexTurnRouteRegistry } from "../src/codex-turn-route-registry.js";

function breakdown(input: number, cached: number, output: number) {
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  };
}

test("CodexTurnRouteRegistry consumes an exact route only once", () => {
  const registry = new CodexTurnRouteRegistry();
  const aliasModelId = buildCodexGatewayModelAlias("provider.same", "model/same", "openai_chat_completions");

  registry.register("thread-1", "turn-1", {
    aliasModelId,
    providerId: "provider.same",
    upstreamModelId: "model/same",
    apiCompat: "openai_chat_completions",
  });

  expect(registry.size).toBe(1);
  expect(registry.consume("thread-1", "turn-1")).toMatchObject({
    aliasModelId,
    providerId: "provider.same",
    upstreamModelId: "model/same",
    apiCompat: "openai_chat_completions",
  });
  expect(registry.consume("thread-1", "turn-1")).toBeUndefined();
  expect(registry.size).toBe(0);
});

test("CodexTurnRouteRegistry clears matching pending state when Gateway registers first", () => {
  const registry = new CodexTurnRouteRegistry();
  const route = {
    aliasModelId: "eco_provider__model",
    providerId: "provider",
    upstreamModelId: "model",
  };
  const owner = registry.registerPending("thread-1", route);
  registry.register("thread-1", "turn-1", route);
  expect(registry.size).toBe(2);

  expect(registry.bindPending(owner, "turn-1")).toMatchObject(route);
  expect(registry.size).toBe(1);
  registry.consume("thread-1", "turn-1");
  expect(registry.size).toBe(0);
});

test("Gateway-first conflict preserves the exact turn and consumes its pending owner", () => {
  const registry = new CodexTurnRouteRegistry();
  const owner = registry.registerPending("thread-1", {
    aliasModelId: "eco_pending__model-a",
    providerId: "pending",
    upstreamModelId: "model-a",
  });

  registry.register("thread-1", "turn-1", {
    aliasModelId: "eco_gateway__model-b",
    providerId: "gateway",
    upstreamModelId: "model-b",
  });

  expect(registry.size).toBe(2);
  expect(registry.peek("thread-1", "turn-1")).toMatchObject({
    aliasModelId: "eco_gateway__model-b",
    providerId: "gateway",
    upstreamModelId: "model-b",
  });
  expect(() => registry.bindPending(owner, "turn-1")).toThrow("Codex turn route registration conflict");
  expect(registry.clearPending(owner)).toBe(false);
  expect(registry.size).toBe(1);
});

test("replaying an old exact turn never consumes a newer pending owner", () => {
  const registry = new CodexTurnRouteRegistry();
  const route = {
    aliasModelId: "eco_provider__model",
    providerId: "provider",
    upstreamModelId: "model",
  };
  registry.register("thread-1", "turn-old", route);
  const newOwner = registry.registerPending("thread-1", route);

  registry.register("thread-1", "turn-old", route);
  expect(registry.size).toBe(2);
  expect(registry.bindPending(newOwner, "turn-new")).toMatchObject({
    turnId: "turn-new",
    ...route,
  });
  expect(registry.peek("thread-1", "turn-old")).toBeDefined();
  expect(registry.peek("thread-1", "turn-new")).toBeDefined();
});

test("a stale owner cannot clear or bind a newer pending generation", () => {
  const registry = new CodexTurnRouteRegistry();
  const route = {
    aliasModelId: "eco_provider__model",
    providerId: "provider",
    upstreamModelId: "model",
  };
  const staleOwner = registry.registerPending("thread-1", route);
  expect(registry.clearPending(staleOwner)).toBe(true);
  const currentOwner = registry.registerPending("thread-1", route);

  expect(registry.clearPending(staleOwner)).toBe(false);
  expect(() => registry.bindPending(staleOwner, "turn-stale")).toThrow("pending owner is no longer active");
  expect(registry.bindPending(currentOwner, "turn-current")?.turnId).toBe("turn-current");
});

test("one Codex thread cannot share a pending owner across concurrent starts", () => {
  const registry = new CodexTurnRouteRegistry();
  const route = {
    aliasModelId: "eco_provider__model",
    providerId: "provider",
    upstreamModelId: "model",
  };
  registry.registerPending("thread-1", route);

  expect(() => registry.registerPending("thread-1", route)).toThrow("already has a pending owner");
});

test("CodexTurnRouteRegistry keeps same provider/model routes distinct by apiCompat", () => {
  const registry = new CodexTurnRouteRegistry();
  const chatAlias = buildCodexGatewayModelAlias("provider.same", "model/same", "openai_chat_completions");
  const anthropicAlias = buildCodexGatewayModelAlias("provider.same", "model/same", "anthropic");

  registry.register("thread-1", "turn-chat", {
    aliasModelId: chatAlias,
    providerId: "provider.same",
    upstreamModelId: "model/same",
    apiCompat: "openai_chat_completions",
  });
  registry.register("thread-1", "turn-anthropic", {
    aliasModelId: anthropicAlias,
    providerId: "provider.same",
    upstreamModelId: "model/same",
    apiCompat: "anthropic",
  });

  expect(registry.consume("thread-1", "turn-chat")?.apiCompat).toBe("openai_chat_completions");
  expect(registry.consume("thread-1", "turn-anthropic")?.apiCompat).toBe("anthropic");
});

test("CodexTurnRouteRegistry aggregates total deltas and ignores duplicate usage notifications", () => {
  const registry = new CodexTurnRouteRegistry();
  registry.register("thread-1", "turn-1", {
    aliasModelId: "eco_provider__model",
    providerId: "provider",
    upstreamModelId: "model",
  });

  registry.observeTokenUsage("thread-1", "turn-1", {
    last: breakdown(100, 40, 10),
    total: breakdown(100, 40, 10),
  });
  registry.observeTokenUsage("thread-1", "turn-1", {
    last: breakdown(150, 80, 20),
    total: breakdown(250, 120, 30),
  });
  registry.observeTokenUsage("thread-1", "turn-1", {
    last: breakdown(150, 80, 20),
    total: breakdown(250, 120, 30),
  });

  expect(registry.peek("thread-1", "turn-1")?.appServerTokenUsage).toEqual({
    inputTokens: 250,
    cachedInputTokens: 120,
    outputTokens: 30,
    reasoningOutputTokens: 0,
    totalTokens: 280,
  });
  expect(registry.peek("thread-1", "turn-1")?.appServerTokenUsageRequests).toEqual([
    breakdown(100, 40, 10),
    breakdown(150, 80, 20),
  ]);
  const firstRequest = registry.peek("thread-1", "turn-1")?.appServerTokenUsageRequests?.[0];
  if (!firstRequest) throw new Error("Missing request snapshot");
  firstRequest.inputTokens = 0;
  expect(registry.peek("thread-1", "turn-1")?.appServerTokenUsageRequests?.[0]?.inputTokens).toBe(100);
  // A missed request leaves a total delta greater than `last`: the split is unknown.
  registry.observeTokenUsage("thread-1", "turn-1", {
    last: breakdown(50, 20, 5),
    total: breakdown(350, 160, 40),
  });
  expect(registry.peek("thread-1", "turn-1")?.appServerTokenUsageRequests).toBeUndefined();
  registry.observeTokenUsage("thread-1", "turn-1", {
    last: breakdown(50, 20, 5),
    total: breakdown(400, 180, 45),
  });
  expect(registry.consume("thread-1", "turn-1")?.appServerTokenUsageRequests).toBeUndefined();
});

test("CodexTurnRouteRegistry uses the prior thread total as the next turn baseline", () => {
  const registry = new CodexTurnRouteRegistry();
  registry.register("thread-1", "turn-1", {
    aliasModelId: "eco_provider__model",
    providerId: "provider",
    upstreamModelId: "model",
  });
  registry.observeTokenUsage("thread-1", "turn-1", {
    last: breakdown(100, 40, 10),
    total: breakdown(100, 40, 10),
  });
  registry.consume("thread-1", "turn-1");

  registry.register("thread-1", "turn-2", {
    aliasModelId: "eco_provider__model",
    providerId: "provider",
    upstreamModelId: "model",
  });
  registry.observeTokenUsage("thread-1", "turn-2", {
    last: breakdown(50, 20, 5),
    total: breakdown(150, 60, 15),
  });

  expect(registry.consume("thread-1", "turn-2")?.appServerTokenUsage).toEqual({
    inputTokens: 50,
    cachedInputTokens: 20,
    outputTokens: 5,
    reasoningOutputTokens: 0,
    totalTokens: 55,
  });
});

test("CodexTurnRouteRegistry applies a late resume replay to a registered turn baseline", () => {
  const registry = new CodexTurnRouteRegistry();
  registry.register("thread-1", "turn-current", {
    aliasModelId: "eco_provider__model",
    providerId: "provider",
    upstreamModelId: "model",
  });

  registry.observeTokenUsage("thread-1", "turn-previous", {
    last: breakdown(100, 40, 10),
    total: breakdown(1_000, 400, 100),
  });
  registry.observeTokenUsage("thread-1", "turn-current", {
    last: breakdown(50, 20, 5),
    total: breakdown(1_050, 420, 105),
  });

  expect(registry.consume("thread-1", "turn-current")?.appServerTokenUsage).toEqual({
    inputTokens: 50,
    cachedInputTokens: 20,
    outputTokens: 5,
    reasoningOutputTokens: 0,
    totalTokens: 55,
  });
});

test("CodexTurnRouteRegistry clears a turn, thread, or all records idempotently", () => {
  const registry = new CodexTurnRouteRegistry();
  const route = {
    aliasModelId: "eco_provider__model",
    providerId: "provider",
    upstreamModelId: "model",
  };
  registry.register("thread-1", "turn-1", route);
  registry.register("thread-1", "turn-2", route);
  registry.register("thread-2", "turn-3", route);

  expect(registry.clearTurn("thread-1", "turn-1")).toBe(true);
  expect(registry.clearTurn("thread-1", "turn-1")).toBe(false);
  expect(registry.clearThread("thread-1")).toBe(1);
  expect(registry.size).toBe(1);
  registry.clearAll();
  expect(registry.size).toBe(0);
});
