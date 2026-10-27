import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  NotificationHookInput,
  PermissionRequestHookInput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TaskCompletedHookInput,
  TaskCreatedHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { truncateToolOutputForHistory } from "./codex-output-truncation.js";
import { buildForcedPlanDelegationContract } from "./forced-plan-delegation.js";
import { IMAGE_READ_DISABLED_REASON, isNativeImageFile } from "./native-image-read.js";
import {
  readPlanFileContent,
  readPlanFromPhaseTranscript,
  readPlanFromSdkTranscriptPath,
} from "./plan-path.js";
import { appendReviewerScopeToPrompt } from "./reviewer-scope";
import {
  createSubagentResumePreToolHook,
  normalizeAgentToolInputSubagentType,
  normalizeSdkSubagentType,
  readAgentSubagentType,
  type SubagentResumeResolveInput,
} from "./subagent-resume.js";

export {
  normalizeAgentToolInputSubagentType,
  normalizeSdkSubagentType,
  readAgentSubagentType,
} from "./subagent-resume.js";

import type { RuntimeAgentRole } from "../../shared/src";
import {
  type EcoRuntimeToolPermissionEntry,
  type EcoRuntimeToolPermissionPolicy,
  parseMcpToolServerName,
  resolveToolPermissionEntryForActor,
  sanitizeMcpServerName,
  sdkAgentKeyForOrchestrationAgent,
} from "./agent-orchestration.js";
import {
  isSubagentEnabled,
  isSubagentRole,
  normalizeSubagentAvailability,
  SDK_GENERAL_PURPOSE_AGENT_KEY,
  SDK_PLAN_AGENT_KEY,
  type SubagentAvailability,
} from "./subagent-availability";
import { SubagentLaunchRegistry } from "./subagent-launch-registry.js";
import {
  type ExecutionConfirmationMode,
  evaluateBashHookGate,
  evaluateFilesystemHookGate,
} from "./tool-confirmation.js";
import { materializeEcoToolPolicy } from "./tool-permission-policy.js";

export { type SubagentLaunchRecord, SubagentLaunchRegistry } from "./subagent-launch-registry.js";

export interface EcoTaskTrackerHooks {
  onPreToolUse(toolName: string, input: Record<string, unknown>): void;
  onTaskCreated(input: { taskId: string; subject: string; description?: string }): void;
  onTaskCompleted(input: { taskId: string; subject: string }): void;
  onSubagentStart(input: {
    agentId: string;
    agentType: string;
    parentToolUseId?: string;
    prompt?: string;
    todoId?: string;
  }): void;
  onSubagentStop(input: {
    agentId: string;
    agentType: string;
    failed?: boolean;
    cancelled?: boolean;
    reason?: string;
  }): void;
  onStop(status: "completed" | "blocked" | "cancelled"): void;
  peekPendingCoderTodoId?: () => string | undefined;
}

export interface EcoPreCompactHookInput {
  trigger: "auto" | "manual";
  sessionId?: string;
}

export type SubagentRunPhase = "planning" | "execution" | "ask";

/**
 * Mirror of desktop `requiresBrowserOpenApproval` for PreToolUse.
 * Keep in sync with apps/desktop/src/shared/browser.ts.
 */
export function isEcoBrowserOpenApprovalToolName(toolName: string): boolean {
  const name = toolName.trim().toLowerCase();
  if (!name) {
    return false;
  }
  const isEcoBrowser =
    name.includes("eco_agent_browser") ||
    name.includes("mcp__eco_agent_browser") ||
    name.includes("agent_browser_");
  if (!isEcoBrowser) {
    return false;
  }
  if (name.includes("agent_browser_open")) {
    return true;
  }
  if (name.includes("agent_browser_tab_new") || name.includes("tab_new")) {
    return true;
  }
  if (name.includes("navigate") || name.includes("goto")) {
    return true;
  }
  return false;
}

export function createBrowserOpenApprovalPreToolHook(
  resolveMode?: () => "always_allow" | "always_ask",
): HookCallback | undefined {
  if (!resolveMode) {
    return undefined;
  }
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (resolveMode() !== "always_ask") {
      return {};
    }
    if (!isEcoBrowserOpenApprovalToolName(preInput.tool_name)) {
      return {};
    }
    return askTool(preInput.tool_name, "Agent is about to open a website in the built-in browser.");
  };
}

/** Match Claude-native WebSearch and Eco integrated web-search MCP tool. */
export function isEcoWebSearchApprovalToolName(toolName: string): boolean {
  const name = toolName.trim().toLowerCase();
  if (!name) {
    return false;
  }
  if (name === "websearch" || name === "web_search") {
    return true;
  }
  return name.includes("eco_web_search");
}

export function createWebSearchApprovalPreToolHook(
  resolveMode?: () => "always_allow" | "always_ask",
): HookCallback | undefined {
  if (!resolveMode) {
    return undefined;
  }
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (resolveMode() !== "always_ask") {
      return {};
    }
    if (!isEcoWebSearchApprovalToolName(preInput.tool_name)) {
      return {};
    }
    return askTool(preInput.tool_name, "Agent is about to run a web search.");
  };
}

export interface EcoSubagentSessionHooks {
  phase: SubagentRunPhase;
  threadId: string;
  onStart(input: {
    agentId: string;
    agentType: string;
    parentToolUseId?: string;
    prompt?: string;
    todoId?: string;
  }): void;
  onStop(input: {
    agentId: string;
    agentType: string;
    agentTranscriptPath?: string;
    transcriptPath?: string;
    failed?: boolean;
    cancelled?: boolean;
    reason?: string;
  }): void | Promise<void>;
  /** SDK stream paired parent_tool_use_id with a SubagentStart agent id. */
  onDelegationLinked?(input: {
    agentId: string;
    agentType: string;
    parentToolUseId: string;
    prompt: string;
    todoId?: string;
  }): void;
  resolveResume(input: SubagentResumeResolveInput): string | undefined;
  todoIdHint?: () => string | undefined;
  onAgentToolCapture?: (input: { role: RuntimeAgentRole; prompt: string; todoIdHint?: string }) => void;
}

export type EcoSubagentLaunchGateDecision = { ok: true } | { ok: false; reason: string };

export interface EcoSubagentLaunchGate {
  tryReserveLaunch(input: {
    toolUseId: string;
    role?: RuntimeAgentRole;
    prompt?: string;
  }): EcoSubagentLaunchGateDecision;
  releaseLaunch?(input: { toolUseId?: string; agentId?: string; role?: RuntimeAgentRole }): void;
}

export interface EcoSubagentRuntimeLimitHooks {
  onStart(input: { agentId: string; agentType: string }): void;
  onStop(input: { agentId: string; agentType: string }): void;
}

export interface EcoSubagentAttributionHooks {
  resolveAgentId?(input: {
    role: RuntimeAgentRole;
    parentToolUseId?: string;
    sessionId: string;
  }): string | undefined;
  onTaskToolUse?(toolUseId: string, input?: { role?: RuntimeAgentRole }): void;
  /** Seed runtime stream context when a subagent instance is known (SubagentStart / delegation link). */
  onSubagentRegistered?(input: { role: RuntimeAgentRole; agentId?: string; parentToolUseId?: string }): void;
}

/**
 * "指定子代理执行已批准计划": host-supplied one-shot delegation contract. When present,
 * the parent turn's Agent/Task spawn is rewritten to the canonical task and restricted to
 * the chosen role.
 */
export interface ForcedPlanDelegationHookConfig {
  /** Target role key from the thread's locked orchestration snapshot. */
  agentKey: string;
  /** Canonical task (verbatim plan + optional user message) the parent must send. */
  canonicalTask: string;
  /** One-shot claim; `ok: false` denies a wrong-target or repeat delegation. */
  claimSpawn: (input: {
    toolUseId?: string;
    agentKey: string;
  }) => { ok: true } | { ok: false; reason: string };
  /** Mark the claim as started only after the SDK emits SubagentStart. */
  confirmSpawn?: (input: { agentKey: string; toolUseIds: readonly string[] }) => void;
}

