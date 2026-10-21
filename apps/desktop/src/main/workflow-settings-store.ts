import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  type CoreKind,
  DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT,
  DEFAULT_GLOBAL_MAX_OUTPUT_LIMIT,
  type GlobalMaxOutputTokens,
  type EcoOrchestrationMode,
  isCoreKind,
  isGlobalContextWindowLimit,
  isGlobalMaxOutputTokens,
  normalizeGlobalContextWindowLimit,
  normalizeGlobalMaxOutputTokens,
} from "@eco/runtime";
import type { OrchestrationSelection } from "../shared/agent-orchestration";
import { isOrchestrationSelection } from "../shared/agent-orchestration";
import {
  type ApprovalModelSelection,
  isApprovalModelSelection,
  normalizeApprovalModelSelection,
} from "../shared/approval-model";
import {
  type AuxiliaryModelSelection,
  isAuxiliaryModelSelection,
  normalizeAuxiliaryModelSelection,
} from "../shared/auxiliary-model";
import { type BashReviewMode, isBashReviewMode, normalizeBashReviewMode } from "../shared/bash-review-ui";
import { ECO_AGENT_BROWSER_MCP_SERVER } from "../shared/browser";
import { type McpServersEnabledSettings, normalizeMcpServersEnabled } from "../shared/composer-mcp";
import { type IntegrationsEnabledSettings, normalizeIntegrationsEnabled } from "../shared/integrations";
import type { FollowUpDeliveryMode } from "../shared/ipc";
import {
  isMainAgentModelOverride,
  type MainAgentModelOverride,
  normalizeMainAgentModelOverride,
} from "../shared/thread-runtime-config";
import { isSessionMode, normalizeSessionMode, type SessionMode } from "../shared/session-mode";
import {
  isVisionModelSelection,
  normalizeVisionModelSelection,
  type VisionModelSelection,
} from "../shared/vision-model";

export type { SessionMode };

export const FOLLOW_UP_DELIVERY_MODES = ["queue", "steer"] as const satisfies readonly FollowUpDeliveryMode[];

export const DEFAULT_FOLLOW_UP_DELIVERY_MODE: FollowUpDeliveryMode = "steer";

export function isFollowUpDeliveryMode(value: unknown): value is FollowUpDeliveryMode {
  return value === "queue" || value === "steer";
}

export function normalizeFollowUpDeliveryMode(value: unknown): FollowUpDeliveryMode {
  return isFollowUpDeliveryMode(value) ? value : DEFAULT_FOLLOW_UP_DELIVERY_MODE;
}

export type AcpAgentsEnabledSettings = {
  cursor?: boolean;
};

export type DefaultAcpAgentId = "cursor";

export interface WorkflowSettingsSnapshot {
  sessionMode: SessionMode;
  defaultCoreKind?: CoreKind;
  /** Per-ACP-agent opt-in. Absent/false = off. */
  acpAgentsEnabled?: AcpAgentsEnabledSettings;
  /** Cursor ACP model id; absent means let Cursor use its own current/default. */
  acpCursorModelId?: string;
  /** Cursor ACP API key (spawned as `CURSOR_API_KEY`); absent = use local Cursor login. */
  acpCursorApiKey?: string;
  /** When defaultCoreKind is `"acp"`, which agent (MVP: `"cursor"`). */
  defaultAcpAgentId?: DefaultAcpAgentId;
  /** Whether Composer shows billing usage. Defaults to true for older settings. */
  showBilling?: boolean;
  /**
   * Default execution approval mode for new sessions.
   * Absent / invalid → `"always"` (request approval).
   */
  defaultBashReviewMode?: BashReviewMode;
  contextWindowLimitTokens: number;
  maxOutputLimitTokens: GlobalMaxOutputTokens;
  followUpDeliveryMode: FollowUpDeliveryMode;
  defaultOrchestrationSelection?: OrchestrationSelection;
  defaultAuxiliaryModel?: AuxiliaryModelSelection;
  defaultApprovalModel?: ApprovalModelSelection;
  defaultVisionModel?: VisionModelSelection;
  /** Last model and reasoning choice made with the built-in Codex Auth config. */
  codexAuthModel?: MainAgentModelOverride;
  mcpServersEnabled?: Record<string, boolean>;
  integrationsEnabled?: IntegrationsEnabledSettings;
}

