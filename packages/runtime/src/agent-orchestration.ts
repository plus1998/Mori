import {
  SDK_DELEGATION_SUPPORT_TOOL_NAMES,
  SDK_FILESYSTEM_READ_TOOL_NAMES,
  SDK_FILESYSTEM_WRITE_TOOL_NAMES,
  SDK_SKILL_TOOL_NAME,
  SDK_TASK_PROGRESS_TOOL_NAMES,
} from "./sdk-tool-names.js";
import { SDK_GENERAL_PURPOSE_AGENT_KEY, SDK_PLAN_AGENT_KEY } from "./subagent-availability.js";
import { normalizeSdkSubagentType } from "./subagent-resume.js";
import {
  capEcoToolPolicyForPhase,
  materializeEcoToolPolicy,
  resolveMainAgentHandsOnFromPolicy,
} from "./tool-permission-policy.js";
import { appendV4aTeachingToPrompt } from "./v4a-teaching.js";
import { isV4aTeachingEnabled } from "./v4a-teaching-flags.js";

export {
  SDK_DELEGATION_SUPPORT_TOOL_NAMES,
  SDK_FILESYSTEM_READ_TOOL_NAMES,
  SDK_FILESYSTEM_WRITE_TOOL_NAMES,
  SDK_SKILL_TOOL_NAME,
  SDK_TASK_PROGRESS_TOOL_NAMES,
} from "./sdk-tool-names.js";

export type EcoAgentConfigSource = "built_in" | "user" | "project" | "derived";

export interface EcoModelRef {
  providerId: string;
  modelId: string;
  apiCompat?: string;
  thinkingEffort?: string;
}

export type EcoModelRequirementCapability = "reasoning" | "coding" | "long_context" | "vision" | "tool_use";

export interface EcoModelRequirements {
  capabilities: EcoModelRequirementCapability[];
  preferredLatency?: "fast" | "balanced" | "quality";
  minContextTokens?: number;
}

export interface EcoToolPolicy {
  allowed: string[];
  disallowed: string[];
  bash?: {
    enabled: boolean;
  };
  mcp?: {
    allowedServers: string[];
    allowedTools: string[];
  };
  filesystem?: {
    read: "workspace" | "extra_dirs" | "none";
    write: "workspace" | "none";
  };
  network?: {
    webSearch: boolean;
    webFetch: boolean;
  };
  confirmation?: "always" | "on_risk" | "never";
  skills?: { enabled: boolean };
  interaction?: { askUser: boolean };
  taskProgress?: { enabled: boolean };
  delegation?: { enabled: boolean; allowedAgents?: string[] };
  coreOverrides?: {
    claude?: { disallowedTools: string[] };
    codex?: {
      sandboxMode?: "read-only";
    };
  };
}

export interface EcoAgentTemplateConfig {
  id: string;
  name: string;
  description: string;
  prompt: string;
  whenToUse: string;
  outputContract?: string;
  modelRequirements?: EcoModelRequirements;
  defaultTools: EcoToolPolicy;
  mcpServers: string[];
  skills: string[];
  allowDelegation: boolean;
  builtIn: boolean;
  source: EcoAgentConfigSource;
  updatedAt: string;
}

export interface EcoMainAgentConfig {
  agentKey: string;
  name: string;
  systemPromptPreset: "core_native" | "custom_append";
  prompt: string;
  modelRef: EcoModelRef;
  tools: EcoToolPolicy;
  skills: string[];
  /** When true, Codex appends V4A apply_patch teaching to main-agent developer instructions. */
  v4aTeachingEnabled?: boolean;
}

export interface EcoAgentInstanceConfig {
  /** Omitted: derive from this agent's resolved route at query creation. */
  claudeAutoCompactWindow?: number;
  agentKey: string;
  templateId: string;
  displayName?: string;
  themeColor?: string;
  modelRef: EcoModelRef;
  tools: EcoToolPolicy;
  mcpServers: string[];
  skills: string[];
  enabled: boolean;
  /** When true, Codex appends V4A apply_patch teaching to this subagent's developer instructions. */
  v4aTeachingEnabled?: boolean;
}

export type EcoOrchestrationStrategy = { kind: "autonomous"; guidancePrompt?: string };

export interface EcoOrchestrationConfig {
  mainAgent: EcoMainAgentConfig;
  agents: EcoAgentInstanceConfig[];
  strategy: EcoOrchestrationStrategy;
}