export function createForcedPlanDelegationSubagentStartHook(
  resolveConfig?: () => ForcedPlanDelegationHookConfig | undefined,
): HookCallback | undefined {
  if (!resolveConfig) {
    return undefined;
  }
  return async (input) => {
    if (input.hook_event_name !== "SubagentStart") {
      return {};
    }
    const config = resolveConfig();
    if (!config) {
      return {};
    }
    const started = input as SubagentStartHookInput;
    // Claude Agent SDK reports Eco's registered agents as `general-purpose` in
    // SubagentStart, even though the spawn was rewritten to `eco_<role>`. The
    // armed delegation already pins the only allowed target, so use that
    // target for the launch confirmation when the SDK emits its generic key.
    const agentKey =
      (started.agent_type === SDK_GENERAL_PURPOSE_AGENT_KEY
        ? config.agentKey
        : normalizeSdkBuiltinOrEcoAgentRole(started.agent_type)) ??
      normalizeSdkSubagentType(started.agent_type) ??
      started.agent_type;
    config.confirmSpawn?.({
      agentKey,
      // The SDK's SubagentStart callback `toolUseID` is a hook invocation id,
      // not the parent Agent tool id. Use only ids explicitly carried by the
      // event; otherwise the one-shot role claim is the source of truth.
      toolUseIds: collectSubagentStartParentToolUseIdCandidates(started, undefined),
    });
    return {};
  };
}

export interface EcoHookContext {
  resolveChangedFiles?: () => Promise<readonly string[]>;
  onExitPlanMode?: (request: SdkExitPlanModeRequest & { toolUseId: string }) => void | Promise<void>;
  /** Blocks until the user approves or denies ExitPlanMode (SDK canUseTool + PermissionRequest). */
  awaitPlanApproval?: (
    request: SdkExitPlanModeRequest & { toolUseId: string },
  ) => Promise<PlanApprovalDecision>;
  /** Tracks ExitPlanMode captures to avoid duplicate Pre/Post hook submissions. */
  exitPlanCaptureState?: { capturedToolUseIds: Set<string> };
  /** Execution resume: only this previously approved deferred ExitPlanMode call may complete. */
  approvedExitPlanToolUseId?: string;
  /** Forced one-shot plan delegation (see `ForcedPlanDelegationHookConfig`). */
  resolveForcedPlanDelegation?: () => ForcedPlanDelegationHookConfig | undefined;
  /** Explicit current phase boundary; do not infer Agent mode from available callbacks. */
  planModeToolPolicy?: PlanModeToolPolicy;
  taskTracker?: EcoTaskTrackerHooks;
  subagentSessions?: EcoSubagentSessionHooks;
  subagentLaunchGate?: EcoSubagentLaunchGate;
  subagentRuntimeLimit?: EcoSubagentRuntimeLimitHooks;
  subagentMaxRuntimeMs?: number;
  subagentLaunchRegistry?: SubagentLaunchRegistry;
  subagentAttribution?: EcoSubagentAttributionHooks;
  onNotification?: (input: { message: string; title?: string; notificationType: string }) => void;
  onPreCompact?: (input: EcoPreCompactHookInput) => Promise<void>;
  getStopTodoStatus?: () => "completed" | "blocked" | "cancelled";
  subagentAvailability?: SubagentAvailability;
  allowedAgentKeys?: string[];
  allowedSdkBuiltinAgentKeys?: string[];
  toolPermissions?: EcoRuntimeToolPermissionPolicy;
  /** Actor's actual model capability. Applied in PreToolUse even under bypassPermissions. */
  resolveSupportsImageInput?: (input: { agentId?: string; agentType?: string }) => boolean | undefined;
  /** @deprecated 持久化字段名；语义为执行确认档位 */
  bashReviewMode?: ExecutionConfirmationMode;
  resolveBashReviewMode?: () => ExecutionConfirmationMode;
  /**
   * Built-in browser open approval. When `always_ask`, PreToolUse returns ask so
   * canUseTool can show the approval card (including under bypassPermissions).
   */
  resolveBrowserOpenApprovalMode?: () => "always_allow" | "always_ask";
  /**
   * Web search approval. When `always_ask`, PreToolUse returns ask so
   * canUseTool can show the approval card (including under bypassPermissions).
   */
  resolveWebSearchApprovalMode?: () => "always_allow" | "always_ask";
  workspacePath?: string;
  implicitReadAllowRoots?: readonly string[];
  /** In-memory planning transcript buffer (updated as SDK stream events arrive). */
  getPhaseTranscript?: () => string;
  onToolPermissionDecision?: (decision: EcoToolPermissionDecisionAudit) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const READ_FILESYSTEM_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
export interface EcoToolPermissionDecisionAudit {
  permissionDecision: "deny";
  toolName: string;
  toolUseId: string;
  reason: string;
  actor: string;
  sessionId?: string;
  agentId?: string;
  agentType?: string;
  cwd: string;
}

export interface SdkExitPlanModeRequest {
  plan: string;
  planFilePath?: string;
  allowedPrompts?: unknown;
  rawInput: Record<string, unknown>;
}

export type PlanApprovalDecision = "approved" | "denied";

export type PlanModeToolPolicy = "forbidden" | "user-approval" | "resume-approved-exit";

export function parseExitPlanModeOutput(
  response: unknown,
): { plan: string; planFilePath?: string } | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  const plan = typeof response.plan === "string" ? response.plan.trim() : "";
  const planFilePath = readStringField(response, ["filePath", "file_path", "planFilePath", "plan_file_path"]);
  if (!plan && !planFilePath) {
    return undefined;
  }
  return {
    plan,
    ...(planFilePath ? { planFilePath } : {}),
  };
}

export function parseExitPlanModeInput(input: Record<string, unknown>): SdkExitPlanModeRequest {
  const plan = readStringField(input, ["plan", "planContent", "plan_content", "markdown", "content"]);
  const planFilePath = readStringField(input, [
    "planFilePath",
    "plan_file_path",
    "filePath",
    "file_path",
    "plan_filename",
    "plan_path",
  ]);
  const allowedPrompts = input.allowedPrompts ?? input.allowed_prompts;
  return {
    plan,
    ...(planFilePath ? { planFilePath } : {}),
    ...(allowedPrompts !== undefined ? { allowedPrompts } : {}),
    rawInput: input,
  };
}

function readStringField(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function markExitPlanCaptured(
  state: { capturedToolUseIds: Set<string> } | undefined,
  toolUseId: string,
): boolean {
  const id = toolUseId.trim();
  if (!id || !state) {
    return false;
  }
  if (state.capturedToolUseIds.has(id)) {
    return true;
  }
  state.capturedToolUseIds.add(id);
  return false;
}

function uniqueSearchRoots(roots: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const root of roots) {
    const trimmed = root?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    resolved.push(trimmed);
  }
  return resolved;
}

interface ExitPlanResolveOptions {
  searchRoots: readonly (string | undefined)[];
  transcriptPath?: string;
  getPhaseTranscript?: () => string;
}

