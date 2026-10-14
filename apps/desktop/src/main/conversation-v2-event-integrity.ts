import { type ConversationEventInput, type ConversationEventRecord, stableHash } from "@eco/shared";

/** Hash the immutable envelope; callers must supply its persisted JSON payload. */
export function conversationV2EventHash(input: ConversationEventInput): string {
  return stableHash({
    conversationId: input.conversationId,
    eventId: input.eventId,
    type: input.type,
    occurredAt: input.occurredAt,
    ...(input.sourceEventKey ? { sourceEventKey: input.sourceEventKey } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.agentInstanceId ? { agentInstanceId: input.agentInstanceId } : {}),
    ...(input.parentAgentInstanceId ? { parentAgentInstanceId: input.parentAgentInstanceId } : {}),
    ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
    ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
    payload: input.payload ?? {},
  });
}

export interface SdkInformationalEventHashRepair {
  previousHash: string;
  correctedHash: string;
  omittedMetadataKeys: string[];
}

/**
 * Prove the historical SDK informational serialization defect. This never
 * accepts an arbitrary hash mismatch: restoring only the producer's optional
 * level/tag properties must reproduce the stored hash exactly. Payloads,
 * identities, source keys, sequence numbers and effects remain untouched.
 */
export function inspectSdkInformationalEventHashRepair(
  event: ConversationEventRecord,
): SdkInformationalEventHashRepair | undefined {
  const correctedHash = conversationV2EventHash(event);
  if (correctedHash === event.eventHash) return undefined;
  const source = event.payload.source;
  if (!isRecord(source) || !isRecord(source.metadata)) return undefined;
  const metadata = source.metadata;
  if (
    event.type !== "noop" ||
    event.payload.reason !== "runtime.input" ||
    source.threadId !== event.conversationId ||
    source.eventType !== "diagnostic" ||
    metadata.activityOrigin !== "sdk.informational" ||
    metadata.liveType !== "sdk.notice" ||
    event.sourceEventKey !== `runtime-input:${event.conversationId}:${source.id}:${event.payload.inputHash}`
  )
    return undefined;
  const missing = ["level", "tag"].filter((key) => !Object.hasOwn(metadata, key));
  for (let mask = 1; mask < 1 << missing.length; mask += 1) {
    const omittedMetadataKeys = missing.filter((_, index) => mask & (1 << index));
    const restoredMetadata = { ...metadata };
    for (const key of omittedMetadataKeys) restoredMetadata[key] = undefined;
    const restored = {
      ...event,
      payload: { ...event.payload, source: { ...source, metadata: restoredMetadata } },
    };
    if (conversationV2EventHash(restored) === event.eventHash) {
      return { previousHash: event.eventHash, correctedHash, omittedMetadataKeys };
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
