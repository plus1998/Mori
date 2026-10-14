/**
 * Account-level settings + secrets sync against Supabase Center (Track E).
 *
 * - `user_settings.payload`: non-secret provider / ASR / image / workflow / orchestration JSON
 * - `user_secrets`: AES-GCM ciphertext of API keys under local vault_key
 */

import { decryptSecretWithVaultKey, encryptSecretWithVaultKey, generateVaultKey } from "@eco/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AgentTemplate,
  MainAgentConfigResource,
  MainAgentPromptResource,
  SubagentOrchestrationResource,
} from "../shared/agent-orchestration";
import { isWebSearchApprovalMode } from "../shared/integrated-web-search";
import type {
  CandidateModelInput,
  IntegratedWebSearchSettingsSnapshot,
  ProxyBridgeSettingsSnapshot,
  RouteProfileInput,
} from "../shared/ipc";
import type { SshBookmarkPublic } from "../shared/ssh-bookmarks";
import { defaultGitSettings, normalizeGitSettingsSnapshot } from "./git-settings-store";
import { normalizeIntegratedWebSearchProvider } from "./integrated-web-search-settings-store";
import { normalizePersonalizationSettingsSnapshot } from "./personalization-settings-store";
import { resolveUpstreamUserAgentOverrides } from "./proxy-bridge-settings-store";
import type { WorkflowSettingsSnapshot } from "./workflow-settings-store";

export const ECO_SYNCED_SETTINGS_VERSION = 1 as const;

export type EcoSecretKind = "provider" | "provider-proxy" | "asr" | "image" | "workflow" | "proxy" | "ssh";

export const ECO_WORKFLOW_CURSOR_API_KEY_SECRET = "acp_cursor_api_key";
export const ECO_PROXY_URL_SECRET = "upstream_proxy_url";
export const ECO_INTEGRATED_WEB_SEARCH_API_KEY_SECRET = "integrated_web_search_api_key";

export type EcoSyncedIntegratedWebSearchSettings = Pick<
  IntegratedWebSearchSettingsSnapshot,
  "enabled" | "provider" | "approvalMode"
>;

export type EcoSyncedProxyBridgeSettings = Pick<
  ProxyBridgeSettingsSnapshot,
  "upstreamUserAgent" | "upstreamUserAgents"
> & {
  integratedWebSearch?: EcoSyncedIntegratedWebSearchSettings;
};

export interface EcoSyncedProvider {
  id: string;
  name: string;
  baseUrl: string;
  requestPath: string;
  version: string;
  apiCompat: string;
  tokenCountMode?: string;
  authMethod?: string;
  credentialPoolId?: string;
  defaultModel: string;
  enabled: boolean;
}

export interface EcoSyncedAsrProfile {
  id: string;
  name: string;
  endpoint: string;
  apiMode: string;
  model: string;
  systemPrompt: string;
}

export interface EcoSyncedImageProfile {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  model: string;
  /** Absent on older cloud snapshots; treat as false. */
  supportsImageToImage?: boolean;
}

/** Workflow / default-agent settings without Cursor API key (secret synced separately). */
export type EcoSyncedWorkflowSettings = Omit<WorkflowSettingsSnapshot, "acpCursorApiKey">;

export interface EcoSyncedSettingsPayload {
  version: typeof ECO_SYNCED_SETTINGS_VERSION;
  providers: EcoSyncedProvider[];
  asr: {
    activeProfileId: string;
    profiles: EcoSyncedAsrProfile[];
  };
  imageGeneration: {
    enabled: boolean;
    activeProfileId: string;
    profiles: EcoSyncedImageProfile[];
  };
  /** Optional for payloads written before workflow sync existed. */
  workflow?: EcoSyncedWorkflowSettings;
  mainAgentConfigs?: MainAgentConfigResource[];
  mainAgentPrompts?: MainAgentPromptResource[];
  subagentOrchestrations?: SubagentOrchestrationResource[];
  agentTemplates?: AgentTemplate[];
  candidateModels?: CandidateModelInput[];
  routeProfiles?: RouteProfileInput[];
  /** Proxy UA + integrated web search metadata; proxy URL and search API keys stay in user_secrets. */
  proxyBridge?: EcoSyncedProxyBridgeSettings;
  /** Git commit message preferences and instructions. */
  git?: EcoSyncedGitSettings;
  /** Personalization (global user rules). */
  personalization?: EcoSyncedPersonalizationSettings;
  /** npm/bun/pnpm/yarn script trailing args keyed by workspace path, then script name. */
  packageScriptArgs?: EcoSyncedPackageScriptArgs;
  /** Leading shell commands (nvm switch, env exports) for the same workspace/script keys. */
  packageScriptPrefixes?: EcoSyncedPackageScriptArgs;
  /** SSH bookmark metadata (passwords/keys synced via user_secrets). */
  sshBookmarks?: EcoSyncedSshBookmark[];
}

export type EcoSyncedSshBookmark = SshBookmarkPublic;

/** Mirrors personalization-settings-store snapshot (global user rules). */
export type EcoSyncedPersonalizationSettings = {
  globalRules?: string;
};

/** Mirrors git-settings-store snapshot (commit message route prefs + instructions). */
export type EcoSyncedGitSettings = {
  commitMessageRoleByMainAgentConfigId: Record<string, string>;
  commitMessageCandidateModelIdByMainAgentConfigId: Record<string, string>;
  commitMessageInstructions?: string;
  autofetch?: boolean;
  autofetchPeriod?: number;
};

export type EcoSyncedPackageScriptArgs = Record<string, Record<string, string>>;

export interface EcoPlainSecret {
  kind: EcoSecretKind;
  key: string;
  value: string;
}

export interface UserSettingsRow {
  user_id: string;
  payload: unknown;
  updated_at: string;
  revision: number;
}

export interface UserSecretRow {
  id: string;
  user_id: string;
  secret_kind: string;
  secret_key: string;
  ciphertext: string;
  nonce: string;
  key_version: number;
  updated_at: string;
}

export interface SettingsSyncHooks {
  collectSettingsPayload: () => EcoSyncedSettingsPayload;
  applySettingsPayload: (payload: EcoSyncedSettingsPayload) => void | Promise<void>;
  collectPlainSecrets: () => EcoPlainSecret[];
  applyPlainSecrets: (secrets: EcoPlainSecret[]) => void | Promise<void>;
}

function isEcoSyncedIntegratedWebSearchSettings(
  value: unknown,
): value is EcoSyncedIntegratedWebSearchSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.enabled === "boolean" &&
    (record.provider === "brave" || record.provider === "tavily" || record.provider === "doubao") &&
    (record.approvalMode === undefined || isWebSearchApprovalMode(record.approvalMode))
  );
}

