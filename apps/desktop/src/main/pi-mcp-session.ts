import { ECO_TTS_MCP_SERVER } from "../shared/tts";
import path from "node:path";
import { ECO_IMAGE_VIEW_MCP_SERVER } from "@eco/runtime";
import { ECO_AGENT_BROWSER_MCP_SERVER } from "../shared/browser";
import { ECO_COMPUTER_USE_MCP_SERVER } from "../shared/computer-use";
import { ECO_HTML_HOST_MCP_SERVER } from "../shared/html-host-tool";
import { ECO_IMAGE_DISPLAY_MCP_SERVER } from "../shared/image-display-tool";
import { ECO_IMAGE_GENERATION_MCP_SERVER } from "../shared/image-generation";
import type { McpSdkConfig } from "../shared/mcp";
import { filterMcpSdkConfigByAssignedServers, sanitizeMcpServerName } from "../shared/mcp";
import { mergeEcoMcpHubPromptParts } from "../shared/mcp-hub-tool-usage";
import { prepareMcpSdkConfigForRuntime } from "./mcp-runtime";

export type PiMcpSessionResolution = {
  mcpServers: Record<string, unknown>;
  appendSystemPrompt: string[];
  /** Absolute skill directories to merge into PI skillPaths (e.g. browser skill). */
  extraSkillDirectories: string[];
};

/**
 * Join Eco personalization + integration guidance for PI `appendSystemPrompt`.
 * Global rules come first (same order as Claude/Codex `mergeMainAgentAppendParts`).
 */
export function mergePiAppendSystemPrompt(parts: {
  globalUserRules?: string;
  integrationAppend?: readonly string[];
}): string[] {
  const rules = parts.globalUserRules?.trim() ?? "";
  return mergeEcoMcpHubPromptParts([...(rules ? [rules] : []), ...(parts.integrationAppend ?? [])]);
}

/**
 * Build isolated PI MCP config from Eco global store + Composer selection + integrations.
 * Mirrors Claude `buildSdkSessionOptions` filtering, without ambient .mcp.json.
 */
export function buildPiMcpSessionConfig(input: {
  globalSdkConfig: McpSdkConfig;
  enabledMcpServerKeys: readonly string[];
  browserInject: {
    enabled: boolean;
    sdkEntry?: Record<string, unknown>;
    promptAppend?: string;
  };
  computerUseInject?: {
    enabled: boolean;
    sdkEntry?: Record<string, unknown>;
    promptAppend?: string;
  };
  imageInject: {
    enabled: boolean;
    sdkEntry?: Record<string, unknown>;
    promptAppend?: string;
  };
  ttsInject?: {
    enabled: boolean;
    sdkEntry?: Record<string, unknown>;
    promptAppend?: string;
  };
  imageViewInject?: {
    enabled: boolean;
    sdkEntry?: Record<string, unknown>;
    promptAppend?: string;
  };
  imageDisplayInject?: {
    enabled: boolean;
    sdkEntry?: Record<string, unknown>;
    promptAppend?: string;
  };
  htmlHostInject?: {
    enabled: boolean;
    sdkEntry?: Record<string, unknown>;
    promptAppend?: string;
  };
  /** Absolute directory containing eco-agent-browser SKILL.md when browser is enabled. */
  browserSkillDirectory?: string;
}): PiMcpSessionResolution {
  const assignedUserKeys = input.enabledMcpServerKeys
    .map((key) => sanitizeMcpServerName(key))
    .filter(
      (key) =>
        key !== ECO_AGENT_BROWSER_MCP_SERVER &&
        !key.startsWith("eco_ab_") &&
        key !== ECO_COMPUTER_USE_MCP_SERVER &&
        key !== ECO_IMAGE_GENERATION_MCP_SERVER &&
        key !== ECO_TTS_MCP_SERVER &&
        key !== ECO_IMAGE_VIEW_MCP_SERVER &&
        key !== ECO_IMAGE_DISPLAY_MCP_SERVER &&
        key !== ECO_HTML_HOST_MCP_SERVER,
    );

  const filtered = filterMcpSdkConfigByAssignedServers(input.globalSdkConfig, assignedUserKeys);

  const mcpServers: Record<string, unknown> = { ...filtered.mcpServers };
  const appendSystemPrompt: string[] = [];
  const extraSkillDirectories: string[] = [];

  if (input.browserInject.enabled && input.browserInject.sdkEntry) {
    mcpServers[ECO_AGENT_BROWSER_MCP_SERVER] = input.browserInject.sdkEntry;
    if (input.browserInject.promptAppend?.trim()) {
      appendSystemPrompt.push(input.browserInject.promptAppend.trim());
    }
    if (input.browserSkillDirectory?.trim()) {
      extraSkillDirectories.push(path.resolve(input.browserSkillDirectory.trim()));
    }
  }

  if (input.computerUseInject?.enabled && input.computerUseInject.sdkEntry) {
    mcpServers[ECO_COMPUTER_USE_MCP_SERVER] = input.computerUseInject.sdkEntry;
    if (input.computerUseInject.promptAppend?.trim()) {
      appendSystemPrompt.push(input.computerUseInject.promptAppend.trim());
    }
  }

  if (input.imageInject.enabled && input.imageInject.sdkEntry) {
    mcpServers[ECO_IMAGE_GENERATION_MCP_SERVER] = input.imageInject.sdkEntry;
    if (input.imageInject.promptAppend?.trim()) {
      appendSystemPrompt.push(input.imageInject.promptAppend.trim());
    }
  }

  if (input.ttsInject?.enabled && input.ttsInject.sdkEntry) {
    mcpServers[ECO_TTS_MCP_SERVER] = input.ttsInject.sdkEntry;
    if (input.ttsInject.promptAppend?.trim()) {
      appendSystemPrompt.push(input.ttsInject.promptAppend.trim());
    }
  }

  if (input.imageViewInject?.enabled && input.imageViewInject.sdkEntry) {
    mcpServers[ECO_IMAGE_VIEW_MCP_SERVER] = input.imageViewInject.sdkEntry;
    if (input.imageViewInject.promptAppend?.trim()) {
      appendSystemPrompt.push(input.imageViewInject.promptAppend.trim());
    }
  }

  if (input.imageDisplayInject?.enabled && input.imageDisplayInject.sdkEntry) {
    mcpServers[ECO_IMAGE_DISPLAY_MCP_SERVER] = input.imageDisplayInject.sdkEntry;
    if (input.imageDisplayInject.promptAppend?.trim()) {
      appendSystemPrompt.push(input.imageDisplayInject.promptAppend.trim());
    }
  }

  if (input.htmlHostInject?.enabled && input.htmlHostInject.sdkEntry) {
    mcpServers[ECO_HTML_HOST_MCP_SERVER] = input.htmlHostInject.sdkEntry;
    if (input.htmlHostInject.promptAppend?.trim()) {
      appendSystemPrompt.push(input.htmlHostInject.promptAppend.trim());
    }
  }

  const runtime = prepareMcpSdkConfigForRuntime({
    mcpServers,
    allowedTools: filtered.allowedTools,
  });

  return {
    mcpServers: runtime.mcpServers,
    appendSystemPrompt,
    extraSkillDirectories: [...new Set(extraSkillDirectories)].sort((a, b) => a.localeCompare(b)),
  };
}
