import type { DatabaseSync } from "node:sqlite";
import { type ConversationEventInput, stableHash } from "@eco/shared";
import type { ThreadRunEvent, ThreadRunEventInput } from "../shared/thread-run-events";
import {
  appendProviderEventToConversationV2,
  conversationV2ProviderMessageId,
} from "./conversation-v2-provider-events";
import type { ConversationAppendResult, ConversationV2Store } from "./conversation-v2-store";

/**
 * Atomic provider ingestion. The V2 log is the only durable input/output boundary.
 * A receipt prevents an old cumulative snapshot from being applied against a later
 * content version when a provider retries after a lost acknowledgement or restart.
 */
export class ConversationV2RuntimeWriter {
  constructor(
    private readonly db: DatabaseSync,
    private readonly v2: ConversationV2Store,
  ) {}

  append(input: ThreadRunEventInput): { event: ThreadRunEvent; duplicate: boolean } {
    const result = this.appendBatch([input])[0];
    if (!result) throw new Error("Runtime writer returned no append result.");
    return result;
  }

  appendBatch(inputs: readonly ThreadRunEventInput[]): Array<{ event: ThreadRunEvent; duplicate: boolean }> {
    for (const input of inputs) this.v2.head(input.threadId);
    const results: ConversationAppendResult[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    let accepted: Array<{ event: ThreadRunEvent; duplicate: boolean }>;
    try {
      accepted = inputs.map((input) => this.appendInTransaction(input, results));
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // SQLite can roll back the transaction itself for SQLITE_FULL and similar
        // fatal errors. Preserve the provider write failure instead of masking it
        // with "cannot rollback - no transaction is active".
      }
      throw error;
    }
    this.v2.publishCommitted(results);
    return accepted;
  }

