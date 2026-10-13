import { useVirtualizer, type VirtualItem, type VirtualizerOptions } from "@tanstack/react-virtual";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isProjectionUserPromptItem } from "./conversation-v2-projection-view";
import type { ThreadRunTurnFeedSection } from "./conversation-v2-turn-feed";

/** Below this count, mount everything — virtualization overhead is not worth it. */
export const FEED_VIRTUALIZE_MIN_SECTIONS = 12;

/**
 * Distance from the end that still counts as "reading the live tail". The Feed's
 * stick-to-bottom follow in App.tsx uses the same number, so the library and the
 * follow writer agree on when the reader has left the bottom.
 */
export const FEED_END_ANCHOR_THRESHOLD_PX = 120;

export const FEED_SCROLL_TO_ANCHOR_EVENT = "eco:feed-scroll-to-anchor";

export type FeedScrollToAnchorDetail = {
  anchorId: string;
};

const ESTIMATE_TURN_PX = 220;
const ESTIMATE_ENTRY_PX = 140;
const ESTIMATE_ACTIVE_TAIL_PX = 56;
const OVERSCAN = 6;

const ESTIMATE_TOOL_ENTRY_PX = 36;

/**
 * A turn row in a real feed measures 700–1800px, while the static estimate
 * caps at 508. Under-estimating is what makes the model's total size churn by
 * ~200px per row as the reader scrolls into unmeasured history, and every
 * churn is a chance for the viewport to lurch. Each shape bucket therefore
 * learns its own average from what it has already measured.
 */
const LEARNED_ESTIMATE_BUCKETS = 48;
const LEARNED_ESTIMATE_MIN_PX = 40;
const LEARNED_ESTIMATE_MAX_PX = 4_000;
const learnedSectionSizes = new Map<string, number>();
const learnedSectionSamples = new Map<string, number>();
/** Section keys already folded into a bucket, so one row is one shape sample. */
const learnedEstimateSampleKeys = new Set<string>();
const LEARNED_ESTIMATE_SAMPLE_KEYS = 1_024;

/** Keep callbacks stable for text updates, but capture a new key snapshot for structural changes. */
export function createFeedSectionKeySelector() {
  let keys: readonly string[] = [];
  let getItemKey = (index: number): string | number => index;
  return (sections: readonly ThreadRunTurnFeedSection[]) => {
    if (keys.length !== sections.length || sections.some((section, index) => section.key !== keys[index])) {
      const nextKeys = sections.map((section) => section.key);
      keys = nextKeys;
      // Previous callbacks must retain their old snapshot for virtual-core's anchor lookup.
      getItemKey = (index: number) => nextKeys[index] ?? index;
    }
    return getItemKey;
  };
}

function sectionEstimateKey(section: ThreadRunTurnFeedSection): string {
  if (section.kind === "active-tail") {
    return "active-tail";
  }
  if (section.kind !== "turn") {
    return "entry";
  }
  return `turn:${Math.min(section.processEntries.length, 16)}`;
}

function staticEstimateSectionSize(section: ThreadRunTurnFeedSection): number {
  if (section.kind === "turn") {
    return ESTIMATE_TURN_PX + Math.min(section.processEntries.length, 8) * ESTIMATE_TOOL_ENTRY_PX;
  }
  if (section.kind === "active-tail") {
    return ESTIMATE_ACTIVE_TAIL_PX;
  }
  return ESTIMATE_ENTRY_PX;
}

/** Padding the scroll element carries itself, which the virtual model cannot see. */
type FeedScrollPadding = { start: number; end: number };

function readScrollPadding(element: HTMLElement): FeedScrollPadding {
  const style = getComputedStyle(element);
  return {
    start: Number.parseFloat(style.paddingTop) || 0,
    end: Number.parseFloat(style.paddingBottom) || 0,
  };
}

export function estimateSectionSize(section: ThreadRunTurnFeedSection): number {
  return learnedSectionSizes.get(sectionEstimateKey(section)) ?? staticEstimateSectionSize(section);
}

