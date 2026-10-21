import {
  type ClaudeRunTerminal,
  extractSdkRunFailure,
  extractSdkRunIncompleteReason,
} from "@eco/runtime/sdk";
import {
  applyClaudeRunTerminal,
  type ClaudeRunTerminalState,
  isClaudeRunTerminalPayload,
  resolveAbortReason,
  resolveClaudeRunAttemptFromTerminalState,
} from "./claude-run-terminal";
import type { RequestAttemptResult } from "./request-retry";

export interface SdkRunEventLike {
  type: string;
  payload: unknown;
}

export interface ConsumeSdkRunEventsInput<TEvent extends SdkRunEventLike> {
  events: AsyncIterable<TEvent>;
  threadId: string;
  worktreePath: string;
  signal: AbortSignal;
  onUsageRecorded: (threadId: string, event: TEvent) => void;
  captureSession: (threadId: string, event: TEvent, worktreePath: string) => void | Promise<void>;
  emitActivity: (threadId: string, event: TEvent) => void;
  onEvent?: (event: TEvent) => void | Promise<void>;
}

/**
 * Consume SDK run events.
 * Claude path: `run.terminal` is the outcome source (usage.recorded is billing-only).
 * Multi-turn Queries may emit multiple `run.terminal` observations; last wins.
 * Legacy PI / older emitters: without `run.terminal`, still derive outcome from result-shaped usage.
 */
export async function consumeSdkRunEvents<TEvent extends SdkRunEventLike>(
  input: ConsumeSdkRunEventsInput<TEvent>,
): Promise<RequestAttemptResult> {
  let terminalState: ClaudeRunTerminalState = { kind: "running" };
  let sawExplicitTerminal = false;
  let legacyFailure: string | undefined;
  let legacyIncomplete: string | undefined;

  for await (const event of input.events) {
    if (event.type === "run.terminal") {
      sawExplicitTerminal = true;
      const terminal = isClaudeRunTerminalPayload(event.payload)
        ? event.payload
        : ({
            status: "failed",
            error: "Invalid Claude run.terminal payload.",
          } satisfies ClaudeRunTerminal);
      terminalState = applyClaudeRunTerminal(terminalState, terminal);
      await input.onEvent?.(event);
      continue;
    }

    if (event.type === "usage.recorded") {
      input.onUsageRecorded(input.threadId, event);
      if (!sawExplicitTerminal) {
        const incompleteReason = extractSdkRunIncompleteReason(event.payload);
        if (incompleteReason) {
          legacyIncomplete = incompleteReason;
        } else {
          legacyFailure = extractSdkRunFailure(event.payload) ?? legacyFailure;
        }
      }
      continue;
    }

    await input.captureSession(input.threadId, event, input.worktreePath);
    await input.onEvent?.(event);
    input.emitActivity(input.threadId, event);
  }

  if (sawExplicitTerminal) {
    return resolveClaudeRunAttemptFromTerminalState(terminalState, input.signal);
  }

  // Legacy path (PI / emitters without run.terminal).
  if (input.signal.aborted) {
    return {
      ok: false,
      reason: resolveAbortReason(input.signal.reason),
      aborted: true,
    };
  }
  if (legacyFailure) {
    return { ok: false, reason: legacyFailure };
  }
  if (legacyIncomplete) {
    return { ok: false, reason: legacyIncomplete, incomplete: true };
  }
  return { ok: true };
}
