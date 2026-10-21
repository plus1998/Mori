import { describe, expect, test } from "vitest";
import {
  shouldRebuildFeedSkeletonForEmptyTimeline,
  shouldRebuildFeedSkeletonForOrphanAgentEvents,
  shouldRebuildFeedSkeletonForTruncatedUserPrompts,
} from "../src/main/legacy-feed-skeleton-detectors";
import { isFeedMainTimelineEvent } from "../src/main/legacy-feed-skeleton-timeline-items";
import type { ThreadRunProjectionTimelineItem } from "../src/shared/conversation-v2-projection";
import type { ThreadRunEvent } from "../src/shared/ipc";
import {
  CORPUS_AGENT_ID,
  CORPUS_ATTEMPT_ID,
  CORPUS_THREAD_ID,
  corpusAgentInstance,
  corpusAttemptRecord,
  eventFromShape,
  generateStream,
  loadObservedShapeFile,
  type ObservedEventShape,
  rebuildFeedTimeline,
} from "./helpers/feed-parity-corpus";

function event(overrides: Partial<ThreadRunEvent> & Pick<ThreadRunEvent, "id">): ThreadRunEvent {
  return {
    threadId: CORPUS_THREAD_ID,
    sequence: 1,
    eventType: "message.final",
    scope: "main",
    streamState: "finalized",
    message: "text",
    observedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function promptItem(id: string, text: string): ThreadRunProjectionTimelineItem {
  return {
    id,
    sequence: 1,
    eventType: "message.final",
    scope: "main",
    role: "user",
    text,
    at: "2026-01-01T00:00:01.000Z",
    metadata: { liveType: "thread.user_prompt" },
  };
}

describe("feed skeleton rebuild detectors", () => {
  test("promoted orphan agent rows force exactly one rebuild", () => {
    const orphan = event({
      id: "agent_body",
      scope: "agent",
      agentId: "agent_missing",
      role: "main",
      message: "orphan body",
    });
    const input = {
      events: [orphan],
      timeline: [] as ThreadRunProjectionTimelineItem[],
      knownAgentIds: [] as string[],
    };
    expect(shouldRebuildFeedSkeletonForOrphanAgentEvents(input)).toBe(true);
    // The rebuilt skeleton contains the promoted row, so the detector cannot fire again.
    const promotedTimeline = rebuildFeedTimeline([orphan], [corpusAttemptRecord("completed")], {
      agents: [],
    });
    expect(promotedTimeline.some((item) => item.scope !== "agent")).toBe(true);
    expect(
      shouldRebuildFeedSkeletonForOrphanAgentEvents({
        events: [orphan],
        timeline: promotedTimeline,
        knownAgentIds: [],
      }),
    ).toBe(false);
    // A registered agent instance is not an orphan.
    expect(
      shouldRebuildFeedSkeletonForOrphanAgentEvents({
        events: [{ ...orphan, agentId: CORPUS_AGENT_ID }],
        timeline: [],
        knownAgentIds: [CORPUS_AGENT_ID],
      }),
    ).toBe(false);
    // Rows without an agent id, and non-assistant rows, are ignored.
    expect(
      shouldRebuildFeedSkeletonForOrphanAgentEvents({
        events: [{ ...orphan, agentId: undefined }],
        timeline: [],
        knownAgentIds: [],
      }),
    ).toBe(false);
    expect(
      shouldRebuildFeedSkeletonForOrphanAgentEvents({
        events: [{ ...orphan, eventType: "agent.started" }],
        timeline: [],
        knownAgentIds: [],
      }),
    ).toBe(false);
  });

  test("empty timelines force a rebuild only for a skeleton built without events", () => {
    const base = { timeline: [] as ThreadRunProjectionTimelineItem[], sourceEventCount: 0 };
    // The poison this detector exists for: the DB has events, the skeleton was built from
    // an empty event read (projection cache wiped).
    expect(shouldRebuildFeedSkeletonForEmptyTimeline({ ...base, hasFeedVisibleEvent: true }, 12)).toBe(true);
    // No cursor yet, or no feed-visible row at all: nothing to heal.
    expect(shouldRebuildFeedSkeletonForEmptyTimeline({ ...base, hasFeedVisibleEvent: true }, 0)).toBe(false);
    expect(
      shouldRebuildFeedSkeletonForEmptyTimeline(
        { ...base, hasFeedVisibleEvent: false, sourceEventCount: 9 },
        42,
      ),
    ).toBe(false);
    // The builder did read events; the selection kept nothing. A rebuild would be empty as
    // well, so rebuilding here would repeat on every load.
    expect(
      shouldRebuildFeedSkeletonForEmptyTimeline(
        { timeline: [], sourceEventCount: 9, hasFeedVisibleEvent: true },
        42,
      ),
    ).toBe(false);
    expect(
      shouldRebuildFeedSkeletonForEmptyTimeline(
        { timeline: [promptItem("p", "hi")], sourceEventCount: 0, hasFeedVisibleEvent: true },
        12,
      ),
    ).toBe(false);
  });

  test("truncated user prompts force a rebuild until the fix is applied", () => {
    expect(shouldRebuildFeedSkeletonForTruncatedUserPrompts([promptItem("p", "hi")])).toBe(false);
    expect(
      shouldRebuildFeedSkeletonForTruncatedUserPrompts([
        { ...promptItem("p", "hi"), metadata: { liveType: "thread.user_prompt", textTruncated: true } },
      ]),
    ).toBe(true);
    // A truncated assistant body is not a user prompt and must not trigger the rebuild.
    expect(
      shouldRebuildFeedSkeletonForTruncatedUserPrompts([
        {
          ...promptItem("a", "body"),
          role: "main",
          metadata: { liveType: "message.final", textTruncated: true },
        },
      ]),
    ).toBe(false);
  });

  test("a freshly rebuilt skeleton never re-triggers any detector", () => {
    // Loop freedom: the detectors run on every projection emit, so firing again after a
    // rebuild would rebuild on every emit.
    const shapes = loadObservedShapeFile().shapes;
    for (let seed = 1; seed <= 30; seed += 1) {
      const stream = generateStream({
        seed: seed * 5,
        shapes,
        count: 20,
        finalStatus: seed % 2 === 0 ? "completed" : "cancelled",
      });
      const attempts = [corpusAttemptRecord(stream.finalStatus)];
      const timeline = rebuildFeedTimeline(stream.events, attempts, {
        agents: [corpusAgentInstance()],
      });
      // Note: an empty rebuilt feed is legitimate (no feed-visible row at all, or a finished
      // attempt whose selection keeps nothing) — it is exactly what the next load would
      // rebuild, so the assertions below must hold for it too.
      expect(
        shouldRebuildFeedSkeletonForOrphanAgentEvents({
          events: stream.events,
          timeline,
          knownAgentIds: [CORPUS_AGENT_ID],
        }),
        `seed ${seed} orphan`,
      ).toBe(false);
      expect(
        shouldRebuildFeedSkeletonForEmptyTimeline(
          {
            timeline,
            sourceEventCount: stream.events.length,
            hasFeedVisibleEvent: stream.events.some(isFeedMainTimelineEvent),
          },
          stream.events.length,
        ),
        `seed ${seed} empty`,
      ).toBe(false);
      expect(shouldRebuildFeedSkeletonForTruncatedUserPrompts(timeline), `seed ${seed} truncated`).toBe(
        false,
      );

      // A stream with only agent-scoped rows legitimately has an empty main timeline; the
      // detector must not treat that as poison (it would rebuild on every emit).
      const agentOnly = stream.events.filter((item) => item.scope === "agent");
      if (agentOnly.length > 0) {
        expect(
          shouldRebuildFeedSkeletonForEmptyTimeline(
            {
              timeline: [],
              sourceEventCount: agentOnly.length,
              hasFeedVisibleEvent: agentOnly.some(isFeedMainTimelineEvent),
            },
            agentOnly.length,
          ),
          `seed ${seed} agent-only`,
        ).toBe(false);
      }
    }
  });

  test("orphan agent shapes from real data are the ones the detector watches", () => {
    const shapeFile = loadObservedShapeFile();
    expect(shapeFile.threadsWithOrphanAgentRows).toBeGreaterThan(0);
    const agentShape = shapeFile.shapes.find(
      (shape) => shape.scope === "agent" && shape.hasAgentId && shape.eventType === "message.final",
    );
    expect(agentShape).toBeDefined();
    const agentEvent = eventFromShape(agentShape as ObservedEventShape, {
      sequence: 1,
      attemptId: CORPUS_ATTEMPT_ID,
    });
    expect(
      shouldRebuildFeedSkeletonForOrphanAgentEvents({
        events: [agentEvent],
        timeline: [],
        knownAgentIds: [],
      }),
    ).toBe(true);
  });
});
