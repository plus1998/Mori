export type AgentRole = "main" | "explore" | "architect" | "coder" | "reviewer" | "tester";
export type RuntimeAgentRole = string;
export { isMainAgentId, isMainAgentRole, normalizeAgentRole } from "./agent-role";
export * from "./codex-gateway-model-alias";
export type ModelCapability =
  | "messages_api"
  | "streaming"
  | "tool_use"
  | "subagent_compatible"
  | "count_tokens"
  | "cost_usage"
  | "long_context";
export type ModelProviderKind = "anthropic" | "litellm" | "openrouter" | "bedrock" | "vertex" | "custom";
export interface ModelProfile {
  id: string;
  provider: ModelProviderKind;
  displayName: string;
  baseUrl: string;
  modelId: string;
  capabilities: ModelCapability[];
  enabled: boolean;
  contextWindow?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}
export interface AgentRoleRoute {
  role: RuntimeAgentRole;
  primaryModelId: string;
  fallbackModelIds: string[];
  maxCostUsd?: number;
  requiredCapabilities: ModelCapability[];
}
export type AgentEventType =
  | "thread.started"
  | "thread.completed"
  | "thread.failed"
  | "session.captured"
  | "session.title"
  | "file.checkpoint"
  | "agent.started"
  | "agent.completed"
  | "agent.loop_ended"
  | "agent.settled"
  | "agent.failed"
  | "plan.ready"
  | "message.delta"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "todo.updated"
  | "approval.requested"
  | "approval.resolved"
  | "terminal.output"
  | "changeset.created"
  | "changeset.applied"
  | "usage.recorded"
  | "context.compaction.started"
  | "context.compaction.completed"
  | "context.compaction.failed"
  | "run.terminal";
/** Payload for AgentEvent when type is `run.terminal`. */
export type ClaudeRunTerminal =
  | { status: "completed" }
  | { status: "failed"; error: string; unstarted?: boolean }
  | { status: "cancelled"; reason: string }
  | { status: "incomplete"; reason: string };
export interface PlanReadyPayload {
  userPrompt: string;
  analysis: string;
  plan: string;
  /** Claude Code plan file written by ExitPlanMode (workspace-relative when possible). */
  planFilePath?: string;
  /** Exact deferred ExitPlanMode call that may complete after approval. */
  deferredExitPlanToolUseId?: string;
}
export interface SessionCapturedPayload {
  sessionId: string;
  cwd: string;
  /** /clear allocated an empty session which still needs its first persisted turn. */
  resetPending?: boolean;
}
export interface SessionTitlePayload {
  title: string;
}
export interface AgentEvent<TPayload = unknown> {
  id: string;
  threadId: string;
  agentId: string;
  parentAgentId?: string;
  role: RuntimeAgentRole;
  type: AgentEventType;
  timestamp: string;
  payload: TPayload;
}
export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalDecision = "pending" | "approved" | "denied";
export interface ApprovalRequest {
  id: string;
  threadId: string;
  agentId: string;
  operation: string;
  riskLevel: ApprovalRiskLevel;
  cwd: string;
  command?: string[];
  filePath?: string;
  reason: string;
  decision: ApprovalDecision;
  createdAt: string;
  resolvedAt?: string;
}
export type ChangeSetStatus = "created" | "reviewed" | "applied" | "rejected" | "failed";
export interface ChangeSet {
  id: string;
  threadId: string;
  sourceWorktreePath: string;
  targetWorkspacePath: string;
  filesChanged: string[];
  diff: string;
  status: ChangeSetStatus;
  createdAt: string;
  appliedAt?: string;
}
export interface UsageRecord {
  threadId: string;
  agentId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
}
export type { EventStore, SecretStore, ThreadRecord } from "./store";
export { InMemoryEventStore, InMemorySecretStore, redactSecrets } from "./store";
export declare function hasCapabilities(
  profile: Pick<ModelProfile, "capabilities">,
  requiredCapabilities: readonly ModelCapability[],
): boolean;
export declare function createAgentEvent<TPayload>(
  event: Omit<AgentEvent<TPayload>, "timestamp"> & {
    timestamp?: string;
  },
): AgentEvent<TPayload>;
