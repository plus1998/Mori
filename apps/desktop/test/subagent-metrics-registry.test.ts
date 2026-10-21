import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyCostBreakdown } from "@eco/runtime";
import type { ConversationStore } from "../src/main/conversation-store";
import { createConversationStore } from "../src/main/conversation-store";
import type { SubagentMetricsDiagnosticsPort } from "../src/main/subagent-metrics-diagnostics";
import type { SubagentMetricsPersistenceStore } from "../src/main/subagent-metrics-persistence";
import { SubagentMetricsRegistry } from "../src/main/subagent-metrics-registry";

function seedThread(store: ConversationStore, threadId: string): void {
  const now = new Date().toISOString();
  store.saveThread({
    id: threadId,
    title: "Test",
    prompt: "hello",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "ok",
    createdAt: now,
    updatedAt: now,
  });
}

const metricsStoreStub: SubagentMetricsPersistenceStore = {
  listSubagentMetrics: () => [],
  upsertSubagentMetrics: () => {},
  clearSubagentMetrics: () => {},
};

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!sqliteAvailable)("resolves agent via parent tool_use_id and persists metrics", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-subagent-metrics-"));
  const store = await createConversationStore(path.join(dir, "eco.sqlite"));
  const registry = new SubagentMetricsRegistry(store);
  const threadId = "thr_subagent_metrics";
  seedThread(store, threadId);

  registry.noteTaskToolUse(threadId, "toolu_task_1");
  registry.onSubagentStart(threadId, {
    agentId: "agent_explore_a",
    role: "explore",
    parentToolUseId: "toolu_task_1",
  });

  const resolved = registry.resolveAgentId(threadId, {
    role: "explore",
    parentToolUseId: "toolu_task_1",
  });
  expect(resolved).toBe("agent_explore_a");

  registry.recordSdkUsage(threadId, {
    role: "explore",
    agentId: "agent_explore_a",
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
    },
    contextOccupied: 1060,
    contextLimit: 200_000,
    billing: {
      ecoCostUsd: 0.01,
      plannerTokenCostUsd: 0,
      ecoBreakdown: emptyCostBreakdown(),
      plannerBreakdown: emptyCostBreakdown(),
      pricingResolved: false,
    },
    modelId: "claude-test",
    requestKey: "sdk-result:evt_1",
  });

  const rows = store.listSubagentMetrics(threadId);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.agentId).toBe("agent_explore_a");
  expect(rows[0]?.inputTokens).toBe(1000);
  expect(rows[0]?.ecoCostUsd).toBe(0.01);

  registry.onSubagentStop(threadId, { agentId: "agent_explore_a", role: "explore" });
  const restored = new SubagentMetricsRegistry(store);
  restored.restoreFromStore(threadId);
  const entries = restored.listEntries(threadId);
  expect(entries[0]?.status).toBe("stopped");
  expect(entries[0]?.usage.inputTokens).toBe(1000);
});

test("resolveAgentId maps parent tool_use_id even when event role is planner", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const threadId = "thr_parent_planner";
  registry.noteTaskToolUse(threadId, "toolu_task_2");
  registry.onSubagentStart(threadId, {
    agentId: "agent_explore_b",
    role: "explore",
    parentToolUseId: "toolu_task_2",
  });
  expect(
    registry.resolveAgentId(threadId, {
      role: "main",
      parentToolUseId: "toolu_task_2",
    }),
  ).toBe("agent_explore_b");
});