function isEcoSyncedProxyBridgeSettings(value: unknown): value is EcoSyncedProxyBridgeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.upstreamUserAgent !== undefined && typeof record.upstreamUserAgent !== "string") {
    return false;
  }
  if (record.upstreamUserAgents !== undefined) {
    if (!record.upstreamUserAgents || typeof record.upstreamUserAgents !== "object") {
      return false;
    }
    if (
      Object.values(record.upstreamUserAgents as Record<string, unknown>).some(
        (entry) => typeof entry !== "string",
      )
    ) {
      return false;
    }
  }
  if (
    record.integratedWebSearch !== undefined &&
    !isEcoSyncedIntegratedWebSearchSettings(record.integratedWebSearch)
  ) {
    return false;
  }
  return true;
}

export function normalizeEcoSyncedIntegratedWebSearchSettings(
  value: unknown,
): EcoSyncedIntegratedWebSearchSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { enabled: false, provider: "tavily", approvalMode: "always_allow" };
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    provider: normalizeIntegratedWebSearchProvider(record.provider),
    approvalMode: isWebSearchApprovalMode(record.approvalMode) ? record.approvalMode : "always_allow",
  };
}

export function normalizeEcoSyncedProxyBridgeSettings(value: unknown): EcoSyncedProxyBridgeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as EcoSyncedProxyBridgeSettings;
  const result: EcoSyncedProxyBridgeSettings = {};
  const ua = typeof record.upstreamUserAgent === "string" ? record.upstreamUserAgent.trim() : "";
  if (ua) {
    result.upstreamUserAgent = ua;
  }
  const upstreamUserAgents = resolveUpstreamUserAgentOverrides(record);
  if (upstreamUserAgents) {
    result.upstreamUserAgents = upstreamUserAgents;
  }
  if (record.integratedWebSearch !== undefined) {
    result.integratedWebSearch = normalizeEcoSyncedIntegratedWebSearchSettings(record.integratedWebSearch);
  }
  return result;
}

export function isEcoSyncedSettingsPayload(value: unknown): value is EcoSyncedSettingsPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as EcoSyncedSettingsPayload;
  return (
    record.version === ECO_SYNCED_SETTINGS_VERSION &&
    Array.isArray(record.providers) &&
    Boolean(record.asr) &&
    Array.isArray(record.asr.profiles) &&
    typeof record.asr.activeProfileId === "string" &&
    Boolean(record.imageGeneration) &&
    Array.isArray(record.imageGeneration.profiles) &&
    typeof record.imageGeneration.activeProfileId === "string" &&
    typeof record.imageGeneration.enabled === "boolean" &&
    (record.candidateModels === undefined || Array.isArray(record.candidateModels)) &&
    (record.routeProfiles === undefined || Array.isArray(record.routeProfiles)) &&
    (record.proxyBridge === undefined || isEcoSyncedProxyBridgeSettings(record.proxyBridge)) &&
    (record.git === undefined || (Boolean(record.git) && typeof record.git === "object")) &&
    (record.personalization === undefined ||
      (Boolean(record.personalization) &&
        typeof record.personalization === "object" &&
        !Array.isArray(record.personalization) &&
        (record.personalization.globalRules === undefined ||
          typeof record.personalization.globalRules === "string"))) &&
    (record.packageScriptArgs === undefined ||
      (Boolean(record.packageScriptArgs) &&
        typeof record.packageScriptArgs === "object" &&
        !Array.isArray(record.packageScriptArgs))) &&
    (record.packageScriptPrefixes === undefined ||
      (Boolean(record.packageScriptPrefixes) &&
        typeof record.packageScriptPrefixes === "object" &&
        !Array.isArray(record.packageScriptPrefixes))) &&
    (record.sshBookmarks === undefined || Array.isArray(record.sshBookmarks))
  );
}

export function emptyEcoSyncedSettingsPayload(): EcoSyncedSettingsPayload {
  return {
    version: ECO_SYNCED_SETTINGS_VERSION,
    providers: [],
    asr: { activeProfileId: "", profiles: [] },
    imageGeneration: { enabled: false, activeProfileId: "", profiles: [] },
    mainAgentConfigs: [],
    mainAgentPrompts: [],
    subagentOrchestrations: [],
    agentTemplates: [],
    candidateModels: [],
    routeProfiles: [],
    proxyBridge: {},
    sshBookmarks: [],
  };
}

/** Ensure a vault_key exists locally; generate once when first syncing secrets. */
export async function ensureLocalVaultKey(
  getVaultKey: () => string,
  saveVaultKey: (vaultKey: string) => void,
): Promise<{ vaultKey: string; created: boolean }> {
  const existing = getVaultKey().trim();
  if (existing) {
    return { vaultKey: existing, created: false };
  }
  const vaultKey = await generateVaultKey();
  saveVaultKey(vaultKey);
  return { vaultKey, created: true };
}

export async function pullUserSettings(
  client: SupabaseClient,
  userId: string,
): Promise<UserSettingsRow | null> {
  const { data, error } = await client
    .from("user_settings")
    .select("user_id, payload, updated_at, revision")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data as UserSettingsRow | null;
}

export const SETTINGS_SYNC_CONFLICT_CODE = "settings_sync_conflict";
export const SETTINGS_SYNC_VAULT_DECRYPT_CODE = "settings_sync_vault_decrypt";
export const SETTINGS_SYNC_VAULT_REQUIRED_CODE = "settings_sync_vault_required";

export class SettingsSyncConflictError extends Error {
  readonly code = SETTINGS_SYNC_CONFLICT_CODE;

  constructor(message = "Settings were updated on another device. Pull again, then retry sync.") {
    super(message);
    this.name = "SettingsSyncConflictError";
  }
}

/** Local vault_key cannot decrypt cloud user_secrets (wrong key or corrupt ciphertext). */
export class SettingsSyncVaultDecryptError extends Error {
  readonly code = SETTINGS_SYNC_VAULT_DECRYPT_CODE;

  constructor(
    message = `${SETTINGS_SYNC_VAULT_DECRYPT_CODE}: This device's vault key cannot decrypt cloud secrets. Request authorization from a device that already synced.`,
  ) {
    super(message);
    this.name = "SettingsSyncVaultDecryptError";
  }
}

/** Settings and secrets are one snapshot; a device without the vault key may apply neither. */
export class SettingsSyncVaultRequiredError extends Error {
  readonly code = SETTINGS_SYNC_VAULT_REQUIRED_CODE;

  constructor(
    message = `${SETTINGS_SYNC_VAULT_REQUIRED_CODE}: Unlock this device with your account login password before syncing settings.`,
  ) {
    super(message);
    this.name = "SettingsSyncVaultRequiredError";
  }
}

/**
 * Write user_settings with optimistic concurrency on `revision`.
 * - No prior row (`expectedRevision` undefined): insert only (unique violation → conflict).
 * - Prior row: update only when `revision` still equals `expectedRevision`.
 */
