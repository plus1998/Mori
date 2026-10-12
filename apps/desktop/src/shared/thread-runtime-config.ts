import {
  defaultSubagentAvailability,
  normalizeSubagentAvailability,
  SUBAGENT_ROLES,
} from "@eco/runtime/subagent-availability";
import type { BashReviewMode } from "../../../../packages/bash-policy/src";
import {
  type EcoOrchestrationConfig,
  isOrchestrationSelection,
  isResolvedOrchestrationSnapshot,
  type OrchestrationResourceLookup,
  type OrchestrationSelection,
  orchestrationConfigFromSnapshot,
  type ResolvedOrchestrationSnapshot,
  resolveOrchestrationSnapshot,
} from "./agent-orchestration";
import {
  type ApprovalModelSelection,
  isApprovalModelSelection,
  normalizeApprovalModelSelection,
} from "./approval-model";
import {
  type AuxiliaryModelSelection,
  isAuxiliaryModelSelection,
  normalizeAuxiliaryModelSelection,
} from "./auxiliary-model";
import { normalizeBashReviewMode } from "./bash-review-ui";
import { ECO_AGENT_BROWSER_MCP_SERVER } from "./browser";
import {
  deriveMcpServersEnabled,
  listEnabledGlobalMcpServerKeys,
  type McpServersEnabledSettings,
  normalizeMcpServersEnabled,
  resolveEnabledMcpServerKeys,
} from "./composer-mcp";
import { normalizeSkillsEnabled, type SkillsEnabledSettings } from "./composer-skills-settings";
import { type IntegrationsEnabledSettings, normalizeIntegrationsEnabled } from "./integrations";
import type {
  McpServerConfigView,
  ModelSettingsSnapshot,
  RuntimeAgentRole,
  RuntimeRoleRouteConfig,
  SubagentEnabledSettings,
  ThinkingEffort,
  WorkflowSettingsSnapshot,
} from "./ipc";
import { isSessionMode, normalizeSessionMode, resolveSessionMode, type SessionMode } from "./session-mode";
import {
  isVisionModelSelection,
  normalizeVisionModelSelection,
  type VisionModelSelection,
} from "./vision-model";

export type {
  ApprovalModelSelection,
  AuxiliaryModelSelection,
  BashReviewMode,
  IntegrationsEnabledSettings,
  McpServersEnabledSettings,
  OrchestrationSelection,
  ResolvedOrchestrationSnapshot,
  SessionMode,
  VisionModelSelection,
};

export type MainAgentSystemPromptPreset = ResolvedOrchestrationSnapshot["mainAgent"]["systemPromptPreset"];

export interface MainAgentModelOverride {
  providerId: string;
  modelId: string;
  thinkingEffort?: ThinkingEffort;
  candidateModelId?: string;
}

/**
 * Thread-bound runtime config.
 * Eco cores persist `orchestrationSelection` + `resolvedOrchestrationSnapshot` when
 * creating a thread or switching 运行配置. ACP does not use Eco orchestration;
 * missing selection is valid and a run can start with session/model fields only.
 */
export interface ThreadRuntimeConfig {
  /** Cursor Agent CLI model id; only used when coreKind is acp + acpAgentId cursor. */
  cursorModelId?: string;
  orchestrationSelection?: OrchestrationSelection;
  resolvedOrchestrationSnapshot?: ResolvedOrchestrationSnapshot;
  mainAgentModelOverride?: MainAgentModelOverride;
  auxiliaryModel?: AuxiliaryModelSelection;
  approvalModel?: ApprovalModelSelection;
  visionModel?: VisionModelSelection;
  mainAgentSystemPromptPresetOverride?: MainAgentSystemPromptPreset;
  subagentEnabled: SubagentEnabledSettings;
  mcpServersEnabled?: McpServersEnabledSettings;
  integrationsEnabled?: IntegrationsEnabledSettings;
  skillsEnabled?: SkillsEnabledSettings;
  sessionMode: SessionMode;
  bashReviewMode: BashReviewMode;
}