export function defaultWorkflowSettings(): WorkflowSettingsSnapshot {
  return {
    sessionMode: "agent",
    defaultCoreKind: "claude",
    showBilling: true,
    defaultBashReviewMode: "always",
    contextWindowLimitTokens: DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT,
    maxOutputLimitTokens: DEFAULT_GLOBAL_MAX_OUTPUT_LIMIT,
    followUpDeliveryMode: DEFAULT_FOLLOW_UP_DELIVERY_MODE,
  };
}

export async function createWorkflowSettingsStore(dbPath: string): Promise<WorkflowSettingsStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await import("node:sqlite");
  const store = new WorkflowSettingsStore(new sqlite.DatabaseSync(dbPath));
  store.initialize();
  return store;
}

export class WorkflowSettingsStore {
  constructor(private readonly db: DatabaseSyncType) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(): WorkflowSettingsSnapshot {
    const sessionMode = this.readSessionMode();
    const storedCoreKind = this.readDefaultCoreKindRaw();
    const acpAgentsEnabled = this.readAcpAgentsEnabled();
    const acpCursorModelId = this.readAcpCursorModelId();
    const acpCursorApiKey = this.readAcpCursorApiKey();
    const defaultAcpAgentId = this.readDefaultAcpAgentId();
    const showBilling = this.readShowBilling();
    const defaultBashReviewMode = this.readDefaultBashReviewMode();
    const contextWindowLimitTokens = this.readContextWindowLimitTokens();
    const maxOutputLimitTokens = this.readMaxOutputLimitTokens();
    const defaultOrchestrationSelection = this.readDefaultOrchestrationSelection();
    const defaultAuxiliaryModel = this.readDefaultAuxiliaryModel();
    const defaultApprovalModel = this.readDefaultApprovalModel();
    const defaultVisionModel = this.readDefaultVisionModel();
    const codexAuthModel = this.getCodexAuthModel();
    const followUpDeliveryMode = this.readFollowUpDeliveryMode();
    const mcpServersEnabled = this.readMcpServersEnabled();
    const storedIntegrations = this.readIntegrationsEnabled();
    const legacyBrowser = mcpServersEnabled?.[ECO_AGENT_BROWSER_MCP_SERVER];
    const integrationsEnabled =
      storedIntegrations ?? (typeof legacyBrowser === "boolean" ? { browser: legacyBrowser } : undefined);
    const cleanedMcp = mcpServersEnabled
      ? Object.fromEntries(
          Object.entries(mcpServersEnabled).filter(([key]) => key !== ECO_AGENT_BROWSER_MCP_SERVER),
        )
      : undefined;
    const legacyCursorEnabled = this.readLegacyCursorCoreEnabled();
    const legacyCursorModelId = this.readLegacyCursorModelId();
    const hasLegacyCursorKeys = this.hasLegacyCursorKeys();
    // One-shot migrate: legacy cursor_* keys → ACP fields (normalize also handles IPC payloads).
    const migrated = normalizeWorkflowSettingsSnapshot({
      sessionMode,
      defaultCoreKind: storedCoreKind,
      ...(acpAgentsEnabled ? { acpAgentsEnabled } : {}),
      ...(acpCursorModelId ? { acpCursorModelId } : {}),
      ...(acpCursorApiKey ? { acpCursorApiKey } : {}),
      ...(defaultAcpAgentId ? { defaultAcpAgentId } : {}),
      showBilling,
      defaultBashReviewMode,
      ...(legacyCursorEnabled ? { cursorCoreEnabled: true } : {}),
      ...(legacyCursorModelId ? { cursorModelId: legacyCursorModelId } : {}),
      contextWindowLimitTokens,
      maxOutputLimitTokens,
      followUpDeliveryMode,
      ...(defaultOrchestrationSelection ? { defaultOrchestrationSelection } : {}),
      ...(defaultAuxiliaryModel ? { defaultAuxiliaryModel } : {}),
      ...(defaultApprovalModel ? { defaultApprovalModel } : {}),
      ...(defaultVisionModel ? { defaultVisionModel } : {}),
      ...(codexAuthModel ? { codexAuthModel } : {}),
      ...(cleanedMcp && Object.keys(cleanedMcp).length > 0 ? { mcpServersEnabled: cleanedMcp } : {}),
      ...(integrationsEnabled ? { integrationsEnabled } : {}),
    });
    // Persist migrated ACP keys and delete legacy keys (not only in-memory normalize).
    if (hasLegacyCursorKeys) {
      return this.save(migrated);
    }
    return migrated;
  }

