import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { parseUpstreamProxyUrl } from "@eco/gateway";
import { createBuiltInAgentTemplates } from "../shared/agent-orchestration";
import { normalizeUpstreamApiCompat } from "../shared/api-compat";
import {
  AGENT_ROLES,
  type AgentRole,
  type CandidateModelInput,
  type CandidateModelView,
  type ModelSettingsSnapshot,
  type ProviderConfigInput,
  type ProviderConfigView,
  type RoleRouteConfig,
  type RouteManualSpec,
  type RouteProfileInput,
  type RouteProfileView,
  type ThinkingEffort,
} from "../shared/ipc";
import { normalizeStoredPriceMultiplier } from "../shared/manual-spec-pricing";
import { normalizeProviderTokenCountMode } from "../shared/provider-token-count";
import { normalizeApiVersion, normalizeRequestPath, splitBaseUrlAndRequestPath } from "./provider-models";

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  request_path: string;
  version: string;
  api_compat: string;
  token_count_mode: string;
  api_key: string;
  auth_method: string;
  credential_pool_id: string;
  upstream_proxy_url: string;
  default_model: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RouteProfileRow {
  id: string;
  name: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface RouteRow {
  profile_id: string;
  role: AgentRole;
  provider_id: string;
  model_id: string;
  api_compat: string | null;
  thinking_effort: string | null;
  models_dev_provider_key: string | null;
  models_dev_model_id: string | null;
  manual_context_tokens: number | null;
  manual_input_per_m: number | null;
  manual_output_per_m: number | null;
  manual_cache_read_per_m: number | null;
  manual_cache_write_per_m: number | null;
  manual_price_multiplier: number | null;
}

interface LegacyRouteRow {
  role: AgentRole;
  provider_id: string;
  model_id: string;
  thinking_effort: string | null;
}

interface CandidateModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string | null;
  models_dev_provider_key: string | null;
  models_dev_model_id: string | null;
  manual_context_tokens: number | null;
  manual_max_output_tokens: number | null;
  manual_supports_image_input: number | null;
  manual_supports_reasoning: number | null;
  manual_supports_native_web_search: number | null;
  manual_supports_remote_compaction: number | null;
  manual_input_per_m: number | null;
  manual_output_per_m: number | null;
  manual_cache_read_per_m: number | null;
  manual_cache_write_per_m: number | null;
  manual_price_multiplier: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderConfigSecret extends ProviderConfigView {
  apiKey: string;
}

const DEFAULT_ROUTE_PROFILE_ID = "default";

function rollbackProviderTransaction(db: DatabaseSyncType): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // SQLite may already have rolled back after a fatal storage error. Preserve
    // the original provider transaction failure.
  }
}

export async function createProviderStore(dbPath: string): Promise<ProviderStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new ProviderStore(new sqlite.DatabaseSync(dbPath));
  store.initialize();
  return store;
}

