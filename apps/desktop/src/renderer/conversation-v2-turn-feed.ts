import type { ThreadRunProjectionAttempt, ThreadRunProjectionSnapshot } from "../shared/ipc";
import type {
  ThreadRunProjectionAgentEchoFeedEntry,
  ThreadRunProjectionMainFeedEntry,
  ThreadRunProjectionTimelineFeedEntry,
} from "./conversation-v2-projection-view";
import { isProjectionUserPromptItem, projectionItemToDetailBlock } from "./conversation-v2-projection-view";

export type ThreadRunTurnFeedSection =
  | {
      kind: "entry";
      key: string;
      entry: ThreadRunProjectionMainFeedEntry;
    }
  | {
      /**
       * The live 「正在思考」/「正在写」 line. It is feed content and it must sit
       * **inside** the virtualized geometry: an end-anchored virtualizer can only
       * keep the tail visible for heights it owns, and a row rendered after the
       * virtual window silently pushes the live tail out of the viewport.
       */
      kind: "active-tail";
      key: string;
    }
  | {
      kind: "turn";
      key: string;
      attempt: ThreadRunProjectionAttempt;
      running: boolean;
      /** Output after a prompt inserted into an already running attempt. */
      continuation?: boolean;
      processEntries: ThreadRunProjectionMainFeedEntry[];
      finalEntry?: ThreadRunProjectionMainFeedEntry;
    };

type UserPromptBoundary = {
  sequence: number;
  at: string;
};

/**
 * Group main feed entries into user-prompt boundaries and turn segments.
 *
 * Mid-turn steer inserts a new `thread.user_prompt` mid-attempt. Later agent
 * output must render **after** that prompt (Codex-style). Segments are keyed by
 * (attemptId, last user-prompt sequence before the entry) so same-attempt
 * output cannot remain glued under attempt.startedAt ahead of the mid-turn user.
 */
