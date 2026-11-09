import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { buildResourcesFromRouteProfile } from "../src/shared/agent-orchestration";
import type { ModelSettingsSnapshot, ThreadRuntimeConfig } from "../src/shared/ipc";
import {
  buildAcpThreadRuntimeConfig,
  isThreadRuntimeConfig,
  parseThreadRuntimeConfigJson,
  serializeThreadRuntimeConfig,
  materializeThreadOrchestrationSnapshot,
  resolveThreadOrchestrationSnapshot,
  resolveThreadRuntimeConfigUpdate,
  runtimeRoleRoutesFromOrchestrationSnapshot,
} from "../src/shared/thread-runtime-config";
import { pruneThreadRuntimeConfigReferences, resolveThreadRuntimeConfigEdit } from "../src/shared/thread-runtime-config-references";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { executeRuntimeConfigMutationCommand } from "../src/main/conversation-runtime-config-command";

function fixture() {
  const bundle = buildResourcesFromRouteProfile({
    id: "profile", name: "Saved config", routes: (["main", "explore", "architect", "coder", "reviewer", "tester"] as const).map(role => ({
      role, providerId: "vendor", modelId: "deleted", candidateModelId: "deleted-candidate",
    })), createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
  }, { mainAgentConfigId: "main-config", subagentOrchestrationId: "subagents" });
  bundle.mainAgentConfig.modelRef.candidateModelId = "deleted-candidate";
  for (const agent of bundle.subagentOrchestration.agents) agent.modelRef.candidateModelId = "deleted-candidate";
  const settings: ModelSettingsSnapshot = {
    providers: [], routeProfiles: [], agentTemplates: [], mainAgentConfigs: [bundle.mainAgentConfig],
    mainAgentPrompts: [], subagentOrchestrations: [bundle.subagentOrchestration],
  };
  const original: ThreadRuntimeConfig = {
    ...buildAcpThreadRuntimeConfig(), ...materializeThreadOrchestrationSnapshot(settings, bundle.selection),
  };
  const available = (model: { candidateModelId?: string }) => model.candidateModelId !== "deleted-candidate";
  const validModel = { providerId: "vendor", modelId: "valid", candidateModelId: "valid-candidate", thinkingEffort: "xhigh" as const };
  return { settings, original, available, validModel };
}

test("choosing a valid main model removes deleted subagents and their enabled flags", () => {
  const { settings, original, available, validModel } = fixture();
  const saved = resolveThreadRuntimeConfigEdit(settings, original, {
    ...original,
    orchestrationSelection: { mainModel: validModel, mainPrompt: { mode: "builtin" }, subagents: original.orchestrationSelection!.subagents },
  }, available);
  expect(saved.resolvedOrchestrationSnapshot?.mainAgent.modelRef).toEqual(validModel);
  expect(saved.resolvedOrchestrationSnapshot?.agents).toEqual([]);
  expect(saved.orchestrationSelection?.subagents).toEqual({ mode: "none" });
  expect(Object.values(saved.subagentEnabled).every(value => !value)).toBe(true);
  expect(JSON.stringify(saved)).not.toContain("deleted-candidate");
  expect(original.resolvedOrchestrationSnapshot?.agents.length).toBeGreaterThan(0);
});

test("choosing valid subagents clears the deleted main model and saves a selectable partial config", () => {
  const { settings, original, available, validModel } = fixture();
  settings.subagentOrchestrations[0]!.agents.forEach(agent => { agent.modelRef = validModel; });
  const incoming = { ...original, ...materializeThreadOrchestrationSnapshot(settings, original.orchestrationSelection!) };
  const saved = resolveThreadRuntimeConfigEdit(settings, original, incoming, available);
  expect(saved.orchestrationSelection?.mainAgentConfigId).toBeUndefined();
  expect(saved.orchestrationSelection?.mainModel).toBeUndefined();
  expect(saved.orchestrationSelection?.subagents).toEqual({ mode: "orchestration", orchestrationId: "subagents" });
  expect(saved.resolvedOrchestrationSnapshot).toBeUndefined();
  expect(isThreadRuntimeConfig(saved)).toBe(true);
  expect(parseThreadRuntimeConfigJson(serializeThreadRuntimeConfig(saved))).toEqual(saved);
  expect(resolveThreadOrchestrationSnapshot(settings, saved)).toBeUndefined();
  // Editing can save a draft, but starting a run cannot invent a main model.
  expect(() => resolveThreadRuntimeConfigUpdate(settings, undefined, saved)).toThrow("编排组合不完整");
  const completed = resolveThreadRuntimeConfigEdit(settings, saved, {
    ...saved, orchestrationSelection: { ...saved.orchestrationSelection!, mainModel: validModel },
  }, available);
  expect(completed.resolvedOrchestrationSnapshot?.mainAgent.modelRef).toEqual(validModel);
  expect(completed.resolvedOrchestrationSnapshot?.agents.length).toBeGreaterThan(0);
});

