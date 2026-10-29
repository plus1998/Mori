import type {
  ThreadRunProjectionRequestSpan,
  ThreadRunProjectionWritingTool,
} from "../shared/conversation-v2-projection";

/**
 * The model is mid–tool-call: it has committed to a call and is writing its arguments,
 * so nothing on screen changes until the arguments are complete and the tool row lands.
 *
 * That window used to be indistinguishable from a stall — the Feed dropped the partial
 * call and the Composer guessed from a still timeline. The stream states it plainly, so
 * this is read straight off the request span instead of being inferred.
 */
export interface ToolWritingIndicator extends ThreadRunProjectionWritingTool {
  requestId: string;
  /** observedAt of the `tool.writing` fact, so callers can show how long the wait is. */
  since: string;
}

/**
 * Newest request of this agent that is writing a tool call, if any. Omitting the
 * owner selects the main agent; subagent spans never supply the main Feed's label.
 *
 * Note this is *not* gated on the request span still being open: a span is marked completed
 * as soon as the narrative stream finalizes, and that happens before the tool call the model
 * wrote next — the text block closes, then the call is written. The projection deletes the
 * field on every path that really ends the wait (the tool row landing, or the agent/thread
 * going terminal). Argument completion advances to dispatching without removing the row.
 *
 * A fact that says nothing about the call — no tool, no kind — is not worth a label; the
 * producers only omit the tool name for provider-side items (a web search), and even those
 * arrive with a kind.
 */
export function resolveToolWritingIndicator(
  spans: Iterable<ThreadRunProjectionRequestSpan>,
  ownerAgentId?: string,
): ToolWritingIndicator | undefined {
  let newest: ToolWritingIndicator | undefined;
  for (const span of spans) {
    if (span.ownerAgentId !== ownerAgentId) {
      continue;
    }
    const writing = span.writingTool;
    if (!writing?.name && !writing?.kind && !writing?.target) {
      continue;
    }
    if (!newest || writing.since.localeCompare(newest.since) > 0) {
      newest = {
        requestId: span.requestId,
        since: writing.since,
        ...(writing.name && { name: writing.name }),
        ...(writing.kind && { kind: writing.kind }),
        ...(writing.target && { target: writing.target }),
        ...(writing.phase && { phase: writing.phase }),
      };
    }
  }
  return newest;
}

/** i18n key + params for the writing label, kept apart from i18n so it stays testable. */
export interface ToolWritingLabel {
  key: string;
  /** Empty for the labels that carry no target. */
  params: Record<string, string>;
}

/** Longest target shown; a 400-character path would push the rest of the tail off screen. */
const MAX_LABEL_TARGET_LENGTH = 64;

/**
 * Say as much as the fact knows: the file or command, else the kind of thing being written,
 * else — when the stream said only "a call is being written" — that something is being built.
 */
export function resolveToolWritingLabel(indicator: ToolWritingIndicator): ToolWritingLabel {
  const target = indicator.target ? truncateTarget(indicator.target) : undefined;
  if (indicator.phase === "dispatching") {
    const tool = indicator.name ?? target;
    return tool
      ? { key: "activity.writingTool", params: { tool } }
      : { key: "activity.writingUnknown", params: {} };
  }
  const kind = indicator.kind ?? "tool";
  if (kind === "file") {
    return target
      ? { key: "activity.writingFileTarget", params: { target } }
      : { key: "activity.writingFile", params: {} };
  }
  if (kind === "read") {
    return target
      ? { key: "activity.writingReadTarget", params: { target } }
      : { key: "activity.writingRead", params: {} };
  }
  if (kind === "command") {
    return target
      ? { key: "activity.writingCommandTarget", params: { target } }
      : { key: "activity.writingCommand", params: {} };
  }
  // A call names itself either by its tool or by its target; both read as "being called".
  const called = target ?? indicator.name;
  return called
    ? { key: "activity.writingTool", params: { tool: called } }
    : { key: "activity.writingUnknown", params: {} };
}

function truncateTarget(target: string): string {
  return target.length > MAX_LABEL_TARGET_LENGTH
    ? `${target.slice(0, MAX_LABEL_TARGET_LENGTH - 1)}…`
    : target;
}
