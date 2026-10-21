import { expect, test } from "bun:test";
import { ContextWindowMonitor } from "../src/main/context-window-monitor";
import type { ModelsDevPricingCache } from "../src/main/models-dev-pricing-cache";

function mockCache(limit = 100_000, resolved = true): ModelsDevPricingCache {
  return {
    resolveContextLimit: async () => ({
      limit,
      limitsResolved: resolved,
    }),
  } as ModelsDevPricingCache;
}

function roleAwareMockCache(): ModelsDevPricingCache {
  return {
    resolveContextLimit: async (_baseUrl: string, modelId: string) => ({
      limit: modelId === "coder-model" ? 40_000 : 100_000,
      limitsResolved: true,
    }),
  } as ModelsDevPricingCache;
}

test("markCompactCompleted resets occupancy from Core compact post-tokens", async () => {
  const monitor = new ContextWindowMonitor(mockCache());
  await monitor.updateFromUsage("t1", {
    inputTokens: 90_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
  monitor.markCompactCompleted("t1", 20_000);
  expect(monitor.getSnapshot("t1")?.occupied).toBe(20_000);
});

test("prefers planner display while retaining subagent role snapshots", async () => {
  const monitor = new ContextWindowMonitor(mockCache());
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "main" },
  );
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 80_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "coder" },
  );
  const snapshot = monitor.getSnapshot("t1");
  expect(snapshot?.occupied).toBe(500_000);
  expect(snapshot?.displayRole).toBe("main");
  expect(snapshot?.roles.map((role) => role.role)).toEqual(["main", "coder"]);
  expect(snapshot?.roles.find((role) => role.role === "coder")?.occupied).toBe(80_000);
});

test("tracks dynamic orchestration context roles and instances", async () => {
  const monitor = new ContextWindowMonitor(mockCache());
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 40_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "main" },
  );
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 60_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "researcher" },
  );
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 25_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "source_verifier", agentId: "source-agent-1" },
  );

  const snapshot = monitor.getSnapshot("t1");
  expect(snapshot?.displayRole).toBe("main");
  expect(snapshot?.roles.map((role) => role.role)).toEqual(["main", "researcher"]);
  expect(snapshot?.roles.find((role) => role.role === "researcher")?.occupied).toBe(60_000);
  expect(snapshot?.instances?.[0]).toMatchObject({
    agentId: "source-agent-1",
    role: "source_verifier",
    occupied: 25_000,
  });
});

test("resolves context limits per role model", async () => {
  const monitor = new ContextWindowMonitor(roleAwareMockCache());
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 20_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "main", modelId: "planner-model", providerBaseUrl: "https://api.example" },
  );
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 20_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "coder", modelId: "coder-model", providerBaseUrl: "https://api.example" },
  );
  const snapshot = monitor.getSnapshot("t1");
  expect(snapshot?.roles.find((role) => role.role === "main")?.limit).toBe(100_000);
  expect(snapshot?.roles.find((role) => role.role === "coder")?.limit).toBe(40_000);
});

test("caps resolved and SDK-reported context windows with the global limit", async () => {
  let globalLimit = 262_144;
  const monitor = new ContextWindowMonitor(mockCache(1_048_576), () => globalLimit);
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 20_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "main", modelId: "large-model", providerBaseUrl: "https://api.example" },
  );
  expect(monitor.getSnapshot("t1")?.limit).toBe(262_144);

  globalLimit = 131_072;
  await monitor.updateOccupied("t1", "main", 30_000, { limit: 1_048_576 });
  expect(monitor.getSnapshot("t1")?.limit).toBe(131_072);
});

test("does not let a lower Codex catalog window overwrite models.dev limits", async () => {
  const monitor = new ContextWindowMonitor(mockCache(1_050_000), () => 262_144);
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 20_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    {
      role: "main",
      modelId: "gpt-5.6-luna",
      providerBaseUrl: "https://api.example",
    },
  );
  expect(monitor.getSnapshot("t1")?.limit).toBe(262_144);

  // Codex unknown-model catalog default (128k) * effective percent ≈ 121600
  await monitor.updateOccupied("t1", "main", 13_157, { limit: 121_600 });
  expect(monitor.getSnapshot("t1")?.limit).toBe(262_144);
  expect(monitor.getSnapshot("t1")?.occupied).toBe(13_157);
});

test("preserves a model window smaller than the global limit", async () => {
  const monitor = new ContextWindowMonitor(mockCache(128_000), () => 262_144);
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 20_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "main", modelId: "small-model", providerBaseUrl: "https://api.example" },
  );
  expect(monitor.getSnapshot("t1")?.limit).toBe(128_000);
});

