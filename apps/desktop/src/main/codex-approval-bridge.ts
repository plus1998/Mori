import { isDeepStrictEqual } from "node:util";
import {
  CODEX_JSON_RPC_INVALID_PARAMS,
  CODEX_JSON_RPC_METHOD_NOT_FOUND,
  CodexAppServerRequestError,
} from "@eco/runtime";
import {
  type BrowserOpenApprovalMode,
  isEcoAgentBrowserRuntimeServerName,
  requiresBrowserOpenApproval,
} from "../shared/browser";
import { CLARIFICATION_CUSTOM_OPTION_LABEL } from "../shared/clarification";
import {
  commandMatchesAnyRememberedBashPrefix,
  deriveBashApprovalRememberPrefix,
} from "../shared/bash-approval-ui";
import {
  type ComputerUseActionApprovalMode,
  isEcoComputerUseRuntimeServerName,
  requiresComputerUseActionApproval,
} from "../shared/computer-use";
import { ECO_HTML_HOST_MCP_SERVER, ECO_HTML_HOST_TOOL } from "../shared/html-host-tool";
import { ECO_IMAGE_DISPLAY_MCP_SERVER, ECO_IMAGE_DISPLAY_TOOL } from "../shared/image-display-tool";
import { ECO_IMAGE_GENERATION_MCP_SERVER, ECO_IMAGE_GENERATION_TOOL } from "../shared/image-generation";
import { ECO_IMAGE_VIEW_MCP_SERVER, ECO_IMAGE_VIEW_TOOL } from "../shared/image-view-tool";
import { ECO_WEB_SEARCH_MCP_SERVER, type WebSearchApprovalMode } from "../shared/integrated-web-search";
import type {
  BashApprovalRequest,
  ClarificationAnswers,
  ClarificationRequest,
  PlanApprovalRequest,
  ThreadLiveEvent,
} from "../shared/ipc";
import { presentMcpApproval } from "../shared/mcp-approval-presentation";
import { modelApprovalOutcome } from "./approval-model-outcome";
import {
  type BashApprovalResolution,
  cancelBashApprovalsForThread,
  getPendingBashApprovalForThread,
  registerPendingBashApproval,
  resolvePendingBashApproval,
} from "./bash-approval-bridge";
import {
  buildClarificationToolMetadata,
  cancelClarificationsForThread,
  formatClarificationAnswersSummary,
  registerPendingClarification,
} from "./clarification-bridge";
import { cancelPlanApprovalsForThread, registerPendingPlanApproval } from "./plan-approval-bridge";
import { applyThreadPlanReadyEffects, type ThreadPendingPlanWithRoutes } from "./thread-plan-ready-effects";

export const CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL = "item/commandExecution/requestApproval";
export const CODEX_FILE_CHANGE_REQUEST_APPROVAL = "item/fileChange/requestApproval";
export const CODEX_PERMISSIONS_REQUEST_APPROVAL = "item/permissions/requestApproval";
export const CODEX_TOOL_REQUEST_USER_INPUT = "item/tool/requestUserInput";
export const CODEX_MCP_SERVER_ELICITATION_REQUEST = "mcpServer/elicitation/request";

type PendingMcpToolCall = {
  codexThreadId: string;
  itemId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

/**
 * Codex currently sends MCP tool approval as an elicitation whose payload can
 * identify only the wrapper server. Keep the preceding item/started payload so
 * the approval card can show the actual Hub target and arguments.
 */
const pendingMcpToolCalls = new Map<string, PendingMcpToolCall[]>();
const pendingFileChanges = new Map<
  string,
  Array<{ itemId: string; ecoThreadId: string; changes: unknown[] }>
>();

/**
 * Detect Codex / MCP “Allow the X MCP server to run tool "Y"?” tool-run confirmations.
 * Returns full MCP tool name when recognized.
 */
export function parseMcpToolRunElicitationMessage(serverName: string, message: string): string | undefined {
  const match = message.match(/run tool\s+["']([^"']+)["']/i);
  if (!match?.[1]) {
    return undefined;
  }
  const tool = match[1].trim();
  if (!tool) {
    return undefined;
  }
  if (tool.startsWith("mcp__")) {
    return tool;
  }
  const server =
    serverName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-") || "mcp-server";
  return `mcp__${server}__${tool}`;
}

/**
 * Whether Eco should accept an eco_agent_browser tool-run elicitation without UI.
 * - always_allow: all eco browser tool-run confirms auto-accept
 * - always_ask: only non-open tools auto-accept (open / tab_new still ask)
 */
export function shouldAutoAcceptEcoBrowserToolElicitation(input: {
  serverName: string;
  message: string;
  openApprovalMode: BrowserOpenApprovalMode;
}): boolean {
  const server = input.serverName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  if (!isEcoAgentBrowserRuntimeServerName(server)) {
    return false;
  }
  const toolName = parseMcpToolRunElicitationMessage(input.serverName, input.message);
  if (!toolName) {
    return false;
  }
  if (input.openApprovalMode === "always_allow") {
    return true;
  }
  // always_ask: still auto-accept non-navigation tools
  return !requiresBrowserOpenApproval(toolName);
}

/**
 * Whether Eco should accept an eco_web_search tool-run elicitation without UI.
 * - always_allow: all eco web-search tool-run confirms auto-accept
 * - always_ask: never auto-accept (user confirms before each search)
 */
export function shouldAutoAcceptEcoWebSearchToolElicitation(input: {
  serverName: string;
  message: string;
  approvalMode: WebSearchApprovalMode;
}): boolean {
  const server = input.serverName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  if (server !== ECO_WEB_SEARCH_MCP_SERVER) {
    return false;
  }
  return input.approvalMode === "always_allow";
}

/**
 * Whether Eco should accept an eco_computer_use tool-run elicitation without UI.
 * - always_allow: all Computer Use tool-run confirms auto-accept
 * - always_ask: only read tools (list_apps / get_app_state) auto-accept
 */
export function shouldAutoAcceptEcoComputerUseToolElicitation(input: {
  serverName: string;
  message: string;
  actionApprovalMode: ComputerUseActionApprovalMode;
}): boolean {
  const server = input.serverName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  if (!isEcoComputerUseRuntimeServerName(server)) {
    return false;
  }
  const toolName = parseMcpToolRunElicitationMessage(input.serverName, input.message);
  if (!toolName) {
    return false;
  }
  if (input.actionApprovalMode === "always_allow") {
    return true;
  }
  return !requiresComputerUseActionApproval(toolName);
}

const LEGACY_TOOL_REQUEST_USER_INPUT = "tool/requestUserInput";
const IGNORED_CLARIFICATION_ANSWER = "忽略 — 请根据代码与常见做法推进，并在计划中写明假设";
const MCP_FORM_SKIP_LABEL = "不提供此字段";
const MCP_FORM_EMPTY_STRING_LABEL = "提交空字符串";
const MCP_FORM_EMPTY_LIST_LABEL = "提交空列表";

export interface CodexApprovalBridgeThread {
  prompt: string;
  workspacePath: string;
}

export interface CodexApprovalBridgeDeps {
  getMcpToolApprovalTarget?: (
    serverName: string,
    toolName: string,
  ) => import("../shared/mcp").McpToolApprovalTarget | undefined;
  isMcpToolApproved?: (target: import("../shared/mcp").McpToolApprovalTarget) => boolean;
  resolveEcoThreadId: (codexThreadId: string) => string;
  getThread: (ecoThreadId: string) => CodexApprovalBridgeThread | undefined;
  getWorktreePath: (ecoThreadId: string) => string | undefined;
  getPlannerAgentId: (ecoThreadId: string) => string | undefined;
  getRoutesJson: (ecoThreadId: string) => string;
  savePendingPlan: (plan: ThreadPendingPlanWithRoutes) => void;
  emitThreadLive: (event: ThreadLiveEvent) => void;
  updateThreadStatus: (ecoThreadId: string, patch: { status: string; message: string }) => void;
  getApprovalMode?: (ecoThreadId: string) => "always" | "auto" | "allow_all";
  getBashRememberPrefixes?: (ecoThreadId: string) => readonly string[];
  rememberBashPrefix?: (ecoThreadId: string, prefix: string) => void;
  /** Exact registered server owned by this thread; a matching prefix is not sufficient. */
  getMcpHubServerName?: (ecoThreadId: string) => string | undefined;
  /**
   * Built-in browser open approval (settings). Used to auto-accept Codex MCP
   * tool-run elicitations for eco_agent_browser when mode is always_allow.
   */
  getBrowserOpenApprovalMode?: () => BrowserOpenApprovalMode;
  /**
   * Computer Use action approval (settings). Used to auto-accept Codex MCP
   * tool-run elicitations for eco_computer_use when mode is always_allow.
   */
  getComputerUseActionApprovalMode?: () => ComputerUseActionApprovalMode;
  /**
   * Web search approval (settings). Used to auto-accept Codex MCP tool-run
   * elicitations for eco_web_search when mode is always_allow.
   */
  getWebSearchApprovalMode?: () => WebSearchApprovalMode;
  /**
   * Codex image MCP has no per-thread auth token. Register a claim when the
   * elicitation is accepted so create_image can bind to this Eco thread.
   */
  noteUpcomingImageGenerationTool?: (ecoThreadId: string, toolName: string, toolUseId?: string) => void;
  reviewApproval?: (
    ecoThreadId: string,
    request: BashApprovalRequest,
    tool: { toolName: string; toolInput: Record<string, unknown> },
  ) => Promise<{ action: "allow" | "human_required" | "deny"; rationale: string }>;
  /** Injects custom rejection feedback before the approval response resumes Codex. */
  injectCodexApprovalFeedback?: (input: {
    ecoThreadId: string;
    codexThreadId: string;
    turnId: string;
    toolUseId: string;
    text: string;
  }) => Promise<void>;
}

export interface CodexApprovalBridge {
  handleServerRequest(method: string, params: unknown): Promise<unknown>;
  handleNotification(method: string, params: unknown): void;
  cancelApprovalsForThread(threadId: string, reason: string): void;
}

export function createCodexApprovalBridge(deps: CodexApprovalBridgeDeps): CodexApprovalBridge {
  pendingMcpToolCalls.clear();
  pendingFileChanges.clear();
  return {
    handleServerRequest: (method, params) => handleCodexServerRequest(deps, method, params),
    handleNotification: (method, params) => handleCodexApprovalNotification(deps, method, params),
    cancelApprovalsForThread: (threadId, reason) => cancelCodexApprovalsForThread(threadId, reason),
  };
}

export async function handleCodexServerRequest(
  deps: CodexApprovalBridgeDeps,
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL:
      return handleCommandExecutionRequestApproval(deps, requireRequestParams(method, params));
    case CODEX_FILE_CHANGE_REQUEST_APPROVAL:
      return handleFileChangeRequestApproval(deps, requireRequestParams(method, params));
    case CODEX_PERMISSIONS_REQUEST_APPROVAL:
      return handlePermissionsRequestApproval(deps, requireRequestParams(method, params));
    case CODEX_TOOL_REQUEST_USER_INPUT:
    case LEGACY_TOOL_REQUEST_USER_INPUT:
      return handleToolRequestUserInput(deps, requireRequestParams(method, params));
    case CODEX_MCP_SERVER_ELICITATION_REQUEST:
      return handleMcpServerElicitationRequest(deps, requireRequestParams(method, params));
    default:
      throw new CodexAppServerRequestError(
        CODEX_JSON_RPC_METHOD_NOT_FOUND,
        `Eco does not implement Codex app-server request method ${method}.`,
      );
  }
}

