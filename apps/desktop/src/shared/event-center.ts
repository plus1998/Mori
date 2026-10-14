import type { ConversationSyncEffect } from "@eco/shared";
import type { IpcChannel, TerminalStreamEvent, ThreadLiveEvent, WorkspaceDiffChangedEvent } from "./ipc";

export const EVENT_CENTER_PROTOCOL_VERSION = 1 as const;
export const EVENT_CENTER_JSON_RPC_VERSION = "2.0" as const;

export const EVENT_CENTER_JSON_RPC_METHODS = {
  event: "eco.event",
  invoke: "eco.invoke",
} as const;

export type EventCenterJsonRpcMethod =
  (typeof EVENT_CENTER_JSON_RPC_METHODS)[keyof typeof EVENT_CENTER_JSON_RPC_METHODS];

export type EventCenterJsonRpcId = string | number | null;

export type EventCenterEventKind =
  | "thread.lifecycle"
  | "thread.stream"
  | "thread.plan"
  | "thread.clarification"
  | "thread.bash_approval"
  | "thread.follow_up"
  | "thread.todo"
  | "thread.usage"
  | "thread.context"
  | "conversation.sync_effect"
  | "conversation.projection_extras"
  | "settings.updated"
  | "workspace.terminal"
  | "workspace.package_json_changed"
  | "workspace.git_remote_fetched"
  | "workspace.git_status_changed"
  | "workspace.git_diff_changed";

export type ThreadEventCenterEventKind = Exclude<
  EventCenterEventKind,
  | "workspace.terminal"
  | "workspace.package_json_changed"
  | "workspace.git_remote_fetched"
  | "workspace.git_status_changed"
  | "workspace.git_diff_changed"
>;

export type EventCenterSource = "desktop" | "renderer" | "center-server" | "mobile";

export interface EventCenterEnvelope<TPayload = unknown> {
  protocolVersion: typeof EVENT_CENTER_PROTOCOL_VERSION;
  id: string;
  kind: EventCenterEventKind;
  source: EventCenterSource;
  occurredAt: string;
  payload: TPayload;
  threadId?: string;
  workspacePath?: string;
  aggregateKey?: string;
  metadata?: Record<string, unknown>;
}

export interface EventCenterJsonRpcNotification<TPayload = unknown> {
  jsonrpc: typeof EVENT_CENTER_JSON_RPC_VERSION;
  method: typeof EVENT_CENTER_JSON_RPC_METHODS.event;
  params: EventCenterEnvelope<TPayload>;
}

export interface EventCenterJsonRpcRequest<TParams = unknown> {
  jsonrpc: typeof EVENT_CENTER_JSON_RPC_VERSION;
  id?: EventCenterJsonRpcId;
  method: string;
  params?: TParams;
}

export interface EventCenterJsonRpcSuccess<TResult = unknown> {
  jsonrpc: typeof EVENT_CENTER_JSON_RPC_VERSION;
  id: EventCenterJsonRpcId;
  result: TResult;
}

export interface EventCenterJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface EventCenterJsonRpcFailure {
  jsonrpc: typeof EVENT_CENTER_JSON_RPC_VERSION;
  id: EventCenterJsonRpcId;
  error: EventCenterJsonRpcError;
}

export type EventCenterJsonRpcResponse<TResult = unknown> =
  | EventCenterJsonRpcSuccess<TResult>
  | EventCenterJsonRpcFailure;

export interface EventCenterInvokeParams {
  channel: IpcChannel;
  args?: unknown[];
  caller?: EventCenterSource | string;
  requestId?: string;
}

export interface EventCenterInvokeResult<TResult = unknown> {
  channel: IpcChannel;
  result: TResult;
}

export interface EventCenterPackageJsonChangedPayload {
  workspacePath: string;
}

export interface EventCenterGitRemoteFetchedPayload {
  workspacePath: string;
}

export interface EventCenterGitStatusChangedPayload {
  workspacePath: string;
  dirtyFileCount: number;
  insertions: number;
  deletions: number;
}