export type ThreadRuntimeConfigInput = ThreadRuntimeConfig;

export function resolveMainAgentModelOverrideForProvider(
  providerId: string | undefined,
  override: MainAgentModelOverride | undefined,
): MainAgentModelOverride | undefined {
  const currentProviderId = providerId?.trim();
  return currentProviderId && override?.providerId.trim() === currentProviderId ? override : undefined;
}

export function orchestrationResourceLookupFromSettings(
  settings: ModelSettingsSnapshot,
): OrchestrationResourceLookup {
  return {
    mainAgentConfigs: settings.mainAgentConfigs,
    mainAgentPrompts: settings.mainAgentPrompts,
    subagentOrchestrations: settings.subagentOrchestrations,
  };
}

export function hasCompleteOrchestrationSelection(
  selection: OrchestrationSelection | undefined,
): selection is OrchestrationSelection {
  if (!selection || !isOrchestrationSelection(selection)) {
    return false;
  }
  if (!selection.mainAgentConfigId.trim()) {
    return false;
  }
  if (selection.mainPrompt.mode === "custom_append" && !selection.mainPrompt.promptId.trim()) {
    return false;
  }
  if (selection.subagents.mode === "orchestration" && !selection.subagents.orchestrationId.trim()) {
    return false;
  }
  return true;
}

export function resolveThreadOrchestrationSnapshot(
  settings: ModelSettingsSnapshot,
  config: ThreadRuntimeConfig,
): ResolvedOrchestrationSnapshot | undefined {
  if (
    config.resolvedOrchestrationSnapshot &&
    isResolvedOrchestrationSnapshot(config.resolvedOrchestrationSnapshot)
  ) {
    return config.resolvedOrchestrationSnapshot;
  }
  if (!hasCompleteOrchestrationSelection(config.orchestrationSelection)) {
    return undefined;
  }
  return resolveOrchestrationSnapshot(
    config.orchestrationSelection,
    orchestrationResourceLookupFromSettings(settings),
  );
}

export function resolveThreadOrchestrationConfig(
  settings: ModelSettingsSnapshot,
  config: ThreadRuntimeConfig,
): EcoOrchestrationConfig | undefined {
  const snapshot = resolveThreadOrchestrationSnapshot(settings, config);
  return snapshot ? orchestrationConfigFromSnapshot(snapshot) : undefined;
}

export function runtimeRoleRoutesFromOrchestrationSnapshot(
  snapshot: ResolvedOrchestrationSnapshot,
  mainAgentModelOverride?: MainAgentModelOverride,
): RuntimeRoleRouteConfig[] {
  const routes = new Map<RuntimeAgentRole, RuntimeRoleRouteConfig>();
  routes.set("planner", routeFromModelRef("planner", snapshot.mainAgent.modelRef));
  for (const agent of snapshot.agents) {
    const role = agent.agentKey;
    if (agent.enabled && role !== "planner" && !routes.has(role)) {
      routes.set(role, routeFromModelRef(role, agent.modelRef));
    }
  }
  return applyMainAgentModelOverride([...routes.values()], mainAgentModelOverride);
}

export function applyMainAgentModelOverride(
  routes: readonly RuntimeRoleRouteConfig[],
  override?: MainAgentModelOverride,
): RuntimeRoleRouteConfig[] {
  if (!override) {
    return routes.map((route) => ({ ...route }));
  }
  return routes.map((route) => {
    if (route.role !== "planner") {
      return { ...route };
    }
    const applicableOverride = resolveMainAgentModelOverrideForProvider(route.providerId, override);
    if (!applicableOverride) {
      return { ...route };
    }
    const sameModel = route.modelId.trim() === applicableOverride.modelId.trim();
    return {
      ...(sameModel ? route : {}),
      role: "planner",
      providerId: applicableOverride.providerId,
      modelId: applicableOverride.modelId,
      ...(applicableOverride.thinkingEffort !== undefined
        ? { thinkingEffort: applicableOverride.thinkingEffort }
        : {}),
      ...(applicableOverride.candidateModelId
        ? { candidateModelId: applicableOverride.candidateModelId }
        : {}),
    };
  });
}

