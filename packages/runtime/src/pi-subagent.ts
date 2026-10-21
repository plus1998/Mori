import type { AgentEvent } from "../../shared/src";
import type {
  EcoAgentInstanceConfig,
  EcoAgentRuntimeConfig,
  EcoAgentTemplateConfig,
  EcoToolPolicy,
} from "./agent-orchestration.js";
import { PI_CODEMODE_TOOL_NAME } from "./pi-codemode.js";
import { PI_MCP_HUB_TOOL_NAMES } from "./pi-mcp.js";
import { PI_WEB_SEARCH_TOOL_NAME, type PiWebSearchBackend } from "./pi-web-search-plan.js";
import { materializeEcoToolPolicy } from "./tool-permission-policy.js";

export const PI_AGENT_TOOL_NAME = "Agent" as const;

/** Soft truncate for LLM-facing subagent tool results (align with Pi tool defaults). */
export const PI_SUBAGENT_RESULT_MAX_LINES = 2000;
export const PI_SUBAGENT_RESULT_MAX_BYTES = 50 * 1024;

export interface PiEnabledSubagent {
  agentKey: string;
  displayName: string;
  description: string;
  prompt: string;
  modelRef: EcoAgentInstanceConfig["modelRef"];
  tools: EcoToolPolicy;
  mcpServers: string[];
  skills: string[];
  template: EcoAgentTemplateConfig;
}

export interface PiSubagentSpawnInput {
  threadId: string;
  parentToolUseId: string;
  agentKey: string;
  task: string;
  signal?: AbortSignal;
  /** Push Eco feed events while the child runs (parent prompt drains this). */
  emitEvent: (event: AgentEvent) => void;
}

export interface PiSubagentSpawnResult {
  agentId: string;
  agentKey: string;
  text: string;
  truncated: boolean;
}

export type PiSubagentSpawnHandler = (input: PiSubagentSpawnInput) => Promise<PiSubagentSpawnResult>;

export function listEnabledPiSubagents(registry: EcoAgentRuntimeConfig | undefined): PiEnabledSubagent[] {
  if (!registry) {
    return [];
  }
  const templateById = new Map(registry.templates.map((template) => [template.id, template]));
  const out: PiEnabledSubagent[] = [];
  for (const agent of registry.orchestration.agents) {
    if (!agent.enabled) {
      continue;
    }
    const agentKey = agent.agentKey.trim();
    if (!agentKey || agentKey === "main") {
      continue;
    }
    const template = templateById.get(agent.templateId);
    if (!template) {
      throw new Error(`Missing agent template for ${agentKey}: ${agent.templateId}`);
    }
    out.push({
      agentKey,
      displayName: agent.displayName?.trim() || template.name,
      description: buildPiSubagentDescription(agent, template),
      prompt: template.prompt,
      modelRef: agent.modelRef,
      tools: materializeEcoToolPolicy(
        agent.tools.allowed.length > 0 || agent.tools.disallowed.length > 0
          ? agent.tools
          : template.defaultTools,
      ),
      mcpServers: [
        ...new Set([...template.mcpServers, ...agent.mcpServers].map((name) => name.trim()).filter(Boolean)),
      ],
      skills: [...new Set([...template.skills, ...agent.skills].map((s) => s.trim()).filter(Boolean))],
      template,
    });
  }
  return out;
}