export async function pushUserSettings(
  client: SupabaseClient,
  userId: string,
  payload: EcoSyncedSettingsPayload,
  expectedRevision?: number,
): Promise<UserSettingsRow> {
  const now = new Date().toISOString();

  if (expectedRevision === undefined) {
    const { data, error } = await client
      .from("user_settings")
      .insert({
        user_id: userId,
        payload,
        updated_at: now,
        revision: 1,
      })
      .select("user_id, payload, updated_at, revision")
      .single();
    if (error || !data) {
      if (isUniqueViolation(error)) {
        throw new SettingsSyncConflictError();
      }
      throw new Error(error?.message ?? "Failed to insert user_settings.");
    }
    return data as UserSettingsRow;
  }

  const nextRevision = expectedRevision + 1;
  const { data, error } = await client
    .from("user_settings")
    .update({
      payload,
      updated_at: now,
      revision: nextRevision,
    })
    .eq("user_id", userId)
    .eq("revision", expectedRevision)
    .select("user_id, payload, updated_at, revision")
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    throw new SettingsSyncConflictError();
  }
  return data as UserSettingsRow;
}

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) {
    return false;
  }
  if (error.code === "23505") {
    return true;
  }
  const message = error.message ?? "";
  return /duplicate key|unique constraint/i.test(message);
}

export function ecoSyncedSettingsPayloadEqual(left: EcoSyncedSettingsPayload, right: unknown): boolean {
  if (!isEcoSyncedSettingsPayload(right)) {
    return false;
  }
  return (
    JSON.stringify(normalizeEcoSyncedSettingsPayload(left)) ===
    JSON.stringify(normalizeEcoSyncedSettingsPayload(right))
  );
}

/** Fill optional orchestration fields so older cloud payloads compare stably. */
export function normalizeEcoSyncedSettingsPayload(
  payload: EcoSyncedSettingsPayload,
): EcoSyncedSettingsPayload {
  return {
    ...payload,
    mainAgentConfigs: payload.mainAgentConfigs ?? [],
    mainAgentPrompts: payload.mainAgentPrompts ?? [],
    subagentOrchestrations: payload.subagentOrchestrations ?? [],
    agentTemplates: payload.agentTemplates ?? [],
    candidateModels: payload.candidateModels ?? [],
    routeProfiles: payload.routeProfiles ?? [],
    proxyBridge: normalizeEcoSyncedProxyBridgeSettings(payload.proxyBridge),
    ...(payload.git !== undefined ? { git: payload.git } : {}),
    ...(payload.personalization !== undefined ? { personalization: payload.personalization } : {}),
    ...(payload.packageScriptArgs !== undefined ? { packageScriptArgs: payload.packageScriptArgs } : {}),
    ...(payload.packageScriptPrefixes !== undefined
      ? { packageScriptPrefixes: payload.packageScriptPrefixes }
      : {}),
    sshBookmarks: payload.sshBookmarks ?? [],
  };
}

interface EcoEncryptedSecretSnapshot {
  secret_kind: EcoSecretKind;
  secret_key: string;
  ciphertext: string;
  nonce: string;
  key_version: number;
}

async function encryptSecretSnapshot(
  vaultKey: string,
  secrets: readonly EcoPlainSecret[],
): Promise<EcoEncryptedSecretSnapshot[]> {
  return Promise.all(
    secrets.map(async (secret) => {
      const sealed = await encryptSecretWithVaultKey(vaultKey, secret.value);
      return {
        secret_kind: secret.kind,
        secret_key: secret.key,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        key_version: 1,
      };
    }),
  );
}

/** Atomically replace the account settings and complete encrypted-secret snapshot. */
export async function pushAccountConfigSnapshot(
  client: SupabaseClient,
  input: {
    payload: EcoSyncedSettingsPayload;
    expectedRevision?: number;
    secrets: readonly EcoEncryptedSecretSnapshot[];
  },
): Promise<UserSettingsRow> {
  const { data, error } = await client.rpc("eco_replace_account_config", {
    p_payload: input.payload,
    p_expected_revision: input.expectedRevision ?? null,
    p_secrets: input.secrets,
  });
  if (error) {
    if (
      error.code === "PT409" ||
      error.code === "40001" ||
      error.message.includes(SETTINGS_SYNC_CONFLICT_CODE)
    ) {
      throw new SettingsSyncConflictError();
    }
    throw new Error(error.message);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    throw new Error("eco_replace_account_config returned no settings row.");
  }
  return row as UserSettingsRow;
}

export async function pullUserSecrets(client: SupabaseClient, userId: string): Promise<UserSecretRow[]> {
  const { data, error } = await client
    .from("user_secrets")
    .select("id, user_id, secret_kind, secret_key, ciphertext, nonce, key_version, updated_at")
    .eq("user_id", userId);
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []) as UserSecretRow[];
}

export async function upsertEncryptedSecret(
  client: SupabaseClient,
  input: {
    userId: string;
    kind: EcoSecretKind;
    key: string;
    vaultKey: string;
    plaintext: string;
  },
): Promise<UserSecretRow> {
  const sealed = await encryptSecretWithVaultKey(input.vaultKey, input.plaintext);
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("user_secrets")
    .upsert(
      {
        user_id: input.userId,
        secret_kind: input.kind,
        secret_key: input.key,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        key_version: 1,
        updated_at: now,
      },
      { onConflict: "user_id,secret_kind,secret_key" },
    )
    .select("id, user_id, secret_kind, secret_key, ciphertext, nonce, key_version, updated_at")
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to upsert user_secrets.");
  }
  return data as UserSecretRow;
}

export async function decryptUserSecrets(
  vaultKey: string,
  rows: readonly UserSecretRow[],
): Promise<{ secrets: EcoPlainSecret[]; skipped: number }> {
  const secrets: EcoPlainSecret[] = [];
  let attempted = 0;
  for (const row of rows) {
    const kind = parseSecretKind(row.secret_kind);
    if (!kind) {
      throw new Error(`Unsupported cloud secret kind: ${row.secret_kind}`);
    }
    attempted += 1;
    try {
      const value = await decryptSecretWithVaultKey(vaultKey, row.ciphertext, row.nonce);
      secrets.push({ kind, key: row.secret_key, value });
    } catch {
      throw new SettingsSyncVaultDecryptError(
        `${SETTINGS_SYNC_VAULT_DECRYPT_CODE}: Failed to decrypt ${row.secret_kind}:${row.secret_key}. The settings snapshot was not applied.`,
      );
    }
  }
  if (attempted > 0 && secrets.length === 0) {
    throw new SettingsSyncVaultDecryptError();
  }
  return { secrets, skipped: 0 };
}

