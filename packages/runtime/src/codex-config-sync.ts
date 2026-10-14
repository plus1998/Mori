import fs from "node:fs/promises";
import path from "node:path";
import {
  buildCodexGatewayModelAlias as buildSharedCodexGatewayModelAlias,
  CODEX_GATEWAY_MODEL_ALIAS_SEPARATOR,
  type CodexGatewayApiCompat,
  type ParsedCodexGatewayModelAlias,
  parseCodexGatewayModelAlias as parseSharedCodexGatewayModelAlias,
} from "../../shared/src";

export const DEFAULT_ECO_GATEWAY_PORT = 18_765;
/** Dev Electron uses a separate bridge port so it can run beside packaged Eco on :18765. */
export const DEFAULT_DEV_ECO_GATEWAY_PORT = 18_766;
/** Codex stream idle timeout — local models may pause a long time before first token. */
export const DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS = 900_000;
/** Avoid hammering free/local upstreams when a slow request is still in flight. */
export const DEFAULT_CODEX_REQUEST_MAX_RETRIES = 0;

export function resolveCodexStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ECO_CODEX_STREAM_IDLE_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ECO_CODEX_STREAM_IDLE_TIMEOUT_MS: ${raw}`);
  }
  return parsed;
}

export interface EcoProviderForCodexConfig {
  id: string;
  name: string;
  enabled: boolean;
  apiCompat?: "anthropic" | "openai_responses" | "openai_chat_completions";
  compactionMode?: "codex-local" | "responses-native";
}

export interface CodexAgentRoleForConfigSync {
  roleId: string;
  description: string;
  configFile: string;
}

/** Codex `config.toml` `[mcp_servers.*]` entry (stdio or streamable HTTP only). */
export interface CodexMcpServerForConfigSync {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  httpHeaders?: Record<string, string>;
  /** Tool names without `mcp__<server>__` prefix; omit = all tools from the server. */
  enabledTools?: string[];
  /**
   * Codex default is 10s — too short for `npx -y …` cold starts.
   * Eco writes 60s for stdio servers prepared for runtime.
   */
  startupTimeoutSec?: number;
  /**
   * Codex default is 60s — too short for long tools (e.g. Creative Drawing).
   * Written as `tool_timeout_sec` when set.
   */
  toolTimeoutSec?: number;
  /**
   * Per-tool model-facing output budget (Codex 0.152+ `output_token_limit`).
   * Keys are bare tool names (no `mcp__server__` prefix).
   */
  toolOutputTokenLimits?: Record<string, number>;
}

export interface SyncCodexConfigFromEcoProvidersInput {
  ecoDataDir: string;
  providers: readonly EcoProviderForCodexConfig[];
  /** Keep global multi-agent feature/hook support installed; role definitions remain thread-scoped. */
  enableMultiAgent?: boolean;
  agentRoles?: readonly CodexAgentRoleForConfigSync[];
  /** Thread/composer-selected MCP servers; omitted or empty = no MCP in config.toml. */
  mcpServers?: readonly CodexMcpServerForConfigSync[];
  gatewayPort?: number;
  gatewayBaseUrl?: string;
  /**
   * Absolute path to Eco's formal model catalog (`eco-model-catalog.json`).
   * When set, written as `model_catalog_json` so gateway aliases receive freeform apply_patch.
   */
  modelCatalogJsonPath?: string;
}

export interface SyncCodexConfigResult {
  codexHomeDir: string;
  configPath: string;
  gatewayBaseUrl: string;
  providerSlugs: string[];
  mcpServerNames: string[];
  defaultProviderSlug?: string;
  modelCatalogJsonPath?: string;
}

export function resolveEcoGatewayPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ECO_GATEWAY_PORT?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid ECO_GATEWAY_PORT: ${raw}`);
    }
    return parsed;
  }
  if (env.VITE_DEV_SERVER_URL !== undefined) {
    return DEFAULT_DEV_ECO_GATEWAY_PORT;
  }
  return DEFAULT_ECO_GATEWAY_PORT;
}

export function resolveEcoGatewayBaseUrl(port?: number, env: NodeJS.ProcessEnv = process.env): string {
  const resolvedPort = port ?? resolveEcoGatewayPort(env);
  return `http://127.0.0.1:${resolvedPort}/v1`;
}

export function resolveCodexHomeDir(ecoDataDir: string): string {
  return path.join(ecoDataDir, "codex");
}

