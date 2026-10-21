import type { ResolvedModelRoute } from "../../model-router/src";
import {
  type AgentEvent,
  type AgentEventType,
  type AgentRole,
  type ClaudeRunTerminal,
  createAgentEvent,
  type PlanReadyPayload,
  type RuntimeAgentRole,
} from "../../shared/src";
import { formatSubagentMissionMessage } from "./agent-mission";
import {
  buildClaudeCodeSystemPrompt,
  buildMainAgentSystemPrompt,
  buildToolPermissionPolicyFromOrchestration,
  createAgentDefinitionsFromOrchestration,
  resolveMainAgentAllowedTools,
  SDK_DELEGATION_SUPPORT_TOOL_NAMES,
  SDK_FILESYSTEM_READ_TOOL_NAMES,
  SDK_FILESYSTEM_WRITE_TOOL_NAMES,
  SDK_SKILL_TOOL_NAME,
  SDK_TASK_PROGRESS_TOOL_NAMES,
} from "./agent-orchestration.js";
import { expandAssistantMessageContent } from "./anthropic-content-normalize.js";
import { formatApiErrorUserMessage } from "./api-error.js";
import { applyClaudeSubagentCompactionWindows } from "./claude-subagent-compaction";
import {
  awaitExitPlanModeUserDecision,
  buildEcoSdkHooks,
  captureDeferredExitPlanModeFromResult,
  type EcoHookContext,
  type EcoToolPermissionDecisionAudit,
  type PlanModeToolPolicy,
  parseDeferredExitPlanModeResult,
} from "./eco-sdk-hooks.js";
import type {
  AgentRuntimeDriver,
  AgentRuntimeRunInput,
  EcoPlanningContext,
  EcoSdkResumeOptions,
  EcoSdkSessionOptions,
} from "./index";
import { SDK_TASK_READ_TOOL_NAMES } from "./sdk-tool-names.js";
import { formatSendMessageToolInputSummary } from "./send-message-tool.js";

export {
  findClaudeSessionByRecoveryTitle,
  forkClaudeSessionAt,
  resolveClaudeResumeSessionAtBeforeUserMessage,
} from "./runtime-session-compat.js";

import { toWorkspaceRelativePlanFile } from "./plan-path.js";
import { createSdkModelResolver, resolveMainSdkModelId } from "./sdk-model-alias";
import {
  applySubagentUsageAttribution,
  createAttributedAgentEvent,
  createSdkStreamContext,
  mapStreamEventToEvents,
  registerSubagentOnStreamContext,
  type SdkStreamContext,
  slimStreamEventMessage,
} from "./sdk-stream-events.js";
import { formatSkillActivityLabel, resolveSkillDisplayName } from "./skill-display";
import { mergeStreamText } from "./stream-text";
import { normalizeSdkSubagentType } from "./subagent-resume.js";
import { SubagentRuntimeLimitController } from "./subagent-runtime-limit.js";
import { mergeSdkDisallowedTools } from "./tool-permission-policy.js";
import {
  formatGrepTargetLabel,
  formatReadTargetLabel,
  resolveGrepTargetFromToolInput,
  resolveReadTargetFromToolInput,
} from "./tool-target.js";

export type { EcoHookContext, EcoPreCompactHookInput } from "./eco-sdk-hooks.js";
export { type SubagentLaunchRecord, SubagentLaunchRegistry } from "./eco-sdk-hooks.js";

import { buildAutonomousPlanContinuationPrompt } from "./prompts/autonomous.js";
import {
  executionArchitectDescription,
  executionArchitectPrompt,
  executionCoderDescription,
  executionCoderPrompt,
  executionTesterDescription,
  executionTesterPrompt,
  exploreAgentDescription,
  exploreAgentPrompt,
  planningArchitectDescription,
  planningArchitectPrompt,
  reviewerAgentPrompt,
} from "./prompts/index.js";
import {
  defaultSubagentAvailability,
  ecoSubagentKeyForRole,
  effectiveSubagentAvailability,
  filterAgentDefinitions,
  isSubagentEnabled,
  isSubagentRole,
  normalizeSubagentAvailability,
  SDK_GENERAL_PURPOSE_AGENT_KEY,
  SDK_PLAN_AGENT_KEY,
  SUBAGENT_ROLES,
  type SubagentAvailability,
  type SubagentRole,
  sdkBuiltinSubagentDenyRules,
} from "./subagent-availability.js";
import type { ThinkingEffort } from "./thinking-options.js";
import { applyThinkingToProcessEnv, applyThinkingToQueryOptions } from "./thinking-options.js";

export { isSubagentRole, SUBAGENT_ROLES, type SubagentRole };

/** Minimal user message shape for Claude Agent SDK streaming input mode. */
export type SdkUserMessage = {
  type: "user";
  message: {
    role: "user";
    content: string | Array<{ type: "text"; text: string }>;
  };
  parent_tool_use_id: string | null;
  uuid?: string;
  shouldQuery?: boolean;
};

export interface SdkInterruptReceipt {
  still_queued?: string[];
  cancelled?: string[];
}

/** Query handle returned by `sdk.query` (streaming control surface). */
export type SdkQueryHandle = AsyncIterable<unknown> & {
  close?: () => void;
  interrupt?: (options?: { cancelQueued?: boolean }) => Promise<SdkInterruptReceipt | undefined>;
  streamInput?: (stream: AsyncIterable<SdkUserMessage>) => Promise<void>;
  stopTask?: (taskId: string) => Promise<void>;
  setPermissionMode?: (
    mode: "dontAsk" | "default" | "acceptEdits" | "plan" | "bypassPermissions",
  ) => Promise<void> | void;
  getContextUsage?: (opts?: { detail?: "summary" | "full" }) => Promise<Record<string, unknown>>;
};

export interface ClaudeBackgroundTaskSnapshot {
  taskId: string;
  taskType: string;
  description: string;
}

export interface ClaudeBackgroundTasksChangedInput {
  threadId: string;
  query: SdkQueryHandle;
  tasks: readonly ClaudeBackgroundTaskSnapshot[];
}

type SdkQuery = (input: {
  prompt: string | AsyncIterable<SdkUserMessage>;
  options: Record<string, unknown>;
}) => SdkQueryHandle;

/**
 * Internal Query handle lifecycle.
 * Desktop mid-turn port maps open → accepting, closing → closing, closed → closed.
 */
export type ClaudeQueryHandlePhase = "open" | "closing" | "closed";

export interface ClaudeQueryHandle {
  query: SdkQueryHandle;
  phase: ClaudeQueryHandlePhase;
  sessionId?: string;
  /** Shared interrupt work so abort listener and finally stay idempotent. */
  interruptWork?: Promise<SdkInterruptReceipt | undefined>;
  /**
   * Mid-turn inject: one user message via the held prompt mailbox (`promptStream.push`).
   * Fails hard when phase !== open or push timeout — never fake success.
   */
  pushUserMessage(text: string, options?: { uuid?: string }): Promise<void>;
}

export class ClaudeStreamInputFailed extends Error {
  readonly code = "ClaudeStreamInputFailed";

  constructor(
    message: string,
    readonly deliveryUnknown: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ClaudeStreamInputFailed";
  }
}

export function isClaudeStreamInputDeliveryUnknown(error: unknown): boolean {
  return error instanceof ClaudeStreamInputFailed && error.deliveryUnknown;
}

/** Eco follow-up ids wrap a UUID; SDK 0.3.275+ fork points require the bare UUID. */
export function normalizeClaudeSdkUserMessageUuid(value: string): string {
  const uuid = value.startsWith("tfu_") ? value.slice(4) : value;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error("Claude SDK user messages require a valid UUID; Eco follow-up ids must contain one.");
  }
  return uuid;
}

export interface ClaudeQueryLifecycleHooks {
  onOpen?: (handle: ClaudeQueryHandle) => void | Promise<void>;
  onClosing?: (handle: ClaudeQueryHandle) => void | Promise<void>;
  onClosed?: (
    handle: ClaudeQueryHandle,
    detail: { stillQueued: string[]; cancelled: string[] },
  ) => void | Promise<void>;
}

export interface ClaudeQueryTeardownResult {
  stillQueued: string[];
  cancelled: string[];
  closed: boolean;
  interrupted: boolean;
}

/** Default deadline for draining residual iterator frames after interrupt/cancel. */
export const CLAUDE_QUERY_DRAIN_DEADLINE_MS = 2_000;

/** Default deadline for an SDK control request before force-closing the Query. */
export const CLAUDE_QUERY_CONTROL_DEADLINE_MS = 500;

/** Default deadline for mid-turn `streamInput` before declaring push failure. */
export const CLAUDE_QUERY_STREAM_INPUT_DEADLINE_MS = 10_000;

/**
 * Grace before closing the held prompt after an SDK `result`.
 * Must cover the gap where an interim `result` is followed by more `canUseTool`
 * (e.g. AskUserQuestion) on the same Query before the next iterator frame.
 */
export const CLAUDE_HELD_PROMPT_CLOSE_GRACE_MS = 75;

/**
 * Build a single-message AsyncIterable for official streaming input mode.
 * Rewind uses this with an empty prompt. Thread ask/agent path uses `createHeldPromptStream`.
 *
 * `ecoPromptText` is an Eco-local marker for probes/tests (not an SDK wire field).
 *
 * ---
 * WORKAROUND (delete when SDK fixes stdin teardown for background Task/canUseTool):
 * Anthropic engineer guidance (claude-code#4775 / agent-sdk-typescript#376): with
 * streaming `prompt` + `canUseTool`, do not let the prompt iterable complete while
 * the query (including background subagents) still needs the control channel.
 * SDK `streamInput()` calls `transport.endInput()` after the iterable ends and the
 * first `result`, which permanently breaks later `can_use_tool` (often surfaced as
 * `toolDenialKind: "cancelled"` / J3H "user doesn't want to take this action").
 * TypeScript 0.3.284 fixed an SDK background-follow-up stdin teardown bug.
 * Eco still needs the mailbox for mid-turn user input and closes it only once
 * user UUIDs, session state, subagents and permission callbacks have settled.
 *
 * Eco uses one held mailbox (`createHeldPromptStream`) and never calls
 * `query.streamInput`. Because `prompt` is an AsyncIterable, the SDK treats the
 * Query as multi-turn (`isSingleUserTurn=false`) and will **not** endInput on
 * `result` — so if Eco never closes the mailbox, the Eco-run / thread stays
 * `running` forever after the assistant looks finished (UI case 1).
 *
 * Close policy: after a `result`, schedule mailbox close once there are no active
 * subagents, no in-flight `canUseTool`, and no unmatched mid-turn user push.
 * Cancel/reschedule when those conditions flip. Teardown close remains the
 * abort/error fallback. Mid-turn one-shot `streamInput` is not fine.
 * `toStreamingUserPrompt` (with optional `holdOpenUntil`) is only for rewind-style
 * one-shot prompts that need to stay open on a single message.
 * ---
 */
export type StreamingUserPrompt = AsyncIterable<SdkUserMessage> & {
  readonly ecoPromptText: string;
};

function buildSdkUserMessage(text: string, uuid?: string): SdkUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...(uuid?.trim() ? { uuid: uuid.trim() } : {}),
  };
}

export function toStreamingUserPrompt(
  text: string,
  options?: { uuid?: string; holdOpenUntil?: Promise<void> },
): StreamingUserPrompt {
  const userMessage = buildSdkUserMessage(text, options?.uuid);
  const holdOpenUntil = options?.holdOpenUntil;
  return {
    ecoPromptText: text,
    async *[Symbol.asyncIterator]() {
      yield userMessage;
      // See WORKAROUND on StreamingUserPrompt / toStreamingUserPrompt above.
      if (holdOpenUntil) {
        await holdOpenUntil;
      }
    },
  };
}

export type HeldPromptStream = StreamingUserPrompt & {
  push(text: string, options?: { uuid?: string }): Promise<void>;
  close(): void;
};

export function createHeldPromptStream(text: string, options?: { uuid?: string }): HeldPromptStream {
  type Queued = {
    message: SdkUserMessage;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  const queue: Queued[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const closedError = () => new Error("Held prompt stream is closed.");

  const kick = () => {
    wake?.();
    wake = undefined;
  };

  const rejectQueued = () => {
    const pending = queue.splice(0);
    for (const item of pending) {
      item.reject(closedError());
    }
  };

  const stream: HeldPromptStream = {
    ecoPromptText: text,
    push(nextText, pushOptions) {
      const trimmed = nextText.trim();
      if (!trimmed) {
        return Promise.reject(new Error("Mid-turn push requires non-empty text."));
      }
      if (closed) {
        return Promise.reject(closedError());
      }
      return new Promise<void>((resolve, reject) => {
        queue.push({
          message: buildSdkUserMessage(trimmed, pushOptions?.uuid),
          resolve,
          reject,
        });
        kick();
      });
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      rejectQueued();
      kick();
    },
    [Symbol.asyncIterator]() {
      let yieldedInitial = false;
      return {
        async next() {
          if (!yieldedInitial) {
            yieldedInitial = true;
            return {
              value: buildSdkUserMessage(text, options?.uuid),
              done: false,
            };
          }
          while (queue.length === 0 && !closed) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          if (closed) {
            rejectQueued();
            return { value: undefined, done: true };
          }
          const item = queue.shift();
          if (!item) {
            return { value: undefined, done: true };
          }
          queueMicrotask(() => item.resolve());
          return { value: item.message, done: false };
        },
      };
    },
  };
  return stream;
}

/**
 * Build a Query handle with mid-turn push. Phase transitions are owned by
 * `teardownClaudeQueryHandle` (open → closing → closed).
 */
export function createClaudeQueryHandle(
  query: SdkQueryHandle,
  options: {
    promptStream: HeldPromptStream;
    streamInputDeadlineMs?: number;
    onProbe?: (phase: string, detail: Record<string, unknown>) => void;
  },
): ClaudeQueryHandle {
  const handle: ClaudeQueryHandle = {
    query,
    phase: "open",
    async pushUserMessage(text, pushOptions) {
      if (handle.phase !== "open") {
        throw new Error("Claude query is not accepting mid-turn input.");
      }
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("Mid-turn push requires non-empty text.");
      }
      const deadlineMs = options.streamInputDeadlineMs ?? CLAUDE_QUERY_STREAM_INPUT_DEADLINE_MS;
      const raced = await settleWithin(options.promptStream.push(trimmed, pushOptions), deadlineMs);
      if (raced.kind === "timeout") {
        options.onProbe?.("stream_input_timeout", {
          deadline_ms: deadlineMs,
          uuid: pushOptions?.uuid?.trim() || null,
        });
        throw new ClaudeStreamInputFailed(
          `streamInput timed out after ${deadlineMs}ms; delivery status is unknown.`,
          true,
        );
      }
      if (raced.kind === "rejected") {
        const message = raced.error instanceof Error ? raced.error.message : String(raced.error);
        options.onProbe?.("stream_input_error", {
          error: message,
          uuid: pushOptions?.uuid?.trim() || null,
        });
        throw new ClaudeStreamInputFailed(message, true, { cause: raced.error });
      }
      options.onProbe?.("stream_input_ok", {
        uuid: pushOptions?.uuid?.trim() || null,
        text_len: trimmed.length,
      });
    },
  };
  return handle;
}

/** Prefer worktree root when present (aligned with rewind / resume cwd). */
export function resolveClaudeSessionCwd(input: { workspacePath: string; worktreePath: string }): string {
  const worktree = input.worktreePath.trim();
  if (worktree) {
    return worktree;
  }
  return input.workspacePath.trim();
}

/** Synchronous capture helper for tests and probes (uses ecoPromptText when present). */
export function resolveSdkPromptCaptureText(prompt: string | AsyncIterable<SdkUserMessage>): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (
    prompt &&
    typeof prompt === "object" &&
    "ecoPromptText" in prompt &&
    typeof (prompt as StreamingUserPrompt).ecoPromptText === "string"
  ) {
    return (prompt as StreamingUserPrompt).ecoPromptText;
  }
  return "";
}

/**
 * Extract the user text from a string or streaming prompt (async; reads full iterable).
 */