function routeFromModelRef(
  role: RuntimeAgentRole,
  modelRef: ResolvedOrchestrationSnapshot["mainAgent"]["modelRef"],
): RuntimeRoleRouteConfig {
  return {
    role,
    providerId: modelRef.providerId,
    modelId: modelRef.modelId,
    ...(modelRef.apiCompat && { apiCompat: modelRef.apiCompat }),
    ...(modelRef.thinkingEffort && { thinkingEffort: modelRef.thinkingEffort }),
    ...(modelRef.modelsDevMapping && { modelsDevMapping: modelRef.modelsDevMapping }),
    ...(modelRef.manualSpec && { manualSpec: modelRef.manualSpec }),
    ...(modelRef.candidateModelId && { candidateModelId: modelRef.candidateModelId }),
  };
}

/** Build selection + snapshot for thread persistence. */
export function materializeThreadOrchestrationSnapshot(
  settings: ModelSettingsSnapshot,
  selection: OrchestrationSelection,
): {
  orchestrationSelection: OrchestrationSelection;
  resolvedOrchestrationSnapshot: ResolvedOrchestrationSnapshot;
} {
  const resolvedOrchestrationSnapshot = resolveOrchestrationSnapshot(
    selection,
    orchestrationResourceLookupFromSettings(settings),
  );
  return {
    orchestrationSelection: selection,
    resolvedOrchestrationSnapshot,
  };
}

export function isThreadRuntimeConfig(value: unknown): value is ThreadRuntimeConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    "routeProfileId" in record ||
    "agentProfileId" in record ||
    "mainAgentConfigId" in record ||
    "mainPrompt" in record ||
    "subagentOrchestrationId" in record ||
    "resolvedProfileSnapshot" in record
  ) {
    return false;
  }
  if (!isSessionMode(record.sessionMode)) {
    return false;
  }
  if (!record.subagentEnabled || typeof record.subagentEnabled !== "object") {
    return false;
  }
  if (
    record.cursorModelId !== undefined &&
    (typeof record.cursorModelId !== "string" ||
      !record.cursorModelId.trim() ||
      record.cursorModelId.trim().length > 256)
  ) {
    return false;
  }
  if (
    record.mainAgentModelOverride !== undefined &&
    !isMainAgentModelOverride(record.mainAgentModelOverride)
  ) {
    return false;
  }
  if (record.auxiliaryModel !== undefined && !isAuxiliaryModelSelection(record.auxiliaryModel)) {
    return false;
  }
  if (record.approvalModel !== undefined && !isApprovalModelSelection(record.approvalModel)) {
    return false;
  }
  if (record.visionModel !== undefined && !isVisionModelSelection(record.visionModel)) {
    return false;
  }
  if (
    record.mainAgentSystemPromptPresetOverride !== undefined &&
    !isMainAgentSystemPromptPreset(record.mainAgentSystemPromptPresetOverride)
  ) {
    return false;
  }
  if (
    record.orchestrationSelection !== undefined &&
    !isOrchestrationSelection(record.orchestrationSelection)
  ) {
    return false;
  }
  if (
    record.resolvedOrchestrationSnapshot !== undefined &&
    !isResolvedOrchestrationSnapshot(record.resolvedOrchestrationSnapshot)
  ) {
    return false;
  }
  const subagents = record.subagentEnabled as Record<string, unknown>;
  if (!SUBAGENT_ROLES.every((role) => typeof subagents[role] === "boolean")) {
    return false;
  }
  const bashReviewMode = record.bashReviewMode;
  return (
    (bashReviewMode === undefined ||
      bashReviewMode === "always" ||
      bashReviewMode === "auto" ||
      bashReviewMode === "allow_all") &&
    (record.mcpServersEnabled === undefined || isMcpServersEnabledRecord(record.mcpServersEnabled)) &&
    (record.integrationsEnabled === undefined || isMcpServersEnabledRecord(record.integrationsEnabled)) &&
    (record.skillsEnabled === undefined || isMcpServersEnabledRecord(record.skillsEnabled))
  );
}

function isMcpServersEnabledRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((enabled) => typeof enabled === "boolean");
}

export function parseThreadRuntimeConfigJson(
  json: string | null | undefined,
): ThreadRuntimeConfig | undefined {
  if (!json?.trim()) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    if (!isThreadRuntimeConfig(parsed)) {
      return undefined;
    }
    return normalizeThreadRuntimeConfig(parsed);
  } catch {
    return undefined;
  }
}

export function serializeThreadRuntimeConfig(config: ThreadRuntimeConfig): string {
  return JSON.stringify(normalizeThreadRuntimeConfig(config));
}

/** Compare runtime configs without volatile snapshot timestamps. */
export function serializeThreadRuntimeConfigForCompare(config: ThreadRuntimeConfig): string {
  const normalized = normalizeThreadRuntimeConfig(config);
  if (!normalized.resolvedOrchestrationSnapshot) {
    return JSON.stringify(normalized);
  }
  const { resolvedAt: _resolvedAt, ...snapshotWithoutTimestamp } = normalized.resolvedOrchestrationSnapshot;
  return JSON.stringify({
    ...normalized,
    resolvedOrchestrationSnapshot: snapshotWithoutTimestamp,
  });
}

export function threadRuntimeConfigsEquivalent(
  left: ThreadRuntimeConfig,
  right: ThreadRuntimeConfig,
): boolean {
  return serializeThreadRuntimeConfigForCompare(left) === serializeThreadRuntimeConfigForCompare(right);
}

function orchestrationSelectionsEquivalent(
  left: OrchestrationSelection | undefined,
  right: OrchestrationSelection | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    JSON.stringify(normalizeOrchestrationSelection(left)) ===
    JSON.stringify(normalizeOrchestrationSelection(right))
  );
}

/** Continue must not rebuild the locked snapshot from current global settings. */
export function shouldRematerializeThreadRuntimeConfigOnContinue(
  existing: ThreadRuntimeConfig | undefined,
  incoming: ThreadRuntimeConfig,
): boolean {
  return !(
    Boolean(existing?.resolvedOrchestrationSnapshot) &&
    orchestrationSelectionsEquivalent(existing?.orchestrationSelection, incoming.orchestrationSelection)
  );
}

/** Keep the session snapshot; apply continue-time fields such as model override. */
export function lockThreadRuntimeConfigSnapshotOnContinue(
  existing: ThreadRuntimeConfig,
  incoming: ThreadRuntimeConfig,
): ThreadRuntimeConfig {
  const normalizedIncoming = normalizeThreadRuntimeConfig(incoming);
  if (shouldRematerializeThreadRuntimeConfigOnContinue(existing, normalizedIncoming)) {
    return normalizedIncoming;
  }
  return normalizeThreadRuntimeConfig(
    existing.resolvedOrchestrationSnapshot
      ? { ...normalizedIncoming, resolvedOrchestrationSnapshot: existing.resolvedOrchestrationSnapshot }
      : normalizedIncoming,
  );
}