export async function markDeviceVaultSynced(
  client: SupabaseClient,
  deviceId: string,
  syncedAt = new Date().toISOString(),
): Promise<void> {
  const { error } = await client.rpc("eco_mark_device_vault_synced", {
    p_device_id: deviceId,
    p_synced_at: syncedAt,
  });
  if (error) {
    throw new Error(error.message);
  }
}

export async function listVaultSyncedDeviceIds(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client
    .from("devices_public")
    .select("id, vault_synced_at, disabled_at")
    .not("vault_synced_at", "is", null)
    .is("disabled_at", null);
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []).map((row) => (typeof row.id === "string" ? row.id : "")).filter(Boolean);
}

export type EcoSettingsSyncMode = "pull" | "push" | "reconcile";

export interface SyncAccountConfigResult {
  mode: EcoSettingsSyncMode;
  settingsPushed: boolean;
  settingsPulled: boolean;
  secretsPushed: number;
  secretsPulled: number;
  syncedAt: string;
  vaultKeyCreated: boolean;
  /**
   * Local and cloud both have settings and they differ.
   * reconcile mode refuses to overwrite either side — user must choose pull or push.
   */
  needsUserChoice?: boolean;
  /** Settings/secrets may already be on the cloud; devices.vault_synced_at update failed (often missing RPC). */
  vaultMarkFailed?: string;
  /** Cloud secret rows that could not be decrypted with the local vault_key (stale / other key). */
  secretsSkipped?: number;
  /** Pull requested but cloud has no user_settings row yet (nothing to apply). */
  cloudEmpty?: boolean;
}

export function isSparseEcoSyncedSettings(payload: EcoSyncedSettingsPayload): boolean {
  return (
    payload.providers.length === 0 &&
    payload.asr.profiles.length === 0 &&
    payload.imageGeneration.profiles.length === 0 &&
    (payload.mainAgentConfigs?.length ?? 0) === 0 &&
    (payload.mainAgentPrompts?.length ?? 0) === 0 &&
    (payload.subagentOrchestrations?.length ?? 0) === 0 &&
    (payload.agentTemplates?.length ?? 0) === 0 &&
    (payload.candidateModels?.length ?? 0) === 0 &&
    (payload.routeProfiles?.length ?? 0) === 0 &&
    !payload.proxyBridge?.upstreamUserAgent &&
    !payload.proxyBridge?.upstreamUserAgents &&
    !payload.proxyBridge?.integratedWebSearch?.enabled
  );
}

/**
 * Account settings/secrets sync.
 *
 * - pull: cloud → local only (never push). Overwrites local settings/secrets from cloud.
 * - push: local → cloud only (never pull first). Uses revision CAS for settings.
 * - reconcile (background): never silently clobber. Pull only if local is sparse;
 *   push only if cloud is empty; if both differ → needsUserChoice.
 */
export async function syncAccountConfig(input: {
  client: SupabaseClient;
  userId: string;
  deviceId: string;
  getVaultKey: () => string;
  saveVaultKey: (vaultKey: string) => void;
  hooks: SettingsSyncHooks;
  /** When true, create vault_key if missing so secrets can be pushed (first device). */
  allowCreateVaultKey: boolean;
  mode: EcoSettingsSyncMode;
}): Promise<SyncAccountConfigResult> {
  const syncedAt = new Date().toISOString();
  let settingsPulled = false;
  let settingsPushed = false;
  let secretsPulled = 0;
  let secretsPushed = 0;
  let secretsSkipped = 0;
  let vaultKeyCreated = false;

  const localBefore = input.hooks.collectSettingsPayload();
  const remote = await pullUserSettings(input.client, input.userId);
  const remotePayload = remote && isEcoSyncedSettingsPayload(remote.payload) ? remote.payload : null;

  if (remote && !remotePayload) {
    throw new Error("Cloud user_settings payload is invalid or uses an unsupported version.");
  }

  if (input.mode === "reconcile") {
    if (remotePayload && !isSparseEcoSyncedSettings(localBefore)) {
      if (!ecoSyncedSettingsPayloadEqual(localBefore, remotePayload)) {
        return {
          mode: input.mode,
          settingsPushed: false,
          settingsPulled: false,
          secretsPushed: 0,
          secretsPulled: 0,
          syncedAt,
          vaultKeyCreated: false,
          needsUserChoice: true,
        };
      }
      // Already aligned. Reconcile leaves replacement-style secret snapshots untouched below.
    }
  }

  let vaultKey = input.getVaultKey().trim();
  const settingsShouldBePulled = Boolean(
    remotePayload &&
      (input.mode === "pull" || (input.mode === "reconcile" && isSparseEcoSyncedSettings(localBefore))),
  );
  // A secret snapshot is replacement data. During reconcile, apply it only as
  // part of the same sparse-local bootstrap so an older cloud snapshot cannot
  // silently delete a local-only key when the non-secret settings already match.
  const secretsShouldBePulled = Boolean(remotePayload && (input.mode === "pull" || settingsShouldBePulled));
  const snapshotShouldBePushed = input.mode === "push" || (input.mode === "reconcile" && !remotePayload);

  if (!vaultKey && input.allowCreateVaultKey && snapshotShouldBePushed) {
    const ensured = await ensureLocalVaultKey(input.getVaultKey, input.saveVaultKey);
    vaultKey = ensured.vaultKey;
    vaultKeyCreated = ensured.created;
  }
  if (!vaultKey && (settingsShouldBePulled || secretsShouldBePulled || snapshotShouldBePushed)) {
    throw new SettingsSyncVaultRequiredError();
  }

  if (vaultKey && secretsShouldBePulled) {
    const secretRows = await pullUserSecrets(input.client, input.userId);
    // Decrypt first so a bad vault key cannot partially apply settings without secrets.
    const plain = await decryptUserSecrets(vaultKey, secretRows);
    if (settingsShouldBePulled && remotePayload) {
      await input.hooks.applySettingsPayload(remotePayload);
      settingsPulled = true;
    }
    await input.hooks.applyPlainSecrets(plain.secrets);
    secretsPulled = plain.secrets.length;
    secretsSkipped += plain.skipped;
  } else if (vaultKey && settingsShouldBePulled && remotePayload) {
    // Settings-only pull path (no secret rows / secrets not requested).
    await input.hooks.applySettingsPayload(remotePayload);
    settingsPulled = true;
  }

  if (snapshotShouldBePushed && vaultKey) {
    const localPayload = input.hooks.collectSettingsPayload();
    const secrets = input.hooks.collectPlainSecrets().filter((secret) => secret.value.trim());
    const encryptedSecrets = await encryptSecretSnapshot(vaultKey, secrets);
    await pushAccountConfigSnapshot(input.client, {
      payload: localPayload,
      ...(remote ? { expectedRevision: remote.revision } : {}),
      secrets: encryptedSecrets,
    });
    settingsPushed = true;
    secretsPushed = secrets.length;
  }

  if (
    vaultKey &&
    (settingsPushed || secretsPushed > 0 || vaultKeyCreated || secretsPulled > 0 || settingsPulled)
  ) {
    await markDeviceVaultSynced(input.client, input.deviceId, syncedAt);
  }

  return {
    mode: input.mode,
    settingsPushed,
    settingsPulled,
    secretsPushed,
    secretsPulled,
    syncedAt,
    vaultKeyCreated,
    ...(secretsSkipped > 0 ? { secretsSkipped } : {}),
    ...(input.mode === "pull" && !remotePayload ? { cloudEmpty: true } : {}),
  };
}