export function buildThreadRunTurnFeedSections(
  entries: readonly ThreadRunProjectionMainFeedEntry[],
  projection: Pick<ThreadRunProjectionSnapshot, "attempts" | "timeline">,
): ThreadRunTurnFeedSection[] {
  const attempts = [...projection.attempts].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
  const attemptById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  type MutableTurnSection = Extract<ThreadRunTurnFeedSection, { kind: "turn" }> & {
    entries: ThreadRunProjectionMainFeedEntry[];
    afterUserSequence: number;
    boundaryAt?: string;
  };
  type OrderedSection = {
    section: ThreadRunTurnFeedSection;
    at: string;
    sequence: number;
  };

  const userBoundaries: UserPromptBoundary[] = [];
  for (const entry of entries) {
    if (entry.kind === "timeline" && isProjectionUserPromptItem(entry.item)) {
      userBoundaries.push({ sequence: entry.sequence, at: entry.at });
    }
  }
  userBoundaries.sort((left, right) => left.sequence - right.sequence);
  // Queued prompts keep their acceptance sequence after delivery updates `at`.
  // Reordering the queue can therefore invert sequence order and delivery time.
  // Each boundary lookup must walk an index sorted by the clock it compares.
  const userBoundariesByTime = [...userBoundaries].sort(
    (left, right) => left.at.localeCompare(right.at) || left.sequence - right.sequence,
  );

  const sections: OrderedSection[] = [];
  const turnBySegmentKey = new Map<string, MutableTurnSection>();
  const visibleTimelineAttemptIds = new Set(
    projection.timeline.flatMap((item) => (item.runAttemptId?.trim() ? [item.runAttemptId.trim()] : [])),
  );

  for (const entry of entries) {
    if (entry.kind === "timeline" && isProjectionUserPromptItem(entry.item)) {
      sections.push({
        section: { kind: "entry", key: `standalone:${entry.key}`, entry },
        at: entry.at,
        sequence: entry.sequence,
      });
      continue;
    }
    const attempt = resolveEntryAttempt(entry, attempts, attemptById);
    if (!attempt) {
      sections.push({
        section: { kind: "entry", key: `standalone:${entry.key}`, entry },
        at: entry.at,
        sequence: entry.sequence,
      });
      continue;
    }
    const boundary = lastUserBoundaryForEntry(
      shouldUseObservedAtForUserBoundary(entry) ? userBoundariesByTime : userBoundaries,
      entry,
    );
    const afterUserSequence = boundary?.sequence ?? 0;
    const segmentKey = `${attempt.attemptId}#after:${afterUserSequence}`;
    let turn = turnBySegmentKey.get(segmentKey);
    if (!turn) {
      turn = {
        kind: "turn",
        key: `turn:${segmentKey}`,
        attempt,
        running: attempt.status === "running",
        processEntries: [],
        entries: [],
        afterUserSequence,
        ...(boundary ? { boundaryAt: boundary.at } : {}),
      };
      turnBySegmentKey.set(segmentKey, turn);
    }
    turn.entries.push(entry);
  }

  for (const attempt of attempts) {
    const rootKey = `${attempt.attemptId}#after:0`;
    const hasInitialPrompt = userBoundariesByTime.some((boundary) => boundary.at <= attempt.startedAt);
    if (
      attempt.status === "completed" ||
      turnBySegmentKey.has(rootKey) ||
      [...turnBySegmentKey.values()].some(
        (turn) =>
          turn.attempt.attemptId === attempt.attemptId &&
          (attempt.status !== "running" ||
            !hasInitialPrompt ||
            !turn.boundaryAt ||
            turn.boundaryAt <= attempt.startedAt),
      ) ||
      (attempt.status !== "running" && !visibleTimelineAttemptIds.has(attempt.attemptId))
    ) {
      continue;
    }
    // Keep the original heading when the first output arrives only after a
    // mid-turn prompt, instead of moving that heading below the inserted user.
    const turn: MutableTurnSection = {
      kind: "turn",
      key: `turn:${rootKey}`,
      attempt,
      running: attempt.status === "running",
      processEntries: [],
      entries: [],
      afterUserSequence: 0,
    };
    turnBySegmentKey.set(rootKey, turn);
  }

  for (const turn of turnBySegmentKey.values()) {
    const minEntrySequence =
      turn.entries.length > 0
        ? Math.min(...turn.entries.map((entry) => entry.sequence))
        : Number.MAX_SAFE_INTEGER;
    sections.push({
      section: turn,
      // Mid-turn segments sort from the preceding user bubble so steered output
      // cannot jump above the mid-turn prompt via attempt.startedAt.
      at: turn.boundaryAt ?? turn.attempt.startedAt,
      // Stopped skeleton cards have empty agent timelines, so sequence may be 0.
      // Bump past the preceding user prompt (same rule as mobile) so the turn
      // cannot sort above the bubble that opened the segment.
      sequence:
        minEntrySequence === Number.MAX_SAFE_INTEGER
          ? turn.afterUserSequence > 0
            ? turn.afterUserSequence + 1
            : Number.MAX_SAFE_INTEGER
          : turn.afterUserSequence > 0
            ? Math.max(minEntrySequence, turn.afterUserSequence + 1)
            : minEntrySequence,
    });
  }

  sections.sort(compareOrderedSections);

  const seenAttemptIds = new Set<string>();
  return sections.map(({ section }) => {
    if (section.kind !== "turn") {
      return section;
    }
    const matched = [...turnBySegmentKey.values()].find((turn) => turn.key === section.key);
    const turnEntries = matched?.entries ?? [];
    const finalEntry = section.running ? undefined : resolveFinalOutputEntry(turnEntries);
    const continuation = seenAttemptIds.has(section.attempt.attemptId);
    seenAttemptIds.add(section.attempt.attemptId);
    return {
      kind: "turn",
      key: section.key,
      attempt: section.attempt,
      running: section.running,
      continuation,
      processEntries: finalEntry ? turnEntries.filter((entry) => entry.key !== finalEntry.key) : turnEntries,
      ...(finalEntry && { finalEntry }),
    };
  });
}