export function normalizeThreadRuntimeConfig(config: ThreadRuntimeConfig): ThreadRuntimeConfig {
  const bashReviewMode = normalizeBashReviewMode(config.bashReviewMode);
  const rawMcpServersEnabled = normalizeMcpServersEnabled(config.mcpServersEnabled);
  const legacyBrowserEnabled = rawMcpServersEnabled?.[ECO_AGENT_BROWSER_MCP_SERVER];
  const mcpServersEnabled = rawMcpServersEnabled
    ? Object.fromEntries(
        Object.entries(rawMcpServersEnabled).filter(([key]) => key !== ECO_AGENT_BROWSER_MCP_SERVER),
      )
    : undefined;
  const integrationsEnabled =
    normalizeIntegrationsEnabled(config.integrationsEnabled) ??
    (typeof legacyBrowserEnabled === "boolean" ? { browser: legacyBrowserEnabled } : undefined);
  const skillsEnabled = normalizeSkillsEnabled(config.skillsEnabled);
  const auxiliaryModel = normalizeAuxiliaryModelSelection(config.auxiliaryModel);
  const approvalModel = normalizeApprovalModelSelection(config.approvalModel);
  const visionModel = normalizeVisionModelSelection(config.visionModel);
  return {
    ...(typeof config.cursorModelId === "string" && config.cursorModelId.trim()
      ? { cursorModelId: config.cursorModelId.trim().slice(0, 256) }
      : {}),
    ...(config.orchestrationSelection && isOrchestrationSelection(config.orchestrationSelection)
      ? { orchestrationSelection: normalizeOrchestrationSelection(config.orchestrationSelection) }
      : {}),
    ...(config.resolvedOrchestrationSnapshot &&
    isResolvedOrchestrationSnapshot(config.resolvedOrchestrationSnapshot)
      ? { resolvedOrchestrationSnapshot: config.resolvedOrchestrationSnapshot }
      : {}),
    ...(config.mainAgentModelOverride
      ? { mainAgentModelOverride: normalizeMainAgentModelOverride(config.mainAgentModelOverride) }
      : {}),
    ...(auxiliaryModel ? { auxiliaryModel } : {}),
    ...(approvalModel ? { approvalModel } : {}),
    ...(visionModel ? { visionModel } : {}),
    ...(config.mainAgentSystemPromptPresetOverride
      ? { mainAgentSystemPromptPresetOverride: config.mainAgentSystemPromptPresetOverride }
      : {}),
    subagentEnabled: normalizeSubagentAvailability(config.subagentEnabled),
    ...(mcpServersEnabled && Object.keys(mcpServersEnabled).length > 0 ? { mcpServersEnabled } : {}),
    ...(integrationsEnabled ? { integrationsEnabled } : {}),
    ...(skillsEnabled ? { skillsEnabled } : {}),
    sessionMode: normalizeSessionMode(config.sessionMode),
    bashReviewMode,
  };
}

/** Align runtime subagent toggles with agents actually present in the snapshot. */
export function deriveSubagentEnabledFromSnapshot(
  snapshot: ResolvedOrchestrationSnapshot,
  existing?: Partial<SubagentEnabledSettings>,
): SubagentEnabledSettings {
  const subagentEnabled = defaultSubagentAvailability();
  const orchestrationAgents = snapshot.agents;
  for (const role of SUBAGENT_ROLES) {
    const agent = orchestrationAgents.find((candidate) => candidate.agentKey === role);
    if (!agent?.enabled) {
      subagentEnabled[role] = false;
      continue;
    }
    if (typeof existing?.[role] === "boolean") {
      subagentEnabled[role] = existing[role];
    }
  }
  return subagentEnabled;
}

/** Resolve MCP servers enabled for a thread session (Composer/workpanel only). */
export function resolveThreadRuntimeMcpServerKeys(input: {
  runtimeConfig?: ThreadRuntimeConfig;
  settings: ModelSettingsSnapshot;
  availableMcpServerKeys: readonly string[];
}): string[] {
  if (input.runtimeConfig?.mcpServersEnabled) {
    return resolveEnabledMcpServerKeys(
      deriveMcpServersEnabled(input.availableMcpServerKeys, {
        existing: input.runtimeConfig.mcpServersEnabled,
      }),
    );
  }
  return [];
}