export function handleCodexApprovalNotification(
  deps: CodexApprovalBridgeDeps,
  method: string,
  params: unknown,
): void {
  if (!isRecord(params)) {
    return;
  }
  if (method === "item/started") {
    rememberPendingMcpToolCall(params);
    const threadId = readString(params, "threadId");
    const item = isRecord(params.item) ? params.item : undefined;
    const itemId = item ? readString(item, "id") : undefined;
    if (threadId && itemId && item?.type === "fileChange" && Array.isArray(item.changes)) {
      const changes = item.changes;
      const entries = (pendingFileChanges.get(threadId) ?? []).filter((entry) => entry.itemId !== itemId);
      if (JSON.stringify(changes).length <= 64_000) {
        entries.push({ itemId, changes, ecoThreadId: deps.resolveEcoThreadId(threadId) });
        pendingFileChanges.set(threadId, entries.slice(-32));
      } else if (entries.length) pendingFileChanges.set(threadId, entries);
      else pendingFileChanges.delete(threadId);
    }
    return;
  }
  if (method !== "item/completed") {
    return;
  }
  forgetPendingMcpToolCall(params);
  const threadId = readString(params, "threadId");
  const itemId = isRecord(params.item) ? readString(params.item, "id") : undefined;
  if (threadId && itemId) {
    const entries = (pendingFileChanges.get(threadId) ?? []).filter((entry) => entry.itemId !== itemId);
    if (entries.length) pendingFileChanges.set(threadId, entries);
    else pendingFileChanges.delete(threadId);
  }
  handlePlanItemCompleted(deps, params);
}

export function cancelCodexApprovalsForThread(threadId: string, reason: string): void {
  for (const [codexThreadId, entries] of pendingFileChanges) {
    if (entries.some((entry) => entry.ecoThreadId === threadId) || codexThreadId === threadId)
      pendingFileChanges.delete(codexThreadId);
  }
  cancelClarificationsForThread(threadId, reason);
  cancelBashApprovalsForThread(threadId, reason);
  cancelPlanApprovalsForThread(threadId, reason);
}

async function handleCommandExecutionRequestApproval(
  deps: CodexApprovalBridgeDeps,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { ecoThreadId, itemId, codexThreadId, turnId } = validateApprovalRequestEnvelope(
    deps,
    CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL,
    params,
  );
  validateCommandExecutionRequestParams(params);
  const approvalId = readString(params, "approvalId") ?? itemId;

  const thread = deps.getThread(ecoThreadId);
  if (!thread) {
    return { decision: "decline" };
  }

  const command = resolveCommandExecutionLabel(params);
  const cwd = readString(params, "cwd") ?? deps.getWorktreePath(ecoThreadId) ?? thread.workspacePath;
  const reason = readString(params, "reason") ?? "Codex requires your approval before running this command.";
  const plannerAgentId = deps.getPlannerAgentId(ecoThreadId) ?? `${ecoThreadId}:main`;
  const isNetwork = Boolean(params.networkApprovalContext);
  const proposedExecpolicyAmendment = readStringArray(
    params.proposedExecpolicyAmendment ?? params.proposed_execpolicy_amendment,
  );
  const proposedNetworkPolicyAmendments = readNetworkPolicyAmendments(params);
  let approvalRequest: BashApprovalRequest = {
    toolUseId: approvalId,
    threadId: ecoThreadId,
    command,
    cwd,
    reason,
    riskScore: resolveCommandRiskScore(params),
    riskLevel: resolveCommandRiskLevel(params),
    agentId: plannerAgentId,
    description: reason,
    kind: isNetwork ? "network" : "command",
    ...(proposedExecpolicyAmendment.length > 0 ? { proposedExecpolicyAmendment } : {}),
    ...(proposedNetworkPolicyAmendments.length > 0 ? { proposedNetworkPolicyAmendments } : {}),
  };

  if (shouldHostAutoAllowCodexApproval(deps, ecoThreadId)) {
    return { decision: "accept" };
  }

  // An explicit user approval takes precedence over a later model review, just
  // as it does for the other runtimes. Network gates are separate permissions.
  const canRememberCommand = !isNetwork && Boolean(readString(params, "command"));
  if (
    canRememberCommand &&
    commandMatchesAnyRememberedBashPrefix(command, deps.getBashRememberPrefixes?.(ecoThreadId) ?? [])
  ) {
    return { decision: "accept" };
  }

  const automatic = await reviewCodexApprovalIfEnabled(deps, ecoThreadId, approvalRequest, {
    toolName: "Bash",
    toolInput: params,
  });
  if (automatic?.action === "allow") {
    emitAutomaticApproval(deps, { ...approvalRequest, reviewRationale: automatic.rationale }, command);
    return { decision: "accept" };
  }
  if (automatic?.action === "human_required") {
    approvalRequest = { ...approvalRequest, reviewRationale: automatic.rationale };
  }

  emitBashApprovalRequested(deps, approvalRequest, command);
  const resolution = await registerPendingBashApproval(ecoThreadId, approvalRequest);
  if (resolution.decision === "approved_remember_prefix") {
    if (!canRememberCommand || !deps.rememberBashPrefix) {
      throw new Error("This Codex request does not support remembering a command prefix.");
    }
    deps.rememberBashPrefix(ecoThreadId, deriveBashApprovalRememberPrefix(command));
    // Keep this an individual native grant. Eco owns the remembered prefix;
    // acceptForSession would grant broader access than the selected command.
    return { decision: "accept" };
  }
  await injectCodexApprovalFeedback(deps, {
    ecoThreadId,
    codexThreadId,
    turnId,
    toolUseId: approvalId,
    request: approvalRequest,
    ...(resolution.feedback !== undefined ? { feedback: resolution.feedback } : {}),
  });
  return mapBashResolutionToCodexCommandDecision(resolution, approvalRequest);
}

async function handleFileChangeRequestApproval(
  deps: CodexApprovalBridgeDeps,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { ecoThreadId, itemId, codexThreadId, turnId } = validateApprovalRequestEnvelope(
    deps,
    CODEX_FILE_CHANGE_REQUEST_APPROVAL,
    params,
  );
  validateNullableStringFields(CODEX_FILE_CHANGE_REQUEST_APPROVAL, params, ["grantRoot", "reason"]);

  const thread = deps.getThread(ecoThreadId);
  if (!thread) {
    return { decision: "decline" };
  }

  const grantRoot = readString(params, "grantRoot");
  const reason = readString(params, "reason") ?? "Codex requires your approval before applying file changes.";
  const filesystemPath = grantRoot ?? thread.workspacePath;
  const command = grantRoot ? `write under ${grantRoot}` : "apply file changes";
  const plannerAgentId = deps.getPlannerAgentId(ecoThreadId) ?? `${ecoThreadId}:main`;
  let approvalRequest: BashApprovalRequest = {
    toolUseId: itemId,
    threadId: ecoThreadId,
    command,
    cwd: deps.getWorktreePath(ecoThreadId) ?? thread.workspacePath,
    reason,
    riskScore: 55,
    riskLevel: "medium",
    agentId: plannerAgentId,
    kind: "file_change",
    filesystemTool: "FileChange",
    filesystemPath,
    description: reason,
  };

  if (shouldHostAutoAllowCodexApproval(deps, ecoThreadId)) {
    return { decision: "accept" };
  }

  const pendingChanges = pendingFileChanges
    .get(codexThreadId)
    ?.find((entry) => entry.itemId === itemId)?.changes;
  const automatic = await reviewCodexApprovalIfEnabled(deps, ecoThreadId, approvalRequest, {
    toolName: "FileChange",
    toolInput: {
      ...params,
      ...(pendingChanges ? { changes: pendingChanges } : {}),
    },
  });
  if (automatic?.action === "allow") {
    emitAutomaticApproval(deps, { ...approvalRequest, reviewRationale: automatic.rationale }, command);
    return { decision: "accept" };
  }
  if (automatic?.action === "human_required") {
    approvalRequest = { ...approvalRequest, reviewRationale: automatic.rationale };
  }

  emitBashApprovalRequested(deps, approvalRequest, command);
  const resolution = await registerPendingBashApproval(ecoThreadId, approvalRequest);
  await injectCodexApprovalFeedback(deps, {
    ecoThreadId,
    codexThreadId,
    turnId,
    toolUseId: itemId,
    request: approvalRequest,
    ...(resolution.feedback !== undefined ? { feedback: resolution.feedback } : {}),
  });
  return mapBashResolutionToCodexFileChangeDecision(resolution);
}

async function handlePermissionsRequestApproval(
  deps: CodexApprovalBridgeDeps,
  params: Record<string, unknown>,
): Promise<{ permissions: Record<string, unknown>; scope: "turn" | "session" }> {
  const denied = { permissions: {}, scope: "turn" as const };
  const { ecoThreadId, itemId, codexThreadId, turnId } = validateApprovalRequestEnvelope(
    deps,
    CODEX_PERMISSIONS_REQUEST_APPROVAL,
    params,
  );
  const cwd = requireNonEmptyRequestString(CODEX_PERMISSIONS_REQUEST_APPROVAL, params, "cwd");
  validateNullableStringFields(CODEX_PERMISSIONS_REQUEST_APPROVAL, params, ["environmentId", "reason"]);
  const requestedPermissions = normalizeRequestedPermissions(params.permissions);
  if (!requestedPermissions) {
    throw invalidServerRequestParams(
      CODEX_PERMISSIONS_REQUEST_APPROVAL,
      "permissions must match RequestPermissionProfile.",
    );
  }

  const thread = deps.getThread(ecoThreadId);
  if (!thread) {
    return denied;
  }

  const reason =
    readString(params, "reason") ??
    "Codex requires additional filesystem or network permissions for this turn.";
  const networkRequested = permissionRequestIncludesNetwork(requestedPermissions);
  let approvalRequest: BashApprovalRequest = {
    toolUseId: itemId,
    threadId: ecoThreadId,
    command: "grant additional permissions",
    cwd,
    reason,
    riskScore: networkRequested ? 75 : 65,
    riskLevel: "high",
    agentId: deps.getPlannerAgentId(ecoThreadId) ?? `${ecoThreadId}:main`,
    description: reason,
    kind: networkRequested ? "network" : "file_change",
    filesystemTool: "PermissionGrant",
    filesystemPath: formatRequestedPermissions(requestedPermissions),
  };

  if (shouldHostAutoAllowCodexApproval(deps, ecoThreadId)) {
    return { permissions: requestedPermissions, scope: "turn" };
  }

  const automatic = await reviewCodexApprovalIfEnabled(deps, ecoThreadId, approvalRequest, {
    toolName: "PermissionGrant",
    toolInput: params,
  });
  if (automatic?.action === "allow") {
    emitAutomaticApproval(
      deps,
      { ...approvalRequest, reviewRationale: automatic.rationale },
      "additional Codex permissions",
    );
    return { permissions: requestedPermissions, scope: "turn" };
  }
  if (automatic?.action === "human_required") {
    approvalRequest = { ...approvalRequest, reviewRationale: automatic.rationale };
  }

  emitBashApprovalRequested(deps, approvalRequest, "additional Codex permissions");
  const resolution = await registerPendingBashApproval(ecoThreadId, approvalRequest);
  await injectCodexApprovalFeedback(deps, {
    ecoThreadId,
    codexThreadId,
    turnId,
    toolUseId: itemId,
    request: approvalRequest,
    ...(resolution.feedback !== undefined ? { feedback: resolution.feedback } : {}),
  });
  if (resolution.decision === "approved") {
    return { permissions: requestedPermissions, scope: "turn" };
  }
  if (resolution.decision === "approved_for_session") {
    return { permissions: requestedPermissions, scope: "session" };
  }
  if (
    resolution.decision === "approved_execpolicy_amendment" ||
    resolution.decision === "approved_network_policy_amendment"
  ) {
    throw new Error(
      "Permission approvals cannot write Codex execpolicy/network rules; only turn or session grants are supported.",
    );
  }
  return denied;
}

