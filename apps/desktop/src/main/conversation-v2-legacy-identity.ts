import { stableHash } from "@eco/shared";
import type { ThreadRunEvent, ThreadRunEventInput } from "../shared/thread-run-events";

/**
 * Row identities and provider facts of the legacy event log.
 *
 * Two callers need the same answer for "which V2 row does this legacy event
 * produce, and what did the provider call it":
 *
 * - the mirror adapter, which writes the rows live;
 * - the read model, which fills a column added later from the log it was derived
 *   from (a plain re-derivation: rebuilding the read model produces the same
 *   values).
 *
 * Keeping the derivation in one module is what makes those two agree. A second
 * copy of the hash formula silently produces a different row id, which shows up
 * as a backfill that matches nothing.
 */

/** The provider's own role label (`main`, `coder`, `explore`, `thinking`, ...). */
export function legacyProviderRole(event: ThreadRunEventInput): string | undefined {
  const role = event.role?.trim();
  return role ? role : undefined;
}

export function legacyToolMetadata(event: ThreadRunEventInput): Record<string, unknown> {
  const metadata = event.metadata?.tool;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

export function legacyMessageId(event: ThreadRunEventInput): string {
  const explicit = event.metadata?.conversationV2MessageId;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  const key = event.streamKey?.trim() || event.requestId?.trim() || event.id;
  return `legacy_message_${stableHash(
    `${event.threadId}:${event.runAttemptId ?? ""}:${key}:${event.role ?? "assistant"}`,
  )}`;
}

export function legacyToolCallId(event: ThreadRunEventInput): string {
  const tool = legacyToolMetadata(event);
  const fromMetadata = typeof tool.toolUseId === "string" ? tool.toolUseId.trim() : "";
  return fromMetadata || `legacy_tool_${stableHash(`${event.threadId}:${event.id}:${event.sequence}`)}`;
}

/**
 * Identity of a provider notice row (a failed request the reader is told about).
 *
 * A notice is not a stream: the recorder writes one row per failure, and two failures can
 * share a request id (a retry after a 503 fails the same request again). Keying it by the
 * stream would fold the second notice onto the first and keep only the newer text, which is
 * how a failure reason disappears from the record — so the row's own event is the identity.
 */
export function legacyNoticeMessageId(event: ThreadRunEventInput): string {
  return `legacy_message_${stableHash(`${event.threadId}:${event.id}:notice`)}`;
}

/** Minimal row shape the read model can read back out of `thread_run_events`. */
export interface LegacyEventIdentityRow {
  id: string;
  thread_id: string;
  sequence: number;
  event_type: string;
  scope: string;
  stream_state: string;
  role: string | null;
  run_attempt_id: string | null;
  request_id: string | null;
  stream_key: string | null;
  metadata_json: string | null;
}

/**
 * Turns a persisted legacy row into the event shape the identity formulas take.
 *
 * Returns `undefined` when the row cannot be identified (unreadable metadata),
 * because a guessed id would write the fact onto a row that is not its own.
 */
export function legacyIdentityEventFromRow(row: LegacyEventIdentityRow): ThreadRunEventInput | undefined {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata_json) {
    try {
      const parsed: unknown = JSON.parse(row.metadata_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    sequence: row.sequence,
    eventType: row.event_type as ThreadRunEvent["eventType"],
    scope: row.scope as ThreadRunEvent["scope"],
    streamState: row.stream_state as ThreadRunEvent["streamState"],
    message: "",
    observedAt: "",
    ...(row.role ? { role: row.role } : {}),
    ...(row.run_attempt_id ? { runAttemptId: row.run_attempt_id } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.stream_key ? { streamKey: row.stream_key } : {}),
    ...(metadata ? { metadata } : {}),
  };
}
