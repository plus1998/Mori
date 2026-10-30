import {
  type AgentBashPolicy,
  type BashPolicyDecision,
  type BashReviewMode,
  evaluateBashHardDeny,
  evaluateBashPolicy,
} from "../../bash-policy/src";
import type { ApprovalRiskLevel } from "../../shared/src";
import type { EcoAgentRuntimeConfig } from "./agent-orchestration.js";
import { resolveEffectiveBashPolicy } from "./agent-orchestration.js";
import {
  filesystemReadScopeAskReason,
  isDiscoveryFilesystemTool,
  isPathInsideAnyPolicyScope,
  isPathInsidePolicyScope,
  isReadFilesystemTool,
  isReviewableExternalReadPath,
  isSystemTemporaryPolicyPath,
  isWriteFilesystemTool,
  pathContainsGlobMeta,
  readFilesystemPath,
  resolveFilesystemScopeRoot,
  resolvePolicyPath,
  resolvePolicySearchBase,
} from "./filesystem-scope-policy.js";
import { materializeEcoToolPolicy } from "./tool-permission-policy.js";

/** Composer「执行确认」档位（持久化字段仍为 `bashReviewMode`）。 */
export type ExecutionConfirmationMode = BashReviewMode;

export type ToolConfirmationAction = "allow" | "ask" | "deny";

export interface ToolConfirmationDecision {
  action: ToolConfirmationAction;
  reason: string;
  userMessage: string;
  riskScore?: number;
  riskLevel?: ApprovalRiskLevel;
  matchedRule?: string;
}

export interface EvaluateBashConfirmationInput {
  command: string;
  cwd: string;
  workspacePath: string;
  confirmationMode: ExecutionConfirmationMode;
  phaseAllowsExecution?: boolean;
  agentBash?: AgentBashPolicy;
}

export interface EvaluateFilesystemReadConfirmationInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  workspacePath: string;
  confirmationMode: ExecutionConfirmationMode;
  implicitReadAllowRoots?: readonly string[];
  fallbackReason?: string;
}

export type EvaluateFilesystemWriteConfirmationInput = Omit<
  EvaluateFilesystemReadConfirmationInput,
  "implicitReadAllowRoots"
>;

export interface ResolveAgentBashPolicyInput {
  registry?: EcoAgentRuntimeConfig;
  agentId?: string;
  agentType?: string;
}

export function resolveAgentBashPolicyForConfirmation(
  input: ResolveAgentBashPolicyInput,
): AgentBashPolicy | undefined {
  const registry = input.registry;
  if (!registry) {
    return undefined;
  }
  const bash = resolveToolBashPolicy(
    registry.orchestration,
    registry.templates,
    input.agentId,
    input.agentType,
  );
  if (!bash) {
    return undefined;
  }
  return {
    enabled: bash.enabled,
  };
}

export function evaluateBashConfirmation(input: EvaluateBashConfirmationInput): ToolConfirmationDecision {
  if (input.phaseAllowsExecution === false) {
    return toConfirmationDecision({
      action: "deny",
      reason: "当前模式不允许运行终端命令。",
      riskScore: 100,
      riskLevel: "critical",
      matchedRule: "phase_execution_disabled",
    });
  }

  const policy = evaluateBashPolicy({
    command: input.command,
    cwd: input.cwd,
    workspacePath: input.workspacePath,
    mode: input.confirmationMode,
    ...(input.agentBash ? { agentBash: input.agentBash } : {}),
  });
  return bashPolicyToConfirmation(policy);
}

/** PreToolUse：仅硬拒；通过则交给 canUseTool 做确认。 */
export function evaluateBashHookGate(
  input: EvaluateBashConfirmationInput,
): ToolConfirmationDecision | undefined {
  if (input.phaseAllowsExecution === false) {
    return toConfirmationDecision({
      action: "deny",
      reason: "当前模式不允许运行终端命令。",
      riskScore: 100,
      riskLevel: "critical",
      matchedRule: "phase_execution_disabled",
    });
  }

  const hardDeny = evaluateBashHardDeny({
    command: input.command,
    cwd: input.cwd,
    workspacePath: input.workspacePath,
    ...(input.agentBash ? { agentBash: input.agentBash } : {}),
  });
  if (!hardDeny) {
    return undefined;
  }
  return bashPolicyToConfirmation(hardDeny);
}