async function handleMcpServerElicitationRequest(
  deps: CodexApprovalBridgeDeps,
  params: Record<string, unknown>,
): Promise<{ action: "accept" | "decline"; content?: Record<string, unknown> }> {
  const codexThreadId = requireNonEmptyRequestString(
    CODEX_MCP_SERVER_ELICITATION_REQUEST,
    params,
    "threadId",
  );
  const ecoThreadId = deps.resolveEcoThreadId(codexThreadId);
  const rawServerName = requireNonEmptyRequestString(
    CODEX_MCP_SERVER_ELICITATION_REQUEST,
    params,
    "serverName",
  );
  const mode = requireNonEmptyRequestString(CODEX_MCP_SERVER_ELICITATION_REQUEST, params, "mode");
  const rawMessage = requireRequestString(CODEX_MCP_SERVER_ELICITATION_REQUEST, params, "message");
  validateNullableStringFields(CODEX_MCP_SERVER_ELICITATION_REQUEST, params, ["turnId"]);
  const turnId = readString(params, "turnId");
  const rawToolName =
    mode === "form" ? parseMcpToolRunElicitationMessage(rawServerName, rawMessage) : undefined;
  if (
    mode === "form" &&
    deps.getThread(ecoThreadId) &&
    deps.getMcpHubServerName?.(ecoThreadId) === rawServerName &&
    rawToolName === parseMcpToolRunElicitationMessage(rawServerName, 'run tool "search_tools"')
  ) {
    return { action: "accept", content: {} };
  }
  const nestedHubCall =
    deps.getMcpHubServerName?.(ecoThreadId) === rawServerName &&
    rawToolName === parseMcpToolRunElicitationMessage(rawServerName, 'run tool "call_tool"')
      ? resolvePendingHubCall(codexThreadId, rawServerName, readString(params, "itemId"))
      : undefined;
  const serverName = nestedHubCall?.serverName ?? rawServerName;
  const message = nestedHubCall
    ? buildMcpToolApprovalMessage(nestedHubCall.serverName, nestedHubCall.toolName, nestedHubCall.arguments)
    : rawMessage;
  const parsedToolName = mode === "form" ? parseMcpToolRunElicitationMessage(serverName, message) : undefined;
  const approvalMode = deps.getApprovalMode?.(ecoThreadId) ?? "always";
  const mcpToolApproval = parsedToolName
    ? deps.getMcpToolApprovalTarget?.(serverName, parsedToolName)
    : undefined;
  if (mcpToolApproval && deps.getThread(ecoThreadId) && deps.isMcpToolApproved?.(mcpToolApproval)) {
    return { action: "accept", content: {} };
  }

  // MCP tool-run confirmations are a separate Codex request category from
  // command/file approvals. Route the global Eco approval modes through the
  // same bridge before applying integration-specific policies below.
  if (parsedToolName && (approvalMode === "allow_all" || approvalMode === "auto")) {
    const toolName = parsedToolName;
    const approvalItemId = readString(params, "itemId");
    const toolInput =
      nestedHubCall?.arguments ??
      resolveDirectMcpApprovalArguments({
        codexThreadId,
        serverName,
        toolName,
        message: rawMessage,
        ...(approvalItemId ? { itemId: approvalItemId } : {}),
      });
    const isImageGenerationTool =
      serverName.trim().toLowerCase() === ECO_IMAGE_GENERATION_MCP_SERVER &&
      toolName.endsWith(`__${ECO_IMAGE_GENERATION_TOOL}`);
    const toolUseId = createMcpElicitationToolUseId(serverName);
    const thread = deps.getThread(ecoThreadId);
    if (!thread) {
      return { action: "decline" };
    }
    let approvalRequest: BashApprovalRequest = {
      toolUseId,
      threadId: ecoThreadId,
      command: toolName,
      cwd: deps.getWorktreePath(ecoThreadId) ?? thread.workspacePath,
      reason: `Agent 请求调用 MCP 工具 ${serverName}/${toolName}。`,
      riskScore: 60,
      riskLevel: "medium",
      agentId: deps.getPlannerAgentId(ecoThreadId) ?? `${ecoThreadId}:main`,
      description: message.trim() || `调用 MCP 工具 ${serverName}/${toolName}`,
      kind: "mcp",
      ...(mcpToolApproval ? { mcpToolApproval } : {}),
      filesystemTool: "MCP",
      filesystemPath: `${serverName}/${toolName}`,
    };

    if (approvalMode === "allow_all") {
      if (isImageGenerationTool) {
        deps.noteUpcomingImageGenerationTool?.(ecoThreadId, ECO_IMAGE_GENERATION_TOOL, toolUseId);
      }
      return { action: "accept", content: {} };
    }

    const automatic = await reviewCodexApprovalIfEnabled(deps, ecoThreadId, approvalRequest, {
      toolName,
      toolInput,
    });
    if (automatic?.action === "allow") {
      if (isImageGenerationTool) {
        deps.noteUpcomingImageGenerationTool?.(ecoThreadId, ECO_IMAGE_GENERATION_TOOL, toolUseId);
      }
      emitAutomaticApproval(deps, { ...approvalRequest, reviewRationale: automatic.rationale }, toolName);
      return { action: "accept", content: {} };
    }
    if (automatic?.action === "human_required") {
      approvalRequest = { ...approvalRequest, reviewRationale: automatic.rationale };
    }

    emitBashApprovalRequested(deps, approvalRequest, `MCP ${serverName}/${toolName}`);
    const resolution = await registerPendingBashApproval(ecoThreadId, approvalRequest);
    if (resolution.feedback?.trim() && turnId && deps.injectCodexApprovalFeedback) {
      await deps.injectCodexApprovalFeedback({
        ecoThreadId,
        codexThreadId,
        turnId,
        toolUseId,
        text: ["MCP approval feedback:", resolution.feedback.trim()].join("\n"),
      });
    }
    if (
      resolution.decision === "approved" ||
      resolution.decision === "approved_for_session" ||
      resolution.decision === "approved_remember_mcp_tool"
    ) {
      return { action: "accept", content: {} };
    }
    return { action: "decline" };
  }

  const openApprovalMode = deps.getBrowserOpenApprovalMode?.() ?? "always_allow";
  const autoAccept = shouldAutoAcceptEcoBrowserToolElicitation({
    serverName,
    message,
    openApprovalMode,
  });
  if (autoAccept && mode === "form") {
    return { action: "accept", content: {} };
  }

  const computerUseActionMode = deps.getComputerUseActionApprovalMode?.() ?? "always_ask";
  const autoAcceptComputerUse = shouldAutoAcceptEcoComputerUseToolElicitation({
    serverName,
    message,
    actionApprovalMode: computerUseActionMode,
  });
  if (autoAcceptComputerUse && mode === "form") {
    return { action: "accept", content: {} };
  }

  const webSearchApprovalMode = deps.getWebSearchApprovalMode?.() ?? "always_allow";
  const autoAcceptWebSearch = shouldAutoAcceptEcoWebSearchToolElicitation({
    serverName,
    message,
    approvalMode: webSearchApprovalMode,
  });
  if (autoAcceptWebSearch && mode === "form") {
    return { action: "accept", content: {} };
  }

  if (
    mode === "form" &&
    serverName.trim().toLowerCase() === ECO_IMAGE_VIEW_MCP_SERVER &&
    parseMcpToolRunElicitationMessage(serverName, message)?.endsWith(`__${ECO_IMAGE_VIEW_TOOL}`)
  ) {
    return { action: "accept", content: {} };
  }

  if (
    mode === "form" &&
    serverName.trim().toLowerCase() === ECO_IMAGE_DISPLAY_MCP_SERVER &&
    parseMcpToolRunElicitationMessage(serverName, message)?.endsWith(`__${ECO_IMAGE_DISPLAY_TOOL}`)
  ) {
    return { action: "accept", content: {} };
  }

  if (
    mode === "form" &&
    serverName.trim().toLowerCase() === ECO_HTML_HOST_MCP_SERVER &&
    parseMcpToolRunElicitationMessage(serverName, message)?.endsWith(`__${ECO_HTML_HOST_TOOL}`)
  ) {
    return { action: "accept", content: {} };
  }

  // Generic external MCP tool-run confirmations still use Eco's approval
  // surface in the normal interactive mode. Built-in integrations above keep
  // their dedicated approval settings and clarification UX.
  const normalizedServerName = serverName.trim().toLowerCase();
  const isDedicatedEcoServer =
    isEcoAgentBrowserRuntimeServerName(normalizedServerName) ||
    isEcoComputerUseRuntimeServerName(normalizedServerName) ||
    normalizedServerName === ECO_WEB_SEARCH_MCP_SERVER ||
    normalizedServerName === ECO_IMAGE_VIEW_MCP_SERVER ||
    normalizedServerName === ECO_IMAGE_DISPLAY_MCP_SERVER ||
    normalizedServerName === ECO_HTML_HOST_MCP_SERVER ||
    normalizedServerName === ECO_IMAGE_GENERATION_MCP_SERVER;
  if (parsedToolName && !isDedicatedEcoServer) {
    const thread = deps.getThread(ecoThreadId);
    if (!thread) {
      return { action: "decline" };
    }
    const toolUseId = createMcpElicitationToolUseId(serverName);
    const approvalRequest: BashApprovalRequest = {
      toolUseId,
      threadId: ecoThreadId,
      command: parsedToolName,
      cwd: deps.getWorktreePath(ecoThreadId) ?? thread.workspacePath,
      reason: `Agent 请求调用 MCP 工具 ${serverName}/${parsedToolName}。`,
      riskScore: 60,
      riskLevel: "medium",
      agentId: deps.getPlannerAgentId(ecoThreadId) ?? `${ecoThreadId}:main`,
      description: message.trim() || `调用 MCP 工具 ${serverName}/${parsedToolName}`,
      kind: "mcp",
      ...(mcpToolApproval ? { mcpToolApproval } : {}),
      filesystemTool: "MCP",
      filesystemPath: `${serverName}/${parsedToolName}`,
    };
    emitBashApprovalRequested(deps, approvalRequest, `MCP ${serverName}/${parsedToolName}`);
    const resolution = await registerPendingBashApproval(ecoThreadId, approvalRequest);
    if (resolution.feedback?.trim() && turnId && deps.injectCodexApprovalFeedback) {
      await deps.injectCodexApprovalFeedback({
        ecoThreadId,
        codexThreadId,
        turnId,
        toolUseId,
        text: ["MCP approval feedback:", resolution.feedback.trim()].join("\n"),
      });
    }
    if (
      resolution.decision === "approved" ||
      resolution.decision === "approved_for_session" ||
      resolution.decision === "approved_remember_mcp_tool"
    ) {
      return { action: "accept", content: {} };
    }
    return { action: "decline" };
  }

  if (
    mode === "form" &&
    serverName.trim().toLowerCase() === ECO_IMAGE_GENERATION_MCP_SERVER &&
    parseMcpToolRunElicitationMessage(serverName, message)?.endsWith(`__${ECO_IMAGE_GENERATION_TOOL}`)
  ) {
    const thread = deps.getThread(ecoThreadId);
    if (!thread) {
      return { action: "decline" };
    }
    const toolUseId = createMcpElicitationToolUseId(serverName);
    const request: BashApprovalRequest = {
      toolUseId,
      threadId: ecoThreadId,
      command: "创建图片",
      cwd: deps.getWorktreePath(ecoThreadId) ?? thread.workspacePath,
      reason: "Agent 请求调用当前启用的创意绘画供应商。",
      riskScore: 50,
      riskLevel: "medium",
      agentId: deps.getPlannerAgentId(ecoThreadId) ?? `${ecoThreadId}:main`,
      description: message.trim() || "创建图片",
      kind: "image_generation",
    };
    emitBashApprovalRequested(deps, request, "创建图片");
    const resolution = await registerPendingBashApproval(ecoThreadId, request);
    if (resolution.feedback?.trim()) {
      if (!turnId) {
        throw invalidServerRequestParams(
          CODEX_MCP_SERVER_ELICITATION_REQUEST,
          "turnId is required when an approval rejection includes feedback.",
        );
      }
      await injectCodexApprovalFeedback(deps, {
        ecoThreadId,
        codexThreadId,
        turnId,
        toolUseId,
        request,
        feedback: resolution.feedback,
      });
    }
    if (resolution.decision !== "approved") {
      return { action: "decline" };
    }
    // Claim must be fresh at accept time: earlier tool.started claims expire in 60s,
    // and Codex image MCP has no ECO_IMAGE_AUTH_TOKEN (unlike Pi/Claude injection).
    deps.noteUpcomingImageGenerationTool?.(ecoThreadId, ECO_IMAGE_GENERATION_TOOL, toolUseId);
    return { action: "accept", content: {} };
  }

  if (mode === "url") {
    requireNonEmptyRequestString(CODEX_MCP_SERVER_ELICITATION_REQUEST, params, "elicitationId");
    requireNonEmptyRequestString(CODEX_MCP_SERVER_ELICITATION_REQUEST, params, "url");
    if (!deps.getThread(ecoThreadId)) {
      return { action: "decline" };
    }
    emitMcpElicitationDeclined(
      deps,
      ecoThreadId,
      `已拒绝 ${serverName} 的 URL 交互请求：Eco 尚未实现可验证的外部 URL 完成回调。`,
    );
    return { action: "decline" };
  }
  if (mode === "openai/form") {
    requireOwnRequestField(CODEX_MCP_SERVER_ELICITATION_REQUEST, params, "requestedSchema");
    if (!deps.getThread(ecoThreadId)) {
      return { action: "decline" };
    }
    emitMcpElicitationDeclined(
      deps,
      ecoThreadId,
      `已拒绝 ${serverName} 的 openai/form 请求：当前客户端未声明该 elicitation 能力。`,
    );
    return { action: "decline" };
  }
  if (mode !== "form") {
    throw invalidServerRequestParams(
      CODEX_MCP_SERVER_ELICITATION_REQUEST,
      `unsupported elicitation mode ${mode}.`,
    );
  }

  const toolUseId = createMcpElicitationToolUseId(serverName);
  let mapped: MappedMcpElicitationForm;
  try {
    mapped = mapMcpElicitationForm(ecoThreadId, toolUseId, serverName, message, params.requestedSchema);
  } catch (error) {
    if (deps.getThread(ecoThreadId)) {
      emitMcpElicitationMappingFailure(deps, ecoThreadId, serverName, error);
    }
    throw error;
  }

  if (!deps.getThread(ecoThreadId)) {
    return { action: "decline" };
  }

  deps.emitThreadLive({
    threadId: ecoThreadId,
    type: "clarification.requested",
    message: `${serverName} 请求结构化输入。`,
    role: "tool",
    clarification: mapped.request,
    tool: buildClarificationToolMetadata(toolUseId, "started"),
  });
  deps.updateThreadStatus(ecoThreadId, {
    status: "running",
    message: "",
  });

  const answers = await registerPendingClarification(ecoThreadId, toolUseId, {
    questions: mapped.request.questions,
  });
  if (isIgnoredClarification(answers)) {
    emitMcpElicitationDeclined(deps, ecoThreadId, `你已拒绝 ${serverName} 的 MCP 表单请求。`);
    return { action: "decline" };
  }

  try {
    const content = mapped.decode(answers);
    if (!content) {
      emitMcpElicitationDeclined(deps, ecoThreadId, `你已拒绝 ${serverName} 的 MCP 表单请求。`);
      return { action: "decline" };
    }
    deps.emitThreadLive({
      threadId: ecoThreadId,
      type: "clarification.answered",
      message: `${serverName} 的 MCP 表单已提交。`,
      role: "tool",
      tool: buildClarificationToolMetadata(toolUseId, "completed"),
    });
    return { action: "accept", content };
  } catch (error) {
    emitMcpElicitationMappingFailure(deps, ecoThreadId, serverName, error);
    throw error;
  }
}