export type FrozenSectionEstimator = (section: ThreadRunTurnFeedSection) => number;

/** Cap on frozen estimates per mounted Feed (evicted oldest-first). */
const FROZEN_ESTIMATE_KEYS = 4_096;

/**
 * Give each section one estimate for its lifetime in the model.
 *
 * The shape buckets learn, so `estimateSectionSize` alone is not a function of
 * the section: measuring any row nudges the average and therefore rewrites the
 * estimate of every unmeasured row of that shape. `getTotalSize()` follows, and
 * an end-anchored virtualizer treats that as a real content change — `resizeItem`
 * compensates `scrollTop` by the delta even though no DOM box changed size. The
 * viewport lifts off the bottom by exactly that delta, the live tail drops into
 * the Composer's mask band, and because the next measurement nudges the bucket
 * again the two states oscillate. Measured against the running app: writes of
 * `maxScrollTop − 41` from `applyScrollAdjustment` while `scrollHeight` stayed
 * flat, repeating every few hundred milliseconds.
 *
 * Freezing per key keeps the buckets useful (rows that enter the model later
 * start from what has already been measured) while making the model monotonic:
 * only a real measurement of a row can change that row's size.
 */
export function createFrozenSectionEstimator(): FrozenSectionEstimator {
  const frozen = new Map<string, number>();
  return (section) => {
    const cached = frozen.get(section.key);
    if (cached !== undefined) {
      return cached;
    }
    const size = estimateSectionSize(section);
    if (frozen.size >= FROZEN_ESTIMATE_KEYS) {
      const oldest = frozen.keys().next();
      if (!oldest.done) {
        frozen.delete(oldest.value);
      }
    }
    frozen.set(section.key, size);
    return size;
  };
}

/**
 * Fold one measured row height into its shape bucket's average.
 *
 * Two rules keep the estimate from feeding the churn it exists to absorb: a row
 * contributes at most one sample, and a row that is still streaming contributes
 * none. Otherwise a growing turn row re-averages its own bucket on every
 * ResizeObserver tick, which moves the estimate of every *unmeasured* row,
 * which moves `getTotalSize()`, which moves the spacers — and the virtual
 * window then re-derives its boundary from geometry that just moved.
 */
export function recordMeasuredSectionSize(section: ThreadRunTurnFeedSection, size: number): void {
  if (!(size > 0) || !Number.isFinite(size)) {
    return;
  }
  if (section.kind === "turn" && section.running) {
    return;
  }
  if (learnedEstimateSampleKeys.has(section.key)) {
    return;
  }
  learnedEstimateSampleKeys.add(section.key);
  while (learnedEstimateSampleKeys.size > LEARNED_ESTIMATE_SAMPLE_KEYS) {
    const oldest = learnedEstimateSampleKeys.values().next();
    if (oldest.done) {
      break;
    }
    learnedEstimateSampleKeys.delete(oldest.value);
  }
  const clamped = Math.min(LEARNED_ESTIMATE_MAX_PX, Math.max(LEARNED_ESTIMATE_MIN_PX, size));
  const key = sectionEstimateKey(section);
  const previous = learnedSectionSizes.get(key);
  const samples = learnedSectionSamples.get(key) ?? 0;
  const next =
    previous === undefined ? Math.round(clamped) : Math.round((previous * samples + clamped) / (samples + 1));
  learnedSectionSamples.set(key, samples + 1);
  learnedSectionSizes.delete(key);
  learnedSectionSizes.set(key, next);
  while (learnedSectionSizes.size > LEARNED_ESTIMATE_BUCKETS) {
    const oldest = learnedSectionSizes.keys().next();
    if (oldest.done) {
      break;
    }
    learnedSectionSizes.delete(oldest.value);
    learnedSectionSamples.delete(oldest.value);
  }
}

