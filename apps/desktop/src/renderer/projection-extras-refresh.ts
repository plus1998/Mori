import type { ConversationEffect } from "@eco/shared";

/** Block starts and first content must not wait for the per-token refresh throttle. */
export function isConversationV2ProjectionRefreshEffect(effect: ConversationEffect): boolean {
  return (
    (effect.type === "noop" &&
      (effect.reason === "runtime.thinking.changed" || effect.reason === "runtime.tool_writing.changed")) ||
    effect.type === "message.create" ||
    effect.type === "tool.summary.upsert" ||
    (effect.type === "run.upsert" && effect.run.status !== "running" && effect.run.status !== "queued")
  );
}

/** Token updates stay throttled; thinking and tool boundaries can force a refresh. */
export function shouldRefreshConversationV2ProjectionExtras(input: {
  hasThreadState: boolean;
  hasProjectionApi: boolean;
  inFlight: boolean;
  now: number;
  nextAllowed: number;
  force?: boolean;
}): boolean {
  if (!input.hasThreadState || !input.hasProjectionApi || input.inFlight) {
    return false;
  }
  return input.force === true || input.now >= input.nextAllowed;
}

/**
 * Live events that change whether a tool call is being written, and therefore have to force the
 * fetch: `tool.writing` announces one, and the call's own row landing (or the turn ending) ends
 * the wait. Dropping `tool.writing` from this set reintroduces the stall silently — nothing else
 * in the stream fires during the write.
 */
export const TOOL_WRITING_REFRESH_LIVE_TYPES: ReadonlySet<string> = new Set([
  "tool.writing",
  "tool.writing.completed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "thread.completed",
  "thread.failed",
  "thread.cancelled",
  "thread.idle",
  "thread.blocked",
  "thread.execution_failed",
]);
