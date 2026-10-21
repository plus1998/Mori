import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mergeAgentRegistrySettings } from "../src/main/agent-registry-settings";
import { WorkflowSettingsStore } from "../src/main/workflow-settings-store";
import { OPENAI_OFFICIAL_MAIN_AGENT_CONFIG_ID } from "../src/shared/agent-orchestration";
import type { ModelSettingsSnapshot } from "../src/shared/ipc";
import { buildThreadRuntimeConfigFromDefaults } from "../src/shared/thread-runtime-config";

test("Codex Auth choice survives restart and supplies new threads without changing existing snapshots", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-auth-model-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, "settings.sqlite");
  const base: ModelSettingsSnapshot = {
    providers: [],
    routeProfiles: [],
    agentTemplates: [],
    mainAgentConfigs: [],
    mainAgentPrompts: [],
    subagentOrchestrations: [],
  };
  const registry = {
    listAgentTemplates: () => [],
    listMainAgentConfigs: () => [],
    listMainAgentPrompts: () => [],
    listSubagentOrchestrations: () => [],
  };
  const selection = {
    mainAgentConfigId: OPENAI_OFFICIAL_MAIN_AGENT_CONFIG_ID,
    mainPrompt: { mode: "builtin" as const },
    subagents: { mode: "none" as const },
  };
  const db = new DatabaseSync(dbPath);
  const store = new WorkflowSettingsStore(db);
  store.initialize();
  const existing = buildThreadRuntimeConfigFromDefaults({
    settings: mergeAgentRegistrySettings(base, registry, { openAiAccountActive: true }),
    workflowDefaults: store.get(),
    orchestrationSelection: selection,
  });
  const codexAuthModel = {
    providerId: "openai",
    modelId: "gpt-5.3-codex",
    thinkingEffort: "xhigh" as const,
  };
  store.save({ ...store.get(), codexAuthModel });
  db.close();

  const reopenedDb = new DatabaseSync(dbPath);
  t.after(() => reopenedDb.close());
  const reopened = new WorkflowSettingsStore(reopenedDb);
  reopened.initialize();
  assert.deepEqual(reopened.get().codexAuthModel, codexAuthModel);
  const settings = mergeAgentRegistrySettings(base, registry, {
    openAiAccountActive: true,
    codexAuthModel: reopened.get().codexAuthModel!,
  });
  const fresh = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: reopened.get(),
    orchestrationSelection: selection,
  });
  assert.deepEqual(settings.mainAgentConfigs[0]?.modelRef, codexAuthModel);
  assert.equal(fresh.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId, "gpt-5.3-codex");
  assert.equal(fresh.resolvedOrchestrationSnapshot?.mainAgent.modelRef.thinkingEffort, "xhigh");
  assert.equal(existing.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId, "gpt-5.6-luna");
  assert.equal(existing.resolvedOrchestrationSnapshot?.mainAgent.modelRef.thinkingEffort, "medium");
  assert.deepEqual(mergeAgentRegistrySettings(base, registry, { codexAuthModel }).mainAgentConfigs, []);
});