function sectionContainsUserAnchor(section: ThreadRunTurnFeedSection, anchorId: string): boolean {
  if (section.kind === "entry") {
    if (section.entry.kind === "timeline" && section.entry.item.id === anchorId) {
      return true;
    }
    return section.entry.key === anchorId || section.key === `standalone:${anchorId}`;
  }
  if (section.kind === "active-tail") {
    return false;
  }
  if (section.finalEntry?.kind === "timeline" && section.finalEntry.item.id === anchorId) {
    return true;
  }
  return section.processEntries.some((entry) => {
    if (entry.kind === "timeline" && entry.item.id === anchorId) {
      return true;
    }
    return entry.key === anchorId;
  });
}

export function isThreadPromptAnchorId(anchorId: string): boolean {
  return anchorId.startsWith("thread:");
}

export function findFeedSectionIndexForAnchor(
  sections: readonly ThreadRunTurnFeedSection[],
  anchorId: string,
): number {
  const trimmed = anchorId.trim();
  if (!trimmed || isThreadPromptAnchorId(trimmed)) {
    return -1;
  }
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (!section) {
      continue;
    }
    if (sectionContainsUserAnchor(section, trimmed)) {
      return index;
    }
    // User prompts are standalone timeline entries — also match by prompt item helper.
    if (
      section.kind === "entry" &&
      section.entry.kind === "timeline" &&
      isProjectionUserPromptItem(section.entry.item) &&
      section.entry.item.id === trimmed
    ) {
      return index;
    }
  }
  return -1;
}

export function listUserMessageAnchorsFromSections(
  sections: readonly ThreadRunTurnFeedSection[],
): Array<{ anchorId: string; sectionIndex: number }> {
  const anchors: Array<{ anchorId: string; sectionIndex: number }> = [];
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex];
    if (!section || section.kind !== "entry") {
      continue;
    }
    if (section.entry.kind !== "timeline" || !isProjectionUserPromptItem(section.entry.item)) {
      continue;
    }
    const anchorId = section.entry.item.id.trim();
    if (!anchorId) {
      continue;
    }
    anchors.push({ anchorId, sectionIndex });
  }
  return anchors;
}

/**
 * Zero-size stand-ins so messages-nav active/jump keep working when the real
 * user-prompt row is virtualized out of the DOM.
 */
export function FeedVirtualUserMessageSentinels(props: {
  anchors: readonly { anchorId: string; sectionIndex: number }[];
  mountedSectionIndexes: ReadonlySet<number>;
  /** Virtual item.start values include scrollMargin (= header offset inside run-log). */
  resolveSectionTopPx: (sectionIndex: number) => number;
}): ReactNode {
  const { anchors, mountedSectionIndexes, resolveSectionTopPx } = props;
  if (anchors.length === 0) {
    return null;
  }
  return (
    <>
      {anchors.map((anchor) => {
        if (mountedSectionIndexes.has(anchor.sectionIndex)) {
          return null;
        }
        return (
          <div
            key={`virtual-anchor:${anchor.anchorId}`}
            className="run-log-virtual-anchor"
            data-user-message-anchor-id={anchor.anchorId}
            data-virtual-anchor="true"
            aria-hidden
            style={{ top: resolveSectionTopPx(anchor.sectionIndex) }}
          />
        );
      })}
    </>
  );
}

/**
 * Where the Feed's measurement-driven scroll corrections land.
 *
 * With `anchorTo: "end"`, `resizeItem` keeps the viewport pinned by adding a
 * A per-item delta only equals what the element actually did when that row was
 * the only thing that changed. The Feed breaks that assumption constantly: the
 * live tail row appears and disappears while the streaming row above it loses
 * the same height, thinking blocks collapse when a turn ends, and sections get
 * appended in the same commit. The element's height then moves by the net of
 * several deltas while each correction applies one of them, and the viewport
 * ends up that far from the end. Measured against the running app:
 * `applyScrollAdjustment` writing `maxScrollTop − 42` while `scrollHeight`
 * stayed flat, leaving the live tail row 42px below the fold for seconds at a
 * time — the same shape as upstream TanStack/virtual#1297, where the end anchor
 * misses a shrink instead of a growth.
 *
 * So while the reader is inside the stick band, a correction re-pins to the
 * element's real end rather than trusting the accumulated delta: growth lands on
 * it, a shrink the browser already absorbed becomes a no-op, and a frame that
 * grew and shrank at once lands on it too. Outside the band the reader is
 * reading history, and the per-item delta is exactly what keeps their place.
 * Commands (`scrollToIndex`, `scrollToOffset`, `scrollToEnd`) carry no
 * adjustments and keep using the model, which now matches the element because
 * `paddingStart` / `paddingEnd` are modelled.
 */