export interface EcoAgentRuntimeConfig {
  templates: EcoAgentTemplateConfig[];
  orchestration: EcoOrchestrationConfig;
}

export interface EcoResolvedAgentDefinitionSet {
  definitions: Record<string, unknown>;
  agentKeys: string[];
}

export interface EcoRuntimeToolPermissionEntry {
  allowed: string[];
  disallowed: string[];
  /** Sanitized MCP server names assigned to this actor; any tool from these servers is allowed. */
  mcpServers: string[];
  bash?: EcoToolPolicy["bash"];
  filesystem?: EcoToolPolicy["filesystem"];
  network?: EcoToolPolicy["network"];
}

export function sanitizeMcpServerName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "mcp-server";
}

export function parseMcpToolServerName(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp__")) {
    return undefined;
  }
  const rest = toolName.slice(5);
  const separatorIndex = rest.indexOf("__");
  if (separatorIndex <= 0) {
    return undefined;
  }
  return rest.slice(0, separatorIndex);
}

export function mcpAutoApprovePatternsForServers(servers: readonly string[]): string[] {
  return uniqueToolPatterns(servers.map((server) => `mcp__${sanitizeMcpServerName(server)}__*`));
}

export function resolveAssignedMcpServers(
  policy: EcoToolPolicy,
  extraServerNames: readonly string[] = [],
): string[] {
  const fromTools = (policy.mcp?.allowedTools ?? [])
    .map((pattern) => parseMcpToolServerName(pattern))
    .filter((server): server is string => Boolean(server));
  const servers = [...(policy.mcp?.allowedServers ?? []), ...fromTools, ...extraServerNames];
  return [...new Set(servers.map((server) => sanitizeMcpServerName(server)).filter(Boolean))];
}

export function resolveEffectiveBashPolicy(policy: EcoToolPolicy): NonNullable<EcoToolPolicy["bash"]> {
  const disallowed = new Set(policyDisallowedTools(policy).map((entry) => entry.trim()));

  if (disallowed.has("Bash") || policy.bash?.enabled === false) {
    return { enabled: false };
  }

  return { enabled: true };
}

export function collectOrchestrationAssignedMcpServers(
  orchestration: EcoOrchestrationConfig,
  templates: readonly EcoAgentTemplateConfig[],
): string[] {
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const servers = new Set<string>();

  for (const server of resolveAssignedMcpServers(orchestration.mainAgent.tools)) {
    servers.add(server);
  }

  for (const agent of orchestration.agents) {
    if (!agent.enabled) {
      continue;
    }
    for (const server of resolveAssignedMcpServers(agent.tools, agent.mcpServers)) {
      servers.add(server);
    }
    const template = templateById.get(agent.templateId);
    if (template) {
      for (const server of template.mcpServers.map((name) => sanitizeMcpServerName(name))) {
        servers.add(server);
      }
    }
  }

  return [...servers];
}

export interface EcoRuntimeToolPermissionPolicy {
  main: EcoRuntimeToolPermissionEntry;
  agents: Record<string, EcoRuntimeToolPermissionEntry>;
}

/** Read-only policy for Claude SDK built-in Plan subagent during native Plan Mode. */
export const BUILTIN_PLAN_TOOL_POLICY: EcoToolPolicy = {
  allowed: [],
  disallowed: [
    "Agent",
    "Task",
    "TaskList",
    "TaskGet",
    "Bash",
    ...SDK_FILESYSTEM_WRITE_TOOL_NAMES,
    ...SDK_TASK_PROGRESS_TOOL_NAMES,
    "AskUserQuestion",
  ],
  filesystem: { read: "workspace", write: "none" },
  network: { webSearch: true, webFetch: true },
};

export function buildBuiltinPlanToolPermissionEntry(): EcoRuntimeToolPermissionEntry {
  return normalizeToolPermissionEntry(BUILTIN_PLAN_TOOL_POLICY);
}

type SdkBuiltinToolPolicyRule = "inherit_main_without_delegation" | "plan_readonly";

/** Allowed SDK built-in subagents that need explicit tool policy resolution (not Orchestration-generated). */
const SDK_BUILTIN_TOOL_POLICY_RULES: Record<string, SdkBuiltinToolPolicyRule> = {
  [SDK_GENERAL_PURPOSE_AGENT_KEY]: "inherit_main_without_delegation",
  [SDK_PLAN_AGENT_KEY]: "plan_readonly",
};