/**
 * Codex's built-in provider id for the official OpenAI/ChatGPT subscription route
 * (credentials from CODEX_HOME/auth.json). Eco never writes `[model_providers.openai]`,
 * so this id must be pinned explicitly wherever config.toml's global `model_provider =
 * "eco_*"` default would otherwise apply (thread/start, role TOMLs).
 */
export const CODEX_BUILT_IN_OPENAI_PROVIDER_ID = "openai";

export function buildCodexModelProviderSlug(providerId: string): string {
  const trimmed = providerId.trim();
  if (!trimmed) {
    throw new Error("Provider id is required for Codex model provider slug");
  }
  return `eco_${trimmed}`;
}

export { CODEX_GATEWAY_MODEL_ALIAS_SEPARATOR };

/**
 * Provider-scoped model id for Codex → eco-gateway HTTP routing.
 * Avoids collisions when multiple providers expose the same upstream model name.
 */
export function buildCodexGatewayModelAlias(
  providerId: string,
  upstreamModelId: string,
  apiCompat?: CodexGatewayApiCompat,
): string {
  return buildSharedCodexGatewayModelAlias(providerId, upstreamModelId, apiCompat);
}

export function parseCodexGatewayModelAlias(
  requestedModel: string,
): ParsedCodexGatewayModelAlias | undefined {
  return parseSharedCodexGatewayModelAlias(requestedModel);
}

