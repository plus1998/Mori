import type { ClaudeRunTerminal } from "@eco/shared";
import type { RequestAttemptResult } from "./request-retry";

export type { ClaudeRunTerminal };

/**
 * Claude run terminal outcome — independent from usage.recorded billing events.
 *
 * One ECO Claude Query may emit multiple SDK `result` messages (mid-turn
 * `streamInput` / multi-turn streaming-input sessions). Each result may map to a
 * `run.terminal` observation; the **last** observation for the Query wins.
 * AbortSignal cancellation is resolved separately and wins over result terminals.
 *
 * Payload contract lives in `@eco/shared` (`ClaudeRunTerminal`).
 */
export type ClaudeRunTerminalState = { kind: "running" } | { kind: "terminal"; terminal: ClaudeRunTerminal };

export function isClaudeRunTerminalPayload(payload: unknown): payload is ClaudeRunTerminal {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (record.status === "completed") {
    return true;
  }
  if (record.status === "failed" && typeof record.error === "string") {
    return true;
  }
  if (record.status === "cancelled" && typeof record.reason === "string") {
    return true;
  }
  if (record.status === "incomplete" && typeof record.reason === "string") {
    return true;
  }
  return false;
}

/**
 * Apply one terminal observation. Later observations replace earlier ones (last-wins).
 */
export function applyClaudeRunTerminal(
  _state: ClaudeRunTerminalState,
  next: ClaudeRunTerminal,
): ClaudeRunTerminalState {
  return { kind: "terminal", terminal: next };
}

export function resolveClaudeRunAttemptFromTerminalState(
  state: ClaudeRunTerminalState,
  signal: AbortSignal,
): RequestAttemptResult {
  if (signal.aborted) {
    return {
      ok: false,
      reason: resolveAbortReason(signal.reason),
      aborted: true,
    };
  }
  if (state.kind === "running") {
    return {
      ok: false,
      reason: "Claude run ended without a terminal result.",
      incomplete: true,
    };
  }
  switch (state.terminal.status) {
    case "completed":
      return { ok: true };
    case "failed":
      return {
        ok: false,
        reason: state.terminal.error,
        ...(state.terminal.unstarted ? { unstarted: true } : {}),
      };
    case "cancelled":
      return { ok: false, reason: state.terminal.reason, aborted: true };
    case "incomplete":
      return { ok: false, reason: state.terminal.reason, incomplete: true };
    default: {
      const _exhaustive: never = state.terminal;
      return _exhaustive;
    }
  }
}

export function resolveAbortReason(
  reason: unknown,
  fallback = "cancelled by user",
): string {
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  if (reason instanceof Error && reason.message.trim()) {
    const message = reason.message.trim();
    if (
      reason.name === "AbortError" &&
      /^(?:The|This) operation was aborted\.?$/i.test(message)
    ) {
      return fallback;
    }
    return message;
  }
  return fallback;
}