export function buildAcpThreadRuntimeConfig(input?: {
  cursorModelId?: string;
  sessionMode?: SessionMode;
  bashReviewMode?: BashReviewMode;
  subagentEnabled?: SubagentEnabledSettings;
  auxiliaryModel?: AuxiliaryModelSelection;
  approvalModel?: ApprovalModelSelection;
  visionModel?: VisionModelSelection;
  mcpServersEnabled?: McpServersEnabledSettings;
  integrationsEnabled?: IntegrationsEnabledSettings;
  skillsEnabled?: SkillsEnabledSettings;
}): ThreadRuntimeConfig {
  const cursorModelId =
    typeof input?.cursorModelId === "string" ? input.cursorModelId.trim().slice(0, 256) : "";
  const auxiliaryModel = normalizeAuxiliaryModelSelection(input?.auxiliaryModel);
  const approvalModel = normalizeApprovalModelSelection(input?.approvalModel);
  const visionModel = normalizeVisionModelSelection(input?.visionModel);
  const mcpServersEnabled = normalizeMcpServersEnabled(input?.mcpServersEnabled);
  const integrationsEnabled = normalizeIntegrationsEnabled(input?.integrationsEnabled);
  const skillsEnabled = normalizeSkillsEnabled(input?.skillsEnabled);
  return {
    ...(cursorModelId ? { cursorModelId } : {}),
    subagentEnabled: input?.subagentEnabled ?? defaultSubagentAvailability(),
    sessionMode: normalizeSessionMode(input?.sessionMode),
    bashReviewMode: input?.bashReviewMode ?? "always",
    ...(auxiliaryModel ? { auxiliaryModel } : {}),
    ...(approvalModel ? { approvalModel } : {}),
    ...(visionModel ? { visionModel } : {}),
    ...(mcpServersEnabled ? { mcpServersEnabled } : {}),
    ...(integrationsEnabled ? { integrationsEnabled } : {}),
    ...(skillsEnabled ? { skillsEnabled } : {}),
  };
}

export function resolveAcpCursorModelIdForSend(input: {
  runtimeConfig?: Pick<ThreadRuntimeConfig, "cursorModelId"> | null;
  workflowDefault?: string;
}): string | undefined {
  if (input.runtimeConfig) {
    const selected = input.runtimeConfig.cursorModelId?.trim();
    return selected || undefined;
  }
  const fallback = input.workflowDefault?.trim();
  return fallback || undefined;
}

export function buildThreadRuntimeConfigFromDefaults(input: {
  settings: ModelSettingsSnapshot;
  workflowDefaults: WorkflowSettingsSnapshot;
  orchestrationSelection?: OrchestrationSelection;
  mcpServers?: readonly McpServerConfigView[];
}): ThreadRuntimeConfig {
  const selection = input.orchestrationSelection ?? input.workflowDefaults.defaultOrchestrationSelection;
  if (!hasCompleteOrchestrationSelection(selection)) {
    throw new Error("请先选择完整的主代理、提示词和子代理编排组合。");
  }
  const materialized = materializeThreadOrchestrationSnapshot(input.settings, selection);
  const availableMcpServerKeys = listEnabledGlobalMcpServerKeys(input.mcpServers ?? []);
  const sessionMode = normalizeSessionMode(input.workflowDefaults.sessionMode);
  const integrationsEnabled = normalizeIntegrationsEnabled(input.workflowDefaults.integrationsEnabled);
  const base: ThreadRuntimeConfig = {
    ...materialized,
    ...(input.workflowDefaults.acpCursorModelId
      ? { cursorModelId: input.workflowDefaults.acpCursorModelId }
      : {}),
    ...(input.workflowDefaults.defaultAuxiliaryModel
      ? { auxiliaryModel: input.workflowDefaults.defaultAuxiliaryModel }
      : {}),
    ...(input.workflowDefaults.defaultApprovalModel
      ? { approvalModel: input.workflowDefaults.defaultApprovalModel }
      : {}),
    ...(input.workflowDefaults.defaultVisionModel
      ? { visionModel: input.workflowDefaults.defaultVisionModel }
      : {}),
    subagentEnabled: deriveSubagentEnabledFromSnapshot(materialized.resolvedOrchestrationSnapshot),
    ...(availableMcpServerKeys.length > 0
      ? {
          mcpServersEnabled: deriveMcpServersEnabled(availableMcpServerKeys, {
            ...(input.workflowDefaults.mcpServersEnabled
              ? { remembered: input.workflowDefaults.mcpServersEnabled }
              : {}),
          }),
        }
      : {}),
    ...(integrationsEnabled ? { integrationsEnabled } : {}),
    sessionMode,
    bashReviewMode: normalizeBashReviewMode(input.workflowDefaults.defaultBashReviewMode),
  };

  return base;
}