test("clearSubagentRoles preserves planner and drops stale child windows", async () => {
  const monitor = new ContextWindowMonitor(mockCache(100_000));
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "main" },
  );
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 50_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "explore" },
  );
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 70_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "coder", agentId: "coder-1" },
  );

  const snapshot = monitor.clearSubagentRoles("t1");

  expect(snapshot?.roles.map((role) => role.role)).toEqual(["main"]);
  expect(snapshot?.occupied).toBe(10_000);
  expect(snapshot?.instances).toEqual([]);
});

test("restores multi-role context snapshots", () => {
  const monitor = new ContextWindowMonitor(mockCache());
  monitor.restoreFromContextSnapshot("t1", {
    occupied: 10_000,
    limit: 100_000,
    occupancyPct: 10,
    limitsResolved: true,
    displayRole: "main",
    segments: [],
    roles: [
      {
        role: "main",
        occupied: 10_000,
        limit: 100_000,
        occupancyPct: 10,
        limitsResolved: true,
        segments: [],
      },
      {
        role: "coder",
        occupied: 30_000,
        limit: 40_000,
        occupancyPct: 75,
        limitsResolved: true,
        modelId: "coder-model",
        segments: [],
      },
    ],
    instances: [
      {
        agentId: "coder-agent-1",
        role: "coder",
        occupied: 12_000,
        limit: 40_000,
        occupancyPct: 30,
        limitsResolved: true,
        modelId: "coder-model",
        segments: [],
        updatedAt: Date.now(),
      },
    ],
    updatedAt: Date.now(),
  });
  const snapshot = monitor.getSnapshot("t1");
  expect(snapshot?.displayRole).toBe("main");
  expect(snapshot?.roles.find((role) => role.role === "coder")?.modelId).toBe("coder-model");
  expect(snapshot?.instances?.[0]?.agentId).toBe("coder-agent-1");
});

test("tracks concurrent coder instances by agentId", async () => {
  const monitor = new ContextWindowMonitor(mockCache(100_000));
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 22_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "coder", agentId: "coder-agent-1" },
  );
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 31_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "coder", agentId: "coder-agent-2" },
  );

  const snapshot = monitor.getSnapshot("t1");
  expect(snapshot?.instances?.map((entry) => entry.agentId)).toEqual(["coder-agent-2", "coder-agent-1"]);
  expect(snapshot?.instances?.map((entry) => entry.occupied)).toEqual([31_000, 22_000]);
});

test("shouldHandoffSubagentResume uses byInstance occupancy when available", async () => {
  const monitor = new ContextWindowMonitor(mockCache(131_072));
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 110_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    {
      role: "explore",
      agentId: "explore-agent-1",
      modelId: "explore-model",
      providerBaseUrl: "https://example.test",
    },
  );

  expect(monitor.getInstanceOccupancy("t1", "explore-agent-1")?.occupied).toBe(110_000);
  expect(monitor.shouldHandoffSubagentResume("t1", "explore-agent-1", "explore", 0.85)).toBe(true);
  expect(monitor.shouldHandoffSubagentResume("t1", "explore-agent-2", "explore", 0.85)).toBe(false);
});

test("shouldHandoffSubagentResume triggers when occupied exceeds nominal limit", async () => {
  const monitor = new ContextWindowMonitor(mockCache(131_072));
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 140_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    {
      role: "explore",
      agentId: "explore-agent-over",
      modelId: "explore-model",
      providerBaseUrl: "https://example.test",
    },
  );

  expect(monitor.shouldHandoffSubagentResume("t1", "explore-agent-over", "explore", 0.85)).toBe(true);
});

test("dedupes assistant usage by messageId", async () => {
  const monitor = new ContextWindowMonitor(mockCache());
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 50_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { messageId: "msg-1" },
  );
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 30_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { messageId: "msg-1" },
  );
  expect(monitor.getSnapshot("t1")?.occupied).toBe(50_000);
});

test("updateOccupied sets planner occupancy from /context header", async () => {
  const monitor = new ContextWindowMonitor(mockCache());
  await monitor.updateFromUsage(
    "t1",
    { inputTokens: 36_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { role: "main", modelId: "planner-model", providerBaseUrl: "https://api.example" },
  );
  await monitor.updateOccupied("t1", "main", 76_000);
  expect(monitor.getSnapshot("t1")?.roles.find((role) => role.role === "main")?.occupied).toBe(76_000);
});

test("updateOccupied can restore subagent instance occupancy by agentId", async () => {
  const monitor = new ContextWindowMonitor(mockCache());
  await monitor.updateOccupied("t1", "explore", 114_000, {
    agentId: "agent_explore",
    modelId: "deepseek-v4-flash",
  });
  const instance = monitor.getSnapshot("t1")?.instances?.find((entry) => entry.agentId === "agent_explore");
  expect(instance?.occupied).toBe(114_000);
  expect(instance?.role).toBe("explore");
});
