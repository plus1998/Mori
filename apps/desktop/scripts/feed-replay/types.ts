import {
  CONVERSATION_V2_EFFECT_VERSION,
  type ConversationDetailItem,
  type ConversationRunStatus,
  type ConversationSyncEffect,
  stableHash,
} from "@eco/shared";
import type {
  ThreadPendingFollowUp,
  ThreadRunProjectionRequestSpan,
  ThreadSummary,
} from "../../src/shared/ipc";

export interface FeedReplayEvent extends ConversationSyncEffect {
  at: number;
  eventType: string;
  live?: Record<string, unknown>;
  requestSpans?: ThreadRunProjectionRequestSpan[];
  requestSpanChanges?: {
    upserts: ThreadRunProjectionRequestSpan[];
    removed: string[];
  };
}

export interface FeedReplayFixture {
  formatVersion: 1 | 2;
  protocolVersion: 2;
  exportedAt: string;
  conversationId: string;
  storeEpoch: string;
  thread: ThreadSummary;
  events: FeedReplayEvent[];
  detailItems: ConversationDetailItem[];
  coverage: string[];
  /** Explicit reproduction conditions, not a reconstruction of historical UI state. */
  uiScenario?: {
    pausedFollowUps?: ThreadPendingFollowUp[];
    terminalHeight?: number;
  };
}

export function replayThreadStatus(status?: ConversationRunStatus): ThreadSummary["status"] {
  switch (status) {
    case undefined:
    case "cancelled":
    case "interrupted":
      return "idle";
    case "running":
      return "running";
    case "queued":
      return "queued";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      throw new Error(`Cannot reconstruct thread status from run status: ${status}`);
  }
}

export function validateReplayFixture(value: unknown): asserts value is FeedReplayFixture {
  if (!value || typeof value !== "object") throw new Error("Invalid replay fixture.");
  const fixture = value as FeedReplayFixture;
  if (![1, 2].includes(fixture.formatVersion) || fixture.protocolVersion !== 2) {
    throw new Error("Unsupported replay format/protocol; no legacy fallback is available.");
  }
  if (!fixture.conversationId || !fixture.storeEpoch || fixture.thread?.id !== fixture.conversationId) {
    throw new Error("Replay fixture has an invalid conversation identity.");
  }
  if (
    !Array.isArray(fixture.events) ||
    !fixture.events.length ||
    !Array.isArray(fixture.detailItems) ||
    !Array.isArray(fixture.coverage)
  ) {
    throw new Error("Replay fixture is missing events or detail items.");
  }
  for (const [index, event] of fixture.events.entries()) {
    if (
      !event ||
      event.seq !== index + 1 ||
      !Number.isFinite(event.at) ||
      !event.effect ||
      event.effectVersion !== CONVERSATION_V2_EFFECT_VERSION ||
      stableHash(event.effect) !== event.effectHash
    ) {
      throw new Error(`Invalid or non-contiguous replay event at index ${index}.`);
    }
    if (
      (fixture.formatVersion === 2 && event.requestSpans !== undefined) ||
      (fixture.formatVersion === 1 && event.requestSpanChanges !== undefined)
    ) {
      throw new Error(`Replay span encoding does not match format version at sequence ${event.seq}.`);
    }
    const changes = event.requestSpanChanges;
    if (changes !== undefined) {
      if (!changes || !Array.isArray(changes.upserts) || !Array.isArray(changes.removed))
        throw new Error(`Invalid replay span changes at sequence ${event.seq}.`);
      const ids = new Set<string>();
      for (const span of changes.upserts) {
        if (
          !span ||
          typeof span.requestId !== "string" ||
          !span.requestId ||
          ids.has(span.requestId) ||
          typeof span.startedAt !== "string" ||
          !Number.isFinite(Date.parse(span.startedAt)) ||
          !["waiting_first_token", "streaming", "completed", "failed", "cancelled"].includes(span.status)
        )
          throw new Error(`Invalid or duplicate replay span at sequence ${event.seq}.`);
        ids.add(span.requestId);
      }
      for (const id of changes.removed) {
        if (typeof id !== "string" || !id || ids.has(id))
          throw new Error(`Invalid or duplicate replay span removal at sequence ${event.seq}.`);
        ids.add(id);
      }
    }
  }
  const scenario = fixture.uiScenario;
  if (scenario !== undefined) {
    if (!scenario || typeof scenario !== "object" || Array.isArray(scenario))
      throw new Error("Replay UI scenario must be an object.");
    if (
      scenario.terminalHeight !== undefined &&
      (!Number.isFinite(scenario.terminalHeight) ||
        scenario.terminalHeight < 120 ||
        scenario.terminalHeight > 600)
    ) {
      throw new Error("Replay terminal height must be between 120 and 600.");
    }
    if (
      scenario.pausedFollowUps !== undefined &&
      (!Array.isArray(scenario.pausedFollowUps) ||
        scenario.pausedFollowUps.some(
          (item) =>
            !item ||
            item.threadId !== fixture.conversationId ||
            item.status !== "queued" ||
            !item.id ||
            typeof item.prompt !== "string",
        ))
    ) {
      throw new Error("Replay paused follow-ups must be queued messages in this conversation.");
    }
  }
}
