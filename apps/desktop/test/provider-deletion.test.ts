import { expect, test } from "bun:test";
import {
  collectProviderDeleteReferences,
  partitionProviderDeleteReferences,
} from "../src/main/provider-deletion";
import type { ModelSettingsSnapshot, ThreadSummary } from "../src/shared/ipc";

const PROVIDER_ID = "provider-a";

test("collects current editable configurations but ignores legacy route profiles", () => {
  const settings = {
    providers: [],
    routeProfiles: [
      {
        id: "profile-a",
        name: "Profile A",
        routes: [
          { role: "main", providerId: PROVIDER_ID, modelId: "model-a" },
          { role: "coder", providerId: PROVIDER_ID, modelId: "model-a" },
        ],
      },
    ],
    agentTemplates: [],
    mainAgentConfigs: [
      {
        id: "main-a",
        name: "Main A",
        modelRef: { providerId: PROVIDER_ID, modelId: "model-a" },
      },
    ],
    mainAgentPrompts: [],
    subagentOrchestrations: [
      {
        id: "orchestration-a",
        name: "Orchestration A",
        agents: [
          { modelRef: { providerId: PROVIDER_ID, modelId: "model-a" } },
          { modelRef: { providerId: PROVIDER_ID, modelId: "model-b" } },
        ],
      },
    ],
  } as unknown as ModelSettingsSnapshot;

  expect(collectProviderDeleteReferences(PROVIDER_ID, settings, [])).toEqual([
    { kind: "main_agent_config", id: "main-a", name: "Main A" },
    {
      kind: "subagent_orchestration",
      id: "orchestration-a",
      name: "Orchestration A",
    },
  ]);
});

test("only active queued or running threads block deletion", () => {
  const threads = [
    threadWithProvider("queued", "queued-thread"),
    threadWithProvider("running", "running-thread"),
    threadWithProvider("idle", "idle-thread"),
    threadWithProvider("completed", "completed-thread"),
    threadWithProvider("failed", "failed-thread"),
  ];

  expect(collectProviderDeleteReferences(PROVIDER_ID, emptySettings(), threads)).toEqual([
    { kind: "active_thread", id: "queued-thread", name: "queued-thread" },
    { kind: "active_thread", id: "running-thread", name: "running-thread" },
  ]);
});

test("detects active thread overrides and ignores unrelated providers", () => {
  const matchingOverride = threadWithOverride("running", "matching", PROVIDER_ID);
  const unrelated = threadWithOverride("running", "unrelated", "provider-b");

  expect(
    collectProviderDeleteReferences(PROVIDER_ID, emptySettings(), [matchingOverride, unrelated]),
  ).toEqual([{ kind: "active_thread", id: "matching", name: "matching" }]);
});

test("partitions cascading configs from blocking active threads", () => {
  const partitioned = partitionProviderDeleteReferences([
    { kind: "main_agent_config", id: "main-a", name: "Main A" },
    { kind: "subagent_orchestration", id: "orch-a", name: "Orch A" },
    { kind: "active_thread", id: "thread-a", name: "Thread A" },
    { kind: "route_profile", id: "legacy", name: "Legacy" },
  ]);

  expect(partitioned.blocking).toEqual([{ kind: "active_thread", id: "thread-a", name: "Thread A" }]);
  expect(partitioned.cascadeMainAgentConfigs).toEqual([
    { kind: "main_agent_config", id: "main-a", name: "Main A" },
  ]);
  expect(partitioned.cascadeSubagentOrchestrations).toEqual([
    { kind: "subagent_orchestration", id: "orch-a", name: "Orch A" },
  ]);
});

function emptySettings(): ModelSettingsSnapshot {
  return {
    providers: [],
    routeProfiles: [],
    agentTemplates: [],
    mainAgentConfigs: [],
    mainAgentPrompts: [],
    subagentOrchestrations: [],
  };
}

function threadWithProvider(status: ThreadSummary["status"], id: string): ThreadSummary {
  return {
    id,
    title: id,
    status,
    runtimeConfig: {
      resolvedOrchestrationSnapshot: {
        mainAgent: {
          modelRef: { providerId: PROVIDER_ID, modelId: "model-a" },
        },
        agents: [],
      },
    },
  } as unknown as ThreadSummary;
}

function threadWithOverride(status: ThreadSummary["status"], id: string, providerId: string): ThreadSummary {
  return {
    id,
    title: id,
    status,
    runtimeConfig: {
      mainAgentModelOverride: {
        providerId,
        modelId: "model-a",
      },
    },
  } as unknown as ThreadSummary;
}