/**
 * Answer a blocking `item/tool/requestUserInput` server request.
 *
 * This is the only question path that is a JSON-RPC server request: app-server awaits
 * the response and the model call cannot finish without it. Non-blocking questions in
 * Codex 0.160 arrive as `agentMessage` items with `delivery: "async"` instead — there
 * is no `requestUserInputAsync` method, and no answer is ever fabricated on a timer.
 *
 * `isBlocking` is a hint about whether the question holds the turn (upstream sends
 * `mode == Plan`), not about whether this RPC must be answered — it always must.
 */
async function handleToolRequestUserInput(
  deps: CodexApprovalBridgeDeps,
  params: Record<string, unknown>,
): Promise<unknown> {
  const codexThreadId = requireNonEmptyRequestString(CODEX_TOOL_REQUEST_USER_INPUT, params, "threadId");
  requireNonEmptyRequestString(CODEX_TOOL_REQUEST_USER_INPUT, params, "turnId");
  const itemId = requireNonEmptyRequestString(CODEX_TOOL_REQUEST_USER_INPUT, params, "itemId");
  const ecoThreadId = deps.resolveEcoThreadId(codexThreadId);
  const rawQuestions = validateToolRequestUserInputQuestions(params.questions);
  const isBlocking = validateIsBlocking(params.isBlocking);

  const mappedClarification = mapCodexToolQuestionsToClarification(ecoThreadId, itemId, rawQuestions);
  const clarificationRequest = {
    ...mappedClarification.request,
    delivery: "sync" as const,
  };
  deps.emitThreadLive({
    threadId: ecoThreadId,
    type: "clarification.requested",
    message: isBlocking ? "主代理需要你回答几个问题。" : "Codex 需要你回答几个问题（任务可继续）。",
    role: "main",
    clarification: clarificationRequest,
    tool: buildClarificationToolMetadata(itemId, "started"),
  });
  deps.updateThreadStatus(ecoThreadId, {
    status: "running",
    message: "",
  });

  const answers = await registerPendingClarification(ecoThreadId, itemId, {
    questions: mappedClarification.request.questions,
    delivery: "sync",
    blocking: isBlocking,
  });
  deps.updateThreadStatus(ecoThreadId, {
    status: "running",
    message: "",
  });
  deps.emitThreadLive({
    threadId: ecoThreadId,
    type: "clarification.answered",
    message: formatClarificationAnswersSummary(mappedClarification.request, answers),
    role: "main",
    tool: buildClarificationToolMetadata(itemId, "completed"),
  });
  return mapClarificationAnswersToCodexToolResponse(mappedClarification, answers);
}

