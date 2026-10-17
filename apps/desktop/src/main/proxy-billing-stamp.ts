import type { IncomingHttpHeaders } from "node:http";
import type { RuntimeAgentRole } from "../shared/ipc";

export const ECO_PROXY_BILLING_HEADERS = {
  agentId: "x-eco-agent-id",
  billingRole: "x-eco-billing-role",
  parentToolUseId: "x-eco-parent-tool-use-id",
  runAttemptId: "x-eco-run-attempt-id",
} as const;

/**
 * Claude Agent SDK / Claude Code (≥2.1.139; Eco bundles 0.3.301) stamps these on
 * in-process subagent/teammate requests when agentContext.agentId is set.
 * Main-session and some Workflow spawn paths may omit them — treat absence as a
 * real gap (pending/unattributed), never invent from role alone.
 */
export const CLAUDE_CODE_ATTRIBUTION_HEADERS = {
  agentId: "x-claude-code-agent-id",
  parentAgentId: "x-claude-code-parent-agent-id",
  sessionId: "x-claude-code-session-id",
} as const;

export interface ProxyBillingStamp {
  agentId: string;
  routeRole: RuntimeAgentRole;
  billingRole: RuntimeAgentRole;
  parentToolUseId?: string;
  runAttemptId?: string;
}

export interface ProxyBillingStampInput {
  agentId: string;
  role: RuntimeAgentRole;
  parentToolUseId?: string;
  runAttemptId?: string;
}

export class ProxyBillingStampRegistry {
  private readonly byThread = new Map<string, Map<string, ProxyBillingStamp>>();

  register(threadId: string, input: ProxyBillingStampInput): void {
    const agents = this.byThread.get(threadId) ?? new Map<string, ProxyBillingStamp>();
    agents.set(input.agentId, {
      agentId: input.agentId,
      routeRole: input.role,
      billingRole: input.role,
      ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
      ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    });
    this.byThread.set(threadId, agents);
  }

  unregister(threadId: string, agentId: string): void {
    const agents = this.byThread.get(threadId);
    if (!agents) {
      return;
    }
    agents.delete(agentId);
    if (agents.size === 0) {
      this.byThread.delete(threadId);
    }
  }

  clearThread(threadId: string): void {
    this.byThread.delete(threadId);
  }

  resolveForRoute(threadId: string, routeRole: RuntimeAgentRole): ProxyBillingStamp | undefined {
    const agents = this.byThread.get(threadId);
    if (!agents || agents.size === 0) {
      return undefined;
    }
    const matches = [...agents.values()].filter((stamp) => stamp.routeRole === routeRole);
    return matches.length === 1 ? matches[0] : undefined;
  }
}

export function readProxyBillingStampFromHeaders(
  headers: IncomingHttpHeaders,
): Partial<Pick<ProxyBillingStamp, "agentId" | "billingRole" | "parentToolUseId" | "runAttemptId">> {
  const agentId = readHeader(headers, ECO_PROXY_BILLING_HEADERS.agentId);
  const billingRole = readHeader(headers, ECO_PROXY_BILLING_HEADERS.billingRole) as
    | RuntimeAgentRole
    | undefined;
  const parentToolUseId = readHeader(headers, ECO_PROXY_BILLING_HEADERS.parentToolUseId);
  const runAttemptId = readHeader(headers, ECO_PROXY_BILLING_HEADERS.runAttemptId);
  return {
    ...(agentId && { agentId }),
    ...(billingRole && { billingRole }),
    ...(parentToolUseId && { parentToolUseId }),
    ...(runAttemptId && { runAttemptId }),
  };
}

/** Read explicit request-scoped billing stamp from Bridge HTTP headers. */
export function readProxyBillingStampFromRequestHeaders(
  headers: Headers,
): Partial<Pick<ProxyBillingStamp, "agentId" | "billingRole" | "parentToolUseId" | "runAttemptId">> {
  return readProxyBillingStampFromHeaders(headersToIncomingRecord(headers));
}

export function readClaudeCodeAgentIdFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  return readHeader(headers, CLAUDE_CODE_ATTRIBUTION_HEADERS.agentId);
}

export function readClaudeCodeAgentIdFromRequestHeaders(headers: Headers): string | undefined {
  return readClaudeCodeAgentIdFromHeaders(headersToIncomingRecord(headers));
}

export function readClaudeCodeParentAgentIdFromRequestHeaders(headers: Headers): string | undefined {
  return readHeader(headersToIncomingRecord(headers), CLAUDE_CODE_ATTRIBUTION_HEADERS.parentAgentId);
}

function headersToIncomingRecord(headers: Headers): IncomingHttpHeaders {
  const record: IncomingHttpHeaders = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function readHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || undefined;
}
