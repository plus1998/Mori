import { describe, expect, test } from "bun:test";
import { Virtualizer } from "@tanstack/react-virtual";
import type { ThreadRunTurnFeedSection } from "../src/renderer/conversation-v2-turn-feed";
import {
  createFeedSectionKeySelector,
  estimateSectionSize,
  FEED_VIRTUALIZE_MIN_SECTIONS,
  findFeedSectionIndexForAnchor,
  followEndAnchoredScroll,
  isThreadPromptAnchorId,
  listUserMessageAnchorsFromSections,
  recordMeasuredSectionSize,
} from "../src/renderer/feed-virtual-sections";

describe("Feed measurement corrections", () => {
  function scrollFixture(scrollTop: number, scrollHeight: number) {
    const writes: ScrollToOptions[] = [];
    const element = {
      scrollTop,
      scrollHeight,
      clientHeight: 700,
      scrollTo: (options: ScrollToOptions) => writes.push(options),
    } as HTMLElement;
    return { writes, instance: { scrollElement: element, options: { anchorTo: "end" as const } } };
  }

  test("simultaneous row changes cannot detach a following reader outside the distance band", () => {
    const { writes, instance } = scrollFixture(1500, 2600);
    followEndAnchoredScroll(1500, { adjustments: 180 }, instance, true);
    expect(writes).toEqual([{ top: 1900 }]);
  });

  test("a cancelled turn's shrink uses the DOM end already clamped by the browser", () => {
    const { writes, instance } = scrollFixture(1300, 2000);
    followEndAnchoredScroll(1900, { adjustments: -1000 }, instance, true);
    expect(writes).toEqual([{ top: 1300 }]);
  });

  test("history reading and explicit navigation retain their requested offsets", () => {
    const { writes, instance } = scrollFixture(900, 2600);
    followEndAnchoredScroll(900, { adjustments: 80 }, instance, false);
    followEndAnchoredScroll(300, { behavior: "smooth" }, instance, true);
    expect(writes).toEqual([{ top: 980 }, { top: 300, behavior: "smooth" }]);
  });
});

function timelineEntry(id: string, text = "hi"): ThreadRunTurnFeedSection {
  return {
    kind: "entry",
    key: `standalone:timeline:${id}`,
    entry: {
      kind: "timeline",
      key: `timeline:${id}`,
      at: "2026-01-01T00:00:00.000Z",
      sequence: 1,
      item: {
        id,
        at: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        eventType: "thread.user_prompt",
        text,
        contentLoaded: true,
        metadata: { liveType: "thread.user_prompt" },
      },
    },
  };
}

describe("feed-virtual-sections", () => {
  test("virtualize threshold stays stable", () => {
    expect(FEED_VIRTUALIZE_MIN_SECTIONS).toBeGreaterThanOrEqual(8);
  });

  test("thread prompt anchors are recognized", () => {
    expect(isThreadPromptAnchorId("thread:abc")).toBe(true);
    expect(isThreadPromptAnchorId("evt_1")).toBe(false);
  });

  test("findFeedSectionIndexForAnchor matches user prompt item ids", () => {
    const sections: ThreadRunTurnFeedSection[] = [
      timelineEntry("u1"),
      timelineEntry("u2"),
      {
        kind: "turn",
        key: "turn:a",
        attempt: {
          attemptId: "a",
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
        },
        running: false,
        processEntries: [],
        finalEntry: {
          kind: "timeline",
          key: "timeline:final",
          at: "2026-01-01T00:00:01.000Z",
          sequence: 3,
          item: {
            id: "final-1",
            at: "2026-01-01T00:00:01.000Z",
            sequence: 3,
            eventType: "message.assistant",
            text: "done",
            contentLoaded: true,
          },
        },
      },
    ];
    expect(findFeedSectionIndexForAnchor(sections, "u2")).toBe(1);
    expect(findFeedSectionIndexForAnchor(sections, "final-1")).toBe(2);
    expect(findFeedSectionIndexForAnchor(sections, "missing")).toBe(-1);
    expect(findFeedSectionIndexForAnchor(sections, "thread:x")).toBe(-1);
  });

  test("listUserMessageAnchorsFromSections only lists user prompts", () => {
    const sections: ThreadRunTurnFeedSection[] = [
      timelineEntry("u1"),
      {
        kind: "turn",
        key: "turn:a",
        attempt: {
          attemptId: "a",
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
        },
        running: false,
        processEntries: [],
      },
      timelineEntry("u2"),
    ];
    expect(listUserMessageAnchorsFromSections(sections)).toEqual([
      { anchorId: "u1", sectionIndex: 0 },
      { anchorId: "u2", sectionIndex: 2 },
    ]);
  });
});

