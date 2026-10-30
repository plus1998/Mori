export type AgentRole = "main" | "explore" | "architect" | "coder" | "reviewer" | "tester";
export type RuntimeAgentRole = string;
export { isMainAgentId, isMainAgentRole, normalizeAgentRole } from "./agent-role";
export * from "./claude-subagent-compaction";

export * from "./codex-gateway-model-alias";
export * from "./context-budget";
export * from "./input-token-count-error";
export type {
  ConversationAgent,
  ConversationBootstrap,
  ConversationCapabilities,
  ConversationCursor,
  ConversationDetailItem,
  ConversationDetailsPage,
  ConversationEffect,
  ConversationEventInput,
  ConversationEventRecord,
  ConversationEventType,
  ConversationHead,
  ConversationMessage,
  ConversationMessageChannel,
  ConversationMessageHistoryTarget,
  ConversationMessageOrigin,
  ConversationMessageRole,
  ConversationMessageStatus,
  ConversationMessagesPage,
  ConversationRun,
  ConversationRunStatus,
  ConversationSendMessageResult,
  ConversationSyncEffect,
  ConversationSyncPage,
  ConversationTodo,
  ConversationTodoStatus,
  ConversationToolCall,
  ConversationToolStatus,
  ConversationToolsPage,
  ConversationTurnSummary,
  ConversationV2ErrorCode,
} from "./conversation-v2";
export {
  CONVERSATION_V2_DEFAULT_MAX_BYTES,
  CONVERSATION_V2_EFFECT_VERSION,
  CONVERSATION_V2_ERROR,
  CONVERSATION_V2_MAX_PAGE_SIZE,
  CONVERSATION_V2_MAX_SYNC_EVENTS,
  CONVERSATION_V2_PROTOCOL_VERSION,
  CONVERSATION_V2_SCHEMA_VERSION,
  ConversationV2Error,
  compareConversationMessagePosition,
  decodeConversationCursor,
  encodeConversationCursor,
  estimateConversationBytes,
  isConversationMessageOrigin,
  limitConversationToolSummaryPayload,
  stableHash,
  stableJson,
} from "./conversation-v2";
export { definedProps } from "./defined-props";
export {
  ECO_MCP_HUB_TOOL_NAMES,
  ecoMcpHubNamespace,
  ecoMcpHubServerName,
} from "./eco-mcp-hub";
export type {
  EcoCommandRisk,
  EcoDeviceCapability,
  EcoDeviceKind,
  EcoEventEnvelope,
  EcoForwardedInvokeParams,
  EcoInvokeOrigin,
  EcoInvokeParams,
  EcoInvokeResult,
  EcoJsonRpcError,
  EcoJsonRpcFailure,
  EcoJsonRpcId,
  EcoJsonRpcMessage,
  EcoJsonRpcMethod,
  EcoJsonRpcNotification,
  EcoJsonRpcRequest,
  EcoJsonRpcResponse,
  EcoJsonRpcSuccess,
  EcoPresenceDeviceEventPayload,
  EcoRpcSource,
} from "./event-rpc";
export {
  buildEcoJsonRpcFailure,
  buildEcoJsonRpcNotification,
  buildEcoJsonRpcRequest,
  buildEcoJsonRpcSuccess,
  ECO_JSON_RPC_VERSION,
  ECO_RPC_ERROR,
  ECO_RPC_METHODS,
  ECO_RPC_PROTOCOL_VERSION,
  isEcoInvokeParams,
  isEcoJsonRpcNotification,
  isEcoJsonRpcRequest,
  isEcoJsonRpcResponse,
} from "./event-rpc";
export { containsImageInput } from "./image-input";
export type { EcoRealtimeRpcEnvelope } from "./realtime-envelope";
export {
  ECO_REALTIME_BROADCAST_EVENT,
  ECO_REALTIME_ENVELOPE_VERSION,
  isEcoJsonRpcMessage,
  isEcoRealtimeRpcEnvelope,
  unwrapEcoRpcFromBroadcast,
  wrapEcoRpcForBroadcast,
} from "./realtime-envelope";
export type {
  EcoRealtimeTopic,
  EcoRealtimeTopicKind,
  ParsedEcoRealtimeTopic,
} from "./realtime-topics";
export {
  ECO_REALTIME_BINDINGS_CHANGED_EVENT,
  ECO_REALTIME_BINDING_READY_EVENT,
  buildEcoBindTopic,
  buildEcoUserTopic,
  buildEcoVaultTopic,
  ECO_REALTIME_TOPIC_PREFIX,
  isEcoUuid,
  normalizeEcoUuid,
  parseEcoBindTopic,
  parseEcoRealtimeTopic,
  parseEcoUserTopic,
  parseEcoVaultTopic,
} from "./realtime-topics";
export type { RemoteCommandArgsValidation, RemoteCommandDefinition } from "./remote-command-registry";
export {
  getRemoteCommandDefinition,
  isRemoteCommandChannel,
  listRemoteCommandDefinitions,
  REMOTE_COMMAND_DEFINITIONS,
  validateRemoteCommandArgs,
} from "./remote-command-registry";
export type { EventStore, SecretStore, ThreadRecord } from "./store";
export { InMemoryEventStore, InMemorySecretStore, redactSecrets } from "./store";
export * from "./tool-write-target";
export * from "./tool-write-target-tracker";
export type {
  PasswordWrappedVaultKey,
  VaultClaimKeyPair,
  VaultKeyBytes,
  VaultSecretCipher,
  WrappedVaultKey,
} from "./vault-crypto";
export {
  decryptSecretWithVaultKey,
  ECO_VAULT_PASSWORD_WRAP_ALGORITHM,
  ECO_VAULT_PASSWORD_WRAP_ITERATIONS,
  ECO_VAULT_WRAP_ALGORITHM,
  encryptSecretWithVaultKey,
  generateVaultClaimCode,
  generateVaultClaimKeyPair,
  generateVaultKey,
  hashVaultClaimCode,
  isPasswordWrappedVaultKey,
  isWrappedVaultKey,
  normalizeVaultClaimCode,
  unwrapVaultKeyFromClaim,
  unwrapVaultKeyWithPassword,
  vaultKeyToBytes,
  verifyVaultClaimCode,
  wrapVaultKeyForClaim,
  wrapVaultKeyWithPassword,
} from "./vault-crypto";

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
  /** False when the context window is an assumed default rather than model metadata. */
  contextWindowResolved?: boolean;
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
  /** PI agent loop ended (may still retry / continue) — not a run terminal. */
  | "agent.loop_ended"
  /** PI agent fully settled — paired with run.terminal from the driver. */
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
  /** Context compaction lifecycle (PI native compaction) — mirrors thread-run context.compaction.* events. */
  | "context.compaction.started"
  | "context.compaction.completed"
  | "context.compaction.failed"
  /** Claude/SDK run terminal — independent from usage.recorded billing. */
  | "run.terminal";

/**
 * Payload for `AgentEvent` with `type: "run.terminal"`.
 * Emitter (Claude Agent SDK adapter) and consumer (desktop event loop) share this contract.
 */
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

export function hasCapabilities(
  profile: Pick<ModelProfile, "capabilities">,
  requiredCapabilities: readonly ModelCapability[],
): boolean {
  const capabilities = new Set(profile.capabilities);
  return requiredCapabilities.every((capability) => capabilities.has(capability));
}

export function createAgentEvent<TPayload>(
  event: Omit<AgentEvent<TPayload>, "timestamp"> & { timestamp?: string },
): AgentEvent<TPayload> {
  return {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
}