/** Encrypt/decrypt roundtrip helper for unit tests. */
export async function encryptDecryptSecretRoundtrip(vaultKey: string, plaintext: string): Promise<string> {
  const sealed = await encryptSecretWithVaultKey(vaultKey, plaintext);
  return decryptSecretWithVaultKey(vaultKey, sealed.ciphertext, sealed.nonce);
}

function parseSecretKind(value: string): EcoSecretKind | null {
  if (
    value === "provider" ||
    value === "provider-proxy" ||
    value === "asr" ||
    value === "image" ||
    value === "workflow" ||
    value === "proxy" ||
    value === "ssh"
  ) {
    return value;
  }
  return null;
}

export type EcoSettingsSyncDomain =
  | "providers"
  | "proxyBridge"
  | "asr"
  | "imageGeneration"
  | "defaultAgent"
  | "orchestration"
  | "agentLibrary"
  | "git"
  | "packageScriptArgs"
  | "sshBookmarks"
  | "personalization";

export const ECO_SETTINGS_SYNC_DOMAINS: readonly EcoSettingsSyncDomain[] = [
  "providers",
  "proxyBridge",
  "asr",
  "imageGeneration",
  "orchestration",
  "agentLibrary",
  "git",
  "packageScriptArgs",
  "sshBookmarks",
  "personalization",
];

/** Cursor API key only; workflow JSON is local-only. */
export function isSecretsOnlySyncDomain(domain: EcoSettingsSyncDomain): boolean {
  return domain === "defaultAgent";
}

/** User-created agent templates only; built-in / derived catalog entries stay local. */
export function syncableAgentTemplates(templates: readonly AgentTemplate[] | undefined): AgentTemplate[] {
  return (templates ?? []).filter(
    (template) =>
      !template.builtIn &&
      template.source !== "built_in" &&
      template.source !== "derived" &&
      (template.source === "user" || template.source === undefined),
  );
}

export type EcoDomainSyncState = "synced" | "dirty" | "never_synced" | "cloud_empty" | "needs_vault";

export interface EcoDomainSyncStatusEntry {
  domain: EcoSettingsSyncDomain;
  state: EcoDomainSyncState;
  summary?: string;
  lastSyncedAt?: string;
}

export function secretKindsForDomain(domain: EcoSettingsSyncDomain): readonly EcoSecretKind[] {
  switch (domain) {
    case "providers":
      return ["provider", "provider-proxy"];
    case "asr":
      return ["asr"];
    case "imageGeneration":
      return ["image"];
    case "defaultAgent":
      return ["workflow"];
    case "proxyBridge":
      return ["proxy"];
    case "orchestration":
      return [];
    case "agentLibrary":
      return [];
    case "git":
      return [];
    case "packageScriptArgs":
      return [];
    case "sshBookmarks":
      return ["ssh"];
    case "personalization":
      return [];
  }
}

export function filterSecretsForDomain(
  secrets: readonly EcoPlainSecret[],
  domain: EcoSettingsSyncDomain,
): EcoPlainSecret[] {
  const kinds = new Set(secretKindsForDomain(domain));
  return secrets.filter((secret) => kinds.has(secret.kind));
}

export function mergeDomainSecrets(
  cloudSecrets: readonly EcoPlainSecret[],
  localSecrets: readonly EcoPlainSecret[],
  domain: EcoSettingsSyncDomain,
): EcoPlainSecret[] {
  const kinds = new Set(secretKindsForDomain(domain));
  const retained = cloudSecrets.filter((secret) => !kinds.has(secret.kind));
  const domainLocal = filterSecretsForDomain(localSecrets, domain);
  return [...retained, ...domainLocal];
}

export function extractDomainPayloadSlice(
  payload: EcoSyncedSettingsPayload,
  domain: EcoSettingsSyncDomain,
): unknown {
  const normalized = normalizeEcoSyncedSettingsPayload(payload);
  switch (domain) {
    case "providers":
      return {
        providers: normalized.providers,
        candidateModels: normalized.candidateModels,
        routeProfiles: normalized.routeProfiles,
      };
    case "proxyBridge":
      return normalized.proxyBridge ?? {};
    case "asr":
      return normalized.asr;
    case "imageGeneration":
      return normalized.imageGeneration;
    case "defaultAgent":
      return normalized.workflow ?? {};
    case "orchestration":
      return {
        mainAgentConfigs: normalized.mainAgentConfigs,
        mainAgentPrompts: normalized.mainAgentPrompts,
        subagentOrchestrations: normalized.subagentOrchestrations,
      };
    case "agentLibrary":
      return {
        agentTemplates: syncableAgentTemplates(normalized.agentTemplates),
      };
    case "git":
      return normalized.git ?? {};
    case "personalization":
      return normalized.personalization ?? {};
    case "packageScriptArgs":
      return {
        args: normalized.packageScriptArgs ?? {},
        prefixes: normalized.packageScriptPrefixes ?? {},
      };
    case "sshBookmarks":
      return normalized.sshBookmarks ?? [];
  }
}

