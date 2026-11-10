import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkflowSettingsStore } from "../src/main/workflow-settings-store";
import { buildThreadRuntimeConfigFromDefaults } from "../src/shared/thread-runtime-config";

test("ChatGPT Login account and model choice survives restart without changing existing threads", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-auth-model-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, "settings.sqlite");
  const settings = {
    providers: [],
    routeProfiles: [],
    agentTemplates: [],
    mainAgentConfigs: [],
    mainAgentPrompts: [],
    subagentOrchestrations: [],
  };
  const selection = {
    mainModel: { providerId: "openai", modelId: "gpt-5.6-luna", accountId: "account-a" },
    mainPrompt: { mode: "builtin" as const },
    subagents: { mode: "none" as const },
  };
  const db = new DatabaseSync(dbPath);
  const store = new WorkflowSettingsStore(db);
  store.initialize();
  store.save({ ...store.get(), defaultOrchestrationSelection: selection });
  const existing = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: store.get(),
  });
  const nextSelection = {
    ...selection,
    mainModel: { providerId: "openai", modelId: "gpt-5.3-codex", accountId: "account-b", thinkingEffort: "xhigh" as const, serviceTier: "fast" as const },
  };
  store.save({ ...store.get(), defaultOrchestrationSelection: nextSelection });
  db.close();

  const reopenedDb = new DatabaseSync(dbPath);
  t.after(() => reopenedDb.close());
  const reopened = new WorkflowSettingsStore(reopenedDb);
  reopened.initialize();
  assert.deepEqual(reopened.get().defaultOrchestrationSelection, nextSelection);
  const fresh = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: reopened.get(),
  });
  assert.equal(fresh.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId, "gpt-5.3-codex");
  assert.equal(fresh.resolvedOrchestrationSnapshot?.mainAgent.modelRef.thinkingEffort, "xhigh");
  assert.equal(fresh.resolvedOrchestrationSnapshot?.mainAgent.modelRef.serviceTier, "fast");
  assert.equal(fresh.resolvedOrchestrationSnapshot?.mainAgent.modelRef.accountId, "account-b");
  assert.equal(existing.resolvedOrchestrationSnapshot?.mainAgent.modelRef.modelId, "gpt-5.6-luna");
  assert.equal(existing.resolvedOrchestrationSnapshot?.mainAgent.modelRef.accountId, "account-a");
});
