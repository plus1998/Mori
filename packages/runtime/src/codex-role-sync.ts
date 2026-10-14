import fs from "node:fs/promises";
import path from "node:path";
import type { CodexGatewayApiCompat } from "../../shared/src";
import type {
  EcoAgentInstanceConfig,
  EcoAgentTemplateConfig,
  EcoOrchestrationConfig,
} from "./agent-orchestration.js";
import {
  buildCodexGatewayModelAlias,
  buildCodexMcpServerTomlLines,
  buildCodexModelProviderSlug,
  CODEX_BUILT_IN_OPENAI_PROVIDER_ID,
  type CodexAgentRoleForConfigSync,
  type CodexMcpServerForConfigSync,
  type EcoProviderForCodexConfig,
} from "./codex-config-sync.js";
import { resolveCodexMultiAgentVersion } from "./codex-model-catalog-sync.js";
import type {
  CodexExecutionConfirmationMode,
  CodexSandboxMode,
  CodexWebSearchMode,
  EcoToolPolicy,
} from "./codex-tool-policy.js";
import {
  applyCodexExecutionConfirmation,
  cloneEcoToolPolicy,
  ecoToolPolicyToRoleTomlFields,
  normalizeEcoToolPolicy,
  sanitizeMcpServerName,
} from "./codex-tool-policy.js";
import { exploreAgentDescription, exploreAgentPrompt } from "./prompts/explore.js";
import { isThreadSubagentRoleEnabledForCodex } from "./subagent-availability.js";
import { appendV4aTeachingToPrompt } from "./v4a-teaching.js";
import { isV4aTeachingEnabled } from "./v4a-teaching-flags.js";

/** Reserved Codex role id for the editable Explore roster entry. */
export const CODEX_EXPLORE_ROLE_ID = "explore";
const CODEX_EXPLORE_TEMPLATE_ID = "builtin.coding.explore";
const ECO_ROLE_BUNDLES_DIRNAME = "eco-agent-bundles";

const BUILTIN_EXPLORE_TOOL_POLICY: EcoToolPolicy = {
  sandboxMode: "read-only",
  approvalPolicy: "on-request",
  webSearch: "disabled",
  allowSpawn: false,
};

export interface SyncOrchestrationAgentsToCodexRolesInput {
  codexHomeDir: string;
  orchestration: EcoOrchestrationConfig;
  templates: readonly EcoAgentTemplateConfig[];
  /** Global MCP definitions inherited by the thread before actor-specific policy is applied. */
  mcpServers?: readonly CodexMcpServerForConfigSync[];
  /** Composer-selected MCP servers. Missing entries are denied for every actor. */
  threadEnabledMcpServers?: readonly string[];
  /** Known secrets that must be removed if a user-authored prompt accidentally contains them. */
  secretsToRedact?: readonly string[];
  executionConfirmationMode?: CodexExecutionConfirmationMode;
  /**
   * Force Codex native `web_search` mode for every role (e.g. `"disabled"` when Eco Integrated
   * Web Search MCP is armed). Main-thread `web_search` is applied separately via thread config.
   */
  webSearchOverride?: CodexWebSearchMode;
  resolveSupportsImageInput?: (ref: { providerId: string; modelId: string }) => boolean | undefined;
}

export interface CodexMcpServerVisibilityOverride {
  enabled: boolean;
  enabled_tools?: string[];
}

export interface CodexThreadConfigOverrides extends Record<string, unknown> {
  features?: {
    multi_agent: boolean;
    hooks: boolean;
    multi_agent_v2?: boolean;
    view_image?: boolean;
  };
  agents?: Record<string, unknown>;
  skills?: {
    config: Array<{ path: string; enabled: boolean }>;
  };
  mcp_servers: Record<string, CodexMcpServerVisibilityOverride>;
}

export function withCodexSkillConfig(
  config: CodexThreadConfigOverrides,
  entries: readonly { path: string; enabled: boolean }[],
): CodexThreadConfigOverrides {
  if (entries.length === 0) return { ...config };
  const byPath = new Map(
    [...(config.skills?.config ?? []), ...entries].map((entry) => [
      entry.path,
      { path: entry.path, enabled: entry.enabled },
    ]),
  );
  return {
    ...config,
    skills: { ...config.skills, config: [...byPath.values()] },
  };
}

