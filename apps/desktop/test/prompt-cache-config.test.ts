import { expect, test } from "bun:test";
import {
  buildResourcesFromRouteProfile,
  type OrchestrationResourceBundle,
  resolveOrchestrationSnapshot,
} from "../src/shared/agent-orchestration";
import type { McpServerConfigView, ModelSettingsSnapshot } from "../src/shared/ipc";
import {
  buildOrchestrationRuntimeKey,
  formatPromptCacheConfigDriftHint,
  formatPromptCacheConfigDriftMessage,
  formatSnapshotModelStack,
  resolvePromptCacheConfigDrift,
  resolvePromptCacheOrchestrationLabel,
} from "../src/shared/prompt-cache-config";
import type { ThreadRuntimeConfig } from "../src/shared/thread-runtime-config";

function bundle(id: string): OrchestrationResourceBundle {
  return buildResourcesFromRouteProfile(
    {
      id: "coding-default",
      name: "Default coding",
      routes: [
        { role: "main", providerId: "p1", modelId: "m1" },
        { role: "explore", providerId: "p1", modelId: "m1" },
        { role: "architect", providerId: "p1", modelId: "m1" },
        { role: "coder", providerId: "p1", modelId: "m1" },
        { role: "reviewer", providerId: "p1", modelId: "m1" },
        { role: "tester", providerId: "p1", modelId: "m1" },
      ],
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    },
    {
      mainAgentConfigId: `${id}.main`,
      subagentOrchestrationId: `${id}.subagents`,
      updatedAt: "2026-07-27T00:00:00.000Z",
    },
  );
}

const bundleA = bundle("a");
const bundleB = bundle("b");
const settings: ModelSettingsSnapshot = {
  providers: [
    {
      id: "p1",
      name: "GPT",
      baseUrl: "https://example.com",
      requestPath: "",
      version: "v1",
      apiCompat: "anthropic",
      defaultModel: "m1",
      enabled: true,
      hasApiKey: true,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    },
    {
      id: "p2",
      name: "DeepSeek",
      baseUrl: "https://example.com",
      requestPath: "",
      version: "v1",
      apiCompat: "anthropic",
      defaultModel: "m2",
      enabled: true,
      hasApiKey: true,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    },
  ],
  routeProfiles: [],
  agentTemplates: [],
  mainAgentConfigs: [bundleA.mainAgentConfig, bundleB.mainAgentConfig],
  mainAgentPrompts: [],
  subagentOrchestrations: [bundleA.subagentOrchestration, bundleB.subagentOrchestration],
};
const mcpServers = [
  { name: "github", enabled: true },
  { name: "mongo", enabled: true },
] as McpServerConfigView[];

function config(
  resourceBundle: OrchestrationResourceBundle = bundleA,
  overrides: Partial<ThreadRuntimeConfig> = {},
): ThreadRuntimeConfig {
  const snapshot = resolveOrchestrationSnapshot(resourceBundle.selection, {
    mainAgentConfigs: settings.mainAgentConfigs,
    mainAgentPrompts: settings.mainAgentPrompts,
    subagentOrchestrations: settings.subagentOrchestrations,
  });
  return {
    orchestrationSelection: resourceBundle.selection,
    resolvedOrchestrationSnapshot: snapshot,
    subagentEnabled: {
      explore: true,
      architect: true,
      coder: true,
      reviewer: true,
      tester: true,
    },
    sessionMode: "agent",
    bashReviewMode: "always",
    ...overrides,
  };
}

test("resolvePromptCacheConfigDrift detects orchestration and MCP changes", () => {
  const baseline = config(bundleA, { mcpServersEnabled: { github: true, mongo: false } });
  expect(
    resolvePromptCacheConfigDrift({
      baseline,
      current: config(bundleB, { mcpServersEnabled: { github: true, mongo: false } }),
      settings,
      mcpServers,
    }),
  ).toEqual(["orchestration"]);
  expect(
    resolvePromptCacheConfigDrift({
      baseline,
      current: config(bundleA, { mcpServersEnabled: { github: true, mongo: true } }),
      settings,
      mcpServers,
    }),
  ).toEqual(["mcp"]);
});

test("orchestration runtime key includes snapshot content but ignores resolution time", () => {
  const original = config().resolvedOrchestrationSnapshot!;
  const edited = structuredClone(original);
  edited.mainAgent.prompt = "Changed prompt content";
  edited.resolvedAt = "2027-01-01T00:00:00.000Z";
  expect(buildOrchestrationRuntimeKey(original, original.selection)).not.toBe(
    buildOrchestrationRuntimeKey(edited, edited.selection),
  );
  const timestampOnly = { ...original, resolvedAt: "2027-01-01T00:00:00.000Z" };
  expect(buildOrchestrationRuntimeKey(original, original.selection)).toBe(
    buildOrchestrationRuntimeKey(timestampOnly, timestampOnly.selection),
  );
});

test("resolvePromptCacheConfigDrift detects model, prompt, Skill and MCP changes", () => {
  const baseline = config();
  expect(
    resolvePromptCacheConfigDrift({
      baseline,
      current: config(bundleA, {
        mainAgentModelOverride: { providerId: "p1", modelId: "m2", thinkingEffort: "high" },
      }),
      settings,
      mcpServers,
    }),
  ).toEqual(["main_model"]);
  expect(
    resolvePromptCacheConfigDrift({
      baseline,
      current: config(bundleA, { mainAgentSystemPromptPresetOverride: "custom_append" }),
      settings,
      mcpServers,
    }),
  ).toEqual(["system_prompt"]);
  expect(
    resolvePromptCacheConfigDrift({
      baseline: config(bundleA, { skillsEnabled: { "project:a": true } }),
      current: config(bundleA, { skillsEnabled: { "project:a": true, "user:b": true } }),
      settings,
      mcpServers,
    }),
  ).toEqual(["skills"]);
});

test("orchestration label and model stack use snapshot display names", () => {
  const runtimeConfig = config();
  const snapshot = structuredClone(runtimeConfig.resolvedOrchestrationSnapshot!);
  const explore = snapshot.agents.find((agent) => agent.agentKey === "explore");
  if (!explore) throw new Error("Missing Explore fixture.");
  explore.modelRef = { providerId: "p2", modelId: "m2" };
  runtimeConfig.resolvedOrchestrationSnapshot = snapshot;
  expect(resolvePromptCacheOrchestrationLabel(settings, runtimeConfig)).toEqual({
    modelStack: "GPT+DeepSeek",
    orchestrationName: "Default coding Main Config / 内置提示词 / Default coding Subagents",
  });
  expect(formatSnapshotModelStack(snapshot, settings.providers)).toBe("GPT+DeepSeek");
});

test("prompt cache drift messages describe orchestration changes", () => {
  const orchestrationLabel = { modelStack: "GPT+DeepSeek", orchestrationName: "Composer" };
  expect(formatPromptCacheConfigDriftHint(["orchestration", "mcp"], { orchestrationLabel })).toContain(
    "已经变更为 GPT+DeepSeek（Composer）",
  );
  expect(formatPromptCacheConfigDriftMessage(["orchestration"], { orchestrationLabel })).toBe(
    "已经变更为 GPT+DeepSeek（Composer）",
  );
});

test("resolvePromptCacheConfigDrift returns empty when signatures match", () => {
  expect(
    resolvePromptCacheConfigDrift({
      baseline: config(bundleA, { mcpServersEnabled: { github: true } }),
      current: config(bundleA, { mcpServersEnabled: { github: true } }),
      settings,
      mcpServers,
    }),
  ).toEqual([]);
});