test("SubagentMetricsRegistry emits diagnostics through injected port", () => {
  const lifecycle: unknown[] = [];
  const taskTools: unknown[] = [];
  const diagnostics: SubagentMetricsDiagnosticsPort = {
    logLifecycle: (input) => lifecycle.push(input),
    logTaskTool: (input) => taskTools.push(input),
    logResolveMiss: () => undefined,
    logUsageDedupe: () => undefined,
  };
  const registry = new SubagentMetricsRegistry(metricsStoreStub, diagnostics);
  const threadId = "thr_injected_diag";

  registry.noteTaskToolUse(threadId, "toolu_task_1", "coder");
  registry.onSubagentStart(threadId, {
    agentId: "agent_coder_a",
    role: "coder",
    parentToolUseId: "toolu_task_1",
  });
  registry.onSubagentStop(threadId, { agentId: "agent_coder_a", role: "coder" });

  expect(taskTools).toEqual([
    {
      threadId,
      toolUseId: "toolu_task_1",
      role: "coder",
      pending: true,
      pendingCount: 1,
    },
  ]);
  expect(lifecycle).toEqual([
    {
      threadId,
      event: "start",
      role: "coder",
      agentId: "agent_coder_a",
      activeCount: 1,
      toolUseLinks: 1,
    },
    {
      threadId,
      event: "stop",
      role: "coder",
      agentId: "agent_coder_a",
      activeCount: 0,
    },
  ]);
});

test("resolveAgentId does not consume queued parent tool_use ids without explicit parent", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const threadId = "thr_parallel_queue";

  registry.noteTaskToolUse(threadId, "toolu_task_a");
  registry.noteTaskToolUse(threadId, "toolu_task_b");
  registry.onSubagentStart(threadId, { agentId: "agent_coder_a", role: "coder" });
  registry.onSubagentStart(threadId, { agentId: "agent_coder_b", role: "coder" });

  expect(
    registry.resolveAgentId(threadId, { role: "coder", parentToolUseId: "toolu_task_a" }),
  ).toBeUndefined();
  expect(
    registry.resolveAgentId(threadId, { role: "coder", parentToolUseId: "toolu_task_b" }),
  ).toBeUndefined();
});

test("resolveAgentId does not match queued parent tool_use ids by role", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const threadId = "thr_parallel_role_queue";

  registry.noteTaskToolUse(threadId, "toolu_task_explore", "explore");
  registry.noteTaskToolUse(threadId, "toolu_task_coder", "coder");
  registry.onSubagentStart(threadId, { agentId: "agent_coder_a", role: "coder" });
  registry.onSubagentStart(threadId, { agentId: "agent_explore_a", role: "explore" });

  expect(
    registry.resolveAgentId(threadId, { role: "main", parentToolUseId: "toolu_task_coder" }),
  ).toBeUndefined();
  expect(
    registry.resolveAgentId(threadId, { role: "main", parentToolUseId: "toolu_task_explore" }),
  ).toBeUndefined();
});

test("resolveAgentId links explicit parentToolUseId even when subagent starts out of order", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const threadId = "thr_explicit_parent";

  registry.noteTaskToolUse(threadId, "toolu_task_a", "coder");
  registry.noteTaskToolUse(threadId, "toolu_task_b", "coder");
  registry.onSubagentStart(threadId, {
    agentId: "agent_coder_b",
    role: "coder",
    parentToolUseId: "toolu_task_b",
  });
  registry.onSubagentStart(threadId, {
    agentId: "agent_coder_a",
    role: "coder",
    parentToolUseId: "toolu_task_a",
  });

  expect(
    registry.resolveAgentId(threadId, {
      role: "coder",
      parentToolUseId: "toolu_task_a",
    }),
  ).toBe("agent_coder_a");
  expect(
    registry.resolveAgentId(threadId, {
      role: "coder",
      parentToolUseId: "toolu_task_b",
    }),
  ).toBe("agent_coder_b");
});

test("resolveAgentId matches dynamic runtime roles", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const threadId = "thr_dynamic_role_queue";

  registry.noteTaskToolUse(threadId, "toolu_research", "researcher");
  registry.onSubagentStart(threadId, {
    agentId: "agent_researcher",
    role: "researcher",
    parentToolUseId: "toolu_research",
  });

  expect(
    registry.resolveAgentId(threadId, {
      role: "researcher",
      parentToolUseId: "toolu_research",
    }),
  ).toBe("agent_researcher");
  expect(registry.roleForAgentId(threadId, "agent_researcher")).toBe("researcher");
});