  save(snapshot: WorkflowSettingsSnapshot): WorkflowSettingsSnapshot {
    const normalized = normalizeWorkflowSettingsSnapshot(snapshot);
    const now = new Date().toISOString();
    if (normalized.codexAuthModel) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run("codex_auth_model", JSON.stringify(normalized.codexAuthModel), now);
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("codex_auth_model");
    }
    this.db
      .prepare(
        `INSERT INTO workflow_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run("session_mode", JSON.stringify(normalized.sessionMode), now);
    this.db
      .prepare(
        `INSERT INTO workflow_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run("default_core_kind", JSON.stringify(normalized.defaultCoreKind ?? "claude"), now);
    if (normalized.acpAgentsEnabled?.cursor === true) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run("acp_agents_enabled", JSON.stringify({ cursor: true }), now);
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("acp_agents_enabled");
    }
    if (normalized.acpCursorModelId) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run("acp_cursor_model_id", JSON.stringify(normalized.acpCursorModelId), now);
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("acp_cursor_model_id");
    }
    if (normalized.acpCursorApiKey) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run("acp_cursor_api_key", JSON.stringify(normalized.acpCursorApiKey), now);
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("acp_cursor_api_key");
    }
    if (normalized.defaultAcpAgentId) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run("default_acp_agent_id", JSON.stringify(normalized.defaultAcpAgentId), now);
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("default_acp_agent_id");
    }
    // Drop legacy Cursor opt-in keys after ACP migration write.
    this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("cursor_model_id");
    this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("cursor_core_enabled");
    this.db
      .prepare(
        `INSERT INTO workflow_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run("show_billing", JSON.stringify(normalized.showBilling !== false), now);
    this.db
      .prepare(
        `INSERT INTO workflow_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run("default_bash_review_mode", JSON.stringify(normalized.defaultBashReviewMode ?? "always"), now);
    this.db
      .prepare(
        `INSERT INTO workflow_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run("context_window_limit_tokens", JSON.stringify(normalized.contextWindowLimitTokens), now);
    this.db
      .prepare(
        `INSERT INTO workflow_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run("max_output_limit_tokens", JSON.stringify(normalized.maxOutputLimitTokens), now);
    this.db
      .prepare(
        `INSERT INTO workflow_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run("follow_up_delivery_mode", JSON.stringify(normalized.followUpDeliveryMode), now);
    if (normalized.defaultOrchestrationSelection) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(
          "default_orchestration_selection",
          JSON.stringify(normalized.defaultOrchestrationSelection),
          now,
        );
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("default_orchestration_selection");
    }
    if (normalized.defaultAuxiliaryModel) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run("default_auxiliary_model", JSON.stringify(normalized.defaultAuxiliaryModel), now);
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("default_auxiliary_model");
    }
    if (normalized.defaultApprovalModel) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run("default_approval_model", JSON.stringify(normalized.defaultApprovalModel), now);
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("default_approval_model");
    }
    if (normalized.defaultVisionModel) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run("default_vision_model", JSON.stringify(normalized.defaultVisionModel), now);
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("default_vision_model");
    }
    if (normalized.mcpServersEnabled) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run("composer_mcp_servers_enabled", JSON.stringify(normalized.mcpServersEnabled), now);
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("composer_mcp_servers_enabled");
    }
    if (normalized.integrationsEnabled) {
      this.db
        .prepare(
          `INSERT INTO workflow_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run("composer_integrations_enabled", JSON.stringify(normalized.integrationsEnabled), now);
    } else {
      this.db.prepare(`DELETE FROM workflow_settings WHERE key = ?`).run("composer_integrations_enabled");
    }
    return this.get();
  }

  clearDefaultSubagentOrchestrationReference(orchestrationId: string): boolean {
    const trimmedId = orchestrationId.trim();
    const selection = this.readDefaultOrchestrationSelection();
    if (
      !trimmedId ||
      !selection ||
      selection.subagents.mode !== "orchestration" ||
      selection.subagents.orchestrationId !== trimmedId
    ) {
      return false;
    }
    this.save({
      ...this.get(),
      defaultOrchestrationSelection: { ...selection, subagents: { mode: "none" } },
    });
    return true;
  }

  /** Clear the global default when it points at a deleted main-agent config. */
  clearDefaultMainAgentConfigReference(configId: string): boolean {
    const trimmedId = configId.trim();
    const selection = this.readDefaultOrchestrationSelection();
    if (!trimmedId || !selection || selection.mainAgentConfigId !== trimmedId) {
      return false;
    }
    const current = this.get();
    const { defaultOrchestrationSelection: _removed, ...rest } = current;
    this.save(rest);
    return true;
  }

  /** Reset the global default prompt to builtin when it points at a deleted prompt. */
  clearDefaultMainAgentPromptReference(promptId: string): boolean {
    const trimmedId = promptId.trim();
    const selection = this.readDefaultOrchestrationSelection();
    if (
      !trimmedId ||
      !selection ||
      selection.mainPrompt.mode !== "custom_append" ||
      selection.mainPrompt.promptId !== trimmedId
    ) {
      return false;
    }
    this.save({
      ...this.get(),
      defaultOrchestrationSelection: { ...selection, mainPrompt: { mode: "builtin" } },
    });
    return true;
  }

  private readSessionMode(): SessionMode {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("session_mode") as { value_json: string } | undefined;
    if (!row) {
      return "agent";
    }
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      if (isSessionMode(parsed)) {
        return parsed;
      }
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (isSessionMode(record.sessionMode)) {
          return record.sessionMode;
        }
      }
    } catch {
      // ignore
    }
    return normalizeSessionMode(row.value_json);
  }

  private readIntegrationsEnabled(): IntegrationsEnabledSettings | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("composer_integrations_enabled") as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return normalizeIntegrationsEnabled(JSON.parse(row.value_json));
    } catch {
      return undefined;
    }
  }

  private readDefaultCoreKindRaw(): string {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("default_core_kind") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return "claude";
    }
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      return typeof parsed === "string" ? parsed : "claude";
    } catch {
      return "claude";
    }
  }

  private readAcpAgentsEnabled(): AcpAgentsEnabledSettings | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("acp_agents_enabled") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) return undefined;
    try {
      return normalizeAcpAgentsEnabled(JSON.parse(row.value_json) as unknown);
    } catch {
      return undefined;
    }
  }

  private readAcpCursorModelId(): string | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("acp_cursor_model_id") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) return undefined;
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private readAcpCursorApiKey(): string | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("acp_cursor_api_key") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) return undefined;
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private readDefaultAcpAgentId(): DefaultAcpAgentId | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("default_acp_agent_id") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) return undefined;
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      return parsed === "cursor" ? "cursor" : undefined;
    } catch {
      return undefined;
    }
  }

  private readLegacyCursorModelId(): string | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("cursor_model_id") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) return undefined;
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private readLegacyCursorCoreEnabled(): boolean {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("cursor_core_enabled") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) return false;
    try {
      return JSON.parse(row.value_json) === true;
    } catch {
      return false;
    }
  }

  private hasLegacyCursorKeys(): boolean {
    const enabled = this.db
      .prepare(`SELECT 1 AS ok FROM workflow_settings WHERE key = ?`)
      .get("cursor_core_enabled") as { ok: number } | undefined;
    if (enabled) return true;
    const model = this.db
      .prepare(`SELECT 1 AS ok FROM workflow_settings WHERE key = ?`)
      .get("cursor_model_id") as { ok: number } | undefined;
    return Boolean(model);
  }

  private readShowBilling(): boolean {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("show_billing") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return true;
    }
    try {
      return JSON.parse(row.value_json) !== false;
    } catch {
      return true;
    }
  }

  private readDefaultBashReviewMode(): BashReviewMode {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("default_bash_review_mode") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return "always";
    }
    try {
      return normalizeBashReviewMode(JSON.parse(row.value_json) as unknown);
    } catch {
      return "always";
    }
  }

  private readContextWindowLimitTokens(): number {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("context_window_limit_tokens") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT;
    }
    try {
      return normalizeGlobalContextWindowLimit(JSON.parse(row.value_json) as unknown);
    } catch {
      return DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT;
    }
  }

  private readMaxOutputLimitTokens(): GlobalMaxOutputTokens {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("max_output_limit_tokens") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return DEFAULT_GLOBAL_MAX_OUTPUT_LIMIT;
    }
    try {
      return normalizeGlobalMaxOutputTokens(JSON.parse(row.value_json) as unknown);
    } catch {
      return DEFAULT_GLOBAL_MAX_OUTPUT_LIMIT;
    }
  }

  private readMcpServersEnabled(): McpServersEnabledSettings | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("composer_mcp_servers_enabled") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return undefined;
    }
    try {
      return normalizeMcpServersEnabled(JSON.parse(row.value_json) as unknown);
    } catch {
      return undefined;
    }
  }

  private readDefaultOrchestrationSelection(): OrchestrationSelection | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("default_orchestration_selection") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      return isOrchestrationSelection(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private readDefaultAuxiliaryModel(): AuxiliaryModelSelection | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("default_auxiliary_model") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return undefined;
    }
    try {
      return normalizeAuxiliaryModelSelection(JSON.parse(row.value_json) as unknown);
    } catch {
      return undefined;
    }
  }

  private readDefaultApprovalModel(): ApprovalModelSelection | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("default_approval_model") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return undefined;
    }
    try {
      return normalizeApprovalModelSelection(JSON.parse(row.value_json) as unknown);
    } catch {
      return undefined;
    }
  }

  getCodexAuthModel(): MainAgentModelOverride | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("codex_auth_model") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) return undefined;
    try {
      return normalizeCodexAuthModel(JSON.parse(row.value_json) as unknown);
    } catch {
      return undefined;
    }
  }

  private readDefaultVisionModel(): VisionModelSelection | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("default_vision_model") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return undefined;
    }
    try {
      return normalizeVisionModelSelection(JSON.parse(row.value_json) as unknown);
    } catch {
      return undefined;
    }
  }

  private readFollowUpDeliveryMode(): FollowUpDeliveryMode {
    const row = this.db
      .prepare(`SELECT value_json FROM workflow_settings WHERE key = ?`)
      .get("follow_up_delivery_mode") as { value_json: string } | undefined;
    if (!row?.value_json?.trim()) {
      return DEFAULT_FOLLOW_UP_DELIVERY_MODE;
    }
    try {
      return normalizeFollowUpDeliveryMode(JSON.parse(row.value_json) as unknown);
    } catch {
      return DEFAULT_FOLLOW_UP_DELIVERY_MODE;
    }
  }
}

