import {
  type AgentEvent,
  normalizeSdkSubagentType,
  SDK_GENERAL_PURPOSE_AGENT_KEY,
  SDK_PLAN_AGENT_KEY,
} from "@eco/runtime";
import { inferActivityRole } from "@eco/runtime/sdk";
import { isAcpSubagentAgentId } from "../shared/acp-subagent";
import type { RuntimeAgentRole } from "../shared/ipc";
import type { SubagentMetricsRegistry } from "./subagent-metrics-registry.js";

type ActivityAgentEvent = Pick<AgentEvent, "type" | "payload" | "role" | "agentId">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readParentToolUseId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const direct = payload.parent_tool_use_id;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  return undefined;
}

function readBillingRole(role: string): RuntimeAgentRole | undefined {
  const trimmed = role.trim();
  if (trimmed === SDK_GENERAL_PURPOSE_AGENT_KEY || trimmed === SDK_PLAN_AGENT_KEY) {
    return trimmed;
  }
  const normalized = normalizeSdkSubagentType(role);
  if (normalized) {
    return normalized;
  }
  if (!trimmed || isReservedActivityRole(trimmed)) {
    return undefined;
  }
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmed) ? trimmed : undefined;
}

function isReservedActivityRole(role: string): boolean {
  return ["assistant", "main", "main", "system", "thinking", "tool", "user"].includes(role);
}

function readDistinctSubagentSessionId(
  agentId: string | undefined,
  plannerSessionId: string | undefined,
): string | undefined {
  const explicitAgentId = agentId?.trim();
  if (!explicitAgentId || explicitAgentId === "unknown-session" || explicitAgentId === plannerSessionId) {
    return undefined;
  }
  return explicitAgentId;
}

/**
 * Cursor ACP root-turn events stamp a per-run UUID as `agentId`, but Eco never
 * mints a matching agent instance / Card. Those rows must land on the main Feed
 * (`scope: main`); nested `acp-sub:*` / parent-tool-linked events keep attribution.
 */
export function shouldOmitAcpRootActivityAgentId(input: {
  coreKind?: string | null;
  eventAgentId?: string | null;
  parentToolUseId?: string | null;
}): boolean {
  if (input.coreKind !== "acp") {
    return false;
  }
  if (isAcpSubagentAgentId(input.eventAgentId)) {
    return false;
  }
  if (typeof input.parentToolUseId === "string" && input.parentToolUseId.trim()) {
    return false;
  }
  return Boolean(typeof input.eventAgentId === "string" && input.eventAgentId.trim());
}

/** Resolve sub-agent instance id for activity persistence. */
export function resolveActivityAgentId(
  threadId: string,
  event: ActivityAgentEvent,
  options: {
    plannerSessionId?: string;
    metricsRegistry?: SubagentMetricsRegistry;
    /** When `acp`, root-turn UUIDs are omitted so narrative lands on the main Feed. */
    coreKind?: string | null;
  },
): string | undefined {
  const displayRole = inferActivityRole(event);
  const billingRole = readBillingRole(displayRole);
  const distinctExplicit = readDistinctSubagentSessionId(event.agentId, options.plannerSessionId?.trim());
  const parentToolUseId = readParentToolUseId(event.payload);

  if (
    shouldOmitAcpRootActivityAgentId({
      ...(options.coreKind === undefined ? {} : { coreKind: options.coreKind }),
      ...(event.agentId === undefined ? {} : { eventAgentId: event.agentId }),
      ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
    })
  ) {
    return undefined;
  }

  if (parentToolUseId && options.metricsRegistry) {
    const linked = options.metricsRegistry.resolveAgentIdByParentToolUse(threadId, parentToolUseId);
    if (linked) {
      return linked;
    }
  }

  if (distinctExplicit && billingRole) {
    return distinctExplicit;
  }

  if (distinctExplicit && options.metricsRegistry?.roleForAgentId(threadId, distinctExplicit)) {
    return distinctExplicit;
  }

  if (!billingRole) {
    return undefined;
  }

  if (distinctExplicit) {
    return distinctExplicit;
  }

  return undefined;
}

export function activityStreamKey(
  threadId: string,
  agentId?: string,
  role?: string,
  parentToolUseId?: string,
  streamBlockKey?: string,
  runAttemptId?: string,
): string {
  let key: string;
  if (agentId?.trim()) {
    key = `${threadId}:${agentId.trim()}`;
  } else if (parentToolUseId?.trim()) {
    key = `${threadId}:parent:${parentToolUseId.trim()}`;
  } else {
    key = `${threadId}:${role ?? "main"}`;
  }
  // Scope unkeyed narrative streams per Eco run attempt so ACP/PI block
  // generations (message:0) cannot collide across turns in persisted streamKey.
  const attempt = runAttemptId?.trim();
  if (attempt) {
    key = `${key}:attempt:${attempt}`;
  }
  return streamBlockKey?.trim() ? `${key}:block:${streamBlockKey.trim()}` : key;
}