function followEndAnchoredScroll(
  offset: number,
  options: { adjustments?: number; behavior?: ScrollBehavior },
  instance: { scrollElement: HTMLElement | null; options: { anchorTo?: "start" | "end" } },
  followEnd: boolean,
): void {
  const element = instance.scrollElement;
  if (!element) {
    return;
  }
  const adjustments = options.adjustments ?? 0;
  const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
  const insideStickBand =
    followEnd &&
    instance.options.anchorTo === "end" &&
    adjustments !== 0 &&
    maxTop - element.scrollTop <= FEED_END_ANCHOR_THRESHOLD_PX;
  element.scrollTo({
    top: insideStickBand ? maxTop : offset + adjustments,
    ...(options.behavior ? { behavior: options.behavior } : null),
  });
}

export function useFeedSectionVirtualizer(input: {
  sections: readonly ThreadRunTurnFeedSection[];
  enabled: boolean;
  /** Explicit user intent overrides the virtualizer's near-end distance heuristic. */
  userDetached?: boolean;
  runLogRef: RefObject<HTMLElement | null>;
  /** Element above the virtualized rows (e.g. thread prompt) inside the same scroll parent. */
  headerRef: RefObject<HTMLElement | null>;
}) {
  const { sections, enabled, userDetached = false, runLogRef, headerRef } = input;
  const count = sections.length;
  const [scrollMargin, setScrollMargin] = useState(0);

  const getScrollElement = useCallback(() => {
    const runLog = runLogRef.current;
    if (!runLog) {
      return null;
    }
    return runLog.closest(".activity-messages") as HTMLElement | null;
  }, [runLogRef]);

  /**
   * The Feed reserves the Composer's band as padding on the scroll element
   * itself (`padding-bottom: mask + overlays + 32`), and that reservation grows
   * whenever the Composer stacks overlays. virtual-core only knows about item
   * boxes, so left alone it places "the end" `padding-top + padding-bottom`
   * above the element's real scroll end: `scrollToEnd`, `followOnAppend` and
   * `isAtEnd` all land that far short, and the newest row sits inside the band
   * the padding exists to keep clear. Measured live: `getTotalSize()` trailed
   * `scrollHeight` by a constant 55px while every row was measured.
   */
  const [scrollPadding, setScrollPadding] = useState<FeedScrollPadding>({ start: 0, end: 0 });

  useLayoutEffect(() => {
    if (!enabled) {
      setScrollPadding((current) =>
        current.start === 0 && current.end === 0 ? current : { start: 0, end: 0 },
      );
      return;
    }
    const element = getScrollElement();
    if (!element) {
      return;
    }
    const apply = () => {
      const next = readScrollPadding(element);
      setScrollPadding((current) =>
        Math.abs(current.start - next.start) > 0.5 || Math.abs(current.end - next.end) > 0.5 ? next : current,
      );
    };
    apply();
    // Padding changes move the content box without moving the border box, so a
    // content-box observer is what sees the Composer's overlays arriving.
    const observer = new ResizeObserver(apply);
    observer.observe(element, { box: "content-box" });
    return () => {
      observer.disconnect();
    };
  }, [enabled, getScrollElement]);

  // Text updates keep the key callback stable. Replacements/reorders need a new
  // callback so virtual-core invalidates measurements even when count is unchanged.
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const [selectSectionKeys] = useState(createFeedSectionKeySelector);

  // One estimator per mounted Feed: its frozen estimates live exactly as long as
  // the geometry they describe.
  const estimatorRef = useRef<FrozenSectionEstimator | null>(null);
  if (estimatorRef.current === null) {
    estimatorRef.current = createFrozenSectionEstimator();
  }
  const estimate = estimatorRef.current;

  const getItemKey = selectSectionKeys(sections);
  const estimateSize = useCallback(
    (index: number) => {
      const section = sectionsRef.current[index];
      return section ? estimate(section) : ESTIMATE_ENTRY_PX;
    },
    [estimate],
  );

  const scrollToFn = useCallback<VirtualizerOptions<HTMLElement, Element>["scrollToFn"]>(
    (offset, options, instance) => followEndAnchoredScroll(offset, options, instance, !userDetached),
    [userDetached],
  );

  const virtualizer = useVirtualizer({
    count: enabled ? count : 0,
    enabled,
    getScrollElement,
    estimateSize,
    overscan: OVERSCAN,
    getItemKey,
    scrollMargin,
    paddingStart: scrollPadding.start,
    paddingEnd: scrollPadding.end,
    scrollToFn,
    // The live tail is the anchor. While the reader sits at the end, virtual-core
    // compensates growth itself (`resizeItem`'s `wasAtEnd` path) and follows an
    // appended section, instead of leaving every growth tick to App.tsx's follow
    // writer — two writers racing on one `scrollTop` is what made the boundary
    // re-derive on nearly every frame. Upstream calls this end-anchored
    // virtualization (TanStack/virtual#1173); its chat guide uses this option set.
    anchorTo: "end",
    followOnAppend: !userDetached,
    // Distance is nonnegative, so -1 disables end-follow on resize while keeping
    // end-anchored key preservation and above-viewport resize compensation.
    scrollEndThreshold: userDetached ? -1 : FEED_END_ANCHOR_THRESHOLD_PX,
    // No `gap`: the Feed's rhythm lives inside each row (a margin-top on the row's
    // own child), so every pixel of scroll height sits inside a measured row. A
    // flex gap would be height the model never sees.
    //
    // Keep React's default flushSync. `anchorTo:"end"` writes `scrollTop`
    // synchronously inside the measurement ResizeObserver, while the spacers that
    // make that write land correctly only exist after React re-renders. Batching
    // the notification splits the two across frames, so every measurement leaves
    // the pinned position further from the live tail — upstream sees the same
    // shape of bug in #1227.
    useFlushSync: true,
  });

  const measureElement = useCallback(
    (node: Element | null) => {
      virtualizer.measureElement(node);
      if (!node) return;
      const index = virtualizer.indexFromElement(node);
      if (index < 0 || index >= virtualizer.options.count) return;
      const section = sections[index];
      if (section) {
        recordMeasuredSectionSize(section, (node as HTMLElement).offsetHeight);
      }
    },
    [sections, virtualizer],
  );

  useLayoutEffect(() => {
    if (!enabled) {
      setScrollMargin(0);
      return;
    }
    const header = headerRef.current;
    const next = header?.offsetHeight ?? 0;
    setScrollMargin((current) => (Math.abs(next - current) > 0.5 ? next : current));
  }, [enabled, headerRef, sections.length]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const header = headerRef.current;
    if (!header) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const next = header.offsetHeight;
      setScrollMargin((current) => (Math.abs(next - current) > 0.5 ? next : current));
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [enabled, headerRef]);

  const scrollToAnchor = useCallback(
    async (anchorId: string) => {
      if (isThreadPromptAnchorId(anchorId)) {
        const scroll = getScrollElement();
        scroll?.scrollTo({ top: 0, behavior: "smooth" });
        return true;
      }
      const index = findFeedSectionIndexForAnchor(sections, anchorId);
      if (index < 0) {
        return false;
      }
      virtualizer.scrollToIndex(index, { align: "start" });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return true;
    },
    [getScrollElement, sections, virtualizer],
  );

  useEffect(() => {
    const runLog = runLogRef.current;
    if (!runLog || !enabled) {
      return;
    }
    const onScrollToAnchor = (event: Event) => {
      const detail = (event as CustomEvent<FeedScrollToAnchorDetail>).detail;
      const anchorId = detail?.anchorId?.trim();
      if (!anchorId) {
        return;
      }
      void scrollToAnchor(anchorId);
    };
    runLog.addEventListener(FEED_SCROLL_TO_ANCHOR_EVENT, onScrollToAnchor as EventListener);
    return () => {
      runLog.removeEventListener(FEED_SCROLL_TO_ANCHOR_EVENT, onScrollToAnchor as EventListener);
    };
  }, [enabled, runLogRef, scrollToAnchor]);

  return {
    enabled,
    virtualizer,
    virtualItems: enabled ? virtualizer.getVirtualItems() : ([] as VirtualItem[]),
    totalSize: enabled ? virtualizer.getTotalSize() : 0,
    scrollMargin: enabled ? scrollMargin : 0,
    // The scroll element's own padding is real DOM space already, so anything
    // laid out from the model has to take it back out again.
    paddingStart: enabled ? scrollPadding.start : 0,
    paddingEnd: enabled ? scrollPadding.end : 0,
    measureElement,
    resolveSectionTopPx: (sectionIndex: number) => {
      if (!enabled || sectionIndex < 0) {
        return 0;
      }
      // Sentinels are positioned inside the row container, which starts below the
      // scroll element's own padding-top, while model offsets include it.
      const measured = virtualizer.measurementsCache[sectionIndex];
      if (measured) {
        return measured.start - scrollPadding.start;
      }
      let start = scrollMargin;
      for (let index = 0; index < sectionIndex; index += 1) {
        const previous = virtualizer.measurementsCache[index];
        const section = sections[index];
        start += previous?.size ?? (section ? estimateSectionSize(section) : ESTIMATE_ENTRY_PX);
      }
      return start;
    },
  };
}