export function withCodexNativeImageView(
  config: CodexThreadConfigOverrides,
  providerId: string,
  supportsImageInput?: boolean,
): CodexThreadConfigOverrides {
  if (!config.features) {
    throw new Error("Codex thread features are required to scope native image viewing.");
  }
  return {
    ...config,
    features: {
      ...config.features,
      view_image: providerId.trim() === "openai" && supportsImageInput !== false,
    },
  };
}

export interface SyncedCodexRole {
  agentKey: string;
  roleId: string;
  rolePath: string;
  description: string;
  configFile: string;
  /** Upstream model id written into the role file (F12). */
  modelId: string;
  /** Eco provider id; must exist in ProviderStore / config.toml model_providers (F12). */
  providerId: string;
  /** Explicit modelRef wire override; absent means use the provider default. */
  apiCompat?: CodexGatewayApiCompat;
  /** Orchestration tool policy sandbox used to infer subagent card role when spawn omits agent_type. */
  sandboxMode: CodexSandboxMode;
  /** Exact role policy reapplied to explicit child turns after thread/resume. */
  toolPolicy: EcoToolPolicy;
}

export interface SyncOrchestrationAgentsToCodexRolesResult {
  codexHomeDir: string;
  /** Directory containing generated Codex custom agent TOML files. */
  agentsDir: string;
  roleIds: string[];
  agentRoles: CodexAgentRoleForConfigSync[];
  roles: SyncedCodexRole[];
  /** Exact main-thread config passed to both thread/start and thread/resume. */
  threadConfig: CodexThreadConfigOverrides;
  /** Exact child-thread config used when Eco explicitly resumes a persisted subagent. */
  roleThreadConfigs: Record<string, CodexThreadConfigOverrides>;
}

interface CodexRoleDraft extends BuiltCodexRole {
  agentKey: string;
  roleId: string;
  mcpVisibility: Record<string, CodexMcpServerVisibilityOverride>;
}

/**
 * Sync enabled orchestration agents into a content-addressed immutable directory.
 * Codex reads a role file only when spawn_agent runs, so mutable shared paths
 * would let a concurrent thread replace another thread's permissions.
 * Bundles stay outside `$CODEX_HOME/agents`, where Codex recursively discovers
 * standalone roles and would see duplicate names across immutable bundles.
 *
 * @see docs/codex-integration-plan.md §6.2.2, §6.4
 */