export function buildPiSubagentDescription(
  agent: EcoAgentInstanceConfig,
  template: EcoAgentTemplateConfig,
): string {
  const displayName = agent.displayName?.trim() || template.name;
  return [
    `${displayName}: ${template.description.trim()}`,
    `Use when: ${template.whenToUse.trim()}`,
    template.outputContract?.trim() ? `Output: ${template.outputContract.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Map Eco tool policy → PI built-in allowlist.
 * Never includes Agent (no nested delegation).
 */
export function resolvePiSubagentToolAllowlist(
  policy: EcoToolPolicy,
  hasMcpServers: boolean,
  options?: { webSearchBackend?: PiWebSearchBackend },
): string[] {
  const materialized = materializeEcoToolPolicy(policy);
  const disallowed = new Set(
    materialized.disallowed.map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );
  const tools: string[] = [];

  const readBlocked =
    materialized.filesystem?.read === "none" ||
    disallowed.has("read") ||
    disallowed.has("readfile") ||
    disallowed.has("grep");
  if (!readBlocked) {
    tools.push("read");
  }

  const writeBlocked =
    materialized.filesystem?.write === "none" ||
    disallowed.has("write") ||
    disallowed.has("writefile") ||
    disallowed.has("edit") ||
    disallowed.has("editfile");
  if (!writeBlocked) {
    tools.push("edit", "write");
  }

  const bashBlocked = materialized.bash?.enabled === false || disallowed.has("bash");
  if (!bashBlocked) {
    tools.push("bash");
  }

  if (hasMcpServers) {
    tools.push(...PI_MCP_HUB_TOOL_NAMES);
  }

  // Same codemode policy as the Agent session mode: scripts may only reach the
  // tools this subagent was already granted (the sandbox resolves calls through
  // this session's registry). Agent stays out of the list above, so a script
  // cannot delegate a nested subagent.
  tools.push(PI_CODEMODE_TOOL_NAME);

  const webSearchAllowed =
    materialized.network?.webSearch !== false &&
    options?.webSearchBackend !== undefined &&
    options.webSearchBackend !== "none";
  if (webSearchAllowed) {
    tools.push(PI_WEB_SEARCH_TOOL_NAME);
  }

  return [...new Set(tools)];
}

export function truncatePiSubagentResult(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized) {
    return { text: "(no output)", truncated: false };
  }
  const lines = normalized.split("\n");
  let truncated = false;
  let next = normalized;
  if (lines.length > PI_SUBAGENT_RESULT_MAX_LINES) {
    next = lines.slice(-PI_SUBAGENT_RESULT_MAX_LINES).join("\n");
    truncated = true;
  }
  while (Buffer.byteLength(next, "utf8") > PI_SUBAGENT_RESULT_MAX_BYTES && next.length > 0) {
    const cut = Math.max(1, Math.floor(next.length * 0.15));
    next = next.slice(cut);
    truncated = true;
  }
  if (!truncated) {
    return { text: next, truncated: false };
  }
  return {
    text: `${next}\n\n[truncated: showing last ${PI_SUBAGENT_RESULT_MAX_LINES} lines / ${PI_SUBAGENT_RESULT_MAX_BYTES} bytes]`,
    truncated: true,
  };
}

export function piParentSessionKey(threadId: string): string {
  return threadId.trim();
}

export function piChildSessionKey(threadId: string, agentId: string): string {
  const id = agentId.trim();
  if (!id) {
    throw new Error("PI child session key requires a non-empty agentId.");
  }
  return `${threadId.trim()}::sub::${id}`;
}

export function isPiChildSessionKey(key: string): boolean {
  return key.includes("::sub::");
}

export function filterMcpServersForPiSubagent(
  parentMcp: Record<string, unknown> | undefined,
  assignedServers: readonly string[],
): Record<string, unknown> | undefined {
  if (!parentMcp || assignedServers.length === 0) {
    return undefined;
  }
  const allow = new Set(assignedServers.map((name) => name.trim()).filter(Boolean));
  const next: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(parentMcp)) {
    if (allow.has(name)) {
      next[name] = entry;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Collect final assistant text from child Eco events (best-effort). */
export function collectPiSubagentFinalText(events: readonly AgentEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type !== "message.delta") {
      continue;
    }
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }
    const record = payload as Record<string, unknown>;
    if (record.blockKind === "thinking") {
      continue;
    }
    const text =
      (typeof record.text === "string" && record.text) ||
      (typeof record.content === "string" && record.content) ||
      "";
    if (text) {
      chunks.push(text);
    }
  }
  return chunks.join("");
}