describe("virtualizer key invalidation", () => {
  function virtualizerFor(sections: readonly ThreadRunTurnFeedSection[]) {
    const selectKeys = createFeedSectionKeySelector();
    const virtualizer = new Virtualizer<HTMLElement, Element>({
      count: sections.length,
      getScrollElement: () => null,
      getItemKey: selectKeys(sections),
      estimateSize: () => 100,
      initialRect: { width: 600, height: 400 },
      scrollToFn: () => {},
      observeElementRect: () => {},
      observeElementOffset: () => {},
    });
    return { virtualizer, selectKeys };
  }

  test("text-only updates preserve measured sizes and the key callback", () => {
    const sections = [
      timelineEntry("key-first"),
      timelineEntry("key-middle"),
      timelineEntry("key-last"),
    ] as const;
    const { virtualizer, selectKeys } = virtualizerFor(sections);
    virtualizer.getTotalSize();
    virtualizer.resizeItem(1, 240);
    const previous = virtualizer.options.getItemKey;
    const getItemKey = selectKeys(sections.map((section) => ({ ...section })));
    virtualizer.setOptions({ ...virtualizer.options, getItemKey });
    expect(getItemKey).toBe(previous);
    expect(virtualizer.getVirtualItems()[1]?.size).toBe(240);
    expect(virtualizer.getTotalSize()).toBe(440);
  });

  test("same-count middle replacement discards the old row's measured geometry", () => {
    const sections = [
      timelineEntry("key-first"),
      timelineEntry("key-middle"),
      timelineEntry("key-last"),
    ] as const;
    const { virtualizer, selectKeys } = virtualizerFor(sections);
    virtualizer.getTotalSize();
    virtualizer.resizeItem(1, 240);
    const previous = virtualizer.options.getItemKey;
    virtualizer.setOptions({
      ...virtualizer.options,
      getItemKey: selectKeys([sections[0], timelineEntry("key-replacement"), sections[2]]),
    });
    expect(previous(1)).toBe("standalone:timeline:key-middle");
    expect(virtualizer.getVirtualItems()[1]?.key).toBe("standalone:timeline:key-replacement");
    expect(virtualizer.getVirtualItems()[1]?.size).toBe(100);
    expect(virtualizer.getTotalSize()).toBe(300);
  });

  test("same-count reorder moves measured sizes with the corresponding keys", () => {
    const sections = [
      timelineEntry("key-first"),
      timelineEntry("key-a"),
      timelineEntry("key-b"),
      timelineEntry("key-last"),
    ] as const;
    const { virtualizer, selectKeys } = virtualizerFor(sections);
    virtualizer.getTotalSize();
    virtualizer.resizeItem(1, 240);
    virtualizer.resizeItem(2, 160);
    virtualizer.setOptions({
      ...virtualizer.options,
      getItemKey: selectKeys([sections[0], sections[2], sections[1], sections[3]]),
    });
    const rows = virtualizer.getVirtualItems();
    expect(rows[1]?.key).toBe("standalone:timeline:key-b");
    expect(rows[1]?.size).toBe(160);
    expect(rows[2]?.key).toBe("standalone:timeline:key-a");
    expect(rows[2]?.size).toBe(240);
    expect(rows[2]?.start).toBe(260);
  });
});