function readHookTranscriptPath(hookInput: Record<string, unknown>): string | undefined {
  const value = hookInput.transcript_path;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function resolveExitPlanModeSubmission(
  parsed: SdkExitPlanModeRequest,
  options: ExitPlanResolveOptions,
): Promise<SdkExitPlanModeRequest> {
  if (parsed.plan.trim()) {
    return parsed;
  }
  const roots = uniqueSearchRoots(options.searchRoots);
  for (const root of roots) {
    if (parsed.planFilePath) {
      const planText = await readPlanFileContent(root, parsed.planFilePath);
      if (planText) {
        return { ...parsed, plan: planText };
      }
    }
  }
  const transcriptPath = options.transcriptPath?.trim();
  if (transcriptPath) {
    const fromTranscriptFile = await readPlanFromSdkTranscriptPath(transcriptPath);
    if (fromTranscriptFile?.plan.trim()) {
      return { ...parsed, plan: fromTranscriptFile.plan };
    }
  }
  const phaseTranscript = options.getPhaseTranscript?.().trim();
  if (phaseTranscript) {
    const fromPhase = readPlanFromPhaseTranscript(phaseTranscript);
    if (fromPhase?.plan.trim()) {
      return { ...parsed, plan: fromPhase.plan };
    }
  }
  return parsed;
}

async function delegateExitPlanModeCapture(
  delegate: NonNullable<EcoHookContext["onExitPlanMode"]>,
  state: { capturedToolUseIds: Set<string> } | undefined,
  request: SdkExitPlanModeRequest & { toolUseId: string },
): Promise<boolean> {
  if (!request.plan.trim() || markExitPlanCaptured(state, request.toolUseId)) {
    return false;
  }
  await delegate(request);
  return true;
}

export async function awaitExitPlanModeUserDecision(
  toolInput: Record<string, unknown>,
  context: {
    toolUseId: string;
    cwd?: string;
    transcriptPath?: string;
    awaitApproval: NonNullable<EcoHookContext["awaitPlanApproval"]>;
    capture?: EcoHookContext["onExitPlanMode"];
    state?: { capturedToolUseIds: Set<string> };
    workspacePath?: string;
    getPhaseTranscript?: () => string;
  },
): Promise<{
  behavior: "allow" | "deny";
  message?: string;
  interrupt?: boolean;
  updatedInput: Record<string, unknown>;
}> {
  const parsed = parseExitPlanModeInput(toolInput);
  const resolved = await resolveExitPlanModeSubmission(parsed, {
    searchRoots: [context.workspacePath, context.cwd],
    ...(context.transcriptPath ? { transcriptPath: context.transcriptPath } : {}),
    ...(context.getPhaseTranscript ? { getPhaseTranscript: context.getPhaseTranscript } : {}),
  });
  if (!resolved.plan.trim()) {
    return {
      behavior: "deny",
      message: "ExitPlanMode requires plan content before Mori can present it for approval.",
      interrupt: true,
      updatedInput: toolInput,
    };
  }
  if (context.capture) {
    await delegateExitPlanModeCapture(context.capture, context.state, {
      ...resolved,
      toolUseId: context.toolUseId,
    });
  }
  const decision = await context.awaitApproval({
    ...resolved,
    toolUseId: context.toolUseId,
    rawInput: resolved.rawInput,
  });
  if (decision === "approved") {
    return { behavior: "allow", updatedInput: toolInput };
  }
  return {
    behavior: "deny",
    message: "User declined the plan in Mori.",
    interrupt: false,
    updatedInput: toolInput,
  };
}

/**
 * PermissionRequest overlay for ExitPlanMode. Official SDK plan approval is canUseTool;
 * this hook shares awaitPlanApproval so CLI-style prompts cannot race ahead of Eco UI.
 */
export function createExitPlanModeAwaitApprovalHook(
  awaitApproval: NonNullable<EcoHookContext["awaitPlanApproval"]>,
  capture?: EcoHookContext["onExitPlanMode"],
  state?: { capturedToolUseIds: Set<string> },
  options: { workspacePath?: string; getPhaseTranscript?: () => string } = {},
): HookCallback | undefined {
  return async (input) => {
    if (input.hook_event_name !== "PermissionRequest") {
      return {};
    }
    const requestInput = input as PermissionRequestHookInput;
    if (requestInput.tool_name !== "ExitPlanMode") {
      return {};
    }
    const toolInput = isRecord(requestInput.tool_input) ? requestInput.tool_input : {};
    const injectedInput = mergeExitPlanModeInjectedFields(
      toolInput,
      requestInput as unknown as PreToolUseHookInput,
    );
    const hookRecord = requestInput as unknown as Record<string, unknown>;
    const transcriptPath = readHookTranscriptPath(hookRecord);
    const rawToolUseId = hookRecord.tool_use_id;
    const toolUseId =
      (typeof rawToolUseId === "string" && rawToolUseId.trim()) || `permission:${requestInput.session_id}`;
    const result = await awaitExitPlanModeUserDecision(injectedInput, {
      toolUseId,
      cwd: requestInput.cwd,
      awaitApproval,
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(capture ? { capture } : {}),
      ...(state ? { state } : {}),
      ...(options.workspacePath ? { workspacePath: options.workspacePath } : {}),
      ...(options.getPhaseTranscript ? { getPhaseTranscript: options.getPhaseTranscript } : {}),
    });
    if (result.behavior === "allow") {
      return {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "allow",
            updatedInput: injectedInput,
            updatedPermissions: [
              {
                type: "setMode",
                mode: "acceptEdits",
                destination: "session",
              },
            ],
          },
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          ...(result.message !== undefined ? { message: result.message } : {}),
          interrupt: result.interrupt === true,
        },
      },
    };
  };
}

/** @deprecated Defer-based plan capture removed; use createExitPlanModeAwaitApprovalHook. */
export function createExitPlanModePreToolHook(
  delegate: EcoHookContext["onExitPlanMode"],
  state?: { capturedToolUseIds: Set<string> },
  options: { workspacePath?: string; getPhaseTranscript?: () => string } = {},
): HookCallback | undefined {
  if (!delegate) {
    return undefined;
  }

  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "ExitPlanMode") {
      return {};
    }
    const toolUseId = toolUseID ?? preInput.tool_use_id;
    const toolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const injectedInput = mergeExitPlanModeInjectedFields(toolInput, preInput);
    const hookRecord = preInput as unknown as Record<string, unknown>;
    const transcriptPath = readHookTranscriptPath(hookRecord);
    const parsed = parseExitPlanModeInput(injectedInput);
    const resolved = await resolveExitPlanModeSubmission(parsed, {
      searchRoots: [options.workspacePath, preInput.cwd],
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(options.getPhaseTranscript ? { getPhaseTranscript: options.getPhaseTranscript } : {}),
    });
    if (resolved.plan.trim()) {
      await delegateExitPlanModeCapture(delegate, state, { ...resolved, toolUseId });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "defer",
          permissionDecisionReason:
            "Mori captured the plan for user approval. Planning session ends; execution starts after Mori approval.",
        },
      };
    }
    return {};
  };
}

/**
 * @deprecated Defer + deny path removed; use createExitPlanModeAwaitApprovalHook.
 */
export function createExitPlanModePermissionRequestHook(
  delegate: EcoHookContext["onExitPlanMode"],
  state?: { capturedToolUseIds: Set<string> },
  options: { workspacePath?: string; getPhaseTranscript?: () => string } = {},
): HookCallback | undefined {
  if (!delegate) {
    return undefined;
  }

  return async (input) => {
    if (input.hook_event_name !== "PermissionRequest") {
      return {};
    }
    const requestInput = input as PermissionRequestHookInput;
    if (requestInput.tool_name !== "ExitPlanMode") {
      return {};
    }
    const toolInput = isRecord(requestInput.tool_input) ? requestInput.tool_input : {};
    const injectedInput = mergeExitPlanModeInjectedFields(
      toolInput,
      requestInput as unknown as PreToolUseHookInput,
    );
    const hookRecord = requestInput as unknown as Record<string, unknown>;
    const transcriptPath = readHookTranscriptPath(hookRecord);
    const parsed = parseExitPlanModeInput(injectedInput);
    const resolved = await resolveExitPlanModeSubmission(parsed, {
      searchRoots: [options.workspacePath, requestInput.cwd],
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(options.getPhaseTranscript ? { getPhaseTranscript: options.getPhaseTranscript } : {}),
    });
    const toolUseId = `permission:${requestInput.session_id}`;
    const captured = resolved.plan.trim()
      ? await delegateExitPlanModeCapture(delegate, state, { ...resolved, toolUseId })
      : false;

    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: captured
            ? "Plan captured for Mori approval. Implementation starts only after you approve in Mori."
            : "ExitPlanMode requires plan content before Mori can present it for approval.",
          interrupt: true,
        },
      },
    };
  };
}

export function createPlanModeBoundaryPreToolHook(
  policy: PlanModeToolPolicy,
  approvedExitPlanToolUseId?: string,
): HookCallback {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    const toolName = preInput.tool_name;
    if (
      toolName !== "EnterPlanMode" &&
      toolName !== "ExitPlanMode" &&
      toolName !== "mcp__eco_plan__finalize_plan"
    ) {
      return {};
    }

    if (policy === "user-approval" && toolName === "ExitPlanMode") {
      return {};
    }

    const actualToolUseId = toolUseID ?? preInput.tool_use_id;
    if (
      policy === "resume-approved-exit" &&
      toolName === "ExitPlanMode" &&
      approvedExitPlanToolUseId?.trim() &&
      actualToolUseId === approvedExitPlanToolUseId.trim()
    ) {
      const toolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Completing the exact ExitPlanMode call already approved in Mori.",
          updatedInput: mergeExitPlanModeInjectedFields(toolInput, preInput),
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          policy === "forbidden"
            ? "Plan Mode tools are unavailable in Agent and Ask sessions."
            : "This Plan Mode tool call is not the ExitPlanMode call previously approved in Mori.",
      },
    };
  };
}