export function FeedVirtualSectionWindow(props: {
  sections: readonly ThreadRunTurnFeedSection[];
  totalSize: number;
  scrollMargin: number;
  /** The scroll element's own padding, which the model counts but the DOM already has. */
  paddingStart: number;
  paddingEnd: number;
  virtualItems: readonly VirtualItem[];
  measureElement: (node: Element | null) => void;
  renderSection: (index: number) => ReactNode;
}): ReactNode {
  const {
    sections,
    totalSize,
    scrollMargin,
    paddingStart,
    paddingEnd,
    virtualItems,
    measureElement,
    renderSection,
  } = props;
  const first = virtualItems[0];
  const last = virtualItems[virtualItems.length - 1];
  // item.start/end include scrollMargin and the element's padding-top; totalSize
  // also carries the element's padding-bottom. The padding is real DOM space
  // outside the row container, so the spacers must not reproduce it — otherwise
  // the Composer's band gets reserved twice.
  const topSpacer = Math.max(0, (first?.start ?? 0) - scrollMargin - paddingStart);
  const bottomSpacer = Math.max(0, totalSize - paddingEnd - ((last?.end ?? scrollMargin) - scrollMargin));

  return (
    <>
      {topSpacer > 0 ? (
        <div className="run-log-virtual-spacer" style={{ height: topSpacer }} aria-hidden />
      ) : null}
      {virtualItems.map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          data-previous-section-kind={sections[item.index - 1]?.kind}
          ref={measureElement}
          className="run-log-virtual-row"
        >
          {renderSection(item.index)}
        </div>
      ))}
      {bottomSpacer > 0 ? (
        <div className="run-log-virtual-spacer" style={{ height: bottomSpacer }} aria-hidden />
      ) : null}
    </>
  );
}

export function dispatchFeedScrollToAnchor(container: ParentNode, anchorId: string): boolean {
  const runLog = container.querySelector(".run-log");
  if (!(runLog instanceof HTMLElement)) {
    return false;
  }
  runLog.dispatchEvent(
    new CustomEvent<FeedScrollToAnchorDetail>(FEED_SCROLL_TO_ANCHOR_EVENT, {
      detail: { anchorId },
      bubbles: false,
    }),
  );
  return true;
}