export async function syncOrchestrationAgentsToCodexRoles(
  input: SyncOrchestrationAgentsToCodexRolesInput & {
    /** Thread-level subagent toggles; when set, only enabled roles are written. */
    subagentAvailability?: Partial<Record<string, boolean>>;
  },
): Promise<SyncOrchestrationAgentsToCodexRolesResult> {
  const templateById = new Map(input.templates.map((template) => [template.id, template]));
  const exploreAgent = input.orchestration.agents.find(
    (agent) =>
      agent.agentKey.trim().toLowerCase() === CODEX_EXPLORE_ROLE_ID &&
      agent.templateId === CODEX_EXPLORE_TEMPLATE_ID,
  );
  const enabledAgents = input.orchestration.agents.filter((agent) => {
    if (agent === exploreAgent) {
      return false;
    }
    if (!agent.enabled) {
      return false;
    }
    if (!input.subagentAvailability) {
      return true;
    }
    const role = agentKeyToSubagentRole(agent.agentKey);
    if (!role) {
      return true;
    }
    return isThreadSubagentRoleEnabledForCodex(role, input.subagentAvailability);
  });
  const includeExplore = Boolean(exploreAgent?.enabled) && isExploreRoleEnabled(input.subagentAvailability);
  const orchestrationRoleIds = resolveUniqueRoleIds(enabledAgents.map((agent) => agent.agentKey));
  if (orchestrationRoleIds.includes(CODEX_EXPLORE_ROLE_ID)) {
    throw new Error(
      `Orchestration agent key sanitizes to reserved Codex explore role id '${CODEX_EXPLORE_ROLE_ID}'. Rename the agent key.`,
    );
  }
  const secretsToRedact = input.secretsToRedact ?? [];
  const mcpScope = normalizeMcpScope(input.mcpServers ?? [], input.threadEnabledMcpServers);
  const mainMcpVisibility = buildActorMcpVisibility({
    actor: "main",
    mcpScope,
    // Composer/workpanel session selection is the sole MCP scope for all actors.
    assignedServers: [...mcpScope.threadEnabled],
  });
  const drafts: CodexRoleDraft[] = [];

  if (includeExplore) {
    const exploreToolPolicy = applyCodexWebSearchOverride(
      input.executionConfirmationMode
        ? applyCodexExecutionConfirmation(BUILTIN_EXPLORE_TOOL_POLICY, input.executionConfirmationMode)
        : BUILTIN_EXPLORE_TOOL_POLICY,
      input.webSearchOverride,
    );
    const mcpVisibility = buildActorMcpVisibility({
      actor: CODEX_EXPLORE_ROLE_ID,
      mcpScope,
      assignedServers: [...mcpScope.threadEnabled],
    });
    drafts.push({
      agentKey: CODEX_EXPLORE_ROLE_ID,
      roleId: CODEX_EXPLORE_ROLE_ID,
      mcpVisibility,
      ...buildExploreCodexRole(
        exploreAgent!.modelRef,
        secretsToRedact,
        mcpVisibility,
        input.mcpServers ?? [],
        isV4aTeachingEnabled(exploreAgent),
        exploreToolPolicy,
        input.resolveSupportsImageInput?.(exploreAgent!.modelRef),
      ),
    });
  }

  for (let index = 0; index < enabledAgents.length; index += 1) {
    const agent = enabledAgents[index];
    const roleId = orchestrationRoleIds[index];
    if (!agent || !roleId) {
      throw new Error("Orchestration agent role resolution failed.");
    }
    const template = templateById.get(agent.templateId);
    if (!template) {
      throw new Error(`Missing agent template for ${agent.agentKey}: ${agent.templateId}`);
    }
    const configuredToolPolicy = resolveEffectiveAgentToolPolicy(agent, template);
    const toolPolicy = applyCodexWebSearchOverride(
      input.executionConfirmationMode
        ? applyCodexExecutionConfirmation(configuredToolPolicy, input.executionConfirmationMode)
        : configuredToolPolicy,
      input.webSearchOverride,
    );
    const mcpVisibility = buildActorMcpVisibility({
      actor: roleId,
      mcpScope,
      assignedServers: [...mcpScope.threadEnabled],
    });
    assertRoleDoesNotSilentlyBroadenMainMcp({
      roleId,
      mainMcpVisibility,
      roleMcpVisibility: mcpVisibility,
    });
    drafts.push({
      agentKey: agent.agentKey,
      roleId,
      mcpVisibility,
      ...buildCodexRole(
        agent,
        template,
        roleId,
        secretsToRedact,
        mcpVisibility,
        input.mcpServers ?? [],
        toolPolicy,
        input.resolveSupportsImageInput?.(agent.modelRef),
      ),
    });
  }

  const bundleFingerprint = await fingerprintRoleBundle(drafts);
  const agentsDir = path.join(input.codexHomeDir, ECO_ROLE_BUNDLES_DIRNAME, bundleFingerprint);
  const roles: SyncedCodexRole[] = [];

  await removeLegacyDiscoveredEcoRoles(input.codexHomeDir);
  await fs.mkdir(agentsDir, { recursive: true });

  for (const draft of drafts) {
    const rolePath = path.join(agentsDir, `${draft.roleId}.toml`);
    await writeImmutableRoleFile(rolePath, draft.toml);
    roles.push({
      agentKey: draft.agentKey,
      roleId: draft.roleId,
      rolePath,
      description: draft.description,
      configFile: rolePath,
      modelId: draft.modelId,
      providerId: draft.providerId,
      ...(draft.apiCompat && { apiCompat: draft.apiCompat }),
      sandboxMode: draft.sandboxMode,
      toolPolicy: cloneEcoToolPolicy(draft.toolPolicy),
    });
  }

  const commonThreadConfig = buildThreadAgentConfig(roles, input.orchestration.mainAgent.modelRef.modelId);
  const threadConfig: CodexThreadConfigOverrides = {
    ...commonThreadConfig,
    mcp_servers: cloneMcpVisibility(mainMcpVisibility),
  };
  const roleThreadConfigs = Object.fromEntries(
    drafts.map((draft) => [
      draft.roleId,
      withCodexNativeImageView(
        {
          ...commonThreadConfig,
          mcp_servers: cloneMcpVisibility(draft.mcpVisibility),
        },
        draft.providerId,
        input.resolveSupportsImageInput?.(draft),
      ),
    ]),
  );

  return {
    codexHomeDir: input.codexHomeDir,
    agentsDir,
    roleIds: roles.map((role) => role.roleId),
    agentRoles: roles.map((role) => ({
      roleId: role.roleId,
      description: role.description,
      configFile: role.configFile,
    })),
    roles,
    threadConfig,
    roleThreadConfigs,
  };
}

