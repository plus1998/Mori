import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { ModelRef } from "../shared/agent-orchestration";

type JsonObject = Record<string, unknown>;

/** Convert persisted main-agent references before removing their backing table. */
export function migrateMainAgentConfigs(db: DatabaseSyncType): void {
  const legacyTableExists = hasTable(db, "main_agent_configs");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  if (!legacyTableExists && db.prepare("SELECT 1 FROM schema_migrations WHERE key = ?")
      .get("direct_main_model_v1")) return;
  const rows = legacyTableExists
    ? db.prepare("SELECT id, value_json FROM main_agent_configs").all() as
        Array<{ id: string; value_json: string }>
    : [];
  const candidateIds = new Map<string, string>(hasTable(db, "provider_candidate_models")
    ? (db.prepare("SELECT id, provider_id, model_id FROM provider_candidate_models").all() as
        Array<{ id: string; provider_id: string; model_id: string }>).map((row) =>
        [`${row.provider_id}\0${row.model_id}`, row.id])
    : []);
  const models = new Map<string, ModelRef>();
  for (const row of rows) {
    const config = parseObject(row.value_json, `主代理配置 ${row.id}`);
    const ref = config.modelRef;
    if (!isModelRef(ref)) throw new Error(`主代理配置 ${row.id} 缺少模型，无法迁移。`);
    const candidateId = candidateIds.get(`${ref.providerId}\0${ref.modelId}`);
    models.set(row.id, { ...ref, ...(candidateId ? { candidateModelId: candidateId } : {}) });
  }
  const codexPreference = hasTable(db, "workflow_settings")
    ? db.prepare("SELECT value_json FROM workflow_settings WHERE key = 'codex_auth_model'")
        .get() as { value_json: string } | undefined
    : undefined;
  const preferredCodexModel = codexPreference
    ? parseObject(codexPreference.value_json, "ChatGPT Login 默认模型") : undefined;
  const activeLoginAccount = hasTable(db, "openai_account_settings")
    ? db.prepare("SELECT value FROM openai_account_settings WHERE key = 'active_account_id'")
        .get() as { value: string } | undefined
    : undefined;
  models.set("__openai_official__", {
    providerId: "openai",
    modelId: isModelRef(preferredCodexModel) && preferredCodexModel.providerId === "openai"
      ? preferredCodexModel.modelId : "gpt-5.6-luna",
    ...(isModelRef(preferredCodexModel) && preferredCodexModel.providerId === "openai" &&
      ["none", "minimal", "low", "medium", "high", "xhigh"].includes(String(preferredCodexModel.thinkingEffort))
      ? { thinkingEffort: preferredCodexModel.thinkingEffort as NonNullable<ModelRef["thinkingEffort"]> } : {}),
    ...(activeLoginAccount?.value?.trim() ? { accountId: activeLoginAccount.value.trim() } : {}),
  });
  models.set("__chatgpt_subscription__", { providerId: "eco-coding-chatgpt", modelId: "gpt-5" });

  db.exec("BEGIN IMMEDIATE");
  try {
    migrateJsonColumn(db, "workflow_settings", "key", "value_json", "key = 'default_orchestration_selection'", models, candidateIds);
    migrateJsonColumn(db, "project_orchestration_settings", "workspace_path", "selection_json", "1 = 1", models, candidateIds);
    migrateJsonColumn(db, "threads", "id", "runtime_config_json", "runtime_config_json IS NOT NULL", models, candidateIds);
    migrateJsonColumn(db, "schedule_definitions", "id", "data", "1 = 1", models, candidateIds);
    migrateJsonColumn(db, "schedule_occurrences", "id", "data", "1 = 1", models, candidateIds);
    if (legacyTableExists) db.exec("DROP TABLE main_agent_configs");
    db.prepare("INSERT OR REPLACE INTO schema_migrations (key, applied_at) VALUES (?, ?)")
      .run("direct_main_model_v1", new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateJsonColumn(
  db: DatabaseSyncType,
  table: string,
  idColumn: string,
  jsonColumn: string,
  condition: string,
  models: ReadonlyMap<string, ModelRef>,
  candidateIds: ReadonlyMap<string, string>,
): void {
  if (!hasTable(db, table)) return;
  const rows = db.prepare(`SELECT ${idColumn} AS row_id, ${jsonColumn} AS body FROM ${table} WHERE ${condition}`)
    .all() as Array<{ row_id: string; body: string | null }>;
  const update = db.prepare(`UPDATE ${table} SET ${jsonColumn} = ? WHERE ${idColumn} = ?`);
  for (const row of rows) {
    if (!row.body) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.body); }
    catch { throw new Error(`${table} ${row.row_id} 的配置 JSON 损坏，无法迁移。`); }
    if (migrateNested(parsed, models, candidateIds, `${table} ${row.row_id}`)) {
      update.run(JSON.stringify(parsed), row.row_id);
    }
  }
}

function migrateNested(
  value: unknown,
  models: ReadonlyMap<string, ModelRef>,
  candidateIds: ReadonlyMap<string, string>,
  location: string,
  inheritedSnapshotModel?: ModelRef,
): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    let changed = false;
    for (const entry of value) if (migrateNested(entry, models, candidateIds, location, inheritedSnapshotModel)) changed = true;
    return changed;
  }
  const record = value as JsonObject;
  const snapshotAgent = (record.resolvedOrchestrationSnapshot as JsonObject | undefined)
    ?.mainAgent as JsonObject | undefined;
  const snapshotModel = isModelRef(snapshotAgent?.modelRef)
    ? snapshotAgent.modelRef : inheritedSnapshotModel;
  let changed = false;
  if (typeof record.mainAgentConfigId === "string") {
    const id = record.mainAgentConfigId.trim();
    if (id && !isModelRef(record.mainModel)) {
      const model = (snapshotModel && {
        ...snapshotModel,
        ...(candidateIds.get(`${snapshotModel.providerId}\0${snapshotModel.modelId}`)
          ? { candidateModelId: candidateIds.get(`${snapshotModel.providerId}\0${snapshotModel.modelId}`) }
          : {}),
        ...(snapshotModel.providerId === "openai" && !snapshotModel.accountId &&
          models.get("__openai_official__")?.accountId
          ? { accountId: models.get("__openai_official__")!.accountId } : {}),
      }) ?? models.get(id);
      if (!model) throw new Error(`${location} 引用不存在的主代理配置 ${id}，无法安全迁移。`);
      record.mainModel = { ...model };
    }
    delete record.mainAgentConfigId;
    changed = true;
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "mainModel") continue;
    if (migrateNested(child, models, candidateIds, location, snapshotModel)) changed = true;
  }
  const selection = record.orchestrationSelection as JsonObject | undefined;
  const override = record.mainAgentModelOverride;
  if (selection && isModelRef(selection.mainModel) && isModelRef(override)) {
    const previous = selection.mainModel;
    const effective: ModelRef = {
      ...override,
      ...(previous.providerId === override.providerId && previous.accountId
        ? { accountId: previous.accountId } : {}),
    };
    selection.mainModel = effective;
    delete record.mainAgentModelOverride;
    const snapshotSelection = (record.resolvedOrchestrationSnapshot as JsonObject | undefined)
      ?.selection as JsonObject | undefined;
    if (snapshotSelection) snapshotSelection.mainModel = { ...effective };
    changed = true;
  }
  if (record.resolvedOrchestrationSnapshot && typeof record.resolvedOrchestrationSnapshot === "object") {
    const snapshot = record.resolvedOrchestrationSnapshot as JsonObject;
    const selection = snapshot.selection as JsonObject | undefined;
    const mainAgent = snapshot.mainAgent as JsonObject | undefined;
    if (changed && selection?.mainModel && mainAgent) {
      mainAgent.modelRef = { ...selection.mainModel as ModelRef };
      mainAgent.tools = {
        allowed: [], disallowed: [], bash: { enabled: true },
        filesystem: { read: "workspace", write: "workspace" },
        network: { webSearch: true, webFetch: true },
      };
      mainAgent.skills = [];
      changed = true;
    }
  }
  return changed;
}

function hasTable(db: DatabaseSyncType, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function parseObject(json: string, label: string): JsonObject {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error(`${label} JSON 损坏，无法迁移。`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 不是有效对象，无法迁移。`);
  }
  return value as JsonObject;
}

function isModelRef(value: unknown): value is ModelRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as JsonObject;
  return typeof ref.providerId === "string" && Boolean(ref.providerId.trim()) &&
    typeof ref.modelId === "string" && Boolean(ref.modelId.trim());
}
