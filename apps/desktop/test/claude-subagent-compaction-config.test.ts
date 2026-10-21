import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { AgentOrchestrationStore } from "../src/main/agent-orchestration-store";
import {
  buildSubagentOrchestrationFromForm,
  createBlankSubagentOrchestrationForm,
  createCopiedSubagentOrchestrationForm,
  subagentOrchestrationToForm,
} from "../src/renderer/agent-resource-form";
import {
  createBuiltInAgentTemplates,
  orchestrationConfigFromSnapshot,
  resolveOrchestrationSnapshot,
} from "../src/shared/agent-orchestration";
import type { ProviderConfigView } from "../src/shared/ipc";

const provider: ProviderConfigView = {
  id: "provider",
  name: "provider",
  baseUrl: "http://local",
  requestPath: "",
  version: "v1",
  apiCompat: "anthropic",
  defaultModel: "model",
  enabled: true,
  hasApiKey: true,
  createdAt: "",
  updatedAt: "",
};
const templates = createBuiltInAgentTemplates();
function form() {
  const result = createBlankSubagentOrchestrationForm({ providers: [provider], templates });
  result.agents[0]!.candidateModelId = "candidate";
  return result;
}

test("subagent automatic default and explicit window survive form, SQLite, copy and thread snapshot", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AgentOrchestrationStore(db);
    store.initialize();
    const draft = form();
    expect(buildSubagentOrchestrationFromForm(draft, { templates }).agents[0]).not.toHaveProperty(
      "claudeAutoCompactWindow",
    );
    draft.agents[0]!.claudeAutoCompactWindow = "128000";
    const saved = store.saveSubagentOrchestration(buildSubagentOrchestrationFromForm(draft, { templates }));
    const reopened = new AgentOrchestrationStore(db).getSubagentOrchestration(saved.id)!;
    expect(reopened.agents[0]?.claudeAutoCompactWindow).toBe(128_000);
    expect(subagentOrchestrationToForm(reopened).agents[0]?.claudeAutoCompactWindow).toBe("128000");
    expect(createCopiedSubagentOrchestrationForm(reopened).agents[0]?.claudeAutoCompactWindow).toBe("128000");
    const main = {
      id: "main",
      name: "Main",
      agentKey: "main",
      modelRef: { providerId: "provider", modelId: "model" },
      tools: { allowed: [], disallowed: [] },
      skills: [],
      source: "user" as const,
      updatedAt: "",
    };
    const snapshot = resolveOrchestrationSnapshot(
      {
        mainAgentConfigId: main.id,
        mainPrompt: { mode: "builtin" },
        subagents: { mode: "orchestration", orchestrationId: reopened.id },
      },
      { mainAgentConfigs: [main], mainAgentPrompts: [], subagentOrchestrations: [reopened] },
    );
    expect(orchestrationConfigFromSnapshot(snapshot).agents[0]?.claudeAutoCompactWindow).toBe(128_000);
    draft.agents[0]!.claudeAutoCompactWindow = "";
    expect(
      buildSubagentOrchestrationFromForm(draft, { templates, existing: saved }).agents[0],
    ).not.toHaveProperty("claudeAutoCompactWindow");
  } finally {
    db.close();
  }
});

test("invalid explicit windows are rejected in both UI form and host persistence", () => {
  const draft = form();
  const valid = buildSubagentOrchestrationFromForm(draft, { templates });
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AgentOrchestrationStore(db);
    store.initialize();
    for (const value of ["99999", "1000001", "100000.5", "NaN", "Infinity"]) {
      draft.agents[0]!.claudeAutoCompactWindow = value;
      expect(() => buildSubagentOrchestrationFromForm(draft, { templates })).toThrow("100000～1000000");
      expect(() =>
        store.saveSubagentOrchestration({
          ...valid,
          agents: valid.agents.map((agent) => ({ ...agent, claudeAutoCompactWindow: Number(value) })),
        }),
      ).toThrow("100000～1000000");
    }
  } finally {
    db.close();
  }
});