async function removeLegacyDiscoveredEcoRoles(codexHomeDir: string): Promise<void> {
  await fs.rm(path.join(codexHomeDir, "agents", "eco"), { recursive: true, force: true });
}

/**
 * Fail closed when a role's modelRef.providerId is not an enabled Eco provider.
 * Heterogeneous models (F12) require the provider to exist in config.toml model_providers.
 */
export function assertCodexRoleProvidersAvailable(
  roles: readonly SyncedCodexRole[],
  providers: readonly EcoProviderForCodexConfig[],
): void {
  if (roles.length === 0) {
    return;
  }
  const enabledProviders = new Map(
    providers
      .filter((provider) => provider.enabled)
      .map((provider) => [provider.id.trim(), provider] as const)
      .filter(([providerId]) => Boolean(providerId)),
  );
  // Built-in OpenAI (auth.json) — no ProviderStore entry needed
  if (!enabledProviders.has(CODEX_BUILT_IN_OPENAI_PROVIDER_ID)) {
    enabledProviders.set(CODEX_BUILT_IN_OPENAI_PROVIDER_ID, {
      id: "openai",
      name: "OpenAI",
      enabled: true,
      apiCompat: "openai_responses" as const,
    } as (typeof providers)[number]);
  }
  for (const role of roles) {
    const providerId = role.providerId.trim();
    const modelId = role.modelId.trim();
    if (!modelId) {
      throw new Error(
        `Codex role '${role.roleId}' is missing modelRef.modelId. Set an explicit model on the orchestration agent.`,
      );
    }
    if (!providerId) {
      throw new Error(
        `Codex role '${role.roleId}' is missing modelRef.providerId. Set an explicit provider on the orchestration agent.`,
      );
    }
    const provider = enabledProviders.get(providerId);
    if (!provider) {
      throw new Error(
        `Codex role '${role.roleId}' requires provider '${providerId}' (model '${modelId}'), but it is missing or disabled in Settings. Enable the provider or update the orchestration modelRef.`,
      );
    }
    if (
      provider.compactionMode === "responses-native" &&
      role.apiCompat !== undefined &&
      role.apiCompat !== "openai_responses"
    ) {
      throw new Error(
        `Codex role '${role.roleId}' cannot override provider '${providerId}' to apiCompat=${role.apiCompat} because the provider uses responses-native compaction. Use openai_responses or switch the provider to codex-local compaction.`,
      );
    }
  }
}

export function sanitizeCodexRoleId(agentKey: string): string {
  const sanitized = agentKey
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!sanitized) {
    throw new Error("Agent key cannot be empty after Codex role sanitization.");
  }
  return sanitized;
}

function agentKeyToSubagentRole(agentKey: string): string | undefined {
  const key = agentKey.trim().toLowerCase();
  for (const role of ["explore", "architect", "coder", "reviewer", "tester"] as const) {
    if (key === role || key === `eco_${role}` || key.endsWith(`_${role}`)) {
      return role;
    }
  }
  return undefined;
}

interface NormalizedMcpScope {
  servers: Array<{ name: string; enabledTools?: string[] }>;
  threadEnabled: ReadonlySet<string>;
}

