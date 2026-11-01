import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAgentOrchestrationStore } from "../src/main/agent-orchestration-store";
import { createProviderStore } from "../src/main/provider-store";

test("removes legacy main config table after migrating defaults, projects, threads and schedules", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-main-config-migration-"));
  const filename = path.join(dir, "app.sqlite");
  try {
    const providers = await createProviderStore(filename);
    const provider = providers.saveProvider({
      name: "Custom", baseUrl: "https://api.test", apiKey: "key", defaultModel: "m1", enabled: true,
    });
    const candidate = providers.saveCandidateModel({ providerId: provider.id, modelId: "m1" });
    const db = new DatabaseSync(filename);
    const selection = { mainAgentConfigId: "old-main", mainPrompt: { mode: "builtin" }, subagents: { mode: "none" } };
    const config = {
      id: "old-main", name: "Old", agentKey: "main", modelRef: { providerId: provider.id, modelId: "m1" },
      tools: { allowed: ["Read"], disallowed: ["Bash"] }, skills: ["legacy"], source: "user", updatedAt: "",
    };
    db.exec(`
      CREATE TABLE main_agent_configs (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE project_orchestration_settings (workspace_path TEXT PRIMARY KEY, selection_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, runtime_config_json TEXT);
      CREATE TABLE schedule_definitions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO main_agent_configs VALUES (?, ?, '')").run(config.id, JSON.stringify(config));
    db.prepare("INSERT INTO workflow_settings VALUES ('default_orchestration_selection', ?, '')")
      .run(JSON.stringify(selection));
    db.prepare("INSERT INTO project_orchestration_settings VALUES ('/repo', ?, '')")
      .run(JSON.stringify(selection));
    db.prepare("INSERT INTO threads VALUES ('thread-1', ?)")
      .run(JSON.stringify({ orchestrationSelection: selection, resolvedOrchestrationSnapshot: {
        selection, mainAgent: { modelRef: config.modelRef, tools: config.tools, skills: config.skills },
      } }));
    db.prepare("INSERT INTO threads VALUES ('thread-deleted-config', ?)")
      .run(JSON.stringify({ orchestrationSelection: { ...selection, mainAgentConfigId: "deleted-main" },
        resolvedOrchestrationSnapshot: {
          selection: { ...selection, mainAgentConfigId: "deleted-main" },
          mainAgent: { modelRef: config.modelRef, tools: config.tools, skills: config.skills },
        } }));
    db.prepare("INSERT INTO schedule_definitions VALUES ('schedule-1', ?)")
      .run(JSON.stringify({ executionProfile: { runtimeConfig: { orchestrationSelection: selection } } }));
    await createAgentOrchestrationStore(filename);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'main_agent_configs'").get()).toBeUndefined();
    for (const [table, column, id] of [
      ["workflow_settings", "value_json", "default_orchestration_selection"],
      ["project_orchestration_settings", "selection_json", "/repo"],
      ["threads", "runtime_config_json", "thread-1"],
      ["schedule_definitions", "data", "schedule-1"],
    ] as const) {
      const row = db.prepare(`SELECT ${column} AS body FROM ${table} WHERE ${table === "workflow_settings" ? "key" : table === "project_orchestration_settings" ? "workspace_path" : "id"} = ?`)
        .get(id) as { body: string };
      expect(row.body).toContain(candidate.id);
      expect(row.body).not.toContain('"mainAgentConfigId":"old-main"');
    }
    const thread = db.prepare("SELECT runtime_config_json FROM threads WHERE id = 'thread-1'")
      .get() as { runtime_config_json: string };
    expect(JSON.parse(thread.runtime_config_json).resolvedOrchestrationSnapshot.mainAgent.tools.disallowed)
      .toEqual([]);
    const deleted = db.prepare("SELECT runtime_config_json FROM threads WHERE id = 'thread-deleted-config'")
      .get() as { runtime_config_json: string };
    expect(JSON.parse(deleted.runtime_config_json).orchestrationSelection.mainModel.candidateModelId)
      .toBe(candidate.id);
    await createAgentOrchestrationStore(filename);
    const normalized = db.prepare("SELECT runtime_config_json FROM threads WHERE id = 'thread-1'")
      .get() as { runtime_config_json: string };
    expect(JSON.parse(normalized.runtime_config_json).orchestrationSelection)
      .not.toHaveProperty("mainAgentConfigId");
    db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("migrates the saved ChatGPT Login model and pins the active account", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-login-main-migration-"));
  const filename = path.join(dir, "app.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec(`
      CREATE TABLE workflow_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE openai_account_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, runtime_config_json TEXT);
    `);
    const selection = { mainAgentConfigId: "__openai_official__", mainPrompt: { mode: "builtin" }, subagents: { mode: "none" } };
    db.prepare("INSERT INTO workflow_settings VALUES ('default_orchestration_selection', ?, '')").run(JSON.stringify(selection));
    db.prepare("INSERT INTO workflow_settings VALUES ('codex_auth_model', ?, '')")
      .run(JSON.stringify({ providerId: "openai", modelId: "gpt-5.3-codex", thinkingEffort: "xhigh" }));
    db.prepare("INSERT INTO openai_account_settings VALUES ('active_account_id', 'account-a', '')").run();
    db.prepare("INSERT INTO threads VALUES ('thread-1', ?)").run(JSON.stringify({
      orchestrationSelection: selection,
      resolvedOrchestrationSnapshot: { selection, mainAgent: { modelRef: { providerId: "openai", modelId: "gpt-5.6-luna" } } },
    }));
    await createAgentOrchestrationStore(filename);
    const global = JSON.parse((db.prepare("SELECT value_json FROM workflow_settings WHERE key = 'default_orchestration_selection'").get() as { value_json: string }).value_json);
    expect(global.mainModel).toMatchObject({ providerId: "openai", modelId: "gpt-5.3-codex", accountId: "account-a", thinkingEffort: "xhigh" });
    const thread = JSON.parse((db.prepare("SELECT runtime_config_json FROM threads WHERE id = 'thread-1'").get() as { runtime_config_json: string }).runtime_config_json);
    expect(thread.orchestrationSelection.mainModel).toMatchObject({ providerId: "openai", modelId: "gpt-5.6-luna", accountId: "account-a" });
    db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