/** Parse `deferred_tool_use` for ExitPlanMode from an SDK result message (defer protocol payload). */
export function parseDeferredExitPlanModeResult(
  message: unknown,
): { toolUseId: string; request: SdkExitPlanModeRequest } | undefined {
  if (!isRecord(message) || message.type !== "result") {
    return undefined;
  }
  const deferred = message.deferred_tool_use;
  if (!isRecord(deferred) || deferred.name !== "ExitPlanMode") {
    return undefined;
  }
  const toolUseId = typeof deferred.id === "string" ? deferred.id.trim() : "";
  const input = isRecord(deferred.input) ? deferred.input : {};
  return { toolUseId, request: parseExitPlanModeInput(input) };
}

/**
 * Capture the deferred ExitPlanMode plan from the SDK result payload.
 * This is the official primary channel for defer-based integrations; the PreToolUse hook
 * capture covers the same tool call, so `state` dedupes by tool use id.
 */
export async function captureDeferredExitPlanModeFromResult(
  message: unknown,
  delegate: EcoHookContext["onExitPlanMode"],
  state: { capturedToolUseIds: Set<string> } | undefined,
  options: {
    searchRoots?: readonly (string | undefined)[];
    getPhaseTranscript?: () => string;
  } = {},
): Promise<boolean> {
  if (!delegate) {
    return false;
  }
  const deferred = parseDeferredExitPlanModeResult(message);
  if (!deferred) {
    return false;
  }
  const resolved = await resolveExitPlanModeSubmission(deferred.request, {
    searchRoots: options.searchRoots ?? [],
    ...(options.getPhaseTranscript ? { getPhaseTranscript: options.getPhaseTranscript } : {}),
  });
  if (!resolved.plan.trim()) {
    return false;
  }
  return delegateExitPlanModeCapture(delegate, state, { ...resolved, toolUseId: deferred.toolUseId });
}

function mergeExitPlanModeInjectedFields(
  toolInput: Record<string, unknown>,
  hookInput: PreToolUseHookInput,
): Record<string, unknown> {
  const merged = { ...toolInput };
  const hookRecord = hookInput as unknown as Record<string, unknown>;
  for (const key of [
    "plan",
    "planFilePath",
    "plan_file_path",
    "filePath",
    "file_path",
    "plan_filename",
    "plan_path",
    "allowedPrompts",
    "allowed_prompts",
  ]) {
    if (merged[key] === undefined && hookRecord[key] !== undefined) {
      merged[key] = hookRecord[key];
    }
  }
  return merged;
}

export function createWorkflowDenyPreToolHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "Workflow") {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "SDK Dynamic Workflows are disabled in Mori.",
      },
    };
  };
}

export function createImageReadPreToolHook(
  resolveSupportsImageInput: EcoHookContext["resolveSupportsImageInput"],
): HookCallback | undefined {
  if (!resolveSupportsImageInput) return undefined;
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "Read") return {};
    let supportsImages: boolean | undefined;
    try {
      supportsImages = resolveSupportsImageInput({
        ...(preInput.agent_id ? { agentId: preInput.agent_id } : {}),
        ...(preInput.agent_type ? { agentType: preInput.agent_type } : {}),
      });
    } catch (error) {
      // SDK hook exceptions are non-blocking. Return a concrete denial when the
      // actor's route cannot be resolved, so that gap cannot bypass the policy.
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `无法确认 Agent 的模型视觉配置：${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    if (supportsImages !== false) return {};
    const args = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const filePath = typeof args.file_path === "string" ? args.file_path : "";
    if (!filePath || !(await isNativeImageFile(filePath, preInput.cwd))) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: IMAGE_READ_DISABLED_REASON,
      },
    };
  };
}

export function createNormalizeSubagentPreToolHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "Agent" && preInput.tool_name !== "Task") {
      return {};
    }
    const toolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const normalized = normalizeAgentToolInputSubagentType(toolInput);
    if (!normalized.changed) {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: normalized.input,
      },
    };
  };
}

/** Canonical comparison key for an Eco/Codex/SDK agent role (tolerates `eco_` prefixes). */
function canonicalForcedAgentKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  const role = normalizeSdkSubagentType(value);
  if (role) {
    return role;
  }
  return trimmed.startsWith("eco_") ? trimmed.slice(4) : trimmed;
}

/**
 * Force the parent turn's Agent/Task spawn to the chosen subagent and canonical task.
 * Subagent actors are ignored: only the main agent may consume the armed delegation.
 */
/** Tools the parent may not use while a forced delegation is armed (it must not do the work). */
const FORCED_DELEGATION_PARENT_DENY_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);

export function createForcedPlanDelegationPreToolHook(
  resolveConfig?: () => ForcedPlanDelegationHookConfig | undefined,
): HookCallback {
  return async (input) => {
    if (!resolveConfig || input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    const isSpawn = preInput.tool_name === "Agent" || preInput.tool_name === "Task";
    if (!isSpawn && !FORCED_DELEGATION_PARENT_DENY_TOOLS.has(preInput.tool_name)) {
      return {};
    }
    if (resolveToolPermissionActor(preInput) !== "main") {
      return {};
    }
    const config = resolveConfig();
    if (!config) {
      return {};
    }
    if (!isSpawn) {
      // The user chose a subagent: the parent must delegate instead of editing the workspace.
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: buildForcedPlanDelegationContract({
            agentKey: sdkAgentKeyForOrchestrationAgent(config.agentKey),
          }),
        },
      };
    }
    const toolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const requested = canonicalForcedAgentKey(readAgentSubagentType(toolInput) ?? "");
    const target = canonicalForcedAgentKey(config.agentKey);
    const toolUseId =
      typeof preInput.tool_use_id === "string" && preInput.tool_use_id.trim()
        ? preInput.tool_use_id.trim()
        : undefined;
    const claim = config.claimSpawn({
      ...(toolUseId ? { toolUseId } : {}),
      agentKey: requested || target,
    });
    if (!claim.ok) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: claim.reason,
        },
      };
    }
    const updatedInput: Record<string, unknown> = { ...toolInput, prompt: config.canonicalTask };
    if (target) {
      // The SDK resolves agents by their registered `eco_<key>` name, not the bare role key.
      updatedInput.subagent_type = sdkAgentKeyForOrchestrationAgent(config.agentKey);
      delete updatedInput.agent_type;
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput,
      },
    };
  };
}

/**
 * Injects the forced-delegation contract right after the approved plan is submitted, so
 * the resumed parent turn knows it must delegate (the bridge path has no other prompt).
 */
export function createForcedPlanDelegationPostToolHook(
  resolveConfig?: () => ForcedPlanDelegationHookConfig | undefined,
): HookCallback {
  return async (input) => {
    if (!resolveConfig || input.hook_event_name !== "PostToolUse") {
      return {};
    }
    const postInput = input as PostToolUseHookInput;
    if (postInput.tool_name !== "ExitPlanMode") {
      return {};
    }
    if (resolveToolPermissionActor(postInput) !== "main") {
      return {};
    }
    const config = resolveConfig();
    if (!config) {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: buildForcedPlanDelegationContract({
          agentKey: sdkAgentKeyForOrchestrationAgent(config.agentKey),
        }),
      },
    };
  };
}

export function createNonEcoSubagentDenyPreToolHook(
  allowedAgentKeys: readonly string[] = [],
  allowedSdkBuiltinAgentKeys: readonly string[] = [],
): HookCallback {
  const allowed = new Set(allowedAgentKeys);
  const allowedSdkBuiltins = new Set(allowedSdkBuiltinAgentKeys);
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "Agent" && preInput.tool_name !== "Task") {
      return {};
    }
    const toolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const rawType = readAgentSubagentType(toolInput);
    if (!rawType) {
      return {};
    }
    if (allowedSdkBuiltins.has(rawType)) {
      return {};
    }
    const normalizedType = normalizeSdkSubagentType(rawType);
    if (normalizedType && isSubagentRole(normalizedType)) {
      return {};
    }
    const normalizedEcoKey = normalizedType ? `eco_${normalizedType}` : undefined;
    if (allowed.has(rawType) || (normalizedEcoKey && allowed.has(normalizedEcoKey))) {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Subagent "${rawType}" is not registered for this session.`,
      },
    };
  };
}

