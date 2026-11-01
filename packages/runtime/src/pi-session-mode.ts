/**
 * PI session mode (agent / plan / ask): tool allowlists, read-only bash policy,
 * and mode-aware wrapping of Eco tool permission handlers.
 */
import type { SdkToolPermissionHandler } from "./ask-user-question.js";
import type { SdkToolPermissionDecision, SdkToolPermissionRequest } from "./claude-agent-sdk.js";
import type { CoreSessionMode } from "./core-runtime.js";
import { PI_CODEMODE_TOOL_NAME } from "./pi-codemode.js";
import { PI_MCP_HUB_TOOL_NAMES } from "./pi-mcp.js";
import { PI_AGENT_TOOL_NAME } from "./pi-subagent.js";
import { PI_WEB_SEARCH_TOOL_NAME } from "./pi-web-search-plan.js";

export const PI_FINALIZE_PLAN_TOOL_NAME = "finalize_plan" as const;

export const PI_READ_ONLY_BUILTIN_TOOLS = ["read", "bash"] as const;
export const PI_WRITE_BUILTIN_TOOLS = ["edit", "write"] as const;

const PI_ASK_PLAN_DENY_TOOLS = new Set(
  [...PI_WRITE_BUILTIN_TOOLS, "Edit", "Write", "MultiEdit", "NotebookEdit", PI_AGENT_TOOL_NAME, "Agent"].map(
    (name) => name.toLowerCase(),
  ),
);