export function buildCodexConfigToml(input: SyncCodexConfigFromEcoProvidersInput): string {
  const gatewayBaseUrl = input.gatewayBaseUrl ?? resolveEcoGatewayBaseUrl(input.gatewayPort);
  const enabledProviders = input.providers.filter((provider) => provider.enabled);
  const gatewayProviders = enabledProviders.filter(
    (provider) => provider.id !== CODEX_BUILT_IN_OPENAI_PROVIDER_ID,
  );
  const defaultProvider = gatewayProviders[0];
  const agentRoles = uniqueAgentRoles(input.agentRoles ?? []);
  const enableMultiAgent = input.enableMultiAgent === true || agentRoles.length > 0;
  const lines = [
    "# Generated by Eco Coding. Upstream API keys live in ProviderStore / eco-gateway only.",
    "",
    // Gateway aliases are absent from Codex's built-in model catalog, whose
    // fallback disables summaries. Request them explicitly so reasoning reaches Feed.
    'model_reasoning_summary = "detailed"',
    "",
  ];

  const modelCatalogJsonPath = input.modelCatalogJsonPath?.trim();
  if (modelCatalogJsonPath) {
    if (!path.isAbsolute(modelCatalogJsonPath)) {
      throw new Error(`modelCatalogJsonPath must be an absolute path, received: ${modelCatalogJsonPath}`);
    }
    // Formal Eco catalog with freeform apply_patch aliases for eco_route_v1… models.
    lines.push(`model_catalog_json = ${tomlString(modelCatalogJsonPath)}`, "");
  }

  if (defaultProvider) {
    lines.push(`model_provider = "${buildCodexModelProviderSlug(defaultProvider.id)}"`, "");
  }

  // Features are global to the app-server process. Always pin fail-closed defaults:
  // Codex also loads the built-in Apps catalog independently of plugins/MCP selection.
  // Disable it so cached account tools do not enter Eco sessions without being selected.
  // Role definitions stay thread-scoped via thread/start.config & thread/resume.config.
  lines.push("[features]", "remote_plugin = false", "plugins = false", "apps = false");
  if (enableMultiAgent) {
    lines.push("multi_agent = true", "hooks = true", "", "[agents]", "max_threads = 16", "max_depth = 1");
  }
  lines.push("");
  // Codex 0.152+ disables update_plan by default; Eco Plan→Todo requires it.
  lines.push("[tools.update_plan]", "enabled = true", "");

  const streamIdleTimeoutMs = resolveCodexStreamIdleTimeoutMs();
  for (const provider of gatewayProviders) {
    const slug = buildCodexModelProviderSlug(provider.id);
    lines.push(
      `[model_providers.${slug}]`,
      `name = ${tomlString(resolveCodexModelProviderName(provider, slug))}`,
      `base_url = ${tomlString(gatewayBaseUrl)}`,
      'wire_api = "responses"',
      // Local / slow models often emit no bytes for minutes during prefill.
      `stream_idle_timeout_ms = ${streamIdleTimeoutMs}`,
      `request_max_retries = ${DEFAULT_CODEX_REQUEST_MAX_RETRIES}`,
      "",
    );
  }

  for (const server of uniqueMcpServers(input.mcpServers ?? []).map(withDefaultCodexMcpToolOutputTokenLimits)) {
    lines.push(...buildCodexMcpServerTomlLines(server));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function resolveCodexModelProviderName(provider: EcoProviderForCodexConfig, slug: string): string {
  if (provider.compactionMode === "responses-native") {
    if (provider.apiCompat !== "openai_responses") {
      throw new Error(
        `Provider "${provider.id}" can use responses-native compaction only with apiCompat=openai_responses.`,
      );
    }
    // Codex selects remote compaction only for providers named exactly "OpenAI" (verified through 0.150.1).
    return "OpenAI";
  }
  return `Eco Gateway (${slug})`;
}

export async function syncCodexConfigFromEcoProviders(
  input: SyncCodexConfigFromEcoProvidersInput,
): Promise<SyncCodexConfigResult> {
  const codexHomeDir = resolveCodexHomeDir(input.ecoDataDir);
  const configPath = path.join(codexHomeDir, "config.toml");
  const gatewayBaseUrl = input.gatewayBaseUrl ?? resolveEcoGatewayBaseUrl(input.gatewayPort);
  const enabledProviders = input.providers.filter(
    (provider) => provider.enabled && provider.id !== CODEX_BUILT_IN_OPENAI_PROVIDER_ID,
  );
  const providerSlugs = enabledProviders.map((provider) => buildCodexModelProviderSlug(provider.id));
  const mcpServers = uniqueMcpServers(input.mcpServers ?? []);
  const configToml = buildCodexConfigToml({ ...input, gatewayBaseUrl, mcpServers });

  await fs.mkdir(codexHomeDir, { recursive: true });
  let managedHookTrust = "";

  // Multi-agent: PreToolUse spawn_agent fork_turns=none.
  // Dynamic import keeps node:crypto out of the renderer bundle.
  const enableMultiAgent = input.enableMultiAgent === true || (input.agentRoles ?? []).length > 0;
  if (enableMultiAgent) {
    const { syncEcoCodexHooks } = await import("./codex-hooks-sync.js");
    const hooks = await syncEcoCodexHooks({
      codexHomeDir,
      enableSpawnAgent: true,
    });
    managedHookTrust = hooks.trustTomlBlock;
  }
  await writeUtf8FileIfChanged(configPath, `${configToml}${managedHookTrust}`);

  const modelCatalogJsonPath = input.modelCatalogJsonPath?.trim() || undefined;
  return {
    codexHomeDir,
    configPath,
    gatewayBaseUrl,
    providerSlugs,
    mcpServerNames: mcpServers.map((server) => server.name),
    ...(providerSlugs[0] ? { defaultProviderSlug: providerSlugs[0] } : {}),
    ...(modelCatalogJsonPath ? { modelCatalogJsonPath } : {}),
  };
}

async function writeUtf8FileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if ((await fs.readFile(filePath, "utf8")) === content) {
      return;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

export function codexConfigContainsUpstreamSecret(
  configToml: string,
  secrets: readonly string[],
): string | undefined {
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (!trimmed) {
      continue;
    }
    if (configToml.includes(trimmed)) {
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

function tomlInlineTable(entries: Record<string, string>): string {
  const parts = Object.entries(entries).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`);
  return `{ ${parts.join(", ")} }`;
}

export function buildCodexMcpServerTomlLines(server: CodexMcpServerForConfigSync): string[] {
  const name = server.name.trim();
  if (!name) {
    throw new Error("Codex MCP server name is required.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid Codex MCP server name: ${name}`);
  }

  const lines: string[] = [`[mcp_servers.${name}]`];
  if (server.transport === "stdio") {
    const command = server.command?.trim();
    if (!command) {
      throw new Error(`Codex MCP server "${name}" requires a stdio command.`);
    }
    lines.push(`command = ${tomlString(command)}`);
    if (server.args && server.args.length > 0) {
      lines.push(`args = ${tomlStringArray(server.args)}`);
    }
  } else if (server.transport === "http") {
    const url = server.url?.trim();
    if (!url) {
      throw new Error(`Codex MCP server "${name}" requires an HTTP URL.`);
    }
    lines.push(`url = ${tomlString(url)}`);
    if (server.httpHeaders && Object.keys(server.httpHeaders).length > 0) {
      lines.push(`http_headers = ${tomlInlineTable(server.httpHeaders)}`);
    }
  } else {
    throw new Error(`Unsupported Codex MCP transport for "${name}".`);
  }

  if (server.enabledTools && server.enabledTools.length > 0) {
    lines.push(`enabled_tools = ${tomlStringArray(server.enabledTools)}`);
  }
  if (
    typeof server.startupTimeoutSec === "number" &&
    Number.isFinite(server.startupTimeoutSec) &&
    server.startupTimeoutSec > 0
  ) {
    lines.push(`startup_timeout_sec = ${Math.ceil(server.startupTimeoutSec)}`);
  }
  if (
    typeof server.toolTimeoutSec === "number" &&
    Number.isFinite(server.toolTimeoutSec) &&
    server.toolTimeoutSec > 0
  ) {
    lines.push(`tool_timeout_sec = ${Math.ceil(server.toolTimeoutSec)}`);
  }
  lines.push("enabled = true", "");

  if (server.transport === "stdio" && server.env && Object.keys(server.env).length > 0) {
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [key, value] of Object.entries(server.env)) {
      const envKey = key.trim();
      if (!envKey) {
        continue;
      }
      lines.push(`${envKey} = ${tomlString(value)}`);
    }
    lines.push("");
  }

  const toolLimits = server.toolOutputTokenLimits ?? {};
  for (const [toolName, limit] of Object.entries(toolLimits)) {
    const trimmedTool = toolName.trim();
    if (!trimmedTool || !Number.isFinite(limit) || limit <= 0) {
      continue;
    }
    lines.push(
      `[mcp_servers.${name}.tools.${tomlBareKey(trimmedTool)}]`,
      `output_token_limit = ${Math.ceil(limit)}`,
      "",
    );
  }

  return lines;
}

/** TOML bare keys for tool names; quote when not a simple identifier. */
function tomlBareKey(key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
    return key;
  }
  return tomlString(key);
}

/**
 * Default per-tool model-facing budgets for Eco-hosted MCP servers (Codex 0.152+).
 * Conservative for status tools; higher for snapshots / vision reports.
 */
export function defaultCodexMcpToolOutputTokenLimits(
  serverName: string,
): Record<string, number> | undefined {
  switch (serverName.trim()) {
    case "eco_agent_browser":
      return {
        snapshot: 8_000,
        screenshot: 2_000,
        get_text: 6_000,
        get_title: 512,
        get_url: 512,
        read: 8_000,
        eval: 4_000,
      };
    case "eco_computer_use":
      return {
        get_app_state: 8_000,
        list_apps: 2_000,
        click: 1_024,
        type_text: 1_024,
        press_key: 1_024,
        scroll: 1_024,
        drag: 1_024,
        set_value: 1_024,
        perform_secondary_action: 2_000,
      };
    case "eco_image_view":
      return { view_image: 6_000 };
    case "eco_image_display":
      return { display_image: 1_024 };
    case "eco_image_generation":
      return { create_image: 2_000 };
    case "eco_html_host":
      return { publish_html: 2_000 };
    case "eco_web_search":
      return { web_search: 4_000 };
    default:
      return undefined;
  }
}

/** Attach Eco defaults when the caller did not set per-tool limits. */
export function withDefaultCodexMcpToolOutputTokenLimits(
  server: CodexMcpServerForConfigSync,
): CodexMcpServerForConfigSync {
  if (server.toolOutputTokenLimits && Object.keys(server.toolOutputTokenLimits).length > 0) {
    return server;
  }
  const defaults = defaultCodexMcpToolOutputTokenLimits(server.name);
  if (!defaults) {
    return server;
  }
  return { ...server, toolOutputTokenLimits: defaults };
}

function uniqueAgentRoles(roles: readonly CodexAgentRoleForConfigSync[]): CodexAgentRoleForConfigSync[] {
  const seen = new Set<string>();
  const result: CodexAgentRoleForConfigSync[] = [];
  for (const role of roles) {
    const roleId = role.roleId.trim();
    if (!roleId || seen.has(roleId)) {
      continue;
    }
    seen.add(roleId);
    result.push({
      roleId,
      description: role.description,
      configFile: role.configFile,
    });
  }
  return result;
}

function uniqueMcpServers(servers: readonly CodexMcpServerForConfigSync[]): CodexMcpServerForConfigSync[] {
  const seen = new Set<string>();
  const result: CodexMcpServerForConfigSync[] = [];
  for (const server of servers) {
    const name = server.name.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    result.push({ ...server, name });
  }
  return result;
}