  private appendInTransaction(
    input: ThreadRunEventInput,
    results: ConversationAppendResult[],
  ): { event: ThreadRunEvent; duplicate: boolean } {
    // Runtime inputs are provider envelopes, not legacy rows.  Let the V2
    // provider adapter derive identities while it creates the normalized fact.
    // Pre-populating `conversationV2MessageId` here makes a new user prompt
    // look like an already materialized message, so the adapter skips the
    // `message.created` effect and the receipt references a missing message.
    let source = { ...input, sequence: 0 };
    // A child agent can start in one provider turn and stop in another. Its
    // lifecycle identity is the agent instance, so inferring a run from each
    // turn would make one agent appear to change ownership. Only provider
    // content/run/tool rows use request correlation; lifecycle rows retain an
    // explicit runAttemptId when the producer supplies one.
    if (!source.runAttemptId && !source.eventType.startsWith("agent.")) {
      const requestId =
        source.requestId?.trim() ||
        (typeof source.metadata?.turnId === "string" ? source.metadata.turnId.trim() : "");
      const recoveredRunId = requestId
        ? this.v2.resolveRuntimeRunAttemptId(source.threadId, requestId)
        : undefined;
      if (recoveredRunId) {
        source = { ...source, runAttemptId: recoveredRunId };
      }
    }
    if (
      (source.eventType === "agent.stopped" || source.eventType === "agent.abandoned") &&
      source.agentId
    ) {
      const agent = this.db
        .prepare(`SELECT run_id, role FROM conversation_agents_v2
          WHERE conversation_id = ? AND agent_instance_id = ?`)
        .get(source.threadId, source.agentId) as { run_id: string | null; role: string } | undefined;
      if (agent) {
        // Codex stamps a child turn's completion with the parent's *current* run.
        // The agent's first lifecycle event already fixed its owning run and role.
        const reportedRunAttemptId = source.runAttemptId?.trim();
        const reportedRole = source.role?.trim();
        const { runAttemptId: _reportedRunAttemptId, ...sourceWithoutAttempt } = source;
        const runChanged = Boolean(reportedRunAttemptId && reportedRunAttemptId !== agent.run_id);
        const roleChanged = Boolean(reportedRole && reportedRole !== agent.role);
        source = {
          ...sourceWithoutAttempt,
          ...(agent.run_id ? { runAttemptId: agent.run_id } : {}),
          role: agent.role,
          ...(runChanged || roleChanged
            ? {
                metadata: {
                  ...source.metadata,
                  ...(runChanged ? { reportedRunAttemptId } : {}),
                  ...(roleChanged ? { reportedRole } : {}),
                },
              }
            : {}),
        };
      }
    }
    const receiptInput = conversationV2ProviderReceipt(source, "runtime-input");
    const sourceEventKey = receiptInput.sourceEventKey;
    if (!sourceEventKey) throw new Error("Runtime provider receipt has no source event key.");
    const existing = this.db
      .prepare(`SELECT seq FROM conversation_events_v2
      WHERE conversation_id = ? AND source_event_key = ?`)
      .get(input.threadId, sourceEventKey) as { seq: number } | undefined;
    if (existing) {
      const receipt = this.v2.appendInCurrentTransaction(receiptInput);
      return { event: { ...source, sequence: receipt.event.seq }, duplicate: true };
    }
    const current = this.db
      .prepare(`SELECT visible FROM conversation_provider_inputs_v2
      WHERE conversation_id = ? AND input_id = ?`)
      .get(input.threadId, input.id) as { visible: number } | undefined;
    if (current?.visible === 0) {
      throw new Error(
        `Provider input ${input.id} was removed by a history change; late updates are rejected.`,
      );
    }
    appendProviderEventToConversationV2(this.v2, source, {
      mode: "runtime",
      sourcePrefix: "provider",
      inCurrentTransaction: true,
      onAppendResult: (result) => results.push(result),
    });
    const receipt = this.v2.appendInCurrentTransaction(receiptInput);
    results.push(receipt);
    if (
      source.eventType === "thinking.final" ||
      (source.eventType === "thinking.delta" && source.streamState === "placeholder")
    ) {
      // A separate notice preserves existing receipt hashes and wakes the renderer even
      // when an empty start creates no message effect. Never emit this per content delta.
      const noticeKey = `thinking-state:${sourceEventKey}`;
      results.push(this.v2.appendInCurrentTransaction({
        conversationId: source.threadId,
        eventId: `thinking_state_${stableHash(noticeKey)}`,
        sourceEventKey: noticeKey,
        type: "noop",
        occurredAt: source.observedAt,
        payload: { reason: "runtime.thinking.changed" },
      }));
    }
    return { event: { ...source, sequence: receipt.event.seq }, duplicate: false };
  }
}

/** Small source identity receipt; cumulative message bodies remain in normalized V2 events only. */
export function conversationV2ProviderReceipt(
  source: ThreadRunEvent,
  prefix: string,
  options: { includeMessageId?: boolean } = {},
): ConversationEventInput {
  const inputHash = stableHash(stripLegacyCompatibilityMarker(source));
  const sourceEventKey = `${prefix}:${source.threadId}:${source.id}:${inputHash}`;
  const messageId = options.includeMessageId === false ? undefined : conversationV2ProviderMessageId(source);
  const { message, ...envelope } = source;
  const storedSource = messageId
    ? {
        ...envelope,
        metadata: { ...envelope.metadata, conversationV2MessageId: messageId },
      }
    : envelope;
  return {
    conversationId: source.threadId,
    eventId: `runtime_input_${stableHash(sourceEventKey)}`,
    sourceEventKey,
    type: "noop",
    occurredAt: source.observedAt,
    ...(source.runAttemptId ? { runId: source.runAttemptId } : {}),
    ...(messageId ? { messageId } : {}),
    payload: { reason: "runtime.input", inputHash, source: storedSource, ...(messageId ? {} : { message }) },
  };
}

function stripLegacyCompatibilityMarker<T extends ThreadRunEvent>(source: T): T {
  if (source.metadata?.legacyCompat !== true) {
    return source;
  }
  const metadata = { ...source.metadata };
  delete metadata.legacyCompat;
  if (Object.keys(metadata).length > 0) {
    return { ...source, metadata };
  }
  const { metadata: _metadata, ...withoutMetadata } = source;
  return withoutMetadata as T;
}