function resolveEcoAgentToolPermissionEntry(
  policy: EcoRuntimeToolPermissionPolicy,
  actor: string,
): EcoRuntimeToolPermissionEntry | undefined {
  const directEntry = policy.agents[actor];
  if (directEntry) {
    return directEntry;
  }
  if (!actor.startsWith("eco_")) {
    const dynamicEntry = policy.agents[`eco_${actor}`];
    if (dynamicEntry) {
      return dynamicEntry;
    }
  }
  const normalizedRole = normalizeSdkSubagentType(actor);
  return normalizedRole ? policy.agents[`eco_${normalizedRole}`] : undefined;
}

export function resolveToolPermissionEntryForActor(
  policy: EcoRuntimeToolPermissionPolicy,
  actor: "main" | string,
): EcoRuntimeToolPermissionEntry | undefined {
  if (actor === "main") {
    return policy.main;
  }

  const ecoEntry = resolveEcoAgentToolPermissionEntry(policy, actor);
  if (ecoEntry) {
    return ecoEntry;
  }

  const rule = SDK_BUILTIN_TOOL_POLICY_RULES[actor];
  if (rule === "inherit_main_without_delegation") {
    return {
      ...policy.main,
      allowed: policy.main.allowed.filter((tool) => !isDelegationToolPattern(tool)),
      disallowed: uniqueToolPatterns([
        ...policy.main.disallowed,
        "Agent",
        "Task",
        ...SDK_DELEGATION_SUPPORT_TOOL_NAMES,
      ]),
    };
  }
  if (rule === "plan_readonly") {
    return buildBuiltinPlanToolPermissionEntry();
  }

  return undefined;
}

export interface MainAgentHandsOnCapability {
  canEditFiles: boolean;
  canRunBash: boolean;
}

/**
 * What the main orchestrator can do hands-on under the active orchestration tool policy.
 * Mirrors PreToolUse enforcement: only explicit disallow rules or structured flags apply.
 */
export function resolveMainAgentHandsOnCapability(
  orchestration?: EcoOrchestrationConfig,
): MainAgentHandsOnCapability {
  if (!orchestration) {
    return { canEditFiles: true, canRunBash: true };
  }
  return resolveMainAgentHandsOnFromPolicy(orchestration.mainAgent.tools);
}

/** When Eco Integrated Web Search is armed, replace native WebSearch on Claude subagents. */
export interface IntegratedWebSearchAgentDefOptions {
  serverName: string;
  fullToolName: string;
}

export function createAgentDefinitionsFromOrchestration(
  orchestration: EcoOrchestrationConfig,
  templates: readonly EcoAgentTemplateConfig[],
  options: {
    agentSkills?: Partial<Record<string, string[]>>;
    /**
     * Maps a orchestration agent's raw model id to the id the SDK should request (e.g. the local
     * proxy role alias), so usage billing can attribute requests to the right agent role.
     */
    resolveModelId?: (agentKey: string, modelId: string) => string;
    /**
     * Session uses Eco Integrated search: deny native WebSearch on every subagent definition, and
     * for search-capable agents expose the Eco MCP tool (explicit tools) / server (inherit tools).
     */
    integratedWebSearch?: IntegratedWebSearchAgentDefOptions;
  } = {},
): EcoResolvedAgentDefinitionSet {
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const definitions: Record<string, unknown> = {};
  const agentKeys: string[] = [];
  for (const agent of orchestration.agents) {
    if (!agent.enabled) {
      continue;
    }
    const template = templateById.get(agent.templateId);
    if (!template) {
      throw new Error(`Missing agent template for ${agent.agentKey}: ${agent.templateId}`);
    }
    const sdkKey = sdkAgentKeyForOrchestrationAgent(agent.agentKey);
    definitions[sdkKey] = buildSdkAgentDefinition(
      agent,
      template,
      resolveOrchestrationAgentSkills(agent.agentKey, sdkKey, options),
      options.resolveModelId,
      options.integratedWebSearch,
    );
    agentKeys.push(sdkKey);
  }
  return { definitions, agentKeys };
}

