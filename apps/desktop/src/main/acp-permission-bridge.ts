import {
  type AcpPermissionHandler,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  acpPermissionCancelled,
  acpPermissionCommandPreview,
  acpPermissionFilesystemPath,
  acpPermissionIsExecute,
  acpPermissionToolName,
  resolveAcpPermissionAutoAllow,
  resolveAcpPermissionSelection,
  shouldHostAutoAllowAcpPermission,
} from "@eco/runtime";
import {
  type BrowserOpenApprovalMode,
  isEcoAgentBrowserToolName,
  requiresBrowserOpenApproval,
} from "../shared/browser";
import {
  type ComputerUseActionApprovalMode,
  ECO_COMPUTER_USE_ACTION_TOOLS,
  isEcoComputerUseToolName,
  requiresComputerUseActionApproval,
} from "../shared/computer-use";
import { isEcoWebSearchToolName, type WebSearchApprovalMode } from "../shared/integrated-web-search";
import type { BashApprovalDecision, BashApprovalRequest } from "../shared/ipc";
import { modelApprovalOutcome } from "./approval-model-outcome";
import type { BashApprovalResolution } from "./bash-approval-bridge";
import type { EcoApprovalReviewResult } from "./eco-approval-reviewer";
import type { ThreadToolConfirmationInput, ToolConfirmationDecision } from "./thread-bash-permission";

export type AcpPermissionBridgeEmitType =
  | "bash_approval.requested"
  | "bash_approval.approved"
  | "bash_approval.rejected"
  | "bash_approval.denied";

export interface AcpPermissionBridgeDeps {
  getBashReviewMode: () => string | undefined;
  /**
   * Built-in browser open approval (settings). When always_allow, eco browser MCP
   * tools skip auxiliary review / human park — same policy as Codex elicitation.
   */
  getBrowserOpenApprovalMode?: () => BrowserOpenApprovalMode;
  /**
   * Computer Use action approval (settings). When always_allow, eco computer-use
   * MCP tools skip auxiliary review / human park.
   */
  getComputerUseActionApprovalMode?: () => ComputerUseActionApprovalMode;
  /**
   * Web search approval (settings). When always_allow, eco web-search MCP tools
   * skip auxiliary review / human park — same policy as Codex elicitation.
   */
  getWebSearchApprovalMode?: () => WebSearchApprovalMode;
  getCwd: () => string;
  getWorkspacePath: () => string;
  getPlannerAgentId: () => string | undefined;
  getRememberPrefixes: () => readonly string[];
  evaluateConfirmation: (input: ThreadToolConfirmationInput) => ToolConfirmationDecision;
  reviewApproval?: (
    request: BashApprovalRequest,
    tool: { toolName: string; toolInput: Record<string, unknown> },
  ) => Promise<EcoApprovalReviewResult>;
  registerPending: (threadId: string, request: BashApprovalRequest) => Promise<BashApprovalResolution>;
  rememberPrefix: (threadId: string, command: string) => void;
  emit: (type: AcpPermissionBridgeEmitType, message: string, request: BashApprovalRequest) => void;
  log?: (phase: string, payload: Record<string, unknown>) => void;
}

/**
 * Whether ACP should auto-allow an eco_agent_browser tool without bash/aux review.
 * Mirrors Codex MCP elicitation: always_allow → all tools; always_ask → non-open only.
 */
export function shouldAutoAllowAcpEcoBrowserTool(input: {
  toolName: string;
  openApprovalMode: BrowserOpenApprovalMode;
}): boolean {
  if (!isEcoAgentBrowserToolName(input.toolName)) {
    return false;
  }
  if (input.openApprovalMode === "always_allow") {
    return true;
  }
  return !requiresBrowserOpenApproval(input.toolName);
}

/**
 * Whether ACP should auto-allow an eco_computer_use tool without bash/aux review.
 * Mirrors Codex: always_allow → all; always_ask → read tools only.
 */
