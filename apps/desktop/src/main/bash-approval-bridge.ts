import type { BashApprovalDecision, BashApprovalRequest } from "../shared/ipc";

export interface BashApprovalResolution {
  decision: BashApprovalDecision;
  feedback?: string;
}

interface PendingBashApproval {
  threadId: string;
  request: BashApprovalRequest;
  resolve: (resolution: BashApprovalResolution) => void;
  reject: (error: Error) => void;
}

const pending = new Map<string, PendingBashApproval>();

export function buildResolvedBashApprovalThreadPatch(_decision: BashApprovalDecision): {
  status: "running";
  message: string;
} {
  return {
    status: "running",
    message: "",
  };
}

export function registerPendingBashApproval(
  threadId: string,
  request: BashApprovalRequest,
): Promise<BashApprovalResolution> {
  if (pending.has(request.toolUseId)) {
    return Promise.reject(new Error(`Bash approval ${request.toolUseId} is already pending.`));
  }

  return new Promise<BashApprovalResolution>((resolve, reject) => {
    pending.set(request.toolUseId, {
      threadId,
      request,
      resolve,
      reject,
    });
  });
}

export function getPendingBashApprovalForThread(threadId: string): BashApprovalRequest | undefined {
  for (const entry of pending.values()) {
    if (entry.threadId === threadId) {
      return entry.request;
    }
  }
  return undefined;
}

export function listPendingBashApprovalsForThread(threadId: string): BashApprovalRequest[] {
  const requests: BashApprovalRequest[] = [];
  for (const entry of pending.values()) {
    if (entry.threadId === threadId) {
      requests.push(entry.request);
    }
  }
  return requests;
}

export function getPendingBashApprovalByToolUseId(toolUseId: string): BashApprovalRequest | undefined {
  return pending.get(toolUseId)?.request;
}

export function resolvePendingBashApproval(toolUseId: string, resolution: BashApprovalResolution): boolean {
  const entry = pending.get(toolUseId);
  if (!entry) {
    return false;
  }
  assertBashApprovalResolutionAllowed(entry.request, resolution);
  pending.delete(toolUseId);
  entry.resolve(resolution);
  return true;
}

/**
 * Idempotent resolve for PC/mobile races: missing pending is success (`alreadyResolved`),
 * not an error. Callers should only emit live events when `alreadyResolved` is false.
 */
export function resolveBashApprovalIdempotent(
  toolUseId: string,
  resolution: BashApprovalResolution,
): { ok: true; alreadyResolved: false; request: BashApprovalRequest } | { ok: true; alreadyResolved: true } {
  const entry = pending.get(toolUseId);
  if (!entry) {
    return { ok: true, alreadyResolved: true };
  }
  assertBashApprovalResolutionAllowed(entry.request, resolution);
  pending.delete(toolUseId);
  entry.resolve(resolution);
  return { ok: true, alreadyResolved: false, request: entry.request };
}

/**
 * Mid-run switch to Eco「完全访问」: host-approve every parked execution card for the thread.
 * Does not touch plan approvals. Uses one-shot `approved` (no remember-prefix / session grant).
 */
export function approveAllPendingBashApprovalsForThread(threadId: string): BashApprovalRequest[] {
  const approved: BashApprovalRequest[] = [];
  for (const [toolUseId, entry] of pending) {
    if (entry.threadId !== threadId) {
      continue;
    }
    pending.delete(toolUseId);
    entry.resolve({ decision: "approved" });
    approved.push(entry.request);
  }
  return approved;
}

export function cancelBashApprovalsForThread(threadId: string, reason: string): void {
  for (const [toolUseId, entry] of pending) {
    if (entry.threadId !== threadId) {
      continue;
    }
    pending.delete(toolUseId);
    entry.reject(new Error(reason));
  }
}

export function assertBashApprovalResolutionAllowed(
  request: BashApprovalRequest,
  resolution: BashApprovalResolution,
): void {
  if (
    request.suppressAlwaysAllowRule &&
    [
      "approved_remember_prefix",
      "approved_remember_mcp_tool",
      "approved_for_session",
      "approved_execpolicy_amendment",
      "approved_network_policy_amendment",
    ].includes(resolution.decision)
  ) {
    throw new Error("This SDK permission request forbids persistent approval rules.");
  }
  if (resolution.decision === "approved_remember_mcp_tool" && !request.mcpToolApproval) {
    throw new Error("This request has no host-bound MCP tool to remember.");
  }
}