export function buildToolPermissionPolicyFromOrchestration(
  orchestration: EcoOrchestrationConfig,
  templates: readonly EcoAgentTemplateConfig[],
  options: {
    agentKeys?: readonly string[];
    /** Phase read-only cap list (plan/question). Not the merged SDK auto-approve list. */
    phaseAllowedTools?: readonly string[];
    mainAllowedTools?: readonly string[];
    /** Composer/runtime MCP selection merged into main agent MCP allowlist. */
    runtimeMcpServers?: readonly string[];
  } = {},
): EcoRuntimeToolPermissionPolicy {
  const explicitAgentKeys = options.agentKeys ? new Set(options.agentKeys) : undefined;
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const phaseCapTools =
    options.phaseAllowedTools && options.phaseAllowedTools.length > 0 ? options.phaseAllowedTools : undefined;
  const runtimeMcp = (options.runtimeMcpServers ?? []).map((server) => sanitizeMcpServerName(server));
  const agents: Record<string, EcoRuntimeToolPermissionEntry> = {};
  for (const agent of orchestration.agents) {
    if (!agent.enabled) {
      continue;
    }
    const sdkKey = sdkAgentKeyForOrchestrationAgent(agent.agentKey);
    if (explicitAgentKeys && !explicitAgentKeys.has(sdkKey)) {
      continue;
    }
    const template = templateById.get(agent.templateId);
    if (!template) {
      throw new Error(`Missing agent template for ${agent.agentKey}: ${agent.templateId}`);
    }
    // Session MCP scope is Composer/workpanel only — orchestration tools.mcp is ignored.
    agents[sdkKey] = resolveAgentToolPermission(agent, template, phaseCapTools, runtimeMcp);
  }
  const mainToolPolicy = phaseCapTools
    ? capEcoToolPolicyForPhase(orchestration.mainAgent.tools, phaseCapTools)
    : materializeEcoToolPolicy(orchestration.mainAgent.tools);
  return {
    main: normalizeToolPermissionEntry(
      mainToolPolicy,
      resolveMainToolPermissionExtraAllowed(phaseCapTools, options.mainAllowedTools),
      runtimeMcp,
    ),
    agents,
  };
}

function resolveMainToolPermissionExtraAllowed(
  phaseAllowedTools: readonly string[] | undefined,
  mainAllowedTools: readonly string[] | undefined,
): string[] {
  const extras = [SDK_SKILL_TOOL_NAME, ...SDK_TASK_PROGRESS_TOOL_NAMES];
  if (!phaseAllowedTools) {
    return [...(mainAllowedTools ?? []), ...extras];
  }
  const phaseAllowed = new Set(phaseAllowedTools);
  return extras.filter((tool) => phaseAllowed.has(tool));
}

export function buildMainAgentStrategySummary(orchestration: EcoOrchestrationConfig): string {
  return orchestration.strategy.guidancePrompt?.trim() ?? "";
}

/** Stable join order for Claude append / Codex developerInstructions. */
export function mergeMainAgentAppendParts(parts: {
  globalUserRules?: string;
  customPrompt?: string;
  strategySummary?: string;
}): string {
  return [parts.globalUserRules, parts.customPrompt, parts.strategySummary]
    .map((entry) => entry?.trim() ?? "")
    .filter((entry) => entry.length > 0)
    .join("\n\n");
}

export function buildMainAgentOrchestrationAppend(
  config: EcoOrchestrationConfig,
  _templates: readonly EcoAgentTemplateConfig[],
  _options?: { summaryLabel?: string },
): string {
  return buildMainAgentStrategySummary(config);
}

export function buildCodexMainAgentOrchestrationAppend(
  config: EcoOrchestrationConfig,
  _templates: readonly EcoAgentTemplateConfig[],
  options?: {
    subagentAvailability?: Partial<Record<string, boolean>>;
    globalUserRules?: string;
  },
): string {
  const customPrompt =
    config.mainAgent.systemPromptPreset === "custom_append" ? config.mainAgent.prompt.trim() : "";
  const append = mergeMainAgentAppendParts({
    ...(options?.globalUserRules !== undefined ? { globalUserRules: options.globalUserRules } : {}),
    customPrompt,
    strategySummary: buildMainAgentStrategySummary(config),
  });
  return appendV4aTeachingToPrompt(append, isV4aTeachingEnabled(config.mainAgent));
}

export function buildMainAgentSystemPrompt(
  orchestration: EcoOrchestrationConfig,
  templates: readonly EcoAgentTemplateConfig[],
  options: { excludeDynamicSections?: boolean; globalUserRules?: string } = {},
): string | Record<string, unknown> {
  return buildClaudeCodeSystemPrompt({
    orchestration,
    templates,
    ...options,
  });
}

