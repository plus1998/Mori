import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentOrchestrationStore,
  normalizeStoredAgentTemplate,
} from "../src/main/agent-orchestration-store";
import { createBuiltInAgentTemplates } from "../src/shared/agent-orchestration";
import type { AgentTemplate } from "../src/shared/ipc";

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

function customTemplate(): AgentTemplate {
  return {
    id: "user.researcher",
    name: "Researcher",
    description: "Research agent",
    prompt: "Research the topic and cite sources.",
    whenToUse: "Use for broad research.",
    defaultTools: {
      allowed: ["WebSearch", "WebFetch"],
      disallowed: [],
      network: { webSearch: true, webFetch: true },
    },
    mcpServers: [],
    skills: [],
    allowDelegation: false,
    builtIn: false,
    source: "user",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("normalizeStoredAgentTemplate rejects built-in ids", () => {
  const builtIn = createBuiltInAgentTemplates()[0]!;
  expect(() => normalizeStoredAgentTemplate(builtIn)).toThrow(
    /内置子代理模板不可写入用户配置|built-in subagent template cannot be written/i,
  );
});

test.skipIf(!sqliteAvailable)("agent template CRUD remains available", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-orchestration-store-template-"));
  const store = await createAgentOrchestrationStore(path.join(dir, "orchestration.db"));
  const saved = store.saveAgentTemplate(customTemplate());
  expect(store.listAgentTemplates().map((template) => template.id)).toEqual([saved.id]);
  store.deleteAgentTemplate(saved.id);
  expect(store.listAgentTemplates()).toEqual([]);
});

test.skipIf(!sqliteAvailable)("deleteSubagentOrchestration ignores selection references", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-orchestration-store-subagent-delete-"));
  const store = await createAgentOrchestrationStore(path.join(dir, "orchestration.db"));
  store.saveSubagentOrchestration({
    id: "user.orchestration",
    name: "Orchestration",
    agents: [],
    strategy: { kind: "autonomous" },
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "user",
  });

  expect(() => store.deleteSubagentOrchestration("user.orchestration")).not.toThrow();
  expect(store.getSubagentOrchestration("user.orchestration")).toBeUndefined();
});

test.skipIf(!sqliteAvailable)("saved OAuth subagent account bindings survive SQLite reload and runtime route resolution", async () => {
  const { buildSubagentOrchestrationFromForm, createBlankSubagentOrchestrationForm, subagentOrchestrationToForm } = await import("../src/renderer/agent-resource-form");
  const { resolveOrchestrationSnapshot } = await import("../src/shared/agent-orchestration");
  const { runtimeRoleRoutesFromOrchestrationSnapshot } = await import("../src/shared/thread-runtime-config");
  const { resolveCandidateModelRouteDefaults } = await import("../src/main/candidate-model-defaults");
  const { resolveThreadRuntimeConfig, roleRoutesFromRuntime } = await import("../src/main/thread-runtime-routes");
  const { runtimeRouteToProxyRoute } = await import("../src/main/anthropic-proxy");
  const templates = createBuiltInAgentTemplates();
  const form = createBlankSubagentOrchestrationForm({ templates });
  for (const agent of form.agents) Object.assign(agent, {
    providerId: "eco-coding-chatgpt", modelId: "gpt-6-luna", accountId: `account-${agent.agentKey}`,
    candidateModelId: "account:eco-coding-chatgpt:gpt-6-luna", thinkingEffort: "high",
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-subagent-oauth-"));
  const dbPath = path.join(dir, "orchestration.db");
  const store = await createAgentOrchestrationStore(dbPath);
  const saved = store.saveSubagentOrchestration(buildSubagentOrchestrationFromForm(form, { templates }));
  const reopened = await createAgentOrchestrationStore(dbPath);
  const reloaded = reopened.getSubagentOrchestration(saved.id)!;
  expect(subagentOrchestrationToForm(reloaded).agents.map(agent => agent.accountId)).toEqual(form.agents.map(agent => agent.accountId));
  const selection = { mainPrompt: { mode: "builtin" as const },
    subagents: { mode: "orchestration" as const, orchestrationId: saved.id },
    mainModel: { providerId: "eco-coding-chatgpt", modelId: "gpt-6-luna", accountId: "main-account" },
  };
  const settings = { providers: [], routeProfiles: [], agentTemplates: templates,
    mainAgentConfigs: [], mainAgentPrompts: [], subagentOrchestrations: [reloaded] };
  const snapshot = resolveOrchestrationSnapshot(selection, settings);
  const routes = resolveCandidateModelRouteDefaults(runtimeRoleRoutesFromOrchestrationSnapshot(snapshot), {
    isBuiltInCodexProvider: () => false, isChatGptSubscriptionProvider: () => true,
    listCandidateModels: () => { throw new Error("Must use the account catalog, not a shared cache"); },
  });
  const provider = { id: "eco-coding-chatgpt", name: "OAuth", baseUrl: "https://oauth.test",
    requestPath: "", version: "v1", apiCompat: "openai_responses" as const,
    authMethod: "chatgpt_subscription" as const, defaultModel: "gpt-6-luna", enabled: true,
    hasApiKey: false, apiKey: "", createdAt: "", updatedAt: "" };
  const runtime = resolveThreadRuntimeConfig(settings, [provider], routes, { requireCompleteCodingRoutes: false });
  if (!runtime.ok) throw new Error(runtime.reason);
  const before = roleRoutesFromRuntime(runtime.routes);
  expect(before[1]?.accountId).toBe(form.agents[0]?.accountId);
  expect(runtimeRouteToProxyRoute(runtime.routes[1]!)).toMatchObject({
    accountId: form.agents[0]?.accountId, apiCompat: "openai_responses", thinkingEffort: "high",
  });
  snapshot.mainAgent.modelRef.accountId = "different-main-account";
  expect(runtimeRoleRoutesFromOrchestrationSnapshot(snapshot)[1]?.accountId).toBe(before[1]?.accountId);
  const missing = resolveThreadRuntimeConfig(settings, [provider], [{ ...routes[1]!, accountId: " " }], { requireCompleteCodingRoutes: false });
  expect(missing).toMatchObject({ ok: false });
  if (!missing.ok) expect(missing.reason).toContain("尚未选择账号");
  await fs.rm(dir, { recursive: true, force: true });
});