export function isPlanModeThreadRuntime(config: ThreadRuntimeConfig): boolean {
  return resolveSessionMode(config) === "plan";
}

/** ExitPlanMode ends the planning phase; align thread config with Agent session mode. */
export function withAgentSessionMode(
  config: ThreadRuntimeConfig,
  sessionMode: SessionMode = "agent",
): ThreadRuntimeConfig {
  if (resolveSessionMode(config) === sessionMode) {
    return config;
  }
  return { ...config, sessionMode };
}

/**
 * Strip fields that mobile (and other thin clients) often drop or rewrite when
 * round-tripping a full ThreadRuntimeConfig. Busy / bash-only update paths always
 * keep the host's existing snapshot and preset override; comparing them would
 * falsely reject a bashReviewMode-only change.
 */
function threadRuntimeConfigForBashReviewModeCompare(config: ThreadRuntimeConfig): ThreadRuntimeConfig {
  const {
    resolvedOrchestrationSnapshot: _snapshot,
    mainAgentSystemPromptPresetOverride: _preset,
    ...rest
  } = config;
  return rest;
}

/** True when `after` differs from `before` only by `bashReviewMode`. */
export function isBashReviewModeOnlyRuntimeConfigUpdate(
  before: ThreadRuntimeConfig,
  after: ThreadRuntimeConfig,
): boolean {
  const normalizedBefore = normalizeThreadRuntimeConfig(before);
  const normalizedAfter = normalizeThreadRuntimeConfig(after);
  return threadRuntimeConfigsEquivalent(
    {
      ...threadRuntimeConfigForBashReviewModeCompare(normalizedBefore),
      bashReviewMode: normalizedAfter.bashReviewMode,
    },
    threadRuntimeConfigForBashReviewModeCompare(normalizedAfter),
  );
}

/**
 * Fields that may change while a run is active:
 * - `bashReviewMode`: host-side execution confirmation is re-read per tool call.
 * - `auxiliaryModel` / `approvalModel` / `visionModel`: every auxiliary, approval and
 *   vision request is a stateless single-shot call; the host re-reads the thread
 *   selection when the request is made, so a switch only affects the next request.
 * Everything else (main agent route, orchestration, session mode, MCP / skills /
 * integrations) is bound to the running session and still requires the run to finish.
 *
 * Serialized view of every session-bound field; those busy-mutable fields are neutralized.
 */
function busyImmutableThreadRuntimeConfigView(config: ThreadRuntimeConfig): string {
  const {
    auxiliaryModel: _a,
    approvalModel: _p,
    visionModel: _v,
    ...rest
  } = threadRuntimeConfigForBashReviewModeCompare(normalizeThreadRuntimeConfig(config));
  return serializeThreadRuntimeConfigForCompare({ ...rest, bashReviewMode: "auto" });
}

/** True when `after` differs from `before` only by fields that are safe mid-run. */
export function isBusyMutableOnlyRuntimeConfigUpdate(
  before: ThreadRuntimeConfig,
  after: ThreadRuntimeConfig,
): boolean {
  return busyImmutableThreadRuntimeConfigView(before) === busyImmutableThreadRuntimeConfigView(after);
}