/** Claude `claude_code` preset + optional personalization / orchestration append. */
export function buildClaudeCodeSystemPrompt(options: {
  orchestration?: EcoOrchestrationConfig;
  templates?: readonly EcoAgentTemplateConfig[];
  excludeDynamicSections?: boolean;
  globalUserRules?: string;
}): string | Record<string, unknown> {
  const customInstructions =
    options.orchestration?.mainAgent.systemPromptPreset === "custom_append"
      ? options.orchestration.mainAgent.prompt.trim()
      : "";
  const strategySummary = options.orchestration
    ? buildMainAgentOrchestrationAppend(options.orchestration, options.templates ?? [])
    : "";
  const append = mergeMainAgentAppendParts({
    ...(options.globalUserRules !== undefined ? { globalUserRules: options.globalUserRules } : {}),
    customPrompt: customInstructions,
    strategySummary,
  });
  return {
    type: "preset",
    preset: "claude_code",
    // Eco rebuilds user rules and orchestration instructions on each resumed query.
    // SDK 0.3.267+ otherwise freezes the append until compaction.
    snapshot: false,
    ...(append ? { append } : {}),
    ...(options.excludeDynamicSections ? { excludeDynamicSections: true } : {}),
  };
}

export function resolveMainAgentAllowedTools(
  orchestration: EcoOrchestrationConfig,
  phaseAllowedTools: readonly string[],
): string[] {
  const extras = [SDK_SKILL_TOOL_NAME, ...SDK_TASK_PROGRESS_TOOL_NAMES];
  const phaseExpanded = allowedToolPatternsFromPolicy(
    { allowed: [...phaseAllowedTools], disallowed: [] },
    extras,
  );
  const phaseToolSet = new Set(phaseExpanded);
  const phaseBlocksWrites = !hasAnyToolPattern(phaseToolSet, SDK_FILESYSTEM_WRITE_TOOL_NAMES);
  const phaseBlocksBash = !phaseToolSet.has("Bash");
  const orchestrationExpanded = allowedToolPatternsFromPolicy(orchestration.mainAgent.tools, extras);
  const mainMcpAutoApprove = mcpAutoApprovePatternsForServers(
    resolveAssignedMcpServers(orchestration.mainAgent.tools),
  );
  const orchestrationExtras = orchestrationExpanded.filter((tool) => {
    if (phaseToolSet.has(tool)) {
      return false;
    }
    if (phaseBlocksWrites && hasAnyToolPattern(new Set([tool]), SDK_FILESYSTEM_WRITE_TOOL_NAMES)) {
      return false;
    }
    if (phaseBlocksBash && tool === "Bash") {
      return false;
    }
    return true;
  });
  return uniqueToolPatterns([...phaseExpanded, ...orchestrationExtras, ...mainMcpAutoApprove]);
}

export function sdkAgentKeyForOrchestrationAgent(agentKey: string): string {
  const sanitized = agentKey
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!sanitized) {
    throw new Error("Agent key cannot be empty.");
  }
  return sanitized.startsWith("eco_") ? sanitized : `eco_${sanitized}`;
}

function buildSdkAgentDefinition(
  agent: EcoAgentInstanceConfig,
  template: EcoAgentTemplateConfig,
  sessionSkills: readonly string[] = [],
  resolveModelId?: (agentKey: string, modelId: string) => string,
  integratedWebSearch?: IntegratedWebSearchAgentDefOptions,
): Record<string, unknown> {
  const toolPolicy = materializeEcoToolPolicy(
    applyDelegationToolPolicy(resolveAgentToolPolicy(agent, template), template.allowDelegation),
  );
  let mcpServers = resolveAssignedMcpServers(toolPolicy, [...template.mcpServers, ...agent.mcpServers]);
  let tools = toolPolicy.allowed.length > 0 ? allowedToolPatternsFromPolicy(toolPolicy) : [];
  let disallowedTools = [...toolPolicy.disallowed];
  if (integratedWebSearch) {
    const applied = applyIntegratedWebSearchToAgentToolFields({
      tools,
      disallowedTools,
      mcpServers,
      ...(toolPolicy.network?.webSearch === undefined
        ? {}
        : { networkWebSearch: toolPolicy.network.webSearch }),
      integratedWebSearch,
    });
    tools = applied.tools;
    disallowedTools = applied.disallowedTools;
    mcpServers = applied.mcpServers;
  }
  const skills = sessionSkills.length > 0 ? [...sessionSkills] : [];
  return {
    description: buildAgentDescription(agent, template),
    ...(agent.claudeAutoCompactWindow !== undefined && { autoCompactWindow: agent.claudeAutoCompactWindow }),
    ...(tools.length > 0 ? { tools } : {}),
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    prompt: template.prompt,
    model: resolveModelId
      ? resolveModelId(agent.agentKey, requireModelId(agent.modelRef.modelId, agent.agentKey))
      : requireModelId(agent.modelRef.modelId, agent.agentKey),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(skills.length > 0 ? { skills } : {}),
  };
}