function turnSection(processCount: number): ThreadRunTurnFeedSection {
  return {
    kind: "turn",
    key: `turn:shape-${processCount}`,
    attempt: {
      attemptId: `a${processCount}`,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
    },
    running: false,
    processEntries: Array.from({ length: processCount }, (_, index) => ({
      kind: "timeline",
      key: `timeline:p${processCount}-${index}`,
      at: "2026-01-01T00:00:00.000Z",
      sequence: index + 1,
      item: {
        id: `p${processCount}-${index}`,
        at: "2026-01-01T00:00:00.000Z",
        sequence: index + 1,
        eventType: "agent.tool_call",
        text: "tool",
        contentLoaded: true,
        metadata: { liveType: "agent.tool_call" },
      },
    })),
  } as ThreadRunTurnFeedSection;
}

describe("learned row estimates", () => {
  test("a measured shape bucket replaces its static estimate", () => {
    const turn = turnSection(11);
    const before = estimateSectionSize(turn);
    for (let index = 0; index < 4; index += 1) {
      recordMeasuredSectionSize(turn, 1_400);
    }
    const after = estimateSectionSize(turn);
    expect(before).toBe(508);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(1_400);
  });

  test("unusable measurements are ignored and outliers are clamped", () => {
    const turn = turnSection(12);
    for (const size of [0, -40, Number.NaN]) {
      recordMeasuredSectionSize(turn, size);
    }
    expect(estimateSectionSize(turn)).toBe(508);
    recordMeasuredSectionSize(turn, 99_999);
    expect(estimateSectionSize(turn)).toBeLessThanOrEqual(4_000);
  });

  test("buckets stay separate per turn shape", () => {
    const wide = turnSection(13);
    const narrow = turnSection(14);
    recordMeasuredSectionSize(wide, 2_000);
    expect(estimateSectionSize(wide)).toBe(2_000);
    expect(estimateSectionSize(narrow)).toBe(508);
  });

  test("a streaming row never moves the estimate of its shape", () => {
    // The live turn grows on every ResizeObserver tick. Folding those heights
    // back into the shared bucket re-estimates every unmeasured row of the same
    // shape, which moves totalSize — and the virtual boundary — every frame.
    const shape = 15;
    const settled = { ...turnSection(shape), key: "turn:settled-15" };
    recordMeasuredSectionSize(settled, 900);
    const baseline = estimateSectionSize(settled);
    for (let height = 900; height <= 4_000; height += 50) {
      recordMeasuredSectionSize({ ...turnSection(shape), key: "turn:live-15", running: true }, height);
    }
    expect(estimateSectionSize(settled)).toBe(baseline);
  });

  test("one row is one shape sample, so re-measuring it cannot churn the estimate", () => {
    const row = { ...turnSection(16), key: "turn:repeat-16" };
    recordMeasuredSectionSize(row, 1_000);
    const baseline = estimateSectionSize(row);
    for (const height of [1_000, 1_050, 980, 1_200]) {
      recordMeasuredSectionSize(row, height);
    }
    expect(estimateSectionSize(row)).toBe(baseline);
  });

  test("the bucket estimate settles instead of chasing every sample", () => {
    const shape = 17;
    for (let index = 0; index < 12; index += 1) {
      recordMeasuredSectionSize({ ...turnSection(shape), key: `turn:converge-${index}` }, 1_000);
    }
    const settled = estimateSectionSize(turnSection(shape));
    recordMeasuredSectionSize({ ...turnSection(shape), key: "turn:converge-outlier" }, 1_400);
    const afterOutlier = estimateSectionSize(turnSection(shape));
    expect(settled).toBe(1_000);
    // A cumulative mean moves by one sample's share, not by 40% of the gap.
    expect(afterOutlier - settled).toBeLessThanOrEqual(31);
  });
});