function normalizeMcpScope(
  servers: readonly { name: string; enabledTools?: readonly string[] }[],
  threadEnabledServers: readonly string[] | undefined,
): NormalizedMcpScope {
  const byName = new Map<string, { name: string; enabledTools?: string[] }>();
  for (const server of servers) {
    const name = sanitizeMcpServerName(server.name);
    if (!name) {
      throw new Error("Codex MCP server name is required for role isolation.");
    }
    const enabledTools = normalizeToolNames(server.enabledTools);
    const existing = byName.get(name);
    if (existing) {
      if (JSON.stringify(existing.enabledTools) !== JSON.stringify(enabledTools)) {
        throw new Error(`Conflicting Codex MCP definitions for role isolation: ${name}.`);
      }
      continue;
    }
    byName.set(name, {
      name,
      ...(enabledTools !== undefined ? { enabledTools } : {}),
    });
  }

  const requested =
    threadEnabledServers === undefined
      ? new Set(byName.keys())
      : new Set(threadEnabledServers.map(sanitizeMcpServerName).filter(Boolean));
  for (const name of requested) {
    if (!byName.has(name)) {
      throw new Error(`Thread selected MCP server '${name}', but it is not in the global Codex MCP pool.`);
    }
  }
  return {
    servers: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    threadEnabled: requested,
  };
}

function buildActorMcpVisibility(input: {
  actor: string;
  mcpScope: NormalizedMcpScope;
  assignedServers: readonly string[];
  enabledTools?: readonly string[];
}): Record<string, CodexMcpServerVisibilityOverride> {
  const assigned = new Set(input.assignedServers.map(sanitizeMcpServerName).filter(Boolean));
  const actorTools = normalizeToolNames(input.enabledTools);
  return Object.fromEntries(
    input.mcpScope.servers.map((server) => {
      const enabled = input.mcpScope.threadEnabled.has(server.name) && assigned.has(server.name);
      if (!enabled) {
        return [server.name, { enabled: false } satisfies CodexMcpServerVisibilityOverride];
      }
      const effectiveTools = intersectToolFilters(server.enabledTools, actorTools);
      return [
        server.name,
        {
          enabled: true,
          ...(effectiveTools !== undefined ? { enabled_tools: effectiveTools } : {}),
        } satisfies CodexMcpServerVisibilityOverride,
      ];
    }),
  );
}

function intersectToolFilters(
  globalTools: readonly string[] | undefined,
  actorTools: readonly string[] | undefined,
): string[] | undefined {
  if (globalTools === undefined) {
    return actorTools === undefined ? undefined : [...actorTools];
  }
  if (actorTools === undefined) {
    return [...globalTools];
  }
  const globalSet = new Set(globalTools);
  return actorTools.filter((tool) => globalSet.has(tool));
}

function normalizeToolNames(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  return normalized.length > 0 ? normalized : undefined;
}

function assertRoleDoesNotSilentlyBroadenMainMcp(input: {
  roleId: string;
  mainMcpVisibility: Readonly<Record<string, CodexMcpServerVisibilityOverride>>;
  roleMcpVisibility: Readonly<Record<string, CodexMcpServerVisibilityOverride>>;
}): void {
  for (const [serverName, roleVisibility] of Object.entries(input.roleMcpVisibility)) {
    const mainVisibility = input.mainMcpVisibility[serverName];
    if (
      roleVisibility.enabled &&
      mainVisibility?.enabled &&
      mainVisibility.enabled_tools !== undefined &&
      roleVisibility.enabled_tools === undefined
    ) {
      throw new Error(
        `Codex role '${input.roleId}' requests every tool from MCP server '${serverName}', but the main actor inherits a narrower enabled_tools list. Codex 0.142.5 cannot remove that inherited list without an enumerated child allowlist. Configure explicit MCP tools for the role.`,
      );
    }
  }
}

function buildThreadAgentConfig(
  roles: readonly SyncedCodexRole[],
  mainModelId: string,
): Pick<CodexThreadConfigOverrides, "features" | "agents"> {
  if (roles.length === 0) {
    return {
      features: {
        multi_agent: false,
        hooks: false,
        multi_agent_v2: false,
      },
    };
  }
  const agents: Record<string, unknown> = {
    max_threads: 16,
    max_depth: 1,
  };
  for (const role of roles) {
    agents[role.roleId] = {
      description: role.description,
      config_file: role.rolePath,
    };
  }
  return {
    features: {
      multi_agent: true,
      hooks: true,
      multi_agent_v2: resolveCodexMultiAgentVersion(mainModelId) === "v2",
    },
    agents,
  };
}

function cloneMcpVisibility(
  visibility: Readonly<Record<string, CodexMcpServerVisibilityOverride>>,
): Record<string, CodexMcpServerVisibilityOverride> {
  return Object.fromEntries(
    Object.entries(visibility).map(([name, entry]) => [
      name,
      {
        enabled: entry.enabled,
        ...(entry.enabled_tools !== undefined ? { enabled_tools: [...entry.enabled_tools] } : {}),
      },
    ]),
  );
}