test("recordContextObservation updates context without billing usage", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const threadId = "thr_subagent_context_observation";
  registry.onSubagentStart(threadId, { agentId: "agent_coder_a", role: "coder" });

  registry.recordContextObservation(threadId, {
    role: "coder",
    agentId: "agent_coder_a",
    contextOccupied: 1260,
    contextLimit: 100_000,
    modelId: "claude-test",
    requestKey: "sdk-result:evt_context",
  });

  const contextOnlyEntry = registry.listEntries(threadId)[0];
  expect(contextOnlyEntry?.usage.inputTokens).toBe(0);
  expect(contextOnlyEntry?.ecoCostUsd).toBe(0);
  expect(contextOnlyEntry?.contextOccupied).toBe(1260);
  expect(contextOnlyEntry?.contextLimit).toBe(100_000);
  expect(contextOnlyEntry?.modelId).toBe("claude-test");
  expect(contextOnlyEntry?.lastRequestKey).toBe("sdk-result:evt_context");

  registry.recordSdkUsage(threadId, {
    role: "coder",
    agentId: "agent_coder_a",
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
    },
    contextOccupied: 1260,
    billing: {
      ecoCostUsd: 0.01,
      plannerTokenCostUsd: 0,
      ecoBreakdown: emptyCostBreakdown(),
      plannerBreakdown: emptyCostBreakdown(),
      pricingResolved: false,
    },
    modelId: "claude-test",
    requestKey: "sdk-result:evt_context",
  });

  const billedEntry = registry.listEntries(threadId)[0];
  expect(billedEntry?.usage.inputTokens).toBe(1000);
  expect(billedEntry?.ecoCostUsd).toBeCloseTo(0.01);
});

test("recordSdkUsage is idempotent per agent request and model", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  const threadId = "thr_subagent_usage_dedupe";
  registry.onSubagentStart(threadId, { agentId: "agent_coder_a", role: "coder" });

  const usage = {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 50,
    cacheCreationTokens: 10,
  };
  const billing = {
    ecoCostUsd: 0.01,
    plannerTokenCostUsd: 0,
    ecoBreakdown: emptyCostBreakdown(),
    plannerBreakdown: emptyCostBreakdown(),
    pricingResolved: false,
  };

  registry.recordSdkUsage(threadId, {
    role: "coder",
    agentId: "agent_coder_a",
    usage,
    contextOccupied: 1260,
    billing,
    modelId: "claude-test-a",
    requestKey: "sdk-result:evt_1",
  });
  registry.recordSdkUsage(threadId, {
    role: "coder",
    agentId: "agent_coder_a",
    usage,
    contextOccupied: 1260,
    billing,
    modelId: "claude-test-a",
    requestKey: "sdk-result:evt_1",
  });
  registry.recordSdkUsage(threadId, {
    role: "coder",
    agentId: "agent_coder_a",
    usage,
    contextOccupied: 1260,
    billing,
    modelId: "claude-test-b",
    requestKey: "sdk-result:evt_1",
  });

  const entry = registry.listEntries(threadId)[0];
  expect(entry?.usage.inputTokens).toBe(2000);
  expect(entry?.usage.outputTokens).toBe(400);
  expect(entry?.ecoCostUsd).toBeCloseTo(0.02);
  expect(entry?.lastRequestKey).toBe("sdk-result:evt_1");
});

test.skipIf(!sqliteAvailable)("does not resolve role-only usage to a sole active subagent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-subagent-resolve-"));
  const store = await createConversationStore(path.join(dir, "eco.sqlite"));
  const registry = new SubagentMetricsRegistry(store);
  const threadId = "thr_resolve";
  seedThread(store, threadId);

  registry.onSubagentStart(threadId, { agentId: "agent_coder_a", role: "coder" });
  expect(registry.resolveAgentId(threadId, { role: "coder" })).toBeUndefined();
});
