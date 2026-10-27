import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeAgentRole } from "../../shared/src";
import {
  ecoSubagentKeyForRole,
  isSubagentRole,
  SUBAGENT_ROLES,
  type SubagentRole,
} from "./subagent-availability.js";

/** Map SDK subagent_type values to Eco subagent roles. */
export function normalizeSdkSubagentType(type: string): RuntimeAgentRole | undefined {
  const trimmed = type.trim();
  if (!trimmed) {
    return undefined;
  }
  for (const role of SUBAGENT_ROLES) {
    if (trimmed === ecoSubagentKeyForRole(role)) {
      return role;
    }
  }
  if (isSubagentRole(trimmed)) {
    return trimmed;
  }
  return normalizeDynamicEcoAgentRole(trimmed);
}

export function normalizeAgentToolInputSubagentType(input: Record<string, unknown>): {
  input: Record<string, unknown>;
  role?: RuntimeAgentRole;
  changed: boolean;
} {
  const rawType = readAgentSubagentType(input);
  const role = rawType ? normalizeSdkSubagentType(rawType) : undefined;
  if (!role) {
    return { input, changed: false };
  }
  const nextType = ecoAgentKeyForRuntimeRole(role);
  if (input.subagent_type === nextType && input.agent_type === undefined) {
    return { input, role, changed: false };
  }
  const nextInput: Record<string, unknown> = { ...input, subagent_type: nextType };
  delete nextInput.agent_type;
  return { input: nextInput, role, changed: true };
}

export function readAgentSubagentType(input: Record<string, unknown>): string | undefined {
  if (typeof input.subagent_type === "string" && input.subagent_type.trim()) {
    return input.subagent_type.trim();
  }
  if (typeof input.agent_type === "string" && input.agent_type.trim()) {
    return input.agent_type.trim();
  }
  // PI Agent tool names the child agent key `agent` (e.g. smoke_worker).
  if (typeof input.agent === "string" && input.agent.trim()) {
    return input.agent.trim();
  }
  return undefined;
}

const FRESH_SUBAGENT_PATTERNS = [
  /\bfresh\b/i,
  /\brestart\b/i,
  /\bfrom\s+scratch\b/i,
  /\bnew\s+explore\b/i,
  /\bnew\s+agent\b/i,
  /重新探索/,
  /全新/,
  /从头开始/,
  /重新开始/,
  /不要恢复/,
  /无需恢复/,
];

export function isFreshSubagentRequest(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return false;
  }
  return FRESH_SUBAGENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function buildResumeAgentPrompt(agentId: string, originalPrompt: string): string {
  const task = originalPrompt.trim() || "Continue the previous task from where you left off.";
  if (/^\s*Resume\s+agent\s+/i.test(task)) {
    return task;
  }
  return `Resume agent ${agentId} and ${task}`;
}

export type SubagentResumeResolveInput = {
  threadId: string;
  role: RuntimeAgentRole;
  phase: "planning" | "execution" | "ask";
  prompt: string;
  todoIdHint?: string;
};

export function createSubagentMissionCapturePreToolHook(
  onCapture: (input: { role: RuntimeAgentRole; prompt: string; todoIdHint?: string }) => void,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "Agent" && preInput.tool_name !== "Task") {
      return {};
    }
    const rawToolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const { input: toolInput, role: subagentType } = normalizeAgentToolInputSubagentType(rawToolInput);
    if (!subagentType) {
      return {};
    }
    const originalPrompt =
      (typeof toolInput.prompt === "string" && toolInput.prompt) ||
      (typeof toolInput.task === "string" && toolInput.task) ||
      (typeof toolInput.description === "string" && toolInput.description) ||
      "";
    onCapture({
      role: subagentType,
      prompt: originalPrompt,
      ...(typeof toolInput.eco_todo_id === "string" && { todoIdHint: toolInput.eco_todo_id }),
    });
    return {};
  };
}

export function formatResumableSubagentsAppend(
  entries: readonly { role: string; agentId: string }[],
): string {
  if (entries.length === 0) {
    return "";
  }
  const lines = entries.map((entry) => `- ${entry.role}: ${entry.agentId}`);
  return [
    "",
    "Resumable subagents in this thread (Mori will auto-Resume when you call the same eco_* Agent key again):",
    ...lines,
    "To force a fresh subagent, include words like fresh/restart/从头开始 in the Agent prompt.",
  ].join("\n");
}

export interface SubagentResumeHookOptions {
  todoIdHint?: () => string | undefined;
}

export function createSubagentResumePreToolHook(
  threadId: string,
  phase: SubagentResumeResolveInput["phase"],
  resolve: (input: SubagentResumeResolveInput) => string | undefined,
  options?: SubagentResumeHookOptions,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "Agent" && preInput.tool_name !== "Task") {
      return {};
    }

    const rawToolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const { input: toolInput, role: subagentType } = normalizeAgentToolInputSubagentType(rawToolInput);
    if (!subagentType) {
      return {};
    }

    const originalPrompt =
      (typeof toolInput.prompt === "string" && toolInput.prompt) ||
      (typeof toolInput.task === "string" && toolInput.task) ||
      (typeof toolInput.description === "string" && toolInput.description) ||
      "";

    const todoIdHint =
      (typeof toolInput.eco_todo_id === "string" && toolInput.eco_todo_id) || options?.todoIdHint?.();

    if (isFreshSubagentRequest(originalPrompt)) {
      return {};
    }

    const agentId = resolve({
      threadId,
      role: subagentType,
      phase,
      prompt: originalPrompt,
      ...(todoIdHint && { todoIdHint }),
    });
    if (!agentId) {
      return {};
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: {
          ...toolInput,
          prompt: buildResumeAgentPrompt(agentId, originalPrompt),
        },
      },
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDynamicEcoAgentRole(type: string): RuntimeAgentRole | undefined {
  if (!type.startsWith("eco_")) {
    return undefined;
  }
  return sanitizeRuntimeAgentRole(type.slice(4));
}

function ecoAgentKeyForRuntimeRole(role: RuntimeAgentRole): string {
  if (isSubagentRole(role)) {
    return ecoSubagentKeyForRole(role);
  }
  const sanitized = sanitizeRuntimeAgentRole(role) ?? "agent";
  return sanitized.startsWith("eco_") ? sanitized : `eco_${sanitized}`;
}

function sanitizeRuntimeAgentRole(value: string): RuntimeAgentRole | undefined {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || undefined;
}