async function fingerprintRoleBundle(drafts: readonly CodexRoleDraft[]): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for (const draft of drafts) {
    hash.update(draft.roleId);
    hash.update("\0");
    hash.update(draft.toml);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

async function writeImmutableRoleFile(rolePath: string, contents: string): Promise<void> {
  try {
    await fs.writeFile(rolePath, contents, { encoding: "utf8", flag: "wx" });
    return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  const existing = await fs.readFile(rolePath, "utf8");
  if (existing !== contents) {
    throw new Error(`Immutable Codex role file collision at ${rolePath}.`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function buildCodexRoleToml(input: {
  roleId: string;
  description: string;
  developerInstructions: string;
  modelId: string;
  providerId: string;
  apiCompat?: CodexGatewayApiCompat;
  reasoningEffort?: string;
  supportsImageInput?: boolean;
  toolPolicy: EcoToolPolicy;
  mcpVisibility?: Readonly<Record<string, CodexMcpServerVisibilityOverride>>;
  mcpServers?: readonly CodexMcpServerForConfigSync[];
}): string {
  const permission = ecoToolPolicyToRoleTomlFields(input.toolPolicy);
  const isBuiltInOpenAi = input.providerId === CODEX_BUILT_IN_OPENAI_PROVIDER_ID;
  const modelValue = isBuiltInOpenAi
    ? input.modelId
    : buildCodexGatewayModelAlias(input.providerId, input.modelId, input.apiCompat);
  // Role configs inherit config.toml's global `model_provider = "eco_*"` default, so the
  // built-in OpenAI route must be pinned to Codex's own provider here too — otherwise the
  // role's official-subscription model would be sent to eco-gateway as a route miss (404).
  const modelProviderValue = isBuiltInOpenAi
    ? CODEX_BUILT_IN_OPENAI_PROVIDER_ID
    : buildCodexModelProviderSlug(input.providerId);
  const lines = [
    "# Generated by Eco Coding. Upstream secrets stay in ProviderStore / eco-gateway.",
    `name = ${tomlString(input.roleId)}`,
    `description = ${tomlString(input.description)}`,
    `developer_instructions = ${tomlString(input.developerInstructions)}`,
    `model = ${tomlString(modelValue)}`,
    `model_provider = ${tomlString(modelProviderValue)}`,
    `sandbox_mode = ${tomlString(permission.sandbox_mode)}`,
    `approval_policy = ${tomlString(permission.approval_policy)}`,
  ];
  if (permission.web_search) {
    lines.push(`web_search = ${tomlString(permission.web_search)}`);
  }
  if (input.reasoningEffort) {
    lines.push(`model_reasoning_effort = ${tomlString(input.reasoningEffort)}`);
  }
  lines.push(
    "",
    "[features]",
    `view_image = ${isBuiltInOpenAi && input.supportsImageInput !== false ? "true" : "false"}`,
  );
  if (permission.sandbox_workspace_write) {
    lines.push(
      "",
      "[sandbox_workspace_write]",
      `network_access = ${permission.sandbox_workspace_write.network_access ? "true" : "false"}`,
    );
  }
  const serverByName = new Map(
    (input.mcpServers ?? []).map((server) => [sanitizeMcpServerName(server.name), server]),
  );
  for (const [serverName, visibility] of Object.entries(input.mcpVisibility ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const server = serverByName.get(serverName);
    if (!server) throw new Error(`Missing MCP definition for Codex role server '${serverName}'.`);
    const serverLines = buildCodexMcpServerTomlLines({
      ...server,
      ...(visibility.enabled_tools !== undefined ? { enabledTools: visibility.enabled_tools } : {}),
    }).map((line) =>
      line === "enabled = true" ? `enabled = ${visibility.enabled ? "true" : "false"}` : line,
    );
    lines.push("", ...serverLines);
  }
  if (input.toolPolicy.allowSpawn === false) {
    lines.push("# Eco allowSpawn: false (role must not nest spawn_agent)");
  }
  return `${lines.join("\n")}\n`;
}

export function mapEcoThinkingEffortToCodexReasoningEffort(effort: string | undefined): string | undefined {
  if (effort === undefined) {
    return undefined;
  }
  const normalized = effort.trim();
  if (!normalized) {
    throw new Error("Codex reasoning effort must be a non-empty string.");
  }
  return normalized === "off" ? "none" : normalized;
}

export function codexRoleSyncContainsSecret(value: string, secrets: readonly string[]): string | undefined {
  return findSecret(value, secrets);
}

interface BuiltCodexRole {
  description: string;
  toml: string;
  modelId: string;
  providerId: string;
  apiCompat?: CodexGatewayApiCompat;
  sandboxMode: CodexSandboxMode;
  toolPolicy: EcoToolPolicy;
}

function buildCodexRole(
  agent: EcoAgentInstanceConfig,
  template: EcoAgentTemplateConfig,
  roleId: string,
  secretsToRedact: readonly string[],
  mcpVisibility: Readonly<Record<string, CodexMcpServerVisibilityOverride>>,
  mcpServers: readonly CodexMcpServerForConfigSync[],
  toolPolicy: EcoToolPolicy,
  supportsImageInput?: boolean,
): BuiltCodexRole {
  const description = redactKnownSecrets(buildRoleDescription(agent, template), secretsToRedact);
  const developerInstructions = redactKnownSecrets(
    buildDeveloperInstructions(agent, template, roleId),
    secretsToRedact,
  );
  const modelId = requireModelId(agent.modelRef.modelId, agent.agentKey);
  const providerId = requireProviderId(agent.modelRef.providerId, agent.agentKey);
  const apiCompat = resolveCodexRoleApiCompat(agent.modelRef.apiCompat, agent.agentKey);
  return {
    sandboxMode: toolPolicy.sandboxMode,
    toolPolicy: cloneEcoToolPolicy(toolPolicy),
    description,
    modelId,
    providerId,
    ...(apiCompat && { apiCompat }),
    toml: buildCodexRoleToml({
      roleId,
      description,
      developerInstructions,
      modelId: redactKnownSecrets(modelId, secretsToRedact),
      providerId: redactKnownSecrets(providerId, secretsToRedact),
      ...(apiCompat && { apiCompat }),
      ...(supportsImageInput !== undefined && { supportsImageInput }),
      ...withCodexReasoningEffort(agent.modelRef.thinkingEffort),
      toolPolicy,
      mcpVisibility,
      mcpServers,
    }),
  };
}

function buildExploreCodexRole(
  modelRef: EcoAgentInstanceConfig["modelRef"],
  secretsToRedact: readonly string[],
  mcpVisibility: Readonly<Record<string, CodexMcpServerVisibilityOverride>>,
  mcpServers: readonly CodexMcpServerForConfigSync[],
  v4aTeachingEnabled = false,
  toolPolicy: EcoToolPolicy = BUILTIN_EXPLORE_TOOL_POLICY,
  supportsImageInput?: boolean,
): BuiltCodexRole {
  const modelId = requireModelId(modelRef.modelId, CODEX_EXPLORE_ROLE_ID);
  const providerId = requireProviderId(modelRef.providerId, CODEX_EXPLORE_ROLE_ID);
  const apiCompat = resolveCodexRoleApiCompat(modelRef.apiCompat, CODEX_EXPLORE_ROLE_ID);
  const description = redactKnownSecrets(exploreAgentDescription, secretsToRedact);
  const developerInstructions = redactKnownSecrets(
    appendV4aTeachingToPrompt(exploreAgentPrompt, v4aTeachingEnabled),
    secretsToRedact,
  );
  return {
    sandboxMode: toolPolicy.sandboxMode,
    toolPolicy: cloneEcoToolPolicy(toolPolicy),
    description,
    modelId,
    providerId,
    ...(apiCompat && { apiCompat }),
    toml: buildCodexRoleToml({
      roleId: CODEX_EXPLORE_ROLE_ID,
      description,
      developerInstructions,
      modelId: redactKnownSecrets(modelId, secretsToRedact),
      providerId: redactKnownSecrets(providerId, secretsToRedact),
      ...(apiCompat && { apiCompat }),
      ...withCodexReasoningEffort(modelRef.thinkingEffort),
      ...(supportsImageInput !== undefined && { supportsImageInput }),
      toolPolicy,
      mcpVisibility,
      mcpServers,
    }),
  };
}

function resolveCodexRoleApiCompat(
  value: string | undefined,
  agentKey: string,
): CodexGatewayApiCompat | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  switch (normalized) {
    case "anthropic":
    case "openai_responses":
    case "openai_chat_completions":
      return normalized;
    default:
      throw new Error(`Codex role '${agentKey}' has unsupported modelRef.apiCompat '${normalized}'.`);
  }
}

function withCodexReasoningEffort(effort: string | undefined): { reasoningEffort?: string } {
  const reasoningEffort = mapEcoThinkingEffortToCodexReasoningEffort(effort);
  return reasoningEffort ? { reasoningEffort } : {};
}

function isExploreRoleEnabled(subagentAvailability?: Partial<Record<string, boolean>>): boolean {
  return subagentAvailability?.explore !== false;
}

function resolveUniqueRoleIds(agentKeys: readonly string[]): string[] {
  const seen = new Map<string, string>();
  return agentKeys.map((agentKey) => {
    const roleId = sanitizeCodexRoleId(agentKey);
    const existing = seen.get(roleId);
    if (existing) {
      throw new Error(
        `Duplicate Codex role id '${roleId}' after sanitizing agent keys '${existing}' and '${agentKey}'.`,
      );
    }
    seen.set(roleId, agentKey);
    return roleId;
  });
}

function buildRoleDescription(agent: EcoAgentInstanceConfig, template: EcoAgentTemplateConfig): string {
  const displayName = agent.displayName?.trim() || template.name;
  return [
    `${displayName}: ${template.description.trim()}`,
    `Use when: ${template.whenToUse.trim()}`,
    template.outputContract?.trim() ? `Output: ${template.outputContract.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDeveloperInstructions(
  agent: EcoAgentInstanceConfig,
  template: EcoAgentTemplateConfig,
  _roleId: string,
): string {
  return appendV4aTeachingToPrompt(template.prompt.trim(), isV4aTeachingEnabled(agent));
}

function resolveEffectiveAgentToolPolicy(
  agent: EcoAgentInstanceConfig,
  template: EcoAgentTemplateConfig,
): EcoToolPolicy {
  const basePolicy = hasConfiguredToolPolicy(agent.tools) ? agent.tools : template.defaultTools;
  return normalizeEcoToolPolicy(basePolicy, { allowSpawnDefault: template.allowDelegation });
}

function hasConfiguredToolPolicy(policy: unknown): boolean {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return false;
  }
  const record = policy as Record<string, unknown>;
  const mcp =
    record.mcp && typeof record.mcp === "object" ? (record.mcp as Record<string, unknown>) : undefined;
  return (
    Boolean(record.sandboxMode) ||
    Boolean(record.approvalPolicy) ||
    record.networkAccess !== undefined ||
    record.webSearch !== undefined ||
    record.allowSpawn !== undefined ||
    (Array.isArray(record.allowed) && record.allowed.length > 0) ||
    (Array.isArray(record.disallowed) && record.disallowed.length > 0) ||
    record.bash !== undefined ||
    record.filesystem !== undefined ||
    record.network !== undefined ||
    (Array.isArray(mcp?.allowedServers) && mcp.allowedServers.length > 0) ||
    (Array.isArray(mcp?.enabledTools) && mcp.enabledTools.length > 0) ||
    (Array.isArray(mcp?.allowedTools) && mcp.allowedTools.length > 0)
  );
}

function requireModelId(modelId: string | undefined, agentKey: string): string {
  const resolved = modelId?.trim();
  if (!resolved) {
    throw new Error(`Missing model id for ${agentKey} agent. Agents must use explicit models.`);
  }
  return resolved;
}

function requireProviderId(providerId: string | undefined, agentKey: string): string {
  const resolved = providerId?.trim();
  if (!resolved) {
    throw new Error(`Missing provider id for ${agentKey} agent. Agents must use explicit providers.`);
  }
  return resolved;
}

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (!trimmed) {
      continue;
    }
    redacted = redacted.split(trimmed).join("[redacted]");
  }
  return redacted;
}

function applyCodexWebSearchOverride(
  policy: EcoToolPolicy,
  override: CodexWebSearchMode | undefined,
): EcoToolPolicy {
  if (!override) {
    return policy;
  }
  return cloneEcoToolPolicy({ ...policy, webSearch: override });
}

function findSecret(value: string, secrets: readonly string[]): string | undefined {
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed && value.includes(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}