export function mergeDomainIntoPayload(
  base: EcoSyncedSettingsPayload,
  domainSource: EcoSyncedSettingsPayload,
  domain: EcoSettingsSyncDomain,
): EcoSyncedSettingsPayload {
  const normalizedBase = normalizeEcoSyncedSettingsPayload(base);
  const normalizedSource = normalizeEcoSyncedSettingsPayload(domainSource);
  switch (domain) {
    case "providers":
      return {
        ...normalizedBase,
        providers: normalizedSource.providers,
        candidateModels: normalizedSource.candidateModels ?? [],
        routeProfiles: normalizedSource.routeProfiles ?? [],
      };
    case "proxyBridge":
      return {
        ...normalizedBase,
        proxyBridge: normalizedSource.proxyBridge ?? {},
      };
    case "asr":
      return {
        ...normalizedBase,
        asr: normalizedSource.asr,
      };
    case "imageGeneration":
      return {
        ...normalizedBase,
        imageGeneration: normalizedSource.imageGeneration,
      };
    case "defaultAgent":
      return {
        ...normalizedBase,
        ...(normalizedSource.workflow !== undefined ? { workflow: normalizedSource.workflow } : {}),
      };
    case "orchestration":
      return {
        ...normalizedBase,
        mainAgentConfigs: normalizedSource.mainAgentConfigs ?? [],
        mainAgentPrompts: normalizedSource.mainAgentPrompts ?? [],
        subagentOrchestrations: normalizedSource.subagentOrchestrations ?? [],
      };
    case "agentLibrary":
      return {
        ...normalizedBase,
        agentTemplates: syncableAgentTemplates(normalizedSource.agentTemplates),
      };
    case "git":
      return {
        ...normalizedBase,
        ...(normalizedSource.git !== undefined ? { git: normalizedSource.git } : {}),
      };
    case "personalization":
      return {
        ...normalizedBase,
        ...(normalizedSource.personalization !== undefined
          ? { personalization: normalizedSource.personalization }
          : {}),
      };
    case "packageScriptArgs":
      return {
        ...normalizedBase,
        ...(normalizedSource.packageScriptArgs !== undefined
          ? { packageScriptArgs: normalizedSource.packageScriptArgs }
          : {}),
        ...(normalizedSource.packageScriptPrefixes !== undefined
          ? { packageScriptPrefixes: normalizedSource.packageScriptPrefixes }
          : {}),
      };
    case "sshBookmarks":
      return {
        ...normalizedBase,
        sshBookmarks: normalizedSource.sshBookmarks ?? [],
      };
  }
}

export function domainPayloadEqual(
  local: EcoSyncedSettingsPayload,
  remote: EcoSyncedSettingsPayload,
  domain: EcoSettingsSyncDomain,
): boolean {
  return (
    JSON.stringify(canonicalizeDomainPayloadSlice(domain, extractDomainPayloadSlice(local, domain))) ===
    JSON.stringify(canonicalizeDomainPayloadSlice(domain, extractDomainPayloadSlice(remote, domain)))
  );
}

function isUserOwnedSyncSource(source: string | undefined): boolean {
  return source === "user" || source === undefined;
}

function sortById<T extends { id?: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => (left.id ?? "").localeCompare(right.id ?? ""));
}

function stripUpdatedAt<T extends { updatedAt?: string }>(row: T): Omit<T, "updatedAt"> {
  const { updatedAt: _omit, ...rest } = row;
  return rest;
}

function sortRecordKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, record[key]!]),
  );
}

function isGitSyncSliceEmpty(git: unknown): boolean {
  return JSON.stringify(normalizeGitSettingsSnapshot(git)) === JSON.stringify(defaultGitSettings());
}

function isDefaultAgentSliceEmpty(workflow: unknown): boolean {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    return true;
  }
  return Object.keys(workflow as Record<string, unknown>).length === 0;
}

export function canonicalizeDomainPayloadSlice(domain: EcoSettingsSyncDomain, slice: unknown): unknown {
  if (slice == null) {
    return slice;
  }

  switch (domain) {
    case "providers": {
      const record = slice as {
        providers?: EcoSyncedSettingsPayload["providers"];
        candidateModels?: CandidateModelInput[];
        routeProfiles?: RouteProfileInput[];
      };
      return {
        providers: sortById(record.providers ?? []),
        candidateModels: sortById(record.candidateModels ?? []),
        routeProfiles: sortById(record.routeProfiles ?? []),
      };
    }
    case "proxyBridge": {
      return normalizeEcoSyncedProxyBridgeSettings(slice);
    }
    case "asr": {
      const record = slice as EcoSyncedSettingsPayload["asr"];
      return {
        activeProfileId: record.activeProfileId,
        profiles: sortById(record.profiles ?? []),
      };
    }
    case "imageGeneration": {
      const record = slice as EcoSyncedSettingsPayload["imageGeneration"];
      return {
        enabled: record.enabled,
        activeProfileId: record.activeProfileId,
        profiles: sortById(record.profiles ?? []),
      };
    }
    case "defaultAgent": {
      const record = { ...(slice as Record<string, unknown>) };
      delete record.acpCursorApiKey;
      return record;
    }
    case "orchestration": {
      const record = slice as {
        mainAgentConfigs?: MainAgentConfigResource[];
        mainAgentPrompts?: MainAgentPromptResource[];
        subagentOrchestrations?: SubagentOrchestrationResource[];
      };
      return {
        mainAgentConfigs: sortById(
          (record.mainAgentConfigs ?? [])
            .filter((row) => isUserOwnedSyncSource(row.source))
            .map((row) => stripUpdatedAt(row)),
        ),
        mainAgentPrompts: sortById(
          (record.mainAgentPrompts ?? [])
            .filter((row) => isUserOwnedSyncSource(row.source))
            .map((row) => stripUpdatedAt(row)),
        ),
        subagentOrchestrations: sortById(
          (record.subagentOrchestrations ?? [])
            .filter((row) => isUserOwnedSyncSource(row.source))
            .map((row) => stripUpdatedAt(row)),
        ),
      };
    }
    case "agentLibrary": {
      const record = slice as { agentTemplates?: AgentTemplate[] };
      return {
        agentTemplates: sortById(
          syncableAgentTemplates(record.agentTemplates).map((row) => stripUpdatedAt(row)),
        ),
      };
    }
    case "git":
      return normalizeGitSettingsSnapshot(slice);
    case "personalization":
      return normalizePersonalizationSettingsSnapshot(slice);
    case "packageScriptArgs": {
      const record = slice as {
        args?: Record<string, Record<string, string>>;
        prefixes?: Record<string, Record<string, string>>;
      };
      const sortWorkspaces = (record: Record<string, Record<string, string>> | undefined) => {
        const sorted: Record<string, Record<string, string>> = {};
        for (const workspacePath of Object.keys(record ?? {}).sort((left, right) =>
          left.localeCompare(right),
        )) {
          sorted[workspacePath] = sortRecordKeys(record?.[workspacePath] ?? {});
        }
        return sorted;
      };
      return {
        args: sortWorkspaces(record.args),
        prefixes: sortWorkspaces(record.prefixes),
      };
    }
    case "sshBookmarks": {
      const record = slice as { bookmarks?: EcoSyncedSshBookmark[] } | EcoSyncedSshBookmark[];
      const bookmarks = Array.isArray(record)
        ? record
        : Array.isArray(record.bookmarks)
          ? record.bookmarks
          : [];
      return sortById(bookmarks);
    }
  }
}