export interface EventCenterPayloadMap {
  "thread.lifecycle": ThreadLiveEvent;
  "thread.stream": ThreadLiveEvent;
  "thread.plan": ThreadLiveEvent;
  "thread.clarification": ThreadLiveEvent;
  "thread.bash_approval": ThreadLiveEvent;
  "thread.follow_up": ThreadLiveEvent;
  "thread.todo": ThreadLiveEvent;
  "thread.usage": ThreadLiveEvent;
  "thread.context": ThreadLiveEvent;
  "conversation.sync_effect": {
    conversationId: string;
    storeEpoch: string;
    effect: ConversationSyncEffect;
  };
  "conversation.projection_extras": {
    conversationId: string;
  };
  "settings.updated": ThreadLiveEvent;
  "workspace.terminal": TerminalStreamEvent;
  "workspace.package_json_changed": EventCenterPackageJsonChangedPayload;
  "workspace.git_remote_fetched": EventCenterGitRemoteFetchedPayload;
  "workspace.git_status_changed": EventCenterGitStatusChangedPayload;
  "workspace.git_diff_changed": WorkspaceDiffChangedEvent;
}

export const EVENT_CENTER_JSON_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function buildEventCenterJsonRpcNotification<TPayload>(
  envelope: EventCenterEnvelope<TPayload>,
): EventCenterJsonRpcNotification<TPayload> {
  return {
    jsonrpc: EVENT_CENTER_JSON_RPC_VERSION,
    method: EVENT_CENTER_JSON_RPC_METHODS.event,
    params: envelope,
  };
}

export function buildEventCenterJsonRpcSuccess<TResult>(
  id: EventCenterJsonRpcId,
  result: TResult,
): EventCenterJsonRpcSuccess<TResult> {
  return {
    jsonrpc: EVENT_CENTER_JSON_RPC_VERSION,
    id,
    result,
  };
}

export function buildEventCenterJsonRpcFailure(
  id: EventCenterJsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): EventCenterJsonRpcFailure {
  return {
    jsonrpc: EVENT_CENTER_JSON_RPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

export function isEventCenterJsonRpcRequest(value: unknown): value is EventCenterJsonRpcRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as EventCenterJsonRpcRequest;
  const hasValidId =
    request.id === undefined ||
    request.id === null ||
    typeof request.id === "string" ||
    typeof request.id === "number";
  return (
    request.jsonrpc === EVENT_CENTER_JSON_RPC_VERSION &&
    typeof request.method === "string" &&
    request.method.trim().length > 0 &&
    hasValidId
  );
}

export function isEventCenterInvokeParams(value: unknown): value is EventCenterInvokeParams {
  if (!value || typeof value !== "object") {
    return false;
  }
  const params = value as EventCenterInvokeParams;
  return (
    typeof params.channel === "string" &&
    params.channel.trim().length > 0 &&
    (params.args === undefined || Array.isArray(params.args)) &&
    (params.caller === undefined || typeof params.caller === "string") &&
    (params.requestId === undefined || typeof params.requestId === "string")
  );
}

const THREAD_PLAN_LIVE_EVENT_TYPES = new Set([
  "thread.awaiting_plan",
  "thread.plan_cleared",
  "plan_approval.requested",
  "plan_approval.approved",
  "plan_approval.denied",
]);

export function isThreadPlanLiveEvent(event: ThreadLiveEvent): boolean {
  return (
    Boolean(event.plan) ||
    Boolean(event.planApproval) ||
    THREAD_PLAN_LIVE_EVENT_TYPES.has(event.type) ||
    event.type.startsWith("plan_approval.")
  );
}

export function classifyThreadLiveEventForCenter(event: ThreadLiveEvent): ThreadEventCenterEventKind {
  if (event.type === "settings.updated") {
    return "settings.updated";
  }
  if (isThreadPlanLiveEvent(event)) {
    return "thread.plan";
  }
  if (event.clarification || event.type.startsWith("clarification.")) {
    return "thread.clarification";
  }
  if (event.bashApproval || event.type.startsWith("bash_approval.")) {
    return "thread.bash_approval";
  }
  if (event.followUp || event.type.startsWith("thread.follow_up.")) {
    return "thread.follow_up";
  }
  if (event.type === "thread.todos_updated") {
    return "thread.todo";
  }
  if (event.usage || event.billing || event.type === "thread.usage_updated") {
    return "thread.usage";
  }
  if (event.context || event.type === "thread.context_updated") {
    return "thread.context";
  }
  if (event.stream || event.activityLine) {
    return "thread.stream";
  }
  return "thread.lifecycle";
}