export function shouldAutoAllowAcpEcoComputerUseTool(input: {
  toolName: string;
  actionApprovalMode: ComputerUseActionApprovalMode;
}): boolean {
  if (!isEcoComputerUseToolName(input.toolName)) {
    return false;
  }
  if (input.actionApprovalMode === "always_allow") {
    return true;
  }
  if (requiresComputerUseActionApproval(input.toolName)) {
    return false;
  }
  // ACP titles look like `eco_computer_use-click: click` (not mcp__…__leaf).
  const lower = input.toolName.trim().toLowerCase();
  for (const action of ECO_COMPUTER_USE_ACTION_TOOLS) {
    if (
      lower.includes(`__${action}`) ||
      lower.includes(`-${action}`) ||
      lower.includes(`_${action}`) ||
      lower.includes(`: ${action}`) ||
      lower.endsWith(`:${action}`)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether ACP should auto-allow an eco web-search tool without bash/aux review.
 * Mirrors Codex elicitation: always_allow → allow; always_ask → never auto-allow.
 */
export function shouldAutoAllowAcpEcoWebSearchTool(input: {
  toolName: string;
  approvalMode: WebSearchApprovalMode;
}): boolean {
  if (!isEcoWebSearchToolName(input.toolName)) {
    return false;
  }
  return input.approvalMode === "always_allow";
}

export function mapAcpPermissionToBashApprovalRequest(input: {
  threadId: string;
  request: AcpPermissionRequest;
  cwd: string;
  agentId: string;
  reason: string;
  riskScore?: number;
  riskLevel?: BashApprovalRequest["riskLevel"];
  description?: string;
}): BashApprovalRequest {
  const command = acpPermissionCommandPreview(input.request.toolCall);
  const filesystemPath = acpPermissionFilesystemPath(input.request.toolCall);
  const toolName = acpPermissionToolName(input.request.toolCall);
  const kind = acpPermissionBashKind(input.request);
  return {
    toolUseId: input.request.toolCall.toolCallId,
    threadId: input.threadId,
    command,
    cwd: input.cwd,
    reason: input.reason,
    riskScore: input.riskScore ?? 50,
    riskLevel: input.riskLevel ?? "medium",
    agentId: input.agentId,
    description: input.description ?? input.request.toolCall.title ?? toolName,
    kind,
    ...(filesystemPath && kind === "file_change" ? { filesystemTool: toolName, filesystemPath } : {}),
  };
}

export function acpPermissionBashKind(
  request: AcpPermissionRequest,
): NonNullable<BashApprovalRequest["kind"]> {
  const kind = request.toolCall.kind?.trim().toLowerCase() ?? "";
  const id = request.toolCall.toolCallId.toLowerCase();
  if (kind === "edit" || kind === "delete" || kind === "move") return "file_change";
  if (kind === "fetch" || id.includes("web_search") || (kind === "search" && id.includes("web"))) {
    return "network";
  }
  return "command";
}

export function mapBashResolutionToAcpPermission(
  request: AcpPermissionRequest,
  resolution: BashApprovalResolution,
): AcpPermissionOutcome {
  const granted =
    resolution.decision === "approved" ||
    resolution.decision === "approved_remember_prefix" ||
    resolution.decision === "approved_for_session";
  if (!granted) {
    return resolveAcpPermissionSelection(request.options, "reject") ?? acpPermissionCancelled();
  }
  return (
    resolveAcpPermissionSelection(
      request.options,
      "allow",
      resolution.decision === "approved_remember_prefix" || resolution.decision === "approved_for_session",
    ) ?? resolveAcpPermissionAutoAllow({ options: request.options, toolCall: request.toolCall })
  );
}

export function createAcpPermissionHandler(
  threadId: string,
  deps: AcpPermissionBridgeDeps,
): AcpPermissionHandler {
  return async (request) => {
    const bashReviewMode = deps.getBashReviewMode() ?? "always";
    const toolName = acpPermissionToolName(request.toolCall);
    const command = acpPermissionCommandPreview(request.toolCall);
    deps.log?.("acp-permission", {
      threadId,
      bashReviewMode,
      kind: request.toolCall.kind ?? null,
      toolName,
      toolCallId: request.toolCall.toolCallId,
    });
    if (shouldHostAutoAllowAcpPermission({ bashReviewMode, request })) {
      return resolveAcpPermissionAutoAllow({
        options: request.options,
        toolCall: request.toolCall,
      });
    }

    // Integration settings (browser / computer-use) outrank session bashReviewMode
    // for their own MCP tools — otherwise "始终允许" is ignored under Cursor ACP + 替我审批.
    const openApprovalMode = deps.getBrowserOpenApprovalMode?.() ?? "always_allow";
    if (shouldAutoAllowAcpEcoBrowserTool({ toolName, openApprovalMode })) {
      deps.log?.("acp-permission-browser-auto-allow", {
        threadId,
        toolName,
        openApprovalMode,
      });
      return resolveAcpPermissionAutoAllow({
        options: request.options,
        toolCall: request.toolCall,
      });
    }
    const computerUseActionMode = deps.getComputerUseActionApprovalMode?.() ?? "always_ask";
    if (
      shouldAutoAllowAcpEcoComputerUseTool({
        toolName,
        actionApprovalMode: computerUseActionMode,
      })
    ) {
      deps.log?.("acp-permission-computer-use-auto-allow", {
        threadId,
        toolName,
        actionApprovalMode: computerUseActionMode,
      });
      return resolveAcpPermissionAutoAllow({
        options: request.options,
        toolCall: request.toolCall,
      });
    }

    const webSearchApprovalMode = deps.getWebSearchApprovalMode?.() ?? "always_allow";
    if (shouldAutoAllowAcpEcoWebSearchTool({ toolName, approvalMode: webSearchApprovalMode })) {
      deps.log?.("acp-permission-web-search-auto-allow", {
        threadId,
        toolName,
        approvalMode: webSearchApprovalMode,
      });
      return resolveAcpPermissionAutoAllow({
        options: request.options,
        toolCall: request.toolCall,
      });
    }

    const agentId = deps.getPlannerAgentId()?.trim();
    if (!agentId) {
      deps.log?.("acp-permission-reject", {
        threadId,
        reason: "missing_planner_agent_id",
        toolName,
      });
      const rejected = resolveAcpPermissionSelection(request.options, "reject");
      if (rejected) return rejected;
      throw new Error("Eco could not attribute this ACP approval to a planner agent instance.");
    }

    const cwd = deps.getCwd();
    const workspacePath = deps.getWorkspacePath();
    const isExecute = acpPermissionIsExecute(request.toolCall);

    let reason = `Cursor ACP 请求确认 ${toolName}`;
    let riskScore: number | undefined;
    let riskLevel: BashApprovalRequest["riskLevel"] | undefined;
    let description: string | undefined;

    if (isExecute) {
      const confirmation = deps.evaluateConfirmation({
        command,
        cwd,
        workspacePath,
        confirmationMode: bashReviewMode as ThreadToolConfirmationInput["confirmationMode"],
        sessionBashRememberPrefixes: deps.getRememberPrefixes(),
      });
      if (confirmation.action === "deny") {
        const denied = mapAcpPermissionToBashApprovalRequest({
          threadId,
          request,
          cwd,
          agentId,
          reason: confirmation.reason,
          ...(confirmation.riskScore !== undefined ? { riskScore: confirmation.riskScore } : {}),
          ...(confirmation.riskLevel !== undefined ? { riskLevel: confirmation.riskLevel } : {}),
          description: confirmation.userMessage,
        });
        deps.emit("bash_approval.denied", `已拒绝：${confirmation.userMessage}`, denied);
        return resolveAcpPermissionSelection(request.options, "reject") ?? acpPermissionCancelled();
      }
      if (
        confirmation.action === "allow" &&
        (bashReviewMode !== "auto" || confirmation.matchedRule === "session_bash_prefix")
      ) {
        deps.log?.("acp-permission-policy-allow", {
          threadId,
          command,
          reason: confirmation.reason,
        });
        return resolveAcpPermissionAutoAllow({
          options: request.options,
          toolCall: request.toolCall,
        });
      }
      reason = confirmation.reason;
      riskScore = confirmation.riskScore;
      riskLevel = confirmation.riskLevel;
      description = confirmation.userMessage;
    }

    const approvalRequest = mapAcpPermissionToBashApprovalRequest({
      threadId,
      request,
      cwd,
      agentId,
      reason,
      ...(riskScore !== undefined ? { riskScore } : {}),
      ...(riskLevel !== undefined ? { riskLevel } : {}),
      ...(description !== undefined ? { description } : {}),
    });

    const reviewed = await applyAcpAuxiliaryReview({
      threadId,
      request,
      approvalRequest,
      bashReviewMode,
      toolName: isExecute ? "Bash" : toolName,
      command,
      toolInput: request.toolCall.rawInput ?? { command },
      deps,
    });
    if (reviewed.kind === "resolved") {
      return reviewed.outcome;
    }
    return parkAcpBashApproval(threadId, request, reviewed.approvalRequest, command, deps);
  };
}

async function applyAcpAuxiliaryReview(input: {
  threadId: string;
  request: AcpPermissionRequest;
  approvalRequest: BashApprovalRequest;
  bashReviewMode: string;
  toolName: string;
  command: string;
  toolInput: Record<string, unknown>;
  deps: AcpPermissionBridgeDeps;
}): Promise<
  { kind: "resolved"; outcome: AcpPermissionOutcome } | { kind: "park"; approvalRequest: BashApprovalRequest }
> {
  if (input.bashReviewMode !== "auto") {
    return { kind: "park", approvalRequest: input.approvalRequest };
  }
  if (!input.deps.reviewApproval) {
    input.deps.log?.("acp-permission-review-missing", {
      threadId: input.threadId,
      toolName: input.toolName,
      command: input.command,
    });
    return { kind: "park", approvalRequest: input.approvalRequest };
  }

  input.deps.log?.("acp-permission-review-start", {
    threadId: input.threadId,
    toolName: input.toolName,
    command: input.command,
  });
  const modelReview = await input.deps.reviewApproval(input.approvalRequest, {
    toolName: input.toolName,
    toolInput: input.toolInput,
  });
  const review = { ...modelReview, ...modelApprovalOutcome(modelReview) };
  const approvalRequest = { ...input.approvalRequest, reviewRationale: review.rationale };
  if (review.action === "allow") {
    input.deps.emit(
      "bash_approval.approved",
      `审批模型已允许 ${input.toolName}：${input.command}`,
      approvalRequest,
    );
    return {
      kind: "resolved",
      outcome: resolveAcpPermissionAutoAllow({
        options: input.request.options,
        toolCall: input.request.toolCall,
      }),
    };
  }
  return { kind: "park", approvalRequest };
}

async function parkAcpBashApproval(
  threadId: string,
  request: AcpPermissionRequest,
  approvalRequest: BashApprovalRequest,
  command: string,
  deps: AcpPermissionBridgeDeps,
): Promise<AcpPermissionOutcome> {
  deps.emit("bash_approval.requested", `等待确认 ${approvalRequest.description ?? command}`, approvalRequest);
  try {
    const resolution = await deps.registerPending(threadId, approvalRequest);
    if (resolution.decision === "approved_remember_prefix") {
      deps.rememberPrefix(threadId, command);
    }
    const granted = isGrantedDecision(resolution.decision);
    deps.emit(
      granted ? "bash_approval.approved" : "bash_approval.rejected",
      granted ? `已允许：${command}` : `已拒绝：${command}`,
      approvalRequest,
    );
    return mapBashResolutionToAcpPermission(request, resolution);
  } catch {
    return acpPermissionCancelled();
  }
}

function isGrantedDecision(decision: BashApprovalDecision): boolean {
  return (
    decision === "approved" || decision === "approved_remember_prefix" || decision === "approved_for_session"
  );
}