export async function extractSdkPromptText(prompt: string | AsyncIterable<SdkUserMessage>): Promise<string> {
  const marked = resolveSdkPromptCaptureText(prompt);
  if (typeof prompt === "string" || marked) {
    return typeof prompt === "string" ? prompt : marked;
  }
  const parts: string[] = [];
  for await (const message of prompt) {
    const content = message.message?.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join("\n");
}

interface SdkSessionMutationOptions {
  dir?: string;
}

interface SdkSessionReadOptions extends SdkSessionMutationOptions {
  limit?: number;
  offset?: number;
  includeSystemMessages?: boolean;
}

interface SdkSessionMessage {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
}

export interface ClaudeAgentSdkModule {
  query: SdkQuery;
  deleteSession?: (sessionId: string, options?: SdkSessionMutationOptions) => Promise<void>;
  getSessionMessages?: (sessionId: string, options?: SdkSessionReadOptions) => Promise<SdkSessionMessage[]>;
  forkSession?: (
    sessionId: string,
    options?: SdkSessionMutationOptions & { upToMessageId?: string; title?: string },
  ) => Promise<{ sessionId: string }>;
}

const networkAllowedTools = ["WebSearch", "WebFetch"] as const;
const defaultAllowedTools = [
  "Agent",
  ...SDK_DELEGATION_SUPPORT_TOOL_NAMES,
  SDK_SKILL_TOOL_NAME,
  ...SDK_TASK_PROGRESS_TOOL_NAMES,
  ...SDK_FILESYSTEM_READ_TOOL_NAMES,
  ...SDK_FILESYSTEM_WRITE_TOOL_NAMES,
  "Bash",
  ...networkAllowedTools,
] as const;
const readOnlyDisallowedSdkTools = [...SDK_FILESYSTEM_WRITE_TOOL_NAMES, "Bash"] as const;
const planningContinuationAllowedTools = [
  "Agent",
  ...SDK_TASK_READ_TOOL_NAMES,
  ...SDK_DELEGATION_SUPPORT_TOOL_NAMES,
  SDK_SKILL_TOOL_NAME,
  ...SDK_FILESYSTEM_READ_TOOL_NAMES,
  ...networkAllowedTools,
  "AskUserQuestion",
] as const;
// Plan submission tools are user-approval boundaries; never let SDK allow-rules auto-approve them.
const protectedPlanModeToolNames = ["EnterPlanMode", "ExitPlanMode", "mcp__eco_plan__finalize_plan"] as const;
// A preset also advertises CLI-only scheduling and worktree tools. Keep the native
// tools Eco supports explicit; allowedTools controls approval, not visibility.
const nativeSdkTools = uniqueStrings([
  ...defaultAllowedTools,
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "ListAgents",
  "SendMessage",
  "TaskStop",
]);
const askAllowedTools = [
  "Agent",
  ...SDK_TASK_READ_TOOL_NAMES,
  ...SDK_DELEGATION_SUPPORT_TOOL_NAMES,
  ...SDK_FILESYSTEM_READ_TOOL_NAMES,
  ...networkAllowedTools,
] as const;
const askDisallowedSdkTools = [...readOnlyDisallowedSdkTools, ...protectedPlanModeToolNames] as const;
/** Agent / execution: Plan tools belong to sessionMode plan only (align with Ask). */
const agentDisallowedSdkTools = [...protectedPlanModeToolNames] as const;
const readOnlyAgentDefinitionDisallowedTools = [
  "Agent",
  "Task",
  ...SDK_DELEGATION_SUPPORT_TOOL_NAMES,
  ...SDK_FILESYSTEM_WRITE_TOOL_NAMES,
  "Bash",
  "AskUserQuestion",
  "Workflow",
  ...protectedPlanModeToolNames,
] as const;
const exploreSubagentTools = ["Read", "Glob", "Grep"] as const;
const readOnlySubagentTools = [...SDK_FILESYSTEM_READ_TOOL_NAMES, ...networkAllowedTools] as const;
const readOnlySubagentBashTools = [
  ...SDK_FILESYSTEM_READ_TOOL_NAMES,
  "Bash",
  ...networkAllowedTools,
] as const;
const executionCoderTools = [
  ...SDK_FILESYSTEM_READ_TOOL_NAMES,
  ...SDK_FILESYSTEM_WRITE_TOOL_NAMES,
  "Bash",
] as const;
const autonomousAllowedTools = [...defaultAllowedTools, "AskUserQuestion"] as const;
/** Read-only phases: auto-approve tools in allowedTools without edit prompts. */
const readOnlyPermissionMode = "dontAsk" as const;
const defaultSettingSources = ["project"] as const;

function buildAskSessionPhase(input: AgentRuntimeRunInput): {
  prompt: string;
  permissionMode: typeof readOnlyPermissionMode;
  askPhase: true;
  allowedTools: string[];
  availability: SubagentAvailability;
} {
  const availability = resolveEffectiveSubagentAvailability(input.sdkSession, input.routes);
  return {
    prompt: input.prompt,
    permissionMode: readOnlyPermissionMode,
    askPhase: true,
    allowedTools: [...askAllowedTools],
    availability,
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isReadOnlyPhaseAgentToolAllowed(toolName: string, phaseAllowedTools: ReadonlySet<string>): boolean {
  const trimmed = toolName.trim();
  if (
    trimmed === "Agent" ||
    trimmed === "Task" ||
    (SDK_DELEGATION_SUPPORT_TOOL_NAMES as readonly string[]).includes(trimmed) ||
    (SDK_FILESYSTEM_WRITE_TOOL_NAMES as readonly string[]).includes(trimmed) ||
    trimmed === "Bash" ||
    trimmed === "AskUserQuestion" ||
    trimmed === "Workflow" ||
    (protectedPlanModeToolNames as readonly string[]).includes(trimmed)
  ) {
    return false;
  }
  return phaseAllowedTools.has(trimmed) || trimmed.startsWith("mcp__");
}

function capAgentDefinitionsForReadOnlyPhase(
  definitions: Record<string, unknown>,
  phaseAllowedTools: readonly string[],
): Record<string, unknown> {
  const phaseAllowed = new Set(phaseAllowedTools);
  return Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => {
      if (!isRecord(definition)) {
        return [key, definition];
      }
      const tools = readStringArray(definition.tools);
      const disallowedTools = uniqueStrings([
        ...readStringArray(definition.disallowedTools),
        ...readOnlyAgentDefinitionDisallowedTools,
      ]);
      return [
        key,
        {
          ...definition,
          ...(tools.length > 0
            ? { tools: tools.filter((toolName) => isReadOnlyPhaseAgentToolAllowed(toolName, phaseAllowed)) }
            : {}),
          disallowedTools,
        },
      ];
    }),
  );
}

export function mergeAllowedTools(base: string[], session?: EcoSdkSessionOptions): string[] {
  const merged = new Set(base);
  for (const tool of session?.mcpAllowedTools ?? []) {
    merged.add(tool);
  }
  return [...merged];
}

/** Detect Eco Integrated Web Search arming from session MCP + disallowed native WebSearch. */
export function resolveIntegratedWebSearchAgentDefOptions(
  session?: EcoSdkSessionOptions,
): { serverName: string; fullToolName: string } | undefined {
  if (!session?.disallowedTools?.some((tool) => tool.trim() === "WebSearch")) {
    return undefined;
  }
  const fullToolName = session.mcpAllowedTools?.find((tool) => tool.includes("eco_web_search"))?.trim();
  if (!fullToolName) {
    return undefined;
  }
  const serverFromMcp = Object.keys(session.mcpServers ?? {}).find((name) => name.includes("eco_web_search"));
  const serverFromRuntime = session.runtimeMcpServers?.find((name) => name.includes("eco_web_search"));
  const serverName = (serverFromMcp ?? serverFromRuntime)?.trim();
  if (!serverName) {
    return undefined;
  }
  return { serverName, fullToolName };
}

export function resolveSdkSessionOptions(session?: EcoSdkSessionOptions): {
  settingSources: EcoSdkSessionOptions["settingSources"];
  skills: EcoSdkSessionOptions["skills"];
  mcpServers: Record<string, unknown>;
} {
  const plannerSkills = readAgentSkillAssignment(session?.agentSkills, "main") ?? session?.skills;
  return {
    settingSources: session?.settingSources ?? [...defaultSettingSources],
    skills: plannerSkills === undefined ? undefined : [...plannerSkills],
    mcpServers: session?.mcpServers ?? {},
  };
}

export function resolveSubagentAvailabilityFromSession(session?: EcoSdkSessionOptions): SubagentAvailability {
  return normalizeSubagentAvailability(session?.enabledSubagents);
}

export function resolveEffectiveSubagentAvailability(
  session: EcoSdkSessionOptions | undefined,
  routes: readonly ResolvedModelRoute[],
): SubagentAvailability {
  return effectiveSubagentAvailability(resolveSubagentAvailabilityFromSession(session), routes);
}

export function resolveAgentSkills(
  role: RuntimeAgentRole,
  agentSkills?: Partial<Record<RuntimeAgentRole, string[]>>,
  sessionSkills?: string[],
): string[] {
  const fromRole = readAgentSkillAssignment(agentSkills, role);
  if (fromRole !== undefined) {
    return [...fromRole];
  }
  if (role === "main" && sessionSkills !== undefined) {
    return [...sessionSkills];
  }
  return [];
}

function agentDefinitionToolFields(
  role: RuntimeAgentRole,
  tools: readonly string[],
  agentSkills?: Partial<Record<RuntimeAgentRole, string[]>>,
): Record<string, unknown> {
  const skills = resolveAgentSkills(role, agentSkills);
  return {
    tools: skills.length > 0 ? [...tools, SDK_SKILL_TOOL_NAME] : [...tools],
    ...(skills.length > 0 ? { skills } : {}),
  };
}

function readAgentSkillAssignment(
  agentSkills: Partial<Record<RuntimeAgentRole, string[]>> | undefined,
  role: RuntimeAgentRole,
): string[] | undefined {
  if (!agentSkills) {
    return undefined;
  }
  for (const key of agentSkillLookupKeys(role)) {
    const skills = agentSkills[key];
    if (skills !== undefined) {
      return skills;
    }
  }
  return undefined;
}

function agentSkillLookupKeys(role: RuntimeAgentRole): string[] {
  const trimmed = role.trim();
  if (!trimmed) {
    return [];
  }
  const unprefixed = trimmed.startsWith("eco_") ? trimmed.slice(4) : trimmed;
  const prefixed = trimmed.startsWith("eco_") ? trimmed : `eco_${trimmed}`;
  return [...new Set([trimmed, unprefixed, prefixed, ...(unprefixed === "main" ? ["planner", "eco_planner"] : [])])];
}

export type EcoRunPhase = "analyze" | "plan" | "execute" | "answer";

export interface ClaudeAgentSdkDriverOptions {
  apiKey: string;
  baseUrl: string;
  /** Native Claude CLI path supplied by packaged desktop builds. */
  pathToClaudeCodeExecutable?: string;
  /**
   * When true, move cwd/git/platform context out of the cached system prompt prefix
   * so identical append text can share prompt cache across worktrees.
   */
  excludeDynamicSections?: boolean;
  loadSdk?: () => Promise<ClaudeAgentSdkModule>;
  /** SDK callback hooks context (AskUserQuestion, reviewer scope, task tracking, notifications). */
  hookContext?: EcoHookContext;
  /** SDK-native tool permission callback. Desktop uses this for blocking Bash confirmation. */
  toolPermissionHandler?: (request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision>;
  /** Official Claude Agent SDK permission mode used for execution passes. */
  executionPermissionMode?: "default" | "bypassPermissions";
  /** Optional probe logging for `getContextUsage()` (desktop sets from ECO_CONTEXT_SNAPSHOT_LOG). */
  onContextProbe?: (phase: string, detail: Record<string, unknown>) => void;
  /** Record raw SDK messages for offline replay fixtures (tests / conversation-round). */
  onSdkMessage?: (message: unknown) => void;
  /** Live background-task level signal owned by the current Claude Query. */
  onBackgroundTasksChanged?: (input: ClaudeBackgroundTasksChangedInput) => void;
  /** Clears producer-owned task handles when the Query closes. */
  onBackgroundTasksClosed?: (input: { threadId: string; query: SdkQueryHandle }) => void;
  /** Override SDK control/drain deadlines for constrained runtimes and deterministic tests. */
  queryControlDeadlineMs?: number;
  /** Override mid-turn streamInput deadline (tests / constrained runtimes). */
  queryStreamInputDeadlineMs?: number;
  /**
   * Anthropic gateway auth style. Use `bearer` for third-party Anthropic-compatible
   * providers (e.g. LongCat) that expect Authorization: Bearer instead of x-api-key.
   */
  anthropicAuthMode?: "api-key" | "bearer";
  /** Live Query lifecycle for desktop mid-turn port (does not change product queue defaults alone). */
  queryLifecycle?: ClaudeQueryLifecycleHooks;
  /**
   * When true (default), expose per-task stop affordance to the CLI.
   * Maps to SDK query option `perTaskStopAffordance`.
   */
  perTaskStopAffordance?: boolean;
  /**
   * Host vs none permission prompts. When unset, Eco still forces `none` for
   * `dontAsk` phases (ask / compact / rewind-style).
   */
  permissionPrompts?: "host" | "none";
  /**
   * When aborting, pass `cancelQueued: true` to `query.interrupt` (default true).
   */
  cancelQueuedOnInterrupt?: boolean;
  /**
   * How plugins are delivered to the CLI process. Default `initialize`.
   */
  pluginDelivery?: "argv" | "initialize";
}

export interface SdkToolPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  requestId?: string;
  agentId?: string;
  agentType?: string;
  cwd?: string;
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
  mcpServer?: { name: string; source: string };
  signal: AbortSignal;
}

export type SdkToolPermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export async function deleteClaudeAgentSdkSession(input: {
  sessionId: string;
  dir?: string;
  loadSdk?: () => Promise<ClaudeAgentSdkModule>;
}): Promise<void> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return;
  }

  const sdk = input.loadSdk
    ? await input.loadSdk()
    : ((await import("@anthropic-ai/claude-agent-sdk")) as ClaudeAgentSdkModule);
  if (typeof sdk.deleteSession !== "function") {
    throw new Error("SDK deleteSession is not available. Update @anthropic-ai/claude-agent-sdk.");
  }

  const options: SdkSessionMutationOptions = {};
  if (input.dir?.trim()) {
    options.dir = input.dir.trim();
  }

  await sdk.deleteSession(sessionId, Object.keys(options).length > 0 ? options : undefined);
}

export async function resolveResumeSessionAtBeforeUserMessage(input: {
  sessionId: string;
  userMessageId: string;
  dir?: string;
  loadSdk?: () => Promise<ClaudeAgentSdkModule>;
}): Promise<string | undefined> {
  const sessionId = input.sessionId.trim();
  const userMessageId = input.userMessageId.trim();
  if (!sessionId || !userMessageId) {
    throw new Error("SDK session id and user message id are required.");
  }

  const sdk = input.loadSdk
    ? await input.loadSdk()
    : ((await import("@anthropic-ai/claude-agent-sdk")) as ClaudeAgentSdkModule);
  if (typeof sdk.getSessionMessages !== "function") {
    throw new Error("SDK getSessionMessages is not available. Update @anthropic-ai/claude-agent-sdk.");
  }

  const options: SdkSessionReadOptions = { includeSystemMessages: false };
  if (input.dir?.trim()) {
    options.dir = input.dir.trim();
  }

  const messages = await sdk.getSessionMessages(sessionId, options);
  const targetIndex = messages.findIndex(
    (message) => message.uuid === userMessageId && message.type === "user",
  );
  if (targetIndex < 0) {
    throw new Error("找不到该节点对应的 SDK user message，无法安全回滚对话。");
  }

  // Keep through the last chain entry of the prior turn (assistant, tool_result,
  // structured_output, or any other chain uuid) — required by resumeDropsTurn.
  if (targetIndex === 0) {
    return undefined;
  }
  const previous = messages[targetIndex - 1];
  const previousUuid = typeof previous?.uuid === "string" ? previous.uuid.trim() : "";
  if (!previousUuid) {
    throw new Error("目标消息之前缺少可 fork 的 chain entry UUID，无法安全截断 resume。");
  }
  return previousUuid;
}

interface FinalizePlanPayload {
  analysis: string;
  plan: string;
  planFilePath?: string;
  deferredExitPlanToolUseId?: string;
}