test("a deleted orchestration is removed before either frontend materialization or backend save", () => {
  const { settings, original, available, validModel } = fixture();
  settings.subagentOrchestrations = [];
  const input = { ...original, orchestrationSelection: {
    mainModel: validModel, mainPrompt: { mode: "builtin" as const }, subagents: original.orchestrationSelection!.subagents,
  } };
  const frontend = pruneThreadRuntimeConfigReferences(settings, input);
  expect(frontend.orchestrationSelection?.subagents).toEqual({ mode: "none" });
  expect(() => materializeThreadOrchestrationSnapshot(settings, frontend.orchestrationSelection!)).not.toThrow();
  const saved = resolveThreadRuntimeConfigEdit(settings, original, input, available);
  expect(saved.resolvedOrchestrationSnapshot?.agents).toEqual([]);
  expect(saved.resolvedOrchestrationSnapshot?.mainAgent.modelRef).toEqual(validModel);
});

test("cleanup removes invalid overrides and stateless models without changing valid frozen routes", () => {
  const { settings, original, available, validModel } = fixture();
  const config = {
    ...original,
    mainAgentModelOverride: { ...validModel, candidateModelId: "deleted-candidate" },
    auxiliaryModel: { ...validModel, candidateModelId: "deleted-candidate" },
    approvalModel: { ...validModel, candidateModelId: "deleted-candidate" },
    visionModel: validModel,
  };
  const saved = pruneThreadRuntimeConfigReferences(settings, config, available);
  expect(saved.mainAgentModelOverride).toBeUndefined();
  expect(saved.auxiliaryModel).toBeUndefined();
  expect(saved.approvalModel).toBeUndefined();
  expect(saved.visionModel).toEqual({ providerId: validModel.providerId, modelId: validModel.modelId, candidateModelId: validModel.candidateModelId });
  expect(JSON.stringify(saved)).not.toContain("deleted-candidate");
  expect(pruneThreadRuntimeConfigReferences(settings, saved, available)).toEqual(saved);
});

test("cleanup removes only invalid agents from a mixed roster", () => {
  const { settings, original, available, validModel } = fixture();
  const config = structuredClone(original);
  config.orchestrationSelection = { mainModel: validModel, mainPrompt: { mode: "builtin" }, subagents: config.orchestrationSelection!.subagents };
  config.resolvedOrchestrationSnapshot!.selection = structuredClone(config.orchestrationSelection);
  config.resolvedOrchestrationSnapshot!.mainAgent.modelRef = validModel;
  config.resolvedOrchestrationSnapshot!.agents[0]!.modelRef = { providerId: "vendor", modelId: "pinned", baseUrl: "https://saved.example", apiCompat: "anthropic" };
  const saved = pruneThreadRuntimeConfigReferences(settings, config, available);
  expect(saved.resolvedOrchestrationSnapshot?.agents).toHaveLength(1);
  expect(saved.resolvedOrchestrationSnapshot?.agents[0]?.modelRef.baseUrl).toBe("https://saved.example");
  expect(runtimeRoleRoutesFromOrchestrationSnapshot(saved.resolvedOrchestrationSnapshot!).map(route => route.role)).toEqual(["main", "explore"]);
});

test("removing deleted subagents preserves the valid pinned main model instead of importing global edits", () => {
  const { settings, original, available, validModel } = fixture();
  original.resolvedOrchestrationSnapshot!.mainAgent.modelRef = {
    ...validModel, baseUrl: "https://pinned.example", apiCompat: "anthropic",
  };
  settings.mainAgentConfigs[0]!.modelRef = { ...validModel, modelId: "changed-globally" };
  const cleaned = pruneThreadRuntimeConfigReferences(settings, original, available);
  const saved = resolveThreadRuntimeConfigEdit(settings, cleaned, cleaned, available);
  expect(saved.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId).toBe("valid");
  expect(saved.resolvedOrchestrationSnapshot?.mainAgent.modelRef.baseUrl).toBe("https://pinned.example");
  expect(saved.resolvedOrchestrationSnapshot?.agents).toEqual([]);
});

test("a partial edit is durably completed and can be repaired in a second command", async () => {
  const { settings, original, available, validModel } = fixture();
  const db = new DatabaseSync(":memory:");
  try {
    const v2 = new ConversationV2Store(db);
    v2.initialize(); v2.ensureConversation("thread");
    let stored = original;
    const save = (id: string, incoming: ThreadRuntimeConfig) => executeRuntimeConfigMutationCommand({
      principalId: "user", clientCommandId: id, conversationId: "thread", expectedHistoryRevision: 0,
      request: { runtimeConfig: incoming },
    }, { v2, errorMessage: String, execute: async () => {
      stored = resolveThreadRuntimeConfigEdit(settings, stored, incoming, available);
      return { thread: { id: "thread", runtimeConfig: stored } };
    } });
    const partial = await save("clear", original);
    expect(partial.thread.runtimeConfig.resolvedOrchestrationSnapshot).toBeUndefined();
    expect(v2.getCommandJob("user", "thread", "clear")?.status).toBe("completed");
    const repaired = await save("choose-model", { ...stored, orchestrationSelection: {
      ...stored.orchestrationSelection!, mainModel: validModel,
    } });
    expect(repaired.thread.runtimeConfig.resolvedOrchestrationSnapshot?.mainAgent.modelRef).toEqual(validModel);
    expect(v2.getCommandJob("user", "thread", "choose-model")?.status).toBe("completed");
  } finally { db.close(); }
});