export function createDisabledSubagentPreToolHook(
  availability?: SubagentAvailability,
): HookCallback | undefined {
  const resolved = availability ?? normalizeSubagentAvailability();
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "Agent" && preInput.tool_name !== "Task") {
      return {};
    }
    const toolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const rawType = readAgentSubagentType(toolInput);
    const subagentType = rawType ? normalizeSdkSubagentType(rawType) : undefined;
    if (!subagentType) {
      return {};
    }
    if (!isSubagentRole(subagentType) || isSubagentEnabled(resolved, subagentType)) {
      return {};
    }
    const deniedLabel = rawType ?? subagentType;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Subagent "${deniedLabel}" is disabled in Mori settings.`,
      },
    };
  };
}

export function createNestedSubagentDenyPreToolHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "Agent" && preInput.tool_name !== "Task") {
      return {};
    }
    const actorAgentId = typeof preInput.agent_id === "string" ? preInput.agent_id.trim() : "";
    if (actorAgentId) {
      return denyTool(preInput.tool_name, "Subagents cannot launch other subagents.");
    }
    return {};
  };
}

export function createSubagentLaunchGatePreToolHook(gate?: EcoSubagentLaunchGate): HookCallback {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "Agent" && preInput.tool_name !== "Task") {
      return {};
    }
    if (!gate) {
      return {};
    }
    const parentToolUseId =
      (typeof toolUseID === "string" && toolUseID.trim()) || preInput.tool_use_id.trim();
    if (!parentToolUseId) {
      return {};
    }
    const rawToolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const { input: toolInput } = normalizeAgentToolInputSubagentType(rawToolInput);
    const rawType = readAgentSubagentType(rawToolInput);
    const role = normalizeSdkBuiltinOrEcoAgentRole(rawType) ?? rawType;
    const prompt = readAgentDelegationPrompt(toolInput);
    const decision = gate.tryReserveLaunch({
      toolUseId: parentToolUseId,
      ...(role && { role }),
      ...(prompt && { prompt }),
    });
    if (decision.ok) {
      return {};
    }
    return denyTool(preInput.tool_name, decision.reason);
  };
}

export function createToolPermissionPreToolHook(
  policy?: EcoRuntimeToolPermissionPolicy,
  options: {
    workspacePath?: string;
    implicitReadAllowRoots?: readonly string[];
    bashReviewMode?: ExecutionConfirmationMode;
    resolveBashReviewMode?: () => ExecutionConfirmationMode;
    onDecision?: (decision: EcoToolPermissionDecisionAudit) => void;
  } = {},
): HookCallback | undefined {
  if (!policy) {
    return undefined;
  }
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (
      preInput.tool_name === "EnterPlanMode" ||
      preInput.tool_name === "ExitPlanMode" ||
      preInput.tool_name === "AskUserQuestion"
    ) {
      return {};
    }
    const actor = resolveToolPermissionActor(preInput);
    const entry = materializeRuntimeToolPermissionEntry(resolveToolPermissionEntryForActor(policy, actor));
    if (!entry) {
      return recordToolPermissionDecision(
        preInput,
        actor,
        denyTool(preInput.tool_name, `No Mori tool policy is registered for agent ${actor}.`),
        options,
      );
    }
    if (matchesAnyToolPattern(preInput.tool_name, entry.disallowed)) {
      return recordToolPermissionDecision(
        preInput,
        actor,
        denyTool(preInput.tool_name, `Tool "${preInput.tool_name}" is disallowed for ${actor}.`),
        options,
      );
    }
    const structuredDecision = evaluateStructuredToolPolicy(preInput, entry, { ...options, actor });
    if (structuredDecision) {
      return recordToolPermissionDecision(preInput, actor, structuredDecision, options);
    }
    const mcpDecision = evaluateMcpToolPolicy(preInput, entry, { actor });
    if (mcpDecision) {
      return recordToolPermissionDecision(preInput, actor, mcpDecision, options);
    }
    return {};
  };
}

function resolveToolPermissionActor(input: { agent_id?: string; agent_type?: string }): "main" | string {
  if (typeof input.agent_id === "string" && input.agent_id.trim()) {
    return typeof input.agent_type === "string" && input.agent_type.trim()
      ? input.agent_type.trim()
      : input.agent_id.trim();
  }
  return "main";
}

function materializeRuntimeToolPermissionEntry(
  entry: EcoRuntimeToolPermissionEntry | undefined,
): EcoRuntimeToolPermissionEntry | undefined {
  if (!entry) {
    return undefined;
  }
  const materialized = materializeEcoToolPolicy({
    allowed: entry.allowed,
    disallowed: entry.disallowed,
    ...(entry.bash ? { bash: entry.bash } : {}),
    ...(entry.filesystem ? { filesystem: entry.filesystem } : {}),
    ...(entry.network ? { network: entry.network } : {}),
  });
  return {
    ...entry,
    disallowed: materialized.disallowed,
    ...(materialized.bash ? { bash: materialized.bash } : {}),
  };
}

function evaluateStructuredToolPolicy(
  input: PreToolUseHookInput,
  entry: EcoRuntimeToolPermissionEntry,
  options: {
    workspacePath?: string;
    bashReviewMode?: ExecutionConfirmationMode;
    resolveBashReviewMode?: () => ExecutionConfirmationMode;
    actor?: "main" | string;
  },
): HookJSONOutput | undefined {
  if (input.tool_name === "Bash") {
    return evaluateBashToolPolicy(input, entry, options);
  }
  const filesystemDecision = evaluateFilesystemToolPolicy(input, entry, options);
  if (filesystemDecision) {
    return filesystemDecision;
  }
  return evaluateNetworkToolPolicy(input, entry);
}

function evaluateBashToolPolicy(
  input: PreToolUseHookInput,
  entry: EcoRuntimeToolPermissionEntry,
  options: {
    workspacePath?: string;
    bashReviewMode?: ExecutionConfirmationMode;
    resolveBashReviewMode?: () => ExecutionConfirmationMode;
    actor?: "main" | string;
  },
): HookJSONOutput | undefined {
  const command = readBashCommand(input.tool_input);
  if (!command) {
    return undefined;
  }
  const workspacePath = options.workspacePath?.trim() || input.cwd;
  const confirmationMode = options.resolveBashReviewMode?.() ?? options.bashReviewMode ?? "always";
  const gate = evaluateBashHookGate({
    command,
    cwd: input.cwd,
    workspacePath,
    confirmationMode,
    agentBash: {
      enabled: true,
    },
  });
  if (!gate || gate.action !== "deny") {
    return undefined;
  }
  return denyTool("Bash", gate.reason);
}

function evaluateFilesystemToolPolicy(
  input: PreToolUseHookInput,
  entry: EcoRuntimeToolPermissionEntry,
  options: {
    workspacePath?: string;
    bashReviewMode?: ExecutionConfirmationMode;
    resolveBashReviewMode?: () => ExecutionConfirmationMode;
    implicitReadAllowRoots?: readonly string[];
    actor?: "main" | string;
  },
): HookJSONOutput | undefined {
  const filesystem = entry.filesystem;
  if (!filesystem) {
    return undefined;
  }
  const workspacePath = options.workspacePath?.trim();
  if (!workspacePath) {
    return undefined;
  }
  const confirmationMode = options.resolveBashReviewMode?.() ?? options.bashReviewMode ?? "always";
  const gate = evaluateFilesystemHookGate({
    toolName: input.tool_name,
    toolInput: isRecord(input.tool_input) ? input.tool_input : {},
    cwd: input.cwd,
    workspacePath,
    confirmationMode,
    filesystemRead: filesystem.read,
    filesystemWrite: filesystem.write,
    ...(options.implicitReadAllowRoots?.length
      ? { implicitReadAllowRoots: options.implicitReadAllowRoots }
      : {}),
  });
  if (!gate) {
    return undefined;
  }
  if (gate.action === "deny") {
    return denyTool(input.tool_name, gate.reason);
  }
  if (gate.action === "ask") {
    return askTool(input.tool_name, gate.reason);
  }
  return undefined;
}

function evaluateNetworkToolPolicy(
  _input: PreToolUseHookInput,
  _entry: EcoRuntimeToolPermissionEntry,
): HookJSONOutput | undefined {
  return undefined;
}

function evaluateMcpToolPolicy(
  input: PreToolUseHookInput,
  entry: EcoRuntimeToolPermissionEntry,
  options: { actor?: "main" | string },
): HookJSONOutput | undefined {
  if (!input.tool_name.startsWith("mcp__")) {
    return undefined;
  }
  const assignedServers = entry.mcpServers ?? [];
  const actorLabel = options.actor ?? "this agent";
  if (assignedServers.length === 0) {
    return denyTool(input.tool_name, `MCP is not configured for ${actorLabel}.`);
  }
  const toolServer = parseMcpToolServerName(input.tool_name);
  if (!toolServer) {
    return denyTool(input.tool_name, `Tool "${input.tool_name}" is not a valid MCP tool for ${actorLabel}.`);
  }
  const assigned = new Set(assignedServers.map((server) => sanitizeMcpServerName(server)));
  if (!assigned.has(toolServer)) {
    return denyTool(input.tool_name, `MCP server "${toolServer}" is not assigned to ${actorLabel}.`);
  }
  return undefined;
}

function readBashCommand(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  for (const key of ["command", "bash_command", "full_command"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function askTool(toolName: string, reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason || `Tool "${toolName}" requires approval by Mori policy.`,
    },
  };
}

function recordToolPermissionDecision(
  input: PreToolUseHookInput,
  actor: string,
  output: HookJSONOutput,
  options: { onDecision?: (decision: EcoToolPermissionDecisionAudit) => void },
): HookJSONOutput {
  const hookOutput = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
  if (hookOutput?.hookEventName !== "PreToolUse" || hookOutput.permissionDecision !== "deny") {
    return output;
  }
  options.onDecision?.({
    permissionDecision: "deny",
    toolName: input.tool_name,
    toolUseId: input.tool_use_id,
    reason: hookOutput.permissionDecisionReason || `Tool "${input.tool_name}" is denied by Mori policy.`,
    actor,
    ...(typeof input.session_id === "string" && { sessionId: input.session_id }),
    ...(typeof input.agent_id === "string" && { agentId: input.agent_id }),
    ...(typeof input.agent_type === "string" && { agentType: input.agent_type }),
    cwd: input.cwd,
  });
  return output;
}

function denyTool(toolName: string, reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason || `Tool "${toolName}" is denied by Mori policy.`,
    },
  };
}

function matchesAnyToolPattern(toolName: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesToolPattern(toolName, pattern));
}

function matchesToolPattern(toolName: string, pattern: string): boolean {
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

export function createReviewerScopePreToolHook(
  resolveChangedFiles: EcoHookContext["resolveChangedFiles"],
): HookCallback | undefined {
  if (!resolveChangedFiles) {
    return undefined;
  }

  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== "Agent" && preInput.tool_name !== "Task") {
      return {};
    }
    const rawToolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const { input: toolInput, role } = normalizeAgentToolInputSubagentType(rawToolInput);
    if (role !== "reviewer") {
      return {};
    }

    const changedFiles = await resolveChangedFiles();
    const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : "";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: {
          ...toolInput,
          prompt: appendReviewerScopeToPrompt(prompt, changedFiles),
        },
      },
    };
  };
}

export function resolveSubagentStartParentToolUseId(
  input: SubagentStartHookInput,
  toolUseID: string | undefined,
): string | undefined {
  return resolveHookToolUseId(input as unknown as Record<string, unknown>, toolUseID);
}

/** All parent tool ids SubagentStart may carry; parent_tool_use_id is the delegating Agent tool. */
export function collectSubagentStartParentToolUseIdCandidates(
  input: SubagentStartHookInput,
  toolUseID: string | undefined,
): string[] {
  const record = input as unknown as Record<string, unknown>;
  const candidates: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };
  push(record.parent_tool_use_id);
  push(toolUseID);
  push(record.tool_use_id);
  return candidates;
}

function resolveHookToolUseId(
  input: Record<string, unknown>,
  toolUseID: string | undefined,
): string | undefined {
  const fromCallback = typeof toolUseID === "string" ? toolUseID.trim() : "";
  if (fromCallback) {
    return fromCallback;
  }
  const fromParentField = typeof input.parent_tool_use_id === "string" ? input.parent_tool_use_id.trim() : "";
  if (fromParentField) {
    return fromParentField;
  }
  const fromToolField = typeof input.tool_use_id === "string" ? input.tool_use_id.trim() : "";
  return fromToolField || undefined;
}

function readTaskIdFromSubagentStart(input: SubagentStartHookInput): string | undefined {
  const extended = input as SubagentStartHookInput & { task_id?: string };
  const taskId = typeof extended.task_id === "string" ? extended.task_id.trim() : "";
  return taskId || undefined;
}

function readPromptFromSubagentStart(input: SubagentStartHookInput): string | undefined {
  const prompt = readAgentDelegationPrompt(input as unknown as Record<string, unknown>);
  return prompt || undefined;
}

function readAgentDelegationPrompt(toolInput: Record<string, unknown>): string {
  if (typeof toolInput.prompt === "string" && toolInput.prompt.trim()) {
    return toolInput.prompt;
  }
  if (typeof toolInput.task === "string" && toolInput.task.trim()) {
    return toolInput.task;
  }
  if (typeof toolInput.description === "string" && toolInput.description.trim()) {
    return toolInput.description;
  }
  return "";
}

export function createSubagentLaunchPreToolHook(input: {
  registry: SubagentLaunchRegistry;
  attribution?: EcoSubagentAttributionHooks;
  onAgentToolCapture?: EcoSubagentSessionHooks["onAgentToolCapture"];
}): HookCallback {
  const { registry, attribution, onAgentToolCapture } = input;
  return async (hookInput, toolUseID) => {
    if (hookInput.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = hookInput as PreToolUseHookInput;
    if (preInput.tool_name !== "Agent" && preInput.tool_name !== "Task") {
      return {};
    }
    const parentToolUseId =
      (typeof toolUseID === "string" && toolUseID.trim()) || preInput.tool_use_id.trim();
    if (!parentToolUseId) {
      return {};
    }
    const rawToolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    const { input: toolInput } = normalizeAgentToolInputSubagentType(rawToolInput);
    const role = normalizeSdkBuiltinOrEcoAgentRole(readAgentSubagentType(rawToolInput));
    if (!role) {
      return {};
    }
    const prompt = readAgentDelegationPrompt(toolInput);
    const todoIdHint =
      typeof toolInput.eco_todo_id === "string" && toolInput.eco_todo_id.trim()
        ? toolInput.eco_todo_id.trim()
        : undefined;
    registry.register({
      parentToolUseId,
      role,
      prompt,
      ...(todoIdHint && { todoIdHint }),
    });
    attribution?.onSubagentRegistered?.({ role, parentToolUseId });
    onAgentToolCapture?.({
      role,
      prompt,
      ...(todoIdHint && { todoIdHint }),
    });
    attribution?.onTaskToolUse?.(parentToolUseId, { role });
    return {};
  };
}

export function createSubagentToolAttributionPreToolHook(
  attribution?: EcoSubagentAttributionHooks,
): HookCallback | undefined {
  if (!attribution?.onTaskToolUse && !attribution?.onSubagentRegistered) {
    return undefined;
  }
  const onTaskToolUse = attribution.onTaskToolUse;
  const onSubagentRegistered = attribution.onSubagentRegistered;
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    if (typeof toolUseID === "string" && (preInput.tool_name === "Task" || preInput.tool_name === "Agent")) {
      const parentToolUseId = toolUseID.trim() || preInput.tool_use_id.trim();
      const toolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
      const rawType = readAgentSubagentType(toolInput);
      const role = normalizeSdkBuiltinOrEcoAgentRole(rawType);
      if (parentToolUseId && role) {
        onSubagentRegistered?.({ role, parentToolUseId });
      }
      onTaskToolUse?.(toolUseID, role ? { role } : undefined);
    }
    return {};
  };
}

function normalizeSdkBuiltinOrEcoAgentRole(rawType: string | undefined): RuntimeAgentRole | undefined {
  if (rawType === SDK_GENERAL_PURPOSE_AGENT_KEY || rawType === SDK_PLAN_AGENT_KEY) {
    return rawType;
  }
  return normalizeSdkSubagentType(rawType ?? "");
}

export function createTaskToolPreToolHook(taskTracker: EcoTaskTrackerHooks): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    const toolInput = isRecord(preInput.tool_input) ? preInput.tool_input : {};
    taskTracker.onPreToolUse(preInput.tool_name, toolInput);
    return {};
  };
}

export function createTaskCreatedHook(
  taskTracker: EcoTaskTrackerHooks,
  subagentLaunchRegistry?: SubagentLaunchRegistry,
): HookCallback {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "TaskCreated") {
      return {};
    }
    const created = input as TaskCreatedHookInput;
    taskTracker.onTaskCreated({
      taskId: created.task_id,
      subject: created.task_subject,
      ...(created.task_description ? { description: created.task_description } : {}),
    });
    const parentToolUseId = resolveHookToolUseId(created as unknown as Record<string, unknown>, toolUseID);
    if (parentToolUseId) {
      subagentLaunchRegistry?.linkTask(created.task_id, parentToolUseId);
    }
    return {};
  };
}

export function createTaskCompletedHook(taskTracker: EcoTaskTrackerHooks): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "TaskCompleted") {
      return {};
    }
    const completed = input as TaskCompletedHookInput;
    taskTracker.onTaskCompleted({
      taskId: completed.task_id,
      subject: completed.task_subject,
    });
    return {};
  };
}

export function createSubagentStartHook(handlers: {
  taskTracker?: EcoTaskTrackerHooks;
  subagentSessions?: EcoSubagentSessionHooks;
  subagentLaunchRegistry?: SubagentLaunchRegistry;
  attribution?: EcoSubagentAttributionHooks;
  runtimeLimit?: EcoSubagentRuntimeLimitHooks;
}): HookCallback {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "SubagentStart") {
      return {};
    }
    const started = input as SubagentStartHookInput;
    const taskId = readTaskIdFromSubagentStart(started);
    const agentType =
      normalizeSdkBuiltinOrEcoAgentRole(started.agent_type) ??
      normalizeSdkSubagentType(started.agent_type) ??
      started.agent_type;
    const parentToolUseIdCandidates = collectSubagentStartParentToolUseIdCandidates(started, toolUseID);
    const delegationPrompt = readPromptFromSubagentStart(started);
    const launchFromHook = handlers.subagentLaunchRegistry?.takeForSubagentStart({
      role: agentType as RuntimeAgentRole,
      agentId: started.agent_id,
      ...(taskId && { taskId }),
      parentToolUseIds: parentToolUseIdCandidates,
      ...(delegationPrompt && { prompt: delegationPrompt }),
    });
    const streamPair =
      !launchFromHook && started.agent_id.trim()
        ? handlers.subagentLaunchRegistry?.noteSubagentAwaitingStream(
            started.agent_id,
            agentType as RuntimeAgentRole,
          )
        : undefined;
    const launch = launchFromHook ?? streamPair?.launch;
    if (launch && started.agent_id.trim()) {
      handlers.subagentLaunchRegistry?.linkTask(started.agent_id, launch.parentToolUseId);
    }
    const resolvedParentToolUseId = launch?.parentToolUseId;
    const prompt = launch?.prompt?.trim() || undefined;
    const todoId = launch?.todoIdHint?.trim() || undefined;
    const payload = {
      agentId: started.agent_id,
      agentType,
      ...(resolvedParentToolUseId && { parentToolUseId: resolvedParentToolUseId }),
      ...(prompt && { prompt }),
      ...(todoId && { todoId }),
    };
    handlers.taskTracker?.onSubagentStart(payload);
    handlers.subagentSessions?.onStart(payload);
    handlers.runtimeLimit?.onStart(payload);
    handlers.attribution?.onSubagentRegistered?.({
      role: agentType as RuntimeAgentRole,
      agentId: started.agent_id,
      ...(resolvedParentToolUseId && { parentToolUseId: resolvedParentToolUseId }),
    });
    return {};
  };
}

/**
 * Claude Agent SDK SubagentStopHookInput has no `failed` field (0.3.266).
 * Infer terminal failure from extra fields some emitters attach, or from the
 * documented Agent-tool error text (`Agent terminated early due to an API error`).
 * https://code.claude.com/docs/en/errors
 */
export function inferSubagentStopFailure(input: SubagentStopHookInput): {
  failed?: boolean;
  cancelled?: boolean;
  reason?: string;
} {
  const extra = input as SubagentStopHookInput & Record<string, unknown>;
  const reasonCandidates = [
    extra.last_assistant_message,
    extra.reason,
    extra.error,
    extra.stopReason,
    extra.stop_reason,
  ];
  const reason = reasonCandidates
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  const cancelled = extra.cancelled === true || extra.status === "stopped" || extra.status === "killed";
  const failedExplicit =
    extra.failed === true || extra.status === "failed" || extra.is_error === true || extra.isError === true;
  const failedFromMessage = Boolean(
    reason && /terminated early due to an API error|API Error:\s*\d{3}/i.test(reason),
  );
  const failed = failedExplicit || failedFromMessage;
  return {
    ...(failed && { failed: true }),
    ...(cancelled && { cancelled: true }),
    ...(reason && { reason }),
  };
}

export function createSubagentStopHook(handlers: {
  taskTracker?: EcoTaskTrackerHooks;
  subagentSessions?: EcoSubagentSessionHooks;
  runtimeLimit?: EcoSubagentRuntimeLimitHooks;
}): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "SubagentStop") {
      return {};
    }
    const stopped = input as SubagentStopHookInput;
    const agentType = normalizeSdkSubagentType(stopped.agent_type) ?? stopped.agent_type;
    const outcome = inferSubagentStopFailure(stopped);
    const payload = {
      agentId: stopped.agent_id,
      agentType,
      ...(stopped.agent_transcript_path?.trim() && {
        agentTranscriptPath: stopped.agent_transcript_path.trim(),
      }),
      ...(stopped.transcript_path?.trim() && { transcriptPath: stopped.transcript_path.trim() }),
      ...outcome,
    };
    handlers.runtimeLimit?.onStop(payload);
    handlers.taskTracker?.onSubagentStop(payload);
    await handlers.subagentSessions?.onStop(payload);
    return {};
  };
}

export function createStopHook(ctx: EcoHookContext): HookCallback | undefined {
  if (!ctx.taskTracker) {
    return undefined;
  }

  return async (input) => {
    if (input.hook_event_name !== "Stop") {
      return {};
    }
    const stopInput = input as StopHookInput;
    if (stopInput.stop_hook_active) {
      return {};
    }
    const status = ctx.getStopTodoStatus?.() ?? "completed";
    ctx.taskTracker?.onStop(status);
    return {};
  };
}

export function createPreCompactHook(onPreCompact: EcoHookContext["onPreCompact"]): HookCallback | undefined {
  if (!onPreCompact) {
    return undefined;
  }

  return async (input) => {
    if (input.hook_event_name !== "PreCompact") {
      return {};
    }
    const preInput = input as PreCompactHookInput;
    await onPreCompact({
      trigger: preInput.trigger,
      sessionId: preInput.session_id,
    });
    return {};
  };
}

/**
 * Codex-aligned record-time tool output prune: replace oversized tool_response before
 * it is written into the SDK transcript / model context (TruncationPolicy ≈ 10k tokens × 1.2).
 * Also stamps a short `classifierContext` (tool name + brief outcome) for PostToolUse.
 */
export function createToolOutputTruncationPostToolHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PostToolUse") {
      return {};
    }
    const post = input as PostToolUseHookInput;
    const classifierContext = buildPostToolClassifierContext(post);
    const pruned = truncateToolOutputForHistory(post.tool_response);
    if (!pruned.truncated) {
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          classifierContext,
        },
      } satisfies HookJSONOutput;
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: pruned.value,
        classifierContext,
      },
    } satisfies HookJSONOutput;
  };
}

/** Standalone PostToolUse hook that only sets classifierContext. */
export function createClassifierContextPostToolHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PostToolUse") {
      return {};
    }
    const post = input as PostToolUseHookInput;
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        classifierContext: buildPostToolClassifierContext(post),
      },
    } satisfies HookJSONOutput;
  };
}

const CLASSIFIER_CONTEXT_MAX_CHARS = 240;

function buildPostToolClassifierContext(post: PostToolUseHookInput): string {
  const toolName =
    typeof post.tool_name === "string" && post.tool_name.trim() ? post.tool_name.trim() : "Tool";
  const outcome = summarizeToolResponseForClassifier(post.tool_response);
  const combined = outcome ? `${toolName}: ${outcome}` : toolName;
  if (combined.length <= CLASSIFIER_CONTEXT_MAX_CHARS) {
    return combined;
  }
  return `${combined.slice(0, CLASSIFIER_CONTEXT_MAX_CHARS - 1)}…`;
}

function summarizeToolResponseForClassifier(toolResponse: unknown): string {
  if (typeof toolResponse === "string") {
    return toolResponse.replace(/\s+/g, " ").trim();
  }
  if (toolResponse == null) {
    return "";
  }
  try {
    return JSON.stringify(toolResponse).replace(/\s+/g, " ").trim();
  } catch {
    return String(toolResponse).replace(/\s+/g, " ").trim();
  }
}

export function createNotificationHook(
  onNotification: EcoHookContext["onNotification"],
): HookCallback | undefined {
  if (!onNotification) {
    return undefined;
  }

  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "Notification") {
      const output: HookJSONOutput = {};
      return output;
    }
    const notification = input as NotificationHookInput;
    onNotification({
      message: notification.message,
      ...(notification.title ? { title: notification.title } : {}),
      notificationType: notification.notification_type,
    });
    return { async: true, asyncTimeout: 5000 };
  };
  return hook;
}

function pushMatcher(
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
  event: HookEvent,
  matcher: HookCallbackMatcher,
): void {
  const existing = hooks[event];
  if (existing) {
    existing.push(matcher);
    return;
  }
  hooks[event] = [matcher];
}

function pushHook(
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
  event: HookEvent,
  callback: HookCallback | undefined,
  matcher?: string,
): void {
  if (!callback) {
    return;
  }
  pushMatcher(hooks, event, {
    ...(matcher ? { matcher } : {}),
    hooks: [callback],
  });
}

/** Build SDK callback hooks for eco-coding thread sessions. */
export function buildEcoSdkHooks(ctx: EcoHookContext): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  const availability = ctx.subagentAvailability ?? normalizeSubagentAvailability();
  const planModeToolPolicy: PlanModeToolPolicy =
    ctx.planModeToolPolicy ??
    (ctx.awaitPlanApproval
      ? "user-approval"
      : ctx.approvedExitPlanToolUseId
        ? "resume-approved-exit"
        : "forbidden");

  pushHook(hooks, "PreToolUse", createWorkflowDenyPreToolHook(), "Workflow");
  pushHook(hooks, "PreToolUse", createImageReadPreToolHook(ctx.resolveSupportsImageInput), "Read");
  pushHook(
    hooks,
    "PreToolUse",
    createPlanModeBoundaryPreToolHook(planModeToolPolicy, ctx.approvedExitPlanToolUseId),
    "EnterPlanMode|ExitPlanMode|mcp__eco_plan__finalize_plan",
  );
  const exitPlanHookOptions = {
    ...(ctx.workspacePath ? { workspacePath: ctx.workspacePath } : {}),
    ...(ctx.getPhaseTranscript ? { getPhaseTranscript: ctx.getPhaseTranscript } : {}),
  };
  if (planModeToolPolicy === "user-approval" && ctx.awaitPlanApproval) {
    pushHook(
      hooks,
      "PermissionRequest",
      createExitPlanModeAwaitApprovalHook(
        ctx.awaitPlanApproval,
        ctx.onExitPlanMode,
        ctx.exitPlanCaptureState,
        exitPlanHookOptions,
      ),
      "ExitPlanMode",
    );
  }
  pushHook(hooks, "PreToolUse", createNormalizeSubagentPreToolHook(), "Agent|Task");
  pushHook(hooks, "PreToolUse", createForcedPlanDelegationPreToolHook(ctx.resolveForcedPlanDelegation));
  pushHook(
    hooks,
    "SubagentStart",
    createForcedPlanDelegationSubagentStartHook(ctx.resolveForcedPlanDelegation),
  );
  pushHook(
    hooks,
    "PostToolUse",
    createForcedPlanDelegationPostToolHook(ctx.resolveForcedPlanDelegation),
    "ExitPlanMode",
  );
  pushHook(
    hooks,
    "PreToolUse",
    createNonEcoSubagentDenyPreToolHook(ctx.allowedAgentKeys, ctx.allowedSdkBuiltinAgentKeys),
    "Agent|Task",
  );
  pushHook(hooks, "PreToolUse", createDisabledSubagentPreToolHook(availability), "Agent|Task");
  pushHook(hooks, "PreToolUse", createNestedSubagentDenyPreToolHook(), "Agent|Task");
  pushHook(
    hooks,
    "PreToolUse",
    createToolPermissionPreToolHook(ctx.toolPermissions, {
      ...(ctx.workspacePath && { workspacePath: ctx.workspacePath }),
      ...(ctx.implicitReadAllowRoots?.length ? { implicitReadAllowRoots: ctx.implicitReadAllowRoots } : {}),
      bashReviewMode: ctx.bashReviewMode ?? "always",
      ...(ctx.resolveBashReviewMode && { resolveBashReviewMode: ctx.resolveBashReviewMode }),
      ...(ctx.onToolPermissionDecision && { onDecision: ctx.onToolPermissionDecision }),
    }),
  );
  pushHook(hooks, "PreToolUse", createBrowserOpenApprovalPreToolHook(ctx.resolveBrowserOpenApprovalMode));
  pushHook(hooks, "PreToolUse", createWebSearchApprovalPreToolHook(ctx.resolveWebSearchApprovalMode));
  pushHook(hooks, "PreToolUse", createSubagentLaunchGatePreToolHook(ctx.subagentLaunchGate), "Agent|Task");
  const subagentLaunchRegistry =
    ctx.subagentLaunchRegistry ??
    (ctx.subagentSessions || ctx.taskTracker || ctx.subagentAttribution
      ? new SubagentLaunchRegistry()
      : undefined);

  if (ctx.subagentSessions) {
    const sessions = ctx.subagentSessions;
    pushHook(
      hooks,
      "PreToolUse",
      createSubagentResumePreToolHook(sessions.threadId, sessions.phase, sessions.resolveResume, {
        ...(sessions.todoIdHint && { todoIdHint: sessions.todoIdHint }),
      }),
      "Agent|Task",
    );
  }
  pushHook(hooks, "PreToolUse", createReviewerScopePreToolHook(ctx.resolveChangedFiles), "Agent|Task");
  if (subagentLaunchRegistry) {
    pushHook(
      hooks,
      "PreToolUse",
      createSubagentLaunchPreToolHook({
        registry: subagentLaunchRegistry,
        ...(ctx.subagentAttribution && { attribution: ctx.subagentAttribution }),
        ...(ctx.subagentSessions?.onAgentToolCapture && {
          onAgentToolCapture: ctx.subagentSessions.onAgentToolCapture,
        }),
      }),
      "Agent|Task",
    );
  } else {
    pushHook(
      hooks,
      "PreToolUse",
      createSubagentToolAttributionPreToolHook(ctx.subagentAttribution),
      "Agent|Task",
    );
  }

  const subagentHandlers = {
    ...(ctx.taskTracker && { taskTracker: ctx.taskTracker }),
    ...(ctx.subagentSessions && { subagentSessions: ctx.subagentSessions }),
    ...(subagentLaunchRegistry && { subagentLaunchRegistry }),
    ...(ctx.subagentAttribution && { attribution: ctx.subagentAttribution }),
    ...(ctx.subagentRuntimeLimit && { runtimeLimit: ctx.subagentRuntimeLimit }),
  };
  if (subagentHandlers.taskTracker || subagentHandlers.subagentSessions || subagentHandlers.runtimeLimit) {
    pushHook(hooks, "SubagentStart", createSubagentStartHook(subagentHandlers));
    pushHook(hooks, "SubagentStop", createSubagentStopHook(subagentHandlers));
  }

  if (ctx.taskTracker) {
    pushHook(
      hooks,
      "PreToolUse",
      createTaskToolPreToolHook(ctx.taskTracker),
      "TaskCreate|TaskUpdate|TodoWrite",
    );
    pushHook(hooks, "TaskCreated", createTaskCreatedHook(ctx.taskTracker, subagentLaunchRegistry));
    pushHook(hooks, "TaskCompleted", createTaskCompletedHook(ctx.taskTracker));
    pushHook(hooks, "Stop", createStopHook(ctx));
  }

  pushHook(hooks, "Notification", createNotificationHook(ctx.onNotification));
  pushHook(hooks, "PreCompact", createPreCompactHook(ctx.onPreCompact));
  pushHook(hooks, "PostToolUse", createToolOutputTruncationPostToolHook());

  return hooks;
}