export function evaluateFilesystemReadConfirmation(
  input: EvaluateFilesystemReadConfirmationInput,
): ToolConfirmationDecision | undefined {
  if (!isReadFilesystemTool(input.toolName)) {
    return undefined;
  }

  const scopeRoot = resolveFilesystemScopeRoot(input.workspacePath, input.cwd);
  const implicitRoots = input.implicitReadAllowRoots ?? [];
  const filePath = readFilesystemPath(input.toolInput, input.toolName);
  const resolved = resolveFilesystemReadCandidate(
    input.toolName,
    filePath,
    input.cwd,
    scopeRoot,
    implicitRoots,
  );

  if (!resolved) {
    return { action: "allow", reason: "Path is inside workspace scope.", userMessage: "工作区内访问" };
  }

  if (resolved.kind === "deny") {
    return toConfirmationDecision({
      action: "deny",
      reason:
        resolved.reason ?? filesystemReadScopeAskReason(input.toolName, resolved.displayPath, scopeRoot),
      riskScore: 100,
      riskLevel: "high",
      matchedRule: "filesystem_outside_scope",
    });
  }

  if (input.confirmationMode === "allow_all") {
    return {
      action: "allow",
      reason: "External read allowed by execution confirmation mode.",
      userMessage: "已允许工作区外读取",
    };
  }

  const reason =
    input.fallbackReason ?? filesystemReadScopeAskReason(input.toolName, resolved.displayPath, scopeRoot);
  return toConfirmationDecision({
    action: "ask",
    reason,
    riskScore: 40,
    riskLevel: "medium",
    matchedRule: "filesystem_external_read",
  });
}

export function evaluateFilesystemWriteConfirmation(
  input: EvaluateFilesystemWriteConfirmationInput,
): ToolConfirmationDecision | undefined {
  if (!isWriteFilesystemTool(input.toolName)) {
    return undefined;
  }

  const scopeRoot = resolveFilesystemScopeRoot(input.workspacePath, input.cwd);
  const filePath = readFilesystemPath(input.toolInput, input.toolName);
  const writeTarget = filePath ? resolvePolicyPath(filePath, input.cwd) : resolvePolicyPath(".", input.cwd);
  if (isPathInsidePolicyScope(writeTarget, scopeRoot) || isSystemTemporaryPolicyPath(writeTarget)) {
    return {
      action: "allow",
      reason: "Path is inside an allowed filesystem scope.",
      userMessage: "允许访问",
    };
  }
  if (input.confirmationMode === "allow_all") {
    return {
      action: "allow",
      reason: "External write allowed by execution confirmation mode.",
      userMessage: "已允许工作区外写入",
    };
  }

  const displayPath = filePath ?? ".";
  return toConfirmationDecision({
    action: "ask",
    reason:
      input.fallbackReason ??
      `Filesystem write path "${displayPath}" is outside Mori workspace "${scopeRoot}". Approve to allow this ${input.toolName} call.`,
    riskScore: 70,
    riskLevel: "high",
    matchedRule: "filesystem_external_write",
  });
}

/** PreToolUse：工作区外读写返回 ask，避免 acceptEdits 自动放行。 */
export function evaluateFilesystemHookGate(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  workspacePath: string;
  confirmationMode: ExecutionConfirmationMode;
  implicitReadAllowRoots?: readonly string[];
  filesystemWrite: "workspace" | "none";
  filesystemRead: "workspace" | "extra_dirs" | "none";
}): ToolConfirmationDecision | undefined {
  const isReadTool = isReadFilesystemTool(input.toolName);
  const isWriteTool = isWriteFilesystemTool(input.toolName);
  if (!isReadTool && !isWriteTool) {
    return undefined;
  }
  if (isReadTool && input.filesystemRead === "extra_dirs") {
    return undefined;
  }

  if (isWriteTool && input.filesystemWrite === "workspace") {
    const writeDecision = evaluateFilesystemWriteConfirmation({
      toolName: input.toolName,
      toolInput: input.toolInput,
      cwd: input.cwd,
      workspacePath: input.workspacePath,
      confirmationMode: input.confirmationMode,
    });
    if (writeDecision?.action !== "allow") {
      return writeDecision;
    }
  }

  const readDecision = evaluateFilesystemReadConfirmation({
    toolName: input.toolName,
    toolInput: input.toolInput,
    cwd: input.cwd,
    workspacePath: input.workspacePath,
    confirmationMode: input.confirmationMode,
    ...(input.implicitReadAllowRoots?.length ? { implicitReadAllowRoots: input.implicitReadAllowRoots } : {}),
  });
  if (!readDecision || readDecision.action === "allow") {
    return undefined;
  }
  return readDecision;
}

