import { ECO_AGENT_BROWSER_MCP_SERVER } from "./browser";
import type { ComposerReference, ComposerReferenceSearchRequest } from "./composer-references";
import { ECO_COMPUTER_USE_MCP_SERVER } from "./computer-use";
import { ECO_IMAGE_GENERATION_MCP_SERVER } from "./image-generation";
import type {
  IntegrationAvailabilitySnapshot,
  IntegrationId,
  IntegrationsEnabledSettings,
} from "./integrations";
import { sanitizeMcpServerName, type McpServerConfigView } from "./mcp";
import { ECO_TTS_MCP_SERVER } from "./tts";

export interface ComposerCapabilityReference extends ComposerReference {
  kind: "integration" | "subagent" | "mcp";
  server?: string;
  agentKey?: string;
  searchTerms: string;
}
const INTEGRATIONS: Record<IntegrationId, { label: string; server: string; aliases: string }> = {
  browser: { label: "浏览器", server: ECO_AGENT_BROWSER_MCP_SERVER, aliases: "browser 浏览器 网页操作" },
  imageGeneration: {
    label: "创意绘画",
    server: ECO_IMAGE_GENERATION_MCP_SERVER,
    aliases: "imageGeneration image drawing 创意绘画 绘图 图片生成",
  },
  tts: { label: "语音生成", server: ECO_TTS_MCP_SERVER, aliases: "tts speech voice 语音生成" },
  computerUse: {
    label: "电脑操控",
    server: ECO_COMPUTER_USE_MCP_SERVER,
    aliases: "computerUse computer desktop 电脑操控",
  },
};

/** Only public capability metadata. Never spread MCP configs (env/headers may contain credentials). */
export function buildComposerCapabilityReferences(input: {
  availability: IntegrationAvailabilitySnapshot;
  integrationsEnabled: IntegrationsEnabledSettings;
  integrationLabels?: Partial<Record<IntegrationId, string>>;
  mcpServers: readonly Pick<McpServerConfigView, "id" | "name" | "enabled" | "transport">[];
  mcpServersEnabled: Record<string, boolean>;
  agents: readonly { agentKey: string; name: string; modelId: string; enabled: boolean }[];
}): ComposerCapabilityReference[] {
  const integrations: ComposerCapabilityReference[] = input.availability.integrations.flatMap((item) => {
    if (!item.enabled || !item.available || input.integrationsEnabled[item.id] !== true) return [];
    const definition = INTEGRATIONS[item.id];
    return [
      {
        kind: "integration",
        id: item.id,
        label: input.integrationLabels?.[item.id] ?? definition.label,
        detail: item.activeProfileName ?? "",
        server: definition.server,
        searchTerms: definition.aliases,
      },
    ];
  });
  const agents: ComposerCapabilityReference[] = input.agents
    .filter((agent) => agent.enabled && agent.agentKey.trim() && agent.modelId.trim())
    .map((agent) => ({
      kind: "subagent",
      id: agent.agentKey,
      label: agent.name,
      detail: agent.modelId,
      agentKey: agent.agentKey,
      searchTerms: `子代理 subagent ${agent.agentKey}`,
    }));
  const servers: ComposerCapabilityReference[] = input.mcpServers.flatMap((server) => {
    if (!server.enabled || !server.name.trim()) return [];
    const key = sanitizeMcpServerName(server.name);
    if (input.mcpServersEnabled[key] !== true) return [];
    return [
      {
        kind: "mcp",
        id: server.id,
        label: server.name,
        detail: server.transport,
        server: key,
        searchTerms: `MCP ${key}`,
      },
    ];
  });
  return [...integrations, ...agents, ...servers];
}

export function filterComposerCapabilityReferences(
  items: readonly ComposerCapabilityReference[],
  request: ComposerReferenceSearchRequest,
): ComposerCapabilityReference[] {
  const query = request.query.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (!request.kind || request.kind === item.kind) &&
      `${item.label} ${item.detail} ${item.searchTerms}`.toLocaleLowerCase().includes(query),
  );
}