export function applyBusyMutableRuntimeConfigFields(
  existing: ThreadRuntimeConfig,
  incoming: ThreadRuntimeConfig,
): ThreadRuntimeConfig {
  const { auxiliaryModel, approvalModel, visionModel, bashReviewMode } = incoming;
  const base = { ...existing };
  delete base.auxiliaryModel;
  delete base.approvalModel;
  delete base.visionModel;
  return {
    ...base,
    bashReviewMode,
    ...(auxiliaryModel ? { auxiliaryModel } : {}),
    ...(approvalModel ? { approvalModel } : {}),
    ...(visionModel ? { visionModel } : {}),
  };
}

export function resolveBusyThreadRuntimeConfigUpdate(input: {
  existing: ThreadRuntimeConfig | undefined;
  incoming: ThreadRuntimeConfig;
}): { kind: "apply"; runtimeConfig: ThreadRuntimeConfig } | { kind: "blocked" } {
  if (!input.existing || !isBusyMutableOnlyRuntimeConfigUpdate(input.existing, input.incoming)) {
    return { kind: "blocked" };
  }
  return {
    kind: "apply",
    runtimeConfig: applyBusyMutableRuntimeConfigFields(
      normalizeThreadRuntimeConfig(input.existing),
      normalizeThreadRuntimeConfig(input.incoming),
    ),
  };
}

export function resolveMainAgentSystemPromptPreset(
  snapshot: ResolvedOrchestrationSnapshot,
  config: ThreadRuntimeConfig,
): MainAgentSystemPromptPreset {
  return config.mainAgentSystemPromptPresetOverride ?? snapshot.mainAgent.systemPromptPreset;
}

function normalizeOrchestrationSelection(selection: OrchestrationSelection): OrchestrationSelection {
  const mainPrompt =
    selection.mainPrompt.mode === "builtin"
      ? { mode: "builtin" as const }
      : {
          mode: "custom_append" as const,
          promptId:
            typeof selection.mainPrompt.promptId === "string" ? selection.mainPrompt.promptId.trim() : "",
        };
  const subagents =
    selection.subagents.mode === "none"
      ? { mode: "none" as const }
      : {
          mode: "orchestration" as const,
          orchestrationId:
            typeof selection.subagents.orchestrationId === "string"
              ? selection.subagents.orchestrationId.trim()
              : "",
        };
  return {
    mainAgentConfigId:
      typeof selection.mainAgentConfigId === "string" ? selection.mainAgentConfigId.trim() : "",
    mainPrompt,
    subagents,
  };
}

function isMainAgentSystemPromptPreset(value: unknown): value is MainAgentSystemPromptPreset {
  return value === "core_native" || value === "custom_append";
}

function isMainAgentModelOverride(value: unknown): value is MainAgentModelOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.providerId === "string" &&
    Boolean(record.providerId.trim()) &&
    typeof record.modelId === "string" &&
    Boolean(record.modelId.trim()) &&
    (record.thinkingEffort === undefined ||
      (typeof record.thinkingEffort === "string" && isThinkingEffort(record.thinkingEffort))) &&
    (record.candidateModelId === undefined || typeof record.candidateModelId === "string")
  );
}

function normalizeMainAgentModelOverride(override: MainAgentModelOverride): MainAgentModelOverride {
  const candidateModelId = override.candidateModelId?.trim();
  return {
    providerId: override.providerId.trim(),
    modelId: override.modelId.trim(),
    ...(override.thinkingEffort !== undefined ? { thinkingEffort: override.thinkingEffort } : {}),
    ...(candidateModelId ? { candidateModelId } : {}),
  };
}

function isThinkingEffort(value: string): value is ThinkingEffort {
  return (
    value === "off" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

export function isAutonomousThreadRuntime(config: ThreadRuntimeConfig): boolean {
  return resolveSessionMode(config) === "agent";
}

export { isAskSessionMode, isPlanSessionMode, resolveSessionMode } from "./session-mode";