function buildExitPlanModeAnalysis(submission: { planFilePath?: string }): string {
  return [
    "Claude official Plan Mode submitted this plan via ExitPlanMode.",
    submission.planFilePath ? `Plan file: ${submission.planFilePath}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export class ClaudeAgentSdkDriver implements AgentRuntimeDriver {
  constructor(private readonly options: ClaudeAgentSdkDriverOptions) {}

  async *run(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    yield* this.runAutonomous(input);
  }

  async *runAsk(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    yield createPhaseBoundaryEvent(input.threadId, "answer", "【问答】只读回答");
    yield* this.runSingleSession(input, buildAskSessionPhase(input));
  }

  async *runPlan(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    yield createPhaseBoundaryEvent(input.threadId, "plan", "【计划】调研并制定方案");
    yield* this.runPlanningPass(input, input.prompt);
  }

  async *compactSession(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    yield* this.runSlashCommand(input, "/compact", { permissionMode: "dontAsk" });
  }

  async *runContinuation(
    input: AgentRuntimeRunInput,
    mode: "planning" | "execution" | "ask",
    planning?: EcoPlanningContext,
  ): AsyncIterable<AgentEvent> {
    if (mode === "ask") {
      yield createPhaseBoundaryEvent(input.threadId, "answer", "【续聊】只读回答");
      yield* this.runSingleSession(input, buildAskSessionPhase(input));
      return;
    }

    const availability = resolveEffectiveSubagentAvailability(input.sdkSession, input.routes);
    const isSdkResume = Boolean(input.resume?.resumeSessionId);
    const continuationPrompt =
      mode === "execution" && planning
        ? buildAutonomousPlanContinuationPrompt({
            userPrompt: planning.userPrompt,
            analysis: planning.analysis,
            plan: planning.plan,
            ...(planning.planUserEdited ? { planUserEdited: true } : {}),
            followUp: input.prompt,
            isResume: isSdkResume,
          })
        : input.prompt;
    yield createPhaseBoundaryEvent(
      input.threadId,
      mode === "execution" ? "execute" : "plan",
      mode === "execution" ? "【续聊】继续执行" : "【续聊】继续对话",
    );
    if (mode === "planning") {
      yield* this.runPlanningPass(input, continuationPrompt);
      return;
    }
    const sessionResult = yield* this.runSingleSession(input, {
      prompt: continuationPrompt,
      permissionMode: this.options.executionPermissionMode ?? "default",
      ...(planning?.deferredExitPlanToolUseId
        ? { approvedExitPlanToolUseId: planning.deferredExitPlanToolUseId }
        : {}),
      allowedTools: [...autonomousAllowedTools],
      availability,
    });
    void sessionResult;
  }

  private async *runPlanningPass(input: AgentRuntimeRunInput, prompt: string): AsyncIterable<AgentEvent> {
    const availability = resolveEffectiveSubagentAvailability(input.sdkSession, input.routes);
    const sessionResult = yield* this.runSingleSession(input, {
      prompt,
      permissionMode: "plan",
      planningPhase: true,
      allowedTools: [...planningContinuationAllowedTools],
      availability,
    });
    const finalizedPlan = sessionResult.finalizedPlan;
    // PermissionRequest approval publishes the plan while this query is blocked. Once approved,
    // the same query continues into execution; emitting plan.ready at query end would reopen it.
    if (finalizedPlan && !this.options.hookContext?.awaitPlanApproval) {
      yield createPlanReadyEvent(input.threadId, {
        userPrompt: input.prompt,
        analysis: finalizedPlan.analysis,
        plan: finalizedPlan.plan,
        ...(finalizedPlan.planFilePath ? { planFilePath: finalizedPlan.planFilePath } : {}),
        ...(finalizedPlan.deferredExitPlanToolUseId
          ? { deferredExitPlanToolUseId: finalizedPlan.deferredExitPlanToolUseId }
          : {}),
      });
    }
  }

  private async *runAutonomous(input: AgentRuntimeRunInput): AsyncIterable<AgentEvent> {
    const availability = resolveEffectiveSubagentAvailability(input.sdkSession, input.routes);
    yield* this.runSingleSession(input, {
      prompt: input.prompt,
      permissionMode: this.options.executionPermissionMode ?? "default",
      allowedTools: [...autonomousAllowedTools],
      availability,
    });
  }

  private async *runSingleSession(
    input: AgentRuntimeRunInput,
    phase: {
      prompt: string;
      permissionMode: "dontAsk" | "default" | "acceptEdits" | "plan" | "bypassPermissions";
      planningPhase?: boolean;
      askPhase?: boolean;
      /** Execution resume after Eco plan approval: complete only this deferred ExitPlanMode call. */
      approvedExitPlanToolUseId?: string;
      allowedTools: string[];
      availability?: SubagentAvailability;
    },
  ): AsyncGenerator<AgentEvent, { transcript: string; finalizedPlan?: FinalizePlanPayload }> {
    input.signal.throwIfAborted();
    const sdk = await sdkWorkOrAbort(this.loadSdk(), input.signal);
    const plannerRoute = findRoute(input.routes, "main") ?? input.routes[0];
    if (!plannerRoute) {
      throw new Error("At least one model route is required to start Claude Agent SDK");
    }

    const session = resolveSdkSessionOptions(input.sdkSession);
    // Orchestration agents must request the role route's model id (the proxy alias), so the local
    // proxy can attribute usage to the right agent role instead of guessing by shared model.
    const resolveSdkModel = createSdkModelResolver(input.routes);
    const integratedWebSearchForAgents = resolveIntegratedWebSearchAgentDefOptions(input.sdkSession);
    const dynamicAgents = input.agentRegistry
      ? createAgentDefinitionsFromOrchestration(
          input.agentRegistry.orchestration,
          input.agentRegistry.templates,
          {
            ...(input.sdkSession?.agentSkills && { agentSkills: input.sdkSession.agentSkills }),
            resolveModelId: resolveSdkModel,
            ...(integratedWebSearchForAgents ? { integratedWebSearch: integratedWebSearchForAgents } : {}),
          },
        )
      : undefined;
    const availableDynamicDefinitions =
      dynamicAgents && phase.availability
        ? filterAgentDefinitions(dynamicAgents.definitions, phase.availability)
        : dynamicAgents?.definitions;
    const dynamicDefinitions = input.agentRegistry ? availableDynamicDefinitions : undefined;
    const dynamicAgentKeys = dynamicDefinitions ? Object.keys(dynamicDefinitions) : undefined;
    const mainAllowedTools = phase.askPhase
      ? phase.allowedTools
      : input.agentRegistry
        ? resolveMainAgentAllowedTools(input.agentRegistry.orchestration, phase.allowedTools)
        : phase.allowedTools;
    // Native Plan Mode owns its temporary read-only boundary. An Eco phase cap would keep
    // Write/Edit/Bash unavailable after ExitPlanMode changes this session to acceptEdits.
    const applyPhaseToolCap = phase.permissionMode === "dontAsk";
    const effectiveDynamicDefinitions =
      dynamicDefinitions && applyPhaseToolCap
        ? capAgentDefinitionsForReadOnlyPhase(dynamicDefinitions, phase.allowedTools)
        : dynamicDefinitions;
    const toolPermissions = input.agentRegistry
      ? buildToolPermissionPolicyFromOrchestration(
          input.agentRegistry.orchestration,
          input.agentRegistry.templates,
          {
            ...(dynamicAgentKeys ? { agentKeys: dynamicAgentKeys } : {}),
            ...(applyPhaseToolCap ? { phaseAllowedTools: phase.allowedTools } : {}),
            ...(input.sdkSession?.runtimeMcpServers?.length
              ? { runtimeMcpServers: input.sdkSession.runtimeMcpServers }
              : {}),
          },
        )
      : undefined;
    const pendingToolPermissionDecisions: EcoToolPermissionDecisionAudit[] = [];
    const onToolPermissionDecision = (decision: EcoToolPermissionDecisionAudit) => {
      this.options.hookContext?.onToolPermissionDecision?.(decision);
      pendingToolPermissionDecisions.push(decision);
    };
    let finalizedPlan: FinalizePlanPayload | undefined;
    const exitPlanCaptureState = phase.planningPhase ? { capturedToolUseIds: new Set<string>() } : undefined;
    const onExitPlanMode = phase.planningPhase
      ? (submission: { plan: string; planFilePath?: string }) => {
          // Plan paths are workspace-relative product paths; session SDK cwd may be the worktree.
          const planPathRoot = input.workspacePath.trim() || resolveClaudeSessionCwd(input);
          finalizedPlan = {
            analysis: buildExitPlanModeAnalysis(submission),
            plan: submission.plan,
            ...(submission.planFilePath
              ? {
                  planFilePath: toWorkspaceRelativePlanFile(submission.planFilePath, planPathRoot),
                }
              : {}),
          };
        }
      : undefined;
    const allowedSdkBuiltinAgentKeys = phase.planningPhase ? [SDK_PLAN_AGENT_KEY] : undefined;
    const approvedExitPlanToolUseId = !phase.planningPhase
      ? phase.approvedExitPlanToolUseId?.trim()
      : undefined;
    const planModeToolPolicy: PlanModeToolPolicy = phase.planningPhase
      ? "user-approval"
      : approvedExitPlanToolUseId
        ? "resume-approved-exit"
        : "forbidden";
    const hookContext = this.options.hookContext;
    let queryForSubagentControl: ReturnType<SdkQuery> | undefined;
    const subagentRuntimeLimit = new SubagentRuntimeLimitController({
      ...(hookContext?.subagentMaxRuntimeMs !== undefined && {
        maxRuntimeMs: hookContext.subagentMaxRuntimeMs,
      }),
      stopTask: async (agentId) => {
        if (typeof queryForSubagentControl?.stopTask !== "function") {
          throw new Error(
            `Claude Agent SDK cannot stop timed-out subagent ${agentId}: stopTask is unavailable.`,
          );
        }
        await queryForSubagentControl.stopTask(agentId);
      },
      onTimeout: ({ agentId, maxRuntimeMs }) => {
        hookContext?.onNotification?.({
          title: "子代理运行超时",
          message: `子代理 ${agentId} 已运行 ${Math.round(maxRuntimeMs / 60_000)} 分钟，已单独停止。`,
          notificationType: "subagent_runtime_limit",
        });
      },
      onStopError: ({ agentId, error }) => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.onContextProbe?.("subagent_runtime_limit_stop_error", { agentId, error: message });
        hookContext?.onNotification?.({
          title: "子代理超时停止失败",
          message: `子代理 ${agentId} 超时，但 SDK 未能停止它：${message}`,
          notificationType: "subagent_runtime_limit_error",
        });
      },
    });
    const shouldBuildHooks = Boolean(
      hookContext ||
        onExitPlanMode ||
        approvedExitPlanToolUseId ||
        dynamicAgentKeys ||
        toolPermissions ||
        planModeToolPolicy === "forbidden",
    );
    const mergedAllowedTools = mergeAllowedTools(mainAllowedTools, input.sdkSession);
    const allowedToolsRaw = stripProtectedPlanModeAutoApprovedTools(
      this.options.toolPermissionHandler
        ? stripBashAutoApprovedTools(mergedAllowedTools)
        : mergedAllowedTools,
    );
    const sdkDisallowedTools = mergeSdkDisallowedTools(
      toolPermissions?.main.disallowed,
      input.sdkSession?.disallowedTools,
      phase.askPhase ? askDisallowedSdkTools : [],
      !phase.planningPhase
        ? approvedExitPlanToolUseId
          ? protectedPlanModeToolNames.filter((toolName) => toolName !== "ExitPlanMode")
          : agentDisallowedSdkTools
        : [],
    );
    const disallowedSet = new Set(sdkDisallowedTools);
    const allowedTools = allowedToolsRaw.filter((tool) => !disallowedSet.has(tool));
    // Prefer the planner route's model id (the proxy role alias) so main-agent usage is
    // attributed to the planner role; raw orchestration model ids are ambiguous when multiple
    // roles share the same upstream model.
    const orchestrationMainModelId = input.agentRegistry?.orchestration.mainAgent.modelRef.modelId;
    const mainModel = resolveMainSdkModelId(input.routes, orchestrationMainModelId);
    const systemPrompt = input.agentRegistry
      ? buildMainAgentSystemPrompt(input.agentRegistry.orchestration, input.agentRegistry.templates, {
          ...(this.options.excludeDynamicSections ? { excludeDynamicSections: true } : {}),
          ...(input.globalUserRules ? { globalUserRules: input.globalUserRules } : {}),
        })
      : buildClaudeCodeSystemPrompt({
          ...(this.options.excludeDynamicSections ? { excludeDynamicSections: true } : {}),
          ...(input.globalUserRules ? { globalUserRules: input.globalUserRules } : {}),
        });
    const sessionCwd = resolveClaudeSessionCwd(input);
    // Late-bound: schedule/cancel are assigned after the held prompt + handle exist.
    const heldPromptCloseGate = {
      resultSeen: false,
      sessionState: undefined as "idle" | "running" | "requires_action" | undefined,
      activeSubagentCount: 0,
      inflightCanUseTool: 0,
      unmatchedUserTurns: (): boolean => false,
      pendingQueuedTurns: (): boolean => false,
      cancel: (): void => {},
      schedule: (): void => {},
    };
    const rawCanUseTool = this.options.toolPermissionHandler
      ? createCanUseTool(this.options.toolPermissionHandler, {
          planModeToolPolicy,
          ...(approvedExitPlanToolUseId ? { approvedExitPlanToolUseId } : {}),
          ...(phase.planningPhase && this.options.hookContext?.awaitPlanApproval
            ? { awaitPlanApproval: this.options.hookContext.awaitPlanApproval }
            : {}),
          ...(onExitPlanMode ? { onExitPlanMode } : {}),
          ...(exitPlanCaptureState ? { exitPlanCaptureState } : {}),
          workspacePath: input.workspacePath,
          ...(phase.planningPhase ? { getPhaseTranscript: () => phaseTranscriptBox.text } : {}),
        })
      : undefined;
    const outputCeilings = input.routes
      .map((route) => route.maxOutputTokens)
      .filter((tokens): tokens is number => tokens !== undefined);
    // Parent and children share a CLI process. Per-role budgets remain owned by Gateway.
    const sdkMaxOutputTokens = outputCeilings.length > 0 ? Math.max(...outputCeilings) : undefined;
    const sdkAbortController = new AbortController();
    const queryOptions: Record<string, unknown> = {
      abortController: sdkAbortController,
      cwd: sessionCwd,
      model: mainModel,
      ...(this.options.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable }
        : {}),
      fallbackModel: plannerRoute.fallbacks?.[0]?.modelId,
      includePartialMessages: true,
      forwardSubagentText: true,
      settingSources: session.settingSources,
      ...(session.skills !== undefined ? { skills: session.skills } : {}),
      permissionMode: phase.permissionMode,
      ...(phase.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      allowedTools,
      ...(sdkDisallowedTools.length > 0 ? { disallowedTools: sdkDisallowedTools } : {}),
      ...(rawCanUseTool
        ? {
            canUseTool: async (
              toolName: string,
              toolInput: Record<string, unknown>,
              toolOptions: Record<string, unknown>,
            ) => {
              heldPromptCloseGate.inflightCanUseTool += 1;
              heldPromptCloseGate.cancel();
              try {
                return await rawCanUseTool(toolName, toolInput, toolOptions);
              } finally {
                heldPromptCloseGate.inflightCanUseTool = Math.max(
                  0,
                  heldPromptCloseGate.inflightCanUseTool - 1,
                );
                heldPromptCloseGate.schedule();
              }
            },
          }
        : {}),
      systemPrompt,
      tools: nativeSdkTools.filter((tool) => !disallowedSet.has(tool)),
      ...(shouldBuildHooks
        ? {
            hooks: buildEcoSdkHooks({
              ...(this.options.hookContext ?? {}),
              subagentRuntimeLimit,
              planModeToolPolicy,
              ...(input.sdkSession?.implicitReadAllowRoots?.length
                ? { implicitReadAllowRoots: input.sdkSession.implicitReadAllowRoots }
                : {}),
              ...(onExitPlanMode ? { onExitPlanMode } : {}),
              ...(phase.planningPhase && this.options.hookContext?.awaitPlanApproval
                ? { awaitPlanApproval: this.options.hookContext.awaitPlanApproval }
                : {}),
              ...(exitPlanCaptureState ? { exitPlanCaptureState } : {}),
              ...(approvedExitPlanToolUseId ? { approvedExitPlanToolUseId } : {}),
              ...(phase.planningPhase ? { getPhaseTranscript: () => phaseTranscriptBox.text } : {}),
              workspacePath: input.workspacePath,
              ...(dynamicAgentKeys ? { allowedAgentKeys: dynamicAgentKeys } : {}),
              ...(allowedSdkBuiltinAgentKeys ? { allowedSdkBuiltinAgentKeys } : {}),
              ...(toolPermissions ? { toolPermissions } : {}),
              ...(toolPermissions ? { onToolPermissionDecision } : {}),
              subagentAvailability:
                phase.availability ?? resolveEffectiveSubagentAvailability(input.sdkSession, input.routes),
            }),
          }
        : {}),
      env: buildSdkProcessEnv({
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
        ...(plannerRoute.primary.contextWindow !== undefined && {
          contextWindow: plannerRoute.primary.contextWindow,
        }),
        ...(sdkMaxOutputTokens !== undefined && { maxOutputTokens: sdkMaxOutputTokens }),
        ...(this.options.anthropicAuthMode ? { anthropicAuthMode: this.options.anthropicAuthMode } : {}),
        ...(plannerRoute.thinkingEffort ? { thinkingEffort: plannerRoute.thinkingEffort } : {}),
      }),
      settings: {},
    };

    queryOptions.pluginDelivery = this.options.pluginDelivery ?? "initialize";
    queryOptions.perTaskStopAffordance = this.options.perTaskStopAffordance ?? true;
    if (phase.permissionMode === "dontAsk" || this.options.permissionPrompts === "none") {
      queryOptions.permissionPrompts = "none";
    } else if (this.options.permissionPrompts !== undefined) {
      queryOptions.permissionPrompts = this.options.permissionPrompts;
    }

    applyClaudeJsonlSessionPersistence(queryOptions);
    applyResumeToQueryOptions(queryOptions, input.resume);
    applyThinkingToQueryOptions(queryOptions, plannerRoute.thinkingEffort);
    applyEcoSdkSettings(queryOptions, this.options.apiKey, this.options.baseUrl, {
      ...(allowedSdkBuiltinAgentKeys ? { allowedSdkBuiltinAgentKeys } : {}),
      ...(plannerRoute.primary.contextWindow !== undefined
        ? {
            contextWindow: plannerRoute.primary.contextWindow,
            autoCompactWindow: plannerRoute.primary.contextWindow,
          }
        : {}),
      ...(this.options.anthropicAuthMode ? { anthropicAuthMode: this.options.anthropicAuthMode } : {}),
      ...(sdkMaxOutputTokens !== undefined && { maxOutputTokens: sdkMaxOutputTokens }),
    });

    if (Object.keys(session.mcpServers).length > 0) {
      queryOptions.mcpServers = session.mcpServers;
    }
    if (effectiveDynamicDefinitions) {
      queryOptions.agents = applyClaudeSubagentCompactionWindows(effectiveDynamicDefinitions, input.routes);
    }

    this.options.onContextProbe?.("query_start", {
      threadId: input.threadId,
      runMode: phase.planningPhase ? "plan" : phase.askPhase ? "ask" : "agent",
      permissionMode: phase.permissionMode,
      planningPhase: phase.planningPhase === true,
      askPhase: phase.askPhase === true,
      prompt: summarizeTextForProbe(phase.prompt),
      session: {
        isResume: Boolean(input.resume?.resumeSessionId),
        ...(input.resume?.resumeSessionId && { resumeSessionId: input.resume.resumeSessionId }),
        ...(input.resume?.resumeSessionAt && { resumeSessionAt: input.resume.resumeSessionAt }),
        ...(input.resume?.resumeDropsTurn && { resumeDropsTurn: input.resume.resumeDropsTurn }),
        forkSession: input.resume?.forkSession === true,
      },
      cwd: summarizeTextForProbe(sessionCwd),
      model: mainModel,
      fallbackModel: plannerRoute.fallbacks?.[0]?.modelId ?? null,
      routes: input.routes.map((route) => ({
        role: route.role,
        primaryModel: route.primary.modelId,
        fallbackCount: route.fallbacks.length,
      })),
      systemPrompt: summarizeSystemPromptForProbe(systemPrompt),
      tools: {
        allowedCount: allowedTools.length,
        allowed: allowedTools.slice(0, 40),
        disallowedCount: sdkDisallowedTools.length,
        disallowed: sdkDisallowedTools.slice(0, 40),
      },
      agents: summarizeAgentsForProbe(
        (queryOptions.agents as Record<string, unknown> | undefined) ?? undefined,
      ),
      mcp: {
        serverCount: Object.keys(session.mcpServers).length,
      },
      skills: {
        count: session.skills?.length ?? 0,
        names: session.skills?.slice(0, 40) ?? [],
      },
      settingSources: session.settingSources,
      flags: {
        includePartialMessages: queryOptions.includePartialMessages === true,
        forwardSubagentText: queryOptions.forwardSubagentText === true,
        enableFileCheckpointing: queryOptions.enableFileCheckpointing === true,
        excludeDynamicSections: this.options.excludeDynamicSections === true,
      },
    });

    const resolveSubagent = this.options.hookContext?.subagentAttribution?.resolveAgentId;
    const streamCtx = createSdkStreamContext({
      ...(resolveSubagent && {
        resolveSubagentAgentId: (input) =>
          resolveSubagent({
            role: input.role,
            sessionId: input.sessionId,
            ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
          }),
      }),
    });
    const subagentAttribution = this.options.hookContext?.subagentAttribution;
    if (subagentAttribution) {
      const priorOnSubagentRegistered = subagentAttribution.onSubagentRegistered;
      subagentAttribution.onSubagentRegistered = (input) => {
        registerSubagentOnStreamContext(streamCtx, input);
        priorOnSubagentRegistered?.(input);
      };
    }
    // WORKAROUND: one held prompt mailbox for the whole Eco query (see createHeldPromptStream).
    // Keep open across interim results while subagents / canUseTool still need the channel;
    // schedule close after a settled result so the multi-turn Query can endInput and idle.
    const initialUserMessageUuid = crypto.randomUUID();
    const promptStream = createHeldPromptStream(phase.prompt, { uuid: initialUserMessageUuid });
    const query = sdk.query({
      prompt: promptStream,
      options: queryOptions,
    });
    const handle = createClaudeQueryHandle(query, {
      promptStream,
      ...(this.options.queryStreamInputDeadlineMs !== undefined
        ? { streamInputDeadlineMs: this.options.queryStreamInputDeadlineMs }
        : {}),
      onProbe: (probePhase, detail) => this.options.onContextProbe?.(probePhase, detail),
    });
    queryForSubagentControl = query;

    let closingNotified = false;
    const notifyClosing = async (): Promise<void> => {
      if (closingNotified) {
        return;
      }
      closingNotified = true;
      try {
        await sdkWorkOrAbort(Promise.resolve(this.options.queryLifecycle?.onClosing?.(handle)), input.signal);
      } catch {
        // Port closeIngress must not block prompt/query teardown.
      }
    };

    let promptCloseStarted = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    heldPromptCloseGate.cancel = () => {
      if (closeTimer !== undefined) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
    };
    heldPromptCloseGate.schedule = () => {
      heldPromptCloseGate.cancel();
      if (
        promptCloseStarted ||
        !heldPromptCloseGate.resultSeen ||
        (heldPromptCloseGate.sessionState !== undefined && heldPromptCloseGate.sessionState !== "idle") ||
        heldPromptCloseGate.activeSubagentCount > 0 ||
        heldPromptCloseGate.inflightCanUseTool > 0 ||
        heldPromptCloseGate.unmatchedUserTurns() ||
        heldPromptCloseGate.pendingQueuedTurns()
      ) {
        return;
      }
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        if (
          promptCloseStarted ||
          !heldPromptCloseGate.resultSeen ||
          (heldPromptCloseGate.sessionState !== undefined && heldPromptCloseGate.sessionState !== "idle") ||
          heldPromptCloseGate.activeSubagentCount > 0 ||
          heldPromptCloseGate.inflightCanUseTool > 0 ||
          heldPromptCloseGate.unmatchedUserTurns() ||
          heldPromptCloseGate.pendingQueuedTurns()
        ) {
          return;
        }
        promptCloseStarted = true;
        void (async () => {
          await notifyClosing();
          if (handle.phase === "open") {
            handle.phase = "closing";
          }
          promptStream.close();
        })();
      }, CLAUDE_HELD_PROMPT_CLOSE_GRACE_MS);
    };

    const subagentSessions = this.options.hookContext?.subagentSessions;
    if (subagentSessions) {
      const priorOnStart = subagentSessions.onStart;
      subagentSessions.onStart = (subagentInput) => {
        heldPromptCloseGate.activeSubagentCount += 1;
        heldPromptCloseGate.cancel();
        priorOnStart?.(subagentInput);
      };
      const priorOnStop = subagentSessions.onStop;
      subagentSessions.onStop = (subagentInput) => {
        heldPromptCloseGate.activeSubagentCount = Math.max(0, heldPromptCloseGate.activeSubagentCount - 1);
        priorOnStop?.(subagentInput);
        heldPromptCloseGate.schedule();
      };
    }

    const ensureInterrupt = (): Promise<SdkInterruptReceipt | undefined> => {
      if (!handle.interruptWork) {
        handle.interruptWork = interruptOrCloseSdkQuery(
          query,
          (probePhase, detail) => this.options.onContextProbe?.(probePhase, detail),
          { cancelQueued: this.options.cancelQueuedOnInterrupt ?? true },
        );
      }
      return handle.interruptWork;
    };

    const onAbort = () => {
      void ensureInterrupt();
      // Drive the SDK transport too: cancellation must not depend on iterator
      // progress, a context probe, or a mid-turn ingress waiter reaching finally.
      sdkAbortController.abort(input.signal.reason);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();

    let transcript = "";
    const phaseTranscriptBox = { text: "" };
    let sessionCaptured = false;
    let activeSessionId = "unknown-session";
    let resetPending = Boolean(input.resume?.newSessionId);
    let usageSessionResumed = Boolean(input.resume?.resumeSessionId);
    let usageResetId: string | undefined;
    // Slash detection uses the logical phase text, not typeof prompt (streaming path).
    const slashPrompt = phase.prompt.trim().startsWith("/");
    const slashCommand = slashPrompt ? phase.prompt.trim().split(/\s+/)[0]?.toLowerCase() : "";
    let contextUsageCollected = false;
    let permissionModeApplied = false;
    // Pair streaming-input turns: initial prompt + each successful mid-turn push.
    // A prior turn's result must not satisfy a later accepted input that never got a result.
    const pendingUserMessageUuids = new Set<string>([initialUserMessageUuid]);
    let completedResultTurns = 0;
    let pendingQueuedTurns = 0;
    heldPromptCloseGate.unmatchedUserTurns = () => pendingUserMessageUuids.size > 0;
    heldPromptCloseGate.pendingQueuedTurns = () => pendingQueuedTurns > 0;
    const pushUserMessage = handle.pushUserMessage.bind(handle);
    handle.pushUserMessage = async (text, pushOptions) => {
      const uuid = pushOptions?.uuid
        ? normalizeClaudeSdkUserMessageUuid(pushOptions.uuid)
        : crypto.randomUUID();
      pendingUserMessageUuids.add(uuid);
      try {
        await pushUserMessage(text, { ...pushOptions, uuid });
      } catch (error) {
        if (!isClaudeStreamInputDeliveryUnknown(error)) {
          pendingUserMessageUuids.delete(uuid);
          heldPromptCloseGate.schedule();
        }
        throw error;
      }
      // A new user turn is in flight — keep the mailbox open until its result.
      heldPromptCloseGate.cancel();
    };
    const iterator = query[Symbol.asyncIterator]();
    let pendingIteratorNext: Promise<IteratorResult<unknown>> | undefined;
    try {
      await sdkWorkOrAbort(Promise.resolve(this.options.queryLifecycle?.onOpen?.(handle)), input.signal);
      while (true) {
        if (input.signal.aborted) {
          break;
        }
        const nextOutcome = await nextSdkIteratorOrAbort(iterator, input.signal);
        if (nextOutcome.kind === "aborted") {
          pendingIteratorNext = nextOutcome.nextWork;
          break;
        }
        const next = nextOutcome.value;
        if (next.done) {
          break;
        }
        const message = next.value;
        if (
          isRecord(message) &&
          message.type === "system" &&
          message.subtype === "session_state_changed" &&
          (message.state === "idle" || message.state === "running" || message.state === "requires_action")
        ) {
          heldPromptCloseGate.sessionState = message.state;
          if (message.state === "idle") heldPromptCloseGate.schedule();
          else heldPromptCloseGate.cancel();
        }
        if (
          isRecord(message) &&
          message.type === "conversation_reset" &&
          typeof message.new_conversation_id === "string"
        ) {
          activeSessionId = message.new_conversation_id;
          // Local commands can reset before init; that init may still name the
          // resumed conversation. The reset's new id is authoritative.
          sessionCaptured = true;
          handle.sessionId = activeSessionId;
          usageSessionResumed = false;
          usageResetId = typeof message.uuid === "string" ? message.uuid : crypto.randomUUID();
          contextUsageCollected = false;
          resetPending = true;
          yield createSessionCapturedEvent(input.threadId, activeSessionId, sessionCwd, { resetPending });
        }
        for (const event of drainToolPermissionDecisionEvents(
          input.threadId,
          pendingToolPermissionDecisions,
        )) {
          yield event;
        }
        if (!sessionCaptured && isSdkInitMessage(message)) {
          const sessionId = readSdkSessionId(message);
          if (sessionId) {
            sessionCaptured = true;
            activeSessionId = sessionId;
            handle.sessionId = sessionId;
            yield createSessionCapturedEvent(input.threadId, sessionId, sessionCwd, { resetPending });
          }
        }

        // /clear allocates an ID without writing a resumable transcript. Keep
        // that intent durable until a real message establishes history.
        if (
          resetPending &&
          isRecord(message) &&
          message.type === "assistant" &&
          readSdkSessionId(message) === activeSessionId
        ) {
          resetPending = false;
          yield createSessionCapturedEvent(input.threadId, activeSessionId, sessionCwd);
        }
        // An API failure can persist the user turn without an assistant reply.
        // Check the actual transcript before settling a pending reset so a retry
        // resumes that turn rather than initializing an already-written ID.
        if (resetPending && isRecord(message) && message.type === "result" && sdk.getSessionMessages) {
          const persisted = await sdk.getSessionMessages(activeSessionId, { dir: sessionCwd });
          if (persisted.some((line) => line.type === "user")) {
            resetPending = false;
            yield createSessionCapturedEvent(input.threadId, activeSessionId, sessionCwd);
          }
        }

        if (
          !permissionModeApplied &&
          sessionCaptured &&
          phase.permissionMode !== "plan" &&
          typeof query.setPermissionMode === "function"
        ) {
          permissionModeApplied = true;
          await sdkWorkOrAbort(Promise.resolve(query.setPermissionMode(phase.permissionMode)), input.signal);
        }

        const checkpointId = readSdkUserMessageCheckpointId(message);
        if (checkpointId) {
          yield createFileCheckpointEvent(input.threadId, checkpointId);
        }

        let pendingContextEvents: AgentEvent[] = [];
        if (
          isRecord(message) &&
          message.type === "result" &&
          (!slashPrompt || slashCommand === "/compact") &&
          !contextUsageCollected &&
          typeof query.getContextUsage === "function"
        ) {
          this.options.onContextProbe?.("query_result", summarizeSdkResultForProbe(message, activeSessionId));
          contextUsageCollected = true;
          pendingContextEvents = await sdkWorkOrAbort(
            this.collectContextUsageEvents(query, input.threadId, activeSessionId),
            input.signal,
          );
        }

        // Calibrate planner context from getContextUsage before result billing usage.
        for (const contextEvent of pendingContextEvents) {
          yield contextEvent;
        }

        if (isRecord(message) && message.type === "result") {
          const uuids = readUserMessageUuidFields(message);
          const matched = [
            uuids.user_message_uuid,
            ...(Array.isArray(uuids.user_message_uuids) ? uuids.user_message_uuids : []),
          ].filter((uuid): uuid is string => typeof uuid === "string");
          if (matched.length > 0 && !isSdkBackgroundOnlyResult(message)) {
            for (const uuid of matched) pendingUserMessageUuids.delete(uuid);
          } else if (!isSdkBackgroundOnlyResult(message)) {
            // Older SDKs and startup failures can omit prompt UUIDs. Consume one
            // input only; an interim background result must never settle a user turn.
            const first = pendingUserMessageUuids.values().next().value;
            if (first) pendingUserMessageUuids.delete(first);
          }
          if (!isSdkBackgroundOnlyResult(message)) completedResultTurns += 1;
          const queuedTurnCount =
            typeof message.queued_turn_count === "number" && Number.isFinite(message.queued_turn_count)
              ? Math.max(0, Math.floor(message.queued_turn_count))
              : typeof message.queuedTurnCount === "number" && Number.isFinite(message.queuedTurnCount)
                ? Math.max(0, Math.floor(message.queuedTurnCount))
                : 0;
          pendingQueuedTurns = queuedTurnCount;
        }

        this.options.onSdkMessage?.(message);
        const backgroundTasks = readClaudeBackgroundTasksChanged(message);
        if (backgroundTasks) {
          this.options.onBackgroundTasksChanged?.({
            threadId: input.threadId,
            query,
            tasks: backgroundTasks,
          });
        }

        const mappedMessage =
          isRecord(message) && message.type === "result"
            ? {
                ...message,
                ...(sessionCaptured && {
                  sdk_session_usage: {
                    sessionId: activeSessionId,
                    resumed: usageSessionResumed,
                    ...(usageResetId && { resetId: usageResetId }),
                  },
                }),
              }
            : message;
        for (const event of mapSdkMessageToEvents(mappedMessage, input.threadId, streamCtx)) {
          yield event;
          transcript = appendToPhaseTranscript(transcript, event);
          phaseTranscriptBox.text = transcript;
        }

        // Defer protocol primary channel: the result payload carries the deferred ExitPlanMode
        // call (`deferred_tool_use`). The PreToolUse capture covers the same tool use id, so
        // this only lands when the hook path missed it.
        if (onExitPlanMode) {
          const capturedDeferredExit = await captureDeferredExitPlanModeFromResult(
            message,
            onExitPlanMode,
            exitPlanCaptureState,
            {
              searchRoots: [input.workspacePath, sessionCwd],
              getPhaseTranscript: () => phaseTranscriptBox.text,
            },
          );
          const deferredExit = capturedDeferredExit ? parseDeferredExitPlanModeResult(message) : undefined;
          if (finalizedPlan && deferredExit) {
            finalizedPlan.deferredExitPlanToolUseId = deferredExit.toolUseId;
          }
        }

        if (input.signal.aborted) {
          break;
        }

        // Streaming prompt ⇒ SDK multi-turn Query (no endInput on result). After a
        // matched result, schedule mailbox close so the Eco-run can converge to idle;
        // canUseTool / subagents / unmatched mid-turn push / remaining queued turns
        // cancel or delay that close.
        if (isRecord(message) && message.type === "result") {
          heldPromptCloseGate.resultSeen = true;
          heldPromptCloseGate.schedule();
        }
      }

      const unmatchedUserTurns = pendingUserMessageUuids.size > 0 || pendingQueuedTurns > 0;
      if (unmatchedUserTurns || completedResultTurns === 0) {
        if (input.signal.aborted) {
          yield createAgentEvent({
            id: `${crypto.randomUUID()}:run-terminal-cancelled`,
            threadId: input.threadId,
            agentId: activeSessionId,
            role: "main",
            type: "run.terminal",
            payload: {
              status: "cancelled",
              reason: "cancelled by user",
            } satisfies ClaudeRunTerminal,
          });
        } else {
          yield createAgentEvent({
            id: `${crypto.randomUUID()}:run-terminal-incomplete`,
            threadId: input.threadId,
            agentId: activeSessionId,
            role: "main",
            type: "run.terminal",
            payload: {
              status: "incomplete",
              reason:
                pendingQueuedTurns > 0
                  ? "Claude run ended while queued turns were still pending."
                  : unmatchedUserTurns
                    ? "Claude run ended while a user turn was still awaiting a result."
                    : "Claude run ended without a terminal result.",
            } satisfies ClaudeRunTerminal,
          });
        }
      }
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      heldPromptCloseGate.cancel();
      await notifyClosing();
      promptStream.close();
      try {
        const teardown = await teardownClaudeQueryHandle(handle, {
          iterator,
          ...(pendingIteratorNext ? { pendingNext: pendingIteratorNext } : {}),
          shouldInterrupt: input.signal.aborted,
          interruptDeadlineMs: this.options.queryControlDeadlineMs ?? CLAUDE_QUERY_CONTROL_DEADLINE_MS,
          drainDeadlineMs: this.options.queryControlDeadlineMs ?? CLAUDE_QUERY_DRAIN_DEADLINE_MS,
          cancelQueued: this.options.cancelQueuedOnInterrupt ?? true,
          onProbe: (probePhase, detail) => this.options.onContextProbe?.(probePhase, detail),
          clearSubagentLimits: () => subagentRuntimeLimit.clear(),
        });
        try {
          await this.options.queryLifecycle?.onClosed?.(handle, {
            stillQueued: teardown.stillQueued,
            cancelled: teardown.cancelled,
          });
        } catch {
          // Reconcile hooks must not suppress post-run cleanup callers.
        }
      } finally {
        this.options.onBackgroundTasksClosed?.({ threadId: input.threadId, query });
      }
    }
    for (const event of drainToolPermissionDecisionEvents(input.threadId, pendingToolPermissionDecisions)) {
      yield event;
    }

    return { transcript: transcript.trim(), ...(finalizedPlan ? { finalizedPlan } : {}) };
  }

  /** Once per agent `result`, while the SDK query transport is still open. */
  private async collectContextUsageEvents(
    query: SdkQueryHandle,
    threadId: string,
    sessionId: string,
  ): Promise<AgentEvent[]> {
    if (typeof query.getContextUsage !== "function") {
      return [];
    }
    try {
      const usage = await query.getContextUsage({ detail: "summary" });
      this.options.onContextProbe?.("getContextUsage", {
        usage: usage as unknown as Record<string, unknown>,
        timing: "on_result",
      });
      const role: AgentRole = "main";
      return [
        createAgentEvent({
          id: `${crypto.randomUUID()}:sdk-context-usage`,
          threadId,
          agentId: sessionId,
          role,
          type: "usage.recorded",
          payload: {
            type: "sdk_context_usage",
            ecoSdkContextUsage: usage,
          },
        }),
      ];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.options.onContextProbe?.("getContextUsage_error", {
        error: errorMessage,
        timing: "on_result",
      });
      return [];
    }
  }

  private async *runSlashCommand(
    input: AgentRuntimeRunInput,
    command: string,
    options: { permissionMode: "dontAsk" | "default" | "acceptEdits" },
  ): AsyncGenerator<AgentEvent, string> {
    if (!input.resume?.resumeSessionId) {
      throw new Error(`${command} requires an existing SDK session (resume).`);
    }
    const result = yield* this.runSingleSession(input, {
      prompt: command,
      permissionMode: options.permissionMode,
      allowedTools: [],
    });
    return result.transcript;
  }

  private async loadSdk(): Promise<ClaudeAgentSdkModule> {
    if (this.options.loadSdk) {
      return this.options.loadSdk();
    }

    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<ClaudeAgentSdkModule>;
    return dynamicImport("@anthropic-ai/claude-agent-sdk");
  }
}

interface ProbeTextSummary {
  chars: number;
  bytes: number;
  hash: string;
}

function summarizeTextForProbe(value: string): ProbeTextSummary {
  return {
    chars: value.length,
    bytes: Buffer.byteLength(value, "utf8"),
    hash: stableTextDigest(value),
  };
}

function summarizeSystemPromptForProbe(systemPrompt: unknown): Record<string, unknown> {
  if (!isRecord(systemPrompt)) {
    return { kind: typeof systemPrompt, bytes: jsonBytes(systemPrompt) };
  }
  const append = typeof systemPrompt.append === "string" ? systemPrompt.append : undefined;
  const prompt = typeof systemPrompt.prompt === "string" ? systemPrompt.prompt : undefined;
  return {
    kind: typeof systemPrompt.type === "string" ? systemPrompt.type : "object",
    keys: Object.keys(systemPrompt).sort(),
    bytes: jsonBytes(systemPrompt),
    ...(typeof systemPrompt.preset === "string" && { preset: systemPrompt.preset }),
    ...(append !== undefined && { append: summarizeTextForProbe(append) }),
    ...(prompt !== undefined && { prompt: summarizeTextForProbe(prompt) }),
    excludeDynamicSections: systemPrompt.excludeDynamicSections === true,
  };
}

function summarizeAgentsForProbe(agents: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!agents) {
    return { count: 0, keys: [] };
  }
  const entries = Object.entries(agents);
  return {
    count: entries.length,
    keys: entries.map(([key]) => key).slice(0, 40),
    definitions: entries.slice(0, 20).map(([key, definition]) => {
      const record = isRecord(definition) ? definition : {};
      return {
        key,
        model: typeof record.model === "string" ? record.model : null,
        autoCompactWindow: typeof record.autoCompactWindow === "number" ? record.autoCompactWindow : null,
        description:
          typeof record.description === "string" ? summarizeTextForProbe(record.description) : null,
        prompt: typeof record.prompt === "string" ? summarizeTextForProbe(record.prompt) : null,
        toolsCount: readStringArray(record.tools).length,
        disallowedToolsCount: readStringArray(record.disallowedTools).length,
        skillsCount: readStringArray(record.skills).length,
      };
    }),
  };
}

function summarizeSdkResultForProbe(
  message: Record<string, unknown>,
  activeSessionId: string,
): Record<string, unknown> {
  const modelUsage = isRecord(message.modelUsage) ? message.modelUsage : undefined;
  const usage = isRecord(message.usage) ? message.usage : undefined;
  return {
    sessionId: typeof message.session_id === "string" ? message.session_id : activeSessionId,
    uuid: typeof message.uuid === "string" ? message.uuid : undefined,
    subtype: typeof message.subtype === "string" ? message.subtype : undefined,
    terminalReason: typeof message.terminal_reason === "string" ? message.terminal_reason : undefined,
    isError: message.is_error === true,
    hasUsage: Boolean(usage),
    ...(usage && { usage: summarizeUsageObjectForProbe(usage) }),
    modelUsageCount: modelUsage ? Object.keys(modelUsage).length : 0,
    ...(modelUsage && {
      modelUsage: Object.entries(modelUsage)
        .slice(0, 12)
        .map(([modelId, entry]) => ({
          modelId,
          ...(isRecord(entry) && { usage: summarizeUsageObjectForProbe(entry) }),
        })),
    }),
    ...(typeof message.totalCostUsd === "number" && { totalCostUsd: message.totalCostUsd }),
    ...(typeof message.total_cost_usd === "number" && { totalCostUsd: message.total_cost_usd }),
  };
}

function summarizeUsageObjectForProbe(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    inputTokens: readNumberField(usage, "input_tokens", "inputTokens"),
    outputTokens: readNumberField(usage, "output_tokens", "outputTokens"),
    cacheReadTokens: readNumberField(
      usage,
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cache_read_tokens",
    ),
    cacheCreationTokens: readNumberField(
      usage,
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
      "cache_creation_tokens",
    ),
  };
}

function readNumberField(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function stableTextDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** @deprecated Use createAutonomousAgentDefinitions */
export function createAgentDefinitions(
  routes: readonly ResolvedModelRoute[],
  agentSkills?: Partial<Record<RuntimeAgentRole, string[]>>,
  availability?: SubagentAvailability,
): Record<string, unknown> {
  return createAutonomousAgentDefinitions(routes, agentSkills, availability);
}

function createExploreAgentDefinition(
  routes: readonly ResolvedModelRoute[],
  agentSkills?: Partial<Record<RuntimeAgentRole, string[]>>,
): Record<string, unknown> {
  const routeByRole = new Map(routes.map((route) => [route.role, route]));
  return {
    description: exploreAgentDescription,
    ...agentDefinitionToolFields("explore", exploreSubagentTools, agentSkills),
    prompt: exploreAgentPrompt,
    model: toSdkAgentModel(routeByRole.get("explore")?.primary.modelId, "explore"),
  };
}

export function createPlanningAgentDefinitions(
  routes: readonly ResolvedModelRoute[],
  agentSkills?: Partial<Record<RuntimeAgentRole, string[]>>,
  availability: SubagentAvailability = normalizeSubagentAvailability(),
): Record<string, unknown> {
  const effective = effectiveSubagentAvailability(availability, routes);
  const routeByRole = new Map(routes.map((route) => [route.role, route]));
  const definitions: Record<string, unknown> = {};
  if (isSubagentEnabled(effective, "explore")) {
    definitions[ecoSubagentKeyForRole("explore")] = createExploreAgentDefinition(routes, agentSkills);
  }
  if (isSubagentEnabled(effective, "architect")) {
    definitions[ecoSubagentKeyForRole("architect")] = {
      description: planningArchitectDescription,
      ...agentDefinitionToolFields("architect", readOnlySubagentTools, agentSkills),
      prompt: planningArchitectPrompt,
      model: toSdkAgentModel(routeByRole.get("architect")?.primary.modelId, "architect"),
    };
  }
  return definitions;
}

export function createAskAgentDefinitions(
  routes: readonly ResolvedModelRoute[],
  agentSkills?: Partial<Record<RuntimeAgentRole, string[]>>,
  availability: SubagentAvailability = normalizeSubagentAvailability(),
): Record<string, unknown> {
  const effective = effectiveSubagentAvailability(availability, routes);
  if (!isSubagentEnabled(effective, "explore")) {
    return {};
  }
  return {
    [ecoSubagentKeyForRole("explore")]: createExploreAgentDefinition(routes, agentSkills),
  };
}

/** @deprecated Import from ./prompts/execution-agents.js */
export { reviewerAgentPrompt };

const autonomousReviewerDescription = [
  "High-risk code review only: cross-module changes, security, or data-sensitive paths.",
  "Review ONLY this session's workspace changes (not full repo history).",
  "When NOT to use: low/medium risk — the main agent should self-review with Read/Grep/git diff instead.",
].join(" ");

export function createAutonomousAgentDefinitions(
  routes: readonly ResolvedModelRoute[],
  agentSkills?: Partial<Record<RuntimeAgentRole, string[]>>,
  availability: SubagentAvailability = defaultSubagentAvailability(),
): Record<string, unknown> {
  const effective = effectiveSubagentAvailability(availability, routes);
  const routeByRole = new Map(routes.map((route) => [route.role, route]));
  const definitions: Record<string, unknown> = {};
  if (isSubagentEnabled(effective, "explore")) {
    definitions[ecoSubagentKeyForRole("explore")] = createExploreAgentDefinition(routes, agentSkills);
  }
  if (isSubagentEnabled(effective, "architect")) {
    definitions[ecoSubagentKeyForRole("architect")] = {
      description: executionArchitectDescription,
      ...agentDefinitionToolFields("architect", readOnlySubagentTools, agentSkills),
      prompt: executionArchitectPrompt,
      model: toSdkAgentModel(routeByRole.get("architect")?.primary.modelId, "architect"),
    };
  }
  if (isSubagentEnabled(effective, "coder")) {
    definitions[ecoSubagentKeyForRole("coder")] = {
      description: executionCoderDescription,
      ...agentDefinitionToolFields("coder", executionCoderTools, agentSkills),
      prompt: executionCoderPrompt,
      model: toSdkAgentModel(routeByRole.get("coder")?.primary.modelId, "coder"),
    };
  }
  if (isSubagentEnabled(effective, "reviewer")) {
    definitions[ecoSubagentKeyForRole("reviewer")] = {
      description: autonomousReviewerDescription,
      ...agentDefinitionToolFields("reviewer", readOnlySubagentBashTools, agentSkills),
      prompt: reviewerAgentPrompt,
      model: toSdkAgentModel(routeByRole.get("reviewer")?.primary.modelId, "reviewer"),
    };
  }
  if (isSubagentEnabled(effective, "tester")) {
    definitions[ecoSubagentKeyForRole("tester")] = {
      description: executionTesterDescription,
      ...agentDefinitionToolFields("tester", readOnlySubagentBashTools, agentSkills),
      prompt: executionTesterPrompt,
      model: toSdkAgentModel(routeByRole.get("tester")?.primary.modelId, "tester"),
    };
  }
  return definitions;
}

export function toSdkAgentModel(modelId?: string, role = "subagent"): string {
  const resolved = modelId?.trim();
  if (!resolved) {
    throw new Error(`Missing model id for ${role} subagent. Subagents must use explicit models.`);
  }
  return resolved;
}

export interface BuildSdkProcessEnvOptions {
  apiKey: string;
  baseUrl: string;
  thinkingEffort?: ThinkingEffort;
  anthropicAuthMode?: "api-key" | "bearer";
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** Merge host env and force local router credentials so Claude Code does not call api.anthropic.com directly. */
export function buildSdkProcessEnv(options: BuildSdkProcessEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.ANTHROPIC_BASE_URL = options.baseUrl.replace(/\/+$/, "");
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "eco-coding";
  if (options.contextWindow !== undefined) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = serializeSdkContextWindow(options.contextWindow);
  }
  if (options.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) {
      throw new Error("Claude SDK requires a valid resolved max output token ceiling.");
    }
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(options.maxOutputTokens);
  }
  if (options.anthropicAuthMode === "bearer") {
    env.ANTHROPIC_AUTH_TOKEN = options.apiKey;
    delete env.ANTHROPIC_API_KEY;
  } else {
    env.ANTHROPIC_API_KEY = options.apiKey;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  applyThinkingToProcessEnv(env, options.thinkingEffort);
  env.CLAUDE_CODE_DISABLE_WORKFLOWS = "1";
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
  // Stop injecting per-request cch= into the system prompt (breaks prompt cache).
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";

  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

function serializeSdkContextWindow(contextWindow: number): string {
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2) {
    throw new Error("Claude SDK requires a valid resolved context window.");
  }
  return String(contextWindow);
}

export function getDefaultAllowedTools(): string[] {
  return [...defaultAllowedTools];
}

export function stripBashAutoApprovedTools(tools: readonly string[]): string[] {
  return tools.filter((tool) => tool.trim() !== "Bash");
}

export function stripProtectedPlanModeAutoApprovedTools(tools: readonly string[]): string[] {
  return tools.filter((tool) => !matchesProtectedPlanModeToolPattern(tool));
}

function matchesProtectedPlanModeToolPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  return protectedPlanModeToolNames.some((toolName) => matchesSimpleToolPattern(toolName, trimmed));
}

function matchesSimpleToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*" || pattern === toolName) {
    return true;
  }
  if (!pattern.includes("*")) {
    return false;
  }
  const parts = pattern.split("*");
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    if (!part) {
      continue;
    }
    const found = toolName.indexOf(part, offset);
    if (found < 0) {
      return false;
    }
    if (index === 0 && found !== 0) {
      return false;
    }
    offset = found + part.length;
  }
  const last = parts[parts.length - 1] ?? "";
  return !last || toolName.endsWith(last);
}

/** SDK settings schema: autoCompactWindow is 100k–1M. */
export const SDK_AUTO_COMPACT_WINDOW_MIN = 100_000;
export const SDK_AUTO_COMPACT_WINDOW_MAX = 1_000_000;

export function resolveSdkAutoCompactWindow(contextWindow: number | undefined): number | undefined {
  if (contextWindow === undefined || !Number.isFinite(contextWindow)) {
    return undefined;
  }
  const windowSize = Math.floor(contextWindow);
  if (windowSize < SDK_AUTO_COMPACT_WINDOW_MIN || windowSize > SDK_AUTO_COMPACT_WINDOW_MAX) {
    return undefined;
  }
  return windowSize;
}

/** SDK settings shared by every query(): disable Dynamic Workflows and route API credentials. */
export function applyEcoSdkSettings(
  queryOptions: Record<string, unknown>,
  apiKey: string,
  baseUrl: string,
  options: {
    allowedSdkBuiltinAgentKeys?: readonly string[];
    autoCompactWindow?: number;
    anthropicAuthMode?: "api-key" | "bearer";
    contextWindow?: number;
    maxOutputTokens?: number;
  } = {},
): void {
  const existing = isRecord(queryOptions.settings) ? queryOptions.settings : {};
  const existingEnv = isRecord(existing.env) ? (existing.env as Record<string, string>) : {};
  const existingPermissions = isRecord(existing.permissions) ? existing.permissions : {};
  const existingDeny = Array.isArray(existingPermissions.deny) ? (existingPermissions.deny as string[]) : [];
  const deny = [
    ...new Set([...existingDeny, ...sdkBuiltinSubagentDenyRules(options.allowedSdkBuiltinAgentKeys)]),
  ];
  const autoCompactWindow = resolveSdkAutoCompactWindow(options.autoCompactWindow);
  queryOptions.settings = {
    ...existing,
    disableWorkflows: true,
    autoCompactEnabled: true,
    ...(autoCompactWindow !== undefined && { autoCompactWindow }),
    plansDirectory: ".claude/plans",
    permissions: {
      ...existingPermissions,
      deny,
    },
    env: {
      ...existingEnv,
      ANTHROPIC_BASE_URL: baseUrl.replace(/\/+$/, ""),
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      ...(options.contextWindow !== undefined
        ? {
            CLAUDE_CODE_MAX_CONTEXT_TOKENS: serializeSdkContextWindow(options.contextWindow),
          }
        : {}),
      ...(options.maxOutputTokens !== undefined
        ? {
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxOutputTokens),
          }
        : {}),
      ...(options.anthropicAuthMode === "bearer"
        ? { ANTHROPIC_AUTH_TOKEN: apiKey }
        : { ANTHROPIC_API_KEY: apiKey }),
    },
  };
}

export function applyResumeToQueryOptions(
  queryOptions: Record<string, unknown>,
  resume?: EcoSdkResumeOptions,
): void {
  if (resume?.newSessionId) {
    if (resume.resumeSessionId || resume.resumeSessionAt || resume.resumeDropsTurn || resume.forkSession) {
      throw new Error("An empty reset conversation cannot also resume or fork a transcript.");
    }
    queryOptions.sessionId = resume.newSessionId;
  }
  if (resume?.resumeSessionId) {
    queryOptions.resume = resume.resumeSessionId;
  }
  if (resume?.resumeSessionAt) {
    queryOptions.resumeSessionAt = resume.resumeSessionAt;
  }
  if (resume?.resumeDropsTurn) {
    queryOptions.resumeDropsTurn = resume.resumeDropsTurn;
  }
  if (resume?.forkSession) {
    queryOptions.forkSession = true;
  }
}

/** Claude CLI refusal prefix when resumeDropsTurn validation fails (deterministic). */
export const RESUME_DROPS_TURN_REJECTED_PREFIX = "Resume rejected by --resume-drops-turn:";

export function isResumeDropsTurnRejection(message: string | null | undefined): boolean {
  if (!message) return false;
  return message.includes(RESUME_DROPS_TURN_REJECTED_PREFIX);
}

/**
 * User-facing / diagnostic message for a resumeDropsTurn refusal.
 * Do not retry the same fork params — refusal is deterministic.
 */
export function formatResumeDropsTurnRejection(message: string): string {
  return [
    "截断 resume 被 Claude CLI 拒绝（resumeDropsTurn 校验失败）：丢弃区间包含非拟丢弃 turn 的内容。",
    "不会重试同一 fork。请以 plain resume 继续或重新选择回退节点。",
    message.trim(),
  ].join("\n");
}

export function applyClaudeJsonlSessionPersistence(queryOptions: Record<string, unknown>): void {
  // Persist the SDK session to local JSONL only — never enable SDK file checkpointing
  // (rewind is conversation-only; Eco must not restore files or snapshot file state).
  delete queryOptions.sessionStore;
  queryOptions.extraArgs = {
    ...(isRecord(queryOptions.extraArgs) ? (queryOptions.extraArgs as Record<string, unknown>) : {}),
    "replay-user-messages": null,
  };
}

/**
 * Interrupt the query when possible; fall back to close on missing/erroring interrupt.
 * Idempotent when called via a shared promise on ClaudeQueryHandle.interruptWork.
 * Returns the interrupt receipt when the SDK provides one (still_queued for foundation probes).
 */
export async function interruptOrCloseSdkQuery(
  query: SdkQueryHandle,
  onProbe?: (phase: string, detail: Record<string, unknown>) => void,
  options?: { cancelQueued?: boolean },
): Promise<SdkInterruptReceipt | undefined> {
  if (typeof query.interrupt !== "function") {
    query.close?.();
    onProbe?.("interrupt", {
      receipt: null,
      still_queued: [],
      cancelled: [],
      closed_without_interrupt: true,
    });
    return undefined;
  }

  try {
    const cancelQueued = options?.cancelQueued ?? true;
    const receipt = await query.interrupt({ cancelQueued });
    const stillQueued = isRecord(receipt) ? readStringArray(receipt.still_queued) : [];
    const cancelled = isRecord(receipt) ? readStringArray(receipt.cancelled) : [];
    onProbe?.("interrupt", {
      receipt: receipt ?? null,
      still_queued: stillQueued,
      cancelled,
    });
    return receipt;
  } catch (error) {
    onProbe?.("interrupt_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    query.close?.();
    return undefined;
  }
}

type DeadlineResult<T> =
  | { kind: "settled"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "timeout" };

async function sdkWorkOrAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}

async function settleWithin<T>(work: Promise<T>, deadlineMs: number): Promise<DeadlineResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, deadlineMs));
  });
  try {
    return await Promise.race([
      work.then(
        (value): DeadlineResult<T> => ({ kind: "settled", value }),
        (error: unknown): DeadlineResult<T> => ({ kind: "rejected", error }),
      ),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function nextSdkIteratorOrAbort(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): Promise<
  | { kind: "next"; value: IteratorResult<unknown> }
  | { kind: "aborted"; nextWork: Promise<IteratorResult<unknown>> }
> {
  const nextWork = iterator.next();
  if (signal.aborted) {
    return { kind: "aborted", nextWork };
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve({ kind: "aborted", nextWork });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void nextWork.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "next", value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function drainAsyncIterator(
  iterator: AsyncIterator<unknown>,
  deadlineMs: number,
  pendingNext?: Promise<IteratorResult<unknown>>,
): Promise<{ drained: boolean; timedOut: boolean; frames: number }> {
  const deadline = Date.now() + Math.max(0, deadlineMs);
  let frames = 0;
  let nextWork = pendingNext;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const raced = await settleWithin(nextWork ?? iterator.next(), remaining);
    nextWork = undefined;
    if (raced.kind === "timeout") {
      return { drained: false, timedOut: true, frames };
    }
    if (raced.kind === "rejected") {
      throw raced.error;
    }
    if (raced.value.done) {
      return { drained: true, timedOut: false, frames };
    }
    frames += 1;
  }
  return { drained: false, timedOut: true, frames };
}

/**
 * Unified Query teardown: optional interrupt → bounded residual drain → close.
 * Transitions handle.phase open → closing → closed. Safe to call once.
 */
export async function teardownClaudeQueryHandle(
  handle: ClaudeQueryHandle,
  options: {
    iterator?: AsyncIterator<unknown>;
    pendingNext?: Promise<IteratorResult<unknown>>;
    shouldInterrupt: boolean;
    interruptDeadlineMs?: number;
    drainDeadlineMs?: number;
    cancelQueued?: boolean;
    onProbe?: (phase: string, detail: Record<string, unknown>) => void;
    clearSubagentLimits?: () => void;
  },
): Promise<ClaudeQueryTeardownResult> {
  if (handle.phase === "closed") {
    options.clearSubagentLimits?.();
    return { stillQueued: [], cancelled: [], closed: true, interrupted: options.shouldInterrupt };
  }
  handle.phase = "closing";
  const started = Date.now();
  let stillQueued: string[] = [];
  let cancelled: string[] = [];
  let closed = false;
  let interruptMs = 0;
  let interruptTimedOut = false;
  let drain: { drained: boolean; timedOut: boolean; frames: number } | undefined;

  const closeQuery = () => {
    if (closed) return;
    try {
      handle.query.close?.();
      closed = true;
    } catch (error) {
      options.onProbe?.("query_close_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    if (options.shouldInterrupt) {
      const interruptStarted = Date.now();
      if (!handle.interruptWork) {
        handle.interruptWork = interruptOrCloseSdkQuery(handle.query, options.onProbe, {
          cancelQueued: options.cancelQueued ?? true,
        });
      }
      const interruptResult = await settleWithin(
        handle.interruptWork,
        options.interruptDeadlineMs ?? CLAUDE_QUERY_CONTROL_DEADLINE_MS,
      );
      if (interruptResult.kind === "settled") {
        const receipt = interruptResult.value;
        stillQueued = isRecord(receipt) ? readStringArray(receipt.still_queued) : [];
        cancelled = isRecord(receipt) ? readStringArray(receipt.cancelled) : [];
      } else if (interruptResult.kind === "timeout") {
        interruptTimedOut = true;
        options.onProbe?.("interrupt_timeout", {
          deadline_ms: options.interruptDeadlineMs ?? CLAUDE_QUERY_CONTROL_DEADLINE_MS,
        });
        closeQuery();
      }
      interruptMs = Date.now() - interruptStarted;
      // Once Stop is acknowledged (or its deadline expires), close the query
      // before draining residual frames, so tools/queued turns cannot keep running.
      closeQuery();
    }

    if (options.iterator && !interruptTimedOut) {
      try {
        drain = await drainAsyncIterator(
          options.iterator,
          options.drainDeadlineMs ??
            (options.shouldInterrupt ? CLAUDE_QUERY_CONTROL_DEADLINE_MS : CLAUDE_QUERY_DRAIN_DEADLINE_MS),
          options.pendingNext,
        );
      } catch (error) {
        options.onProbe?.("query_drain_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    closeQuery();
  } finally {
    handle.phase = "closed";
    options.clearSubagentLimits?.();
    options.onProbe?.("query_teardown", {
      interrupted: options.shouldInterrupt,
      interrupt_ms: interruptMs,
      interrupt_timed_out: interruptTimedOut,
      closed,
      still_queued: stillQueued,
      cancelled,
      drain_frames: drain?.frames ?? 0,
      drain_timed_out: drain?.timedOut ?? false,
      elapsed_ms: Date.now() - started,
      session_id: handle.sessionId ?? null,
    });
  }
  return {
    stillQueued,
    cancelled,
    closed,
    interrupted: options.shouldInterrupt,
  };
}

export function readSdkUserMessageCheckpointId(message: unknown): string | undefined {
  if (!isRecord(message) || message.type !== "user") {
    return undefined;
  }
  // Tool results are SDK user-role frames too, but their UUID is not a user
  // prompt's history target. A mid-turn steer can still be awaiting delivery.
  const content = isRecord(message.message) ? message.message.content : undefined;
  if (Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "tool_result")) {
    return undefined;
  }
  return typeof message.uuid === "string" && message.uuid.trim() ? message.uuid.trim() : undefined;
}

export function createFileCheckpointEvent(threadId: string, userMessageId: string): AgentEvent {
  return createAgentEvent({
    id: `file-checkpoint:${userMessageId}`,
    type: "file.checkpoint",
    threadId,
    role: "main",
    agentId: "eco-checkpoint",
    payload: { userMessageId },
  });
}

export function readSdkSessionId(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  return typeof message.session_id === "string" ? message.session_id : undefined;
}

export function isSdkInitMessage(message: unknown): boolean {
  return isRecord(message) && message.type === "system" && message.subtype === "init";
}

export function createSessionCapturedEvent(
  threadId: string,
  sessionId: string,
  cwd: string,
  state?: { resetPending?: boolean },
): AgentEvent {
  return createAgentEvent({
    id: `${threadId}:session:${sessionId}`,
    threadId,
    agentId: sessionId,
    role: "main",
    type: "session.captured",
    payload: { sessionId, cwd, ...(state?.resetPending && { resetPending: true }) },
  });
}

export function createToolPermissionDeniedEvent(
  threadId: string,
  decision: EcoToolPermissionDecisionAudit,
  uuidFactory: () => string = () => crypto.randomUUID(),
): AgentEvent {
  const subagentRole = normalizeSdkRuntimeAgentRole(decision.agentType ?? decision.actor);
  return createAgentEvent({
    id: `${threadId}:tool-permission-denied:${decision.toolUseId}:${uuidFactory()}`,
    threadId,
    agentId: decision.agentId ?? decision.sessionId ?? decision.actor,
    role: subagentRole ?? "main",
    type: "tool.failed",
    payload: {
      type: "tool_permission_denied",
      tool_name: decision.toolName,
      tool_use_id: decision.toolUseId,
      permission_decision: decision.permissionDecision,
      message: decision.reason,
      actor: decision.actor,
      cwd: decision.cwd,
      ...(decision.sessionId && { session_id: decision.sessionId }),
      ...(decision.agentId && { agent_id: decision.agentId }),
      ...(decision.agentType && { agent_type: decision.agentType }),
    },
  });
}

function drainToolPermissionDecisionEvents(
  threadId: string,
  queue: EcoToolPermissionDecisionAudit[],
  uuidFactory: () => string = () => crypto.randomUUID(),
): AgentEvent[] {
  const events: AgentEvent[] = [];
  while (queue.length > 0) {
    const decision = queue.shift();
    if (decision) {
      events.push(createToolPermissionDeniedEvent(threadId, decision, uuidFactory));
    }
  }
  return events;
}

export { buildAutonomousPlanContinuationPrompt } from "./prompts/autonomous.js";

export function createPhaseBoundaryEvent(threadId: string, phase: EcoRunPhase, label: string): AgentEvent {
  return createAgentEvent({
    id: `${threadId}:eco-phase-${phase}-${crypto.randomUUID()}`,
    threadId,
    agentId: "eco-orchestrator",
    role: "main",
    type: "agent.started",
    payload: { ecoPhase: phase, label },
  });
}

export function extractSdkRunFailure(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const isTerminalResult =
    payload.type === "result" || (payloadHasSdkResultShape(payload) && typeof payload.subtype === "string");

  if (!isTerminalResult) {
    return null;
  }

  const terminalFailureReason = readTerminalFailureReason(payload);
  const isError = payload.is_error === true;
  if (payload.subtype === "success" && !terminalFailureReason && !isError) {
    return null;
  }

  const apiErrorStatus =
    typeof payload.api_error_status === "number" && Number.isFinite(payload.api_error_status)
      ? payload.api_error_status
      : undefined;
  if (apiErrorStatus !== undefined) {
    const errorText =
      typeof payload.result === "string" && payload.result.trim()
        ? payload.result.trim()
        : Array.isArray(payload.errors)
          ? payload.errors.filter((entry): entry is string => typeof entry === "string").join("\n")
          : "";
    return formatApiErrorUserMessage({
      statusCode: apiErrorStatus,
      message: errorText || "API 请求失败",
    });
  }

  if (typeof payload.result === "string" && payload.result.trim()) {
    const resultText = payload.result.trim();
    if (isResumeDropsTurnRejection(resultText)) {
      return formatResumeDropsTurnRejection(resultText);
    }
    return resultText;
  }

  if (Array.isArray(payload.errors)) {
    const messages = payload.errors.filter((entry): entry is string => typeof entry === "string");
    if (messages.length > 0) {
      const joined = messages.join("\n");
      if (isResumeDropsTurnRejection(joined)) {
        return formatResumeDropsTurnRejection(joined);
      }
      return joined;
    }
  }

  if (terminalFailureReason) {
    return `Agent run failed (terminal_reason: ${terminalFailureReason}).`;
  }

  if (typeof payload.startup_failure_reason === "string") {
    return `Claude Code startup failed: ${payload.startup_failure_reason}.`;
  }

  if (isError) {
    return "Agent run failed (is_error: true).";
  }

  return `Agent run failed (${String(payload.subtype ?? "error")}).`;
}

export function extractSdkRunIncompleteReason(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const isTerminalResult =
    payload.type === "result" || (payloadHasSdkResultShape(payload) && typeof payload.subtype === "string");
  if (!isTerminalResult) {
    return null;
  }

  if (payload.stop_reason === "max_tokens") {
    return "模型输出达到 max_tokens 上限，响应已被截断；执行尚未完成，请继续执行或提高模型输出上限。";
  }

  if (payload.terminal_reason === "stop_hook_prevented") {
    return "SDK 报告 stop_hook_prevented，本轮未正常完成。";
  }

  return null;
}

/**
 * Map Claude SDK `result` message fields into a single run terminal.
 * Usage/billing fields are intentionally ignored here.
 * Payload contract: `@eco/shared` `ClaudeRunTerminal`.
 */
export type { ClaudeRunTerminal };

export function resolveClaudeRunTerminalFromSdkResult(payload: unknown): ClaudeRunTerminal | null {
  if (!isRecord(payload)) {
    return null;
  }
  const isTerminalResult =
    payload.type === "result" || (payloadHasSdkResultShape(payload) && typeof payload.subtype === "string");
  if (!isTerminalResult) {
    return null;
  }

  const incompleteReason = extractSdkRunIncompleteReason(payload);
  if (incompleteReason) {
    return { status: "incomplete", reason: incompleteReason };
  }

  const failure = extractSdkRunFailure(payload);
  if (failure) {
    return { status: "failed", error: failure };
  }

  return { status: "completed" };
}

function payloadHasSdkResultShape(payload: Record<string, unknown>): boolean {
  return (
    "subtype" in payload && ("usage" in payload || "totalCostUsd" in payload || "total_cost_usd" in payload)
  );
}

const benignTerminalReasons = new Set(["completed", "tool_deferred", "background_requested"]);

function readTerminalFailureReason(payload: Record<string, unknown>): string | undefined {
  const reason = typeof payload.terminal_reason === "string" ? payload.terminal_reason.trim() : "";
  if (!reason || benignTerminalReasons.has(reason)) {
    return undefined;
  }
  return reason;
}

export function readSdkSlashCommands(message: unknown): string[] {
  if (
    !isRecord(message) ||
    message.type !== "system" ||
    (message.subtype !== "init" && message.subtype !== "commands_changed")
  ) {
    return [];
  }
  const commands = message.subtype === "commands_changed" ? message.commands : message.slash_commands;
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.flatMap((entry) =>
    typeof entry === "string"
      ? [entry]
      : isRecord(entry) && typeof entry.name === "string"
        ? [entry.name]
        : [],
  );
}

export function sdkSupportsSlashCommand(commands: readonly string[], name: string): boolean {
  const normalized = name.replace(/^\//, "").toLowerCase();
  return commands.some((entry) => entry.replace(/^\//, "").toLowerCase() === normalized);
}

export function extractCompactPostTokens(payload: unknown): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const meta =
    (isRecord(payload.compact_metadata) && payload.compact_metadata) ||
    (payload.subtype === "compact_boundary" && isRecord(payload.compact_metadata)
      ? payload.compact_metadata
      : undefined);
  if (!meta) {
    return undefined;
  }
  const post =
    typeof meta.post_tokens === "number"
      ? meta.post_tokens
      : typeof meta.postTokens === "number"
        ? meta.postTokens
        : undefined;
  return post !== undefined && Number.isFinite(post) ? post : undefined;
}

export function createPlanReadyEvent(threadId: string, payload: PlanReadyPayload): AgentEvent {
  return createAgentEvent({
    id: `${threadId}:plan-ready-${crypto.randomUUID()}`,
    threadId,
    agentId: "eco-orchestrator",
    role: "main",
    type: "plan.ready",
    payload,
  });
}

export function appendToPhaseTranscript(transcript: string, event: AgentEvent): string {
  if (event.type === "usage.recorded") {
    return transcript;
  }

  const line = formatAgentEventLine(event);
  if (!line) {
    return transcript;
  }

  if (isStreamableAgentEventType(event.type) && isStreamPayload(event.payload)) {
    return mergeStreamText(transcript, line);
  }

  return transcript ? `${transcript}\n${line}` : line;
}

export type SdkTodoUpdatedKind = "task_started" | "task_updated" | "task_progress" | "task_notification";

/** Payload for `todo.updated` events — mirrors Claude Agent SDK task system messages. */
export interface SdkTodoUpdatedPayload {
  sdkKind: SdkTodoUpdatedKind;
  task_id: string;
  run_id?: string;
  parent_task_id?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  task_type?: string;
  skip_transcript?: boolean;
  prompt?: string;
  last_tool_name?: string;
  summary?: string;
  reason?: string;
  status?: "completed" | "failed" | "stopped";
  output_file?: string;
  ambient?: boolean;
  is_backgrounded?: boolean;
  spawn_depth?: number;
  resource_links?: Array<{
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
  }>;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  patch?: {
    status?: string;
    description?: string;
    error?: string;
  };
}

export function readClaudeBackgroundTasksChanged(
  message: unknown,
): ClaudeBackgroundTaskSnapshot[] | undefined {
  if (
    !isRecord(message) ||
    message.type !== "system" ||
    message.subtype !== "background_tasks_changed" ||
    !Array.isArray(message.tasks)
  ) {
    return undefined;
  }
  return message.tasks.flatMap((task): ClaudeBackgroundTaskSnapshot[] => {
    if (!isRecord(task)) {
      return [];
    }
    const taskId = typeof task.task_id === "string" ? task.task_id.trim() : "";
    const taskType = typeof task.task_type === "string" ? task.task_type.trim() : "";
    if (!taskId || !taskType) {
      return [];
    }
    return [
      {
        taskId,
        taskType,
        description: typeof task.description === "string" ? task.description.trim() : "",
      },
    ];
  });
}

export function buildSdkTodoUpdatedPayload(message: Record<string, unknown>): SdkTodoUpdatedPayload | null {
  const subtype = message.subtype;
  if (
    subtype !== "task_started" &&
    subtype !== "task_updated" &&
    subtype !== "task_progress" &&
    subtype !== "task_notification"
  ) {
    return null;
  }

  const taskId = typeof message.task_id === "string" ? message.task_id : "";
  if (!taskId) {
    return null;
  }

  const payload: SdkTodoUpdatedPayload = {
    sdkKind: subtype,
    task_id: taskId,
  };
  if (typeof message.run_id === "string" && message.run_id.trim()) payload.run_id = message.run_id.trim();
  if (typeof message.parent_task_id === "string" && message.parent_task_id.trim())
    payload.parent_task_id = message.parent_task_id.trim();

  if (typeof message.tool_use_id === "string" && message.tool_use_id.trim()) {
    payload.tool_use_id = message.tool_use_id.trim();
  }
  if (typeof message.description === "string" && message.description.trim()) {
    payload.description = message.description.trim();
  }
  if (typeof message.subagent_type === "string" && message.subagent_type.trim()) {
    payload.subagent_type = message.subagent_type.trim();
  }
  if (typeof message.task_type === "string" && message.task_type.trim()) {
    payload.task_type = message.task_type.trim();
  }
  if (message.skip_transcript === true) {
    payload.skip_transcript = true;
  }
  if (typeof message.prompt === "string" && message.prompt.trim()) {
    payload.prompt = message.prompt.trim();
  }
  if (typeof message.last_tool_name === "string" && message.last_tool_name.trim()) {
    payload.last_tool_name = message.last_tool_name.trim();
  }
  if (typeof message.summary === "string" && message.summary.trim()) {
    payload.summary = message.summary.trim();
  }
  if (
    subtype === "task_notification" &&
    (message.status === "completed" || message.status === "failed" || message.status === "stopped")
  ) {
    payload.status = message.status;
  }
  if (typeof message.reason === "string" && message.reason.trim()) payload.reason = message.reason;
  if (typeof message.output_file === "string" && message.output_file.trim()) {
    payload.output_file = message.output_file.trim();
  }
  if (message.ambient === true) {
    payload.ambient = true;
  }
  if (message.is_backgrounded === true || message.isBackgrounded === true) {
    payload.is_backgrounded = true;
  }
  const spawnDepth =
    typeof message.spawn_depth === "number"
      ? message.spawn_depth
      : typeof message.spawnDepth === "number"
        ? message.spawnDepth
        : undefined;
  if (typeof spawnDepth === "number" && Number.isFinite(spawnDepth)) {
    payload.spawn_depth = spawnDepth;
  }
  const resourceLinks = parseSdkResourceLinks(message.resource_links ?? message.resourceLinks);
  if (resourceLinks) {
    payload.resource_links = resourceLinks;
  }
  if (isRecord(message.usage)) {
    const totalTokens = message.usage.total_tokens;
    const toolUses = message.usage.tool_uses;
    const durationMs = message.usage.duration_ms;
    if (
      typeof totalTokens === "number" &&
      Number.isFinite(totalTokens) &&
      typeof toolUses === "number" &&
      Number.isFinite(toolUses) &&
      typeof durationMs === "number" &&
      Number.isFinite(durationMs)
    ) {
      payload.usage = {
        total_tokens: totalTokens,
        tool_uses: toolUses,
        duration_ms: durationMs,
      };
    }
  }
  if (subtype === "task_updated" && isRecord(message.patch)) {
    const patch: SdkTodoUpdatedPayload["patch"] = {};
    if (typeof message.patch.status === "string") {
      patch.status = message.patch.status;
    }
    if (typeof message.patch.description === "string" && message.patch.description.trim()) {
      patch.description = message.patch.description.trim();
    }
    if (typeof message.patch.error === "string" && message.patch.error.trim()) {
      patch.error = message.patch.error.trim();
    }
    if (Object.keys(patch).length > 0) {
      payload.patch = patch;
    }
  }

  return payload;
}

function parseSdkResourceLinks(value: unknown): SdkTodoUpdatedPayload["resource_links"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const links: NonNullable<SdkTodoUpdatedPayload["resource_links"]> = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const uri = typeof item.uri === "string" ? item.uri.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!uri || !name) {
      continue;
    }
    const link: NonNullable<SdkTodoUpdatedPayload["resource_links"]>[number] = { uri, name };
    if (typeof item.title === "string" && item.title.trim()) {
      link.title = item.title.trim();
    }
    if (typeof item.description === "string" && item.description.trim()) {
      link.description = item.description.trim();
    }
    const mimeType =
      typeof item.mimeType === "string"
        ? item.mimeType
        : typeof item.mime_type === "string"
          ? item.mime_type
          : undefined;
    if (mimeType?.trim()) {
      link.mimeType = mimeType.trim();
    }
    if (typeof item.size === "number" && Number.isFinite(item.size)) {
      link.size = item.size;
    }
    links.push(link);
  }
  return links.length > 0 ? links : undefined;
}

function readUserMessageUuidFields(message: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof message.user_message_uuid === "string" && message.user_message_uuid.trim()) {
    fields.user_message_uuid = message.user_message_uuid.trim();
  }
  if (Array.isArray(message.user_message_uuids)) {
    const uuids = message.user_message_uuids
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
    if (uuids.length > 0) {
      fields.user_message_uuids = uuids;
    }
  }
  return fields;
}

function mapTaskSystemMessageToEvents(
  message: Record<string, unknown>,
  threadId: string,
  sessionId: string,
  role: RuntimeAgentRole,
  uuid: string,
  streamCtx?: SdkStreamContext,
): AgentEvent[] {
  const payload = buildSdkTodoUpdatedPayload(message);
  if (!payload) {
    return [];
  }
  const messageParentToolUseId =
    (typeof message.tool_use_id === "string" && message.tool_use_id.trim()) ||
    (typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id.trim()) ||
    undefined;
  const streamRole =
    (messageParentToolUseId && streamCtx?.subagentRoleByParentToolUseId.get(messageParentToolUseId)) || role;

  return [
    createAttributedAgentEvent(
      {
        id: `${uuid}:todo`,
        threadId,
        sessionId,
        role: streamRole,
        type: "todo.updated",
        payload: {
          ...payload,
          ...(typeof message.subagent_type === "string" && { subagent_type: message.subagent_type }),
          ...(typeof message.agent_type === "string" && { agent_type: message.agent_type }),
        },
        ...(messageParentToolUseId !== undefined ? { messageParentToolUseId } : {}),
      },
      streamCtx,
    ),
  ];
}

export function isCompactBoundarySdkMessage(message: unknown): boolean {
  if (!isRecord(message)) {
    return false;
  }
  return (
    (message.type === "system" && message.subtype === "compact_boundary") ||
    message.type === "compact_boundary"
  );
}

function mapCompactBoundaryToEvents(
  message: Record<string, unknown>,
  threadId: string,
  sessionId: string,
  role: RuntimeAgentRole,
  uuid: string,
): AgentEvent[] {
  const compactMetadata = isRecord(message.compact_metadata) ? message.compact_metadata : undefined;
  return [
    createAgentEvent({
      id: `${uuid}:compact`,
      threadId,
      agentId: sessionId,
      role,
      type: "agent.started",
      payload: {
        type: "system",
        subtype: "compact_boundary",
        ...(typeof message.session_id === "string" && { session_id: message.session_id }),
        ...(typeof message.compacted_summary === "string" && {
          compacted_summary: message.compacted_summary,
        }),
        ...(compactMetadata && { compact_metadata: compactMetadata }),
      },
    }),
  ];
}

function resolveSdkMessageStreamRole(
  message: Record<string, unknown>,
  streamCtx: SdkStreamContext | undefined,
  fallback: RuntimeAgentRole,
): RuntimeAgentRole {
  const nativeAgentId = readSdkMessageAgentId(message);
  if (nativeAgentId && streamCtx) {
    for (const [parentId, agentId] of streamCtx.registeredSubagentByParentToolUseId) {
      const registeredRole = streamCtx.subagentRoleByParentToolUseId.get(parentId);
      if (agentId === nativeAgentId && registeredRole) return registeredRole;
    }
  }
  const parentToolUseId =
    typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id.trim() : "";
  const linkedRole = parentToolUseId && streamCtx?.subagentRoleByParentToolUseId.get(parentToolUseId);
  if (linkedRole) {
    return linkedRole;
  }
  const fromMessage = inferRole(message);
  return fromMessage !== "main" ? fromMessage : fallback;
}

function readSdkMessageAgentId(message: Record<string, unknown>): string | undefined {
  return typeof message.agent_id === "string" && message.agent_id.trim()
    ? message.agent_id.trim()
    : undefined;
}

export function isSdkBackgroundOnlyResult(message: Record<string, unknown>): boolean {
  return (
    message.type === "result" &&
    message.num_turns === 0 &&
    !message.local_command &&
    !message.is_error &&
    message.stop_reason !== "interrupted" &&
    !(typeof message.result === "string" && message.result.trim())
  );
}

export function mapSdkMessageToEvents(
  message: unknown,
  threadId: string,
  streamCtx?: SdkStreamContext,
): AgentEvent[] {
  if (!isRecord(message)) {
    return [];
  }

  const uuid = typeof message.uuid === "string" ? message.uuid : crypto.randomUUID();
  const sessionId = typeof message.session_id === "string" ? message.session_id : "unknown-session";
  const role = inferRole(message);

  if (isCompactBoundarySdkMessage(message)) {
    return mapCompactBoundaryToEvents(message, threadId, sessionId, role, uuid);
  }

  if (message.type === "system" && message.subtype === "init") {
    return [
      createAgentEvent({
        id: `${uuid}:init`,
        threadId,
        agentId: sessionId,
        role,
        type: "agent.started",
        payload: message,
      }),
    ];
  }

  if (message.type === "stream_event") {
    const ctx = streamCtx ?? createSdkStreamContext();
    const streamEvents = mapStreamEventToEvents(message, threadId, sessionId, role, uuid, ctx);
    if (streamEvents.length > 0) {
      return streamEvents;
    }
    return [
      createAgentEvent({
        id: `${uuid}:stream`,
        threadId,
        agentId: sessionId,
        role,
        type: "message.delta",
        payload: slimStreamEventMessage(message),
      }),
    ];
  }

  if (message.type === "assistant") {
    return mapAssistantMessageToEvents(message, threadId, sessionId, role, uuid, streamCtx);
  }

  if (message.type === "user") {
    return [
      ...mapUserToolResultEvents(message, threadId, sessionId, role, uuid, streamCtx),
      ...mapUserAgentOutputToEvents(message, threadId, role, uuid),
    ];
  }

  if (message.type === "tool_progress") {
    const streamRole = resolveSdkMessageStreamRole(message, streamCtx, role);
    const toolUseId = typeof message.tool_use_id === "string" ? message.tool_use_id : uuid;
    const toolUseDescriptor = streamCtx?.toolUseById.get(toolUseId);
    const messageParentToolUseId =
      typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : undefined;
    return [
      createAttributedAgentEvent(
        {
          id: `${uuid}:tool-progress:${toolUseId}`,
          threadId,
          sessionId,
          role: streamRole,
          type: "tool.started",
          payload: {
            ...message,
            ...(toolUseDescriptor?.input && !isRecord(message.input) && { input: toolUseDescriptor.input }),
            ...(typeof message.subagent_type === "string" && { subagent_type: message.subagent_type }),
            ...(typeof message.agent_type === "string" && { agent_type: message.agent_type }),
          },
          ...(messageParentToolUseId !== undefined ? { messageParentToolUseId } : {}),
        },
        streamCtx,
      ),
    ];
  }

  if (message.type === "result") {
    const uuidFields = readUserMessageUuidFields(message);
    const queuedTurnCount =
      typeof message.queued_turn_count === "number" && Number.isFinite(message.queued_turn_count)
        ? message.queued_turn_count
        : typeof message.queuedTurnCount === "number" && Number.isFinite(message.queuedTurnCount)
          ? message.queuedTurnCount
          : undefined;
    const resultPayload: Record<string, unknown> = {
      type: "result",
      session_id: sessionId,
      ...(isRecord(message.sdk_session_usage) && { sdk_session_usage: message.sdk_session_usage }),
      ...Object.fromEntries(
        ["result_index", "num_turns", "local_command", "resume_reason", "startup_failure_reason"]
          .filter((key) => message[key] !== undefined)
          .map((key) => [key, message[key]]),
      ),
      totalCostUsd: message.total_cost_usd,
      usage: message.usage,
      modelUsage: message.modelUsage,
      subtype: message.subtype,
      ...(typeof message.is_error === "boolean" && { is_error: message.is_error }),
      ...(typeof message.stop_reason === "string" || message.stop_reason === null
        ? { stop_reason: message.stop_reason }
        : {}),
      ...(typeof message.terminal_reason === "string" && { terminal_reason: message.terminal_reason }),
      ...(typeof message.api_error_status === "number" && { api_error_status: message.api_error_status }),
      ...(Array.isArray(message.errors) && { errors: message.errors }),
      ...(typeof message.result === "string" && { result: message.result }),
      ...uuidFields,
      ...(queuedTurnCount !== undefined && { queued_turn_count: queuedTurnCount }),
    };
    // Result messages summarize the main session; never attribute them to a stale subagent context.
    const attributed = applySubagentUsageAttribution(
      { role, sessionId, payload: resultPayload, messageParentToolUseId: null },
      streamCtx,
    );
    const terminal = resolveClaudeRunTerminalFromSdkResult(attributed.payload) ?? {
      status: "completed" as const,
    };
    return [
      createAgentEvent({
        id: `${uuid}:usage`,
        threadId,
        agentId: attributed.agentId,
        role,
        type: "usage.recorded",
        payload: attributed.payload,
      }),
      ...(!isSdkBackgroundOnlyResult(message)
        ? [
            createAgentEvent({
              id: `${uuid}:run-terminal`,
              threadId,
              agentId: attributed.agentId,
              role,
              type: "run.terminal",
              payload: terminal,
            }),
          ]
        : []),
    ];
  }

  if (message.type === "system") {
    if (message.subtype === "thinking_tokens") {
      return [];
    }
    if (
      message.subtype === "task_started" ||
      message.subtype === "task_updated" ||
      message.subtype === "task_progress" ||
      message.subtype === "task_notification"
    ) {
      return mapTaskSystemMessageToEvents(message, threadId, sessionId, role, uuid, streamCtx);
    }
    if (
      message.subtype === "status" ||
      message.subtype === "api_retry" ||
      message.subtype === "permission_denied" ||
      message.subtype === "informational" ||
      message.subtype === "commands_changed" ||
      message.subtype === "session_state_changed"
    ) {
      return [
        createAgentEvent({
          id: `${uuid}:system`,
          threadId,
          agentId: sessionId,
          role,
          type: "agent.started",
          payload: message,
        }),
      ];
    }
  }

  if (
    (message.type === "auth_status" && Array.isArray(message.output)) ||
    message.type === "rate_limit_event" ||
    message.type === "conversation_reset"
  ) {
    return [
      createAgentEvent({
        id: `${uuid}:auth`,
        threadId,
        agentId: sessionId,
        role,
        type: "agent.started",
        payload: message,
      }),
    ];
  }

  if (message.type === "tool_use_summary") {
    const streamRole = resolveSdkMessageStreamRole(message, streamCtx, role);
    const messageParentToolUseId =
      typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : undefined;
    const summaryToolUseId = typeof message.tool_use_id === "string" ? message.tool_use_id.trim() : "";
    const summaryDescriptor = summaryToolUseId ? streamCtx?.toolUseById.get(summaryToolUseId) : undefined;
    const summaryInput =
      isRecord(message.input) && Object.keys(message.input).length > 0 ? message.input : undefined;
    return [
      createAttributedAgentEvent(
        {
          id: `${uuid}:tool-summary`,
          threadId,
          sessionId,
          role: streamRole,
          type: "tool.completed",
          payload: {
            ...message,
            ...(typeof message.subagent_type === "string" && { subagent_type: message.subagent_type }),
            ...(typeof message.agent_type === "string" && { agent_type: message.agent_type }),
            ...(summaryDescriptor?.input && !summaryInput && { input: summaryDescriptor.input }),
          },
          ...(messageParentToolUseId !== undefined ? { messageParentToolUseId } : {}),
        },
        streamCtx,
      ),
    ];
  }

  return [];
}

function mapUserToolResultEvents(
  message: Record<string, unknown>,
  threadId: string,
  sessionId: string,
  fallbackRole: RuntimeAgentRole,
  uuid: string,
  streamCtx?: SdkStreamContext,
): AgentEvent[] {
  if (!isRecord(message.message) || !Array.isArray(message.message.content)) {
    return [];
  }
  const messageParentToolUseId =
    typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null;
  const role = resolveSdkMessageStreamRole(message, streamCtx, fallbackRole);
  const nativeAgentId = readSdkMessageAgentId(message);
  const agentOutput = isRecord(message.tool_use_result)
    ? message.tool_use_result
    : isRecord(message.toolUseResult)
      ? message.toolUseResult
      : undefined;
  const hasCompletedAgentOutput =
    agentOutput?.status === "completed" &&
    typeof agentOutput.agentId === "string" &&
    Boolean(agentOutput.agentId.trim());
  const hasFailedAgentOutput = isFailedAgentOutput(agentOutput);
  const detached = agentOutput?.detachedToolCall === true;
  const structuredContentOmitted = agentOutput?.structuredContentOmitted === true;
  const resourceLinks = parseSdkResourceLinks(
    (agentOutput && (agentOutput.resourceLinks ?? agentOutput.resource_links)) ??
      message.resourceLinks ??
      message.resource_links,
  );
  const events: AgentEvent[] = [];
  for (const [index, block] of message.message.content.entries()) {
    if (!isRecord(block) || block.type !== "tool_result") {
      continue;
    }
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
    const descriptor = toolUseId ? streamCtx?.toolUseById.get(toolUseId) : undefined;
    const output = extractToolResultText(block.content);
    const failed =
      block.is_error === true ||
      hasFailedAgentOutput ||
      /terminated early due to an API error|API Error:\s*\d{3}/i.test(output);
    if (!failed && hasCompletedAgentOutput) {
      continue;
    }
    const nonExecutionKind = readSdkToolNonExecutionKind(message, block);
    events.push(
      createAttributedAgentEvent(
        {
          id: `${uuid}:tool-${failed ? "failed" : "completed"}:${index}`,
          threadId,
          sessionId,
          role,
          type: failed ? "tool.failed" : detached ? "tool.started" : "tool.completed",
          payload: failed
            ? {
                type: "tool_result_error",
                tool_name: descriptor?.name ?? "Tool",
                ...(toolUseId && { tool_use_id: toolUseId }),
                ...(descriptor?.input && { input: descriptor.input }),
                message: output || "Tool execution failed.",
                ...(nonExecutionKind ? { non_execution_kind: nonExecutionKind } : {}),
                ...(resourceLinks && { resource_links: resourceLinks }),
              }
            : {
                type: detached ? "tool_progress" : "tool_result",
                ...(detached && { detachedToolCall: true }),
                ...(structuredContentOmitted && {
                  structuredContentOmitted: true,
                  message:
                    "MCP structuredContent was omitted by Claude Code because it exceeds 1,048,576 JSON characters.",
                }),
                ...(agentOutput?.structuredContent !== undefined && {
                  structuredContent: agentOutput.structuredContent,
                }),
                tool_name: descriptor?.name ?? "Tool",
                ...(toolUseId && { tool_use_id: toolUseId }),
                ...(descriptor?.input && { input: descriptor.input }),
                ...(output && { output }),
                ...(resourceLinks && { resource_links: resourceLinks }),
              },
          messageParentToolUseId,
          ...(nativeAgentId && { nativeAgentId }),
        },
        streamCtx,
      ),
    );
  }
  return events;
}

/**
 * Classify non-executing tool outcomes from SDK 0.3.216+ `tool_result_meta` or
 * Claude JSONL `toolDenialKind`. Eco's pinned types may omit the sidecar — read
 * defensively. Delete/simplify once SDK types expose this on SDKUserMessage and
 * Eco no longer needs JSONL fallback.
 */
export type SdkToolNonExecutionKind = "denied" | "interrupted" | "cancelled";

export function readSdkToolNonExecutionKind(
  message: Record<string, unknown>,
  block?: Record<string, unknown>,
): SdkToolNonExecutionKind | undefined {
  const fromMeta =
    readNonExecutionKindFromMeta(message.tool_result_meta) ??
    (block ? readNonExecutionKindFromMeta(block.tool_result_meta) : undefined);
  if (fromMeta) {
    return fromMeta;
  }
  return (
    normalizeSdkToolNonExecutionKind(message.toolDenialKind) ??
    (block ? normalizeSdkToolNonExecutionKind(block.toolDenialKind) : undefined)
  );
}

function readNonExecutionKindFromMeta(value: unknown): SdkToolNonExecutionKind | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return normalizeSdkToolNonExecutionKind(value.non_execution_kind);
}

function normalizeSdkToolNonExecutionKind(value: unknown): SdkToolNonExecutionKind | undefined {
  if (value === "denied" || value === "interrupted" || value === "cancelled") {
    return value;
  }
  return undefined;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((entry): string[] => {
      if (typeof entry === "string") {
        return entry.trim() ? [entry.trim()] : [];
      }
      if (isRecord(entry) && typeof entry.text === "string" && entry.text.trim()) {
        return [entry.text.trim()];
      }
      return [];
    })
    .join("\n");
}

function isFailedAgentOutput(output: Record<string, unknown> | undefined): boolean {
  if (!output) {
    return false;
  }
  if (output.status === "failed" || output.status === "error" || output.is_error === true) {
    return true;
  }
  const contentText = extractAgentOutputText(output);
  return /terminated early due to an API error|API Error:\s*\d{3}/i.test(contentText);
}

function extractAgentOutputText(output: Record<string, unknown>): string {
  if (typeof output.result === "string" && output.result.trim()) {
    return output.result.trim();
  }
  if (typeof output.error === "string" && output.error.trim()) {
    return output.error.trim();
  }
  if (!Array.isArray(output.content)) {
    return "";
  }
  return output.content
    .flatMap((entry): string[] => {
      if (typeof entry === "string") {
        return entry.trim() ? [entry.trim()] : [];
      }
      if (isRecord(entry) && typeof entry.text === "string" && entry.text.trim()) {
        return [entry.text.trim()];
      }
      return [];
    })
    .join("\n");
}

function mapUserAgentOutputToEvents(
  message: Record<string, unknown>,
  threadId: string,
  fallbackRole: RuntimeAgentRole,
  uuid: string,
): AgentEvent[] {
  const output = isRecord(message.tool_use_result)
    ? message.tool_use_result
    : isRecord(message.toolUseResult)
      ? message.toolUseResult
      : undefined;
  if (!output) {
    return [];
  }
  const failed = isFailedAgentOutput(output);
  if (output.status !== "completed" && !failed) {
    return [];
  }
  const agentId = typeof output.agentId === "string" ? output.agentId.trim() : "";
  if (!agentId) {
    return [];
  }
  const agentType = typeof output.agentType === "string" ? output.agentType.trim() : "";
  const outputRole = agentType ? normalizeSdkRuntimeAgentRole(agentType) : undefined;
  const toolUseId = readUserToolResultUseId(message);
  const failureText = failed ? extractAgentOutputText(output) : "";
  return [
    createAgentEvent({
      id: `${uuid}:agent-output:${agentId}`,
      threadId,
      agentId,
      role: outputRole ?? fallbackRole,
      type: "agent.completed",
      payload: {
        type: "agent_output",
        status: failed ? "failed" : "completed",
        agentId,
        ...(failed && { failed: true }),
        ...(failureText && { error: failureText }),
        ...(agentType && { agentType }),
        ...(toolUseId && { tool_use_id: toolUseId }),
        ...(typeof output.resolvedModel === "string" && { resolvedModel: output.resolvedModel }),
        ...(typeof output.totalToolUseCount === "number" && {
          totalToolUseCount: output.totalToolUseCount,
        }),
        ...(typeof output.totalDurationMs === "number" && { totalDurationMs: output.totalDurationMs }),
        ...(typeof output.totalTokens === "number" && { totalTokens: output.totalTokens }),
        ...(isRecord(output.usage) && { usage: output.usage }),
        ...(Array.isArray(output.content) && { content: output.content }),
        ...(typeof output.prompt === "string" && { prompt: output.prompt }),
      },
    }),
  ];
}

function readUserToolResultUseId(message: Record<string, unknown>): string | undefined {
  if (!isRecord(message.message) || !Array.isArray(message.message.content)) {
    return undefined;
  }
  for (const block of message.message.content) {
    if (!isRecord(block) || block.type !== "tool_result") {
      continue;
    }
    if (typeof block.tool_use_id === "string" && block.tool_use_id.trim()) {
      return block.tool_use_id.trim();
    }
  }
  return undefined;
}

function mapAssistantMessageToEvents(
  message: Record<string, unknown>,
  threadId: string,
  sessionId: string,
  role: RuntimeAgentRole,
  uuid: string,
  streamCtx?: SdkStreamContext,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const nestedMessage = isRecord(message.message) ? message.message : undefined;
  const messageId = nestedMessage && typeof nestedMessage.id === "string" ? nestedMessage.id : undefined;
  const messageParentToolUseId =
    typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null;
  const nativeAgentId = readSdkMessageAgentId(message);
  const contentRole = resolveSdkMessageStreamRole(message, streamCtx, role);
  const sdkRequestId =
    typeof message.request_id === "string" && message.request_id.trim()
      ? message.request_id.trim()
      : undefined;
  const uuidFields = readUserMessageUuidFields(message);

  if (nestedMessage && isRecord(nestedMessage.usage)) {
    const assistantPayload: Record<string, unknown> = {
      usage: nestedMessage.usage,
      ...(messageId && { messageId }),
      ...(typeof nestedMessage.model === "string" && { model: nestedMessage.model }),
      ...(typeof message.subagent_type === "string" && { subagent_type: message.subagent_type }),
      ...(typeof message.agent_type === "string" && { agent_type: message.agent_type }),
      // ECO logical request identity from Gateway `request-id` → SDKAssistantMessage.request_id.
      ...(sdkRequestId && { request_id: sdkRequestId }),
      ...uuidFields,
    };
    const attributed = applySubagentUsageAttribution(
      {
        role: contentRole,
        sessionId,
        payload: assistantPayload,
        messageParentToolUseId,
        ...(nativeAgentId && { nativeAgentId }),
      },
      streamCtx,
    );
    events.push(
      createAgentEvent({
        id: `${uuid}:assistant-usage`,
        threadId,
        agentId: attributed.agentId,
        role: contentRole,
        type: "usage.recorded",
        payload: attributed.payload,
      }),
    );
  }

  if (!nestedMessage || !Array.isArray(nestedMessage.content)) {
    return events;
  }
  const content = expandAssistantMessageContent(
    nestedMessage.content.filter((block): block is Record<string, unknown> => isRecord(block)),
  );
  for (const [index, block] of content.entries()) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      const streamBlockKey = assistantStreamBlockKey(messageId ?? uuid, "text", index);
      if (
        hasEmittedStreamBlockForMessageKind(
          streamCtx,
          messageId,
          "text",
          messageParentToolUseId === null && !nativeAgentId,
        )
      ) {
        continue;
      }
      events.push(
        createAttributedAgentEvent(
          {
            id: `${uuid}:text:${index}`,
            threadId,
            sessionId,
            role: contentRole,
            type: "message.delta",
            payload: {
              type: "eco_stream",
              blockKind: "text",
              text: block.text,
              streamFinalize: true,
              stream_block_key: streamBlockKey,
              ...(messageId && { messageId }),
              ...(sdkRequestId && { request_id: sdkRequestId }),
              ...uuidFields,
              ...(typeof message.parent_tool_use_id === "string" && {
                parent_tool_use_id: message.parent_tool_use_id,
              }),
              ...(typeof message.subagent_type === "string" && { subagent_type: message.subagent_type }),
              ...(typeof message.agent_type === "string" && { agent_type: message.agent_type }),
            },
            messageParentToolUseId,
            ...(nativeAgentId && { nativeAgentId }),
          },
          streamCtx,
        ),
      );
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      const streamBlockKey = assistantStreamBlockKey(messageId ?? uuid, "thinking", index);
      if (
        hasEmittedStreamBlockForMessageKind(
          streamCtx,
          messageId,
          "thinking",
          messageParentToolUseId === null && !nativeAgentId,
        )
      ) {
        continue;
      }
      events.push(
        createAttributedAgentEvent(
          {
            id: `${uuid}:thinking:${index}`,
            threadId,
            sessionId,
            role: contentRole,
            type: "message.delta",
            payload: {
              type: "eco_stream",
              blockKind: "thinking",
              text: block.thinking,
              streamFinalize: true,
              stream_block_key: streamBlockKey,
              ...(messageId && { messageId }),
              ...(sdkRequestId && { request_id: sdkRequestId }),
              ...uuidFields,
              ...(typeof message.parent_tool_use_id === "string" && {
                parent_tool_use_id: message.parent_tool_use_id,
              }),
              ...(typeof message.subagent_type === "string" && { subagent_type: message.subagent_type }),
              ...(typeof message.agent_type === "string" && { agent_type: message.agent_type }),
            },
            messageParentToolUseId,
            ...(nativeAgentId && { nativeAgentId }),
          },
          streamCtx,
        ),
      );
      continue;
    }
    if (block.type !== "tool_use" || typeof block.name !== "string") {
      continue;
    }

    const toolUseId = typeof block.id === "string" ? block.id : undefined;
    if (toolUseId) {
      streamCtx?.toolUseById.set(toolUseId, {
        name: block.name,
        ...(isRecord(block.input) && { input: block.input }),
      });
    }
    if (toolUseId && streamCtx?.emittedToolUseIds.has(toolUseId)) {
      continue;
    }

    events.push(
      createAttributedAgentEvent(
        {
          id: `${uuid}:tool:${index}`,
          threadId,
          sessionId,
          role: contentRole,
          type: "tool.started",
          payload: {
            type: "tool_use",
            tool_name: block.name,
            input: block.input,
            ...(messageId && { messageId }),
            ...(toolUseId && { tool_use_id: toolUseId }),
            ...(typeof message.subagent_type === "string" && { subagent_type: message.subagent_type }),
            ...(typeof message.agent_type === "string" && { agent_type: message.agent_type }),
            ...(block.name === "Agent" &&
              isRecord(block.input) &&
              typeof block.input.subagent_type === "string" && {
                subagent_type: block.input.subagent_type,
              }),
          },
          messageParentToolUseId,
          ...(nativeAgentId && { nativeAgentId }),
        },
        streamCtx,
      ),
    );
  }

  return events;
}

function assistantStreamBlockKey(messageId: string, kind: "text" | "thinking", index: number): string {
  return `${messageId}:${kind}:${index}`;
}

function hasEmittedStreamBlockForMessageKind(
  streamCtx: SdkStreamContext | undefined,
  messageId: string | undefined,
  kind: "text" | "thinking",
  allowLegacyMainFallback: boolean,
): boolean {
  if (!streamCtx) {
    return false;
  }
  if (messageId) {
    const prefix = `${messageId}:${kind}:`;
    for (const key of streamCtx.emittedStreamBlockKeys) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
  }
  if (!allowLegacyMainFallback) {
    return false;
  }
  for (const key of streamCtx.emittedStreamBlockKeys) {
    if (key.startsWith(`${kind}:`) || key.startsWith(`embedded:${kind}:`)) {
      return true;
    }
  }
  return false;
}

export function createCanUseTool(
  handler: (request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision>,
  config: {
    planModeToolPolicy?: PlanModeToolPolicy;
    approvedExitPlanToolUseId?: string;
    awaitPlanApproval?: EcoHookContext["awaitPlanApproval"];
    onExitPlanMode?: EcoHookContext["onExitPlanMode"];
    exitPlanCaptureState?: EcoHookContext["exitPlanCaptureState"];
    workspacePath?: string;
    getPhaseTranscript?: () => string;
  } = {},
): (
  toolName: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<Record<string, unknown>> {
  return async (toolName, input, options) => {
    const normalizedToolName = toolName.trim();
    const planModeToolPolicy = config.planModeToolPolicy ?? "forbidden";
    const toolUseId = readStringOption(options, ["toolUseID", "toolUseId", "tool_use_id"]);
    if (normalizedToolName === "ExitPlanMode" && planModeToolPolicy === "user-approval") {
      if (!config.awaitPlanApproval) {
        return {
          behavior: "deny",
          message: "ExitPlanMode requires Eco plan approval before execution.",
          interrupt: true,
        };
      }
      const cwd = typeof options.cwd === "string" ? options.cwd : undefined;
      const result = await awaitExitPlanModeUserDecision(input, {
        toolUseId: toolUseId ?? crypto.randomUUID(),
        awaitApproval: config.awaitPlanApproval,
        ...(cwd ? { cwd } : {}),
        ...(config.onExitPlanMode ? { capture: config.onExitPlanMode } : {}),
        ...(config.exitPlanCaptureState ? { state: config.exitPlanCaptureState } : {}),
        ...(config.workspacePath ? { workspacePath: config.workspacePath } : {}),
        ...(config.getPhaseTranscript ? { getPhaseTranscript: config.getPhaseTranscript } : {}),
      });
      if (result.behavior === "allow") {
        return { behavior: "allow", updatedInput: result.updatedInput };
      }
      return {
        behavior: "deny",
        message: result.message,
        interrupt: result.interrupt,
      };
    }
    const exitPlanModeAllowed =
      normalizedToolName === "ExitPlanMode" &&
      planModeToolPolicy === "resume-approved-exit" &&
      Boolean(config.approvedExitPlanToolUseId?.trim()) &&
      toolUseId === config.approvedExitPlanToolUseId?.trim();
    if (isProtectedPlanModeToolName(normalizedToolName) && !exitPlanModeAllowed) {
      return {
        behavior: "deny",
        message:
          planModeToolPolicy === "forbidden"
            ? "Plan Mode tools are unavailable in Agent and Ask sessions."
            : "Eco Plan approval is handled by Plan Mode hooks and the Eco approval UI; generic tool auto-approval must not approve this tool.",
        interrupt: true,
      };
    }
    if (exitPlanModeAllowed) {
      return { behavior: "allow", updatedInput: input };
    }

    const signal = options.signal instanceof AbortSignal ? options.signal : new AbortController().signal;
    // Honest deny when the SDK aborts the permission round-trip (stdin closed /
    // interrupt). Prefer this over CLI J3H "user doesn't want…" prose. Removable
    // once hold-open / SDK stdin lifecycle makes these aborts rare.
    if (signal.aborted) {
      return {
        behavior: "deny",
        message:
          "Tool permission request was aborted before Eco could decide (control channel closed or interrupt) — not a user denial.",
      };
    }

    const request: SdkToolPermissionRequest = {
      toolName,
      input,
      toolUseId: toolUseId ?? crypto.randomUUID(),
      signal,
    };
    const requestId = readStringOption(options, ["requestId", "request_id"]);
    const agentId = readStringOption(options, ["agentID", "agentId", "agent_id"]);
    const agentType = readStringOption(options, ["agentType", "agent_type"]);
    if (requestId) request.requestId = requestId;
    if (agentId) request.agentId = agentId;
    if (agentType) request.agentType = agentType;
    if (typeof options.cwd === "string") request.cwd = options.cwd;
    if (typeof options.blockedPath === "string") request.blockedPath = options.blockedPath;
    if (typeof options.decisionReason === "string") request.decisionReason = options.decisionReason;
    if (typeof options.title === "string") request.title = options.title;
    if (typeof options.displayName === "string") request.displayName = options.displayName;
    if (typeof options.description === "string") request.description = options.description;
    if (typeof options.defaultToNo === "boolean") request.defaultToNo = options.defaultToNo;
    if (typeof options.suppressAlwaysAllowRule === "boolean")
      request.suppressAlwaysAllowRule = options.suppressAlwaysAllowRule;
    if (
      isRecord(options.mcpServer) &&
      typeof options.mcpServer.name === "string" &&
      typeof options.mcpServer.source === "string"
    ) {
      request.mcpServer = { name: options.mcpServer.name, source: options.mcpServer.source };
    }

    const decision = await handler(request);

    if (decision.behavior === "allow") {
      return {
        behavior: "allow",
        updatedInput: decision.updatedInput ?? input,
      };
    }

    return {
      behavior: "deny",
      message: decision.message,
      interrupt: decision.interrupt,
    };
  };
}

function isProtectedPlanModeToolName(toolName: string): boolean {
  return (protectedPlanModeToolNames as readonly string[]).includes(toolName.trim());
}

function readStringOption(options: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function findRoute(routes: readonly ResolvedModelRoute[], role: AgentRole): ResolvedModelRoute | undefined {
  return routes.find((route) => route.role === role);
}

function inferRole(message: Record<string, unknown>): RuntimeAgentRole {
  if (typeof message.subagent_type === "string") {
    const normalized = normalizeSdkRuntimeAgentRole(message.subagent_type);
    if (normalized) {
      return normalized;
    }
    if (isAgentRole(message.subagent_type)) {
      return message.subagent_type;
    }
  }
  if (typeof message.agent_type === "string") {
    const normalized = normalizeSdkRuntimeAgentRole(message.agent_type);
    if (normalized) {
      return normalized;
    }
    if (isAgentRole(message.agent_type)) {
      return message.agent_type;
    }
  }
  return "main";
}

function isAgentRole(value: string): value is AgentRole {
  return ["main", "explore", "architect", "coder", "reviewer", "tester"].includes(value);
}

function resolveActivitySubagentRole(value: string): ActivityDisplayRole | undefined {
  const normalized = normalizeSdkRuntimeAgentRole(value);
  if (normalized) {
    return normalized;
  }
  return isAgentRole(value) ? value : undefined;
}

function normalizeSdkRuntimeAgentRole(value: string): RuntimeAgentRole | undefined {
  const trimmed = value.trim();
  if (trimmed === SDK_GENERAL_PURPOSE_AGENT_KEY || trimmed === SDK_PLAN_AGENT_KEY) {
    return trimmed;
  }
  return normalizeSdkSubagentType(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ActivityDisplayRole = RuntimeAgentRole | "system" | "thinking" | "tool";

export interface AgentEventDisplay {
  message: string;
  role: ActivityDisplayRole;
  stream: boolean;
}

/** SDK / proxy status lines that should appear in the activity log while waiting on the model. */
export function isUpstreamStatusActivityMessage(message: string | null | undefined): boolean {
  if (!message?.trim()) {
    return false;
  }
  return /^(?:Requesting model|Compacting context|API retry )/i.test(message.trim());
}

export function formatAgentEventDisplay(
  event: Pick<AgentEvent, "type" | "payload" | "role">,
): AgentEventDisplay | null {
  if (isRecord(event.payload) && event.payload.type === "eco_stream" && event.payload.streamPlaceholder) {
    return {
      message: "",
      role: inferActivityRole(event),
      stream: true,
    };
  }

  const message = formatAgentEventLine(event);
  if (
    !message &&
    !(isRecord(event.payload) && event.payload.type === "eco_stream" && event.payload.streamFinalize)
  ) {
    return null;
  }

  const finalize =
    isRecord(event.payload) && event.payload.type === "eco_stream" && event.payload.streamFinalize === true;

  return {
    message: message ?? "",
    role: inferActivityRole(event),
    stream: finalize ? false : isStreamableAgentEventType(event.type) && isStreamPayload(event.payload),
  };
}

export function formatAgentEventLine(event: Pick<AgentEvent, "type" | "payload" | "role">): string | null {
  if (event.type === "usage.recorded" || event.type === "todo.updated") {
    if (event.type === "todo.updated" && isSdkTodoUpdatedPayload(event.payload)) {
      const sdkPayload = event.payload;
      if (sdkPayload.ambient === true) {
        return null;
      }
      if (sdkPayload.sdkKind === "task_updated") {
        const status = sdkPayload.patch?.status;
        return status ? `Task ${status}` : null;
      }
      return formatSdkPayloadMessage({
        type: "system",
        subtype: sdkPayload.sdkKind,
        task_id: sdkPayload.task_id,
        description: sdkPayload.description,
        subagent_type: sdkPayload.subagent_type,
        last_tool_name: sdkPayload.last_tool_name,
        summary: sdkPayload.summary,
        reason: sdkPayload.reason,
        status: sdkPayload.status,
        output_file: sdkPayload.output_file,
        usage: sdkPayload.usage,
      });
    }
    if (event.type === "usage.recorded") {
      return null;
    }
  }

  const fromPayload = formatSdkPayloadMessage(event.payload);
  if (fromPayload) {
    return fromPayload;
  }

  if (event.type === "agent.started") {
    return formatSdkPayloadMessage(event.payload) ?? "Agent session started.";
  }

  if (event.type === "plan.ready") {
    return "计划已生成，等待确认。";
  }

  if (
    event.type === "tool.started" &&
    isRecord(event.payload) &&
    typeof event.payload.tool_name === "string"
  ) {
    return `Running tool: ${event.payload.tool_name}`;
  }

  if (event.type === "tool.completed") {
    return formatSdkPayloadMessage(event.payload);
  }

  return null;
}

export function inferActivityRole(event: Pick<AgentEvent, "type" | "payload" | "role">): ActivityDisplayRole {
  if (isThinkingPayload(event.payload)) {
    return "thinking";
  }

  if (isRecord(event.payload)) {
    if (event.payload.type === "tool_permission_denied" || event.payload.type === "tool_result_error") {
      return "tool";
    }
    if (
      event.payload.type === "tool_progress" ||
      event.payload.type === "tool_result" ||
      event.payload.type === "tool_use_summary"
    ) {
      return "tool";
    }
    if (event.payload.type === "tool_use") {
      if (event.payload.tool_name === "Agent" && isRecord(event.payload.input)) {
        const subagent =
          (typeof event.payload.input.subagent_type === "string" && event.payload.input.subagent_type) ||
          (typeof event.payload.input.agent_type === "string" && event.payload.input.agent_type) ||
          undefined;
        const role = subagent ? resolveActivitySubagentRole(subagent) : undefined;
        if (role) {
          return role;
        }
      }
      if (typeof event.payload.subagent_type === "string") {
        const role = resolveActivitySubagentRole(event.payload.subagent_type);
        if (role) {
          return role;
        }
      }
      if (isRuntimeAgentActivityRole(event.role)) {
        return event.role;
      }
      return "tool";
    }
    if (typeof event.payload.subagent_type === "string") {
      const role = resolveActivitySubagentRole(event.payload.subagent_type);
      if (role) {
        return role;
      }
    }
    if (typeof event.payload.agent_type === "string") {
      const role = resolveActivitySubagentRole(event.payload.agent_type);
      if (role) {
        return role;
      }
    }
  }

  if (event.type === "todo.updated" && isRecord(event.payload)) {
    const subagent = event.payload.subagent_type;
    if (typeof subagent === "string") {
      const role = resolveActivitySubagentRole(subagent);
      if (role) {
        return role;
      }
    }
  }

  if (event.type === "tool.started" || event.type === "tool.completed") {
    if (isRuntimeAgentActivityRole(event.role)) {
      return event.role;
    }
    if (isRecord(event.payload) && event.payload.tool_name === "Agent" && isRecord(event.payload.input)) {
      const subagent =
        (typeof event.payload.input.subagent_type === "string" && event.payload.input.subagent_type) ||
        (typeof event.payload.input.agent_type === "string" && event.payload.input.agent_type) ||
        undefined;
      const role = subagent ? resolveActivitySubagentRole(subagent) : undefined;
      if (role) {
        return role;
      }
    }
    if (isRecord(event.payload) && typeof event.payload.subagent_type === "string") {
      const role = resolveActivitySubagentRole(event.payload.subagent_type);
      if (role) {
        return role;
      }
    }
    return "tool";
  }

  return event.role;
}

function isRuntimeAgentActivityRole(role: RuntimeAgentRole): boolean {
  return role !== "main" && role !== "system" && role !== "thinking" && role !== "tool" && role !== "user";
}

export function isThinkingPayload(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }

  if (payload.type === "eco_stream" && payload.blockKind === "thinking") {
    return true;
  }

  if (payload.type === "stream_event" && isRecord(payload.event)) {
    const event = payload.event;
    if (
      event.type === "content_block_delta" &&
      isRecord(event.delta) &&
      event.delta.type === "thinking_delta"
    ) {
      return true;
    }
  }

  if (payload.type === "assistant" && isRecord(payload.message) && Array.isArray(payload.message.content)) {
    return payload.message.content.some(
      (block) => isRecord(block) && block.type === "thinking" && typeof block.thinking === "string",
    );
  }

  return false;
}

export function isStreamPayload(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  if (payload.type === "eco_stream") {
    return !payload.streamFinalize;
  }
  return payload.type === "stream_event";
}

export function formatSdkPayloadMessage(payload: unknown): string | null {
  if (
    isRecord(payload) &&
    payload.type === "system" &&
    payload.subtype === "informational" &&
    typeof payload.content === "string"
  )
    return payload.content;
  if (isRecord(payload) && payload.structuredContentOmitted === true && typeof payload.message === "string")
    return payload.message;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!isRecord(payload)) {
    return null;
  }

  if (payload.type === "tool_permission_denied" && typeof payload.tool_name === "string") {
    const reason = typeof payload.message === "string" ? `: ${payload.message}` : "";
    return `Permission denied for ${payload.tool_name}${reason}`;
  }

  if (payload.type === "tool_result_error" && typeof payload.tool_name === "string") {
    if (payload.non_execution_kind === "cancelled") {
      return `Tool cancelled: ${payload.tool_name} (system cancelled — not a user denial)`;
    }
    const reason = typeof payload.message === "string" ? `: ${payload.message}` : "";
    return `Tool failed: ${payload.tool_name}${reason}`;
  }

  if (payload.type === "tool_result" && payload.is_error === true && typeof payload.tool_name === "string") {
    const reasonText =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.content === "string"
          ? payload.content
          : "";
    const reason = reasonText.trim() ? `: ${reasonText.trim()}` : "";
    return `Tool failed: ${payload.tool_name}${reason}`;
  }

  if (typeof payload.label === "string" && typeof payload.ecoPhase === "string") {
    return payload.label.trim() || null;
  }

  if (payload.type === "assistant" && isRecord(payload.message)) {
    return extractBetaMessageText(payload.message);
  }

  if (payload.type === "eco_stream") {
    if (payload.streamPlaceholder) {
      return null;
    }
    if (typeof payload.text === "string" && payload.text.length > 0) {
      return payload.text;
    }
    return null;
  }

  if (payload.type === "stream_event" && isRecord(payload.event)) {
    return extractStreamEventText(payload.event);
  }

  if (payload.type === "tool_use" && typeof payload.tool_name === "string") {
    const skillName = resolveSkillDisplayName(payload.tool_name, payload.input);
    if (skillName) {
      return formatSkillActivityLabel(skillName);
    }
    if (payload.tool_name === "Agent") {
      const mission = formatAgentToolMissionMessage(payload.input);
      if (mission) {
        return mission;
      }
    }
    const detail = formatToolInputSummary(payload.tool_name, payload.input);
    return detail ? `Tool: ${payload.tool_name} · ${detail}` : `Tool: ${payload.tool_name}`;
  }

  if (payload.type === "tool_progress" && typeof payload.tool_name === "string") {
    const seconds =
      typeof payload.elapsed_time_seconds === "number"
        ? ` (${payload.elapsed_time_seconds.toFixed(1)}s)`
        : "";
    return `Tool: ${payload.tool_name}${seconds}`;
  }

  if (payload.type === "tool_result" && typeof payload.tool_name === "string") {
    const skillName = resolveSkillDisplayName(payload.tool_name, payload.input);
    if (skillName) {
      return formatSkillActivityLabel(skillName);
    }
    const detail = formatToolInputSummary(payload.tool_name, payload.input);
    return detail ? `Tool: ${payload.tool_name} · ${detail}` : `Tool: ${payload.tool_name}`;
  }

  if (payload.type === "tool_use_summary" && typeof payload.summary === "string") {
    return payload.summary.trim() || null;
  }

  if (payload.type === "system") {
    if (payload.subtype === "init") {
      const model = typeof payload.model === "string" ? payload.model : "model";
      return `Claude Agent SDK ready (${model}).`;
    }
    if (payload.subtype === "notification" && typeof payload.text === "string") {
      return payload.text.trim() || null;
    }
    if (payload.subtype === "status") {
      if (payload.status === "requesting") {
        return "Requesting model…";
      }
      if (payload.status === "compacting") {
        return "Compacting context…";
      }
      return null;
    }
    if (payload.subtype === "compact_boundary") {
      return "Compacting context…";
    }
    if (payload.subtype === "task_started" && typeof payload.description === "string") {
      const subagent =
        (typeof payload.subagent_type === "string" && payload.subagent_type.trim()) ||
        (typeof payload.agent_type === "string" && payload.agent_type.trim()) ||
        undefined;
      if (subagent) {
        return formatSubagentMissionMessage(subagent, payload.description);
      }
      return `Task started: ${payload.description}`;
    }
    if (payload.subtype === "task_progress") {
      const description = typeof payload.description === "string" ? payload.description.trim() : "";
      const toolName = typeof payload.last_tool_name === "string" ? payload.last_tool_name.trim() : "";
      if (description && toolName) {
        return `Tool: ${toolName} · ${description}`;
      }
      if (toolName) {
        return `Tool: ${toolName}`;
      }
      return description || null;
    }
    if (payload.subtype === "task_notification") {
      const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
      const status = typeof payload.status === "string" ? payload.status : "completed";
      const reason = typeof payload.reason === "string" ? ` · ${payload.reason}` : "";
      return `${summary || `Task ${status}`}${reason}`;
    }
    if (payload.subtype === "task_updated" && isRecord(payload.patch)) {
      const status = payload.patch.status;
      if (typeof status === "string") {
        return `Task ${status}`;
      }
      return null;
    }
    if (payload.subtype === "api_retry") {
      const attempt = typeof payload.attempt === "number" ? payload.attempt : "?";
      const maxRetries = typeof payload.max_retries === "number" ? payload.max_retries : "?";
      return `API retry ${attempt}/${maxRetries}…`;
    }
    if (payload.subtype === "permission_denied" && typeof payload.tool_name === "string") {
      const reason = typeof payload.message === "string" ? `: ${payload.message}` : "";
      return `Permission denied for ${payload.tool_name}${reason}`;
    }
  }

  if (payload.type === "auth_status" && Array.isArray(payload.output)) {
    const lines = payload.output.filter(
      (line): line is string => typeof line === "string" && line.trim().length > 0,
    );
    return lines.length > 0 ? lines.join("\n") : null;
  }

  if (payload.type === "result") {
    return null;
  }

  if (payload.type === "user") {
    return null;
  }

  if (typeof payload.message === "string") {
    const trimmed = payload.message.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}

function extractBetaMessageText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      parts.push(block.thinking);
      continue;
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      const detail = formatToolInputSummary(block.name, block.input);
      parts.push(detail ? `[tool] ${block.name} · ${detail}` : `[tool] ${block.name}`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function extractStreamEventText(event: Record<string, unknown>): string | null {
  if (event.type === "content_block_delta" && isRecord(event.delta)) {
    if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
      const text = event.delta.text;
      return text.length > 0 ? text : null;
    }
    if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
      const thinking = event.delta.thinking;
      return thinking.length > 0 ? thinking : null;
    }
  }

  return null;
}

const SUBAGENT_ROLE_LABELS: Record<SubagentRole, string> = {
  explore: "探索",
  architect: "架构",
  coder: "编码",
  reviewer: "审查",
  tester: "测试",
};

export function formatSubagentLabel(role: string): string {
  if (isSubagentRole(role)) {
    return SUBAGENT_ROLE_LABELS[role];
  }
  if (isAgentRole(role) && role !== "main") {
    return role;
  }
  return role;
}

function isSdkTodoUpdatedPayload(payload: unknown): payload is SdkTodoUpdatedPayload {
  if (!isRecord(payload)) {
    return false;
  }
  const sdkKind = payload.sdkKind;
  if (
    sdkKind !== "task_started" &&
    sdkKind !== "task_updated" &&
    sdkKind !== "task_progress" &&
    sdkKind !== "task_notification"
  ) {
    return false;
  }
  return typeof payload.task_id === "string" && payload.task_id.length > 0;
}

function formatAgentToolMissionMessage(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }
  const subagent =
    (typeof input.subagent_type === "string" && input.subagent_type.trim()) ||
    (typeof input.agent_type === "string" && input.agent_type.trim()) ||
    undefined;
  if (!subagent) {
    return null;
  }
  const prompt =
    (typeof input.prompt === "string" && input.prompt.trim()) ||
    (typeof input.task === "string" && input.task.trim()) ||
    (typeof input.description === "string" && input.description.trim()) ||
    "";
  return formatSubagentMissionMessage(subagent, prompt);
}

function formatToolInputSummary(toolName: string, input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  const taskSummary = formatTaskToolInputSummary(toolName, input);
  if (taskSummary) {
    return taskSummary;
  }

  if (toolName === "SendMessage") {
    return formatSendMessageToolInputSummary(input) ?? null;
  }

  if (toolName === "AskUserQuestion") {
    if (!Array.isArray(input.questions)) {
      return "澄清问题";
    }
    const count = input.questions.length;
    const first = input.questions[0];
    if (isRecord(first) && typeof first.question === "string") {
      const preview = first.question.trim();
      const short = preview.length > 48 ? `${preview.slice(0, 45)}…` : preview;
      return count > 1 ? `澄清 ${count} 个问题 · ${short}` : short;
    }
    return count > 1 ? `澄清 ${count} 个问题` : "澄清问题";
  }

  const skillName = resolveSkillDisplayName(toolName, input);
  if (skillName) {
    return `${skillName} 技能`;
  }

  if (toolName === "Agent") {
    const subagent =
      (typeof input.subagent_type === "string" && input.subagent_type.trim()) ||
      (typeof input.agent_type === "string" && input.agent_type.trim()) ||
      undefined;
    if (subagent) {
      const label = formatSubagentLabel(subagent);
      const taskPrompt = typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : "";
      if (taskPrompt) {
        const summary = taskPrompt.length > 60 ? `${taskPrompt.slice(0, 57)}…` : taskPrompt;
        return `${label} · ${summary}`;
      }
      return label;
    }
  }

  const readTarget = resolveReadTargetFromToolInput(toolName, input);
  if (readTarget) {
    return formatReadTargetLabel(readTarget);
  }

  const grepTarget = resolveGrepTargetFromToolInput(toolName, input);
  if (grepTarget) {
    return formatGrepTargetLabel(grepTarget);
  }

  const filePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : undefined;
  if (filePath) {
    return pathBasename(filePath);
  }

  if (typeof input.command === "string") {
    const command = input.command.trim();
    return command.length > 80 ? `${command.slice(0, 77)}…` : command;
  }

  if (typeof input.pattern === "string") {
    return input.pattern;
  }

  if (toolName === "WebSearch") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (query) {
      return query.length > 80 ? `${query.slice(0, 77)}…` : query;
    }
  }

  if (toolName === "WebFetch") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (url) {
      return url.length > 80 ? `${url.slice(0, 77)}…` : url;
    }
  }

  return null;
}

function formatTaskToolInputSummary(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "TaskCreate") {
    return readFirstTrimmedString(input, "subject", "activeForm", "active_form", "description") ?? null;
  }
  if (toolName === "TaskUpdate") {
    const subject = readFirstTrimmedString(input, "subject", "activeForm", "active_form");
    if (subject) {
      return subject;
    }
    const taskId = readFirstTrimmedString(input, "taskId", "task_id");
    const status = formatTaskStatus(readFirstTrimmedString(input, "status"));
    return [taskId ? `#${taskId}` : undefined, status].filter(Boolean).join(" · ") || null;
  }
  if (toolName === "TodoWrite" && Array.isArray(input.todos)) {
    return `${input.todos.length} 项`;
  }
  return null;
}

function readFirstTrimmedString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function formatTaskStatus(status: string | undefined): string | undefined {
  if (!status) {
    return undefined;
  }
  return (
    {
      pending: "待处理",
      in_progress: "进行中",
      completed: "已完成",
      deleted: "已删除",
    }[status] ?? status
  );
}

function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

export function isStreamableAgentEventType(type: AgentEventType): boolean {
  return type === "message.delta";
}

export {
  createSdkStreamContext,
  isEcoStreamFinalize,
  isEcoStreamPlaceholder,
  type SdkStreamContext,
} from "./sdk-stream-events.js";
