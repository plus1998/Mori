import type { RuntimeAgentRole } from "../../shared/src";
import type { EcoRuntimeToolPermissionPolicy } from "./agent-orchestration.js";
import type { SubagentAvailability } from "./subagent-availability.js";
import type { SubagentLaunchRegistry } from "./subagent-launch-registry.js";
import type { SubagentResumeResolveInput } from "./subagent-resume.js";
import type { ExecutionConfirmationMode } from "./tool-confirmation.js";

export type PlanApprovalDecision = "approved" | "denied";

export interface SdkPlanSubmitRequest {
  plan: string;
  planFilePath?: string;
  allowedPrompts?: unknown;
  rawInput: Record<string, unknown>;
}

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

export interface EcoHookContext {
  resolveChangedFiles?: () => Promise<readonly string[]>;
  onPlanSubmitted?: (request: SdkPlanSubmitRequest & { toolUseId: string }) => void | Promise<void>;
  awaitPlanApproval?: (
    request: SdkPlanSubmitRequest & { toolUseId: string },
  ) => Promise<PlanApprovalDecision>;
  planCaptureState?: { capturedToolUseIds: Set<string> };
  approveDeferredPlanSubmit?: boolean;
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
  /** @deprecated 持久化字段名；语义为执行确认档位 */
  bashReviewMode?: ExecutionConfirmationMode;
  resolveBashReviewMode?: () => ExecutionConfirmationMode;
  /**
   * Built-in browser: whether agent_browser_open / tab_new must ask the user first.
   * When `always_ask`, PreToolUse returns ask so canUseTool shows the approval card
   * even under permissionMode bypassPermissions.
   */
  resolveBrowserOpenApprovalMode?: () => "always_allow" | "always_ask";
  /**
   * Web search: whether WebSearch / mori_web_search must ask the user first.
   * When `always_ask`, PreToolUse returns ask so canUseTool shows the approval card
   * even under permissionMode bypassPermissions.
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