export class ProviderStore {
  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        default_model TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS route_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.migrateProviderRequestPath();
    this.migrateProviderAuthMethod();
    this.migrateProviderVersion();
    this.migrateRoleRoutesToProfiles();
    this.migrateRoleRoutesThinkingEffort();
    this.migrateRoleRoutesModelsDevMapping();
    this.migrateRoleRoutesManualSpec();
    this.migrateProviderApiCompat();
    this.migrateProviderTokenCountMode();
    this.migrateProviderUpstreamProxy();
    this.migrateRoleRoutesApiCompat();
    this.migrateLegacyOpenaiApiCompatValues();
    this.migrateCandidateModelsTable();
    this.migrateManualPriceMultiplier();
  }

  getSettings(): ModelSettingsSnapshot {
    const routeProfiles = this.listRouteProfiles();
    return {
      providers: this.listProviders(),
      routeProfiles,
      agentTemplates: createBuiltInAgentTemplates(),
      mainAgentConfigs: [],
      mainAgentPrompts: [],
      subagentOrchestrations: [],
    };
  }

  listProviders(): ProviderConfigView[] {
    return this.listProviderRows().map(providerRowToView);
  }

  listProvidersWithSecrets(): ProviderConfigSecret[] {
    return this.listProviderRows().map((row) => ({
      ...providerRowToView(row),
      apiKey: row.api_key,
    }));
  }

  getProviderWithSecret(id: string): ProviderConfigSecret | undefined {
    const row = this.getProviderRow(id);
    if (!row) {
      return undefined;
    }
    return {
      ...providerRowToView(row),
      apiKey: row.api_key,
    };
  }

  clearProviderApiKey(id: string): void {
    const result = this.db
      .prepare("UPDATE provider_configs SET api_key = '', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (result.changes === 0) {
      throw new Error(`找不到 Provider：${id}`);
    }
  }

  /** Clear the per-provider upstream proxy URL (cloud sync: secret no longer present). */
  clearProviderUpstreamProxy(id: string): void {
    const result = this.db
      .prepare("UPDATE provider_configs SET upstream_proxy_url = '', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (result.changes === 0) {
      throw new Error(`找不到 Provider：${id}`);
    }
  }

  saveProvider(input: ProviderConfigInput): ProviderConfigView {
    validateProviderInput(input);
    const now = new Date().toISOString();
    const existing = input.id ? this.getProviderRow(input.id) : undefined;
    const id = input.id ?? createProviderId(input.name);
    const apiKey = input.apiKey && input.apiKey.length > 0 ? input.apiKey : (existing?.api_key ?? "");
    const createdAt = existing?.created_at ?? now;

    this.db
      .prepare(`
        INSERT INTO provider_configs (
          id, name, base_url, request_path, version, api_compat, token_count_mode,
          api_key, auth_method, credential_pool_id, upstream_proxy_url, default_model, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          base_url = excluded.base_url,
          request_path = excluded.request_path,
          version = excluded.version,
          api_compat = excluded.api_compat,
          token_count_mode = excluded.token_count_mode,
          api_key = excluded.api_key,
          auth_method = excluded.auth_method,
          credential_pool_id = excluded.credential_pool_id,
          upstream_proxy_url = excluded.upstream_proxy_url,
          default_model = excluded.default_model,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `)
      .run(
        id,
        input.name.trim(),
        input.baseUrl.trim(),
        normalizeRequestPath(input.requestPath),
        normalizeApiVersion(input.version ?? existing?.version),
        normalizeUpstreamApiCompat(input.apiCompat ?? existing?.api_compat),
        normalizeProviderTokenCountMode(input.tokenCountMode ?? existing?.token_count_mode),
        apiKey,
        input.authMethod ?? existing?.auth_method ?? "api_key",
        input.credentialPoolId?.trim() ?? existing?.credential_pool_id ?? "",
        normalizeProviderUpstreamProxyUrl(input.upstreamProxyUrl ?? existing?.upstream_proxy_url ?? ""),
        input.defaultModel.trim(),
        input.enabled ? 1 : 0,
        createdAt,
        now,
      );

    this.syncDefaultModelFromCandidates(id);
    return providerRowToView(this.getProviderRow(id) ?? fail(`Provider ${id} was not saved`));
  }

  deleteProvider(id: string): void {
    if (!this.getProviderRow(id)) {
      throw new Error(`找不到 Provider：${id}`);
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Route profiles are legacy configuration. A profile becomes invalid when any of its
      // providers is removed, so remove the whole profile instead of leaving partial routes.
      const referencedProfiles = this.db
        .prepare("SELECT DISTINCT profile_id FROM role_routes WHERE provider_id = ?")
        .all(id) as unknown as Array<{ profile_id: string }>;
      for (const profile of referencedProfiles) {
        this.db.prepare("DELETE FROM role_routes WHERE profile_id = ?").run(profile.profile_id);
        this.db.prepare("DELETE FROM route_profiles WHERE id = ?").run(profile.profile_id);
      }
      this.db.prepare("DELETE FROM provider_candidate_models WHERE provider_id = ?").run(id);
      this.db.prepare("DELETE FROM provider_configs WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackProviderTransaction(this.db);
      throw error;
    }
  }

  listRouteProfiles(): RouteProfileView[] {
    return this.listRouteProfileRows().map((row) => profileRowToView(row, this.listRoutesForProfile(row.id)));
  }

  saveRouteProfile(input: RouteProfileInput): RouteProfileView {
    validateRouteProfileInput(input);
    const now = new Date().toISOString();
    const existing = input.id ? this.getRouteProfileRow(input.id) : undefined;
    const id = input.id ?? createRouteProfileId(input.name);
    const createdAt = existing?.created_at ?? now;

    this.db
      .prepare(`
        INSERT INTO route_profiles (id, name, is_active, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          updated_at = excluded.updated_at
      `)
      .run(id, input.name.trim(), createdAt, now);

    this.saveProfileRoutes(id, input.routes);

    return profileRowToView(
      this.getRouteProfileRow(id) ?? fail(`Route profile ${id} was not saved`),
      this.listRoutesForProfile(id),
    );
  }

  deleteRouteProfile(id: string): void {
    const profiles = this.listRouteProfileRows();
    if (profiles.length <= 1) {
      throw new Error("至少保留一套子代理编排配置。");
    }
    const target = profiles.find((profile) => profile.id === id);
    if (!target) {
      throw new Error(`找不到路由配置：${id}`);
    }

    this.db.prepare("DELETE FROM role_routes WHERE profile_id = ?").run(id);
    this.db.prepare("DELETE FROM route_profiles WHERE id = ?").run(id);
  }

  /** Cloud settings pull: replace all route profiles with the snapshot (may be empty). */
  replaceRouteProfilesForSync(profiles: readonly RouteProfileInput[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM role_routes").run();
      this.db.prepare("DELETE FROM route_profiles").run();
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackProviderTransaction(this.db);
      throw error;
    }
    for (const profile of profiles) {
      this.saveRouteProfile(profile);
    }
  }

  private saveProfileRoutes(profileId: string, routes: RoleRouteConfig[]): void {
    const normalizedRoutes = normalizeProfileRoutes(routes);
    this.db.prepare("DELETE FROM role_routes WHERE profile_id = ?").run(profileId);
    for (const route of normalizedRoutes) {
      this.saveRoleRoute(profileId, route);
    }
  }

  private saveRoleRoute(profileId: string, route: RoleRouteConfig): void {
    if (!AGENT_ROLES.includes(route.role)) {
      throw new Error(`Unsupported role: ${route.role}`);
    }
    if (!this.getProviderRow(route.providerId)) {
      throw new Error(`Provider ${route.providerId} does not exist`);
    }
    if (!route.modelId.trim()) {
      throw new Error(`Model id is required for ${route.role}`);
    }

    const thinkingEffort = normalizeThinkingEffort(route.thinkingEffort);
    const modelsDev = normalizeModelsDevMapping(route.modelsDevMapping);
    const manual = normalizeManualSpec(route.manualSpec);
    this.db
      .prepare(`
        INSERT INTO role_routes (
          profile_id, role, provider_id, model_id, api_compat, thinking_effort,
          models_dev_provider_key, models_dev_model_id,
          manual_context_tokens, manual_input_per_m, manual_output_per_m,
          manual_cache_read_per_m, manual_cache_write_per_m, manual_price_multiplier,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, role) DO UPDATE SET
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          api_compat = excluded.api_compat,
          thinking_effort = excluded.thinking_effort,
          models_dev_provider_key = excluded.models_dev_provider_key,
          models_dev_model_id = excluded.models_dev_model_id,
          manual_context_tokens = excluded.manual_context_tokens,
          manual_input_per_m = excluded.manual_input_per_m,
          manual_output_per_m = excluded.manual_output_per_m,
          manual_cache_read_per_m = excluded.manual_cache_read_per_m,
          manual_cache_write_per_m = excluded.manual_cache_write_per_m,
          manual_price_multiplier = excluded.manual_price_multiplier,
          updated_at = excluded.updated_at
      `)
      .run(
        profileId,
        route.role,
        route.providerId,
        route.modelId.trim(),
        route.apiCompat ?? null,
        thinkingEffort,
        modelsDev?.providerKey ?? null,
        modelsDev?.modelId ?? null,
        manual?.contextTokens ?? null,
        manual?.inputPerM ?? null,
        manual?.outputPerM ?? null,
        manual?.cacheReadPerM ?? null,
        manual?.cacheWritePerM ?? null,
        manual?.priceMultiplier ?? null,
        new Date().toISOString(),
      );
  }

  private listRoutesForProfile(profileId: string): RoleRouteConfig[] {
    return this.db
      .prepare(`
        SELECT profile_id, role, provider_id, model_id, api_compat, thinking_effort,
               models_dev_provider_key, models_dev_model_id,
               manual_context_tokens, manual_input_per_m, manual_output_per_m,
               manual_cache_read_per_m, manual_cache_write_per_m, manual_price_multiplier
        FROM role_routes
        WHERE profile_id = ?
        ORDER BY role
      `)
      .all(profileId)
      .map((row) => routeRowToConfig(row as unknown as RouteRow));
  }

  private migrateProviderRequestPath(): void {
    const columns = this.db.prepare("PRAGMA table_info(provider_configs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "request_path")) {
      this.db.exec(`ALTER TABLE provider_configs ADD COLUMN request_path TEXT NOT NULL DEFAULT ''`);
    }

    const rows = this.db.prepare("SELECT id, base_url, request_path FROM provider_configs").all() as Array<{
      id: string;
      base_url: string;
      request_path: string;
    }>;

    for (const row of rows) {
      if (row.request_path) {
        continue;
      }
      const split = splitBaseUrlAndRequestPath(row.base_url);
      // Only split `/anthropic`-style message prefixes; keep service roots like `/zen` in base_url.
      if (split.requestPath === "/anthropic" && split.baseUrl !== row.base_url) {
        this.db
          .prepare("UPDATE provider_configs SET base_url = ?, request_path = ? WHERE id = ?")
          .run(split.baseUrl, split.requestPath, row.id);
      }
    }
  }

  /** API path version (e.g. v1). Historical empty/missing rows normalize to v1 on read/write. */
  private migrateProviderVersion(): void {
    const columns = this.db.prepare("PRAGMA table_info(provider_configs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "version")) {
      this.db.exec(`ALTER TABLE provider_configs ADD COLUMN version TEXT NOT NULL DEFAULT 'v1'`);
    }
    // Backfill empty strings (and any null if schema ever allows) to default v1.
    this.db.exec(`UPDATE provider_configs SET version = 'v1' WHERE version IS NULL OR TRIM(version) = ''`);
  }

  /** Per-provider outbound proxy URL. Empty means the global proxy setting applies. */
  private migrateProviderUpstreamProxy(): void {
    const columns = this.db.prepare("PRAGMA table_info(provider_configs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "upstream_proxy_url")) {
      this.db.exec(`ALTER TABLE provider_configs ADD COLUMN upstream_proxy_url TEXT NOT NULL DEFAULT ''`);
    }
    this.db.exec(`UPDATE provider_configs SET upstream_proxy_url = '' WHERE upstream_proxy_url IS NULL`);
  }

  private migrateRoleRoutesToProfiles(): void {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_routes'")
      .all() as Array<{ name: string }>;
    if (tables.length === 0) {
      this.db.exec(`
        CREATE TABLE role_routes (
          profile_id TEXT NOT NULL,
          role TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          thinking_effort TEXT,
          models_dev_provider_key TEXT,
          models_dev_model_id TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (profile_id, role),
          FOREIGN KEY(profile_id) REFERENCES route_profiles(id),
          FOREIGN KEY(provider_id) REFERENCES provider_configs(id)
        );
      `);
      return;
    }

    const columns = this.db.prepare("PRAGMA table_info(role_routes)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "profile_id")) {
      return;
    }

    const legacyRoutes = this.db
      .prepare("SELECT role, provider_id, model_id, thinking_effort FROM role_routes ORDER BY role")
      .all() as unknown as LegacyRouteRow[];

    this.db.exec(`
      CREATE TABLE role_routes_migrated (
        profile_id TEXT NOT NULL,
        role TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        thinking_effort TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, role),
        FOREIGN KEY(profile_id) REFERENCES route_profiles(id),
        FOREIGN KEY(provider_id) REFERENCES provider_configs(id)
      );
    `);

    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO route_profiles (id, name, is_active, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `)
      .run(DEFAULT_ROUTE_PROFILE_ID, "默认", now, now);

    const insertRoute = this.db.prepare(`
      INSERT INTO role_routes_migrated (profile_id, role, provider_id, model_id, thinking_effort, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const route of legacyRoutes) {
      insertRoute.run(
        DEFAULT_ROUTE_PROFILE_ID,
        route.role,
        route.provider_id,
        route.model_id,
        route.thinking_effort,
        now,
      );
    }

    this.db.exec("DROP TABLE role_routes");
    this.db.exec("ALTER TABLE role_routes_migrated RENAME TO role_routes");
  }

  private migrateRoleRoutesThinkingEffort(): void {
    const columns = this.db.prepare("PRAGMA table_info(role_routes)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "thinking_effort")) {
      return;
    }
    this.db.exec("ALTER TABLE role_routes ADD COLUMN thinking_effort TEXT");
  }

  private migrateRoleRoutesModelsDevMapping(): void {
    const columns = this.db.prepare("PRAGMA table_info(role_routes)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "models_dev_provider_key")) {
      return;
    }
    this.db.exec(`
      ALTER TABLE role_routes ADD COLUMN models_dev_provider_key TEXT;
      ALTER TABLE role_routes ADD COLUMN models_dev_model_id TEXT;
    `);
  }

  private migrateRoleRoutesManualSpec(): void {
    const columns = this.db.prepare("PRAGMA table_info(role_routes)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "manual_context_tokens")) {
      return;
    }
    this.db.exec(`
      ALTER TABLE role_routes ADD COLUMN manual_context_tokens INTEGER;
      ALTER TABLE role_routes ADD COLUMN manual_input_per_m REAL;
      ALTER TABLE role_routes ADD COLUMN manual_output_per_m REAL;
      ALTER TABLE role_routes ADD COLUMN manual_cache_read_per_m REAL;
      ALTER TABLE role_routes ADD COLUMN manual_cache_write_per_m REAL;
    `);
  }

  private migrateProviderApiCompat(): void {
    const columns = this.db.prepare("PRAGMA table_info(provider_configs)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "api_compat")) {
      return;
    }
    this.db.exec(`ALTER TABLE provider_configs ADD COLUMN api_compat TEXT NOT NULL DEFAULT 'anthropic'`);
  }

  private migrateProviderTokenCountMode(): void {
    const columns = this.db.prepare("PRAGMA table_info(provider_configs)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "token_count_mode")) {
      return;
    }
    this.db.exec(
      `ALTER TABLE provider_configs ADD COLUMN token_count_mode TEXT NOT NULL DEFAULT 'local_heuristic'`,
    );
  }

  private migrateRoleRoutesApiCompat(): void {
    const columns = this.db.prepare("PRAGMA table_info(role_routes)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "api_compat")) {
      return;
    }
    this.db.exec(`ALTER TABLE role_routes ADD COLUMN api_compat TEXT`);
  }

  /** Rename legacy `openai` stored value to `openai_responses`. */
  private migrateLegacyOpenaiApiCompatValues(): void {
    this.db.exec(`
      UPDATE provider_configs SET api_compat = 'openai_responses' WHERE api_compat = 'openai';
      UPDATE role_routes SET api_compat = 'openai_responses' WHERE api_compat = 'openai';
    `);
  }

  private listProviderRows(): ProviderRow[] {
    return this.db
      .prepare(`
        SELECT id, name, base_url, request_path, version, api_compat, token_count_mode,
               api_key, auth_method, credential_pool_id, upstream_proxy_url, default_model, enabled, created_at, updated_at
        FROM provider_configs
        ORDER BY updated_at DESC, name ASC
      `)
      .all() as unknown as ProviderRow[];
  }

  private migrateProviderAuthMethod(): void {
    const columns = this.db.prepare("PRAGMA table_info(provider_configs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "auth_method")) {
      this.db.exec(`ALTER TABLE provider_configs ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'api_key'`);
    }
    if (!columns.some((column) => column.name === "credential_pool_id")) {
      this.db.exec(`ALTER TABLE provider_configs ADD COLUMN credential_pool_id TEXT NOT NULL DEFAULT ''`);
    }
    this.db.exec(
      `UPDATE provider_configs SET auth_method = 'api_key' WHERE auth_method IS NULL OR TRIM(auth_method) = ''`,
    );
    this.db.exec(`UPDATE provider_configs SET credential_pool_id = '' WHERE credential_pool_id IS NULL`);
  }

  private getProviderRow(id: string): ProviderRow | undefined {
    return this.db
      .prepare(`
        SELECT id, name, base_url, request_path, version, api_compat, token_count_mode,
               api_key, auth_method, credential_pool_id, upstream_proxy_url, default_model, enabled, created_at, updated_at
        FROM provider_configs
        WHERE id = ?
      `)
      .get(id) as ProviderRow | undefined;
  }

  private listRouteProfileRows(): RouteProfileRow[] {
    return this.db
      .prepare(`
        SELECT id, name, is_active, created_at, updated_at
        FROM route_profiles
        ORDER BY updated_at DESC, name ASC
      `)
      .all() as unknown as RouteProfileRow[];
  }

  private getRouteProfileRow(id: string): RouteProfileRow | undefined {
    return this.db
      .prepare(`
        SELECT id, name, is_active, created_at, updated_at
        FROM route_profiles
        WHERE id = ?
      `)
      .get(id) as RouteProfileRow | undefined;
  }

  private migrateManualPriceMultiplier(): void {
    const roleColumns = this.db.prepare("PRAGMA table_info(role_routes)").all() as Array<{ name: string }>;
    if (!roleColumns.some((column) => column.name === "manual_price_multiplier")) {
      this.db.exec("ALTER TABLE role_routes ADD COLUMN manual_price_multiplier REAL");
    }
    const candidateColumns = this.db.prepare("PRAGMA table_info(provider_candidate_models)").all() as Array<{
      name: string;
    }>;
    if (
      candidateColumns.length > 0 &&
      !candidateColumns.some((column) => column.name === "manual_price_multiplier")
    ) {
      this.db.exec("ALTER TABLE provider_candidate_models ADD COLUMN manual_price_multiplier REAL");
    }
    if (
      candidateColumns.length > 0 &&
      !candidateColumns.some((column) => column.name === "manual_supports_native_web_search")
    ) {
      this.db.exec(
        "ALTER TABLE provider_candidate_models ADD COLUMN manual_supports_native_web_search INTEGER",
      );
    }
    if (
      candidateColumns.length > 0 &&
      !candidateColumns.some((column) => column.name === "manual_supports_remote_compaction")
    ) {
      this.db.exec(
        "ALTER TABLE provider_candidate_models ADD COLUMN manual_supports_remote_compaction INTEGER",
      );
    }
  }

  // ─── Candidate Models ───────────────────────────────────────────────────────

  private migrateCandidateModelsTable(): void {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_candidate_models'")
      .all() as Array<{ name: string }>;
    if (tables.length > 0) return;
    this.db.exec(`
      CREATE TABLE provider_candidate_models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT,
        models_dev_provider_key TEXT,
        models_dev_model_id TEXT,
        manual_context_tokens INTEGER,
        manual_max_output_tokens INTEGER,
        manual_supports_image_input INTEGER,
        manual_supports_reasoning INTEGER,
        manual_input_per_m REAL,
        manual_output_per_m REAL,
        manual_cache_read_per_m REAL,
        manual_cache_write_per_m REAL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(provider_id) REFERENCES provider_configs(id) ON DELETE CASCADE,
        UNIQUE(provider_id, model_id)
      );
    `);
  }

  listCandidateModels(providerId: string): CandidateModelView[] {
    return this.db
      .prepare(`
        SELECT id, provider_id, model_id, display_name,
               models_dev_provider_key, models_dev_model_id,
               manual_context_tokens, manual_max_output_tokens,
               manual_supports_image_input, manual_supports_reasoning,
               manual_supports_native_web_search,
               manual_supports_remote_compaction,
               manual_input_per_m, manual_output_per_m,
               manual_cache_read_per_m, manual_cache_write_per_m, manual_price_multiplier,
               sort_order, created_at, updated_at
        FROM provider_candidate_models
        WHERE provider_id = ?
        ORDER BY sort_order ASC, model_id ASC
      `)
      .all(providerId)
      .map((row) => candidateRowToView(row as unknown as CandidateModelRow));
  }

  saveCandidateModel(input: CandidateModelInput): CandidateModelView {
    if (!input.providerId.trim()) throw new Error("Provider ID 不能为空。");
    if (!input.modelId.trim()) throw new Error("Model ID 不能为空。");
    if (!this.getProviderRow(input.providerId)) {
      throw new Error(`找不到 Provider：${input.providerId}`);
    }
    const now = new Date().toISOString();
    const id = input.id ?? createCandidateModelId(input.providerId, input.modelId);
    const mapping = input.modelsDevMapping;
    const manual = input.manualSpec;
    this.db
      .prepare(`
        INSERT INTO provider_candidate_models (
          id, provider_id, model_id, display_name,
          models_dev_provider_key, models_dev_model_id,
          manual_context_tokens, manual_max_output_tokens,
          manual_supports_image_input, manual_supports_reasoning,
          manual_supports_native_web_search,
          manual_supports_remote_compaction,
          manual_input_per_m, manual_output_per_m,
          manual_cache_read_per_m, manual_cache_write_per_m, manual_price_multiplier,
          sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider_id, model_id) DO UPDATE SET
          display_name = excluded.display_name,
          models_dev_provider_key = excluded.models_dev_provider_key,
          models_dev_model_id = excluded.models_dev_model_id,
          manual_context_tokens = excluded.manual_context_tokens,
          manual_max_output_tokens = excluded.manual_max_output_tokens,
          manual_supports_image_input = excluded.manual_supports_image_input,
          manual_supports_reasoning = excluded.manual_supports_reasoning,
          manual_supports_native_web_search = excluded.manual_supports_native_web_search,
          manual_supports_remote_compaction = excluded.manual_supports_remote_compaction,
          manual_input_per_m = excluded.manual_input_per_m,
          manual_output_per_m = excluded.manual_output_per_m,
          manual_cache_read_per_m = excluded.manual_cache_read_per_m,
          manual_cache_write_per_m = excluded.manual_cache_write_per_m,
          manual_price_multiplier = excluded.manual_price_multiplier,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at
      `)
      .run(
        id,
        input.providerId.trim(),
        input.modelId.trim(),
        input.displayName?.trim() ?? null,
        mapping?.providerKey?.trim() ?? null,
        mapping?.modelId?.trim() ?? null,
        manual?.contextTokens ?? null,
        manual?.maxOutputTokens ?? null,
        triStateToNullableInt(manual?.supportsImageInput),
        triStateToNullableInt(manual?.supportsReasoning),
        nativeWebSearchToNullableInt(manual?.supportsNativeWebSearch),
        triStateToNullableInt(manual?.supportsRemoteCompaction),
        manual?.inputPerM ?? null,
        manual?.outputPerM ?? null,
        manual?.cacheReadPerM ?? null,
        manual?.cacheWritePerM ?? null,
        manual?.priceMultiplier ?? null,
        input.sortOrder ?? 0,
        now,
        now,
      );
    const savedRow = this.db
      .prepare("SELECT * FROM provider_candidate_models WHERE id = ?")
      .get(id) as unknown as CandidateModelRow;
    this.syncDefaultModelFromCandidates(input.providerId.trim());
    return candidateRowToView(savedRow);
  }

  deleteCandidateModel(id: string): void {
    const existing = this.db
      .prepare("SELECT provider_id FROM provider_candidate_models WHERE id = ?")
      .get(id) as { provider_id: string } | undefined;
    const result = this.db.prepare("DELETE FROM provider_candidate_models WHERE id = ?").run(id);
    if (result.changes === 0) {
      throw new Error(`找不到候选模型：${id}`);
    }
    if (existing?.provider_id) {
      this.syncDefaultModelFromCandidates(existing.provider_id);
    }
  }

  reorderCandidateModels(providerId: string, orderedIds: string[]): void {
    const stmt = this.db.prepare(
      "UPDATE provider_candidate_models SET sort_order = ?, updated_at = ? WHERE id = ? AND provider_id = ?",
    );
    const now = new Date().toISOString();
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (id) stmt.run(i, now, id, providerId);
    }
    this.syncDefaultModelFromCandidates(providerId);
  }

  bulkImportCandidateModels(providerId: string, modelIds: string[]): CandidateModelView[] {
    if (!this.getProviderRow(providerId)) {
      throw new Error(`找不到 Provider：${providerId}`);
    }
    const results: CandidateModelView[] = [];
    const now = new Date().toISOString();
    const maxSortOrder =
      (
        this.db
          .prepare("SELECT MAX(sort_order) as max_sort FROM provider_candidate_models WHERE provider_id = ?")
          .get(providerId) as { max_sort: number | null } | undefined
      )?.max_sort ?? -1;
    let sortOrder = maxSortOrder + 1;
    for (const modelId of modelIds) {
      const trimmed = modelId.trim();
      if (!trimmed) continue;
      const id = createCandidateModelId(providerId, trimmed);
      this.db
        .prepare(`
          INSERT OR IGNORE INTO provider_candidate_models (
            id, provider_id, model_id, display_name,
            models_dev_provider_key, models_dev_model_id,
            manual_context_tokens, manual_max_output_tokens,
            manual_supports_image_input, manual_supports_reasoning,
            manual_input_per_m, manual_output_per_m,
            manual_cache_read_per_m, manual_cache_write_per_m,
            sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
        `)
        .run(id, providerId, trimmed, null, sortOrder++, now, now);
      const row = this.db
        .prepare("SELECT * FROM provider_candidate_models WHERE provider_id = ? AND model_id = ?")
        .get(providerId, trimmed) as unknown as CandidateModelRow;
      if (row) results.push(candidateRowToView(row));
    }
    this.syncDefaultModelFromCandidates(providerId);
    return results;
  }

  /**
   * Synchronize models discovered from an upstream catalog into the provider's
   * candidate list. Existing rows keep their user-managed metadata; only a
   * missing row or an empty display name is filled from the upstream catalog.
   */
  syncCandidateModels(
    providerId: string,
    models: Array<{ id: string; displayName?: string }>,
  ): { models: CandidateModelView[]; changed: boolean } {
    if (!this.getProviderRow(providerId)) {
      throw new Error(`找不到 Provider：${providerId}`);
    }
    const now = new Date().toISOString();
    const existing = new Map(
      this.db
        .prepare("SELECT * FROM provider_candidate_models WHERE provider_id = ?")
        .all(providerId)
        .map(
          (row) =>
            [(row as unknown as CandidateModelRow).model_id, row as unknown as CandidateModelRow] as const,
        ),
    );
    let nextSortOrder =
      ((
        this.db
          .prepare("SELECT MAX(sort_order) as max_sort FROM provider_candidate_models WHERE provider_id = ?")
          .get(providerId) as { max_sort: number | null } | undefined
      )?.max_sort ?? -1) + 1;
    let changed = false;
    const seenModelIds = new Set<string>();

    for (const model of models) {
      const modelId = model.id.trim();
      if (!modelId) continue;
      if (seenModelIds.has(modelId)) continue;
      seenModelIds.add(modelId);
      const displayName = model.displayName?.trim() || modelId;
      const current = existing.get(modelId);
      if (!current) {
        const id = createCandidateModelId(providerId, modelId);
        this.db
          .prepare(`
            INSERT INTO provider_candidate_models (
              id, provider_id, model_id, display_name,
              models_dev_provider_key, models_dev_model_id,
              manual_context_tokens, manual_max_output_tokens,
              manual_supports_image_input, manual_supports_reasoning,
              manual_supports_native_web_search,
              manual_supports_remote_compaction,
              manual_input_per_m, manual_output_per_m,
              manual_cache_read_per_m, manual_cache_write_per_m, manual_price_multiplier,
              sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
          `)
          .run(id, providerId, modelId, displayName, nextSortOrder++, now, now);
        changed = true;
        continue;
      }
      if (!current.display_name?.trim()) {
        this.db
          .prepare("UPDATE provider_candidate_models SET display_name = ?, updated_at = ? WHERE id = ?")
          .run(displayName, now, current.id);
        changed = true;
      }
    }

    if (changed) this.syncDefaultModelFromCandidates(providerId);
    return { models: this.listCandidateModels(providerId), changed };
  }

  /** Keep provider.default_model aligned with the first candidate model when present. */
  private syncDefaultModelFromCandidates(providerId: string): void {
    const firstCandidate = this.listCandidateModels(providerId)[0];
    if (!firstCandidate) {
      return;
    }
    const row = this.getProviderRow(providerId);
    if (!row) {
      return;
    }
    const nextDefault = firstCandidate.modelId.trim();
    if (!nextDefault || row.default_model === nextDefault) {
      return;
    }
    this.db
      .prepare("UPDATE provider_configs SET default_model = ?, updated_at = ? WHERE id = ?")
      .run(nextDefault, new Date().toISOString(), providerId);
  }
}