export function orchestrationModeFromSnapshot(settings: WorkflowSettingsSnapshot): EcoOrchestrationMode {
  return settings.sessionMode === "plan" ? "manual" : "autonomous";
}

export function usesPlanMode(settings: WorkflowSettingsSnapshot): boolean {
  return settings.sessionMode === "plan";
}

/** @deprecated Use usesPlanMode */
export function usesManualOrchestration(settings: WorkflowSettingsSnapshot): boolean {
  return usesPlanMode(settings);
}

/** @deprecated Use usesPlanMode */
export function usesPlanOrchestration(settings: WorkflowSettingsSnapshot): boolean {
  return usesPlanMode(settings);
}

export function normalizeWorkflowSettingsSnapshot(value: unknown): WorkflowSettingsSnapshot {
  if (!value || typeof value !== "object") {
    return defaultWorkflowSettings();
  }
  const record = value as Record<string, unknown>;
  const defaultCoreKind = normalizeDefaultCoreKind(record.defaultCoreKind);
  const acpAgentsEnabled = resolveAcpAgentsEnabled(record);
  const acpCursorModelId =
    normalizeAcpCursorModelId(record.acpCursorModelId) ?? normalizeAcpCursorModelId(record.cursorModelId);
  const acpCursorApiKey = normalizeAcpCursorApiKey(record.acpCursorApiKey);
  const defaultAcpAgentId = resolveDefaultAcpAgentId(record, defaultCoreKind);
  const showBilling = record.showBilling !== false;
  const defaultBashReviewMode = normalizeBashReviewMode(record.defaultBashReviewMode);
  const contextWindowLimitTokens = normalizeGlobalContextWindowLimit(record.contextWindowLimitTokens);
  const maxOutputLimitTokens = normalizeGlobalMaxOutputTokens(record.maxOutputLimitTokens);
  const followUpDeliveryMode = normalizeFollowUpDeliveryMode(record.followUpDeliveryMode);
  const defaultOrchestrationSelection = isOrchestrationSelection(record.defaultOrchestrationSelection)
    ? record.defaultOrchestrationSelection
    : undefined;
  const defaultAuxiliaryModel = normalizeAuxiliaryModelSelection(record.defaultAuxiliaryModel);
  const defaultApprovalModel = normalizeApprovalModelSelection(record.defaultApprovalModel);
  const defaultVisionModel = normalizeVisionModelSelection(record.defaultVisionModel);
  const codexAuthModel = normalizeCodexAuthModel(record.codexAuthModel);
  const mcpServersEnabled = normalizeMcpServersEnabled(record.mcpServersEnabled);
  const integrationsEnabled = normalizeIntegrationsEnabled(record.integrationsEnabled);
  const acpCursorApiKeyPart = acpCursorApiKey ? { acpCursorApiKey } : {};
  const mcpPart = mcpServersEnabled ? { mcpServersEnabled } : {};
  const integrationsPart = integrationsEnabled ? { integrationsEnabled } : {};
  const defaultOrchestrationPart = defaultOrchestrationSelection ? { defaultOrchestrationSelection } : {};
  const defaultAuxiliaryPart = defaultAuxiliaryModel ? { defaultAuxiliaryModel } : {};
  const defaultApprovalPart = defaultApprovalModel ? { defaultApprovalModel } : {};
  const defaultVisionPart = defaultVisionModel ? { defaultVisionModel } : {};
  if (isSessionMode(record.sessionMode)) {
    return {
      sessionMode: record.sessionMode,
      defaultCoreKind,
      ...(acpAgentsEnabled ? { acpAgentsEnabled } : {}),
      ...(acpCursorModelId ? { acpCursorModelId } : {}),
      ...acpCursorApiKeyPart,
      ...(defaultAcpAgentId ? { defaultAcpAgentId } : {}),
      showBilling,
      defaultBashReviewMode,
      contextWindowLimitTokens,
      maxOutputLimitTokens,
      followUpDeliveryMode,
      ...defaultOrchestrationPart,
      ...defaultAuxiliaryPart,
      ...defaultApprovalPart,
      ...defaultVisionPart,
      ...(codexAuthModel ? { codexAuthModel } : {}),
      ...mcpPart,
      ...integrationsPart,
    };
  }
  return defaultWorkflowSettings();
}