function isDomainSliceEmpty(domain: EcoSettingsSyncDomain, slice: unknown): boolean {
  switch (domain) {
    case "providers": {
      const record = slice as {
        providers?: unknown[];
        candidateModels?: unknown[];
        routeProfiles?: unknown[];
      };
      return (
        (record.providers?.length ?? 0) === 0 &&
        (record.candidateModels?.length ?? 0) === 0 &&
        (record.routeProfiles?.length ?? 0) === 0
      );
    }
    case "proxyBridge": {
      const record = normalizeEcoSyncedProxyBridgeSettings(slice);
      return (
        !record.upstreamUserAgent?.trim() &&
        !record.upstreamUserAgents &&
        record.integratedWebSearch?.enabled !== true
      );
    }
    case "asr":
      return ((slice as EcoSyncedSettingsPayload["asr"]).profiles?.length ?? 0) === 0;
    case "imageGeneration":
      return ((slice as EcoSyncedSettingsPayload["imageGeneration"]).profiles?.length ?? 0) === 0;
    case "defaultAgent":
      return isDefaultAgentSliceEmpty(slice);
    case "orchestration": {
      const canonical = canonicalizeDomainPayloadSlice(domain, slice) as {
        mainAgentConfigs: unknown[];
        mainAgentPrompts: unknown[];
        subagentOrchestrations: unknown[];
      };
      return (
        canonical.mainAgentConfigs.length === 0 &&
        canonical.mainAgentPrompts.length === 0 &&
        canonical.subagentOrchestrations.length === 0
      );
    }
    case "agentLibrary":
      return (
        (canonicalizeDomainPayloadSlice(domain, slice) as { agentTemplates: unknown[] }).agentTemplates
          .length === 0
      );
    case "git":
      return isGitSyncSliceEmpty(slice);
    case "personalization":
      return !(normalizePersonalizationSettingsSnapshot(slice).globalRules ?? "").trim();
    case "packageScriptArgs": {
      const record = slice as { args?: Record<string, unknown>; prefixes?: Record<string, unknown> };
      return Object.keys(record.args ?? {}).length === 0 && Object.keys(record.prefixes ?? {}).length === 0;
    }
    case "sshBookmarks":
      return ((slice as EcoSyncedSshBookmark[]).length ?? 0) === 0;
  }
}

function isDomainEmptyInLocal(local: EcoSyncedSettingsPayload, domain: EcoSettingsSyncDomain): boolean {
  return isDomainSliceEmpty(domain, extractDomainPayloadSlice(local, domain));
}

export function domainSecretsEqual(
  localSecrets: readonly EcoPlainSecret[],
  remoteSecrets: readonly EcoPlainSecret[],
  domain: EcoSettingsSyncDomain,
): boolean {
  const left = filterSecretsForDomain(localSecrets, domain)
    .map((secret) => ({ kind: secret.kind, key: secret.key, value: secret.value }))
    .sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`));
  const right = filterSecretsForDomain(remoteSecrets, domain)
    .map((secret) => ({ kind: secret.kind, key: secret.key, value: secret.value }))
    .sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`));
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isDomainEmptyInCloud(
  remote: EcoSyncedSettingsPayload | null,
  domain: EcoSettingsSyncDomain,
): boolean {
  if (!remote) {
    return true;
  }
  return isDomainSliceEmpty(domain, extractDomainPayloadSlice(remote, domain));
}

export function buildDomainSyncSummary(
  payload: EcoSyncedSettingsPayload,
  domain: EcoSettingsSyncDomain,
): string {
  const normalized = normalizeEcoSyncedSettingsPayload(payload);
  switch (domain) {
    case "providers": {
      const count = normalized.providers.length;
      if (count === 0) {
        return "";
      }
      const names = normalized.providers.slice(0, 3).map((provider) => provider.name);
      const suffix = count > 3 ? ` +${count - 3}` : "";
      return `${count} · ${names.join(", ")}${suffix}`;
    }
    case "proxyBridge": {
      const record = normalizeEcoSyncedProxyBridgeSettings(normalized.proxyBridge);
      const parts: string[] = [];
      if (record.upstreamUserAgent?.trim() || record.upstreamUserAgents) {
        parts.push("proxy");
      }
      if (record.integratedWebSearch?.enabled) {
        parts.push("search");
      }
      return parts.join(" · ");
    }
    case "asr":
      return normalized.asr.profiles.length > 0 ? String(normalized.asr.profiles.length) : "";
    case "imageGeneration":
      return normalized.imageGeneration.profiles.length > 0
        ? String(normalized.imageGeneration.profiles.length)
        : "";
    case "defaultAgent":
      return normalized.workflow?.defaultCoreKind ? "1" : "";
    case "orchestration": {
      const count =
        (normalized.mainAgentConfigs?.length ?? 0) +
        (normalized.mainAgentPrompts?.length ?? 0) +
        (normalized.subagentOrchestrations?.length ?? 0);
      return count > 0 ? String(count) : "";
    }
    case "agentLibrary": {
      const count = syncableAgentTemplates(normalized.agentTemplates).length;
      return count > 0 ? String(count) : "";
    }
    case "git": {
      const git = normalized.git;
      if (!git) {
        return "";
      }
      const parts: string[] = [];
      if (git.commitMessageInstructions?.trim()) {
        parts.push("instructions");
      }
      const routeCount =
        Object.keys(git.commitMessageRoleByMainAgentConfigId ?? {}).length +
        Object.keys(git.commitMessageCandidateModelIdByMainAgentConfigId ?? {}).length;
      if (routeCount > 0) {
        parts.push(String(routeCount));
      }
      return parts.join(" · ");
    }
    case "packageScriptArgs": {
      const argsByWorkspace = normalized.packageScriptArgs ?? {};
      const prefixesByWorkspace = normalized.packageScriptPrefixes ?? {};
      const workspaceCount = new Set([...Object.keys(argsByWorkspace), ...Object.keys(prefixesByWorkspace)])
        .size;
      if (workspaceCount === 0) {
        return "";
      }
      const scriptCount =
        Object.values(argsByWorkspace).reduce((total, scripts) => total + Object.keys(scripts).length, 0) +
        Object.values(prefixesByWorkspace).reduce((total, scripts) => total + Object.keys(scripts).length, 0);
      return `${workspaceCount} · ${scriptCount}`;
    }
    case "sshBookmarks": {
      const count = normalized.sshBookmarks?.length ?? 0;
      return count > 0 ? String(count) : "";
    }
    case "personalization":
      return normalized.personalization?.globalRules?.trim() ? "rules" : "";
  }
}

export interface DomainSettingsSyncHooks extends SettingsSyncHooks {
  applyDomainPlainSecrets: (secrets: EcoPlainSecret[], domain: EcoSettingsSyncDomain) => void | Promise<void>;
}

export interface SyncAccountConfigDomainResult extends SyncAccountConfigResult {
  domain: EcoSettingsSyncDomain;
}

/**
 * Pull or push a single settings domain. Cloud storage remains one payload; push merges the domain slice.
 */