/**
 * Session-level Integrated search: always deny native WebSearch on the definition.
 * Search-capable agents get the Eco MCP server (and tool when they use an explicit allowlist).
 */
export function applyIntegratedWebSearchToAgentToolFields(input: {
  tools: readonly string[];
  disallowedTools: readonly string[];
  mcpServers: readonly string[];
  networkWebSearch?: boolean;
  integratedWebSearch: IntegratedWebSearchAgentDefOptions;
}): { tools: string[]; disallowedTools: string[]; mcpServers: string[] } {
  const disallowedTools = uniqueToolPatterns([...input.disallowedTools, "WebSearch"]);
  const wantsSearch =
    input.networkWebSearch !== false &&
    (input.tools.includes("WebSearch") || (input.tools.length === 0 && input.networkWebSearch === true));
  if (!wantsSearch) {
    return {
      tools: [...input.tools],
      disallowedTools,
      mcpServers: [...input.mcpServers],
    };
  }
  const mcpServers = uniqueToolPatterns([...input.mcpServers, input.integratedWebSearch.serverName]);
  if (input.tools.length === 0) {
    return { tools: [], disallowedTools, mcpServers };
  }
  return {
    tools: uniqueToolPatterns([
      ...input.tools.filter((tool) => tool !== "WebSearch"),
      input.integratedWebSearch.fullToolName,
    ]),
    disallowedTools,
    mcpServers,
  };
}

function resolveOrchestrationAgentSkills(
  agentKey: string,
  sdkKey: string,
  options: { agentSkills?: Partial<Record<string, string[]>> },
): string[] {
  const assignments = options.agentSkills;
  if (!assignments) {
    return [];
  }
  for (const key of [agentKey, sdkKey]) {
    const skills = assignments[key];
    if (skills && skills.length > 0) {
      return skills;
    }
  }
  return [];
}

function resolveAgentToolPermission(
  agent: EcoAgentInstanceConfig,
  template: EcoAgentTemplateConfig,
  phaseAllowedTools?: readonly string[],
  runtimeMcpServers: readonly string[] = [],
): EcoRuntimeToolPermissionEntry {
  const tools = applyDelegationToolPolicy(resolveAgentToolPolicy(agent, template), template.allowDelegation);
  const childPhaseAllowedTools = phaseAllowedTools
    ? phaseAllowedTools.filter((tool) => !isReadOnlyChildAgentBlockedTool(tool))
    : undefined;
  const effectiveTools = childPhaseAllowedTools
    ? capEcoToolPolicyForPhase(tools, childPhaseAllowedTools)
    : tools;
  const skillExtraAllowed = childPhaseAllowedTools
    ? [SDK_SKILL_TOOL_NAME].filter((tool) => childPhaseAllowedTools.includes(tool))
    : [SDK_SKILL_TOOL_NAME];
  return normalizeToolPermissionEntry(effectiveTools, skillExtraAllowed, runtimeMcpServers);
}

function isReadOnlyChildAgentBlockedTool(toolName: string): boolean {
  return (
    toolName === "Agent" ||
    toolName === "Task" ||
    (SDK_DELEGATION_SUPPORT_TOOL_NAMES as readonly string[]).includes(toolName) ||
    toolName === "AskUserQuestion"
  );
}