function resolveFilesystemReadCandidate(
  toolName: string,
  filePath: string | undefined,
  cwd: string,
  scopeRoot: string,
  implicitRoots: readonly string[],
): undefined | { kind: "ask" | "deny"; displayPath: string; reason?: string } {
  if (!filePath) {
    if (isDiscoveryFilesystemTool(toolName)) {
      const cwdInsideScope = isPathInsidePolicyScope(resolvePolicyPath(".", cwd), scopeRoot);
      if (!cwdInsideScope) {
        return { kind: "ask", displayPath: "." };
      }
    }
    return undefined;
  }

  const absolutePath = resolvePolicyPath(filePath, cwd);
  if (implicitRoots.length > 0 && isPathInsideAnyPolicyScope(absolutePath, implicitRoots)) {
    return undefined;
  }

  const candidatePath =
    isDiscoveryFilesystemTool(toolName) && pathContainsGlobMeta(filePath)
      ? resolvePolicySearchBase(filePath, cwd)
      : absolutePath;

  if (isSystemTemporaryPolicyPath(candidatePath)) {
    return undefined;
  }

  if (implicitRoots.length > 0 && isPathInsideAnyPolicyScope(candidatePath, implicitRoots)) {
    return undefined;
  }

  if (isPathInsidePolicyScope(candidatePath, scopeRoot)) {
    return undefined;
  }

  if (isDiscoveryFilesystemTool(toolName) && pathContainsGlobMeta(filePath)) {
    return { kind: "ask", displayPath: filePath };
  }

  if (isReviewableExternalReadPath(absolutePath)) {
    return { kind: "ask", displayPath: filePath };
  }

  return { kind: "ask", displayPath: filePath };
}

function bashPolicyToConfirmation(policy: BashPolicyDecision): ToolConfirmationDecision {
  return toConfirmationDecision({
    action: policy.action,
    reason: policy.reason,
    riskScore: policy.riskScore,
    riskLevel: policy.riskLevel,
    ...(policy.matchedRule ? { matchedRule: policy.matchedRule } : {}),
  });
}

function toConfirmationDecision(input: {
  action: ToolConfirmationAction;
  reason: string;
  riskScore?: number;
  riskLevel?: ApprovalRiskLevel;
  matchedRule?: string;
}): ToolConfirmationDecision {
  return {
    action: input.action,
    reason: input.reason,
    userMessage: formatConfirmationUserMessage(input.action, input.reason, input.matchedRule),
    ...(input.riskScore !== undefined && { riskScore: input.riskScore }),
    ...(input.riskLevel && { riskLevel: input.riskLevel }),
    ...(input.matchedRule && { matchedRule: input.matchedRule }),
  };
}

export function formatConfirmationUserMessage(
  action: ToolConfirmationAction,
  reason: string,
  matchedRule?: string,
): string {
  if (action === "allow") {
    return "将自动执行";
  }
  if (matchedRule === "phase_execution_disabled") {
    return "当前模式不允许运行终端命令";
  }
  if (matchedRule === "agent_denylist" || matchedRule?.includes("denylist")) {
    return "该命令在智能体策略中被禁止";
  }
  if (matchedRule === "agent_allowlist") {
    return "该命令不在智能体允许列表中";
  }
  if (matchedRule === "filesystem_external_read") {
    return "需要确认：访问工作区外的路径";
  }
  if (matchedRule === "filesystem_external_write") {
    return "需要确认：写入工作区外的路径";
  }
  if (matchedRule === "filesystem_write_outside_scope" || matchedRule === "filesystem_outside_scope") {
    return "不允许写入或读取工作区外的路径";
  }
  if (action === "ask" && reason.includes("always review")) {
    return "需要确认：执行终端命令";
  }
  if (action === "ask" && (reason.includes("risk score") || reason.includes("File deletion"))) {
    return "需要确认：检测到高风险操作";
  }
  if (action === "ask") {
    return "需要确认后才能执行";
  }
  return reason;
}

function resolveToolBashPolicy(
  orchestration: EcoAgentRuntimeConfig["orchestration"],
  templates: EcoAgentRuntimeConfig["templates"],
  agentId?: string,
  agentType?: string,
): ReturnType<typeof resolveEffectiveBashPolicy> {
  const actor = resolveBashPolicyActor(agentId, agentType);
  if (actor === "main") {
    return resolveEffectiveBashPolicy(materializeEcoToolPolicy(orchestration.mainAgent.tools));
  }
  const agent = orchestration.agents.find((entry) => entry.agentKey === actor);
  if (!agent) {
    return resolveEffectiveBashPolicy(materializeEcoToolPolicy(orchestration.mainAgent.tools));
  }
  const template = templates.find((entry) => entry.id === agent.templateId);
  const policy =
    agent.tools.bash !== undefined ||
    agent.tools.allowed.length > 0 ||
    agent.tools.disallowed.some((entry) => entry.trim() === "Bash")
      ? agent.tools
      : (template?.defaultTools ?? orchestration.mainAgent.tools);
  return resolveEffectiveBashPolicy(materializeEcoToolPolicy(policy));
}

function resolveBashPolicyActor(agentId?: string, agentType?: string): "main" | string {
  const raw = agentId?.trim() || agentType?.trim();
  if (!raw || raw === "main") {
    return "main";
  }
  if (raw.startsWith("eco_")) {
    return raw.slice("eco_".length);
  }
  return raw;
}