function lastUserBoundaryForEntry(
  boundaries: readonly UserPromptBoundary[],
  entry: ThreadRunProjectionMainFeedEntry,
): UserPromptBoundary | undefined {
  let found: UserPromptBoundary | undefined;
  const useObservedAt = shouldUseObservedAtForUserBoundary(entry);
  for (const boundary of boundaries) {
    if (useObservedAt) {
      // Stream rows often keep the first-delta sequence across mid-turn user prompts.
      // Wall-clock keeps steered / continued output in the segment after that prompt.
      // Agent cards on the skeleton Feed also need wall-clock: their timeline is
      // cleared, so sequence falls back to 0 and would otherwise open a second
      // empty turn (duplicate "已处理" / stopped headings) for the same attempt.
      if (boundary.at < entry.at) {
        found = boundary;
        continue;
      }
      break;
    }
    if (boundary.sequence < entry.sequence) {
      found = boundary;
      continue;
    }
    break;
  }
  return found;
}

function shouldUseObservedAtForUserBoundary(entry: ThreadRunProjectionMainFeedEntry): boolean {
  if (entry.kind === "agent-card") {
    return true;
  }
  if (entry.kind === "tool-group") {
    return entry.entries.some(isConversationV2FeedEntry);
  }
  if (entry.kind !== "timeline") {
    return false;
  }
  return (
    isConversationV2FeedEntry(entry) ||
    entry.item.eventType === "message.delta" ||
    entry.item.eventType === "message.final" ||
    entry.item.eventType === "thinking.delta" ||
    entry.item.eventType === "thinking.final"
  );
}

/**
 * A row the renderer took from the V2 stream rather than from a legacy row. Its
 * `sequence` is a V2 sequence the legacy skeleton never used, so it can only be
 * placed by wall clock — otherwise a tool row of a live turn resolves to an older
 * prompt's segment and opens a second, empty turn for that attempt above the
 * prompt that actually started it.
 */
function isConversationV2FeedEntry(
  entry: ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry,
): boolean {
  return entry.kind === "timeline" && entry.item.id.startsWith("conversation-v2:");
}

function compareOrderedSections(
  left: { section: ThreadRunTurnFeedSection; at: string; sequence: number },
  right: { section: ThreadRunTurnFeedSection; at: string; sequence: number },
): number {
  const atDiff = left.at.localeCompare(right.at);
  if (atDiff !== 0) {
    return atDiff;
  }
  const sequenceDiff = left.sequence - right.sequence;
  if (sequenceDiff !== 0) {
    return sequenceDiff;
  }
  if (left.section.kind !== right.section.kind) {
    // Same timestamp/sequence: user entry before the turn it opens.
    return left.section.kind === "entry" ? -1 : 1;
  }
  return left.section.key.localeCompare(right.section.key);
}

function resolveEntryAttempt(
  entry: ThreadRunProjectionMainFeedEntry,
  attempts: readonly ThreadRunProjectionAttempt[],
  attemptById: ReadonlyMap<string, ThreadRunProjectionAttempt>,
): ThreadRunProjectionAttempt | undefined {
  const explicitId = readEntryAttemptId(entry);
  if (explicitId) {
    const explicit = attemptById.get(explicitId);
    if (explicit) return explicit;
  }
  const at = entry.at;
  let candidate: ThreadRunProjectionAttempt | undefined;
  for (const attempt of attempts) {
    if (attempt.startedAt > at) break;
    candidate = attempt;
  }
  return candidate;
}

function readEntryAttemptId(entry: ThreadRunProjectionMainFeedEntry): string | undefined {
  if (entry.kind === "timeline" || entry.kind === "agent-echo") {
    return entry.item.runAttemptId?.trim() || undefined;
  }
  if (entry.kind === "tool-group") {
    for (const child of entry.entries) {
      const attemptId = child.item.runAttemptId?.trim();
      if (attemptId) return attemptId;
    }
    return undefined;
  }
  return entry.card.agent.runAttemptId?.trim() || undefined;
}

function resolveFinalOutputEntry(
  entries: readonly ThreadRunProjectionMainFeedEntry[],
): ThreadRunProjectionMainFeedEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== "timeline" || entry.item.eventType !== "message.final") {
      continue;
    }
    if (entry.item.role === "user" || entry.item.role === "tool" || entry.item.role === "thinking") {
      continue;
    }
    const block = projectionItemToDetailBlock(entry.item);
    if (block?.kind === "narrative" && !block.streaming && block.text.trim()) {
      return entry;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== "timeline") continue;
    const block = projectionItemToDetailBlock(entry.item);
    if (block?.kind === "api-error" || block?.kind === "tool-failed") {
      return entry;
    }
  }
  return undefined;
}