function normalizeCodexAuthModel(value: unknown): MainAgentModelOverride | undefined {
  if (!isMainAgentModelOverride(value) || value.providerId.trim() !== "openai") return undefined;
  return normalizeMainAgentModelOverride(value);
}

function normalizeDefaultCoreKind(value: unknown): CoreKind {
  if (value === "cursor") {
    return "acp";
  }
  return isCoreKind(value) ? value : "claude";
}

function normalizeAcpAgentsEnabled(value: unknown): AcpAgentsEnabledSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.cursor === true) {
    return { cursor: true };
  }
  return undefined;
}

function resolveAcpAgentsEnabled(record: Record<string, unknown>): AcpAgentsEnabledSettings | undefined {
  const fromNew = normalizeAcpAgentsEnabled(record.acpAgentsEnabled);
  if (fromNew) return fromNew;
  if (record.cursorCoreEnabled === true) {
    return { cursor: true };
  }
  return undefined;
}

function resolveDefaultAcpAgentId(
  record: Record<string, unknown>,
  defaultCoreKind: CoreKind,
): DefaultAcpAgentId | undefined {
  if (record.defaultAcpAgentId === "cursor") {
    return "cursor";
  }
  if (defaultCoreKind === "acp" || record.defaultCoreKind === "cursor") {
    return "cursor";
  }
  return undefined;
}

function normalizeAcpCursorModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 256 ? trimmed : undefined;
}

function normalizeAcpCursorApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 512 ? trimmed : undefined;
}

/**
 * Resolve the effective Cursor ACP API key for a workflow-settings save.
 *
 * The key is a device-local secret. Partial-update callers (notably the mobile
 * `workflow-settings:save`) omit the field entirely because they never carry the
 * raw key; omission must mean "no change" so a key set on this device is not
 * silently deleted. Only an explicit string sets (non-blank) or clears (blank) it.
 */
export function resolveAcpCursorApiKeyForSave(
  payload: { acpCursorApiKey?: unknown },
  previousKey: string | undefined,
): string | undefined {
  const explicit = payload.acpCursorApiKey;
  if (typeof explicit !== "string") {
    return previousKey;
  }
  return normalizeAcpCursorApiKey(explicit);
}

export function isWorkflowSettingsSnapshot(value: unknown): value is WorkflowSettingsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const coreKindOk =
    record.defaultCoreKind === undefined ||
    isCoreKind(record.defaultCoreKind) ||
    record.defaultCoreKind === "cursor";
  const acpAgentsOk =
    record.acpAgentsEnabled === undefined ||
    (typeof record.acpAgentsEnabled === "object" &&
      record.acpAgentsEnabled !== null &&
      !Array.isArray(record.acpAgentsEnabled) &&
      ((record.acpAgentsEnabled as Record<string, unknown>).cursor === undefined ||
        typeof (record.acpAgentsEnabled as Record<string, unknown>).cursor === "boolean"));
  return (
    isSessionMode(record.sessionMode) &&
    coreKindOk &&
    acpAgentsOk &&
    (record.acpCursorModelId === undefined ||
      normalizeAcpCursorModelId(record.acpCursorModelId) !== undefined) &&
    (record.acpCursorApiKey === undefined ||
      normalizeAcpCursorApiKey(record.acpCursorApiKey) !== undefined) &&
    (record.defaultAcpAgentId === undefined || record.defaultAcpAgentId === "cursor") &&
    (record.showBilling === undefined || typeof record.showBilling === "boolean") &&
    (record.defaultBashReviewMode === undefined || isBashReviewMode(record.defaultBashReviewMode)) &&
    // Legacy fields accepted so older renderer payloads migrate via normalize.
    (record.cursorModelId === undefined || normalizeAcpCursorModelId(record.cursorModelId) !== undefined) &&
    (record.cursorCoreEnabled === undefined || typeof record.cursorCoreEnabled === "boolean") &&
    (record.contextWindowLimitTokens === undefined ||
      isGlobalContextWindowLimit(record.contextWindowLimitTokens)) &&
    (record.maxOutputLimitTokens === undefined || isGlobalMaxOutputTokens(record.maxOutputLimitTokens)) &&
    (record.followUpDeliveryMode === undefined || isFollowUpDeliveryMode(record.followUpDeliveryMode)) &&
    (record.defaultOrchestrationSelection === undefined ||
      isOrchestrationSelection(record.defaultOrchestrationSelection)) &&
    (record.defaultAuxiliaryModel === undefined || isAuxiliaryModelSelection(record.defaultAuxiliaryModel)) &&
    (record.defaultApprovalModel === undefined || isApprovalModelSelection(record.defaultApprovalModel)) &&
    (record.defaultVisionModel === undefined || isVisionModelSelection(record.defaultVisionModel)) &&
    (record.codexAuthModel === undefined || normalizeCodexAuthModel(record.codexAuthModel) !== undefined) &&
    (record.integrationsEnabled === undefined ||
      normalizeIntegrationsEnabled(record.integrationsEnabled) !== undefined)
  );
}