function providerRowToView(row: ProviderRow): ProviderConfigView {
  const provider: ProviderConfigView = {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    requestPath: row.request_path ?? "",
    version: normalizeApiVersion(row.version),
    apiCompat: normalizeUpstreamApiCompat(row.api_compat),
    tokenCountMode: normalizeProviderTokenCountMode(row.token_count_mode),
    authMethod: normalizeProviderAuthMethod(row.auth_method),
    ...(row.credential_pool_id ? { credentialPoolId: row.credential_pool_id } : {}),
    defaultModel: row.default_model,
    enabled: row.enabled === 1,
    hasApiKey: row.api_key.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const apiKeyPreview = previewSecret(row.api_key);
  if (apiKeyPreview) provider.apiKeyPreview = apiKeyPreview;
  if (row.upstream_proxy_url) provider.upstreamProxyUrl = row.upstream_proxy_url;
  return provider;
}

function profileRowToView(row: RouteProfileRow, routes: RoleRouteConfig[]): RouteProfileView {
  return {
    id: row.id,
    name: row.name,
    routes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function routeRowToConfig(row: RouteRow): RoleRouteConfig {
  const effort = parseThinkingEffort(row.thinking_effort);
  const modelsDevMapping = parseModelsDevMapping(row.models_dev_provider_key, row.models_dev_model_id);
  const manualSpec = parseManualSpecRow(row);
  const apiCompat = row.api_compat ? normalizeUpstreamApiCompat(row.api_compat) : undefined;
  return {
    role: row.role,
    providerId: row.provider_id,
    modelId: row.model_id,
    ...(apiCompat && { apiCompat }),
    ...(effort && { thinkingEffort: effort }),
    ...(modelsDevMapping && { modelsDevMapping }),
    ...(manualSpec && { manualSpec }),
  };
}

const THINKING_EFFORT_VALUES = new Set<ThinkingEffort>(["off", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingEffort(value: string | null | undefined): ThinkingEffort | undefined {
  if (!value) {
    return undefined;
  }
  return THINKING_EFFORT_VALUES.has(value as ThinkingEffort) ? (value as ThinkingEffort) : undefined;
}

function normalizeThinkingEffort(value: ThinkingEffort | undefined): string | null {
  if (!value) {
    return null;
  }
  return THINKING_EFFORT_VALUES.has(value) ? value : null;
}

function parseModelsDevMapping(
  providerKey: string | null | undefined,
  modelId: string | null | undefined,
): RoleRouteConfig["modelsDevMapping"] {
  if (!providerKey?.trim() || !modelId?.trim()) {
    return undefined;
  }
  return {
    providerKey: providerKey.trim(),
    modelId: modelId.trim(),
  };
}

function normalizeModelsDevMapping(
  value: RoleRouteConfig["modelsDevMapping"],
): RoleRouteConfig["modelsDevMapping"] {
  if (!value?.providerKey.trim() || !value.modelId.trim()) {
    return undefined;
  }
  return {
    providerKey: value.providerKey.trim(),
    modelId: value.modelId.trim(),
  };
}

function parseManualSpecRow(row: RouteRow): RouteManualSpec | undefined {
  const contextTokens = parsePositiveInt(row.manual_context_tokens);
  const inputPerM = parseNonNegativeNumber(row.manual_input_per_m);
  const outputPerM = parseNonNegativeNumber(row.manual_output_per_m);
  const cacheReadPerM = parseNonNegativeNumber(row.manual_cache_read_per_m);
  const cacheWritePerM = parseNonNegativeNumber(row.manual_cache_write_per_m);
  const priceMultiplier = parseStoredPriceMultiplier(row.manual_price_multiplier);
  if (
    contextTokens === undefined &&
    inputPerM === undefined &&
    outputPerM === undefined &&
    cacheReadPerM === undefined &&
    cacheWritePerM === undefined &&
    priceMultiplier === undefined
  ) {
    return undefined;
  }
  return {
    ...(contextTokens !== undefined && { contextTokens }),
    ...(inputPerM !== undefined && { inputPerM }),
    ...(outputPerM !== undefined && { outputPerM }),
    ...(cacheReadPerM !== undefined && { cacheReadPerM }),
    ...(cacheWritePerM !== undefined && { cacheWritePerM }),
    ...(priceMultiplier !== undefined && { priceMultiplier }),
  };
}

function normalizeManualSpec(value: RouteManualSpec | undefined): RouteManualSpec | undefined {
  if (!value) {
    return undefined;
  }
  const contextTokens = parsePositiveInt(value.contextTokens);
  const inputPerM = parseNonNegativeNumber(value.inputPerM);
  const outputPerM = parseNonNegativeNumber(value.outputPerM);
  const cacheReadPerM = parseNonNegativeNumber(value.cacheReadPerM);
  const cacheWritePerM = parseNonNegativeNumber(value.cacheWritePerM);
  const priceMultiplier = parseStoredPriceMultiplier(value.priceMultiplier);
  if (
    contextTokens === undefined &&
    inputPerM === undefined &&
    outputPerM === undefined &&
    cacheReadPerM === undefined &&
    cacheWritePerM === undefined &&
    priceMultiplier === undefined
  ) {
    return undefined;
  }
  return {
    ...(contextTokens !== undefined && { contextTokens }),
    ...(inputPerM !== undefined && { inputPerM }),
    ...(outputPerM !== undefined && { outputPerM }),
    ...(cacheReadPerM !== undefined && { cacheReadPerM }),
    ...(cacheWritePerM !== undefined && { cacheWritePerM }),
    ...(priceMultiplier !== undefined && { priceMultiplier }),
  };
}

function parsePositiveInt(value: number | undefined | null): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function parseNonNegativeNumber(value: number | undefined | null): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return value >= 0 ? value : undefined;
}

function parseStoredPriceMultiplier(value: number | undefined | null): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return normalizeStoredPriceMultiplier(value);
}

function normalizeProfileRoutes(routes: RoleRouteConfig[]): RoleRouteConfig[] {
  const routesByRole = new Map<AgentRole, RoleRouteConfig>();
  for (const route of routes) {
    routesByRole.set(route.role, route);
  }
  return AGENT_ROLES.map((role) => {
    const route = routesByRole.get(role);
    if (!route) {
      throw new Error(`Route for ${role} is required.`);
    }
    return route;
  });
}

function validateProviderInput(input: ProviderConfigInput): void {
  if (!input.name.trim()) throw new Error("Provider name is required.");
  if (!input.baseUrl.trim().startsWith("http://") && !input.baseUrl.trim().startsWith("https://")) {
    throw new Error("Provider baseURL must start with http:// or https://.");
  }
  const requestPath = input.requestPath?.trim();
  if (requestPath && !requestPath.startsWith("/")) {
    throw new Error("请求端点须以 / 开头，例如 /anthropic。");
  }
  const authMethod = input.authMethod ?? "api_key";
  if (!["api_key", "oauth", "auth_json", "chatgpt_subscription"].includes(authMethod)) {
    throw new Error(`Unsupported provider auth method: ${authMethod}`);
  }
  if (authMethod === "chatgpt_subscription" && input.apiKey?.trim()) {
    throw new Error("chatgpt_subscription provider must not store an API key.");
  }
}

function normalizeProviderAuthMethod(
  value: string | undefined,
): "api_key" | "oauth" | "auth_json" | "chatgpt_subscription" {
  switch (value) {
    case "oauth":
    case "auth_json":
    case "chatgpt_subscription":
    case "api_key":
      return value;
    default:
      return "api_key";
  }
}

/** Validate per-provider proxy URL; empty means "follow global proxy". */
function normalizeProviderUpstreamProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return parseUpstreamProxyUrl(trimmed) ?? "";
  } catch (error) {
    throw new Error(`无效的上游代理 URL：${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateRouteProfileInput(input: RouteProfileInput): void {
  if (!input.name.trim()) {
    throw new Error("路由配置名称不能为空。");
  }
  normalizeProfileRoutes(input.routes);
}

function createProviderId(name: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const normalizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${normalizedName || "provider"}-${suffix}`;
}

function createRouteProfileId(name: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const normalizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${normalizedName || "route-profile"}-${suffix}`;
}

function previewSecret(secret: string): string | undefined {
  if (!secret) return undefined;
  if (secret.length <= 8) return "saved";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function candidateRowToView(row: CandidateModelRow): CandidateModelView {
  const modelsDevMapping = parseModelsDevMapping(row.models_dev_provider_key, row.models_dev_model_id);
  const contextTokens = parsePositiveInt(row.manual_context_tokens);
  const maxOutputTokens = parsePositiveInt(row.manual_max_output_tokens);
  const inputPerM = parseNonNegativeNumber(row.manual_input_per_m);
  const outputPerM = parseNonNegativeNumber(row.manual_output_per_m);
  const cacheReadPerM = parseNonNegativeNumber(row.manual_cache_read_per_m);
  const cacheWritePerM = parseNonNegativeNumber(row.manual_cache_write_per_m);
  const priceMultiplier = parseStoredPriceMultiplier(row.manual_price_multiplier);
  const supportsImageInput =
    row.manual_supports_image_input === null || row.manual_supports_image_input === undefined
      ? undefined
      : row.manual_supports_image_input === 1;
  const supportsReasoning =
    row.manual_supports_reasoning === null || row.manual_supports_reasoning === undefined
      ? undefined
      : row.manual_supports_reasoning === 1;
  const supportsNativeWebSearch = nullableIntToNativeWebSearch(row.manual_supports_native_web_search);
  const supportsRemoteCompaction =
    row.manual_supports_remote_compaction == null ? undefined : row.manual_supports_remote_compaction === 1;
  const hasManualSpec =
    contextTokens !== undefined ||
    maxOutputTokens !== undefined ||
    inputPerM !== undefined ||
    outputPerM !== undefined ||
    cacheReadPerM !== undefined ||
    cacheWritePerM !== undefined ||
    priceMultiplier !== undefined ||
    supportsImageInput !== undefined ||
    supportsReasoning !== undefined ||
    supportsNativeWebSearch !== undefined ||
    supportsRemoteCompaction !== undefined;
  const manualSpec: RouteManualSpec | undefined = hasManualSpec
    ? {
        ...(contextTokens !== undefined && { contextTokens }),
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
        ...(supportsImageInput !== undefined && { supportsImageInput }),
        ...(supportsReasoning !== undefined && { supportsReasoning }),
        ...(supportsNativeWebSearch !== undefined && { supportsNativeWebSearch }),
        ...(supportsRemoteCompaction !== undefined && { supportsRemoteCompaction }),
        ...(inputPerM !== undefined && { inputPerM }),
        ...(outputPerM !== undefined && { outputPerM }),
        ...(cacheReadPerM !== undefined && { cacheReadPerM }),
        ...(cacheWritePerM !== undefined && { cacheWritePerM }),
        ...(priceMultiplier !== undefined && { priceMultiplier }),
      }
    : undefined;
  const view: CandidateModelView = {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.display_name) view.displayName = row.display_name;
  if (modelsDevMapping) view.modelsDevMapping = modelsDevMapping;
  if (manualSpec) view.manualSpec = manualSpec;
  return view;
}

function createCandidateModelId(providerId: string, modelId: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const normalizedProvider = providerId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const normalizedModel = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `cand-${normalizedProvider}-${normalizedModel}-${suffix}`;
}

function nativeWebSearchToNullableInt(value: boolean | undefined): number | null {
  if (value === false) {
    return 0;
  }
  return null;
}

function nullableIntToNativeWebSearch(value: number | null | undefined): boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value !== 0;
}

function triStateToNullableInt(value: boolean | undefined): number | null {
  if (value === undefined) return null;
  return value ? 1 : 0;
}

function fail(message: string): never {
  throw new Error(message);
}