function handlePlanItemCompleted(deps: CodexApprovalBridgeDeps, params: Record<string, unknown>): void {
  const item = isRecord(params.item) ? params.item : params;
  const itemType = readString(item, "type");
  if (itemType !== "plan") {
    return;
  }

  const ecoThreadId = resolveEcoThread(deps, params);
  const itemId = readString(params, "itemId");
  const planText = readString(item, "text");
  if (!ecoThreadId || !itemId || !planText) {
    return;
  }

  const thread = deps.getThread(ecoThreadId);
  if (!thread) {
    return;
  }

  const worktreePath = deps.getWorktreePath(ecoThreadId) ?? thread.workspacePath;
  const planFilePath = readString(item, "planFilePath") ?? readString(item, "path");
  const analysis = [
    "Codex plan mode produced this plan for Eco approval.",
    planFilePath ? `Plan file: ${planFilePath}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const planPayload = {
    userPrompt: thread.prompt,
    analysis,
    plan: planText,
    ...(planFilePath ? { planFilePath } : {}),
  };

  applyThreadPlanReadyEffects({
    threadId: ecoThreadId,
    payload: planPayload,
    workspacePath: thread.workspacePath,
    worktreePath,
    routesJson: deps.getRoutesJson(ecoThreadId),
    awaitingPlanMessage: "",
    effects: {
      savePendingPlan: deps.savePendingPlan,
      emitAwaitingPlan: (event) => {
        deps.emitThreadLive({
          threadId: event.threadId,
          type: "thread.awaiting_plan",
          message: event.message,
          role: "main",
          plan: event.plan,
        });
      },
    },
  });

  const approvalRequest: PlanApprovalRequest = {
    toolUseId: itemId,
    threadId: ecoThreadId,
    ...planPayload,
  };
  deps.updateThreadStatus(ecoThreadId, {
    status: "awaiting_plan",
    message: "",
  });
  deps.emitThreadLive({
    threadId: ecoThreadId,
    type: "plan_approval.requested",
    message: "计划已提交，等待你确认。",
    role: "main",
    plan: planPayload,
    planApproval: approvalRequest,
  });
  void registerPendingPlanApproval(ecoThreadId, approvalRequest).catch(() => {
    // Run cleanup or thread cancel may reject before the user resolves the panel.
  });
}

function requireRequestParams(method: string, params: unknown): Record<string, unknown> {
  if (!isRecord(params)) {
    throw invalidServerRequestParams(method, "params must be an object.");
  }
  return params;
}

function invalidServerRequestParams(method: string, detail: string): CodexAppServerRequestError {
  return new CodexAppServerRequestError(
    CODEX_JSON_RPC_INVALID_PARAMS,
    `Invalid params for ${method}: ${detail}`,
  );
}

function requireRequestString(method: string, params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") {
    throw invalidServerRequestParams(method, `${key} must be a string.`);
  }
  return value;
}

function requireNonEmptyRequestString(method: string, params: Record<string, unknown>, key: string): string {
  const value = requireRequestString(method, params, key).trim();
  if (!value) {
    throw invalidServerRequestParams(method, `${key} must be a non-empty string.`);
  }
  return value;
}

function requireOwnRequestField(method: string, params: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(params, key)) {
    throw invalidServerRequestParams(method, `${key} is required.`);
  }
  return params[key];
}

function validateNullableStringFields(
  method: string,
  params: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = params[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw invalidServerRequestParams(method, `${key} must be a string or null.`);
    }
  }
}

function validateApprovalRequestEnvelope(
  deps: CodexApprovalBridgeDeps,
  method: string,
  params: Record<string, unknown>,
): {
  ecoThreadId: string;
  itemId: string;
  codexThreadId: string;
  turnId: string;
} {
  const codexThreadId = requireNonEmptyRequestString(method, params, "threadId");
  const turnId = requireNonEmptyRequestString(method, params, "turnId");
  const itemId = requireNonEmptyRequestString(method, params, "itemId");
  const startedAtMs = params.startedAtMs;
  if (typeof startedAtMs !== "number" || !Number.isInteger(startedAtMs)) {
    throw invalidServerRequestParams(method, "startedAtMs must be an integer.");
  }
  return {
    ecoThreadId: deps.resolveEcoThreadId(codexThreadId),
    itemId,
    codexThreadId,
    turnId,
  };
}

function validateCommandExecutionRequestParams(params: Record<string, unknown>): void {
  const method = CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL;
  validateNullableStringFields(method, params, ["approvalId", "command", "cwd", "environmentId", "reason"]);
  if (typeof params.approvalId === "string" && !params.approvalId.trim()) {
    throw invalidServerRequestParams(method, "approvalId must be null or a non-empty string.");
  }
  validateCommandActions(params.commandActions);

  const networkContext = params.networkApprovalContext;
  if (networkContext !== undefined && networkContext !== null) {
    if (
      !isRecord(networkContext) ||
      typeof networkContext.host !== "string" ||
      !networkContext.host.trim() ||
      typeof networkContext.protocol !== "string" ||
      !["http", "https", "socks5Tcp", "socks5Udp"].includes(networkContext.protocol)
    ) {
      throw invalidServerRequestParams(method, "networkApprovalContext is invalid.");
    }
  }

  validateOptionalStringArray(
    method,
    params.proposedExecpolicyAmendment ?? params.proposed_execpolicy_amendment,
    "proposedExecpolicyAmendment",
  );
  const amendments = params.proposedNetworkPolicyAmendments ?? params.proposed_network_policy_amendments;
  if (amendments !== undefined && amendments !== null) {
    if (
      !Array.isArray(amendments) ||
      !amendments.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.host === "string" &&
          Boolean(entry.host.trim()) &&
          (entry.action === "allow" || entry.action === "deny"),
      )
    ) {
      throw invalidServerRequestParams(method, "proposedNetworkPolicyAmendments is invalid.");
    }
  }
}

function validateCommandActions(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value) || !value.every(isValidCommandAction)) {
    throw invalidServerRequestParams(CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL, "commandActions is invalid.");
  }
}

function isValidCommandAction(value: unknown): boolean {
  if (!isRecord(value) || typeof value.command !== "string") {
    return false;
  }
  if (value.type === "read") {
    return typeof value.name === "string" && typeof value.path === "string";
  }
  if (value.type === "listFiles") {
    return value.path === undefined || value.path === null || typeof value.path === "string";
  }
  if (value.type === "search") {
    return (
      (value.path === undefined || value.path === null || typeof value.path === "string") &&
      (value.query === undefined || value.query === null || typeof value.query === "string")
    );
  }
  return value.type === "unknown";
}

function validateOptionalStringArray(method: string, value: unknown, key: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw invalidServerRequestParams(method, `${key} must be a string array or null.`);
  }
}

/**
 * `isBlocking` gates whether the question holds the run. app-server always sends it,
 * and deserializes a missing value as `true` (`ToolRequestUserInputParams::deserialize`),
 * so an absent field must not be read as "non-blocking".
 */
function validateIsBlocking(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw invalidServerRequestParams(CODEX_TOOL_REQUEST_USER_INPUT, "isBlocking must be a boolean.");
  }
  return value;
}

function validateToolRequestUserInputQuestions(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidServerRequestParams(CODEX_TOOL_REQUEST_USER_INPUT, "questions must be a non-empty array.");
  }
  const questionIds = new Set<string>();
  return value.map((question, index) => {
    if (!isRecord(question)) {
      throw invalidServerRequestParams(
        CODEX_TOOL_REQUEST_USER_INPUT,
        `questions[${index}] must be an object.`,
      );
    }
    for (const key of ["id", "header", "question"] as const) {
      if (typeof question[key] !== "string" || !question[key].trim()) {
        throw invalidServerRequestParams(
          CODEX_TOOL_REQUEST_USER_INPUT,
          `questions[${index}].${key} must be a non-empty string.`,
        );
      }
    }
    const questionId = question.id as string;
    if (questionIds.has(questionId)) {
      throw invalidServerRequestParams(
        CODEX_TOOL_REQUEST_USER_INPUT,
        `questions[${index}].id duplicates ${questionId}.`,
      );
    }
    questionIds.add(questionId);
    for (const key of ["isOther", "isSecret"] as const) {
      if (question[key] !== undefined && typeof question[key] !== "boolean") {
        throw invalidServerRequestParams(
          CODEX_TOOL_REQUEST_USER_INPUT,
          `questions[${index}].${key} must be a boolean.`,
        );
      }
    }
    if (question.isSecret === true) {
      throw invalidServerRequestParams(
        CODEX_TOOL_REQUEST_USER_INPUT,
        `questions[${index}] requests secret input, which Eco cannot present without exposing it.`,
      );
    }
    // `options` is nullable in 0.160.1 (`Array<ToolRequestUserInputOption> | null`) and
    // may legitimately be empty: the question then only accepts free text, which Eco's
    // clarification panel already offers through its custom-answer row.
    if (question.options !== undefined && question.options !== null && !Array.isArray(question.options)) {
      throw invalidServerRequestParams(
        CODEX_TOOL_REQUEST_USER_INPUT,
        `questions[${index}].options must be an array or null.`,
      );
    }
    const optionLabels = new Set<string>();
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      if (
        !isRecord(option) ||
        typeof option.label !== "string" ||
        !option.label.trim() ||
        typeof option.description !== "string"
      ) {
        throw invalidServerRequestParams(
          CODEX_TOOL_REQUEST_USER_INPUT,
          `questions[${index}].options[${optionIndex}] is invalid.`,
        );
      }
      const optionLabel = option.label as string;
      if (optionLabels.has(optionLabel.trim())) {
        throw invalidServerRequestParams(
          CODEX_TOOL_REQUEST_USER_INPUT,
          `questions[${index}].options[${optionIndex}].label is ambiguous after trimming.`,
        );
      }
      optionLabels.add(optionLabel.trim());
    }
    return question;
  });
}

function normalizeRequestedPermissions(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["fileSystem", "network"])) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {};
  if ("fileSystem" in value) {
    if (value.fileSystem === null) {
      normalized.fileSystem = null;
    } else {
      const fileSystem = normalizeFileSystemPermissions(value.fileSystem);
      if (!fileSystem) {
        return undefined;
      }
      normalized.fileSystem = fileSystem;
    }
  }
  if ("network" in value) {
    if (value.network === null) {
      normalized.network = null;
    } else if (
      isRecord(value.network) &&
      hasOnlyKeys(value.network, ["enabled"]) &&
      (value.network.enabled === undefined ||
        value.network.enabled === null ||
        typeof value.network.enabled === "boolean")
    ) {
      normalized.network = {
        ...(value.network.enabled === undefined ? {} : { enabled: value.network.enabled }),
      };
    } else {
      return undefined;
    }
  }
  return normalized;
}

function normalizeFileSystemPermissions(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["entries", "globScanMaxDepth", "read", "write"])) {
    return undefined;
  }
  const normalized: Record<string, unknown> = {};
  if ("entries" in value) {
    if (value.entries === null) {
      normalized.entries = null;
    } else if (Array.isArray(value.entries)) {
      const entries = value.entries.map(normalizeFileSystemEntry);
      if (entries.some((entry) => entry === undefined)) {
        return undefined;
      }
      normalized.entries = entries;
    } else {
      return undefined;
    }
  }
  if ("globScanMaxDepth" in value) {
    if (
      value.globScanMaxDepth !== null &&
      (typeof value.globScanMaxDepth !== "number" ||
        !Number.isInteger(value.globScanMaxDepth) ||
        value.globScanMaxDepth < 1)
    ) {
      return undefined;
    }
    normalized.globScanMaxDepth = value.globScanMaxDepth;
  }
  for (const key of ["read", "write"] as const) {
    if (!(key in value)) {
      continue;
    }
    const paths = value[key];
    if (paths === null) {
      normalized[key] = null;
    } else if (Array.isArray(paths) && paths.every((entry) => typeof entry === "string")) {
      normalized[key] = [...paths];
    } else {
      return undefined;
    }
  }
  return normalized;
}

function normalizeFileSystemEntry(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["access", "path"])) {
    return undefined;
  }
  if (value.access !== "read" && value.access !== "write" && value.access !== "deny") {
    return undefined;
  }
  const normalizedPath = normalizeFileSystemPath(value.path);
  return normalizedPath ? { access: value.access, path: normalizedPath } : undefined;
}

function normalizeFileSystemPath(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.type === "path" && hasOnlyKeys(value, ["type", "path"]) && typeof value.path === "string") {
    return { type: "path", path: value.path };
  }
  if (
    value.type === "glob_pattern" &&
    hasOnlyKeys(value, ["type", "pattern"]) &&
    typeof value.pattern === "string"
  ) {
    return { type: "glob_pattern", pattern: value.pattern };
  }
  if (value.type !== "special" || !hasOnlyKeys(value, ["type", "value"]) || !isRecord(value.value)) {
    return undefined;
  }
  const special = value.value;
  const kind = special.kind;
  if (
    (kind === "root" || kind === "minimal" || kind === "tmpdir" || kind === "slash_tmp") &&
    hasOnlyKeys(special, ["kind"])
  ) {
    return { type: "special", value: { kind } };
  }
  if (
    kind === "project_roots" &&
    hasOnlyKeys(special, ["kind", "subpath"]) &&
    (special.subpath === undefined || special.subpath === null || typeof special.subpath === "string")
  ) {
    return {
      type: "special",
      value: { kind, ...(special.subpath === undefined ? {} : { subpath: special.subpath }) },
    };
  }
  if (
    kind === "unknown" &&
    hasOnlyKeys(special, ["kind", "path", "subpath"]) &&
    typeof special.path === "string" &&
    (special.subpath === undefined || special.subpath === null || typeof special.subpath === "string")
  ) {
    return {
      type: "special",
      value: {
        kind,
        path: special.path,
        ...(special.subpath === undefined ? {} : { subpath: special.subpath }),
      },
    };
  }
  return undefined;
}

function permissionRequestIncludesNetwork(permissions: Record<string, unknown>): boolean {
  return isRecord(permissions.network) && permissions.network.enabled === true;
}

function formatRequestedPermissions(permissions: Record<string, unknown>): string {
  return JSON.stringify(permissions, null, 2);
}

function emitMcpElicitationDeclined(deps: CodexApprovalBridgeDeps, threadId: string, message: string): void {
  deps.emitThreadLive({
    threadId,
    type: "thread.mcp_elicitation_declined",
    message,
    role: "tool",
  });
  deps.updateThreadStatus(threadId, { status: "running", message: "" });
}

function emitMcpElicitationMappingFailure(
  deps: CodexApprovalBridgeDeps,
  threadId: string,
  serverName: string,
  error: unknown,
): void {
  const detail = error instanceof Error ? error.message : String(error);
  const message = `${serverName} 的 MCP 表单无法无损呈现，已拒绝：${detail}`;
  deps.emitThreadLive({
    threadId,
    type: "thread.mcp_elicitation_failed",
    message,
    role: "tool",
  });
  deps.updateThreadStatus(threadId, { status: "running", message: "" });
}

let nextMcpElicitationId = 1;

function createMcpElicitationToolUseId(serverName: string): string {
  return `mcp_elicitation:${serverName}:${nextMcpElicitationId++}`;
}

function isIgnoredClarification(answers: ClarificationAnswers): boolean {
  return (
    (answers.customInputIndices?.length ?? 0) === 0 &&
    answers.selections.length > 0 &&
    answers.selections.every(
      (selection) => selection.length === 1 && selection[0] === IGNORED_CLARIFICATION_ANSWER,
    )
  );
}

const OMIT_MCP_FORM_VALUE = Symbol("omit-mcp-form-value");

interface MappedMcpElicitationField {
  key: string;
  question: ClarificationRequest["questions"][number];
  decode: (selection: readonly string[], fromCustomInput: boolean) => unknown | typeof OMIT_MCP_FORM_VALUE;
}

interface MappedMcpElicitationForm {
  request: ClarificationRequest;
  decode: (answers: ClarificationAnswers) => Record<string, unknown> | undefined;
}

function mapMcpElicitationForm(
  threadId: string,
  toolUseId: string,
  serverName: string,
  message: string,
  rawSchema: unknown,
): MappedMcpElicitationForm {
  if (
    !isRecord(rawSchema) ||
    rawSchema.type !== "object" ||
    !isRecord(rawSchema.properties) ||
    !hasOnlyKeys(rawSchema, ["$schema", "type", "properties", "required"])
  ) {
    throw invalidServerRequestParams(
      CODEX_MCP_SERVER_ELICITATION_REQUEST,
      "form requestedSchema must be a typed object schema.",
    );
  }
  if (
    rawSchema.$schema !== undefined &&
    rawSchema.$schema !== null &&
    typeof rawSchema.$schema !== "string"
  ) {
    throw invalidServerRequestParams(
      CODEX_MCP_SERVER_ELICITATION_REQUEST,
      "form requestedSchema.$schema must be a string or null.",
    );
  }

  const propertyEntries = Object.entries(rawSchema.properties);
  const required = normalizeRequiredPropertyNames(
    rawSchema.required,
    new Set(propertyEntries.map(([key]) => key)),
  );
  if (propertyEntries.length === 0) {
    const request: ClarificationRequest = {
      toolUseId,
      threadId,
      questions: [
        {
          header: serverName,
          question: message,
          allowCustom: false,
          options: [{ label: "同意并继续" }, { label: "拒绝" }],
        },
      ],
    };
    return {
      request,
      decode: (answers) => {
        const customInputIndices = normalizeCustomInputIndices(answers.customInputIndices, 1);
        if (customInputIndices.has(0)) {
          throw invalidMcpFormAnswer("confirmation", "does not allow custom input");
        }
        const selected = answers.selections[0] ?? [];
        if (selected.length === 1 && selected[0] === "拒绝") {
          return undefined;
        }
        if (selected.length !== 1 || selected[0] !== "同意并继续") {
          throw invalidMcpFormAnswer("confirmation", "must be accepted or declined");
        }
        return {};
      },
    };
  }

  const fields = propertyEntries.map(([key, schema]) =>
    mapMcpElicitationField(key, schema, required.has(key), message),
  );
  return {
    request: {
      toolUseId,
      threadId,
      questions: fields.map((field) => field.question),
    },
    decode: (answers) => {
      if (answers.selections.length !== fields.length) {
        throw invalidServerRequestParams(
          CODEX_MCP_SERVER_ELICITATION_REQUEST,
          `expected ${fields.length} form answers, received ${answers.selections.length}.`,
        );
      }
      const customInputIndices = normalizeCustomInputIndices(answers.customInputIndices, fields.length);
      const contentEntries: Array<[string, unknown]> = [];
      fields.forEach((field, index) => {
        const value = field.decode(answers.selections[index] ?? [], customInputIndices.has(index));
        if (value !== OMIT_MCP_FORM_VALUE) {
          contentEntries.push([field.key, value]);
        }
      });
      return Object.fromEntries(contentEntries);
    },
  };
}

function normalizeCustomInputIndices(value: unknown, questionCount: number): Set<number> {
  if (value === undefined) {
    return new Set();
  }
  if (
    !Array.isArray(value) ||
    !value.every((index) => Number.isInteger(index) && index >= 0 && index < questionCount) ||
    new Set(value).size !== value.length
  ) {
    throw invalidServerRequestParams(
      CODEX_MCP_SERVER_ELICITATION_REQUEST,
      "custom input provenance is invalid.",
    );
  }
  return new Set(value as number[]);
}

function normalizeRequiredPropertyNames(value: unknown, propertyNames: Set<string>): Set<string> {
  if (value === undefined || value === null) {
    return new Set();
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw invalidServerRequestParams(
      CODEX_MCP_SERVER_ELICITATION_REQUEST,
      "requestedSchema.required must be an array of property names.",
    );
  }
  const required = new Set(value);
  if (required.size !== value.length || [...required].some((key) => !propertyNames.has(key))) {
    throw invalidServerRequestParams(
      CODEX_MCP_SERVER_ELICITATION_REQUEST,
      "requestedSchema.required contains a duplicate or unknown property.",
    );
  }
  return required;
}

function mapMcpElicitationField(
  key: string,
  rawSchema: unknown,
  required: boolean,
  message: string,
): MappedMcpElicitationField {
  if (!isRecord(rawSchema)) {
    throw unsupportedMcpFormProperty(key, "schema must be an object");
  }
  for (const metadataKey of ["title", "description"] as const) {
    const value = rawSchema[metadataKey];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw unsupportedMcpFormProperty(key, `${metadataKey} must be a string`);
    }
  }
  const type = rawSchema.type;
  if (type === "string" && (hasOwnKey(rawSchema, "enum") || hasOwnKey(rawSchema, "oneOf"))) {
    return mapMcpSingleSelectField(key, rawSchema, required, message);
  }
  if (type === "array") {
    return mapMcpMultiSelectField(key, rawSchema, required, message);
  }
  if (type === "string") {
    return mapMcpStringField(key, rawSchema, required, message);
  }
  if (type === "boolean") {
    return mapMcpBooleanField(key, rawSchema, required, message);
  }
  if (type === "number" || type === "integer") {
    return mapMcpNumberField(key, rawSchema, required, message);
  }
  throw unsupportedMcpFormProperty(key, `unsupported type ${String(type)}`);
}

function mapMcpStringField(
  key: string,
  schema: Record<string, unknown>,
  required: boolean,
  message: string,
): MappedMcpElicitationField {
  assertMcpPropertyKeys(key, schema, [
    "type",
    "title",
    "description",
    "default",
    "format",
    "minLength",
    "maxLength",
  ]);
  if (schema.format !== undefined && schema.format !== null) {
    throw unsupportedMcpFormProperty(
      key,
      `string format ${String(schema.format)} is not losslessly validated`,
    );
  }
  const minLength = readOptionalNonNegativeInteger(schema.minLength, key, "minLength");
  const maxLength = readOptionalNonNegativeInteger(schema.maxLength, key, "maxLength");
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw unsupportedMcpFormProperty(key, "minLength exceeds maxLength");
  }
  const defaultValue = readOptionalDefault<string>(schema.default, "string", key);
  if (defaultValue !== undefined) {
    validateMcpString(key, defaultValue, minLength, maxLength);
  }
  const choices = createMcpChoices(required);
  if (defaultValue !== undefined) {
    choices.add(`使用默认值：${defaultValue}`, defaultValue, "MCP server 提供的默认值", true);
  }
  if ((minLength ?? 0) === 0) {
    choices.add(MCP_FORM_EMPTY_STRING_LABEL, "", "提交一个存在但内容为空的字符串");
  }
  choices.options.push({
    label: CLARIFICATION_CUSTOM_OPTION_LABEL,
    description: "输入该字段的文本值",
  });
  return {
    key,
    question: {
      ...buildMcpQuestion(key, schema, message, choices.options),
      preserveCustomText: true,
    },
    decode: (selection, fromCustomInput) => {
      if (fromCustomInput) {
        const value = requireSingleSelection(key, selection);
        validateMcpString(key, value, minLength, maxLength);
        return value;
      }
      const known = choices.decodeKnown(selection);
      if (known.matched) {
        return known.value;
      }
      const value = requireSingleSelection(key, selection);
      validateMcpString(key, value, minLength, maxLength);
      return value;
    },
  };
}

function mapMcpBooleanField(
  key: string,
  schema: Record<string, unknown>,
  required: boolean,
  message: string,
): MappedMcpElicitationField {
  assertMcpPropertyKeys(key, schema, ["type", "title", "description", "default"]);
  const defaultValue = readOptionalDefault<boolean>(schema.default, "boolean", key);
  const choices = createMcpChoices(required);
  choices.add("是 (true)", true, undefined, defaultValue === true);
  choices.add("否 (false)", false, undefined, defaultValue === false);
  return {
    key,
    question: {
      ...buildMcpQuestion(key, schema, message, choices.options),
      allowCustom: false,
    },
    decode: (selection, fromCustomInput) => {
      if (fromCustomInput) {
        throw invalidMcpFormAnswer(key, "does not allow custom input");
      }
      const known = choices.decodeKnown(selection);
      if (known.matched) {
        return known.value;
      }
      const raw = requireSingleSelection(key, selection).trim().toLowerCase();
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw invalidMcpFormAnswer(key, "must be true or false");
    },
  };
}

function mapMcpNumberField(
  key: string,
  schema: Record<string, unknown>,
  required: boolean,
  message: string,
): MappedMcpElicitationField {
  assertMcpPropertyKeys(key, schema, ["type", "title", "description", "default", "minimum", "maximum"]);
  const integer = schema.type === "integer";
  const minimum = readOptionalFiniteNumber(schema.minimum, key, "minimum");
  const maximum = readOptionalFiniteNumber(schema.maximum, key, "maximum");
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw unsupportedMcpFormProperty(key, "minimum exceeds maximum");
  }
  const defaultValue = readOptionalDefault<number>(schema.default, "number", key);
  if (defaultValue !== undefined) {
    validateMcpNumber(key, defaultValue, integer, minimum, maximum);
  }
  const choices = createMcpChoices(required);
  if (defaultValue !== undefined) {
    choices.add(`使用默认值：${defaultValue}`, defaultValue, "MCP server 提供的默认值", true);
  }
  choices.options.push({
    label: CLARIFICATION_CUSTOM_OPTION_LABEL,
    description: "输入该字段的数值",
  });
  return {
    key,
    question: buildMcpQuestion(key, schema, message, choices.options),
    decode: (selection, fromCustomInput) => {
      if (fromCustomInput) {
        const raw = requireSingleSelection(key, selection).trim();
        if (!raw) {
          throw invalidMcpFormAnswer(key, "must be a number");
        }
        const value = Number(raw);
        validateMcpNumber(key, value, integer, minimum, maximum);
        return value;
      }
      const known = choices.decodeKnown(selection);
      if (known.matched) {
        return known.value;
      }
      const raw = requireSingleSelection(key, selection).trim();
      if (!raw) {
        throw invalidMcpFormAnswer(key, "must be a number");
      }
      const value = Number(raw);
      validateMcpNumber(key, value, integer, minimum, maximum);
      return value;
    },
  };
}

function mapMcpSingleSelectField(
  key: string,
  schema: Record<string, unknown>,
  required: boolean,
  message: string,
): MappedMcpElicitationField {
  const hasEnum = hasOwnKey(schema, "enum");
  const hasOneOf = hasOwnKey(schema, "oneOf");
  if (hasEnum === hasOneOf) {
    throw unsupportedMcpFormProperty(key, "string enum requires exactly one of enum or oneOf");
  }
  assertMcpPropertyKeys(
    key,
    schema,
    hasOneOf
      ? ["type", "title", "description", "default", "oneOf"]
      : ["type", "title", "description", "default", "enum", "enumNames"],
  );
  const enumOptions = readMcpEnumOptions(key, schema);
  const defaultValue = readOptionalDefault<string>(schema.default, "string", key);
  if (defaultValue !== undefined && !enumOptions.some((option) => option.value === defaultValue)) {
    throw unsupportedMcpFormProperty(key, "default is not one of the enum values");
  }
  const choices = createMcpChoices(required);
  enumOptions.forEach((option) => {
    choices.add(option.label, option.value, undefined, option.value === defaultValue);
  });
  return {
    key,
    question: {
      ...buildMcpQuestion(key, schema, message, choices.options),
      allowCustom: false,
    },
    decode: (selection, fromCustomInput) => {
      if (fromCustomInput) {
        throw invalidMcpFormAnswer(key, "does not allow custom input");
      }
      const known = choices.decodeKnown(selection);
      if (known.matched) {
        return known.value;
      }
      const raw = requireSingleSelection(key, selection);
      if (enumOptions.some((option) => option.value === raw)) {
        return raw;
      }
      throw invalidMcpFormAnswer(key, "must be one of the advertised enum values");
    },
  };
}

function mapMcpMultiSelectField(
  key: string,
  schema: Record<string, unknown>,
  required: boolean,
  message: string,
): MappedMcpElicitationField {
  assertMcpPropertyKeys(key, schema, [
    "type",
    "title",
    "description",
    "default",
    "items",
    "minItems",
    "maxItems",
  ]);
  if (!isRecord(schema.items)) {
    throw unsupportedMcpFormProperty(key, "array items must be an enum schema");
  }
  const hasEnum = hasOwnKey(schema.items, "enum");
  const hasAnyOf = hasOwnKey(schema.items, "anyOf");
  if (hasEnum === hasAnyOf) {
    throw unsupportedMcpFormProperty(key, "array items require exactly one of enum or anyOf");
  }
  if (hasAnyOf) {
    assertMcpPropertyKeys(key, schema.items, ["anyOf"]);
  } else {
    assertMcpPropertyKeys(key, schema.items, ["type", "enum"]);
    if (schema.items.type !== "string") {
      throw unsupportedMcpFormProperty(key, "untitled array enum items require type string");
    }
  }
  const enumOptions = readMcpEnumOptions(key, schema.items);
  const minItems = readOptionalNonNegativeInteger(schema.minItems, key, "minItems") ?? 0;
  const maxItems = readOptionalNonNegativeInteger(schema.maxItems, key, "maxItems");
  if (maxItems !== undefined && minItems > maxItems) {
    throw unsupportedMcpFormProperty(key, "minItems exceeds maxItems");
  }
  const defaultValues = readOptionalStringArrayDefault(schema.default, key);
  if (defaultValues?.some((value) => !enumOptions.some((option) => option.value === value))) {
    throw unsupportedMcpFormProperty(key, "default contains a value outside the enum");
  }
  if (
    defaultValues &&
    (defaultValues.length < minItems || (maxItems !== undefined && defaultValues.length > maxItems))
  ) {
    throw unsupportedMcpFormProperty(key, "default does not satisfy minItems/maxItems");
  }
  const choices = createMcpChoices(required);
  enumOptions.forEach((option) => {
    choices.add(option.label, option.value);
  });
  if (minItems === 0) {
    choices.add(MCP_FORM_EMPTY_LIST_LABEL, []);
  }
  if (defaultValues !== undefined) {
    choices.add(`使用默认列表：${defaultValues.join(", ") || "（空）"}`, defaultValues, undefined, true);
  }
  return {
    key,
    question: {
      ...buildMcpQuestion(key, schema, message, choices.options),
      multiSelect: true,
      allowCustom: false,
    },
    decode: (selection, fromCustomInput) => {
      if (fromCustomInput) {
        throw invalidMcpFormAnswer(key, "does not allow custom input");
      }
      if (selection.length === 1) {
        const known = choices.decodeKnown(selection);
        if (known.matched && (known.value === OMIT_MCP_FORM_VALUE || Array.isArray(known.value))) {
          return known.value;
        }
      }
      const values: string[] = [];
      for (const selected of selection) {
        const known = choices.decodeLabel(selected);
        if (known.matched) {
          if (known.value === OMIT_MCP_FORM_VALUE || Array.isArray(known.value)) {
            throw invalidMcpFormAnswer(
              key,
              "skip/default/empty choices cannot be combined with other values",
            );
          }
          values.push(String(known.value));
        } else if (enumOptions.some((option) => option.value === selected)) {
          values.push(selected);
        } else {
          throw invalidMcpFormAnswer(key, `unknown enum value ${selected}`);
        }
      }
      const uniqueValues = [...new Set(values)];
      if (uniqueValues.length < minItems) {
        throw invalidMcpFormAnswer(key, `must select at least ${minItems} values`);
      }
      if (maxItems !== undefined && uniqueValues.length > maxItems) {
        throw invalidMcpFormAnswer(key, `must select at most ${maxItems} values`);
      }
      return uniqueValues;
    },
  };
}

interface McpChoiceLookup {
  options: ClarificationRequest["questions"][number]["options"];
  add: (label: string, value: unknown, description?: string, recommended?: boolean) => void;
  decodeKnown: (selection: readonly string[]) => { matched: boolean; value?: unknown };
  decodeLabel: (label: string) => { matched: boolean; value?: unknown };
}

function createMcpChoices(required: boolean): McpChoiceLookup {
  const options: McpChoiceLookup["options"] = [];
  const values = new Map<string, unknown>();
  const add = (baseLabel: string, value: unknown, description?: string, recommended?: boolean) => {
    let label = baseLabel;
    let suffix = 2;
    while (values.has(label)) {
      label = `${baseLabel} (${suffix++})`;
    }
    values.set(label, value);
    options.push({
      label,
      ...(description ? { description } : {}),
      ...(recommended ? { recommended: true } : {}),
    });
  };
  if (!required) {
    add(MCP_FORM_SKIP_LABEL, OMIT_MCP_FORM_VALUE, "不在提交内容中包含该可选字段");
  }
  return {
    options,
    add,
    decodeKnown: (selection) => {
      if (selection.length !== 1) return { matched: false };
      const selected = selection[0];
      if (selected === undefined) return { matched: false };
      return values.has(selected) ? { matched: true, value: values.get(selected) } : { matched: false };
    },
    decodeLabel: (label) =>
      values.has(label) ? { matched: true, value: values.get(label) } : { matched: false },
  };
}

function buildMcpQuestion(
  key: string,
  schema: Record<string, unknown>,
  message: string,
  options: ClarificationRequest["questions"][number]["options"],
): ClarificationRequest["questions"][number] {
  const description = readString(schema, "description");
  return {
    header: readString(schema, "title") ?? key,
    question: description ? `${message}\n${description}` : message,
    options,
  };
}

function readMcpEnumOptions(
  key: string,
  schema: Record<string, unknown>,
): Array<{ label: string; value: string }> {
  let options: Array<{ label: string; value: string }>;
  const titledOptions = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (titledOptions) {
    options = titledOptions.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasOnlyKeys(entry, ["const", "title"]) ||
        typeof entry.const !== "string" ||
        typeof entry.title !== "string"
      ) {
        throw unsupportedMcpFormProperty(key, "oneOf/anyOf entries require string const and title");
      }
      return { label: entry.title, value: entry.const };
    });
  } else if (Array.isArray(schema.enum) && schema.enum.every((entry) => typeof entry === "string")) {
    const names = schema.enumNames;
    if (
      names !== undefined &&
      names !== null &&
      (!Array.isArray(names) ||
        names.length !== schema.enum.length ||
        !names.every((entry) => typeof entry === "string"))
    ) {
      throw unsupportedMcpFormProperty(key, "enumNames must match enum length");
    }
    options = schema.enum.map((value, index) => ({
      value,
      label: Array.isArray(names) ? String(names[index]) : value,
    }));
  } else {
    throw unsupportedMcpFormProperty(key, "enum schema requires enum, oneOf, or anyOf string values");
  }
  if (options.length === 0 || new Set(options.map((option) => option.value)).size !== options.length) {
    throw unsupportedMcpFormProperty(key, "enum values must be non-empty and unique");
  }
  return options;
}

function assertMcpPropertyKeys(
  key: string,
  schema: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (!hasOnlyKeys(schema, allowed)) {
    const unsupported = Object.keys(schema).filter((entry) => !allowed.includes(entry));
    throw unsupportedMcpFormProperty(key, `unsupported schema keywords: ${unsupported.join(", ")}`);
  }
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function readOptionalDefault<T>(
  value: unknown,
  expectedType: "string" | "boolean" | "number",
  key: string,
): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    typeof value !== expectedType ||
    (expectedType === "number" && (typeof value !== "number" || !Number.isFinite(value)))
  ) {
    throw unsupportedMcpFormProperty(key, `default must be a ${expectedType}`);
  }
  return value as T;
}

function readOptionalStringArrayDefault(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw unsupportedMcpFormProperty(key, "default must be a string array");
  }
  return [...value];
}

function readOptionalNonNegativeInteger(value: unknown, key: string, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw unsupportedMcpFormProperty(key, `${name} must be a non-negative integer`);
  }
  return Number(value);
}

function readOptionalFiniteNumber(value: unknown, key: string, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw unsupportedMcpFormProperty(key, `${name} must be a finite number`);
  }
  return value;
}

function requireSingleSelection(key: string, selection: readonly string[]): string {
  if (selection.length !== 1 || !selection[0]) {
    throw invalidMcpFormAnswer(key, "requires exactly one answer");
  }
  return selection[0];
}

function validateMcpNumber(
  key: string,
  value: number,
  integer: boolean,
  minimum: number | undefined,
  maximum: number | undefined,
): void {
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw invalidMcpFormAnswer(key, integer ? "must be an integer" : "must be a finite number");
  }
  if (minimum !== undefined && value < minimum) {
    throw invalidMcpFormAnswer(key, `must be at least ${minimum}`);
  }
  if (maximum !== undefined && value > maximum) {
    throw invalidMcpFormAnswer(key, `must be at most ${maximum}`);
  }
}

function validateMcpString(
  key: string,
  value: string,
  minLength: number | undefined,
  maxLength: number | undefined,
): void {
  const length = [...value].length;
  if (minLength !== undefined && length < minLength) {
    throw invalidMcpFormAnswer(key, `must contain at least ${minLength} characters`);
  }
  if (maxLength !== undefined && length > maxLength) {
    throw invalidMcpFormAnswer(key, `must contain at most ${maxLength} characters`);
  }
}

function unsupportedMcpFormProperty(key: string, detail: string): CodexAppServerRequestError {
  return invalidServerRequestParams(
    CODEX_MCP_SERVER_ELICITATION_REQUEST,
    `property ${key} cannot be represented losslessly: ${detail}.`,
  );
}

function invalidMcpFormAnswer(key: string, detail: string): CodexAppServerRequestError {
  return invalidServerRequestParams(
    CODEX_MCP_SERVER_ELICITATION_REQUEST,
    `answer for property ${key} ${detail}.`,
  );
}

function emitBashApprovalRequested(
  deps: CodexApprovalBridgeDeps,
  request: BashApprovalRequest,
  commandLabel: string,
): void {
  const presentation = presentMcpApproval(request);
  deps.emitThreadLive({
    threadId: request.threadId,
    type: "bash_approval.requested",
    message: `等待确认：${request.kind === "mcp" ? presentation.description : commandLabel}`,
    role: "tool",
    bashApproval: presentation,
  });
  deps.updateThreadStatus(request.threadId, {
    status: "running",
    message: "",
  });
}

/** Eco「完全访问」: host auto-allows Codex requestApproval without parking (mid-run simulation). */
function shouldHostAutoAllowCodexApproval(deps: CodexApprovalBridgeDeps, threadId: string): boolean {
  return deps.getApprovalMode?.(threadId) === "allow_all";
}

async function reviewCodexApprovalIfEnabled(
  deps: CodexApprovalBridgeDeps,
  threadId: string,
  request: BashApprovalRequest,
  tool: { toolName: string; toolInput: Record<string, unknown> },
): Promise<{ action: "allow" | "human_required" | "deny"; rationale: string } | undefined> {
  if (deps.getApprovalMode?.(threadId) !== "auto" || !deps.reviewApproval) {
    return undefined;
  }
  const review = await deps.reviewApproval(threadId, request, tool);
  return modelApprovalOutcome(review);
}

function emitAutomaticApproval(
  deps: CodexApprovalBridgeDeps,
  request: BashApprovalRequest,
  commandLabel: string,
): void {
  deps.emitThreadLive({
    threadId: request.threadId,
    type: "bash_approval.approved",
    message: `审批模型已允许：${commandLabel}`,
    role: "tool",
    bashApproval: request,
  });
}

function resolveEcoThread(
  deps: CodexApprovalBridgeDeps,
  params: Record<string, unknown>,
): string | undefined {
  const codexThreadId = readString(params, "threadId");
  if (!codexThreadId) {
    return undefined;
  }
  return deps.resolveEcoThreadId(codexThreadId);
}

function resolveCommandExecutionLabel(params: Record<string, unknown>): string {
  const command = readString(params, "command");
  if (command) {
    return command;
  }
  const networkContext = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : undefined;
  const host = networkContext ? readString(networkContext, "host") : undefined;
  if (host) {
    return `network access: ${host}`;
  }
  return "shell command";
}

function resolveCommandRiskScore(params: Record<string, unknown>): number {
  if (params.networkApprovalContext) {
    return 65;
  }
  return 40;
}

function resolveCommandRiskLevel(params: Record<string, unknown>): BashApprovalRequest["riskLevel"] {
  if (params.networkApprovalContext) {
    return "high";
  }
  return "medium";
}

/**
 * Codex v2 approval responses only carry decision tags. Queue custom feedback as pending
 * user input before returning decline so the model sees it at the same turn boundary.
 */
async function injectCodexApprovalFeedback(
  deps: CodexApprovalBridgeDeps,
  input: {
    ecoThreadId: string;
    codexThreadId: string;
    turnId: string;
    toolUseId: string;
    request: BashApprovalRequest;
    feedback?: string;
  },
): Promise<void> {
  const feedback = input.feedback?.trim();
  if (!feedback) {
    return;
  }
  if (!deps.injectCodexApprovalFeedback) {
    throw new Error(
      "Codex approval feedback cannot be delivered because the active turn has no steer bridge.",
    );
  }

  const toolLabel =
    input.request.filesystemTool ?? (input.request.kind === "image_generation" ? "image generation" : "Bash");
  await deps.injectCodexApprovalFeedback({
    ecoThreadId: input.ecoThreadId,
    codexThreadId: input.codexThreadId,
    turnId: input.turnId,
    toolUseId: input.toolUseId,
    text: [
      `The user rejected the preceding ${toolLabel} approval.`,
      `User feedback: ${feedback}`,
      "Do not retry the rejected request unless the user explicitly asks for it again.",
    ].join("\n"),
  });
}

/**
 * Map Eco UI decision → Codex `CommandExecutionApprovalDecision`.
 * Persistent "remember" must use `acceptWithExecpolicyAmendment` when Codex proposed a rule.
 * Never invent Eco-side prefix memory.
 */
function mapBashResolutionToCodexCommandDecision(
  resolution: BashApprovalResolution,
  request: BashApprovalRequest,
): unknown {
  if (resolution.decision === "approved") {
    return { decision: "accept" };
  }
  if (resolution.decision === "approved_for_session") {
    return { decision: "acceptForSession" };
  }
  if (resolution.decision === "approved_execpolicy_amendment") {
    const amendment = request.proposedExecpolicyAmendment;
    if (!amendment || amendment.length === 0) {
      throw new Error(
        "Codex did not propose an execpolicy amendment; cannot write a persistent rule. Use accept or acceptForSession only when offered.",
      );
    }
    if (amendment.some((token) => token.includes("\n") || token.includes("\r"))) {
      throw new Error(
        "Codex refused multiline execpolicy prefixes; persistent rule is unavailable for this command.",
      );
    }
    // The decision tag is camelCase, but 0.142.5 keeps the nested amendment field snake_case.
    return {
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: amendment,
        },
      },
    };
  }
  if (resolution.decision === "approved_network_policy_amendment") {
    const allow = request.proposedNetworkPolicyAmendments?.find((entry) => entry.action === "allow");
    if (!allow) {
      throw new Error(
        "Codex did not propose a network policy allow amendment; cannot write a persistent network rule.",
      );
    }
    return {
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { host: allow.host, action: "allow" },
        },
      },
    };
  }
  if (resolution.decision === "cancelled") {
    return { decision: "cancel" };
  }
  return { decision: "decline" };
}

function mapBashResolutionToCodexFileChangeDecision(resolution: BashApprovalResolution): unknown {
  // FileChangeApprovalDecision: accept | acceptForSession | decline | cancel — no persistent rule.
  if (resolution.decision === "approved") {
    return { decision: "accept" };
  }
  if (resolution.decision === "approved_for_session") {
    return { decision: "acceptForSession" };
  }
  if (
    resolution.decision === "approved_execpolicy_amendment" ||
    resolution.decision === "approved_network_policy_amendment"
  ) {
    throw new Error(
      "File change approvals cannot write Codex execpolicy/network rules; only accept / acceptForSession are supported.",
    );
  }
  if (resolution.decision === "cancelled") {
    return { decision: "cancel" };
  }
  return { decision: "decline" };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...(value as string[])];
}

function readNetworkPolicyAmendments(
  params: Record<string, unknown>,
): NonNullable<BashApprovalRequest["proposedNetworkPolicyAmendments"]> {
  const raw = params.proposedNetworkPolicyAmendments ?? params.proposed_network_policy_amendments;
  if (!Array.isArray(raw)) {
    return [];
  }
  const amendments: NonNullable<BashApprovalRequest["proposedNetworkPolicyAmendments"]> = [];
  for (const entry of raw) {
    const typedEntry = entry as { host: string; action: "allow" | "deny" };
    amendments.push({ host: typedEntry.host, action: typedEntry.action });
  }
  return amendments;
}

interface MappedCodexClarification {
  request: ClarificationRequest;
  questionIds: string[];
}

function mapCodexToolQuestionsToClarification(
  ecoThreadId: string,
  toolUseId: string,
  rawQuestions: unknown[],
): MappedCodexClarification {
  const questions: ClarificationRequest["questions"] = [];
  const questionIds: string[] = [];

  for (const entry of rawQuestions) {
    if (!isRecord(entry)) {
      continue;
    }
    const question = entry.question as string;
    const header = entry.header as string;
    // 0.160.1 serializes `options` as `Array<...> | null`; null means free text only.
    const options = ((entry.options as Record<string, unknown>[] | null | undefined) ?? []).map((option) => {
      const label = option.label as string;
      const description = option.description as string;
      return description ? { label, description } : { label };
    });
    questionIds.push(entry.id as string);
    questions.push({
      question,
      ...(header ? { header } : {}),
      options,
      allowCustom: entry.isOther === true,
    });
  }

  return {
    request: {
      toolUseId,
      threadId: ecoThreadId,
      questions,
    },
    questionIds,
  };
}

function mapClarificationAnswersToCodexToolResponse(
  mapped: MappedCodexClarification,
  answers: ClarificationAnswers,
): { answers: Record<string, { answers: string[] }> } {
  if (isIgnoredClarification(answers)) {
    return { answers: {} };
  }
  if (answers.selections.length !== mapped.questionIds.length) {
    throw invalidServerRequestParams(
      CODEX_TOOL_REQUEST_USER_INPUT,
      `expected ${mapped.questionIds.length} answers, received ${answers.selections.length}.`,
    );
  }
  const answerEntries: Array<[string, { answers: string[] }]> = [];
  for (const [index] of mapped.request.questions.entries()) {
    const questionId = mapped.questionIds[index];
    if (!questionId) {
      throw invalidServerRequestParams(
        CODEX_TOOL_REQUEST_USER_INPUT,
        `missing question id for answer ${index}.`,
      );
    }
    answerEntries.push([questionId, { answers: [...(answers.selections[index] ?? [])] }]);
  }

  return { answers: Object.fromEntries(answerEntries) };
}

function rememberPendingMcpToolCall(params: Record<string, unknown>): void {
  const codexThreadId = readString(params, "threadId");
  const item = isRecord(params.item) ? params.item : undefined;
  if (!codexThreadId || !item || readString(item, "type") !== "mcpToolCall") {
    return;
  }
  const itemId = readString(item, "id");
  const serverName = readString(item, "server");
  const toolName = readString(item, "tool");
  const argumentsValue = readMcpArguments(item);
  if (!itemId || !serverName || !toolName || !argumentsValue) {
    return;
  }
  const existing = pendingMcpToolCalls.get(codexThreadId) ?? [];
  const next = existing.filter((call) => call.itemId !== itemId);
  next.push({ codexThreadId, itemId, serverName, toolName, arguments: argumentsValue });
  // A malformed/abandoned turn must not grow this process-global cache forever.
  pendingMcpToolCalls.set(codexThreadId, next.slice(-32));
}

function forgetPendingMcpToolCall(params: Record<string, unknown>): void {
  const codexThreadId = readString(params, "threadId");
  const item = isRecord(params.item) ? params.item : undefined;
  const itemId = item ? readString(item, "id") : undefined;
  if (!codexThreadId || !itemId) {
    return;
  }
  const next = (pendingMcpToolCalls.get(codexThreadId) ?? []).filter((call) => call.itemId !== itemId);
  if (next.length > 0) pendingMcpToolCalls.set(codexThreadId, next);
  else pendingMcpToolCalls.delete(codexThreadId);
}

function resolvePendingHubCall(
  codexThreadId: string,
  wrapperServerName: string,
  itemId?: string,
): { itemId: string; serverName: string; toolName: string; arguments: Record<string, unknown> } | undefined {
  if (!wrapperServerName.trim().toLowerCase().startsWith("eco_mcp")) {
    return undefined;
  }
  const calls = (pendingMcpToolCalls.get(codexThreadId) ?? []).filter(
    (call) =>
      call.serverName === wrapperServerName &&
      call.toolName === "call_tool" &&
      (!itemId || call.itemId === itemId),
  );
  if (calls.length !== 1) return undefined;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (!call || call.serverName.trim().toLowerCase() !== wrapperServerName.trim().toLowerCase()) {
      continue;
    }
    if (call.toolName.trim().toLowerCase() !== "call_tool") {
      continue;
    }
    const nestedName = readString(call.arguments, "name");
    const separator = nestedName?.indexOf(":") ?? -1;
    if (!nestedName || separator <= 0 || separator === nestedName.length - 1) {
      return undefined;
    }
    const nestedArguments = isRecord(call.arguments.arguments) ? call.arguments.arguments : {};
    return {
      itemId: call.itemId,
      serverName: nestedName.slice(0, separator),
      toolName: nestedName.slice(separator + 1),
      arguments: nestedArguments,
    };
  }
  return undefined;
}

/** Preserve direct MCP arguments as well as Hub arguments; never borrow an ambiguous concurrent call. */
function resolveDirectMcpApprovalArguments(input: {
  codexThreadId: string;
  serverName: string;
  toolName: string;
  message: string;
  itemId?: string;
}): Record<string, unknown> {
  const calls = (pendingMcpToolCalls.get(input.codexThreadId) ?? []).filter(
    (call) =>
      call.serverName.trim().toLowerCase() === input.serverName.trim().toLowerCase() &&
      parseMcpToolRunElicitationMessage(call.serverName, `run tool "${call.toolName}"`) === input.toolName &&
      (!input.itemId || call.itemId === input.itemId),
  );
  // Some Codex versions include exact JSON arguments in the elicitation rather than item/started.
  const encoded = input.message.match(/with arguments\s+(\{[\s\S]*\})\s*\?\s*$/i)?.[1];
  let statedArguments: Record<string, unknown> | undefined;
  if (encoded) {
    try {
      const parsed: unknown = JSON.parse(encoded);
      if (isRecord(parsed)) statedArguments = parsed;
    } catch {
      // Keep the raw protocol evidence below so the reviewer sees the actual gap.
    }
  }
  if (calls.length === 1 && calls[0]) {
    if (statedArguments && !isDeepStrictEqual(statedArguments, calls[0].arguments)) {
      return { _approvalMessage: input.message, _argumentsUnavailable: "conflicting_argument_sources" };
    }
    return calls[0].arguments;
  }
  if (statedArguments) return statedArguments;
  return {
    _approvalMessage: input.message,
    _argumentsUnavailable:
      calls.length > 1 ? "ambiguous_concurrent_calls" : encoded ? "invalid_json" : "not_provided",
  };
}

function buildMcpToolApprovalMessage(
  serverName: string,
  toolName: string,
  argumentsValue: Record<string, unknown>,
): string {
  let encoded = "{}";
  try {
    encoded = JSON.stringify(argumentsValue);
  } catch {
    encoded = "[unserializable arguments]";
  }
  if (encoded.length > 4000) encoded = `${encoded.slice(0, 3997)}...`;
  return `Allow the ${serverName} MCP server to run tool "${toolName}" with arguments ${encoded}?`;
}

function readMcpArguments(item: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ["arguments", "args", "input", "params", "toolInput", "tool_input"] as const) {
    const value = item[key];
    if (isRecord(value)) return value;
    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (isRecord(parsed)) return parsed;
      } catch {
        // Ignore non-JSON diagnostics fields.
      }
    }
  }
  return undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPendingCodexBashApprovalForThread(threadId: string): BashApprovalRequest | undefined {
  return getPendingBashApprovalForThread(threadId);
}

export function resolvePendingCodexBashApproval(
  toolUseId: string,
  resolution: BashApprovalResolution,
): boolean {
  return resolvePendingBashApproval(toolUseId, resolution);
}