function normalizeToolPermissionEntry(
  policy: EcoToolPolicy,
  extraAllowed: readonly string[] = [],
  assignedMcpServers: readonly string[] = [],
): EcoRuntimeToolPermissionEntry {
  const materialized = materializeEcoToolPolicy(policy);
  const effectiveBash = resolveEffectiveBashPolicy(materialized);
  return {
    allowed: allowedToolPatternsFromPolicy(materialized, extraAllowed),
    disallowed: uniqueToolPatterns(materialized.disallowed),
    // Session MCP scope comes only from assignedMcpServers (Composer/workpanel runtime list).
    mcpServers: [
      ...new Set(assignedMcpServers.map((server) => sanitizeMcpServerName(server)).filter(Boolean)),
    ],
    bash: effectiveBash,
    ...(materialized.filesystem && { filesystem: { ...materialized.filesystem } }),
    ...(materialized.network && { network: { ...materialized.network } }),
  };
}

function hasConfiguredToolPolicy(policy: EcoToolPolicy): boolean {
  const allowed = policyAllowedTools(policy);
  const disallowed = policyDisallowedTools(policy);
  return (
    allowed.length > 0 ||
    disallowed.length > 0 ||
    policy.bash !== undefined ||
    policy.filesystem !== undefined ||
    policy.network !== undefined ||
    (policy.mcp?.allowedServers.length ?? 0) > 0 ||
    (policy.mcp?.allowedTools.length ?? 0) > 0
  );
}

function resolveAgentToolPolicy(
  agent: EcoAgentInstanceConfig,
  template: EcoAgentTemplateConfig,
): EcoToolPolicy {
  return hasConfiguredToolPolicy(agent.tools) ? agent.tools : template.defaultTools;
}

function applyDelegationToolPolicy(policy: EcoToolPolicy, allowDelegation: boolean): EcoToolPolicy {
  if (allowDelegation) {
    return policy;
  }
  const allowed = policyAllowedTools(policy);
  const disallowed = policyDisallowedTools(policy);
  return {
    ...policy,
    allowed: allowed.filter((tool) => !isDelegationToolPattern(tool)),
    disallowed: uniqueToolPatterns([...disallowed, "Agent", "Task", ...SDK_DELEGATION_SUPPORT_TOOL_NAMES]),
  };
}

function allowedToolPatternsFromPolicy(
  policy: EcoToolPolicy,
  extraAllowed: readonly string[] = [],
): string[] {
  const base = uniqueToolPatterns([...policyAllowedTools(policy), ...extraAllowed]);
  return uniqueToolPatterns([...base, ...relatedClaudeToolPatterns(base)]);
}

function policyAllowedTools(policy: EcoToolPolicy): readonly string[] {
  return Array.isArray(policy.allowed) ? policy.allowed : [];
}

function policyDisallowedTools(policy: EcoToolPolicy): readonly string[] {
  return Array.isArray(policy.disallowed) ? policy.disallowed : [];
}

function uniqueToolPatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean))];
}

function relatedClaudeToolPatterns(patterns: readonly string[]): string[] {
  const allowed = new Set(patterns);
  const related: string[] = [];
  if (hasAnyToolPattern(allowed, SDK_FILESYSTEM_READ_TOOL_NAMES)) {
    related.push("LS", "NotebookRead");
  }
  if (hasAnyToolPattern(allowed, SDK_FILESYSTEM_WRITE_TOOL_NAMES)) {
    related.push("MultiEdit", "NotebookEdit");
  }
  if (allowed.has("Agent") || allowed.has("Task")) {
    related.push(...SDK_DELEGATION_SUPPORT_TOOL_NAMES);
  }
  return related;
}

function hasAnyToolPattern(allowed: ReadonlySet<string>, tools: readonly string[]): boolean {
  return tools.some((tool) => allowed.has(tool));
}

function isDelegationToolPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  return (
    trimmed === "Agent" || trimmed === "Task" || trimmed.startsWith("Agent(") || trimmed.startsWith("Task(")
  );
}

function buildAgentDescription(agent: EcoAgentInstanceConfig, template: EcoAgentTemplateConfig): string {
  const displayName = agent.displayName?.trim() || template.name;
  return [
    `${displayName}: ${template.description.trim()}`,
    `Use when: ${template.whenToUse.trim()}`,
    template.outputContract?.trim() ? `Output: ${template.outputContract.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function requireModelId(modelId: string | undefined, agentKey: string): string {
  const resolved = modelId?.trim();
  if (!resolved) {
    throw new Error(`Missing model id for ${agentKey} agent. Agents must use explicit models.`);
  }
  return resolved;
}
