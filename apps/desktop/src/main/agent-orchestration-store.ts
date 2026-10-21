import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { validateClaudeSubagentCompactWindow } from "@eco/shared";
import type {
  AgentTemplate,
  MainAgentConfigResource,
  MainAgentPromptResource,
  SubagentOrchestrationResource,
} from "../shared/agent-orchestration";

interface StoredConfigRow {
  id: string;
  value_json: string;
}

const UPSERT_SQL = `
  INSERT INTO __TABLE__ (id, value_json, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
`;

export async function createAgentOrchestrationStore(dbPath: string): Promise<AgentOrchestrationStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new AgentOrchestrationStore(new sqlite.DatabaseSync(dbPath));
  store.initialize();
  return store;
}

export class AgentOrchestrationStore {
  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_templates (
        id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS main_agent_configs (
        id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS main_agent_prompts (
        id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subagent_orchestrations (
        id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

    `);
  }

  listAgentTemplates(): AgentTemplate[] {
    return this.db
      .prepare(`SELECT id, value_json FROM agent_templates ORDER BY id ASC`)
      .all()
      .map((row) => parseAgentTemplateRow(row as unknown as StoredConfigRow));
  }

  getAgentTemplate(id: string): AgentTemplate | undefined {
    const row = this.db
      .prepare(`SELECT id, value_json FROM agent_templates WHERE id = ?`)
      .get(id.trim()) as unknown as StoredConfigRow | undefined;
    return row ? parseAgentTemplateRow(row) : undefined;
  }

  saveAgentTemplate(template: AgentTemplate): AgentTemplate {
    const normalized = normalizeStoredAgentTemplate(template);
    this.upsertRow("agent_templates", normalized.id, normalized, normalized.updatedAt);
    return normalized;
  }

  deleteAgentTemplate(id: string): void {
    this.db.prepare(`DELETE FROM agent_templates WHERE id = ?`).run(id.trim());
  }

  listMainAgentConfigs(): MainAgentConfigResource[] {
    return this.listResourceRows("main_agent_configs").map(parseMainAgentConfigRow);
  }

  getMainAgentConfig(id: string): MainAgentConfigResource | undefined {
    const row = this.getResourceRow("main_agent_configs", id);
    return row ? parseMainAgentConfigRow(row) : undefined;
  }

  saveMainAgentConfig(config: MainAgentConfigResource): MainAgentConfigResource {
    const normalized = normalizeStoredMainAgentConfig(config);
    this.upsertRow("main_agent_configs", normalized.id, normalized, normalized.updatedAt);
    return normalized;
  }

  deleteMainAgentConfig(id: string): void {
    const trimmed = id.trim();
    this.db.prepare(`DELETE FROM main_agent_configs WHERE id = ?`).run(trimmed);
  }

  listMainAgentPrompts(): MainAgentPromptResource[] {
    return this.listResourceRows("main_agent_prompts").map(parseMainAgentPromptRow);
  }

  getMainAgentPrompt(id: string): MainAgentPromptResource | undefined {
    const row = this.getResourceRow("main_agent_prompts", id);
    return row ? parseMainAgentPromptRow(row) : undefined;
  }

  saveMainAgentPrompt(prompt: MainAgentPromptResource): MainAgentPromptResource {
    const normalized = normalizeStoredMainAgentPrompt(prompt);
    this.upsertRow("main_agent_prompts", normalized.id, normalized, normalized.updatedAt);
    return normalized;
  }

  deleteMainAgentPrompt(id: string): void {
    const trimmed = id.trim();
    this.db.prepare(`DELETE FROM main_agent_prompts WHERE id = ?`).run(trimmed);
  }

  listSubagentOrchestrations(): SubagentOrchestrationResource[] {
    return this.listResourceRows("subagent_orchestrations").map(parseSubagentOrchestrationRow);
  }

  getSubagentOrchestration(id: string): SubagentOrchestrationResource | undefined {
    const row = this.getResourceRow("subagent_orchestrations", id);
    return row ? parseSubagentOrchestrationRow(row) : undefined;
  }

  saveSubagentOrchestration(orchestration: SubagentOrchestrationResource): SubagentOrchestrationResource {
    const normalized = normalizeStoredSubagentOrchestration(orchestration);
    this.upsertRow("subagent_orchestrations", normalized.id, normalized, normalized.updatedAt);
    return normalized;
  }

  deleteSubagentOrchestration(id: string): void {
    const trimmed = id.trim();
    this.db.prepare(`DELETE FROM subagent_orchestrations WHERE id = ?`).run(trimmed);
  }

  private listResourceRows(table: string): StoredConfigRow[] {
    return this.db
      .prepare(`SELECT id, value_json FROM ${table} ORDER BY id ASC`)
      .all() as unknown as StoredConfigRow[];
  }

  private getResourceRow(table: string, id: string): StoredConfigRow | undefined {
    return this.db.prepare(`SELECT id, value_json FROM ${table} WHERE id = ?`).get(id.trim()) as unknown as
      | StoredConfigRow
      | undefined;
  }

  private upsertRow(table: string, id: string, value: unknown, updatedAt: string): void {
    this.db.prepare(UPSERT_SQL.replace("__TABLE__", table)).run(id, JSON.stringify(value), updatedAt);
  }
}

export function normalizeStoredAgentTemplate(template: AgentTemplate): AgentTemplate {
  if (template.builtIn || template.source === "built_in") {
    throw new Error("内置子代理模板不可写入用户配置。");
  }
  if (!template.id.trim()) {
    throw new Error("子代理模板 id 不能为空。");
  }
  if (template.id.trim().startsWith("builtin.")) {
    throw new Error("内置子代理模板 id 不可用于用户配置。");
  }
  if (!template.name.trim()) {
    throw new Error("子代理模板名称不能为空。");
  }
  if (!template.prompt.trim()) {
    throw new Error("子代理模板提示词不能为空。");
  }
  const now = new Date().toISOString();
  const templateWithoutLegacyModel = { ...(template as AgentTemplate & { defaultModelRef?: unknown }) };
  delete templateWithoutLegacyModel.defaultModelRef;
  const { version: _version, ...rest } = templateWithoutLegacyModel as AgentTemplate & { version?: number };
  return {
    ...rest,
    id: template.id.trim(),
    name: template.name.trim(),
    description: template.description.trim(),
    prompt: template.prompt.trim(),
    whenToUse: template.whenToUse.trim(),
    source: "user",
    builtIn: false,
    updatedAt: template.updatedAt || now,
  };
}

export function normalizeStoredMainAgentConfig(config: MainAgentConfigResource): MainAgentConfigResource {
  assertWritableUserResource(config.source, config.id, "主 Agent 配置");
  if (!config.name.trim()) {
    throw new Error("主 Agent 配置名称不能为空。");
  }
  if (!config.agentKey.trim()) {
    throw new Error("主 Agent 配置 agentKey 不能为空。");
  }
  const now = new Date().toISOString();
  return {
    ...config,
    id: config.id.trim(),
    name: config.name.trim(),
    agentKey: config.agentKey.trim(),
    skills: [...(config.skills ?? [])],
    ...(config.v4aTeachingEnabled === true ? { v4aTeachingEnabled: true } : {}),
    source: config.source === "project" ? "project" : "user",
    updatedAt: config.updatedAt || now,
  };
}

export function normalizeStoredMainAgentPrompt(prompt: MainAgentPromptResource): MainAgentPromptResource {
  assertWritableUserResource(prompt.source, prompt.id, "主 Agent 提示词");
  if (!prompt.name.trim()) {
    throw new Error("主 Agent 提示词名称不能为空。");
  }
  const mode = prompt.mode === "builtin" ? "builtin" : "custom_append";
  const text = typeof prompt.prompt === "string" ? prompt.prompt.trim() : "";
  if (mode === "custom_append" && !text) {
    throw new Error("自定义主 Agent 提示词不能为空。");
  }
  const now = new Date().toISOString();
  return {
    id: prompt.id.trim(),
    name: prompt.name.trim(),
    mode,
    prompt: mode === "builtin" ? "" : text,
    source: prompt.source === "project" ? "project" : "user",
    updatedAt: prompt.updatedAt || now,
  };
}

export function normalizeStoredSubagentOrchestration(
  orchestration: SubagentOrchestrationResource,
): SubagentOrchestrationResource {
  assertWritableUserResource(orchestration.source, orchestration.id, "子代理编排");
  if (!orchestration.name.trim()) {
    throw new Error("子代理编排名称不能为空。");
  }
  const now = new Date().toISOString();
  const { version: _version, ...rest } = orchestration as SubagentOrchestrationResource & {
    version?: number;
  };
  for (const agent of orchestration.agents) {
    if (agent.claudeAutoCompactWindow !== undefined)
      validateClaudeSubagentCompactWindow(agent.claudeAutoCompactWindow, agent.displayName ?? agent.agentKey);
  }
  return {
    ...rest,
    id: orchestration.id.trim(),
    name: orchestration.name.trim(),
    agents: orchestration.agents.map((agent) => ({
      ...agent,
      ...(agent.v4aTeachingEnabled === true ? { v4aTeachingEnabled: true } : {}),
    })),
    source: orchestration.source === "project" ? "project" : "user",
    updatedAt: orchestration.updatedAt || now,
  };
}

function assertWritableUserResource(
  source: MainAgentConfigResource["source"] | undefined,
  id: string,
  label: string,
): void {
  if (source === "built_in" || source === "derived") {
    throw new Error(`内置或派生${label}不可写入用户配置。`);
  }
  if (!id.trim()) {
    throw new Error(`${label} id 不能为空。`);
  }
  if (id.trim().startsWith("builtin.")) {
    throw new Error(`内置${label} id 不可用于用户配置。`);
  }
}

function parseAgentTemplateRow(row: StoredConfigRow): AgentTemplate {
  const parsed = parseJsonObject(row.value_json);
  return normalizeStoredAgentTemplate(parsed as unknown as AgentTemplate);
}

function parseMainAgentConfigRow(row: StoredConfigRow): MainAgentConfigResource {
  const parsed = parseJsonObject(row.value_json);
  return normalizeStoredMainAgentConfig(parsed as unknown as MainAgentConfigResource);
}

function parseMainAgentPromptRow(row: StoredConfigRow): MainAgentPromptResource {
  const parsed = parseJsonObject(row.value_json);
  return normalizeStoredMainAgentPrompt(parsed as unknown as MainAgentPromptResource);
}

function parseSubagentOrchestrationRow(row: StoredConfigRow): SubagentOrchestrationResource {
  const parsed = parseJsonObject(row.value_json);
  return normalizeStoredSubagentOrchestration(parsed as unknown as SubagentOrchestrationResource);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置 JSON 必须是对象。");
  }
  return parsed as Record<string, unknown>;
}