/** Destructive / mutating patterns — fail closed if matched. */
const DESTRUCTIVE_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\$\(/,
  /`/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bbun\s+(add|install|remove|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

/** Safe read-only command prefixes (whole command must match one). */
const SAFE_BASH_PATTERNS: readonly RegExp[] = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
  /^\s*yarn\s+(list|info|why|audit)\b/i,
  /^\s*node\s+--version\b/i,
  /^\s*python(?:3)?\s+--version\b/i,
  /^\s*bun\s+--version\b/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n\b/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
];

/** cd / cd - / cd /d X — navigation only, no side effects. */
const CD_COMMAND_PATTERN = /^\s*cd(?:\s+\S+){0,2}$/;

export function isPiReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  // Safe redirections (discarding output / fd duping) are not mutations;
  // strip them before the chaining/destructive checks.
  const normalized = trimmed
    .replace(/\d*>\s*\/dev\/null/g, " ")
    .replace(/\d*>\s*&\d+/g, " ")
    .trim();
  if (!normalized) {
    return false;
  }
  // Fail closed on backgrounding (lone &) and logical-OR chains.
  if (/(^|[^&])&(?![&])/.test(normalized) || normalized.includes("||")) {
    return false;
  }
  if (DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const isSafeSegment = (segment: string): boolean =>
    CD_COMMAND_PATTERN.test(segment) || SAFE_BASH_PATTERNS.some((pattern) => pattern.test(segment));

  // Allow read-only chains: each && / ; link, and each | stage within it,
  // must be cd or an allowlisted read-only command.
  const chains = normalized.split(/&&|;/).map((chain) => chain.trim());
  const allStages: string[] = [];
  if (chains.length > 1) {
    for (const chain of chains) {
      if (!chain) {
        return false;
      }
      const stages = chain.includes("|") ? chain.split("|").map((stage) => stage.trim()) : [chain];
      if (!stages.every(isSafeSegment)) {
        return false;
      }
      allStages.push(...stages);
    }
  } else if (normalized.includes("|")) {
    const segments = normalized.split("|").map((part) => part.trim());
    if (!segments.every(isSafeSegment)) {
      return false;
    }
    allStages.push(...segments);
  } else {
    allStages.push(normalized);
  }

  // At least one real read-only command is required (cd-only does nothing).
  return allStages.some((stage) => !CD_COMMAND_PATTERN.test(stage) && isSafeSegment(stage));
}

export function piToolsForSessionMode(
  mode: CoreSessionMode,
  options?: {
    hasMcpServers?: boolean;
    includeFinalizePlan?: boolean;
    includeWebSearch?: boolean;
  },
): string[] {
  const webSearchTools = options?.includeWebSearch ? [PI_WEB_SEARCH_TOOL_NAME] : [];
  if (mode === "agent") {
    const base = ["read", "bash", "edit", "write", ...webSearchTools];
    return [
      ...base,
      ...(options?.hasMcpServers ? PI_MCP_HUB_TOOL_NAMES : []),
      // Ask/Plan are built below from the read-only set and never see codemode.
      PI_CODEMODE_TOOL_NAME,
    ];
  }
  const tools: string[] = [...PI_READ_ONLY_BUILTIN_TOOLS, ...webSearchTools];
  if (mode === "plan" && options?.hasMcpServers) {
    tools.push(...PI_MCP_HUB_TOOL_NAMES);
  }
  if (mode === "plan" && options?.includeFinalizePlan !== false) {
    tools.push(PI_FINALIZE_PLAN_TOOL_NAME);
  }
  return tools;
}

export function piSystemPromptForSessionMode(mode: CoreSessionMode): string {
  if (mode === "ask") {
    return [
      "You may use read and read-only bash commands to inspect the codebase.",
      "You MUST NOT modify files, create files, or run mutating shell commands.",
      "Answer clearly and concisely.",
    ].join(" ");
  }
  if (mode === "plan") {
    return [
      "Use read, bash, web search, and available MCP tools to research the plan, including reading referenced todos and their images. Do not modify project files or perform implementation actions.",
      "When the plan is ready you MUST invoke the finalize_plan tool with the complete Markdown plan, then stop.",
      "Writing the plan only in assistant text does not submit it. Do not implement changes in this turn.",
    ].join(" ");
  }
  return "";
}

export type PiPlanSubmittedHandler = (input: { plan: string; toolCallId: string }) => void;

export interface CreatePiModeAwareToolPermissionHandlerInput {
  mode: CoreSessionMode;
  baseHandler: SdkToolPermissionHandler;
}

function deny(message: string, interrupt = true): SdkToolPermissionDecision {
  return { behavior: "deny", message, interrupt };
}

function allow(input: Record<string, unknown>): SdkToolPermissionDecision {
  return { behavior: "allow", updatedInput: input };
}

function readBashCommand(input: Record<string, unknown>): string {
  const command = input.command;
  return typeof command === "string" ? command : "";
}

function readFinalizePlanText(input: Record<string, unknown>): string {
  const plan = input.plan ?? input.planMarkdown ?? input.content;
  return typeof plan === "string" ? plan.trim() : "";
}

/**
 * Wrap Eco's PI tool permission handler with Ask/Plan hard gates.
 * Agent mode is a pure passthrough to baseHandler.
 * Plan: research tools use the normal permission handler; write tools are denied.
 * Ask: write tools denied; `read` goes through Eco (workspace auto-allow /
 * external ask); read-only bash allowlist is mode-gated then allowed without Eco
 * bash confirmation; finalize_plan is allowed immediately (Codex-style).
 */
export function createPiModeAwareToolPermissionHandler(
  input: CreatePiModeAwareToolPermissionHandlerInput,
): SdkToolPermissionHandler {
  const { mode, baseHandler } = input;
  if (mode === "agent") {
    return baseHandler;
  }

  return async (request: SdkToolPermissionRequest): Promise<SdkToolPermissionDecision> => {
    const toolKey = request.toolName.trim().toLowerCase();

    if (toolKey === PI_FINALIZE_PLAN_TOOL_NAME) {
      if (mode !== "plan") {
        return deny("finalize_plan is only available in Plan mode.");
      }
      const plan = readFinalizePlanText(request.input);
      if (!plan) {
        return deny("finalize_plan requires a non-empty plan Markdown string.");
      }
      return allow(request.input);
    }

    if (PI_ASK_PLAN_DENY_TOOLS.has(toolKey)) {
      return deny(`Tool "${request.toolName}" is not allowed.`);
    }

    if (mode === "plan" && (toolKey === "bash" || toolKey.startsWith("mcp__"))) {
      return baseHandler(request);
    }

    if (toolKey === "bash") {
      const command = readBashCommand(request.input);
      if (!isPiReadOnlyBashCommand(command)) {
        // Non-interrupting: surface the block as a tool error so the model
        // can adjust (e.g. drop a redirect) instead of aborting the turn.
        return deny(
          `Non-read-only bash is blocked. Use read or an allowlisted read-only command. Redirection to /dev/null is allowed.\nCommand: ${command}`,
          false,
        );
      }
      return allow(request.input);
    }

    // Align with Agent: Eco filesystem scope decides (workspace allow / external ask).
    if (toolKey === "read") {
      return baseHandler(request);
    }

    if (toolKey === PI_WEB_SEARCH_TOOL_NAME || toolKey === "websearch") {
      return baseHandler(request);
    }

    // Unknown / extension tools remain unavailable; Ask also excludes MCP.
    return deny(`Tool "${request.toolName}" is not allowed.`);
  };
}
