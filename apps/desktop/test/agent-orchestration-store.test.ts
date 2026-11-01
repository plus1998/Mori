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