export async function syncAccountConfigDomain(input: {
  client: SupabaseClient;
  userId: string;
  deviceId: string;
  domain: EcoSettingsSyncDomain;
  getVaultKey: () => string;
  saveVaultKey: (vaultKey: string) => void;
  hooks: DomainSettingsSyncHooks;
  allowCreateVaultKey: boolean;
  mode: "pull" | "push";
}): Promise<SyncAccountConfigDomainResult> {
  const syncedAt = new Date().toISOString();
  let settingsPulled = false;
  let settingsPushed = false;
  let secretsPulled = 0;
  let secretsPushed = 0;
  let vaultKeyCreated = false;

  const localFull = input.hooks.collectSettingsPayload();
  const remote = await pullUserSettings(input.client, input.userId);
  const remotePayload = remote && isEcoSyncedSettingsPayload(remote.payload) ? remote.payload : null;

  if (remote && !remotePayload) {
    throw new Error("Cloud user_settings payload is invalid or uses an unsupported version.");
  }

  const domainHasSecrets = secretKindsForDomain(input.domain).length > 0;
  let vaultKey = input.getVaultKey().trim();

  if (input.mode === "pull") {
    if (!remotePayload) {
      return {
        domain: input.domain,
        mode: input.mode,
        settingsPushed: false,
        settingsPulled: false,
        secretsPushed: 0,
        secretsPulled: 0,
        syncedAt,
        vaultKeyCreated: false,
        cloudEmpty: true,
      };
    }
    if (domainHasSecrets && !vaultKey) {
      throw new SettingsSyncVaultRequiredError();
    }
    if (!isSecretsOnlySyncDomain(input.domain)) {
      const mergedForApply = mergeDomainIntoPayload(localFull, remotePayload, input.domain);
      await input.hooks.applySettingsPayload(mergedForApply);
      settingsPulled = true;
    }

    if (domainHasSecrets && vaultKey) {
      const secretRows = await pullUserSecrets(input.client, input.userId);
      const plain = await decryptUserSecrets(vaultKey, secretRows);
      const domainSecrets = filterSecretsForDomain(plain.secrets, input.domain);
      await input.hooks.applyDomainPlainSecrets(domainSecrets, input.domain);
      secretsPulled = domainSecrets.length;
    }
  } else {
    if (!vaultKey && input.allowCreateVaultKey) {
      const ensured = await ensureLocalVaultKey(input.getVaultKey, input.saveVaultKey);
      vaultKey = ensured.vaultKey;
      vaultKeyCreated = ensured.created;
    }
    if (domainHasSecrets && !vaultKey) {
      throw new SettingsSyncVaultRequiredError();
    }

    const cloudBase = remotePayload ?? emptyEcoSyncedSettingsPayload();
    const mergedPayload = isSecretsOnlySyncDomain(input.domain)
      ? cloudBase
      : mergeDomainIntoPayload(cloudBase, localFull, input.domain);
    let encryptedSecrets: EcoEncryptedSecretSnapshot[] = [];

    if (vaultKey) {
      const localSecrets = input.hooks.collectPlainSecrets().filter((secret) => secret.value.trim());
      let mergedSecrets = filterSecretsForDomain(localSecrets, input.domain);
      if (remotePayload) {
        const secretRows = await pullUserSecrets(input.client, input.userId);
        const plain =
          secretRows.length > 0
            ? await decryptUserSecrets(vaultKey, secretRows)
            : { secrets: [], skipped: 0 };
        mergedSecrets = mergeDomainSecrets(plain.secrets, localSecrets, input.domain);
      }
      encryptedSecrets = await encryptSecretSnapshot(vaultKey, mergedSecrets);
      secretsPushed = filterSecretsForDomain(mergedSecrets, input.domain).length;
    }

    await pushAccountConfigSnapshot(input.client, {
      payload: mergedPayload,
      ...(remote ? { expectedRevision: remote.revision } : {}),
      secrets: encryptedSecrets,
    });
    settingsPushed = !isSecretsOnlySyncDomain(input.domain);
  }

  if (
    vaultKey &&
    (settingsPushed || secretsPushed > 0 || vaultKeyCreated || secretsPulled > 0 || settingsPulled)
  ) {
    await markDeviceVaultSynced(input.client, input.deviceId, syncedAt);
  }

  return {
    domain: input.domain,
    mode: input.mode,
    settingsPushed,
    settingsPulled,
    secretsPushed,
    secretsPulled,
    syncedAt,
    vaultKeyCreated,
  };
}

export function computeDomainSyncStatuses(input: {
  localPayload: EcoSyncedSettingsPayload;
  remotePayload: EcoSyncedSettingsPayload | null;
  localSecrets: readonly EcoPlainSecret[];
  remoteSecrets: readonly EcoPlainSecret[];
  hasVaultKey: boolean;
  domainSyncTimes: Partial<Record<EcoSettingsSyncDomain, string>>;
}): EcoDomainSyncStatusEntry[] {
  return ECO_SETTINGS_SYNC_DOMAINS.map((domain) => {
    const lastSyncedAt = input.domainSyncTimes[domain];
    const summary =
      buildDomainSyncSummary(input.localPayload, domain) ||
      (input.remotePayload ? buildDomainSyncSummary(input.remotePayload, domain) : "");

    if (!input.remotePayload) {
      return {
        domain,
        state: "cloud_empty" as const,
        ...(summary ? { summary } : {}),
        ...(lastSyncedAt ? { lastSyncedAt } : {}),
      };
    }

    const domainHasSecrets = secretKindsForDomain(domain).length > 0;
    if (domainHasSecrets && !input.hasVaultKey) {
      return {
        domain,
        state: "needs_vault" as const,
        ...(summary ? { summary } : {}),
        ...(lastSyncedAt ? { lastSyncedAt } : {}),
      };
    }

    const payloadMatch = domainPayloadEqual(input.localPayload, input.remotePayload, domain);
    const secretsMatch =
      !domainHasSecrets || domainSecretsEqual(input.localSecrets, input.remoteSecrets, domain);
    const cloudEmpty = isDomainEmptyInCloud(input.remotePayload, domain);
    const localEmpty = isDomainEmptyInLocal(input.localPayload, domain);

    if (cloudEmpty && localEmpty) {
      return {
        domain,
        state: "synced" as const,
        ...(summary ? { summary } : {}),
        ...(lastSyncedAt ? { lastSyncedAt } : {}),
      };
    }

    if (cloudEmpty && !localEmpty) {
      return {
        domain,
        state: "never_synced" as const,
        ...(summary ? { summary } : {}),
        ...(lastSyncedAt ? { lastSyncedAt } : {}),
      };
    }

    if (payloadMatch && secretsMatch) {
      return {
        domain,
        state: "synced" as const,
        ...(summary ? { summary } : {}),
        ...(lastSyncedAt ? { lastSyncedAt } : {}),
      };
    }

    return {
      domain,
      state: "dirty" as const,
      ...(summary ? { summary } : {}),
      ...(lastSyncedAt ? { lastSyncedAt } : {}),
    };
  });
}
